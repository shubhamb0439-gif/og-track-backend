const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const config = require('./config');
const coreDb = require('./db/core');

const resolveTenant = require('./middleware/resolveTenant');
const requireModule = require('./middleware/requireModule');
const { requireAuth } = require('./utils/auth');

const companiesRoutes = require('./routes/companies');
const masteradminRoutes = require('./routes/masteradmin');
const usersRoutes = require('./routes/users');
const projectsRoutes = require('./routes/projects');
const bugsRoutes = require('./routes/bugs');
const sprintsRoutes = require('./routes/sprints');
const storiesRoutes = require('./routes/stories');
const testCasesRoutes = require('./routes/testCases');
const subTicketsRoutes = require('./routes/sub_tickets');
const rolesRoutes = require('./routes/roles');
const attendanceRoutes = require('./routes/attendance');
const messagingRoutes = require('./routes/messaging');
const accountingRoutes = require('./routes/accounting');
const hrRoutes = require('./routes/hr');
const crmRoutes = require('./routes/crm');
const inventoryRoutes = require('./routes/inventory');
const manufacturingRoutes = require('./routes/manufacturing');
const salesRoutes = require('./routes/sales');
const uploadRoutes = require('./routes/upload');
const { tenantAidaRouter, masterAdminAidaRouter } = require('./routes/aida');
const aidaJobRunner = require('./aida/jobs/jobRunner');
const to_do_listRoutes = require('./routes/to_do_list');
const tokenRoutes = require('./routes/token');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST', 'PATCH', 'DELETE'] } });

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Make io available to every route via req.io.
app.use((req, _res, next) => { req.io = io; next(); });

// AIDA's background job runner needs the same io instance to push job status
// updates into a client's room asynchronously (a job can finish long after
// its originating POST /aida/chat request has already returned).
aidaJobRunner.start(io);

// ── Socket.io: per-tenant rooms ──────────────────────────────────────────────
// Every client joins a room named after its company slug. All real-time
// emits in the routes target io.to(slug), so OGTrack events never reach Cajo
// browsers and vice versa — the same isolation the databases have, applied to
// the websocket layer.
io.on('connection', (socket) => {
  socket.on('join', (slug) => {
    if (slug) socket.join(slug);
  });
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    await coreDb.raw('SELECT 1 AS ok');
    res.json({ status: 'ok', core: 'connected' });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

// ── Platform-level (masteradmin) routes — operate on OGCore, NOT tenant-scoped ─
app.use('/api/companies', companiesRoutes);
app.use('/api/masteradmin', masteradminRoutes);
// AIDA for master admin (domain.com/master-admin/aida) — cross-company tools only.
app.use('/api/masteradmin/aida', masterAdminAidaRouter);

// ── Tenant-scoped routes — every path carries the :slug segment ───────────────
// resolveTenant runs first (attaches req.db + req.company), then each module's
// router. Attendance is additionally gated behind requireModule('attendance').
app.use('/api/:slug/users', resolveTenant, usersRoutes);
app.use('/api/:slug/projects', resolveTenant, requireModule('projects'), projectsRoutes);
app.use('/api/:slug/bugs', resolveTenant, requireModule('bugs'), bugsRoutes);
app.use('/api/:slug/sprints', resolveTenant, requireModule('sprints'), sprintsRoutes);
app.use('/api/:slug/stories', resolveTenant, requireModule('sprints'), storiesRoutes);
// Test Cases — GET is open to any authenticated tenant user; POST/PATCH/DELETE
// are further gated to the 'tester' role inside testCasesRoutes via requireRole.
app.use('/api/:slug/test-cases', resolveTenant, requireModule('test_cases'), requireAuth, testCasesRoutes);
app.use('/api/:slug/sub-tickets', resolveTenant, requireModule('sub_tickets'), subTicketsRoutes);
app.use('/api/:slug/roles', resolveTenant, rolesRoutes);
app.use('/api/:slug/attendance', resolveTenant, requireModule('attendance'), attendanceRoutes);
app.use('/api/:slug/conversations', resolveTenant, requireModule('messages'), messagingRoutes);
// Accounting suite (clients, time-entries, eod-reports, eod-routes) — any
// accounting-related module checkbox unlocks it (a company can enable Timer
// and EOD Reports without Clients, e.g. Cajo, and still needs those routes).
app.use('/api/:slug/acc', resolveTenant, requireModule(['acc_clients', 'acc_timer', 'acc_eod']), accountingRoutes);
// HR suite (jobs, candidates, interviews) — any HR-related module checkbox unlocks it.
app.use('/api/:slug/hr', resolveTenant, requireModule(['hr_dashboard','hr_jobs','hr_candidates','hr_interviews']), hrRoutes);
// Sales / CRM funnel (leads, prospects, customers, sales log) — gated by crm.
app.use('/api/:slug/crm', resolveTenant, requireModule('crm'), crmRoutes);
// Inventory (vendors, items, purchases) — gated by inventory.
app.use('/api/:slug/inventory', resolveTenant, requireModule('inventory'), inventoryRoutes);
// Manufacturing (BOMs, assemblies) — gated by manufacturing. Its tables have
// FKs into inventory's tables, so masteradmin.html enforces that a company
// can't have manufacturing without inventory also being enabled.
app.use('/api/:slug/manufacturing', resolveTenant, requireModule('manufacturing'), manufacturingRoutes);
app.use('/api/:slug/sales', resolveTenant, requireModule('sales'), salesRoutes);
app.use('/api/:slug/upload', resolveTenant, uploadRoutes);
// AIDA — the AI orchestration layer (domain.com/<slug>/aida in the frontend).
// Not gated by requireModule: it's not a module, it's a layer over every
// module. Each individual tool self-gates against req.company.enabled_modules.
app.use('/api/:slug/aida', resolveTenant, tenantAidaRouter);
app.use('/api/:slug/to_do_list', resolveTenant, requireModule('to_do_list'), to_do_listRoutes);
app.use('/api/:slug/token', resolveTenant, requireModule('token'), tokenRoutes);

// Serve uploaded files (written by the upload route) as static assets.
app.use('/uploads', express.static(require('path').join(__dirname, '..', 'public', 'uploads')));

// Pre-generated AIDA filler audio (src/aida/voice/fillerPhrases.js's
// FILLERS_BY_CATEGORY, synthesized once via the generation script — see
// docs/FRONTEND_PROMPTS.md prompt 7) — static, non-tenant, non-sensitive
// audio clips, so no auth/resolveTenant gate like the rest of the API.
// The frontend fetches manifest.json once, caches the files locally, and
// plays one INSTANTLY (no server round trip) the moment the user finishes
// speaking/typing, rather than waiting on the existing socket-emitted
// filler (which still exists as the server-side fallback/general case).
// maxAge: without it express.static defaults to Cache-Control: max-age=0,
// which forces the browser to revalidate (a real network round trip, even
// if it comes back 304) on every fetch — defeating "instant, no server
// round trip" for exactly the files this exists to make instant. These are
// static, content-fixed files regenerated only by
// scripts/generate-aida-fillers.js, never mutated in place, so caching them
// hard for a year is safe.
app.use('/aida-fillers', express.static(require('path').join(__dirname, '..', 'public', 'aida-fillers'), {
  maxAge: '365d',
  immutable: true,
}));

// ── Fallback error handler ────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.statusCode || 500).json({ error: err.message || 'Internal server error' });
});

server.listen(config.app.port, () => {
  console.log(`OGTrack backend listening on :${config.app.port}`);
  console.log(`Core DB: ${config.sql.coreDatabase} @ ${config.sql.server}`);
});
