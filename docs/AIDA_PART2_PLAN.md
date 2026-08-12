# AIDA Part 2 — Deferred Plan (Autonomous Project Creation, Live Preview, AI Usage Tracking)

**Status: NOT started. Nothing in this document has been built.**

This is a reference document, written to be picked up later — after other changes
you're making yourself land in the codebase first. It assumes no memory of the
conversation that produced it: read it standalone.

It builds on the original AIDA power-tier plan (Parts 1-3: coding/DevOps agent,
autonomous project creation, master-admin full data access), specifically expanding
**Part 2 — Autonomous Project Creation & Azure Deployment** with two things that were
missing from the first pass, plus one unrelated but explicitly requested addition
(AI usage/token tracking). Phases already shipped before this document existed:

- Master admin cross-tenant **read** (`src/aida/tools/masteradminCrossTenant.js`)
- The async job model + approval-gate machinery (`src/aida/jobs/`)
- Lightweight, no-sandbox repo diagnosis (`dev_repo_diagnose` / `src/aida/jobs/jobKinds/devDiagnose.js`)

Everything below is new, unbuilt work.

---

## 1. Human approval — confirmed, unchanged from the original plan

Every destructive/hard-to-reverse step in Part 1 and Part 2 stays gated behind an
explicit human approval, exactly as originally designed:

- Push a branch / open a PR — gated
- Merge to main (triggers the existing GitHub→Azure auto-deploy) — gated, separately from push
- Provision a real Azure SQL database — gated (costs money, not cleanly reversible)
- Create a new GitHub repo / push generated code — gated
- Wire CI/CD + configure deploy secrets — gated
- Trigger the actual deploy — gated, separately from the push-code step

**No fully unattended merge/deploy/migration, ever** — this is a standing rule, not
something to revisit per-feature.

### Open question not yet answered: does anything trigger diagnosis automatically?

Today (and in everything planned so far), a job only ever starts because a human
typed a chat message asking for one. "Auto-update" framing implies something should
run diagnosis **on its own schedule** (nightly/weekly) without a human prompting it.
That is a small, distinct addition (a cron-style trigger that enqueues a
`dev_diagnose` job periodically) — **not yet decided**, and not implied by anything
already built. Decide before building:
- Should this exist at all, or should diagnosis always be human-initiated?
- If yes: what cadence, and does a scheduled run still land in the approval-gate
  flow the same way a chat-initiated one does (it should — no reason for a
  scheduled fix to skip the same gates a manual one requires)?

---

## 2. Part 2 pipeline (recap, unchanged from the original plan)

New app ≠ new OG Track tenant. A generated app is a genuinely separate application
that only shares Azure infra *conveniences* with OG Track — never runtime, tables,
or credentials:

- **Database**: a brand-new, isolated Azure SQL database on the existing logical
  server (same low-level mechanism `src/utils/provisioning.js` already uses for
  `CREATE DATABASE`) — own login, not inserted into OGCore's `companies` table, no
  `enabled_modules` concept.
- **Backend**: its own new Express/Node app in its own new GitHub repo — not routed
  through `og-track-backend`'s router, not sharing its process/memory.
- **Deploy**: copies the proven pattern from `.github/workflows/main_og-track-backend.yml`
  (build → `azure/webapps-deploy`) for the new app's own Web App, plus Azure Static
  Web Apps for its frontend — reusing the *pattern*, not the *running instance*.

Pipeline steps:
1. Understand the spec → propose an architecture (plain chat, no job, no gate).
2. Scaffold the app inside a sandbox — **no gate** (nothing has left the sandbox yet).
3. Provision the isolated database — **gated**.
4. Create the GitHub repo, push the scaffolded code — **gated**.
5. Wire CI/CD, configure deploy secrets via Key Vault — **gated**.
6. Trigger the actual deploy — **gated**, kept separate from step 4's push.
7. Validate + report status back in chat.

---

## 3. NEW: Live preview (the gap identified in this pass)

Container Apps **Jobs** (the primitive Part 1's sandbox uses) run once and exit —
they cannot stay up to serve a live, clickable preview. Live preview needs a
different Azure primitive:

- A regular **Azure Container App** (not a Job) per in-progress project draft. It
  stays running and gets a real URL (Azure auto-generates one, e.g.
  `https://<preview-id>.<region>.azurecontainerapps.io`).
- **Same network isolation as the diagnose/fix sandbox** — no access to production
  DB, no access to Key Vault, no access to any real tenant data. This is not
  negotiable just because it's "only a preview."
- **Auto-expires** after a period of inactivity (suggested default: 30-60 minutes)
  so a forgotten preview doesn't quietly accrue cost. Needs its own cleanup job
  (a scheduled sweep, or an idle-timeout mechanism on the Container App itself).
- **Updated in place across iterations**: when the user says "make the button
  blue," AIDA updates the *same* running preview container — the URL stays stable
  across a whole editing session, not a new link per change.
- Still **ungated** — matches the existing "scaffold + run in sandbox = no approval
  needed" principle. Gates only start at step 3 (provisioning a real database) and
  beyond, i.e. the point where "just show me a preview" becomes "make this a real,
  persistent, billable thing."

### Build pieces needed (none exist yet)
- A way to provision/deprovision a per-draft Container App (Azure SDK/CLI calls
  from the trusted backend process, not from inside any sandboxed job).
- A "preview session" concept — something needs to track which draft maps to
  which running Container App, and its idle timer. Likely a new column/table
  alongside `aida_jobs` (e.g. `preview_container_url`, `preview_expires_at`) rather
  than a wholly separate table — revisit shape when actually building this.
- The in-place-update mechanism: redeploying new code to the same Container App
  without changing its URL (Container Apps supports revision-based updates —
  research whether a new revision or an in-place image update fits better once
  this is actually being built).

---

## 4. NEW: AI usage / token tracking, per tenant slug and per user

Unrelated to Part 2's app-building goal, but requested alongside it — track how
much LLM usage (tokens, therefore cost) is being consumed, broken down by company
and by individual user.

### Data model
New OGCore table, `aida_usage_log` — one row per underlying LLM API call (not per
chat turn: a single chat turn can call the model multiple times via the tool-use
loop, so logging per-call and aggregating at query time is more accurate than
trying to log once per turn):

```sql
CREATE TABLE dbo.aida_usage_log (
    id              NVARCHAR(64)   NOT NULL PRIMARY KEY,
    tenant_slug     NVARCHAR(100)  NULL,      -- NULL for masteradmin-initiated calls
    user_id         NVARCHAR(64)   NOT NULL,
    provider        NVARCHAR(20)   NOT NULL,  -- 'anthropic' | 'openai'
    model           NVARCHAR(100)  NOT NULL,
    input_tokens    INT            NOT NULL,
    output_tokens   INT            NOT NULL,
    created_at      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
);
```
(Follow the same idempotent-migration-file convention as
`ogtrack-sql-schema/core/01_platform_core.sql` — this would be `02_usage_log.sql`
or similar, in the same folder.)

### Where to record it
Both Anthropic's and OpenAI's API responses already include exact token counts
(`response.usage` for both, just shaped slightly differently) — record right after
every call:
- `src/aida/providers/anthropic.js` and `src/aida/providers/openai.js` — the main
  chat tool-use loop, once per iteration (a single chat turn may log more than
  one row if the tool-use loop iterates more than once).
- `src/aida/jobs/reportLLM.js` — the diagnosis job's plain completion call, a
  separate code path from the chat engine, easy to forget when building this.

### Query/reporting layer
- A new masteradmin-only endpoint, e.g. `GET /api/masteradmin/aida/usage?slug=cajo&from=...&to=...`
  returning aggregated totals (and a breakdown by user/day/model).
- Probably also an AIDA tool (`masteradmin_get_ai_usage(companySlug, from, to)`),
  consistent with how every other capability in this codebase is exposed both as
  a REST endpoint and as a chat-callable tool.

### Open question not yet answered: who can see it?
- **Master-admin-only** (look up any company by slug) matches the existing
  cross-tenant tool pattern (`masteradminCrossTenant.js`) most directly.
- Alternatively, each **tenant's own superadmin** could also see their own
  company's usage without needing master-admin access — a different, additive
  access-control surface, not yet designed.
- Decide this before building the query endpoint's auth — it changes which
  route(s)/auth middleware this lives behind.

---

## What to do when picking this back up

1. Re-read the original AIDA power-tier plan (Parts 1-3) for full context on the
   job model, sandbox, and approval-gate machinery this builds on.
2. Resolve the two open questions above (scheduled auto-diagnosis: yes/no + cadence;
   usage-tracking visibility: masteradmin-only vs also tenant self-view) before
   writing any code — both change the shape of what gets built.
3. Confirm the Azure resources this needs (Container Apps Environment with locked-
   down egress, Container Registry, Key Vault, a write-scoped GitHub App or PAT)
   are provisioned — none of Part 2 or live preview can be built without them, and
   provisioning them requires your Azure/GitHub access, not something done from
   inside a coding session.
