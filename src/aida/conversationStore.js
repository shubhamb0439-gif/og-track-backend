const coreDb = require('../db/core');

/**
 * Durable, multi-thread AIDA chat history for masteradmin — the piece
 * sessionMemory.js (in-memory, single rolling window, no browsable history)
 * doesn't cover: cross-device/cross-restart continuity, and a real "see my
 * old chats" / "start a new chat" UI. See patch_12_ai_conversations.sql for
 * why this exists alongside sessionMemory rather than replacing it.
 *
 * "Active" conversation is deliberately not a separate pointer column —
 * it's just whichever conversation has the most recent last_message_at.
 * Continuing an OLD chat naturally makes it active again (its
 * last_message_at gets bumped), which is exactly the behavior wanted: pick
 * up an old thread anywhere and it becomes "the" conversation going forward.
 */

function newId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function mapConversation(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at,
  };
}

async function createConversation(ownerId, title) {
  const id = newId('conv');
  const now = new Date();
  await coreDb('ai_conversations').insert({
    id, owner_id: ownerId, title: title || null, created_at: now, updated_at: now, last_message_at: now,
  });
  return mapConversation({ id, owner_id: ownerId, title: title || null, created_at: now, updated_at: now, last_message_at: now });
}

/** The owner's most recently active conversation, or a brand new one if they've never chatted before. */
async function getOrCreateActive(ownerId) {
  const existing = await coreDb('ai_conversations').where({ owner_id: ownerId }).orderBy('last_message_at', 'desc').first();
  if (existing) return mapConversation(existing);
  return createConversation(ownerId);
}

/** Ownership-checked lookup — returns null (never another admin's conversation) if id doesn't belong to ownerId. */
async function getConversation(ownerId, id) {
  return mapConversation(await coreDb('ai_conversations').where({ id, owner_id: ownerId }).first());
}

async function listConversations(ownerId, { limit = 50 } = {}) {
  const rows = await coreDb('ai_conversations').where({ owner_id: ownerId }).orderBy('last_message_at', 'desc').limit(limit);
  return rows.map(mapConversation);
}

async function getMessages(conversationId, { limit = 200 } = {}) {
  const rows = await coreDb('ai_conversation_messages').where({ conversation_id: conversationId }).orderBy('created_at', 'asc').limit(limit);
  return rows.map((r) => ({ role: r.role, content: r.content, createdAt: r.created_at }));
}

/**
 * Appends one turn's messages (user + assistant), bumps last_message_at (the
 * thing that makes a continued-old-chat "active" again), and auto-fills
 * title from the first-ever user message in this conversation if it doesn't
 * have one yet. Best-effort from every call site — never meant to block or
 * fail a real chat reply, same convention as memory/capability-gap lookups
 * elsewhere in src/aida/.
 */
async function appendTurn(conversationId, userMessage, assistantMessage) {
  const now = new Date();
  const rows = [
    { id: newId('convmsg'), conversation_id: conversationId, role: 'user', content: userMessage, created_at: now },
    { id: newId('convmsg'), conversation_id: conversationId, role: 'assistant', content: assistantMessage, created_at: now },
  ];
  await coreDb('ai_conversation_messages').insert(rows);

  const updates = { updated_at: now, last_message_at: now };
  const conv = await coreDb('ai_conversations').where({ id: conversationId }).first();
  if (conv && !conv.title && userMessage) updates.title = userMessage.trim().slice(0, 60);
  await coreDb('ai_conversations').where({ id: conversationId }).update(updates);
}

module.exports = { createConversation, getOrCreateActive, getConversation, listConversations, getMessages, appendTurn };
