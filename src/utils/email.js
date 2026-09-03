const { EmailClient } = require('@azure/communication-email');
const config = require('../config');

let client = null;
function getClient() {
  if (!client) client = new EmailClient(config.email.connectionString);
  return client;
}

/**
 * Sends one email via Azure Communication Services. Throws if email isn't
 * configured or the send itself fails — callers decide how to handle that
 * (see routes/users.js's forgot-password route, which deliberately never
 * lets a send failure leak back to the caller as anything other than the
 * same generic "if that email is registered..." response, to avoid
 * confirming/denying whether a given address exists in the system).
 */
async function sendEmail({ to, subject, html, text }) {
  if (!config.email.enabled) throw new Error('Email is not configured (AZURE_ACS_EMAIL_CONNECTION_STRING / AZURE_ACS_EMAIL_SENDER missing).');
  const poller = await getClient().beginSend({
    senderAddress: config.email.senderAddress,
    content: { subject, html, plainText: text },
    recipients: { to: [{ address: to }] },
  });
  return poller.pollUntilDone();
}

module.exports = { sendEmail };
