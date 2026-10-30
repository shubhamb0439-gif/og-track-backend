const express = require('express');
const requireRole = require('../middleware/requireRole');

const router = express.Router();

// Test Module — a lightweight diagnostic/smoke-test utility for testers and
// developers to confirm the full stack (frontend -> backend -> this
// tenant's own database) is wired up correctly in a given environment.
// Deliberately has no real business data model: the only thing persisted is
// a short log of "checks" someone has run, purely so the page has something
// real to show rather than being a dead end.
//
// Mounted in server.js as:
//   app.use('/api/:slug/test_module', resolveTenant, requireModule('test_module'), requireAuth, test_moduleRoutes);
// requireAuth (above) guarantees req.auth exists; this additionally locks
// every route in this file to the 'tester' and 'developer' roles only —
// nobody else at a company that has this module enabled can see or use it.
router.use(requireRole(['tester', 'developer']));

// Rehydrate a DB row into the shape the frontend expects (camelCase, parsed JSON).
function rowToCheck(row) {
  if (!row) return row;
  return {
    id: row.id,
    userId: row.user_id,
    role: row.role || null,
    note: row.note || '',
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : (row.created_at || null),
    extra: row.extra_json ? JSON.parse(row.extra_json) : {},
  };
}

// GET /api/:slug/test_module — most recent checks run against this module
// (newest first), so a tester/developer can see the history of smoke tests.
router.get('/', async (req, res) => {
  try {
    const rows = await req.db('test_module_checks').orderBy('created_at', 'desc').limit(100);
    res.json(rows.map(rowToCheck));
  } catch (e) {
    console.error('GET /test_module failed:', e);
    res.status(500).json({ error: 'Could not load Test Module checks. Please try again.' });
  }
});

// POST /api/:slug/test_module — record a new check ("ping") confirming the
// stack is reachable. Frontend sends: { note? }
router.post('/', async (req, res) => {
  try {
    const note = req.body && req.body.note != null ? String(req.body.note).slice(0, 500) : '';
    const id = 'tmchk' + Date.now() + Math.floor(Math.random() * 1000);
    const now = new Date();
    await req.db('test_module_checks').insert({
      id,
      user_id: req.auth.userId,
      role: req.auth.role || null,
      note,
      created_at: now,
    });
    const saved = rowToCheck(await req.db('test_module_checks').where({ id }).first());
    req.io.to(req.company.slug).emit('test_module:created', saved);
    res.json(saved);
  } catch (e) {
    console.error('POST /test_module failed:', e);
    res.status(500).json({ error: 'Could not save that check. Please try again.' });
  }
});

module.exports = router;
