const express = require('express');
const router = express.Router();

// SQL DATE → 'YYYY-MM-DD' string
const dOnly = (v) => { if (!v) return null; return (v instanceof Date) ? v.toISOString().slice(0,10) : String(v).slice(0,10); };
const dTime = (v) => { if (!v) return null; return (v instanceof Date) ? v.toISOString() : new Date(v).toISOString(); };

// Frontend expects: id, projectId, name, startDate, endDate, status, goal, createdAt
const mapSprint = (r) => r && ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  startDate: dOnly(r.start_date),
  endDate: dOnly(r.end_date),
  status: r.status,
  goal: r.goal || null,
  createdAt: dTime(r.created_at),
  extra: r.extra_json ? JSON.parse(r.extra_json) : {},
});

// GET /api/:slug/sprints?projectId=...
router.get('/', async (req, res) => {
  try {
    let q = req.db('sprints').orderBy('created_at', 'desc');
    if (req.query.projectId) q = q.where('project_id', req.query.projectId);
    res.json((await q).map(mapSprint));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/sprints — frontend sends { name, startDate, endDate, goal, projectId, status }
router.post('/', async (req, res) => {
  try {
    const { name, startDate, endDate, goal, projectId, status, ...rest } = req.body;
    if (!projectId || !name) return res.status(400).json({ error: 'projectId and name are required' });
    const id = 's' + Date.now();
    await req.db('sprints').insert({
      id,
      project_id: projectId,
      name,
      start_date: startDate || null,
      end_date: endDate || null,
      status: status || 'planned',
      goal: goal || null,
      extra_json: Object.keys(rest).length ? JSON.stringify(rest) : null,
    });
    res.json(mapSprint(await req.db('sprints').where({ id }).first()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/:slug/sprints/:id — frontend sends camelCase fields
router.patch('/:id', async (req, res) => {
  try {
    const { startDate, endDate, projectId, ...rest } = req.body;
    const upd = { ...rest, updated_at: new Date() };
    if (startDate !== undefined) upd.start_date = startDate;
    if (endDate !== undefined) upd.end_date = endDate;
    if (projectId !== undefined) upd.project_id = projectId;
    // remove camelCase keys that would hit unknown-column errors
    delete upd.startDate; delete upd.endDate; delete upd.projectId; delete upd.createdAt; delete upd.extra;
    await req.db('sprints').where({ id: req.params.id }).update(upd);
    const row = await req.db('sprints').where({ id: req.params.id }).first();
    if (!row) return res.status(404).json({ error: 'Sprint not found' });
    res.json(mapSprint(row));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/:slug/sprints/:id
router.delete('/:id', async (req, res) => {
  try {
    await req.db('sprints').where({ id: req.params.id }).delete();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;