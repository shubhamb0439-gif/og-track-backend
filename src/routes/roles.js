const express = require('express');
const router = express.Router();

function rowToRole(r) {
  return { ...r, permissions: JSON.parse(r.permissions || '[]') };
}

// GET /api/:slug/roles
router.get('/', async (req, res) => {
  try {
    const rows = await req.db('custom_roles').orderBy('created_at', 'desc');
    res.json(rows.map(rowToRole));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/roles
router.post('/', async (req, res) => {
  try {
    const { name, permissions } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const id = 'r' + Date.now();
    const role = { id, name, permissions: JSON.stringify(permissions || []) };
    await req.db('custom_roles').insert(role);
    const saved = rowToRole(await req.db('custom_roles').where({ id }).first());
    req.io.to(req.company.slug).emit('role:created', saved);
    res.json({ success: true, ...saved });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/:slug/roles/:id
router.patch('/:id', async (req, res) => {
  try {
    const { name, permissions } = req.body;
    await req.db('custom_roles').where({ id: req.params.id }).update({
      name,
      permissions: JSON.stringify(permissions || []),
    });
    req.io.to(req.company.slug).emit('role:updated', { id: req.params.id, name, permissions });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/:slug/roles/:id
router.delete('/:id', async (req, res) => {
  try {
    await req.db('custom_roles').where({ id: req.params.id }).delete();
    req.io.to(req.company.slug).emit('role:deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
