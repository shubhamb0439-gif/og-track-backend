const config = require('./../config');
const { getGraphToken } = require('./graphClient');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

function toRecipientList(addresses) {
  return (Array.isArray(addresses) ? addresses : [addresses]).filter(Boolean)
    .map((address) => ({ emailAddress: { address } }));
}

async function graphFetch(token, url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (res.status === 204 || res.status === 202) return null; // no body on these
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error?.message || `Graph request failed (${res.status})`);
  return data;
}

/**
 * Composes and sends a brand-new email as config.microsoftGraph.mailbox
 * (aida@sanj.co) — used by the send_email tool (AIDA-initiated mail, not a
 * reply to something that arrived). `attachments` is an optional array of
 * { filename, mimeType, buffer } — forwarded as real file attachments, not
 * links.
 */
async function sendMail({ to, cc, subject, body, attachments }) {
  const token = await getGraphToken();
  const message = {
    subject,
    body: { contentType: 'Text', content: body },
    toRecipients: toRecipientList(to),
    ccRecipients: cc ? toRecipientList(cc) : [],
  };
  if (attachments?.length) {
    message.attachments = attachments.map((a) => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: a.filename,
      contentType: a.mimeType || 'application/octet-stream',
      contentBytes: a.buffer.toString('base64'),
    }));
  }
  await graphFetch(token, `${GRAPH_BASE}/users/${config.microsoftGraph.mailbox}/sendMail`, {
    method: 'POST',
    body: JSON.stringify({ message, saveToSentItems: true }),
  });
}

/**
 * Replies to an existing message (by Graph message id) with a real threaded
 * reply, ALSO adding an extra CC recipient (the master admin) who wasn't
 * necessarily on the original thread. Uses the single-call `/reply`
 * endpoint — its `message` parameter accepts "any writeable properties to
 * update in the reply," including ccRecipients, confirmed directly against
 * a live message. Needs only Mail.Send (which we have); the alternative
 * createReply->PATCH->send draft flow needs Mail.ReadWrite instead, a
 * separate permission not worth requesting for this.
 */
async function replyToEmailWithCc({ messageId, commentText, ccAddress }) {
  const token = await getGraphToken();
  const mailbox = config.microsoftGraph.mailbox;
  await graphFetch(token, `${GRAPH_BASE}/users/${mailbox}/messages/${messageId}/reply`, {
    method: 'POST',
    body: JSON.stringify({
      comment: commentText,
      message: { ccRecipients: toRecipientList(ccAddress) },
    }),
  });
}

module.exports = { sendMail, replyToEmailWithCc };
