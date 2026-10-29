const config = require('../../config');
const coreDb = require('../../db/core');
const { getTenantDbByName } = require('../../db/tenantConnections');
const { sendEmail } = require('../../utils/email');

/**
 * Post-demo feedback item — "if AIDA takes a while, email me when it's
 * ready." Confirmed with the user to scope this to jobs specifically (every
 * job already IS the real "this is taking a while" case — a plain chat
 * reply that's merely slow has no job/timeline behind it at all, so there's
 * nothing generic to hook there without inventing a new trigger). Applies
 * uniformly to every job kind rather than being opt-in per kind — email is
 * a different channel from whatever WhatsApp acks a kind already sends
 * (capabilityGapProposal.js, userReportedIssue.js, etc.), so this doesn't
 * duplicate those, it just adds the channel the user actually asked for.
 *
 * A job's creator is either a masteradmin (companySlug is null — look up
 * via platform_admins) or a tenant user (companySlug set — look up via
 * that company's own tenant DB). Both paths already exist elsewhere in
 * this codebase (tools/masteradmin.js's currentAdminEmail is the
 * masteradmin half of this exact lookup) — this just needs the tenant half
 * too, since job creation itself isn't masteradmin-only (user_reported_issue
 * is tenant-created).
 */

async function resolveCreatorEmail(job) {
  if (!job.companySlug) {
    const admin = await coreDb('platform_admins').where({ id: job.createdByUserId }).first();
    return admin?.email || null;
  }
  const company = await coreDb('companies').where({ slug: job.companySlug }).first();
  if (!company) return null;
  const db = getTenantDbByName(company.db_name);
  const user = await db('users').where({ id: job.createdByUserId }).first();
  return user?.email || null;
}

// Human-readable label per job kind, for the email subject/body — falls
// back to a generic label for any kind not listed here, so a future job
// kind never silently fails to notify just because it's missing from this map.
const JOB_LABELS = {
  dev_repo_diagnose: 'your repo diagnosis',
  dev_diagnose: 'your repo diagnosis',
  dev_repo_fix: 'your code fix',
  create_module: 'your new module',
  generate_document: 'your generated document',
  user_reported_issue: 'your bug/feature report',
  user_reported_issue_build: 'your bug/feature report',
  capability_gap_proposal: 'the new AIDA capability you asked about',
};

/** Fire-and-forget — never throws, a notification failure must never affect the job's own real outcome. */
async function notifyJobComplete(job) {
  if (!config.email.enabled) return;
  if (job.status !== 'completed' && job.status !== 'failed') return;
  try {
    const email = await resolveCreatorEmail(job);
    if (!email) return;

    const label = JOB_LABELS[job.kind] || 'an AIDA job';
    const succeeded = job.status === 'completed';
    const subject = `AIDA — ${label} ${succeeded ? 'is ready' : 'failed'}`;
    const bodyLine = succeeded
      ? `${label[0].toUpperCase()}${label.slice(1)} is ready — open AIDA's Job panel for the full result.`
      : `${label[0].toUpperCase()}${label.slice(1)} failed: ${job.errorMessage || 'no error detail available'}.`;
    const html = `<p>${bodyLine}</p>`;

    await sendEmail({ to: email, subject, html, text: bodyLine });
  } catch (e) {
    console.error(`[aida-jobs] job ${job.id}: completion email failed:`, e.message);
  }
}

module.exports = { notifyJobComplete };
