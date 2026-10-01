const config = require('../config');

/**
 * Places a short spoken-alert phone call via Twilio's REST API — AIDA
 * roadmap item 3's urgent-email escalation, reserved for genuinely urgent
 * incoming email only (not bug reports — see docs/FRONTEND_PROMPTS.md's
 * item 4b notes on this same boundary). The TwiML is passed inline in the
 * request itself (a `<Response><Say>...</Say></Response>` document), so no
 * separate publicly-reachable TwiML-hosting endpoint is needed for a call
 * that only ever speaks one fixed message and hangs up.
 *
 * Best-effort: logs and swallows failures rather than throwing, matching
 * every other outbound-notification helper in this codebase
 * (sendWhatsAppMessage) — a failed call should never break whatever real
 * work triggered it.
 */
async function placeUrgentCall(to, message) {
  if (!config.twilio.enabled) return;
  try {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(message)}</Say></Response>`;
    const url = `https://api.twilio.com/2010-04-01/Accounts/${config.twilio.accountSid}/Calls.json`;
    const auth = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString('base64');
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: config.twilio.fromNumber, Twiml: twiml }),
    });
    if (!res.ok) console.error('[twilio] call request failed:', res.status, await res.text());
  } catch (e) {
    console.error('[twilio] call request threw:', e.message);
  }
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

module.exports = { placeUrgentCall };
