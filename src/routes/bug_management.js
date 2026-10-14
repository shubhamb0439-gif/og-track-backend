const express = require('express');
const requireRole = require('../middleware/requireRole');

const router = express.Router();

// Entire module is Tester-only — requireAuth runs upstream in server.js
// (same mounting pattern as test-cases), this restricts every route here
// (GET included — unlike test-cases, there's no "open to any authenticated
// user" read access for this module; visibility itself is restricted to
// Tester per spec).
router.use(requireRole('tester'));

// Rehydrate a dbo.bugs row into the shape this module's frontend expects.
function rowToBug(row) {
  if (!row) return row;
  const dTime = (v) => { if (!v) return null; return (v instanceof Date) ? v.toISOString() : new Date(v).toISOString(); };
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    title: row.title,
    description: row.description,
    status: row.status,
    reporter: row.reporter,
    assignee: row.assignee,
    priorityRank: row.priority_rank === null || row.priority_rank === undefined ? null : Number(row.priority_rank),
    assignedDeveloperId: row.assigned_developer_id || null,
    assignedDeveloperName: row.assigned_developer_name || null,
    createdAt: dTime(row.created_at),
    updatedAt: dTime(row.updated_at),
  };
}

// GET /api/:slug/bug_management?projectId=...&status=...
// Ranked bugs first (lowest priority_rank = highest priority), then
// unranked bugs, newest first.
router.get('/', async (req, res) => {
  try {
    let q = req.db('bugs').orderBy([
      { column: req.db.raw('CASE WHEN priority_rank IS NULL THEN 1 ELSE 0 END') },
      { column: 'priority_rank', order: 'asc' },
      { column: 'created_at', order: 'desc' },
    ]);
    if (req.query.projectId) q = q.where('project_id', req.query.projectId);
    if (req.query.status) q = q.where('status', req.query.status);
    const rows = await q;
    res.json(rows.map(rowToBug));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/:slug/bug_management/developers — users eligible to be assigned
// to a bug, for the assignment dropdown.
router.get('/developers', async (req, res) => {
  try {
    const rows = await req.db('users').where({ role: 'developer' }).select('id', 'name', 'email');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/:slug/bug_management/reorder
// body: { orderedIds: ['BUG-003', 'BUG-001', 'BUG-002'] } — first id becomes
// the highest priority (priority_rank = 1), and so on down the list. Only
// touches bugs whose id is actually present in the list.
router.patch('/reorder', async (req, res) => {
  try {
    const orderedIds = Array.isArray(req.body.orderedIds) ? req.body.orderedIds : null;
    if (!orderedIds || !orderedIds.length) {
      return res.status(400).json({ error: 'orderedIds (non-empty array) is required' });
    }
    const now = new Date();
    for (let i = 0; i < orderedIds.length; i++) {
      await req.db('bugs').where({ id: orderedIds[i] }).update({ priority_rank: i + 1, updated_at: now });
    }
    const rows = await req.db('bugs').whereIn('id', orderedIds);
    const byId = new Map(rows.map(r => [r.id, r]));
    const ordered = orderedIds.map(id => byId.get(id)).filter(Boolean).map(rowToBug);
    req.io.to(req.company.slug).emit('bugManagement:reordered', ordered);
    res.json(ordered);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/:slug/bug_management/:id/assign
// body: { developerId, developerName } — pass developerId: null to unassign.
router.patch('/:id/assign', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await req.db('bugs').where({ id }).first();
    if (!existing) return res.status(404).json({ error: 'Bug not found' });

    const { developerId, developerName } = req.body;
    const updates = {
      assigned_developer_id: developerId || null,
      assigned_developer_name: developerId ? (developerName || null) : null,
      updated_at: new Date(),
    };
    await req.db('bugs').where({ id }).update(updates);
    const saved = rowToBug(await req.db('bugs').where({ id }).first());

    if (saved.assignedDeveloperId) {
      const pname = saved.projectName ? `[${saved.projectName}] ` : '';
      req.io.to(req.company.slug).emit('notification', {
        to: 'developer', icon: '🧑‍💻', bugId: id, time: new Date().toISOString(), read: false,
        msg: `${pname}You were assigned bug ${id}: "${saved.title}"`,
      });
    }
    req.io.to(req.company.slug).emit('bugManagement:assigned', saved);
    res.json(saved);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
