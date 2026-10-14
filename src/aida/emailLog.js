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

async function logEmail({ graphMessageId, watchedAddress, fromAddress, subject, summary, isUrgent, whatsappSent, whatsappError, whatsappMessageId }) {
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
    // IMPORTANT: this only reflects whether Meta's API ACCEPTED the send —
    // see updateWhatsAppDeliveryStatus below for the real, later outcome.
    whatsapp_sent: whatsappSent === undefined ? null : !!whatsappSent,
    whatsapp_error: whatsappError || null,
    whatsapp_message_id: whatsappMessageId || null,
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

/**
 * Called from routes/whatsapp.js's webhook when a "statuses" callback
 * arrives for a message id this module previously recorded — the REAL
 * delivery outcome, which can genuinely differ from whatsapp_sent (Meta
 * accepting the send is not the same as the phone receiving it). Only
 * updates a row if that message id is actually one we logged; a status
 * callback for some other AIDA-sent message (a normal chat reply, not an
 * email alert) has nothing to match here and is a no-op.
 */
async function updateWhatsAppDeliveryStatus(whatsappMessageId, { status, error } = {}) {
  if (!whatsappMessageId) return false;
  const updates = {};
  if (status === 'failed') {
    updates.whatsapp_sent = false;
    updates.whatsapp_error = error || 'Delivery failed (reported by WhatsApp status callback).';
  } else if (status === 'delivered' || status === 'read') {
    updates.whatsapp_sent = true;
    updates.whatsapp_error = null;
  } else {
    return false;
  }
  const count = await coreDb('ai_email_log').where({ whatsapp_message_id: whatsappMessageId }).update(updates);
  return count > 0;
}

module.exports = { logEmail, getMostRecent, getById, updateWhatsAppDeliveryStatus };
