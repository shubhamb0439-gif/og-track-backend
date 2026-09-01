const fs = require('fs');
const path = require('path');
const config = require('../../../config');
const { createSandbox } = require('../../codingAgent/sandbox');
const { runCommand } = require('../../codingAgent/tools');
// Provider is selectable via AIDA_CODING_AGENT_PROVIDER — env var only, no
// code change, per docs/AIDA_PHASE1_SELF_FIX_PLAN.md's original design.
const { runCodingAgent } = config.aida.codingAgent.provider === 'anthropic'
  ? require('../../codingAgent/providers/anthropic')
  : require('../../codingAgent/providers/openai');
const {
  createBranch, commitAll, pushBranch, openPullRequest,
  mergePullRequest, closePullRequest,
} = require('../../codingAgent/github');
const { notifyPreviewReady } = require('../previewResolver');

/**
 * Phase 1 of the AIDA power-tier coding-agent vision — see
 * docs/AIDA_PHASE1_SELF_FIX_PLAN.md for the full design. Clones an
 * authorized repo into a disposable sandbox (dummy .env, no real
 * credentials — see codingAgent/sandbox.js), runs the coding-agent loop
 * against a task (defaults to "run tests, fix what's failing" for the
 * weekly trigger; a specific task string for on-demand chat-triggered
 * runs), and if it produced a real fix, pushes a branch and opens a PR —
 * landing the job in 'awaiting_approval' rather than completing it, since
 * merging is a human decision (see run() below for exactly where each
 * branch of that decision lives).
 *
 * Never merges or pushes anything without this having already gone through
 * run() -> awaiting_approval first; resume()/onReject() below are the ONLY
 * places that touch the real PR after that point, and they only ever fire
 * from an explicit human action (the approve/reject endpoints), never
 * automatically.
 */

function isAuthorized(repo) {
  return config.aida.authorizedRepos.includes(repo);
}

const DEFAULT_TASK = `Run the test suite ("npm test"). If any tests are failing, investigate the root cause
in the actual source code and fix it. Never modify anything under test/ to make a failing
test pass artificially — if you believe a test itself is wrong, say so in your summary
instead of editing it. If all tests already pass and there is nothing to fix, say so
clearly in your summary and call finish with success: true without changing any files.`;

module.exports = {
  async run(job, { appendEvent, updateStatus }) {
    const { repo, task } = job.payload || {};
    if (!repo || !repo.includes('/')) {
      await updateStatus(job.id, 'failed', { errorMessage: 'Missing or malformed repo in job payload (expected "owner/repo").' });
      return;
    }
    if (!isAuthorized(repo)) {
      await updateStatus(job.id, 'failed', { errorMessage: `Repo "${repo}" is not authorized for AIDA repo access.` });
      return;
    }
    const ca = config.aida.codingAgent;
    if (!ca.enabled) {
      await updateStatus(job.id, 'failed', { errorMessage: 'Coding agent is not configured (missing an API key for its provider).' });
      return;
    }
    if (!ca.githubToken) {
      await updateStatus(job.id, 'failed', { errorMessage: 'Coding agent has no write-scoped GitHub token configured (AIDA_CODING_AGENT_GITHUB_TOKEN).' });
      return;
    }

    const [owner, repoName] = repo.split('/');
    const effectiveTask = (task && task.trim()) || DEFAULT_TASK;
    await appendEvent(job.id, 'started', { repo, task: effectiveTask });

    let sandbox;
    try {
      sandbox = await createSandbox(owner, repoName, ca.githubToken);
      await appendEvent(job.id, 'cloned', { repo });

      await appendEvent(job.id, 'installing');
      // Not every authorized repo is an npm project — the frontend repo in
      // particular is plain static files with no package.json at all
      // (confirmed live). Running npm install against a directory with no
      // package.json fails hard (ENOENT), so check first rather than assume.
      const hasPackageJson = fs.existsSync(path.join(fs.realpathSync(sandbox.dir), 'package.json'));
      const install = hasPackageJson
        ? await runCommand(sandbox.dir, 'npm', ['install', '--no-audit', '--no-fund'], { timeoutMs: 180_000 })
        : { exitCode: 0, skipped: true };
      if (install.exitCode !== 0) {
        await updateStatus(job.id, 'failed', { errorMessage: `npm install failed in the sandbox:\n${install.stderr.slice(0, 1000)}` });
        await appendEvent(job.id, 'failed', { stage: 'install' });
        return;
      }
      await appendEvent(job.id, 'installed', { skipped: !hasPackageJson });

      const branchName = `aida/fix-${job.id}`;
      await createBranch(sandbox, branchName);

      await appendEvent(job.id, 'agent_started');
      const toolLog = [];
      const agentResult = await runCodingAgent({
        sandboxDir: sandbox.dir,
        task: effectiveTask,
        // Live-verified: 25 was too low for a large existing file (1.5MB+,
        // past read_file's 200KB cap) — surgically finding/editing one spot
        // in it via findstr + small scratch Node scripts legitimately takes
        // more tool calls than a normal small-file edit.
        maxIterations: 50,
        onEvent: (e) => toolLog.push(e),
      });
      await appendEvent(job.id, 'agent_finished', { success: agentResult.success, toolCallCount: agentResult.toolLog.length });

      if (!agentResult.success) {
        await updateStatus(job.id, 'failed', {
          errorMessage: agentResult.summary,
          result: { repo, task: effectiveTask, agentSummary: agentResult.summary, toolLog: agentResult.toolLog },
        });
        await appendEvent(job.id, 'failed', { stage: 'agent' });
        return;
      }

      const commitResult = await commitAll(sandbox, `AIDA: ${effectiveTask.slice(0, 72).replace(/\s+/g, ' ')}`);
      if (!commitResult.committed) {
        // The agent succeeded but made no file changes — nothing to review or push.
        await updateStatus(job.id, 'completed', {
          result: { repo, task: effectiveTask, agentSummary: agentResult.summary, changed: false, toolLog: agentResult.toolLog },
        });
        await appendEvent(job.id, 'completed', { changed: false });
        return;
      }

      await pushBranch(sandbox);
      await appendEvent(job.id, 'pushed', { branch: branchName });

      const pr = await openPullRequest({
        owner, repo: repoName, token: ca.githubToken,
        head: branchName, base: 'main',
        title: `AIDA fix: ${effectiveTask.slice(0, 60).replace(/\s+/g, ' ')}`,
        body: `${agentResult.summary}\n\n---\n_Opened automatically by AIDA's phase-1 self-fix job (${job.id}). Review the diff and CI status, then Approve or Reject from the AIDA Job panel._`,
      });
      await appendEvent(job.id, 'pr_opened', { prNumber: pr.number, prUrl: pr.html_url });

      // The backend repo's preview URL is a FIXED, always-known value (the
      // "preview" deployment slot auto-deploys any non-main branch push —
      // see config.aida.previewBackendUrl) — no need to wait or poll for it.
      // The frontend repo's Azure Static Web Apps preview hostname is
      // per-PR/unpredictable and only appears in a bot comment once its build
      // finishes (1-3 min later), so it starts null here and gets filled in
      // by GET /jobs/:id once that comment shows up (see routes/aida.js).
      const previewUrl = repo === config.aida.moduleBuilder.backendRepo
        ? config.aida.previewBackendUrl
        : null;

      const finalJob = await updateStatus(job.id, 'awaiting_approval', {
        result: {
          repo, task: effectiveTask, agentSummary: agentResult.summary, changed: true,
          branch: branchName, prNumber: pr.number, prUrl: pr.html_url, previewUrl, toolLog: agentResult.toolLog,
        },
      });
      await appendEvent(job.id, 'awaiting_approval', { prUrl: pr.html_url });
      // Only the backend case has a link already at this point (see above) —
      // the frontend case starts null and gets its own notification later,
      // once previewResolver.js's background poll actually resolves it.
      if (previewUrl) {
        notifyPreviewReady(finalJob).catch((e) => console.error(`[aida] preview-ready WhatsApp notify failed for job ${job.id}:`, e.message));
      }
    } catch (e) {
      const safeMessage = ca.githubToken ? e.message.split(ca.githubToken).join('***') : e.message;
      await updateStatus(job.id, 'failed', { errorMessage: safeMessage });
      await appendEvent(job.id, 'failed', { error: safeMessage });
    } finally {
      sandbox?.cleanup();
    }
  },

  /** Called only when a human clicks Approve on an 'awaiting_approval' dev_repo_fix job — merges the real PR. */
  async resume(job, { appendEvent, updateStatus }) {
    const { repo, prNumber } = job.result || {};
    if (!repo || !prNumber) {
      await updateStatus(job.id, 'failed', { errorMessage: 'Job has no PR to merge (missing repo/prNumber in its result) — nothing to approve.' });
      return;
    }
    const [owner, repoName] = repo.split('/');
    try {
      await mergePullRequest({ owner, repo: repoName, token: config.aida.codingAgent.githubToken, pullNumber: prNumber });
      await appendEvent(job.id, 'merged', { prNumber });
      await updateStatus(job.id, 'completed', { result: { ...job.result, merged: true } });
    } catch (e) {
      await updateStatus(job.id, 'failed', { errorMessage: `Approved, but merging the PR failed: ${e.message}` });
      await appendEvent(job.id, 'merge_failed', { error: e.message });
    }
  },

  /** Called only when a human clicks Reject on an 'awaiting_approval' dev_repo_fix job — closes the real PR without merging. */
  async onReject(job, { appendEvent }) {
    const { repo, prNumber } = job.result || {};
    if (!repo || !prNumber) return; // nothing was ever pushed (e.g. rejecting a job that failed before opening a PR) — nothing to close
    const [owner, repoName] = repo.split('/');
    try {
      await closePullRequest({ owner, repo: repoName, token: config.aida.codingAgent.githubToken, pullNumber: prNumber });
      await appendEvent(job.id, 'pr_closed', { prNumber });
    } catch (e) {
      await appendEvent(job.id, 'pr_close_failed', { error: e.message });
    }
  },
};
