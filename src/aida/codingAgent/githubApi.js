const fs = require('fs');
const path = require('path');

/**
 * Git-binary-free repo operations, built entirely on GitHub's REST/Git Data
 * API. Exists because `git` itself isn't installed in Azure App Service's
 * default Node.js runtime (confirmed live: `spawn git ENOENT`) — this whole
 * feature only ever worked on a dev machine with Git for Windows/git
 * pre-installed until this file existed. Every operation here is a plain
 * fetch() call, so it works identically in any Node environment.
 *
 * The trade-off for not shelling out to git: there's no local git history/
 * diffing to lean on, so "what changed" is computed by comparing the
 * sandbox's current on-disk files against a snapshot taken right after
 * materializing them (see materializeSandbox's returned `originalFiles`).
 */

class GitHubApiError extends Error {}

async function githubRequest(token, method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'aida-coding-agent',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new GitHubApiError(`GitHub API ${method} ${path} failed (${res.status}): ${data?.message || 'unknown error'}`);
  }
  return data;
}

/** Files/dirs never materialized into (or read back out of) a sandbox — mirrors what a real .gitignore'd clone would never have anyway. */
const SKIP_PREFIXES = ['node_modules/', '.git/'];

function shouldSkip(relPath) {
  return SKIP_PREFIXES.some((p) => relPath === p.slice(0, -1) || relPath.startsWith(p));
}

/**
 * Downloads every file in `ref`'s tree into `destDir` via the Contents-free
 * Git Data API (one recursive tree listing + one blob fetch per file — no
 * tarball/zip extraction, no external dependency). Returns everything a
 * later commitAll/pushBranch call needs to diff against and commit on top
 * of: the base commit/tree SHAs, and a snapshot of every file's exact bytes
 * at materialization time.
 */
async function materializeSandbox({ owner, repo, token, ref = 'main', destDir }) {
  const refData = await githubRequest(token, 'GET', `/repos/${owner}/${repo}/git/refs/heads/${ref}`);
  const baseCommitSha = refData.object.sha;
  const commitData = await githubRequest(token, 'GET', `/repos/${owner}/${repo}/git/commits/${baseCommitSha}`);
  const baseTreeSha = commitData.tree.sha;

  const treeData = await githubRequest(token, 'GET', `/repos/${owner}/${repo}/git/trees/${baseTreeSha}?recursive=1`);
  if (treeData.truncated) {
    // GitHub caps a single recursive tree response — would need per-directory
    // pagination to handle a repo this large. Every repo this has run
    // against so far is well under that cap; fail loudly rather than
    // silently materialize a partial, misleading sandbox.
    throw new Error(`${owner}/${repo}'s tree at ${ref} is too large for a single recursive listing — materializeSandbox needs per-directory pagination added for repos this size.`);
  }

  const blobEntries = treeData.tree.filter((e) => e.type === 'blob' && !shouldSkip(e.path));
  const originalFiles = new Map(); // relPath (posix, forward-slash) -> Buffer

  // Bounded concurrency — same spirit as the voice module's filler warm-up:
  // firing every blob fetch at once risks the same kind of rate/connection
  // ceiling, sequential would be needlessly slow for a few hundred files.
  const CONCURRENCY = 8;
  let next = 0;
  async function worker() {
    while (next < blobEntries.length) {
      const entry = blobEntries[next++];
      const blob = await githubRequest(token, 'GET', `/repos/${owner}/${repo}/git/blobs/${entry.sha}`);
      const buf = Buffer.from(blob.content, blob.encoding || 'base64');
      const absPath = path.join(destDir, ...entry.path.split('/'));
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, buf);
      originalFiles.set(entry.path, buf);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, blobEntries.length) }, worker));

  return { baseCommitSha, baseTreeSha, originalFiles };
}

/** Walks `dir` (skipping the same paths materialization skipped, plus the sandbox's own dummy .env) and returns every file as relPath -> Buffer, posix-style paths regardless of host OS. */
function snapshotCurrentFiles(dir) {
  const resolvedRoot = fs.realpathSync(dir);
  const files = new Map();
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      const rel = path.relative(resolvedRoot, abs).split(path.sep).join('/');
      if (shouldSkip(rel) || rel === '.env') continue;
      if (entry.isDirectory()) { walk(abs); continue; }
      files.set(rel, fs.readFileSync(abs));
    }
  }
  walk(resolvedRoot);
  return files;
}

/**
 * Compares the sandbox's current on-disk state against its materialization-
 * time snapshot and, if anything changed, creates a new commit (new blobs +
 * a new tree layered on the base tree + a commit pointing at it) — but does
 * NOT move any branch ref yet, matching git's own commit/push split (see
 * updateBranchRef). Returns { committed: false } if nothing actually
 * differs, exactly like the git-based commitAll's "nothing to commit" case.
 */
async function commitChanges({ owner, repo, token, dir, originalFiles, baseCommitSha, baseTreeSha, message }) {
  const current = snapshotCurrentFiles(dir);
  const treeEntries = [];

  for (const [relPath, buf] of current) {
    const original = originalFiles.get(relPath);
    if (original && original.equals(buf)) continue; // unchanged
    const blob = await githubRequest(token, 'POST', `/repos/${owner}/${repo}/git/blobs`, {
      content: buf.toString('base64'), encoding: 'base64',
    });
    treeEntries.push({ path: relPath, mode: '100644', type: 'blob', sha: blob.sha });
  }
  for (const relPath of originalFiles.keys()) {
    if (!current.has(relPath)) treeEntries.push({ path: relPath, mode: '100644', type: 'blob', sha: null }); // deletion
  }

  if (!treeEntries.length) return { committed: false, reason: 'Nothing to commit — the agent made no file changes.' };

  const tree = await githubRequest(token, 'POST', `/repos/${owner}/${repo}/git/trees`, {
    base_tree: baseTreeSha, tree: treeEntries,
  });
  const commit = await githubRequest(token, 'POST', `/repos/${owner}/${repo}/git/commits`, {
    message, tree: tree.sha, parents: [baseCommitSha],
  });
  return { committed: true, commitSha: commit.sha };
}

/** Creates (or, if it already exists, force-updates) a branch ref pointing at `commitSha` — the "push" half of the git analogy. */
async function updateBranchRef({ owner, repo, token, branch, commitSha }) {
  try {
    await githubRequest(token, 'POST', `/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${branch}`, sha: commitSha,
    });
  } catch (e) {
    if (!/already exists/i.test(e.message)) throw e;
    await githubRequest(token, 'PATCH', `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
      sha: commitSha, force: true,
    });
  }
}

module.exports = { materializeSandbox, snapshotCurrentFiles, commitChanges, updateBranchRef, GitHubApiError };
