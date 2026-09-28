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
const { notifyCompanyMessage } = require('../notifyCompanyMessage');
const { sendWhatsAppMessage } = require('../../whatsapp');
const jobStore = require('../jobStore');
const { describeApprover, latestEventDetail } = require('../approverInfo');
const devFix = require('./devFix');

// Closes the loop that stage 1 (userReportedIssue.js) opens — whoever
// approved the plan sees it land in Messages/WhatsApp, but without this
// they'd otherwise hear nothing further until someone happens to check the
// masteradmin Job panel. Best-effort, same as every other notification in
// this pipeline: a failure here never affects the job's own real outcome.
function notifyBuildResult(job, text) {
  // Every message this job kind sends ends with these two machine-parseable
  // lines — same "Label: value" convention as userReportedIssue.js's plan
  // message ("Job ID: job_..."), centralized here so no individual call site
  // can forget them (a prior version of the "fix ready" message omitted the
  // job id entirely, which meant a frontend Approve/Reject button had
  // nothing to call the endpoint with — see docs/FRONTEND_PROMPTS.md #33).
  const fullText = [text, `Type: ${job.payload?.type || 'unknown'}`, `Job ID: ${job.id}`].join('\n');
  if (config.whatsapp.enabled && config.whatsapp.masterAdminNumber) {
    sendWhatsAppMessage(config.whatsapp.masterAdminNumber, fullText).catch((e) => console.error(`[aida] job ${job.id}: build-result WhatsApp failed:`, e.message));
  }
  if (job.companySlug) {
    notifyCompanyMessage(job.companySlug, fullText).catch((e) => console.error(`[aida] job ${job.id}: build-result in-app message failed:`, e.message));
  }
}

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
      notifyBuildResult(job, `⚠️ AIDA couldn't start work on this — its job payload was incomplete. A master admin will need to look into this directly.`);
      return;
    }
    const ca = config.aida.codingAgent;
    if (!ca.enabled) {
      await updateStatus(job.id, 'failed', { errorMessage: 'Coding agent is not configured (missing an API key for its provider).' });
      notifyBuildResult(job, `⚠️ The plan was approved, but AIDA's coding agent isn't configured on this server yet, so it can't actually start building. A master admin will need to set that up.`);
      return;
    }
    if (!ca.githubToken) {
      await updateStatus(job.id, 'failed', { errorMessage: 'Coding agent has no write-scoped GitHub token configured (AIDA_CODING_AGENT_GITHUB_TOKEN).' });
      notifyBuildResult(job, `⚠️ The plan was approved, but AIDA's coding agent has no repo access configured on this server yet, so it can't actually start building. A master admin will need to set that up.`);
      return;
    }
    // Defense in depth — stage 1 already checked this, but this job re-checks
    // so nothing can reach a clone step regardless of how it was created.
    if (!isAuthorized(repo)) {
      await updateStatus(job.id, 'failed', { errorMessage: `Repo "${repo}" is not authorized for AIDA repo access.` });
      notifyBuildResult(job, `⚠️ The plan was approved, but AIDA isn't authorized to access the repo this needs (${repo}). A master admin will need to look into this.`);
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
        notifyBuildResult(job, `⚠️ AIDA wasn't able to produce a fix: ${agentResult.summary}`);
        return;
      }

      const commitResult = await commitAll(sandbox, `AIDA: ${description.trim().slice(0, 72).replace(/\s+/g, ' ')}`);
      if (!commitResult.committed) {
        await updateStatus(job.id, 'completed', { result: { ...baseResult, changed: false } });
        await appendEvent(job.id, 'completed', { changed: false });
        notifyBuildResult(job, `ℹ️ AIDA investigated but found nothing to change: ${agentResult.summary}`);
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
      const reviewerLine = type === 'bug'
        ? 'pending final review — you (developer/tester) or the master admin can approve this'
        : 'pending final review by the master admin';
      notifyBuildResult(job, [
        `🔧 A fix is ready — a pull request has been opened and is now ${reviewerLine}.`,
        '',
        agentResult.summary,
        '',
        previewUrl ? `Preview: ${previewUrl}` : null,
        `PR: ${pr.html_url}`,
      ].filter((l) => l !== null).join('\n'));
      if (previewUrl) {
        notifyPreviewReady(finalJob).catch((e) => console.error(`[aida] preview-ready WhatsApp notify failed for job ${job.id}:`, e.message));
      }
    } catch (e) {
      const safeMessage = ca.githubToken ? e.message.split(ca.githubToken).join('***') : e.message;
      await updateStatus(job.id, 'failed', { errorMessage: safeMessage });
      await appendEvent(job.id, 'failed', { error: safeMessage });
      notifyBuildResult(job, `⚠️ AIDA hit an unexpected error while working on this and had to stop: ${safeMessage}`);
    } finally {
      sandbox?.cleanup();
    }
  },

  /**
   * Merging the PR once it exists is identical to dev_repo_fix's own
   * behavior (both only ever read job.result.repo/prNumber) — devFix.resume
   * does the actual merge. What's new here: for a BUG report specifically,
   * this can now be approved by this company's own developer/tester, not
   * just a master admin (see routes/aida.js's validateReportIssueApprovableJob)
   * — either way, the master admin gets told what happened, since they're
   * no longer necessarily the one who acted.
   */
  async resume(job, helpers) {
    await devFix.resume(job, helpers);
    const finalJob = await jobStore.getJob(job.id);
    const approvedBy = await describeApprover(job.companySlug, (await latestEventDetail(job.id, 'approved'))?.approvedBy);
    const text = finalJob.status === 'completed'
      ? `✅ Merged by ${approvedBy} — this fix is now live.`
      : `⚠️ Approved by ${approvedBy}, but merging failed: ${finalJob.errorMessage || 'unknown error'}`;
    notifyBuildResult(finalJob, text);
  },

  async onReject(job, helpers) {
    await devFix.onReject(job, helpers);
    const rejectedBy = await describeApprover(job.companySlug, (await latestEventDetail(job.id, 'rejected'))?.rejectedBy);
    notifyBuildResult(job, `❌ Fix rejected by ${rejectedBy} — the pull request has been closed without merging.`);
  },
};
