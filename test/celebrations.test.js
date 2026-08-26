const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matchTodayCelebrations } = require('../src/aida/celebrations');

const now = new Date();
const todayMonth = String(now.getUTCMonth() + 1).padStart(2, '0');
const todayDay = String(now.getUTCDate()).padStart(2, '0');
const currentYear = now.getUTCFullYear();

test('matches a birthday when month+day equal today (any year)', () => {
  const result = matchTodayCelebrations(`1990-${todayMonth}-${todayDay}`, null);
  assert.deepEqual(result, [{ type: 'birthday' }]);
});

test('matches a work anniversary when month+day equal today and the join year is not this year', () => {
  const result = matchTodayCelebrations(null, `${currentYear - 3}-${todayMonth}-${todayDay}`);
  assert.deepEqual(result, [{ type: 'anniversary', yearsCount: 3 }]);
});

test('excludes a same-year join from counting as an anniversary', () => {
  const result = matchTodayCelebrations(null, `${currentYear}-${todayMonth}-${todayDay}`);
  assert.deepEqual(result, []);
});

test('returns both a birthday and an anniversary when both apply the same day', () => {
  const result = matchTodayCelebrations(`1985-${todayMonth}-${todayDay}`, `${currentYear - 1}-${todayMonth}-${todayDay}`);
  assert.deepEqual(result, [{ type: 'birthday' }, { type: 'anniversary', yearsCount: 1 }]);
});

test('returns no matches when neither date is today and both are null/invalid', () => {
  assert.deepEqual(matchTodayCelebrations(null, null), []);
  assert.deepEqual(matchTodayCelebrations(undefined, undefined), []);
  assert.deepEqual(matchTodayCelebrations('not-a-date', 'also-not-a-date'), []);
});

test('does not match when month or day differ from today', () => {
  const otherMonth = ((now.getUTCMonth() + 6) % 12) + 1; // 6 months away, wraps safely
  const otherMonthStr = String(otherMonth).padStart(2, '0');
  const result = matchTodayCelebrations(`1990-${otherMonthStr}-${todayDay}`, null);
  assert.deepEqual(result, []);
});
