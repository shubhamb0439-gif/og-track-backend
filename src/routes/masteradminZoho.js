const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config');
const coreDb = require('../db/core');
const zohoAuth = require('../zoho/zohoAuth');
const zohoClient = require('../zoho/zohoClient');

/**
 * Masteradmin-only Zoho Books connection management (AIDA roadmap item 5).
 * Mounted masteradmin-only, no resolveTenant — same convention as the rest
 * of routes/masteradmin.js. A "connection" is per Zoho organization; a
 * separate "link" maps an OG Track company onto one, with an optional
 * branch_id — see patch_06_zoho_connections.sql for why.
 */

const router = express.Router();

function requireMasterAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role !== 'masteradmin') return res.status(403).json({ error: 'Forbidden' });
    req.admin = payload;
    next();
  } catch { res.status(401).json({ error: 'Invalid or expired token' }); }
}

// In-memory, short-lived — a connect flow is a single browser round trip
// (redirect out to Zoho, redirect back seconds later), not something that
// needs to survive a server restart. Maps Zoho's `state` param back to which
// company initiated the connect, since Zoho's callback carries no other
// context of ours.
const pendingConnects = new Map();

router.get('/connections', requireMasterAdmin, async (req, res) => {
  const [connections, links] = await Promise.all([zohoAuth.listConnections(), zohoAuth.listCompanyLinks()]);
  res.json({ connections, links });
});

/** Step 1 — redirects the admin's browser to Zoho's consent screen for the given company. */
router.get('/connect', requireMasterAdmin, async (req, res) => {
  if (!config.zoho.enabled) return res.status(400).json({ error: 'Zoho is not configured — missing ZOHO_CLIENT_ID/ZOHO_CLIENT_SECRET.' });
  const { companyId } = req.query;
  if (!companyId) return res.status(400).json({ error: 'companyId is required' });
  const company = await coreDb('companies').where({ id: companyId }).first();
  if (!company) return res.status(404).json({ error: 'Company not found' });

  const state = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  pendingConnects.set(state, { companyId, companyName: company.name, requestedBy: req.admin.email || req.admin.id });
  res.json({ authUrl: zohoAuth.buildAuthUrl(state) });
});

/** Step 2 — Zoho redirects the browser here after consent. Exchanges the code, resolves the org, links this flow's company to it. */
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send(`Zoho denied access: ${error}`);
  const pending = state && pendingConnects.get(state);
  if (!pending) return res.status(400).send('This connect link has expired or was already used — start again from the masteradmin panel.');
  pendingConnects.delete(state);

  try {
    const tokens = await zohoAuth.exchangeCodeForTokens(code);
    const orgs = await zohoAuth.listOrganizations(tokens.access_token, tokens.api_domain);
    // A Zoho account can have multiple organizations; the one just granted
    // is whichever the human picked on Zoho's own consent screen — Zoho
    // doesn't tell us which directly, so take the first (the common case:
    // one org per Zoho account). Multi-org accounts may need a follow-up
    // "which org did you mean" step once this is actually hands-on tested.
    const org = orgs[0];
    if (!org) return res.status(400).send('No Zoho organization found on this account.');

    const connectionId = await zohoAuth.upsertConnectionByOrg({
      displayName: org.name, zohoOrganizationId: org.organization_id, tokens, connectedBy: pending.requestedBy,
    });
    await zohoAuth.linkCompany({ companyId: pending.companyId, zohoConnectionId: connectionId });

    res.send(`<html><body style="font-family:sans-serif;padding:40px"><h2>Connected ${pending.companyName} to Zoho org "${org.name}"</h2><p>You can close this tab and return to the masteradmin panel.</p></body></html>`);
  } catch (e) {
    res.status(500).send(`Zoho connect failed: ${e.message}`);
  }
});

/** Links an ADDITIONAL company to an already-connected org (e.g. Sitara joining OG Plus's existing connection), optionally scoped to one Branch. No new OAuth round trip needed. */
router.post('/connections/:connectionId/link-company', requireMasterAdmin, async (req, res) => {
  const { connectionId } = req.params;
  const { companyId, branchId } = req.body;
  if (!companyId) return res.status(400).json({ error: 'companyId is required' });
  const conn = await coreDb('zoho_connections').where({ id: connectionId }).first();
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  await zohoAuth.linkCompany({ companyId, zohoConnectionId: connectionId, zohoBranchId: branchId });
  res.json({ ok: true });
});

/** Lists the Branches inside a connection's org — for picking a branchId when linking a second company. */
router.get('/connections/:connectionId/branches', requireMasterAdmin, async (req, res) => {
  // listBranches is scoped by companyId, not connectionId, in zohoClient —
  // resolve via any company already linked to this connection.
  const link = await coreDb('zoho_company_links').where({ zoho_connection_id: req.params.connectionId }).first();
  if (!link) return res.status(404).json({ error: 'No company is linked to this connection yet — link one first (even unbranched), then list branches.' });
  try {
    const branches = await zohoClient.listBranches(link.company_id);
    res.json({ branches });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
