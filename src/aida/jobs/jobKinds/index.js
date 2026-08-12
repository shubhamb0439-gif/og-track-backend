/**
 * Job-kind registry. Each kind exports:
 *   - run(job, helpers): called once when the runner picks the job up from
 *     'queued'. Should drive the job to a terminal state itself (completed/
 *     failed) OR to 'awaiting_approval' and then just return — the runner
 *     does not poll a running job, the kind decides when it's done.
 *   - resume(job, helpers) [optional]: called when an 'awaiting_approval'
 *     job is approved, to continue from wherever it left off. Kinds with no
 *     approval gate don't need this.
 * helpers = { appendEvent(event, detail), updateStatus(status, extra) }
 *
 * noop/noop_gated are synthetic, test-only kinds proving the job machinery
 * itself works (happy path + approval gate). dev_diagnose is the first real
 * one — registers here the exact same way; jobRunner.js and the routes
 * never had to change to add it.
 */
const kinds = {
  noop: {
    async run(job, { appendEvent, updateStatus }) {
      await appendEvent(job.id, 'started');
      await new Promise((resolve) => setTimeout(resolve, 500)); // stand-in for "did some work"
      await updateStatus(job.id, 'completed', { result: { message: 'noop job finished with nothing to do' } });
      await appendEvent(job.id, 'completed');
    },
  },

  noop_gated: {
    async run(job, { appendEvent, updateStatus }) {
      await appendEvent(job.id, 'started');
      await new Promise((resolve) => setTimeout(resolve, 500));
      await updateStatus(job.id, 'awaiting_approval');
      await appendEvent(job.id, 'awaiting_approval', { note: 'synthetic gate — approve or reject to continue' });
    },
    async resume(job, { appendEvent, updateStatus }) {
      await updateStatus(job.id, 'completed', { result: { message: 'noop_gated job finished after approval' } });
      await appendEvent(job.id, 'completed');
    },
  },

  dev_diagnose: require('./devDiagnose'),
};

function getJobKind(kind) {
  return kinds[kind] || null;
}

module.exports = { getJobKind, kinds };
