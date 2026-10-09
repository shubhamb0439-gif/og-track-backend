const coreDb = require('../db/core');

/**
 * AIDA's remembered name -> email/WhatsApp-number mapping — so "mail pooja"
 * or "message lalith on whatsapp" works after the first time their details
 * were given alongside their name. Deliberately a separate, structured table
 * from memory.js's free-text aida_memories — a lookup AIDA code needs to
 * query directly, not prose meant only as LLM context.
 *
 * Scoped per master admin (ownerId) — confirmed live there are 2 real master
 * admins; before patch_09, this table was one global pool where admin A
 * saving "Lalith" would silently overwrite a DIFFERENT "Lalith" admin B had
 * already saved. Every function below takes ownerId and only ever
 * reads/writes that admin's own contacts — see getContactByPhone for the
 * one deliberate exception (inbound WhatsApp recognition has no "current
 * admin" to scope to, since the message isn't from an admin at all).
 */

function newId() {
  return `contact_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Strips a phone number down to digits and adds the country code when it's
 * missing — live-confirmed as a real bug otherwise: a human naturally says
 * "message pooja at 7624840126" (the normal way to state an Indian number,
 * no one actually says "91" out loud), the LLM passes that bare 10-digit
 * string straight through, and WhatsApp's send API silently rejects it since
 * it's not a real international number — the message never arrives, with no
 * error surfaced anywhere obvious. A number that's already 11+ digits (has
 * SOME country code, even if not India's) is left alone.
 */
function normalizeWhatsAppNumber(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

async function getContacts(ownerId) {
  return coreDb('ai_contacts').where({ owner_id: ownerId }).orderBy('name', 'asc');
}

/** Case-insensitive exact-name lookup, scoped to one admin's own contacts. Returns the most recently updated match if more than one somehow exists. */
async function findContactByName(ownerId, name) {
  return coreDb('ai_contacts').where({ owner_id: ownerId }).whereRaw('LOWER(name) = LOWER(?)', [String(name || '').trim()])
    .orderBy('updated_at', 'desc').first();
}

/**
 * Reverse lookup by WhatsApp number — deliberately NOT scoped by ownerId.
 * Used only for recognizing who just messaged AIDA on WhatsApp, where
 * there's no "current admin" context at all (the message is FROM an
 * external contact, not from an admin acting on their own contacts). Matches
 * on the last 10 digits so a stored "+91 98765 43210" and an inbound
 * "919876543210" still match without needing identical formatting.
 */
async function findContactByPhone(phoneNumber) {
  const last10 = String(phoneNumber || '').replace(/\D/g, '').slice(-10);
  if (!last10) return null;
  const candidates = await coreDb('ai_contacts').whereNotNull('whatsapp_number');
  return candidates.find((c) => String(c.whatsapp_number || '').replace(/\D/g, '').slice(-10) === last10) || null;
}

/**
 * Upsert by name (case-insensitive), scoped to ownerId — saving the same
 * name again just updates whichever of email/whatsappNumber was actually
 * passed, leaving the other untouched (so remembering a WhatsApp number for
 * someone who already has a saved email doesn't clobber it, and vice versa).
 * At least one of the two is required — matches the DB's own
 * CK_ai_contacts_has_identifier constraint, checked here first so the error
 * is clear rather than a raw SQL one.
 */
async function saveContact(ownerId, { name, email, whatsappNumber }) {
  if (!name || !name.trim()) throw new Error('name is required.');
  if ((!email || !email.trim()) && (!whatsappNumber || !whatsappNumber.trim())) {
    throw new Error('At least one of email or whatsappNumber is required.');
  }
  const updates = { updated_at: new Date() };
  if (email && email.trim()) updates.email = email.trim();
  if (whatsappNumber && whatsappNumber.trim()) updates.whatsapp_number = normalizeWhatsAppNumber(whatsappNumber);

  const existing = await findContactByName(ownerId, name);
  if (existing) {
    await coreDb('ai_contacts').where({ id: existing.id }).update(updates);
    return { id: existing.id, name: existing.name, email: updates.email ?? existing.email, whatsappNumber: updates.whatsapp_number ?? existing.whatsapp_number };
  }
  const id = newId();
  await coreDb('ai_contacts').insert({ id, owner_id: ownerId, name: name.trim(), ...updates });
  return { id, name: name.trim(), email: updates.email ?? null, whatsappNumber: updates.whatsapp_number ?? null };
}

/** Scoped to ownerId — an admin can only ever forget their own saved contacts. */
async function forgetContact(ownerId, id) {
  const deleted = await coreDb('ai_contacts').where({ id, owner_id: ownerId }).delete();
  return deleted > 0;
}

module.exports = { getContacts, findContactByName, findContactByPhone, saveContact, forgetContact, normalizeWhatsAppNumber };
