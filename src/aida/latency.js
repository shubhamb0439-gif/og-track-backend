const config = require('../config');

/**
 * Per-turn latency instrumentation. One timer per conversational turn,
 * marking the timestamps called out in docs/AIDA_VOICE_UPGRADE.md (t0..t7)
 * relative to when the turn started, then emitting one structured
 * "AIDA_LATENCY" line summarizing it — cheap enough to always run.
 *
 * Verbose per-event lines (TURN_START, LLM_FIRST_CHUNK, ...) are additionally
 * emitted only when AIDA_DEBUG_LATENCY=true, per the observability spec —
 * never logs API keys, tokens, or conversation content, only timings/ids.
 */
function createTurnTimer(turnId, meta = {}) {
  const t0 = Date.now();
  const marks = {};

  function mark(name) {
    if (!(name in marks)) marks[name] = Date.now() - t0;
    if (config.aida.debugLatency) {
      console.log(`[aida-latency] ${name}`, JSON.stringify({ turnId, ms: marks[name], ...meta }));
    }
    return marks[name];
  }

  function elapsedSince(name) {
    return name in marks ? Date.now() - t0 - marks[name] : null;
  }

  function summary() {
    return {
      turnId,
      ...meta,
      stt_ms: marks.sttDone != null ? marks.sttDone - (marks.sttStart || 0) : undefined,
      llm_first_chunk_ms: marks.llmFirstChunk,
      llm_total_ms: marks.llmDone,
      tts_first_chunk_sent_ms: marks.ttsFirstChunkSent,
      tts_first_audio_ms: marks.ttsFirstAudio,
      end_to_end_first_audio_ms: marks.firstAudioDelivered,
      total_response_ms: marks.llmDone,
      total_audio_ms: marks.audioDone,
      total_turn_ms: Date.now() - t0,
    };
  }

  function logSummary() {
    console.log('AIDA_LATENCY', JSON.stringify(summary()));
  }

  return { mark, elapsedSince, summary, logSummary };
}

module.exports = { createTurnTimer };
