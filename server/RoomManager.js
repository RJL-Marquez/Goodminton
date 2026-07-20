/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * server/RoomManager.js
 * ----------------------
 * Owns the registry of live Rooms and everything about turning "a player wants
 * a private match" into a six-character code someone can read over voice chat.
 *
 * Phase 4 scope (room codes):
 *   - generate codes from Protocol.ROOM_CODE_ALPHABET (no O/0, I/1, no vowels)
 *   - guarantee uniqueness against every currently-live room
 *   - reject/normalize malformed codes on lookup instead of throwing
 *   - expire rooms nobody is using, so codes free back up and the Map can't
 *     grow without bound over a long-running server process
 *
 * This module knows NOTHING about sockets or packets — it only creates/looks
 * up/destroys Room instances. server/index.js is the only thing that talks to
 * both this and the transport, which keeps Room (Phase 2's authoritative sim
 * owner) and the lobby/code bookkeeping decoupled and each easy to unit test
 * on its own.
 */
'use strict';

const Protocol = require('../shared/protocol.js');
const { Room } = require('./Room.js');

class RoomManager {
  constructor() {
    /** @type {Map<string, Room>} room code -> Room */
    this.rooms = new Map();
  }

  get size() { return this.rooms.size; }

  // ---- code generation -----------------------------------------------------
  /**
   * Draw a ROOM_CODE_LENGTH string from ROOM_CODE_ALPHABET. Not unique on its
   * own — callers go through createRoom(), which retries against the live set.
   */
  _randomCode() {
    let code = '';
    const alphabet = Protocol.ROOM_CODE_ALPHABET;
    for (let i = 0; i < Protocol.ROOM_CODE_LENGTH; i++) {
      code += alphabet[(Math.random() * alphabet.length) | 0];
    }
    return code;
  }

  /**
   * Produce a code that isn't currently assigned to a live room. The alphabet
   * (24 chars ^ 6) gives ~191M combinations, so collisions are rare, but we
   * still loop-and-check rather than assume, and cap the attempts so a corrupt
   * state can never spin forever.
   */
  generateUniqueCode() {
    for (let attempt = 0; attempt < Protocol.ROOM_CODE_MAX_ATTEMPTS; attempt++) {
      const code = this._randomCode();
      if (!this.rooms.has(code)) return code;
    }
    // Exhausted retries (would imply the room table is absurdly full). Fall
    // back to a longer, still-readable code rather than handing out a dupe.
    let code;
    do { code = this._randomCode() + this._randomCode()[0]; } while (this.rooms.has(code));
    return code;
  }

  // ---- CRUD ------------------------------------------------------------
  /** Create a brand-new room with a fresh unique code and register it. */
  createRoom() {
    const code = this.generateUniqueCode();
    const room = new Room(code, this);
    this.rooms.set(code, room);
    return room;
  }

  /**
   * Look up a room by code. Accepts loose input (lowercase, stray whitespace)
   * since players type these by hand; normalizes before the Map lookup so
   * "abcdxy" and " ABCDXY " both find "ABCDXY". Returns null, never throws,
   * so callers can turn a miss straight into ROOM_NOT_FOUND.
   */
  getRoom(code) {
    if (typeof code !== 'string') return null;
    const normalized = code.trim().toUpperCase();
    if (normalized.length !== Protocol.ROOM_CODE_LENGTH) return null;
    return this.rooms.get(normalized) || null;
  }

  /** Remove a room from the registry outright (used by the sweep, and tests). */
  removeRoom(code) {
    return this.rooms.delete(code);
  }

  // ---- expiration (Phase 4: "expiration for unused rooms") ---------------
  /**
   * Delete rooms nobody can still reach:
   *   - empty (no one seated) past ROOM_EMPTY_TTL_MS since last activity, or
   *   - still occupied but stuck in LOBBY (never started) past the longer
   *     ROOM_STALE_LOBBY_TTL_MS — covers an abandoned waiting room where one
   *     player left their tab open but nobody ever readied up.
   * A room mid-match, or one that finished and is sitting on the victory
   * screen, is never swept here — Phase 10 disconnect handling is what tears
   * those down once players actually leave.
   * Returns the list of codes removed, mainly so callers/tests can assert on it.
   */
  sweep(now) {
    now = typeof now === 'number' ? now : Date.now();
    const removed = [];
    for (const [code, room] of this.rooms) {
      const idleMs = now - room.lastActivity;
      const emptyExpired = room.isEmpty && idleMs >= Protocol.ROOM_EMPTY_TTL_MS;
      const staleLobby = !room.isEmpty
        && room.phase === Protocol.PHASE.LOBBY
        && idleMs >= Protocol.ROOM_STALE_LOBBY_TTL_MS;
      if (emptyExpired || staleLobby) {
        this.rooms.delete(code);
        removed.push(code);
      }
    }
    return removed;
  }

  /** Start the periodic sweep timer. Returns the interval handle so callers can clear it. */
  startSweeping(intervalMs) {
    return setInterval(() => this.sweep(), intervalMs || Protocol.ROOM_SWEEP_INTERVAL_MS);
  }
}

module.exports = { RoomManager };
