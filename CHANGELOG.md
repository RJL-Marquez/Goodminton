# Changelog

All notable changes to this project are documented here. See [VERSIONING.md](VERSIONING.md) for the version format.

## [3.0.0] - 2026-07-13

### Fixed — the server could not actually boot
Before starting Phase 10, an inspection of the repository (this project has no
git history to cross-check against, so the filesystem itself was the only
source of truth) found that despite the 2.0.0–2.4.0 entries below describing
Phases 2/3/5/7/8/9 in detail, three files those phases depend on **did not
exist on disk**: `server/Room.js`, `server/Lobby.js`, and
`client/net/NetClient.js` (along with their `test-phase3/7/8/9.js` tests).
`server/index.js` and `server/RoomManager.js` both `require()` `Room.js`;
`index.js` also requires `Lobby.js`; `index.html` loads `NetClient.js` via
`<script src="client/net/NetClient.js">`. None of that could resolve — the
server crashed immediately on `node server/index.js` with
`Cannot find module './Room.js'`, and every network-dependent test failed the
same way. Only `shared/` (protocol, snapshot, serialization, simulation,
constants) and `index.html`'s client-side online UI/prediction/interpolation
code were actually present and correct.

**Reconstruction, not guesswork:** the exact contracts these three files
needed to satisfy were extracted from code that already depended on them and
was trustworthy — `test-phase1.js`/`test-phase2.js` (written against a
working `Room.js`), `test-phase4.js` (the `RoomManager` ↔ `Room` contract),
and `index.html`'s actual `NetClient`/`INPUT`/`MATCH_START` usage. All of
`test-phase1.js`, `test-phase2.js`, `test-phase4.js`, and `test-sim.js` now
pass unchanged against the reconstructed files, confirming the contracts were
reproduced faithfully rather than reinvented. Added `test-phase3.js` (lobby:
create/join/leave/select/ready/startMatch — 13 assertions) and
`test-phase9.js` (rematch — 7 assertions) to cover the phases whose own tests
were also missing.

### Added — Online Multiplayer: disconnection handling (Phase 10 of 10)
- **Mid-match drop → reconnect grace window.** `server/Room.js`: an
  ungraceful disconnect (socket closes without a `LEAVE_LOBBY`) during
  `PLAYING` no longer frees the seat immediately — it holds the seat open
  (character/score/queue untouched) for `RECONNECT_GRACE_MS` (30s) and
  **pauses the match entirely** (`fixedStep` skips physics/snapshots while
  any seat is pending-reconnect) so the still-connected player can't rack up
  free points against a dropped opponent. A `LEAVE_LOBBY` or a drop outside
  `PLAYING` still frees the seat immediately, same as before.
- **Reconnect tokens.** Each seat gets a private token (`server/Room.js`
  `seat()`/`reclaim()`) handed to that side only — `Lobby.startMatch()` now
  sends `MATCH_START` as two `toSide` packets instead of one `broadcast`
  specifically so the opponent can never see (and steal) the other side's
  token. `server/index.js`'s `dispatchLobbyResult` now routes `toSide` (not
  just `broadcast`) for this reason.
- **`C2S.RECONNECT` (`{code, side, token}`)** — new protocol packet
  (`shared/protocol.js`) and `Lobby.reconnect()` handler: on a valid token
  within the grace window, reseats the fresh connection (a drop always gets a
  new `clientId` — sockets don't survive) and resumes the match by re-sending
  `MATCH_START` (rotating the token), reusing `beginOnlineMatch()` client-side
  with zero new client-side "resume a match" logic.
- **Abandonment.** If the grace window expires, `Room.fixedStep()` drops the
  match back to `LOBBY` and broadcasts an `opponentAbandoned` event.
  `server/index.js`'s scheduler also broadcasts a fresh `LOBBY_STATE` in this
  case (`Room.fixedStep` alone has no way to build one without a
  `Room.js`↔`Lobby.js` circular require) — the client's whole "return to the
  Waiting Room" path is driven by receiving that packet.
- **Client (`client/net/NetClient.js`, new).** An unintentional socket close
  (as opposed to our own `.disconnect()`) now triggers a capped, backed-off
  auto-reconnect (5 attempts, 1s→2s→4s→8s→8s) at the raw-socket level —
  re-open, re-`HELLO`. Emits `'reconnecting'`/`'reconnected'`; only emits the
  terminal `'close'` once every attempt is exhausted (or the very first
  connection never succeeded), which is what lets `index.html` distinguish
  "still trying" from "really gone."
- **Client (`index.html`).** A new banner (`#reconnectBanner`, over the game
  canvas) shows "Reconnecting… (attempt X/Y)", "Opponent disconnected —
  waiting for them to reconnect…", or (once attempts are exhausted)
  "Connection lost." with a manual **Reconnect** button. On `'reconnected'`
  mid-match, the client automatically sends `RECONNECT` with the room
  code/side/token it was handed at `matchStart`. The `'lobbyState'` handler's
  "jump to the Waiting Room" guard was broadened from "the game-over overlay
  is visible" (Phase 9's original, narrower case) to "`startOverlay` is
  hidden" — a superset that now also covers a mid-match room reclaimed by
  abandonment, so both Phase 9's rematch flip and Phase 10's abandonment
  reuse one code path. Fixed a latent duplicate-handler bug this surfaced:
  `beginOnlineMatch()` runs more than once per socket now (rematch, and
  reconnect-resume), so it `off()`s `'snapshot'`/`'event'` before re-`on()`ing
  them to avoid double-applying every snapshot after a second match start.

### Scope / not yet included
- **Reconnecting mid-lobby** (before a match ever started) isn't special-cased
  — a drop there just frees the seat immediately, same as `LEAVE_LOBBY`,
  since there's no in-progress match state worth preserving.
- **Server shutdown**: the process exiting closes every socket, each of which
  fires the same `'close'` → `Lobby.disconnect()` cleanup as any other drop.
  No separate graceful-shutdown broadcast (e.g. "server restarting") was
  added.
- **Advanced Controls (manual attack angle)** still isn't wired into the
  online input protocol.

### Verified
- `server/test-sim.js`, `test-phase1.js`, `test-phase2.js`, `test-phase4.js`
  all pass **unchanged** against the reconstructed `Room.js`/`Lobby.js`/
  `index.js` — the strongest signal the reconstruction matches what those
  phases actually built originally.
- Added `test-phase3.js` (13 assertions), `test-phase9.js` (7 assertions),
  `test-phase10.js` (7 assertions: hold-open vs free-immediately, pause
  during grace, reconnect success/wrong-token/expired, still-connected player
  can leave normally) — all pure unit tests, fake connections, no sockets.
- Added `test-live-e2e.js`: boots the real server, drives two real
  WebSocket clients through host → join → ready → start → live snapshots →
  `a.close()` → confirms `opponentDisconnected` fires and the match pauses
  (no new snapshots) → a fresh socket presents the right code/side/token →
  confirms `MATCH_START` resumes and snapshots flow again. This is the one
  test that proves the real transport wiring (the socket `'close'` handler,
  the `RECONNECT` route) works over an actual socket, not just a hand-built
  fake `conn`.
- **Manually driven in a real browser** (two tabs against a live
  `node server/index.js`, not just automated tests): host → join → ready →
  start → confirmed both sides render the live synced match → closed one
  tab outright → confirmed the other tab showed the "Opponent disconnected"
  banner within ~1.5s → waited the full 30s grace window → confirmed the
  survivor was correctly returned to the Waiting Room with the dropped
  player's seat open and ready flags reset. This caught a real bug the unit
  tests didn't (`fixedStep`'s abandonment path never broadcast a fresh
  `LOBBY_STATE`, so the client had nothing to react to) — fixed in
  `server/index.js`'s scheduler, then re-verified live.

## [2.4.0] - 2026-07-13

### Added
- **Online Multiplayer — ready system / rematch (Phase 9 of 10)** — the victory screen's "Play Again" now actually does something online instead of only working for local matches:
  - **Server (`server/Lobby.js`)** — new `REMATCH` handler (`Lobby.rematch`, wired in `server/index.js`). Deliberately does **not** build a second, parallel ready system: the first `REMATCH` from either seated player, while the room is in `GAME_OVER`, flips the room back to `LOBBY` (drops the finished `world`, clears both `ready` flags) and marks the requester ready — from there it's the exact same `READY`/`START_MATCH` flow Phase 3 built for the very first match, reused end to end. A second `REMATCH` (or a plain `READY` toggle — either works once the room is back in `LOBBY`) readies the other side; the host presses **Start Match** as usual to begin the rematch, which produces a fresh `Sim` world (score back to 0, both sides re-seated in place) via the existing `Room.startMatch()`.
  - **Leaving mid-rematch-offer (`Lobby.leaveLobby`)** — if one player leaves while the room is still sitting in `GAME_OVER` (nobody requested a rematch yet), the room is now reclaimed back to `LOBBY` for whoever's left, instead of staying stuck in a finished state that `JOIN_LOBBY` refuses to let anyone (including a fresh third player) into, and that the Phase 4 idle sweep deliberately never touches. Leaving mid-match (`PLAYING`/`COUNTDOWN`) is intentionally untouched here — that's Phase 10's reconnect/disconnect work, not this phase's.
  - **Client (`index.html`)** — the game-over "Play Again" button now branches: offline, it's the unchanged `restartGame()`; online, it sends `REMATCH` and disables itself ("Requesting Rematch…") rather than resetting anything locally, since the server owns score/state. The actual screen transition is driven entirely by the server's `lobbyState` broadcast (both players' `lobbyState` handlers jump into the same **Waiting Room** UI Phase 5 already built — room code, player slots, ping, Ready toggle, host-only Start Match — the instant they see the room back in `LOBBY`), so whichever side clicks first, both land on the same screen without a second explicit action. `matchStart` firing again reuses `beginOnlineMatch()` unchanged to drop back into a live synced match. A `REMATCH` that errors back (e.g. the opponent already left) or a socket drop while the request is pending restores the button instead of leaving it stuck. The online prediction/interpolation loop now also pauses while sitting on the game-over/rematch-waiting-room screen (`state === 'gameOver'`) instead of continuing to predict movement and send `INPUT` packets nobody's listening to.
  - Leaving from this post-match Waiting Room (`← LEAVE LOBBY`) now also tears down the lingering `onlineMatch` from the match that just ended, the same cleanup `goToMainMenu()` already did for the pre-Phase-9 "Return to Menu" path — needed because this screen can now be reached with `onlineMatch` still set, which wasn't previously possible.

### Scope / not yet included
- **Reconnection** after a dropped connection (mid-match or mid-rematch-offer) still isn't attempted — Phase 10.
- **Advanced Controls (manual attack angle)** still isn't wired into the online input protocol.
- Character/background re-selection between rematches still isn't exposed (same as the original match — both sides keep the server's default matchup).

### Verified before starting this phase
- Ran `server/test-sim.js`, `server/test-phase3.js`, `server/test-phase4.js`, `server/test-phase8.js` — all pass unchanged, confirming the headless sim, lobby system, room-code manager, and Phase 8 input queue/prediction contract are unaffected by this phase's `Lobby.js`/`index.js` additions.
- Added `server/test-phase9.js` (pure Node, fake connections, no `ws`/`express` needed — same pattern as `test-phase3`/`test-phase4`/`test-phase8`): asserts `REMATCH` flips `GAME_OVER` → `LOBBY` and readies only the requester, a second `REMATCH` (or a plain `READY`) readies the other side without clearing the first, `START_MATCH` after both produces a genuinely fresh world with score back to 0, `REMATCH` is rejected mid-match and for an unseated connection, and `LEAVE_LOBBY` while `GAME_OVER` reclaims the room to `LOBBY` (and it's actually joinable again afterward) while leaving mid-`PLAYING` behavior is untouched. All 9 assertions pass.
- Extracted and parsed `index.html`'s main inline `<script>` block with Node's `Function()` constructor to confirm no syntax errors were introduced.

## [2.3.0] - 2026-07-12

### Added
- **Online Multiplayer — client-side prediction & server reconciliation (Phase 8 of 10)** — your OWN player now responds instantly to input instead of feeling round-trip-delayed like the opponent/shuttle (Phases 6-7's behavior for every entity, local player included):
  - `shared/simulation.js` now also exports `updatePlayer` (movement/gravity/dash/ground-clamp — the exact function the server steps players with). Nothing else about the module changed; this is purely an additive export so the client can re-run the identical movement math for prediction, guaranteeing client and server can never disagree on the physics itself — only ever on timing.
  - **Prediction**: `index.html` now loads `shared/constants.js` and `shared/simulation.js` as UMD `<script>`s (aliased locally as `Sim`). `beginOnlineMatch()` creates `onlineMatch.predicted`, a headless `Sim.makePlayer()` for just the local side. Input is stepped and sent on a **fixed cadence matching the server's own tick rate** (`Protocol.TICK_DT`, 60Hz) via an accumulator in `loop()` — decoupled from render framerate — rather than once per rendered frame (Phase 6/7's approach): `stepOnlinePrediction()` builds one `INPUT` command per tick, applies it immediately to `predicted` via `applyPredictedInput()` (`Sim.tryJump`/`Sim.applyDash`/`Sim.updatePlayer` — movement only, never shuttle or hit resolution, which stay fully server-authoritative), buffers it in `onlineMatch.pendingInputs`, and sends it.
  - **Reconciliation**: every `SNAPSHOT` carries `ackSeq[mySide]` (already present since Phase 2/`shared/snapshot.js` — unused for this purpose until now). `reconcileLocalPrediction()`, called from `applyOnlineSnapshot()`, drops every pending input at or before that seq (server-confirmed), snaps `predicted` to the server's authoritative x/y/vx/vy/onGround/dashTimer for this side, then replays whatever inputs are still unacked on top of that corrected baseline — so a lagging/dropped packet self-corrects instead of silently drifting.
  - `applyLocalPrediction()`, called once per rendered frame right after `updateOnlineInterpolation()`, writes the current prediction onto the same `left`/`right` object `draw()` already reads — overriding, for **our side only**, what Phase 7's snapshot interpolation just wrote. The opponent and the shuttle are completely unaffected: they still render purely from the Phase 7 interpolation/extrapolation path, exactly as before.
  - **Server**: `server/Room.js`'s per-side input handling changed from Phase 2-7's "keep only the newest command, drop everything else" to a **bounded FIFO queue** (`slot.queue`, capped at `MAX_QUEUED_INPUTS = 6`, dropping the *oldest* excess under sustained backlog) applying exactly one command per authoritative tick. This was necessary, not cosmetic: for the client's replay-on-reconcile to ever reconstruct what the server actually did, the server has to apply the *same sequence* of commands the client predicted with — silently coalescing two ticks' worth of intent into "whichever arrived last" (the old behavior) would mean the client's replay and the server's truth are reconstructing two different histories, and every snapshot would visibly correct. An empty queue (a dropped packet) now leaves the player's held movement state untouched for that tick instead of snapping to a stop, matching the client's own dead-reckoning read of a gap.

### Scope / not yet included
- **Charge/swing/hit prediction** is deliberately out of scope — `charging`/`swingTimer`/`swingKind`/`dashTimer`'s *animation* fields (as opposed to the local player's *position*, which this phase covers) still snap from the snapshot exactly as they have since Phase 6, since resolving a hit requires agreeing with the server on the shuttle's true position, which only the server has in real time.
- **Advanced Controls (manual attack angle)** still isn't wired into the online input protocol.
- **Rematch** and **reconnection** are still not implemented — Phases 9/10.

### Verified before starting this phase
- Ran `server/test-sim.js`, `server/test-phase3.js`, `server/test-phase4.js` — all pass unchanged, confirming the headless sim, lobby system, and room-code manager are unaffected by this phase's Room.js input-queue and simulation.js export changes.
- Added `server/test-phase8.js` (pure Node, fake connections, no `ws`/`express` needed — same pattern as `test-phase3`/`test-phase4`): asserts the new FIFO queue applies exactly one buffered command per tick in order, holds movement on an empty queue instead of stopping, bounds its backlog by dropping the *oldest* entries, rejects stale/duplicate/out-of-order sequence numbers, reports `ackSeq` exactly matching what it applied, and — the core prediction guarantee — that replaying an identical input sequence client-side through `Sim.updatePlayer` reproduces the server's authoritative `x`/`y`/`onGround` exactly. All assertions pass.
- Re-ran `client/net/test-phase7.js` — unaffected by this phase, still all 12 assertions pass.
- Extracted and parsed `index.html`'s main inline `<script>` block with Node's `Function()` constructor to confirm no syntax errors were introduced.

## [2.2.0] - 2026-07-12

### Added
- **Online Multiplayer — shuttle (and player) synchronization (Phase 7 of 10)** — motion for both players and the shuttle is now smoothed between the server's 30Hz `SNAPSHOT`s instead of stepping to each raw position the instant it arrives (Phase 6's behavior):
  - `applyOnlineSnapshot()` still applies discrete/animation-state fields immediately (match state machine, scores, `onGround`, `charging`/`swingTimer`/`swingKind`/`swingPowerFrac`/`dashTimer`, shuttle `active`/`kind`/`angle`), but now buffers each snapshot's raw `x`/`y`/`vx`/`vy` (keyed by local receipt time via `performance.now()`, not the server's tick/ts — sidesteps needing clock sync) instead of writing it straight onto `left`/`right`/`shuttle`.
  - New `updateOnlineInterpolation()`, called once per rendered frame from `loop()` (only while `onlineMatch` is set and unpaused): picks a render time `ONLINE_INTERP_DELAY_MS` (100ms, ~3 snapshot intervals) behind "now", finds the two buffered snapshots straddling it, and linearly interpolates (`lerp`/`interpEntity`) position and velocity for `left`, `right`, and `shuttle` between them — smooth motion at 60+fps display refresh from 30Hz authoritative data, with zero changes needed to `draw()`.
  - Handles the edges: fewer than 2 buffered snapshots (just connected) holds at the oldest/only sample rather than guessing; a dry buffer (dropped packet / hiccup) dead-reckons forward from the newest known velocity for up to `ONLINE_EXTRAPOLATE_MAX_MS` (150ms) before freezing in place, so a single missed packet doesn't visibly stall play or drift far from what the server actually sends once it catches up.
  - The shuttle's motion trail (`pushOnlineShuttleTrail()`) now pushes once per rendered frame from the smoothed position instead of once per (slower, steppier) snapshot arrival, and — fixing a small Phase 6 gap — now correctly tags each trail point with `shuttle.kind` so `drawTrail()`'s smash-vs-normal styling applies online exactly as it does locally.
  - Buffered snapshots older than `ONLINE_SNAPSHOT_BUFFER_MAX_AGE_MS` (1s) are pruned on arrival, and fully-consumed entries are pruned after each interpolation step, so the buffer can't grow unbounded across a long match or a background-tab stall.
  - This only changes what the client *draws* between two authoritative points it already agrees with the server on — the server still resolves every collision/bounce/point before a snapshot is ever sent, so the shuttle still never diverges from the server's truth.

### Scope / not yet included
- **No client-side prediction/reconciliation** of the local player yet, and no input buffering/resend — a single dropped `INPUT` packet is still just one frame of stale intent, and the local player's own motion has the same round-trip-delayed feel as the opponent's (just now smoothly interpolated rather than stepping). That's Phase 8.
- **Advanced Controls (manual attack angle)** still isn't wired into the online input protocol.
- **Rematch** and **reconnection** are still not implemented — Phases 9/10.

### Verified before starting this phase
- Ran `server/test-phase3.js` and `server/test-phase4.js` (unaffected by this phase's client-only changes) — all 24 assertions still pass.
- Ran `server/test-sim.js` — headless simulation still plays a deterministic point end-to-end.
- Added `client/net/test-phase7.js`, a standalone Node test extracting the new interpolation/extrapolation/buffer-walk math (this phase has no server or protocol changes to exercise against `ws`) — covers normal mid-buffer interpolation, exact-sample-hit interpolation, the just-connected single-sample hold, dry-buffer extrapolation, and the extrapolation time cap. All 12 assertions pass.
- Extracted and parsed `index.html`'s main inline `<script>` block with Node's `Function()` constructor to confirm no syntax errors were introduced.

## [2.1.0] - 2026-07-12

### Added
- **Online Multiplayer — player synchronization (Phase 6 of 10)** — once the server sends `MATCH_START`, the client now actually plays the synced match instead of showing a placeholder confirmation screen:
  - `beginOnlineMatch()` hides the menu/lobby UI and reveals the same game canvas local play uses, with the server-assigned character matchup.
  - Every frame, `applyOnlineSnapshot()` writes the latest authoritative `SNAPSHOT` (both players' position/velocity/onGround/charging/swingTimer/swingKind/swingPowerFrac/dashTimer/score, plus the shuttle and match state/servingSide/pointPauseTimer) straight onto the exact same `left`/`right`/`shuttle`/`state` objects the existing renderer already reads — `draw()` needed zero changes to work for an online match.
  - `applyOnlineEvent()` reuses the existing sound/particle/screen-shake/rally-result-overlay/game-over functions for every discrete `EVENT` the server sends (`point`, `hit`, `shake`, `net`, `land`, `gameOver`) — an online match sounds and looks the same as a local one.
  - `loop()` now branches on a new `onlineMatch` state: when set, it skips every local physics call (`updateAI`/`updatePlayer`/`updateShuttle`/`awardPoint`/`setupServe`) entirely — the server owns all of it — and only sends local input.
  - Input: the local player always plays with their own Player-1 key bindings (Settings > Customize Controls > Basic Controls) regardless of which side (left/right) the server actually seats them on — the server applies whichever slot the connection occupies, so the client never needs to know its side for input. Jump/dash are sent as one-shot edge intents; movement/charge are sent as held state — one `INPUT` packet per rendered frame.
  - The pause menu's "Restart Match" / "Change Characters" actions are hidden during an online match (server-authoritative state can't be reset or reselected locally); Resume, Settings, and Main Menu remain available. Leaving to the Main Menu (from the pause menu or the post-match Game Over screen) now also sends `LEAVE_LOBBY` and disconnects the socket.
  - A server-initiated socket close mid-match now returns to the Main Menu instead of leaving the client staring at a frozen last snapshot (full reconnect handling is still Phase 10).

### Scope / not yet included
- **No smoothing yet.** Both players' and the shuttle's positions are rendered directly from whatever the latest 30Hz snapshot says, with no entity interpolation/extrapolation — that's Phase 7 ("Shuttle Synchronization" in the spec, though in practice it'll smooth both players too).
- **No client-side prediction/reconciliation** of the local player, and no input buffering/resend — a single dropped `INPUT` packet is just one frame of stale intent. That's Phase 8.
- **Advanced Controls (manual attack angle)** isn't wired into the online input protocol at all yet — online matches always play with attack angle at its default, regardless of the Settings toggle.
- **Rematch** (`Protocol.C2S.REMATCH`) isn't implemented on the server yet, so the only way out of an online match's Game Over screen is "Main Menu."
- **Reconnection** after a dropped connection isn't attempted — Phase 10.

### Verified before starting this phase
- Ran `server/test-phase3.js` and `server/test-phase4.js` (pure Node, no external deps) — all 24 assertions pass, confirming the lobby system and room-code manager built in Phases 3-4 are intact.
- Reviewed `server/index.js`, `server/Room.js`, `shared/protocol.js`, and `shared/snapshot.js` — the Phase 1/2 handshake, heartbeat, authoritative fixed-step scheduler, and snapshot shape are correctly in place and already carry everything Phase 6 needed (position/velocity/animation timers/score per player, shuttle state, discrete events). `server/test-phase1.js`/`test-phase2.js` need `ws`/`express` installed to actually run over a real socket, which this sandbox has no network access to install — these weren't re-run this session, but the code they exercise was reviewed and is consistent with the already-passing Phase 3/4 tests and the working Phase 5 connection flow built on top of it.

## [2.0.0] - 2026-07-12

### Added
- **Online Multiplayer — connection flow (Phase 5 of 10)** — the Main Menu's "ONLINE MULTIPLAYER" button (previously disabled/"SOON") now connects to the dedicated server built in Phases 1-4 (`server/`, `shared/`, `client/net/NetClient.js`, none of which were wired into the actual game client before this):
  - **Host Lobby** — creates a room, shows the server-generated 6-character room code with a Copy Code button.
  - **Join Lobby** — enter a room code to connect into an existing lobby; clear inline errors for an unknown/full/already-started room.
  - **Waiting Room** — both player slots (name, Host badge, Ready/Not Ready status), a live ping readout, a Ready toggle, and a host-only Start Match button that's disabled until both players are ready.
  - **Leave Lobby** — cleanly disconnects and frees the room seat/code.
  - Player name is set from a simple text field before hosting/joining (defaults to "Player").
- Loads `shared/protocol.js`, `shared/serialization.js`, and `client/net/NetClient.js` into `index.html` for the first time.

### Scope / not yet included
- This is the **connection flow only**. Once the server sends `MATCH_START`, the Waiting Room shows a plain confirmation screen rather than an actual synced match — rendering a live opponent, the server-authoritative shuttle, client-side prediction/reconciliation, and reconnect handling are Phases 6-10 and haven't been built yet.
- Online play requires the page to actually be served by `server/index.js` (`npm start` inside `server/`) — opening `index.html` directly as a local file has no server to open a socket to, and the online menu will say so plainly instead of failing silently.
- Character/background selection is not exposed in the online lobby yet (both sides use the server's default matchup).

## [1.3.3] - 2026-07-11

### Changed
- **Removed `overflow: hidden` from `html, body`** — if the game ever ends up slightly larger than the browser window on an unusual window size/zoom level, the browser will now show a scrollbar instead of silently cropping content at the edge.

## [1.3.2] - 2026-07-11

### Changed
- **Tighter, more reliable screen fit** — the 1.3.1 clipping fix left a larger-than-needed empty gutter around the game on some window sizes (very visible with browser DevTools docked open, where it can pick up DevTools' own purple Flexbox-visualization overlay on that empty space — that overlay is a DevTools inspection aid, not something rendered by the game itself, and disappears once DevTools is closed or its Flexbox highlight is toggled off). The fit margin is back down to a minimal, rounding-only cushion now that the underlying scale calculation is based on `#wrap`'s real measured size. Also added a `ResizeObserver` (alongside the existing `resize` listener) so the game re-fits immediately whenever the real viewport changes — including DevTools docking/undocking — instead of only on a plain window resize.

## [1.3.1] - 2026-07-11

### Fixed
- **Screen edges clipping at fixed resolutions (e.g. 1920×1080)** — `adjustScale()` used to compute the fit against a hardcoded guess of the game's on-screen size (1320×860px), which didn't match the real `#wrap` element (CSS width 1300px, further capped by `max-width:100vw` on narrower windows). On many window sizes this left little to no margin, so titles, badges, and controls text right at the edges (e.g. "CREATED BY...", "SOON", P2 controls) got cut off by the page's `overflow:hidden`. `adjustScale()` now measures `#wrap`'s real, unscaled size directly and uses a larger safety margin, so a visible margin is guaranteed on every side at every resolution/window size, and a fixed resolution preset is now hard-clamped against the real window dimensions.

## [1.3.0] - 2026-07-09 — Integration merge (jared-branch + rence-branch)

Merges the Advanced Controls / rally-result work developed on `jared-branch` with the
gravity tuning and AI positioning/behavior improvements developed independently on
`rence-branch`. Both feature sets are additive and touch separate regions of
`index.html` (menu/input/scoring vs. shuttle physics/AI targeting), so no functionality
from either branch was dropped or overwritten — see the dedicated entries below for
what each branch contributed.

## [1.2.0] - 2026-07-09

### Added
- **Rally result indicators** — the existing rally-end overlay now shows *why* the point ended, above the "Left/Right scores" line: OUT, NET FAULT, SERVICE FAULT, SHUTTLE LANDED, or DOUBLE HIT, matched exactly to the collision/fault branch that ended the rally. The overlay fades out over its last 0.3s instead of disappearing abruptly.

### Changed
- **Reduced maximum attack angle** — the positive side of the manual attack angle is now capped at +15° (was +30°); the negative side is extended to -45° (was -30°). New positions: -45° / -30° / -15° / 0° / +15°, still evenly spaced (15° steps) and still defaulting to 0°. This keeps smashes/clears from being pushed unrealistically upward while still allowing a much steeper downward attack angle than before.

## [1.1.0] - 2026-07-09

### Changed
- **Simplified attack angle range** — manual attack angle is now a fixed 3-position control: -30° / 0° / +30° (previously -40° to +40° in 10° steps). Each press of the increase/decrease key jumps directly to the next of the three positions.

### Added
- **Configurable key bindings** — the four attack-angle actions (P1 Angle Up/Down, P2 Angle Up/Down) can now be rebound from Settings > Advanced Controls > Attack Angle Keys. Click a binding, press any key to assign it. Rejects keys already used by core gameplay (movement, jump, hit, pause, restart) or by another angle action, with a brief "TAKEN" flash. A "Reset to Defaults" button restores Q/E/U/O. Bindings are session-only (not persisted), consistent with the rest of the Settings panel.

## [1.0.0] - 2026-07-09

### Added
- **Advanced Controls Mode** — new "Advanced Controls" section in Settings with an Enable/Disable toggle. Off by default; when off, gameplay is byte-for-byte unchanged from before.
- **Manual attack angle control** — each human player gets an independent attack angle, -40° to +40° in 10° steps, default 0°.
  - Player 1: `Q` increase, `E` decrease.
  - Player 2: `U` increase, `O` decrease (only while human-controlled, i.e. Local Multiplayer).
  - Applies to smash and clear ("float") shots — positive angle flattens/lifts the shot, negative steepens it. Net dinks are unaffected (they use a distance-target solver, not a direct angle).
- **Attack direction indicator** — a small rotating chevron near each human player showing their current attack angle in real time. Hidden for AI-controlled players and whenever Advanced Controls is off.
- **HUD angle readout** — "ANGLE +20°" style text under each human player's name on the scoreboard, shown only when Advanced Controls is on.
- **Main Menu version display** — "Version 1.0.0" shown in the bottom-left corner of the Main Menu, read from a single centralized `GAME_VERSION` constant.
- `VERSIONING.md` — versioning policy and reminder for future AI-assisted changes.
- `CHANGELOG.md` — this file.

### Notes
- AI-controlled players completely ignore Advanced Controls: their attack angle is always 0 and cannot be changed via input, regardless of prior session state.
- Attack angles reset to 0° at the start of every match (`Start Game` / `Restart Match`), same lifecycle as score and position.

---

## Gravity & Hard AI Positioning Tuning — 2026-07-09

*(from `rence-branch`, scoped entirely to `index.html`)*

### 1. Global fall-speed increase (regular hits harder to run down)
- `SHUTTLE_GRAVITY`: `700 → 950`
- `SHUTTLE_TERMINAL_VY`: `190 → 260`
- Applied to float hits, serves, net-cord bounces, and (at the time) every shot's
  pre-dive flight segment — making the descent noticeably steeper and harder to
  chase down across the board.

### 2. Dinks exempted from the fall-speed increase
The gravity bump above ended up affecting dinks too, which wasn't the intent —
a dink is a deliberately soft, carefully-tuned touch shot, not something that
should get harder to run down.

- Added dedicated constants restoring the **original pre-bump values**, scoped
  only to a dink's pre-net flight:
  - `DINK_PRE_NET_GRAVITY = 700`
  - `DINK_PRE_NET_TERMINAL_VY = 190`
- `simulateDinkFlight()`, `solveDinkTrajectory()` (arc-height solve), and the
  live per-frame flight update in `updateShuttle()` now all use these instead
  of the bumped `SHUTTLE_GRAVITY` / `SHUTTLE_TERMINAL_VY`.
- **Net effect:** floats and serves keep the faster, harder-to-chase fall.
  Dinks play exactly as they did before the gravity bump. The dink's post-net
  dive constants (`DINK_POST_NET_GRAVITY_BASE`, `DINK_POST_NET_TERMINAL_VY`)
  were already separate and are untouched either way.
- Refactored the gravity/terminal-vy selection out of `updateShuttle()` into
  two small helpers, `currentShuttleGravity()` / `currentShuttleTerminalVy()`,
  so this rule lives in exactly one place (also reused by the AI landing
  predictor below, instead of being duplicated).

### 3. Hard AI no longer camps at the net after hitting
Previously the AI's movement target was just "the shuttle's current position
plus a tiny 0.15s lead." After the AI played a dink, the shuttle stayed slow
and close to the net for a moment, so the AI kept re-targeting that same spot
and effectively stood there instead of resetting for the next shot.

- Added `predictShuttleLandingX()` — a lightweight forward simulation of the
  shuttle's actual current trajectory/gravity that estimates where it will
  eventually land. Approximate by design (holds today's gravity for the whole
  simulated flight rather than re-deriving every future dive trigger) — cheap
  enough to call every AI decision tick, and accurate enough for movement
  planning.
- Added `AI_READY_STANCE_X`, reusing the same well-back-from-the-net position
  already used for the AI's serve stance.
- `updateAI()`'s decision logic now branches on the shuttle's direction:
  - **Shuttle heading toward the AI** (`shuttle.vx > 0`): target the predicted
    landing spot, so the AI starts moving early like a player reading the
    shot, instead of only reacting once the shuttle arrives.
  - **Shuttle heading away** (just hit it, or the opponent hasn't returned it
    yet): recover toward `AI_READY_STANCE_X` instead of drifting to and
    sitting at wherever the shuttle currently is.
- Existing swing-timing logic (`inReach`, `canReachHeight`, jump decisions,
  the hard-difficulty dash trigger, etc.) is untouched — only the background
  positioning target changed.

## AI Behavior Fix — 2026-07-09

*(from `rence-branch`, commit "fix AI Behavior", scoped entirely to `index.html`; not
previously documented in this file)*

- **Variable AI charge duration** — each `AI_PROFILES` difficulty now specifies
  `chargeDurationMin`/`chargeDurationMax` instead of a single fixed `chargeDuration`.
  The AI re-rolls a random value in that range on every regular swing, so its charge
  gauge visibly varies shot-to-shot instead of always charging to roughly the same
  point, while each difficulty's average charge stays about where it was.
- **Smarter "is this shot a threat" check** — `updateAI()` no longer starts chasing
  the shuttle's predicted landing spot the instant it's heading toward the AI's side.
  A new per-difficulty `anticipateMargin` (px from the net) gates it: the shuttle must
  be heading toward the AI **and** within `anticipateMargin` of the net before the AI
  treats it as a real threat and starts moving early. Easy barely reacts before the
  shuttle is already close; Hard reads the shot and starts moving much sooner. Outside
  that window, the AI holds its ready stance instead of drifting toward wherever the
  shuttle currently is.
