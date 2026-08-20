const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const config = require('../src/config');

// Regression test for a real bug found in production testing: AIDA's
// masteradmin_attendance_* tools were failing with a "token issue" because
// GET /attendance/all (src/routes/attendance.js) requires
// req.auth.slug === req.company.slug — a check the master admin's own JWT
// (role: 'masteradmin', no slug) can never satisfy for any tenant. The fix
// mints a short-lived, properly tenant-shaped token per cross-tenant call
// instead of reusing the master admin's own token — this test proves that
// synthetic token would actually pass the real route's check.

test('a masteradmin cross-tenant tool call sends a properly tenant-scoped Authorization token', async () => {
  const tools = require('../src/aida/tools/masteradminCrossTenant');
  const tool = tools.find((t) => t.name === 'masteradmin_attendance_get_late_employees');
  assert.ok(tool, 'expected masteradmin_attendance_get_late_employees to be registered');

  let capturedAuthHeader = null;
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    capturedAuthHeader = opts.headers.Authorization;
    return { ok: true, status: 200, text: async () => JSON.stringify([]) };
  };

  try {
    const context = { kind: 'masteradmin', userId: 'admin-42', authHeader: 'Bearer masteradmin-own-token', internalBaseUrl: config.aida.internalBaseUrl };
    await tool.handler(context, { companySlug: 'testco', date: '2026-08-19' });
  } finally {
    global.fetch = originalFetch;
  }

  assert.ok(capturedAuthHeader, 'expected the tool to have called apiClient with an Authorization header');
  assert.ok(capturedAuthHeader.startsWith('Bearer '));
  const token = capturedAuthHeader.slice(7);

  // This is the exact check GET /attendance/all performs (src/routes/attendance.js).
  const decoded = jwt.verify(token, config.app.jwtSecret);
  assert.equal(decoded.slug, 'testco', 'token must carry the target tenant slug, not the master admin\'s own');
  assert.equal(decoded.role, 'superadmin', 'token must carry a role attendance.js\'s /all endpoint accepts (manager|superadmin)');
  assert.notEqual(decoded.slug, undefined, 'a masteradmin token has no slug at all — this must not be that raw token');
});
