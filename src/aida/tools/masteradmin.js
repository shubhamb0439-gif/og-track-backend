const jwt = require('jsonwebtoken');
const config = require('../../config');
const coreDb = require('../../db/core');
const { callPlatformApi, callTenantApi } = require('../apiClient');
const memory = require('../memory');
const contacts = require('../contacts');
const emailLog = require('../emailLog');
const graphMail = require('../graphMail');
const pendingAttachments = require('../pendingAttachments');
const zohoClient = require('../../zoho/zohoClient');

/** The real email address of the master admin acting in this turn — used to CC them on anything AIDA sends on their behalf. */
async function currentAdminEmail(context) {
  const admin = await coreDb('platform_admins').where({ id: context.userId }).first();
  return admin?.email || null;
}

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
      "('always keep replies terse'), a correction to how you should work going forward, real context about an " +
      "ongoing project/decision, or a genuinely personal fact about them (birthday, family, things they've " +
      "mentioned about themselves) — 'user' is not limited to work-related facts, save real personal context too " +
      "when they share it. Do NOT save ephemeral task details, one-off requests, or anything already obvious " +
      "from the code/data itself. Categorize as 'user' (their role, preferences, or personal facts), 'feedback' " +
      "(a correction on how you should work), 'project' (ongoing initiative/decision context), or 'reference' " +
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

  {
    name: 'send_email',
    description:
      "Sends a real email, from aida@sanj.co, to anyone — a known contact by name, or a fresh address. If both " +
      "`to` and `name` are given, that pairing is remembered so just `name` works next time (e.g. after once " +
      "being told \"email pooja, her address is pooja@ogplus.in\", a later \"mail pooja\" resolves automatically). " +
      "If only `name` is given and it's not a known contact yet, this returns an error — ask the human for the " +
      "address rather than guessing one. Set includeAttachment: true ONLY when the human attached a file/photo " +
      "earlier in this same conversation and asked you to send/forward THAT specific file. SAFETY — a real, " +
      "irreversible action: call this WITHOUT confirmed first, it returns a preview instead of sending. Read the " +
      "preview back to the human and wait for their explicit yes in their NEXT message, then call again with the " +
      "exact same arguments plus confirmed: true.",
    requiredModules: ['__masteradmin__'],
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address. Omit if sending to an already-known contact by name only.' },
        name: { type: 'string', description: "The recipient's name — used to remember/look up their address." },
        subject: { type: 'string' },
        body: { type: 'string' },
        includeAttachment: { type: 'boolean', description: 'Set true to attach the file the human most recently sent AIDA in this conversation.' },
        confirmed: { type: 'boolean', description: 'Only set true after the human has explicitly confirmed sending, in a later message.' },
      },
      required: ['subject', 'body'],
    },
    async handler(context, { to, name, subject, body, includeAttachment, confirmed }) {
      let recipient = to;
      if (!recipient && name) {
        const known = await contacts.findContactByName(name);
        if (!known) return { error: `I don't have an email address saved for "${name}" yet — ask the human for it, then call this again with both "to" and "name".` };
        recipient = known.email;
      }
      if (!recipient) return { error: 'Need either "to" or a "name" that\'s already a known contact.' };

      let attachment = null;
      if (includeAttachment) {
        const pending = pendingAttachments.getPending(context);
        if (!pending) return { error: "There's no recently-attached file in this conversation to include — ask the human to resend it." };
        attachment = pending;
      }

      if (!confirmed) {
        return {
          status: 'needs_confirmation',
          preview: { to: recipient, subject, body, attachment: attachment ? attachment.filename : null },
          instruction: 'Read this preview back to the human and ask them to confirm before sending. Do NOT send until they explicitly say yes in their next message — then call this tool again with confirmed: true.',
        };
      }

      if (name && to) await contacts.saveContact({ name, email: to });
      const ccAddress = await currentAdminEmail(context);
      try {
        await graphMail.sendMail({
          to: recipient, cc: ccAddress, subject, body,
          attachments: attachment ? [{ filename: attachment.filename, mimeType: attachment.mimeType, buffer: attachment.buffer }] : undefined,
        });
      } catch (e) {
        return { error: `Failed to send: ${e.message}` };
      }
      return { success: true, to: recipient, cc: ccAddress };
    },
  },

  {
    name: 'reply_to_email',
    description:
      "Replies to a real email AIDA previously surfaced over WhatsApp (one of the emails it summarized from the " +
      "watched inbox) — sends a genuine threaded reply to the original sender, with the master admin's own email " +
      "CC'd so they stay in the loop. Omit emailId to reply to whichever email was MOST RECENTLY summarized in " +
      "this conversation (the natural default for \"reply to them saying...\"). SAFETY — a real, irreversible " +
      "action: call this WITHOUT confirmed first, it returns a preview instead of sending. Read the preview back " +
      "to the human and wait for their explicit yes in their NEXT message, then call again with confirmed: true.",
    requiredModules: ['__masteradmin__'],
    inputSchema: {
      type: 'object',
      properties: {
        emailId: { type: 'string', description: 'The internal log id of the email to reply to — omit to use the most recent one.' },
        replyText: { type: 'string', description: 'What to actually say in the reply.' },
        confirmed: { type: 'boolean', description: 'Only set true after the human has explicitly confirmed sending, in a later message.' },
      },
      required: ['replyText'],
    },
    async handler(context, { emailId, replyText, confirmed }) {
      const logged = emailId ? await emailLog.getById(emailId) : await emailLog.getMostRecent();
      if (!logged) return { error: emailId ? `No logged email found with id "${emailId}".` : 'No emails have been logged yet to reply to.' };

      const ccAddress = await currentAdminEmail(context);
      if (!confirmed) {
        return {
          status: 'needs_confirmation',
          preview: { replyingTo: logged.from_address, subject: logged.subject, replyText, cc: ccAddress },
          instruction: 'Read this preview back to the human and ask them to confirm before sending. Do NOT send until they explicitly say yes in their next message — then call this tool again with confirmed: true.',
        };
      }

      try {
        await graphMail.replyToEmailWithCc({ messageId: logged.graph_message_id, commentText: replyText, ccAddress });
      } catch (e) {
        return { error: `Failed to send reply: ${e.message}` };
      }
      return { success: true, repliedTo: logged.from_address, cc: ccAddress };
    },
  },

  {
    name: 'remember_contact',
    description: 'Saves or updates a name -> email address pairing for later use with send_email, without sending anything right now.',
    requiredModules: ['__masteradmin__'],
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, email: { type: 'string' } },
      required: ['name', 'email'],
    },
    async handler(context, { name, email }) {
      const saved = await contacts.saveContact({ name, email });
      return { success: true, contact: saved };
    },
  },

  {
    name: 'forget_contact',
    description: 'Deletes a remembered contact by name — use when the human explicitly asks you to forget someone\'s saved email.',
    requiredModules: ['__masteradmin__'],
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    async handler(context, { name }) {
      const existing = await contacts.findContactByName(name);
      if (!existing) return { error: `No saved contact found named "${name}".` };
      await contacts.forgetContact(existing.id);
      return { success: true };
    },
  },

  {
    name: 'query_zoho_books',
    description: 'Fetches real Zoho Books data (invoices, bills, expenses, contacts, bank accounts, or P&L/balance-sheet reports) for ANY connected company, by slug — cross-company, master-admin only. Returns an error naming the company if it has no Zoho connection linked yet.',
    requiredModules: ['__masteradmin__'],
    inputSchema: {
      type: 'object',
      properties: {
        companySlug: { type: 'string', description: 'The OG Track company slug, e.g. "cajo", "ogplus", "sitara".' },
        dataType: { type: 'string', enum: ['invoices', 'bills', 'expenses', 'contacts', 'bank_accounts', 'profit_and_loss', 'balance_sheet'] },
        fromDate: { type: 'string', description: 'YYYY-MM-DD, for profit_and_loss only.' },
        toDate: { type: 'string', description: 'YYYY-MM-DD, for profit_and_loss/balance_sheet.' },
      },
      required: ['companySlug', 'dataType'],
    },
    async handler(context, { companySlug, dataType, fromDate, toDate }) {
      const company = await coreDb('companies').where({ slug: companySlug }).first();
      if (!company) return { error: `No company found with slug "${companySlug}".` };
      try {
        switch (dataType) {
          case 'invoices': return { invoices: await zohoClient.getInvoices(company.id) };
          case 'bills': return { bills: await zohoClient.getBills(company.id) };
          case 'expenses': return { expenses: await zohoClient.getExpenses(company.id) };
          case 'contacts': return { contacts: await zohoClient.getContacts(company.id) };
          case 'bank_accounts': return { bankAccounts: await zohoClient.getBankAccounts(company.id) };
          case 'profit_and_loss': return await zohoClient.getProfitAndLoss(company.id, { fromDate, toDate });
          case 'balance_sheet': return await zohoClient.getBalanceSheet(company.id, { toDate });
          default: return { error: `Unknown dataType "${dataType}".` };
        }
      } catch (e) {
        if (e instanceof zohoClient.ZohoNotConnectedError) {
          return { error: `${company.name} has no Zoho Books connection linked yet — connect it from the masteradmin panel first.` };
        }
        return { error: `Zoho Books request failed: ${e.message}` };
      }
    },
  },
];
