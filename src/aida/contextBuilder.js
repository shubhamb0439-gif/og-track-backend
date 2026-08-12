/**
 * Every AIDA request carries an AidaContext — the one object every tool and
 * the engine read from. Nothing here is decided by AIDA itself: identity
 * comes from the verified JWT (auth.js), module access comes from
 * req.company.enabled_modules (set by the existing resolveTenant
 * middleware), and page/module/route awareness comes from whatever the
 * frontend says it's currently showing.
 */

const MASTERADMIN_SENTINEL_MODULE = '__masteradmin__';

function buildTenantContext(req) {
  const ui = req.body?.pageContext || {};
  return {
    kind: 'tenant',
    tenantSlug: req.company.slug,
    companyId: req.company.id,
    companyName: req.company.name,
    userId: req.auth.userId,
    role: req.auth.role,
    enabledModules: req.company.enabled_modules || [],
    authHeader: req.headers.authorization,
    currentPage: ui.page || null,
    currentModule: ui.module || null,
    currentRoute: ui.route || null,
    activeEntity: ui.activeEntity || null, // e.g. { type: 'sprint', id: 's123', name: 'Sprint 24' }
  };
}

function buildMasterAdminContext(req) {
  const ui = req.body?.pageContext || {};
  return {
    kind: 'masteradmin',
    tenantSlug: null,
    companyId: null,
    companyName: null,
    userId: req.admin.adminId,
    role: 'masteradmin',
    enabledModules: [MASTERADMIN_SENTINEL_MODULE],
    authHeader: req.headers.authorization,
    currentPage: ui.page || null,
    currentModule: ui.module || null,
    currentRoute: ui.route || null,
    activeEntity: ui.activeEntity || null,
  };
}

module.exports = { buildTenantContext, buildMasterAdminContext, MASTERADMIN_SENTINEL_MODULE };
