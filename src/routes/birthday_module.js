const express = require('express');

const router = express.Router();

// Rehydrate a DB row into the shape the frontend expects (camelCase, parsed JSON).
function rowToProfile(row) {
  if (!row) return row;
  const dTime = (v) => { if (!v) return null; return (v instanceof Date) ? v.toISOString() : new Date(v).toISOString(); };
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name || null,
    birthDate: row.birth_date ? (row.birth_date instanceof Date ? row.birth_date.toISOString().slice(0, 10) : String(row.birth_date).slice(0, 10)) : null,
    createdAt: dTime(row.created_at),
    updatedAt: dTime(row.updated_at),
    extra: row.extra_json ? JSON.parse(row.extra_json) : {},
  };
}

function rowToGreeting(row) {
  if (!row) return row;
  const dTime = (v) => { if (!v) return null; return (v instanceof Date) ? v.toISOString() : new Date(v).toISOString(); };
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name || null,
    year: row.greeting_year,
    message: row.message,
    sentAt: dTime(row.sent_at),
  };
}

function defaultGreetingMessage(name) {
  return `🎉 Happy Birthday, ${name || 'there'}! Wishing you a fantastic day from the whole team!`;
}

// GET /api/:slug/birthday_module?userId=... — this user's birth date, or all
// profiles (sorted by upcoming month/day) when no userId is given.
router.get('/', async (req, res) => {
  try {
    if (req.query.userId) {
      const row = await req.db('birthday_profiles').where({ user_id: req.query.userId }).first();
      if (!row) return res.json({ id: null, userId: req.query.userId, userName: null, birthDate: null, createdAt: null, updatedAt: null, extra: {} });
      return res.json(rowToProfile(row));
    }
    const rows = await req.db('birthday_profiles').select('*');
    const withParts = rows.map(r => {
      const d = r.birth_date instanceof Date ? r.birth_date : new Date(r.birth_date);
      return { row: r, month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    });
    withParts.sort((a, b) => (a.month - b.month) || (a.day - b.day));
    res.json(withParts.map(x => rowToProfile(x.row)));
  } catch (e) { console.error('GET /birthday_module failed:', e); res.status(500).json({ error: 'Could not load birthdays. Please try again.' }); }
});

// POST /api/:slug/birthday_module — save (create or overwrite) a user's birth date.
// Frontend sends: { userId, userName, birthDate } where birthDate is 'YYYY-MM-DD'.
router.post('/', async (req, res) => {
  try {
    const body = { ...req.body };
    if (!body.userId || !String(body.userId).trim()) {
      return res.status(400).json({ error: 'userId is required' });
    }
    if (!body.birthDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(body.birthDate))) {
      return res.status(400).json({ error: 'birthDate is required in YYYY-MM-DD format' });
    }
    const userId = String(body.userId).trim();
    const userName = body.userName || null;
    const birthDate = body.birthDate;
    const now = new Date();

    const existing = await req.db('birthday_profiles').where({ user_id: userId }).first();
    if (existing) {
      await req.db('birthday_profiles').where({ user_id: userId }).update({ birth_date: birthDate, user_name: userName || existing.user_name, updated_at: now });
    } else {
      const id = 'bday' + Date.now() + Math.floor(Math.random() * 1000);
      await req.db('birthday_profiles').insert({ id, user_id: userId, user_name: userName, birth_date: birthDate, created_at: now });
    }

    const saved = rowToProfile(await req.db('birthday_profiles').where({ user_id: userId }).first());
    req.io.to(req.company.slug).emit('birthday:saved', saved);
    res.json(saved);
  } catch (e) { console.error('POST /birthday_module failed:', e); res.status(500).json({ error: 'Could not save birth date. Please try again.' }); }
});

// GET /api/:slug/birthday_module/today — the feature that "sends" the greeting:
// finds every profile whose month/day matches today, and for anyone who
// hasn't already gotten this year's greeting, creates+emits it now. Safe to
// call repeatedly (e.g. once per page load) — a user only ever gets one
// greeting row per calendar year thanks to the unique (user_id, year) index.
router.get('/today', async (req, res) => {
  try {
    const now = new Date();
    const month = now.getUTCMonth() + 1;
    const day = now.getUTCDate();
    const year = now.getUTCFullYear();

    const rows = await req.db('birthday_profiles').select('*');
    const todays = rows.filter(r => {
      const d = r.birth_date instanceof Date ? r.birth_date : new Date(r.birth_date);
      return (d.getUTCMonth() + 1) === month && d.getUTCDate() === day;
    });

    const results = [];
    for (const profile of todays) {
      let greetingRow = await req.db('birthday_greetings').where({ user_id: profile.user_id, greeting_year: year }).first();
      let justSent = false;
      if (!greetingRow) {
        const message = defaultGreetingMessage(profile.user_name);
        const id = 'bgreet' + Date.now() + Math.floor(Math.random() * 1000);
        try {
          await req.db('birthday_greetings').insert({ id, user_id: profile.user_id, user_name: profile.user_name, greeting_year: year, message, sent_at: new Date() });
          justSent = true;
        } catch (e) {
          // Unique index race (two simultaneous requests) — someone else just inserted it; fall through and re-read.
        }
        greetingRow = await req.db('birthday_greetings').where({ user_id: profile.user_id, greeting_year: year }).first();
      }
      const greeting = rowToGreeting(greetingRow);
      if (justSent) req.io.to(req.company.slug).emit('birthday:greeting', greeting);
      results.push({ userId: profile.user_id, userName: profile.user_name, birthDate: rowToProfile(profile).birthDate, greeting, justSent });
    }

    res.json(results);
  } catch (e) { console.error('GET /birthday_module/today failed:', e); res.status(500).json({ error: 'Could not check today\'s birthdays. Please try again.' }); }
});

// GET /api/:slug/birthday_module/greetings?userId=...&limit=... — history of
// greetings already sent (used to show a user their own past birthday messages).
router.get('/greetings', async (req, res) => {
  try {
    let q = req.db('birthday_greetings').orderBy('sent_at', 'desc');
    if (req.query.userId) q = q.where('user_id', req.query.userId);
    if (req.query.limit) q = q.limit(Number(req.query.limit) || 20);
    const rows = await q;
    res.json(rows.map(rowToGreeting));
  } catch (e) { console.error('GET /birthday_module/greetings failed:', e); res.status(500).json({ error: 'Could not load greetings. Please try again.' }); }
});

module.exports = router;
