# AIDA Phase 1 — Weekly Self-Diagnose-and-Fix (Plan)

**Status: design confirmed through conversation, nothing built yet.** This is the first
phase of the broader "AIDA power-tier" coding-agent vision (see
`docs/AIDA_PART2_PLAN.md` for phases 2/3 — on-demand module creation, and building whole
new client systems). Phase 1 is deliberately the *safest* place to prove the underlying
"AIDA writes code, tests it, a human approves it" loop actually works, before trusting it
with anything higher-stakes: it operates on an already-understood codebase with an
existing test suite as a safety net, not greenfield code for a paying client.

Written to be read standalone — assumes no memory of the conversation that produced it.

---

## What this actually does, end to end

1. A trigger starts the job — either the weekly schedule (Saturdays, 8pm IST — pending
   timezone confirmation) or master admin asking for one on demand in chat (same
   underlying job kind, two ways to start it).
2. AIDA clones the repo into an isolated workspace, runs diagnosis (already-built
   behavior, see `dev_repo_diagnose`), and — new — attempts an actual fix using a
   dedicated coding-agent loop (read file / write file / run tests / iterate).
3. AIDA commits the fix to a **new branch**, pushes it, and **opens a PR against
   `main`**.
4. GitHub Actions CI runs automatically against that PR (needs a workflow change — see
   below; today CI only runs on push to `main`, not on PRs at all).
5. The job shows up as `awaiting_approval` behind a **new "AIDA Job" button**, added to
   the existing long-press-the-center-logo quick-action menu on the master-admin AIDA
   page (not a brand-new page — an addition to an existing, already-built UI surface).
   Opens a panel showing: AIDA's plain-language summary of what it found and fixed, a
   link to the PR, and the CI result.
6. A human reviews the **actual diff on GitHub** (full line-by-line diff, CI checks,
   comments — GitHub's own PR review UI; OG Track does not build a custom diff viewer)
   and clicks **Approve** or **Reject** in that panel.
7. Approve → merges the PR → the *existing* deploy workflow takes over automatically
   (already deploys on push to `main`, no change needed there). Reject → closes the PR,
   nothing merges.

A reviewer can optionally push their own additional commits to the PR branch before
approving (normal git/GitHub behavior) — not a required step, just always available.

---

## Confirmed design decisions

- **Coding-agent provider is separate from AIDA's chat provider.** New config,
  `AIDA_CODING_AGENT_PROVIDER` (own OpenAI/Anthropic adapter pair, mirroring the existing
  `providers/openai.js`/`providers/anthropic.js` pattern) — independent of `AIDA_PROVIDER`
  (which stays governing user-facing chat). Starts on OpenAI temporarily (already
  configured, key available now); switches to Anthropic later via `AIDA_CODING_AGENT_PROVIDER=anthropic`
  + `ANTHROPIC_API_KEY` — **a config change, not a code change**, if the provider
  abstraction is built correctly from the start.
- **Scope: `og-track-backend` only for phase 1.** The frontend repo is explicitly out of
  scope until this is proven once on the backend.
- **Code review happens on GitHub, not in OG Track.** The new jobs page is a thin
  wrapper: status, summary, PR link, CI result, Approve/Reject. GitHub's own PR UI is the
  actual review surface.
- **GitHub credential**: `AIDA_CODING_AGENT_GITHUB_TOKEN` — a fine-grained PAT scoped to
  `og-track-backend` only, `Contents: read/write` + `Pull requests: read/write`, nothing
  else. **Done and live-verified**: confirmed it can read contents and list/create PRs,
  and confirmed it's genuinely restricted (Actions secrets endpoint returns 403) — not
  just a UI label with no real enforcement behind it.

## Decisions — RESOLVED

1. **Merge location: Option A, confirmed.** Approve in OG Track's UI calls GitHub's API
   to merge on the user's behalf. **New, specific placement**: the approve/job-info
   surface is a new button, **"AIDA Job"**, added to the existing long-press-the-center-
   logo quick-action menu on the master-admin AIDA page (the same menu that already
   shows a few other action buttons there). Opens a panel with the job's full info (what
   was found/fixed, PR link, CI status) and the Approve/Reject buttons. This is a
   concrete, existing UI anchor point — not a brand-new page from scratch, which
   simplifies the eventual frontend prompt.
2. **Schedule: every Saturday at 8pm, confirmed** — timezone not yet specified;
   proceeding on the assumption of **IST (Asia/Kolkata)** unless corrected. **Also
   confirmed**: master admin must ALSO be able to trigger a fix run on demand from chat
   (not wait for Saturday) — same pattern as `dev_repo_diagnose` already being
   chat-triggered. So `dev_repo_fix` needs to be invocable both by the weekly scheduler
   AND as a normal AIDA tool call, sharing the same underlying job-kind logic.
3. **v1 sandbox approach (local temp clone + GitHub Actions CI as the real gate):
   confirmed, proceed.**

## Still required from you

- [x] `AIDA_CODING_AGENT_GITHUB_TOKEN` — done, verified.
- [x] Merge location, schedule, sandbox approach — all confirmed above.
- [ ] Confirm the Saturday 8pm timezone assumption (IST) is correct.
- [ ] `ANTHROPIC_API_KEY` — not blocking (starting on OpenAI), but needed before the
  seamless switch later.
- [ ] Sign-off on the exact CI workflow diff before it's applied (see below) — this
  touches your deploy pipeline, shown to you before anything lands.

---

## Build checklist (backend)

- [ ] `config.js`: add `AIDA_CODING_AGENT_PROVIDER`, `AIDA_CODING_AGENT_GITHUB_TOKEN`
      (already added by you), coding-agent model override.
- [ ] New coding-agent provider pair (`src/aida/codingAgent/providers/{openai,anthropic}.js`
      or similar) — a tool-use loop like the chat providers, but with filesystem/test
      tools instead of OG-Track-data tools.
- [ ] New job kind `dev_repo_fix` (`src/aida/jobs/jobKinds/`) — builds on
      `devDiagnose.js`'s clone/scan pattern, adds: coding-agent loop, git branch/commit/
      push, PR creation via the GitHub API. Registered BOTH as a normal AIDA tool
      (chat-triggered, on demand, master-admin only) AND as the target of the weekly
      scheduler — same underlying job-kind logic either way.
- [ ] Extend job data (existing `aida_jobs`/`aida_job_events`, or a new column) to carry
      the PR URL and CI status for display.
- [ ] Weekly scheduler (in-process timer) to auto-enqueue `dev_repo_fix` every Saturday
      8pm IST (pending timezone confirmation).
- [ ] `.github/workflows/main_og-track-backend.yml`: add a `pull_request` trigger for
      the `build` job, with an explicit `if: github.event_name == 'push'` guard on the
      `deploy` job so an unreviewed branch can never deploy to production. Diff shown to
      you before applying — this is the one change with real deploy-pipeline blast
      radius if done carelessly.
- [ ] Master-admin API endpoints backing the new "AIDA Job" panel (job info incl. PR
      link + CI status; approve → merge via GitHub API; reject → close PR).

## Build checklist (frontend)

- **Anchor point confirmed**: a new **"AIDA Job"** button added to the existing
  long-press-center-logo quick-action menu on the master-admin AIDA page — not a
  brand-new page. Opens a panel with job info + Approve/Reject. Exact prompt to follow
  once the backend API contract above is built and verified (same pattern as every other
  `docs/FRONTEND_PROMPTS.md` entry — verified first, then handed off).

---

## What to do when picking this back up

1. Resolve the three open decisions above before writing the job kind itself — they
   change its shape (merge mechanics, when it fires, how strict v1's isolation is).
2. Build and verify the coding-agent provider pair in isolation first (a small script,
   similar to how the voice-upgrade work in this repo was verified live against real
   APIs before wiring into routes) — prove it can read/write/test-fix a trivial, real
   bug before wiring the full job/PR/approval flow around it.
3. Apply the CI workflow change only after showing the exact diff and getting explicit
   confirmation — it's the one piece here with real production blast radius.
