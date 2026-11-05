const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { resolveTenant } = require('../db/tenantConnections');
const { issueTokenPair } = require('../utils/auth');
const { recordLoginAttempt } = require('../utils/loginAttempts');
const { createHandoffCode, consumeHandoffCode } = require('../utils/ssoHandoff');
const { getTenantSsoMsalClient } = require('../utils/tenantSsoClient');

// AIDA roadmap item 18 Phase 2 — tenant-user Microsoft SSO, mounted directly
// at /api/tenant-sso (NOT under /api/:slug) since Entra needs ONE fixed,
// pre-registered redirect URI shared by every company — the company slug
// rides in the signed `state` param instead (set by routes/users.js's
// GET /sso/login, which DOES run under /api/:slug/users and so already has
// req.company). This mirrors masteradmin.js's /sso/callback shape, just
// resolving a tenant DB from the decoded slug instead of always meaning
// OGCore, and never auto-creating a user account — SSO only ever LINKS an
// existing active row by email on first use, exactly like masteradmin's own
// SSO, so a stranger with a Microsoft account can't self-register into a
// company just by knowing its slug.
const router = express.Router();

function stripPassword(u) {
  const { password_hash, ...safe } = u;
  return safe;
}

router.get('/callback', async (req, res) => {
  if (!config.tenantSso.enabled) return res.status(503).json({ error: 'Microsoft SSO is not configured on this server.' });

  const { code, state, error, error_description: errorDescription } = req.query;

  let slug = null;
  const failureRedirect = (message) => {
    const url = new URL(config.tenantSso.frontendCallbackUrl);
    url.searchParams.set('error', message);
    if (slug) url.searchParams.set('slug', slug);
    return res.redirect(url.toString());
  };

  if (error) return failureRedirect(errorDescription || error);
  if (!code || !state) return res.status(400).json({ error: 'Missing authorization code or state' });

  try {
    const decoded = jwt.verify(state, config.app.jwtSecret);
    if (decoded.type !== 'tenant_sso_state' || !decoded.slug) throw new Error('bad state');
    slug = decoded.slug;
  } catch {
    return res.status(400).json({ error: 'This sign-in link is invalid or expired. Please start again from the company login page.' });
  }

  let emailForLog = 'unknown';
  try {
    const { company, db } = await resolveTenant(slug);

    const result = await getTenantSsoMsalClient().acquireTokenByCode({
      code,
      scopes: ['openid', 'profile', 'email'],
      redirectUri: config.tenantSso.redirectUri,
    });
    const claims = result.idTokenClaims || {};
    // A work/school account carries `oid`; a personal Microsoft account
    // (outlook.com/hotmail.com) has no `oid` at all, only `sub` — both are
    // stable per-account identifiers, so either is accepted here.
    const microsoftId = claims.oid || claims.sub;
    const email = (claims.preferred_username || claims.email || '').toLowerCase();
    emailForLog = email || 'unknown';
    if (!microsoftId) throw new Error('Microsoft did not return an account identifier for this sign-in.');

    let user = await db('users').where({ microsoft_oid: microsoftId }).first();
    if (!user && email) {
      // First-ever SSO login for an existing password-based account — match
      // once by email, then store microsoft_oid so every future login at
      // THIS company resolves by id directly.
      user = await db('users').where({ email }).first();
      if (user) await db('users').where({ id: user.id }).update({ microsoft_oid: microsoftId, updated_at: new Date() });
    }
    if (!user) {
      recordLoginAttempt({ scope: 'tenant_user', companySlug: slug, emailTried: emailForLog, ip: req.ip, success: false });
      return failureRedirect('No account at this company matches your Microsoft identity. Ask your admin to add you first.');
    }
    if (user.status === 'pending') {
      recordLoginAttempt({ scope: 'tenant_user', companySlug: slug, emailTried: user.email, ip: req.ip, success: false });
      return failureRedirect('Account pending Super Admin approval.');
    }
    if (user.status === 'rejected') {
      recordLoginAttempt({ scope: 'tenant_user', companySlug: slug, emailTried: user.email, ip: req.ip, success: false });
      return failureRedirect('Account request was rejected.');
    }

    const { token, refreshToken } = issueTokenPair({ userId: user.id, role: user.role, slug: company.slug });
    recordLoginAttempt({ scope: 'tenant_user', companySlug: slug, emailTried: user.email, ip: req.ip, success: true });
    const handoffCode = createHandoffCode({ token, refreshToken, user: stripPassword(user) });
    const url = new URL(config.tenantSso.frontendCallbackUrl);
    url.searchParams.set('code', handoffCode);
    url.searchParams.set('slug', slug);
    res.redirect(url.toString());
  } catch (e) {
    recordLoginAttempt({ scope: 'tenant_user', companySlug: slug, emailTried: emailForLog, ip: req.ip, success: false });
    failureRedirect(e.message);
  }
});

// Same one-time code -> real tokens exchange as masteradmin's /sso/exchange
// (src/utils/ssoHandoff.js is the shared store behind both) — keeps the
// real JWTs out of the browser URL/history/server logs.
router.post('/exchange', async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'code is required' });
    const payload = consumeHandoffCode(code);
    if (!payload) return res.status(400).json({ error: 'This sign-in link has expired or was already used. Please sign in again.' });
    res.json(payload);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
