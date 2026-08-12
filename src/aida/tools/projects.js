const { callTenantApi } = require('../apiClient');

const CLOSED_BUG_STATUSES = new Set(['Resolved', 'Fixed', 'Closed', "Won't Fix", 'Wont Fix', 'Not a Bug', 'Expected Behavior', 'NAB']);
const daysAgo = (n) => Date.now() - n * 24 * 60 * 60 * 1000;

module.exports = [
  {
    name: 'projects_list',
    description: 'List all projects (name, short code, status).',
    requiredModules: ['projects'],
    inputSchema: { type: 'object', properties: {} },
    async handler(context) {
      const rows = await callTenantApi(context, 'GET', '/projects');
      return { count: (rows || []).length, projects: rows };
    },
  },

  {
    name: 'projects_get_sprints',
    description: 'List sprints, optionally for one project. Each sprint has status planned | active | completed.',
    requiredModules: ['sprints'],
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
    },
    async handler(context, { projectId } = {}) {
      const rows = await callTenantApi(context, 'GET', '/sprints', { query: { projectId } });
      return { count: (rows || []).length, sprints: rows };
    },
  },

  {
    name: 'projects_get_overdue_sprints',
    description: "Sprints whose end date has passed but are still 'active' (not marked completed) — i.e. running late.",
    requiredModules: ['sprints'],
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
    },
    async handler(context, { projectId } = {}) {
      const rows = await callTenantApi(context, 'GET', '/sprints', { query: { projectId } });
      const today = new Date().toISOString().slice(0, 10);
      const overdue = (rows || []).filter((s) => s.status === 'active' && s.endDate && s.endDate < today);
      return { count: overdue.length, overdueSprints: overdue };
    },
  },

  {
    name: 'projects_get_backlog_stories',
    description: "Stories/backlog items, optionally for one project or one sprint. Filter by status (e.g. 'backlog').",
    requiredModules: ['sprints'],
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        status: { type: 'string', description: "e.g. 'backlog', 'in_progress', 'done'. Omit for all." },
      },
    },
    async handler(context, { projectId, status } = {}) {
      const rows = await callTenantApi(context, 'GET', '/stories', { query: { projectId } });
      const filtered = status ? (rows || []).filter((s) => s.status === status) : rows;
      return { count: (filtered || []).length, stories: filtered };
    },
  },

  {
    name: 'projects_get_delayed_tasks',
    description:
      'Bugs/tasks that have been open longer than a threshold number of days without being resolved — a proxy for ' +
      "delayed work, since OG Track's bugs have no explicit due date. Optionally scoped to one project.",
    requiredModules: ['bugs'],
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        olderThanDays: { type: 'number', description: 'Defaults to 7.' },
      },
    },
    async handler(context, { projectId, olderThanDays } = {}) {
      const threshold = olderThanDays || 7;
      const rows = await callTenantApi(context, 'GET', '/bugs', { query: { projectId } });
      const cutoff = daysAgo(threshold);
      const delayed = (rows || []).filter(
        (b) => !CLOSED_BUG_STATUSES.has(b.status) && b.createdAt && new Date(b.createdAt).getTime() < cutoff
      );
      return { thresholdDays: threshold, count: delayed.length, delayedTasks: delayed };
    },
  },

  {
    name: 'projects_get_bug_counts',
    description: 'Open vs total bug counts, grouped by project.',
    requiredModules: ['bugs'],
    inputSchema: { type: 'object', properties: {} },
    async handler(context) {
      const counts = await callTenantApi(context, 'GET', '/bugs/counts');
      return { countsByProject: counts };
    },
  },

  {
    name: 'projects_get_open_requests',
    description:
      "Sub-tickets (internal requests) that are still 'pending'. Visibility follows the same rule as the OG Track " +
      'UI: superadmin/manager/accounts_manager see every request, everyone else sees only their own.',
    requiredModules: ['sub_tickets'],
    inputSchema: { type: 'object', properties: {} },
    async handler(context) {
      const rows = await callTenantApi(context, 'GET', '/sub-tickets', {
        query: { userId: context.userId, role: context.role },
      });
      const open = (rows || []).filter((r) => r.status === 'pending');
      return { count: open.length, openRequests: open };
    },
  },
];
