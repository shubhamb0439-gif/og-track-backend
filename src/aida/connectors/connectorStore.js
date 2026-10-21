const coreDb = require('../../db/core');
const { PROVIDER_IDS, getProvider } = require('./providers');

/**
 * DB access for ai_oauth_connections (patch_14) — scope-aware so the same
 * functions serve both a tenant user's own connectors and a masteradmin's
 * own connectors. `scope` is always `{ companyId, userId }`, with
 * companyId === null for a masteradmin (see contextBuilder.js's
 * buildMasterAdminContext, which already sets companyId: null / userId:
 * req.admin.adminId — the exact same shape this module expects).
 */

function newId() {
  return `oauthconn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function scopeWhere(db, scope) {
  // company_id IS NULL needs its own clause — plain `.where({ company_id: null })`
  // does generate "company_id IS NULL" correctly in knex/mssql, but being
  // explicit here avoids any doubt given it's load-bearing for which of the
  // two filtered unique indexes (patch_14) a row actually satisfies.
  return scope.companyId
    ? db.where({ company_id: scope.companyId, user_id: scope.userId })
    : db.whereNull('company_id').andWhere({ user_id: scope.userId });
}

/** Always returns exactly 4 rows (one per known provider), connected:false for anything never set up. */
async function listForScope(scope) {
  const rows = await scopeWhere(coreDb('ai_oauth_connections'), scope).select('provider', 'connected_email', 'connected_at');
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  return PROVIDER_IDS.map((provider) => {
    const row = byProvider.get(provider);
    return row
      ? { provider, connected: true, connectedEmail: row.connected_email || null, connectedAt: row.connected_at }
      : { provider, connected: false };
  });
}

/** Upsert — reconnecting a provider already connected for this scope replaces its tokens in place rather than erroring on the unique index. */
async function upsertConnection(scope, providerId, tokens) {
  const expiresAt = tokens.expiresInSec ? new Date(Date.now() + tokens.expiresInSec * 1000) : null;
  const existing = await scopeWhere(coreDb('ai_oauth_connections'), scope).andWhere({ provider: providerId }).first();
  const fields = {
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken || null,
    token_expires_at: expiresAt,
    connected_email: tokens.email || null,
    updated_at: new Date(),
  };
  if (existing) {
    await coreDb('ai_oauth_connections').where({ id: existing.id }).update(fields);
    return existing.id;
  }
  const id = newId();
  await coreDb('ai_oauth_connections').insert({
    id, company_id: scope.companyId || null, user_id: scope.userId, provider: providerId, ...fields,
  });
  return id;
}

/** Returns true if a connection existed and was removed, false if there was nothing to disconnect (caller turns that into a 404). */
async function disconnect(scope, providerId) {
  const deleted = await scopeWhere(coreDb('ai_oauth_connections'), scope).andWhere({ provider: providerId }).delete();
  return deleted > 0;
}

/**
 * Not used by the phase-1 connect/disconnect/status routes themselves — kept
 * here now (same "build it once the shape is known" choice as
 * zohoAuth.getActiveConnectionForCompany) so phase 2's file-listing/attach
 * endpoints have a ready-made, already-refreshing token source instead of
 * reinventing this later. Returns null if nothing is connected for this
 * scope/provider.
 */
async function getActiveAccessToken(scope, providerId) {
  const row = await scopeWhere(coreDb('ai_oauth_connections'), scope).andWhere({ provider: providerId }).first();
  if (!row) return null;

  const provider = getProvider(providerId);
  const expiringSoon = row.token_expires_at && new Date(row.token_expires_at).getTime() - Date.now() < 60_000;
  if (!expiringSoon) return row.access_token;

  const refreshed = await provider.refreshAccessToken(row.refresh_token);
  if (!refreshed) return row.access_token; // this provider's tokens don't expire/can't be refreshed — the stored one is still the right one to use
  const expiresAt = refreshed.expiresInSec ? new Date(Date.now() + refreshed.expiresInSec * 1000) : null;
  await coreDb('ai_oauth_connections').where({ id: row.id }).update({ access_token: refreshed.accessToken, token_expires_at: expiresAt, updated_at: new Date() });
  return refreshed.accessToken;
}

module.exports = { listForScope, upsertConnection, disconnect, getActiveAccessToken };
