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
          outputFormat: process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_128',
          maxConcurrentChunks: parseInt(process.env.ELEVENLABS_MAX_CONCURRENT_CHUNKS || '2', 10),
          maxCharsPerReply: parseInt(process.env.ELEVENLABS_MAX_CHARS_PER_REPLY || '2000', 10),
          // Playback pace — ElevenLabs defaults to 1.0 (their "natural" pace),
          // which read as too fast in practice. Tunable without a code change.
          speed: parseFloat(process.env.ELEVENLABS_SPEED || '0.92'),
          // How long to wait for a real reply before playing a cached "thinking"
          // filler (src/aida/voice/fillerPhrases.js) — only fires if the reply is
          // actually slow; a fast reply is completely unaffected.
          fillerDelayMs: parseInt(process.env.AIDA_VOICE_FILLER_DELAY_MS || '1200', 10),
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
          model: process.env.AIDA_STT_MODEL || 'whisper-1',
        };
      })(),
    };
  })(),
};