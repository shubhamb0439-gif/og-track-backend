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
const { sendWhatsAppMessage, sendWhatsAppDocument } = require('../whatsapp');
const { isTrivialMessage } = require('../messageTriviality');

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
    category: 'Company Management',
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
    name: 'masteradmin_open_company',
    category: 'Company Management',
    description: 'Resolve a company name/slug to its real OG Track app URL, for "open X" / "show me X" / "pull up X" requests. ALWAYS call this instead of guessing or constructing a URL yourself — the frontend auto-renders any real URL appearing in your reply text as a preview card, so when found, state the returned url field PLAINLY as visible text. If not found or ambiguous, say so in plain text instead of guessing.',
    requiredModules: ['__masteradmin__'],
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The company name or slug as the user said it, e.g. "CAJO", "Sitara Drapes"' } },
      required: ['query'],
    },
    async handler(context, { query } = {}) {
      const q = (query || '').trim().toLowerCase();
      if (!q) return { found: false, error: 'query is required' };
      if (!config.email.frontendBaseUrl) {
        return { found: false, error: 'FRONTEND_BASE_URL is not configured on this server — I cannot construct a real link right now.' };
      }

      const rows = (await callPlatformApi(context, 'GET', '/masteradmin/companies')) || [];
      // Exact match (name or slug) first — only fall back to substring
      // matching when nothing matches exactly, so a short/common name never
      // loses to an unrelated longer one that happens to contain it.
      // Substring check is BIDIRECTIONAL: a stored name can be shorter than
      // the query ("CAJO" vs. a user saying "CAJO ERP") just as easily as
      // longer, so both c.name.includes(q) and q.includes(c.name) matter.
      const exact = rows.filter((c) => c.name.toLowerCase() === q || c.slug.toLowerCase() === q);
      const candidates = exact.length ? exact : rows.filter((c) => {
        const name = c.name.toLowerCase(), slug = c.slug.toLowerCase();
        return name.includes(q) || q.includes(name) || slug.includes(q) || q.includes(slug);
      });

      if (candidates.length === 0) return { found: false, message: `No company found matching "${query}".` };
      if (candidates.length > 1) {
        return {
          found: false, ambiguous: true,
          candidates: candidates.map((c) => ({ name: c.name, slug: c.slug })),
          message: `Multiple companies match "${query}": ${candidates.map((c) => c.name).join(', ')}. Ask which one they mean.`,
        };
      }
      const company = candidates[0];
      return {
        found: true, name: company.name, slug: company.slug, status: company.status,
        url: `${config.email.frontendBaseUrl.replace(/\/+$/, '')}/${company.slug}`,
      };
    },
  },

  {
    name: 'masteradmin_get_pending_users',
    category: 'Company Management',
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
    category: 'Company Management',
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
    category: 'Communication',
    subcategory: 'In-App Messages',
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
    category: 'Memory',
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
    category: 'Memory',
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
    category: 'Communication',
    subcategory: 'Email',
    description:
      "Sends a real email, from aida@sanj.co, to anyone — a known contact by name, or a fresh address. If both " +
      "`to` and `name` are given, that pairing is remembered so just `name` works next time (e.g. after once " +
      "being told \"email pooja, her address is pooja@ogplus.in\", a later \"mail pooja\" resolves automatically). " +
      "If only `name` is given and it's not a known contact yet, this returns an error — ask the human for the " +
      "address rather than guessing one. Set includeAttachment: true ONLY when the human attached a file/photo " +
      "earlier in this same conversation and asked you to send/forward THAT specific file — this does NOT work " +
      "when called from a Flow (no live conversation exists there). To attach a file from an earlier step's " +
      "result instead (e.g. generate_document's fileUrl, or any other real URL), set attachFileUrl to that URL — " +
      "the real bytes are downloaded and attached, works in both chat and Flows. SAFETY — a real, " +
      "irreversible action, confirmed first for anything that matters: a SHORT, casual message (roughly a " +
      "sentence or two, no attachment, nothing sensitive like payments/legal/confidential topics) sends " +
      "IMMEDIATELY on the first call — no need to preview or ask first, exactly like a human firing off a quick " +
      "email themselves. Anything longer, anything with an attachment, or anything touching a sensitive/" +
      "high-stakes topic instead returns a preview (status: needs_confirmation) on that first call — read it back " +
      "to the human, wait for their explicit yes in their NEXT message, then call again with the exact same " +
      "arguments plus confirmed: true.",
    requiredModules: ['__masteradmin__'],
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address. Omit if sending to an already-known contact by name only.' },
        name: { type: 'string', description: "The recipient's name — used to remember/look up their address." },
        subject: { type: 'string' },
        body: { type: 'string' },
        includeAttachment: { type: 'boolean', description: 'Set true to attach the file the human most recently sent AIDA in this conversation. Chat only — never works from a Flow.' },
        attachFileUrl: { type: 'string', description: "A direct URL to a real file to attach (e.g. an earlier step's fileUrl) — downloaded and attached as a real file. Works in both chat and Flows." },
        confirmed: { type: 'boolean', description: 'Only set true after the human has explicitly confirmed sending, in a later message.' },
      },
      required: ['subject', 'body'],
    },
    async handler(context, { to, name, subject, body, includeAttachment, attachFileUrl, confirmed }) {
      let recipient = to;
      if (!recipient && name) {
        const known = await contacts.findContactByNameLoose(context.userId, name);
        if (!known) return { error: `I don't have an email address saved for "${name}" yet — ask the human for it, then call this again with both "to" and "name".` };
        recipient = known.email;
      }
      if (!recipient) return { error: 'Need either "to" or a "name" that\'s already a known contact.' };

      let attachment = null;
      if (includeAttachment) {
        const pending = pendingAttachments.getPending(context);
        if (!pending) return { error: "There's no recently-attached file in this conversation to include — ask the human to resend it." };
        attachment = pending;
      } else if (attachFileUrl) {
        try {
          const res = await fetch(attachFileUrl);
          if (!res.ok) return { error: `Could not download the file to attach (HTTP ${res.status}): ${attachFileUrl}` };
          const buffer = Buffer.from(await res.arrayBuffer());
          const urlFilename = decodeURIComponent(attachFileUrl.split('/').pop().split('?')[0] || '');
          attachment = {
            filename: urlFilename || 'attachment',
            mimeType: res.headers.get('content-type') || 'application/octet-stream',
            buffer,
          };
        } catch (e) {
          return { error: `Failed to download attachFileUrl: ${e.message}` };
        }
      }

      if (!confirmed && !isTrivialMessage({ text: body, hasAttachment: !!attachment })) {
        return {
          status: 'needs_confirmation',
          preview: { to: recipient, subject, body, attachment: attachment ? attachment.filename : null },
          instruction: 'Read this preview back to the human and ask them to confirm before sending. Do NOT send until they explicitly say yes in their next message — then call this tool again with confirmed: true.',
        };
      }

      if (name && to) await contacts.saveContact(context.userId, { name, email: to });
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
    category: 'Communication',
    subcategory: 'Email',
    description:
      "Replies to a real email AIDA previously surfaced over WhatsApp (one of the emails it summarized from the " +
      "watched inbox) — sends a genuine threaded reply to the original sender, with the master admin's own email " +
      "CC'd so they stay in the loop. Omit emailId to reply to whichever email was MOST RECENTLY summarized in " +
      "this conversation (the natural default for \"reply to them saying...\"). SAFETY — a real, irreversible " +
      "action, confirmed first for anything that matters: a SHORT, casual reply (roughly a sentence or two, " +
      "nothing sensitive like payments/legal/confidential topics) sends IMMEDIATELY on the first call — no need " +
      "to preview or ask first. A longer or sensitive reply instead returns a preview (status: needs_confirmation) " +
      "on that first call — read it back to the human, wait for their explicit yes in their NEXT message, then " +
      "call again with confirmed: true.",
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
      if (!confirmed && !isTrivialMessage({ text: replyText })) {
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
    category: 'Communication',
    subcategory: 'Contacts',
    description: 'Saves or updates a name -> email address pairing for later use with send_email, without sending anything right now.',
    requiredModules: ['__masteradmin__'],
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, email: { type: 'string' } },
      required: ['name', 'email'],
    },
    async handler(context, { name, email }) {
      const saved = await contacts.saveContact(context.userId, { name, email });
      return { success: true, contact: saved };
    },
  },

  {
    name: 'find_contact',
    category: 'Communication',
    subcategory: 'Contacts',
    description:
      'Checks whether a specific saved contact exists by name, and what we actually have for them (email and/or ' +
      'WhatsApp number) — use this for a plain lookup question like "do you have Pooja\'s number?" or "what\'s ' +
      'Pooja\'s email?". This is READ-ONLY and never sends anything — for that, use send_email/message_contact instead.',
    requiredModules: ['__masteradmin__'],
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    async handler(context, { name }) {
      const found = await contacts.findContactByNameLoose(context.userId, name);
      if (!found) return { found: false };
      return { found: true, name: found.name, email: found.email || null, whatsappNumber: found.whatsapp_number || null };
    },
  },

  {
    name: 'list_contacts',
    category: 'Communication',
    subcategory: 'Contacts',
    description: 'Lists every contact currently saved (from manual teaching, send_email/message_contact\'s save-on-first-use, or the Android app\'s phone-contact sync) — name plus whatever email/number we have for each.',
    requiredModules: ['__masteradmin__'],
    inputSchema: { type: 'object', properties: {} },
    async handler(context) {
      const rows = await contacts.getContacts(context.userId);
      return {
        count: rows.length,
        contacts: rows.map((c) => ({ name: c.name, email: c.email || null, whatsappNumber: c.whatsapp_number || null })),
      };
    },
  },

  {
    name: 'forget_contact',
    category: 'Communication',
    subcategory: 'Contacts',
    description: 'Deletes a remembered contact by name — use when the human explicitly asks you to forget someone\'s saved email.',
    requiredModules: ['__masteradmin__'],
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    async handler(context, { name }) {
      const existing = await contacts.findContactByName(context.userId, name);
      if (!existing) return { error: `No saved contact found named "${name}".` };
      await contacts.forgetContact(context.userId, existing.id);
      return { success: true };
    },
  },

  {
    name: 'query_zoho_books',
    category: 'Accounting',
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

  {
    name: 'message_contact',
    category: 'Communication',
    subcategory: 'WhatsApp',
    description:
      "Sends a real freeform WhatsApp message to a saved contact by name (or to a number given alongside a name, which " +
      "saves that pairing for next time — same save-on-first-use pattern as send_email), optionally forwarding the " +
      "file the human most recently sent AIDA in this conversation (set includeAttachment: true — same mechanism as " +
      "send_email's includeAttachment; chat only, does NOT work from a Flow). To attach a file from an earlier " +
      "step's result instead (e.g. make_pdf's or generate_document's fileUrl, or any other real URL), set " +
      "attachFileUrl to that URL — the real bytes are downloaded and attached, works in both chat and Flows. text " +
      "may be omitted if includeAttachment/attachFileUrl provides a file and it should go with just a caption-less " +
      "send, but at least one of text/includeAttachment/attachFileUrl is required. SAFETY — this is a real, " +
      "visible action, confirmed first for anything that matters: a SHORT, casual message (roughly a sentence or " +
      "two, no attachment, nothing sensitive like payments/legal/confidential topics) sends IMMEDIATELY on the " +
      "first call — no need to preview or ask first, exactly like a human firing off a quick \"hi\" themselves. " +
      "Anything longer, anything with an attachment, or anything touching a sensitive/high-stakes topic instead " +
      "returns a preview (status: needs_confirmation) on that first call — read it back to the user in plain " +
      "language, wait for their explicit yes in their NEXT message, then call this again with the exact same " +
      "arguments plus confirmed: true to actually send it. " +
      "IMPORTANT real platform limit, not a bug: WhatsApp only allows a freeform message (any text) to someone who has " +
      "themselves messaged this WhatsApp number within the last 24 hours — outside that window Meta will reject the " +
      "send, and this tool will report that real rejection back rather than pretending it worked.",
    requiredModules: ['__masteradmin__'],
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "The contact's name — resolved against saved contacts if phoneNumber is omitted." },
        phoneNumber: { type: 'string', description: 'Full number with country code (e.g. "919845009748") — only needed the first time, or to update a saved number.' },
        text: { type: 'string' },
        includeAttachment: { type: 'boolean', description: 'Set true to forward the file the human most recently sent AIDA in this conversation. Chat only — never works from a Flow.' },
        attachFileUrl: { type: 'string', description: "A direct URL to a real file to attach (e.g. an earlier step's fileUrl) — downloaded and attached as a real file. Works in both chat and Flows." },
        confirmed: { type: 'boolean', description: 'Only set true after the user has explicitly confirmed sending, in a later message.' },
      },
      required: ['name'],
    },
    async handler(context, { name, phoneNumber, text, includeAttachment, attachFileUrl, confirmed }) {
      if (!text && !includeAttachment && !attachFileUrl) return { error: 'Need at least one of text, includeAttachment: true, or attachFileUrl.' };

      let resolvedNumber = phoneNumber ? contacts.normalizeWhatsAppNumber(phoneNumber) : null;
      if (!resolvedNumber) {
        const existing = await contacts.findContactByNameLoose(context.userId, name);
        if (!existing?.whatsapp_number) {
          return { error: `No saved WhatsApp number for "${name}" — give me the number (with country code) to message them.` };
        }
        resolvedNumber = existing.whatsapp_number;
      }

      let attachment = null;
      if (includeAttachment) {
        attachment = pendingAttachments.getPending(context);
        if (!attachment) return { error: "There's no recently-attached file in this conversation to forward — ask the human to resend it." };
      } else if (attachFileUrl) {
        try {
          const res = await fetch(attachFileUrl);
          if (!res.ok) return { error: `Could not download the file to attach (HTTP ${res.status}): ${attachFileUrl}` };
          const buffer = Buffer.from(await res.arrayBuffer());
          const urlFilename = decodeURIComponent(attachFileUrl.split('/').pop().split('?')[0] || '');
          attachment = {
            filename: urlFilename || 'attachment',
            mimeType: res.headers.get('content-type') || 'application/octet-stream',
            buffer,
          };
        } catch (e) {
          return { error: `Failed to download attachFileUrl: ${e.message}` };
        }
      }

      if (!confirmed && !isTrivialMessage({ text, hasAttachment: !!attachment })) {
        return {
          status: 'needs_confirmation',
          preview: { to: name, phoneNumber: resolvedNumber, text: text || null, attachment: attachment ? attachment.filename : null },
          instruction: 'Read this preview back to the user and ask them to confirm. Do NOT send anything until they explicitly say yes in their next message — then call this tool again with confirmed: true.',
        };
      }

      if (phoneNumber) {
        try { await contacts.saveContact(context.userId, { name, whatsappNumber: resolvedNumber }); }
        catch (e) { return { error: `Failed to save contact: ${e.message}` }; }
      }

      if (text) {
        const result = await sendWhatsAppMessage(resolvedNumber, text);
        if (!result.success) {
          return { error: `WhatsApp send failed — this is usually Meta's real 24-hour-window rule (the contact hasn't messaged this number recently), not a bug: ${result.error}` };
        }
      }
      if (attachment) {
        const docResult = await sendWhatsAppDocument(resolvedNumber, attachment.buffer, attachment.filename, attachment.mimeType, text ? undefined : 'Sent via AIDA');
        if (!docResult.success) {
          return { error: `WhatsApp document send failed: ${docResult.error}` };
        }
      }
      return { success: true, to: name, phoneNumber: resolvedNumber, forwardedFile: attachment?.filename || null };
    },
  },
];
