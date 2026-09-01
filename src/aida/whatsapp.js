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

module.exports = { sendWhatsAppMessage };
