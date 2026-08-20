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
