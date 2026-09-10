# Frontend Prompts — hand these to your frontend session

Ready-to-paste prompts for frontend work that backs onto backend features already
built and verified in this repo. Each one is self-contained — paste the fenced block
into your frontend-repo session as-is.

---

## 1. Floating AIDA launcher + overlay-on-top-of-current-page

**Status: backend needs no changes — this is purely a frontend interaction pattern
change.** Today, `/:slug/aida` (and `/master-admin/aida`) work by hiding the main app
screen and showing a full-screen AIDA takeover — a destination, not a widget. This
prompt turns it into a persistent overlay layer instead (Intercom-style): a floating
button, an overlay panel that toggles without a page transition, and the URL updates
to `/aida` via `history.pushState` for shareability, without a real navigation.

```
Add a persistent floating AIDA launcher button, and change how the AIDA screen is
triggered so it overlays the current page instead of replacing it.

Logo: I'll provide the image separately — use it as the button's icon once given;
build the button now with a placeholder (a simple orb icon or the letter "A") so the
positioning/behavior can be reviewed before the final asset drops in.

Requirements:
1. A circular floating button, fixed position, bottom-right corner (e.g.
   `position: fixed; bottom: 24px; right: 24px; z-index` above everything else),
   visible on every logged-in screen for every employee — not just a specific page.
   If there's a shared "app shell" component/element that every logged-in screen
   renders inside of, add the button there once; if screens are fully independent
   divs with no shared wrapper, add the button as its own always-rendered element
   outside the screen-switching logic so it survives navigation between screens.
2. Clicking it must NOT navigate away from or unmount the current screen. It should
   open the existing AIDA chat overlay (if one already exists in this codebase, reuse
   it as-is — same chat history panel, orb, input box, etc.; if it doesn't exist for
   this app yet, build a full-screen or large-panel overlay using the SAME
   markup/behavior already built for masteradmin.html's `#aida-screen` /
   `showAidaScreen()` / `sendAidaMessage()` as a reference implementation to copy from).
3. Update the URL to end in `/aida` when opened (`history.pushState`, not a real
   navigation) so the state is shareable/bookmarkable, and restore the previous URL
   on close. Do not trigger a full page reload either direction.
4. If the user directly loads a URL ending in `/aida` (deep link), open the overlay
   automatically on load, on top of whatever the default/home screen is.
5. Closing the overlay (an X button, click-outside, or Escape) returns to the
   underlying page exactly as it was — nothing about the underlying page's state
   should reset just because AIDA was opened and closed.
6. Keep this only for tenant/employee logins for now — do not change master admin's
   existing AIDA entry point.
```

---

## 2. AIDA voice playback (ElevenLabs)

**Status: backend is built and verified** — `src/aida/voice/` (chunked, low-latency
TTS via ElevenLabs, delivered over the existing socket.io connection). See
`README.md`'s "Voice — streaming, personality, interruption" section for the full
backend design if you want the context; this prompt only needs the contract below.

```
Wire up AIDA voice playback using a new socket.io event, and enable the existing
disabled voice-mode toggle button.

1. Enable the voice-mode toggle in the AIDA chat UI (currently a disabled/stubbed
   button per the placeholder built earlier). When on, every POST to /chat should
   include `voice: true` in the request body.
2. On the same socket.io connection already used for other real-time events (the one
   already joined via `socket.emit('join', ...)`), listen for `aida:voice-chunk`
   events: `{ turnId, seq, isFinal, audioBase64, mimeType }`. Decode each
   `audioBase64` chunk and play it back in strict `seq` order using the Web Audio API
   (e.g. decode each chunk to an AudioBuffer and queue playback so chunk N+1 starts
   the instant chunk N finishes, with no gap or overlap) — do not wait for `isFinal`
   before starting playback, only use `isFinal` to know when to stop showing the
   "speaking" state.
3. Drive the existing `.aida-orb-speaking` CSS state (already stubbed) for the
   duration between the first chunk playing and the final chunk finishing.
4. Listen for `aida:voice-error` (`{ turnId, message }`) — on receipt, stop any
   "speaking" UI state for that turnId; the text reply (already delivered via the
   normal chat response) stays visible regardless — never hide or retract text
   because voice failed.
5. Bind incoming chunks to the correct chat bubble via `turnId` (returned in the
   `/chat` response alongside `reply`) so a second message sent before the first
   finishes speaking doesn't cross-play audio onto the wrong bubble.

Note: tenant clients receive a per-user event name instead of the plain one above —
`aida:voice-chunk:<userId>` / `aida:voice-error:<userId>` (since a tenant's socket
room is shared by every user at that company) — master admin gets the plain
`aida:voice-chunk` / `aida:voice-error` names shown above. Use whichever matches the
login type this screen is for.
```

---

## 3. Master admin dashboard overhaul

**Status: backend is built and verified** — `GET /api/masteradmin/dashboard/summary`
(see `README.md`'s "Master admin dashboard summary" section for the full field list).

```
Redesign master admin's main screen from its current bare add-company-form-and-list
layout into an actual dashboard, while keeping the existing company management
functionality (add/edit company, provision modules, pending users list) — this is an
addition/reorganization, not a removal of anything that currently works.

1. Call the new `GET /api/masteradmin/dashboard/summary` endpoint on load (same
   `authFetch`-style pattern already used for other masteradmin API calls) and render
   its data as a set of dashboard cards/sections above or alongside the existing
   company list:
   - Company counts (total / active / suspended) as stat tiles.
   - A simple trend chart (companies created per month, last 6-12 months).
   - Module adoption (which modules are enabled across the most companies) — a
     simple bar/ranked list is enough, this doesn't need to be elaborate.
   - Provisioning health (success/failed/pending counts, last 30 days) — make
     failures visually stand out (e.g. a warning color) since this is the one card
     that should prompt action.
   - Pending approvals count, linking to (or expanding into) the existing pending
     users list already on this page.
   - A "this month" summary card: new companies, new pending users, provisioning
     failures, all for the current calendar month.
2. Keep the existing light theme and color variables already defined in this file's
   `:root` block — this is a reorganization/expansion of the existing visual language,
   not a switch to dark mode (that's specific to the AIDA overlay elsewhere on this
   page, not the rest of the app).
3. Keep every existing piece of functionality reachable — add-company form,
   per-company module provisioning, pending-user approve/reject — either above the
   new dashboard cards or in a clearly-labeled section below them. Nothing that works
   today should become harder to find.
4. This is a real-data dashboard, not a static mockup — wire it to the actual
   endpoint response, and handle the loading/empty states reasonably (e.g. "no
   companies yet" rather than a blank card) rather than assuming data is always
   present.
```

---

## 4. Barge-in — spacebar interrupts AIDA mid-reply and starts listening

**Status: backend is built and verified** — `POST /aida/voice-cancel` (see
`README.md`'s "Interruption / barge-in" section). Verified live: cancelling a real
in-flight reply produced zero further audio chunks, even for a long multi-sentence
answer — and, per prompt 6 below, can now also abort the LLM call generating it.

```
Add a spacebar-triggered interrupt for AIDA's voice replies.

1. Listen for a spacebar keydown, but only when focus is NOT inside the text input
   box (check document.activeElement before acting) — otherwise this would hijack
   normal typing.
2. On trigger, while AIDA is currently speaking (audio is playing or chunks are still
   arriving for the current turnId):
   - Immediately stop local audio playback (clear/stop the Web Audio queue) — don't
     wait for a server round trip for this part, it must feel instant.
   - Call `POST /aida/voice-cancel` with `{ turnId }` for the turn that was just
     interrupted, so the backend stops synthesizing/sending anything more for it.
   - Immediately start a new voice recording — reuse the exact same function that
     already starts recording for the microphone button, don't duplicate that logic.
3. If spacebar is pressed while AIDA is NOT currently speaking, just start recording
   directly (same as clicking the mic button) — no cancel call needed since there's
   nothing to interrupt.

Note: this does not cancel AIDA's "thinking" — if you interrupt before any reply has
started arriving yet (still waiting on the very first chunk/filler), there's nothing
to stop yet; just start recording as in step 3. Also note: some replies now play a
short "thinking" filler clip before the real answer (tagged `filler: true` in the
`aida:voice-chunk` payload) — treat it the same as real audio for interrupt purposes
(stopping playback and cancelling mid-filler is fine and expected).
```

---

## 5. AIDA interface redesign — on hold

Not started. Waiting on you to provide the HTML file and implementation instructions.
The integration surface it needs to hook into either way: `POST /chat`, `GET /history`,
`DELETE /session`, `GET /tools` (all documented in `README.md`), plus the voice event
contract in prompt 2 above.

---

## 6. Real-time voice upgrade (streaming, personality, interruption) — ONE required fix

**Status: backend upgraded and verified — FRONTEND CHANGE REQUIRED: YES, one specific fix
(see below).** I originally wrote this section saying no frontend change was needed —
that was wrong, found from your own browser console log. Read the "REQUIRED FIX" block
first; the rest of this section is background/optional.

**REQUIRED FIX — paste this to your frontend session as-is:**

```
Fix a real bug in how the AIDA voice chat screen accepts incoming aida:voice-chunk
events, found from this exact console log pattern:

  [AIDA voice] chunk received  {turnId: 'voice_...', seq: -1, ..., currentTurn: null}
  [AIDA voice] dropped — turnId does not match the current turn
  [AIDA voice] chunk received  {turnId: 'voice_...', seq: 0, ..., currentTurn: null}
  [AIDA voice] dropped — turnId does not match the current turn
  ... (repeats for several more chunks) ...
  [AIDA voice] chunk received  {turnId: 'voice_...', seq: 8, ..., currentTurn: 'voice_...'}
  (finally accepted, seq 8 onward plays)

Root cause: `currentTurn` is currently only ever set from the POST /chat (or
/voice-input) HTTP response body's `turnId` field. AIDA's backend now streams audio
while the LLM is still generating text, so `aida:voice-chunk` events (and the filler
event, seq: -1) can legitimately arrive over the socket BEFORE that HTTP response ever
comes back — especially for a longer reply. Every chunk that arrives before the HTTP
response is currently being silently dropped, because `currentTurn` is still null at
that point and the code only accepts a chunk whose turnId matches it exactly.

Find wherever `currentTurn` is compared against an incoming chunk's `turnId` (the code
that logs "dropped — turnId does not match the current turn") and change the ADOPTION
rule: if `currentTurn` is currently null/unset (no turn is being tracked yet), ADOPT the
incoming chunk's turnId as the new `currentTurn` instead of dropping it — then continue
handling that chunk normally (play its audio, don't just adopt-and-discard it). Once
`currentTurn` is set, later chunks compared against a DIFFERENT turnId should still be
dropped exactly as today — that part of the logic is correct and is what makes barge-in
work; only the "reject because currentTurn happens to still be null" case needs to
become "adopt instead of reject."

Also make sure whatever code currently sets `currentTurn = turnId` from the HTTP
response body still runs — it becomes a harmless no-op re-assignment to the same value
once a chunk has already set it, and is still needed as a fallback for the case where
the HTTP response genuinely does arrive first (e.g. a very short reply).

Do not change anything else about chunk playback, ordering, or the barge-in/interrupt
logic — only this adoption rule.
```

**Why this matters**: this single bug was silently dropping BOTH real audio chunks for
any reply long enough that TTS starts before the LLM finishes, AND the filler line
(`seq: -1`) on every single turn — meaning it looked like "no filler ever plays" and "no
audio on long replies" were two separate bugs, when they were actually the same one, on
the frontend, not the backend. Short replies mostly hid it, since the HTTP response
usually still won that particular race for those.

---

The rest of this section (background, unchanged from the original write-up): none of the
above changes the wire contract prompt 2 already documented — `aida:voice-chunk`
(`{ turnId, seq, isFinal, audioBase64, mimeType }`), `aida:voice-error`
(`{ turnId, message }`), and `POST /aida/voice-cancel` (`{ turnId }`) are byte-for-byte
the same shape as before. The existing chunk-queue playback (played in strict `seq`
order, not waiting for `isFinal`) already handles this correctly once the fix above is
in — it just now receives chunks sooner and possibly more of them for a longer reply,
which it was already built to handle (multiple ordered chunks per turn) once they
aren't being dropped at the door.

Two *optional* enhancements this now makes possible, only worth doing if you want to
polish the barge-in experience further — skip entirely if the current spacebar-interrupt
behavior (prompt 4) already feels good enough:

```
Optional AIDA voice UX polish — only pursue this if the current barge-in (spacebar
interrupt, prompt 4 above) doesn't already feel responsive enough for real usage.

Context: previously, a turnId only became known to the frontend once the full chat
reply arrived (embedded in the same event as the first audio/filler chunk). AIDA's
backend now streams the reply and can start sending audio chunks for a turn WHILE the
LLM is still generating the rest of it — meaning the interrupt affordance could be made
available slightly earlier for a snappier feel, though the existing "AIDA is speaking"
state already covers the common case.

1. If there's any UI state that gates showing the "interrupt AIDA" affordance (e.g. a
   visible stop button, not just the spacebar shortcut) on the full chat response having
   returned, consider gating it on the FIRST `aida:voice-chunk` (or filler) event for a
   turnId instead — that event can now arrive noticeably earlier. Not required if the
   affordance is already keyed off "AIDA is speaking" audio state rather than the HTTP
   response.
2. The `/chat` and `/voice-input` JSON responses may now additionally include
   `interrupted: true` (the turn was cut short by a barge-in) or `degraded: true` (a
   transient LLM/TTS error occurred but AIDA still returned a partial/fallback reply).
   Both are purely additive — safe to ignore — but if you want, render a subtle
   indicator (e.g. a small "cut short" tag on that message bubble) when `interrupted` is
   present. Do not treat `degraded` as an error state — the reply is still valid and
   should display normally either way.

Do not change the core audio-chunk playback logic, the turnId-binding logic, or
anything else already built for prompt 2/4 above — none of that needs to change.
```

---

## 7. Instant local "thinking" sound on recording-stop (zero network latency)

**Status: backend built and verified — new static files + endpoint, frontend change
required.** Even with the backend's own filler mechanism (prompt 2/6) starting as early
as physically possible on the server side, it can never be truly instant — it still
needs the recording to finish uploading and the server to receive it first. The only way
to get a genuinely zero-latency "AIDA heard you and is thinking" reaction is to play a
short pre-recorded sound **locally, from a cached file, the instant recording stops** —
before the upload even begins.

New static endpoint: `GET /aida-fillers/manifest.json` (no auth — these are generic,
non-tenant audio clips) returns:
```json
{
  "thinking": [
    { "file": "thinking/0.mp3", "text": "[sighs] Ummmmm, let me check on that...", "bytes": 55633 },
    { "file": "thinking/1.mp3", "text": "Hmmm... one second...", "bytes": 28884 },
    { "file": "thinking/2.mp3", "text": "Okay, let me look into that...", "bytes": 32645 },
    ... 52 more (55 total) ...
  ],
  "acknowledgement": [ ... ], "surprise": [ ... ], "amusement": [ ... ], "empathy": [ ... ]
}
```
Each listed file is fetchable directly at `GET /aida-fillers/<file>` (e.g.
`/aida-fillers/thinking/0.mp3`), real MP3 audio, ready to play as-is. The full
`thinking` category is ~2MB total (55 short clips) — see the sizing note in step 1
below for when to fetch it.

```
Add instant, zero-latency local filler playback for AIDA voice input, using pre-recorded
audio files the backend now serves — no network call needed at the moment it plays.

1. Fetch GET /aida-fillers/manifest.json once and cache the response, then prefetch the
   audio files listed under the "thinking" category specifically (55 short clips, e.g.
   "Ummmmm, let me check on that...", "Hmmm... one second...") — these are the only ones
   relevant here, since at record-stop time AIDA doesn't know what the user said yet, so
   only a generic "thinking" reaction makes sense. The whole category is ~2MB, which is
   fine as a one-time app-load cost relying on normal browser HTTP caching for repeat
   visits, but if you'd rather avoid that upfront hit, fetch/cache it lazily the moment
   the user STARTS recording (mic press) rather than on app load — each file is small
   (20-55KB) and will finish downloading well within the time the user is still talking,
   so it's still ready the instant they stop. Either timing works; just don't defer the
   fetch until AFTER recording stops, or it defeats the point. Preloading them (e.g. via `Audio`
   objects with `preload="auto"`, or fetching as blobs up front) avoids any decode delay
   on first playback.
2. The INSTANT the user finishes speaking (spacebar release / stop-recording, whichever
   currently ends the recording and starts the upload to POST /voice-input), before
   that upload even starts: pick one of the cached "thinking" clips at random (avoid
   repeating the same one twice in a row) and play it immediately, locally — this must
   not wait on the recording upload, transcription, or anything server-side.
3. AIDA's backend ALSO still sends its own filler over the socket (the existing
   aida:voice-chunk event with filler: true) as a fallback/general-purpose mechanism —
   it's not being removed. To avoid hearing two overlapping "thinking" reactions back to
   back for the same turn, track whether a local filler already played for the turn
   currently in flight; if the incoming aida:voice-chunk event has filler: true AND a
   local filler already played for this turn, skip PLAYING that particular event's
   audio — but still process it normally for everything else (in particular, still
   adopt its turnId as the current turn if one isn't set yet, per the fix in prompt 6 —
   don't skip that part, only skip the audio playback for this one event).
4. Reset the "local filler already played" flag at the start of each new recording, so
   it's evaluated fresh per turn.

Do not change how real (non-filler) audio chunks are handled, the turnId adoption logic
from prompt 6, or the existing server-triggered filler mechanism itself — this is purely
additive, a faster reaction layered on top of what already exists.
```

---

## 8. Manufacturing Assembly — remove the single-vendor stock gate

**Status: backend fixed and verified — frontend change required.** The Create Assembly
screen's "Vendor Source" dropdown currently requires ONE vendor/lot to cover a
component's entire requirement, and flags the line unavailable if none does — even when
the item's total stock (summed across every lot: opening stock, PO A, PO B, ...) is more
than enough. This was never actually true on the backend: `POST /assemblies` has always
consumed stock FIFO across ALL lots for a component regardless of vendor, opening-stock
lots included. The bug was the frontend gating on the wrong signal.

Root cause, now fixed on the backend: `GET /api/:slug/manufacturing/boms/:id/vendor-check?quantity=N`
used to return `anyVendorSufficient` — true only if some SINGLE vendor's lots alone
covered the requirement. That field has been **removed**. Each line in the response now
looks like:
```json
{
  "componentItemId": "...", "componentName": "...",
  "required": 120, "totalAvailable": 150, "sufficient": true,
  "vendors": [
    { "vendorId": "v1", "vendorName": "Vendor A", "available": 80, "sufficient": false },
    { "vendorId": null, "vendorName": "Unassigned stock", "available": 40, "sufficient": false },
    { "vendorId": "v2", "vendorName": "Vendor B", "available": 30, "sufficient": false }
  ]
}
```
and the response now also has a top-level `canBuild` (= every line's `sufficient` is
true), matching the shape `GET /api/:slug/manufacturing/boms/:id/check?quantity=N`
already used.

```
Fix the Manufacturing Assembly screen's stock-availability check and remove the
single-vendor requirement — the backend already supports pooling stock across every
vendor/lot for a component, this was purely a frontend gating bug.

1. Find wherever the "Vendor Source" dropdown / per-component availability check lives
   (likely calls GET /api/:slug/manufacturing/boms/:id/vendor-check?quantity=N, and/or
   GET /api/:slug/manufacturing/boms/:id/check?quantity=N). Find the logic that reads
   `anyVendorSufficient` (or loops over `vendors` checking if any single one covers the
   requirement) to decide whether a component/line is "available" — that field no
   longer exists in the API response and must not be the basis for this decision.
2. Replace it with the line's own `sufficient` field (`totalAvailable >= required`,
   already computed server-side) — or equivalently use the `canBuild` field on the
   response as a whole. A component is available if the pooled total across all its
   lots covers the requirement, full stop; no single vendor/lot needs to cover it alone.
3. Remove the "Vendor Source" dropdown as a required selection. Replace it with a
   read-only summary of which vendors/lots will actually be drawn from — the `vendors`
   array (sorted by `available` descending) already tells you this; something like
   "Will draw from: Vendor A (80), Unassigned stock (40)" is enough. The user is not
   choosing anymore — consumption is automatic FIFO across lots (oldest first) — this
   is purely informational, similar in spirit to how the assembly detail page already
   shows a read-only "Source" column for completed builds.
4. When a line is genuinely insufficient (totalAvailable < required, i.e. `sufficient:
   false` / not in `canBuild`), keep showing it as unavailable/blocking — that part of
   the behavior was correct, only the false-positive case (enough pooled stock, no
   single vendor alone) needs to stop being flagged.

Do not change anything about how the actual build request (POST /assemblies) is called
or its request body — only the pre-build availability check and the Vendor Source UI.
```

---

## 9. Local instant filler still not firing on spacebar release — likely an autoplay/user-gesture bug

**Status: backend verified healthy (manifest, files, CORS, caching all correct) —
frontend bug, diagnosis needed.** Prompt 7 was applied (fetches the manifest, plays a
local file), but it's reportedly still not firing right when recording stops. The
leading cause: browsers only allow `audio.play()` without restriction when it's tied
closely enough to a real user gesture (a keyup counts) — and that link breaks if there's
ANY async gap between the gesture and the `.play()` call, including doing
`await fetch(...)` for the manifest INSIDE the keyup/stop-recording handler itself,
rather than ahead of time.

```
Local instant filler playback (built per an earlier prompt: fetch /aida-fillers/
manifest.json, play a cached "thinking" clip locally the instant recording stops) isn't
actually firing. Diagnose and fix.

1. Reproduce it and check the browser console at the exact moment recording stops.
   Look specifically for an error resembling:
     NotAllowedError: play() failed because the user didn't interact with the document first
   or any other rejected promise from an `.play()` call. This happens when too much
   async work (even a fast one) sits between the user gesture (keyup / stop-recording
   click) and the `.play()` call — browsers can decide the gesture no longer "counts."
2. If that's the error: make sure the manifest fetch and Audio object construction/
   preload happen AHEAD OF TIME — on app load, or at latest on mic-press (recording
   START, not stop) — not inside the same handler that calls `.play()`. At the moment
   recording actually stops, there should be ZERO `await`/async work between reading the
   already-cached Audio object and calling `.play()` on it synchronously.
3. If that's NOT the error (playback is being attempted with no console error, just
   silently not audible, or not being attempted at all): check whether the manifest
   fetch itself is failing or resolving after the fact — confirm in the Network tab that
   GET /aida-fillers/manifest.json succeeds (200, JSON body with a "thinking" array) well
   before the recording-stop event, and that the audio file URLs constructed from it
   (e.g. /aida-fillers/thinking/3.mp3) are correct and also fetched successfully.
4. Also confirm the flag from prompt 7 step 3/4 (suppressing the server's own filler
   once a local one played) isn't accidentally suppressing the LOCAL one too, or getting
   set before the local playback actually succeeded — if `.play()`'s promise rejected
   (case 1 above), that flag should NOT be set, since nothing actually played.

Report back what you find in the console/network tab if the fix in step 2 doesn't fully
resolve it — there may be more than one issue here.
```

---

## 10. "AIDA Job" panel — master admin, on the long-press-logo quick-action menu

**Status: backend built and verified — frontend change required, new UI.** Phase 1 of
AIDA's coding-agent capability (see `docs/AIDA_PHASE1_SELF_FIX_PLAN.md`) — AIDA can now
actually diagnose and fix real bugs in an authorized repo, push a branch, and open a real
GitHub PR for review. Nothing merges without a human clicking Approve. This is the panel
that surfaces that.

**Confirmed placement**: a new button, **"AIDA Job"**, added to the existing long-press-
the-center-logo quick-action menu on the master-admin AIDA page (the same menu that
already shows a few other action buttons there) — not a new page.

**Endpoints** (all master-admin auth, same pattern as every other masteradmin AIDA call):
```
GET  /api/masteradmin/aida/jobs?kind=dev_repo_fix&status=awaiting_approval&limit=20
     -> { jobs: [ { id, kind, status, payload, result, errorMessage, createdAt, updatedAt }, ... ] }
     kind/status/limit are all optional filters — omit any/all to get everything, most recent first.

GET  /api/masteradmin/aida/jobs/:id
     -> { job, events, ciStatus }
     - job.result for a dev_repo_fix job that found something to fix:
         { repo, task, agentSummary, changed: true, branch, prNumber, prUrl, toolLog }
       for a run that found nothing to fix (the common case — most weeks nothing's broken):
         { repo, task, agentSummary, changed: false, toolLog }
       job.status is one of: queued | running | awaiting_approval | approved | rejected | completed | failed
     - events: the full timeline, e.g. [{ event: "started" }, { event: "cloned" }, { event: "installed" },
       { event: "agent_started" }, { event: "agent_finished" }, { event: "pushed" }, { event: "pr_opened" },
       { event: "awaiting_approval" }, ...] — each with a createdAt and sometimes a detail object.
     - ciStatus: { state: "success"|"failure"|"pending"|"unknown", description } or null if there's no PR
       yet to check — fetched live from GitHub server-side, so you never need your own GitHub access here.

POST /api/masteradmin/aida/jobs/:id/approve  -> { job }   (merges the real PR)
POST /api/masteradmin/aida/jobs/:id/reject   -> { job }   (closes the real PR without merging)
     Both only valid while job.status === "awaiting_approval".
```

Also available, for triggering a fix on demand instead of waiting for the weekly run —
this already works today as a normal AIDA chat tool call (say something like "AIDA, look
into the attendance clock-out bug" to master admin's chat), no new endpoint needed for
that part.

Live updates: the existing `aida:job` socket event (same `masteradmin:<userId>` room
convention already used for other real-time AIDA events) fires on every status change —
listening for it is optional (polling `GET /jobs` on an interval works fine too), but
avoids needing to poll if you want it snappier.

```
Add an "AIDA Job" panel for master admin.

1. Add a new button labeled "AIDA Job" to the existing long-press-center-logo
   quick-action menu on the master-admin AIDA page, alongside whatever buttons are
   already there.
2. Clicking it opens a panel/modal that lists jobs via GET /api/masteradmin/aida/jobs
   (default to kind=dev_repo_fix, no status filter, so both pending-review and
   historical jobs show). For each job in the list show: a status badge, when it was
   created, and — if present — job.result.agentSummary as a one-line preview. Sort by
   newest first (the endpoint already returns them that way).
3. Clicking a job in the list opens its detail (GET /api/masteradmin/aida/jobs/:id):
   - The full agentSummary (plain language — this is meant to be read, not a raw diff).
   - If job.result.prUrl exists, a link that opens it in a new tab (the actual code
     review happens on GitHub — do not build a diff viewer here).
   - The ciStatus (success/failure/pending/unknown) as a colored badge — make failure
     stand out visually, since that's the case that should give a reviewer pause before
     approving.
   - If job.status === "awaiting_approval": Approve and Reject buttons, calling the
     corresponding POST endpoints. After either, refresh the job (or just optimistically
     update its status) and show a brief confirmation.
   - If job.status is anything else (completed/failed/rejected/running/queued), no
     Approve/Reject buttons — just show the current state. A "completed" job with
     result.changed === false means AIDA looked and found nothing to fix — display that
     as a normal, positive outcome, not as an error.
   - Optionally, the event timeline (the `events` array) as a simple chronological list
     — useful for seeing progress on a still-running job, not required for MVP.
4. Handle the empty state (no jobs yet) and loading states reasonably.

Do not build a custom diff viewer, do not add any direct GitHub API calls from the
frontend (the backend already proxies CI status), and do not change anything about the
existing chat UI — this is purely a new, additive panel.
```

---

## 11. "AIDA Job" panel — extend it for `create_module` jobs (Phase 2)

**Status: backend built — small extension to the existing panel from prompt 10, not a
new panel.** Phase 2 of AIDA's coding-agent capability
(`docs/AIDA_PHASE2_MODULE_BUILDER_PLAN.md`) lets master admin ask AIDA to build a whole
new module (e.g. "create me a module called Attendance: ..."). It reuses every endpoint
from prompt 10 — same job list, same detail call, same Approve/Reject buttons — just with
a new `kind`, `"create_module"`, whose `job.result` and `ciStatus` are shaped differently
because it involves TWO repos, not one.

**Two things need to change:**

1. **The job list should include `create_module` jobs, not just `dev_repo_fix`.** If your
   `GET /jobs` call currently hardcodes `?kind=dev_repo_fix`, either drop the `kind` filter
   entirely (shows every job kind, newest first) or fetch both kinds and merge — either is
   fine, this doesn't need to be a toggle/tab for v1.

2. **`job.result` and `ciStatus` have a different shape for `kind === "create_module"`:**
   ```
   job.result (once it has something to review):
     {
       moduleName, slug, agentSummary, changed: true,
       branch,
       backendRepo, frontendRepo,        // "owner/repo" strings
       backendPr:  { number, url } | null,   // null only if the agent made no backend changes
       frontendPr: { number, url } | null,   // null only if the agent made no frontend changes
       previewUrls: {
         backendUrl, frontendUrl,        // e.g. "http://localhost:4113"
         backendReady, frontendReady,    // booleans — false means it didn't come up within the timeout
       } | null,                          // null if booting the preview itself failed (rare)
       toolLog
     }
   // a run that found nothing to change: { moduleName, slug, agentSummary, changed: false, toolLog }

   ciStatus (only present/non-null for create_module once at least one PR exists):
     { backend: {state, description} | null, frontend: {state, description} | null }
   // null entry means that side had no changes/no PR to check — not a failure, don't show it as one.
   ```

3. **In the job detail view**, when `job.kind === "create_module"`:
   - Show both PR links (whichever of `backendPr`/`frontendPr` is non-null) instead of the
     single `prUrl` prompt 10 used for `dev_repo_fix` — label them "Backend PR" / "Frontend
     PR".
   - Show both CI badges from `ciStatus.backend`/`ciStatus.frontend` the same way prompt
     10 showed one, skipping any side that's `null`.
   - **New**: if `previewUrls` is present, show a prominent "Open Live Preview" button/link
     using `previewUrls.frontendUrl` (that's the actual app UI to click through — the
     backend URL is just its API, not meant to be opened directly). If
     `previewUrls.frontendReady === false`, show a small note ("still starting up, try
     again in a moment") instead of hiding the link — it may just need a few more seconds.
   - Approve/Reject buttons work exactly as prompt 10 already built them — same two
     endpoints, no change needed there; the backend now merges/closes both PRs and tears
     down the preview internally.
   - Everything else (status badges, agentSummary display, event timeline, empty/loading
     states) is unchanged from prompt 10.

Do not build anything new for triggering this — "AIDA, create me a module called X with
these features: ..." already works today as a normal chat message to master admin's chat,
same as prompt 10's on-demand trigger note.

**One more small fix, applies to prompt 10's panel too, not just this one**: a job that
fails before producing any `job.result` (e.g. npm install failing in the sandbox) has a
real `job.errorMessage` string, but the panel currently only ever displays
`job.result.agentSummary` — so a job like this shows "No summary yet" with literally no
way to see what actually went wrong. Fix: when `job.status === "failed"` and there's no
`job.result.agentSummary` to show, display `job.errorMessage` instead (plain text, it can
be long — a raw stack/log excerpt — so don't truncate it, just let it wrap/scroll).

---

## 12. Birthday / work-anniversary tracking — registration field + popups

**Status: backend built (PR open, pending approval) — frontend change required, new UI.**
Employees can now have a date of birth and a joining date on file; once merged, the app
should surface that as a fun, low-key celebration — not gate anything behind it.

**Endpoints** (live once the backend PR merges):
```
POST /api/:slug/users/register
  Body now optionally accepts: dateOfBirth ("YYYY-MM-DD" string). Everything else about
  this endpoint is unchanged. joining_date is stamped automatically server-side — nothing
  to send for that.

GET /api/:slug/users/today-celebrations
  -> [ { userId, name, type: "birthday" | "anniversary", yearsCount }, ... ]
  yearsCount is only meaningful (and present) for type "anniversary" — years since joining.
  Empty array on a normal day with nothing to celebrate. No special auth beyond the normal
  logged-in request — every user in the company can see this.

PATCH /api/:slug/users/me/dob
  Body: { dateOfBirth: "YYYY-MM-DD" }
  Sets the CURRENTLY LOGGED IN user's own date_of_birth (validated server-side: must be a
  real date, not in the future). Uses the same auth as any other authenticated request.

Note: the existing GET /api/:slug/users (or wherever the frontend already reads the logged-
in user's own row) will include date_of_birth/joining_date automatically once the backend
PR merges — no new endpoint needed just to check whether the current user already has a
DOB on file.
```

```
Add birthday/work-anniversary tracking to the frontend.

1. Registration form: add an optional "Date of Birth" date picker. If filled in, include it
   in the POST /register body as dateOfBirth ("YYYY-MM-DD"); if left blank, omit it — it's
   optional at registration time (people can fill it in later via step 3 below).

2. On login/page load, once per day per user (track "already shown today" in localStorage,
   keyed by today's date + the user's id, so it doesn't repeat on every navigation — just
   once when they first open the app that day), call GET /api/:slug/users/today-celebrations.
   If it returns any entries:
   - For each "birthday" entry: show a celebratory popup/toast visible to everyone in the
     company — something like "🎉 Today is <name>'s birthday! Wish them well."
   - For each "anniversary" entry: similar, e.g. "🎊 Today marks <name>'s <yearsCount>-year
     work anniversary!"
   - If there are multiple entries the same day, show all of them (stacked toasts, or one
     combined popup listing everyone) — don't just show the first and drop the rest.

3. If the currently logged-in user has no date_of_birth on file (check their own user row,
   per the note above), show a one-time popup (once per session is fine, or track
   "dismissed" in localStorage if you want it less naggy) asking them to enter their date of
   birth, saving it via PATCH /api/:slug/users/me/dob. Let them dismiss/skip it — this
   should never block using the app.

Keep this purely additive — don't change any existing registration/login behavior beyond
what's described here.

---

## 13. Point preview deployments at the preview backend, not production

**Frontend setup checklist (do this before the code change below) — no slot or publish
profile to create here, this is Azure Static Web Apps, which manages per-PR preview
environments itself once connected:**
1. Look for `.github/workflows/azure-static-web-apps-<something>.yml` in this repo — Azure
   auto-generated it (with its own auto-created secret) when the Static Web App was first
   linked to this repo. If it's missing entirely, the SWA was never connected via GitHub
   Actions and that's a bigger gap than this prompt covers.
2. Open it and check for a `staging_environment_policy: Disabled` line — remove it or set
   to `Enabled` (Enabled is the default when the line is absent).
3. Confirm which branch(es) its `pull_request:` trigger watches — matches whatever branch
   you'll actually target when opening PRs.
4. Test empirically: open any small test PR against that branch and confirm Azure's bot
   comments a live preview link within a couple minutes, before relying on it.

**Status: backend piece built (a "preview" deployment slot + a workflow that auto-deploys
every non-main branch to it, so any in-progress branch gets a real, live URL without
merging first). This prompt is the one frontend piece needed to make that actually useful
end-to-end** — right now, whatever decides which backend API base URL to call only knows
about two cases (localhost → dev API, anything else → the hardcoded production API URL),
so even once the frontend itself has a live preview URL (Azure Static Web Apps' built-in
per-PR preview environments), it would still silently call the PRODUCTION backend, not the
preview one — meaning a preview of a frontend+backend change together isn't actually
testing the backend change at all.

I don't have visibility into this repo (standing rule — I never read/edit the frontend), so
find this yourself first: search for wherever the API base URL is currently decided —
likely a single small function/const near the top of a config file or index.html, something
like `location.hostname === 'localhost' ? 'http://localhost:3000' : 'https://<prod-host>'`.
Read whatever you find before changing it; the exact current shape may differ from this
guess.

Add a third case: when `location.hostname` is neither `localhost` NOR the known production
hostname/custom domain, treat it as a preview environment (Azure Static Web Apps' per-PR
preview URLs look like `https://<some-hash>.<region>.azurestaticapps.net`, distinct from
the production custom domain) and point the API base URL at the backend's preview slot
instead. The preview slot's exact URL will show in the Azure Portal once it's created
(App Service → Deployment slots → preview) — something like
`https://og-track-backend-preview.azurewebsites.net` or with a region/hash suffix matching
production's own hostname pattern; use whatever the Portal actually shows, don't guess it.

If there's ever a need to preview a frontend change ALONE without a matching backend change
(most cases), falling back to the regular production backend for a preview build is
perfectly fine — only add the preview-backend branch, don't try to guess the "right" one
API-call-by-API-call.

Keep this to just the API-base-URL decision — don't touch the localhost/production cases
that already work.

---

## 14. Forgot password / reset password

**Status: backend built, needs Azure email setup to actually send (see chat) — frontend
change required, new UI.**

**Endpoints:**
```
POST /api/:slug/users/forgot-password
  Body: { email }
  Always returns { success: true, message: "..." } — even if the email doesn't exist, isn't
  approved yet, or the send itself failed. Never treat a different response shape as meaning
  "this email exists" — there isn't one, by design (prevents account enumeration). Show the
  returned `message` as-is.

POST /api/:slug/users/reset-password
  Body: { token, newPassword }
  token comes from the emailed link's query string. newPassword must be at least 8
  characters (server-enforced; validate client-side too for a faster error). On success:
  { success: true }. On an invalid/expired token: 400 { error: "..." } — show that error and
  let them request a new link (the token is single-use and expires after 1 hour either way).
```

```
Add a forgot-password flow to the frontend.

1. Login page: add a "Forgot password?" link/button. Clicking it shows a simple form (an
   email input) — either a modal or a separate view, match whatever pattern this app already
   uses for that kind of small auxiliary form. On submit, POST /forgot-password with the
   entered email, then show the returned `message` (a generic, non-committal confirmation —
   don't add your own "email sent!" wording, use exactly what the backend returns) and let
   them dismiss back to login.

2. New route/page: /reset-password — reads `token` and `company` from the URL query string
   (the emailed link is `<frontend-base-url>/reset-password?token=...&company=<slug>`).
   Show a form with a new-password input (+ confirm-password input, checked to match
   client-side) and a submit button. On submit, POST /api/<company-from-query>/users/reset-password
   with { token, newPassword }. On success, show a confirmation and a link/button back to
   login. On error (invalid/expired token), show the error message and a link back to the
   login page's "Forgot password?" flow so they can request a fresh one — don't let them
   resubmit the same dead token.

3. If `token` or `company` is missing from the URL entirely (someone navigated to
   /reset-password directly), show a plain "invalid reset link" state instead of rendering
   the form — don't call the endpoint with empty/missing values.

Keep this purely additive — don't change any existing login/registration behavior beyond
adding the "Forgot password?" entry point described in step 1.
```

---

## 15. Sitara Bespoke module bundle (dashboard, people, stocks, orders)

**Status: backend built (Phase 1 manual data entry + Phase 2 BigCommerce order sync are both
in; Razorpay reconciliation is still a later phase) — frontend change required, new company
checkbox + 4 new screens.**

**1. Company-creation form (master admin)**: add a single checkbox — **"Sitara Bespoke"** —
that, when ticked, sets all 4 of these module keys in `enabled_modules` at once (don't add 4
separate checkboxes, one toggle does all 4): `sitara_dashboard`, `sitara_people`,
`sitara_stocks`, `sitara_orders`. This is purely a convenience grouping — under the hood
they're just normal entries in the same `enabled_modules` array every other module checkbox
already writes to.

**Endpoints** (all under `/api/:slug/sitara`, gated by any of the 4 module keys above):
```
GET  /weavers  |  POST /weavers  |  PATCH /weavers/:id  |  DELETE /weavers/:id
  Weaver: { id, name, contactName, phone, email, notes }. POST body: { name, contactName?,
  phone?, email?, notes? } — name is the only required field.

GET  /vendors  |  POST /vendors  |  PATCH /vendors/:id  |  DELETE /vendors/:id
  Same shape as weavers (separate list — a vendor and a weaver are different people/roles).

GET  /customers  |  POST /customers  |  PATCH /customers/:id  |  DELETE /customers/:id
  Customer: { id, name, phone, email, source, city, bigcommerceCustomerId, notes }. source is
  one of "bigcommerce" | "whatsapp" | "instagram" | "manual" — POST body needs a source
  dropdown with exactly these 4 options (defaults to "manual" if omitted). city is the
  customer's location (populated automatically from BigCommerce's billing address for synced
  orders; optional free-text field for manually-added customers). Real BigCommerce customers
  now get created automatically by the order webhook — this endpoint is for manually adding a
  customer yourself (e.g. a WhatsApp/Instagram DM sale).

GET  /products  |  POST /products  |  PATCH /products/:id  |  DELETE /products/:id
  Product (a saree, the inventory item): { id, name, sku, vendorId, weaverId, stock, unit,
  bigcommerceProductId, notes }. POST body: { name, sku?, vendorId?, weaverId?, stock?, unit?,
  notes? } — vendorId/weaverId are dropdowns sourced from GET /vendors and GET /weavers.

GET  /purchase-orders  |  GET /purchase-orders/:id (includes items)
POST /purchase-orders
  Body: { vendorId, orderDate?, notes?, items: [{ productId, quantity, unitPrice }] }
  This is the "manual Add Purchase" button — every purchase order is created this way (there's
  no auto-generated path yet). vendorId is a dropdown from GET /vendors; each item's productId
  is a dropdown from GET /products.
PATCH /purchase-orders/:id — body: { status? ('pending'|'partial'|'received'|'cancelled'), notes? }
DELETE /purchase-orders/:id

GET  /orders  (optional query: ?status=... or ?source=bigcommerce|manual)
  Order objects now include `customerName` and `customerCity` (flat fields, not nested under
  a `customer` object) — populated automatically for BigCommerce-synced orders, null when
  there's no linked customer (a rare case: an order synced before the guest-checkout fix, or
  a manual order with no customerId given). Use these directly — no separate GET /customers
  lookup needed to show a name on an order.
GET  /orders/:id (includes items, same customerName/customerCity fields)
POST /orders
  Body: { customerId?, status?, notes?, items: [{ productId?, productName, quantity, unitPrice }] }
  Manual order entry (a GPay/DM sale) — always creates source:"manual". BigCommerce orders now
  arrive automatically via a webhook (source:"bigcommerce") — this endpoint never creates those.
PATCH /orders/:id/status — body: { status }. Valid values mirror BigCommerce's own order
  statuses: "incomplete", "pending", "awaiting_payment", "awaiting_fulfillment",
  "awaiting_shipment", "awaiting_pickup", "partially_shipped", "shipped", "completed",
  "cancelled", "declined", "refunded", "partially_refunded", "disputed",
  "manual_verification_required", "verified". This is THE status-change action for every order
  regardless of source — use the same control/button for both BigCommerce-sourced and manual
  orders. Response includes `bigcommerceSyncError` (string or null) — if non-null, the local
  status change still succeeded but pushing it back to BigCommerce failed; show this as a
  dismissible warning next to the (already-updated) status, don't block on it or roll anything back.

GET  /dashboard
  -> { recentSales: [...orders], totalSales, totalSalesThisMonth, orderCount, totalExpenses,
       stockOnHand, pendingOrderCount, topProducts, topRegions }
  totalExpenses is currently always 0 (no expense-tracking source exists yet) — show it as-is,
  don't hide the field. recentSales entries include customerName/customerCity same as GET /orders.
  topProducts is an array (up to 10) of { productName, totalQuantity, totalRevenue }, sorted by
  totalQuantity descending — the best-sellers list.
  topRegions is an array (up to 10) of { city, orderCount, revenue }, sorted by revenue
  descending — orders grouped by the customer's city (from BigCommerce billing address).
  Orders with no linked customer or no city on file are excluded rather than lumped into an
  "unknown" bucket. Show both as simple ranked tables/lists on the dashboard.
```

```
Add the Sitara Bespoke module bundle to the frontend: the company-creation checkbox (step 1
above) plus 4 new screens, all under a "Sitara Bespoke" section in the sidebar (only visible
when at least one of the 4 module keys is enabled for the company, same pattern every other
module's sidebar entry already follows).

1. Sitara Drapes Dashboard — a stat-tile row (recent sales, total sales, total sales this
   month, number of orders, total expenses, stock in hand, pending orders) fed from
   GET /dashboard, plus a simple recent-orders list below it (from the same response's
   `recentSales`).

2. People — one screen with 3 tabs/sub-sections: Weavers, Vendors, Customers. Each is a
   simple list + add/edit/delete form (name required, the rest optional) — Weavers and
   Vendors are identical in shape, Customers additionally has the 4-option source dropdown
   described above.

3. Stocks — one screen with 2 tabs: Inventory (the Products list — name, sku, vendor, weaver,
   stock, unit, with add/edit/delete) and Purchases (purchase order list with a prominent
   "Add Purchase" button opening the vendor + line-items form described in POST
   /purchase-orders above; clicking a PO shows its items).

4. Orders — a list (filterable by status and by source) showing order number, customer,
   status, total, and how long it's been in the current status (compute client-side from
   `statusChangedAt` — no need to wait for a backend "days stale" field). Each row/detail view
   needs a status-change control (dropdown or buttons) calling PATCH /orders/:id/status, and a
   manual "Add Order" button for the GPay/DM case (POST /orders above).

Keep this additive — don't touch any existing module's screens or the company-creation form
beyond adding the one new checkbox.

---

## 16. Sitara Bespoke follow-up — dashboard analytics, customer info on orders

**Status: backend built — updates to the screens from Prompt 15, not new screens.**

**Endpoints** (both already exist from Prompt 15 — these are field additions to their responses):
```
GET  /orders  (and GET /orders/:id, and recentSales inside GET /dashboard)
  Order objects now also include: customerName, customerCity (flat fields, not nested under
  a customer object) — populated automatically for BigCommerce-synced orders. Both are null
  when there's no linked customer (rare: an order synced before a fix, or a manual order with
  no customerId given). Use these directly instead of cross-referencing GET /customers.

PATCH /orders/:id/status
  Valid status values are now the full BigCommerce list, not the shorter one from Prompt 15:
  "incomplete", "pending", "awaiting_payment", "awaiting_fulfillment", "awaiting_shipment",
  "awaiting_pickup", "partially_shipped", "shipped", "completed", "cancelled", "declined",
  "refunded", "partially_refunded", "disputed", "manual_verification_required", "verified".
  If your status dropdown/control only has the original 7 values, update it to this full list.

GET  /dashboard
  Now also returns: topProducts, topRegions.
  topProducts: array (up to 10) of { productName, totalQuantity, totalRevenue }, sorted by
  totalQuantity descending — the best-sellers list.
  topRegions: array (up to 10) of { city, orderCount, revenue }, sorted by revenue descending
  — orders grouped by the customer's city. Orders with no linked customer or no city on file
  are excluded rather than lumped into an "unknown" bucket.

GET  /customers  |  POST /customers  |  PATCH /customers/:id
  Customer objects now also include: city (nullable — populated automatically from
  BigCommerce's billing address for synced customers; a plain optional text field for
  manually-added ones).
```

```
Update the Sitara Bespoke screens built from Prompt 15 — no new screens, just these changes:

1. Orders (list + detail): show the new customerName/customerCity fields directly on each
   order — remove any client-side lookup against GET /customers you may have built to get a
   name, it's no longer needed.

2. Orders: update the status dropdown/control to the full 16-value list above, if it only has
   the original 7.

3. Orders: after PATCH /orders/:id/status, if the response's bigcommerceSyncError is non-null,
   show it as a small dismissible warning next to the (already-updated) status — the status
   change itself still succeeded, this only means the push back to BigCommerce failed.

4. Dashboard: add two new sections — "Top Products" (topProducts, ranked list/table) and "Top
   Regions" (topRegions, ranked list/table) — same simple stat-tile/list style as the existing
   dashboard sections.

5. Customers screen: optionally show the new city field per customer (not required for
   anything else to function).

Keep this additive — don't change anything about the screens beyond what's listed above.
```

---

## 17. Sitara Bespoke — live updates without refreshing

**Status: no backend change needed — every write already emits a socket event, same room
(`io.to(company.slug)`) your other modules already use. This is purely wiring the Sitara
screens up to listen, the same way your other modules' screens presumably already do.**

**Events already emitted** (payload is the same shape `GET`/`POST`/`PATCH` for that resource
already returns):
```
sitara:weaver_created / sitara:weaver_updated / sitara:weaver_deleted   (deleted payload: { id })
sitara:vendor_created / sitara:vendor_updated / sitara:vendor_deleted   (deleted payload: { id })
sitara:customer_created / sitara:customer_updated / sitara:customer_deleted (deleted payload: { id })
sitara:product_created / sitara:product_updated / sitara:product_deleted (deleted payload: { id })
sitara:po_created / sitara:po_updated / sitara:po_deleted (purchase orders; deleted payload: { id })
sitara:order_created / sitara:order_updated
```

```
Wire the Sitara Bespoke screens (Dashboard, People, Stocks, Orders) up to the same socket.io
room every other module's screens already join for this company. Look at how an existing
screen (e.g. Sales or CRM) subscribes to its own events and updates its local state/re-fetches
— apply the exact same pattern here for the sitara:* events listed above, so:

- Weavers/Vendors/Customers/Products lists update live on create/update/delete.
- Purchase orders list updates live on create/update/delete.
- Orders list/detail updates live on create/update (there's no order-delete event — orders
  aren't deletable through the UI).
- Dashboard numbers (totals, recent orders, top products/regions) refresh when an order or
  product event comes in — either by re-fetching GET /dashboard on the relevant events, or by
  patching state locally if that's the pattern already used elsewhere.

Don't change how any other module's real-time updates work — this is only adding the missing
Sitara subscriptions.
```

---

## 18. Sitara Bespoke — Razorpay reconciliation section

**Status: backend built (webhook + backfill both in place) — needs a real payment run through
before the matching logic is fully verified (see chat) — frontend change required, new section.**

**Endpoint:**
```
GET  /razorpay-payments
  -> [ { id, razorpayPaymentId, amount, status, orderId, matched, orderNumber, customerName,
         customerEmail, capturedAt, createdAt }, ... ]
  Every known Razorpay payment, newest first. `matched` is true when it's been linked to a
  real sitara_orders row (matching is done by customer email/phone + amount, not a direct
  order reference — Razorpay itself doesn't carry one). When matched: orderNumber/
  customerName/customerEmail are populated. When NOT matched (matched: false, those three
  null) — that's the actual "did we miss a sale" signal: a real payment came through Razorpay
  with no corresponding order in the system.
```

```
Add a new "Razorpay" section to Sitara Bespoke (sidebar, alongside Dashboard/People/Stocks/
Orders), fed from GET /razorpay-payments.

Show it as a list/table: payment id, amount, status, captured date, and a clear visual
distinction between matched and unmatched rows — e.g. matched rows show the linked order
number + customer name; unmatched rows show something like "⚠ No matching order found" in a
warning color, since these are the ones that actually need someone to look into (a real
payment with nothing recorded against it — possibly a manual/DM sale that was paid via this
same Razorpay account but never entered into Sitara Bespoke, or a sync gap).

Sort or filter so unmatched payments are easy to find (e.g. a "Show unmatched only" toggle,
or just sort unmatched-first) — that's the primary reason this section exists.

Keep this additive — a new section, not a change to any existing screen.
```

---

## 19. Sitara Bespoke — logic change: purchase orders now use Weavers, Razorpay/Orders regrouped under a new "Business" section with Expenses

**Status: backend built — this changes the meaning of an existing field (Purchases) and asks
for a sidebar regroup, not just new additive screens. Read carefully before implementing.**

**Why:** stock purchases are made from weavers (who supply the sarees), not vendors. Vendors
are for unrelated business expenses — electricity, rent, anything else — which is a brand new
feature. Since Orders and Razorpay are both "money coming in/reconciliation" concerns and
Expenses is "money going out", all three now live together under one new **"Business"**
sidebar section, replacing the standalone "Orders" and "Razorpay" entries from Prompts 15/18.

**1. Breaking field change — Purchases (Stocks section, from Prompt 15 #3):**
The "Add Purchase" form and purchase-order list now use a **Weaver** dropdown (from
GET /weavers), not a Vendor dropdown.
```
POST /purchase-orders
  Body: { weaverId, orderDate?, notes?, items: [{ productId, quantity, unitPrice }] }
  (was `vendorId` — rename the field and swap the dropdown's data source to GET /weavers)

GET /purchase-orders  |  GET /purchase-orders/:id
  Purchase order objects now have `weaverId` instead of `vendorId` — show the weaver's name
  (looked up from GET /weavers) wherever the vendor name used to be shown.
```
Vendors are unaffected everywhere else (People section, Prompt 15 #2 — unchanged) — they're
just no longer used for purchases.

**2. New: Expenses**
```
GET  /expenses  |  POST /expenses  |  PATCH /expenses/:id  |  DELETE /expenses/:id
  Expense: { id, vendorId, category, description, amount, expenseDate, createdBy, createdAt,
             updatedAt }.
  POST body: { vendorId, category, description?, amount, expenseDate? }
    - vendorId: dropdown from GET /vendors (required)
    - category: free-text field, NOT a fixed dropdown — e.g. "Electricity", "Rent", "Repairs",
      whatever the user types (placeholder examples are fine, but don't restrict input)
    - description: optional free-text notes
    - amount: required number
    - expenseDate: optional, defaults to today if omitted
  Real-time: sitara:expense_created / sitara:expense_updated / sitara:expense_deleted socket
  events on the company room, same pattern as every other Sitara real-time event from Prompt 17.
```

**3. Sidebar regroup — new "Business" section:**
Replace the standalone "Orders" (Prompt 15 #4) and "Razorpay" (Prompt 18) sidebar entries with
one **"Business"** section containing three tabs:
- **Orders** — exactly the screen from Prompt 15 #4 (no endpoint changes), just moved here.
- **Razorpay** — exactly the screen from Prompt 18 (no endpoint changes), just moved here.
- **Expenses** — new tab: a list (sortable/filterable by date or category) + add/edit/delete
  form per the Expenses endpoints above. Show vendor name (looked up from GET /vendors), not
  just the raw ID.

Final sidebar shape for Sitara Bespoke: Dashboard, People, Stocks, **Business** (Orders /
Razorpay / Expenses tabs). Dashboard's `totalExpenses` stat (Prompt 15, currently hardcoded to
0) can now be wired to a real sum of GET /expenses amounts if convenient, but that's optional —
not a backend contract change either way.

---

## 20. BUG — sidebar shows modules a custom role doesn't have permission for

**Status: backend needs no changes — confirmed via direct DB inspection that this is a
frontend nav-filtering bug, not a data/config problem. Affects every company using custom
roles, not just Sitara — found there by accident.**

**Repro (real data):** A custom role named "Sitara drapes users" has
`permissions: ["attendance","messages"]` (confirmed straight from the `custom_roles` table —
GET `/api/:slug/roles` returns the same thing: `[{ id, name, permissions: [...] }, ...]`). A
user assigned that role (their `role` field holds the custom role's `id`, e.g. `"r17888..."`,
not a builtin string like `"superadmin"`) still sees **both** "Dashboard" and "Sitara Bespoke"
in the sidebar — neither of which is in that role's permissions list at all.

**Root cause:** the backend has no per-route permission enforcement tied to
`custom_roles.permissions` — it only gates by the company's `enabled_modules` (via
`requireModule`), which is intentional (module gating is a company-wide setting; permission
scoping within that is meant to be handled by the frontend UI only, for know-your-nav /
UX purposes). So the sidebar must currently be computing visible nav items from
`enabled_modules` alone, ignoring the logged-in user's own role's permission list.

**Fix:** wherever the sidebar decides which nav items to render, it needs to intersect two
things, not just check `enabled_modules`:
1. The company's `enabled_modules` (already being checked, keep this).
2. The current user's own permission set:
   - If `user.role === 'superadmin'` (or whatever the builtin top role's exact value is), skip
     this check entirely — superadmins should always see everything enabled_modules allows.
   - Otherwise, `user.role` is a custom role's `id` — look it up via GET `/api/:slug/roles`
     (fetch once, e.g. on login/app-load, and cache in whatever global user/auth state already
     holds the logged-in user) to get that role's `permissions` array, and only show a nav item
     if its module key is in BOTH `enabled_modules` AND that role's `permissions`.

Test with the exact repro above: log in as a non-superadmin user whose custom role only has
`["attendance","messages"]` — after the fix, only Attendance, History, and Messages should
appear in the sidebar, nothing else, regardless of what the company has enabled overall.
