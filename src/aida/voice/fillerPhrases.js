const { synthesizeChunkStream, mimeTypeForFormat } = require('./elevenLabsClient');
const config = require('../../config');

/**
 * A small pool of short "thinking" lines — randomized so it's not the exact
 * same line every time, but small and fixed so each one can be synthesized
 * ONCE and reused forever (a live ElevenLabs call here would defeat the
 * entire point: masking latency, not adding more of it).
 */
const PHRASES = [
  'Hmm, let me check on that.',
  'One moment.',
  'Let me see.',
  'Give me just a second.',
  'Okay, let me look into that.',
];

const cache = new Map(); // phrase -> Buffer
const inFlight = new Map(); // phrase -> Promise<Buffer>, so concurrent first-callers share one synthesis

async function synthesizeAndCache(phrase) {
  const pieces = [];
  for await (const buf of synthesizeChunkStream(phrase)) pieces.push(buf);
  const audio = Buffer.concat(pieces);
  cache.set(phrase, audio);
  return audio;
}

/** Returns { audio: Buffer, mimeType } for a random filler phrase — cached after the first call. */
async function getRandomFillerAudio() {
  const phrase = PHRASES[Math.floor(Math.random() * PHRASES.length)];
  let audio = cache.get(phrase);
  if (!audio) {
    let pending = inFlight.get(phrase);
    if (!pending) {
      pending = synthesizeAndCache(phrase).finally(() => inFlight.delete(phrase));
      inFlight.set(phrase, pending);
    }
    audio = await pending;
  }
  return { audio, mimeType: mimeTypeForFormat(config.aida.voice.outputFormat) };
}

module.exports = { getRandomFillerAudio, PHRASES };
