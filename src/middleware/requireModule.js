/**
 * Guards a tenant-scoped router so it only responds if the company has the
 * required module enabled. This is what makes Cajo (has attendance) and
 * OGTrack (doesn't) behave differently against the SAME codebase.
 *
 * Must run AFTER resolveTenantMiddleware (needs req.company populated).
 *
 * Usage:
 *   app.use('/api/:slug/attendance', resolveTenant, requireModule('attendance'), attendanceRoutes);
 *   app.use('/api/:slug/hr', resolveTenant, requireModule(['hr_dashboard','hr_jobs']), hrRoutes); // any one is enough
 */
function requireModule(moduleKeyOrKeys) {
  const acceptable = Array.isArray(moduleKeyOrKeys) ? moduleKeyOrKeys : [moduleKeyOrKeys];
  return (req, res, next) => {
    const enabled = req.company && Array.isArray(req.company.enabled_modules)
      ? req.company.enabled_modules
      : [];
    if (!acceptable.some(k => enabled.includes(k))) {
      return res.status(403).json({
        error: `Module "${acceptable.join('" or "')}" is not enabled for this company.`,
        module: acceptable[0],
      });
    }
    next();
  };
}

module.exports = requireModule;