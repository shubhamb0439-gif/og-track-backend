const fs = require('fs');
const path = require('path');
const sql = require('mssql');
const config = require('../../../config');
const { createSandbox } = require('../../codingAgent/sandbox');
const { runCommand, listFiles, readFile } = require('../../codingAgent/tools');
const { snapshotExistingFiles } = require('../../codingAgent/moduleGuardrails');
// Same provider switch as devFix.js — AIDA_CODING_AGENT_PROVIDER=anthropic
// picks this up automatically, no code change needed beyond this file
// existing once (see docs/AIDA_PHASE2_MODULE_BUILDER_PLAN.md).
const { runModuleBuilderAgent } = config.aida.codingAgent.provider === 'anthropic'
  ? require('../../codingAgent/providers/anthropicModuleBuilder')
  : require('../../codingAgent/providers/moduleBuilder');
const { runSqlFileAgainstPool } = require('../../../utils/provisioning');
const {
  createBranch, commitAll, pushBranch, openPullRequest,
  mergePullRequest, closePullRequest, authenticatedRemoteUrl,
} = require('../../codingAgent/github');
const { startPreview, stopPreview } = require('../../codingAgent/preview');

/**
 * Phase 2 of the AIDA power-tier plan — "Hey AIDA, create me a module
 * called X with these features." See docs/AIDA_PHASE2_MODULE_BUILDER_PLAN.md
 * for the full design. Clones BOTH the backend and frontend repos into
 * sibling sandboxes, runs the dual-repo module-builder agent (guardrailed to
 * new-files-only, see moduleGuardrails.js), and — if it produced real
 * changes — pushes matching branches, opens a PR in each repo, and boots
 * BOTH sandboxes as a live pair of processes against the shared staging
 * database so a human can actually click through the module before
 * approving it.
 *
 * Unlike devFix.js, the sandboxes are NOT cleaned up when this reaches
 * awaiting_approval — the live preview is still running FROM those
 * directories. Cleanup happens in resume()/onReject() below, right after
 * the preview is torn down. If a job sits in awaiting_approval forever
 * (nobody ever approves/rejects it), its sandboxes and preview processes
 * leak until the server restarts — acceptable for a first version, worth a
 * TTL-based reaper later if that becomes a real problem.
 */

function slugify(moduleName) {
  return String(moduleName || '')
    .trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function formatFeatures(features) {
  if (Array.isArray(features)) return features.map((f) => `- ${f}`).join('\n');
  return String(features || '').trim();
}

function nextSchemaScriptNumber(backendSandboxDir) {
  let entries = [];
  try {
    entries = listFiles(backendSandboxDir, 'ogtrack-sql-schema/tenant', { recursive: false });
  } catch {
    return '13'; // directory listing failed (shouldn't happen in a real clone) — safe-ish fallback, agent should verify itself
  }
  const numbers = entries
    .map((f) => /^(\d+)_/.exec(f.split('/').pop()))
    .filter(Boolean)
    .map((m) => parseInt(m[1], 10));
  const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
  return String(next).padStart(2, '0');
}

function buildTask({ moduleName, slug, features, nextNumber }) {
  return `Build a brand-new OG Track module called "${moduleName}" (module key: "${slug}").

Requested features:
${formatFeatures(features)}

Backend: create src/routes/${slug}.js implementing these features (follow the style of an existing
similar route file — read a couple first). Create the module's schema at
ogtrack-sql-schema/tenant/${nextNumber}_module_${slug}.sql (additive-only — read a couple of existing
files in that directory first to match table-naming and dbo. schema conventions exactly). Register the
module by ADDING lines (never changing existing ones) to src/server.js (a require for the new route file
and one app.use('/api/:slug/${slug}', resolveTenant, requireModule('${slug}'), ${slug}Routes) line,
matching the existing pattern used by other modules there) and to src/utils/provisioning.js (one new
MODULE_TO_SCRIPT entry mapping "${slug}" to the new script filename, and adding that filename to the
orderedScripts list in the same file).

Frontend: implement the actual screens/components for these features, and wire up API calls that match
the backend routes you just wrote exactly (same paths, same request/response shapes). If the frontend
needs to register this module in a shared navigation/router file you were not given as an insert-only
file, do NOT edit it — describe the exact line(s) needed in your finish summary instead.`;
}

/** A "page" request is frontend-only — no backend route, no schema, no server.js/provisioning.js edits, no sidebar entry. Just one new self-contained HTML file. */
function buildPageTask({ moduleName, slug, features }) {
  return `Build a standalone, self-contained HTML page called "${moduleName}" at ${slug}.html.

What it should contain:
${formatFeatures(features)}

This is a public/standalone page, NOT an integrated OG Track feature — do NOT touch the backend repo at
all (no route file, no database schema, no server.js/provisioning.js changes), and do NOT add a sidebar
entry or touch the app's navigation in index.html/masteradmin.html. Just one new file, ${slug}.html, with
its own inline <style> (match the general visual feel of the existing site if you can infer it from
index.html — colors, fonts — but this page does not need to share its layout or depend on its login/API
adapter). Any form on the page can be non-functional UI only (no real backend to submit to) unless the
requested features say otherwise.`;
}

module.exports = {
  async run(job, { appendEvent, updateStatus }) {
    const { moduleName, features, kind } = job.payload || {};
    const isPage = kind === 'page';
    if (!moduleName || !String(moduleName).trim()) {
      await updateStatus(job.id, 'failed', { errorMessage: 'Missing moduleName in job payload.' });
      return;
    }
    const mb = config.aida.moduleBuilder;
    const ca = config.aida.codingAgent;
    if (!mb.enabled) {
      await updateStatus(job.id, 'failed', {
        errorMessage: 'Module builder is not fully configured yet (needs AIDA_MODULE_BACKEND_REPO, ' +
          'AIDA_MODULE_FRONTEND_REPO, and AIDA_STAGING_SQL_* env vars for the preview database).',
      });
      return;
    }
    if (!ca.enabled || !ca.githubToken) {
      await updateStatus(job.id, 'failed', { errorMessage: 'Coding agent is not configured (missing provider API key or AIDA_CODING_AGENT_GITHUB_TOKEN).' });
      return;
    }

    const slug = slugify(moduleName);
    const [backendOwner, backendRepoName] = mb.backendRepo.split('/');
    const [frontendOwner, frontendRepoName] = mb.frontendRepo.split('/');
    await appendEvent(job.id, 'started', { moduleName, slug, features });

    let backendSandbox, frontendSandbox;
    let reachedAwaitingApproval = false;
    try {
      backendSandbox = await createSandbox(authenticatedRemoteUrl(backendOwner, backendRepoName, ca.githubToken));
      frontendSandbox = await createSandbox(authenticatedRemoteUrl(frontendOwner, frontendRepoName, ca.githubToken));
      await appendEvent(job.id, 'cloned', { backendRepo: mb.backendRepo, frontendRepo: mb.frontendRepo });

      await appendEvent(job.id, 'installing');
      // Not every repo here is guaranteed to be an npm project — the
      // frontend in particular may be plain static files with no
      // package.json at all (confirmed live: it's static HTML served as-is
      // by serve.js, no build step). Running `npm install` against a
      // directory with no package.json fails hard (ENOENT), so check first
      // and skip per-sandbox rather than assuming every repo needs it.
      const [backendHasPkg, frontendHasPkg] = [
        fs.existsSync(path.join(fs.realpathSync(backendSandbox.dir), 'package.json')),
        fs.existsSync(path.join(fs.realpathSync(frontendSandbox.dir), 'package.json')),
      ];
      const [backendInstall, frontendInstall] = await Promise.all([
        backendHasPkg
          ? runCommand(backendSandbox.dir, 'npm', ['install', '--no-audit', '--no-fund'], { timeoutMs: 180_000 })
          : Promise.resolve({ exitCode: 0, skipped: true }),
        frontendHasPkg
          ? runCommand(frontendSandbox.dir, 'npm', ['install', '--no-audit', '--no-fund'], { timeoutMs: 180_000 })
          : Promise.resolve({ exitCode: 0, skipped: true }),
      ]);
      if (backendInstall.exitCode !== 0 || frontendInstall.exitCode !== 0) {
        await updateStatus(job.id, 'failed', {
          errorMessage: `npm install failed — backend: ${backendInstall.exitCode === 0 ? 'ok' : backendInstall.stderr.slice(0, 500)}, ` +
            `frontend: ${frontendInstall.exitCode === 0 ? 'ok' : frontendInstall.stderr.slice(0, 500)}`,
        });
        await appendEvent(job.id, 'failed', { stage: 'install' });
        return;
      }
      await appendEvent(job.id, 'installed', { backendSkipped: !backendHasPkg, frontendSkipped: !frontendHasPkg });

      const branchName = `aida/module-${slug}-${job.id}`;
      await createBranch(backendSandbox.dir, branchName);
      await createBranch(frontendSandbox.dir, branchName);

      const existingFiles = { backend: snapshotExistingFiles(backendSandbox.dir), frontend: snapshotExistingFiles(frontendSandbox.dir) };
      const originalContents = { backend: new Map(), frontend: new Map() };
      for (const f of mb.insertOnlyFiles.backend) {
        try { originalContents.backend.set(f, readFile(backendSandbox.dir, f)); } catch { /* file may not exist in this checkout — write will fail its own way */ }
      }
      for (const f of mb.insertOnlyFiles.frontend) {
        try { originalContents.frontend.set(f, readFile(frontendSandbox.dir, f)); } catch { /* same as above */ }
      }

      const nextNumber = nextSchemaScriptNumber(backendSandbox.dir);
      const task = isPage
        ? buildPageTask({ moduleName, slug, features })
        : buildTask({ moduleName, slug, features, nextNumber });

      await appendEvent(job.id, 'agent_started');
      const toolLog = [];
      const agentResult = await runModuleBuilderAgent({
        sandboxDirs: { backend: backendSandbox.dir, frontend: frontendSandbox.dir },
        task,
        existingFiles,
        insertOnlyFiles: mb.insertOnlyFiles,
        originalContents,
        // Raised from 40, then 60 — the agent now (a) attempts the large-file
        // (index.html) workaround instead of giving up, AND (b) has to find
        // and hook into the SPA's own in-page view-dispatch mechanism rather
        // than just appending a sidebar array entry, both of which cost
        // real iterations on top of building both repos.
        maxIterations: 80,
        onEvent: (e) => toolLog.push(e),
      });
      await appendEvent(job.id, 'agent_finished', { success: agentResult.success, toolCallCount: agentResult.toolLog.length });

      if (!agentResult.success) {
        await updateStatus(job.id, 'failed', {
          errorMessage: agentResult.summary,
          result: { moduleName, slug, agentSummary: agentResult.summary, toolLog: agentResult.toolLog },
        });
        await appendEvent(job.id, 'failed', { stage: 'agent' });
        return;
      }

      const [backendCommit, frontendCommit] = await Promise.all([
        commitAll(backendSandbox.dir, `AIDA: add ${slug} module (backend)`),
        commitAll(frontendSandbox.dir, `AIDA: add ${slug} module (frontend)`),
      ]);

      if (!backendCommit.committed && !frontendCommit.committed) {
        await updateStatus(job.id, 'completed', {
          result: { moduleName, slug, agentSummary: agentResult.summary, changed: false, toolLog: agentResult.toolLog },
        });
        await appendEvent(job.id, 'completed', { changed: false });
        return;
      }

      let backendPr = null, frontendPr = null;
      if (backendCommit.committed) {
        await pushBranch(backendSandbox.dir, { owner: backendOwner, repo: backendRepoName, token: ca.githubToken, branchName });
        backendPr = await openPullRequest({
          owner: backendOwner, repo: backendRepoName, token: ca.githubToken,
          head: branchName, base: 'main',
          title: `AIDA module: ${moduleName} (backend)`,
          body: `${agentResult.summary}\n\n---\n_Opened automatically by AIDA's phase-2 module-builder job (${job.id}). Companion frontend PR: see the AIDA Job panel. Review the diff, CI status, and live preview, then Approve or Reject there._`,
        });
        await appendEvent(job.id, 'backend_pr_opened', { prNumber: backendPr.number, prUrl: backendPr.html_url });
      }
      if (frontendCommit.committed) {
        await pushBranch(frontendSandbox.dir, { owner: frontendOwner, repo: frontendRepoName, token: ca.githubToken, branchName });
        frontendPr = await openPullRequest({
          owner: frontendOwner, repo: frontendRepoName, token: ca.githubToken,
          head: branchName, base: 'main',
          title: `AIDA module: ${moduleName} (frontend)`,
          body: `${agentResult.summary}\n\n---\n_Opened automatically by AIDA's phase-2 module-builder job (${job.id}). Companion backend PR: see the AIDA Job panel. Review the diff, CI status, and live preview, then Approve or Reject there._`,
        });
        await appendEvent(job.id, 'frontend_pr_opened', { prNumber: frontendPr.number, prUrl: frontendPr.html_url });
      }

      // The agent's new SQL file isn't in MODULE_TO_SCRIPT yet (that only
      // happens once the backend PR merges), so the normal provisioning
      // path can't pick it up — run whatever NEW .sql files the agent added
      // directly against the staging DB here, so the preview actually has
      // the module's own tables before it boots.
      const newSqlFiles = listFiles(backendSandbox.dir, 'ogtrack-sql-schema/tenant', { recursive: false })
        .filter((f) => f.endsWith('.sql') && !existingFiles.backend.has(f));
      if (newSqlFiles.length) {
        await appendEvent(job.id, 'seeding_preview_schema', { files: newSqlFiles });
        try {
          await applyNewSchemaFilesToStaging(newSqlFiles, backendSandbox.dir, mb.stagingDb);
          await appendEvent(job.id, 'preview_schema_seeded');
        } catch (e) {
          await appendEvent(job.id, 'preview_schema_seed_failed', { error: e.message });
        }
      }
      // Every module is gated per-company via enabled_modules (same as
      // attendance, CRM, etc.) — a module this new was never in the preview
      // company's list (it didn't exist when the staging DB was seeded), so
      // without this it would silently 403/hide in the preview even with
      // everything else working correctly.
      try {
        await enableModuleForPreviewCompany(slug, mb.stagingDb, mb.previewCompanySlug);
      } catch (e) {
        await appendEvent(job.id, 'preview_module_enable_failed', { error: e.message });
      }

      await appendEvent(job.id, 'booting_preview');
      let previewUrls = null;
      try {
        previewUrls = await startPreview({
          jobId: job.id,
          backendDir: backendSandbox.dir,
          frontendDir: frontendSandbox.dir,
          stagingDb: mb.stagingDb,
          frontendStartCommand: mb.frontendStartCommand,
          previewBackendPort: mb.previewBackendPort,
          frontendPortEnvVar: mb.frontendPortEnvVar,
        });
        await appendEvent(job.id, 'preview_ready', previewUrls);
      } catch (e) {
        await appendEvent(job.id, 'preview_failed', { error: e.message });
      }

      reachedAwaitingApproval = true;
      await updateStatus(job.id, 'awaiting_approval', {
        result: {
          moduleName, slug, agentSummary: agentResult.summary, changed: true,
          branch: branchName,
          backendRepo: mb.backendRepo, frontendRepo: mb.frontendRepo,
          backendPr: backendPr && { number: backendPr.number, url: backendPr.html_url },
          frontendPr: frontendPr && { number: frontendPr.number, url: frontendPr.html_url },
          previewUrls,
          backendSandboxDir: backendSandbox.dir,
          frontendSandboxDir: frontendSandbox.dir,
          toolLog: agentResult.toolLog,
        },
      });
      await appendEvent(job.id, 'awaiting_approval', { backendPrUrl: backendPr?.html_url, frontendPrUrl: frontendPr?.html_url });
      return; // sandboxes stay on disk — the live preview is running from them; cleaned up on approve/reject below
    } catch (e) {
      const safeMessage = ca.githubToken ? e.message.split(ca.githubToken).join('***') : e.message;
      await updateStatus(job.id, 'failed', { errorMessage: safeMessage });
      await appendEvent(job.id, 'failed', { error: safeMessage });
    } finally {
      // Only clean up here on any path that did NOT reach awaiting_approval —
      // once we're there (even if the preview itself failed to boot), the
      // sandboxes are referenced by job.result for resume()/onReject() to
      // find and clean up later, right after tearing down the preview.
      if (!reachedAwaitingApproval) {
        backendSandbox?.cleanup();
        frontendSandbox?.cleanup();
      }
    }
  },

  /** Called only when a human clicks Approve on an 'awaiting_approval' create_module job — merges both real PRs, tears down the preview, cleans up the sandboxes. */
  async resume(job, { appendEvent, updateStatus }) {
    const { backendRepo, frontendRepo, backendPr, frontendPr, backendSandboxDir, frontendSandboxDir } = job.result || {};
    try {
      if (backendPr) {
        const [owner, repoName] = backendRepo.split('/');
        await mergePullRequest({ owner, repo: repoName, token: config.aida.codingAgent.githubToken, pullNumber: backendPr.number });
        await appendEvent(job.id, 'backend_merged', { prNumber: backendPr.number });
      }
      if (frontendPr) {
        const [owner, repoName] = frontendRepo.split('/');
        await mergePullRequest({ owner, repo: repoName, token: config.aida.codingAgent.githubToken, pullNumber: frontendPr.number });
        await appendEvent(job.id, 'frontend_merged', { prNumber: frontendPr.number });
      }
      stopPreview(job.id);
      cleanupSandboxDirs(backendSandboxDir, frontendSandboxDir);
      await updateStatus(job.id, 'completed', { result: { ...job.result, merged: true } });
    } catch (e) {
      await updateStatus(job.id, 'failed', { errorMessage: `Approved, but merging failed: ${e.message}` });
      await appendEvent(job.id, 'merge_failed', { error: e.message });
    }
  },

  /** Called only when a human clicks Reject on an 'awaiting_approval' create_module job — closes both real PRs without merging, tears down the preview. */
  async onReject(job, { appendEvent }) {
    const { backendRepo, frontendRepo, backendPr, frontendPr, backendSandboxDir, frontendSandboxDir } = job.result || {};
    try {
      if (backendPr) {
        const [owner, repoName] = backendRepo.split('/');
        await closePullRequest({ owner, repo: repoName, token: config.aida.codingAgent.githubToken, pullNumber: backendPr.number });
        await appendEvent(job.id, 'backend_pr_closed', { prNumber: backendPr.number });
      }
      if (frontendPr) {
        const [owner, repoName] = frontendRepo.split('/');
        await closePullRequest({ owner, repo: repoName, token: config.aida.codingAgent.githubToken, pullNumber: frontendPr.number });
        await appendEvent(job.id, 'frontend_pr_closed', { prNumber: frontendPr.number });
      }
    } catch (e) {
      await appendEvent(job.id, 'pr_close_failed', { error: e.message });
    } finally {
      stopPreview(job.id);
      cleanupSandboxDirs(backendSandboxDir, frontendSandboxDir);
    }
  },
};

/** Runs newly-created (not-yet-merged) schema files straight from the sandbox against the staging DB, so the live preview actually has the new module's tables. Safe to re-run — same already-exists-skipping as the real provisioning path. */
async function applyNewSchemaFilesToStaging(relFiles, backendSandboxDir, stagingDb) {
  const pool = await sql.connect({
    server: stagingDb.server, port: stagingDb.port, user: stagingDb.user, password: stagingDb.password,
    database: stagingDb.database, requestTimeout: 60000, connectionTimeout: 30000,
    options: { encrypt: true, trustServerCertificate: false },
  });
  try {
    for (const relFile of relFiles) {
      const absPath = path.join(fs.realpathSync(backendSandboxDir), relFile);
      const result = await runSqlFileAgainstPool(pool, absPath);
      if (result.failed) throw new Error(`${relFile}: ${result.failureMessages.join(' | ')}`);
    }
  } finally {
    await pool.close();
  }
}

/** Adds `slug` to the staging DB's own preview company's enabled_modules list, if not already there — never touches any real tenant's company row. */
async function enableModuleForPreviewCompany(slug, stagingDb, previewCompanySlug) {
  const pool = await sql.connect({
    server: stagingDb.server, port: stagingDb.port, user: stagingDb.user, password: stagingDb.password,
    database: stagingDb.database, requestTimeout: 30000, connectionTimeout: 30000,
    options: { encrypt: true, trustServerCertificate: false },
  });
  try {
    const row = await pool.request().input('slug', sql.NVarChar, previewCompanySlug)
      .query('SELECT id, enabled_modules FROM dbo.companies WHERE slug = @slug');
    if (!row.recordset.length) return; // preview company not seeded yet — scripts/provisionStagingDb.js hasn't been run
    const company = row.recordset[0];
    const modules = JSON.parse(company.enabled_modules || '[]');
    if (modules.includes(slug)) return;
    modules.push(slug);
    await pool.request()
      .input('id', sql.UniqueIdentifier, company.id)
      .input('modules', sql.NVarChar, JSON.stringify(modules))
      .query('UPDATE dbo.companies SET enabled_modules = @modules WHERE id = @id');
  } finally {
    await pool.close();
  }
}

function cleanupSandboxDirs(...dirs) {
  for (const dir of dirs) {
    if (!dir) continue;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort — a leaked temp dir is harmless, unlike a leaked process */ }
  }
}
