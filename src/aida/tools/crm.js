const { callTenantApi } = require('../apiClient');

module.exports = [
  {
    name: 'crm_get_leads',
    description: 'List CRM leads, optionally filtered by status (e.g. New, Contacted, Qualified).',
    requiredModules: ['crm'],
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string' } },
    },
    async handler(context, { status } = {}) {
      const rows = await callTenantApi(context, 'GET', '/crm/leads', { query: { status } });
      return { count: (rows || []).length, leads: rows };
    },
  },

  {
    name: 'crm_get_opportunities',
    description:
      "Active sales opportunities. OG Track's pipeline calls this stage 'prospects' (leads that have been " +
      'qualified and contacted, not yet converted to a customer) — this tool returns that list.',
    requiredModules: ['crm'],
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string' } },
    },
    async handler(context, { status } = {}) {
      const rows = await callTenantApi(context, 'GET', '/crm/prospects');
      const filtered = status ? (rows || []).filter((p) => p.status === status) : rows;
      return { count: (filtered || []).length, opportunities: filtered };
    },
  },

  {
    name: 'crm_get_customers',
    description: 'List CRM customers (converted accounts), optionally filtered by status.',
    requiredModules: ['crm'],
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string' } },
    },
    async handler(context, { status } = {}) {
      const rows = await callTenantApi(context, 'GET', '/crm/customers');
      const filtered = status ? (rows || []).filter((c) => c.status === status) : rows;
      return { count: (filtered || []).length, customers: filtered };
    },
  },

  {
    name: 'crm_get_customer_purchase_orders',
    description:
      "Customer purchase orders. Status is one of open | late | fulfilled | closed | cancelled — filter by " +
      "status: 'late' to see overdue customer orders.",
    requiredModules: ['crm'],
    inputSchema: {
      type: 'object',
      properties: {
        customerId: { type: 'string' },
        status: { type: 'string', enum: ['open', 'late', 'fulfilled', 'closed', 'cancelled'] },
      },
    },
    async handler(context, { customerId, status } = {}) {
      const rows = await callTenantApi(context, 'GET', '/crm/customer-purchase-orders', { query: { customerId, status } });
      return { count: (rows || []).length, purchaseOrders: rows };
    },
  },
];
