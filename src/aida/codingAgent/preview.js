const net = require('net');
const fs = require('fs');
const { spawn } = require('child_process');

/**
 * Boots a phase-2 module-builder job's sandboxes as a live, running pair of
 * processes (backend API + frontend dev server) so a human can actually
 * click through the new module before approving it — not just read a diff.
 * Deliberately separate from tools.js's runCommand (which runs one command
 * to completion and returns); these processes stay alive for the whole
 * review window and are torn down explicitly by stopPreview (called from
 * the create_module job's resume/onReject, whichever the human picks).
 *
 * Every previewed instance points at ONE shared, persistent staging
 * database (config.aida.moduleBuilder.stagingDb) — never a real tenant's —
 * so a preview is a real rehearsal of the module's own SQL script running
 * against a real (if fake-seeded) Azure SQL database, without any chance of
 * touching production data. See docs/AIDA_PHASE2_MODULE_BUILDER_PLAN.md.
 */

const activePreviews = new Map(); // jobId -> { backendProc, frontendProc }

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Same minimal, no-real-secrets environment as tools.js's sandboxEnv() — see that file for why. */
function baseEnv() {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  if (process.platform === 'win32') {
    env.SystemRoot = process.env.SystemRoot;
    env.ComSpec = process.env.ComSpec;
    env.PATHEXT = process.env.PATHEXT;
    env.APPDATA = process.env.APPDATA;
    env.TEMP = process.env.TEMP;
    env.TMP = process.env.TMP;
  }
  return env;
}

function waitForPort(port, { timeoutMs = 30_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    (function attempt() {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(attempt, intervalMs);
      });
    })();
  });
}

/**
 * @param backendDir, frontendDir - sandbox roots (must still exist on disk — the
 *   caller (createModule.js) must NOT run its normal sandbox.cleanup() for
 *   these until stopPreview() has been called).
 * @param stagingDb - { server, port, user, password, database }
 * @param frontendStartCommand - e.g. "node serve.js"
 * @param previewBackendPort - the FIXED port the backend preview must bind to.
 *   Not a free/dynamic port like the frontend gets: the frontend's own inline
 *   script has no API-base-URL env var at all — confirmed it hardcodes
 *   http://localhost:3000 whenever it detects it's being viewed from
 *   localhost, so the backend preview has to actually BE on that exact port
 *   for the frontend preview to reach it. This also means only one
 *   create_module preview can run at a time (see the guard below) — a real
 *   limitation, acceptable for a first version given this is already a
 *   human-approval-gated, one-at-a-time review flow.
 * @param frontendPortEnvVar - env var name serve.js reads for its own port (confirmed: FRONTEND_PORT)
 */
async function startPreview({ jobId, backendDir, frontendDir, stagingDb, frontendStartCommand, previewBackendPort, frontendPortEnvVar }) {
  if (activePreviews.size > 0) {
    throw new Error('Another module preview is already running — approve or reject it before starting a new one (only one preview can run at a time, since the frontend expects the backend on a fixed port).');
  }
  const backendPort = previewBackendPort;
  const frontendPort = await getFreePort();

  const backendEnv = {
    ...baseEnv(),
    PORT: String(backendPort),
    AZURE_SQL_SERVER: stagingDb.server,
    AZURE_SQL_PORT: String(stagingDb.port || 1433),
    AZURE_SQL_USER: stagingDb.user,
    AZURE_SQL_PASSWORD: stagingDb.password,
    AZURE_SQL_CORE_DB: stagingDb.database,
    JWT_SECRET: `aida-preview-${jobId}`,
  };
  const backendProc = spawn('npm', ['start'], {
    cwd: fs.realpathSync(backendDir),
    env: backendEnv,
    shell: process.platform === 'win32',
  });
  // A spawn failure (missing binary, bad cwd, etc.) surfaces as an 'error'
  // event, not a thrown exception — an EventEmitter with no 'error' listener
  // throws instead, which would crash the ENTIRE backend process, not just
  // this preview. Swallow-and-log here; startPreview's own waitForPort
  // timeout is what actually surfaces the failure to the caller.
  backendProc.on('error', (e) => console.error(`[aida-preview] backend process error (job preview):`, e.message));
  backendProc.stdout.on('data', () => {}); // drained, not logged — avoid unbounded buffering; add real logging if this needs debugging later
  backendProc.stderr.on('data', () => {});

  const [frontendCmd, ...frontendArgs] = (frontendStartCommand || 'node serve.js').split(' ');
  const frontendEnv = {
    ...baseEnv(),
    [frontendPortEnvVar]: String(frontendPort),
  };
  const frontendProc = spawn(frontendCmd, frontendArgs, {
    cwd: fs.realpathSync(frontendDir),
    env: frontendEnv,
    shell: process.platform === 'win32',
  });
  frontendProc.on('error', (e) => console.error(`[aida-preview] frontend process error (job preview):`, e.message));
  frontendProc.stdout.on('data', () => {});
  frontendProc.stderr.on('data', () => {});

  activePreviews.set(jobId, { backendProc, frontendProc });

  const [backendUp, frontendUp] = await Promise.all([
    waitForPort(backendPort),
    waitForPort(frontendPort),
  ]);

  return {
    backendUrl: `http://localhost:${backendPort}`,
    frontendUrl: `http://localhost:${frontendPort}`,
    backendReady: backendUp,
    frontendReady: frontendUp,
  };
}

function stopPreview(jobId) {
  const entry = activePreviews.get(jobId);
  if (!entry) return false;
  entry.backendProc.kill();
  entry.frontendProc.kill();
  activePreviews.delete(jobId);
  return true;
}

function isPreviewActive(jobId) {
  return activePreviews.has(jobId);
}

module.exports = { startPreview, stopPreview, isPreviewActive, getFreePort, waitForPort };
