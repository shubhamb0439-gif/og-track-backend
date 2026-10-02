const config = require('../config');
const coreDb = require('../db/core');
const { sendWhatsAppMessage, sendWhatsAppDocument } = require('./whatsapp');
const { placeUrgentCall } = require('./twilio');
const { callLLM } = require('./llmCompletion');
const { getGraphToken } = require('./graphClient');
const { extractTextFromBuffer } = require('./attachmentText');
const emailLog = require('./emailLog');

// Bounded so a message with many large attachments doesn't turn one email
// into a flood of WhatsApp messages — matches the "first N" convention
// autoInspectSource already uses for downloaded images elsewhere in AIDA.
const MAX_ATTACHMENTS_TO_FORWARD = 3;

/**
 * AIDA roadmap item 3 — watches a shared mailbox (config.microsoftGraph.mailbox,
 * e.g. aida@sanj.co) for mail addressed to one of a small set of watched "To"
 * recipients (config.microsoftGraph.recipientRouting), which only reach this
 * mailbox at all because it's CC'd — the CC is why AIDA sees the mail, the
 * "To" address is what decides who gets notified and on which number.
 *
 * Uses Microsoft Graph's mailbox "delta query": each poll re-submits the
 * `@odata.deltaLink` URL Graph returned last time, which returns only what
 * changed since — persisted in OGCore's ai_email_monitor_state (one row) so
 * a server restart doesn't reprocess the whole mailbox. The very FIRST ever
 * call to a delta endpoint returns the ENTIRE existing mailbox as "changed"
 * — see poll()'s isFirstRun handling, which pages through and discards that
 * initial backlog rather than notifying about months of old mail.
 *
 * Known limitation, accepted rather than engineered around: if a message
 * that was already processed changes again later (e.g. marked read/flagged
 * in Outlook), delta will surface it again, which would re-trigger a
 * duplicate WhatsApp summary. Not guarded against — real occurrences should
 * be rare and low-cost (a duplicate summary, not a duplicate call/action),
 * and a message-id dedupe table would be real added complexity for a
 * genuinely rare edge case.
 */

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const POLL_STATE_ID = 'singleton';

let pollTimer = null;
let polling = false;

async function getState() {
  const row = await coreDb('ai_email_monitor_state').where({ id: POLL_STATE_ID }).first();
  if (row) return row;
  await coreDb('ai_email_monitor_state').insert({ id: POLL_STATE_ID, delta_link: null });
  return { id: POLL_STATE_ID, delta_link: null };
}

async function saveDeltaLink(deltaLink) {
  await coreDb('ai_email_monitor_state').where({ id: POLL_STATE_ID }).update({ delta_link: deltaLink, updated_at: new Date() });
}

/** Pages through Graph's delta query until exhausted. Returns every message found plus the final deltaLink to persist for next time. */
async function fetchDeltaPages(token, startUrl) {
  let url = startUrl;
  let messages = [];
  let deltaLink = null;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Graph delta query failed (${res.status})`);
    messages = messages.concat(data.value || []);
    if (data['@odata.nextLink']) {
      url = data['@odata.nextLink'];
    } else {
      deltaLink = data['@odata.deltaLink'] || null;
      url = null;
    }
  }
  return { messages, deltaLink };
}

/**
 * Fetches every real file attachment on a message — both its raw bytes (for
 * forwarding over WhatsApp, item 8.1) and, where the type supports it,
 * extracted text (for the summarization prompt). Previously only did the
 * latter and discarded the bytes entirely.
 */
async function fetchAttachments(token, messageId) {
  const res = await fetch(`${GRAPH_BASE}/users/${config.microsoftGraph.mailbox}/messages/${messageId}/attachments`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(`[email-monitor] attachment list fetch failed for message ${messageId}:`, data.error?.message);
    return [];
  }

  const attachments = [];
  for (const att of data.value || []) {
    if (att['@odata.type'] !== '#microsoft.graph.fileAttachment' || !att.contentBytes) continue;
    const name = att.name || 'attachment';
    const buffer = Buffer.from(att.contentBytes, 'base64');
    const text = await extractTextFromBuffer(buffer, name);
    attachments.push({ name, mimeType: att.contentType || 'application/octet-stream', buffer, text });
  }
  return attachments;
}

const SUMMARY_SYSTEM_PROMPT = [
  'You summarize an incoming business email for a busy master admin who will read this on WhatsApp.',
  'You are given the email body and any text extracted from its attachments.',
  'Respond with ONLY a single JSON object, no markdown fencing: ' +
    '{"summary": "2-4 sentence plain-language summary of what this email is about and what (if anything) is being asked", ' +
    '"isUrgent": true|false}',
  'Mark isUrgent true only for something that genuinely needs attention today/immediately — a real complaint, ' +
    'a payment/legal/compliance issue, a system outage, an angry customer, a deadline today — NOT routine ' +
    'correspondence, newsletters, FYI notices, or anything that can wait.',
].join(' ');

async function summarizeEmail({ subject, from, bodyText, attachmentsText }) {
  const userContent = [
    `From: ${from}`,
    `Subject: ${subject}`,
    '',
    'Body:',
    bodyText,
    attachmentsText ? `\nAttachments:\n${attachmentsText}` : '',
  ].join('\n');
  const fallback = { summary: `New email from ${from}: "${subject}"`, isUrgent: false };
  let raw;
  try {
    raw = await callLLM(SUMMARY_SYSTEM_PROMPT, userContent, 400);
  } catch (e) {
    return { ...fallback, note: `Summarization failed (${e.message}) — used a generic fallback.` };
  }
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    return {
      summary: typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : fallback.summary,
      isUrgent: parsed.isUrgent === true,
    };
  } catch {
    return { ...fallback, note: 'Summarization response was not valid JSON — used a generic fallback.' };
  }
}

/** Which watched "To" address (if any) this message was sent to, and the WhatsApp number that maps to. */
function matchedRecipient(message) {
  const toAddresses = (message.toRecipients || []).map((r) => (r.emailAddress?.address || '').toLowerCase());
  for (const [watchedAddress, phoneNumber] of Object.entries(config.microsoftGraph.recipientRouting)) {
    if (toAddresses.includes(watchedAddress.toLowerCase())) return { watchedAddress, phoneNumber };
  }
  return null;
}

async function processMessage(token, message) {
  if (message['@removed'] || !message.toRecipients) return; // a deletion/removal marker, not a real message
  const match = matchedRecipient(message);
  if (!match) return; // not addressed to a watched recipient

  const attachments = message.hasAttachments ? await fetchAttachments(token, message.id) : [];
  const attachmentsText = attachments.map((a) => (a.text ? `--- ${a.name} ---\n${a.text}` : null)).filter(Boolean).join('\n\n');
  const bodyText = (message.body?.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const from = message.from?.emailAddress?.address || 'unknown sender';
  const subject = message.subject || '(no subject)';

  const { summary, isUrgent } = await summarizeEmail({ subject, from, bodyText, attachmentsText });

  const text = `📧 New email to ${match.watchedAddress}\nFrom: ${from}\nSubject: ${subject}\n\n${summary}`;
  await sendWhatsAppMessage(match.phoneNumber, text);

  for (const att of attachments.slice(0, MAX_ATTACHMENTS_TO_FORWARD)) {
    await sendWhatsAppDocument(match.phoneNumber, att.buffer, att.name, att.mimeType);
  }

  await emailLog.logEmail({
    graphMessageId: message.id,
    watchedAddress: match.watchedAddress,
    fromAddress: from,
    subject,
    summary,
    isUrgent,
  }).catch((e) => console.error('[email-monitor] failed to log email for later reply:', e.message));

  if (isUrgent) {
    await placeUrgentCall(
      match.phoneNumber,
      `Urgent email alert. You have an urgent email from ${from}, subject ${subject}. Please check WhatsApp for details.`
    );
  }
}

async function poll() {
  if (polling || !config.microsoftGraph.enabled) return;
  polling = true;
  try {
    const token = await getGraphToken();
    const state = await getState();
    const isFirstRun = !state.delta_link;
    const startUrl = state.delta_link
      || `${GRAPH_BASE}/users/${config.microsoftGraph.mailbox}/mailFolders/inbox/messages/delta`;
    const { messages, deltaLink } = await fetchDeltaPages(token, startUrl);

    if (isFirstRun) {
      console.log(`[email-monitor] first run — established baseline cursor over ${messages.length} existing message(s); none processed.`);
    } else {
      for (const message of messages) {
        try {
          await processMessage(token, message);
        } catch (e) {
          console.error(`[email-monitor] failed processing message ${message.id}:`, e.message);
        }
      }
    }

    if (deltaLink) await saveDeltaLink(deltaLink);
  } catch (e) {
    console.error('[email-monitor] poll tick failed:', e.message);
  } finally {
    polling = false;
  }
}

/** Call once from server.js, next to jobRunner.start(). No-op if not configured. */
function start() {
  if (!config.microsoftGraph.enabled) {
    console.log('[email-monitor] not configured (missing MS_GRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET) — poller not started.');
    return;
  }
  if (pollTimer) return;
  poll().catch((e) => console.error('[email-monitor] initial poll failed:', e.message));
  pollTimer = setInterval(poll, config.microsoftGraph.pollIntervalMs);
  pollTimer.unref?.();
}

module.exports = { start };
