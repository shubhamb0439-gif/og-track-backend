const fs = require('fs');
const { execFile } = require('child_process');

/**
 * Git/GitHub operations for the coding agent's fix flow — separate from
 * sandbox.js (which only clones+preps a sandbox) and tools.js (the agent's
 * own read/write/list/run tools). Everything here is called by the job kind
 * AFTER the agent loop has already finished editing files, never by the
 * agent itself — the agent doesn't get direct git/GitHub tools, so it can't
 * push or open a PR on its own; only the job orchestration layer does that,
 * after the agent has already called `finish`.
 */

// No shell here, on any platform: unlike npm (a .cmd wrapper on Windows,
// hence tools.js's conditional shell:true), `git` is a real executable on
// every platform including Windows — adding a shell only broke multi-word
// arguments (confirmed live: `-m "fix: add x"` got word-split by cmd.exe
// into separate pathspec arguments, since Node doesn't re-quote array-form
// args for a Windows shell the way it does without one).
function execFileP(command, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(command, args, opts, (error, stdout, stderr) => {
      if (error) {
        const err = new Error(`${command} ${args.join(' ')} failed: ${error.message}\n${stderr || ''}`.trim());
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

/** Builds an authenticated HTTPS URL for push, without ever writing the token into .git/config (which would persist it on disk even after the sandbox is otherwise inert). */
function authenticatedRemoteUrl(owner, repo, token) {
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
}

/** Creates and checks out a new branch in the sandbox. Assumes the sandbox is already on some base branch (createSandbox clones the default branch). */
async function createBranch(sandboxDir, branchName) {
  await execFileP('git', ['checkout', '-b', branchName], { cwd: fs.realpathSync(sandboxDir) });
}

/**
 * Stages everything (respecting .gitignore, so the sandbox's own dummy .env
 * never gets staged) and commits with a fixed author identity — a fresh
 * sandbox clone has no inherited git identity to rely on, and this
 * shouldn't be attributed to whatever identity happens to be configured on
 * the host machine anyway.
 */
async function commitAll(sandboxDir, message) {
  const cwd = fs.realpathSync(sandboxDir);
  await execFileP('git', ['config', 'user.name', 'AIDA'], { cwd });
  await execFileP('git', ['config', 'user.email', 'aida@ogtrack.local'], { cwd });
  await execFileP('git', ['add', '-A'], { cwd });
  const status = await execFileP('git', ['status', '--porcelain'], { cwd });
  if (!status.stdout.trim()) {
    return { committed: false, reason: 'Nothing to commit — the agent made no file changes.' };
  }
  await execFileP('git', ['commit', '-m', message], { cwd });
  return { committed: true };
}

/** Pushes the current branch to `owner/repo` on GitHub using a token passed directly on the push URL — never written to the sandbox's own .git/config. */
async function pushBranch(sandboxDir, { owner, repo, token, branchName }) {
  const cwd = fs.realpathSync(sandboxDir);
  const url = authenticatedRemoteUrl(owner, repo, token);
  await execFileP('git', ['push', url, `HEAD:refs/heads/${branchName}`], { cwd });
}

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

/** Opens a PR from `head` (a branch on the SAME repo — no fork support needed here) into `base` (defaults to "main"). Returns the PR's number, html_url, etc. */
async function openPullRequest({ owner, repo, token, head, base = 'main', title, body }) {
  return githubRequest(token, 'POST', `/repos/${owner}/${repo}/pulls`, { title, head, base, body });
}

/** Fetches combined CI status for a PR's head commit — used by the jobs UI to show pass/fail without the human needing to leave OG Track to check. */
async function getCombinedStatus({ owner, repo, token, ref }) {
  return githubRequest(token, 'GET', `/repos/${owner}/${repo}/commits/${ref}/status`);
}

/** Merges a PR — called only from the job's approve endpoint, never automatically. */
async function mergePullRequest({ owner, repo, token, pullNumber }) {
  return githubRequest(token, 'PUT', `/repos/${owner}/${repo}/pulls/${pullNumber}/merge`, { merge_method: 'squash' });
}

/** Closes a PR without merging — called from the job's reject endpoint. */
async function closePullRequest({ owner, repo, token, pullNumber }) {
  return githubRequest(token, 'PATCH', `/repos/${owner}/${repo}/pulls/${pullNumber}`, { state: 'closed' });
}

module.exports = {
  createBranch, commitAll, pushBranch, openPullRequest, getCombinedStatus,
  mergePullRequest, closePullRequest, authenticatedRemoteUrl, GitHubApiError,
};
