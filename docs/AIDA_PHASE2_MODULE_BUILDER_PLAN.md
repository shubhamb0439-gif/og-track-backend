# AIDA Phase 2 — On-Demand Module Builder (Plan)

**Status: built, not yet live-tested end to end** — every code path exists and follows
the same "sandbox → agent → PR → human approval" shape phase 1 already proved live, but
this has NOT yet been run against real repos/a real staging database the way phase 1 was
(see `docs/AIDA_PHASE1_SELF_FIX_PLAN.md` for that precedent). The pieces that still need
real credentials before a first live run are listed under "What's needed to go live"
below.

Written to be read standalone — assumes no memory of the conversation that produced it.

---

## What this actually does, end to end

1. Master admin says something like *"Hey AIDA, create me a module called Attendance:
   [feature list]"* in chat. This calls the `create_module` tool
   (`src/aida/tools/devops.js`), which starts a `create_module` job.
2. The job clones BOTH the backend repo and the frontend repo into two disposable
   sandboxes (sibling temp directories, same branch name in both —
   `src/aida/jobs/jobKinds/createModule.js`).
3. A single dual-repo coding-agent session (`src/aida/codingAgent/providers/moduleBuilder.js`)
   writes the new backend route + SQL schema file, and the new frontend screens/API calls,
   keeping both sides consistent. Every file tool takes an explicit `repo: "backend" |
   "frontend"` argument.
4. Every write is checked against `src/aida/codingAgent/moduleGuardrails.js` before it
   touches disk (see "The guardrail" below) — this is enforced in code, not just prompt
   instruction.
5. If the agent produced real changes, the job pushes a branch and opens a PR in
   whichever repo(s) changed, then boots BOTH sandboxes as a live pair of running
   processes (`src/aida/codingAgent/preview.js`) against one shared, persistent staging
   database — so master admin gets an actual clickable preview link, not just a diff.
6. The job lands in `awaiting_approval` with both PR links and both preview URLs — same
   "AIDA Job" panel phase 1 already built, extended (see `docs/FRONTEND_PROMPTS.md`) to
   show a second PR and the preview links for a `create_module` job.
7. Approve → merges BOTH PRs (existing CI/CD on both repos takes it from there — already
   confirmed the frontend auto-deploys on merge, same as the backend). Reject → closes
   both PRs, no merge. Either way, the preview processes are killed and the sandboxes
   deleted right after (`resume`/`onReject` in `createModule.js`).

---

## The guardrail: "new files only"

Phase 1's agent only ever fixed bugs in an existing, already-human-reviewed codebase —
worst case, a bad PR. This agent creates whole new surface area across two repos from a
single chat instruction, so the blast radius needed a hard boundary, not just a prompt
instruction an LLM could ignore under pressure. The rule, enforced in
`moduleGuardrails.js` and checked on every single `write_file` call:

- The agent may only **create new files**. Writing to any file that existed before the
  task started is refused with an error the agent sees as its own tool result.
- The one exception: a short, explicitly-named list of **insert-only** files
  (`config.aida.moduleBuilder.insertOnlyFiles`) the agent may add lines to — but a write
  is refused if it would change or remove even one line that was already there. Today
  that's `src/server.js` (the new route's `require` + `app.use(...)` line) and
  `src/utils/provisioning.js` (one new `MODULE_TO_SCRIPT` entry). Frontend: `index.html` (the
  in-page view wiring — see below) and `masteradmin.html` (one new `ALL_MODULES` checkbox
  entry, so a company can actually have the module enabled) — both confirmed live, the
  agent adds its own lines there itself, no manual step needed for either anymore.
- Any `.sql` file is scanned for destructive statements (`DROP`/`TRUNCATE`/destructive
  `ALTER`) and refused if found — module schema files must be additive-only, matching how
  `src/utils/provisioning.js`'s existing script-runner is designed to be safely re-run.

## The live preview

- One fixed, persistent Azure SQL staging database (`config.aida.moduleBuilder.stagingDb`)
  — never a real tenant's. Every preview points at the same one; a module's own new SQL
  script is what actually creates its tables there, the same script that later runs
  against a real tenant DB, so a preview doubles as a rehearsal of that script.
- Preview processes run on the same server as the backend itself, reachable only on the
  local network — nothing new opened to the public internet for this.
- **The backend preview binds to a FIXED port (3000 by default), not a dynamic one.**
  Confirmed: the frontend (plain static HTML, no build step — `serve.js` just serves it
  as-is) has no API-base-URL env var at all; its inline script hardcodes
  `http://localhost:3000` whenever it detects it's being viewed from `localhost`. So the
  backend preview has to actually be on that exact port for a frontend preview to reach
  it. Only the frontend gets a dynamically picked free port, via `FRONTEND_PORT` (confirmed
  env var `serve.js` already reads).
  - **Consequence 1**: only ONE `create_module` preview can run at a time (`preview.js`
    refuses to start a second one while one is active) — acceptable for a first version
    given this is already a human-approval-gated, one-at-a-time review flow.
  - **Consequence 2**: a preview will fail to boot if anything else is already bound to
    port 3000 on that machine — most likely your own local dev backend, if you happen to
    have `npm run dev`/`npm start` running locally at the same time. Stop it first before
    reviewing a module preview.
- **Known limitation**: preview processes are plain child processes with no persistence
  of their own. If the main backend process restarts while a `create_module` job is sitting
  in `awaiting_approval`, its preview dies and its sandbox directories become orphaned
  (the job's own record survives, but the running preview does not) — there's no reaper
  for this yet. Acceptable for a first version; revisit if it becomes a real problem.

## What's needed to go live

Same shape as phase 1's GitHub-token handoff — these are real values only a human can
provide, set as env vars, no code change needed once they exist:

- `AIDA_MODULE_BACKEND_REPO` / `AIDA_MODULE_FRONTEND_REPO` — `"owner/repo"` for each.
  `AIDA_CODING_AGENT_GITHUB_TOKEN` (already set for phase 1) needs its fine-grained PAT's
  repository list expanded to include the frontend repo too (same token, wider scope — no
  new token needed).
- `AIDA_STAGING_SQL_DATABASE` — just a database NAME. Server/user/password default to the
  same `AZURE_SQL_SERVER`/`USER`/`PASSWORD` already configured for the real app (override
  with `AIDA_STAGING_SQL_SERVER`/`USER`/`PASSWORD` only if staging should live somewhere
  else). Run `node scripts/provisionStagingDb.js` once this is set — it creates the
  database (serverless tier), runs the companies schema
  (`ogtrack-sql-schema/core/00_platform_core_companies.sql`, added this phase to close a
  gap where that table existed in real OGCore but had no tracked DDL) plus every tenant
  module's schema, and seeds one company (every module enabled) and one login
  (`AIDA_STAGING_ADMIN_EMAIL`/`AIDA_STAGING_ADMIN_PASSWORD`, sensible defaults if unset).
  Safe to re-run any time.
- `AIDA_MODULE_FRONTEND_START_CMD` — confirmed, defaults to `"node serve.js"`.
  `AIDA_MODULE_FRONTEND_PORT_ENV_VAR` — confirmed, defaults to `"FRONTEND_PORT"`. No API
  base URL env var exists or is needed (see "The live preview" above).
- Optionally, once confirmed: `AIDA_MODULE_FRONTEND_INSERT_ONLY_FILES` (comma-separated),
  naming the frontend's own route/nav registration file(s), to let the agent wire up
  navigation itself instead of leaving it as a manual step every time.

## Provider: OpenAI or Anthropic

Same switch as phase 1 — `AIDA_CODING_AGENT_PROVIDER` (`openai` | `anthropic`) picks which
coding-agent implementation runs, for BOTH phase 1 (`devFix.js`) and phase 2
(`createModule.js`) together, purely via env var: `providers/anthropic.js` /
`providers/anthropicModuleBuilder.js` are the Anthropic equivalents of
`providers/openai.js` / `providers/moduleBuilder.js` — same tool set/rules/guardrail
enforcement, just Anthropic's tool_use wire format. Both provider paths load correctly;
not yet live-tested against a real task on either provider.
