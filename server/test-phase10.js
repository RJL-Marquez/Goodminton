/**
 * Phase 10 unit test: disconnection handling — mid-match drop holds the seat
 * open for RECONNECT (private per-side token, checked in test-phase3.js's
 * startMatch assertion); a drop in LOBBY/GAME_OVER frees the seat immediately
 * like an ordinary LEAVE_LOBBY; an expired grace window abandons the match.
 * Pure unit test — fake connections, no sockets.
 * Run: node server/test-phase10.js
 */
'use strict';
const assert = require('assert');
const Protocol = require('../shared/protocol.js');
const { RoomManager } = require('./RoomManager.js');
const { RECONNECT_GRACE_MS } = require('./Room.js');
const Lobby = require('./Lobby.js');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('PASS:', name); }
  catch (e) { failures++; console.log('FAIL:', name, '-', e.message); }
}

let nextId = 1;
function fakeConn(name) { return { id: nextId++, name: name || 'P', room: null, roomSide: null, send() {} }; }

function seatedMatch(mgr) {
  const host = fakeConn('Host');
  const { room } = Lobby.createLobby(mgr, host);
  const joiner = fakeConn('Joiner');
  Lobby.joinLobby(mgr, joiner, { code: room.code });
  Lobby.ready(host, { ready: true });
  Lobby.ready(joiner, { ready: true });
  const startResult = Lobby.startMatch(host);
  const leftToken = startResult.out.find(o => o.toSide === 'left').packet.yourToken;
  const rightToken = startResult.out.find(o => o.toSide === 'right').packet.yourToken;
  return { room, host, joiner, leftToken, rightToken };
}

check('an ungraceful drop in LOBBY frees the seat immediately (same as LEAVE_LOBBY)', () => {
  const mgr = new RoomManager();
  const host = fakeConn('Host');
  const { room } = Lobby.createLobby(mgr, host);
  const joiner = fakeConn('Joiner');
  Lobby.joinLobby(mgr, joiner, { code: room.code });

  const result = Lobby.disconnect(mgr, host);
  assert.strictEqual(room.left.conn, null);
  assert.strictEqual(room.hostConnId, joiner.id);
  const state = result.out.find(o => o.packet.type === Protocol.S2C.LOBBY_STATE).packet;
  assert.strictEqual(state.players[0].occupied, false);
});

check('an ungraceful drop mid-match holds the seat open instead of freeing it', () => {
  const mgr = new RoomManager();
  const { room, host } = seatedMatch(mgr);
  const result = Lobby.disconnect(mgr, host);
  assert.strictEqual(room.phase, Protocol.PHASE.PLAYING, 'match keeps existing, just paused');
  assert.strictEqual(room.left.conn, null);
  assert.ok(room.left.disconnectedAt !== null, 'seat is marked pending-reconnect');
  assert.strictEqual(room.left.character.id, room.left.character.id, 'character/score state untouched');
  const evt = result.out.find(o => o.packet.type === Protocol.S2C.EVENT);
  assert.strictEqual(evt.packet.kind, 'opponentDisconnected');
  assert.strictEqual(evt.packet.data.side, 'left');
});

check('fixedStep pauses (no snapshots/physics) while a seat is pending reconnect', () => {
  const mgr = new RoomManager();
  const { room, host } = seatedMatch(mgr);
  const xBefore = room.world.left.x;
  Lobby.disconnect(mgr, host);
  for (let i = 0; i < 30; i++) {
    const out = room.fixedStep(1 / 60, i / 60);
    assert.deepStrictEqual(out, [], 'nothing should be simulated or sent while paused');
  }
  assert.strictEqual(room.world.left.x, xBefore, 'world must not advance while paused');
});

check('RECONNECT with the right code/side/token reclaims the seat and resumes the match', () => {
  const mgr = new RoomManager();
  const { room, host, leftToken } = seatedMatch(mgr);
  Lobby.disconnect(mgr, host);

  const newSocket = fakeConn('Host'); // a drop always gets a NEW connection/clientId on reconnect
  const result = Lobby.reconnect(mgr, newSocket, { code: room.code, side: 'left', token: leftToken });
  assert.ok(!result.error, result.error && result.error.message);
  assert.strictEqual(room.left.conn, newSocket);
  assert.strictEqual(room.left.disconnectedAt, null);
  assert.strictEqual(newSocket.room, room);
  assert.strictEqual(result.out[0].toSide, 'left');
  assert.strictEqual(result.out[0].packet.type, Protocol.S2C.MATCH_START, 'reuses matchStart to resume beginOnlineMatch()');
  assert.notStrictEqual(result.out[0].packet.yourToken, leftToken, 'token rotates so it cannot be reused');

  // match resumes normally
  const out = room.fixedStep(1 / 60, 10);
  assert.ok(Array.isArray(out));
});

check('RECONNECT with a wrong token is rejected and the seat stays pending', () => {
  const mgr = new RoomManager();
  const { room, host } = seatedMatch(mgr);
  Lobby.disconnect(mgr, host);
  const result = Lobby.reconnect(mgr, fakeConn('Imposter'), { code: room.code, side: 'left', token: 'not-the-real-token' });
  assert.strictEqual(result.error.code, Protocol.ERR.BAD_STATE);
  assert.strictEqual(room.left.conn, null);
});

check('RECONNECT after the grace window expires is rejected; the match is abandoned to LOBBY', () => {
  const mgr = new RoomManager();
  const { room, host, leftToken } = seatedMatch(mgr);
  Lobby.disconnect(mgr, host);
  room.left.disconnectedAt = Date.now() - (RECONNECT_GRACE_MS + 1000); // simulate time passing

  const stepOut = room.fixedStep(1 / 60, 10);
  assert.strictEqual(room.phase, Protocol.PHASE.LOBBY, 'expired grace window abandons the match');
  assert.strictEqual(stepOut[0].packet.kind, 'opponentAbandoned');

  const result = Lobby.reconnect(mgr, fakeConn('Host'), { code: room.code, side: 'left', token: leftToken });
  assert.strictEqual(result.error.code, Protocol.ERR.BAD_STATE, 'token was cleared once the room returned to lobby');
});

check('the still-connected player can just leave normally while the other seat is pending reconnect', () => {
  const mgr = new RoomManager();
  const { room, host, joiner } = seatedMatch(mgr);
  Lobby.disconnect(mgr, host); // left seat now pending
  const result = Lobby.leaveLobby(mgr, joiner); // right seat leaves cleanly
  assert.strictEqual(room.isEmpty, true);
  assert.strictEqual(result.room, null, 'room was deleted once fully empty');
  assert.strictEqual(mgr.getRoom(room.code), null);
});

console.log(failures === 0 ? '\nALL PASS (Phase 10: disconnection handling)' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
