const coreDb = require('../db/core');

/**
 * AIDA's remembered name -> email mapping (master-admin scoped, OGCore) —
 * so "mail pooja" works after the first time her address was given
 * alongside her name. Deliberately a separate, structured table from
 * memory.js's free-text aida_memories — a lookup AIDA code needs to query
 * directly, not prose meant only as LLM context.
 */

function newId() {
  return `contact_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function getContacts() {
  return coreDb('ai_contacts').orderBy('name', 'asc');
}

/** Case-insensitive exact-name lookup. Returns the most recently updated match if more than one somehow exists. */
async function findContactByName(name) {
  return coreDb('ai_contacts').whereRaw('LOWER(name) = LOWER(?)', [String(name || '').trim()]).orderBy('updated_at', 'desc').first();
}

/** Upsert by name (case-insensitive) — saving the same name again just updates its email. */
async function saveContact({ name, email }) {
  if (!name || !name.trim()) throw new Error('name is required.');
  if (!email || !email.trim()) throw new Error('email is required.');
  const existing = await findContactByName(name);
  if (existing) {
    await coreDb('ai_contacts').where({ id: existing.id }).update({ email: email.trim(), updated_at: new Date() });
    return { id: existing.id, name: existing.name, email: email.trim() };
  }
  const id = newId();
  await coreDb('ai_contacts').insert({ id, name: name.trim(), email: email.trim() });
  return { id, name: name.trim(), email: email.trim() };
}

async function forgetContact(id) {
  const deleted = await coreDb('ai_contacts').where({ id }).delete();
  return deleted > 0;
}

module.exports = { getContacts, findContactByName, saveContact, forgetContact };
