const coreDb = require('../../db/core');

/**
 * All DB access for AIDA's async job model lives here — jobRunner.js and
 * the job routes both go through these functions rather than touching
 * coreDb('aida_jobs')/('aida_job_events') directly, same separation as the
 * rest of the app (routes call helpers, helpers own the schema shape).
 */

function newId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function mapJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    companySlug: row.company_slug,
    createdByUserId: row.created_by_user_id,
    payload: row.payload_json ? JSON.parse(row.payload_json) : null,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.job_id,
    event: row.event,
    detail: row.detail ? JSON.parse(row.detail) : null,
    createdAt: row.created_at,
  };
}

async function createJob({ kind, companySlug, createdByUserId, payload }) {
  const id = newId('job');
  await coreDb('aida_jobs').insert({
    id,
    kind,
    status: 'queued',
    company_slug: companySlug || null,
    created_by_user_id: createdByUserId,
    payload_json: payload ? JSON.stringify(payload) : null,
  });
  await appendEvent(id, 'queued');
  return getJob(id);
}

async function getJob(id) {
  return mapJob(await coreDb('aida_jobs').where({ id }).first());
}

async function listQueuedJobs(limit = 5) {
  const rows = await coreDb('aida_jobs').where({ status: 'queued' }).orderBy('created_at', 'asc').limit(limit);
  return rows.map(mapJob);
}

async function listEventsForJob(jobId) {
  const rows = await coreDb('aida_job_events').where({ job_id: jobId }).orderBy('created_at', 'asc');
  return rows.map(mapEvent);
}

async function updateJobStatus(id, status, { result, errorMessage } = {}) {
  const updates = { status, updated_at: new Date() };
  if (result !== undefined) updates.result_json = result ? JSON.stringify(result) : null;
  if (errorMessage !== undefined) updates.error_message = errorMessage;
  await coreDb('aida_jobs').where({ id }).update(updates);
  return getJob(id);
}

async function appendEvent(jobId, event, detail) {
  await coreDb('aida_job_events').insert({
    id: newId('jev'),
    job_id: jobId,
    event,
    detail: detail !== undefined ? JSON.stringify(detail) : null,
  });
}

module.exports = { createJob, getJob, listQueuedJobs, listEventsForJob, updateJobStatus, appendEvent };
