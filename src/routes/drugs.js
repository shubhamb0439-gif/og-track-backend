const express = require('express');
const crypto = require('crypto');
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

function requireDrugsApiKey(req, res, next) {
  if (!config.ogplusDrugsApi.apiKey) {
    return res.status(503).json({ error: 'Drugs lookup API is not configured on this server.' });
  }
  const provided = req.headers['x-api-key'] || '';
  const expected = config.ogplusDrugsApi.apiKey;
  const match = provided.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!match) return res.status(401).json({ error: 'Invalid or missing API key.' });
  next();
}

// This table only exists in the 'ogplus' tenant DB — guard against any other
// slug reaching here instead of letting it fall through to a confusing
// "table 'drugs' doesn't exist" SQL error.
router.use((req, res, next) => {
  if (req.company.slug !== 'ogplus') return res.status(404).json({ error: 'Not found' });
  next();
});

router.use(requireDrugsApiKey);

// GET /api/ogplus/drugs/lookup?name=Lipitor
router.get('/lookup', async (req, res) => {
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
// Full active-drug list in one response, for the extension to cache locally
// and match page text against client-side — no per-word/per-page-visit call
// to this server, which both keeps it fast and means the content of pages
// someone visits (which could be a medical site) never has to be sent here
// at all. `DRUGASSIST_BASE_URL` builds each drug's public page link from its
// slug; if a row has no slug, `url` comes back null rather than a guessed link.
router.get('/list', async (req, res) => {
  try {
    const allDrugs = await getActiveDrugs(req.db);
    const baseUrl = config.ogplusDrugsApi.publicSiteBaseUrl;
    const drugs = allDrugs.map((r) => ({
      id: String(r.id),
      name: r.drug,
      // No alias data exists in the source table today (one name per row) —
      // this is just the canonical name wrapped in an array so the shape
      // matches what the extension expects. Real aliases (brand vs generic,
      // etc.) would need a new column/table to back this properly.
      aliases: [r.drug],
      url: r.slug && baseUrl ? `${baseUrl.replace(/\/$/, '')}/${r.slug}` : null,
      summary: r.direct_answer || r.description || null,
    }));
    res.json(drugs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ogplus/drugs/lookup-batch?names=Lipitor,Crestor,Entresto
// Same match as /lookup, for a page scan that found several candidate names
// at once — avoids one round trip per candidate.
router.get('/lookup-batch', async (req, res) => {
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
