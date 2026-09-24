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
  // Provider is picked via AIDA_PROVIDER (one of 'anthropic' | 'openai' |
  // 'groq' | 'openrouter' | 'gemini', defaults to anthropic) — src/aida/
  // engine.js dispatches to the matching adapter under src/aida/providers/.
  // This only sets the PROCESS-WIDE default; any of the five can also be
  // picked per-request (see POST /chat's provider/model fields). Only
  // whichever provider(s) actually have their own API key set are usable —
  // GET /aida/models' `providers` list filters to those automatically.
  aida: (() => {
    const provider = (process.env.AIDA_PROVIDER || 'anthropic').toLowerCase();
    // Both keys are kept available regardless of which provider is the
    // process-wide default — a per-conversation override (see engine.js's
    // getProvider(providerName)) needs to actually reach the OTHER
    // provider's real client, not just read whichever single key happened
    // to be selected at boot. `apiKey` stays as the default-provider's key,
    // unchanged, for anything still reading it directly (e.g. the
    // config.aida.enabled gate below).
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY || null;
    const openaiApiKey = process.env.OPENAI_API_KEY || null;
    // Groq/OpenRouter/Gemini keys don't exist in any environment yet (added
    // 2026-09-24, code-first per explicit instruction) — these will read
    // null until the corresponding env var is actually set, at which point
    // `enabled` in GET /aida/models' `providers` filter picks them up
    // automatically, no further code change needed.
    const groqApiKey = process.env.GROQ_API_KEY || null;
    const openrouterApiKey = process.env.OPENROUTER_API_KEY || null;
    const geminiApiKey = process.env.GEMINI_API_KEY || null;
    const apiKey = provider === 'openai' ? openaiApiKey : anthropicApiKey;
    // Per-provider defaults, independent of whichever provider is the
    // process-wide default — config.aida.model (below) can hold an OpenAI
    // model name while provider='openai' is the default, so a per-message
    // override to 'anthropic' must NOT fall back to that value.
    const defaultModels = {
      anthropic: 'claude-sonnet-5',
      openai: 'gpt-4o',
      groq: 'llama-3.3-70b-versatile',
      openrouter: 'moonshotai/kimi-k2',
      gemini: 'gemini-3.8-flash',
    };
    const defaultModel = defaultModels[provider];
    return {
      provider,
      enabled: !!apiKey,
      apiKey,
      anthropicApiKey,
      openaiApiKey,
      groqApiKey,
      openrouterApiKey,
      geminiApiKey,
      model: process.env.AIDA_MODEL || defaultModel,
      defaultModels,
      // Selectable models per provider — what the chat UI's provider/model
      // dropdown offers (AIDA roadmap item 1). Anthropic + OpenAI lists
      // confirmed live via a real API round-trip on 2026-09-24 (see
      // providers/openai.js's history). Groq/OpenRouter/Gemini lists were
      // sourced from each provider's own live docs the same day but NOT yet
      // round-tripped against a real key (none exists yet — these were
      // built ahead of getting the keys, per explicit instruction). Treat
      // these three lists as "best known as of build time, not hands-on
      // verified" until someone actually adds the real keys and confirms.
      models: {
        anthropic: [
          { id: 'claude-sonnet-5', label: 'Sonnet 5' },
          { id: 'claude-opus-5', label: 'Opus 5' },
          { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
          { id: 'claude-fable-5-1', label: 'Fable 5.1' },
        ],
        openai: [
          { id: 'gpt-4o', label: 'GPT-4o' },
          { id: 'gpt-4o-mini', label: 'GPT-4o Mini' },
          { id: 'gpt-5', label: 'GPT-5' },
          { id: 'gpt-5-mini', label: 'GPT-5 Mini' },
          { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
        ],
        // Free tier available (rate-limited) — hosts open-weight models,
        // OpenAI-compatible API. Confirmed against console.groq.com/docs/models.
        groq: [
          { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' },
          { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B (fast)' },
          { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' },
          { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B (fast)' },
        ],
        // One key, many underlying providers — includes Kimi (Moonshot),
        // DeepSeek, Llama, and several genuinely free-tier models. OpenAI-
        // compatible API. Some model ids on OpenRouter have a ":free" variant
        // when the underlying provider sponsors one — check openrouter.ai/models
        // for current availability before relying on that for a specific id.
        openrouter: [
          { id: 'moonshotai/kimi-k2', label: 'Kimi K2 (Moonshot)' },
          { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat' },
          { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B' },
        ],
        // NOT OpenAI-compatible — has its own real adapter (providers/gemini.js).
        // Has a genuinely free tier (rate-limited). Confirmed against
        // ai.google.dev/gemini-api/docs/models.
        gemini: [
          { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
          { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
          { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (Preview)' },
        ],
      },
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
      // The backend's "preview" deployment slot (see .github/workflows/
      // preview_og-track-backend.yml) — a FIXED, always-known URL, unlike the
      // frontend's per-PR Azure Static Web Apps preview hostname (which is
      // unpredictable and has to be fetched from GitHub after the fact — see
      // devFix.js/getSwaPreviewUrl). Any push to a non-main branch already
      // auto-deploys there, so a dev_repo_fix job against the backend repo
      // can report this URL immediately, with no polling needed.
      previewBackendUrl: process.env.AIDA_PREVIEW_BACKEND_URL || null,
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
      // Master-admin-only long-term memory (src/aida/memory.js) — distilled
      // facts AIDA saves/recalls across conversations, backed by OGCore's
      // aida_memories table. AIDA_MEMORY_RETENTION picks a global tier:
      // '1y' | '2y' | 'lifetime' | 'none' (default — feature fully off,
      // matches every existing deployment until this is deliberately turned
      // on). retentionDays is null for 'lifetime' (no cutoff, keep forever).
      memory: (() => {
        const tier = (process.env.AIDA_MEMORY_RETENTION || 'none').toLowerCase();
        const TIERS = { '1y': 365, '2y': 730, lifetime: null };
        const recognized = Object.prototype.hasOwnProperty.call(TIERS, tier);
        if (tier !== 'none' && !recognized) {
          console.error(`[config] AIDA_MEMORY_RETENTION="${tier}" is not a recognized tier (1y, 2y, lifetime, none) — memory stays disabled.`);
        }
        const enabled = tier !== 'none' && recognized;
        return { enabled, tier, retentionDays: enabled ? TIERS[tier] : null };
      })(),
    };
  })(),
  // WhatsApp Business Cloud API bridge (src/routes/whatsapp.js) — lets an
  // allowlisted phone number chat with AIDA's master-admin context over
  // WhatsApp instead of the web app. Deliberately NOT validated via
  // required() — same reasoning as `aida` above, the app must keep booting
  // even before this is configured; the route itself no-ops until enabled.
  whatsapp: (() => {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN || null;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || null;
    // Optional: map a specific allowed phone number to a specific
    // platform_admins row by email, e.g. {"8310066102":"masteradmin@ogplus.com"}
    // — so the AIDA reply/audit trail (job approve/reject) reflects who
    // actually messaged. A number with no entry here falls back to the
    // first active platform admin at request time (see routes/whatsapp.js).
    let adminMap = {};
    if (process.env.WHATSAPP_ADMIN_MAP) {
      try { adminMap = JSON.parse(process.env.WHATSAPP_ADMIN_MAP); }
      catch (e) { console.error('[config] WHATSAPP_ADMIN_MAP is not valid JSON, ignoring:', e.message); }
    }
    return {
      enabled: !!(accessToken && phoneNumberId),
      // Arbitrary secret YOU pick and enter into Meta's webhook setup form —
      // proves the GET verification handshake request actually came from
      // your own Meta app config, not a guess.
      verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || null,
      accessToken,
      phoneNumberId,
      // Meta app's "App Secret" — used to verify the X-Hub-Signature-256
      // header on every incoming POST, so a forged request can't impersonate
      // an allowed number. Strongly recommended; POSTs are rejected outright
      // once this is set.
      appSecret: process.env.WHATSAPP_APP_SECRET || null,
      allowedNumbers: (process.env.WHATSAPP_ALLOWED_NUMBERS || '')
        .split(',').map((s) => s.trim()).filter(Boolean),
      adminMap,
    };
  })(),
  // Azure Communication Services Email (src/utils/email.js) — currently just
  // the "forgot password" flow (src/routes/users.js). Deliberately NOT
  // validated via required() — same reasoning as `aida`/`whatsapp` above.
  email: {
    enabled: !!(process.env.AZURE_ACS_EMAIL_CONNECTION_STRING && process.env.AZURE_ACS_EMAIL_SENDER),
    connectionString: process.env.AZURE_ACS_EMAIL_CONNECTION_STRING || null,
    // Must be a MailFrom sender already verified on this ACS resource's
    // domain (e.g. "no-reply@ogplus.in") — ACS rejects sends from anything
    // not explicitly added there, see the domain-setup steps in chat.
    senderAddress: process.env.AZURE_ACS_EMAIL_SENDER || null,
    // Base URL of the deployed frontend — the reset-password link emailed to
    // a user is `${frontendBaseUrl}/reset-password?token=...&company=...`.
    // No default: without this, a reset email would go out with a broken
    // link, so treat it as required for the feature to actually work even
    // though it's not required() at boot (same "keep booting either way"
    // reasoning as the rest of this block).
    frontendBaseUrl: process.env.FRONTEND_BASE_URL || null,
  },
  // BigCommerce (src/routes/sitara.js's webhook + outbound status push) —
  // Sitara Bespoke's own store, global env vars per the user's own choice
  // (only one company uses this today). Deliberately NOT validated via
  // required() — same reasoning as the rest of this file.
  bigcommerce: {
    enabled: !!(process.env.BIGCOMMERCE_STORE_HASH && process.env.BIGCOMMERCE_ACCESS_TOKEN),
    storeHash: process.env.BIGCOMMERCE_STORE_HASH || null,
    accessToken: process.env.BIGCOMMERCE_ACCESS_TOKEN || null,
    // BigCommerce doesn't sign webhook payloads with a computed HMAC the way
    // Meta/Stripe do — its real mechanism is a custom header you attach when
    // creating the webhook subscription (BigCommerce V3 Webhooks API's
    // "headers" field). This is that header's expected value; the header
    // NAME itself is hardcoded to X-Sitara-Webhook-Secret in sitara.js — use
    // that exact name when creating the webhook subscription.
    webhookSecret: process.env.BIGCOMMERCE_WEBHOOK_SECRET || null,
  },
  // Razorpay (src/routes/sitara.js's payment reconciliation) — Sitara's
  // existing payment gateway behind BigCommerce checkout. Global env vars,
  // same reasoning as bigcommerce above.
  razorpay: {
    enabled: !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
    keyId: process.env.RAZORPAY_KEY_ID || null,
    keySecret: process.env.RAZORPAY_KEY_SECRET || null,
    // Razorpay DOES sign webhooks with a computed HMAC-SHA256 of the raw
    // body (unlike BigCommerce) — this is that secret, set when creating
    // the webhook in Razorpay's own dashboard (Settings > Webhooks).
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || null,
  },
  // Sitara order-staleness threshold — computed at read time (src/routes/
  // sitara.js), not a background poller, so there's no extra always-on job
  // keeping OGCore/the tenant DB active (see the Azure cost investigation,
  // 2026-09-10, for why that matters).
  sitara: {
    staleOrderDays: Number(process.env.SITARA_STALE_ORDER_DAYS || 3),
  },
};