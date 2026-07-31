/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * server/index.js
 * ---------------
 * The dedicated authoritative server, run as ONE Node process that both:
 *   1. serves the static game (index.html, shared/, client/) over HTTP, and
 *   2. hosts the WebSocket endpoint the clients connect to for multiplayer.
 *
 * Serving both from the same process/origin means "works over the internet"
 * needs exactly one thing deployed (Render / Railway / Fly / a VPS) and there is
 * no CORS or cross-origin socket URL to configure — the client just opens a
 * socket back to the same host it loaded the page from.
 *
 * SCOPE SO FAR: accept connections, do the HELLO/WELCOME handshake, run a
 * heartbeat so dead sockets are reaped, answer PING with PONG (Phase 1); run
 * the authoritative fixed-step simulation per room and stream snapshots
 * (Phase 2); the private-lobby lifecycle — create/join/leave, ready,
 * host-started matches — backed by RoomManager's unique room codes
 * (Phase 3/4, delegated to Lobby.js so this file stays pure transport); and
 * REMATCH from the victory screen, which reuses that same ready/start
 * machinery for a second (third, ...) match in the same room (Phase 9).
 */
'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const Protocol = require('../shared/protocol.js');
const Serialization = require('../shared/serialization.js');
const { Room } = require('./Room.js');
const { RoomManager } = require('./RoomManager.js');
const Lobby = require('./Lobby.js');

const PORT = process.env.PORT || 3000;
const PROJECT_ROOT = path.join(__dirname, '..'); // where index.html / shared / client live

// ---------------------------------------------------------------------------
// HTTP: serve the static game files.
// ---------------------------------------------------------------------------
const app = express();
app.use(express.static(PROJECT_ROOT, { extensions: ['html'] }));
// Lightweight health check so a host platform (and our own tests) can confirm
// the process is up without opening a socket.
app.get('/healthz', (_req, res) => res.json({ ok: true, protocol: Protocol.PROTOCOL_VERSION }));

const server = http.createServer(app);

// ---------------------------------------------------------------------------
// WebSocket: the multiplayer transport, mounted at /ws on the same server.
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/ws' });

let nextClientId = 1;
const connections = new Map();        // clientId -> Connection
const roomManager = new RoomManager(); // room code -> Room (Phase 3/4: lobby + codes)
const rooms = roomManager.rooms;       // kept as a plain Map export for the scheduler loop + tests

/**
 * Thin wrapper around a raw socket. Everything the rest of the server sends goes
 * through send()/close() here so serialization lives in exactly one place. Later
 * phases attach room/player references onto the Connection; Phase 1 keeps it to
 * identity + liveness.
 */
class Connection {
  constructor(id, socket) {
    this.id = id;
    this.socket = socket;
    this.name = 'Player';
    this.alive = true;      // heartbeat liveness flag
    this.room = null;       // set once the player is in a room (Phase 3)
  }

  send(packet) {
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.send(Serialization.encode(packet));
    }
  }

  error(code, message) {
    this.send({ type: Protocol.S2C.ERROR, code, message });
  }

  close() {
    try { this.socket.close(); } catch (_e) { /* already closing */ }
  }
}

wss.on('connection', (socket) => {
  const conn = new Connection(nextClientId++, socket);
  connections.set(conn.id, conn);

  socket.on('pong', () => { conn.alive = true; }); // reply to our heartbeat ping frame

  socket.on('message', (data) => {
    const packet = Serialization.decode(data);
    if (!packet) return; // ignore malformed frames rather than dropping the socket
    handlePacket(conn, packet);
  });

  socket.on('close', () => {
    connections.delete(conn.id);
    // Phase 10: an ungraceful drop (network loss, tab killed, crash) — as
    // opposed to a clean LEAVE_LOBBY. Lobby.disconnect() holds a mid-match
    // seat open for RECONNECT instead of freeing it immediately.
    if (conn.room) dispatchLobbyResult(conn, Lobby.disconnect(roomManager, conn));
  });

  socket.on('error', () => { /* 'close' will follow; nothing to do here */ });
});

/**
 * Route one decoded packet from a client. Handles the handshake/ping (Phase 1),
 * buffered input (Phase 2), and the lobby lifecycle — create/join/leave, select,
 * ready, start (Phase 3), backed by RoomManager's unique room codes (Phase 4).
 * Unknown/too-early types get a BAD_STATE error so the client gets clear
 * feedback instead of silence.
 */
function handlePacket(conn, packet) {
  switch (packet.type) {
    case Protocol.C2S.HELLO:
      conn.name = typeof packet.name === 'string' && packet.name.trim()
        ? packet.name.trim().slice(0, 16)
        : 'Player';
      conn.send({
        type: Protocol.S2C.WELCOME,
        clientId: conn.id,
        protocol: Protocol.PROTOCOL_VERSION
      });
      break;

    case Protocol.C2S.PING:
      // Echo the client's own timestamp straight back so it can measure RTT
      // without any server clock involved.
      conn.send({ type: Protocol.S2C.PONG, t: packet.t });
      break;

    case Protocol.C2S.INPUT:
      // Buffer the input on the player's room. The authoritative scheduler
      // applies it on the next tick — we never act on input synchronously.
      if (conn.room) conn.room.queueInput(conn, packet.cmd || packet);
      break;

    // ---- Phase 3 (lobby) / Phase 4 (room codes) --------------------------
    // Lobby.js owns the rules; it never touches a socket. We just run its
    // result through conn.error() on failure or fan its `out` list to the
    // room's seats on success — keeping networking and lobby logic separate.

    case Protocol.C2S.CREATE_LOBBY:
      dispatchLobbyResult(conn, Lobby.createLobby(roomManager, conn));
      break;

    case Protocol.C2S.JOIN_LOBBY:
      dispatchLobbyResult(conn, Lobby.joinLobby(roomManager, conn, packet));
      break;

    case Protocol.C2S.LEAVE_LOBBY:
      dispatchLobbyResult(conn, Lobby.leaveLobby(roomManager, conn));
      break;

    case Protocol.C2S.SELECT:
      dispatchLobbyResult(conn, Lobby.select(conn, packet));
      break;

    case Protocol.C2S.READY:
      dispatchLobbyResult(conn, Lobby.ready(conn, packet));
      break;

    case Protocol.C2S.START_MATCH:
      dispatchLobbyResult(conn, Lobby.startMatch(conn));
      break;

    // ---- Phase 9 (ready system: rematch) ---------------------------------
    case Protocol.C2S.REMATCH:
      dispatchLobbyResult(conn, Lobby.rematch(conn));
      break;

    // ---- Phase 10 (reconnect: reclaim a held-open seat) -------------------
    case Protocol.C2S.RECONNECT:
      dispatchLobbyResult(conn, Lobby.reconnect(roomManager, conn, packet));
      break;

    default:
      // Match packets beyond this point (rematch, etc.) are unknown until
      // later phases wire them up.
      conn.error(Protocol.ERR.BAD_STATE, 'Unsupported packet in this phase: ' + packet.type);
      break;
  }
}

// Turn a Lobby.js handler result into actual socket sends: an error goes back
// to just the caller, otherwise every {broadcast, packet} entry in `out` goes
// to both occupied seats in the room, and every {toSide, packet} entry goes
// only to that one seat (Phase 10: private per-side reconnect tokens must
// never be broadcast to the opponent).
function dispatchLobbyResult(conn, result) {
  if (result.error) { conn.error(result.error.code, result.error.message); return; }
  if (!result.room) return; // e.g. LEAVE_LOBBY when not in a room — nothing to send
  for (const item of result.out) {
    if (item.broadcast) broadcast(result.room, item.packet);
    else if (item.toSide) {
      const slot = result.room.slotFor(item.toSide);
      if (slot && slot.conn) slot.conn.send(item.packet);
    }
  }
}

// Send one packet to both occupied seats in a room.
function broadcast(room, packet) {
  if (room.left.conn) room.left.conn.send(packet);
  if (room.right.conn) room.right.conn.send(packet);
}

// ---------------------------------------------------------------------------
// Heartbeat: ws doesn't tell us about half-open connections (e.g. a laptop that
// slept, or a yanked cable) until we try to write. We ping every interval and
// terminate any socket that didn't pong since the last round.
// ---------------------------------------------------------------------------
const heartbeat = setInterval(() => {
  for (const conn of connections.values()) {
    if (!conn.alive) {
      conn.socket.terminate();
      continue;
    }
    conn.alive = false;
    try { conn.socket.ping(); } catch (_e) { /* terminating next round */ }
  }
}, 5000);

wss.on('close', () => clearInterval(heartbeat));

// ---------------------------------------------------------------------------
// Authoritative fixed-step scheduler. ONE clock drives EVERY room, so all matches
// advance in lockstep with wall time at exactly TICK_RATE steps/second regardless
// of how fast the Node event loop wakes us. We accumulate real elapsed time and
// consume it in fixed TICK_DT increments (a classic fixed-timestep loop) so the
// physics is framerate-independent and reproducible.
// ---------------------------------------------------------------------------
let simClock = 0;                 // monotonic simulation time (seconds)
let accumulator = 0;
let lastReal = Date.now();
const STEP_MS = 1000 / Protocol.TICK_RATE;

const scheduler = setInterval(() => {
  const nowReal = Date.now();
  let frame = (nowReal - lastReal) / 1000;
  lastReal = nowReal;
  if (frame > 0.25) frame = 0.25; // clamp after a GC pause / sleep so we don't spiral
  accumulator += frame;
  while (accumulator >= Protocol.TICK_DT) {
    accumulator -= Protocol.TICK_DT;
    simClock += Protocol.TICK_DT;
    for (const room of rooms.values()) {
      const wasPlaying = room.phase === Protocol.PHASE.PLAYING;
      const out = room.fixedStep(Protocol.TICK_DT, simClock);
      if (out.length) dispatchRoomOut(room, out);
      // Phase 10: fixedStep() can fall a room from PLAYING back to LOBBY on its
      // own (a reconnect grace window expiring) without going through any
      // Lobby.js handler — the client's whole "return to the waiting room"
      // path is driven by receiving a fresh LOBBY_STATE (see index.html's
      // 'lobbyState' handler), so make sure one actually goes out here too.
      if (wasPlaying && room.phase === Protocol.PHASE.LOBBY) {
        broadcast(room, Lobby.buildLobbyState(room));
      }
    }
  }
}, STEP_MS);

// Route a room's outbound packets to the right sockets. Kept here so Room stays
// transport-agnostic (it returns plain {broadcast|toSide, packet} descriptors).
function dispatchRoomOut(room, out) {
  for (const item of out) {
    if (item.broadcast) {
      broadcast(room, item.packet);
    } else if (item.toSide) {
      const slot = room.slotFor(item.toSide);
      if (slot && slot.conn) slot.conn.send(item.packet);
    }
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[rally] HTTP + WS server listening on http://0.0.0.0:${PORT}`);
  console.log(`[rally] game:   http://0.0.0.0:${PORT}/`);
  console.log(`[rally] socket: ws://0.0.0.0:${PORT}/ws`);
});

// Phase 4: periodically reclaim room codes nobody is using any more.
const roomSweep = roomManager.startSweeping();

// Stop the scheduler when the ws layer closes (used by tests to release the loop).
wss.on('close', () => { clearInterval(scheduler); clearInterval(roomSweep); });

module.exports = { app, server, wss, rooms, roomManager, connections, Room };
