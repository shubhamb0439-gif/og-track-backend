const { getActiveConnectionForCompany } = require('./zohoAuth');

/**
 * Zoho Books data access, scoped per OG Track company. Every call resolves
 * that company's connection (access token + organization_id + filter) via
 * zohoAuth.getActiveConnectionForCompany, so callers never handle tokens/org
 * ids themselves.
 *
 * Isolation for a company that shares an org with another (e.g. Sitara
 * Drapes inside OG Plus's org) is live-verified to work one of two ways,
 * never both at once for the same company:
 *   - branchId: a real Zoho "Location" (formerly Branch) — NOT used by OG
 *     Plus's actual org (confirmed live: Locations is disabled there).
 *   - customerIdsFilter: a list of specific customer contact_ids — THIS is
 *     what OG Plus's org actually uses for Sitara (three placeholder
 *     customer contacts split by GST jurisdiction: Intrastate/Interstate/
 *     Overseas, confirmed live by inspecting their real invoice numbers,
 *     e.g. SIT-00166). Invoices/bills/expenses support filtering by this;
 *     reports (P&L/balance sheet) do NOT — see getProfitAndLoss below.
 *
 * Report endpoint paths (getProfitAndLoss/getBalanceSheet) are still
 * best-effort from Zoho Books' established API shape, not yet hands-on
 * verified — the org connected so far doesn't expose a reason to call them
 * yet. Flagging rather than asserting these are confirmed.
 */

class ZohoNotConnectedError extends Error {
  constructor(companyId) {
    super(`No Zoho Books connection is linked for company ${companyId} yet.`);
    this.name = 'ZohoNotConnectedError';
    this.companyId = companyId;
  }
}

async function getConnection(companyId) {
  const conn = await getActiveConnectionForCompany(companyId);
  if (!conn) throw new ZohoNotConnectedError(companyId);
  return conn;
}

async function zohoRequest(conn, method, path, { query = {}, body } = {}) {
  const u = new URL(`/books/v3${path}`, conn.apiDomain);
  u.searchParams.set('organization_id', conn.organizationId);
  if (conn.branchId) u.searchParams.set('branch_id', conn.branchId);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) u.searchParams.set(k, v);

  const res = await fetch(u.toString(), {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${conn.accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok || data.code !== 0) throw new Error(`Zoho Books API error (${path}): ${data.message || res.status}`);
  return data;
}

/**
 * Fully pages through a list endpoint (Zoho defaults to 200/page and sets
 * page_context.has_more_page) rather than silently returning just page 1 —
 * live-verified this org alone has 239 contacts, well past one page, so
 * every list endpoint needs this, not just the ones that happen to be big
 * today.
 */
async function paginatedList(conn, path, listKey, query = {}) {
  let page = 1;
  let all = [];
  for (;;) {
    const data = await zohoRequest(conn, 'GET', path, { query: { ...query, page } });
    all = all.concat(data[listKey] || []);
    if (!data.page_context?.has_more_page) break;
    page += 1;
  }
  return all;
}

/** For invoices/bills/expenses: when the company is isolated by specific customer contacts (not a real Zoho branch), fetches once per customer_id and merges — using Zoho's own server-side filter rather than guessing client-side. */
async function paginatedListFilteredByCustomers(conn, path, listKey, query, customerIds) {
  if (!customerIds?.length) return paginatedList(conn, path, listKey, query);
  const perCustomer = await Promise.all(customerIds.map((customerId) => paginatedList(conn, path, listKey, { ...query, customer_id: customerId })));
  return perCustomer.flat();
}

// ---- Read endpoints -------------------------------------------------------

async function getInvoices(companyId, { status, customerId } = {}) {
  const conn = await getConnection(companyId);
  if (customerId) return paginatedList(conn, '/invoices', 'invoices', { status, customer_id: customerId });
  return paginatedListFilteredByCustomers(conn, '/invoices', 'invoices', { status }, conn.customerIdsFilter);
}

async function getBills(companyId, { status } = {}) {
  const conn = await getConnection(companyId);
  return paginatedListFilteredByCustomers(conn, '/bills', 'bills', { status }, conn.customerIdsFilter);
}

async function getExpenses(companyId) {
  const conn = await getConnection(companyId);
  return paginatedListFilteredByCustomers(conn, '/expenses', 'expenses', {}, conn.customerIdsFilter);
}

/**
 * contact_type: "customer" | "vendor" — omit for both. NOT filtered by
 * customerIdsFilter even for a customer-isolated company like Sitara — that
 * filter identifies WHICH transactions belong to Sitara, it isn't a
 * statement about which vendors/contacts are "Sitara's own" (there's no
 * such ownership concept for a shared org's contact list).
 */
async function getContacts(companyId, { contactType } = {}) {
  const conn = await getConnection(companyId);
  return paginatedList(conn, '/contacts', 'contacts', { contact_type: contactType });
}

/** Bank accounts belong to the whole org, not any one sub-business sharing it — never customer-filtered. */
async function getBankAccounts(companyId) {
  const conn = await getConnection(companyId);
  return paginatedList(conn, '/bankaccounts', 'bankaccounts');
}

/**
 * Whole-organization figures ONLY. Zoho's P&L/Balance Sheet reports have no
 * way to filter down to "just these customers' transactions" — that's a
 * real platform limitation, not something this code works around. For a
 * company isolated by customerIdsFilter (like Sitara), these numbers would
 * silently include OG Plus's figures too, which is worse than not showing a
 * report at all — so this throws instead of returning something misleading.
 * A company's own real P&L (like OG Plus, or CAJO) is unaffected.
 */
async function getProfitAndLoss(companyId, { fromDate, toDate } = {}) {
  const conn = await getConnection(companyId);
  if (conn.customerIdsFilter?.length) {
    throw new Error('Zoho has no way to filter a P&L report to specific customers — this company shares an org and can only see org-wide reports, which would misrepresent its own figures. Not available for this company.');
  }
  return zohoRequest(conn, 'GET', '/reports/profitandloss', { query: { from_date: fromDate, to_date: toDate } });
}

async function getBalanceSheet(companyId, { toDate } = {}) {
  const conn = await getConnection(companyId);
  if (conn.customerIdsFilter?.length) {
    throw new Error('Zoho has no way to filter a balance sheet to specific customers — this company shares an org and can only see org-wide reports, which would misrepresent its own figures. Not available for this company.');
  }
  return zohoRequest(conn, 'GET', '/reports/balancesheet', { query: { to_date: toDate } });
}

/** Lists the Locations (Zoho's current name for Branches) inside this company's org — empty if the org never enabled that feature, as confirmed live for OG Plus's own org. */
async function listBranches(companyId) {
  const conn = await getConnection(companyId);
  return paginatedList(conn, '/branches', 'branches');
}

// ---- Write path: push a locally-created sale out as a real Zoho invoice ---

/**
 * Finds a Zoho contact by exact name match, or creates one — the minimum
 * viable customer-matching strategy for a first cut. Does NOT attempt
 * fuzzy matching or merge-on-email (a real customer-dedup pass is a
 * reasonable later refinement once real sync volume shows whether exact-name
 * matching is actually good enough in practice).
 */
async function findOrCreateCustomer(companyId, { name, email, phone }) {
  const existing = await getContacts(companyId, { contactType: 'customer' });
  const match = existing.find((c) => (c.contact_name || '').trim().toLowerCase() === (name || '').trim().toLowerCase());
  if (match) return match.contact_id;

  const conn = await getConnection(companyId);
  const created = await zohoRequest(conn, 'POST', '/contacts', {
    body: { contact_name: name, contact_type: 'customer', email: email || undefined, phone: phone || undefined },
  });
  return created.contact.contact_id;
}

/**
 * Pushes one local sale out as a real Zoho invoice. Best-effort by design
 * (same convention as BigCommerce/Razorpay elsewhere in this codebase) —
 * callers should catch and log rather than let a Zoho failure block or roll
 * back the local sale that already happened.
 */
async function createInvoice(companyId, { customer, lineItems, invoiceNumber, date }) {
  const customerId = await findOrCreateCustomer(companyId, customer);
  const conn = await getConnection(companyId);
  const created = await zohoRequest(conn, 'POST', '/invoices', {
    body: {
      customer_id: customerId,
      reference_number: invoiceNumber || undefined,
      date: date || undefined,
      line_items: lineItems.map((li) => ({
        name: li.name, description: li.description || undefined,
        rate: li.rate, quantity: li.quantity,
      })),
    },
  });
  return { zohoInvoiceId: created.invoice.invoice_id, zohoInvoiceNumber: created.invoice.invoice_number };
}

module.exports = {
  ZohoNotConnectedError,
  getInvoices, getBills, getExpenses, getContacts, getBankAccounts,
  getProfitAndLoss, getBalanceSheet, listBranches,
  createInvoice,
};
