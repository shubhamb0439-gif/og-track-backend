const { callTenantApi } = require('../apiClient');

/**
 * Sitara Drapes' own bespoke module (src/routes/sitara.js) — BigCommerce/
 * Razorpay order reconciliation, weavers/vendors/purchase-orders, a
 * dedicated customers+products catalog. Gated by whichever of the real
 * sitara_* modules the company has enabled (same modules server.js's own
 * `requireModule([...])` checks on the underlying routes — this is tool
 * VISIBILITY only; the real enforcement still happens there, same as every
 * other tool in this codebase).
 *
 * Every handler here is read-only (GET-backed), so masteradminCrossTenant.js
 * wraps all of these for free into masteradmin_sitara_* counterparts —
 * nothing extra needed to ask about Sitara's data from the masteradmin
 * panel with an explicit companySlug.
 */
module.exports = [
  {
    name: 'sitara_get_dashboard',
    description:
      'Sitara Drapes business overview: total sales, this month\'s sales, order count, pending order count, ' +
      'stock on hand, the 10 most recent orders, best-selling products, and top regions by revenue. Start here ' +
      'for any "how is the business doing" / "give me a summary" question before pulling individual records. ' +
      'These counts are OVERALL/current-state totals, NOT scoped to today or any specific date — for "how many ' +
      'orders came in today/this week" use sitara_list_orders with createdFrom/createdTo instead, never this tool.',
    requiredModules: ['sitara_dashboard'],
    inputSchema: { type: 'object', properties: {} },
    async handler(context) {
      return callTenantApi(context, 'GET', '/sitara/dashboard');
    },
  },

  {
    name: 'sitara_list_orders',
    description:
      'List Sitara Drapes orders (from BigCommerce, Razorpay, or manually entered), newest first. Filter by ' +
      'status (e.g. completed, awaiting_fulfillment, cancelled, refunded), source (bigcommerce|manual|recovered), ' +
      'search (matches order number or customer name), or createdFrom/createdTo for "how many orders came in ' +
      'today/this week/this month" style questions — compute the actual date range yourself (e.g. for "today", ' +
      'createdFrom = today\'s date at midnight, createdTo = tomorrow\'s date at midnight) and pass it here rather ' +
      'than guessing a count from an unfiltered total or from a status that doesn\'t mean what was asked (e.g. ' +
      '"orders received" is about WHEN an order was created, not whether its status happens to be "completed").',
    requiredModules: ['sitara_orders'],
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        source: { type: 'string' },
        search: { type: 'string' },
        createdFrom: { type: 'string', description: 'ISO date/datetime (inclusive) — orders created on or after this.' },
        createdTo: { type: 'string', description: 'ISO date/datetime (exclusive) — orders created before this.' },
      },
    },
    async handler(context, { status, source, search, createdFrom, createdTo } = {}) {
      const rows = await callTenantApi(context, 'GET', '/sitara/orders', { query: { status, source, search, createdFrom, createdTo } });
      return { count: (rows || []).length, orders: rows };
    },
  },

  {
    name: 'sitara_get_order',
    description: 'Full detail for one Sitara Drapes order, including its line items — customer, address, status, totals, and notes.',
    requiredModules: ['sitara_orders'],
    inputSchema: {
      type: 'object',
      properties: { orderId: { type: 'string', description: 'The order\'s internal id (from sitara_list_orders).' } },
      required: ['orderId'],
    },
    async handler(context, { orderId }) {
      return callTenantApi(context, 'GET', `/sitara/orders/${encodeURIComponent(orderId)}`);
    },
  },

  {
    name: 'sitara_list_customers',
    description: 'List Sitara Drapes customers. Filter by source (bigcommerce|whatsapp|instagram|manual) or search (matches name, email, or phone).',
    requiredModules: ['sitara_orders'],
    inputSchema: {
      type: 'object',
      properties: { search: { type: 'string' }, source: { type: 'string' } },
    },
    async handler(context, { search, source } = {}) {
      const rows = await callTenantApi(context, 'GET', '/sitara/customers', { query: { search, source } });
      return { count: (rows || []).length, customers: rows };
    },
  },

  {
    name: 'sitara_get_customer',
    description: 'Full detail for one Sitara Drapes customer, including their full address.',
    requiredModules: ['sitara_orders'],
    inputSchema: {
      type: 'object',
      properties: { customerId: { type: 'string', description: 'The customer\'s internal id (from sitara_list_customers).' } },
      required: ['customerId'],
    },
    async handler(context, { customerId }) {
      return callTenantApi(context, 'GET', `/sitara/customers/${encodeURIComponent(customerId)}`);
    },
  },

  {
    name: 'sitara_list_products',
    description: 'List Sitara Drapes catalog products (name, SKU, price, stock on hand). Search matches name or SKU.',
    requiredModules: ['sitara_stocks'],
    inputSchema: {
      type: 'object',
      properties: { search: { type: 'string' } },
    },
    async handler(context, { search } = {}) {
      const rows = await callTenantApi(context, 'GET', '/sitara/products', { query: { search } });
      return { count: (rows || []).length, products: rows };
    },
  },

  {
    name: 'sitara_list_weavers',
    description: 'List Sitara Drapes weavers (the raw-material suppliers purchase orders are placed against). Search matches name, email, or phone.',
    requiredModules: ['sitara_stocks'],
    inputSchema: {
      type: 'object',
      properties: { search: { type: 'string' } },
    },
    async handler(context, { search } = {}) {
      const rows = await callTenantApi(context, 'GET', '/sitara/weavers', { query: { search } });
      return { count: (rows || []).length, weavers: rows };
    },
  },

  {
    name: 'sitara_list_vendors',
    description: 'List Sitara Drapes vendors (who business expenses are logged against). Search matches name, email, or phone.',
    requiredModules: ['sitara_stocks'],
    inputSchema: {
      type: 'object',
      properties: { search: { type: 'string' } },
    },
    async handler(context, { search } = {}) {
      const rows = await callTenantApi(context, 'GET', '/sitara/vendors', { query: { search } });
      return { count: (rows || []).length, vendors: rows };
    },
  },

  {
    name: 'sitara_list_purchase_orders',
    description: 'List purchase orders placed with weavers. Filter by status, weaverId, or search (matches PO number).',
    requiredModules: ['sitara_stocks'],
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        weaverId: { type: 'string' },
        search: { type: 'string' },
      },
    },
    async handler(context, { status, weaverId, search } = {}) {
      const rows = await callTenantApi(context, 'GET', '/sitara/purchase-orders', { query: { status, weaverId, search } });
      return { count: (rows || []).length, purchaseOrders: rows };
    },
  },

  {
    name: 'sitara_get_purchase_order',
    description: 'Full detail for one purchase order, including its line items.',
    requiredModules: ['sitara_stocks'],
    inputSchema: {
      type: 'object',
      properties: { purchaseOrderId: { type: 'string', description: 'The purchase order\'s internal id (from sitara_list_purchase_orders).' } },
      required: ['purchaseOrderId'],
    },
    async handler(context, { purchaseOrderId }) {
      return callTenantApi(context, 'GET', `/sitara/purchase-orders/${encodeURIComponent(purchaseOrderId)}`);
    },
  },

  {
    name: 'sitara_list_expenses',
    description: 'List business expenses (electricity, rent, etc.), logged against a vendor. Filter by category, vendorId, or search (matches category/description).',
    requiredModules: ['sitara_stocks'],
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string' },
        vendorId: { type: 'string' },
        search: { type: 'string' },
      },
    },
    async handler(context, { category, vendorId, search } = {}) {
      const rows = await callTenantApi(context, 'GET', '/sitara/expenses', { query: { category, vendorId, search } });
      return { count: (rows || []).length, expenses: rows };
    },
  },

  {
    name: 'sitara_list_razorpay_payments',
    description:
      'List Razorpay payments captured for Sitara Drapes, each flagged with whether it was successfully matched to ' +
      'a local order. Set matchedOnly:false to see UNMATCHED payments specifically (a real payment that never got ' +
      'turned into an order — the exact kind of gap the BigCommerce/Razorpay reconciliation work this session was about).',
    requiredModules: ['sitara_orders'],
    inputSchema: {
      type: 'object',
      properties: { matchedOnly: { type: 'boolean', description: 'true = only matched payments, false = only unmatched payments, omit = all.' } },
    },
    async handler(context, { matchedOnly } = {}) {
      const rows = await callTenantApi(context, 'GET', '/sitara/razorpay-payments');
      const filtered = typeof matchedOnly === 'boolean' ? (rows || []).filter((p) => p.matched === matchedOnly) : rows;
      return { count: (filtered || []).length, payments: filtered };
    },
  },
];
