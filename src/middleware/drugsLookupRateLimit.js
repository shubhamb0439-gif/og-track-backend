const rateLimit = require('express-rate-limit');

// Public drug-lookup endpoint (src/routes/drugs.js) is reachable from the
// open internet with no login — same "no throttling at all is a real gap"
// reasoning as loginRateLimit.js (AIDA roadmap item 21), just a looser limit
// since a real user's extension may fire several lookups per page load while
// browsing, not just a handful of attempts total. Keyed on the real client
// IP, which needs `app.set('trust proxy', 1)` in server.js (already set).
const drugsLookupRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});

module.exports = { drugsLookupRateLimit };
