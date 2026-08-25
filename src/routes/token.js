const express = require('express');

const router = express.Router();

// Rehydrate a DB row into the shape the frontend expects (camelCase, parsed JSON).
function rowToToken(row) {
  if (!row) return row;
  const dTime = (v) => { if (!v) return null; return (v instanceof Date) ? v.toISOString() : new Date(v).toISOString(); };
  return {
    id: row.id,
    name: row.name,
    consumed: row.consumed == null ? 0 : Number(row.consumed),
    createdBy: row.created_by || null,
    createdByName: row.created_by_name || null,
    createdAt: dTime(row.created_at),
    updatedAt: dTime(row.updated_at),
    extra: row.extra_json ? JSON.parse(row.extra_json) : {},
  };
}

// GET /api/:slug/token — list all tokens, newest first.
router.get('/', async (req, res) => {
  try {
    let q = req.db('tokens').orderBy('created_at', 'desc');
    if (req.query.limit) q = q.limit(Number(req.query.limit) || 20);
    const rows = await q;
    res.json(rows.map(rowToToken));
  } catch (e) { console.error('GET /token failed:', e); res.status(500).json({ error: 'Could not load tokens. Please try again.' }); }
});

// POST /api/:slug/token
// Frontend sends: { name, consumed, createdBy, createdByName }
router.post('/', async (req, res) => {
  try {
    const body = { ...req.body };
    if (!body.name || !String(body.name).trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const consumed = Number(body.consumed);
    if (body.consumed === undefined || body.consumed === null || body.consumed === '' || Number.isNaN(consumed)) {
      return res.status(400).json({ error: 'consumed must be a number' });
    }

    const id = 'tok' + Date.now() + Math.floor(Math.random() * 1000);
    const now = new Date();
    const { name, consumed: _consumed, createdBy, createdByName, ...rest } = body;

    const item = {
      id,
      name: String(name).trim(),
      consumed,
      created_by: createdBy || null,
      created_by_name: createdByName || null,
      created_at: now,
      extra_json: Object.keys(rest).length ? JSON.stringify(rest) : null,
    };
    await req.db('tokens').insert(item);

    const saved = rowToToken(await req.db('tokens').where({ id }).first());
    req.io.to(req.company.slug).emit('token:created', saved);
    res.json(saved);
  } catch (e) { console.error('POST /token failed:', e); res.status(500).json({ error: 'Could not add token. Please try again.' }); }
});

// DELETE /api/:slug/token/:id
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await req.db('tokens').where({ id }).first();
    if (!existing) return res.status(404).json({ error: 'Token not found' });
    await req.db('tokens').where({ id }).delete();
    req.io.to(req.company.slug).emit('token:deleted', { id });
    res.json({ success: true });
  } catch (e) { console.error('DELETE /token/:id failed:', e); res.status(500).json({ error: 'Could not delete token. Please try again.' }); }
});

module.exports = router;
