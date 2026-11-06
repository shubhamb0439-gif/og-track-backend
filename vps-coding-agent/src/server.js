const express = require('express');
const { requireBearer } = require('./auth');

/**
 * AIDA roadmap item 20 — the VPS-side Claude Code CLI runner. Standalone
 * service, one authenticated HTTP surface for ogtrack-backend's
 * vpsCodingAgentClient.js to call instead of its own hand-rolled Anthropic
 * tool-use loop, for dev_repo_fix jobs whose sandbox is already VPS-backed
 * (see vps-bridge/ — this service never clones/commits/pushes anything
 * itself, it only reads the sandbox directory vps-bridge already
 * materialized via a shared Docker volume). See this directory's README.md
 * for deploy steps and ogtrack-backend's roadmap plan (Item 20) for the
 * full design.
 */

const app = express();
app.use(express.json({ limit: '1mb' })); // a task description is plain text, nowhere near vps-bridge's write-file body sizes

app.use(require('./routes/health'));

// Everything else requires the shared secret.
app.use(requireBearer);
app.use(require('./routes/run'));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[vps-coding-agent] unhandled error:', err.message);
  res.status(500).json({ error: 'Internal coding-agent service error.' });
});

const PORT = process.env.PORT || 3200;
app.listen(PORT, () => {
  console.log(`[vps-coding-agent] listening on port ${PORT}, SANDBOX_ROOT=${process.env.SANDBOX_ROOT || '/sandboxes'}`);
});
