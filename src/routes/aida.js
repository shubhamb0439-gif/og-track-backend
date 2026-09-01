const express = require('express');
const multer = require('multer');
const config = require('../config');
const { requireTenantAidaAuth, requireMasterAdminAidaAuth } = require('../aida/auth');
const { buildTenantContext, buildMasterAdminContext } = require('../aida/contextBuilder');
const { registerAllTools } = require('../aida/tools');
const { listAvailableTools } = require('../aida/toolRegistry');
const { runTurn, runTurnStream } = require('../aida/engine');
const sessionMemory = require('../aida/sessionMemory');
const jobStore = require('../aida/jobs/jobStore');
const jobRunner = require('../aida/jobs/jobRunner');
const voiceSession = require('../aida/voice/voiceSession');
const { transcribeAudio } = require('../aida/voice/speechToText');
const { warmFillerCache } = require('../aida/voice/fillerPhrases');
const { createTurnTimer } = require('../aida/latency');
const { buildDirective, safeDirective } = require('../aida/responseDirector');
const { getCombinedStatus } = require('../aida/codingAgent/github');
const { matchTodayCelebrations } = require('../aida/celebrations');
const { tryResolvePreviewUrl } = require('../aida/jobs/previewResolver');
const memory = require('../aida/memory');

registerAllTools();
sessionMemory.startSweeper();
warmFillerCache().catch((e) => console.error('[aida-voice] filler cache warm-up failed:', e));

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
 * Runs one AIDA turn — text generation plus, for voice requests, the speech
 * pipeline — shared by POST /chat and POST /voice-input (they differ only in
 * where userMessage comes from). This is where the streaming upgrade lives:
 *
 * - AIDA_STREAMING_ENABLED=true (default): the LLM call streams text via
 *   engine.runTurnStream(), and each sentence-sized chunk is handed to
 *   ElevenLabs (via voiceSession.createStreamingSpeaker) as soon as it's
 *   ready — audio can start well before the LLM has finished the full reply.
 * - AIDA_STREAMING_ENABLED=false: falls back to the original behavior byte
 *   for byte (plain runTurn(), then voiceSession.speakReply(fullText) once
 *   it resolves) — the safe rollback path.
 *
 * Either way the HTTP response shape is unchanged ({ reply, toolCalls,
 * turnId }) and audio still arrives over the same socket.io events — nothing
 * downstream needs to know which path ran.
 */
async function runConversationTurn({ req, context, userMessage, wantsVoice, pre }) {
  const history = sessionMemory.getHistory(context);
  const useStreaming = wantsVoice && config.aida.streamingEnabled;

  // First turn of a fresh conversation ("the user just opened/activated
  // AIDA") — check once whether today is this user's birthday or work
  // anniversary so engine.js can have AIDA work a natural wish into its
  // reply. Deliberately not re-checked on every later turn in the same
  // conversation (that would mean AIDA repeating the wish on every message).
  // Nice-to-have only: any failure here must never break or delay a normal
  // chat reply.
  if (context.kind === 'tenant' && history.length === 0) {
    try {
      const user = await req.db('users').where({ id: context.userId }).first();
      const celebrations = user ? matchTodayCelebrations(user.date_of_birth, user.joining_date) : [];
      if (celebrations.length) context.todayCelebrations = celebrations;
    } catch (e) {
      console.error('[aida] today-celebration lookup failed (non-fatal):', e);
    }
  }

  // Long-term memory (see src/aida/memory.js) — loaded every masteradmin
  // turn, not just the first (unlike the birthday check above, this should
  // always be current — memories can be added/forgotten mid-conversation via
  // their own tools). Cheap: master-admin-only, a small table. Nice-to-have
  // only: any failure here must never break or delay a normal chat reply.
  if (context.kind === 'masteradmin' && config.aida.memory.enabled) {
    try {
      context.memories = await memory.getActiveMemories();
    } catch (e) {
      console.error('[aida] memory lookup failed (non-fatal):', e);
    }
  }

  // `pre` lets a caller start the turn (and its filler-delay clock) BEFORE
  // userMessage is even known — see POST /voice-input, which starts this
  // the instant the recording arrives rather than after transcription, so
  // the filler can mask STT latency too, not just LLM/TTS latency.
  const turnId = pre?.turnId ?? (wantsVoice ? newTurnId() : null);
  const target = pre?.target ?? (wantsVoice ? voiceTargetFor(context) : null);
  // A timer now exists for EVERY turn, not just voice ones — a plain text
  // chat was previously invisible to AIDA_LATENCY entirely, which meant a
  // "text chat feels slow" report had no real numbers to check, only
  // isolated synthetic ones that couldn't reflect whatever's actually
  // happening on the live server (session load, DB latency from tool calls,
  // etc.). logTurnId is turnId when there is one (voice), otherwise an
  // internal-only id never exposed in the response — the response contract
  // for non-voice chat is unchanged, this is purely for the server log.
  const logTurnId = turnId ?? `text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const timer = pre?.timer ?? createTurnTimer(logTurnId, { provider: config.aida.provider, streaming: useStreaming, voice: wantsVoice });
  // Computed for EVERY turn now, not just voice ones — the emotion classification
  // also shapes word choice/tone in the actual text reply (see engine.js's
  // system prompt), not just TTS delivery, so a text-only chat benefits too.
  // AIDA_EMOTION_ENABLED=false keeps every reply at flat/neutral delivery
  // (no per-turn classification) while leaving everything else — streaming,
  // fillers, interruption — untouched.
  const directive = config.aida.emotionEnabled ? buildDirective(userMessage) : safeDirective(null);

  let fillerTimer = pre?.fillerTimer ?? null;
  let controller = pre?.controller ?? null;
  let speaker = null;

  if (wantsVoice) {
    if (!controller) controller = voiceSession.createTurnController(turnId);
    if (useStreaming) {
      speaker = voiceSession.createStreamingSpeaker({
        io: req.io,
        room: target.room,
        chunkEvent: target.chunkEvent,
        errorEvent: target.errorEvent,
        turnId,
        directive,
        timer,
        // A filler only ever makes sense before real speech has started —
        // the instant the first chunk begins synthesizing, cancel it.
        onFirstChunkReady: () => clearTimeout(fillerTimer),
      });
    }
    // Only start a NEW filler clock if the caller didn't already start one
    // early (pre.fillerTimer) — starting a second one here would race a
    // filler that may already be about to play.
    if (!pre && config.aida.voice.fillerEnabled) {
      fillerTimer = setTimeout(() => {
        voiceSession.playFiller({
          io: req.io, room: target.room, chunkEvent: target.chunkEvent, turnId,
          category: directive.fillerCategory, sessionKey: target.chunkEvent,
        });
      }, config.aida.voice.fillerDelayMs);
    }
  }

  let result;
  try {
    if (useStreaming) {
      result = await runTurnStream(context, userMessage, history, {
        onDelta: (text) => speaker.pushText(text),
        onFirstToken: () => timer.mark('llmFirstChunk'),
        signal: controller.signal,
        directive,
      });
    } else {
      result = await runTurn(context, userMessage, history, directive);
    }
  } catch (e) {
    clearTimeout(fillerTimer);
    if (e.name === 'AbortError') {
      // Barge-in mid-generation — not a failure, just an early stop. Whatever
      // little text/audio was already produced is what the user gets.
      // IMPORTANT: if a streaming speaker exists, some of its chunk
      // synthesis may still be in flight (racing this same abort) — let ITS
      // own finish()/markDone() release the turn once that settles, rather
      // than releasing here and letting a late chunk win a race against a
      // cancellation check that no longer sees the turn as cancelled.
      if (speaker) speaker.finish().catch(() => {});
      else if (wantsVoice) voiceSession.releaseTurn(turnId);
      return { reply: '', toolCalls: [], turnId, interrupted: true };
    }
    if (wantsVoice) voiceSession.releaseTurn(turnId);
    throw e;
  }
  clearTimeout(fillerTimer);
  timer.mark('llmDone');

  if (speaker) {
    speaker.finish().then(() => timer.logSummary()).catch((e) => console.error('[aida-voice] streaming speaker failed:', e));
  } else if (wantsVoice) {
    voiceSession.speakReply({ io: req.io, room: target.room, chunkEvent: target.chunkEvent, errorEvent: target.errorEvent, turnId, text: result.reply });
    timer.logSummary();
  } else {
    // Plain text chat, no voice involved — still worth a latency line (see
    // logTurnId above for why this didn't exist before): total_response_ms
    // here is the WHOLE thing this request was waiting on, tool calls and
    // all, since a text turn has no streaming/TTS stages to break it down
    // further.
    timer.logSummary();
  }

  if (result.reply && result.reply.trim()) sessionMemory.appendTurn(context, userMessage, result.reply);

  return { ...result, turnId };
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
      const wantsVoice = voice === true && config.aida.voice.enabled;

      const { reply, toolCalls, turnId, interrupted, degraded } = await runConversationTurn({
        req, context, userMessage: message.trim(), wantsVoice,
      });

      // Voice is entirely additive: audio is fire-and-forget over socket.io
      // (already under way by the time we get here when streaming is on),
      // and the text response is sent regardless of whether speech
      // synthesis succeeds, fails, or isn't configured at all.
      const responseBody = { reply, toolCalls };
      if (wantsVoice) responseBody.turnId = turnId;
      if (interrupted) responseBody.interrupted = true;
      if (degraded) responseBody.degraded = true;

      res.json(responseBody);
    } catch (e) {
      console.error('POST /aida/chat failed:', e);
      res.status(500).json({ error: e.message || 'AIDA could not process that request.' });
    }
  });

  // POST /voice-cancel — barge-in support: the frontend calls this the
  // instant the user interrupts AIDA mid-speech, so the reply/audio pipeline
  // for that turn (which may still be running, well past this route's own
  // response) stops synthesizing/emitting anything further. When streaming
  // is enabled (the default), this also aborts the in-flight LLM call itself
  // via the turn's shared AbortController — see voiceSession.js's
  // createTurnController/cancelTurn. With streaming disabled (legacy path),
  // it stops audio emission but cannot abort the single blocking LLM call
  // already in flight, same as before.
  router.post('/voice-cancel', (req, res) => {
    const { turnId } = req.body || {};
    if (!turnId || typeof turnId !== 'string') {
      return res.status(400).json({ error: 'turnId is required' });
    }
    if (config.aida.interruptionEnabled) voiceSession.cancelTurn(turnId);
    res.json({ success: true });
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
    let pre = null;
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

      // multer leaves req.body's other fields as raw strings; overwrite
      // pageContext with the parsed object so buildContext(req) reads it
      // exactly the way it already does for a normal JSON POST /chat body.
      req.body = { ...req.body, pageContext };
      const context = buildContext(req);

      // voice-input is a voice-in/voice-out flow, so this always wants voice
      // whenever it's configured, not conditional on a request flag.
      const wantsVoice = config.aida.voice.enabled;

      // Start the turn — and its filler-delay clock — the INSTANT the
      // recording arrives, not after transcription finishes. Whisper is a
      // real, separate network round trip; waiting until it resolves before
      // even starting the "has AIDA started responding yet?" clock meant
      // that gap was pure dead air no filler could ever mask. The
      // transcript isn't known yet at this point, so the filler (if one
      // fires before transcription+reply are ready) uses a generic
      // 'thinking' category rather than one classified from the message.
      if (wantsVoice) {
        const turnId = newTurnId();
        const target = voiceTargetFor(context);
        const timer = createTurnTimer(turnId, { provider: config.aida.provider, streaming: config.aida.streamingEnabled });
        const controller = voiceSession.createTurnController(turnId);
        timer.mark('sttStart');
        let fillerTimer = null;
        if (config.aida.voice.fillerEnabled) {
          fillerTimer = setTimeout(() => {
            voiceSession.playFiller({
              io: req.io, room: target.room, chunkEvent: target.chunkEvent, turnId,
              category: 'thinking', sessionKey: target.chunkEvent,
            });
          }, config.aida.voice.fillerDelayMs);
        }
        pre = { turnId, target, timer, controller, fillerTimer };
      }

      const transcript = await transcribeAudio(req.file.buffer, {
        filename: req.file.originalname || 'audio.webm',
        mimeType: req.file.mimetype || 'audio/webm',
      });
      pre?.timer.mark('sttDone');
      if (!transcript) {
        if (pre) {
          clearTimeout(pre.fillerTimer);
          voiceSession.releaseTurn(pre.turnId);
        }
        return res.status(400).json({ error: 'Could not transcribe any speech from that recording.' });
      }

      const { reply, toolCalls, turnId, interrupted, degraded } = await runConversationTurn({
        req, context, userMessage: transcript, wantsVoice, pre,
      });

      const responseBody = { transcript, reply, turnId, toolCalls: toolCalls || null };
      if (interrupted) responseBody.interrupted = true;
      if (degraded) responseBody.degraded = true;
      res.json(responseBody);
    } catch (e) {
      if (pre) {
        clearTimeout(pre.fillerTimer);
        voiceSession.releaseTurn(pre.turnId);
      }
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

// GET /jobs?kind=dev_repo_fix&status=awaiting_approval&limit=20 — browse jobs
// without already knowing an id. This is what the "AIDA Job" panel (long-
// press-logo menu, master admin) lists from — without it, a weekly
// scheduler-triggered job (no human around to hand out its id) would be
// invisible until someone happened to ask AIDA about it by guessing an id.
masterAdminAidaRouter.get('/jobs', async (req, res) => {
  try {
    const { kind, status, limit } = req.query;
    const jobs = await jobStore.listJobs({ kind, status, limit: limit ? parseInt(limit, 10) : undefined });
    res.json({ jobs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function fetchCiStatus(repo, ref) {
  try {
    const [owner, repoName] = repo.split('/');
    const status = await getCombinedStatus({ owner, repo: repoName, token: config.aida.codingAgent.githubToken, ref });
    return { state: status.state, description: status.statuses?.[0]?.description || null };
  } catch {
    return { state: 'unknown', description: 'Could not reach GitHub for CI status.' };
  }
}


// GET /jobs/:id — poll a job's current state + its event timeline. For a
// dev_repo_fix job with an open PR, also fetches LIVE CI status from GitHub
// and includes it as ciStatus — so the frontend never needs its own GitHub
// access or token; this is the one place that's fetched from. A create_module
// job has TWO repos/PRs, so its ciStatus is shaped { backend, frontend }
// instead of dev_repo_fix's flat { state, description } — see
// docs/FRONTEND_PROMPTS.md for the exact contract.
masterAdminAidaRouter.get('/jobs/:id', async (req, res) => {
  try {
    let job = await jobStore.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const events = await jobStore.listEventsForJob(job.id);

    let ciStatus = null;
    if (job.kind === 'dev_repo_fix' && job.result?.repo && job.result?.branch) {
      ciStatus = await fetchCiStatus(job.result.repo, job.result.branch);
    } else if (job.kind === 'create_module' && job.result?.branch) {
      const { backendRepo, frontendRepo, backendPr, frontendPr, branch } = job.result;
      ciStatus = {
        backend: backendPr ? await fetchCiStatus(backendRepo, branch) : null,
        frontend: frontendPr ? await fetchCiStatus(frontendRepo, branch) : null,
      };
    }

    // Also check whether the frontend's Static Web Apps preview build has
    // finished and posted its URL yet (see previewResolver.js) — persists +
    // broadcasts once found so it doesn't need re-fetching on every
    // subsequent poll, and any other open AIDA Job panel picks it up live.
    job = await tryResolvePreviewUrl(job);

    res.json({ job, events, ciStatus });
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

// POST /jobs/:id/reject — stops the job dead. Most kinds have no
// kind-specific cleanup (jobRunner.runOnReject is a no-op for them); a kind
// that left something real in flight (dev_repo_fix's open PR) gets a chance
// to clean it up before the job itself is marked rejected — see
// jobKinds/index.js's onReject doc.
masterAdminAidaRouter.post('/jobs/:id/reject', async (req, res) => {
  try {
    const job = await jobStore.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'awaiting_approval') {
      return res.status(400).json({ error: `Job is not awaiting approval (status: ${job.status})` });
    }
    await jobRunner.runOnReject(job);
    const rejected = await jobStore.updateJobStatus(job.id, 'rejected');
    await jobStore.appendEvent(job.id, 'rejected', { rejectedBy: req.admin.adminId });
    jobRunner.emitJobUpdate(rejected);
    res.json({ job: rejected });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// runConversationTurn is exported alongside the routers purely for testing —
// it lets test/liveConversationTurn-style scripts exercise the REAL
// streaming/filler/interruption wiring directly, without needing a full
// HTTP+DB+socket.io harness. Not used by any other module in the app.
module.exports = { tenantAidaRouter, masterAdminAidaRouter, runConversationTurn };
