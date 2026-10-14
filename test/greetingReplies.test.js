const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isGreeting, pickGreetingText, GREETING_REPLIES } = require('../src/aida/voice/greetingReplies');

test('matches bare greetings, with trivial punctuation/repetition', () => {
  for (const m of ['hi', 'Hi!', 'hii', 'hello', 'heyy', 'good morning', 'Good Morning!', 'morning', 'yo', 'sup', 'howdy']) {
    assert.equal(isGreeting(m), true, `expected "${m}" to match`);
  }
});

test('does not match a greeting followed by a real request', () => {
  for (const m of ['hi, can you also check my orders', 'hello there, what is the status of order 123', 'hey can you help']) {
    assert.equal(isGreeting(m), false, `expected "${m}" NOT to match`);
  }
});

test('does not match unrelated/technical messages', () => {
  for (const m of ['why is this broken', '', 'show me open tasks']) {
    assert.equal(isGreeting(m), false);
  }
});

test('pickGreetingText always returns one of the known replies', () => {
  for (let i = 0; i < 20; i++) {
    assert.ok(GREETING_REPLIES.includes(pickGreetingText()));
  }
});
