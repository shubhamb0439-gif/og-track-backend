/**
 * AIDA HTTP Client
 * ============================================================================
 * Every tool calls existing OGTrack APIs over real HTTP, not in-process
 * function calls — per the explicit requirement that existing route files
 * stay completely untouched. This module is the one place that knows how to
 * build a correct, tenant-scoped, authenticated request to "itself".
 * ============================================================================
 */

// Node 18+ has global fetch; if running on an older Node, `node-fetch` would
// need to be added as a dependency. Not assumed here — using global fetch to
// avoid adding a new package for something the runtime may already provide.

function buildUrl(ctx, path) {
  // Mirrors the exact same path-building the frontend's adapter already does
  // (see index.html's rewriteApiPath): tenant-scoped routes are always
  // /api/{slug}/{rest}. AIDA itself is mounted at /api/:slug/aida, so
  // req.protocol/req.get('host') from the original request is reused to
  // target the same running server rather than hardcoding a URL.
  const base = process.env.AIDA_SELF_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}/api/${ctx.slug}${cleanPath}`;
}

async function apiRequest(ctx, method, path, body) {
  const url = buildUrl(ctx, path);
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      // Forward the REAL user's token as-is. This is what makes permission
      // enforcement "just work" for AIDA: if this user's token wouldn't be
      // allowed to see this data via a normal frontend request, the exact
      // same middleware on the exact same route rejects AIDA's request too.
      ...(ctx.token ? { Authorization: `Bearer ${ctx.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // Surface a clean, tool-level error rather than throwing a raw fetch/SQL
    // exception up into the chat response — matches the existing project-
    // wide convention of never exposing raw backend errors to the user.
    const err = new Error((data && data.error) || `Request to ${path} failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const apiGet = (ctx, path) => apiRequest(ctx, 'GET', path);
const apiPost = (ctx, path, body) => apiRequest(ctx, 'POST', path, body);
const apiPatch = (ctx, path, body) => apiRequest(ctx, 'PATCH', path, body);

module.exports = { apiGet, apiPost, apiPatch };