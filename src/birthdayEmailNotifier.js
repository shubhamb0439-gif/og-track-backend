const config = require('./config');
const coreDb = require('./db/core');
const { getTenantDbByName } = require('./db/tenantConnections');
const { sendEmail } = require('./utils/email');

/**
 * Daily birthday-announcement email, requested 2026-11-09. Reuses
 * dbo.users.date_of_birth (patch_01) — the field that's actually populated
 * today (at registration, or later via the user's own "enter your DOB"
 * flow) — NOT the separate, module-gated dbo.employee_birthdays table
 * (ogtrack-sql-schema/tenant/16_module_birthday.sql), which no company
 * currently has enabled and holds almost no real data.
 *
 * Checked hourly across every active company; the real once-a-year guard
 * per matched user is their own last_birthday_email_year column
 * (patch_23) — same convention as the standalone Birthday module's
 * employee_birthdays.last_greeted_year.
 */

let pollTimer = null;
let running = false;

function todayUtc() {
  const now = new Date();
  return { month: now.getUTCMonth() + 1, day: now.getUTCDate(), year: now.getUTCFullYear() };
}

async function checkCompany(company, { month, day, year }) {
  const db = getTenantDbByName(company.db_name);

  const birthdayUsers = await db('users')
    .where({ status: 'active' })
    .whereNotNull('date_of_birth')
    .whereRaw('MONTH(date_of_birth) = ? AND DAY(date_of_birth) = ?', [month, day])
    .andWhere(function () {
      this.whereNull('last_birthday_email_year').orWhere('last_birthday_email_year', '!=', year);
    })
    .select('id', 'name');

  if (!birthdayUsers.length) return;

  const recipients = await db('users').where({ status: 'active' }).whereNotNull('email').select('email', 'name');
  if (!recipients.length) return;

  const names = birthdayUsers.map((u) => u.name || 'a colleague');
  const subject = names.length === 1
    ? `🎉 It's ${names[0]}'s birthday today!`
    : `🎉 Birthdays today: ${names.join(', ')}`;
  const html = `
    <p>Join us in wishing <strong>${names.join(', ')}</strong> a very happy birthday today! 🎂</p>
    <p>— AIDA, on behalf of ${company.name || company.slug}</p>
  `;
  const text = html.replace(/<[^>]+>/g, '').trim();

  for (const r of recipients) {
    try {
      await sendEmail({ to: r.email, subject, html, text });
    } catch (e) {
      console.error(`[birthday-email] failed to email ${r.email} (${company.slug}):`, e.message);
    }
  }

  await db('users').whereIn('id', birthdayUsers.map((u) => u.id)).update({ last_birthday_email_year: year });
  console.log(`[birthday-email] sent birthday announcement for ${names.join(', ')} to ${recipients.length} users in ${company.slug}`);
}

async function checkAndRun() {
  if (running || !config.email.enabled) return;
  running = true;
  try {
    const today = todayUtc();
    const companies = await coreDb('companies').where({ status: 'active' }).select('slug', 'db_name', 'name');
    for (const company of companies) {
      try {
        await checkCompany(company, today);
      } catch (e) {
        console.error(`[birthday-email] ${company.slug} check failed:`, e.message);
      }
    }
  } finally {
    running = false;
  }
}

/** Call once from server.js. No-op if email isn't configured. */
function start() {
  if (!config.email.enabled) {
    console.log('[birthday-email] Email not configured — scheduler not started.');
    return;
  }
  if (pollTimer) return;
  checkAndRun().catch((e) => console.error('[birthday-email] initial check failed:', e.message));
  pollTimer = setInterval(checkAndRun, config.birthdayEmail.checkIntervalMs);
  pollTimer.unref?.();
}

module.exports = { start, checkAndRun };
