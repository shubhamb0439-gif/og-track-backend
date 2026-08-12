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

### Voice — ElevenLabs TTS (`src/aida/voice/`)

Speaks AIDA's replies aloud when a chat request includes `voice: true`. Text generation
stays exactly as before (`engine.js`/`providers/*.js` are untouched) — the **already
complete** reply is split into sentence-sized chunks (`textChunker.js`), each chunk is
sent to ElevenLabs' streaming TTS endpoint (`elevenLabsClient.js`, `eleven_flash_v2_5`
by default), and the resulting audio is pushed to the browser over the **same socket.io
connection/room** every other real-time event in this app already uses — no new
transport. `voiceSession.js` pipelines chunk synthesis with bounded concurrency but
always emits to the client in strict original order, even if a later sentence's network
round trip finishes first (verified with a mocked ElevenLabs client and an artificially
slow first chunk — see git history for the test script).

This is entirely additive and fires-and-forgets from `POST /chat` — it never blocks or
affects the text response, and a request with `voice: true` when
`ELEVENLABS_API_KEY`/`ELEVENLABS_VOICE_ID` aren't set just silently stays text-only
(verified: no error, no hang, no `turnId` in the response).

Env vars:
```
ELEVENLABS_API_KEY=...                      # required — voice stays off without it
ELEVENLABS_VOICE_ID=...                     # required — no default voice
ELEVENLABS_MODEL_ID=eleven_flash_v2_5       # optional, this default
ELEVENLABS_OUTPUT_FORMAT=mp3_44100_128      # optional, this default
ELEVENLABS_MAX_CONCURRENT_CHUNKS=2          # optional, this default
ELEVENLABS_MAX_CHARS_PER_REPLY=2000         # optional — cost guardrail; full text is
                                             # always still shown even if speech is cut
```

Socket.io events a client should listen for once it has `voice: true` and has joined
its usual room: `aida:voice-chunk` (`{ turnId, seq, isFinal, audioBase64, mimeType }`,
tenant clients get a per-user event name `aida:voice-chunk:<userId>` since a tenant's
room is shared by all its users) and `aida:voice-error` (`{ turnId, message }`) — on
error, drop any "speaking" UI state; the text reply already arrived regardless of
whether speech synthesis succeeds.

**Known, accepted limitation**: per-sentence synthesis loses some of the cross-sentence
prosody one long synthesis call would have (this is *why* it's fast, not a bug to chase).
Also, `textChunker.js`'s abbreviation guard only catches single-word abbreviations
("Dr.", "vs.") — multi-letter ones with internal dots ("e.g.", "i.e.") still split at
their second dot, producing one harmless extra chunk boundary.

### Voice input — `POST /aida/voice-input` (speech in, not just speech out)

Mirrors `POST /chat`, but the "message" is a recorded audio clip instead of typed
text — for talking to AIDA instead of typing. `multipart/form-data`: `audio` (the
recorded blob) + `pageContext` (a JSON-encoded string — parsed server-side into the
same shape `/chat`'s `pageContext` already is). Transcribes the audio via OpenAI's
Whisper API (`src/aida/voice/speechToText.js`), then feeds the transcript into the
**exact same** `runTurn()`/`sessionMemory` path `/chat` uses — no separate reply
logic exists, so tool-calling, session memory, and every tool all behave identically
regardless of whether the input was typed or spoken. Triggers the same ElevenLabs
voice-reply pipeline via the same `turnId` convention as `/chat`'s `voice: true` path,
so existing voice-chunk handling on the frontend needs no special-casing for this route.

Verified end-to-end with real audio (self-generated via the ElevenLabs client, so no
external sample was needed): upload → real Whisper transcript → the reply engine
actually called a real tool (`hr_get_employees`) → a real voice chunk arrived over
the socket tagged with the exact same `turnId` as the HTTP response.

Response: `{ transcript, reply, turnId, toolCalls }`. Reuses `OPENAI_API_KEY` directly
for Whisper (`config.aida.speechToText`, independent of whichever provider
`AIDA_PROVIDER` selects for chat generation — Whisper is OpenAI-specific either way).
Optional: `AIDA_STT_MODEL` (defaults to `whisper-1`).

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
