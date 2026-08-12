const config = require('../../config');
const jobStore = require('../jobs/jobStore');
const { MASTERADMIN_SENTINEL_MODULE } = require('../contextBuilder');

/**
 * Master-admin-only "AIDA as a coding agent" tools — the lightweight,
 * no-code-execution first slice of the AIDA power-tier plan's Part 1. See
 * src/aida/jobs/jobKinds/devDiagnose.js for what actually runs.
 */
module.exports = [
  {
    name: 'dev_repo_diagnose',
    description:
      'Clone an authorized GitHub repository and produce a diagnosis report (bugs, security ' +
      'vulnerabilities, performance issues, code quality, configuration issues, architectural ' +
      'concerns, dependency risks). Read-only: clones and reads source text only, never executes ' +
      "anything from the repo. Runs as a background job — returns a job id immediately; call " +
      'dev_get_job_status with that id later to get the actual report.',
    requiredModules: [MASTERADMIN_SENTINEL_MODULE],
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: "GitHub 'owner/repo' full name, e.g. 'my-org/my-repo'." },
      },
      required: ['repo'],
    },
    async handler(context, { repo }) {
      if (!config.aida.authorizedRepos.includes(repo)) {
        return {
          error: `Repo "${repo}" is not authorized for AIDA repo access.`,
          authorizedRepos: config.aida.authorizedRepos,
        };
      }
      const job = await jobStore.createJob({ kind: 'dev_diagnose', createdByUserId: context.userId, payload: { repo } });
      return {
        jobId: job.id,
        status: job.status,
        message: `Started diagnosing ${repo} (job ${job.id}). This runs in the background — ask me to check on it in a bit.`,
      };
    },
  },

  {
    name: 'dev_get_job_status',
    description:
      'Check the status of a background AIDA job by its job id (e.g. one returned by ' +
      'dev_repo_diagnose). If completed, includes the actual result/report.',
    requiredModules: [MASTERADMIN_SENTINEL_MODULE],
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    },
    async handler(context, { jobId }) {
      const job = await jobStore.getJob(jobId);
      if (!job) return { error: `No job found with id "${jobId}".` };
      return { job };
    },
  },
];
