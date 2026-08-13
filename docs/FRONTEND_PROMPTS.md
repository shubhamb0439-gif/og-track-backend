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
`README.md`'s "Voice — ElevenLabs TTS" section for the full backend design if you want
the context; this prompt only needs the contract below.

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
`README.md`'s "Voice UX tuning" section). Verified live: cancelling a real in-flight
reply produced zero further audio chunks, even for a long multi-sentence answer.

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
