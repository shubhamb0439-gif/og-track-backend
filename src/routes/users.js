const express = require('express');
const { hashPassword, verifyPassword, issueToken, requireAuth } = require('../utils/auth');
const { matchTodayCelebrations } = require('../aida/celebrations');

const router = express.Router();

function stripPassword(u) {
  const { password_hash, ...safe } = u;
  return safe;
}

const todayStr = () => new Date().toISOString().slice(0, 10);

// Parses a 'YYYY-MM-DD' (or ISO datetime prefix) string into its date parts,
// or returns null if it isn't a real, parseable calendar date.
function parseDateOnly(input) {
  if (!input) return null;
  const s = String(input).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  // Catches calendar-invalid dates like 2024-02-30 (which JS Date would
  // otherwise silently roll over into March).
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return { dateStr: s, year, month, day };
}

// GET /api/:slug/users
router.get('/', async (req, res) => {
  try {
    const rows = await req.db('users').select('*');
    res.json(rows.map(stripPassword));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/users/register
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, role, dateOfBirth } = req.body;
    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: 'name, email, password, and role are required' });
    }

    // dateOfBirth is optional at registration — plenty of people fill it in
    // later via the "please enter your DOB" prompt instead.
    let date_of_birth = null;
    if (dateOfBirth) {
      const parsed = parseDateOnly(dateOfBirth);
      if (!parsed) return res.status(400).json({ error: 'dateOfBirth must be a valid date (YYYY-MM-DD)' });
      date_of_birth = parsed.dateStr;
    }

    const emailLower = email.toLowerCase();
    const existing = await req.db('users').where({ email: emailLower }).first();
    if (existing) return res.status(400).json({ error: 'Email already registered.' });

    const password_hash = await hashPassword(password);
    const id = 'u' + Date.now();
    // joining_date is always today — it's literally this person's onboarding date.
    const user = { id, name, email: emailLower, password_hash, role, status: 'pending', date_of_birth, joining_date: todayStr() };
    await req.db('users').insert(user);

    const safe = stripPassword(user);
    req.io.to(req.company.slug).emit('user:registered', safe);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/:slug/users/today-celebrations — everyone in this tenant having a
// birthday or work anniversary today. No extra auth beyond normal tenant
// scoping: every logged-in user in the company should see today's list.
router.get('/today-celebrations', async (req, res) => {
  try {
    const rows = await req.db('users').select('id', 'name', 'date_of_birth', 'joining_date');
    const results = [];
    for (const row of rows) {
      for (const c of matchTodayCelebrations(row.date_of_birth, row.joining_date)) {
        results.push({ userId: row.id, name: row.name, type: c.type, yearsCount: c.yearsCount ?? null });
      }
    }
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/:slug/users/me/dob — the calling (authenticated) user sets
// their own date_of_birth.
router.patch('/me/dob', requireAuth, async (req, res) => {
  try {
    if (req.auth.slug !== req.company.slug) {
      return res.status(401).json({ error: 'Token is not valid for this company' });
    }
    const parsed = parseDateOnly(req.body.dateOfBirth);
    if (!parsed) return res.status(400).json({ error: 'dateOfBirth is required and must be a valid date (YYYY-MM-DD)' });

    const now = new Date();
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const givenUtc = Date.UTC(parsed.year, parsed.month - 1, parsed.day);
    if (givenUtc > todayUtc) return res.status(400).json({ error: 'dateOfBirth cannot be in the future' });

    const user = await req.db('users').where({ id: req.auth.userId }).first();
    if (!user) return res.status(404).json({ error: 'User not found' });

    await req.db('users').where({ id: req.auth.userId }).update({ date_of_birth: parsed.dateStr, updated_at: new Date() });
    const updated = await req.db('users').where({ id: req.auth.userId }).first();
    const safe = stripPassword(updated);
    req.io.to(req.company.slug).emit('user:updated', safe);
    res.json(safe);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/users/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await req.db('users').where({ email: (email || '').toLowerCase() }).first();
    if (!user) return res.status(401).json({ error: 'Incorrect email or password.' });

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Incorrect email or password.' });
    if (user.status === 'pending') return res.status(403).json({ error: 'Account pending Super Admin approval.' });
    if (user.status === 'rejected') return res.status(403).json({ error: 'Account request was rejected.' });

    const token = issueToken({ userId: user.id, role: user.role, slug: req.company.slug });
    res.json({ token, user: stripPassword(user) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/:slug/users/:id/status
router.patch('/:id/status', async (req, res) => {
  try {
    await req.db('users').where({ id: req.params.id }).update({ status: req.body.status, updated_at: new Date() });
    const user = await req.db('users').where({ id: req.params.id }).first();
    if (!user) return res.status(404).json({ error: 'User not found' });
    const safe = stripPassword(user);
    req.io.to(req.company.slug).emit('user:updated', safe);
    res.json(safe);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/:slug/users/:id/role
router.patch('/:id/role', async (req, res) => {
  try {
    await req.db('users').where({ id: req.params.id }).update({ role: req.body.role, updated_at: new Date() });
    const user = await req.db('users').where({ id: req.params.id }).first();
    if (!user) return res.status(404).json({ error: 'User not found' });
    const safe = stripPassword(user);
    req.io.to(req.company.slug).emit('user:updated', safe);
    res.json(safe);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
