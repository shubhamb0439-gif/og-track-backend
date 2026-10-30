const config = require('../../../config');
const Anthropic = require('@anthropic-ai/sdk');
const PDFDocument = require('pdfkit');
const { uploadBuffer, logoContainerName } = require('../../../utils/blobStorage');

/**
 * AIDA roadmap item 14, Component C — generates a real document (PowerPoint/
 * Excel/Word/PDF) via Anthropic's own pre-built Agent Skills, which run
 * server-side in Anthropic's own sandboxed container (nothing to do with
 * this app's own coding-agent sandbox). A single background job, no
 * approval gate — this never touches OG Track's own repos or data, only
 * talks to Anthropic directly, so there's nothing for a human to review
 * before it's safe to run (unlike dev_repo_fix/capability_gap_proposal).
 *
 * MUST be a background job, not part of a live chat turn — live-tested
 * 2026-10-26: a simple 3-slide pptx took 157 seconds end to end. Far too
 * slow for a chat reply to block on.
 *
 * The installed @anthropic-ai/sdk (0.32.1) predates the Files API entirely
 * (confirmed: `client.files` doesn't exist on it) but DOES correctly pass
 * through the newer `container`/`code_execution` request fields (it's a
 * generic JS object serializer, not schema-validated) — confirmed live. So
 * the main call still goes through the SDK; only file retrieval needs raw
 * fetch, same "raw fetch for an endpoint the SDK doesn't wrap yet"
 * precedent as elevenLabsClient.js/openaiTtsClient.js.
 *
 * Real, live-confirmed quirk: a plain PDF request can complete successfully
 * with no file_id ever appearing (the file existed in the sandbox per its
 * own stdout, but was never handed back) — handled below by completing the
 * job with just the narration text in that case, not failing it.
 */

const SKILL_IDS = ['pptx', 'xlsx', 'docx', 'pdf'];
// Reuses the EXISTING public "branding-logos" container rather than a new
// one — it's already public-read, already proven working, and avoids
// needing a new Azure resource (creating one hit this environment's own
// "new public surface" guard). Blob names are prefixed so generated
// documents are still clearly distinguishable from real logos within it.
const FILES_CONTAINER = logoContainerName;
const BLOB_PREFIX = 'aida-generated/';
const EXT_CONTENT_TYPES = {
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
};

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: config.aida.anthropicApiKey || config.aida.apiKey });
  return client;
}

function anthropicHeaders() {
  return { 'x-api-key': config.aida.anthropicApiKey || config.aida.apiKey, 'anthropic-version': '2023-06-01' };
}

/** Scans a full (non-streamed) response's content blocks for any generated-file id — see this file's header comment on why it isn't always present. */
function extractFileId(content) {
  for (const block of content) {
    if (block.type !== 'bash_code_execution_tool_result') continue;
    const inner = block.content;
    if (inner?.type === 'bash_code_execution_result') {
      for (const output of inner.content || []) {
        if (output.file_id) return output.file_id;
      }
    }
  }
  return null;
}

async function fetchFileMetadata(fileId) {
  const res = await fetch(`https://api.anthropic.com/v1/files/${fileId}`, { headers: anthropicHeaders() });
  if (!res.ok) throw new Error(`File metadata fetch failed (${res.status}): ${await res.text()}`);
  return res.json(); // { id, filename, mime_type, size_bytes, downloadable }
}

async function fetchFileContent(fileId) {
  const res = await fetch(`https://api.anthropic.com/v1/files/${fileId}/content`, { headers: anthropicHeaders() });
  if (!res.ok) throw new Error(`File content fetch failed (${res.status}): ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Fallback for the real, observed quirk above (skillId 'pdf' sometimes
 * produces no retrievable file_id at all) — renders the narration text
 * itself as a plain PDF via pdfkit (same library/approach as the
 * purpose-built make_pdf tool) so a Flow's next step always has a real
 * fileUrl to attach when 'pdf' was requested, instead of silently getting
 * null. Not attempted for pptx/xlsx/docx — pdfkit can't produce those
 * formats, and live testing found this quirk only ever hits 'pdf'.
 */
function renderFallbackPdfBuffer(narrationText) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.font('Helvetica').fontSize(11).text(narrationText || '(no content returned)', { align: 'left' });
    doc.end();
  });
}

module.exports = {
  async run(job, { appendEvent, updateStatus }) {
    const { skillId, instructions } = job.payload || {};
    if (!SKILL_IDS.includes(skillId)) {
      await updateStatus(job.id, 'failed', { errorMessage: `skillId must be one of: ${SKILL_IDS.join(', ')}` });
      return;
    }
    if (!instructions || !instructions.trim()) {
      await updateStatus(job.id, 'failed', { errorMessage: 'instructions is required.' });
      return;
    }
    if (!config.aida.anthropicApiKey && !config.aida.apiKey) {
      await updateStatus(job.id, 'failed', { errorMessage: 'No Anthropic API key configured — document generation always uses Anthropic directly, regardless of the conversation\'s own selected provider.' });
      return;
    }

    await appendEvent(job.id, 'started', { skillId, instructions });

    let response;
    try {
      response = await getClient().messages.create({
        model: config.aida.defaultModels.anthropic,
        max_tokens: 16000,
        container: { skills: [{ type: 'anthropic', skill_id: skillId, version: 'latest' }] },
        messages: [{ role: 'user', content: instructions }],
        tools: [{ type: 'code_execution_20260521', name: 'code_execution' }],
      });
    } catch (e) {
      await updateStatus(job.id, 'failed', { errorMessage: `Anthropic request failed: ${e.message}` });
      return;
    }
    await appendEvent(job.id, 'generated', { stopReason: response.stop_reason });

    const narrationText = (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const fileId = extractFileId(response.content || []);

    if (!fileId) {
      // Real, observed outcome (see header comment). For 'pdf' specifically,
      // don't leave fileUrl null — a Flow step chaining this into
      // send_email/message_contact's attachFileUrl would have nothing to
      // attach. Render the narration text as a plain fallback PDF instead,
      // so there's always a real, attachable file for this skill.
      if (skillId === 'pdf') {
        try {
          const buffer = await renderFallbackPdfBuffer(narrationText);
          const filename = `document-${job.id}.pdf`;
          const blobName = `${BLOB_PREFIX}${job.id}-${filename}`;
          const fileUrl = await uploadBuffer(buffer, blobName, 'application/pdf', FILES_CONTAINER);
          await appendEvent(job.id, 'fallback_pdf_rendered', { note: 'No file_id came back from Anthropic — rendered the narration text as a plain PDF instead.' });
          await updateStatus(job.id, 'completed', { result: { narrationText, fileUrl, filename } });
          await appendEvent(job.id, 'completed', {});
          return;
        } catch (e) {
          await appendEvent(job.id, 'fallback_pdf_failed', { error: e.message });
          // Fall through to the text-only completion below if even the fallback fails.
        }
      }
      await updateStatus(job.id, 'completed', { result: { narrationText, fileUrl: null, filename: null } });
      await appendEvent(job.id, 'completed', { note: 'No file_id came back — only narration text is available for this one.' });
      return;
    }

    let fileUrl = null, filename = null;
    try {
      const meta = await fetchFileMetadata(fileId);
      filename = meta.filename || `document.${skillId}`;
      const buffer = await fetchFileContent(fileId);
      const ext = (filename.split('.').pop() || skillId).toLowerCase();
      const contentType = EXT_CONTENT_TYPES[ext] || meta.mime_type || 'application/octet-stream';
      const blobName = `${BLOB_PREFIX}${job.id}-${filename}`;
      fileUrl = await uploadBuffer(buffer, blobName, contentType, FILES_CONTAINER);
      await appendEvent(job.id, 'file_uploaded', { filename, fileUrl });
    } catch (e) {
      // The document WAS generated — a storage hiccup shouldn't look like total failure, but the
      // user needs to know the file itself isn't attached this time.
      await appendEvent(job.id, 'file_upload_failed', { error: e.message });
    }

    await updateStatus(job.id, 'completed', { result: { narrationText, fileUrl, filename } });
    await appendEvent(job.id, 'completed', {});
  },
};
