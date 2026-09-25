const fs = require('fs');
const path = require('path');
const config = require('../../../config');
const { createSandbox } = require('../../codingAgent/sandbox');
const { runCommand } = require('../../codingAgent/tools');
const { runCodingAgent } = config.aida.codingAgent.provider === 'anthropic'
  ? require('../../codingAgent/providers/anthropic')
  : require('../../codingAgent/providers/openai');
const { createBranch, commitAll, pushBranch, openPullRequest } = require('../../codingAgent/github');
const { notifyPreviewReady } = require('../previewResolver');
const devFix = require('./devFix');

/**
 * Stage 2 ("build") of the tenant-facing bug/feature report pipeline —
 * only ever created by userReportedIssue.js's resume(), once a human has
 * already approved the PLAN (stage 1). By the time this job exists, the
 * repo has already been resolved/authorized — this is now almost identical
 * to devFix.js's run(), just with the task text built from a user report
 * instead of a human-provided task string.
 *
 * resume/onReject are reused from devFix.js directly, unchanged: merging/
 * closing a PR once one exists doesn't depend on which job kind opened it.
 */

function isAuthorized(repo) {
  return config.aida.authorizedRepos.includes(repo);
}

function buildTask({ type, description, screenshotUrl }) {
  const lines = [
    `A user submitted this ${type === 'feature' ? 'feature request' : 'bug report'} through OG Track's in-app report button:`,
    '',
    description.trim(),
  ];
  if (screenshotUrl) {
    lines.push(
      '',
      `A screenshot was attached for human reference: ${screenshotUrl} — you cannot view images, so investigate via ` +
        'the source code and describe what you found in text rather than guessing at what the screenshot shows.'
    );
  }
  lines.push(
    '',
    type === 'feature'
      ? 'Implement this feature request as described, consistent with the existing code style and patterns in this ' +
          'repo. If the request is unclear or too large/ambiguous to implement safely in one pass, say so clearly in ' +
          'your summary and call finish with success: true without changing any files rather than guessing.'
      : 'Investigate the root cause in the actual source code and fix it. If you cannot reproduce or locate a real ' +
          'bug matching this description, say so clearly in your summary and call finish with success: true without ' +
          'changing any files rather than making unrelated changes.'
  );
  return lines.join('\n');
}

module.exports = {
  async run(job, { appendEvent, updateStatus }) {
    const { type, description, screenshotUrl, repo, classifiedRepo, classifiedReasoning } = job.payload || {};
    if (!description || !repo) {
      await updateStatus(job.id, 'failed', { errorMessage: 'Missing description/repo in job payload.' });
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
    // Defense in depth — stage 1 already checked this, but this job re-checks
    // so nothing can reach a clone step regardless of how it was created.
    if (!isAuthorized(repo)) {
      await updateStatus(job.id, 'failed', { errorMessage: `Repo "${repo}" is not authorized for AIDA repo access.` });
      return;
    }

    await appendEvent(job.id, 'started', { repo, type });

    const [owner, repoName] = repo.split('/');
    const effectiveTask = buildTask({ type, description, screenshotUrl });

    let sandbox;
    try {
      sandbox = await createSandbox(owner, repoName, ca.githubToken);
      await appendEvent(job.id, 'cloned', { repo });

      await appendEvent(job.id, 'installing');
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

      const branchName = `aida/issue-${job.id}`;
      await createBranch(sandbox, branchName);

      await appendEvent(job.id, 'agent_started');
      const agentResult = await runCodingAgent({
        sandboxDir: sandbox.dir,
        task: effectiveTask,
        maxIterations: 50,
        onEvent: () => {},
      });
      await appendEvent(job.id, 'agent_finished', { success: agentResult.success, toolCallCount: agentResult.toolLog.length });

      const baseResult = {
        type, description, screenshotUrl, classifiedRepo, classifiedReasoning,
        repo, task: effectiveTask, agentSummary: agentResult.summary, toolLog: agentResult.toolLog,
      };

      if (!agentResult.success) {
        await updateStatus(job.id, 'failed', { errorMessage: agentResult.summary, result: baseResult });
        await appendEvent(job.id, 'failed', { stage: 'agent' });
        return;
      }

      const commitResult = await commitAll(sandbox, `AIDA: ${description.trim().slice(0, 72).replace(/\s+/g, ' ')}`);
      if (!commitResult.committed) {
        await updateStatus(job.id, 'completed', { result: { ...baseResult, changed: false } });
        await appendEvent(job.id, 'completed', { changed: false });
        return;
      }

      await pushBranch(sandbox);
      await appendEvent(job.id, 'pushed', { branch: branchName });

      const pr = await openPullRequest({
        owner, repo: repoName, token: ca.githubToken,
        head: branchName, base: 'main',
        title: `AIDA ${type === 'feature' ? 'feature' : 'fix'}: ${description.trim().slice(0, 60).replace(/\s+/g, ' ')}`,
        body: `**User-reported ${type === 'feature' ? 'feature request' : 'bug'}** (job ${job.id}${job.companySlug ? `, from company "${job.companySlug}"` : ''}):\n\n${description.trim()}\n\n` +
          (screenshotUrl ? `Screenshot: ${screenshotUrl}\n\n` : '') +
          `_Classified as ${classifiedRepo}: ${classifiedReasoning}_\n\n---\n\n${agentResult.summary}\n\n---\n` +
          `_Opened automatically by AIDA's user-report pipeline, after plan approval. Review the diff and CI status, then Approve or Reject from the AIDA Job panel._`,
      });
      await appendEvent(job.id, 'pr_opened', { prNumber: pr.number, prUrl: pr.html_url });

      const previewUrl = repo === config.aida.moduleBuilder.backendRepo
        ? config.aida.previewBackendUrl
        : null;

      const finalJob = await updateStatus(job.id, 'awaiting_approval', {
        result: {
          ...baseResult, changed: true,
          branch: branchName, prNumber: pr.number, prUrl: pr.html_url, previewUrl,
        },
      });
      await appendEvent(job.id, 'awaiting_approval', { prUrl: pr.html_url });
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

  // Merging/closing the PR once it exists is identical to dev_repo_fix's own
  // behavior — both only ever read job.result.repo/prNumber.
  resume: devFix.resume,
  onReject: devFix.onReject,
};
