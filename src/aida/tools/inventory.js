const { callTenantApi } = require('../apiClient');

module.exports = [
  {
    name: 'inventory_get_stock',
    description: 'Current stock levels for inventory items, optionally filtered by item group.',
    requiredModules: ['inventory'],
    inputSchema: {
      type: 'object',
      properties: { group: { type: 'string', description: 'Item group/category name.' } },
    },
    async handler(context, { group } = {}) {
      const rows = await callTenantApi(context, 'GET', '/inventory/items', { query: { group } });
      return { count: (rows || []).length, items: rows };
    },
  },

  {
    name: 'inventory_get_low_stock',
    description: 'Items at or below their reorder level / minimum stock — needs restocking soon.',
    requiredModules: ['inventory'],
    inputSchema: { type: 'object', properties: {} },
    async handler(context) {
      const rows = await callTenantApi(context, 'GET', '/inventory/items', { query: { alerts: 'true' } });
      return { count: (rows || []).length, lowStockItems: rows };
    },
  },

  {
    name: 'inventory_get_vendors',
    description: 'List inventory vendors/suppliers.',
    requiredModules: ['inventory'],
    inputSchema: { type: 'object', properties: {} },
    async handler(context) {
      const rows = await callTenantApi(context, 'GET', '/inventory/vendors');
      return { count: (rows || []).length, vendors: rows };
    },
  },

  {
    name: 'inventory_get_purchases',
    description: 'Purchase orders placed with vendors, optionally filtered by status (pending | partial | received | cancelled).',
    requiredModules: ['inventory'],
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['pending', 'partial', 'received', 'cancelled'] } },
    },
    async handler(context, { status } = {}) {
      const rows = await callTenantApi(context, 'GET', '/inventory/purchases');
      const filtered = status ? (rows || []).filter((p) => p.status === status) : rows;
      return { count: (filtered || []).length, purchases: filtered };
    },
  },
];
