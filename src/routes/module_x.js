const express = require('express');
const { requireAuth } = require('../utils/auth');
const requireRole = require('../middleware/requireRole');

/**
 * Module X — a minimal module accessible only to managers.
 *
 * Mount: app.use('/api/:slug/module_x', resolveTenant, requireModule('module_x'), module_xRoutes)
 * — same pattern as every other tenant router, requireAuth/requireRole
 * applied per-route below rather than once for the whole router, matching
 * zoho.js's / attendance.js's own mixed-gating convention.
 */

const router = express.Router();
const ALLOWED_ROLES = ['manager'];

// GET /api/:slug/module_x — the module's one screen: a simple text message.
router.get('/', requireAuth, requireRole(ALLOWED_ROLES), async (req, res) => {
  try {
    res.json({ message: 'test' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
