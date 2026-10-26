const config = require('../../config');

const BASE_URL = 'https://api.openai.com/v1/audio/speech';

class OpenAITtsError extends Error {}

/**
 * Same timeout-combining shape as elevenLabsClient.js's withTimeout (the
 * file this replaces, 2026-10-26 — see config.js's voice block for why) —
 * a chunk's fetch must always have SOME signal that eventually fires, so a
 * stalled connection (no error, no data, ever) can't hang a turn forever.
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
  const map = { mp3: 'audio/mpeg', opus: 'audio/opus', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', pcm: 'audio/pcm' };
  return map[outputFormat] || 'application/octet-stream';
}

/**
 * Streams synthesized audio for ONE chunk of text as an async iterable of
 * Buffers — same interface as elevenLabsClient.js's synthesizeChunkStream,
 * so voiceSession.js/fillerPhrases.js/greetingReplies.js needed no changes
 * beyond their one require() line. `opts.stability`/`opts.style` (ElevenLabs-
 * only concepts, no OpenAI equivalent) are accepted but silently ignored
 * rather than erroring, since callers still compute and pass them
 * (speechDirectiveAdapter.js's emotion-to-voice-settings mapping is untouched
 * — only `speed` out of that mapping actually does anything here now).
 */
async function* synthesizeChunkStream(text, opts = {}) {
  const voice = config.aida.voice;
  const model = opts.modelId || voice.modelId;
  const outputFormat = opts.outputFormat || voice.outputFormat;
  const speed = opts.speed !== undefined ? opts.speed : voice.speed;
  const timeoutMs = opts.timeoutMs || voice.ttsTimeoutMs;
  const { signal, isTimeout, cleanup } = withTimeout(opts.signal, timeoutMs);

  try {
    let res;
    try {
      res = await fetch(BASE_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${voice.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, voice: voice.voiceName, input: text, response_format: outputFormat, speed }),
        signal,
      });
    } catch (e) {
      if (isTimeout()) throw new OpenAITtsError(`OpenAI TTS request timed out after ${timeoutMs}ms waiting for a response.`);
      if (e.name === 'AbortError') throw e; // user interruption — propagate as-is, voiceSession.js treats it as a clean stop, not a failure
      throw new OpenAITtsError(`OpenAI TTS request failed: ${e.message}`);
    }

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new OpenAITtsError(`OpenAI TTS failed (${res.status}): ${detail.slice(0, 300)}`);
    }

    const reader = res.body.getReader();
    try {
      while (true) {
        let value, done;
        try {
          ({ value, done } = await reader.read());
        } catch (e) {
          if (isTimeout()) throw new OpenAITtsError(`OpenAI TTS response stalled mid-stream (timed out after ${timeoutMs}ms with no new data).`);
          if (e.name === 'AbortError') throw e;
          throw new OpenAITtsError(`OpenAI TTS stream read failed: ${e.message}`);
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

module.exports = { synthesizeChunkStream, mimeTypeForFormat, OpenAITtsError };
