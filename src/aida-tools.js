/**
 * AIDA Tool Registry
 * ============================================================================
 * A tool is a plain object describing ONE capability AIDA can invoke:
 *   - name / description: shown to the LLM so it can decide which tool(s)
 *     apply to a given user message. Keep descriptions short and concrete.
 *   - module: which existing OGTrack module this tool belongs to (for
 *     grouping/logging only — has no effect on permissions).
 *   - params: JSON-schema-shaped parameter definition, passed to the LLM's
 *     function-calling interface so it knows what arguments (if any) to
 *     supply when it picks this tool.
 *   - run(ctx, args): performs the tool's actual work. MUST do so by making a
 *     real HTTP request to an existing OGTrack API endpoint (see httpClient
 *     below) — AIDA never touches the database directly and never
 *     duplicates business logic that already lives in a route handler.
 *
 * `ctx` (passed to every tool's run function) contains:
 *   { slug, token, userId, role, companyId, currentView, currentProject }
 * — the same context object the frontend sends with every chat message,
 * plus `token`, which is the user's own Bearer token, forwarded as-is so
 * every self-call is subject to the exact same auth/permission behavior a
 * normal frontend request from this user would get.
 *
 * TO ADD A NEW MODULE'S TOOLS: create a new array (e.g. CRM_TOOLS) following
 * this same shape in a new file, then add it to the `require`/spread list at
 * the bottom of this file. Nothing else needs to change — the engine
 * discovers tools purely from this exported list.
 * ============================================================================
 */

const { apiGet } = require('./aida-http-client');

const ATTENDANCE_TOOLS = [
  {
    name: 'get_all_attendance_today',
    module: 'attendance',
    description: "Get every employee's attendance status for today (present/absent/late, clock-in times). Use this for questions like 'who's absent today', 'who's late', 'who hasn't clocked in'.",
    params: { type: 'object', properties: {}, required: [] },
    run: async (ctx) => {
      // GET /api/:slug/attendance/all returns every attendance row across all
      // dates; the tool itself narrows to today's date and also fetches the
      // full user list so it can report who has NO record at all today
      // (a user with zero attendance rows today is absent, but wouldn't show
      // up if we only looked at the attendance table).
      const [allAttendance, allUsers] = await Promise.all([
        apiGet(ctx, '/attendance/all'),
        apiGet(ctx, '/users'),
      ]);
      const today = new Date().toISOString().slice(0, 10);
      const todayRecords = (allAttendance || []).filter(r => r.date === today);
      const recordedUserIds = new Set(todayRecords.map(r => r.userId));
      const activeUsers = (allUsers || []).filter(u => u.status === 'active');
      const absent = activeUsers.filter(u => !recordedUserIds.has(u.id));
      const late = todayRecords.filter(r => r.status === 'present' && r.clockIn && isLate(r.clockIn));
      return {
        date: today,
        totalActiveEmployees: activeUsers.length,
        presentCount: todayRecords.filter(r => r.status === 'present').length,
        absentCount: absent.length,
        absentEmployees: absent.map(u => u.name),
        lateEmployees: late.map(r => r.userName),
      };
    },
  },
  {
    name: 'get_user_attendance_history',
    module: 'attendance',
    description: 'Get attendance history for a SPECIFIC named employee over their recent records. Use when the question names a particular person, e.g. "how many days was Priya late this month".',
    params: {
      type: 'object',
      properties: { userName: { type: 'string', description: "The employee's name as mentioned by the user" } },
      required: ['userName'],
    },
    run: async (ctx, args) => {
      const allUsers = await apiGet(ctx, '/users');
      const match = (allUsers || []).find(u => u.name.toLowerCase().includes((args.userName || '').toLowerCase()));
      if (!match) return { error: `Could not find an employee named "${args.userName}".` };
      const history = await apiGet(ctx, `/attendance/user/${match.id}`);
      return { userName: match.name, records: history };
    },
  },
];

function isLate(clockInIso) {
  // Simple, conservative "late" threshold — adjust if OGTrack has an actual
  // configured shift-start time somewhere; not found in the attendance
  // schema/routes as of this writing, so using a fixed 10:00 AM assumption.
  const d = new Date(clockInIso);
  return d.getHours() > 10 || (d.getHours() === 10 && d.getMinutes() > 0);
}

module.exports = [
  ...ATTENDANCE_TOOLS,
  // Future modules: ...require('./aida-tools-crm'), ...require('./aida-tools-projects'), etc.
];