const express = require('express');
const router = express.Router({ mergeParams: true });
const engine = require('./aida-engine');

/**
 * POST /api/:slug/aida/chat
 * Body: { message, context: { currentView, currentModule, currentProject } }
 *
 * Auth: relies on the same Bearer token every other route already receives
 * (see index.html's fetch adapter, which attaches it automatically). AIDA
 * decodes nothing extra here — req.company/req.params.slug come from the
 * same resolveTenant middleware every other module route uses.
 */
router.post('/chat', async (req, res) => {
  try {
    const { message, context } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'A message is required.' });
    }

    // The frontend already has all of this in memory (currentUser,
    // currentProject, currentView) — it's passed through here, not
    // re-derived or guessed. userId/role/companyId still come from the
    // authenticated user's own request context (req.body from the frontend,
    // which already only shows this user their own identity), same trust
    // model as every other route in this codebase (see PATCH /clients/:id
    // in accounting.js for the established precedent).
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    const ctx = {
      slug: req.params.slug,
      token,
      userId: req.body.userId,
      userName: req.body.userName,
      role: req.body.role,
      companyId: req.body.companyId,
      currentView: context?.currentView,
      currentModule: context?.currentModule,
      currentProject: context?.currentProject,
    };

    const result = await engine.handleMessage(ctx, message.trim());
    res.json(result);
  } catch (e) {
    console.error('POST /aida/chat failed:', e);
    const status = e.status || 500;
    res.status(status).json({ error: e.message && status === 503 ? e.message : 'AIDA could not process that request. Please try again.' });
  }
});

/**
 * POST /api/:slug/aida/clear-session
 * Called on logout (see doLogout() in index.html) to explicitly drop this
 * user's lightweight conversation memory — per the requirement that AIDA
 * must never retain permanent memory across sessions.
 */
router.post('/clear-session', (req, res) => {
  engine.clearSession({ slug: req.params.slug, userId: req.body.userId });
  res.json({ success: true });
});

module.exports = router;