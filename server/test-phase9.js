/**
 * Phase 9 unit test: REMATCH (Lobby.rematch) — the victory-screen "Play Again"
 * flow. Pure unit test, fake connections, no sockets — same pattern as
 * test-phase3.js/test-phase4.js.
 * Run: node server/test-phase9.js
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
function fakeConn(name) { return { id: nextId++, name: name || 'P', room: null, roomSide: null, send() {} }; }

function setUpFinishedMatch(mgr) {
  const host = fakeConn('Host');
  const { room } = Lobby.createLobby(mgr, host);
  const joiner = fakeConn('Joiner');
  Lobby.joinLobby(mgr, joiner, { code: room.code });
  Lobby.ready(host, { ready: true });
  Lobby.ready(joiner, { ready: true });
  Lobby.startMatch(host);
  // Force the room straight to GAME_OVER without playing out a real point —
  // rematch only cares about the room's phase, not how it got there.
  room.phase = Protocol.PHASE.GAME_OVER;
  return { room, host, joiner };
}

check('REMATCH flips GAME_OVER -> LOBBY and readies only the requester', () => {
  const mgr = new RoomManager();
  const { room, host } = setUpFinishedMatch(mgr);
  const result = Lobby.rematch(host);
  assert.ok(!result.error, result.error && result.error.message);
  assert.strictEqual(room.phase, Protocol.PHASE.LOBBY);
  assert.strictEqual(room.left.ready, true);
  assert.strictEqual(room.right.ready, false);
  assert.strictEqual(room.world, null, 'the finished world must be dropped');
});

check('a second REMATCH (or plain READY) readies the other side without clearing the first', () => {
  const mgr = new RoomManager();
  const { room, host, joiner } = setUpFinishedMatch(mgr);
  Lobby.rematch(host);
  Lobby.rematch(joiner);
  assert.strictEqual(room.left.ready, true);
  assert.strictEqual(room.right.ready, true);
});

check('plain READY works interchangeably with REMATCH for the second player', () => {
  const mgr = new RoomManager();
  const { room, host, joiner } = setUpFinishedMatch(mgr);
  Lobby.rematch(host);
  Lobby.ready(joiner, { ready: true });
  assert.strictEqual(room.right.ready, true);
});

check('START_MATCH after both ready produces a genuinely fresh world (score back to 0)', () => {
  const mgr = new RoomManager();
  const { room, host, joiner } = setUpFinishedMatch(mgr);
  room.left.character = { id: 'maya' }; room.right.character = { id: 'jordan' };
  Lobby.rematch(host);
  Lobby.rematch(joiner);
  const started = Lobby.startMatch(host);
  assert.ok(!started.error, started.error && started.error.message);
  assert.strictEqual(room.phase, Protocol.PHASE.PLAYING);
  assert.strictEqual(room.world.left.score, 0);
  assert.strictEqual(room.world.right.score, 0);
});

check('REMATCH is rejected mid-match (not GAME_OVER)', () => {
  const mgr = new RoomManager();
  const host = fakeConn('Host');
  const { room } = Lobby.createLobby(mgr, host);
  const joiner = fakeConn('Joiner');
  Lobby.joinLobby(mgr, joiner, { code: room.code });
  Lobby.ready(host, { ready: true });
  Lobby.ready(joiner, { ready: true });
  Lobby.startMatch(host); // phase -> PLAYING, not GAME_OVER
  const result = Lobby.rematch(host);
  assert.strictEqual(result.error.code, Protocol.ERR.BAD_STATE);
});

check('REMATCH is rejected for an unseated connection', () => {
  const mgr = new RoomManager();
  setUpFinishedMatch(mgr);
  const stranger = fakeConn('Stranger');
  const result = Lobby.rematch(stranger);
  assert.strictEqual(result.error.code, Protocol.ERR.BAD_STATE);
});

check('LEAVE_LOBBY while GAME_OVER (nobody rematched yet) reclaims the room to LOBBY and it stays joinable', () => {
  const mgr = new RoomManager();
  const { room, joiner } = setUpFinishedMatch(mgr);
  const other = fakeConn('Third');
  const beforeLeave = Lobby.joinLobby(mgr, other, { code: room.code });
  assert.strictEqual(beforeLeave.error.code, Protocol.ERR.ROOM_FULL, 'both seats are still occupied on the game-over screen');

  // host (setUpFinishedMatch's `host`) leaves without ever requesting a rematch
  const hostConn = room.left.conn;
  Lobby.leaveLobby(mgr, hostConn);
  assert.strictEqual(room.phase, Protocol.PHASE.LOBBY, 'reclaimed to LOBBY for whoever is left');

  const afterLeave = Lobby.joinLobby(mgr, other, { code: room.code });
  assert.ok(!afterLeave.error, 'room must be joinable again once reclaimed');
  assert.strictEqual(room.right.conn, joiner, 'the player who did not leave keeps their seat');
});

console.log(failures === 0 ? '\nALL PASS (Phase 9: rematch)' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
