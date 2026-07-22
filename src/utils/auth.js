const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');

async function hashPassword(plain) {
  return bcrypt.hash(plain, config.app.bcryptRounds);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

/** Issues a short-lived JWT carrying just enough to identify the user + tenant. */
function issueToken({ userId, role, slug }) {
  return jwt.sign({ userId, role, slug }, config.app.jwtSecret, { expiresIn: '12h' });
}

function verifyToken(token) {
  return jwt.verify(token, config.app.jwtSecret); // throws if invalid/expired
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

module.exports = { hashPassword, verifyPassword, issueToken, verifyToken, requireAuth };
