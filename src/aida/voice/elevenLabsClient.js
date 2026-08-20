const config = require('../../config');

const BASE_URL = 'https://api.elevenlabs.io/v1/text-to-speech';

class ElevenLabsError extends Error {}

/**
 * Combines the turn's own AbortSignal (user interruption — see
 * voiceSession.js's shared per-turn AbortController) with a hard timeout, so
 * a chunk can never wait forever on ElevenLabs: found live in production
 * testing that a stalled connection (headers/body just never arrive — not a
 * clean error, no response at all) left a chunk's promise neither resolving
 * nor rejecting, which meant the whole turn hung silently — no audio, no
 * error event, no completion signal, indefinitely. Every fetch below now
 * always has SOME signal that eventually fires.
 */
function withTimeout(externalSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    isTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    },
  };
}

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
  const speed = opts.speed !== undefined ? opts.speed : voice.speed;
  // stability/style are optional expressiveness tuning from the response
  // director (src/aida/voice/speechDirectiveAdapter.js) — omitted entirely
  // (rather than defaulted here) when the caller doesn't pass them, so the
  // legacy filler/fallback call sites keep ElevenLabs' own defaults.
  const voiceSettings = { speed };
  if (opts.stability !== undefined) voiceSettings.stability = opts.stability;
  if (opts.style !== undefined) voiceSettings.style = opts.style;

  const url = `${BASE_URL}/${encodeURIComponent(voiceId)}/stream?output_format=${encodeURIComponent(outputFormat)}`;
  const timeoutMs = opts.timeoutMs || voice.ttsTimeoutMs;
  const { signal, isTimeout, cleanup } = withTimeout(opts.signal, timeoutMs);

  try {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': voice.apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({ text, model_id: modelId, voice_settings: voiceSettings }),
        signal,
      });
    } catch (e) {
      if (isTimeout()) throw new ElevenLabsError(`ElevenLabs request timed out after ${timeoutMs}ms waiting for a response.`);
      if (e.name === 'AbortError') throw e; // user interruption — let it propagate as-is, voiceSession.js treats it as a clean stop, not a failure
      throw new ElevenLabsError(`ElevenLabs request failed: ${e.message}`);
    }

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new ElevenLabsError(`ElevenLabs TTS failed (${res.status}): ${detail.slice(0, 300)}`);
    }

    const reader = res.body.getReader();
    try {
      while (true) {
        let value, done;
        try {
          ({ value, done } = await reader.read());
        } catch (e) {
          if (isTimeout()) throw new ElevenLabsError(`ElevenLabs response stalled mid-stream (timed out after ${timeoutMs}ms with no new data).`);
          if (e.name === 'AbortError') throw e;
          throw new ElevenLabsError(`ElevenLabs stream read failed: ${e.message}`);
        }
        if (done) break;
        if (value) yield Buffer.from(value);
      }
    } finally {
      reader.releaseLock?.();
    }
  } finally {
    cleanup();
  }
}

module.exports = { synthesizeChunkStream, mimeTypeForFormat, ElevenLabsError };
