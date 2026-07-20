# Rally — 2D Badminton

A physics-based 2D badminton game with local play, AI opponents, and a real
**online multiplayer** mode built on a dedicated authoritative server —
private lobbies with Among-Us-style room codes, client-side prediction,
snapshot interpolation, and reconnect handling for dropped connections.

Version **3.0.0** — see [CHANGELOG.md](CHANGELOG.md) for the full history and
[VERSIONING.md](VERSIONING.md) for the versioning policy.

---

## Features

- **Accurate-feeling 2D physics** — gravity, dashes, charged swings, dinks,
  smashes, net cord/service-fault rules, and a proper rally-scoring badminton
  ruleset.
- **8 characters**, each with independent speed / power / control stats that
  actually change movement, swing timing, and hit forgiveness.
- **6 court themes.**
- **Game modes**: Play vs AI (4 difficulties), Local 2-Player (shared
  keyboard), AI vs AI (spectate), and Online Multiplayer.
- **Advanced Controls** (optional) — manual attack angle per player for
  flatter or steeper smashes/clears.
- **Online Multiplayer**, built like an Among Us private lobby rather than an
  MMO: two players, anywhere on the internet, connect with a 6-character room
  code. See [Online multiplayer architecture](#online-multiplayer-architecture)
  below.

## Controls

| | Player 1 | Player 2 (Local Multiplayer only) |
|---|---|---|
| Move | `A` / `D` | `←` / `→` |
| Jump / Smash | `W` | `↑` |
| Hold to charge a hit | `Space` | `Enter` |
| Dash | double-tap move | double-tap move |
| Attack angle (Advanced Controls) | `Q` / `E` | `U` / `O` |

Bindings are rebindable from **Settings → Customize Controls**. `Esc` pauses.

## Getting started

### Solo / local play (no server needed)

The whole game is one static `index.html` plus a few shared `.js` modules —
open it directly in a browser, or serve the folder statically:

```bash
npx serve .
```

Play vs AI, Local Multiplayer, and AI vs AI all work with no server.

### Online multiplayer

Online play needs the dedicated server, which also serves the game itself
(so there's nothing extra to configure — the client connects back to
whatever host it loaded the page from):

```bash
cd server
npm install
npm start
```

Then open `http://localhost:3000` (or your host's URL) in **two** browser
tabs/windows/devices — Host Lobby in one, Join Lobby with the printed code
in the other.

```bash
# custom port
PORT=8080 npm start
```

Deploying: point any Node host (Render, Railway, Fly, a plain VPS) at
`server/index.js` — it serves the static game and the WebSocket endpoint
(`/ws`) from the same origin, so there's no CORS or separate socket URL to
configure.

## Project structure

```
index.html              the entire game client (rendering, input, menus,
                         local physics, and the online-match client layer)
shared/
  constants.js           court/character/tuning constants
  simulation.js           the pure physics/rules engine — used headlessly by
                          the server AND re-used by the client for
                          client-side prediction (see below)
  protocol.js             wire-protocol packet types, tick/snapshot rates,
                          room-code rules — the single source of truth both
                          ends require/load
  snapshot.js              builds the authoritative world snapshot the server
                          streams to clients
  serialization.js         encode/decode packets (JSON today)
server/
  index.js                 HTTP + WebSocket transport, the authoritative
                          fixed-step scheduler, handshake/heartbeat
  Room.js                  one private match: seats, authoritative
                          simulation, input queue, reconnect grace window
  Lobby.js                 lobby rules — create/join/leave/ready/start/
                          rematch/reconnect — never touches a socket directly
  RoomManager.js            room-code generation/uniqueness/expiration
  test-*.js                 test suite (see Development below)
client/net/
  NetClient.js              the browser's WebSocket wrapper — handshake,
                          heartbeat/ping, auto-reconnect with backoff
```

## Online multiplayer architecture

**Dedicated authoritative server.** The server owns score, shuttle physics,
serves, the match timer, collisions, and win conditions. Clients only ever
send *intent* — movement, jump, swing, dash, ready, menu selections — never
game state. `shared/simulation.js` is the one physics implementation; the
server runs it authoritatively and the client re-runs the same function
locally for prediction, so the two can never disagree on the physics itself,
only on timing.

**Private lobbies.** Hosting a lobby generates a unique 6-character room code
from a confusable-free alphabet (no `O`/`0`, `I`/`1`, no vowels — easy to read
aloud). Empty rooms expire after 5 minutes idle; a filled-but-never-started
lobby expires after 30 minutes.

**Tick rates.** The authoritative simulation steps at a fixed 60Hz regardless
of render framerate; the server broadcasts world snapshots at 30Hz. The
client interpolates/extrapolates between snapshots for the opponent and the
shuttle, and separately predicts its own player's movement instantly against
every input, reconciling against the server's authoritative position on each
snapshot (standard client-side prediction + server reconciliation).

**Disconnection handling.** A clean "Leave Lobby" frees the seat immediately.
An unexpected drop mid-match instead holds the seat open for 30 seconds
(pausing the match — no free points for the still-connected player) while
the client automatically retries the connection with backoff; presenting a
private per-seat reconnect token resumes the same match in place. If the
window expires, the match is abandoned and the remaining player is returned
to the Waiting Room.

**Match flow:** Host creates room → code generated → other player joins with
the code → both ready up → host starts → live synced match → victory screen
→ rematch (reuses the same ready/start flow) or back to the lobby.

## Development

The server has a self-contained test suite — pure Node, no build step:

```bash
cd server
npm install
node test-sim.js         # headless physics/rules engine
node test-phase1.js      # handshake + heartbeat (real socket)
node test-phase2.js      # authoritative sim streams snapshots/events (real socket)
node test-phase3.js      # lobby: create/join/leave/select/ready/startMatch
node test-phase4.js      # room codes: generation, uniqueness, expiration
node test-phase9.js      # rematch flow
node test-phase10.js     # disconnect / reconnect grace window
node test-live-e2e.js    # full flow over real sockets, incl. live reconnect
```

For UI/gameplay changes, run the server and actually play a match in two
browser tabs/windows before calling a change done — automated tests cover
protocol correctness, not how it feels or looks.

## Credits

Created by Rence Joseph Marquez. See [CHANGELOG.md](CHANGELOG.md) for the
full contribution history, including the gravity/AI-positioning tuning and
Advanced Controls work merged from parallel branches.
