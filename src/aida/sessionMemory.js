const config = require('../config');

/**
 * Lightweight, in-memory conversation memory — NOT a persistent AI memory
 * store. One entry per (tenant slug or masteradmin) + user, holding just the
 * recent message turns so follow-ups like "which one is delayed?" resolve
 * against "show my projects" without the user repeating context.
 *
 * Lives only in this Node process's RAM: it disappears on server restart,
 * expires on its own after a period of inactivity, and can be wiped
 * explicitly on logout via clearSession(). If OG Track is later scaled to
 * multiple instances, this is the piece that would move to Redis — nothing
 * else in src/aida/ depends on it being in-process.
 */
const sessions = new Map(); // sessionKey -> { messages: [{role, content}], updatedAt }

function sessionKeyFor(context) {
  return context.kind === 'masteradmin' ? `masteradmin:${context.userId}` : `${context.tenantSlug}:${context.userId}`;
}

function getHistory(context) {
  const key = sessionKeyFor(context);
  const entry = sessions.get(key);
  if (!entry) return [];
  if (Date.now() - entry.updatedAt > config.aida.sessionTtlMs) {
    sessions.delete(key);
    return [];
  }
  return entry.messages;
}

function appendTurn(context, userMessage, assistantMessage) {
  const key = sessionKeyFor(context);
  const entry = sessions.get(key) || { messages: [], updatedAt: Date.now() };
  entry.messages.push({ role: 'user', content: userMessage });
  entry.messages.push({ role: 'assistant', content: assistantMessage });
  // Bound memory growth — keep only the most recent N messages.
  const max = config.aida.maxHistoryMessages;
  if (entry.messages.length > max) entry.messages = entry.messages.slice(entry.messages.length - max);
  entry.updatedAt = Date.now();
  sessions.set(key, entry);
}

function clearSession(context) {
  sessions.delete(sessionKeyFor(context));
}

/** Passive cleanup so idle sessions don't sit in memory forever between requests. */
function sweepExpired() {
  const now = Date.now();
  for (const [key, entry] of sessions.entries()) {
    if (now - entry.updatedAt > config.aida.sessionTtlMs) sessions.delete(key);
  }
}

let sweepTimer = null;
function startSweeper() {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepExpired, 10 * 60 * 1000);
  sweepTimer.unref?.();
}

module.exports = { getHistory, appendTurn, clearSession, startSweeper, _sessions: sessions };
