const config = require('../config');

// AIDA roadmap item 18 Phase 2 — ONE shared MSAL client for every company's
// tenant-user SSO, registered as a multi-tenant + personal-accounts Entra
// app (authority `common`), deliberately separate from masteradmin.js's own
// single-tenant client. Lazily built and cached, same convention as
// masteradmin.js's getMsalClient().
let _client = null;
function getTenantSsoMsalClient() {
  if (!config.tenantSso.enabled) return null;
  if (!_client) {
    const { ConfidentialClientApplication } = require('@azure/msal-node');
    _client = new ConfidentialClientApplication({
      auth: {
        clientId: config.tenantSso.clientId,
        authority: 'https://login.microsoftonline.com/common',
        clientSecret: config.tenantSso.clientSecret,
      },
    });
  }
  return _client;
}

module.exports = { getTenantSsoMsalClient };
