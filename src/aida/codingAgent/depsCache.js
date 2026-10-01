const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const tar = require('tar');
const blobStorage = require('../../utils/blobStorage');

/**
 * AIDA roadmap item 2 — node_modules caching across coding-agent job runs.
 * Every sandbox is materialized fresh (see sandbox.js/githubApi.js — no
 * container reuse), so a cold `npm install` was previously paid on every
 * single job, even when the repo's dependencies hadn't changed since the
 * last run. Keyed by a hash of that repo's own package-lock.json — a
 * matching hash means npm would have installed the exact same dependency
 * tree anyway, so restoring the previous install's node_modules verbatim is
 * equivalent to (and much faster than) reinstalling it.
 *
 * Safe to restore blindly here specifically because every sandbox job runs
 * on the SAME Azure App Service instance every time (confirmed via
 * sandbox.js's own os.tmpdir()-based design, no per-job container) — there
 * is no cross-machine/cross-arch portability risk a cached node_modules
 * would normally carry, and this repo's own dependencies (checked directly)
 * have no native/compiled addons anyway (mssql runs on pure-JS tedious,
 * bcryptjs is pure JS — nothing here needs node-gyp).
 *
 * Stored in its own PRIVATE blob container (see blobStorage.js's
 * ensurePrivateContainer) — separate from the public-read logo container,
 * since a cached dependency tree has no reason to be publicly fetchable.
 * Save only actually runs (and is only awaited) on a cache miss — a cache
 * hit skips `npm install` entirely, so nothing here adds cost to the common
 * case.
 */

const CACHE_CONTAINER = process.env.AZURE_STORAGE_BUILD_CACHE_CONTAINER || 'aida-build-cache';

function lockfileHash(sandboxDir) {
  const lockPath = path.join(sandboxDir, 'package-lock.json');
  if (!fs.existsSync(lockPath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(lockPath)).digest('hex');
}

/** Tries to restore a cached node_modules for this sandbox's exact package-lock.json. Returns true on a real restore, false otherwise (caller should fall back to a normal npm install either way). */
async function tryRestore(sandboxDir) {
  const hash = lockfileHash(sandboxDir);
  if (!hash) return false;
  const blobName = `node_modules-${hash}.tar.gz`;
  const tmpFile = path.join(os.tmpdir(), `aida-depscache-restore-${hash}-${process.pid}-${Date.now()}.tar.gz`);
  try {
    const buffer = await blobStorage.downloadBuffer(blobName, CACHE_CONTAINER);
    if (!buffer) return false;
    fs.writeFileSync(tmpFile, buffer);
    await tar.x({ file: tmpFile, cwd: sandboxDir });
    return fs.existsSync(path.join(sandboxDir, 'node_modules'));
  } catch {
    return false; // corrupt/partial blob, permission issue, etc — never fail the job over a cache miss
  } finally {
    fs.rm(tmpFile, { force: true }, () => {});
  }
}

/**
 * Packs this sandbox's node_modules and uploads it for next time — only
 * actually happens on a cache miss (a changed/new lockfile), so this cost is
 * paid occasionally, not on every run. Callers await this directly (sandboxes
 * stay on disk for the whole job here, not just during install, so there's
 * no reason to risk a background upload racing a later cleanup).
 */
async function saveCache(sandboxDir) {
  const hash = lockfileHash(sandboxDir);
  if (!hash) return;
  if (!fs.existsSync(path.join(sandboxDir, 'node_modules'))) return;
  const blobName = `node_modules-${hash}.tar.gz`;

  const existing = await blobStorage.downloadBuffer(blobName, CACHE_CONTAINER).catch(() => null);
  if (existing) return; // another job already cached this exact lockfile — skip the (large) re-upload

  const tmpFile = path.join(os.tmpdir(), `aida-depscache-save-${hash}-${process.pid}-${Date.now()}.tar.gz`);
  await tar.c({ gzip: true, file: tmpFile, cwd: sandboxDir }, ['node_modules']);
  try {
    await blobStorage.ensurePrivateContainer(CACHE_CONTAINER);
    const buffer = fs.readFileSync(tmpFile);
    await blobStorage.uploadBuffer(buffer, blobName, 'application/gzip', CACHE_CONTAINER);
  } finally {
    fs.rm(tmpFile, { force: true }, () => {});
  }
}

/** Best-effort wrapper — never let a cache-save failure surface as a job failure. */
async function saveCacheSafely(sandboxDir, label) {
  try {
    await saveCache(sandboxDir);
  } catch (e) {
    console.error(`[aida] depsCache save failed (${label}):`, e.message);
  }
}

module.exports = { tryRestore, saveCache, saveCacheSafely };
