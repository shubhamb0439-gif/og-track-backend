const fs = require('fs');
const path = require('path');

/**
 * Direct port of ogtrack-backend's tools.js `resolveSafe` — but enforced
 * HERE, server-side, rather than trusted from the caller. This bridge is a
 * network-reachable service, more exposed than a local fs call ever was, so
 * every file/exec route must re-derive the jail from the sandbox's OWN
 * directory (looked up via sandboxStore, never a client-supplied path) and
 * never trust a relPath/sandboxId pairing from the request body alone.
 */

class SandboxPathError extends Error {}

function resolveSafe(sandboxDir, relPath) {
  if (typeof relPath !== 'string' || !relPath.trim()) {
    throw new SandboxPathError('A path is required.');
  }
  const resolvedRoot = fs.realpathSync(sandboxDir);
  const candidate = path.resolve(resolvedRoot, relPath);
  const withinRoot = candidate === resolvedRoot || candidate.startsWith(resolvedRoot + path.sep);
  if (!withinRoot) {
    throw new SandboxPathError(`Path "${relPath}" resolves outside the sandbox — refused.`);
  }
  let ancestor = candidate;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return candidate;
    ancestor = parent;
  }
  const realAncestor = fs.realpathSync(ancestor);
  if (realAncestor !== resolvedRoot && !realAncestor.startsWith(resolvedRoot + path.sep)) {
    throw new SandboxPathError(`Path "${relPath}" resolves outside the sandbox via a symlink — refused.`);
  }
  return candidate;
}

module.exports = { resolveSafe, SandboxPathError };
