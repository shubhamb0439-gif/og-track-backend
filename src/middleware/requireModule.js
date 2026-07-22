/**
 * Guards a tenant-scoped router so it only responds if the company has the
 * required module enabled. This is what makes Cajo (has attendance) and
 * OGTrack (doesn't) behave differently against the SAME codebase.
 *
 * Must run AFTER resolveTenantMiddleware (needs req.company populated).
 *
 * Usage:
 *   app.use('/api/:slug/attendance', resolveTenant, requireModule('attendance'), attendanceRoutes);
 */
function requireModule(moduleKey) {
  return (req, res, next) => {
    const enabled = req.company && Array.isArray(req.company.enabled_modules)
      ? req.company.enabled_modules
      : [];
    if (!enabled.includes(moduleKey)) {
      return res.status(403).json({
        error: `Module "${moduleKey}" is not enabled for this company.`,
        module: moduleKey,
      });
    }
    next();
  };
}

module.exports = requireModule;
