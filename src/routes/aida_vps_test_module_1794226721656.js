const express = require('express');

const router = express.Router();

// GET /api/:slug/aida_vps_test_module_1794226721656 — static greeting for this test module.
router.get('/', async (_req, res) => {
  try {
    res.json({ message: 'Hello from AIDA VPS Test Module 1794226721656!' });
  } catch (e) {
    console.error('GET /aida_vps_test_module_1794226721656 failed:', e);
    res.status(500).json({ error: 'Could not load the greeting. Please try again.' });
  }
});

module.exports = router;
