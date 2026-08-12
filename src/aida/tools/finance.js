const { callTenantApi } = require('../apiClient');

/**
 * OG Track has no dedicated invoicing/payments module today — there's no
 * "amount paid" or "amount due" field anywhere in the schema. These tools
 * approximate "pending payments" with the closest real data that exists:
 * money owed BY customers (open/late customer purchase orders) and money
 * owed TO vendors (pending/partial vendor purchase orders). If a real
 * finance/invoicing module is added later, add a finance_get_* tool next to
 * these and it shows up automatically — nothing else changes.
 */
module.exports = [
  {
    name: 'finance_get_pending_receivables',
    description:
      'Money likely owed BY customers: customer purchase orders that are still open or running late ' +
      '(not yet fulfilled/closed). Approximates "pending payments" — OG Track has no invoicing module yet.',
    requiredModules: ['crm'],
    inputSchema: { type: 'object', properties: {} },
    async handler(context) {
      const rows = await callTenantApi(context, 'GET', '/crm/customer-purchase-orders');
      const pending = (rows || []).filter((po) => po.status === 'open' || po.status === 'late');
      return { count: pending.length, pendingCustomerOrders: pending };
    },
  },

  {
    name: 'finance_get_pending_payables',
    description:
      'Money likely owed TO vendors: purchase orders still pending or partially received (not fully paid off). ' +
      'Approximates "pending payments" on the purchasing side.',
    requiredModules: ['inventory'],
    inputSchema: { type: 'object', properties: {} },
    async handler(context) {
      const rows = await callTenantApi(context, 'GET', '/inventory/purchases');
      const pending = (rows || []).filter((p) => p.status === 'pending' || p.status === 'partial');
      return { count: pending.length, pendingVendorPurchases: pending };
    },
  },

  {
    name: 'finance_get_accounting_clients',
    description: 'List clients tracked in the accounting/EOD module, optionally filtered by status.',
    requiredModules: ['acc_clients', 'acc_timer', 'acc_eod'],
    inputSchema: { type: 'object', properties: {} },
    async handler(context) {
      const rows = await callTenantApi(context, 'GET', '/acc/clients');
      return { count: (rows || []).length, clients: rows };
    },
  },

  {
    name: 'finance_get_flagged_eod_reports',
    description: "End-of-day accounting reports that were flagged for review, optionally for a given date.",
    requiredModules: ['acc_eod'],
    inputSchema: {
      type: 'object',
      properties: { date: { type: 'string', description: 'YYYY-MM-DD' } },
    },
    async handler(context, { date } = {}) {
      const rows = await callTenantApi(context, 'GET', '/acc/eod-reports', { query: { status: 'flagged', date } });
      return { count: (rows || []).length, flaggedReports: rows };
    },
  },
];
