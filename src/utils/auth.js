const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');

async function hashPassword(plain) {
  return bcrypt.hash(plain, config.app.bcryptRounds);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

const ACCESS_TOKEN_TTL = '12h';
const REFRESH_TOKEN_TTL = '30d';

/**
 * Issues a short-lived JWT. Takes the whole payload object as-is (not
 * destructured to specific fields) so this one function works for every
 * caller's own shape — a tenant user ({userId, role, slug}) and a master
 * admin ({adminId, name, email, role}) alike.
 */
function issueToken(payload) {
  return jwt.sign(payload, config.app.jwtSecret, { expiresIn: ACCESS_TOKEN_TTL });
}

function verifyToken(token) {
  return jwt.verify(token, config.app.jwtSecret); // throws if invalid/expired
}

/**
 * Long-lived companion to issueToken — fixes the "forced to log in again
 * once the access token expires" problem: there was no way to get a new
 * access token without re-entering a password. Signed with a SEPARATE
 * secret (config.app.jwtRefreshSecret) so a leaked access token alone can
 * never be used to mint a refresh token, and carries a `type: 'refresh'`
 * marker so a refresh token can never be replayed as an access token even
 * if someone mixed up which verify function to call.
 *
 * Deliberately stateless (no DB-backed revocation list) for this first
 * pass — matches how every other "ship the real thing, not the maximal
 * thing" feature in this codebase has shipped. Known, accepted limitation:
 * a refresh token can't be individually revoked before it naturally
 * expires (e.g. there's no "log out this device remotely" yet) — real
 * scope for a later pass if that's ever actually needed, not blocking this
 * fix.
 */
function issueRefreshToken(payload) {
  return jwt.sign({ ...payload, type: 'refresh' }, config.app.jwtRefreshSecret, { expiresIn: REFRESH_TOKEN_TTL });
}

/** Verifies a refresh token and returns its payload — throws if invalid/expired/wrong secret, or if it's actually an access token. */
function verifyRefreshToken(token) {
  const payload = jwt.verify(token, config.app.jwtRefreshSecret);
  if (payload.type !== 'refresh') throw new Error('Not a refresh token.');
  return payload;
}

/** Issues both tokens together — the normal shape for a login response and a refresh response alike. */
function issueTokenPair(payload) {
  return {
    token: issueToken(payload),
    refreshToken: issueRefreshToken(payload),
  };
}

/** Express middleware: requires a valid Bearer token, attaches req.auth = {userId, role, slug} */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });
  try {
    req.auth = verifyToken(token);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = {
  hashPassword, verifyPassword, requireAuth,
  issueToken, verifyToken, issueRefreshToken, verifyRefreshToken, issueTokenPair,
};
