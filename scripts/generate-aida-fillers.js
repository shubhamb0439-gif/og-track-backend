/**
 * Generates the static AIDA filler audio files served from
 * public/aida-fillers/ (see docs/FRONTEND_PROMPTS.md prompt 7 for why these
 * exist — instant, zero-latency LOCAL filler playback on the frontend,
 * separate from the server-emitted socket filler).
 *
 * Re-run this whenever FILLERS_BY_CATEGORY (src/aida/voice/fillerPhrases.js)
 * or ELEVENLABS_FILLER_MODEL_ID changes. Requires ELEVENLABS_API_KEY/
 * ELEVENLABS_VOICE_ID configured (.env) — makes real ElevenLabs API calls.
 *
 * Run from the backend folder:
 *   node scripts/generate-aida-fillers.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { synthesizeChunkStream } = require('../src/aida/voice/elevenLabsClient');
const { isExpressiveTagModel } = require('../src/aida/voice/speechDirectiveAdapter');
const { FILLERS_BY_CATEGORY, stripBracketTags } = require('../src/aida/voice/fillerPhrases');
const config = require('../src/config');

const OUT_DIR = path.join(__dirname, '..', 'public', 'aida-fillers');
const modelId = config.aida.voice.fillerModelId;
const useTags = isExpressiveTagModel(modelId);

async function synthesize(text) {
  const pieces = [];
  for await (const buf of synthesizeChunkStream(text, { modelId })) pieces.push(buf);
  return Buffer.concat(pieces);
}

async function main() {
  if (!config.aida.voice.enabled) {
    console.error('ElevenLabs is not configured (ELEVENLABS_API_KEY/ELEVENLABS_VOICE_ID) — nothing to generate.');
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const manifest = {};
  const concurrency = Math.max(1, config.aida.voice.maxConcurrentChunks);

  for (const [category, phrases] of Object.entries(FILLERS_BY_CATEGORY)) {
    const dir = path.join(OUT_DIR, category);
    fs.mkdirSync(dir, { recursive: true });
    const results = new Array(phrases.length);

    let next = 0;
    async function worker() {
      while (next < phrases.length) {
        const i = next++;
        const phrase = phrases[i];
        const text = useTags ? phrase : stripBracketTags(phrase);
        console.log(`[${category}][${i}] ${text}`);
        const audio = await synthesize(text);
        const filename = `${i}.mp3`;
        fs.writeFileSync(path.join(dir, filename), audio);
        results[i] = { file: `${category}/${filename}`, text: phrase, bytes: audio.length };
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, phrases.length) }, worker));
    manifest[category] = results;
  }

  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nDone — wrote ${OUT_DIR}`);
}

main().catch((e) => { console.error('Failed:', e); process.exit(1); });
