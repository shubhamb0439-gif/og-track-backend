const { resolveTenant } = require('../db/tenantConnections');

/**
 * Mount under any router that's tenant-scoped, e.g.:
 *   app.use('/api/:slug', resolveTenantMiddleware, tenantRoutes);
 *
 * After this runs, every route handler downstream can just use:
 *   req.db       -> Knex instance for THIS tenant's database
 *   req.company  -> the company row from OGCore (branding, enabled_modules)
 *
 * Nothing downstream needs to know or care about companyId filtering —
 * the connection itself is already scoped to the right tenant.
 */
async function resolveTenantMiddleware(req, res, next) {
  try {
    const { slug } = req.params;
    const { company, db } = await resolveTenant(slug);
    req.company = company;
    req.db = db;
    next();
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
}

module.exports = resolveTenantMiddleware;
