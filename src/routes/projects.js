const express = require('express');
const { splitKnown, packExtra, unpackRow } = require('../utils/fields');
const router = express.Router();

// Maps the fields the frontend sends (camelCase) to real DB columns.
// Anything not listed here (managers[], developers[], testers[], companyId, ...)
// falls through to extra_json automatically.
const FIELD_MAP = {
  name: 'name',
  shortCode: 'short_code',
  short_code: 'short_code',
  description: 'description',
  status: 'status',
};

// GET /api/:slug/projects
router.get('/', async (req, res) => {
  try {
    const rows = await req.db('projects').orderBy('created_at', 'desc');
    res.json(rows.map(unpackRow));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/projects
router.post('/', async (req, res) => {
  try {
    const { known, extra } = splitKnown(req.body, FIELD_MAP);
    if (!known.name || !known.short_code) {
      return res.status(400).json({ error: 'name and short_code are required' });
    }
    const existing = await req.db('projects').where({ short_code: known.short_code }).first();
    if (existing) return res.status(400).json({ error: `Short code "${known.short_code}" is already used by another project.` });

    const id = 'p' + Date.now();
    const row = {
      id,
      name: known.name,
      short_code: known.short_code,
      description: known.description || null,
      status: known.status || 'active',
      extra_json: packExtra(extra),
    };
    await req.db('projects').insert(row);

    const saved = unpackRow(await req.db('projects').where({ id }).first());
    req.io.to(req.company.slug).emit('project:created', saved);
    res.json(saved);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/:slug/projects/:id
router.patch('/:id', async (req, res) => {
  try {
    const { known, extra } = splitKnown(req.body, FIELD_MAP);

    if (known.short_code) {
      const conflict = await req.db('projects').where({ short_code: known.short_code }).whereNot({ id: req.params.id }).first();
      if (conflict) return res.status(400).json({ error: `Short code "${known.short_code}" is already used by another project.` });
    }

    const current = await req.db('projects').where({ id: req.params.id }).first();
    if (!current) return res.status(404).json({ error: 'Project not found' });
    const mergedExtra = { ...(current.extra_json ? JSON.parse(current.extra_json) : {}), ...extra };

    const updates = { ...known, extra_json: packExtra(mergedExtra), updated_at: new Date() };
    await req.db('projects').where({ id: req.params.id }).update(updates);

    const saved = unpackRow(await req.db('projects').where({ id: req.params.id }).first());
    req.io.to(req.company.slug).emit('project:updated', saved);
    res.json(saved);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/:slug/projects/:id
router.delete('/:id', async (req, res) => {
  try {
    await req.db('projects').where({ id: req.params.id }).delete();
    req.io.to(req.company.slug).emit('project:deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
