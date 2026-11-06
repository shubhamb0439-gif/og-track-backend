const config = require('../../config');

/**
 * AIDA roadmap item 20 — the one HTTP client devFix.js calls through to run
 * the actual coding work via the real Claude Code CLI on the VPS, instead of
 * this process's own hand-rolled provider loop. Mirrors vpsBridgeClient.js's
 * AbortController/timeout/Bearer-auth pattern exactly, talking to a SEPARATE
 * standalone service (vps-coding-agent/) that shares the same sandbox
 * directory vps-bridge already cloned (via a shared Docker volume on the
 * VPS) rather than cloning anything itself.
 *
 * The HTTP timeout here is deliberately much longer than vpsBridgeClient's
 * own calls — a real coding task can run for several minutes inside the
 * Claude Code CLI itself, and the service's own internal process timeout
 * (CODING_AGENT_TIMEOUT_MS) should fire first and return a clean
 * {success:false} result well before this one does; this is only a backstop
 * against a genuinely hung service process.
 */

async function request(path, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${config.aida.vpsCodingAgent.baseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.aida.vpsCodingAgent.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    throw new Error(`VPS coding agent unreachable (${path}): ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`VPS coding agent ${path} failed (${res.status}): ${data?.error || 'unknown error'}`);
  }
  return data;
}

module.exports = {
  /**
   * Runs one headless Claude Code CLI turn against the sandbox vps-bridge
   * already cloned, identified by the same sandboxId. Resolves to the exact
   * { success, summary, toolLog } shape devFix.js already expects from
   * providers/anthropic.js's runCodingAgent, so the rest of the job (commit,
   * test gate, PR, approval) needs zero changes regardless of which engine
   * produced the result.
   */
  run: (sandboxId, task) => request('/run', { sandboxId, task }, 20 * 60 * 1000),
};
