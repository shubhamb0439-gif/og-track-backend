const rateLimit = require('express-rate-limit');

// AIDA roadmap item 21 — stops scripted brute-forcing of login/refresh
// endpoints (there was no throttling at all before this). Keyed on the real
// client IP, which requires `app.set('trust proxy', 1)` in server.js (already
// set) — without it every request would appear to come from Azure's proxy
// and share one counter. 10 attempts / 10 minutes is loose enough that a
// real person mistyping a password a few times is never affected.
const loginRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in a few minutes.' },
});

module.exports = { loginRateLimit };
