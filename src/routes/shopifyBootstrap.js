const express = require('express');
const config = require('../config');
const router = express.Router();

/**
 * ONE-TIME bootstrap for getting a permanent Shopify Admin API access token
 * out of the "Sitara drapes ERP" embedded app, without ever finding a static
 * "reveal token" screen in Shopify's current Dev Dashboard UI (there doesn't
 * appear to be one for this app — confirmed by checking its Overview page
 * directly; this app's own `application_url` already points at THIS backend's
 * real production domain, which is what makes this approach possible at all).
 *
 * Mechanism: Shopify's "token exchange" flow — this page loads inside the
 * Shopify admin iframe (that's what GET / renders when someone opens the app
 * from their store's Apps list), uses App Bridge to mint a short-lived ID
 * token proving an authenticated admin session, and POSTs it here. This route
 * exchanges that ID token for a REAL, non-expiring offline Admin API access
 * token via Shopify's own /admin/oauth/access_token endpoint — the same kind
 * of token a "reveal once" screen would have shown, just obtained a different
 * way. The resulting token is logged server-side only (never echoed back to
 * the browser) — copy it from the App Service log stream into
 * SHOPIFY_ADMIN_API_TOKEN, then this whole file can be deleted; it has no
 * ongoing purpose once the real token exists.
 */

function base64UrlDecode(str) {
  const normalized = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

// GET / — the app's embedded entry point (application_url in the Dev
// Dashboard already points straight at this backend's root, so opening
// "Sitara drapes ERP" from the store's Apps list loads this page in the
// Shopify admin iframe).
router.get('/', (req, res) => {
  if (!config.shopify.shopDomain || !config.shopify.clientId) {
    res.status(503).send('Shopify bootstrap not configured — SHOPIFY_SHOP_DOMAIN/SHOPIFY_CLIENT_ID missing.');
    return;
  }
  // Required on every HTML route Shopify embeds, per their own docs — the
  // admin iframe won't render the page at all without this exact directive,
  // scoped to this one shop (not a wildcard — Shopify's own review tooling
  // flags wildcards here).
  res.set(
    'Content-Security-Policy',
    `frame-ancestors https://${config.shopify.shopDomain} https://admin.shopify.com;`
  );
  res.set('Content-Type', 'text/html');
  res.send(`<!doctype html>
<html>
<head>
  <meta name="shopify-api-key" content="${config.shopify.clientId}" />
  <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
</head>
<body>
  <p id="status">Connecting to Shopify...</p>
  <script>
    (async () => {
      const statusEl = document.getElementById('status');
      try {
        const idToken = await shopify.idToken();
        const resp = await fetch('/shopify-bootstrap/exchange', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + idToken },
        });
        const data = await resp.json();
        statusEl.textContent = data.ok
          ? 'Connected — token generated. You can close this tab.'
          : ('Error: ' + (data.error || 'unknown'));
      } catch (e) {
        statusEl.textContent = 'Error: ' + e.message;
      }
    })();
  </script>
</body>
</html>`);
});

// POST /shopify-bootstrap/exchange — receives the ID token from the page
// above and performs the actual token exchange.
router.post('/shopify-bootstrap/exchange', async (req, res) => {
  try {
    const idToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!idToken) return res.status(400).json({ ok: false, error: 'missing id token' });

    const payload = JSON.parse(base64UrlDecode(idToken.split('.')[1]));
    const shopHost = new URL(payload.dest).hostname;

    const body = new URLSearchParams({
      client_id: config.shopify.clientId,
      client_secret: config.shopify.webhookSecret, // Shopify's client secret
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: idToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
      expiring: '0', // non-expiring offline token — this IS the permanent shpat_ token we want
    });

    const tokenResp = await fetch(`https://${shopHost}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const tokenData = await tokenResp.json();

    if (!tokenResp.ok || !tokenData.access_token) {
      console.error('[shopify-bootstrap] token exchange failed:', JSON.stringify(tokenData));
      return res.status(502).json({ ok: false, error: 'token exchange failed — see server logs' });
    }

    console.log('================================================================');
    console.log('[shopify-bootstrap] SHOPIFY ADMIN API ACCESS TOKEN — copy this into');
    console.log('SHOPIFY_ADMIN_API_TOKEN, then this bootstrap route can be removed:');
    console.log(tokenData.access_token);
    console.log('================================================================');

    res.json({ ok: true });
  } catch (e) {
    console.error('[shopify-bootstrap] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
