const config = require('../config');

/**
 * Sends a WhatsApp text message via the Business Cloud API — shared by
 * routes/whatsapp.js (replying to an incoming chat message) and
 * previewResolver.js (proactively notifying once a preview link is ready).
 * Best-effort: logs and swallows failures rather than throwing, since a
 * failed notification should never break whatever real work triggered it.
 */
async function sendWhatsAppMessage(to, body) {
  try {
    const url = `https://graph.facebook.com/v20.0/${config.whatsapp.phoneNumberId}/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.whatsapp.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
    });
    if (!res.ok) console.error('[whatsapp] send failed:', res.status, await res.text());
  } catch (e) {
    console.error('[whatsapp] send threw:', e.message);
  }
}

/**
 * Uploads a buffer to WhatsApp's media store and returns the media id Meta
 * assigns it — step 1 of the two-step document/image-sending flow (a
 * message can only reference an already-uploaded media id, never raw bytes
 * inline). Node's built-in FormData/Blob (global since Node 18) are used
 * directly — no extra multipart-encoding dependency needed.
 */
async function uploadWhatsAppMedia(buffer, mimeType) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buffer], { type: mimeType }));
  const res = await fetch(`https://graph.facebook.com/v20.0/${config.whatsapp.phoneNumberId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.whatsapp.accessToken}` },
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Media upload failed (${res.status})`);
  return data.id;
}

/**
 * Forwards a real file as a WhatsApp document message (not just a text
 * summary) — AIDA roadmap item 8.1. Best-effort, same swallow-and-log
 * convention as sendWhatsAppMessage: a failed forward should never break
 * the summary that was already sent alongside it.
 */
async function sendWhatsAppDocument(to, buffer, filename, mimeType, caption) {
  try {
    const mediaId = await uploadWhatsAppMedia(buffer, mimeType || 'application/octet-stream');
    const res = await fetch(`https://graph.facebook.com/v20.0/${config.whatsapp.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.whatsapp.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'document',
        document: { id: mediaId, filename, caption: caption || undefined },
      }),
    });
    if (!res.ok) console.error('[whatsapp] document send failed:', res.status, await res.text());
  } catch (e) {
    console.error('[whatsapp] document send threw:', e.message);
  }
}

/**
 * Downloads an inbound WhatsApp media attachment (the master admin sending
 * AIDA a document/image) — Meta's own two-step flow in reverse: GET the
 * media id for a short-lived authenticated CDN url, then GET that url with
 * the same bearer token to get the actual bytes. Throws (does not swallow)
 * since callers need the real buffer to do anything useful with it.
 */
async function downloadWhatsAppMedia(mediaId) {
  const metaRes = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${config.whatsapp.accessToken}` },
  });
  const meta = await metaRes.json();
  if (!metaRes.ok) throw new Error(meta?.error?.message || `Media lookup failed (${metaRes.status})`);

  const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${config.whatsapp.accessToken}` } });
  if (!fileRes.ok) throw new Error(`Media download failed (${fileRes.status})`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  return { buffer, mimeType: meta.mime_type, sizeBytes: meta.file_size };
}

module.exports = { sendWhatsAppMessage, sendWhatsAppDocument, uploadWhatsAppMedia, downloadWhatsAppMedia };
