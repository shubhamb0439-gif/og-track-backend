const crypto = require('crypto');

/**
 * Structural copy of vps-bridge's own requireBearer — same
 * Authorization: Bearer convention, but checked against its OWN dedicated
 * VPS_CODING_AGENT_SECRET, deliberately never reused from VPS_BRIDGE_SECRET
 * even though both run on the same VPS.
 */
function requireBearer(req, res, next) {
  const expected = process.env.VPS_CODING_AGENT_SECRET || '';
  if (!expected) {
    return res.status(503).json({ error: 'This service has no VPS_CODING_AGENT_SECRET configured — refusing all requests.' });
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
