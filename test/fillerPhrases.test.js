const { test } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { canPlayFiller, markFillerPlayed, FILLERS_BY_CATEGORY } = require('../src/aida/voice/fillerPhrases');

// These only exercise the pure cooldown/selection logic — getFillerAudio()/
// getRandomFillerAudio() are excluded here since they make a real (cached)
// ElevenLabs network call on first use, which this repo has no mocking
// infrastructure for; see docs/AIDA_VOICE_UPGRADE.md's testing section.

test('every filler category has at least 2 variants (avoids exact repetition)', () => {
  for (const [category, phrases] of Object.entries(FILLERS_BY_CATEGORY)) {
    assert.ok(phrases.length >= 2, `category "${category}" should have multiple variants`);
  }
  for (const expected of ['thinking', 'acknowledgement', 'surprise', 'amusement', 'empathy']) {
    assert.ok(FILLERS_BY_CATEGORY[expected], `expected a "${expected}" filler category`);
  }
});

test('filler cooldown blocks a second filler for the same session key within the window', () => {
  const originalEnabled = config.aida.voice.fillerEnabled;
  const originalCooldown = config.aida.voice.fillerCooldownMs;
  config.aida.voice.fillerEnabled = true;
  config.aida.voice.fillerCooldownMs = 10_000;
  try {
    const key = `test-session-${Math.random()}`;
    assert.equal(canPlayFiller(key), true);
    markFillerPlayed(key);
    assert.equal(canPlayFiller(key), false);

    const otherKey = `test-session-${Math.random()}`;
    assert.equal(canPlayFiller(otherKey), true, 'a different session key should not be affected by another session\'s cooldown');
  } finally {
    config.aida.voice.fillerEnabled = originalEnabled;
    config.aida.voice.fillerCooldownMs = originalCooldown;
  }
});

test('fillerEnabled=false suppresses fillers regardless of cooldown state', () => {
  const originalEnabled = config.aida.voice.fillerEnabled;
  config.aida.voice.fillerEnabled = false;
  try {
    assert.equal(canPlayFiller(`test-session-${Math.random()}`), false);
  } finally {
    config.aida.voice.fillerEnabled = originalEnabled;
  }
});

test('cooldown clears once enough time has passed', async () => {
  const originalEnabled = config.aida.voice.fillerEnabled;
  const originalCooldown = config.aida.voice.fillerCooldownMs;
  config.aida.voice.fillerEnabled = true;
  config.aida.voice.fillerCooldownMs = 1;
  try {
    const key = `test-session-${Math.random()}`;
    markFillerPlayed(key);
    assert.equal(canPlayFiller(key), false);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(canPlayFiller(key), true);
  } finally {
    config.aida.voice.fillerEnabled = originalEnabled;
    config.aida.voice.fillerCooldownMs = originalCooldown;
  }
});
