const express = require('express');
const router = express.Router();

const todayStr = () => new Date().toISOString().slice(0, 10);

// ── Row mappers: DB (snake_case, SQL DATE/DATETIME2/DECIMAL) → API shape the
//    frontend expects (camelCase, 'YYYY-MM-DD' date strings, ISO datetimes,
//    numeric hours). This is the fix for the "calendar shows all absent /
//    hours blank / regularize not reflecting" class of bug: the data was
//    written fine, the frontend just couldn't read snake_case / Date objects.
const dOnly = (v) => {           // SQL DATE (JS Date @ UTC midnight, or string) → 'YYYY-MM-DD'
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};
const dTime = (v) => {           // SQL DATETIME2 → ISO string (or null)
  if (v == null) return null;
  return (v instanceof Date) ? v.toISOString() : new Date(v).toISOString();
};
const num = (v) => (v == null ? null : Number(v));  // DECIMAL may arrive as string

const mapAtt = (r) => r && ({
  id: r.id,
  userId: r.user_id,
  userName: r.user_name,
  date: dOnly(r.date),
  clockIn: dTime(r.clock_in),
  clockOut: dTime(r.clock_out),
  totalHours: num(r.total_hours),
  status: r.status,
  mode: r.mode || null,
  autoClockout: !!r.auto_clockout,
});

const mapReg = (r) => r && ({
  id: r.id,
  userId: r.user_id,
  userName: r.user_name,
  date: dOnly(r.date),
  reason: r.reason,
  requestedIn: dTime(r.requested_in),
  requestedOut: dTime(r.requested_out),
  status: r.status,
  approvedBy: r.approved_by,
});

const mapLeave = (r) => r && ({
  id: r.id,
  userId: r.user_id,
  userName: r.user_name,
  from: dOnly(r.from_date),
  to: dOnly(r.to_date),
  reason: r.reason,
  leaveType: r.leave_type,
  status: r.status,
  approvedBy: r.approved_by,
});

// ── Clock in ────────────────────────────────────────────────────────────────
router.post('/clockin', async (req, res) => {
  try {
    const { userId, userName } = req.body;
    const date = todayStr();
    const id = `${userId}_${date}`;
    const existing = await req.db('attendance').where({ id }).first();
    if (existing && existing.clock_in) return res.status(400).json({ error: 'Already clocked in today' });

    const now = new Date();
    if (existing) {
      await req.db('attendance').where({ id }).update({ clock_in: now, status: 'present' });
    } else {
      await req.db('attendance').insert({ id, user_id: userId, user_name: userName, date, clock_in: now, status: 'present' });
    }
    req.io.to(req.company.slug).emit(`attendance:${userId}`, { date, clockIn: now.toISOString() });
    res.json({ success: true, clockIn: now.toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Clock out ───────────────────────────────────────────────────────────────
router.post('/clockout', async (req, res) => {
  try {
    const { userId } = req.body;
    const date = todayStr();
    const id = `${userId}_${date}`;
    const rec = await req.db('attendance').where({ id }).first();
    if (!rec || !rec.clock_in) return res.status(400).json({ error: 'Not clocked in today' });
    if (rec.clock_out) return res.status(400).json({ error: 'Already clocked out' });

    const now = new Date();
    const hrs = Number(((now - new Date(rec.clock_in)) / 3600000).toFixed(2));
    await req.db('attendance').where({ id }).update({ clock_out: now, total_hours: hrs });
    req.io.to(req.company.slug).emit(`attendance:${userId}`, { date, clockOut: now.toISOString(), totalHours: hrs });
    res.json({ success: true, clockOut: now.toISOString(), totalHours: hrs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Today's record for a user ────────────────────────────────────────────────
router.get('/today/:userId', async (req, res) => {
  try {
    const rec = await req.db('attendance').where({ id: `${req.params.userId}_${todayStr()}` }).first();
    res.json(mapAtt(rec) || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Last 60 days for a user ──────────────────────────────────────────────────
router.get('/user/:userId', async (req, res) => {
  try {
    const rows = await req.db('attendance').where({ user_id: req.params.userId }).orderBy('date', 'desc').limit(60);
    res.json(rows.map(mapAtt));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Org-wide (last 300) ──────────────────────────────────────────────────────
router.get('/all', async (req, res) => {
  try {
    const rows = await req.db('attendance').orderBy('date', 'desc').limit(300);
    res.json(rows.map(mapAtt));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Regularization requests ──────────────────────────────────────────────────
router.post('/regularize', async (req, res) => {
  try {
    const { userId, userName, date, reason, requestedIn, requestedOut } = req.body;
    const id = 'reg' + Date.now();
    const data = { id, user_id: userId, user_name: userName, date, reason, requested_in: requestedIn || null, requested_out: requestedOut || null, status: 'pending' };
    await req.db('regularize_requests').insert(data);
    req.io.to(req.company.slug).emit('regularize:new', mapReg(data));
    res.json({ success: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/regularize', async (req, res) => {
  try {
    let q = req.db('regularize_requests').orderBy('created_at', 'desc');
    if (req.query.userId) q = q.where('user_id', req.query.userId);
    res.json((await q).map(mapReg));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/regularize/:id', async (req, res) => {
  try {
    const { status, approvedBy } = req.body;
    await req.db('regularize_requests').where({ id: req.params.id }).update({ status, approved_by: approvedBy, resolved_at: new Date() });
    if (status === 'approved') {
      const r = await req.db('regularize_requests').where({ id: req.params.id }).first();
      const attId = `${r.user_id}_${dOnly(r.date)}`;
      let totalHours = null;
      if (r.requested_in && r.requested_out) totalHours = Number(((new Date(r.requested_out) - new Date(r.requested_in)) / 3600000).toFixed(2));
      const existing = await req.db('attendance').where({ id: attId }).first();
      const payload = { user_id: r.user_id, user_name: r.user_name, date: dOnly(r.date), clock_in: r.requested_in, clock_out: r.requested_out, total_hours: totalHours, status: 'regularized' };
      if (existing) await req.db('attendance').where({ id: attId }).update(payload);
      else await req.db('attendance').insert({ id: attId, ...payload });
    }
    req.io.to(req.company.slug).emit('regularize:updated', { id: req.params.id, status });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Leave requests ───────────────────────────────────────────────────────────
router.post('/leave', async (req, res) => {
  try {
    const { userId, userName, from, to, reason, leaveType } = req.body;
    const id = 'lv' + Date.now();
    const data = { id, user_id: userId, user_name: userName, from_date: from, to_date: to, reason, leave_type: leaveType || 'Casual', status: 'pending' };
    await req.db('leave_requests').insert(data);
    req.io.to(req.company.slug).emit('leave:new', mapLeave(data));
    res.json({ success: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/leave', async (req, res) => {
  try {
    let q = req.db('leave_requests').orderBy('created_at', 'desc');
    if (req.query.userId) q = q.where('user_id', req.query.userId);
    res.json((await q).map(mapLeave));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/leave/:id', async (req, res) => {
  try {
    const { status, approvedBy } = req.body;
    await req.db('leave_requests').where({ id: req.params.id }).update({ status, approved_by: approvedBy, resolved_at: new Date() });
    req.io.to(req.company.slug).emit('leave:updated', { id: req.params.id, status });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;