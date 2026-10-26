const { synthesizeChunkStream, mimeTypeForFormat } = require('./elevenLabsClient');
const { isExpressiveTagModel } = require('./speechDirectiveAdapter');
const config = require('../../config');

/**
 * Filler library — short cached lines AIDA can play instantly (no live
 * synthesis in the critical path; each phrase is synthesized once on first
 * use — or at server startup via warmFillerCache() — and reused forever)
 * while a real reply is still being generated. Organized by category so the
 * response director (responseDirector.js) can pick one that matches the
 * moment, with a few variants per category so it isn't the exact same line
 * every time.
 *
 * Written with natural hesitation (elongated "Ummmmm", trailing "...") and,
 * where it fits, an ElevenLabs v3 bracket audio tag ([sighs], [gasps], ...)
 * — deliberately sparing, at most one per phrase, never on every phrase in a
 * category (see the original brief: don't make this sound like voice
 * acting). These phrases are synthesized with config.aida.voice.fillerModelId,
 * NOT the realtime model used for the live reply — fillers are pre-cached,
 * not generated live, so this is the one place a slower/more expressive
 * model costs nothing in real-time latency (measured live: eleven_v3 took
 * ~1.7s vs. ~0.3s for the realtime model — fine for a one-time warm-up,
 * unacceptable for a live reply chunk). If fillerModelId is ever pointed at
 * a non-tag-capable (realtime) model, stripBracketTags() below removes the
 * tags before synthesis so they're never read aloud as literal text.
 */
const FILLERS_BY_CATEGORY = {
  thinking: [
    '[sighs] Ummmmm, let me check on that...',
    'Hmmm... one second...',
    'Okay, let me look into that...',
    'Give me just a moment...',
    "Let's see here...",
    'Hold on, let me pull that up...',
    'Okay, hang on a sec...',
    'Right, let me think...',
    'Hmm... give me a beat...',
    'One sec, let me check...',
    '[sighs] Okay, let\'s see...',
    'Alright, let me dig into that...',
    'Umm, okay, one moment...',
    'Let me take a look...',
    'Hmmm, checking on that now...',
    "Okay... let me see what I've got...",
    'Give me a second here...',
    'Right, one moment...',
    "Hmm, let's find out...",
    'Okay, pulling that up now...',
    'Umm... let me think about that...',
    'Hold on a moment...',
    "Let's see what's going on...",
    'Okay, give me a sec...',
    'Hmmm... let me look...',
    'Alright, one second...',
    '[exhales] Okay, let\'s check...',
    'Right, let me see...',
    'Umm, hang on...',
    'Okay, checking now...',
    'Let me take a quick look...',
    'Hmm, one moment please...',
    'Alright, give me a second...',
    'Okay so, let me check...',
    'Hold on, checking that now...',
    "Umm, let's see...",
    'Right, hang on a second...',
    'Okay, let me have a look...',
    'Hmmm, thinking...',
    'One moment, please...',
    'Let me get that for you...',
    'Okay, just a sec...',
    "Hmm, let's dig in...",
    'Alright, checking on it...',
    'Umm, one second, please...',
    "Okay, let's take a look...",
    'Right, give me a moment...',
    "Hmmm... okay, let's see...",
    'Hold on, let me see...',
    'Umm, checking that for you...',
    'Okay... one sec...',
    '[sighs] Let me look into that...',
    "Alright, let's see what we've got...",
    'Hmm, give me just a sec...',
    'Okay, let me pull it up...',
  ],
  acknowledgement: [
    'Mmhm, got it.',
    "Okay, I'm with you.",
    'Right, that makes sense.',
    'Ahh, okay.',
  ],
  surprise: [
    '[gasps] Oh!',
    'Huh, interesting...',
    'Wait, really?',
  ],
  amusement: [
    '[laughs softly] Okay, that is fair.',
    'Heh, alright, you got me.',
    'Ha, fair enough.',
  ],
  empathy: [
    '[sighs] Yeah, I hear you.',
    "Okay, let's sort this out.",
    'Understood, one second.',
  ],
};

const ALL_CATEGORIES = Object.keys(FILLERS_BY_CATEGORY);

function stripBracketTags(text) {
  return text.replace(/\[[^\]]+\]\s*/g, '');
}

function fillerModelId() {
  return config.aida.voice.fillerModelId || config.aida.voice.modelId;
}

function textForSynthesis(phrase) {
  return isExpressiveTagModel(fillerModelId()) ? phrase : stripBracketTags(phrase);
}

const cache = new Map(); // phrase -> Buffer
const inFlight = new Map(); // phrase -> Promise<Buffer>, so concurrent first-callers share one synthesis
const lastPhraseByCategory = new Map(); // category -> last phrase used, so it isn't repeated back-to-back
const lastFillerAtByKey = new Map(); // sessionKey -> timestamp, for the cooldown

async function synthesizeAndCache(phrase) {
  const pieces = [];
  for await (const buf of synthesizeChunkStream(textForSynthesis(phrase), { modelId: fillerModelId() })) pieces.push(buf);
  const audio = Buffer.concat(pieces);
  cache.set(phrase, audio);
  return audio;
}

function pickPhrase(category) {
  const list = FILLERS_BY_CATEGORY[category] || FILLERS_BY_CATEGORY.thinking;
  if (list.length === 1) return list[0];
  const last = lastPhraseByCategory.get(category);
  let phrase = list[Math.floor(Math.random() * list.length)];
  // One retry to avoid an immediate repeat — good enough for a small pool,
  // no need for a full shuffle-bag.
  if (phrase === last) phrase = list[Math.floor(Math.random() * list.length)];
  lastPhraseByCategory.set(category, phrase);
  return phrase;
}

async function synthesizeFiller(phrase) {
  let audio = cache.get(phrase);
  if (!audio) {
    let pending = inFlight.get(phrase);
    if (!pending) {
      pending = synthesizeAndCache(phrase).finally(() => inFlight.delete(phrase));
      inFlight.set(phrase, pending);
    }
    audio = await pending;
  }
  return { audio, mimeType: mimeTypeForFormat(config.aida.voice.outputFormat), phrase };
}

/** Returns { audio: Buffer, mimeType, phrase } for a random filler in the given category (default 'thinking'). */
async function getFillerAudio(category) {
  const phrase = pickPhrase(ALL_CATEGORIES.includes(category) ? category : 'thinking');
  return synthesizeFiller(phrase);
}

/** Back-compat name used by the legacy (non-directive-aware) call sites. */
async function getRandomFillerAudio() {
  return getFillerAudio('thinking');
}

/**
 * Cooldown gate — true if it's been at least fillerCooldownMs since the last
 * filler for this session key (e.g. the per-user voice-chunk event name).
 * Does NOT itself record the play; call markFillerPlayed once it actually plays.
 */
function canPlayFiller(sessionKey) {
  if (!config.aida.voice.fillerEnabled) return false;
  const last = lastFillerAtByKey.get(sessionKey);
  if (!last) return true;
  return Date.now() - last >= config.aida.voice.fillerCooldownMs;
}

function markFillerPlayed(sessionKey) {
  lastFillerAtByKey.set(sessionKey, Date.now());
}

/**
 * Synthesizes every phrase in every category once, up front, so the very
 * first filler any real user ever triggers doesn't pay a live ElevenLabs
 * round trip on top of the fillerDelayMs threshold (measured live: a
 * cold/uncached phrase added ~500-1200ms on top of the timer firing, which
 * defeats the entire point of a filler — masking latency, not adding more of
 * it). Call once at server startup; best-effort (a failed warm-up here just
 * means that one phrase falls back to lazy synthesis on first real use,
 * exactly like before this existed — never something to crash startup over).
 */
async function warmFillerCache() {
  if (!config.aida.voice.enabled) return;
  const allPhrases = Object.values(FILLERS_BY_CATEGORY).flat();
  // Bounded concurrency, same cap as normal chunk synthesis
  // (maxConcurrentChunks) — firing all ~18 phrases at once blew straight
  // through ElevenLabs' real concurrent-request limit in testing (8/18
  // failed), the exact same reason turn playback is already bounded.
  const concurrency = Math.max(1, config.aida.voice.maxConcurrentChunks);
  const results = [];
  let next = 0;
  async function worker() {
    while (next < allPhrases.length) {
      const phrase = allPhrases[next++];
      try {
        await synthesizeFiller(phrase);
        results.push({ status: 'fulfilled' });
      } catch (e) {
        results.push({ status: 'rejected', reason: e });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, allPhrases.length) }, worker));
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) {
    console.error(`[aida-voice] filler cache warm-up: ${failed.length}/${allPhrases.length} phrases failed to pre-synthesize (will fall back to lazy synthesis on first use):`, failed[0].reason?.message);
  } else {
    console.log(`[aida-voice] filler cache warmed: ${allPhrases.length} phrases pre-synthesized.`);
  }
}

module.exports = {
  getRandomFillerAudio,
  getFillerAudio,
  canPlayFiller,
  markFillerPlayed,
  warmFillerCache,
  FILLERS_BY_CATEGORY,
  stripBracketTags,
};
