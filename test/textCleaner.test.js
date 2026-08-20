const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cleanForSpeech } = require('../src/aida/voice/textCleaner');

test('strips bold/italic markdown emphasis without losing the words', () => {
  assert.equal(cleanForSpeech('**Sure!** Let\'s do this.'), "Sure! Let's do this.");
  assert.equal(cleanForSpeech('This is *important* to note.'), 'This is important to note.');
});

test('strips inline code and fenced code blocks', () => {
  assert.equal(cleanForSpeech('Run `npm install` first.'), 'Run npm install first.');
  const withFence = 'Here you go:\n```js\nconsole.log("hi")\n```\nThat should work.';
  const cleaned = cleanForSpeech(withFence);
  assert.ok(!cleaned.includes('```'));
  assert.ok(cleaned.includes('code block omitted'));
  assert.ok(cleaned.includes('That should work.'));
});

test('strips markdown links but keeps the label', () => {
  assert.equal(cleanForSpeech('See [the docs](https://example.com/docs) for more.'), 'See the docs for more.');
});

test('strips heading markers and list bullets', () => {
  assert.equal(cleanForSpeech('# Summary\nHere is what I found.'), 'Summary\nHere is what I found.');
  assert.equal(cleanForSpeech('- item one\n- item two'), 'item one\nitem two');
});

test('preserves normal punctuation that carries speech rhythm', () => {
  const text = 'First, check the config. Then restart the service, and confirm it works!';
  assert.equal(cleanForSpeech(text), text);
});

test('handles empty/undefined input without throwing', () => {
  assert.equal(cleanForSpeech(''), '');
  assert.equal(cleanForSpeech(undefined), '');
  assert.equal(cleanForSpeech(null), '');
});
