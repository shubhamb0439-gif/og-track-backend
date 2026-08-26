const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const coreDb = require('../db/core');
const { MASTERADMIN_SENTINEL_MODULE } = require('../aida/contextBuilder');
const { runTurn } = require('../aida/engine');
const sessionMemory = require('../aida/sessionMemory');
const { buildDirective, safeDirective } = require('../aida/responseDirector');

const router = express.Router();

/**
 * WhatsApp Business Cloud API bridge — lets an allowlisted phone number chat
 * with AIDA's master-admin context over WhatsApp, using the EXACT same
 * engine.runTurn()/sessionMemory/masteradmin tools the web chat UI uses.
 * WhatsApp itself already verifies who's texting (the phone number), so this
 * only adds one gate on top: the number must be on WHATSAPP_ALLOWED_NUMBERS.
 */

function last10(raw) {
  return String(raw || '').replace(/\D/g, '').slice(-10);
}

// Small bounded in-memory dedupe — WhatsApp can redeliver the same webhook
// event on retry (e.g. if our ack was slow/lost). Not persisted; a server
// restart losing this is fine, a redelivered message just gets answered again.
const seenMessageIds = new Set();
const MAX_SEEN_IDS = 500;
function alreadyProcessed(id) {
  if (!id) return false;
  if (seenMessageIds.has(id)) return true;
  seenMessageIds.add(id);
  if (seenMessageIds.size > MAX_SEEN_IDS) {
    seenMessageIds.delete(seenMessageIds.values().next().value);
  }
  return false;
}

function verifySignature(req) {
  if (!config.whatsapp.appSecret) {
    console.warn('[whatsapp] WHATSAPP_APP_SECRET not set — skipping signature verification (set it before relying on this in production).');
    return true;
  }
  const signature = req.headers['x-hub-signature-256'];
  if (!signature || !req.rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', config.whatsapp.appSecret).update(req.rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false; // length mismatch etc. — definitely not a match
  }
}

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
 * Builds a masteradmin AidaContext for a WhatsApp turn. There's no JWT to
 * verify here (WhatsApp already told us who's texting via phone number), but
 * every masteradmin tool loops back into this app's own protected REST API
 * (see apiClient.js) and needs a real Authorization header to get through —
 * so this mints a short-lived masteradmin JWT server-side, same pattern
 * already used for cross-tenant synthetic tokens in masteradminCrossTenant.js.
 */
async function buildWhatsAppMasterAdminContext(fromNumber) {
  const mappedEmail = config.whatsapp.adminMap[last10(fromNumber)] || config.whatsapp.adminMap[fromNumber];
  let admin = mappedEmail
    ? await coreDb('platform_admins').where({ email: String(mappedEmail).toLowerCase() }).first()
    : null;
  if (!admin) admin = await coreDb('platform_admins').where({ status: 'active' }).first();
  if (!admin) throw new Error('No active platform admin found to act as for this WhatsApp turn.');

  const token = jwt.sign(
    { adminId: admin.id, name: admin.name, email: admin.email, role: 'masteradmin' },
    config.app.jwtSecret,
    { expiresIn: '5m' }
  );
  return {
    kind: 'masteradmin',
    tenantSlug: null,
    companyId: null,
    companyName: null,
    userId: admin.id,
    role: 'masteradmin',
    enabledModules: [MASTERADMIN_SENTINEL_MODULE],
    authHeader: `Bearer ${token}`,
    currentPage: null,
    currentModule: null,
    currentRoute: null,
    activeEntity: null,
  };
}

// GET /api/whatsapp/webhook — Meta's one-time verification handshake, fired
// whenever the callback URL/verify token is (re)saved in Meta's app config.
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && config.whatsapp.verifyToken && token === config.whatsapp.verifyToken) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// POST /api/whatsapp/webhook — incoming messages. Acks immediately (WhatsApp
// expects a fast response and will retry/disable the webhook on repeated
// timeouts) and does the actual AIDA turn + reply afterward.
router.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    if (!config.whatsapp.enabled) return;
    if (!verifySignature(req)) {
      console.error('[whatsapp] rejected a webhook POST with an invalid/missing signature.');
      return;
    }

    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || message.type !== 'text') return; // status callbacks, non-text messages, etc. — nothing to do
    if (alreadyProcessed(message.id)) return;

    const from = message.from;
    const text = (message.text?.body || '').trim();
    if (!text) return;

    const isAllowed = config.whatsapp.allowedNumbers.some((n) => last10(n) === last10(from));
    if (!isAllowed) {
      await sendWhatsAppMessage(from, "You don't have access.");
      return;
    }

    const context = await buildWhatsAppMasterAdminContext(from);
    const history = sessionMemory.getHistory(context);
    const directive = config.aida.emotionEnabled ? buildDirective(text) : safeDirective(null);
    const result = await runTurn(context, text, history, directive);

    if (result.reply && result.reply.trim()) {
      sessionMemory.appendTurn(context, text, result.reply);
      await sendWhatsAppMessage(from, result.reply);
    }
  } catch (e) {
    console.error('[whatsapp] webhook processing failed:', e);
  }
});

module.exports = router;
