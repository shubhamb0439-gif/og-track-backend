const { test } = require('node:test');
const assert = require('node:assert/strict');

// Regression test for a real bug found in production testing: an ElevenLabs
// connection that never resolves or rejects (headers/body just never arrive)
// left a turn hanging forever — no audio, no error, no completion signal.
// synthesizeChunkStream now always races against a hard timeout
// (voice.ttsTimeoutMs / opts.timeoutMs) so this can never happen again.

function abortableHang(signal) {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      reject(err);
    });
  });
}

test('a stalled ElevenLabs connection times out instead of hanging forever', async () => {
  const originalFetch = global.fetch;
  // Simulate a connection that never settles on its own — the exact failure
  // mode found live — but (like real fetch) it DOES respect an abort signal,
  // which is what the client's internal timeout is expected to trigger.
  global.fetch = (url, opts) => abortableHang(opts.signal);

  // The client's own timeout timer is deliberately unref()'d (so it never
  // blocks a real server's graceful shutdown) — on a real running server
  // there's always something else ref'd (the HTTP listener) keeping the
  // event loop alive regardless, but this isolated test has nothing else,
  // so it needs its own keep-alive or the unref'd timer never gets a chance
  // to fire.
  const keepAlive = setInterval(() => {}, 50);
  try {
    const { synthesizeChunkStream } = require('../src/aida/voice/elevenLabsClient');
    const iterator = synthesizeChunkStream('hello there', { timeoutMs: 200 })[Symbol.asyncIterator]();

    await assert.rejects(
      iterator.next(),
      (err) => {
        assert.match(err.message, /timed out/i);
        return true;
      }
    );
  } finally {
    clearInterval(keepAlive);
    global.fetch = originalFetch;
  }
});

test('a connection that stalls mid-stream (after headers, before body finishes) also times out', async () => {
  const originalFetch = global.fetch;
  global.fetch = (url, opts) => Promise.resolve({
    ok: true,
    body: {
      getReader: () => ({
        read: () => abortableHang(opts.signal), // headers arrived, but the body read never resolves on its own
        releaseLock: () => {},
      }),
    },
  });

  const keepAlive = setInterval(() => {}, 50);
  try {
    const { synthesizeChunkStream } = require('../src/aida/voice/elevenLabsClient');
    const iterator = synthesizeChunkStream('hello there', { timeoutMs: 200 })[Symbol.asyncIterator]();

    await assert.rejects(
      iterator.next(),
      (err) => {
        assert.match(err.message, /timed out|stalled/i);
        return true;
      }
    );
  } finally {
    clearInterval(keepAlive);
    global.fetch = originalFetch;
  }
});
