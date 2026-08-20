/**
 * Splits an already-complete AIDA reply into speech-sized chunks, so
 * voiceSession.js can start synthesizing (and the browser start playing)
 * sentence 1 while sentence 2+ are still being generated — instead of
 * waiting for the whole reply to be turned into one long audio clip.
 * Pure, no I/O — the LLM/TTS calls live in the callers, not here.
 */

// Known limitation: this only guards single-word abbreviations ("Dr.", "vs.").
// Multi-letter-with-internal-dots ones ("e.g.", "i.e.") still get split at
// their second dot, producing an extra (harmless, just slightly clipped)
// chunk boundary — accepted rather than chased, same spirit as the other
// documented prosody tradeoffs for this feature.
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'eg', 'ie', 'approx', 'no', 'inc', 'ltd', 'co', 'fig',
]);

const MIN_CHUNK_CHARS = 12; // below this, a "sentence" (e.g. "Sure.") gets merged into a neighbor rather than its own TTS call
const MAX_CHUNK_CHARS = 200; // above this, fall back to splitting on commas/semicolons too

/** Sentence-boundary split, guarding against decimals ("3.14"), abbreviations ("e.g."), and numbered-list markers ("1."). */
function splitIntoSentences(text) {
  const sentences = [];
  let start = 0;
  const boundaryRe = /[.!?]+["')\]]?(?=\s|$)/g;
  let match;

  while ((match = boundaryRe.exec(text))) {
    const idx = match.index;
    const punctChar = text[idx];
    const boundaryEnd = idx + match[0].length;
    const charBefore = text[idx - 1];
    const nextChar = text.slice(boundaryEnd).trimStart()[0];

    const isDecimal = punctChar === '.' && charBefore && /\d/.test(charBefore) && nextChar && /\d/.test(nextChar);
    if (isDecimal) continue;

    if (punctChar === '.') {
      const wordBefore = text.slice(0, idx).match(/([A-Za-z]+)$/);
      if (wordBefore && ABBREVIATIONS.has(wordBefore[1].toLowerCase())) continue;

      const lineStart = text.lastIndexOf('\n', idx) + 1;
      const linePrefix = text.slice(lineStart, idx);
      if (/^\s*\d+$/.test(linePrefix)) continue; // "1." / "12." — a list marker, not a sentence end
    }

    sentences.push(text.slice(start, boundaryEnd).trim());
    start = boundaryEnd;
  }

  const rest = text.slice(start).trim();
  if (rest) sentences.push(rest);
  return sentences.filter(Boolean);
}

/** Glues consecutive pieces together until each merged chunk clears minChars. */
function mergeShortPieces(pieces, minChars) {
  const out = [];
  let buffer = '';
  for (const piece of pieces) {
    buffer = buffer ? `${buffer} ${piece}` : piece;
    if (buffer.length >= minChars) {
      out.push(buffer);
      buffer = '';
    }
  }
  if (buffer) {
    if (out.length) out[out.length - 1] += ' ' + buffer;
    else out.push(buffer);
  }
  return out;
}

/** Fallback for a single sentence that's still too long on its own — split on commas/semicolons instead. */
function splitLongPiece(piece, maxChars) {
  const rawParts = piece.split(/([,;])\s+/);
  const parts = [];
  for (const part of rawParts) {
    if (part === ',' || part === ';') {
      if (parts.length) parts[parts.length - 1] += part;
    } else if (part) {
      parts.push(part);
    }
  }

  const out = [];
  let buffer = '';
  for (const part of parts) {
    const candidate = buffer ? `${buffer} ${part}` : part;
    if (candidate.length > maxChars && buffer) {
      out.push(buffer);
      buffer = part;
    } else {
      buffer = candidate;
    }
  }
  if (buffer) out.push(buffer);
  return out;
}

function splitIntoSpeechChunks(text) {
  if (!text || !text.trim()) return [];
  // Blank-line paragraph breaks are a real boundary even without terminal
  // punctuation (e.g. a short intro line followed by a list) — split on
  // those first, then sentence-split within each resulting block.
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const sentences = blocks.flatMap(splitIntoSentences);
  const merged = mergeShortPieces(sentences, MIN_CHUNK_CHARS);
  const chunks = [];
  for (const piece of merged) {
    if (piece.length <= MAX_CHUNK_CHARS) chunks.push(piece);
    else chunks.push(...splitLongPiece(piece, MAX_CHUNK_CHARS));
  }
  return chunks.filter(Boolean);
}

// ── Streaming variant ────────────────────────────────────────────────────
// Same sentence-boundary rules as splitIntoSpeechChunks, but stateful: text
// arrives incrementally from the LLM stream (see providers/openai.js), and
// each complete chunk needs to be handed to TTS as soon as it's safe to do
// so — instead of waiting for the whole reply like the non-streaming path
// above (still used verbatim when AIDA_STREAMING_ENABLED=false).

// An unpunctuated run this long is forced out anyway, so one slow/rambling
// clause never blocks time-to-first-audio indefinitely.
const STREAM_FORCE_FLUSH_CHARS = 220;

/** Index of the last position in `buffer` at/after which a sentence boundary is trustworthy (has lookahead), or -1. */
function findSafeBoundary(buffer) {
  const boundaryRe = /[.!?]+["')\]]?(?=\s|$)/g;
  let match;
  let lastGood = -1;
  while ((match = boundaryRe.exec(buffer))) {
    const idx = match.index;
    const punctChar = buffer[idx];
    const boundaryEnd = idx + match[0].length;
    if (boundaryEnd >= buffer.length) break; // no lookahead yet — more text might still change the verdict

    const charBefore = buffer[idx - 1];
    const nextChar = buffer.slice(boundaryEnd).trimStart()[0];
    if (!nextChar) break;

    const isDecimal = punctChar === '.' && charBefore && /\d/.test(charBefore) && /\d/.test(nextChar);
    if (isDecimal) continue;

    if (punctChar === '.') {
      const wordBefore = buffer.slice(0, idx).match(/([A-Za-z]+)$/);
      if (wordBefore && ABBREVIATIONS.has(wordBefore[1].toLowerCase())) continue;
      const lineStart = buffer.lastIndexOf('\n', idx) + 1;
      const linePrefix = buffer.slice(lineStart, idx);
      if (/^\s*\d+$/.test(linePrefix)) continue;
    }

    lastGood = boundaryEnd;
  }
  return lastGood;
}

function findWordBoundaryNear(buffer, target) {
  const idx = buffer.lastIndexOf(' ', target);
  return idx > 0 ? idx : target;
}

/**
 * Incremental sentence chunker for streamed LLM text. `onChunk(text)` fires
 * once per speech-ready chunk (merged past MIN_CHUNK_CHARS, same as the
 * batch splitter). Call `push()` for every text delta as it arrives, and
 * `flush()` exactly once when the stream ends to emit whatever remains.
 */
function createStreamingChunker(onChunk) {
  let buffer = '';
  let pendingMerge = '';

  function emit(piece) {
    const trimmed = (piece || '').trim();
    if (trimmed) onChunk(trimmed);
  }

  function drain({ force = false } = {}) {
    while (true) {
      const boundaryEnd = findSafeBoundary(buffer);
      if (boundaryEnd === -1) break;
      const sentence = buffer.slice(0, boundaryEnd).trim();
      buffer = buffer.slice(boundaryEnd);
      pendingMerge = pendingMerge ? `${pendingMerge} ${sentence}` : sentence;
      if (pendingMerge.length >= MIN_CHUNK_CHARS) {
        emit(pendingMerge);
        pendingMerge = '';
      }
    }

    if (buffer.length >= STREAM_FORCE_FLUSH_CHARS) {
      const cut = findWordBoundaryNear(buffer, STREAM_FORCE_FLUSH_CHARS);
      const piece = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut);
      pendingMerge = pendingMerge ? `${pendingMerge} ${piece}` : piece;
      emit(pendingMerge);
      pendingMerge = '';
    }

    if (force) {
      const rest = `${pendingMerge} ${buffer}`.trim();
      buffer = '';
      pendingMerge = '';
      emit(rest);
    }
  }

  function push(delta) {
    if (!delta) return;
    buffer += delta;
    drain();
  }

  function flush() {
    drain({ force: true });
  }

  return { push, flush };
}

module.exports = { splitIntoSpeechChunks, createStreamingChunker };
