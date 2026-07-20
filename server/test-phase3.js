/**
 * Phase 3 unit test: Lobby.js (create/join/leave/select/ready/startMatch).
 * Pure unit test — fake connections (id/name/room/send()), no sockets, no
 * 'ws'/'express' deps — same pattern as test-phase4.js.
 * Run: node server/test-phase3.js
 */
'use strict';
const assert = require('assert');
const Protocol = require('../shared/protocol.js');
const { RoomManager } = require('./RoomManager.js');
const Lobby = require('./Lobby.js');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('PASS:', name); }
  catch (e) { failures++; console.log('FAIL:', name, '-', e.message); }
}

let nextId = 1;
function fakeConn(name) {
  const sent = [];
  return { id: nextId++, name: name || 'P', room: null, roomSide: null, sent, send(p) { sent.push(p); } };
}

check('createLobby seats the creator as host and broadcasts lobbyState', () => {
  const mgr = new RoomManager();
  const host = fakeConn('Host');
  const result = Lobby.createLobby(mgr, host);
  assert.ok(result.room, 'expected a room');
  assert.strictEqual(result.room.left.conn, host, 'creator seated left');
  assert.strictEqual(result.room.hostConnId, host.id);
  assert.strictEqual(result.out.length, 1);
  assert.strictEqual(result.out[0].packet.type, Protocol.S2C.LOBBY_STATE);
  assert.strictEqual(result.out[0].packet.hostId, host.id);
});

check('createLobby rejects a connection already seated somewhere', () => {
  const mgr = new RoomManager();
  const host = fakeConn('Host');
  Lobby.createLobby(mgr, host);
  const again = Lobby.createLobby(mgr, host);
  assert.strictEqual(again.error.code, Protocol.ERR.ALREADY_IN_ROOM);
});

check('joinLobby seats the second player and both sides see occupied:true, ready:false', () => {
  const mgr = new RoomManager();
  const host = fakeConn('Host');
  const { room } = Lobby.createLobby(mgr, host);
  const joiner = fakeConn('Joiner');
  const result = Lobby.joinLobby(mgr, joiner, { code: room.code, name: 'Joiner' });
  assert.ok(!result.error, result.error && result.error.message);
  assert.strictEqual(room.right.conn, joiner);
  const state = result.out.find(o => o.packet.type === Protocol.S2C.LOBBY_STATE).packet;
  assert.strictEqual(state.players.length, 2);
  assert.ok(state.players.every(p => p.occupied && p.ready === false));
});

check('joinLobby is case-insensitive / trims the code, matching RoomManager.getRoom', () => {
  const mgr = new RoomManager();
  const host = fakeConn('Host');
  const { room } = Lobby.createLobby(mgr, host);
  const joiner = fakeConn('Joiner');
  const result = Lobby.joinLobby(mgr, joiner, { code: '  ' + room.code.toLowerCase() + '  ' });
  assert.ok(!result.error, result.error && result.error.message);
});

check('joinLobby rejects an unknown code (ROOM_NOT_FOUND)', () => {
  const mgr = new RoomManager();
  const result = Lobby.joinLobby(mgr, fakeConn(), { code: 'ZZZZZZ' });
  assert.strictEqual(result.error.code, Protocol.ERR.ROOM_NOT_FOUND);
});

check('joinLobby rejects a full room (ROOM_FULL)', () => {
  const mgr = new RoomManager();
  const host = fakeConn('Host');
  const { room } = Lobby.createLobby(mgr, host);
  Lobby.joinLobby(mgr, fakeConn('B'), { code: room.code });
  const third = Lobby.joinLobby(mgr, fakeConn('C'), { code: room.code });
  assert.strictEqual(third.error.code, Protocol.ERR.ROOM_FULL);
});

check('ready toggles the correct seat only, startMatch rejects until both are ready', () => {
  const mgr = new RoomManager();
  const host = fakeConn('Host');
  const { room } = Lobby.createLobby(mgr, host);
  const joiner = fakeConn('Joiner');
  Lobby.joinLobby(mgr, joiner, { code: room.code });

  let started = Lobby.startMatch(host);
  assert.strictEqual(started.error.code, Protocol.ERR.BAD_STATE, 'neither ready yet');

  Lobby.ready(host, { ready: true });
  assert.strictEqual(room.left.ready, true);
  assert.strictEqual(room.right.ready, false);

  started = Lobby.startMatch(host);
  assert.strictEqual(started.error.code, Protocol.ERR.BAD_STATE, 'joiner still not ready');

  Lobby.ready(joiner, { ready: true });
  started = Lobby.startMatch(host);
  assert.ok(!started.error, started.error && started.error.message);
  assert.strictEqual(room.phase, Protocol.PHASE.PLAYING);
});

check('startMatch rejects a non-host', () => {
  const mgr = new RoomManager();
  const host = fakeConn('Host');
  const { room } = Lobby.createLobby(mgr, host);
  const joiner = fakeConn('Joiner');
  Lobby.joinLobby(mgr, joiner, { code: room.code });
  Lobby.ready(host, { ready: true });
  Lobby.ready(joiner, { ready: true });
  const result = Lobby.startMatch(joiner);
  assert.strictEqual(result.error.code, Protocol.ERR.NOT_HOST);
});

check('startMatch sends each side its OWN private reconnect token via toSide, never broadcast', () => {
  const mgr = new RoomManager();
  const host = fakeConn('Host');
  const { room } = Lobby.createLobby(mgr, host);
  const joiner = fakeConn('Joiner');
  Lobby.joinLobby(mgr, joiner, { code: room.code });
  Lobby.ready(host, { ready: true });
  Lobby.ready(joiner, { ready: true });
  const result = Lobby.startMatch(host);
  assert.ok(result.out.every(o => o.toSide && !o.broadcast), 'matchStart must be per-side, not broadcast');
  const leftPacket = result.out.find(o => o.toSide === 'left').packet;
  const rightPacket = result.out.find(o => o.toSide === 'right').packet;
  assert.ok(leftPacket.yourToken && rightPacket.yourToken, 'each side needs a token to reconnect with later');
  assert.notStrictEqual(leftPacket.yourToken, rightPacket.yourToken);
  assert.strictEqual(leftPacket.yourSide, 'left');
  assert.strictEqual(rightPacket.yourSide, 'right');
});

check('leaveLobby frees the seat and reassigns host if the host left', () => {
  const mgr = new RoomManager();
  const host = fakeConn('Host');
  const { room } = Lobby.createLobby(mgr, host);
  const joiner = fakeConn('Joiner');
  Lobby.joinLobby(mgr, joiner, { code: room.code });

  const result = Lobby.leaveLobby(mgr, host);
  assert.strictEqual(room.left.conn, null);
  assert.strictEqual(room.hostConnId, joiner.id, 'host role passes to the remaining player');
  assert.strictEqual(host.room, null);
  const state = result.out.find(o => o.packet.type === Protocol.S2C.LOBBY_STATE).packet;
  assert.strictEqual(state.players[0].occupied, false);
});

check('leaveLobby deletes the room outright once both seats are empty', () => {
  const mgr = new RoomManager();
  const host = fakeConn('Host');
  const { room } = Lobby.createLobby(mgr, host);
  Lobby.leaveLobby(mgr, host);
  assert.strictEqual(mgr.getRoom(room.code), null);
});

check('leaveLobby when not in any room is a harmless no-op', () => {
  const mgr = new RoomManager();
  const result = Lobby.leaveLobby(mgr, fakeConn());
  assert.strictEqual(result.room, null);
  assert.deepStrictEqual(result.out, []);
});

check('select assigns a valid character id and rejects an unknown one silently', () => {
  const mgr = new RoomManager();
  const host = fakeConn('Host');
  const { room } = Lobby.createLobby(mgr, host);
  Lobby.select(host, { character: 'kenji' });
  assert.strictEqual(room.left.character.id, 'kenji');
  Lobby.select(host, { character: 'not-a-real-id' });
  assert.strictEqual(room.left.character.id, 'kenji', 'unknown id must not clobber the existing pick');
});

console.log(failures === 0 ? '\nALL PASS (Phase 3: lobby)' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
