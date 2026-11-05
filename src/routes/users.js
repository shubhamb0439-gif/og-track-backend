const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { hashPassword, verifyPassword, issueTokenPair, verifyRefreshToken, requireAuth } = require('../utils/auth');
const { matchTodayCelebrations } = require('../aida/celebrations');
const { sendEmail } = require('../utils/email');
const { loginRateLimit } = require('../middleware/loginRateLimit');
const { recordLoginAttempt } = require('../utils/loginAttempts');
const { getTenantSsoMsalClient } = require('../utils/tenantSsoClient');

const router = express.Router();

function stripPassword(u) {
  const { password_hash, ...safe } = u;
  return safe;
}

const todayStr = () => new Date().toISOString().slice(0, 10);

// Parses a 'YYYY-MM-DD' (or ISO datetime prefix) string into its date parts,
// or returns null if it isn't a real, parseable calendar date.
function parseDateOnly(input) {
  if (!input) return null;
  const s = String(input).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  // Catches calendar-invalid dates like 2024-02-30 (which JS Date would
  // otherwise silently roll over into March).
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return { dateStr: s, year, month, day };
}

// GET /api/:slug/users
router.get('/', async (req, res) => {
  try {
    const rows = await req.db('users').select('*');
    res.json(rows.map(stripPassword));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/users/register
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, role, dateOfBirth } = req.body;
    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: 'name, email, password, and role are required' });
    }

    // dateOfBirth is optional at registration — plenty of people fill it in
    // later via the "please enter your DOB" prompt instead.
    let date_of_birth = null;
    if (dateOfBirth) {
      const parsed = parseDateOnly(dateOfBirth);
      if (!parsed) return res.status(400).json({ error: 'dateOfBirth must be a valid date (YYYY-MM-DD)' });
      date_of_birth = parsed.dateStr;
    }

    const emailLower = email.toLowerCase();
    const existing = await req.db('users').where({ email: emailLower }).first();
    if (existing) return res.status(400).json({ error: 'Email already registered.' });

    const password_hash = await hashPassword(password);
    const id = 'u' + Date.now();
    // joining_date is always today — it's literally this person's onboarding date.
    const user = { id, name, email: emailLower, password_hash, role, status: 'pending', date_of_birth, joining_date: todayStr() };
    await req.db('users').insert(user);

    const safe = stripPassword(user);
    req.io.to(req.company.slug).emit('user:registered', safe);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/:slug/users/today-celebrations — everyone in this tenant having a
// birthday or work anniversary today. No extra auth beyond normal tenant
// scoping: every logged-in user in the company should see today's list.
router.get('/today-celebrations', async (req, res) => {
  try {
    const rows = await req.db('users').select('id', 'name', 'date_of_birth', 'joining_date');
    const results = [];
    for (const row of rows) {
      for (const c of matchTodayCelebrations(row.date_of_birth, row.joining_date)) {
        results.push({ userId: row.id, name: row.name, type: c.type, yearsCount: c.yearsCount ?? null });
      }
    }
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/:slug/users/me/dob — the calling (authenticated) user sets
// their own date_of_birth.
router.patch('/me/dob', requireAuth, async (req, res) => {
  try {
    if (req.auth.slug !== req.company.slug) {
      return res.status(401).json({ error: 'Token is not valid for this company' });
    }
    const parsed = parseDateOnly(req.body.dateOfBirth);
    if (!parsed) return res.status(400).json({ error: 'dateOfBirth is required and must be a valid date (YYYY-MM-DD)' });

    const now = new Date();
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const givenUtc = Date.UTC(parsed.year, parsed.month - 1, parsed.day);
    if (givenUtc > todayUtc) return res.status(400).json({ error: 'dateOfBirth cannot be in the future' });

    const user = await req.db('users').where({ id: req.auth.userId }).first();
    if (!user) return res.status(404).json({ error: 'User not found' });

    await req.db('users').where({ id: req.auth.userId }).update({ date_of_birth: parsed.dateStr, updated_at: new Date() });
    const updated = await req.db('users').where({ id: req.auth.userId }).first();
    const safe = stripPassword(updated);
    req.io.to(req.company.slug).emit('user:updated', safe);
    res.json(safe);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/users/login
router.post('/login', loginRateLimit, async (req, res) => {
  const { email, password } = req.body;
  let logged = false;
  const log = (success) => { if (!logged) { logged = true; recordLoginAttempt({ scope: 'tenant_user', companySlug: req.company.slug, emailTried: email, ip: req.ip, success }); } };
  try {
    const user = await req.db('users').where({ email: (email || '').toLowerCase() }).first();
    if (!user) { log(false); return res.status(401).json({ error: 'Incorrect email or password.' }); }

    // AIDA roadmap item 18 Phase 2 — once an account has been explicitly
    // switched to sso_only, password login is rejected outright regardless
    // of whether the password itself is correct. Not auto-flipped by
    // anything shipped alongside this yet (see routes/tenantSso.js's
    // /callback) — every existing user's password login is completely
    // unaffected until this is deliberately turned on for a specific account.
    if (user.sso_only) {
      log(false);
      return res.status(403).json({ error: 'This account signs in with Microsoft only.', ssoOnly: true, ssoLoginUrl: `/api/${req.company.slug}/users/sso/login` });
    }
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) { log(false); return res.status(401).json({ error: 'Incorrect email or password.' }); }
    if (user.status === 'pending') { log(false); return res.status(403).json({ error: 'Account pending Super Admin approval.' }); }
    if (user.status === 'rejected') { log(false); return res.status(403).json({ error: 'Account request was rejected.' }); }

    const { token, refreshToken } = issueTokenPair({ userId: user.id, role: user.role, slug: req.company.slug });
    log(true);
    res.json({ token, refreshToken, user: stripPassword(user) });
  } catch (e) { log(false); res.status(500).json({ error: e.message }); }
});

// ── GET /api/:slug/users/sso/login ───────────────────────────────────────
// AIDA roadmap item 18 Phase 2 — redirects to Microsoft's sign-in page for
// THIS company. The company slug is embedded in a short-lived signed `state`
// (verified in routes/tenantSso.js's shared /callback) since Entra only
// allows ONE fixed, pre-registered redirect URI shared across every company
// — req.company is already resolved here (this router runs under
// resolveTenant), so a bad/suspended slug 404s/403s before Microsoft is even
// involved, same as every other route on this router.
router.get('/sso/login', async (req, res) => {
  if (!config.tenantSso.enabled) return res.status(503).json({ error: 'Microsoft SSO is not configured on this server.' });
  try {
    const state = jwt.sign({ type: 'tenant_sso_state', slug: req.company.slug }, config.app.jwtSecret, { expiresIn: '10m' });
    const url = await getTenantSsoMsalClient().getAuthCodeUrl({
      scopes: ['openid', 'profile', 'email'],
      redirectUri: config.tenantSso.redirectUri,
      state,
    });
    res.redirect(url);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/:slug/users/refresh ────────────────────────────────────────
// Fixes the "forced to log in again once the access token expires" issue —
// mints a fresh access token from a still-valid refresh token, no password
// needed. Re-checks the user still exists and is active in THIS company's
// DB (not just trusting the refresh token's own payload) — a user deleted
// or suspended after their refresh token was issued must not be able to
// silently re-authorize forever just because the token hasn't expired yet.
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return res.status(400).json({ error: 'refreshToken is required' });
    let payload;
    try {
      payload = verifyRefreshToken(refreshToken);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired refresh token — please log in again.' });
    }
    if (payload.slug !== req.company.slug) {
      return res.status(403).json({ error: 'This refresh token does not belong to this company.' });
    }
    const user = await req.db('users').where({ id: payload.userId }).first();
    if (!user || user.status !== 'active') {
      return res.status(401).json({ error: 'This account is no longer active — please log in again.' });
    }
    const { token, refreshToken: newRefreshToken } = issueTokenPair({ userId: user.id, role: user.role, slug: req.company.slug });
    res.json({ token, refreshToken: newRefreshToken });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const GENERIC_FORGOT_PASSWORD_MESSAGE = 'If that email is registered and approved, a password reset link has been sent.';

function hashResetToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// POST /api/:slug/users/forgot-password — body: { email }. ALWAYS responds
// with the same generic message regardless of whether the email exists, is
// approved, or the send itself failed — never let this endpoint confirm or
// deny that a given address is registered (a classic account-enumeration
// leak otherwise). Real failures are logged server-side, not surfaced.
router.post('/forgot-password', async (req, res) => {
  try {
    const email = (req.body?.email || '').toLowerCase().trim();
    if (email) {
      const user = await req.db('users').where({ email }).first();
      // Only 'active' (admin-approved) accounts get a real link — matches
      // the same gate login() already enforces for pending/rejected users.
      if (user && user.status === 'active') {
        const rawToken = crypto.randomBytes(32).toString('hex');
        await req.db('users').where({ id: user.id }).update({
          reset_token_hash: hashResetToken(rawToken),
          reset_token_expires: new Date(Date.now() + RESET_TOKEN_TTL_MS),
          updated_at: new Date(),
        });
        if (config.email.enabled && config.email.frontendBaseUrl) {
          const link = `${config.email.frontendBaseUrl.replace(/\/+$/, '')}/reset-password?token=${rawToken}&company=${encodeURIComponent(req.company.slug)}`;
          sendEmail({
            to: user.email,
            subject: 'Reset your OG Track password',
            html: `<p>Hi ${user.name},</p><p>Click below to reset your OG Track password. This link expires in 1 hour and can only be used once.</p><p><a href="${link}">Reset your password</a></p><p>If you didn't request this, you can safely ignore this email.</p>`,
            text: `Reset your OG Track password: ${link}\n\nThis link expires in 1 hour and can only be used once. If you didn't request this, you can safely ignore this email.`,
          }).catch((e) => console.error('[users] forgot-password email send failed:', e.message));
        } else {
          console.error('[users] forgot-password: email not configured (AZURE_ACS_EMAIL_CONNECTION_STRING/SENDER/FRONTEND_BASE_URL) — no email sent.');
        }
      }
    }
    res.json({ success: true, message: GENERIC_FORGOT_PASSWORD_MESSAGE });
  } catch (e) {
    console.error('[users] forgot-password failed:', e.message);
    // Still generic — an internal error here must not look different from "not found" to the caller.
    res.json({ success: true, message: GENERIC_FORGOT_PASSWORD_MESSAGE });
  }
});

// POST /api/:slug/users/reset-password — body: { token, newPassword }.
router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) return res.status(400).json({ error: 'token and newPassword are required' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'newPassword must be at least 8 characters.' });

    const tokenHash = hashResetToken(token);
    const user = await req.db('users').where({ reset_token_hash: tokenHash }).first();
    if (!user || !user.reset_token_expires || new Date(user.reset_token_expires) < new Date()) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
    }

    const password_hash = await hashPassword(newPassword);
    await req.db('users').where({ id: user.id }).update({
      password_hash, reset_token_hash: null, reset_token_expires: null, updated_at: new Date(),
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/:slug/users/:id/status
router.patch('/:id/status', async (req, res) => {
  try {
    await req.db('users').where({ id: req.params.id }).update({ status: req.body.status, updated_at: new Date() });
    const user = await req.db('users').where({ id: req.params.id }).first();
    if (!user) return res.status(404).json({ error: 'User not found' });
    const safe = stripPassword(user);
    req.io.to(req.company.slug).emit('user:updated', safe);
    res.json(safe);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/:slug/users/:id/role
router.patch('/:id/role', async (req, res) => {
  try {
    await req.db('users').where({ id: req.params.id }).update({ role: req.body.role, updated_at: new Date() });
    const user = await req.db('users').where({ id: req.params.id }).first();
    if (!user) return res.status(404).json({ error: 'User not found' });
    const safe = stripPassword(user);
    req.io.to(req.company.slug).emit('user:updated', safe);
    res.json(safe);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
