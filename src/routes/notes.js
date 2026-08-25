const express = require('express');

const router = express.Router();

// Rehydrate a DB row into the shape the frontend expects (camelCase, parsed JSON).
function rowToNote(row) {
  if (!row) return row;
  const dTime = (v) => { if (!v) return null; return (v instanceof Date) ? v.toISOString() : new Date(v).toISOString(); };
  return {
    id: row.id,
    userId: row.user_id,
    content: row.content || '',
    createdAt: dTime(row.created_at),
    updatedAt: dTime(row.updated_at),
    extra: row.extra_json ? JSON.parse(row.extra_json) : {},
  };
}

// GET /api/:slug/notes?userId=... — this user's private note (or an empty
// placeholder if they haven't saved one yet). Never returns another user's note.
router.get('/', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    const row = await req.db('notes').where({ user_id: userId }).first();
    if (!row) return res.json({ id: null, userId, content: '', createdAt: null, updatedAt: null, extra: {} });
    res.json(rowToNote(row));
  } catch (e) { console.error('GET /notes failed:', e); res.status(500).json({ error: 'Could not load your note. Please try again.' }); }
});

// POST /api/:slug/notes — save (create or overwrite) the calling user's note.
// Frontend sends: { userId, content }
router.post('/', async (req, res) => {
  try {
    const body = { ...req.body };
    if (!body.userId || !String(body.userId).trim()) {
      return res.status(400).json({ error: 'userId is required' });
    }
    const userId = String(body.userId).trim();
    const content = body.content == null ? '' : String(body.content);
    const now = new Date();

    const existing = await req.db('notes').where({ user_id: userId }).first();
    if (existing) {
      await req.db('notes').where({ user_id: userId }).update({ content, updated_at: now });
    } else {
      const id = 'note' + Date.now() + Math.floor(Math.random() * 1000);
      await req.db('notes').insert({ id, user_id: userId, content, created_at: now });
    }

    const saved = rowToNote(await req.db('notes').where({ user_id: userId }).first());
    req.io.to(req.company.slug).emit('notes:saved', saved);
    res.json(saved);
  } catch (e) { console.error('POST /notes failed:', e); res.status(500).json({ error: 'Could not save your note. Please try again.' }); }
});

module.exports = router;
