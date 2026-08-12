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
    description:
      `${tool.description} Master-admin cross-tenant view — pass companySlug to target a specific ` +
      "company. If the user names a company rather than its slug, call masteradmin_list_companies first to resolve it.",
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
      const tenantContext = { ...context, kind: 'tenant', tenantSlug: companySlug };
      return tool.handler(tenantContext, rest);
    },
  };
}

module.exports = READABLE_TENANT_TOOL_MODULES.flat().map(wrapForCrossTenant);
