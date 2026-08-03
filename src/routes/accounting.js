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
  catch (e) { console.error('GET /clients failed:', e); res.status(500).json({ error: 'Could not load clients. Please try again.' }); }
});
router.post('/clients', async (req, res) => {
  try {
    const { name, contactName, contact_name, contactEmail, contact_email, contactPhone, contact_phone, requestingUserRole, ...rest } = req.body;
    // Client creation is part of "client management" (Issue 2) — the "+ Add
    // Client" button is already hidden from Accountants/Interns in the
    // frontend; this makes that restriction real at the API boundary too.
    if (requestingUserRole === 'accountant' || requestingUserRole === 'intern') {
      return res.status(403).json({ error: 'Only Senior Accountants and Accounting Managers can create clients.' });
    }
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
  } catch (e) { console.error('POST /clients failed:', e); res.status(500).json({ error: 'Could not create this client. Please try again.' }); }
});
router.patch('/clients/:id', async (req, res) => {
  try {
    const current = await req.db('clients').where({ id: req.params.id }).first();
    if (!current) return res.status(404).json({ error: 'Client not found' });
    // Same pattern as PATCH /time-entries/:id and PATCH /eod-reports/:id below:
    // only true columns are written directly; everything else (assignedTo,
    // description, industry, createdBy, etc.) is merged into extra_json.
    const { name, contactName, contactEmail, contactPhone, status, requestingUserRole, requestingUserName, ...extra } = req.body;
    const currentExtra = current.extra_json ? JSON.parse(current.extra_json) : {};

    // Server-side authorization for assignment changes (Issue 1 / Issue 2).
    // This app has no auth middleware anywhere (no route applies requireAuth
    // in server.js, so req.user/req.auth is never populated on any request
    // in this codebase) — so, consistent with how this same route already
    // trusts body fields for assignedTo/createdBy, the requester's role and
    // name are passed the same way and validated here. This is what makes
    // the restriction a real backend rule rather than something a direct
    // API call (bypassing the UI) could bypass entirely.
    if (extra.assignedTo !== undefined) {
      const isAccountantTier = requestingUserRole === 'accountant' || requestingUserRole === 'intern';
      if (isAccountantTier) {
        const before = new Set(currentExtra.assignedTo || []);
        const after = new Set(extra.assignedTo || []);
        const added = [...after].filter(n => !before.has(n));
        const removed = [...before].filter(n => !after.has(n));
        const onlyRemovingSelf = added.length === 0 && removed.length === 1 && removed[0] === requestingUserName;
        if (!onlyRemovingSelf) {
          return res.status(403).json({ error: 'Accountants can only remove themselves from a client they are already assigned to.' });
        }
      }
    }
    // Only Senior Accountants and Accounting Managers may edit any other
    // client field (name, description, industry, status, etc.) — matches
    // Issue 2's requirement that Accountants must never reach client-edit
    // functionality, not just have the button hidden.
    const otherFieldsBeingChanged = name !== undefined || contactName !== undefined || contactEmail !== undefined
      || contactPhone !== undefined || status !== undefined
      || Object.keys(extra).some(k => k !== 'assignedTo');
    if (otherFieldsBeingChanged && (requestingUserRole === 'accountant' || requestingUserRole === 'intern')) {
      return res.status(403).json({ error: 'Only Senior Accountants and Accounting Managers can edit client details.' });
    }

    const upd = { updated_at: new Date(), extra_json: JSON.stringify({ ...currentExtra, ...extra }) };
    if (name !== undefined) upd.name = name;
    if (contactName !== undefined) upd.contact_name = contactName;
    if (contactEmail !== undefined) upd.contact_email = contactEmail;
    if (contactPhone !== undefined) upd.contact_phone = contactPhone;
    if (status !== undefined) upd.status = status;
    await req.db('clients').where({ id: req.params.id }).update(upd);
    const saved = mapClient(await req.db('clients').where({ id: req.params.id }).first());
    req.io.to(req.company.slug).emit('client:updated', saved);
    res.json(saved);
  } catch (e) {
    // Do not leak raw SQL/driver exceptions to the UI — log server-side and
    // return a clean, generic message instead. Matches the requirement not
    // to expose SQL/database exceptions, and gives the frontend something
    // sensible to show in a toast either way.
    console.error('PATCH /clients/:id failed:', e);
    res.status(500).json({ error: 'Could not update this client. Please try again.' });
  }
});
router.delete('/clients/:id', async (req, res) => {
  try {
    // ROOT CAUSE FIX (Issue 2): Accountants/Interns must never be able to
    // delete a client, even via a direct API call. Same trust-the-body
    // pattern as above, since this is the only mechanism available anywhere
    // in this backend for identifying the requester's role.
    const requestingUserRole = req.body?.requestingUserRole || req.query?.requestingUserRole;
    if (requestingUserRole === 'accountant' || requestingUserRole === 'intern') {
      return res.status(403).json({ error: 'Only Senior Accountants and Accounting Managers can delete clients.' });
    }
    await req.db('clients').where({ id: req.params.id }).delete();
    req.io.to(req.company.slug).emit('client:deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (e) { console.error('DELETE /clients/:id failed:', e); res.status(500).json({ error: 'Could not delete this client. Please try again.' }); }
});

// ── TIME ENTRIES ──────────────────────────────────────────────────────────────
router.get('/time-entries', async (req, res) => {
  try {
    let q = req.db('time_entries');
    if (req.query.accountantId) q = q.where('accountant_id', req.query.accountantId);
    if (req.query.date) q = q.where('date', req.query.date);
    res.json((await q).map(mapTimeEntry));
  } catch (e) { console.error('GET /time-entries failed:', e); res.status(500).json({ error: 'Could not load time entries. Please try again.' }); }
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
  } catch (e) { console.error('POST /time-entries failed:', e); res.status(500).json({ error: 'Could not save this time entry. Please try again.' }); }
});
router.patch('/time-entries/:id', async (req, res) => {
  try {
    const current = await req.db('time_entries').where({ id: req.params.id }).first();
    if (!current) return res.status(404).json({ error: 'Time entry not found' });
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
  } catch (e) { console.error('PATCH /time-entries/:id failed:', e); res.status(500).json({ error: 'Could not update this time entry. Please try again.' }); }
});

// ── EOD REPORTS ───────────────────────────────────────────────────────────────
router.get('/eod-reports', async (req, res) => {
  try {
    let q = req.db('eod_reports');
    if (req.query.accountantId) q = q.where('accountant_id', req.query.accountantId);
    if (req.query.date) q = q.where('date', req.query.date);
    if (req.query.status) q = q.where('status', req.query.status);
    res.json((await q).map(mapEodReport));
  } catch (e) { console.error('GET /eod-reports failed:', e); res.status(500).json({ error: 'Could not load EOD reports. Please try again.' }); }
});
router.post('/eod-reports', async (req, res) => {
  try {
    // Frontend sends: { accountantId, accountantName, accountantRole, date, clientSummary[],
    //   totalDuration, status, submittedAt, reviewNote, reviewedBy, reviewedAt }
    const { accountantId, date, status, summary, accountantRole, ...extraRest } = req.body;
    // An Accounts Manager has no reviewer above them in the hierarchy — their
    // own EOD is final the moment they submit it, not "pending review" by
    // someone else. Enforcing this here (not just hiding the button in the
    // UI) is what actually prevents an Accounts Manager from being stuck in
    // a submitted/pending state forever, since nothing in this system is
    // ever positioned to review a Manager's own report.
    const isManagerSelfReport = accountantRole === 'accounts_manager';
    const finalStatus = isManagerSelfReport ? 'reviewed' : (status || 'submitted');
    const extra = { ...extraRest, accountantRole };
    if (isManagerSelfReport) {
      extra.reviewedBy = extra.reviewedBy || req.body.accountantName || null;
      extra.reviewedAt = extra.reviewedAt || new Date().toISOString();
    }
    const id = 'eod' + Date.now();
    await req.db('eod_reports').insert({
      id,
      accountant_id: accountantId || req.body.accountant_id,
      date: date || null,
      status: finalStatus,
      summary: summary || null,
      extra_json: JSON.stringify(extra),
    });
    const saved = mapEodReport(await req.db('eod_reports').where({ id }).first());
    req.io.to(req.company.slug).emit('eodReport:submitted', saved);
    res.json(saved);
  } catch (e) {
    console.error('POST /eod-reports failed:', e);
    res.status(500).json({ error: 'Could not submit the EOD report. Please try again.' });
  }
});
router.patch('/eod-reports/:id', async (req, res) => {
  try {
    const current = await req.db('eod_reports').where({ id: req.params.id }).first();
    if (!current) return res.status(404).json({ error: 'EOD report not found' });
    const { status, summary, accountantId, date, ...extra } = req.body;
    const currentExtra = current.extra_json ? JSON.parse(current.extra_json) : {};
    const upd = { updated_at: new Date(), extra_json: JSON.stringify({ ...currentExtra, ...extra }) };
    if (status !== undefined) upd.status = status;
    if (summary !== undefined) upd.summary = summary;
    await req.db('eod_reports').where({ id: req.params.id }).update(upd);
    const saved = mapEodReport(await req.db('eod_reports').where({ id: req.params.id }).first());
    req.io.to(req.company.slug).emit('eodReport:updated', saved);
    res.json(saved);
  } catch (e) { console.error('PATCH /eod-reports/:id failed:', e); res.status(500).json({ error: 'Could not update this EOD report. Please try again.' }); }
});

// ── EOD ROUTES ────────────────────────────────────────────────────────────────
router.get('/eod-routes', async (req, res) => {
  try { res.json((await req.db('eod_routes')).map(mapRoute)); }
  catch (e) { console.error('GET /eod-routes failed:', e); res.status(500).json({ error: 'Could not load reviewer routing. Please try again.' }); }
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
  } catch (e) { console.error('POST /eod-routes failed:', e); res.status(500).json({ error: 'Could not save reviewer routing. Please try again.' }); }
});
router.delete('/eod-routes/:id', async (req, res) => {
  try { await req.db('eod_routes').where({ id: req.params.id }).delete(); res.json({ success: true }); }
  catch (e) { console.error('DELETE /eod-routes/:id failed:', e); res.status(500).json({ error: 'Could not remove this reviewer routing. Please try again.' }); }
});

module.exports = router;