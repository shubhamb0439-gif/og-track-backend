const { commitChanges, updateBranchRef } = require('./githubApi');

/**
 * Git/GitHub operations for the coding agent's fix flow — separate from
 * sandbox.js (which only materializes+preps a sandbox) and tools.js (the
 * agent's own read/write/list/run tools). Everything here is called by the
 * job kind AFTER the agent loop has already finished editing files, never by
 * the agent itself — the agent doesn't get direct git/GitHub tools, so it
 * can't push or open a PR on its own; only the job orchestration layer does
 * that, after the agent has already called `finish`.
 *
 * createBranch/commitAll/pushBranch are built on GitHub's REST/Git Data API
 * (see githubApi.js), not a local `git` binary — confirmed live that `git`
 * isn't installed in Azure App Service's default Node runtime
 * (`spawn git ENOENT`), which is where this needs to actually run for a
 * request against the deployed backend, not just a dev machine that happens
 * to have git installed. All three now take the `sandbox` object
 * createSandbox() returns (not a bare directory path) since the diffing
 * this approach needs (no local git history to lean on) requires the
 * materialization-time snapshot and base commit/tree SHAs carried on it.
 */

/** No API call needed yet — the branch ref is only actually created once there's something to commit (see pushBranch). Just records the intended name. */
async function createBranch(sandbox, branchName) {
  sandbox.branch = branchName;
}

/**
 * Diffs the sandbox's current files against its materialization-time
 * snapshot and, if anything changed, creates a new commit on top of the
 * sandbox's base commit (attributed to "AIDA" — a fresh sandbox has no
 * git identity of its own to inherit, and this shouldn't be credited to
 * whatever identity happens to be configured on the host machine anyway).
 * Does NOT move any branch yet — see pushBranch for that half.
 */
async function commitAll(sandbox, message) {
  const result = await commitChanges({
    owner: sandbox.owner, repo: sandbox.repo, token: sandbox.token, dir: sandbox.dir,
    originalFiles: sandbox.originalFiles, baseCommitSha: sandbox.baseCommitSha, baseTreeSha: sandbox.baseTreeSha,
    message,
  });
  if (result.committed) sandbox.newCommitSha = result.commitSha;
  return result;
}

/** Points sandbox.branch at the commit commitAll just created. */
async function pushBranch(sandbox) {
  await updateBranchRef({ owner: sandbox.owner, repo: sandbox.repo, token: sandbox.token, branch: sandbox.branch, commitSha: sandbox.newCommitSha });
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

/**
 * Azure Static Web Apps' per-PR preview hostnames include a region and a
 * revision number (e.g. polite-ground-0d0cadb00-13.eastasia.7.azurestaticapps.net)
 * that aren't derivable from the PR number alone — the only place the real
 * URL shows up is the comment github-actions[bot] posts once the
 * Azure/static-web-apps-deploy build finishes (1-3 minutes after the PR
 * opens), reading "Azure Static Web Apps: Your stage site is ready! Visit it
 * here: <url>". Returns null if that comment hasn't appeared yet — expected
 * and normal for a PR that was just opened; try again on a later poll.
 */
async function getSwaPreviewUrl({ owner, repo, token, pullNumber }) {
  const comments = await githubRequest(token, 'GET', `/repos/${owner}/${repo}/issues/${pullNumber}/comments`);
  for (const c of comments || []) {
    if (c.user?.login !== 'github-actions[bot]') continue;
    const m = /Visit it here:\s*(https:\/\/\S+)/.exec(c.body || '');
    if (m) return m[1];
  }
  return null;
}

module.exports = {
  createBranch, commitAll, pushBranch, openPullRequest, getCombinedStatus,
  mergePullRequest, closePullRequest, getSwaPreviewUrl, GitHubApiError,
};
