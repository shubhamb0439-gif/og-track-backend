const crypto = require('crypto');

// AIDA roadmap item 18 — hands the real token/refreshToken from the SSO
// callback (a browser redirect, so the URL/history/referrer/server logs are
// all real exposure) to the frontend SPA without ever putting the JWTs
// themselves in the URL. /sso/callback stores the real payload here and
// redirects with only a short-lived, single-use opaque code; the frontend
// then POSTs that code to /sso/exchange to get the real tokens back in a
// JSON response body instead. In-memory only (matches sessionMemory.js's own
// "ephemeral, no DB needed for something this short-lived" convention) — a
// server restart simply invalidates any in-flight handoff, which just means
// the person signs in again.
const TTL_MS = 60 * 1000;
const codes = new Map(); // code -> { payload, expiresAt }

function sweep() {
  const now = Date.now();
  for (const [code, entry] of codes) {
    if (entry.expiresAt < now) codes.delete(code);
  }
}

function createHandoffCode(payload) {
  sweep();
  const code = crypto.randomBytes(24).toString('hex');
  codes.set(code, { payload, expiresAt: Date.now() + TTL_MS });
  return code;
}

// Single-use: deletes the entry on the very first read, valid or not.
function consumeHandoffCode(code) {
  sweep();
  const entry = codes.get(code);
  if (!entry) return null;
  codes.delete(code);
  if (entry.expiresAt < Date.now()) return null;
  return entry.payload;
}

module.exports = { createHandoffCode, consumeHandoffCode };
