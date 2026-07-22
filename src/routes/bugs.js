const express = require('express');
const { nextCounter, formatCode } = require('../utils/counters');

const router = express.Router();

const CLOSED_STATUSES = new Set(['Resolved', 'Fixed', 'Closed', "Won't Fix", 'Wont Fix', 'Not a Bug', 'Expected Behavior', 'NAB']);

// Rehydrate a DB row into the shape the frontend expects (parse JSON columns).
function rowToBug(row) {
  if (!row) return row;
  return {
    projectId: row.project_id,
    projectName: row.project_name,
    sprintId: row.sprint_id || null,
    fixSummary: row.fix_summary,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : (row.created_at || null),
    ...row,
    furtherChanges: JSON.parse(row.further_changes || '[]'),
    audit: JSON.parse(row.audit_trail || '[]'),
    extra: row.extra_json ? JSON.parse(row.extra_json) : {},
  };
}

// GET /api/:slug/bugs/counts
router.get('/counts', async (req, res) => {
  try {
    const rows = await req.db('bugs').select('project_id', 'status');
    const counts = {};
    for (const r of rows) {
      if (!r.project_id) continue;
      if (!counts[r.project_id]) counts[r.project_id] = { total: 0, open: 0 };
      counts[r.project_id].total++;
      if (!CLOSED_STATUSES.has(r.status)) counts[r.project_id].open++;
    }
    res.json(counts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/:slug/bugs?projectId=...
router.get('/', async (req, res) => {
  try {
    let q = req.db('bugs').orderBy('created_at', 'desc');
    if (req.query.projectId) q = q.where('project_id', req.query.projectId);
    const rows = await q;
    res.json(rows.map(rowToBug));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/bugs
router.post('/', async (req, res) => {
  try {
    const body = { ...req.body };
    const silent = body._silent === true;
    delete body._silent;
    delete body.companyId; // legacy field from old multi-tenant model — no longer used

    // Frontend sends 'default' (or nothing) when no real project is selected.
    // project_id is a FK to projects(id), so coerce anything non-existent to NULL.
    let projectId = body.projectId || null;
    if (projectId === 'default') projectId = null;
    let shortCode = 'BUG';
    let projectName = body.projectName || null;
    if (projectId) {
      const project = await req.db('projects').where({ id: projectId }).first();
      if (project) { shortCode = project.short_code || 'BUG'; projectName = projectName || project.name; }
      else { projectId = null; } // referenced project doesn't exist -> avoid FK violation
    }

    const num = await nextCounter(req.db, 'counter_' + shortCode);
    const bugId = formatCode(shortCode, num, 3);
    const now = new Date();

    // Pull known fields out; everything else goes to extra_json.
    const { title, description, reporter, assignee, status, projectName: _pn, projectId: _pid, ...rest } = body;

    const bug = {
      id: bugId,
      project_id: projectId,
      project_name: projectName,
      title,
      description: description || null,
      reporter: reporter || null,
      assignee: assignee || null,
      status: status || 'Open',
      fix_summary: '',
      further_changes: '[]',
      audit_trail: JSON.stringify([{ who: reporter, action: silent ? 'Bug imported from Excel' : 'Bug raised', when: now.toISOString(), note: '' }]),
      created_at: now,
      extra_json: Object.keys(rest).length ? JSON.stringify(rest) : null,
    };
    await req.db('bugs').insert(bug);

    const saved = rowToBug(await req.db('bugs').where({ id: bugId }).first());
    const pname = projectName ? `[${projectName}] ` : '';
    if (!silent) {
      const notif = { icon: '🐛', bugId, time: now.toISOString(), read: false, msg: `${pname}New bug: "${saved.title}" [${bugId}]` };
      req.io.to(req.company.slug).emit('notification', { to: 'developer', ...notif });
      req.io.to(req.company.slug).emit('notification', { to: 'manager', ...notif, icon: '📋' });
    }
    req.io.to(req.company.slug).emit('bug:created', saved);
    res.json(saved);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/:slug/bugs/:id
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const body = { ...req.body };
    const src = body._source; delete body._source;
    const fc = body._furtherChange; delete body._furtherChange;
    const retested = body._retested; delete body._retested;

    const existing = await req.db('bugs').where({ id }).first();
    if (!existing) return res.status(404).json({ error: 'Bug not found' });

    const updates = { updated_at: new Date() };
    if (body.status !== undefined) updates.status = body.status;
    if (body.assignee !== undefined) updates.assignee = body.assignee;
    if (body.fixSummary !== undefined) updates.fix_summary = body.fixSummary;
    if (body.title !== undefined) updates.title = body.title;
    if (body.sprintId !== undefined) updates.sprint_id = body.sprintId;
    if (body.description !== undefined) updates.description = body.description;

    if ((updates.status === 'Resolved' || updates.status === 'Fixed') && !existing.resolved_at) updates.resolved_at = new Date();
    if (retested) updates.retested_at = new Date();

    // Append a further-change note to the JSON log if provided.
    if (fc) {
      const arr = JSON.parse(existing.further_changes || '[]');
      arr.push({ note: fc, when: new Date().toISOString() });
      updates.further_changes = JSON.stringify(arr);
    }

    await req.db('bugs').where({ id }).update(updates);
    const bug = rowToBug(await req.db('bugs').where({ id }).first());

    const base = { bugId: id, time: new Date().toISOString(), read: false };
    const pname = bug.project_name ? `[${bug.project_name}] ` : '';
    const emit = (payload) => req.io.to(req.company.slug).emit('notification', payload);
    if (updates.status === 'Fixed') {
      emit({ ...base, to: 'tester', icon: '✅', msg: `${pname}Bug ${id} fixed — please retest: "${bug.title}"` });
      emit({ ...base, to: 'manager', icon: '✅', msg: `${pname}"${bug.title}" marked fixed` });
    }
    if (updates.status === 'Open' && src === 'retest') {
      emit({ ...base, to: 'developer', icon: '🔄', msg: `${pname}Bug ${id} failed retest — reopened` });
      emit({ ...base, to: 'manager', icon: '🔄', msg: `${pname}"${bug.title}" reopened` });
    }
    if (updates.status === 'Closed') {
      emit({ ...base, to: 'developer', icon: '🎉', msg: `${pname}Bug ${id} verified & closed` });
      emit({ ...base, to: 'manager', icon: '🎉', msg: `${pname}"${bug.title}" closed` });
    }
    if (fc) {
      emit({ ...base, to: 'tester', icon: '📝', msg: `${pname}Dev noted a change on ${id}: "${fc}"` });
      emit({ ...base, to: 'manager', icon: '📝', msg: `${pname}Further change on "${bug.title}"` });
    }
    req.io.to(req.company.slug).emit('bug:updated', bug);
    res.json(bug);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/:slug/bugs/:id
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await req.db('bugs').where({ id }).first();
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const silentDelete = req.query.silent === 'true';

    await req.db('bugs').where({ id }).delete();
    req.io.to(req.company.slug).emit('bug:deleted', { id });

    if (!silentDelete) {
      const pname = existing.project_name ? `[${existing.project_name}] ` : '';
      const msg = `${pname}${id} "${existing.title}" deleted by ${existing.reporter}`;
      for (const to of ['manager', 'developer', 'tester']) {
        req.io.to(req.company.slug).emit('notification', { icon: '🗑', time: new Date().toISOString(), read: false, to, msg });
      }
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;