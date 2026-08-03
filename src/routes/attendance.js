const express = require('express');
const crypto = require('crypto');
const config = require('../config');
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
  } catch (e) { console.error('POST /clockin failed:', e); res.status(500).json({ error: 'Could not clock in. Please try again.' }); }
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
  } catch (e) { console.error('POST /clockout failed:', e); res.status(500).json({ error: 'Could not clock out. Please try again.' }); }
});

// ── Today's record for a user ────────────────────────────────────────────────
router.get('/today/:userId', async (req, res) => {
  try {
    const rec = await req.db('attendance').where({ id: `${req.params.userId}_${todayStr()}` }).first();
    res.json(mapAtt(rec) || null);
  } catch (e) { console.error('GET /today/:userId failed:', e); res.status(500).json({ error: 'Could not load today\'s attendance. Please try again.' }); }
});

// ── Last 60 days for a user ──────────────────────────────────────────────────
router.get('/user/:userId', async (req, res) => {
  try {
    const rows = await req.db('attendance').where({ user_id: req.params.userId }).orderBy('date', 'desc').limit(60);
    res.json(rows.map(mapAtt));
  } catch (e) { console.error('GET /user/:userId failed:', e); res.status(500).json({ error: 'Could not load attendance history. Please try again.' }); }
});

// ── Org-wide (last 300) ──────────────────────────────────────────────────────
router.get('/all', async (req, res) => {
  try {
    const rows = await req.db('attendance').orderBy('date', 'desc').limit(300);
    res.json(rows.map(mapAtt));
  } catch (e) { console.error('GET /all failed:', e); res.status(500).json({ error: 'Could not load attendance records. Please try again.' }); }
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
  } catch (e) { console.error('POST /regularize failed:', e); res.status(500).json({ error: 'Could not submit regularization request. Please try again.' }); }
});

router.get('/regularize', async (req, res) => {
  try {
    let q = req.db('regularize_requests').orderBy('created_at', 'desc');
    if (req.query.userId) q = q.where('user_id', req.query.userId);
    res.json((await q).map(mapReg));
  } catch (e) { console.error('GET /regularize failed:', e); res.status(500).json({ error: 'Could not load regularization requests. Please try again.' }); }
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
  } catch (e) { console.error('PATCH /regularize/:id failed:', e); res.status(500).json({ error: 'Could not update this regularization request. Please try again.' }); }
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
  } catch (e) { console.error('POST /leave failed:', e); res.status(500).json({ error: 'Could not submit leave request. Please try again.' }); }
});

router.get('/leave', async (req, res) => {
  try {
    let q = req.db('leave_requests').orderBy('created_at', 'desc');
    if (req.query.userId) q = q.where('user_id', req.query.userId);
    res.json((await q).map(mapLeave));
  } catch (e) { console.error('GET /leave failed:', e); res.status(500).json({ error: 'Could not load leave requests. Please try again.' }); }
});

router.patch('/leave/:id', async (req, res) => {
  try {
    const { status, approvedBy } = req.body;
    await req.db('leave_requests').where({ id: req.params.id }).update({ status, approved_by: approvedBy, resolved_at: new Date() });
    req.io.to(req.company.slug).emit('leave:updated', { id: req.params.id, status });
    res.json({ success: true });
  } catch (e) { console.error('PATCH /leave/:id failed:', e); res.status(500).json({ error: 'Could not update this leave request. Please try again.' }); }
});

// ── QR attendance ─────────────────────────────────────────────────────────────
// Design: a screen/tablet at the office door displays a QR code that rotates
// every 30 seconds (a signed token — company slug + time bucket + HMAC using
// QR_SECRET). Employees scan it with their own phone camera. This means the
// QR image itself is useless if photographed and reused later — it only
// validates within its ~30s window (plus one bucket of tolerance either side
// for clock skew / slow scans).
const QR_BUCKET_SECONDS = 30;

function signQrBucket(slug, bucket) {
  return crypto.createHmac('sha256', config.app.qrSecret).update(`${slug}:${bucket}`).digest('hex');
}

// GET /api/:slug/attendance/qr-token — for the display screen to show/refresh
router.get('/qr-token', async (req, res) => {
  try {
    const bucket = Math.floor(Date.now() / 1000 / QR_BUCKET_SECONDS);
    const sig = signQrBucket(req.company.slug, bucket);
    const token = Buffer.from(`${req.company.slug}.${bucket}.${sig}`).toString('base64');
    res.json({ token, expiresInSeconds: QR_BUCKET_SECONDS });
  } catch (e) { console.error('GET /qr-token failed:', e); res.status(500).json({ error: 'Could not generate QR code. Please try again.' }); }
});

// POST /api/:slug/attendance/qr-scan — an employee's phone scans the
// displayed code; toggles clock-in/clock-out for whichever hasn't happened
// yet today.
router.post('/qr-scan', async (req, res) => {
  try {
    const { token, userId } = req.body;
    if (!token || !userId) return res.status(400).json({ error: 'Missing token or userId' });

    let decoded;
    try { decoded = Buffer.from(token, 'base64').toString('utf8'); }
    catch { return res.status(400).json({ error: 'Malformed QR code' }); }
    const [slug, bucketStr, sig] = decoded.split('.');
    const bucket = Number(bucketStr);
    if (slug !== req.company.slug || !bucket || !sig) {
      return res.status(400).json({ error: 'This QR code is not for this company' });
    }
    const nowBucket = Math.floor(Date.now() / 1000 / QR_BUCKET_SECONDS);
    // Accept the current bucket or one bucket of slack either side.
    const validBuckets = [nowBucket - 1, nowBucket, nowBucket + 1];
    const isValid = validBuckets.some(b => signQrBucket(slug, b) === sig && b === bucket);
    if (!isValid) return res.status(400).json({ error: 'QR code expired — please scan the current code' });

    const user = await req.db('users').where({ id: userId }).first();
    if (!user) return res.status(404).json({ error: 'User not found' });

    const date = todayStr();
    const id = `${userId}_${date}`;
    const existing = await req.db('attendance').where({ id }).first();
    const now = new Date();

    if (!existing || !existing.clock_in) {
      if (existing) {
        await req.db('attendance').where({ id }).update({ clock_in: now, status: 'present', mode: 'qr' });
      } else {
        await req.db('attendance').insert({ id, user_id: userId, user_name: user.name, date, clock_in: now, status: 'present', mode: 'qr' });
      }
      req.io.to(req.company.slug).emit(`attendance:${userId}`, { date, clockIn: now.toISOString() });
      return res.json({ success: true, action: 'clockin', time: now.toISOString() });
    }
    if (!existing.clock_out) {
      const hrs = Number(((now - new Date(existing.clock_in)) / 3600000).toFixed(2));
      await req.db('attendance').where({ id }).update({ clock_out: now, total_hours: hrs });
      req.io.to(req.company.slug).emit(`attendance:${userId}`, { date, clockOut: now.toISOString(), totalHours: hrs });
      return res.json({ success: true, action: 'clockout', time: now.toISOString(), totalHours: hrs });
    }
    return res.status(400).json({ error: 'Already clocked in and out for today' });
  } catch (e) {
    // Do not leak raw SQL/driver exceptions to the UI — this is what
    // previously surfaced literally as "insert into [attendance] (...)
    // values (...) - Invalid column name 'mode'" directly in the QR
    // scanner screen (the real bug: the 'mode' column was missing from the
    // schema entirely — see patch_07_attendance_mode_column.sql). Log the
    // real error server-side and show a clean, actionable message instead.
    console.error('POST /qr-scan failed:', e);
    res.status(500).json({ error: 'Could not record attendance. Please tap close and try again.' });
  }
});

module.exports = router;