const { callPlatformApi } = require('../apiClient');

/**
 * Master-admin-only tools (domain.com/master-admin/aida). These operate on
 * OGCore (the company directory), not a tenant database, and are gated by
 * the '__masteradmin__' sentinel module — see contextBuilder.js. A tenant
 * chat context never has that sentinel, so these never leak into a
 * per-company AIDA session, and tenant tools never leak into master-admin's.
 */
module.exports = [
  {
    name: 'masteradmin_list_companies',
    description: 'List every OG Track company/tenant, with status and enabled modules.',
    requiredModules: ['__masteradmin__'],
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['active', 'suspended'] } },
    },
    async handler(context, { status } = {}) {
      const rows = await callPlatformApi(context, 'GET', '/masteradmin/companies');
      const filtered = status ? (rows || []).filter((c) => c.status === status) : rows;
      return { count: (filtered || []).length, companies: filtered };
    },
  },

  {
    name: 'masteradmin_get_pending_users',
    description: 'Users across ALL companies awaiting Super Admin approval.',
    requiredModules: ['__masteradmin__'],
    inputSchema: { type: 'object', properties: {} },
    async handler(context) {
      const rows = await callPlatformApi(context, 'GET', '/masteradmin/pending-users');
      return { count: (rows || []).length, pendingUsers: rows };
    },
  },

  {
    name: 'masteradmin_get_provisioning_log',
    description: "A company's provisioning history (module setup steps and their status).",
    requiredModules: ['__masteradmin__'],
    inputSchema: {
      type: 'object',
      properties: { companyId: { type: 'string' } },
      required: ['companyId'],
    },
    async handler(context, { companyId }) {
      const rows = await callPlatformApi(context, 'GET', `/masteradmin/provisioning-log/${encodeURIComponent(companyId)}`);
      return { companyId, log: rows };
    },
  },
];
