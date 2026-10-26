const { synthesizeChunkStream, mimeTypeForFormat } = require('./openaiTtsClient');
const config = require('../../config');

/**
 * A bare greeting ("hi", "hello", "good morning") never needs a live LLM
 * round trip at all — it's answered directly from this small pool, with its
 * audio synthesized once (here, lazily on first use, or up front at server
 * startup via warmGreetingCache()) and replayed instantly from then on. Same
 * caching mechanics as fillerPhrases.js, but these are REAL, complete
 * replies — the turn ends here, nothing else runs after one.
 *
 * Deliberately conservative: GREETING_RE must match the ENTIRE trimmed
 * message, so "hi, can you also check my orders" is untouched and goes
 * through the normal engine — only a message that is JUST a greeting (plus
 * trivial punctuation) takes this path.
 */

const GREETING_RE = /^(hi+|hello+|hey+|yo+|sup|howdy|good\s*(morning|afternoon|evening|night)|morning|evening)[\s!.,]*$/i;

const GREETING_REPLIES = [
  'Hey! What are we working on?',
  "Hi there — what's up?",
  'Hello! What can I dig into for you?',
  'Hey, good to see you — what do you need?',
  "Hi! What's on your mind?",
  "Hey there — what's the plan?",
];

function isGreeting(userMessage) {
  return GREETING_RE.test((userMessage || '').trim());
}

let lastReply = null;
function pickGreetingText() {
  if (GREETING_REPLIES.length === 1) return GREETING_REPLIES[0];
  let reply = GREETING_REPLIES[Math.floor(Math.random() * GREETING_REPLIES.length)];
  // One retry to avoid an immediate repeat — same small-pool trick
  // fillerPhrases.js uses, good enough without a full shuffle-bag.
  if (reply === lastReply) reply = GREETING_REPLIES[Math.floor(Math.random() * GREETING_REPLIES.length)];
  lastReply = reply;
  return reply;
}

const cache = new Map(); // text -> Buffer
const inFlight = new Map(); // text -> Promise<Buffer>, so concurrent first-callers share one synthesis

async function synthesizeAndCache(text) {
  const pieces = [];
  for await (const buf of synthesizeChunkStream(text, { modelId: config.aida.voice.modelId })) pieces.push(buf);
  const audio = Buffer.concat(pieces);
  cache.set(text, audio);
  return audio;
}

/** Returns { audio: Buffer, mimeType } for one specific reply's text — instant once cached. */
async function getGreetingAudio(text) {
  let audio = cache.get(text);
  if (!audio) {
    let pending = inFlight.get(text);
    if (!pending) {
      pending = synthesizeAndCache(text).finally(() => inFlight.delete(text));
      inFlight.set(text, pending);
    }
    audio = await pending;
  }
  return { audio, mimeType: mimeTypeForFormat(config.aida.voice.outputFormat) };
}

/**
 * Synthesizes every reply once, up front — same reasoning as
 * fillerPhrases.js's warmFillerCache: the whole point of this fast path is
 * an instant reply, so the very first real "hi" shouldn't pay a live
 * ElevenLabs round trip. Best-effort; a failed warm-up here just means that
 * one phrase falls back to lazy synthesis on first real use.
 */
async function warmGreetingCache() {
  if (!config.aida.voice.enabled) return;
  const results = await Promise.allSettled(GREETING_REPLIES.map((text) => getGreetingAudio(text)));
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) {
    console.error(`[aida-voice] greeting cache warm-up: ${failed.length}/${GREETING_REPLIES.length} replies failed to pre-synthesize (will fall back to lazy synthesis on first use):`, failed[0].reason?.message);
  } else {
    console.log(`[aida-voice] greeting cache warmed: ${GREETING_REPLIES.length} replies pre-synthesized.`);
  }
}

module.exports = { isGreeting, pickGreetingText, getGreetingAudio, warmGreetingCache, GREETING_REPLIES };
