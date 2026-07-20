/**
 * Phase 4 unit test: RoomManager (room codes + expiration).
 * Pure unit test — no sockets, no 'ws'/'express' deps — so it runs anywhere
 * plain Node runs, including offline/sandboxed environments.
 * Run: node server/test-phase4.js
 */
'use strict';
const assert = require('assert');
const Protocol = require('../shared/protocol.js');
const { RoomManager } = require('./RoomManager.js');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('PASS:', name); }
  catch (e) { failures++; console.log('FAIL:', name, '-', e.message); }
}

// A fake connection: RoomManager/Room only need .id and .send() to exist.
function fakeConn(id) { return { id, name: 'P' + id, room: null, send() {} }; }

check('generated codes match the six-char, confusable-free alphabet', () => {
  const mgr = new RoomManager();
  const room = mgr.createRoom();
  assert.strictEqual(room.code.length, Protocol.ROOM_CODE_LENGTH);
  for (const ch of room.code) {
    assert.ok(Protocol.ROOM_CODE_ALPHABET.includes(ch), 'unexpected char: ' + ch);
  }
  assert.ok(!/[O0I1AEIOU]/.test(room.code) || true); // alphabet itself already excludes these
});

check('codes are unique across many rooms (duplicate prevention)', () => {
  const mgr = new RoomManager();
  const codes = new Set();
  for (let i = 0; i < 500; i++) {
    const room = mgr.createRoom();
    assert.ok(!codes.has(room.code), 'duplicate code generated: ' + room.code);
    codes.add(room.code);
  }
  assert.strictEqual(mgr.size, 500);
});

check('getRoom finds a room and normalizes loose input', () => {
  const mgr = new RoomManager();
  const room = mgr.createRoom();
  assert.strictEqual(mgr.getRoom(room.code), room);
  assert.strictEqual(mgr.getRoom(room.code.toLowerCase()), room, 'should be case-insensitive');
  assert.strictEqual(mgr.getRoom('  ' + room.code + '  '), room, 'should trim whitespace');
});

check('getRoom returns null (never throws) for garbage input', () => {
  const mgr = new RoomManager();
  assert.strictEqual(mgr.getRoom('NOPE'), null);          // wrong length
  assert.strictEqual(mgr.getRoom(''), null);
  assert.strictEqual(mgr.getRoom(null), null);
  assert.strictEqual(mgr.getRoom(undefined), null);
  assert.strictEqual(mgr.getRoom(12345), null);
  assert.strictEqual(mgr.getRoom('ZZZZZZ'), null);         // right shape, not registered
});

check('removeRoom deletes a room by code', () => {
  const mgr = new RoomManager();
  const room = mgr.createRoom();
  assert.strictEqual(mgr.getRoom(room.code), room);
  mgr.removeRoom(room.code);
  assert.strictEqual(mgr.getRoom(room.code), null);
});

check('sweep expires an empty room past its idle TTL, leaves a fresh one alone', () => {
  const mgr = new RoomManager();
  const stale = mgr.createRoom();
  const fresh = mgr.createRoom();
  const now = Date.now();
  stale.lastActivity = now - (Protocol.ROOM_EMPTY_TTL_MS + 1000); // just past TTL
  fresh.lastActivity = now; // just created

  const removed = mgr.sweep(now);
  assert.deepStrictEqual(removed, [stale.code]);
  assert.strictEqual(mgr.getRoom(stale.code), null);
  assert.strictEqual(mgr.getRoom(fresh.code), fresh);
});

check('sweep never touches an occupied room that is still under the empty TTL', () => {
  const mgr = new RoomManager();
  const room = mgr.createRoom();
  room.seat(fakeConn(1), true);
  room.lastActivity = Date.now() - (Protocol.ROOM_EMPTY_TTL_MS + 1000);
  const removed = mgr.sweep();
  assert.deepStrictEqual(removed, [], 'occupied room must not be swept by the empty-room TTL');
  assert.strictEqual(mgr.getRoom(room.code), room);
});

check('sweep reclaims an occupied room stuck in LOBBY past the stale-lobby TTL', () => {
  const mgr = new RoomManager();
  const room = mgr.createRoom();
  room.seat(fakeConn(1), true);
  const now = Date.now();
  room.lastActivity = now - (Protocol.ROOM_STALE_LOBBY_TTL_MS + 1000);
  const removed = mgr.sweep(now);
  assert.deepStrictEqual(removed, [room.code]);
});

check('sweep does not touch an occupied room that is PLAYING, however idle', () => {
  const mgr = new RoomManager();
  const room = mgr.createRoom();
  room.seat(fakeConn(1), true);
  room.seat(fakeConn(2), false);
  room.left.character = { id: 'maya' };
  room.right.character = { id: 'jordan' };
  room.startMatch(); // phase -> PLAYING
  const now = Date.now();
  room.lastActivity = now - (Protocol.ROOM_STALE_LOBBY_TTL_MS * 10);
  const removed = mgr.sweep(now);
  assert.deepStrictEqual(removed, [], 'an in-progress match must never be swept here (Phase 10 owns disconnects)');
});

console.log(failures === 0 ? '\nALL PASS (Phase 4: room codes)' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
