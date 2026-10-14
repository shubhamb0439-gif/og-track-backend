const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isTrivialMessage } = require('../src/aida/messageTriviality');

test('short, casual messages are trivial', () => {
  for (const text of ['hi', 'hey, how are you?', 'thanks so much!', 'sounds good, see you then']) {
    assert.equal(isTrivialMessage({ text }), true, `expected "${text}" to be trivial`);
  }
});

test('an attachment always requires confirmation, even with short/no text', () => {
  assert.equal(isTrivialMessage({ text: 'hi', hasAttachment: true }), false);
  assert.equal(isTrivialMessage({ text: '', hasAttachment: true }), false);
});

test('sensitive-topic keywords require confirmation even if short', () => {
  for (const text of [
    'please send the invoice today',
    'this is urgent, call me',
    'about the contract renewal',
    'your payment is overdue',
  ]) {
    assert.equal(isTrivialMessage({ text }), false, `expected "${text}" to require confirmation`);
  }
});

test('a long message requires confirmation', () => {
  const long = 'Hi, I wanted to follow up on our conversation from last week about the project timeline and ' +
    'let you know that we have made some progress but there are still a few things we need to sort out before moving forward.';
  assert.equal(isTrivialMessage({ text: long }), false);
});

test('empty text is never trivial', () => {
  assert.equal(isTrivialMessage({ text: '' }), false);
  assert.equal(isTrivialMessage({}), false);
});
