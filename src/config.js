require('dotenv').config();

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}. Check your .env file (see .env.example).`);
  return v;
}

// Multiple SQL logical servers, one per Azure region you've set up, so
// masteradmin can pick where a new company's database gets created.
// AZURE_SQL_REGIONS is optional JSON, e.g.:
//   [{"key":"eastus","label":"East US","server":"ogtrack-sql-eastus.database.windows.net"}]
// Each entry can optionally override user/password; otherwise it reuses the
// main AZURE_SQL_USER/PASSWORD (the normal case when one admin login was
// used to create every regional server).
function buildSqlRegions() {
  const regions = {
    default: {
      key: 'default',
      label: process.env.AZURE_SQL_DEFAULT_REGION_LABEL || 'Default',
      server: required('AZURE_SQL_SERVER'),
      user: required('AZURE_SQL_USER'),
      password: required('AZURE_SQL_PASSWORD'),
    },
  };
  if (process.env.AZURE_SQL_REGIONS) {
    try {
      const extra = JSON.parse(process.env.AZURE_SQL_REGIONS);
      extra.forEach(r => {
        if (!r.key || !r.server) return;
        regions[r.key] = {
          key: r.key,
          label: r.label || r.key,
          server: r.server,
          user: r.user || regions.default.user,
          password: r.password || regions.default.password,
        };
      });
    } catch (e) {
      console.error('[config] AZURE_SQL_REGIONS is not valid JSON, ignoring:', e.message);
    }
  }
  return regions;
}

module.exports = {
  sql: {
    server: required('AZURE_SQL_SERVER'),
    port: parseInt(process.env.AZURE_SQL_PORT || '1433', 10),
    user: required('AZURE_SQL_USER'),
    password: required('AZURE_SQL_PASSWORD'),
    encrypt: (process.env.AZURE_SQL_ENCRYPT || 'true') === 'true',
    trustServerCertificate: (process.env.AZURE_SQL_TRUST_SERVER_CERT || 'false') === 'true',
    coreDatabase: process.env.AZURE_SQL_CORE_DB || 'OGCore',
    regions: buildSqlRegions(),
  },
  app: {
    port: parseInt(process.env.PORT || '3000', 10),
    qrSecret: process.env.QR_SECRET || 'ogtrack-qr-att-2024',
    jwtSecret: required('JWT_SECRET'),
    bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS || '10', 10),
  },
  // AIDA (AI orchestration layer) — deliberately NOT validated via required()
  // like the rest of config: the app must keep booting for every existing
  // tenant even if AIDA hasn't been configured yet. Routes check
  // config.aida.enabled themselves and return 503 rather than crashing here.
  //
  // Provider is picked via AIDA_PROVIDER ('anthropic' | 'openai', defaults to
  // anthropic) — src/aida/engine.js dispatches to the matching adapter under
  // src/aida/providers/. Only that provider's API key needs to be set.
  aida: (() => {
    const provider = (process.env.AIDA_PROVIDER || 'anthropic').toLowerCase();
    const apiKey = provider === 'openai' ? (process.env.OPENAI_API_KEY || null) : (process.env.ANTHROPIC_API_KEY || null);
    const defaultModel = provider === 'openai' ? 'gpt-4o' : 'claude-sonnet-5';
    return {
      provider,
      enabled: !!apiKey,
      apiKey,
      model: process.env.AIDA_MODEL || defaultModel,
      maxToolIterations: parseInt(process.env.AIDA_MAX_TOOL_ITERATIONS || '4', 10),
      sessionTtlMs: parseInt(process.env.AIDA_SESSION_TTL_MINUTES || '120', 10) * 60 * 1000,
      maxHistoryMessages: parseInt(process.env.AIDA_MAX_HISTORY_MESSAGES || '20', 10),
      // Real-time voice pipeline toggles — all default to the new behavior,
      // but every one of these can be flipped back to the legacy behavior
      // via env var with no code change (see docs/AIDA_VOICE_UPGRADE.md).
      streamingEnabled: (process.env.AIDA_STREAMING_ENABLED || 'true') === 'true',
      interruptionEnabled: (process.env.AIDA_INTERRUPTION_ENABLED || 'true') === 'true',
      emotionEnabled: (process.env.AIDA_EMOTION_ENABLED || 'true') === 'true',
      debugLatency: (process.env.AIDA_DEBUG_LATENCY || 'false') === 'true',
      // Internal loopback base URL AIDA uses to call OG Track's OWN REST API —
      // this is what makes "never touch the DB directly" real: every tool
      // executes as a normal HTTP call through the same Express app, so it
      // goes through the same resolveTenant/requireModule gates as any browser
      // request. Override if the app is behind a reverse proxy internally.
      internalBaseUrl: process.env.AIDA_INTERNAL_BASE_URL || `http://127.0.0.1:${parseInt(process.env.PORT || '3000', 10)}`,
      // Lightweight repo-diagnosis capability (src/aida/jobs/jobKinds/devDiagnose.js):
      // clone + read-only source scan + LLM report, no code execution, no sandbox —
      // an interim step before the full sandboxed dev/deploy pipeline from the AIDA
      // power-tier plan. githubToken is only needed for PRIVATE repos; authorizedRepos
      // is a hard allowlist checked both at tool-call time and again inside the job
      // itself (defense in depth) — nothing outside this list can ever be cloned.
      githubToken: process.env.AIDA_GITHUB_TOKEN || null,
      authorizedRepos: (process.env.AIDA_AUTHORIZED_REPOS || '')
        .split(',').map((s) => s.trim()).filter(Boolean),
      // Coding agent (src/aida/codingAgent/) — the "AIDA writes and tests
      // actual code" capability (phase 1: weekly self-diagnose-and-fix; see
      // docs/AIDA_PHASE1_SELF_FIX_PLAN.md). Deliberately its OWN provider
      // setting, independent of `provider`/`apiKey` above (AIDA's normal
      // chat) — starts on OpenAI (temporary, reuses the existing
      // OPENAI_API_KEY) and is meant to move to Anthropic later via
      // AIDA_CODING_AGENT_PROVIDER=anthropic + ANTHROPIC_API_KEY alone, no
      // code change, once that key exists. githubToken here is separately
      // write-scoped (Contents + Pull requests only) — never reuses
      // AIDA_GITHUB_TOKEN above, which stays read-only for dev_repo_diagnose.
      codingAgent: (() => {
        const provider = (process.env.AIDA_CODING_AGENT_PROVIDER || 'openai').toLowerCase();
        const apiKey = provider === 'openai' ? (process.env.OPENAI_API_KEY || null) : (process.env.ANTHROPIC_API_KEY || null);
        const defaultModel = provider === 'openai' ? 'gpt-4o' : 'claude-sonnet-5';
        return {
          provider,
          enabled: !!apiKey,
          apiKey,
          model: process.env.AIDA_CODING_AGENT_MODEL || defaultModel,
          githubToken: process.env.AIDA_CODING_AGENT_GITHUB_TOKEN || null,
        };
      })(),
      // Phase 2 of the power-tier plan — "AIDA, create me a module." Builds
      // across the SAME two repos every time (unlike dev_repo_fix, which
      // takes a repo per chat call), so they're configured once here rather
      // than passed in chat. insertOnlyFiles are the narrow, named
      // exceptions to "new files only" (see moduleGuardrails.js) — files the
      // agent may ADD lines to (a new require, a new app.use(...), a new
      // MODULE_TO_SCRIPT map entry) but never change or remove a line from.
      // frontendInsertOnlyFiles starts empty because the frontend repo's own
      // registration point (routing/nav config) isn't confirmed yet — until
      // it's added here, the agent describes that step in its summary for a
      // human to do by hand instead of touching it directly.
      moduleBuilder: (() => {
        // Staging DB reuses the SAME Azure SQL server/user/password already
        // configured above for the real app (AZURE_SQL_*) by default — it's
        // one more database on that server, not a separate credential to
        // provision and manage. Override the individual pieces only if the
        // staging DB should live somewhere else entirely.
        const stagingDb = {
          server: process.env.AIDA_STAGING_SQL_SERVER || process.env.AZURE_SQL_SERVER || null,
          port: parseInt(process.env.AIDA_STAGING_SQL_PORT || process.env.AZURE_SQL_PORT || '1433', 10),
          user: process.env.AIDA_STAGING_SQL_USER || process.env.AZURE_SQL_USER || null,
          password: process.env.AIDA_STAGING_SQL_PASSWORD || process.env.AZURE_SQL_PASSWORD || null,
          database: process.env.AIDA_STAGING_SQL_DATABASE || null, // the one value that MUST be its own — never reuse OGCore's own database name here
        };
        const backendRepo = process.env.AIDA_MODULE_BACKEND_REPO || null; // "owner/repo"
        const frontendRepo = process.env.AIDA_MODULE_FRONTEND_REPO || null; // "owner/repo"
        // Must match scripts/provisionStagingDb.js's AIDA_STAGING_COMPANY_SLUG
        // default — createModule.js auto-enables each new module for this one
        // company (never a real tenant) so a preview doesn't need a manual
        // "enable this module" step every single time, on top of the manual
        // frontend-wiring step that already exists.
        const previewCompanySlug = process.env.AIDA_STAGING_COMPANY_SLUG || 'aida-preview';
        return {
          previewCompanySlug,
          backendRepo,
          frontendRepo,
          frontendStartCommand: process.env.AIDA_MODULE_FRONTEND_START_CMD || 'node serve.js',
          // Confirmed: the frontend has no API-base-URL env var and no build
          // step at all (plain static HTML, serve.js just serves it as-is).
          // Its inline script instead hardcodes http://localhost:3000
          // whenever it detects it's being viewed from localhost — so the
          // preview backend MUST bind to this exact port for the frontend
          // preview to be able to reach it; only frontend gets a dynamically
          // picked free port (via FRONTEND_PORT, which serve.js does read).
          previewBackendPort: parseInt(process.env.AIDA_MODULE_PREVIEW_BACKEND_PORT || '3000', 10),
          frontendPortEnvVar: process.env.AIDA_MODULE_FRONTEND_PORT_ENV_VAR || 'FRONTEND_PORT',
          stagingDb,
          insertOnlyFiles: {
            backend: ['src/server.js', 'src/utils/provisioning.js'],
            frontend: (process.env.AIDA_MODULE_FRONTEND_INSERT_ONLY_FILES || '')
              .split(',').map((s) => s.trim()).filter(Boolean),
          },
          enabled: !!(backendRepo && frontendRepo && stagingDb.server && stagingDb.database),
        };
      })(),
      // Voice (src/aida/voice/) — ElevenLabs TTS, chunked over the existing
      // socket.io connection. Soft-optional like the rest of this block:
      // enabled only when both an API key AND a voice id are set, so a
      // POST /chat with voice:true silently stays text-only otherwise
      // rather than erroring.
      voice: (() => {
        const apiKey = process.env.ELEVENLABS_API_KEY || null;
        const voiceId = process.env.ELEVENLABS_VOICE_ID || null;
        return {
          enabled: !!apiKey && !!voiceId,
          apiKey,
          voiceId,
          modelId: process.env.ELEVENLABS_MODEL_ID || 'eleven_flash_v2_5',
          // Fillers are pre-cached (synthesized once, at server startup or on
          // first use — never live, on the critical path of a real reply), so
          // they're the one place a slower, more expressive model costs
          // nothing in real-time latency. Defaults to eleven_v3 (confirmed
          // live: it accepts bracket audio tags like [sighs]/[gasps] — 1.7s
          // vs. the realtime model's 0.3s per phrase, fine for a one-time
          // warm-up, would be a real problem for a live reply chunk, which is
          // why the live reply path stays on `modelId` above, untouched).
          fillerModelId: process.env.ELEVENLABS_FILLER_MODEL_ID || 'eleven_v3',
          outputFormat: process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_128',
          maxConcurrentChunks: parseInt(process.env.ELEVENLABS_MAX_CONCURRENT_CHUNKS || '2', 10),
          maxCharsPerReply: parseInt(process.env.ELEVENLABS_MAX_CHARS_PER_REPLY || '2000', 10),
          // Playback pace — ElevenLabs defaults to 1.0 (their "natural" pace),
          // which read as too fast in practice. Tunable without a code change.
          speed: parseFloat(process.env.ELEVENLABS_SPEED || '0.92'),
          // How long to wait for real speech to start before playing a cached
          // "thinking" filler (src/aida/voice/fillerPhrases.js). Measured
          // live against the real OpenAI+ElevenLabs path: first-token time
          // alone is typically 1100-2400ms, so a filler threshold has to sit
          // well below that to actually mask the wait rather than trail it —
          // 400ms means the filler wins the race on nearly every turn, which
          // is the intended behavior (see "CRITICAL FILLER TIMING" — the
          // goal is AIDA saying *something* almost immediately, not silence
          // followed eventually by the real answer).
          fillerDelayMs: parseInt(process.env.AIDA_FILLER_DELAY_MS || process.env.AIDA_VOICE_FILLER_DELAY_MS || '400', 10),
          fillerEnabled: (process.env.AIDA_FILLER_ENABLED || 'true') === 'true',
          // Minimum gap between two fillers in the SAME session (keyed by
          // the per-user voice-chunk event name, so it persists across the
          // whole session, not just one conversation) — short enough that a
          // normal conversational back-and-forth still hears one occasionally,
          // long enough that two messages sent seconds apart don't both get one.
          fillerCooldownMs: parseInt(process.env.AIDA_FILLER_COOLDOWN_MS || '6000', 10),
          // Hard ceiling on ONE chunk's ElevenLabs round trip (connect through
          // full body read). Found live in production testing: a stalled
          // connection with no error and no data ever arriving left a turn
          // hanging forever — no audio, no error event, nothing. Real
          // synthesis for one sentence-chunk was consistently well under 4s
          // in testing, so this should never fire under normal conditions.
          ttsTimeoutMs: parseInt(process.env.AIDA_TTS_TIMEOUT_MS || '15000', 10),
        };
      })(),
      // Speech-to-text for POST /aida/voice-input (src/aida/voice/speechToText.js).
      // Deliberately reads OPENAI_API_KEY directly rather than config.aida.apiKey
      // above — Whisper is OpenAI-specific regardless of which provider is
      // selected for AIDA's chat replies (AIDA_PROVIDER may be 'anthropic' while
      // an OpenAI key still exists purely for transcription, or vice versa).
      speechToText: (() => {
        const apiKey = process.env.OPENAI_API_KEY || null;
        return {
          enabled: !!apiKey,
          apiKey,
          // gpt-4o-mini-transcribe measured live (self-generated sample audio,
          // repeated calls) at ~2.2x faster than whisper-1 (~930ms vs ~2100ms
          // average) with identical transcription output in testing — a real,
          // unconditional win for voice-input latency. Override to whisper-1
          // (or gpt-4o-transcribe, in between the two on both speed and cost)
          // if you need whisper-1's specific behavior for some reason.
          model: process.env.AIDA_STT_MODEL || 'gpt-4o-mini-transcribe',
        };
      })(),
    };
  })(),
};