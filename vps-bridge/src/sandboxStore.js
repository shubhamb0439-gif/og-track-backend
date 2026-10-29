const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * In-memory registry of this bridge's sandbox directories. A sandboxId is
 * never an Azure-supplied path — it's always generated here via
 * crypto.randomUUID() and resolved back to a real directory ONLY through
 * this map, so an Azure caller can never point `relPath`/`sandboxId` at an
 * arbitrary location on this host.
 *
 * TTL sweep below is load-bearing, not polish: if the Azure process itself
 * crashes mid-job, `devFix.js`'s `finally { cleanup() }` never runs at all,
 * and without this sweep a crash leaks a sandbox directory on this VPS's
 * disk indefinitely.
 */

const SANDBOX_ROOT = process.env.SANDBOX_ROOT || '/sandboxes';
const TTL_MS = 2 * 60 * 60 * 1000; // 2 hours — generous relative to devFix.js's 50-iteration agent loop + 180s install/test timeouts
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

const sandboxes = new Map(); // sandboxId -> { dir, owner, repo, createdAt }

function create({ owner, repo, token }) {
  const sandboxId = crypto.randomUUID();
  const dir = path.join(SANDBOX_ROOT, sandboxId);
  // token is kept only so a later git error (e.g. an authentication failure
  // on push) can be scrubbed before it's logged/returned — the remote URL
  // already carries it on disk in .git/config from clone time regardless,
  // so this isn't a new exposure, just enough to redact it consistently.
  sandboxes.set(sandboxId, { dir, owner, repo, token, createdAt: Date.now() });
  return { sandboxId, dir };
}

function get(sandboxId) {
  return sandboxes.get(sandboxId) || null;
}

async function remove(sandboxId) {
  const entry = sandboxes.get(sandboxId);
  if (!entry) return false;
  sandboxes.delete(sandboxId);
  await fs.promises.rm(entry.dir, { recursive: true, force: true }).catch(() => {});
  return true;
}

function count() {
  return sandboxes.size;
}

async function sweepOrphans() {
  const now = Date.now();
  for (const [sandboxId, entry] of sandboxes) {
    if (now - entry.createdAt > TTL_MS) {
      console.error(`[vps-bridge] sweeping orphaned sandbox ${sandboxId} (age ${Math.round((now - entry.createdAt) / 60000)}min)`);
      await remove(sandboxId);
    }
  }
}

function startSweep() {
  const timer = setInterval(() => { sweepOrphans().catch((e) => console.error('[vps-bridge] sweep failed:', e.message)); }, SWEEP_INTERVAL_MS);
  timer.unref();
  return timer;
}

module.exports = { SANDBOX_ROOT, create, get, remove, count, startSweep };
