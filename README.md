# OGTrack Backend v2 — Azure SQL, multi-tenant (DB-per-company)

The rewritten backend. Replaces Firestore with Azure SQL, splits every request
onto the correct tenant database via the URL slug, and keeps real-time events
isolated per tenant.

## Structure

```
src/
  config.js                     env loader (throws early if a required var is missing)
  db/
    core.js                     single fixed Knex connection to OGCore
    tenantConnections.js        slug -> company row -> cached per-tenant Knex connection
  middleware/
    resolveTenant.js            attaches req.db + req.company for /api/:slug/* routes
    requireModule.js            403s if the tenant hasn't enabled that module
  utils/
    counters.js                 row-locked counter (replaces Firestore transaction counters)
    auth.js                     bcrypt hashing + JWT (replaces plaintext passwords)
  routes/
    companies.js                masteradmin — operates on OGCore only
    users.js  projects.js  bugs.js  sprints.js  stories.js
    sub_tickets.js  roles.js  attendance.js       tenant-scoped
    aida.js                     AIDA chat/history/session/tools endpoints (tenant + masteradmin)
  aida/                         AIDA — the AI orchestration layer (see below)
    apiClient.js                calls OG Track's OWN REST API over loopback HTTP (never touches req.db)
    toolRegistry.js             register/list/execute tools, filtered by enabled_modules
    tools/                      one file per module: attendance, projects, crm, inventory, finance, hr, masteradmin
    engine.js                   intent -> tool selection -> API call -> result -> NL response, dispatches by provider
    providers/                  anthropic.js / openai.js — provider-specific tool-use loop + SDK call
    sessionMemory.js            in-memory per-user conversation memory, TTL + logout reset
    contextBuilder.js           builds the AidaContext (identity, tenant, enabled modules, current page)
    auth.js                     verifies the caller's JWT for AIDA requests specifically
  server.js                     wires it all together + Socket.io per-tenant rooms
```

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in your real Azure SQL values:
   - `AZURE_SQL_SERVER` — your logical server host, e.g. `ogtrack-sqlsrv-prod.database.windows.net`
   - `AZURE_SQL_USER` / `AZURE_SQL_PASSWORD` — the admin login you use in Azure Data Studio
   - `JWT_SECRET` — any long random string
   - Leave `AZURE_SQL_CORE_DB=OGCore`
3. Make sure the Azure SQL server firewall allows your machine's IP (same rule that let Azure Data Studio connect).
4. `npm start`  → should print `OGTrack backend listening on :3000`

## Smoke test — is it alive?

```
curl http://localhost:3000/health
# {"status":"ok","core":"connected"}   <- confirms it reached OGCore
```

If `core` shows an error instead, it's the same class of issue as the Azure Data
Studio connection errors: wrong server host, firewall, or credentials.

## The important test — prove tenant isolation

These two calls hit the SAME code but land in DIFFERENT databases purely because
of the slug (`ogtrack` vs `cajo`):

```
# Register a user into OGTrack's database
curl -X POST http://localhost:3000/api/ogtrack/users/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Alice","email":"alice@ogtrack.test","password":"Test@1234","role":"tester"}'

# Register a user into Cajo's database
curl -X POST http://localhost:3000/api/cajo/users/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Bob","email":"bob@cajo.test","password":"Test@1234","role":"tester"}'
```

Then confirm each user only exists in its own tenant by checking the databases in
Azure Data Studio:

```sql
-- against ogtrack-db-prod:  should show Alice, NOT Bob
SELECT name, email, role, status FROM dbo.users;

-- against OGtrack_cajo:     should show Bob, NOT Alice
SELECT name, email, role, status FROM dbo.users;
```

New users come in as `status='pending'` (same as the old app). To activate one so
you can log in, either flip it in SQL:
```sql
UPDATE dbo.users SET status='active' WHERE email='alice@ogtrack.test';
```
...or once you have an active superadmin, via `PATCH /api/ogtrack/users/:id/status`.

## The module-gating test

Cajo has the attendance module; OGTrack does not. Same endpoint, different result:

```
# Works (Cajo has attendance):
curl -X POST http://localhost:3000/api/cajo/attendance/clockin \
  -H "Content-Type: application/json" -d '{"userId":"<a real cajo user id>","userName":"Bob"}'

# 403 (OGTrack does NOT have attendance):
curl -X POST http://localhost:3000/api/ogtrack/attendance/clockin \
  -H "Content-Type: application/json" -d '{"userId":"x","userName":"y"}'
# {"error":"Module \"attendance\" is not enabled for this company.","module":"attendance"}
```

That 403 is the whole multi-tenant module system working: one codebase, per-tenant
behavior driven entirely by the `enabled_modules` column in OGCore.

## The AIDA async job model test

No chat tool creates a real job yet (that arrives with the first real job kind, e.g. a
future `dev_diagnose`) — so this creates a synthetic one directly, then drives it through
the real HTTP endpoints, proving the queue → run → approval-gate → resume pipeline works
end to end:

```
# 1. a master-admin token (throwaway is fine — same JWT_SECRET the app already trusts)
node -e "const jwt=require('jsonwebtoken');const config=require('./src/config');console.log(jwt.sign({adminId:'test-admin',role:'masteradmin'},config.app.jwtSecret,{expiresIn:'2h'}))"

# 2. create a job that pauses for approval
node -e "
const jobStore = require('./src/aida/jobs/jobStore');
(async () => {
  const job = await jobStore.createJob({ kind: 'noop_gated', createdByUserId: 'test-admin' });
  console.log(job.id);
  process.exit(0);
})();
"

# 3. wait ~5s for the background poller, then check it's paused at the gate
curl -s http://localhost:3000/api/masteradmin/aida/jobs/<jobId> -H "Authorization: Bearer <token>"
# job.status should read "awaiting_approval" — it does NOT proceed on its own.

# 4. approve it
curl -s -X POST http://localhost:3000/api/masteradmin/aida/jobs/<jobId>/approve -H "Authorization: Bearer <token>"
# job.status flips to "completed". Calling /approve again now 400s.
```

Swap `noop_gated` for `noop` in step 2 to see the un-gated happy path (queued→running→
completed with no pause), or call `/reject` instead of `/approve` in step 4 and re-`GET`
a few seconds later to confirm it stays `rejected` rather than silently completing.

## What changed vs the old server.js (important)

- **Login now returns a JWT** (`{ token, user }`) instead of just the user object.
  The frontend will need to store that token and send it as `Authorization: Bearer <token>`
  — we handle this in the frontend-split phase.
- **Passwords are bcrypt-hashed.** The old plaintext accounts from Firestore can't be
  carried over as-is; existing users need a fresh registration or a password reset
  (covered in the data-migration step). The old auto-seeded `admin@bugtrack.com` is
  NOT auto-created here — we'll seed a proper hashed superadmin during migration.
- **No `companyId` filtering anywhere** — the database connection is the tenant boundary.

## Endpoint map (all built)

Tenant-scoped, all under `/api/:slug/...`:
- `users` (register/login/status/role), `projects`, `bugs`, `sprints`, `stories`,
  `sub-tickets`, `roles`
- `attendance/*` (clockin/out, regularize, leave) — gated by the attendance module
- `conversations/*` (messaging) — gated by the messages module
- `acc/clients`, `acc/time-entries`, `acc/eod-reports`, `acc/eod-routes` — gated by acc_clients
- `hr/jobs`, `hr/candidates`, `hr/interviews` — gated by hr_jobs

Platform-scoped (OGCore, masteradmin): `/api/companies`

Note the `acc/` and `hr/` path prefixes — accounting and HR endpoints live under
those namespaces (e.g. `POST /api/ogtrack/hr/jobs`, `GET /api/ogtrack/acc/clients`)
so their module gate doesn't interfere with sibling routes.

## AIDA — the AI layer

AIDA is a conversational orchestration layer over OG Track's existing APIs. It
never queries a database directly: every tool call is a real HTTP request
back into this same Express app (`src/aida/apiClient.js`), so it goes through
the exact same `resolveTenant` / `requireModule` gates a browser request
would. It is currently **read-only** — no tool can create, update, or delete
anything.

### Env vars (add to `.env`)

AIDA supports either Anthropic or OpenAI as the model provider, picked via
`AIDA_PROVIDER`. Only the matching API key needs to be set — src/aida/engine.js
dispatches to the right adapter under `src/aida/providers/`.

```
AIDA_PROVIDER=anthropic             # optional, 'anthropic' (default) or 'openai'

# if AIDA_PROVIDER=anthropic (or unset):
ANTHROPIC_API_KEY=sk-ant-...        # required — AIDA routes 503 until this is set
# if AIDA_PROVIDER=openai:
OPENAI_API_KEY=sk-...               # required instead — check this is a current model id for your account
# (default model is gpt-4o for openai / claude-sonnet-5 for anthropic — override below if needed)

AIDA_MODEL=claude-sonnet-5          # optional — override the default model for whichever provider is active
AIDA_MAX_TOOL_ITERATIONS=4          # optional — safety cap on the tool-use loop per chat turn
AIDA_SESSION_TTL_MINUTES=120        # optional — idle conversation memory expiry
AIDA_MAX_HISTORY_MESSAGES=20        # optional — how many recent turns are kept per user
AIDA_INTERNAL_BASE_URL=http://127.0.0.1:3000   # optional — override if proxied internally

# Real-time voice pipeline (see "Voice — streaming, personality, interruption" below)
AIDA_STREAMING_ENABLED=true         # optional — false reverts to the old wait-for-full-reply pipeline
AIDA_INTERRUPTION_ENABLED=true      # optional — false makes POST /voice-cancel a no-op
AIDA_EMOTION_ENABLED=true           # optional — false keeps every voice reply at flat/neutral delivery
AIDA_DEBUG_LATENCY=false            # optional — true adds a verbose per-mark log line per voice turn
AIDA_FILLER_ENABLED=true            # optional — false disables "thinking..." filler playback entirely
AIDA_FILLER_DELAY_MS=400            # optional — same as the old AIDA_VOICE_FILLER_DELAY_MS name (still read as a fallback)
AIDA_FILLER_COOLDOWN_MS=6000        # optional — minimum gap between two fillers in the same session
```

Nothing else in the app requires these — the server still boots and every
other route still works if the active provider's API key is unset; only
`/aida/*` routes return `503` until it's configured.

Switching provider is just the env var — `toolRegistry.js` exposes both
`toAnthropicTools()` and `toOpenAITools()` from the same tool definitions, so
no tool file needs to change.

### Endpoints

```
POST   /api/:slug/aida/chat        { message, pageContext? }  -> { reply, toolCalls }
GET    /api/:slug/aida/history     -> { messages }
DELETE /api/:slug/aida/session     -> clears this user's conversation memory (call on logout)
GET    /api/:slug/aida/tools       -> tools available to this tenant right now

# Same four endpoints for the platform master admin:
POST   /api/masteradmin/aida/chat
GET    /api/masteradmin/aida/history
DELETE /api/masteradmin/aida/session
GET    /api/masteradmin/aida/tools
```

All AIDA routes require `Authorization: Bearer <token>` from the existing
login flow — this is the one place in the backend that actually verifies the
JWT on every request (see the comment in `src/aida/auth.js` for why most
other routes don't).

### Adding a tool for a new/existing module

Add an entry to (or a new file under) `src/aida/tools/`, exporting `{ name,
description, requiredModules, inputSchema, handler(context, args) }`, and
list the file in `src/aida/tools/index.js`. `handler` should call
`callTenantApi`/`callPlatformApi` from `apiClient.js` — never `req.db`. It
shows up to AIDA automatically for every tenant that has one of
`requiredModules` enabled; nothing else changes.

### Master admin — cross-tenant read (`src/aida/tools/masteradminCrossTenant.js`)

Master admin's AIDA session additionally sees a `masteradmin_<toolName>` counterpart
for every read-only tenant tool (e.g. `masteradmin_hr_get_employees`), each taking an
explicit `companySlug` argument. These are generated automatically from the existing
tenant tool list — adding a new read-only tenant tool gives master admin a cross-tenant
version of it for free, no extra file to touch. Write-capable tools are deliberately not
wrapped this way — cross-tenant writes need an approval-gated job flow (see below) rather
than firing synchronously from a chat turn.

**Real bug found and fixed, found from live production testing (unrelated to the voice
upgrade, but surfaced during the same testing pass)**: `masteradmin_attendance_*` tools
were failing with what read to the user as "there's a token issue" — traced to
`GET /attendance/all` (`src/routes/attendance.js`, added in a recent commit as a
manager-team-scoping fix) requiring `req.auth.slug === req.company.slug`. The cross-tenant
wrapper was reusing the master admin's OWN JWT (`role: 'masteradmin'`, no `slug` at all —
it isn't scoped to any one company) as the `Authorization` header for the impersonated
tenant call, which can never satisfy that check for any company — so this specific
endpoint always 401'd for master admin, while modules without that particular check (e.g.
inventory) kept working, which is exactly the asymmetry that was reported. Fixed in
`wrapForCrossTenant()`: instead of forwarding the master admin's raw token, it now mints a
short-lived (5 min) synthetic token shaped like a real tenant token —
`{ userId, role: 'superadmin', slug: companySlug }`, signed with the same `JWT_SECRET` —
which satisfies this (and any future) per-company token-scoping check the same way a real
tenant superadmin's token would, without needing to special-case individual routes as they
get hardened. Covered by `test/masteradminCrossTenant.test.js`, which decodes the minted
token and asserts it actually passes `attendance.js`'s real check.

### Async job model (`src/aida/jobs/`)

Anything AIDA does that can't finish inside one `POST /aida/chat` request/response cycle —
repo diagnosis, code fixes, cross-tenant writes, new-app deployment — runs as a **job**
instead. Master-admin only for now (every capability that will create one is
master-admin-scoped per the AIDA power-tier plan).

- `ogtrack-sql-schema/core/01_platform_core.sql` — first tracked OGCore schema file;
  adds `aida_jobs` (status: `queued|running|awaiting_approval|approved|rejected|
  completed|failed`) and `aida_job_events` (append-only timeline per job, same pattern
  as the existing `provisioning_log` table).
- `jobStore.js` — all DB access. `jobKinds/index.js` — pluggable registry; a job kind
  exports `run(job, helpers)` and optionally `resume(job, helpers)` (called when an
  `awaiting_approval` job is approved). `jobRunner.js` — background poller
  (`setInterval`, same `unref()`'d pattern as `sessionMemory.startSweeper()`) that picks
  up `queued` jobs and pushes state changes over `socket.io` into a `masteradmin:<userId>`
  room as an `aida:job` event, so a job that finishes long after its originating chat
  request returned still lands back in the conversation.
- `src/routes/aida.js` adds `GET /api/masteradmin/aida/jobs/:id`,
  `POST .../jobs/:id/approve`, `POST .../jobs/:id/reject` — approve/reject only valid
  from `awaiting_approval`; reject is terminal (no kind-specific code runs).
- Two synthetic job kinds ship for testing the machinery itself, not as real
  capabilities: `noop` (queued→running→completed automatically) and `noop_gated`
  (queued→running→**awaiting_approval**, only continues after a real approve call).
  `dev_diagnose` (below) is the first real one — registers the same way.

### Repo diagnosis — `dev_repo_diagnose` (`src/aida/jobs/jobKinds/devDiagnose.js`)

The lightweight, no-sandbox-needed first slice of "AIDA as a coding agent." Master
admin asks AIDA to diagnose an authorized repo; it clones the repo, reads its text
source (bounded to ~150KB, common binary/lockfile/`node_modules`-style paths skipped),
and has an LLM write a bug/security/quality/architecture report — all as a background
job via the machinery above, so it doesn't block the chat request. **It never executes
anything from the cloned repo** (no `npm install`, no running tests/scripts, no
`require()`/`eval` of anything from the clone) — the only operations against the clone
are `git clone` and plain file reads, which is what makes it safe to run in this same
backend process instead of needing an isolated sandbox. `dev_get_job_status` lets a
later chat turn ask "is it done, what did it find?" without repeating the job id — AIDA
recalls it from conversation history.

Required env vars (add to `.env`):
```
AIDA_AUTHORIZED_REPOS=owner/repo,another-owner/another-repo   # hard allowlist — checked
                                                                # both at tool-call time
                                                                # AND again inside the job
AIDA_GITHUB_TOKEN=github_pat_...    # only needed for PRIVATE repos — a fine-grained PAT
                                     # scoped to read-only "Contents" on just those repos
```
Without `AIDA_AUTHORIZED_REPOS` set, every `dev_repo_diagnose` call fails closed with an
explicit "not authorized" error — there is no default-allow behavior.

**Known limitation, found and only partially mitigated during testing — read this before
relying on it**: LLM tool-calling is inherently probabilistic, not deterministic, across
every provider. During testing, the model was caught narrating "I've started diagnosing
X, job id job_abc123" **without actually calling the tool** — verified by checking the
claimed job id against the real database and finding nothing there. The system prompt
now explicitly tells the model job ids look like `job_<numbers>_<letters>` and it must
never type one itself, only ever copy one from a real tool result — this measurably
helps, but cannot be guaranteed to reach 100% by prompting alone. **Practical rule: treat
what AIDA's chat reply *says* happened as a claim, not a fact — `GET /aida/jobs/:id`
(or asking AIDA to check, which calls the same tool) is the actual source of truth.**
This is also exactly why every capability in this repo was verified against real
database/API state during development rather than by trusting a chat reply — the same
discipline applies to using it, not just building it.

**Also found during testing**: repo diagnosis sends a genuinely large prompt (up to
~150KB of source text), which can hit token-per-minute rate limits on smaller API plans
fast, especially with more than one diagnosis in quick succession. If you see `429` /
rate-limit errors, that's your provider account's limit, not a bug here.

### Voice — streaming, personality, interruption (`src/aida/voice/`, `src/aida/*.js`)

Speaks AIDA's replies aloud when a chat request includes `voice: true`. As of the
real-time voice upgrade, this is a genuinely **streaming** pipeline end to end, not
"generate the whole reply, then speak it":

```
user message → LLM streams text (providers/*.js runTurnStream)
             → each delta pushed into an incremental sentence chunker (textChunker.js)
             → the instant a sentence/clause boundary completes, that chunk is handed
               to ElevenLabs (elevenLabsClient.js) — bounded concurrency, same as before
             → audio pushed to the browser over the same socket.io connection/room,
               strictly in original order, as soon as each chunk resolves
```

The old "wait for the complete reply, then split+speak it" pipeline (`engine.runTurn`
→ `voiceSession.speakReply`) still exists **unchanged**, byte for byte, as the fallback
when `AIDA_STREAMING_ENABLED=false` — see "Rollback" below.

**Live-verified, not simulated** — measured with real OpenAI + ElevenLabs calls
(`gpt-4o`, `eleven_flash_v2_5`), same-length 3-sentence reply, run back to back in the
same process (bypassing HTTP/auth to isolate the pipeline itself):

| | legacy (non-streaming) | streaming |
|---|---|---|
| time-to-first-audio | 2935 ms | **2101 ms** |
| chunk count | 2 | 3 |
| LLM full-text-ready | 2396 ms | 2279 ms (first token at **1148 ms**) |

Streaming won by ~830ms (~28%) on first-audio for this sample **despite the LLM call
itself finishing around the same time** — because chunk 1's audio started synthesizing
and playing while chunk 2/3's text was still being generated, instead of only starting
TTS after the whole reply existed. The gap widens further for longer replies, since
legacy's first-audio is always gated on the *entire* reply finishing, streaming's isn't.
These are single-sample numbers from one dev environment/network path, not a production
SLA — re-run the same comparison in your deployment target for real numbers there (call
`engine.runTurnStream`/`engine.runTurn` directly with a fake `context` and a stub `io`;
`src/aida/latency.js`'s `AIDA_LATENCY` log line gives the per-turn breakdown either way).

This is entirely additive and fire-and-forgets from `POST /chat` — it never blocks or
affects the text response, and a request with `voice: true` when
`ELEVENLABS_API_KEY`/`ELEVENLABS_VOICE_ID` aren't set just silently stays text-only.

Env vars (ElevenLabs-specific; see the AIDA env var block above for the pipeline
toggles — `AIDA_STREAMING_ENABLED`, `AIDA_FILLER_*`, etc.):
```
ELEVENLABS_API_KEY=...                      # required — voice stays off without it
ELEVENLABS_VOICE_ID=...                     # required — no default voice
ELEVENLABS_MODEL_ID=eleven_flash_v2_5       # optional, this default — a REALTIME model (see below)
ELEVENLABS_FILLER_MODEL_ID=eleven_v3        # optional, this default — fillers are pre-cached, not live,
                                             # so they're synthesized on v3 for real audio-tag support
                                             # ([sighs], [gasps], ...) — see "Filler engine" below
ELEVENLABS_OUTPUT_FORMAT=mp3_44100_128      # optional, this default
ELEVENLABS_MAX_CONCURRENT_CHUNKS=2          # optional, this default
ELEVENLABS_MAX_CHARS_PER_REPLY=2000         # optional — cost guardrail; full text is
                                             # always still shown even if speech is cut
ELEVENLABS_SPEED=0.92                       # optional, this default — ElevenLabs' own 1.0 read as too fast
AIDA_TTS_TIMEOUT_MS=15000                   # optional, this default — see the "no timeout" bug below
```

**Real bug found and fixed, found from live production testing — a genuinely silent hang**:
reported as "the LLM replied but ElevenLabs never did, no audio, no error." Root cause:
`elevenLabsClient.js` had NO timeout anywhere on the ElevenLabs fetch — a connection that
stalls (headers or body never arrive, no error thrown by the network layer either) left
that chunk's promise neither resolving nor rejecting, forever. With no rejection, nothing
ever reached the error-handling path that would emit `aida:voice-error`; with no
resolution, `isFinal` could never be computed either — so the turn just hung silently,
indefinitely, with zero signal to the frontend that anything had gone wrong. Fixed:
`synthesizeChunkStream` now always races the whole request (connect through full body
read) against a hard ceiling (`AIDA_TTS_TIMEOUT_MS`, default 15s — real synthesis in
testing was consistently well under 4s, so this should never fire under normal
conditions) — a timeout now surfaces as a normal `aida:voice-error` event instead of
silence. Covered by `test/elevenLabsClient.timeout.test.js` (mocks both a stalled connect
and a stalled mid-stream read, asserting each rejects instead of hanging).

**Separately, an earlier real bug found and fixed the same way**:
for a long reply (long enough to hit `ELEVENLABS_MAX_CHARS_PER_REPLY`, or really any reply
where TTS keeps up with or outpaces the LLM), the **last** audio chunk could be sent with
`isFinal: false` and stay that way forever — the frontend's "AIDA is speaking" state (which
the existing frontend keys off `isFinal`, per `docs/FRONTEND_PROMPTS.md` prompt 2) would
then never clear. Root cause: `isFinal` was computed as `seq === totalChunks - 1`, but
`totalChunks` was only known once `finish()` ran (i.e. once the LLM's full generation
resolved) — if TTS had already emitted every chunk *before* that point (very possible: the
character-budget cutoff makes this the common case for any long reply, since speech stops
well before the LLM finishes rambling on), the true last chunk went out with `totalChunks`
still `null`, and nothing ever went out afterward to correct it. Verified live: a
2800+ character reply produced 15 chunks, none marked final, and the turn's own internal
completion promise never resolved either (no `AIDA_LATENCY` line got logged for that turn
at all) — a completely silent failure mode. Fixed by holding back the tail chunk (the
one currently equal to `enqueuedCount - 1`) until the total is actually sealed — either
by `finish()` (normal completion) or by the character-budget cutoff itself (which now also
seals immediately, instead of only capping text with no matching cap on chunk emission,
which was itself also a separate, smaller gap this fix closed at the same time). Re-verified
live after the fix: the same kind of long reply now correctly ends with `isFinal: true` on
its actual last chunk, and the turn's completion promise resolves normally.

Socket.io wire format (event names/payload shape) is unchanged from before this upgrade
— `aida:voice-chunk` (`{ turnId, seq, isFinal, audioBase64, mimeType }`, tenant clients
get a per-user event name `aida:voice-chunk:<userId>`) and `aida:voice-error`
(`{ turnId, message }`).

**Correction — a frontend fix WAS required, found from live production testing**: this
section originally (and wrongly) claimed no frontend change was needed. The existing
frontend only ever set its `currentTurn` tracking variable from the `POST /chat` HTTP
response body — never from the first `aida:voice-chunk`/filler event itself. Streaming
means audio can now legitimately arrive over the socket BEFORE that HTTP response
returns (the response only completes once the ENTIRE LLM reply is done; audio starts as
soon as the first sentence does) — every chunk that arrived first was being silently
dropped as "turnId does not match the current turn," including the filler event, which
is why it looked like two separate bugs ("no audio on long replies," "filler never
plays") when it was one frontend bug. The exact required fix is
`docs/FRONTEND_PROMPTS.md` prompt 6 — the fix is a one-line adoption-rule change (accept
a chunk's turnId as the current turn if none is set yet, instead of only ever getting it
from the HTTP response).

**Realtime vs. expressive model split** (`src/aida/voice/speechDirectiveAdapter.js`):
`eleven_flash_v2_5`/`eleven_turbo_v2_5`-class models don't support ElevenLabs' `[laughs]`/
`[sighs]`-style bracket audio tags at realtime latency — only `voice_settings`
(stability/style) and pacing (speed) are available for expression, so that's all this
adapter uses while a realtime model is configured. Switching `ELEVENLABS_MODEL_ID` to a
`v3`-class model turns bracket-tag support on automatically (`isExpressiveTagModel()`
just regex-checks the model id) — nothing else in the pipeline needs to change.

**Known, accepted limitation**: per-sentence synthesis loses some of the cross-sentence
prosody one long synthesis call would have (this is *why* it's fast, not a bug to chase).
Also, `textChunker.js`'s abbreviation guard only catches single-word abbreviations
("Dr.", "vs.") — multi-letter ones with internal dots ("e.g.", "i.e.") still split at
their second dot, producing one harmless extra chunk boundary. The streaming chunker
additionally can't retroactively merge a very short trailing chunk into the sentence
before it (the earlier one may already be mid-flight to TTS) the way the batch splitter
does — in practice this means an occasional short standalone chunk like "Ok." instead
of it being folded into the previous sentence; harmless, just a marginally smaller chunk.

### Personality & emotion (`src/aida/personality.js`, `src/aida/responseDirector.js`)

`personality.js` is the one place AIDA's tone is defined — a baseline system-prompt line
(intelligent, calm, confident, warm, conversational, a little witty, curious,
emotionally aware, never excessively enthusiastic/robotic/repetitive) plus a small table
of emotions (`neutral`, `warm`, `happy`, `excited`, `curious`, `thoughtful`, `concerned`,
`empathetic`, `surprised`, `amused`, `serious`, `reassuring`, `frustrated`), each with an
energy level and a one-line delivery description.

`responseDirector.js` picks an emotion **deterministically from the user's message** —
keyword/regex rules (frustration → `frustrated`, "haha"/"lol" → `amused`, "wow"/"really?"
→ `surprised`, "thanks"/"it works" → `warm`, technical/why-questions → `thoughtful`, ...
default → `neutral`) — **not a second LLM call**. This was a deliberate choice: a
classifier call would add a full extra round trip to every voice turn's latency for a
signal that keyword rules already catch well enough for the common cases. The resulting
`SpeechDirective` (`{ emotion, delivery, energy, pacing, fillerCategory }`) feeds both the
filler selection (below) and `speechDirectiveAdapter.js`'s ElevenLabs `voice_settings`
tuning (higher energy → lower stability/higher style, within a conservative band — subtle
variation, not a different voice). `AIDA_EMOTION_ENABLED=false` keeps every turn at flat
neutral delivery without touching anything else.

**Also feeds the actual TEXT now, not just voice tuning** — the directive is computed for
EVERY turn (`routes/aida.js`'s `runConversationTurn`), including plain text chat, and
passed into `engine.buildSystemPrompt()`, which adds a line telling the model to let that
delivery come through in its own word choice (not to announce it). This matters because
voice tuning alone is inaudible if a user is testing via text, or if voice itself is
broken for another reason — text-visible personality shouldn't depend on voice working.

**Real, repeated problem found and fixed — near-identical generic openers**: across many
live test turns, master admin's "what can you do for me?"-style questions kept producing
near-verbatim openers ("Sure! Here's a quick overview of what I can help you with:" —
word for word, across unrelated conversations). The existing abstract "vary your
phrasing" instruction wasn't enough on its own. Fixed two ways in `engine.js`/
`personality.js`: (1) an explicit list of the specific overused phrases actually observed
(`personality.js`'s `OVERUSED_PHRASES`), told to the model as phrases to avoid by name —
naming the exact pattern works far better than an abstract instruction; (2) the system
prompt now includes the first few words of the assistant's OWN previous reply in this
conversation (from `history`) and explicitly tells it not to open the same way again.
Live-verified: 3 fresh sessions with the identical question now produced 3 genuinely
different openers ("As a Platform Master Admin, I can help you with a range of
activities...", "I can dive into various aspects of the OG Track platform...",
"Certainly! Here's a snapshot of what I can assist you with..."), and a same-conversation
follow-up question correctly did not repeat the first reply's opener.

**Real finding on latency + model choice — tested, not assumed**: measured `gpt-4o` vs
`gpt-4o-mini` time-to-first-token live, both with and without master admin's full tool
schema attached. Result: no reliable advantage either way (both landed in the same
600ms-1.6s range across repeated runs; the variance between runs of the SAME model was as
large as the difference between models). The dominant factor in the latency you'll see is
OpenAI API/network response-time jitter, not the model tier — switching models was not
implemented as a "fix" here because the data didn't support it actually being one; forcing
a change that doesn't reliably help would just trade real capability (tool-calling
reliability tends to be better on larger models) for a placebo. `AIDA_MODEL` remains fully
configurable via env var if you want to try a different model yourself with your own
traffic pattern — this finding is about THIS specific workload, not a universal claim.

### Filler engine (`src/aida/voice/fillerPhrases.js`)

Short lines AIDA can say instantly while a reply is still generating — each phrase is
synthesized once and cached in memory forever (no live API call in the critical path).
Organized by category (`thinking`, `acknowledgement`, `surprise`, `amusement`,
`empathy`) with several variants each so it isn't the exact same line every time;
`responseDirector.js`'s `fillerCategory` picks which pool to draw from. A per-session
cooldown (`AIDA_FILLER_COOLDOWN_MS`, default **6s** — see the tuning note below, keyed by
the per-user voice-chunk event name, i.e. persists for the whole session, not just one
conversation) stops AIDA from saying "hmm, let me check" on literally every single turn.

Timing: `POST /chat`/`POST /voice-input` generate `turnId` before calling the LLM and
race a `setTimeout` (`AIDA_FILLER_DELAY_MS`, default **400ms** — see below, same value the
older `AIDA_VOICE_FILLER_DELAY_MS` name still works as a fallback for) against it — but as
of streaming, the timer is now cleared the instant the **first real speech chunk starts
synthesizing** (`voiceSession.createStreamingSpeaker`'s `onFirstChunkReady` hook), not
just when the full reply finishes — so a filler no longer plays needlessly once real
audio is already on its way, even if the full reply is still being generated.
`AIDA_FILLER_ENABLED=false` disables this system entirely.

**Fixed: the filler's clock now starts before transcription, not after, for voice
input.** `POST /voice-input`'s reply pipeline used to only start the filler-delay timer
AFTER Whisper/STT transcription finished — meaning the entire STT round trip (a real,
separate network call) was dead air no filler could mask, on top of whatever the LLM
then took. The turn (and its filler clock) now starts the instant the recording arrives;
`runConversationTurn` accepts an optional pre-created `{ turnId, target, timer,
controller, fillerTimer }` for exactly this (see `pre` in `routes/aida.js`) so the
filler can fire while STT is still running. Since the transcript isn't known yet at that
point, this early filler always uses the generic `thinking` category rather than one
classified from the message content.

**Fixed: cold-cache latency on the very first filler.** Each phrase is normally
synthesized once and cached forever — but on a freshly started server, the very FIRST
time any given phrase was used, it still needed a live ElevenLabs round trip (measured
live: ~500-1200ms on top of the timer firing), which meant the first real user's first
filler wasn't actually instant. `warmFillerCache()` now pre-synthesizes all filler
phrases (all categories) at server startup — best-effort, never blocks boot — so every
filler is already cached before any real user ever triggers one. Bounded to the same
concurrency cap as normal chunk synthesis (`ELEVENLABS_MAX_CONCURRENT_CHUNKS`) — firing
all ~18 phrases at once during an early version of this fix blew straight through
ElevenLabs' real concurrent-request limit (8/18 failed); bounding it fixed that
completely (verified live, 18/18 succeed).

**Fillers now use ElevenLabs v3 with real audio tags — the live reply still doesn't.**
Phrases were rewritten with natural hesitation ("Ummmmm, let me check on that...") and,
sparingly (at most one per phrase), a v3 bracket audio tag (`[sighs]`, `[gasps]`,
`[laughs softly]`). This works specifically because fillers are pre-cached — synthesized
once at startup or on first use, never on the live-reply critical path — so the
~5.4x slower generation time (measured live: v3 ~1.7s vs. the realtime model's ~0.3s per
phrase) costs nothing in real turn latency. `ELEVENLABS_FILLER_MODEL_ID` (default
`eleven_v3`) controls this independently of `ELEVENLABS_MODEL_ID` (the live-reply model,
unchanged, still a realtime model — do NOT point the live reply at v3, see "Realtime vs.
expressive model split" above for why). If `ELEVENLABS_FILLER_MODEL_ID` is ever pointed
at a non-tag-capable model, `stripBracketTags()` removes the `[...]` markers before
synthesis so they're never read aloud as literal text.

**The `thinking` category has 55 variants** (up from an initial 5) specifically because
it's the one category the frontend's local instant-playback (below) can use — at
record-stop time the transcript isn't known yet, so only a generic "thinking" reaction
is possible, and with 55 to rotate through it doesn't feel like the same clip every
time even across a long session. The other categories (`acknowledgement`, `surprise`,
`amusement`, `empathy`) stay smaller since they're only ever selected server-side, after
the message is classified.

**New: pre-generated static filler audio files for zero-latency LOCAL playback**
(`public/aida-fillers/`, served via `GET /aida-fillers/manifest.json` +
`GET /aida-fillers/<category>/<n>.mp3`, wired in `server.js`). Even the earliest
possible SERVER-triggered filler still needs the recording to finish uploading and reach
the server first — it can never be instant. These static files let the frontend play a
"thinking" reaction **locally, from a cached file, the instant recording stops**, before
the upload even begins — genuinely zero network latency. Generated by
`scripts/generate-aida-fillers.js` (`node scripts/generate-aida-fillers.js`) from the
same `FILLERS_BY_CATEGORY` phrases and `ELEVENLABS_FILLER_MODEL_ID` — re-run it if either
ever changes; makes real ElevenLabs calls, so it needs `ELEVENLABS_API_KEY`/
`ELEVENLABS_VOICE_ID` configured. This is additive — the existing
server-emitted filler (over the socket) still exists as the general-purpose/fallback
mechanism; the frontend fix to actually use these files and avoid a double-filler is
`docs/FRONTEND_PROMPTS.md` prompt 7 (required for the "instant, before anything else"
effect — not yet applied without it).

**Tuning finding from real usage** (both defaults changed from their initial ship
values): first-token time alone measured live at 1100-2400ms — well past the original
1200ms filler threshold and the 20s cooldown, so in practice fillers were mostly losing
the race or getting suppressed by the cooldown, which read as "no filler ever plays."
`AIDA_FILLER_DELAY_MS` dropped to 400ms (the filler now reliably wins the race and plays
on nearly every turn — matching the upgrade brief's actual intent: something audible
almost immediately, not a long silence gated on a mostly-theoretical "only if slow"
threshold) and `AIDA_FILLER_COOLDOWN_MS` dropped to 6s (so a normal-paced back-and-forth
conversation still hears one occasionally, not just the very first turn of a session).
Live-verified across 3 back-to-back turns: turn 1 (fresh session) played a filler, turn 2
(immediately after, inside the cooldown) correctly did not, turn 3 (7s later, past the
cooldown) played one again.

### Interruption / barge-in (`src/aida/voice/voiceSession.js`)

`POST /aida/voice-cancel` (`{ turnId }`) marks a turn cancelled and — new as of this
upgrade — aborts a **shared `AbortController`** for that turn
(`createTurnController`/`getTurnSignal`), passed into both the LLM stream call
(`engine.runTurnStream`'s `signal`) and every ElevenLabs fetch for that turn. Previously
this could only stop further audio *emission*; it could not touch an in-flight LLM call.
Now it genuinely stops generation on both sides.

**Live-verified**: interrupted a real streaming reply 3 tokens in (~1.5s into a
multi-sentence answer) — the LLM's returned text was itself truncated mid-word ("A CRM
(Customer"), confirming the abort actually cut the network stream, not just discarded
output after the fact; zero ElevenLabs calls were made for the interrupted portion (no
sentence boundary had completed yet); and `result.interrupted === true` was reported
correctly. One implementation finding from that test: the OpenAI Node SDK doesn't always
surface an aborted stream as a thrown `AbortError` — sometimes it just ends the
iteration early with truncated content instead — so both provider adapters explicitly
check `signal.aborted` after the loop as well as catching the exception, rather than
relying on the exception alone.

`AIDA_INTERRUPTION_ENABLED=false` makes `POST /voice-cancel` a no-op (audio keeps
playing/generating) without touching anything else. With `AIDA_STREAMING_ENABLED=false`
(legacy path), barge-in still stops further audio emission the same way it always did,
but cannot abort the single blocking (non-streaming) LLM call already in flight — same
documented limitation as before this upgrade.

### Latency instrumentation (`src/aida/latency.js`)

Every voice turn logs one `AIDA_LATENCY {...}` JSON line with `llm_first_chunk_ms`,
`llm_total_ms`, `tts_first_chunk_sent_ms`, `tts_first_audio_ms`,
`end_to_end_first_audio_ms`, `total_response_ms`, `total_audio_ms`, `total_turn_ms` — see
the "Live-verified" numbers above for a real example. Set `AIDA_DEBUG_LATENCY=true` for
an additional verbose line per individual mark as it's hit (useful when diagnosing where
a specific turn's time went; noisy for normal operation, hence off by default). Never
logs API keys, tokens, or conversation content — only turn ids and millisecond timings.

**Measured, real, NOT yet acted on — master admin pays a real latency tax on every
single turn**: master admin's context sends **33 tool schemas (~18KB / ~4,500+ tokens)**
to the LLM on every message, regardless of whether the question needs any tool at all
(a fully-loaded tenant sends ~21, ~6KB). This is the full cross-tenant tool list
(`masteradminCrossTenant.js` wraps every readable tenant tool automatically) plus master
admin's own tools, and it's a real, measured contributor to first-token latency — every
master-admin screenshot tested during this upgrade showed the worst latency numbers,
which lines up. Not changed here because reducing it means either trimming tool
descriptions (small win) or being more selective about which tools get attached per turn
(bigger win, but a functional trade-off against "master admin can always call anything" —
worth a deliberate decision, not a silent change).

### Rollback

Every part of this upgrade is behind an env var that reverts to the previously-shipped
behavior with no code change: `AIDA_STREAMING_ENABLED=false` (back to the original
wait-then-speak pipeline), `AIDA_FILLER_ENABLED=false`, `AIDA_EMOTION_ENABLED=false`,
`AIDA_INTERRUPTION_ENABLED=false`. The legacy code paths (`engine.runTurn`,
`voiceSession.speakReply`) were left in place unmodified (aside from adding the same TTS
text-cleaning pass streaming gets) specifically so flipping these flags is a genuine,
low-risk way back to known-good behavior, not just a theoretical one.

### Automated tests (`test/`)

`npm test` runs Node's built-in test runner (`node --test`, no new dependency) over the
pure-logic pieces of the voice upgrade: the incremental streaming chunker (matches the
batch splitter's output for equivalent inputs; decimals/abbreviations/force-flush edge
cases; empty/very-short replies), the response director's emotion classification and its
neutral-fallback safety net, the filler cooldown/variety logic, the TTS text cleaner
(markdown/code/link stripping), and the master-admin cross-tenant token-minting fix (decodes
the real minted JWT and asserts it passes `attendance.js`'s actual scoping check). These
don't need network access or credentials, so they run anywhere. What's **not** covered by an automated test — because it needs a real
OpenAI/ElevenLabs round trip and this repo has no HTTP/SDK mocking library — is the live
streaming pipeline, real interruption, and provider fallback-on-error; those were instead
verified directly against the real APIs during development (see the "Live-verified"
callouts above) rather than left as an untested claim. If you want these as permanent
regression tests, the missing piece is a way to stub `fetch`/the OpenAI SDK client —
worth adding if this pipeline gets touched often.

### Voice UX tuning — personality prompt limitation (still applies)

`engine.js`'s system prompt asks the model to vary its phrasing rather than reuse the
same stock line every time. **Honest finding from before this upgrade, still true**:
this measurably helps but doesn't fully fix it — 4 fresh sessions each saying "hi"
produced 3 distinct openers ("Hi there!", "Hello!", "Hello there!"), but all four still
ended with the identical tail phrase "How can I assist you today?" Prompting is
guidance, not a hard constraint — same class of limitation as the tool-calling
reliability note earlier in this doc, not something a bigger prompt tweak can fully
guarantee.

### Voice input — `POST /aida/voice-input` (speech in, not just speech out)

Mirrors `POST /chat`, but the "message" is a recorded audio clip instead of typed
text — for talking to AIDA instead of typing. `multipart/form-data`: `audio` (the
recorded blob) + `pageContext` (a JSON-encoded string — parsed server-side into the
same shape `/chat`'s `pageContext` already is). Transcribes the audio via OpenAI's
Whisper API (`src/aida/voice/speechToText.js`), then feeds the transcript into the
**exact same** `runConversationTurn`/`sessionMemory` path `/chat` uses (`src/routes/aida.js`,
streaming-aware exactly like `/chat`) — no separate reply logic exists, so tool-calling,
session memory, and every tool all behave identically
regardless of whether the input was typed or spoken. Triggers the same ElevenLabs
voice-reply pipeline via the same `turnId` convention as `/chat`'s `voice: true` path,
so existing voice-chunk handling on the frontend needs no special-casing for this route.

Verified end-to-end with real audio (self-generated via the ElevenLabs client, so no
external sample was needed): upload → real Whisper transcript → the reply engine
actually called a real tool (`hr_get_employees`) → a real voice chunk arrived over
the socket tagged with the exact same `turnId` as the HTTP response.

Response: `{ transcript, reply, turnId, toolCalls }`. Reuses `OPENAI_API_KEY` directly
for transcription (`config.aida.speechToText`, independent of whichever provider
`AIDA_PROVIDER` selects for chat generation — this is OpenAI-specific either way).
Optional: `AIDA_STT_MODEL`.

**Real latency win, measured and switched**: default changed from `whisper-1` to
`gpt-4o-mini-transcribe`. Measured live (a self-generated sample clip, repeated calls
against the real API, same trick used elsewhere in this doc): `gpt-4o-mini-transcribe`
averaged ~930ms vs. `whisper-1`'s ~2100ms — **more than 2x faster** — with identical
transcription output in testing. This directly shortens the STT step for every voice
INPUT turn, unconditionally (no trade-off found in testing; same endpoint, same request
shape, just a different `model` field). `gpt-4o-transcribe` (the non-mini variant) also
beat whisper-1 but was slower than the mini version (~1.5s average) — mini is the better
default for latency. Set `AIDA_STT_MODEL=whisper-1` to revert if needed.

Errors are always JSON, never an HTML fallback page: `503` if speech-to-text isn't
configured (missing `OPENAI_API_KEY`) or if AIDA overall isn't enabled (existing
`config.aida.enabled` check, inherited automatically since this route lives on the
same router as `/chat`), `401` for the existing auth failures, `400` for a missing
`audio` field, a malformed `pageContext`, an unreadable recording, or a multer upload
error (oversized file, malformed multipart — caught explicitly so it never falls
through to a generic 500).

**Known limitation, found during testing, not a bug**: Whisper mis-transcribed the
tenant name "Cajo" as "Kayo" in testing (an uncommon proper noun, phonetically
ambiguous) — harmless here because tenant identity comes from the URL slug/JWT, never
from parsing company names out of speech, so the reply was still correct. Don't expect
perfect transcription of unusual proper nouns; this is an inherent STT accuracy
limit, not something this endpoint can control.

### Master admin dashboard summary (`GET /api/masteradmin/dashboard/summary`)

One call returns everything a real dashboard needs — company counts (total/active/
suspended), module adoption across all companies, companies-created-per-month for the
last 12 months, provisioning health (success/failed/pending in the last 30 days, from
the existing `provisioning_log` table), a pending-approvals count (same cross-tenant
loop `GET /pending-users` already uses, just counting), and a "this month" summary.
Deliberately does **not** include AI/token usage yet — that's the separate, still-
deferred `aida_usage_log` feature in `docs/AIDA_PART2_PLAN.md`; add it as a card here
once that table actually exists, don't build a usage table as a side effect of this.

## Not built yet (next phases)

- Automated provisioning (so masteradmin "create company" runs the CREATE DATABASE +
  schema scripts + OGCore insert automatically instead of by hand)
- File upload endpoint (needs an Azure Blob Storage decision vs the old local-disk approach)
- Frontend split
- Data migration from the old Firestore export (optional, if you want existing data carried over)
