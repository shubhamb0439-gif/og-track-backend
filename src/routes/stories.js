const express = require('express');
const { nextCounter } = require('../utils/counters');
const router = express.Router();

const dTime = (v) => { if (!v) return null; return (v instanceof Date) ? v.toISOString() : new Date(v).toISOString(); };

// Frontend expects: id, storyId, projectId, sprintId, title, description, status,
//   assigneeId, assigneeName, storyPoints, createdAt, extra
const mapStory = (r) => r && ({
  id: r.id,
  storyId: r.story_id,
  projectId: r.project_id,
  sprintId: r.sprint_id,
  title: r.title,
  description: r.description,
  status: r.status,
  assigneeId: r.assignee_id || null,
  assigneeName: r.assignee_name || null,
  storyPoints: r.story_points || null,
  createdAt: dTime(r.created_at),
  extra: r.extra_json ? JSON.parse(r.extra_json) : {},
});

// GET /api/:slug/stories?projectId=...
router.get('/', async (req, res) => {
  try {
    let q = req.db('stories').orderBy('created_at', 'desc');
    if (req.query.projectId) q = q.where('project_id', req.query.projectId);
    res.json((await q).map(mapStory));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/stories — frontend sends camelCase
router.post('/', async (req, res) => {
  try {
    const { projectId, sprintId, title, description, status, assigneeId, assigneeName, storyPoints, ...rest } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    let shortCode = 'ST';
    if (projectId) {
      const project = await req.db('projects').where({ id: projectId }).first();
      if (project && project.short_code) shortCode = project.short_code;
    }
    const num = await nextCounter(req.db, 'story_counter_' + shortCode);
    const storyId = `${shortCode}-S${String(num).padStart(3, '0')}`;
    const id = 'st' + Date.now();

    await req.db('stories').insert({
      id, story_id: storyId,
      project_id: projectId || null,
      sprint_id: sprintId || null,
      title,
      description: description || null,
      status: status || 'backlog',
      assignee_id: assigneeId || null,
      assignee_name: assigneeName || null,
      story_points: storyPoints || null,
      extra_json: Object.keys(rest).length ? JSON.stringify(rest) : null,
    });
    res.json(mapStory(await req.db('stories').where({ id }).first()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/:slug/stories/:id — accepts camelCase from frontend
router.patch('/:id', async (req, res) => {
  try {
    const { projectId, sprintId, assigneeId, assigneeName, storyPoints, ...rest } = req.body;
    const upd = { ...rest, updated_at: new Date() };
    if (projectId !== undefined) upd.project_id = projectId;
    if (sprintId !== undefined) upd.sprint_id = sprintId;
    if (assigneeId !== undefined) upd.assignee_id = assigneeId;
    if (assigneeName !== undefined) upd.assignee_name = assigneeName;
    if (storyPoints !== undefined) upd.story_points = storyPoints;
    // scrub camelCase keys & non-column fields
    delete upd.sprintId; delete upd.projectId; delete upd.assigneeId; delete upd.assigneeName;
    delete upd.storyPoints; delete upd.createdAt; delete upd.storyId; delete upd.extra;
    await req.db('stories').where({ id: req.params.id }).update(upd);
    const row = await req.db('stories').where({ id: req.params.id }).first();
    if (!row) return res.status(404).json({ error: 'Story not found' });
    res.json(mapStory(row));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/:slug/stories/:id
router.delete('/:id', async (req, res) => {
  try {
    await req.db('stories').where({ id: req.params.id }).delete();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;