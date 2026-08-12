const config = require('../../config');
const { splitIntoSpeechChunks } = require('./textChunker');
const { synthesizeChunkStream, mimeTypeForFormat } = require('./elevenLabsClient');

/** Drains one chunk's streamed audio into a single Buffer for that sentence. */
async function synthesizeChunkFully(text) {
  const pieces = [];
  for await (const buf of synthesizeChunkStream(text)) pieces.push(buf);
  return Buffer.concat(pieces);
}

/**
 * Speaks one AIDA reply: splits it into sentence-chunks, synthesizes them
 * with bounded concurrency, but emits to the client strictly in original
 * order (a later sentence finishing its network round trip first must never
 * play out of turn). Called fire-and-forget from routes/aida.js — never
 * awaited by the HTTP response, so every failure path here must be caught
 * internally rather than becoming an unhandled rejection.
 *
 * `room`/`chunkEvent`/`errorEvent` are decided by the caller (mirrors
 * src/aida/jobs/jobRunner.js's roomForJob — this file stays agnostic about
 * tenant vs. masteradmin room-naming conventions).
 */
async function speakReply({ io, room, chunkEvent, errorEvent, turnId, text }) {
  try {
    const voice = config.aida.voice;
    if (!voice.enabled || !io || !room || !text) return;

    const truncated = text.length > voice.maxCharsPerReply ? text.slice(0, voice.maxCharsPerReply) : text;
    const chunks = splitIntoSpeechChunks(truncated);
    if (!chunks.length) return;

    const mimeType = mimeTypeForFormat(voice.outputFormat);
    const concurrency = Math.max(1, voice.maxConcurrentChunks);

    const pending = [];
    let nextToStart = 0;
    const startOne = () => {
      const idx = nextToStart++;
      pending.push(synthesizeChunkFully(chunks[idx]).catch((e) => ({ __error: e })));
    };
    while (pending.length < concurrency && nextToStart < chunks.length) startOne();

    for (let seq = 0; seq < chunks.length; seq++) {
      const result = await pending.shift();
      if (nextToStart < chunks.length) startOne(); // keep the pipeline full as we consume

      if (result && result.__error) {
        // Stop the whole reply on first failure rather than risk playing
        // later chunks after a silent gap — text was already delivered via
        // the normal chat response regardless, so nothing is lost.
        io.to(room).emit(errorEvent, { turnId, message: result.__error.message || 'Voice synthesis failed.' });
        return;
      }

      io.to(room).emit(chunkEvent, {
        turnId,
        seq,
        isFinal: seq === chunks.length - 1,
        audioBase64: result.toString('base64'),
        mimeType,
      });
    }
  } catch (e) {
    // Belt-and-suspenders: this function is called without being awaited,
    // so any bug here must never become an unhandled rejection.
    console.error('[aida-voice] speakReply failed:', e);
    try {
      if (io && room && errorEvent) io.to(room).emit(errorEvent, { turnId, message: 'Voice synthesis failed.' });
    } catch {}
  }
}

module.exports = { speakReply };
