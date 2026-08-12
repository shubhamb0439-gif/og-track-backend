const config = require('../../config');

class SpeechToTextError extends Error {}

/**
 * Transcribes one recorded audio clip via OpenAI's Whisper API. Used by
 * POST /aida/voice-input (src/routes/aida.js) — the resulting transcript is
 * then handed to the exact same runTurn() reply-generation logic POST /chat
 * already uses, so this file's only job is audio bytes in, text out.
 */
async function transcribeAudio(buffer, { filename = 'audio.webm', mimeType = 'audio/webm' } = {}) {
  const stt = config.aida.speechToText;
  if (!stt.enabled) {
    throw new SpeechToTextError('Speech-to-text is not configured on this server (missing OPENAI_API_KEY).');
  }

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType }), filename);
  form.append('model', stt.model);

  let res;
  try {
    res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${stt.apiKey}` },
      body: form,
    });
  } catch (e) {
    throw new SpeechToTextError(`Whisper request failed: ${e.message}`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new SpeechToTextError(`Whisper transcription failed (${res.status}): ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  return (data.text || '').trim();
}

module.exports = { transcribeAudio, SpeechToTextError };
