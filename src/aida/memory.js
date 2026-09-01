const coreDb = require('../db/core');
const config = require('../config');

/**
 * AIDA's long-term memory — distilled, durable facts about the master admin
 * (preferences, standing corrections, ongoing project context), NOT raw
 * conversation transcripts (those stay in sessionMemory.js, in-RAM,
 * short-lived). Master-admin scoped only; see contextBuilder.js/engine.js
 * for how this gets loaded into and referenced from a conversation.
 */

const CATEGORIES = ['user', 'feedback', 'project', 'reference'];

function newId() {
  return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Memories older than this are treated as expired (filtered out, not deleted) — null means no cutoff (lifetime retention). */
function retentionCutoff() {
  const days = config.aida.memory.retentionDays;
  if (days == null) return null;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

async function getActiveMemories() {
  if (!config.aida.memory.enabled) return [];
  let q = coreDb('aida_memories').orderBy('created_at', 'asc');
  const cutoff = retentionCutoff();
  if (cutoff) q = q.where('created_at', '>=', cutoff);
  return q;
}

async function saveMemory({ category, content }) {
  if (!CATEGORIES.includes(category)) {
    throw new Error(`Invalid memory category "${category}" — must be one of: ${CATEGORIES.join(', ')}`);
  }
  if (!content || !content.trim()) throw new Error('content is required.');
  const id = newId();
  await coreDb('aida_memories').insert({ id, category, content: content.trim() });
  return { id, category, content: content.trim() };
}

async function forgetMemory(id) {
  const deleted = await coreDb('aida_memories').where({ id }).delete();
  return deleted > 0;
}

module.exports = { getActiveMemories, saveMemory, forgetMemory, CATEGORIES };
