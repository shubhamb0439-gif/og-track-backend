const config = require('../../../config');
const jobStore = require('../jobStore');
const { classifyIssueRepo, generatePlanOfAction } = require('../reportLLM');
const { notifyCompanyMessage } = require('../notifyCompanyMessage');
const { sendWhatsAppMessage } = require('../../whatsapp');

/**
 * Stage 1 ("plan") of the tenant-facing bug/feature report pipeline —
 * AIDA roadmap item 4b, revised per an explicit follow-up request for a
 * plan-of-action review gate BEFORE any sandbox/coding-agent work starts
 * (not just before the resulting PR merges, which is stage 2's own gate —
 * see userReportedIssueBuild.js).
 *
 * run(): classifies which repo the report likely belongs to, has the LLM
 * write a short human-reviewable plan (NOT code, NOT a real diagnosis — see
 * reportLLM.js's generatePlanOfAction), notifies the master admin over
 * WhatsApp and this company's manager/developer/tester over the existing
 * in-app Messages module, then lands at 'awaiting_approval'. Nothing is
 * cloned or built yet at this point.
 *
 * resume(): fires only once a human (master admin, or this company's own
 * manager/developer/tester — see the new requireReportIssueApprover
 * middleware in routes/aida.js) approves the plan. It hands off to a BRAND
 * NEW job (kind: user_reported_issue_build) that does the real sandbox/
 * coding-agent/PR work — this job itself just completes once that handoff
 * happens, it never touches a sandbox or GitHub directly.
 */

function buildPlanMessage({ type, description, classifiedRepo, classifiedReasoning, plan, companySlug }) {
  const kindLabel = type === 'feature' ? 'Feature request' : 'Bug report';
  const lines = [
    `🤖 AIDA — new ${kindLabel.toLowerCase()}${companySlug ? ` from "${companySlug}"` : ''}`,
    '',
    `Reported: ${description.trim()}`,
    '',
    `AIDA's summary: ${plan.summary}`,
    `Likely area: ${classifiedRepo} (${classifiedReasoning})`,
    '',
    'Proposed action:',
    ...plan.actionItems.map((item) => `• ${item}`),
    '',
    'Reply/approve in the AIDA Job panel (master admin) or this company\'s Messages panel to let AIDA start building.',
  ];
  return lines.join('\n');
}

module.exports = {
  async run(job, { appendEvent, updateStatus }) {
    const { type, description, screenshotUrl } = job.payload || {};
    if (!description || !description.trim()) {
      await updateStatus(job.id, 'failed', { errorMessage: 'Missing description in job payload.' });
      return;
    }
    if (!config.aida.moduleBuilder.frontendRepo || !config.aida.moduleBuilder.backendRepo) {
      await updateStatus(job.id, 'failed', { errorMessage: 'AIDA_MODULE_FRONTEND_REPO/AIDA_MODULE_BACKEND_REPO are not both configured — cannot resolve which repo to target.' });
      return;
    }

    await appendEvent(job.id, 'started', { type, companySlug: job.companySlug });

    const classification = await classifyIssueRepo({ type, description });
    const repo = classification.repo === 'backend'
      ? config.aida.moduleBuilder.backendRepo
      : config.aida.moduleBuilder.frontendRepo;
    if (!config.aida.authorizedRepos.includes(repo)) {
      await updateStatus(job.id, 'failed', { errorMessage: `Resolved repo "${repo}" is not on the authorized-repos allowlist.` });
      return;
    }
    await appendEvent(job.id, 'classified', { repo, classifiedRepo: classification.repo, reasoning: classification.reasoning });

    const plan = await generatePlanOfAction({ type, description, repo: classification.repo });
    await appendEvent(job.id, 'plan_generated', { plan });

    const messageText = buildPlanMessage({
      type, description, classifiedRepo: classification.repo, classifiedReasoning: classification.reasoning,
      plan, companySlug: job.companySlug,
    });

    let whatsappSent = false;
    if (config.whatsapp.enabled && config.whatsapp.masterAdminNumber) {
      try {
        await sendWhatsAppMessage(config.whatsapp.masterAdminNumber, messageText);
        whatsappSent = true;
      } catch (e) {
        console.error(`[aida] job ${job.id}: WhatsApp notify to master admin failed:`, e.message);
      }
    }
    await appendEvent(job.id, 'masteradmin_notified', { whatsappSent, configured: config.whatsapp.enabled && !!config.whatsapp.masterAdminNumber });

    let messageResult = { sent: false, reason: 'no companySlug on this job' };
    if (job.companySlug) {
      try {
        messageResult = await notifyCompanyMessage(job.companySlug, messageText);
      } catch (e) {
        messageResult = { sent: false, reason: e.message };
        console.error(`[aida] job ${job.id}: in-app message notify failed:`, e.message);
      }
    }
    await appendEvent(job.id, 'company_notified', messageResult);

    await updateStatus(job.id, 'awaiting_approval', {
      result: {
        type, description, screenshotUrl,
        classifiedRepo: classification.repo, classifiedReasoning: classification.reasoning, repo,
        plan, whatsappSent, messageResult,
      },
    });
    await appendEvent(job.id, 'awaiting_approval', { note: 'Awaiting plan approval before any build starts.' });
  },

  /** Fires once a human approves the PLAN — hands off to the real build job, does not build anything itself. */
  async resume(job, { appendEvent, updateStatus }) {
    const { type, description, screenshotUrl, repo, classifiedRepo, classifiedReasoning } = job.result || {};
    if (!description || !repo) {
      await updateStatus(job.id, 'failed', { errorMessage: 'Job has no plan to act on (missing description/repo in its result).' });
      return;
    }
    const buildJob = await jobStore.createJob({
      kind: 'user_reported_issue_build',
      companySlug: job.companySlug,
      createdByUserId: job.createdByUserId,
      payload: { type, description, screenshotUrl, repo, classifiedRepo, classifiedReasoning },
    });
    await appendEvent(job.id, 'handed_off', { buildJobId: buildJob.id });
    await updateStatus(job.id, 'completed', { result: { ...job.result, buildJobId: buildJob.id } });
  },

  // No onReject: rejecting the PLAN stops here — nothing was ever cloned or
  // pushed yet, so there's nothing external to clean up.
};
