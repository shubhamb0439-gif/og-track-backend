const jwt = require('jsonwebtoken');
const config = require('../../config');
const { MASTERADMIN_SENTINEL_MODULE } = require('../contextBuilder');

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
const READABLE_TENANT_TOOL_MODULES = [
  require('./attendance'),
  require('./projects'),
  require('./crm'),
  require('./inventory'),
  require('./finance'),
  require('./hr'),
];

function wrapForCrossTenant(tool) {
  const originalProperties = (tool.inputSchema && tool.inputSchema.properties) || {};
  const originalRequired = (tool.inputSchema && tool.inputSchema.required) || [];

  return {
    name: `masteradmin_${tool.name}`,
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
        { userId: context.userId, role: 'superadmin', slug: companySlug },
        config.app.jwtSecret,
        { expiresIn: '5m' }
      );
      const tenantContext = {
        ...context,
        kind: 'tenant',
        tenantSlug: companySlug,
        authHeader: `Bearer ${syntheticToken}`,
      };
      return tool.handler(tenantContext, rest);
    },
  };
}

module.exports = READABLE_TENANT_TOOL_MODULES.flat().map(wrapForCrossTenant);
