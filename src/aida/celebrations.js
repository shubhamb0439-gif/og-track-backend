/**
 * Shared "is today this user's birthday/work anniversary" logic — used by
 * both GET /api/:slug/users/today-celebrations (src/routes/users.js) and
 * AIDA's own system-prompt context (src/routes/aida.js) so the two never
 * drift apart on the date-matching rules.
 */

// Extracts { year, month, day } from whatever a DATE column comes back as
// (a JS Date instance or a string), or null if the value is empty/invalid.
function dateParts(v) {
  if (!v) return null;
  const d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d.getTime())) return null;
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * Given a user's raw date_of_birth/joining_date column values, returns every
 * celebration that applies today: { type: 'birthday' } and/or
 * { type: 'anniversary', yearsCount }. joining_date only counts as an
 * anniversary when its year isn't the current year (excludes someone who
 * joined today from also getting an "anniversary" notification on day one).
 * Returns an empty array when neither applies.
 */
function matchTodayCelebrations(dateOfBirthRaw, joiningDateRaw) {
  const now = new Date();
  const todayMonth = now.getUTCMonth() + 1;
  const todayDay = now.getUTCDate();
  const currentYear = now.getUTCFullYear();
  const results = [];

  const dob = dateParts(dateOfBirthRaw);
  if (dob && dob.month === todayMonth && dob.day === todayDay) {
    results.push({ type: 'birthday' });
  }

  const joined = dateParts(joiningDateRaw);
  if (joined && joined.month === todayMonth && joined.day === todayDay && joined.year !== currentYear) {
    results.push({ type: 'anniversary', yearsCount: currentYear - joined.year });
  }

  return results;
}

module.exports = { dateParts, matchTodayCelebrations };
