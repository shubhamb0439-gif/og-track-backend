const config = require('../../../config');
const jobStore = require('../jobStore');
const { generatePlanOfAction } = require('../reportLLM');
const { sendWhatsAppMessage } = require('../../whatsapp');
const { describeApprover, latestEventDetail } = require('../approverInfo');

/**
 * AIDA roadmap item 8.5 — "self-evolving": AIDA proposes fixing its own
 * detected capability gaps. Modeled directly on jobKinds/userReportedIssue.js's
 * two-stage plan-then-build pattern (same reasoning applies here: a
 * human-reviewable plan BEFORE anything is cloned/built), with two real
 * differences since this is master-admin-only by nature (AIDA proposing to
 * modify the exact backend it's running from, not a tenant report):
 *   - No frontend/backend classification — a capability gap in AIDA itself
 *     is always a backend change (new tool, new integration, new job kind).
 *   - resume() hands off directly to a plain dev_repo_fix job instead of a
 *     dedicated "_build" stage — dev_repo_fix already does sandbox/coding-
 *     agent/PR/approval work exactly as-is, and there's no tenant-vs-
 *     masteradmin approver split to handle here (see userReportedIssueBuild.js
 *     for why that one needed its own stage-2 kind).
 *
 * run(): writes a short plan via the EXISTING generatePlanOfAction (reused
 * as-is — its prompt already fits "a code-feature plan", no new prompt
 * needed), notifies the master admin over WhatsApp, lands at
 * 'awaiting_approval'. Nothing is cloned/built yet.
 *
 * resume(): fires once the master admin approves — creates a plain
 * dev_repo_fix job targeting config.aida.moduleBuilder.backendRepo with a
 * task string built from the approved plan + the original request text.
 */

function buildPlanMessage({ jobId, whatToBuild, plan }) {
  const lines = [
    '🤖 AIDA — I noticed I can\'t do something you asked',
    '',
    `You asked: ${whatToBuild.trim()}`,
    '',
    `My proposed plan: ${plan.summary}`,
    '',
    'Proposed action:',
    ...plan.actionItems.map((item) => `• ${item}`),
    '',
    'Reply/approve in the AIDA Job panel to let me start building this.',
    // Same machine-parseable convention as userReportedIssue.js's own
    // message — see docs/FRONTEND_PROMPTS.md #32.
    `Job ID: ${jobId}`,
  ];
  return lines.join('\n');
}

module.exports = {
  async run(job, { appendEvent, updateStatus }) {
    const { whatToBuild, originalUserMessage } = job.payload || {};
    if (!whatToBuild || !whatToBuild.trim()) {
      await updateStatus(job.id, 'failed', { errorMessage: 'Missing whatToBuild in job payload.' });
      return;
    }
    if (!config.aida.moduleBuilder.backendRepo) {
      await updateStatus(job.id, 'failed', { errorMessage: 'AIDA_MODULE_BACKEND_REPO is not configured — cannot resolve which repo to target.' });
      return;
    }
    if (!config.aida.authorizedRepos.includes(config.aida.moduleBuilder.backendRepo)) {
      await updateStatus(job.id, 'failed', { errorMessage: `Backend repo "${config.aida.moduleBuilder.backendRepo}" is not on the authorized-repos allowlist.` });
      return;
    }

    await appendEvent(job.id, 'started', { whatToBuild });

    const plan = await generatePlanOfAction({ type: 'feature', description: whatToBuild, repo: 'backend' });
    await appendEvent(job.id, 'plan_generated', { plan });

    const messageText = buildPlanMessage({ jobId: job.id, whatToBuild, plan });

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

    await updateStatus(job.id, 'awaiting_approval', {
      result: { whatToBuild, originalUserMessage, plan, whatsappSent },
    });
    await appendEvent(job.id, 'awaiting_approval', { note: 'Awaiting plan approval before any build starts.' });
  },

  /** Fires once the master admin approves the PLAN — hands off to a plain dev_repo_fix job, builds nothing itself. */
  async resume(job, { appendEvent, updateStatus }) {
    const { whatToBuild, originalUserMessage, plan } = job.result || {};
    if (!whatToBuild || !plan) {
      await updateStatus(job.id, 'failed', { errorMessage: 'Job has no plan to act on (missing whatToBuild/plan in its result).' });
      return;
    }
    const task = [
      `AIDA detected it could not help with this request from its own master admin: "${(originalUserMessage || whatToBuild).trim()}"`,
      '',
      `Approved plan: ${plan.summary}`,
      '',
      'Action items:',
      ...plan.actionItems.map((item) => `- ${item}`),
      '',
      'STRONGLY PREFERRED approach — a new "action": if this capability can be implemented as a single new tool (one new file exporting `module.exports = [{ name, description, requiredModules, inputSchema, handler }]`, following the EXACT shape already used by every existing file in src/aida/tools/), create it as EXACTLY ONE new file at src/aida/tools/actions/<actionName>.js, and add EXACTLY ONE new require(...) line registering it in src/aida/tools/index.js\'s MODULE_TOOL_FILES array — do not touch any other existing file. This narrow, mechanically-verifiable shape is what lets this change skip the human-approval wait and ship immediately once tests pass.',
      '',
      'If (and only if) the capability genuinely cannot be expressed as a single new tool file this way (e.g. it needs a new config block, a new database table/migration, or changes to existing shared code), implement it properly using whatever existing patterns fit best elsewhere in src/aida/ — that is completely fine, it will simply go through the normal human-approval review instead of the fast lane, which is expected and safe.',
    ].join('\n');

    const buildJob = await jobStore.createJob({
      kind: 'dev_repo_fix',
      companySlug: job.companySlug,
      createdByUserId: job.createdByUserId,
      payload: { repo: config.aida.moduleBuilder.backendRepo, task, actionFastLane: true },
    });
    await appendEvent(job.id, 'handed_off', { buildJobId: buildJob.id });
    await updateStatus(job.id, 'completed', { result: { ...job.result, buildJobId: buildJob.id } });

    const approvedBy = await describeApprover(job.companySlug, (await latestEventDetail(job.id, 'approved'))?.approvedBy);
    const ackText = `✅ Capability plan approved by ${approvedBy} — starting work now. I'll post back here once a fix is ready for review.`;
    if (config.whatsapp.enabled && config.whatsapp.masterAdminNumber) {
      sendWhatsAppMessage(config.whatsapp.masterAdminNumber, ackText).catch((e) => console.error(`[aida] job ${job.id}: approval-ack WhatsApp failed:`, e.message));
    }
  },

  /** Fires once the master admin rejects the PLAN — nothing was ever cloned/pushed, so there's nothing to clean up, only to acknowledge. */
  async onReject(job) {
    const rejectedBy = await describeApprover(job.companySlug, (await latestEventDetail(job.id, 'rejected'))?.rejectedBy);
    const ackText = `❌ Capability plan rejected by ${rejectedBy} — AIDA won't proceed with this.`;
    if (config.whatsapp.enabled && config.whatsapp.masterAdminNumber) {
      sendWhatsAppMessage(config.whatsapp.masterAdminNumber, ackText).catch((e) => console.error(`[aida] job ${job.id}: rejection-ack WhatsApp failed:`, e.message));
    }
  },
};
