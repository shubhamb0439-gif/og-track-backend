const express = require('express');
const coreDb = require('../db/core');
const { resolveTenant } = require('../db/tenantConnections');

const router = express.Router();

// ── Helpers ──────────────────────────────────────────────────────────────────
const dTime = (v) => { if (v == null) return null; return (v instanceof Date) ? v.toISOString() : new Date(v).toISOString(); };

function rowToBirthday(row) {
  if (!row) return row;
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name || null,
    month: row.birth_month,
    day: row.birth_day,
    year: row.birth_year == null ? null : row.birth_year,
    createdAt: dTime(row.created_at),
    updatedAt: dTime(row.updated_at),
  };
}

function rowToGreeting(row) {
  if (!row) return row;
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name || null,
    message: row.message,
    year: row.year,
    sentAt: dTime(row.sent_at),
  };
}

function buildMessage(name) {
  const who = name && String(name).trim() ? String(name).trim() : 'there';
  return `🎉 Happy Birthday, ${who}! Wishing you a fantastic day from all of us at OG Track.`;
}

// Looks at today's (server UTC) month/day, and for every saved birthday that
// matches, makes sure a greeting has been recorded for THIS calendar year —
// creating one (and only one, ever, per user per year — enforced by the
// unique index on birthday_greetings(user_id, year)) if it's missing. This is
// what "automatically sends a Happy Birthday message" means server-side:
// idempotent, safe to call as often as we like (every request to /today, plus
// the background sweep below), and it will never re-send the same year twice.
async function ensureTodaysGreetings(db) {
  const now = new Date();
  const month = now.getUTCMonth() + 1;
  const day = now.getUTCDate();
  const year = now.getUTCFullYear();

  const todaysBirthdays = await db('birthdays').where({ birth_month: month, birth_day: day });
  const created = [];
  for (const person of todaysBirthdays) {
    const already = await db('birthday_greetings').where({ user_id: person.user_id, year }).first();
    if (already) continue;
    const id = 'bgreet' + Date.now() + Math.floor(Math.random() * 1000);
    const greeting = {
      id,
      user_id: person.user_id,
      user_name: person.user_name,
      message: buildMessage(person.user_name),
      year,
      sent_at: now,
    };
    try {
      await db('birthday_greetings').insert(greeting);
      created.push(greeting);
    } catch (e) {
      // Unique-index collision means another concurrent check already sent
      // it a moment ago — not a real failure, just a race we lost harmlessly.
      if (!/unique|duplicate|UQ_birthday_greetings/i.test(e.message || '')) throw e;
    }
  }

  const all = await db('birthday_greetings').where({ year }).orderBy('sent_at', 'desc');
  return { all: all.map(rowToGreeting), created: created.map(rowToGreeting) };
}

// GET /api/:slug/birthday?userId=... — the calling user's saved birthday (or
// an empty placeholder if they haven't saved one yet).
router.get('/', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    const row = await req.db('birthdays').where({ user_id: userId }).first();
    if (!row) return res.json({ id: null, userId, userName: null, month: null, day: null, year: null });
    res.json(rowToBirthday(row));
  } catch (e) { console.error('GET /birthday failed:', e); res.status(500).json({ error: 'Could not load your birthday. Please try again.' }); }
});

// GET /api/:slug/birthday/all — everyone's saved birthdays (for a team
// "who's coming up" view), sorted by month/day.
router.get('/all', async (req, res) => {
  try {
    const rows = await req.db('birthdays').orderBy([{ column: 'birth_month', order: 'asc' }, { column: 'birth_day', order: 'asc' }]);
    res.json(rows.map(rowToBirthday));
  } catch (e) { console.error('GET /birthday/all failed:', e); res.status(500).json({ error: 'Could not load birthdays. Please try again.' }); }
});

// GET /api/:slug/birthday/today — today's birthday people + their greeting
// messages. Also the request-triggered half of the auto-send: calling this
// (e.g. when the frontend loads the Birthday view or dashboard) guarantees
// any birthday matching today already has its message generated.
router.get('/today', async (req, res) => {
  try {
    const { all, created } = await ensureTodaysGreetings(req.db);
    created.forEach(g => req.io.to(req.company.slug).emit('birthday:greeting', g));
    res.json(all);
  } catch (e) { console.error('GET /birthday/today failed:', e); res.status(500).json({ error: "Could not load today's birthdays. Please try again." }); }
});

// POST /api/:slug/birthday — save (create or overwrite) the calling user's birthday.
// Frontend sends: { userId, userName, month, day, year }  (year optional)
router.post('/', async (req, res) => {
  try {
    const body = { ...req.body };
    if (!body.userId || !String(body.userId).trim()) {
      return res.status(400).json({ error: 'userId is required' });
    }
    const month = Number(body.month);
    const day = Number(body.day);
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      return res.status(400).json({ error: 'month must be an integer between 1 and 12' });
    }
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      return res.status(400).json({ error: 'day must be an integer between 1 and 31' });
    }
    const year = body.year ? Number(body.year) : null;

    const userId = String(body.userId).trim();
    const userName = body.userName ? String(body.userName) : null;
    const now = new Date();

    const existing = await req.db('birthdays').where({ user_id: userId }).first();
    if (existing) {
      await req.db('birthdays').where({ user_id: userId }).update({
        birth_month: month,
        birth_day: day,
        birth_year: year,
        user_name: userName || existing.user_name,
        updated_at: now,
      });
    } else {
      const id = 'bday' + Date.now() + Math.floor(Math.random() * 1000);
      await req.db('birthdays').insert({
        id, user_id: userId, user_name: userName, birth_month: month, birth_day: day, birth_year: year, created_at: now,
      });
    }

    const saved = rowToBirthday(await req.db('birthdays').where({ user_id: userId }).first());
    req.io.to(req.company.slug).emit('birthday:saved', saved);
    res.json(saved);
  } catch (e) { console.error('POST /birthday failed:', e); res.status(500).json({ error: 'Could not save your birthday. Please try again.' }); }
});

// ── Background auto-send ─────────────────────────────────────────────────────
// The request-triggered check in GET /today covers the common case (someone
// opens the app that day), but the actual requirement is that the message
// gets sent automatically on the user's birthday — not "only if someone
// happens to load the Birthday view". This sweeps every tenant that has the
// 'birthday' module enabled on a timer so the greeting is generated the
// moment the day turns over regardless of traffic. It's best-effort and
// fully idempotent (ensureTodaysGreetings never creates a duplicate for the
// same user/year — enforced at the DB level too), so a failed tick just gets
// retried on the next one.
const SWEEP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

async function sweepAllTenants() {
  let companies;
  try {
    companies = await coreDb('companies').where({ status: 'active' });
  } catch (e) {
    console.error('[birthday] sweep: could not load companies:', e.message);
    return;
  }
  for (const company of companies) {
    try {
      const enabledModules = JSON.parse(company.enabled_modules || '[]');
      if (!enabledModules.includes('birthday')) continue;
      const { db } = await resolveTenant(company.slug);
      await ensureTodaysGreetings(db);
    } catch (e) {
      console.error(`[birthday] sweep failed for ${company.slug}:`, e.message);
    }
  }
}

/* istanbul ignore next -- background scheduler, not exercised by unit tests */
if (process.env.NODE_ENV !== 'test') {
  const timer = setInterval(sweepAllTenants, SWEEP_INTERVAL_MS);
  timer.unref?.();
  sweepAllTenants().catch(() => {}); // also sweep once shortly after boot
}

module.exports = router;
