const config = require('../config');
const coreDb = require('../db/core');

/**
 * Zoho Books OAuth2 (AIDA roadmap item 5) — the first per-tenant-credential
 * OAuth2 integration in this codebase (every integration before this is a
 * single global API key in .env). A "connection" is per ZOHO ORGANIZATION,
 * not per OG Track company — confirmed live that Sitara Drapes (its own
 * separate OG Track tenant DB) books through OG Plus's own Zoho
 * organization under a dedicated Branch, not a separate Zoho subscription.
 * See ogtrack-sql-schema/core/patch_06_zoho_connections.sql for why this is
 * two tables (connections, and a company->connection link with an optional
 * branch_id) rather than one.
 */

function newId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Read-only scopes cover every "pull data in" case (invoices, contacts,
// bills/expenses, banking, reports); ALL (not just READ/CREATE) on invoices
// specifically is needed for the one write path this item also has — pushing
// a locally-created sale out to Zoho as a real invoice.
const SCOPES = [
  'ZohoBooks.invoices.ALL',
  'ZohoBooks.contacts.ALL',
  'ZohoBooks.bills.READ',
  'ZohoBooks.expenses.READ',
  'ZohoBooks.banking.READ',
  'ZohoBooks.reports.READ',
  'ZohoBooks.settings.READ', // branches live under settings — needed to list them when linking a second company to a connection
].join(',');

/** Step 1 of OAuth — where to send the browser so the human can grant access. `state` round-trips through Zoho so the callback knows which company/flow initiated it. */
function buildAuthUrl(state) {
  const u = new URL('/oauth/v2/auth', config.zoho.accountsBaseUrl);
  u.searchParams.set('client_id', config.zoho.clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', config.zoho.redirectUri);
  u.searchParams.set('scope', SCOPES);
  u.searchParams.set('access_type', 'offline'); // required to get a refresh_token at all, not just a short-lived access_token
  u.searchParams.set('prompt', 'consent'); // forces Zoho to re-issue a refresh_token even on a repeat consent — without this, re-connecting an already-authorized app silently omits it
  u.searchParams.set('state', state);
  return u.toString();
}

/** Step 2 — Zoho's callback hands us a one-time `code`; exchange it for real tokens. */
async function exchangeCodeForTokens(code) {
  const u = new URL('/oauth/v2/token', config.zoho.accountsBaseUrl);
  u.searchParams.set('grant_type', 'authorization_code');
  u.searchParams.set('client_id', config.zoho.clientId);
  u.searchParams.set('client_secret', config.zoho.clientSecret);
  u.searchParams.set('redirect_uri', config.zoho.redirectUri);
  u.searchParams.set('code', code);
  const res = await fetch(u.toString(), { method: 'POST' });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`Zoho token exchange failed: ${data.error || res.status}`);
  return data; // { access_token, refresh_token, expires_in, api_domain, token_type }
}

/** Refreshes an access token using the stored refresh_token — refresh_tokens themselves don't expire (until revoked), so this never needs re-consent. */
async function refreshAccessToken(refreshToken) {
  const u = new URL('/oauth/v2/token', config.zoho.accountsBaseUrl);
  u.searchParams.set('grant_type', 'refresh_token');
  u.searchParams.set('client_id', config.zoho.clientId);
  u.searchParams.set('client_secret', config.zoho.clientSecret);
  u.searchParams.set('refresh_token', refreshToken);
  const res = await fetch(u.toString(), { method: 'POST' });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`Zoho token refresh failed: ${data.error || res.status}`);
  return data; // { access_token, expires_in, api_domain, token_type } — no new refresh_token on this grant type
}

/** The one real Zoho API call that needs no organization_id — used right after connecting to find out which org was just authorized. */
async function listOrganizations(accessToken, apiDomain) {
  const res = await fetch(`${apiDomain || config.zoho.apiBaseUrl}/books/v3/organizations`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  const data = await res.json();
  if (!res.ok || data.code !== 0) throw new Error(`Zoho organizations lookup failed: ${data.message || res.status}`);
  return data.organizations || [];
}

async function createConnection({ displayName, zohoOrganizationId, tokens, connectedBy }) {
  const id = newId('zohoconn');
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  await coreDb('zoho_connections').insert({
    id, display_name: displayName, zoho_organization_id: zohoOrganizationId,
    access_token: tokens.access_token, refresh_token: tokens.refresh_token,
    token_expires_at: expiresAt, api_domain: tokens.api_domain || null, connected_by: connectedBy || null,
  });
  return id;
}

/** Upsert — re-connecting an org that's already linked updates its tokens in place rather than creating a duplicate connection row (enforced by the UNIQUE constraint on zoho_organization_id anyway). */
async function upsertConnectionByOrg({ displayName, zohoOrganizationId, tokens, connectedBy }) {
  const existing = await coreDb('zoho_connections').where({ zoho_organization_id: zohoOrganizationId }).first();
  if (existing) {
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
    await coreDb('zoho_connections').where({ id: existing.id }).update({
      access_token: tokens.access_token, refresh_token: tokens.refresh_token,
      token_expires_at: expiresAt, api_domain: tokens.api_domain || existing.api_domain,
    });
    return existing.id;
  }
  return createConnection({ displayName, zohoOrganizationId, tokens, connectedBy });
}

/**
 * Links a company to a connection, with EITHER a Zoho Location/Branch id
 * (zohoBranchId — for an org that actually has Locations enabled) OR a list
 * of specific customer contact_ids (customerIdsFilter — for an org like OG
 * Plus's, where Locations is disabled and a sub-business's transactions are
 * instead all billed to a small set of known placeholder customer contacts).
 * A company only ever needs one of the two; both are null for a company
 * that IS its whole connected org (e.g. CAJO). One row per company,
 * enforced by the UNIQUE constraint on company_id.
 */
async function linkCompany({ companyId, zohoConnectionId, zohoBranchId, customerIdsFilter }) {
  const customerIdsJson = customerIdsFilter ? JSON.stringify(customerIdsFilter) : null;
  const existing = await coreDb('zoho_company_links').where({ company_id: companyId }).first();
  if (existing) {
    await coreDb('zoho_company_links').where({ id: existing.id })
      .update({ zoho_connection_id: zohoConnectionId, zoho_branch_id: zohoBranchId || null, zoho_customer_ids_filter: customerIdsJson });
    return existing.id;
  }
  const id = newId('zoholink');
  await coreDb('zoho_company_links').insert({ id, company_id: companyId, zoho_connection_id: zohoConnectionId, zoho_branch_id: zohoBranchId || null, zoho_customer_ids_filter: customerIdsJson });
  return id;
}

/** Everything a data call needs for one company: a guaranteed-fresh access token, the org id, the right API host, and that company's filter (branch, customer-id list, or neither). Refreshes lazily — only calls Zoho again when the stored token has actually expired. */
async function getActiveConnectionForCompany(companyId) {
  const link = await coreDb('zoho_company_links').where({ company_id: companyId }).first();
  if (!link) return null;
  const conn = await coreDb('zoho_connections').where({ id: link.zoho_connection_id }).first();
  if (!conn) return null;

  let accessToken = conn.access_token;
  // 60s safety margin so a token that's about to expire mid-request doesn't slip through.
  if (new Date(conn.token_expires_at).getTime() - Date.now() < 60_000) {
    const refreshed = await refreshAccessToken(conn.refresh_token);
    accessToken = refreshed.access_token;
    const expiresAt = new Date(Date.now() + refreshed.expires_in * 1000);
    await coreDb('zoho_connections').where({ id: conn.id }).update({ access_token: accessToken, token_expires_at: expiresAt });
  }

  let customerIdsFilter = null;
  if (link.zoho_customer_ids_filter) {
    try { customerIdsFilter = JSON.parse(link.zoho_customer_ids_filter); } catch { /* leave null — malformed data shouldn't crash a read */ }
  }

  return {
    accessToken, apiDomain: conn.api_domain || config.zoho.apiBaseUrl,
    organizationId: conn.zoho_organization_id, branchId: link.zoho_branch_id || null,
    customerIdsFilter,
  };
}

async function listConnections() {
  return coreDb('zoho_connections').select('id', 'display_name', 'zoho_organization_id', 'connected_at', 'connected_by');
}

async function listCompanyLinks() {
  return coreDb('zoho_company_links as l')
    .join('companies as c', 'c.id', 'l.company_id')
    .join('zoho_connections as conn', 'conn.id', 'l.zoho_connection_id')
    .select('c.id as companyId', 'c.name as companyName', 'c.slug as companySlug',
      'l.zoho_branch_id as branchId', 'conn.id as connectionId', 'conn.display_name as connectionName');
}

module.exports = {
  buildAuthUrl, exchangeCodeForTokens, refreshAccessToken, listOrganizations,
  upsertConnectionByOrg, linkCompany, getActiveConnectionForCompany,
  listConnections, listCompanyLinks,
};
