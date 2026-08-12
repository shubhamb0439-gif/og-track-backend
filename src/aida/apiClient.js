const config = require('../config');

/**
 * The one and only way AIDA reaches OG Track's data. It never touches
 * req.db / Knex — every tool ends up here, and here just makes a normal
 * HTTP request back into this same Express app (loopback), carrying the
 * caller's own Authorization header and slug.
 *
 * That means every existing gate (resolveTenant, requireModule, and any
 * per-route authorization logic) runs exactly as it would for a browser
 * request. AIDA never decides permissions — the API being called does,
 * same as always.
 */
class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode || 500;
  }
}

async function request(pathname, { method = 'GET', query, body, authHeader } = {}) {
  const url = new URL(pathname, config.aida.internalBaseUrl);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    }
  }

  const headers = { 'Content-Type': 'application/json' };
  if (authHeader) headers.Authorization = authHeader;

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError(`OG Track API unreachable: ${e.message}`, 502);
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    throw new ApiError((data && data.error) || `Request to ${pathname} failed (${res.status})`, res.status);
  }
  return data;
}

/** Calls a tenant-scoped endpoint: /api/:slug/<path> */
function callTenantApi(context, method, path, opts = {}) {
  return request(`/api/${context.tenantSlug}${path}`, {
    method,
    authHeader: context.authHeader,
    ...opts,
  });
}

/** Calls a platform-level endpoint that isn't slug-scoped: /api/<path> (companies, masteradmin) */
function callPlatformApi(context, method, path, opts = {}) {
  return request(`/api${path}`, {
    method,
    authHeader: context.authHeader,
    ...opts,
  });
}

module.exports = { callTenantApi, callPlatformApi, ApiError };
