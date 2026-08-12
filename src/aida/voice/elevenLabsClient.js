const config = require('../../config');

const BASE_URL = 'https://api.elevenlabs.io/v1/text-to-speech';

class ElevenLabsError extends Error {}

function mimeTypeForFormat(outputFormat) {
  if (outputFormat.startsWith('mp3')) return 'audio/mpeg';
  if (outputFormat.startsWith('pcm')) return 'audio/pcm';
  if (outputFormat.startsWith('ulaw')) return 'audio/basic';
  return 'application/octet-stream';
}

/**
 * Streams synthesized audio for ONE chunk of text as an async iterable of
 * Buffers. This file only knows how to talk to ElevenLabs — voiceSession.js
 * owns calling this once per sentence-chunk, ordering, and relaying bytes
 * onward over socket.io.
 */
async function* synthesizeChunkStream(text, opts = {}) {
  const voice = config.aida.voice;
  const voiceId = opts.voiceId || voice.voiceId;
  const modelId = opts.modelId || voice.modelId;
  const outputFormat = opts.outputFormat || voice.outputFormat;

  const url = `${BASE_URL}/${encodeURIComponent(voiceId)}/stream?output_format=${encodeURIComponent(outputFormat)}`;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': voice.apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({ text, model_id: modelId }),
    });
  } catch (e) {
    throw new ElevenLabsError(`ElevenLabs request failed: ${e.message}`);
  }

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new ElevenLabsError(`ElevenLabs TTS failed (${res.status}): ${detail.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) yield Buffer.from(value);
    }
  } finally {
    reader.releaseLock?.();
  }
}

module.exports = { synthesizeChunkStream, mimeTypeForFormat, ElevenLabsError };
