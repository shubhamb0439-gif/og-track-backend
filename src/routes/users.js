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

module.exports = router;
