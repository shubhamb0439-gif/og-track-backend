const express = require('express');
const { hashPassword, verifyPassword, issueToken } = require('../utils/auth');

const router = express.Router();

function stripPassword(u) {
  const { password_hash, ...safe } = u;
  return safe;
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
    const { name, email, password, role } = req.body;
    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: 'name, email, password, and role are required' });
    }
    const emailLower = email.toLowerCase();
    const existing = await req.db('users').where({ email: emailLower }).first();
    if (existing) return res.status(400).json({ error: 'Email already registered.' });

    const password_hash = await hashPassword(password);
    const id = 'u' + Date.now();
    const user = { id, name, email: emailLower, password_hash, role, status: 'pending' };
    await req.db('users').insert(user);

    const safe = stripPassword(user);
    req.io.to(req.company.slug).emit('user:registered', safe);
    res.json({ success: true });
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

// DELETE /api/:slug/users/:id
router.delete('/:id', async (req, res) => {
  try {
    const user = await req.db('users').where({ id: req.params.id }).first();
    if (!user) return res.status(404).json({ error: 'User not found' });
    // Safety rail: never allow deleting the last superadmin (or any
    // superadmin) via this route — that's the one account guaranteed to
    // always be able to log back in and fix things. Revoking/deleting a
    // superadmin, if ever needed, should be a deliberate separate action,
    // not something reachable from the same button as every other user.
    if (user.role === 'superadmin') {
      return res.status(400).json({ error: 'Superadmin accounts cannot be deleted from here.' });
    }
    await req.db('users').where({ id: req.params.id }).delete();
    req.io.to(req.company.slug).emit('user:deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (e) {
    // A user with real data still referencing them elsewhere (time entries,
    // sales, bugs they created, etc.) will hit a foreign key constraint —
    // surface that as a clear, specific message rather than a raw SQL
    // exception reaching the UI.
    if (e.message && /FK_|REFERENCE constraint|foreign key/i.test(e.message)) {
      console.error('DELETE /users/:id blocked by FK:', e.message);
      return res.status(409).json({ error: 'This user still has data linked to them (bugs, sales, time entries, etc.) and cannot be deleted directly. Reassign or remove that data first.' });
    }
    console.error('DELETE /users/:id failed:', e);
    res.status(500).json({ error: 'Could not delete this user. Please try again.' });
  }
});

module.exports = router;