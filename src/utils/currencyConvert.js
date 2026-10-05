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

/** Real exchange rate for `fromCurrency` -> INR as of `asOfDate`. Returns 1 for INR (no network call). */
async function getHistoricalRate(fromCurrency, asOfDate) {
  if (!fromCurrency || fromCurrency === BASE_CURRENCY) return 1;
  const dateStr = asOfDate.toISOString().slice(0, 10);
  const res = await fetch(`${FRANKFURTER_BASE}/${dateStr}?base=${fromCurrency}&symbols=${BASE_CURRENCY}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Exchange rate lookup failed (${res.status})`);
  const data = await res.json();
  const rate = data.rates?.[BASE_CURRENCY];
  if (!rate) throw new Error(`No ${BASE_CURRENCY} rate returned for ${fromCurrency} on ${dateStr}`);
  return rate;
}

module.exports = { getHistoricalRate, BASE_CURRENCY };
