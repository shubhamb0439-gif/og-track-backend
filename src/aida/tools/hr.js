const { callTenantApi } = require('../apiClient');

const HR_MODULES = ['hr_dashboard', 'hr_jobs', 'hr_candidates', 'hr_interviews'];

module.exports = [
  {
    name: 'hr_get_employees',
    description:
      'List employees (users). The /users endpoint has no module gate in OG Track, so this is always available ' +
      'regardless of which HR sub-modules are enabled.',
    requiredModules: [], // matches server.js: usersRoutes has no requireModule gate
    inputSchema: {
      type: 'object',
      properties: { role: { type: 'string' }, status: { type: 'string', enum: ['pending', 'active', 'rejected'] } },
    },
    async handler(context, { role, status } = {}) {
      const rows = await callTenantApi(context, 'GET', '/users');
      const filtered = (rows || []).filter((u) => (!role || u.role === role) && (!status || u.status === status));
      return { count: filtered.length, employees: filtered };
    },
  },

  {
    name: 'hr_get_jobs',
    description: 'List open/draft/closed job postings.',
    requiredModules: HR_MODULES,
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['draft', 'published', 'closed'] } },
    },
    async handler(context, { status } = {}) {
      const rows = await callTenantApi(context, 'GET', '/hr/jobs');
      const filtered = status ? (rows || []).filter((j) => j.status === status) : rows;
      return { count: (filtered || []).length, jobs: filtered };
    },
  },

  {
    name: 'hr_get_candidates',
    description: 'List candidates, optionally for one job and/or by pipeline status (applied, shortlisted, interview, offered, rejected, hired).',
    requiredModules: HR_MODULES,
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' }, status: { type: 'string' } },
    },
    async handler(context, { jobId, status } = {}) {
      const rows = await callTenantApi(context, 'GET', '/hr/candidates', { query: { jobId } });
      const filtered = status ? (rows || []).filter((c) => c.status === status) : rows;
      return { count: (filtered || []).length, candidates: filtered };
    },
  },

  {
    name: 'hr_get_interviews',
    description: 'List scheduled/completed interviews.',
    requiredModules: HR_MODULES,
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['scheduled', 'completed', 'cancelled', 'rescheduled'] } },
    },
    async handler(context, { status } = {}) {
      const rows = await callTenantApi(context, 'GET', '/hr/interviews');
      const filtered = status ? (rows || []).filter((i) => i.status === status) : rows;
      return { count: (filtered || []).length, interviews: filtered };
    },
  },
];
