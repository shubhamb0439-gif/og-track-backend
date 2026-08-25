const express = require('express');
const router = express.Router();

// Rehydrate a DB row into the shape the frontend expects (camelCase, parsed JSON).
function rowToTodo(row) {
  if (!row) return row;
  return {
    id: row.id,
    title: row.title,
    notes: row.notes || null,
    isCompleted: !!row.is_completed,
    createdBy: row.created_by || null,
    completedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : (row.completed_at || null),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : (row.created_at || null),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : (row.updated_at || null),
    extra: row.extra_json ? JSON.parse(row.extra_json) : {},
  };
}

// GET /api/:slug/super_admin_todo_list — list all tasks, newest first.
// Optional ?status=completed|pending filter for the sidebar's active-count badge etc.
router.get('/', async (req, res) => {
  try {
    let q = req.db('super_admin_todos').orderBy('created_at', 'desc');
    if (req.query.status === 'completed') q = q.where('is_completed', 1);
    if (req.query.status === 'pending') q = q.where('is_completed', 0);
    const rows = await q;
    res.json(rows.map(rowToTodo));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/super_admin_todo_list — add a task.
// Body: { title, notes?, createdBy? }
router.post('/', async (req, res) => {
  try {
    const { title, notes, createdBy, ...rest } = req.body;
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'title is required' });
    }
    const id = 'todo' + Date.now() + Math.random().toString(36).slice(2, 8);
    const now = new Date();
    const todo = {
      id,
      title: String(title).trim(),
      notes: notes || null,
      is_completed: 0,
      created_by: createdBy || null,
      created_at: now,
      extra_json: Object.keys(rest).length ? JSON.stringify(rest) : null,
    };
    await req.db('super_admin_todos').insert(todo);
    const saved = rowToTodo(await req.db('super_admin_todos').where({ id }).first());
    req.io.to(req.company.slug).emit('super_admin_todo:created', saved);
    res.json(saved);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/:slug/super_admin_todo_list/:id — edit a task and/or toggle completion.
// Body may include any of: { title, notes, isCompleted }
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await req.db('super_admin_todos').where({ id }).first();
    if (!existing) return res.status(404).json({ error: 'Task not found' });

    const updates = { updated_at: new Date() };
    if (req.body.title !== undefined) updates.title = String(req.body.title).trim();
    if (req.body.notes !== undefined) updates.notes = req.body.notes;
    if (req.body.isCompleted !== undefined) {
      updates.is_completed = req.body.isCompleted ? 1 : 0;
      updates.completed_at = req.body.isCompleted ? new Date() : null;
    }

    await req.db('super_admin_todos').where({ id }).update(updates);
    const todo = rowToTodo(await req.db('super_admin_todos').where({ id }).first());
    req.io.to(req.company.slug).emit('super_admin_todo:updated', todo);
    res.json(todo);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/:slug/super_admin_todo_list/:id
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await req.db('super_admin_todos').where({ id }).first();
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await req.db('super_admin_todos').where({ id }).delete();
    req.io.to(req.company.slug).emit('super_admin_todo:deleted', { id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
