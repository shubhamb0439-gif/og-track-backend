const config = require('../../config');

/**
 * AIDA roadmap item 17 — the one HTTP client every VPS-aware branch of
 * sandbox.js/tools.js/github.js calls through. Mirrors the AbortController +
 * timeout pattern browserless.js already uses, and the `Authorization:
 * Bearer <token>` convention githubApi.js/whatsapp.js already use for
 * outbound calls (never the deploy-notify endpoint's custom-header style —
 * that one is for an INCOMING request this backend verifies, not an
 * outgoing one it makes).
 *
 * Every function here corresponds to one endpoint on the standalone
 * `vps-bridge/` service deployed on the VPS (see docs/VPS_BRIDGE_DEPLOY.md
 * for the actual deploy steps) — never called directly by provider files or
 * job kinds; only sandbox.js/tools.js/github.js reach into this module.
 */

function baseUrl() {
  return config.aida.vpsBridge.baseUrl;
}

function secret() {
  return config.aida.vpsBridge.secret;
}

async function bridgeRequest(path, { method = 'POST', body, timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: { Authorization: `Bearer ${secret()}`, 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    // A network-level failure (DNS, connection refused, abort) looks nothing
    // like a normal error to whoever reads it later — jobRunner.js surfaces
    // errorMessage directly to a human reviewer, so make it say what
    // actually happened instead of a raw "fetch failed"/"The operation was
    // aborted" message.
    throw new Error(`VPS bridge unreachable (${method} ${path}): ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`VPS bridge ${method} ${path} failed (${res.status}): ${data?.error || 'unknown error'}`);
  }
  return data;
}

module.exports = {
  createSandbox: ({ owner, repo, token, ref, envFileContents }) =>
    bridgeRequest('/sandbox', { body: { owner, repo, token, ref, envFileContents }, timeoutMs: 60_000 }),

  readFile: (sandboxId, relPath) =>
    bridgeRequest(`/sandbox/${sandboxId}/read-file`, { body: { relPath } }),

  writeFile: (sandboxId, relPath, content) =>
    bridgeRequest(`/sandbox/${sandboxId}/write-file`, { body: { relPath, content } }),

  downloadFile: (sandboxId, relPath, url) =>
    bridgeRequest(`/sandbox/${sandboxId}/download-file`, { body: { relPath, url }, timeoutMs: 25_000 }),

  listFiles: (sandboxId, relDir, opts) =>
    bridgeRequest(`/sandbox/${sandboxId}/list-files`, { body: { relDir, ...opts } }),

  // HTTP timeout is deliberately longer than the bridge's own execFile
  // timeout — the bridge should return a clean {timedOut:true} result well
  // before this fires; this is only a backstop against a genuinely hung
  // bridge process, not the normal path.
  runCommand: (sandboxId, command, args, opts = {}) =>
    bridgeRequest(`/sandbox/${sandboxId}/run-command`, {
      body: { command, args, timeoutMs: opts.timeoutMs },
      timeoutMs: (opts.timeoutMs || 120_000) + 15_000,
    }),

  commit: (sandboxId, message) =>
    bridgeRequest(`/sandbox/${sandboxId}/commit`, { body: { message } }),

  push: (sandboxId, branch) =>
    bridgeRequest(`/sandbox/${sandboxId}/push`, { body: { branch } }),

  deleteSandbox: (sandboxId) =>
    bridgeRequest(`/sandbox/${sandboxId}`, { method: 'DELETE', timeoutMs: 10_000 }),
};
