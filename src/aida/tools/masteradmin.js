const jwt = require('jsonwebtoken');
const config = require('../../config');
const { callPlatformApi, callTenantApi } = require('../apiClient');
const memory = require('../memory');

/**
 * Master-admin-only tools (domain.com/master-admin/aida). These operate on
 * OGCore (the company directory), not a tenant database, and are gated by
 * the '__masteradmin__' sentinel module — see contextBuilder.js. A tenant
 * chat context never has that sentinel, so these never leak into a
 * per-company AIDA session, and tenant tools never leak into master-admin's.
 */
module.exports = [
  {
    name: 'masteradmin_list_companies',
    description: 'List every OG Track company/tenant, with status and enabled modules.',
    requiredModules: ['__masteradmin__'],
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['active', 'suspended'] } },
    },
    async handler(context, { status } = {}) {
      const rows = await callPlatformApi(context, 'GET', '/masteradmin/companies');
      const filtered = status ? (rows || []).filter((c) => c.status === status) : rows;
      return { count: (filtered || []).length, companies: filtered };
    },
  },

  {
    name: 'masteradmin_get_pending_users',
    description: 'Users across ALL companies awaiting Super Admin approval.',
    requiredModules: ['__masteradmin__'],
    inputSchema: { type: 'object', properties: {} },
    async handler(context) {
      const rows = await callPlatformApi(context, 'GET', '/masteradmin/pending-users');
      return { count: (rows || []).length, pendingUsers: rows };
    },
  },

  {
    name: 'masteradmin_get_provisioning_log',
    description: "A company's provisioning history (module setup steps and their status).",
    requiredModules: ['__masteradmin__'],
    inputSchema: {
      type: 'object',
      properties: { companyId: { type: 'string' } },
      required: ['companyId'],
    },
    async handler(context, { companyId }) {
      const rows = await callPlatformApi(context, 'GET', `/masteradmin/provisioning-log/${encodeURIComponent(companyId)}`);
      return { companyId, log: rows };
    },
  },

  {
    name: 'send_message_to_user',
    description:
      "Sends a direct message to a specific user in a specific company's internal messaging (only works if " +
      "that company has the 'messages' module enabled). SAFETY — this is a real, visible action: call this tool " +
      "WITHOUT confirmed first — it returns a preview instead of sending anything. Read that preview back to the " +
      "user in plain language (who, which company, what text) and wait for their explicit yes in their NEXT " +
      "message. Only then call this again with the exact same arguments plus confirmed: true to actually send it.",
    requiredModules: ['__masteradmin__'],
    inputSchema: {
      type: 'object',
      properties: {
        companySlug: { type: 'string', description: 'The target company/tenant slug.' },
        recipientName: { type: 'string', description: "The recipient's name (or a distinctive part of it) — resolved against that company's user list." },
        text: { type: 'string' },
        confirmed: { type: 'boolean', description: 'Only set true after the user has explicitly confirmed sending, in a later message.' },
      },
      required: ['companySlug', 'recipientName', 'text'],
    },
    async handler(context, { companySlug, recipientName, text, confirmed }) {
      // Same synthetic-token pattern as masteradminCrossTenant.js — the real
      // tenant-scoped routes this loops back into (users, conversations)
      // enforce their own auth/module gates exactly as they would for any
      // other caller; this only pins down *who* masteradmin is acting as.
      const syntheticToken = jwt.sign({ userId: context.userId, role: 'superadmin', slug: companySlug }, config.app.jwtSecret, { expiresIn: '5m' });
      const tenantContext = { ...context, tenantSlug: companySlug, authHeader: `Bearer ${syntheticToken}` };

      let users;
      try {
        users = await callTenantApi(tenantContext, 'GET', '/users');
      } catch (e) {
        return { error: `Could not look up users in "${companySlug}": ${e.message}` };
      }
      const needle = recipientName.toLowerCase();
      const matches = (users || []).filter((u) => (u.name || '').toLowerCase().includes(needle));
      if (!matches.length) return { error: `No user matching "${recipientName}" found in "${companySlug}".` };
      if (matches.length > 1) {
        return {
          error: `Multiple users match "${recipientName}" in "${companySlug}" — ask which one and be more specific.`,
          matches: matches.map((u) => ({ id: u.id, name: u.name })),
        };
      }
      const recipient = matches[0];

      if (!confirmed) {
        return {
          status: 'needs_confirmation',
          preview: { to: recipient.name, company: companySlug, text },
          instruction: 'Read this preview back to the user and ask them to confirm. Do NOT send anything until they explicitly say yes in their next message — then call this tool again with confirmed: true.',
        };
      }

      const SENDER_ID = 'masteradmin';
      const SENDER_NAME = 'AIDA (Master Admin)';
      try {
        const convo = await callTenantApi(tenantContext, 'POST', '/conversations', {
          body: { type: 'dm', memberIds: [SENDER_ID, recipient.id], memberNames: [SENDER_NAME, recipient.name], createdBy: SENDER_ID },
        });
        await callTenantApi(tenantContext, 'POST', `/conversations/${convo.id}/messages`, {
          body: { senderId: SENDER_ID, senderName: SENDER_NAME, text },
        });
      } catch (e) {
        return { error: `Failed to send message: ${e.message}` };
      }
      return { success: true, to: recipient.name, company: companySlug };
    },
  },

  {
    name: 'save_memory',
    description:
      "Saves a durable fact to your long-term memory — persists across every future conversation with this " +
      "master admin, not just this one. Only for things worth remembering long-term: a standing preference " +
      "('always keep replies terse'), a correction to how you should work going forward, or real context about " +
      "an ongoing project/decision. Do NOT save ephemeral task details, one-off requests, or anything already " +
      "obvious from the code/data itself. Categorize as 'user' (their role/preferences), 'feedback' (a " +
      "correction on how you should work), 'project' (ongoing initiative/decision context), or 'reference' " +
      "(a pointer to an external system, e.g. \"bugs are tracked in Linear project X\").",
    requiredModules: ['__masteradmin__'],
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: memory.CATEGORIES },
        content: { type: 'string' },
      },
      required: ['category', 'content'],
    },
    async handler(context, { category, content }) {
      if (!config.aida.memory.enabled) return { error: 'Long-term memory is not enabled on this server.' };
      const saved = await memory.saveMemory({ category, content });
      return { success: true, memory: saved };
    },
  },

  {
    name: 'forget_memory',
    description: 'Deletes a saved memory by its id (shown alongside every memory in your system context) — use when the master admin explicitly asks you to forget something.',
    requiredModules: ['__masteradmin__'],
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    async handler(context, { id }) {
      const found = await memory.forgetMemory(id);
      return found ? { success: true } : { error: `No memory found with id "${id}".` };
    },
  },
];
