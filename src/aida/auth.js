const jwt = require('jsonwebtoken');
const config = require('../config');
const { verifyToken } = require('../utils/auth');

/**
 * AIDA is the one place in this backend that verifies the caller's JWT on
 * every request (most existing OG Track routes don't — they trust the
 * frontend to only call them from a logged-in session, see the note in
 * accounting.js). AIDA acts on the user's behalf across many modules in a
 * single turn, so it identifies the caller itself rather than trusting
 * whatever the request body claims — this does NOT change any existing
 * route's auth behavior.
 *
 * This does not grant AIDA any new authority: every tool call it makes
 * still goes through the target module's own route and its own
 * requireModule gate. This only pins down *who* is asking.
 */
function requireTenantAidaAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });
  let auth;
  try {
    auth = verifyToken(token);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  // A token issued for tenant A must not be usable to chat as tenant B.
  if (auth.slug !== req.params.slug) {
    return res.status(403).json({ error: 'This session token does not belong to this company.' });
  }
  req.auth = auth;
  next();
}

function requireMasterAdminAidaAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });
  try {
    const payload = jwt.verify(token, config.app.jwtSecret);
    if (payload.role !== 'masteradmin') return res.status(403).json({ error: 'Forbidden' });
    req.admin = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { requireTenantAidaAuth, requireMasterAdminAidaAuth };
