const jwt = require('jsonwebtoken');
const config = require('../../config');
const coreDb = require('../../db/core');
const { MASTERADMIN_SENTINEL_MODULE } = require('../contextBuilder');

// Short-lived cache — the companies list rarely changes, and this is now
// checked on every cross-tenant tool call (see resolveCompanySlug below),
// not just once per session.
let companiesCache = null;
let companiesCacheAt = 0;
const COMPANIES_CACHE_MS = 60_000;

async function getCompaniesCached() {
  if (companiesCache && Date.now() - companiesCacheAt < COMPANIES_CACHE_MS) return companiesCache;
  companiesCache = await coreDb('companies').select('slug', 'name');
  companiesCacheAt = Date.now();
  return companiesCache;
}

function normalizeForMatch(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Resolves whatever slug-ish string the model passed against the REAL
 * company slugs — confirmed LIVE as a real, recurring failure: a model
 * (GPT-4o, specifically observed) guessed a slug straight from the
 * company's display name instead of calling masteradmin_list_companies
 * first, e.g. "Sitara Drapes" -> "sitaradrapes" instead of the real slug
 * "sitara" — every query then 404'd with no way to self-correct. Exact
 * match wins immediately (the common, correct case); otherwise falls back
 * to a normalized (lowercase, no spaces/punctuation) comparison against
 * both slug AND name, so a model's best-guess slug, or the plain company
 * name, both still resolve — without depending on any model perfectly
 * following the list-companies-first instruction every single turn.
 */
async function resolveCompanySlug(rawSlug) {
  const companies = await getCompaniesCached();
  if (companies.some((c) => c.slug === rawSlug)) return rawSlug;
  const normalizedInput = normalizeForMatch(rawSlug);
  const match = companies.find((c) => normalizeForMatch(c.slug) === normalizedInput || normalizeForMatch(c.name) === normalizedInput);
  return match ? match.slug : null;
}

/**
 * Phase 1 of the "AIDA power tier" plan: master admin gets full READ access
 * across every tenant, without hand-writing a second copy of every tool.
 *
 * Every existing tenant tool's handler only ever reads context.tenantSlug +
 * context.authHeader (via apiClient.callTenantApi) — nothing about the
 * handler itself is tenant-specific beyond that field. So instead of new
 * tools, this wraps each existing tenant tool into a masteradmin_-prefixed
 * counterpart that takes an explicit companySlug argument, builds a
 * synthetic per-call tenant context, and calls the SAME handler unchanged.
 * Zero duplicated business logic; any new tenant tool added later (in
 * attendance.js, projects.js, etc.) gets a cross-tenant counterpart for
 * free just by existing in this list.
 *
 * Registered only under the '__masteradmin__' sentinel, so these never
 * leak into a tenant's own AIDA session (see toolRegistry.isAvailable).
 *
 * Write tools are deliberately NOT wrapped here — per the approved plan,
 * cross-tenant writes must go through a human-approval job flow (not yet
 * built) rather than firing synchronously from a chat turn. Every tool
 * wrapped below is read-only (GET-backed) in its original module file.
 */
// Paired with a category (AIDA roadmap follow-up, 2026-10-28 — organizing
// the browse/Flows node list) so every masteradmin_* cross-tenant tool
// groups under the SAME category as its underlying tenant tool, e.g. every
// masteradmin_sitara_* tool shows up under "Sitara Drapes," not a generic
// bucket — this file isn't one business domain itself, it wraps all 7.
const READABLE_TENANT_TOOL_MODULES = [
  { tools: require('./attendance'), category: 'Attendance' },
  { tools: require('./projects'), category: 'Projects' },
  { tools: require('./crm'), category: 'CRM' },
  { tools: require('./inventory'), category: 'Inventory' },
  { tools: require('./finance'), category: 'Finance' },
  { tools: require('./hr'), category: 'HR' },
  { tools: require('./sitara'), category: 'Sitara Drapes' },
];

function wrapForCrossTenant(tool, category) {
  const originalProperties = (tool.inputSchema && tool.inputSchema.properties) || {};
  const originalRequired = (tool.inputSchema && tool.inputSchema.required) || [];

  return {
    name: `masteradmin_${tool.name}`,
    category,
    // Sitara's own tools subcategorize (Orders/Customers/Products/...) —
    // carrying that through means masteradmin_sitara_* inherits the same
    // grouping for free, no separate assignment needed here.
    subcategory: tool.subcategory || null,
    // Deliberately just the base tool's own description — the "pass
    // companySlug, resolve a company NAME via masteradmin_list_companies
    // first" guidance used to be repeated verbatim in every one of these
    // ~27 wrapped tools' description, but it's already stated once, globally,
    // in engine.js's masteradmin system-prompt line, and companySlug's own
    // purpose is already covered by its own inputSchema property description
    // below. That was pure duplication — real measured cost on every single
    // masteradmin turn (see the "tool schema size" finding in README.md),
    // for zero guidance the model didn't already have.
    description: tool.description,
    requiredModules: [MASTERADMIN_SENTINEL_MODULE],
    inputSchema: {
      type: 'object',
      properties: {
        companySlug: { type: 'string', description: 'The target company/tenant slug.' },
        ...originalProperties,
      },
      required: ['companySlug', ...originalRequired],
    },
    async handler(context, args) {
      const { companySlug, ...rest } = args || {};
      if (!companySlug) return { error: 'companySlug is required.' };
      const resolvedSlug = await resolveCompanySlug(companySlug);
      if (!resolvedSlug) {
        const companies = await getCompaniesCached();
        return { error: `No company matches "${companySlug}". Valid companies: ${companies.map((c) => `${c.name} (slug: ${c.slug})`).join(', ')}` };
      }
      // Reusing the master admin's own JWT here would NOT work against a
      // tenant-scoped route that checks req.auth.slug === req.company.slug
      // (see src/routes/attendance.js's /all endpoint) — that token has
      // role:'masteradmin' and no slug at all, so it can never match any
      // tenant's slug and gets rejected by that check even though the
      // caller genuinely is authorized for full cross-tenant read access.
      // Mint a short-lived, properly tenant-shaped token instead (role
      // 'superadmin' — the same role that already gets full org-wide access
      // within a tenant) so this keeps working against ANY current or future
      // tenant route that enforces per-company token scoping, without
      // needing route-by-route special-casing for "masteradmin passthrough".
      const syntheticToken = jwt.sign(
        { userId: context.userId, role: 'superadmin', slug: resolvedSlug },
        config.app.jwtSecret,
        { expiresIn: '5m' }
      );
      const tenantContext = {
        ...context,
        kind: 'tenant',
        tenantSlug: resolvedSlug,
        authHeader: `Bearer ${syntheticToken}`,
      };
      return tool.handler(tenantContext, rest);
    },
  };
}

module.exports = READABLE_TENANT_TOOL_MODULES.flatMap(({ tools, category }) => tools.map((t) => wrapForCrossTenant(t, category)));
