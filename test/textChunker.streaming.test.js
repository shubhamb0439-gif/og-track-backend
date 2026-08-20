const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStreamingChunker, splitIntoSpeechChunks } = require('../src/aida/voice/textChunker');

function feedInPieces(chunker, text, pieceSize) {
  for (let i = 0; i < text.length; i += pieceSize) chunker.push(text.slice(i, i + pieceSize));
}

// 1: normal fast/simple response — a couple of complete sentences streamed token-by-token.
test('streaming chunker emits the same sentences as the batch splitter, for simple text', () => {
  const text = 'Sure, I can help with that. Here is what I found.';
  const streamed = [];
  const chunker = createStreamingChunker((c) => streamed.push(c));
  feedInPieces(chunker, text, 3);
  chunker.flush();
  assert.deepEqual(streamed, splitIntoSpeechChunks(text));
});

// 3/4: long, multi-sentence response streamed in small pieces.
test('streaming chunker handles a long multi-sentence reply streamed in small deltas', () => {
  const text =
    'Let me walk you through this. First, check the config file for a typo. ' +
    'Second, restart the service once that is fixed. Third, confirm the health check passes. ' +
    'That should resolve it in most cases.';
  const streamed = [];
  const chunker = createStreamingChunker((c) => streamed.push(c));
  feedInPieces(chunker, text, 5);
  chunker.flush();
  assert.deepEqual(streamed, splitIntoSpeechChunks(text));
});

// 13: empty response.
test('streaming chunker emits nothing for an empty stream', () => {
  const streamed = [];
  const chunker = createStreamingChunker((c) => streamed.push(c));
  chunker.flush();
  assert.deepEqual(streamed, []);
});

// 14: very short response.
test('streaming chunker flushes a short reply with no terminal punctuation on flush()', () => {
  const streamed = [];
  const chunker = createStreamingChunker((c) => streamed.push(c));
  chunker.push('Sure');
  chunker.flush();
  assert.deepEqual(streamed, ['Sure']);
});

test('streaming chunker does not split on a decimal number split across deltas', () => {
  const streamed = [];
  const chunker = createStreamingChunker((c) => streamed.push(c));
  chunker.push('The result is 3');
  chunker.push('.14 approximately.');
  chunker.flush();
  assert.deepEqual(streamed, ['The result is 3.14 approximately.']);
});

test('streaming chunker does not split on an abbreviation', () => {
  const streamed = [];
  const chunker = createStreamingChunker((c) => streamed.push(c));
  chunker.push('Ask Dr. Smith about it. He will know.');
  chunker.flush();
  assert.deepEqual(streamed, splitIntoSpeechChunks('Ask Dr. Smith about it. He will know.'));
});

// 15: very long response with an unpunctuated run forces a flush past the char threshold.
test('streaming chunker force-flushes an unpunctuated run past the char threshold', () => {
  const streamed = [];
  const chunker = createStreamingChunker((c) => streamed.push(c));
  const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' '); // no punctuation at all
  chunker.push(words);
  chunker.flush();
  assert.ok(streamed.length >= 2, 'expected the long unpunctuated run to be force-split into multiple chunks');
  assert.equal(streamed.join(' ').replace(/\s+/g, ' '), words);
});

test('streaming chunker holds back a boundary with no lookahead yet, then resolves once more text arrives', () => {
  const streamed = [];
  const chunker = createStreamingChunker((c) => streamed.push(c));
  chunker.push('Give me a second');
  chunker.push('.');
  // Nothing should have flushed yet — no lookahead after the period.
  assert.deepEqual(streamed, []);
  chunker.push(' Okay, here we go.');
  chunker.flush();
  assert.deepEqual(streamed, splitIntoSpeechChunks('Give me a second. Okay, here we go.'));
});
