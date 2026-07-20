/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * server/Lobby.js
 * ----------------
 * Pure lobby/rules logic: create/join/leave, select, ready, start, rematch,
 * and (Phase 10) reconnect. NEVER touches a socket directly — every function
 * here takes a `conn` (id/name/send()/room) and/or the RoomManager, and
 * returns either `{ error: { code, message } }` or `{ room, out }`, where
 * `out` is a list of `{ broadcast, packet }` / `{ toSide, packet }`
 * descriptors. server/index.js's dispatchLobbyResult() is the only thing
 * that turns those into actual `conn.send()` calls, so this module stays
 * trivially unit-testable without a real WebSocket (see test-phase3.js,
 * test-phase9.js).
 */
'use strict';

const Protocol = require('../shared/protocol.js');
const C = require('../shared/constants.js');
const { RECONNECT_GRACE_MS } = require('./Room.js');

function err(code, message) { return { error: { code: code, message: message } }; }
function ok(room, out) { return { room: room, out: out || [] }; }

function buildLobbyState(room) {
  function slotView(slot) {
    if (!slot.conn) return { occupied: false };
    return {
      occupied: true,
      clientId: slot.conn.id,
      name: slot.name || slot.conn.name,
      isHost: slot.conn.id === room.hostConnId,
      ready: slot.ready,
      character: slot.character ? slot.character.id : null,
      bg: slot.bg || null
    };
  }
  return {
    type: Protocol.S2C.LOBBY_STATE,
    code: room.code,
    hostId: room.hostConnId,
    phase: room.phase,
    players: [slotView(room.left), slotView(room.right)]
  };
}

function broadcastLobbyState(room) {
  return [{ broadcast: true, packet: buildLobbyState(room) }];
}

// Per-recipient: everything is shared EXCEPT `yourToken`, which is that
// side's private Phase 10 reconnect token — deliberately sent via `toSide`
// (never broadcast) so the opponent can never see it and steal the seat.
function matchStartPacket(room, forSide) {
  var slot = room.slotFor(forSide);
  return {
    type: Protocol.S2C.MATCH_START,
    leftId: room.left.conn ? room.left.conn.id : null,
    rightId: room.right.conn ? room.right.conn.id : null,
    matchup: { left: room.left.character.id, right: room.right.character.id },
    bg: room.left.bg || 'classic',
    yourSide: forSide,
    yourToken: slot ? slot.reconnectToken : null
  };
}

// ---- C2S.CREATE_LOBBY -------------------------------------------------------
function createLobby(roomManager, conn) {
  if (conn.room) return err(Protocol.ERR.ALREADY_IN_ROOM, 'Already in a room.');
  const room = roomManager.createRoom();
  room.seat(conn, true);
  return ok(room, broadcastLobbyState(room));
}

// ---- C2S.JOIN_LOBBY ----------------------------------------------------------
function joinLobby(roomManager, conn, packet) {
  if (conn.room) return err(Protocol.ERR.ALREADY_IN_ROOM, 'Already in a room.');
  const room = roomManager.getRoom(packet && packet.code);
  if (!room) return err(Protocol.ERR.ROOM_NOT_FOUND, 'No room with that code.');
  if (room.left.conn && room.right.conn) return err(Protocol.ERR.ROOM_FULL, 'That room is full.');
  if (room.phase !== Protocol.PHASE.LOBBY) return err(Protocol.ERR.BAD_STATE, 'That match already started.');
  if (packet && typeof packet.name === 'string' && packet.name.trim()) {
    conn.name = packet.name.trim().slice(0, 16);
  }
  room.seat(conn, false);
  return ok(room, [
    { broadcast: true, packet: { type: Protocol.S2C.PLAYER_JOINED, clientId: conn.id } }
  ].concat(broadcastLobbyState(room)));
}

// ---- C2S.LEAVE_LOBBY (also used for an ungraceful socket close outside PLAYING) ----
function leaveLobby(roomManager, conn) {
  const room = conn.room;
  if (!room) return ok(null);
  room.unseat(conn, { graceful: true });
  conn.room = null;
  conn.roomSide = null;
  if (room.isEmpty) {
    roomManager.removeRoom(room.code);
    return ok(null);
  }
  return ok(room, [
    { broadcast: true, packet: { type: Protocol.S2C.PLAYER_LEFT, clientId: conn.id } }
  ].concat(broadcastLobbyState(room)));
}

// ---- Phase 10: an ungraceful socket close (network drop, tab killed, crash) ----
// Distinct from leaveLobby(): mid-match this HOLDS the seat open for
// RECONNECT rather than freeing it immediately — see Room.unseat().
function disconnect(roomManager, conn) {
  const room = conn.room;
  if (!room) return ok(null);
  const slot = room.unseat(conn, { graceful: false });
  conn.room = null;
  conn.roomSide = null;
  if (!slot) return ok(null);

  if (slot.disconnectedAt !== null) {
    // Held open mid-match: tell the other side so it can show "opponent
    // disconnected, waiting to reconnect" instead of a frozen screen.
    return ok(room, [{
      broadcast: true,
      packet: {
        type: Protocol.S2C.EVENT,
        kind: 'opponentDisconnected',
        data: { side: slot.side, graceMs: RECONNECT_GRACE_MS }
      }
    }]);
  }

  if (room.isEmpty) {
    roomManager.removeRoom(room.code);
    return ok(null);
  }
  return ok(room, [
    { broadcast: true, packet: { type: Protocol.S2C.PLAYER_LEFT, clientId: conn.id } }
  ].concat(broadcastLobbyState(room)));
}

// ---- Phase 10: C2S.RECONNECT --------------------------------------------------
// A fresh connection (new clientId — sockets don't survive a drop) presenting
// the room code + side + token it was given when first seated. On success we
// reuse MATCH_START verbatim (same shape beginOnlineMatch() already handles)
// so the client's existing "start a synced match" path resumes it with zero
// new client-side match-start logic — only the reconnect handshake is new.
function reconnect(roomManager, conn, packet) {
  if (conn.room) return err(Protocol.ERR.ALREADY_IN_ROOM, 'Already in a room.');
  const room = roomManager.getRoom(packet && packet.code);
  if (!room) return err(Protocol.ERR.ROOM_NOT_FOUND, 'No room with that code.');
  const side = packet && (packet.side === 'left' || packet.side === 'right') ? packet.side : null;
  if (!side) return err(Protocol.ERR.BAD_STATE, 'Missing seat side.');
  const slot = room.reclaim(conn, side, packet && packet.token);
  if (!slot) return err(Protocol.ERR.BAD_STATE, 'Reconnect window expired or invalid.');
  return ok(room, [{ toSide: slot.side, packet: matchStartPacket(room, slot.side) }]);
}

// ---- C2S.SELECT (character/background pre-match pick; not yet exposed in the UI) ----
function select(conn, packet) {
  const room = conn.room;
  if (!room) return err(Protocol.ERR.BAD_STATE, 'Not in a room.');
  if (room.phase !== Protocol.PHASE.LOBBY) return err(Protocol.ERR.BAD_STATE, 'Match already started.');
  const slot = room.slotForConn(conn);
  if (!slot) return err(Protocol.ERR.BAD_STATE, 'Not seated in this room.');
  if (packet && typeof packet.character === 'string') {
    const ch = C.CHARACTERS.find(function (c) { return c.id === packet.character; });
    if (ch) slot.character = ch;
  }
  if (packet && typeof packet.bg === 'string') slot.bg = packet.bg;
  room.lastActivity = Date.now();
  return ok(room, broadcastLobbyState(room));
}

// ---- C2S.READY ----------------------------------------------------------------
function ready(conn, packet) {
  const room = conn.room;
  if (!room) return err(Protocol.ERR.BAD_STATE, 'Not in a room.');
  if (room.phase !== Protocol.PHASE.LOBBY) return err(Protocol.ERR.BAD_STATE, 'Match already started.');
  const slot = room.slotForConn(conn);
  if (!slot) return err(Protocol.ERR.BAD_STATE, 'Not seated in this room.');
  slot.ready = !!(packet && packet.ready);
  room.lastActivity = Date.now();
  return ok(room, broadcastLobbyState(room));
}

// ---- C2S.START_MATCH (host only) ----------------------------------------------
function startMatch(conn) {
  const room = conn.room;
  if (!room) return err(Protocol.ERR.BAD_STATE, 'Not in a room.');
  if (conn.id !== room.hostConnId) return err(Protocol.ERR.NOT_HOST, 'Only the host can start the match.');
  if (room.phase !== Protocol.PHASE.LOBBY) return err(Protocol.ERR.BAD_STATE, 'Match already started.');
  if (!room.left.conn || !room.right.conn) return err(Protocol.ERR.BAD_STATE, 'Waiting for a second player.');
  if (!room.left.ready || !room.right.ready) return err(Protocol.ERR.BAD_STATE, 'Both players must be ready.');
  room.startMatch();
  return ok(room, [
    { toSide: 'left', packet: matchStartPacket(room, 'left') },
    { toSide: 'right', packet: matchStartPacket(room, 'right') }
  ]);
}

// ---- C2S.REMATCH (from the victory screen) -------------------------------------
// First REMATCH while GAME_OVER flips the room back to LOBBY and readies the
// requester; from there it's the exact same READY/START_MATCH flow as the
// very first match — no second, parallel ready system. A second REMATCH (the
// other player clicking "Play Again" too, rather than toggling Ready) arrives
// with the room ALREADY back in LOBBY from the first call, so it's handled
// exactly like a READY toggle instead of being rejected as "no match to
// rematch" — see server/test-phase9.js.
function rematch(conn) {
  const room = conn.room;
  if (!room) return err(Protocol.ERR.BAD_STATE, 'Not in a room.');
  if (room.phase !== Protocol.PHASE.GAME_OVER && room.phase !== Protocol.PHASE.LOBBY) {
    return err(Protocol.ERR.BAD_STATE, 'No match to rematch.');
  }
  const slot = room.slotForConn(conn);
  if (!slot) return err(Protocol.ERR.BAD_STATE, 'Not seated in this room.');
  if (room.phase === Protocol.PHASE.GAME_OVER) room.returnToLobby();
  slot.ready = true;
  return ok(room, broadcastLobbyState(room));
}

module.exports = {
  createLobby: createLobby,
  joinLobby: joinLobby,
  leaveLobby: leaveLobby,
  disconnect: disconnect,
  reconnect: reconnect,
  select: select,
  ready: ready,
  startMatch: startMatch,
  rematch: rematch,
  buildLobbyState: buildLobbyState // exported for server/index.js's scheduler — see the Phase 10 comment there
};
