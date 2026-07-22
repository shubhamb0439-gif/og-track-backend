const express = require('express');
const router = express.Router();

// ── Helpers ──────────────────────────────────────────────────────────────────
const dOnly = (v) => { if (!v) return null; return (v instanceof Date) ? v.toISOString().slice(0,10) : String(v).slice(0,10); };
const dTime = (v) => { if (!v) return null; return (v instanceof Date) ? v.toISOString() : new Date(v).toISOString(); };
const num   = (v) => (v == null ? null : Number(v));

// ── Row mappers ───────────────────────────────────────────────────────────────

// clients: frontend reads id, name, contactName, contactEmail, contactPhone, status + extra fields flat
const mapClient = (r) => {
  if (!r) return r;
  const ex = r.extra_json ? JSON.parse(r.extra_json) : {};
  return {
    id: r.id, name: r.name,
    contactName: r.contact_name, contactEmail: r.contact_email, contactPhone: r.contact_phone,
    status: r.status,
    ...ex,
  };
};

// time_entries: the schema only has (id, accountant_id, client_id, date, hours, task, extra_json).
// The frontend timer POSTs { clientId, clientName, accountantId, accountantName, date, startTime,
// endTime, duration, note, status } — the richer fields live in extra_json.
const mapTimeEntry = (r) => {
  if (!r) return r;
  const ex = r.extra_json ? JSON.parse(r.extra_json) : {};
  return {
    id: r.id,
    accountantId: r.accountant_id,
    accountantName: ex.accountantName || null,
    clientId: r.client_id || ex.clientId || null,
    clientName: ex.clientName || null,
    date: dOnly(r.date),
    hours: num(r.hours),
    task: r.task,
    // timer-specific fields stored in extra_json
    startTime: dTime(ex.startTime || null),
    endTime: dTime(ex.endTime || null),
    duration: num(ex.duration),
    note: ex.note || null,
    status: ex.status || null,
  };
};

// eod_reports: schema has (id, accountant_id, date, status, summary, extra_json).
// Frontend submits rich objects with accountantName, clientSummary[], totalDuration, reviewNote, etc.
const mapEodReport = (r) => {
  if (!r) return r;
  const ex = r.extra_json ? JSON.parse(r.extra_json) : {};
  return {
    id: r.id,
    accountantId: r.accountant_id,
    accountantName: ex.accountantName || null,
    accountantRole: ex.accountantRole || null,
    date: dOnly(r.date),
    status: r.status,
    summary: r.summary,
    clientSummary: ex.clientSummary || [],
    totalDuration: num(ex.totalDuration),
    submittedAt: dTime(ex.submittedAt || null),
    reviewNote: ex.reviewNote || null,
    reviewedBy: ex.reviewedBy || null,
    reviewedAt: dTime(ex.reviewedAt || null),
  };
};

// eod_routes: frontend reads accountantId, accountantName, reviewerId, reviewerName
const mapRoute = (r) => r && ({
  id: r.id,
  accountantId: r.accountant_id,
  accountantName: r.accountant_name,
  reviewerId: r.reviewer_id,
  reviewerName: r.reviewer_name,
});

// ── CLIENTS ───────────────────────────────────────────────────────────────────
router.get('/clients', async (req, res) => {
  try { res.json((await req.db('clients')).map(mapClient)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/clients', async (req, res) => {
  try {
    const { name, contactName, contact_name, contactEmail, contact_email, contactPhone, contact_phone, ...rest } = req.body;
    const id = 'cl' + Date.now();
    await req.db('clients').insert({
      id, name,
      contact_name: contactName || contact_name || null,
      contact_email: contactEmail || contact_email || null,
      contact_phone: contactPhone || contact_phone || null,
      status: 'active',
      extra_json: Object.keys(rest).length ? JSON.stringify(rest) : null,
    });
    const saved = mapClient(await req.db('clients').where({ id }).first());
    req.io.to(req.company.slug).emit('client:created', saved);
    res.json(saved);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch('/clients/:id', async (req, res) => {
  try {
    const { contactName, contactEmail, contactPhone, ...rest } = req.body;
    const upd = { ...rest, updated_at: new Date() };
    if (contactName !== undefined) upd.contact_name = contactName;
    if (contactEmail !== undefined) upd.contact_email = contactEmail;
    if (contactPhone !== undefined) upd.contact_phone = contactPhone;
    delete upd.contactName; delete upd.contactEmail; delete upd.contactPhone; delete upd.extra;
    await req.db('clients').where({ id: req.params.id }).update(upd);
    const saved = mapClient(await req.db('clients').where({ id: req.params.id }).first());
    req.io.to(req.company.slug).emit('client:updated', saved);
    res.json(saved);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/clients/:id', async (req, res) => {
  try {
    await req.db('clients').where({ id: req.params.id }).delete();
    req.io.to(req.company.slug).emit('client:deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TIME ENTRIES ──────────────────────────────────────────────────────────────
router.get('/time-entries', async (req, res) => {
  try {
    let q = req.db('time_entries');
    if (req.query.accountantId) q = q.where('accountant_id', req.query.accountantId);
    if (req.query.date) q = q.where('date', req.query.date);
    res.json((await q).map(mapTimeEntry));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/time-entries', async (req, res) => {
  try {
    // Frontend timer sends: { clientId, clientName, accountantId, accountantName, date,
    //   startTime, endTime, duration, note, status }
    const { accountantId, clientId, date, hours, task, ...extra } = req.body;
    const id = 'te' + Date.now();
    await req.db('time_entries').insert({
      id,
      accountant_id: accountantId || req.body.accountant_id,
      client_id: clientId || req.body.client_id || null,
      date: date || null,
      hours: hours || null,
      task: task || extra.note || null,
      extra_json: JSON.stringify(extra),
    });
    const saved = mapTimeEntry(await req.db('time_entries').where({ id }).first());
    req.io.to(req.company.slug).emit('timeEntry:created', saved);
    res.json(saved);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch('/time-entries/:id', async (req, res) => {
  try {
    const current = await req.db('time_entries').where({ id: req.params.id }).first();
    if (!current) return res.status(404).json({ error: 'Not found' });
    const { hours, task, accountantId, clientId, date, ...extra } = req.body;
    const currentExtra = current.extra_json ? JSON.parse(current.extra_json) : {};
    const upd = { updated_at: new Date(), extra_json: JSON.stringify({ ...currentExtra, ...extra }) };
    if (hours !== undefined) upd.hours = hours;
    if (task !== undefined) upd.task = task;
    if (accountantId !== undefined) upd.accountant_id = accountantId;
    if (clientId !== undefined) upd.client_id = clientId;
    if (date !== undefined) upd.date = date;
    await req.db('time_entries').where({ id: req.params.id }).update(upd);
    const saved = mapTimeEntry(await req.db('time_entries').where({ id: req.params.id }).first());
    req.io.to(req.company.slug).emit('timeEntry:updated', saved);
    res.json(saved);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── EOD REPORTS ───────────────────────────────────────────────────────────────
router.get('/eod-reports', async (req, res) => {
  try {
    let q = req.db('eod_reports');
    if (req.query.accountantId) q = q.where('accountant_id', req.query.accountantId);
    if (req.query.date) q = q.where('date', req.query.date);
    if (req.query.status) q = q.where('status', req.query.status);
    res.json((await q).map(mapEodReport));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/eod-reports', async (req, res) => {
  try {
    // Frontend sends: { accountantId, accountantName, accountantRole, date, clientSummary[],
    //   totalDuration, status, submittedAt, reviewNote, reviewedBy, reviewedAt }
    const { accountantId, date, status, summary, ...extra } = req.body;
    const id = 'eod' + Date.now();
    await req.db('eod_reports').insert({
      id,
      accountant_id: accountantId || req.body.accountant_id,
      date: date || null,
      status: status || 'submitted',
      summary: summary || null,
      extra_json: JSON.stringify(extra),
    });
    const saved = mapEodReport(await req.db('eod_reports').where({ id }).first());
    req.io.to(req.company.slug).emit('eodReport:submitted', saved);
    res.json(saved);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch('/eod-reports/:id', async (req, res) => {
  try {
    const current = await req.db('eod_reports').where({ id: req.params.id }).first();
    if (!current) return res.status(404).json({ error: 'Not found' });
    const { status, summary, accountantId, date, ...extra } = req.body;
    const currentExtra = current.extra_json ? JSON.parse(current.extra_json) : {};
    const upd = { updated_at: new Date(), extra_json: JSON.stringify({ ...currentExtra, ...extra }) };
    if (status !== undefined) upd.status = status;
    if (summary !== undefined) upd.summary = summary;
    await req.db('eod_reports').where({ id: req.params.id }).update(upd);
    const saved = mapEodReport(await req.db('eod_reports').where({ id: req.params.id }).first());
    req.io.to(req.company.slug).emit('eodReport:updated', saved);
    res.json(saved);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── EOD ROUTES ────────────────────────────────────────────────────────────────
router.get('/eod-routes', async (req, res) => {
  try { res.json((await req.db('eod_routes')).map(mapRoute)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/eod-routes', async (req, res) => {
  try {
    const { accountantId, accountantName, reviewerId, reviewerName } = req.body;
    const existing = await req.db('eod_routes').where({ accountant_id: accountantId }).first();
    if (existing) {
      await req.db('eod_routes').where({ accountant_id: accountantId })
        .update({ accountant_name: accountantName, reviewer_id: reviewerId, reviewer_name: reviewerName, updated_at: new Date() });
      return res.json(mapRoute(await req.db('eod_routes').where({ accountant_id: accountantId }).first()));
    }
    const id = 'route' + Date.now();
    await req.db('eod_routes').insert({ id, accountant_id: accountantId, accountant_name: accountantName, reviewer_id: reviewerId, reviewer_name: reviewerName });
    res.json(mapRoute(await req.db('eod_routes').where({ id }).first()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/eod-routes/:id', async (req, res) => {
  try { await req.db('eod_routes').where({ id: req.params.id }).delete(); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;