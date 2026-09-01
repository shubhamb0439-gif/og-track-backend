const config = require('../../config');
const jobStore = require('../jobs/jobStore');
const jobRunner = require('../jobs/jobRunner');
const { MASTERADMIN_SENTINEL_MODULE } = require('../contextBuilder');
const { tryResolvePreviewUrl } = require('../jobs/previewResolver');

/** Human-readable summary of what approving/rejecting a job would actually do — shown to the user before either tool acts for real. */
function describeJob(job) {
  if (job.kind === 'create_module') {
    const prs = [
      job.result?.backendPr && `backend PR #${job.result.backendPr.number} (${job.result.backendPr.url})`,
      job.result?.frontendPr && `frontend PR #${job.result.frontendPr.number} (${job.result.frontendPr.url})`,
    ].filter(Boolean);
    return { jobId: job.id, kind: job.kind, moduleName: job.result?.moduleName, prs };
  }
  return { jobId: job.id, kind: job.kind, repo: job.result?.repo, task: job.result?.task, pr: job.result?.prNumber && `PR #${job.result.prNumber} (${job.result.prUrl})` };
}

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
    name: 'dev_repo_fix',
    description:
      'Ask AIDA to actually diagnose AND FIX a real problem in an authorized repo — clones it into ' +
      'a disposable sandbox, runs a coding agent (reads/writes files, runs the test suite), and if ' +
      'it produces a real fix, pushes a branch and opens a real GitHub pull request for human review ' +
      '(never merges automatically). Runs as a background job — returns a job id immediately; call ' +
      'dev_get_job_status with that id to check progress, or check the AIDA Job panel once it reaches ' +
      "awaiting_approval. Unlike dev_repo_diagnose, this can execute code (npm install/test) — but " +
      'only inside the disposable sandbox, which never has real credentials.',
    requiredModules: [MASTERADMIN_SENTINEL_MODULE],
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: "GitHub 'owner/repo' full name, e.g. 'my-org/my-repo'." },
        task: {
          type: 'string',
          description: 'What to fix, in plain language (e.g. "the attendance clock-out endpoint returns the wrong total hours for a shift that crosses midnight"). If omitted, defaults to: run the test suite and fix whatever is failing.',
        },
      },
      required: ['repo'],
    },
    async handler(context, { repo, task }) {
      if (!config.aida.authorizedRepos.includes(repo)) {
        return {
          error: `Repo "${repo}" is not authorized for AIDA repo access.`,
          authorizedRepos: config.aida.authorizedRepos,
        };
      }
      if (!config.aida.codingAgent.enabled) {
        return { error: 'The coding agent is not configured on this server yet (missing its provider API key).' };
      }
      const job = await jobStore.createJob({ kind: 'dev_repo_fix', createdByUserId: context.userId, payload: { repo, task } });
      return {
        jobId: job.id,
        status: job.status,
        message: `Started working on "${repo}"${task ? ` — ${task}` : ' (running the test suite and fixing anything failing)'} (job ${job.id}). This runs in the background — ask me to check on it in a bit, or watch the AIDA Job panel.`,
      };
    },
  },

  {
    name: 'create_module',
    description:
      'Ask AIDA to build brand-new frontend/backend code from scratch and open a real PR for review — this ' +
      'covers TWO different kinds of requests, set via `kind`: (1) "module" — a new integrated OG Track ' +
      'feature with its own backend routes/database table, e.g. "create me a module called Attendance with ' +
      'these features: ...". (2) "page" — a standalone, self-contained HTML page with NO backend/database ' +
      'involved, e.g. "build me a landing page for a coffee shop" or "make me a Coming Soon page". Always use ' +
      'this tool (not dev_repo_fix) for either kind of "build me something new" request. Clones the repo(s) ' +
      'into disposable sandboxes, writes the code, and if successful, pushes a branch and opens a PR (both ' +
      'repos\' PRs for a module, frontend-only for a page), and boots a LIVE local preview for a human to ' +
      'click through before approving. Never merges or goes to production automatically. Runs as a background ' +
      'job — returns a job id immediately; check the AIDA Job panel once it reaches awaiting_approval for the ' +
      'preview link.',
    requiredModules: [MASTERADMIN_SENTINEL_MODULE],
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['module', 'page'],
          description: '"module" for a new integrated feature with its own backend/database; "page" for a standalone page with no backend involved (a landing page, a "coming soon" page, etc). Defaults to "module" if omitted.',
        },
        moduleName: { type: 'string', description: 'Human-readable name, e.g. "Attendance" or "Coming Soon".' },
        features: {
          type: 'array',
          items: { type: 'string' },
          description: 'For a module: the feature list, one item per feature (e.g. ["Clock in/out with GPS", "Weekly timesheet export"]). For a page: what it should contain/say, one item per section or requirement (e.g. ["Title and short description", "Email signup form"]).',
        },
      },
      required: ['moduleName', 'features'],
    },
    async handler(context, { moduleName, features, kind }) {
      if (!config.aida.moduleBuilder.enabled) {
        return { error: 'The module builder is not fully configured on this server yet (missing repo names or the staging database connection).' };
      }
      if (!config.aida.codingAgent.enabled) {
        return { error: 'The coding agent is not configured on this server yet (missing its provider API key).' };
      }
      const effectiveKind = kind === 'page' ? 'page' : 'module';
      const job = await jobStore.createJob({ kind: 'create_module', createdByUserId: context.userId, payload: { moduleName, features, kind: effectiveKind } });
      return {
        jobId: job.id,
        status: job.status,
        message: `Started building the "${moduleName}" ${effectiveKind} (job ${job.id}). This runs in the background and can take a while — ask me to check on it, or watch the AIDA Job panel for the live preview link once it's ready for review.`,
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
      let job = await jobStore.getJob(jobId);
      if (!job) return { error: `No job found with id "${jobId}".` };
      // Same live check the web job panel does — so asking AIDA directly in
      // chat surfaces a just-finished frontend preview link too, not only
      // when the panel happened to already be open.
      job = await tryResolvePreviewUrl(job);
      return { job };
    },
  },

  {
    name: 'dev_approve_job',
    description:
      "Approves an 'awaiting_approval' AIDA job — merges its real PR(s) into main. SAFETY — this is a real, " +
      "irreversible action: call this WITHOUT confirmed first, it returns a preview instead of merging anything. " +
      "Read that preview back to the user (which repo(s)/PR(s) this would merge) and wait for their explicit yes " +
      "in their NEXT message. Only then call this again with the exact same jobId plus confirmed: true.",
    requiredModules: [MASTERADMIN_SENTINEL_MODULE],
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        confirmed: { type: 'boolean', description: 'Only set true after the user has explicitly confirmed approval, in a later message.' },
      },
      required: ['jobId'],
    },
    async handler(context, { jobId, confirmed }) {
      const job = await jobStore.getJob(jobId);
      if (!job) return { error: `No job found with id "${jobId}".` };
      if (job.status !== 'awaiting_approval') return { error: `Job ${jobId} is not awaiting approval (status: ${job.status}) — nothing to approve.` };

      if (!confirmed) {
        return {
          status: 'needs_confirmation',
          preview: describeJob(job),
          instruction: 'Read this preview back to the user and ask them to confirm before merging. Do NOT merge anything until they explicitly say yes in their next message — then call this tool again with confirmed: true.',
        };
      }

      const approved = await jobStore.updateJobStatus(job.id, 'approved');
      await jobStore.appendEvent(job.id, 'approved', { approvedBy: context.userId });
      jobRunner.emitJobUpdate(approved);
      const final = await jobRunner.resumeApproved(approved);
      return { success: final.status === 'completed', status: final.status, job: final };
    },
  },

  {
    name: 'dev_reject_job',
    description:
      "Rejects an 'awaiting_approval' AIDA job — closes its PR(s) without merging, and never touches main. " +
      "SAFETY: call this WITHOUT confirmed first to preview what would be closed; only call again with " +
      "confirmed: true after the user explicitly confirms in their next message.",
    requiredModules: [MASTERADMIN_SENTINEL_MODULE],
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        confirmed: { type: 'boolean', description: 'Only set true after the user has explicitly confirmed rejection, in a later message.' },
      },
      required: ['jobId'],
    },
    async handler(context, { jobId, confirmed }) {
      const job = await jobStore.getJob(jobId);
      if (!job) return { error: `No job found with id "${jobId}".` };
      if (job.status !== 'awaiting_approval') return { error: `Job ${jobId} is not awaiting approval (status: ${job.status}) — nothing to reject.` };

      if (!confirmed) {
        return {
          status: 'needs_confirmation',
          preview: describeJob(job),
          instruction: 'Read this preview back to the user and ask them to confirm before rejecting. Only call this tool again with confirmed: true after they explicitly say yes.',
        };
      }

      await jobRunner.runOnReject(job);
      const rejected = await jobStore.updateJobStatus(job.id, 'rejected');
      await jobStore.appendEvent(job.id, 'rejected', { rejectedBy: context.userId });
      jobRunner.emitJobUpdate(rejected);
      return { success: true, job: rejected };
    },
  },
];
