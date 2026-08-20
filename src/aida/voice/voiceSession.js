const config = require('../../config');
const { splitIntoSpeechChunks, createStreamingChunker } = require('./textChunker');
const { synthesizeChunkStream, mimeTypeForFormat } = require('./elevenLabsClient');
const { getFillerAudio, getRandomFillerAudio, canPlayFiller, markFillerPlayed } = require('./fillerPhrases');
const { cleanForSpeech } = require('./textCleaner');
const { adaptDirective } = require('./speechDirectiveAdapter');
const { safeDirective } = require('../responseDirector');

/** Drains one chunk's streamed audio into a single Buffer for that sentence. */
async function synthesizeChunkFully(text, opts = {}) {
  const pieces = [];
  for await (const buf of synthesizeChunkStream(text, opts)) pieces.push(buf);
  return Buffer.concat(pieces);
}

// ── Barge-in / cancellation ───────────────────────────────────────────────
// A turn is cancelled by a client-side interrupt (POST /aida/voice-cancel).
// Tracked here rather than per-request state since speech generation runs
// fire-and-forget, well past the point where the original HTTP request
// (or the POST /voice-cancel request) has already returned.
//
// turnControllers holds ONE AbortController per in-flight turn, shared by
// BOTH the LLM stream (src/aida/engine.js passes its .signal straight into
// the OpenAI/Anthropic SDK call) and every ElevenLabs fetch for that turn —
// so a single cancelTurn() call now genuinely stops generation on both
// sides, not just further audio emission (the previous, documented
// limitation: "cannot abort in-flight runTurn()").
const cancelledTurns = new Map(); // turnId -> cancelledAtMs
const turnControllers = new Map(); // turnId -> { controller, createdAt }

function createTurnController(turnId) {
  const controller = new AbortController();
  turnControllers.set(turnId, { controller, createdAt: Date.now() });
  return controller;
}

function getTurnSignal(turnId) {
  return turnControllers.get(turnId)?.controller.signal;
}

function cancelTurn(turnId) {
  cancelledTurns.set(turnId, Date.now());
  const entry = turnControllers.get(turnId);
  if (entry) {
    try { entry.controller.abort(); } catch { /* already aborted */ }
  }
}

function isCancelled(turnId) {
  return cancelledTurns.has(turnId);
}

function releaseTurn(turnId) {
  cancelledTurns.delete(turnId);
  turnControllers.delete(turnId);
}

let sweepTimer = null;
function startCancelSweeper() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [id, ts] of cancelledTurns) if (ts < cutoff) cancelledTurns.delete(id);
    // Defense in depth: every turn's controller should already be released
    // via speakReply's/createStreamingSpeaker's own finally/markDone as soon
    // as it finishes — this only catches a turn that somehow never reached
    // that point (e.g. a bug, or a client that vanished mid-stream), so a
    // long-running server never accumulates abandoned AbortControllers.
    for (const [id, entry] of turnControllers) if (entry.createdAt < cutoff) turnControllers.delete(id);
  }, 60 * 1000);
  sweepTimer.unref?.();
}
startCancelSweeper();

/**
 * Plays one cached filler line immediately — no live synthesis call in the
 * critical path (fillerPhrases.js caches each phrase after its first use).
 * `category` comes from the response director; falls back to 'thinking' if
 * omitted/invalid. Gated by both the global AIDA_FILLER_ENABLED flag and a
 * per-session cooldown (AIDA_FILLER_COOLDOWN_MS) so AIDA doesn't say
 * "hmm, let me check" on every single turn.
 */
async function playFiller({ io, room, chunkEvent, turnId, category, sessionKey }) {
  try {
    if (!io || !room || isCancelled(turnId)) return;
    const key = sessionKey || chunkEvent;
    if (!canPlayFiller(key)) return;
    const { audio, mimeType } = await getFillerAudio(category);
    if (isCancelled(turnId)) return; // interrupted while the filler itself was loading
    markFillerPlayed(key);
    io.to(room).emit(chunkEvent, {
      turnId,
      seq: -1,
      isFinal: false,
      filler: true,
      audioBase64: audio.toString('base64'),
      mimeType,
    });
  } catch (e) {
    // Best-effort only — the real reply's own pipeline still runs regardless
    // of whether the filler played, so this is never worth surfacing as
    // aida:voice-error.
    console.error('[aida-voice] playFiller failed:', e);
  }
}

/**
 * Speaks one AIDA reply: splits it into sentence-chunks, synthesizes them
 * with bounded concurrency, but emits to the client strictly in original
 * order (a later sentence finishing its network round trip first must never
 * play out of turn). This is the LEGACY (non-streaming) path — only used
 * when AIDA_STREAMING_ENABLED=false, or the full reply is already available
 * up front. Called fire-and-forget, never awaited by the HTTP response, so
 * every failure path here must be caught internally rather than becoming an
 * unhandled rejection.
 *
 * `room`/`chunkEvent`/`errorEvent` are decided by the caller (mirrors
 * src/aida/jobs/jobRunner.js's roomForJob — this file stays agnostic about
 * tenant vs. masteradmin room-naming conventions).
 */
async function speakReply({ io, room, chunkEvent, errorEvent, turnId, text }) {
  try {
    const voice = config.aida.voice;
    if (!voice.enabled || !io || !room || !text || isCancelled(turnId)) return;

    const cleaned = cleanForSpeech(text);
    const truncated = cleaned.length > voice.maxCharsPerReply ? cleaned.slice(0, voice.maxCharsPerReply) : cleaned;
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
      if (isCancelled(turnId)) break; // interrupted before this chunk's synthesis even started awaiting

      const result = await pending.shift();
      if (isCancelled(turnId)) break; // interrupted while that chunk was synthesizing — don't play it late

      if (nextToStart < chunks.length && !isCancelled(turnId)) startOne(); // keep the pipeline full, unless already interrupted

      if (result && result.__error) {
        // Stop the whole reply on first failure rather than risk playing
        // later chunks after a silent gap — text was already delivered via
        // the normal chat response regardless, so nothing is lost.
        io.to(room).emit(errorEvent, { turnId, message: result.__error.message || 'Voice synthesis failed.' });
        break;
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
  } finally {
    releaseTurn(turnId);
  }
}

/**
 * The streaming counterpart to speakReply: instead of taking a complete
 * reply string, it exposes `pushText(delta)` to be called for every LLM
 * text delta as it streams in (see src/aida/providers/openai.js), and
 * `finish()` once generation is done. Sentence-sized chunks are synthesized
 * (bounded concurrency, same as the legacy path) and emitted the instant
 * each one is ready — the whole point being that chunk 1's audio can start
 * playing while the LLM is still generating chunk 4's text.
 *
 * Ordering/back-pressure: chunks are assigned an increasing seq as the
 * incremental chunker discovers sentence boundaries; synthesis results are
 * buffered by seq and flushed to the socket strictly in order, exactly like
 * the legacy path's `pending` array — just event-driven instead of a
 * length-bounded for-loop, since the total chunk count isn't known until
 * `finish()` has actually run.
 *
 * Wire format emitted to the client is IDENTICAL to speakReply's
 * (`{ turnId, seq, isFinal, audioBase64, mimeType }`), so nothing on the
 * frontend needs to change to consume streamed vs. batch audio.
 */
function createStreamingSpeaker({ io, room, chunkEvent, errorEvent, turnId, directive, timer, onFirstChunkReady }) {
  const voice = config.aida.voice;
  const mimeType = mimeTypeForFormat(voice.outputFormat);
  const concurrency = Math.max(1, voice.maxConcurrentChunks);
  const signal = getTurnSignal(turnId);
  const adapted = adaptDirective(safeDirective(directive), { modelId: voice.modelId, baseSpeed: voice.speed });

  const canSpeak = voice.enabled && io && room;
  let enqueuedCount = 0;
  let emittedCount = 0;
  let activeCount = 0;
  let totalChunks = null; // set once finish() has run and no more chunks will be enqueued
  let done = false;
  let firstChunkNotified = false;
  const results = new Map(); // seq -> { buffer } | { error }
  const pendingStart = []; // { seq, text } waiting for a concurrency slot
  let resolveDone;
  const donePromise = new Promise((resolve) => { resolveDone = resolve; });

  function markDone() {
    if (done) return;
    done = true;
    timer?.mark('audioDone');
    releaseTurn(turnId);
    resolveDone();
  }

  function tryEmit() {
    while (results.has(emittedCount)) {
      if (isCancelled(turnId)) { results.clear(); markDone(); return; }
      const seq = emittedCount;

      // Don't emit the tail chunk yet if it's not yet KNOWN to be the last
      // one (totalChunks isn't sealed) — TTS regularly finishes faster than
      // the LLM signals it's done (the char-budget cutoff is one common
      // case, but not the only one), and once a chunk has gone out with
      // isFinal:false there is no way to correct that afterward. Holding it
      // back this one beat means it gets (re)checked the instant sealTotal()
      // runs or another chunk gets enqueued proving this one wasn't last —
      // in the common case that's next-to-instant, since finish() is called
      // immediately after the LLM promise resolves either way.
      if (totalChunks === null && seq === enqueuedCount - 1) return;

      const result = results.get(seq);
      results.delete(seq);
      const isFinal = totalChunks !== null && seq === totalChunks - 1;

      if (result.error) {
        if (result.error.name !== 'AbortError') {
          io.to(room).emit(errorEvent, { turnId, message: result.error.message || 'Voice synthesis failed.' });
        }
        markDone();
        return;
      }

      if (seq === 0) timer?.mark('firstAudioDelivered');
      io.to(room).emit(chunkEvent, { turnId, seq, isFinal, audioBase64: result.buffer.toString('base64'), mimeType });
      emittedCount++;
      if (isFinal) { markDone(); return; }
    }
  }

  /** Locks in the true total once no more chunks will ever be enqueued — see finish()/pushText's budget cutoff, the two places this fires from. */
  function sealTotal() {
    if (totalChunks !== null) return;
    totalChunks = enqueuedCount;
    if (totalChunks === 0) { markDone(); return; }
    tryEmit();
  }

  function tryStartNext() {
    while (!isCancelled(turnId) && activeCount < concurrency && pendingStart.length) {
      const { seq, text } = pendingStart.shift();
      startSynthesis(seq, text);
    }
  }

  function startSynthesis(seq, text) {
    activeCount++;
    if (seq === 0) timer?.mark('ttsFirstChunkSent');
    synthesizeChunkFully(text, { signal, stability: adapted.voiceSettings.stability, style: adapted.voiceSettings.style, speed: adapted.voiceSettings.speed })
      .then((buf) => {
        if (seq === 0) timer?.mark('ttsFirstAudio');
        results.set(seq, { buffer: buf });
      })
      .catch((e) => { results.set(seq, { error: e }); })
      .finally(() => {
        activeCount--;
        tryEmit();
        tryStartNext();
      });
  }

  function enqueueChunk(rawText) {
    if (!canSpeak || isCancelled(turnId)) return;
    const seq = enqueuedCount++;
    const text = seq === 0 ? `${adapted.prefixText}${rawText}` : rawText;

    if (!firstChunkNotified) {
      firstChunkNotified = true;
      try { onFirstChunkReady?.(); } catch {}
    }

    if (activeCount < concurrency) startSynthesis(seq, text);
    else pendingStart.push({ seq, text });
  }

  const chunker = createStreamingChunker((chunkText) => enqueueChunk(cleanForSpeech(chunkText)));

  // Same cost guardrail the legacy path always had (voice.maxCharsPerReply) —
  // the streaming path didn't enforce this at all, which for a genuinely
  // long reply meant an unbounded number of TTS chunks (full text is always
  // still shown either way; only speech is capped).
  let charsPushed = 0;
  let budgetExhausted = false;

  function pushText(delta) {
    if (!canSpeak || !delta || isCancelled(turnId) || budgetExhausted) return;
    timer?.mark('llmFirstChunk');
    charsPushed += delta.length;
    chunker.push(delta);
    if (charsPushed >= voice.maxCharsPerReply) {
      budgetExhausted = true;
      chunker.flush(); // enqueue whatever's buffered as a clean final chunk rather than cutting mid-sentence
      sealTotal(); // budget cutoff means no more chunks are coming, well before the LLM itself finishes — see sealTotal/tryEmit
    }
  }

  function finish() {
    if (!canSpeak) { markDone(); return donePromise; }
    if (!isCancelled(turnId)) chunker.flush();
    sealTotal();
    tryStartNext();
    return donePromise;
  }

  return { pushText, finish };
}

module.exports = {
  speakReply,
  createStreamingSpeaker,
  playFiller,
  cancelTurn,
  isCancelled,
  createTurnController,
  getTurnSignal,
  releaseTurn,
  getRandomFillerAudio,
};
