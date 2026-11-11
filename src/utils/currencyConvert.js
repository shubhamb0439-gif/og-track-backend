const BASE_CURRENCY = 'INR';
const FRANKFURTER_BASE = 'https://api.frankfurter.dev/v1';

/**
 * Real currency conversion for inventory costing — built after a real
 * production incident: a purchase's `currency` field (USD/EUR/etc.) was
 * being stored but never actually converted anywhere, so a genuinely
 * correct "423.53 EUR" unit cost silently became "₹423.53" (off by ~100x)
 * the moment stock was received, corrupting avg_cost and every BOM that
 * shared that component.
 *
 * Deliberately uses the HISTORICAL rate as of when the cost was agreed
 * (a purchase's order_date), not "today's" rate — converting at
 * view/report time instead would be wrong for two concrete reasons
 * confirmed while diagnosing the incident above: (1) the shown cost would
 * silently drift every time someone looks at it as FX moves, even though
 * nothing about the purchase changed, and (2) avg_cost is a weighted
 * average across multiple stock lots — you cannot correctly average raw
 * numbers that are secretly in different currencies; they must each be
 * converted to one common currency BEFORE averaging, not after.
 *
 * Frankfurter (ECB-sourced, frankfurter.dev) needs no API key/signup and
 * has no rate limit — confirmed live, including with INR and the exact
 * historical dates from the incident, before relying on it here.
 */

// A past day's ECB rate is an immutable historical fact — safe to cache
// forever (process lifetime), not just per-request. This also makes the new
// per-vendor total-value aggregate (inventory.js's GET /vendors) cheap on
// repeat loads instead of re-fetching the same handful of (currency, date)
// pairs on every page view.
const _historicalRateCache = new Map(); // `${currency}|${dateStr}` -> rate

/** Real exchange rate for `fromCurrency` -> INR as of `asOfDate`. Returns 1 for INR (no network call). */
async function getHistoricalRate(fromCurrency, asOfDate) {
  if (!fromCurrency || fromCurrency === BASE_CURRENCY) return 1;
  const dateStr = asOfDate.toISOString().slice(0, 10);
  const cacheKey = `${fromCurrency}|${dateStr}`;
  if (_historicalRateCache.has(cacheKey)) return _historicalRateCache.get(cacheKey);
  const res = await fetch(`${FRANKFURTER_BASE}/${dateStr}?base=${fromCurrency}&symbols=${BASE_CURRENCY}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Exchange rate lookup failed (${res.status})`);
  const data = await res.json();
  const rate = data.rates?.[BASE_CURRENCY];
  if (!rate) throw new Error(`No ${BASE_CURRENCY} rate returned for ${fromCurrency} on ${dateStr}`);
  _historicalRateCache.set(cacheKey, rate);
  return rate;
}

// Short-TTL cache for "today's" rate between two arbitrary currencies — used
// for the display-only currency-conversion toggle (convert already-stored
// amounts to whatever currency the user picks to look at). Deliberately NOT
// cached forever like the historical rate above, since "today's" rate is not
// an immutable fact — but Frankfurter's own /latest endpoint only actually
// updates once a day (~16:00 CET), so a 1-hour TTL is just avoiding redundant
// calls, not staleness risk.
const _latestRateCache = new Map(); // `${from}|${to}` -> { rate, expiresAt }
const LATEST_RATE_TTL_MS = 60 * 60 * 1000;

/** Real "current" exchange rate for `fromCurrency` -> `toCurrency`, for display-only conversion. Returns 1 if they're the same. */
async function getLatestRate(fromCurrency, toCurrency) {
  if (!fromCurrency || !toCurrency || fromCurrency === toCurrency) return 1;
  const cacheKey = `${fromCurrency}|${toCurrency}`;
  const cached = _latestRateCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.rate;
  const res = await fetch(`${FRANKFURTER_BASE}/latest?base=${fromCurrency}&symbols=${toCurrency}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Exchange rate lookup failed (${res.status})`);
  const data = await res.json();
  const rate = data.rates?.[toCurrency];
  if (!rate) throw new Error(`No ${toCurrency} rate returned for ${fromCurrency}`);
  _latestRateCache.set(cacheKey, { rate, expiresAt: Date.now() + LATEST_RATE_TTL_MS });
  return rate;
}

module.exports = { getHistoricalRate, getLatestRate, BASE_CURRENCY };
