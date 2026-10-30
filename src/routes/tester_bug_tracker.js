const express = require('express');

const router = express.Router();

const ALLOWED_STATUS = new Set(['open', 'in_progress', 'resolved']);
const ALLOWED_PRIORITY = new Set(['Low', 'Medium', 'High']);

// Rehydrate a DB row into the shape the frontend expects (camelCase, parsed JSON).
function rowToBug(row) {
  if (!row) return row;
  const dTime = (v) => { if (!v) return null; return (v instanceof Date) ? v.toISOString() : new Date(v).toISOString(); };
  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    priority: row.priority,
    status: row.status,
    createdBy: row.created_by || null,
    createdByName: row.created_by_name || null,
    createdAt: dTime(row.created_at),
    updatedAt: dTime(row.updated_at),
    resolvedAt: dTime(row.resolved_at),
    extra: row.extra_json ? JSON.parse(row.extra_json) : {},
  };
}

// GET /api/:slug/tester_bug_tracker/counts — small summary for a dashboard widget.
router.get('/counts', async (req, res) => {
  try {
    const rows = await req.db('tester_bugs').select('status', 'priority');
    const counts = { total: rows.length, open: 0, in_progress: 0, resolved: 0, high: 0 };
    for (const r of rows) {
      if (counts[r.status] !== undefined) counts[r.status]++;
      if (r.priority === 'High') counts.high++;
    }
    res.json(counts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/:slug/tester_bug_tracker?status=...&priority=...
router.get('/', async (req, res) => {
  try {
    let q = req.db('tester_bugs').orderBy('created_at', 'desc');
    if (req.query.status) q = q.where('status', req.query.status);
    if (req.query.priority) q = q.where('priority', req.query.priority);
    const rows = await q;
    res.json(rows.map(rowToBug));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/:slug/tester_bug_tracker/:id
router.get('/:id', async (req, res) => {
  try {
    const row = await req.db('tester_bugs').where({ id: req.params.id }).first();
    if (!row) return res.status(404).json({ error: 'Bug not found' });
    res.json(rowToBug(row));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/tester_bug_tracker
// Frontend sends: { title, description, priority, createdBy, createdByName }
router.post('/', async (req, res) => {
  try {
    const body = { ...req.body };
    if (!body.title || !String(body.title).trim()) {
      return res.status(400).json({ error: 'title is required' });
    }
    if (body.priority && !ALLOWED_PRIORITY.has(body.priority)) {
      return res.status(400).json({ error: 'priority must be one of Low, Medium, High' });
    }

    const id = 'tbug' + Date.now() + Math.floor(Math.random() * 1000);
    const now = new Date();
    const { title, description, priority, createdBy, createdByName, ...rest } = body;

    const bug = {
      id,
      title: String(title).trim(),
      description: description || null,
      priority: priority || 'Medium',
      status: 'open',
      created_by: createdBy || null,
      created_by_name: createdByName || null,
      created_at: now,
      extra_json: Object.keys(rest).length ? JSON.stringify(rest) : null,
    };
    await req.db('tester_bugs').insert(bug);

    const saved = rowToBug(await req.db('tester_bugs').where({ id }).first());
    req.io.to(req.company.slug).emit('tester_bug:created', saved);
    res.json(saved);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/:slug/tester_bug_tracker/:id
// Frontend sends any subset of: { title, description, priority, status }
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await req.db('tester_bugs').where({ id }).first();
    if (!existing) return res.status(404).json({ error: 'Bug not found' });

    const body = { ...req.body };
    if (body.status !== undefined && !ALLOWED_STATUS.has(body.status)) {
      return res.status(400).json({ error: 'status must be one of open, in_progress, resolved' });
    }
    if (body.priority !== undefined && !ALLOWED_PRIORITY.has(body.priority)) {
      return res.status(400).json({ error: 'priority must be one of Low, Medium, High' });
    }

    const updates = { updated_at: new Date() };
    if (body.title !== undefined) updates.title = body.title;
    if (body.description !== undefined) updates.description = body.description;
    if (body.priority !== undefined) updates.priority = body.priority;
    if (body.status !== undefined) {
      updates.status = body.status;
      if (body.status === 'resolved' && !existing.resolved_at) updates.resolved_at = new Date();
      if (body.status !== 'resolved') updates.resolved_at = null;
    }

    await req.db('tester_bugs').where({ id }).update(updates);
    const saved = rowToBug(await req.db('tester_bugs').where({ id }).first());
    req.io.to(req.company.slug).emit('tester_bug:updated', saved);
    res.json(saved);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/:slug/tester_bug_tracker/:id
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await req.db('tester_bugs').where({ id }).first();
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await req.db('tester_bugs').where({ id }).delete();
    req.io.to(req.company.slug).emit('tester_bug:deleted', { id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
