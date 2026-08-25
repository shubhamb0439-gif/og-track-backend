const express = require('express');

const router = express.Router();

const ALLOWED_STATUS = new Set(['pending', 'in_progress', 'done']);
const ALLOWED_PRIORITY = new Set(['low', 'normal', 'high']);

// Rehydrate a DB row into the shape the frontend expects (camelCase, parsed JSON).
function rowToTodo(row) {
  if (!row) return row;
  const dTime = (v) => { if (!v) return null; return (v instanceof Date) ? v.toISOString() : new Date(v).toISOString(); };
  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    status: row.status,
    priority: row.priority,
    dueDate: row.due_date ? (row.due_date instanceof Date ? row.due_date.toISOString().slice(0, 10) : String(row.due_date).slice(0, 10)) : null,
    assignedTo: row.assigned_to || null,
    assignedToName: row.assigned_to_name || null,
    createdBy: row.created_by || null,
    createdByName: row.created_by_name || null,
    createdAt: dTime(row.created_at),
    updatedAt: dTime(row.updated_at),
    completedAt: dTime(row.completed_at),
    extra: row.extra_json ? JSON.parse(row.extra_json) : {},
  };
}

// GET /api/:slug/to_do_list/counts — small summary used by the dashboard section widget.
router.get('/counts', async (req, res) => {
  try {
    let q = req.db('todo_items').select('status');
    if (req.query.userId) q = q.where('assigned_to', req.query.userId);
    const rows = await q;
    const counts = { total: rows.length, pending: 0, in_progress: 0, done: 0 };
    for (const r of rows) {
      if (counts[r.status] !== undefined) counts[r.status]++;
    }
    res.json(counts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/:slug/to_do_list?userId=...&status=...&limit=...
// userId filters to items assigned to that user OR unassigned (shared) items.
// limit is used by the compact section widget to only pull a handful of rows.
router.get('/', async (req, res) => {
  try {
    let q = req.db('todo_items').orderBy([{ column: 'status', order: 'asc' }, { column: 'created_at', order: 'desc' }]);
    if (req.query.status) q = q.where('status', req.query.status);
    if (req.query.userId) q = q.where(function () { this.where('assigned_to', req.query.userId).orWhereNull('assigned_to'); });
    if (req.query.limit) q = q.limit(Number(req.query.limit) || 5);
    const rows = await q;
    res.json(rows.map(rowToTodo));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/to_do_list
// Frontend sends: { title, description, priority, dueDate, assignedTo, assignedToName, createdBy, createdByName }
router.post('/', async (req, res) => {
  try {
    const body = { ...req.body };
    if (!body.title || !String(body.title).trim()) {
      return res.status(400).json({ error: 'title is required' });
    }
    if (body.priority && !ALLOWED_PRIORITY.has(body.priority)) {
      return res.status(400).json({ error: 'priority must be one of low, normal, high' });
    }

    const id = 'todo' + Date.now() + Math.floor(Math.random() * 1000);
    const now = new Date();
    const { title, description, priority, dueDate, assignedTo, assignedToName, createdBy, createdByName, ...rest } = body;

    const item = {
      id,
      title: String(title).trim(),
      description: description || null,
      status: 'pending',
      priority: priority || 'normal',
      due_date: dueDate || null,
      assigned_to: assignedTo || null,
      assigned_to_name: assignedToName || null,
      created_by: createdBy || null,
      created_by_name: createdByName || null,
      created_at: now,
      extra_json: Object.keys(rest).length ? JSON.stringify(rest) : null,
    };
    await req.db('todo_items').insert(item);

    const saved = rowToTodo(await req.db('todo_items').where({ id }).first());
    req.io.to(req.company.slug).emit('todo:created', saved);
    res.json(saved);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/:slug/to_do_list/:id
// Frontend sends any subset of: { title, description, status, priority, dueDate, assignedTo, assignedToName }
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await req.db('todo_items').where({ id }).first();
    if (!existing) return res.status(404).json({ error: 'To-do item not found' });

    const body = { ...req.body };
    if (body.status !== undefined && !ALLOWED_STATUS.has(body.status)) {
      return res.status(400).json({ error: 'status must be one of pending, in_progress, done' });
    }
    if (body.priority !== undefined && !ALLOWED_PRIORITY.has(body.priority)) {
      return res.status(400).json({ error: 'priority must be one of low, normal, high' });
    }

    const updates = { updated_at: new Date() };
    if (body.title !== undefined) updates.title = body.title;
    if (body.description !== undefined) updates.description = body.description;
    if (body.priority !== undefined) updates.priority = body.priority;
    if (body.dueDate !== undefined) updates.due_date = body.dueDate;
    if (body.assignedTo !== undefined) updates.assigned_to = body.assignedTo;
    if (body.assignedToName !== undefined) updates.assigned_to_name = body.assignedToName;
    if (body.status !== undefined) {
      updates.status = body.status;
      if (body.status === 'done' && !existing.completed_at) updates.completed_at = new Date();
      if (body.status !== 'done') updates.completed_at = null;
    }

    await req.db('todo_items').where({ id }).update(updates);
    const saved = rowToTodo(await req.db('todo_items').where({ id }).first());
    req.io.to(req.company.slug).emit('todo:updated', saved);
    res.json(saved);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/:slug/to_do_list/:id
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await req.db('todo_items').where({ id }).first();
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await req.db('todo_items').where({ id }).delete();
    req.io.to(req.company.slug).emit('todo:deleted', { id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
