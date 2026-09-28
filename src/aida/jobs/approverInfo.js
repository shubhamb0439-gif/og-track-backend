const jobStore = require('./jobStore');
const { resolveTenant } = require('../../db/tenantConnections');

/**
 * Turns the `approvedBy`/`rejectedBy` value routes/aida.js's approver
 * middleware attaches (as an 'approved'/'rejected' job event's detail — a
 * job kind's resume()/onReject() has no other way to see who acted, since
 * jobRunner's generic contract doesn't pass approver identity into a job
 * kind directly) into a human-readable string for an acknowledgment
 * message. Best-effort: a lookup failure never blocks the acknowledgment
 * itself, it just falls back to something generic. Shared by
 * jobKinds/userReportedIssue.js (plan stage) and
 * jobKinds/userReportedIssueBuild.js (bug-fix merge stage).
 */
async function describeApprover(companySlug, approver) {
  if (!approver) return 'someone';
  // The pre-existing masterAdminAidaRouter approve/reject routes (used for
  // dev_repo_fix, create_module, and feature-type user_reported_issue_build
  // jobs) store just the admin id as a plain string — only the NEW
  // requireReportIssueApprover-gated routes attach the richer {type, id,
  // name, role} shape checked below.
  if (typeof approver === 'string') return 'the master admin';
  if (approver.type === 'masteradmin') return `${approver.name || 'the master admin'} (master admin)`;
  try {
    const { db } = await resolveTenant(companySlug);
    const user = await db('users').where({ id: approver.id }).first();
    return `${user?.name || 'someone'} (${approver.role})`;
  } catch {
    return `someone (${approver.role})`;
  }
}

async function latestEventDetail(jobId, eventName) {
  const events = await jobStore.listEventsForJob(jobId);
  const match = [...events].reverse().find((e) => e.event === eventName);
  return match?.detail || null;
}

module.exports = { describeApprover, latestEventDetail };
