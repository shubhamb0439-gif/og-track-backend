const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config');

/**
 * Masteradmin-only Azure spend dashboard (AIDA roadmap item 6). Mounted
 * masteradmin-only, no resolveTenant — same convention as
 * masteradminZoho.js. A SEPARATE Azure AD app registration from the app's
 * own identity, scoped via IAM to ONLY "Cost Management Reader" on the
 * subscription (read-only spend data).
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

// Management-API bearer token, cached in-memory until shortly before it
// expires — a client-credentials token is good for ~1hr, no reason to
// fetch a fresh one on every request.
let cachedToken = null; // { value, expiresAt }

async function getManagementToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.azureCost.clientId,
    client_secret: config.azureCost.clientSecret,
    scope: 'https://management.azure.com/.default',
  });
  const res = await fetch(`https://login.microsoftonline.com/${config.azureCost.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Azure AD token request failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

/** Trailing-30-day actual cost, grouped by the given Cost Management dimension (e.g. "ResourceGroup", "ServiceName"). */
async function queryCostByDimension(dimension) {
  const token = await getManagementToken();
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  const body = {
    type: 'ActualCost',
    timeframe: 'Custom',
    timePeriod: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
    dataset: {
      granularity: 'None',
      aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
      grouping: [{ type: 'Dimension', name: dimension }],
    },
  };
  const url = `https://management.azure.com/subscriptions/${config.azureCost.subscriptionId}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Cost Management query failed (${res.status}): ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  const columns = (data.properties?.columns || []).map((c) => c.name);
  const costIdx = columns.indexOf('Cost');
  const dimIdx = columns.indexOf(dimension);
  const currencyIdx = columns.indexOf('Currency');
  const rows = data.properties?.rows || [];
  return rows
    .map((r) => ({
      name: dimIdx >= 0 ? r[dimIdx] : 'Unknown',
      cost: costIdx >= 0 ? Number(r[costIdx]) : 0,
      currency: currencyIdx >= 0 ? r[currencyIdx] : 'USD',
    }))
    .sort((a, b) => b.cost - a.cost);
}

// 15-minute cache — Cost Management data doesn't change intra-day, and the
// API has its own rate limits, so no reason to hit it on every page load.
const CACHE_MS = 15 * 60 * 1000;
let summaryCache = null; // { data, cachedAt }

router.get('/summary', requireMasterAdmin, async (req, res) => {
  if (!config.azureCost.enabled) {
    return res.status(400).json({ error: 'Azure Cost Management is not configured (missing AZURE_COST_TENANT_ID/CLIENT_ID/CLIENT_SECRET/SUBSCRIPTION_ID).' });
  }
  try {
    if (summaryCache && Date.now() - summaryCache.cachedAt < CACHE_MS) {
      return res.json({ ...summaryCache.data, cached: true });
    }
    const [byResourceGroup, byService] = await Promise.all([
      queryCostByDimension('ResourceGroup'),
      queryCostByDimension('ServiceName'),
    ]);
    const totalCost = byResourceGroup.reduce((sum, r) => sum + r.cost, 0);
    const currency = byResourceGroup[0]?.currency || byService[0]?.currency || 'USD';
    const data = {
      windowDays: 30,
      totalCost,
      currency,
      byResourceGroup,
      byService,
      generatedAt: new Date().toISOString(),
    };
    summaryCache = { data, cachedAt: Date.now() };
    res.json({ ...data, cached: false });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
