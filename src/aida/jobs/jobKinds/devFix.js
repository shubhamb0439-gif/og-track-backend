const fs = require('fs');
const path = require('path');
const config = require('../../../config');
const { createSandbox } = require('../../codingAgent/sandbox');
const { runCommand, fileExists } = require('../../codingAgent/tools');
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

// AIDA roadmap item 16, Part 2 — the bounded actions auto-merge fast-lane.
// Real finding this is built around: there was NO enforced test gate in
// this pipeline at all before — the agent was only PROMPTED to run tests,
// nothing checked the result. Confirmed explicitly with the user before
// building any fast-lane at all: skipping approval with zero real
// verification would be a materially different, much riskier thing than
// what's built here.
const ACTIONS_DIR_PREFIX = 'src/aida/tools/actions/';
const ACTIONS_REGISTRY_FILE = 'src/aida/tools/index.js';

/** True only if every line in the ORIGINAL file is still present, unchanged, in the new one, in the same order — i.e. the diff is purely additive (new require lines), nothing existing removed or edited. A dependency-free subsequence check, not a full diff. */
function isAdditiveOnlyChange(originalBuf, newBuf) {
  if (!originalBuf || !newBuf) return false;
  const originalLines = originalBuf.toString('utf8').split('\n');
  const newLines = newBuf.toString('utf8').split('\n');
  let i = 0;
  for (const line of newLines) {
    if (i < originalLines.length && line === originalLines[i]) i++;
  }
  return i === originalLines.length;
}

/**
 * The diff-shape half of the fast-lane gate: every changed path must be
 * either a NEW file under src/aida/tools/actions/ (nothing to compare — it
 * didn't exist before) or the registry file, and if the registry file is
 * touched, the change there must be additive-only. At least one real
 * actions/ file must actually be touched — a commit that only edits the
 * registry (or touches nothing recognizable) doesn't qualify.
 */
function isScopedToActionsFolder(sandbox, changedPaths) {
  if (!changedPaths || !changedPaths.length) return false;
  let touchesActionsFile = false;
  for (const relPath of changedPaths) {
    const normalized = relPath.replace(/\\/g, '/');
    if (normalized.startsWith(ACTIONS_DIR_PREFIX)) { touchesActionsFile = true; continue; }
    if (normalized === ACTIONS_REGISTRY_FILE) {
      const original = sandbox.originalFiles.get(relPath) || sandbox.originalFiles.get(normalized);
      const currentPath = path.join(fs.realpathSync(sandbox.dir), relPath);
      if (!fs.existsSync(currentPath)) return false; // registry file was deleted — never scoped
      const current = fs.readFileSync(currentPath);
      if (!isAdditiveOnlyChange(original, current)) return false;
      continue;
    }
    return false; // anything else at all disqualifies the fast lane
  }
  return touchesActionsFile;
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
      // AIDA roadmap item 17 — VPS-backed execution, dev_repo_fix only, as a
      // proof of concept. Deliberately excludes actionFastLane jobs (the
      // ones capabilityGapProposal.js's resume() creates for new-action
      // builds): isScopedToActionsFolder() below reads sandbox.originalFiles
      // and local fs directly, which only exist for a local-backend sandbox
      // — keeping fast-lane jobs local keeps this POC's blast radius to
      // ordinary dev_repo_fix calls only, not an oversight.
      const useVps = config.aida.vpsBridge.enabled && job.payload?.actionFastLane !== true;
      sandbox = await createSandbox(owner, repoName, ca.githubToken, 'main', { backend: useVps ? 'vps' : 'local' });
      await appendEvent(job.id, 'cloned', { repo, backend: sandbox.backend });

      await appendEvent(job.id, 'installing');
      // Not every authorized repo is an npm project — the frontend repo in
      // particular is plain static files with no package.json at all
      // (confirmed live). Running npm install against a directory with no
      // package.json fails hard (ENOENT), so check first rather than assume.
      // Goes through tools.js's fileExists (not a raw fs call) specifically
      // so this works for a VPS-backed sandbox.dir too (a "vps://<id>"
      // marker, not a real local path fs.realpathSync could resolve).
      const hasPackageJson = await fileExists(sandbox.dir, 'package.json');
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

      // Real, enforced test gate (item 16 part 2) — previously the agent was
      // only PROMPTED to run tests as part of its own task text; nothing
      // programmatically checked the result before a PR opened. Runs
      // regardless of fast-lane eligibility — every dev_repo_fix/
      // create_module job benefits from a real pass/fail signal on its PR,
      // not just actions.
      let testGate = { ran: false, passed: null };
      if (hasPackageJson) {
        const testRun = await runCommand(sandbox.dir, 'npm', ['test'], { timeoutMs: 180_000 });
        testGate = { ran: true, passed: testRun.exitCode === 0, exitCode: testRun.exitCode };
        await appendEvent(job.id, 'tests_run', testGate);
      }

      await pushBranch(sandbox);
      await appendEvent(job.id, 'pushed', { branch: branchName });

      const testSummaryLine = testGate.ran
        ? (testGate.passed ? '✅ `npm test` passed.' : `⚠️ **\`npm test\` FAILED (exit code ${testGate.exitCode})** — review carefully before merging.`)
        : '_No package.json in this repo — tests were not run._';

      const pr = await openPullRequest({
        owner, repo: repoName, token: ca.githubToken,
        head: branchName, base: 'main',
        title: `AIDA fix: ${effectiveTask.slice(0, 60).replace(/\s+/g, ' ')}`,
        body: `${agentResult.summary}\n\n${testSummaryLine}\n\n---\n_Opened automatically by AIDA's phase-1 self-fix job (${job.id}). Review the diff and CI status, then Approve or Reject from the AIDA Job panel._`,
      });
      await appendEvent(job.id, 'pr_opened', { prNumber: pr.number, prUrl: pr.html_url });

      // The bounded actions auto-merge fast-lane (item 16 part 2) — only
      // ever eligible when capabilityGapProposal.js's resume() explicitly
      // set this flag for a new-action build. Every other dev_repo_fix
      // caller (chat fixes, bug reports, website replicas) never sets it, so
      // they're completely unaffected and always land at awaiting_approval
      // below, exactly as before.
      if (job.payload?.actionFastLane === true) {
        const diffScoped = isScopedToActionsFolder(sandbox, commitResult.changedPaths);
        if (testGate.ran && testGate.passed && diffScoped) {
          try {
            await mergePullRequest({ owner, repo: repoName, token: ca.githubToken, pullNumber: pr.number });
            await appendEvent(job.id, 'auto_merged', { prNumber: pr.number, reason: 'action fast-lane: tests passed, diff scoped to src/aida/tools/actions/' });
            await updateStatus(job.id, 'completed', {
              result: {
                repo, task: effectiveTask, agentSummary: agentResult.summary, changed: true,
                branch: branchName, prNumber: pr.number, prUrl: pr.html_url, toolLog: agentResult.toolLog,
                merged: true, autoMerged: true, testGate,
              },
            });
            return;
          } catch (e) {
            await appendEvent(job.id, 'auto_merge_failed', { error: e.message });
            // fall through to the normal awaiting_approval path below
          }
        } else {
          await appendEvent(job.id, 'fast_lane_declined', { testsRan: testGate.ran, testsPassed: testGate.passed, diffScoped });
        }
      }

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
          testGate,
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
      // Awaited now that cleanup() can be a real network call (VPS mode —
      // see sandbox.js), and failure-tolerant: a cleanup failure must never
      // mask the job's already-recorded completed/failed status above.
      await sandbox?.cleanup().catch((e) => console.error(`[aida] job ${job.id}: sandbox cleanup failed:`, e.message));
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
