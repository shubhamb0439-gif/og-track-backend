const express = require('express');
const router = express.Router();
const { nextCounter, formatCode } = require('../utils/counters');
const requireRole = require('../middleware/requireRole');

// Rehydrate a DB row into the shape the frontend expects.
function mapTestCase(row) {
  if (!row) return row;
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    expectedResult: row.expected_result,
    actualResult: row.actual_result,
    status: row.status,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : (row.created_at || null),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : (row.updated_at || null),
    extra: row.extra_json ? JSON.parse(row.extra_json) : {},
  };
}

// GET /api/:slug/test-cases?projectId=...
router.get('/', async (req, res) => {
  try {
    let q = req.db('test_cases').orderBy('created_at', 'desc');
    if (req.query.projectId) q = q.where('project_id', req.query.projectId);
    res.json((await q).map(mapTestCase));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/:slug/test-cases/:id
router.get('/:id', async (req, res) => {
  try {
    const row = await req.db('test_cases').where({ id: req.params.id }).first();
    if (!row) return res.status(404).json({ error: 'Test case not found' });
    res.json(mapTestCase(row));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/test-cases — Tester only
router.post('/', requireRole('tester'), async (req, res) => {
  try {
    const { projectId, title, description, expectedResult, actualResult, status, ...rest } = req.body;
    if (!projectId || !title) return res.status(400).json({ error: 'projectId and title are required' });

    const project = await req.db('projects').where({ id: projectId }).first();
    if (!project) return res.status(400).json({ error: 'Invalid projectId' });
    const shortCode = project.short_code || 'PRJ';

    const num = await nextCounter(req.db, 'counter_' + shortCode + '_TC');
    const id = formatCode(shortCode + '-TC', num, 3);
    const now = new Date();

    await req.db('test_cases').insert({
      id,
      project_id: projectId,
      title,
      description: description || null,
      expected_result: expectedResult || null,
      actual_result: actualResult || null,
      status: status || 'Not Run',
      created_by: req.auth.userId,
      created_at: now,
      extra_json: Object.keys(rest).length ? JSON.stringify(rest) : null,
    });

    const saved = mapTestCase(await req.db('test_cases').where({ id }).first());
    req.io.to(req.company.slug).emit('testcase:created', saved);
    res.json(saved);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/:slug/test-cases/:id — Tester only
router.patch('/:id', requireRole('tester'), async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await req.db('test_cases').where({ id }).first();
    if (!existing) return res.status(404).json({ error: 'Test case not found' });

    const { title, description, expectedResult, actualResult, status } = req.body;
    const updates = { updated_at: new Date(), updated_by: req.auth.userId };
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (expectedResult !== undefined) updates.expected_result = expectedResult;
    if (actualResult !== undefined) updates.actual_result = actualResult;
    if (status !== undefined) updates.status = status;

    await req.db('test_cases').where({ id }).update(updates);
    const row = mapTestCase(await req.db('test_cases').where({ id }).first());
    req.io.to(req.company.slug).emit('testcase:updated', row);
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/:slug/test-cases/:id — Tester only
router.delete('/:id', requireRole('tester'), async (req, res) => {
  try {
    const existing = await req.db('test_cases').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await req.db('test_cases').where({ id: req.params.id }).delete();
    req.io.to(req.company.slug).emit('testcase:deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
