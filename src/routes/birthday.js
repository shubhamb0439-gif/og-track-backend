const express = require('express');

const router = express.Router();

// Rehydrate a DB row into the shape the frontend expects (camelCase, parsed JSON).
function rowToBirthday(row) {
  if (!row) return row;
  const dTime = (v) => { if (!v) return null; return (v instanceof Date) ? v.toISOString() : new Date(v).toISOString(); };
  const dDate = (v) => { if (!v) return null; return (v instanceof Date) ? v.toISOString().slice(0, 10) : String(v).slice(0, 10); };
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name || null,
    birthDate: dDate(row.birth_date),
    birthMonth: row.birth_month,
    birthDay: row.birth_day,
    lastGreetedYear: row.last_greeted_year || null,
    createdAt: dTime(row.created_at),
    updatedAt: dTime(row.updated_at),
    extra: row.extra_json ? JSON.parse(row.extra_json) : {},
  };
}

function parseBirthDate(input) {
  // Accepts 'YYYY-MM-DD' (and also tolerates a full ISO datetime string).
  const s = String(input).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { dateStr: s, month, day };
}

// GET /api/:slug/birthday — everyone's saved birthday (used by the team list view).
router.get('/', async (req, res) => {
  try {
    const rows = await req.db('employee_birthdays as eb')
      .leftJoin('users as u', 'u.id', 'eb.user_id')
      .select('eb.*', 'u.name as user_name')
      .orderBy(['eb.birth_month', 'eb.birth_day']);
    res.json(rows.map(rowToBirthday));
  } catch (e) { console.error('GET /birthday failed:', e); res.status(500).json({ error: 'Could not load birthdays. Please try again.' }); }
});

// GET /api/:slug/birthday/me?userId=... — the calling user's own saved birthday (or null fields if not set yet).
router.get('/me', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    const row = await req.db('employee_birthdays as eb')
      .leftJoin('users as u', 'u.id', 'eb.user_id')
      .select('eb.*', 'u.name as user_name')
      .where('eb.user_id', userId)
      .first();
    if (!row) return res.json({ id: null, userId, userName: null, birthDate: null, birthMonth: null, birthDay: null, lastGreetedYear: null, createdAt: null, updatedAt: null, extra: {} });
    res.json(rowToBirthday(row));
  } catch (e) { console.error('GET /birthday/me failed:', e); res.status(500).json({ error: 'Could not load your birthday. Please try again.' }); }
});

// GET /api/:slug/birthday/today — who's having a birthday today (used by the
// dashboard banner). Frontend calls this on load; any match that hasn't been
// greeted yet this calendar year is greeted right then (see POST below is
// not needed for that — this endpoint does it inline) and returned with
// justGreeted: true so the UI can show the celebratory toast/banner.
router.get('/today', async (req, res) => {
  try {
    const now = new Date();
    const month = now.getUTCMonth() + 1;
    const day = now.getUTCDate();
    const year = now.getUTCFullYear();

    const rows = await req.db('employee_birthdays as eb')
      .leftJoin('users as u', 'u.id', 'eb.user_id')
      .select('eb.*', 'u.name as user_name')
      .where({ 'eb.birth_month': month, 'eb.birth_day': day });

    const results = [];
    for (const row of rows) {
      let justGreeted = false;
      if (row.last_greeted_year !== year) {
        try {
          await req.db('birthday_greetings').insert({
            id: 'bg' + Date.now() + Math.floor(Math.random() * 1000),
            user_id: row.user_id,
            greeting_year: year,
            message: `Happy Birthday, ${row.user_name || 'there'}! 🎉`,
            sent_at: now,
          });
        } catch (insertErr) {
          // Unique (user_id, greeting_year) index — a duplicate here just means
          // another concurrent request already logged this year's greeting.
        }
        await req.db('employee_birthdays').where({ user_id: row.user_id }).update({ last_greeted_year: year });
        row.last_greeted_year = year;
        justGreeted = true;
        req.io.to(req.company.slug).emit('birthday:greeting', {
          userId: row.user_id,
          userName: row.user_name || null,
          message: `Happy Birthday, ${row.user_name || 'there'}! 🎉`,
        });
      }
      results.push({ ...rowToBirthday(row), justGreeted });
    }
    res.json(results);
  } catch (e) { console.error('GET /birthday/today failed:', e); res.status(500).json({ error: 'Could not check today\'s birthdays. Please try again.' }); }
});

// POST /api/:slug/birthday — save (create or overwrite) the calling user's birthday.
// Frontend sends: { userId, birthDate }  (birthDate as 'YYYY-MM-DD')
router.post('/', async (req, res) => {
  try {
    const body = { ...req.body };
    if (!body.userId || !String(body.userId).trim()) {
      return res.status(400).json({ error: 'userId is required' });
    }
    const parsed = parseBirthDate(body.birthDate);
    if (!parsed) {
      return res.status(400).json({ error: 'birthDate is required and must be a valid date (YYYY-MM-DD)' });
    }
    const userId = String(body.userId).trim();
    const now = new Date();

    const existing = await req.db('employee_birthdays').where({ user_id: userId }).first();
    if (existing) {
      await req.db('employee_birthdays').where({ user_id: userId }).update({
        birth_date: parsed.dateStr,
        birth_month: parsed.month,
        birth_day: parsed.day,
        updated_at: now,
        // A changed birthday means this year's greeting guard no longer applies.
        last_greeted_year: null,
      });
    } else {
      const id = 'bday' + Date.now() + Math.floor(Math.random() * 1000);
      await req.db('employee_birthdays').insert({
        id,
        user_id: userId,
        birth_date: parsed.dateStr,
        birth_month: parsed.month,
        birth_day: parsed.day,
        created_at: now,
      });
    }

    const saved = rowToBirthday(await req.db('employee_birthdays as eb')
      .leftJoin('users as u', 'u.id', 'eb.user_id')
      .select('eb.*', 'u.name as user_name')
      .where('eb.user_id', userId)
      .first());
    req.io.to(req.company.slug).emit('birthday:saved', saved);
    res.json(saved);
  } catch (e) { console.error('POST /birthday failed:', e); res.status(500).json({ error: 'Could not save your birthday. Please try again.' }); }
});

module.exports = router;
