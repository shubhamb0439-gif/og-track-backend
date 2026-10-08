const coreDb = require('../db/core');

/**
 * Durable record of emails the monitor has already surfaced to WhatsApp —
 * written once per processed message in emailMonitor.js's processMessage().
 * Exists specifically so a later "reply to them" WhatsApp instruction has
 * something to resolve against: Graph's message id/sender/subject were
 * previously only local variables inside processMessage, thrown away the
 * moment that function returned.
 */

function newId() {
  return `emaillog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function logEmail({ graphMessageId, watchedAddress, fromAddress, subject, summary, isUrgent, whatsappSent, whatsappError }) {
  const id = newId();
  await coreDb('ai_email_log').insert({
    id,
    graph_message_id: graphMessageId,
    watched_address: watchedAddress,
    from_address: fromAddress,
    subject,
    summary,
    is_urgent: !!isUrgent,
    // Nullable rather than defaulted to false — null means "we don't know"
    // (e.g. a caller that never checked), distinct from a confirmed failure.
    whatsapp_sent: whatsappSent === undefined ? null : !!whatsappSent,
    whatsapp_error: whatsappError || null,
  });
  return { id, graphMessageId };
}

/** Most recently logged email — the natural default for "reply to them" with no explicit reference. */
async function getMostRecent() {
  return coreDb('ai_email_log').orderBy('created_at', 'desc').first();
}

async function getById(id) {
  return coreDb('ai_email_log').where({ id }).first();
}

module.exports = { logEmail, getMostRecent, getById };
