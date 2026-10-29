const express = require('express');
const sandboxStore = require('../sandboxStore');

const router = express.Router();

// No auth — matches Paperclip's own /api/health convention observed on this
// same VPS, and lets a plain uptime check confirm the container is alive
// without needing the shared secret.
router.get('/health', (req, res) => {
  res.json({ ok: true, sandboxes: sandboxStore.count() });
});

module.exports = router;
