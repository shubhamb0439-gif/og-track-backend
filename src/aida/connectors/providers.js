const config = require('../../config');

/**
 * Per-user AIDA OAuth connectors (Google Drive, GitHub, Notion, Slack) —
 * phase 1 (connect/disconnect/status only, see connectorStore.js and
 * routes/aida.js's /connectors routes). Each provider's OAuth2 shape is
 * built directly from that provider's own current documentation, the same
 * methodology used for Groq/OpenRouter/Gemini earlier in this roadmap — NOT
 * yet hands-on tested against a real registered OAuth app for any of the
 * four (no client id/secret exists on this server yet), so treat the exact
 * field names here as "built to spec" rather than "live-verified" until a
 * real connect round trip is run for each one.
 *
 * Every provider exposes the same four functions so connectorStore.js and
 * the routes never need a per-provider branch:
 *   buildAuthUrl(state)                 -> string
 *   exchangeCodeForTokens(code)         -> { accessToken, refreshToken, expiresInSec, email }
 *   refreshAccessToken(refreshToken)    -> { accessToken, expiresInSec } | null (null = this provider's tokens don't expire/can't be refreshed, nothing to do)
 *   fetchConnectedEmail(accessToken)    -> string | null (only called when exchangeCodeForTokens didn't already resolve one)
 */

const PROVIDER_IDS = ['google_drive', 'github', 'notion', 'slack'];

function cfg(providerId) {
  return config.aidaConnectors[providerId];
}

// ── Google Drive ─────────────────────────────────────────────────────────────
// Standard Google OAuth2 (accounts.google.com) — access_type=offline + the
// forced consent prompt mirror Zoho's own "force a refresh_token even on a
// repeat consent" trick (zohoAuth.js), same underlying problem.
const googleDrive = {
  buildAuthUrl(state) {
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.searchParams.set('client_id', cfg('google_drive').clientId);
    u.searchParams.set('redirect_uri', cfg('google_drive').redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', 'https://www.googleapis.com/auth/drive.readonly openid email');
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
    u.searchParams.set('state', state);
    return u.toString();
  },
  async exchangeCodeForTokens(code) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code,
        client_id: cfg('google_drive').clientId, client_secret: cfg('google_drive').clientSecret,
        redirect_uri: cfg('google_drive').redirectUri,
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(`Google token exchange failed: ${data.error_description || data.error || res.status}`);
    return { accessToken: data.access_token, refreshToken: data.refresh_token || null, expiresInSec: data.expires_in, email: null };
  },
  async refreshAccessToken(refreshToken) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: refreshToken,
        client_id: cfg('google_drive').clientId, client_secret: cfg('google_drive').clientSecret,
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(`Google token refresh failed: ${data.error_description || data.error || res.status}`);
    return { accessToken: data.access_token, expiresInSec: data.expires_in };
  },
  async fetchConnectedEmail(accessToken) {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return null;
    const data = await res.json();
    return data.email || null;
  },
};

// ── GitHub ───────────────────────────────────────────────────────────────────
// Classic OAuth App flow. refresh_token/expires_in only appear in the
// response if this OAuth App has "Enable expiring user tokens" turned on —
// refreshAccessToken is a no-op (returns null) when there's nothing to
// refresh, which connectorStore.js treats as "this access token just doesn't
// expire", not an error.
const github = {
  buildAuthUrl(state) {
    const u = new URL('https://github.com/login/oauth/authorize');
    u.searchParams.set('client_id', cfg('github').clientId);
    u.searchParams.set('redirect_uri', cfg('github').redirectUri);
    u.searchParams.set('scope', 'read:user user:email');
    u.searchParams.set('state', state);
    return u.toString();
  },
  async exchangeCodeForTokens(code) {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: cfg('github').clientId, client_secret: cfg('github').clientSecret,
        code, redirect_uri: cfg('github').redirectUri,
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(`GitHub token exchange failed: ${data.error_description || data.error || res.status}`);
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || null,
      expiresInSec: data.expires_in || null, // null = non-expiring (the common case for a classic OAuth App)
      email: null,
    };
  },
  async refreshAccessToken(refreshToken) {
    if (!refreshToken) return null;
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: cfg('github').clientId, client_secret: cfg('github').clientSecret,
        grant_type: 'refresh_token', refresh_token: refreshToken,
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(`GitHub token refresh failed: ${data.error_description || data.error || res.status}`);
    return { accessToken: data.access_token, expiresInSec: data.expires_in || null };
  },
  async fetchConnectedEmail(accessToken) {
    const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'OGTrack-AIDA' };
    const res = await fetch('https://api.github.com/user/emails', { headers });
    if (!res.ok) return null;
    const emails = await res.json();
    const primary = Array.isArray(emails) ? emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified) : null;
    if (primary) return primary.email;
    // Private-email users may return an empty list here — fall back to the profile's own public email, if any.
    const profileRes = await fetch('https://api.github.com/user', { headers });
    if (!profileRes.ok) return null;
    const profile = await profileRes.json();
    return profile.email || null;
  },
};

// ── Notion ───────────────────────────────────────────────────────────────────
// Notion's own internal-integration tokens don't expire — no refresh_token,
// no expiry, confirmed in Notion's own OAuth docs. The connected email comes
// straight back in the token-exchange response itself (data.owner.user), so
// fetchConnectedEmail is never actually called for this provider in
// practice — kept for interface symmetry only.
const notion = {
  buildAuthUrl(state) {
    const u = new URL('https://api.notion.com/v1/oauth/authorize');
    u.searchParams.set('client_id', cfg('notion').clientId);
    u.searchParams.set('redirect_uri', cfg('notion').redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('owner', 'user');
    u.searchParams.set('state', state);
    return u.toString();
  },
  async exchangeCodeForTokens(code) {
    const basic = Buffer.from(`${cfg('notion').clientId}:${cfg('notion').clientSecret}`).toString('base64');
    const res = await fetch('https://api.notion.com/v1/oauth/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: cfg('notion').redirectUri }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(`Notion token exchange failed: ${data.message || data.error || res.status}`);
    return {
      accessToken: data.access_token,
      refreshToken: null,
      expiresInSec: null,
      email: data.owner?.user?.person?.email || null,
    };
  },
  async refreshAccessToken() {
    return null; // Notion tokens don't expire — nothing to refresh
  },
  async fetchConnectedEmail() {
    return null; // always resolved at exchange time above
  },
};

// ── Slack ────────────────────────────────────────────────────────────────────
// "Sign in with Slack" (OpenID Connect) — deliberately NOT the bot/app-install
// flow (oauth.v2.access with a `scope` of bot permissions), since this is
// "connect MY OWN Slack account" per the spec, not "install a Slack app into
// a workspace". Confirms identity + email only, same phase-1 scope as every
// other provider here.
const slack = {
  buildAuthUrl(state) {
    const u = new URL('https://slack.com/openid/connect/authorize');
    u.searchParams.set('client_id', cfg('slack').clientId);
    u.searchParams.set('redirect_uri', cfg('slack').redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', 'openid email profile');
    u.searchParams.set('state', state);
    return u.toString();
  },
  async exchangeCodeForTokens(code) {
    const res = await fetch('https://slack.com/api/openid.connect.token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg('slack').clientId, client_secret: cfg('slack').clientSecret,
        code, redirect_uri: cfg('slack').redirectUri,
      }),
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) throw new Error(`Slack token exchange failed: ${data.error || res.status}`);
    return { accessToken: data.access_token, refreshToken: data.refresh_token || null, expiresInSec: data.expires_in || null, email: null };
  },
  async refreshAccessToken(refreshToken) {
    if (!refreshToken) return null; // token rotation isn't enabled on every Slack app — most connections never need this
    const res = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg('slack').clientId, client_secret: cfg('slack').clientSecret,
        grant_type: 'refresh_token', refresh_token: refreshToken,
      }),
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) throw new Error(`Slack token refresh failed: ${data.error || res.status}`);
    return { accessToken: data.access_token, expiresInSec: data.expires_in || null };
  },
  async fetchConnectedEmail(accessToken) {
    const res = await fetch('https://slack.com/api/openid.connect.userInfo', { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return null;
    const data = await res.json();
    return data.email || null;
  },
};

const REGISTRY = { google_drive: googleDrive, github, notion, slack };

function getProvider(providerId) {
  return REGISTRY[providerId] || null;
}

module.exports = { PROVIDER_IDS, getProvider };
