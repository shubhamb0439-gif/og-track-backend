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

// Live-verified twice now: a freshly (re)started process has occasionally
// failed to resolve an otherwise-valid, already-registered job kind on its
// very first lookup for a given job, despite the kinds registry being fully
// synchronous and unable to change after module load — root cause not
// pinned down, but empirically it always resolves by the very next poll
// tick. Rather than hard-fail a real job over what looks like a one-off
// environment blip, tolerate a few consecutive misses per job id before
// treating it as a genuine "this kind doesn't exist" failure.
const unknownKindMisses = new Map(); // jobId -> consecutive miss count
const MAX_UNKNOWN_KIND_RETRIES = 3;

async function runOne(job) {
  const kind = getJobKind(job.kind);
  if (!kind) {
    const misses = (unknownKindMisses.get(job.id) || 0) + 1;
    unknownKindMisses.set(job.id, misses);
    if (misses < MAX_UNKNOWN_KIND_RETRIES) {
      console.warn(`[aida-jobs] job ${job.id}: kind "${job.kind}" not found (attempt ${misses}/${MAX_UNKNOWN_KIND_RETRIES}) — leaving queued for the next poll tick.`);
      return; // stays 'queued' — the next poll tick will just try again
    }
    unknownKindMisses.delete(job.id);
    await jobStore.updateJobStatus(job.id, 'failed', { errorMessage: `Unknown job kind "${job.kind}"` });
    return;
  }
  unknownKindMisses.delete(job.id);
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

/**
 * Called by the reject endpoint, BEFORE the job itself is marked 'rejected'
 * — gives a kind with something real left in flight (dev_repo_fix's open
 * PR) a chance to clean it up. Best-effort: a kind with nothing to clean up
 * simply has no onReject, and a failure here is logged but never blocks the
 * reject itself from going through (the human's decision to reject stands
 * either way — a stray open PR they can close by hand is a much smaller
 * problem than a reject that silently fails).
 */
async function runOnReject(job) {
  const kind = getJobKind(job.kind);
  if (!kind || !kind.onReject) return;
  try {
    await kind.onReject(job, helpers);
  } catch (e) {
    console.error(`[aida-jobs] job ${job.id} (${job.kind}) onReject failed:`, e);
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

// Much slower than the main job poll above — this only ever checks GitHub
// for a frontend Static Web Apps preview URL that isn't known yet, and that
// build takes 1-3 minutes anyway, so there's no value in checking every 3s
// (and every tick here is a real GitHub API call per pending job). This is
// what makes the preview link resolve/broadcast on its own — a human doesn't
// have to ask AIDA or open the job panel for the aida:job socket update to
// fire once it's ready. See previewResolver.js for the resolve+persist+emit
// logic itself.
const PREVIEW_POLL_INTERVAL_MS = 20_000;
let previewPollTimer = null;
let previewPolling = false;

async function pollPendingPreviewUrls() {
  if (previewPolling) return;
  previewPolling = true;
  try {
    // Lazy require — previewResolver.js requires this module back (to emit
    // job updates), so at least one side of the cycle has to defer until
    // call time rather than module-load time.
    const { tryResolvePreviewUrl } = require('./previewResolver');
    const jobs = await jobStore.listJobs({ status: 'awaiting_approval', limit: 50 });
    for (const job of jobs) {
      await tryResolvePreviewUrl(job);
    }
  } catch (e) {
    console.error('[aida-jobs] preview-url poll tick failed:', e);
  } finally {
    previewPolling = false;
  }
}

/** Call once from server.js with the shared Socket.io instance. */
function start(ioInstance) {
  io = ioInstance;
  if (pollTimer) return;
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  pollTimer.unref?.();
  previewPollTimer = setInterval(pollPendingPreviewUrls, PREVIEW_POLL_INTERVAL_MS);
  previewPollTimer.unref?.();
}

module.exports = { start, resumeApproved, runOnReject, emitJobUpdate, roomForJob };
