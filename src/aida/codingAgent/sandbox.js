const fs = require('fs');
const path = require('path');
const os = require('os');
const { materializeSandbox } = require('./githubApi');
const vpsBridgeClient = require('./vpsBridgeClient');

/**
 * Sandbox lifecycle for the coding agent — a disposable working directory
 * the agent is allowed to read/write/run commands in, torn down when done.
 * Critically, this NEVER carries real secrets: the sandbox gets its own
 * throwaway .env with dummy values, just enough for `require('../../config')`
 * to not throw at load time, so `npm test` can run without ever touching a
 * real Azure SQL server, the real JWT secret, or anything else
 * production-shaped.
 *
 * Populated entirely via GitHub's REST/Git Data API (see githubApi.js), not
 * `git clone` — confirmed live that `git` itself isn't installed in Azure
 * App Service's default Node runtime (`spawn git ENOENT`), which is where
 * this needs to actually run for a chat request triggered against the
 * deployed backend, not just a local dev machine that happens to have Git
 * for Windows installed.
 */

// Dummy values — deliberately obviously-fake, never derived from any real
// secret, just enough to satisfy config.js's required() checks so the
// module graph loads. A job running in the sandbox has no legitimate reason
// to ever reach a real database anyway (it's editing/testing source code,
// not exercising live data paths).
const DUMMY_ENV = [
  'AZURE_SQL_SERVER=sandbox-not-real.database.windows.net',
  'AZURE_SQL_USER=sandbox',
  'AZURE_SQL_PASSWORD=sandbox-dummy-password-not-real',
  'JWT_SECRET=sandbox-dummy-jwt-secret-not-real',
  'PORT=39999',
].join('\n') + '\n';

/**
 * Downloads `ref` (default branch "main") of `owner/repo` into a fresh temp
 * directory via the GitHub API and writes the dummy .env. Returns
 * { dir, cleanup(), owner, repo, token, baseCommitSha, baseTreeSha,
 * originalFiles } — the last four are opaque state github.js's
 * commitAll/pushBranch need later to diff and commit on top of this exact
 * snapshot; callers shouldn't need to touch them directly.
 *
 * AIDA roadmap item 17 — `options.backend` picks WHERE that sandbox actually
 * lives: 'local' (default, unchanged — every existing call site that doesn't
 * pass this option keeps today's exact behavior) or 'vps', which provisions
 * the sandbox on a separate VPS via a real `git clone` instead of this
 * process's GitHub-Data-API materialization, and returns a `dir` that's a
 * "vps://<id>" marker string rather than a real local path — tools.js's
 * functions and github.js's commitAll/pushBranch recognize that marker and
 * route to vpsBridgeClient.js instead of local fs/child_process. Deliberately
 * NOT a global switch: only devFix.js opts in today (see its own comment on
 * why create_module/userReportedIssueBuild stay local for now).
 */
async function createSandbox(owner, repo, token, ref = 'main', { backend = 'local' } = {}) {
  if (backend === 'vps') {
    const { sandboxId, baseCommitSha } = await vpsBridgeClient.createSandbox({ owner, repo, token, ref, envFileContents: DUMMY_ENV });
    return {
      dir: `vps://${sandboxId}`, owner, repo, token, backend: 'vps', sandboxId,
      baseCommitSha, baseTreeSha: null, originalFiles: null,
      branch: null, // set by github.js's createBranch
      cleanup: () => vpsBridgeClient.deleteSandbox(sandboxId),
    };
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aida-coding-agent-'));
  const { baseCommitSha, baseTreeSha, originalFiles } = await materializeSandbox({ owner, repo, token, ref, destDir: dir });
  fs.writeFileSync(path.join(dir, '.env'), DUMMY_ENV, 'utf8');
  return {
    dir, owner, repo, token, backend: 'local', baseCommitSha, baseTreeSha, originalFiles,
    branch: null, // set by github.js's createBranch
    // Always a Promise regardless of backend, since VPS cleanup is a real
    // network call — callers can now safely `await sandbox.cleanup()`.
    cleanup: () => Promise.resolve().then(() => fs.rmSync(dir, { recursive: true, force: true })),
  };
}

module.exports = { createSandbox, DUMMY_ENV };
