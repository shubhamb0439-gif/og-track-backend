const { callTenantApi } = require('../apiClient');

const todayStr = () => new Date().toISOString().slice(0, 10);

module.exports = [
  {
    name: 'attendance_get_daily_summary',
    description:
      "Who's present, absent, or late today (or a given date). Combines today's attendance " +
      'records with the full employee list so absentees (no attendance row at all) are included, ' +
      'not just people who clocked in.',
    requiredModules: ['attendance'],
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: "YYYY-MM-DD. Defaults to today if omitted." },
        lateAfter: { type: 'string', description: "HH:mm 24h clock-in cutoff to count someone as late. Defaults to 09:30." },
      },
    },
    async handler(context, { date, lateAfter } = {}) {
      const targetDate = date || todayStr();
      const [allAttendance, employees] = await Promise.all([
        callTenantApi(context, 'GET', '/attendance/all'),
        callTenantApi(context, 'GET', '/users'),
      ]);
      const cutoff = lateAfter || '09:30';
      const todays = (allAttendance || []).filter((r) => r.date === targetDate);
      const presentIds = new Set(todays.filter((r) => r.clockIn).map((r) => r.userId));
      const late = todays.filter((r) => r.clockIn && r.clockIn.slice(11, 16) > cutoff);
      const absent = (employees || []).filter((u) => u.status === 'active' && !presentIds.has(u.id));
      return {
        date: targetDate,
        totalEmployees: (employees || []).filter((u) => u.status === 'active').length,
        presentCount: presentIds.size,
        absentCount: absent.length,
        lateCount: late.length,
        absentEmployees: absent.map((u) => ({ id: u.id, name: u.name, role: u.role })),
        lateEmployees: late.map((r) => ({ userId: r.userId, userName: r.userName, clockIn: r.clockIn })),
        records: todays,
      };
    },
  },

  {
    name: 'attendance_get_late_employees',
    description: 'List employees whose clock-in on a given date (default today) was after a cutoff time.',
    requiredModules: ['attendance'],
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD, defaults to today.' },
        lateAfter: { type: 'string', description: "HH:mm 24h cutoff, defaults to 09:30." },
      },
    },
    async handler(context, { date, lateAfter } = {}) {
      const targetDate = date || todayStr();
      const cutoff = lateAfter || '09:30';
      const all = await callTenantApi(context, 'GET', '/attendance/all');
      const late = (all || []).filter((r) => r.date === targetDate && r.clockIn && r.clockIn.slice(11, 16) > cutoff);
      return { date: targetDate, cutoff, lateEmployees: late };
    },
  },

  {
    name: 'attendance_get_leave_summary',
    description: 'Leave requests, optionally filtered by employee and/or status (pending | approved | rejected).',
    requiredModules: ['attendance'],
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'Filter to one employee id.' },
        status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
      },
    },
    async handler(context, { userId, status } = {}) {
      const rows = await callTenantApi(context, 'GET', '/attendance/leave', { query: { userId } });
      const filtered = status ? (rows || []).filter((r) => r.status === status) : rows;
      return { count: (filtered || []).length, leaveRequests: filtered };
    },
  },

  {
    name: 'attendance_get_regularization_requests',
    description: 'Attendance regularization (correction) requests, optionally filtered by employee.',
    requiredModules: ['attendance'],
    inputSchema: {
      type: 'object',
      properties: { userId: { type: 'string' } },
    },
    async handler(context, { userId } = {}) {
      const rows = await callTenantApi(context, 'GET', '/attendance/regularize', { query: { userId } });
      return { count: (rows || []).length, requests: rows };
    },
  },

  {
    name: 'attendance_get_employee_history',
    description: "One employee's attendance history (last 60 days).",
    requiredModules: ['attendance'],
    inputSchema: {
      type: 'object',
      properties: { userId: { type: 'string' } },
      required: ['userId'],
    },
    async handler(context, { userId }) {
      const rows = await callTenantApi(context, 'GET', `/attendance/user/${encodeURIComponent(userId)}`);
      return { userId, history: rows };
    },
  },
];
