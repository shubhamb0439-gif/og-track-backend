const config = require('../../config');
const jobStore = require('./jobStore');
const { getSwaPreviewUrl } = require('../codingAgent/github');
const { sendWhatsAppMessage } = require('../whatsapp');

/**
 * The frontend repo's Azure Static Web Apps preview URL isn't known at
 * PR-open time (see devFix.js / createModule.js) — it only appears in a bot
 * comment once that build finishes, 1-3 minutes later. This is the ONE place
 * that checks for it and persists it once found, so every caller (the job
 * panel's GET /jobs/:id, the dev_get_job_status chat tool, and jobRunner's
 * background poll below) shares the same logic instead of drifting apart.
 */
async function fetchUrl(repo, prNumber, jobId) {
  try {
    const [owner, repoName] = repo.split('/');
    return await getSwaPreviewUrl({ owner, repo: repoName, token: config.aida.codingAgent.githubToken, pullNumber: prNumber });
  } catch (e) {
    console.error(`[aida] preview-URL lookup failed for job ${jobId}:`, e.message);
    return null;
  }
}

/** Texts every allowed WhatsApp number the moment a preview link resolves — the whole reason this poller exists, rather than making someone come back and check. No-op if WhatsApp isn't configured. */
async function notifyPreviewReady(job) {
  if (!config.whatsapp.enabled || !config.whatsapp.allowedNumbers.length) return;

  let label, links;
  if (job.kind === 'create_module') {
    label = `"${job.result.moduleName}"`;
    links = [
      job.result.previewUrls?.frontendUrl && `Frontend: ${job.result.previewUrls.frontendUrl}`,
      job.result.previewUrls?.backendUrl && `Backend: ${job.result.previewUrls.backendUrl}`,
    ].filter(Boolean).join('\n');
  } else {
    label = (job.result.task || '').slice(0, 80).replace(/\s+/g, ' ');
    links = job.result.previewUrl;
  }
  if (!links) return; // nothing to actually show — shouldn't happen given the callers, but never send an empty link

  await Promise.all(config.whatsapp.allowedNumbers.map((n) => sendWhatsAppMessage(n, `🔗 AIDA preview ready — ${label}\n${links}`)));
}

/**
 * If `job` has an unresolved frontend preview URL waiting to be discovered,
 * tries to resolve it, persists it, and broadcasts the update over the same
 * `aida:job` socket event every other job change already uses. Safe and
 * cheap to call unconditionally on any job — a no-op for anything that
 * doesn't need it. Returns the job (updated in place if something resolved,
 * otherwise unchanged).
 */
async function tryResolvePreviewUrl(job) {
  let updated = null;

  if (job.kind === 'dev_repo_fix' && job.result?.prNumber && job.result?.previewUrl == null &&
      job.result?.repo === config.aida.moduleBuilder.frontendRepo) {
    const previewUrl = await fetchUrl(job.result.repo, job.result.prNumber, job.id);
    if (previewUrl) {
      updated = await jobStore.updateJobStatus(job.id, job.status, { result: { ...job.result, previewUrl } });
    }
  } else if (job.kind === 'create_module' && job.result?.frontendPr && job.result?.previewUrls?.frontendUrl == null) {
    let previewUrl = await fetchUrl(job.result.frontendRepo, job.result.frontendPr.number, job.id);
    // A standalone page (kind: 'page') lives at its own file — the SWA bot
    // comment only ever gives the site's root, which would just be a blank
    // (or unrelated) landing spot, not the actual thing that was built.
    if (previewUrl && job.payload?.kind === 'page' && job.result.slug) {
      previewUrl = `${previewUrl.replace(/\/+$/, '')}/${job.result.slug}.html`;
    }
    if (previewUrl) {
      updated = await jobStore.updateJobStatus(job.id, job.status, {
        result: { ...job.result, previewUrls: { ...job.result.previewUrls, frontendUrl: previewUrl, frontendReady: true } },
      });
    }
  }

  if (!updated) return job;
  // Lazy require — avoids a load-order cycle with jobRunner.js (which never
  // needs this module itself, only the route/tool/poller callers do).
  require('./jobRunner').emitJobUpdate(updated);
  notifyPreviewReady(updated).catch((e) => console.error(`[aida] preview-ready WhatsApp notify failed for job ${updated.id}:`, e.message));
  return updated;
}

module.exports = { tryResolvePreviewUrl, notifyPreviewReady };
