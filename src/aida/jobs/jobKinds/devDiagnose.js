const os = require('os');
const path = require('path');
const fsp = require('fs/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');
const config = require('../../../config');
const { generateReport } = require('../reportLLM');

const execFileAsync = promisify(execFile);

/**
 * READ-ONLY repo diagnosis — no code execution, ever. This is the interim,
 * lower-isolation alternative to the full sandboxed dev/deploy pipeline in
 * the AIDA power-tier plan: it clones a repo, reads text source files, and
 * asks an LLM to write a report. It never runs `npm install`, never runs a
 * test suite, never executes anything from the cloned tree — the only
 * operations against the clone are `git clone` (network) and plain file
 * reads. That's what makes it safe to run in this same backend process
 * instead of waiting on an isolated sandbox: reading text has a fundamentally
 * smaller blast radius than executing code.
 */
// Kept conservative on purpose — found by testing that og-track-backend's real
// size at the old 150_000-byte budget (~37k tokens of source alone) blew past
// a 30k-TPM account's whole per-request limit on its own. 60_000 bytes is
// ~15k tokens, leaving real headroom under even a small rate-limit tier.
const MAX_TOTAL_BYTES = 60_000;
const MAX_FILE_BYTES = 10_000;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'vendor', 'coverage', '.venv']);
const TEXT_EXTENSIONS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.json', '.md', '.sql', '.yml', '.yaml',
  '.html', '.css', '.py', '.java', '.go', '.rb', '.php', '.txt', '.env.example',
]);
// Common source-adjacent files have no extension at all (path.extname would
// return ''), so they'd silently vanish from every diagnosis without this —
// found by testing against a repo whose only file is literally 'README'.
const TEXT_FILENAMES_NO_EXT = new Set([
  'README', 'LICENSE', 'CHANGELOG', 'CONTRIBUTING', 'Dockerfile', 'Makefile',
  'Procfile', '.gitignore', '.env.example', '.dockerignore', '.eslintrc', '.prettierrc',
]);

async function collectFiles(rootDir) {
  const collected = [];
  let totalBytes = 0;

  async function walk(dir) {
    if (totalBytes >= MAX_TOTAL_BYTES) return;
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (totalBytes >= MAX_TOTAL_BYTES) return;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
        continue;
      }
      const isKnownTextFile = TEXT_EXTENSIONS.has(path.extname(entry.name)) || TEXT_FILENAMES_NO_EXT.has(entry.name);
      if (!isKnownTextFile) continue;
      const full = path.join(dir, entry.name);
      let content;
      try {
        const buf = await fsp.readFile(full);
        content = buf.subarray(0, MAX_FILE_BYTES).toString('utf8');
      } catch {
        continue; // unreadable/binary-ish — skip rather than fail the whole job
      }
      totalBytes += content.length;
      collected.push({ path: path.relative(rootDir, full).replace(/\\/g, '/'), content });
    }
  }

  await walk(rootDir);
  return collected;
}

function isAuthorized(repo) {
  return config.aida.authorizedRepos.includes(repo);
}

module.exports = {
  async run(job, { appendEvent, updateStatus }) {
    const { repo } = job.payload || {};
    if (!repo) {
      await updateStatus(job.id, 'failed', { errorMessage: 'Missing repo in job payload' });
      return;
    }
    // Defense in depth — the tool handler already checked this before creating
    // the job, but the job itself re-checks so nothing can reach a clone step
    // without being on the allowlist, regardless of how the job was created.
    if (!isAuthorized(repo)) {
      await updateStatus(job.id, 'failed', { errorMessage: `Repo "${repo}" is not authorized for AIDA repo access.` });
      return;
    }

    await appendEvent(job.id, 'started', { repo });

    const token = config.aida.githubToken;
    const cloneUrl = token
      ? `https://x-access-token:${token}@github.com/${repo}.git`
      : `https://github.com/${repo}.git`;
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aida-diagnose-'));

    try {
      await execFileAsync('git', ['clone', '--depth', '1', cloneUrl, tmpDir], { timeout: 60_000 });
      await appendEvent(job.id, 'cloned', { repo });

      const files = await collectFiles(tmpDir);
      await appendEvent(job.id, 'analyzing', { fileCount: files.length });

      const report = await generateReport(repo, files);
      await updateStatus(job.id, 'completed', { result: { repo, fileCount: files.length, report } });
      await appendEvent(job.id, 'completed');
    } catch (e) {
      // Never let the embedded access token leak into a stored error message
      // (git sometimes echoes the remote URL back on failure).
      const safeMessage = token ? e.message.split(token).join('***') : e.message;
      await updateStatus(job.id, 'failed', { errorMessage: safeMessage });
      await appendEvent(job.id, 'failed', { error: safeMessage });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  },
};
