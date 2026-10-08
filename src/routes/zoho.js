const express = require('express');
const { requireAuth } = require('../utils/auth');
const requireRole = require('../middleware/requireRole');
const zohoClient = require('../zoho/zohoClient');

/**
 * Tenant-facing Zoho Books views (AIDA roadmap item 5) — read-only, scoped to
 * THIS company only (req.company.id, set by resolveTenant). Gated to
 * accounts_manager/superadmin specifically, not manager/developer/tester —
 * a deliberately narrower set than the roles used elsewhere (e.g. item 4b's
 * report-approval gate), since this is real financial data.
 *
 * Mount: app.use('/api/:slug/zoho', resolveTenant, zohoRoutes) — same
 * pattern as every other tenant router, requireAuth/requireRole applied
 * per-route below rather than once for the whole router, matching
 * attendance.js's own mixed-gating convention.
 */

const router = express.Router();
const ALLOWED_ROLES = ['accounts_manager', 'superadmin'];

function handleZohoError(res, e) {
  if (e instanceof zohoClient.ZohoNotConnectedError) {
    return res.status(409).json({ error: 'This company has no Zoho Books connection linked yet — ask master admin to connect it.' });
  }
  res.status(502).json({ error: e.message });
}

router.get('/invoices', requireAuth, requireRole(ALLOWED_ROLES), async (req, res) => {
  try { res.json({ invoices: await zohoClient.getInvoices(req.company.id, { status: req.query.status }) }); }
  catch (e) { handleZohoError(res, e); }
});

router.get('/bills', requireAuth, requireRole(ALLOWED_ROLES), async (req, res) => {
  try { res.json({ bills: await zohoClient.getBills(req.company.id, { status: req.query.status }) }); }
  catch (e) { handleZohoError(res, e); }
});

router.get('/expenses', requireAuth, requireRole(ALLOWED_ROLES), async (req, res) => {
  try { res.json({ expenses: await zohoClient.getExpenses(req.company.id) }); }
  catch (e) { handleZohoError(res, e); }
});

router.get('/contacts', requireAuth, requireRole(ALLOWED_ROLES), async (req, res) => {
  try { res.json({ contacts: await zohoClient.getContacts(req.company.id, { contactType: req.query.type }) }); }
  catch (e) { handleZohoError(res, e); }
});

router.get('/bank-accounts', requireAuth, requireRole(ALLOWED_ROLES), async (req, res) => {
  try { res.json({ bankAccounts: await zohoClient.getBankAccounts(req.company.id) }); }
  catch (e) { handleZohoError(res, e); }
});

router.get('/reports/profit-and-loss', requireAuth, requireRole(ALLOWED_ROLES), async (req, res) => {
  try { res.json(await zohoClient.getProfitAndLoss(req.company.id, { fromDate: req.query.from, toDate: req.query.to })); }
  catch (e) { handleZohoError(res, e); }
});

router.get('/reports/balance-sheet', requireAuth, requireRole(ALLOWED_ROLES), async (req, res) => {
  try { res.json(await zohoClient.getBalanceSheet(req.company.id, { toDate: req.query.to })); }
  catch (e) { handleZohoError(res, e); }
});

module.exports = router;
