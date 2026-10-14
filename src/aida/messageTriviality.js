/**
 * Decides whether an outgoing WhatsApp/email message is simple/casual enough
 * to send WITHOUT the usual confirm-first round trip — explicit product
 * decision: someone asking AIDA to send a contact a quick "hi" shouldn't
 * then have to separately say "yes, send it" right after already asking
 * once. Anything longer, anything with an attachment, or anything touching
 * a sensitive/high-stakes topic still goes through the existing
 * preview-then-confirmed:true flow in send_email/reply_to_email/
 * message_contact — those ARE worth a real human double-check before a
 * genuine, irreversible send to someone outside the system.
 */

const WORD_LIMIT = 25;

// Deliberately broad and cheap (no LLM call) — a false "not trivial" just
// means one extra confirmation step for a message that was actually fine,
// which is a safe failure mode. A false "trivial" (sending something
// sensitive without asking) is the one to avoid, so this errs toward
// requiring confirmation whenever any of these show up.
const SENSITIVE_RE = /\b(payment|invoice|refund|contract|agreement|salary|bonus|terminat|resign|legal|lawsuit|confidential|password|otp|bank|account\s*number|urgent|asap|deadline|penalty|compliance|security|breach|warning|notice|apolog|complain|cancel|refuse|dispute|loan|credit\s*card|aadhaar|pan\s*card|overdue|lawyer|court|fired|layoff)\b/i;

function isTrivialMessage({ text, hasAttachment } = {}) {
  if (hasAttachment) return false;
  const trimmed = (text || '').trim();
  if (!trimmed) return false;
  if (SENSITIVE_RE.test(trimmed)) return false;
  return trimmed.split(/\s+/).length <= WORD_LIMIT;
}

module.exports = { isTrivialMessage };
