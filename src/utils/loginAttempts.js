const coreDb = require('../db/core');

// AIDA roadmap item 21 — writes a row to the shared OGCore `login_attempts`
// table for every login attempt (success or failure) on either login
// surface. Never throws into the caller: a logging failure must not block a
// real login, so any DB error here is swallowed after a console.error, same
// "best-effort, never block the real action" convention used for things like
// sendWhatsAppMessage elsewhere in this codebase.
async function recordLoginAttempt({ scope, companySlug = null, emailTried, ip, success }) {
  try {
    await coreDb('login_attempts').insert({
      scope,
      company_slug: companySlug,
      email_tried: String(emailTried || '').toLowerCase(),
      ip: ip || null,
      success: !!success,
    });
  } catch (e) {
    console.error('[login_attempts] failed to record attempt:', e.message);
  }
}

module.exports = { recordLoginAttempt };
