const crypto = require('crypto');

/**
 * Direct structural copy of ogtrack-backend's masteradmin.js /deploy-notify
 * check (x-deploy-secret header there, Authorization: Bearer here — matching
 * the OUTBOUND convention that backend already uses for its own calls to
 * GitHub/WhatsApp/Graph) — length-check first so timingSafeEqual never
 * throws on mismatched buffer lengths, then a true constant-time compare.
 */
function requireBearer(req, res, next) {
  const expected = process.env.VPS_BRIDGE_SECRET || '';
  if (!expected) {
    return res.status(503).json({ error: 'This bridge has no VPS_BRIDGE_SECRET configured — refusing all requests.' });
  }
  const header = req.headers.authorization || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  const ok = provided.length === expected.length && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!ok) {
    return res.status(401).json({ error: 'Invalid or missing bridge secret.' });
  }
  next();
}

module.exports = { requireBearer };
