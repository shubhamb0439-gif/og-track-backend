/** Express middleware: requires req.auth (set by requireAuth) to carry one of the allowed roles. */
module.exports = function requireRole(allowedRoles) {
  const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
  return (req, res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      return res.status(403).json({ error: 'Forbidden — requires role: ' + roles.join(' or ') });
    }
    next();
  };
};
