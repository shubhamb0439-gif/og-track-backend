const express = require('express');
const { requireBearer } = require('./auth');
const sandboxStore = require('./sandboxStore');

/**
 * AIDA roadmap item 17 — the VPS-side execution bridge. Standalone service,
 * one authenticated HTTP surface for ogtrack-backend's vpsBridgeClient.js to
 * call into instead of local fs/child_process, for dev_repo_fix jobs only.
 * See ogtrack-backend's docs/.claude plan file (Item 17) for the full design
 * and the deploy steps in this directory's README.md.
 */

const app = express();
app.use(express.json({ limit: '10mb' })); // write-file bodies can carry a real source file's full text

app.use(require('./routes/health'));

// Everything else requires the shared secret.
app.use(requireBearer);
app.use(require('./routes/sandbox'));
app.use(require('./routes/files'));
app.use(require('./routes/exec'));
app.use(require('./routes/git'));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[vps-bridge] unhandled error:', err.message);
  res.status(500).json({ error: 'Internal bridge error.' });
});

const PORT = process.env.PORT || 3100;
app.listen(PORT, () => {
  console.log(`[vps-bridge] listening on port ${PORT}, SANDBOX_ROOT=${sandboxStore.SANDBOX_ROOT}`);
  sandboxStore.startSweep();
});
