const { resolveTenant } = require('../../db/tenantConnections');

/**
 * Posts an AIDA-authored message into a tenant's EXISTING "Messages" module
 * (the real conversations/messages tables — see ogtrack-sql-schema/tenant/
 * 05_module_messaging.sql), targeted at that company's manager/developer/
 * tester users. Used by jobKinds/userReportedIssue.js to deliver a bug/
 * feature report's plan-of-action for review — this is deliberately the
 * durable, real Messages module (not a socket-only "notification" toast
 * like src/routes/bugs.js uses), so nothing is lost if the recipient is
 * offline when it's sent.
 *
 * The Messages schema requires a real sender_id (FK to users), and there is
 * no built-in "system" sender concept — this self-provisions a fixed,
 * non-loginable "AIDA" user row per tenant the first time it's needed,
 * rather than requiring a manual migration across every existing tenant DB.
 */

const AIDA_SYSTEM_USER_ID = 'aida-system';
const AIDA_REPORTS_CONVERSATION_ID = 'c-aida-reports';
const AIDA_REPORTS_CONVERSATION_NAME = 'AIDA Reports';
const NOTIFY_ROLES = ['manager', 'developer', 'tester'];

async function ensureAidaSystemUser(db) {
  const existing = await db('users').where({ id: AIDA_SYSTEM_USER_ID }).first();
  if (existing) return;
  await db('users').insert({
    id: AIDA_SYSTEM_USER_ID,
    name: 'AIDA',
    email: 'aida-system@internal.ogplus.in',
    // Never a valid bcrypt hash — this account can never pass a real login,
    // it exists only to satisfy messages.sender_id's FK constraint.
    password_hash: '!disabled!',
    role: 'system',
    status: 'active',
    created_at: new Date(),
    extra_json: JSON.stringify({ isSystemUser: true }),
  });
}

/** Returns the conversation id to post into, or null if there's nobody to notify yet. */
async function ensureReportsConversation(db) {
  const recipients = await db('users').whereIn('role', NOTIFY_ROLES).andWhere({ status: 'active' });

  const convo = await db('conversations').where({ id: AIDA_REPORTS_CONVERSATION_ID }).first();
  if (!convo) {
    if (!recipients.length) return null; // nobody to notify yet — don't create an empty conversation
    const now = new Date();
    await db('conversations').insert({
      id: AIDA_REPORTS_CONVERSATION_ID, name: AIDA_REPORTS_CONVERSATION_NAME, type: 'group',
      created_by: AIDA_SYSTEM_USER_ID, created_at: now, last_message_at: now, last_message: '',
    });
    await db('conversation_members').insert({ conversation_id: AIDA_REPORTS_CONVERSATION_ID, user_id: AIDA_SYSTEM_USER_ID, user_name: 'AIDA', unread_count: 0 });
    for (const u of recipients) {
      await db('conversation_members').insert({ conversation_id: AIDA_REPORTS_CONVERSATION_ID, user_id: u.id, user_name: u.name, unread_count: 0 });
    }
    return AIDA_REPORTS_CONVERSATION_ID;
  }

  // Keep membership current — include anyone who's taken on a notify-role since this was first created.
  const existingMemberIds = new Set((await db('conversation_members').where({ conversation_id: convo.id })).map((m) => m.user_id));
  for (const u of recipients) {
    if (!existingMemberIds.has(u.id)) {
      await db('conversation_members').insert({ conversation_id: convo.id, user_id: u.id, user_name: u.name, unread_count: 0 });
    }
  }
  return convo.id;
}

/**
 * @returns {Promise<{sent: boolean, reason?: string, conversationId?: string}>}
 */
async function notifyCompanyMessage(companySlug, text) {
  const { company, db } = await resolveTenant(companySlug);
  if (!company.enabled_modules.includes('messages')) {
    return { sent: false, reason: 'messages module not enabled for this company' };
  }

  await ensureAidaSystemUser(db);
  const convoId = await ensureReportsConversation(db);
  if (!convoId) return { sent: false, reason: 'no manager/developer/tester users found' };

  const id = 'm' + Date.now();
  const now = new Date();
  await db('messages').insert({ id, conversation_id: convoId, sender_id: AIDA_SYSTEM_USER_ID, sender_name: 'AIDA', text, sent_at: now, reply_to: null });

  const members = await db('conversation_members').where({ conversation_id: convoId });
  for (const m of members) {
    if (m.user_id !== AIDA_SYSTEM_USER_ID) {
      await db('conversation_members').where({ conversation_id: convoId, user_id: m.user_id }).increment('unread_count', 1);
    }
  }

  const preview = text.length > 60 ? `${text.slice(0, 60)}...` : text;
  await db('conversations').where({ id: convoId }).update({ last_message: preview, last_message_at: now });

  // Best-effort live push — same event shape messaging.js's own POST /:id/messages
  // route emits, so an already-connected client updates instantly; anyone offline
  // still sees it (and the correct unread_count) next time they load conversations.
  try {
    const io = require('./jobRunner').getIo();
    if (io) {
      const saved = { id, conversationId: convoId, senderId: AIDA_SYSTEM_USER_ID, senderName: 'AIDA', text, sentAt: now.toISOString(), replyTo: null, read: [] };
      members.forEach((m) => io.to(company.slug).emit(`message:new:${m.user_id}`, { convoId, message: saved }));
    }
  } catch (e) {
    console.error('[aida] notifyCompanyMessage: live socket push failed (message was still saved):', e.message);
  }

  return { sent: true, conversationId: convoId };
}

module.exports = { notifyCompanyMessage };
