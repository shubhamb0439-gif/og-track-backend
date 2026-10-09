const { callLLMChat } = require('./llmCompletion');
const sessionMemory = require('./sessionMemory');

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

module.exports = { respondToContact };
