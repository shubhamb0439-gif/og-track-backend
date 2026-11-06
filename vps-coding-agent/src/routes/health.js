const express = require('express');

const router = express.Router();

// No auth — same convention as vps-bridge's /health, so a plain uptime
// check works without the shared secret.
router.get('/health', (req, res) => {
  res.json({ ok: true });
});

module.exports = router;
