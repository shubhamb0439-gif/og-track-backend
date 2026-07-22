const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const config = require('./config');
const coreDb = require('./db/core');

const resolveTenant = require('./middleware/resolveTenant');
const requireModule = require('./middleware/requireModule');

const companiesRoutes = require('./routes/companies');
const masteradminRoutes = require('./routes/masteradmin');
const usersRoutes = require('./routes/users');
const projectsRoutes = require('./routes/projects');
const bugsRoutes = require('./routes/bugs');
const sprintsRoutes = require('./routes/sprints');
const storiesRoutes = require('./routes/stories');
const subTicketsRoutes = require('./routes/sub_tickets');
const rolesRoutes = require('./routes/roles');
const attendanceRoutes = require('./routes/attendance');
const messagingRoutes = require('./routes/messaging');
const accountingRoutes = require('./routes/accounting');
const hrRoutes = require('./routes/hr');
const crmRoutes = require('./routes/crm');
const inventoryRoutes = require('./routes/inventory');
const manufacturingRoutes = require('./routes/manufacturing');
const uploadRoutes = require('./routes/upload');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST', 'PATCH', 'DELETE'] } });

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Make io available to every route via req.io.
app.use((req, _res, next) => { req.io = io; next(); });

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

// ── Tenant-scoped routes — every path carries the :slug segment ───────────────
// resolveTenant runs first (attaches req.db + req.company), then each module's
// router. Attendance is additionally gated behind requireModule('attendance').
app.use('/api/:slug/users', resolveTenant, usersRoutes);
app.use('/api/:slug/projects', resolveTenant, requireModule('projects'), projectsRoutes);
app.use('/api/:slug/bugs', resolveTenant, requireModule('bugs'), bugsRoutes);
app.use('/api/:slug/sprints', resolveTenant, requireModule('sprints'), sprintsRoutes);
app.use('/api/:slug/stories', resolveTenant, requireModule('sprints'), storiesRoutes);
app.use('/api/:slug/sub-tickets', resolveTenant, requireModule('sub_tickets'), subTicketsRoutes);
app.use('/api/:slug/roles', resolveTenant, rolesRoutes);
app.use('/api/:slug/attendance', resolveTenant, requireModule('attendance'), attendanceRoutes);
app.use('/api/:slug/conversations', resolveTenant, requireModule('messages'), messagingRoutes);
// Accounting suite (clients, time-entries, eod-reports, eod-routes) — the
// router defines those sub-paths, gated as a whole by the acc_clients module.
app.use('/api/:slug/acc', resolveTenant, requireModule('acc_clients'), accountingRoutes);
// HR suite (jobs, candidates, interviews) — gated by hr_jobs.
app.use('/api/:slug/hr', resolveTenant, requireModule('hr_jobs'), hrRoutes);
// Sales / CRM funnel (leads, prospects, customers, sales log) — gated by crm.
app.use('/api/:slug/crm', resolveTenant, requireModule('crm'), crmRoutes);
// Inventory (vendors, items, purchases) — gated by inventory.
app.use('/api/:slug/inventory', resolveTenant, requireModule('inventory'), inventoryRoutes);
// Manufacturing (BOMs, assemblies) — gated by manufacturing. Its tables have
// FKs into inventory's tables, so masteradmin.html enforces that a company
// can't have manufacturing without inventory also being enabled.
app.use('/api/:slug/manufacturing', resolveTenant, requireModule('manufacturing'), manufacturingRoutes);
app.use('/api/:slug/upload', resolveTenant, uploadRoutes);

// Serve uploaded files (written by the upload route) as static assets.
app.use('/uploads', express.static(require('path').join(__dirname, '..', 'public', 'uploads')));

// ── Fallback error handler ────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.statusCode || 500).json({ error: err.message || 'Internal server error' });
});

server.listen(config.app.port, () => {
  console.log(`OGTrack backend listening on :${config.app.port}`);
  console.log(`Core DB: ${config.sql.coreDatabase} @ ${config.sql.server}`);
});