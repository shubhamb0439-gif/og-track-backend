const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const config = require('../config');
const router = express.Router();

// ── OG Plus drug-lookup API ──────────────────────────────────────────────────
// Backs a Chrome extension: it scans whatever page the person is viewing for
// a drug name and calls this to ask "does OG Plus have a patient assistance
// plan for this?" so it can pop up a toolbar. Public (no login — the caller
// is an anonymous browser extension), gated by a shared API key, and scoped
// to exactly one tenant's `drugs` table (OG Plus Services, slug 'ogplus') —
// mounted the same generic `/api/:slug/drugs` way as every other tenant
// router (see server.js), but hard-guarded below to the one slug this table
// actually exists in, so it 404s cleanly for any other company rather than
// erroring on a missing table.

// In-memory cache of active drug names, refreshed on a short TTL — the table
// is small (hundreds of rows) and barely changes, so one query every few
// minutes comfortably serves a page-scan workload that can fire many lookups
// in a burst. Keyed per req.db since knex instances are per-tenant-db, even
// though in practice only 'ogplus' ever reaches this.
const CACHE_TTL_MS = 5 * 60 * 1000;
const cacheByDb = new WeakMap();

async function getActiveDrugs(db) {
  const cached = cacheByDb.get(db);
  if (cached && cached.expiresAt > Date.now()) return cached.rows;
  const rows = await db('drugs')
    .where({ status: true })
    .select('id', 'drug', 'slug', 'direct_answer', 'discount_percent', 'description');
  const normalized = rows.map((r) => ({ ...r, _norm: normalize(r.drug) }));
  cacheByDb.set(db, { rows: normalized, expiresAt: Date.now() + CACHE_TTL_MS });
  return normalized;
}

function normalize(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function mapDrug(r) {
  return {
    id: r.id,
    name: r.drug,
    slug: r.slug || null,
    directAnswer: r.direct_answer || null,
    discountPercent: r.discount_percent !== undefined && r.discount_percent !== null ? Number(r.discount_percent) : null,
    description: r.description || null,
  };
}

// Exact match first; falls back to "the queried text contains a known drug
// name as a whole word" (e.g. a page's "Lipitor 20mg Tablet" should still
// match "Lipitor") — picks the longest matching drug name so a more specific
// match always wins over a shorter, coincidentally-contained one.
function findMatch(allDrugs, queryName) {
  const q = normalize(queryName);
  if (!q) return null;
  const exact = allDrugs.find((d) => d._norm === q);
  if (exact) return exact;
  let best = null;
  for (const d of allDrugs) {
    if (!d._norm) continue;
    const re = new RegExp(`(^|[^a-z0-9])${d._norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
    if (re.test(q) && (!best || d._norm.length > best._norm.length)) best = d;
  }
  return best;
}

function timingSafeEqualStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Legacy single shared key (env var) — still gates /lookup and /lookup-batch,
// used internally by the extension only, never exposed to a third-party
// website. Kept fail-closed (503 when unset) like before.
function requireDrugsApiKey(req, res, next) {
  if (!config.ogplusDrugsApi.apiKey) {
    return res.status(503).json({ error: 'Drugs lookup API is not configured on this server.' });
  }
  const provided = (req.headers['x-api-key'] || '').toString();
  if (!timingSafeEqualStrings(provided, config.ogplusDrugsApi.apiKey)) {
    return res.status(401).json({ error: 'Invalid or missing API key.' });
  }
  next();
}

// Per-partner read-only keys for GET /list ONLY (src/.../setup_drugs_api_keys.js
// created this table; see also the add-a-partner-key instructions given with
// this change). Stored in the `drugs_api_keys` table so a key can be
// individually switched off (set enabled=0) with no redeploy — a partner's
// key is visible in their page source, so revocation has to be instant.
// Cached briefly to avoid a DB round trip on every page-load across every
// partner site.
const LIST_KEYS_CACHE_TTL_MS = 60 * 1000;
const listKeysCacheByDb = new WeakMap();

async function getActiveListApiKeys(db) {
  const cached = listKeysCacheByDb.get(db);
  if (cached && cached.expiresAt > Date.now()) return cached.keys;
  let keys = [];
  try {
    const rows = await db('drugs_api_keys').where({ enabled: true }).select('api_key');
    keys = rows.map((r) => r.api_key);
  } catch (err) {
    // Table may not exist yet on an older deploy — fall back to just the
    // legacy single key below rather than erroring /list outright.
    keys = [];
  }
  listKeysCacheByDb.set(db, { keys, expiresAt: Date.now() + LIST_KEYS_CACHE_TTL_MS });
  return keys;
}

async function requireListApiKey(req, res, next) {
  const provided = (req.headers['x-api-key'] || '').toString();
  if (!provided) return res.status(401).json({ error: 'Invalid or missing API key.' });
  // The old single env key still works here too during migration, so nothing
  // using it breaks while partners/extension move onto their own dedicated
  // drugs_api_keys row.
  if (timingSafeEqualStrings(provided, config.ogplusDrugsApi.apiKey)) return next();
  try {
    const activeKeys = await getActiveListApiKeys(req.db);
    if (activeKeys.some((k) => timingSafeEqualStrings(provided, k))) return next();
  } catch (err) {
    // fall through to 401
  }
  return res.status(401).json({ error: 'Invalid or missing API key.' });
}

// This table only exists in the 'ogplus' tenant DB — guard against any other
// slug reaching here instead of letting it fall through to a confusing
// "table 'drugs' doesn't exist" SQL error.
router.use((req, res, next) => {
  if (req.company.slug !== 'ogplus') return res.status(404).json({ error: 'Not found' });
  next();
});

// GET /api/ogplus/drugs/lookup?name=Lipitor
router.get('/lookup', requireDrugsApiKey, async (req, res) => {
  const name = (req.query.name || '').toString();
  if (!name.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    const allDrugs = await getActiveDrugs(req.db);
    const match = findMatch(allDrugs, name);
    res.json(match ? { matched: true, drug: mapDrug(match) } : { matched: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ogplus/drugs/list
// Full active-drug list in one response, for the extension AND the
// drugassist-widget.js snippet (embedded on partner websites) to cache
// locally and match page text against client-side — no per-word/per-page-
// visit call to this server, which both keeps it fast and means the content
// of pages someone visits (which could be a medical site) never has to be
// sent here at all. `DRUGASSIST_BASE_URL` builds each drug's public page
// link from its slug; if a row has no slug, `url` comes back null — `slug`
// itself is always included so a caller can build its own link either way.
//
// This is the one endpoint meant to be called from an arbitrary third-party
// website's own page (every partner embedding the widget), so it gets its
// own wide-open CORS policy (Access-Control-Allow-Origin: *) instead of the
// app-wide allowlist in server.js — safe since it's read-only and still
// gated by requireListApiKey below. OPTIONS is handled by drugListCors alone,
// before any API-key check, since browsers never send custom headers (like
// x-api-key) on a preflight request.
const drugListCors = cors({
  origin: '*',
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['x-api-key', 'Content-Type'],
  maxAge: 86400,
});
router.options('/list', drugListCors);

router.get('/list', drugListCors, requireListApiKey, async (req, res) => {
  try {
    const allDrugs = await getActiveDrugs(req.db);
    const baseUrl = config.ogplusDrugsApi.publicSiteBaseUrl;
    const drugs = allDrugs.map((r) => ({
      id: String(r.id),
      name: r.drug,
      slug: r.slug || null,
      // No alias data exists in the source table today (one name per row) —
      // this is just the canonical name wrapped in an array so the shape
      // matches what the extension expects. Real aliases (brand vs generic,
      // etc.) would need real brand/generic data added to the source table —
      // not fabricated here.
      aliases: [r.drug],
      url: r.slug && baseUrl ? `${baseUrl.replace(/\/$/, '')}/${r.slug}` : null,
      summary: r.direct_answer || r.description || null,
    }));
    // Each visitor's browser fetches this at most once an hour per the
    // widget's own design — tell it so explicitly rather than relying on
    // every visitor's browser default (which would otherwise revalidate far
    // more often than needed).
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(drugs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ogplus/drugs/lookup-batch?names=Lipitor,Crestor,Entresto
// Same match as /lookup, for a page scan that found several candidate names
// at once — avoids one round trip per candidate.
router.get('/lookup-batch', requireDrugsApiKey, async (req, res) => {
  const namesParam = (req.query.names || '').toString();
  const names = namesParam.split(',').map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) return res.status(400).json({ error: 'names is required (comma-separated)' });
  try {
    const allDrugs = await getActiveDrugs(req.db);
    const results = names.map((query) => {
      const match = findMatch(allDrugs, query);
      return match ? { query, matched: true, drug: mapDrug(match) } : { query, matched: false };
    });
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
