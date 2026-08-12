const jobStore = require('./jobStore');
const { getJobKind } = require('./jobKinds');

const POLL_INTERVAL_MS = 3000;

let io = null;
let pollTimer = null;
let polling = false; // re-entrancy guard — one tick at a time even if a tick runs long

function roomForJob(job) {
  // Every job today is master-admin-initiated (see the plan: capability 1/2
  // and capability 3's write half are all masteradmin-scoped) — the room
  // convention mirrors the tenant app's io.to(company.slug) rooms.
  return `masteradmin:${job.createdByUserId}`;
}

function emitJobUpdate(job) {
  if (!io) return;
  io.to(roomForJob(job)).emit('aida:job', job);
}

const helpers = {
  appendEvent: (jobId, event, detail) => jobStore.appendEvent(jobId, event, detail),
  updateStatus: async (jobId, status, extra) => {
    const job = await jobStore.updateJobStatus(jobId, status, extra);
    emitJobUpdate(job);
    return job;
  },
};

async function runOne(job) {
  const kind = getJobKind(job.kind);
  if (!kind) {
    await jobStore.updateJobStatus(job.id, 'failed', { errorMessage: `Unknown job kind "${job.kind}"` });
    return;
  }
  try {
    await jobStore.updateJobStatus(job.id, 'running');
    emitJobUpdate(await jobStore.getJob(job.id));
    await kind.run(job, helpers);
  } catch (e) {
    console.error(`[aida-jobs] job ${job.id} (${job.kind}) failed:`, e);
    const failed = await jobStore.updateJobStatus(job.id, 'failed', { errorMessage: e.message });
    emitJobUpdate(failed);
  }
}

/** Called by the approve endpoint once a job is confirmed 'awaiting_approval'. */
async function resumeApproved(job) {
  const kind = getJobKind(job.kind);
  if (!kind || !kind.resume) {
    return jobStore.updateJobStatus(job.id, 'failed', { errorMessage: `Job kind "${job.kind}" has nothing to resume` });
  }
  try {
    await kind.resume(job, helpers);
    return jobStore.getJob(job.id);
  } catch (e) {
    console.error(`[aida-jobs] job ${job.id} (${job.kind}) failed to resume:`, e);
    const failed = await jobStore.updateJobStatus(job.id, 'failed', { errorMessage: e.message });
    emitJobUpdate(failed);
    return failed;
  }
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const queued = await jobStore.listQueuedJobs();
    for (const job of queued) {
      await runOne(job);
    }
  } catch (e) {
    console.error('[aida-jobs] poll tick failed:', e);
  } finally {
    polling = false;
  }
}

/** Call once from server.js with the shared Socket.io instance. */
function start(ioInstance) {
  io = ioInstance;
  if (pollTimer) return;
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  pollTimer.unref?.();
}

module.exports = { start, resumeApproved, emitJobUpdate, roomForJob };
