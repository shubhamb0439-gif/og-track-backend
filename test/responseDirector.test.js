const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildDirective, safeDirective, classifyFromMessage } = require('../src/aida/responseDirector');
const { isValidEmotion } = require('../src/aida/personality');

test('technical question classifies as thoughtful/analytical', () => {
  const d = buildDirective('Why is the deploy build failing with a null pointer exception?');
  assert.equal(d.emotion, 'thoughtful');
});

test('frustration classifies as frustrated/empathetic filler', () => {
  const d = buildDirective("This is still broken and it's so annoying, nothing works.");
  assert.equal(d.emotion, 'frustrated');
  assert.equal(d.fillerCategory, 'empathy');
});

test('humor classifies as amused', () => {
  const d = buildDirective('haha okay that is actually pretty funny');
  assert.equal(d.emotion, 'amused');
});

test('surprise classifies as surprised', () => {
  const d = buildDirective('Wait, seriously? No way that actually worked.');
  assert.equal(d.emotion, 'surprised');
});

test('gratitude/success classifies as warm', () => {
  const d = buildDirective('Thanks, that fixed it, it works now!');
  assert.equal(d.emotion, 'warm');
});

test('plain neutral message falls back to the default emotion', () => {
  const d = buildDirective('Show me my open tasks for today.');
  assert.equal(d.emotion, 'neutral');
});

test('every classification produces a valid emotion known to the personality module', () => {
  const messages = [
    'Why does this happen?', 'Ugh this is broken', 'lol nice', 'Whoa really?',
    'Thanks so much', 'production is down, this is critical', 'What do you think about this?',
    'show me the sprint board',
  ];
  for (const m of messages) {
    const { emotion } = classifyFromMessage(m);
    assert.ok(isValidEmotion(emotion), `expected a valid emotion for "${m}", got "${emotion}"`);
  }
});

// 12: invalid emotion directive falls back to neutral delivery.
test('safeDirective falls back to neutral for a missing/invalid directive', () => {
  assert.equal(safeDirective(null).emotion, 'neutral');
  assert.equal(safeDirective(undefined).emotion, 'neutral');
  assert.equal(safeDirective({ emotion: 'not_a_real_emotion' }).emotion, 'neutral');
  const valid = { emotion: 'amused', delivery: 'x', energy: 0.5, pacing: 'moderate', fillerCategory: 'amusement' };
  assert.deepEqual(safeDirective(valid), valid);
});

test('pacing slows down for empathetic/serious/thoughtful emotions', () => {
  const d = buildDirective("This is broken and it's really frustrating.");
  assert.equal(d.pacing, 'slow');
});
