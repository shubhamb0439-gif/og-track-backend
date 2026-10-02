const config = require('../config');

/**
 * Ephemeral "last file the master admin sent AIDA over WhatsApp" store —
 * same in-memory-only, per-session shape as sessionMemory.js (not a
 * persistent record; a server restart or session expiry just means "AIDA
 * forgot the attachment," which is fine for a short conversational flow
 * like "here's the report" -> "send it to pooja@ogplus.in"). Deliberately
 * separate from sessionMemory's own Map, since this holds a real Buffer,
 * not a text transcript.
 */
const pending = new Map(); // sessionKey -> { filename, mimeType, buffer, text, updatedAt }

function keyFor(context) {
  return context.kind === 'masteradmin' ? `masteradmin:${context.userId}` : `${context.tenantSlug}:${context.userId}`;
}

function setPending(context, attachment) {
  pending.set(keyFor(context), { ...attachment, updatedAt: Date.now() });
}

function getPending(context) {
  const entry = pending.get(keyFor(context));
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > config.aida.sessionTtlMs) {
    pending.delete(keyFor(context));
    return null;
  }
  return entry;
}

function clearPending(context) {
  pending.delete(keyFor(context));
}

module.exports = { setPending, getPending, clearPending };
