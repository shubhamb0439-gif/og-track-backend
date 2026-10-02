const config = require('./../config');

/**
 * Shared Microsoft Graph client-credentials auth — originally private to
 * emailMonitor.js's poller, pulled out once a second real caller (sending/
 * replying to mail on AIDA's behalf) needed the identical token request.
 * Mints a fresh token per call rather than caching — these are infrequent,
 * human-triggered actions (a WhatsApp instruction, a poll tick), not a hot
 * path, so the extra round trip isn't worth the complexity of a cache with
 * expiry handling.
 */
async function getGraphToken() {
  const res = await fetch(`https://login.microsoftonline.com/${config.microsoftGraph.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.microsoftGraph.clientId,
      client_secret: config.microsoftGraph.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || `Graph token request failed (${res.status})`);
  return data.access_token;
}

module.exports = { getGraphToken };
