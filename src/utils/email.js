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
/**
 * `from` is optional — defaults to the platform's own sender (password
 * resets etc.). A caller sending on behalf of a specific brand (e.g.
 * Sitara's own order-recovery emails) passes its own verified sender
 * address instead, so a Sitara customer doesn't get an email that looks
 * like it came from unrelated OG Track infrastructure. Both addresses must
 * be verified on the SAME underlying ACS resource — adding a second
 * verified domain there doesn't need a new connection string.
 */
async function sendEmail({ to, subject, html, text, from }) {
  if (!config.email.enabled) throw new Error('Email is not configured (AZURE_ACS_EMAIL_CONNECTION_STRING / AZURE_ACS_EMAIL_SENDER missing).');
  const poller = await getClient().beginSend({
    senderAddress: from || config.email.senderAddress,
    content: { subject, html, plainText: text },
    recipients: { to: [{ address: to }] },
  });
  return poller.pollUntilDone();
}

module.exports = { sendEmail };
