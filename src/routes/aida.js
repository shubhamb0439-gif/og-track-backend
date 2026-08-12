const express = require('express');
const multer = require('multer');
const config = require('../config');
const { requireTenantAidaAuth, requireMasterAdminAidaAuth } = require('../aida/auth');
const { buildTenantContext, buildMasterAdminContext } = require('../aida/contextBuilder');
const { registerAllTools } = require('../aida/tools');
const { listAvailableTools } = require('../aida/toolRegistry');
const { runTurn } = require('../aida/engine');
const sessionMemory = require('../aida/sessionMemory');
const jobStore = require('../aida/jobs/jobStore');
const jobRunner = require('../aida/jobs/jobRunner');
const voiceSession = require('../aida/voice/voiceSession');
const { transcribeAudio } = require('../aida/voice/speechToText');

registerAllTools();
sessionMemory.startSweeper();

function newTurnId() {
  return `voice_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Same memoryStorage pattern as src/routes/upload.js — buffered in RAM only
// long enough to forward to Whisper, never written to disk.
const voiceInputUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// Wraps multer so a bad/oversized upload returns clean JSON (400) instead of
// falling through to the generic error handler — still JSON either way
// (server.js's fallback handler is JSON too), but this gives a clearer
// status/message for the common case.
function handleAudioUpload(req, res, next) {
  voiceInputUpload.single('audio')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Audio upload failed.' });
    next();
  });
}

/**
 * Room/event names for pushing voice chunks — same "shared room, per-user
 * event name" pattern already used for tenant real-time events elsewhere
 * (see e.g. attendance:${userId} in src/routes/attendance.js, emitted into
 * the shared io.to(company.slug) room) so one tenant's users never receive
 * each other's audio despite sharing a room. Master admin's room is already
 * single-user by convention (matches jobRunner.js's roomForJob).
 */
function voiceTargetFor(context) {
  if (context.kind === 'masteradmin') {
    return { room: `masteradmin:${context.userId}`, chunkEvent: 'aida:voice-chunk', errorEvent: 'aida:voice-error' };
  }
  return {
    room: context.tenantSlug,
    chunkEvent: `aida:voice-chunk:${context.userId}`,
    errorEvent: `aida:voice-error:${context.userId}`,
  };
}

/**
 * One router factory shared by the tenant-scoped mount
 * (/api/:slug/aida) and the master-admin mount (/api/masteradmin/aida) —
 * only the auth middleware and context shape differ between them.
 */
function createAidaRouter({ requireAuth, buildContext }) {
  // mergeParams: true — this router is mounted at '/api/:slug/aida', and
  // without it req.params.slug would be undefined here (Express does not
  // merge parent route params into a child Router by default), breaking
  // the cross-tenant token check in requireTenantAidaAuth.
  const router = express.Router({ mergeParams: true });

  router.use((req, res, next) => {
    if (!config.aida.enabled) {
      const missingKey = config.aida.provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
      return res.status(503).json({ error: `AIDA is not configured on this server yet (missing ${missingKey}).` });
    }
    next();
  });

  router.use(requireAuth);

  // POST /chat — the one endpoint the conversation UI talks to.
  // Body: { message: string, pageContext?: { page, module, route, activeEntity } }
  router.post('/chat', async (req, res) => {
    try {
      const { message, voice } = req.body || {};
      if (!message || typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'message is required' });
      }
      const context = buildContext(req);
      const history = sessionMemory.getHistory(context);

      const { reply, toolCalls } = await runTurn(context, message.trim(), history);
      sessionMemory.appendTurn(context, message.trim(), reply);

      const responseBody = { reply, toolCalls };

      // Voice is entirely additive: fire-and-forget, never awaited, and the
      // text response above is already complete and sent regardless of
      // whether speech synthesis succeeds, fails, or isn't configured at all.
      if (voice === true && config.aida.voice.enabled) {
        const turnId = newTurnId();
        responseBody.turnId = turnId;
        const { room, chunkEvent, errorEvent } = voiceTargetFor(context);
        voiceSession.speakReply({ io: req.io, room, chunkEvent, errorEvent, turnId, text: reply });
      }

      res.json(responseBody);
    } catch (e) {
      console.error('POST /aida/chat failed:', e);
      res.status(500).json({ error: e.message || 'AIDA could not process that request.' });
    }
  });

  // POST /voice-input — mirrors POST /chat, but the "message" arrives as a
  // recorded audio clip instead of typed text. Transcribes it (Whisper),
  // then runs the transcript through the EXACT same runTurn()/sessionMemory
  // path /chat uses — no separate reply-generation logic lives here — and
  // triggers the same ElevenLabs voice-reply pipeline via the same turnId
  // convention, so the frontend's existing voice-chunk handling just works.
  // multipart/form-data: "audio" (the recorded blob) + "pageContext" (a
  // JSON-encoded string, same shape /chat's pageContext already is once
  // express.json() has parsed it — parsed here for the same reason).
  router.post('/voice-input', handleAudioUpload, async (req, res) => {
    try {
      if (!config.aida.speechToText.enabled) {
        return res.status(503).json({ error: 'Voice input is not configured on this server yet (missing OPENAI_API_KEY for transcription).' });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'No audio file uploaded (expected multipart field "audio").' });
      }

      let pageContext;
      if (req.body && req.body.pageContext) {
        try {
          pageContext = JSON.parse(req.body.pageContext);
        } catch {
          return res.status(400).json({ error: 'pageContext must be valid JSON.' });
        }
      }

      const transcript = await transcribeAudio(req.file.buffer, {
        filename: req.file.originalname || 'audio.webm',
        mimeType: req.file.mimetype || 'audio/webm',
      });
      if (!transcript) {
        return res.status(400).json({ error: 'Could not transcribe any speech from that recording.' });
      }

      // multer leaves req.body's other fields as raw strings; overwrite
      // pageContext with the parsed object so buildContext(req) reads it
      // exactly the way it already does for a normal JSON POST /chat body.
      req.body = { ...req.body, pageContext };
      const context = buildContext(req);
      const history = sessionMemory.getHistory(context);

      const { reply, toolCalls } = await runTurn(context, transcript, history);
      sessionMemory.appendTurn(context, transcript, reply);

      const turnId = newTurnId();
      if (config.aida.voice.enabled) {
        const { room, chunkEvent, errorEvent } = voiceTargetFor(context);
        voiceSession.speakReply({ io: req.io, room, chunkEvent, errorEvent, turnId, text: reply });
      }

      res.json({ transcript, reply, turnId, toolCalls: toolCalls || null });
    } catch (e) {
      console.error('POST /aida/voice-input failed:', e);
      res.status(500).json({ error: e.message || 'AIDA could not process that voice message.' });
    }
  });

  // GET /history — restore the conversation panel (e.g. after a page reload).
  router.get('/history', (req, res) => {
    try {
      const context = buildContext(req);
      const messages = sessionMemory.getHistory(context).map((m) => ({ role: m.role, text: m.content }));
      res.json({ messages });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // DELETE /session — the frontend should call this on logout so the next
  // login (even by the same user) starts with a clean slate.
  router.delete('/session', (req, res) => {
    try {
      sessionMemory.clearSession(buildContext(req));
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /tools — what AIDA can currently do in this context. Useful for a
  // "what can you help me with?" empty state in the UI, and for debugging
  // which modules are wired up.
  router.get('/tools', (req, res) => {
    try {
      const context = buildContext(req);
      const tools = listAvailableTools(context).map((t) => ({ name: t.name, description: t.description }));
      res.json({ tools });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}

const tenantAidaRouter = createAidaRouter({ requireAuth: requireTenantAidaAuth, buildContext: buildTenantContext });
const masterAdminAidaRouter = createAidaRouter({ requireAuth: requireMasterAdminAidaAuth, buildContext: buildMasterAdminContext });

// ── Async job endpoints — master admin only for now ──────────────────────────
// Added directly to the already-built router (still behind its 'enabled'
// check + requireMasterAdminAidaAuth from createAidaRouter above) rather than
// a createAidaRouter option, since jobs don't exist on the tenant side at all
// yet — every capability that creates one (repo diagnosis/fixing, cross-
// tenant writes, new-app deployment) is master-admin-scoped per the AIDA
// power-tier plan. Any authenticated master admin can see/act on any job —
// there's no per-admin ownership restriction, matching "master admin has
// full access" elsewhere in that plan.

// GET /jobs/:id — poll a job's current state + its event timeline.
masterAdminAidaRouter.get('/jobs/:id', async (req, res) => {
  try {
    const job = await jobStore.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const events = await jobStore.listEventsForJob(job.id);
    res.json({ job, events });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /jobs/:id/approve — the human-approval gate. Only valid from
// 'awaiting_approval'; resumes the job kind's own continuation logic.
masterAdminAidaRouter.post('/jobs/:id/approve', async (req, res) => {
  try {
    const job = await jobStore.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'awaiting_approval') {
      return res.status(400).json({ error: `Job is not awaiting approval (status: ${job.status})` });
    }
    const approved = await jobStore.updateJobStatus(job.id, 'approved');
    await jobStore.appendEvent(job.id, 'approved', { approvedBy: req.admin.adminId });
    jobRunner.emitJobUpdate(approved);
    const final = await jobRunner.resumeApproved(approved);
    res.json({ job: final });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /jobs/:id/reject — stops the job dead; no kind-specific code runs.
masterAdminAidaRouter.post('/jobs/:id/reject', async (req, res) => {
  try {
    const job = await jobStore.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'awaiting_approval') {
      return res.status(400).json({ error: `Job is not awaiting approval (status: ${job.status})` });
    }
    const rejected = await jobStore.updateJobStatus(job.id, 'rejected');
    await jobStore.appendEvent(job.id, 'rejected', { rejectedBy: req.admin.adminId });
    jobRunner.emitJobUpdate(rejected);
    res.json({ job: rejected });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = { tenantAidaRouter, masterAdminAidaRouter };
