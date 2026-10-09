const { callLLM, callLLMChat } = require('./llmCompletion');
const sessionMemory = require('./sessionMemory');
const coreDb = require('../db/core');

/**
 * AIDA roadmap item 9's "recognize who just messaged" piece — when a known
 * contact (not a master admin) messages AIDA's WhatsApp number for the
 * first time, this is what actually talks to them.
 *
 * Deliberately built on callLLMChat (a bare completion call), NOT
 * engine.runTurn — confirmed via toolRegistry.js's isAvailable() that any
 * context whose kind isn't 'masteradmin' is treated as a generic "tenant"
 * context, where any tool with no module requirement is "always available"
 * regardless of kind. Inventing a new context.kind here would have silently
 * handed an external, unverified contact whatever module-less tools exist
 * today OR get added later — a real, ongoing risk not worth taking for a
 * feature whose whole point is a tool-free conversation. This path has
 * literally no tool definitions in reach, so there's nothing to leak.
 *
 * Reuses sessionMemory.js for conversation history by giving each contact a
 * synthetic, clearly-namespaced session key (kind !== 'masteradmin', a fixed
 * tenantSlug so it can never collide with a real company slug, userId = the
 * contact's own ai_contacts row id) — same TTL/bounding behavior every other
 * session already gets, no new store needed.
 */

const SYSTEM_PROMPT = [
  'You are AIDA, a helpful assistant, chatting over WhatsApp with someone OUTSIDE the company —',
  'a known contact, not an employee or admin. You have NO tools and NO access to any internal',
  'company systems, data, or accounts in this conversation. Just have a normal, friendly, helpful',
  'conversation. If they ask you to do something that would need internal access (checking records,',
  'sending something on the company\'s behalf, changing anything), say plainly that you can\'t do that',
  'over this channel and suggest they reach out to the team directly. Keep replies short — this is WhatsApp.',
].join(' ');

function sessionContextFor(contact) {
  return { kind: 'contact', tenantSlug: '__contact_chat__', userId: contact.id };
}

/** Builds the reply AND records the turn in the same bounded, TTL'd session history every other AIDA conversation uses. */
async function respondToContact(contact, text) {
  const sessionContext = sessionContextFor(contact);
  const history = sessionMemory.getHistory(sessionContext);
  const systemPrompt = `${SYSTEM_PROMPT} You're talking with ${contact.name}.`;

  let reply;
  try {
    reply = await callLLMChat(systemPrompt, [...history, { role: 'user', content: text }], 500);
  } catch (e) {
    console.error('[contact-chat] LLM call failed:', e.message);
    reply = "Sorry, I'm having trouble replying right now — try again in a bit.";
  }
  sessionMemory.appendTurn(sessionContext, text, reply);
  return reply;
}

const ATTACHMENT_SYSTEM_PROMPT = [
  'An external contact just sent a file over WhatsApp, along with (optionally) a short message/caption.',
  'You are given the filename, their message/caption if any, and whatever text could be extracted from the file.',
  'Respond with ONLY a single JSON object, no markdown fencing: ' +
    '{"summary": "2-3 sentence plain-language summary of what this file is about", ' +
    '"forwardToName": "shubham"|"sanj"|null}',
  'Set forwardToName to "shubham" or "sanj" ONLY when their message clearly asks to forward/send/pass this file ' +
    'to that specific person by name (e.g. "please send this to Shubham"). If they didn\'t mention a name, or the ' +
    'name isn\'t clearly one of those two, leave it null — do NOT guess who they might mean.',
].join(' ');

/**
 * Summarizes an attachment a known external contact sent, and — ONLY when
 * their own message explicitly names a recipient — identifies who they want
 * it forwarded to. This is a classification call, not a tool: the actual
 * forwarding decision and action happen in deterministic code in
 * routes/whatsapp.js, never inside this untrusted conversation's own
 * reasoning — same "no tools reachable from here" guarantee respondToContact
 * already gives, just extended to cover this one new input shape.
 */
async function summarizeAndRouteAttachment({ filename, caption, extractedText }) {
  const userContent = [
    `Filename: ${filename}`,
    caption ? `Their message: ${caption}` : '(no message/caption, just the file)',
    '',
    extractedText ? `Extracted file content:\n${extractedText.slice(0, 8000)}` : '(no text could be extracted from this file type.)',
  ].join('\n');

  const fallback = { summary: `Received a file: "${filename}".`, forwardToName: null };
  try {
    const raw = await callLLM(ATTACHMENT_SYSTEM_PROMPT, userContent, 300);
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]);
    const forwardToName = ['shubham', 'sanj'].includes(String(parsed.forwardToName || '').toLowerCase())
      ? String(parsed.forwardToName).toLowerCase() : null;
    return {
      summary: typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : fallback.summary,
      forwardToName,
    };
  } catch (e) {
    console.error('[contact-chat] attachment summarization failed:', e.message);
    return fallback;
  }
}

/** Resolves a first-name guess ("shubham"/"sanj") to a real platform_admins row with a real WhatsApp number — never guessed, only an exact name match. */
async function resolveAdminByFirstName(firstName) {
  if (!firstName) return null;
  const admin = await coreDb('platform_admins').whereRaw('LOWER(name) = LOWER(?)', [firstName]).where({ status: 'active' }).first();
  return admin?.whatsapp_number ? admin : null;
}

module.exports = { respondToContact, summarizeAndRouteAttachment, resolveAdminByFirstName };
