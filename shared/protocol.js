/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * shared/protocol.js
 * ------------------
 * Single source of truth for the wire protocol. Loaded by BOTH the Node server
 * (via require) and the browser client (via <script> -> window.Protocol), so the
 * two ends can never drift out of sync on packet names or tuning of the network
 * layer.
 *
 * PACKET FLOW (high level — detail lives next to each type below):
 *
 *   Client                         Server
 *     |  HELLO (name) ------------>  |   handshake, assigns clientId
 *     |  <----------- WELCOME       |   clientId + protocol check
 *     |  CREATE_LOBBY ------------>  |   makes a Room, 6-char code
 *     |  <----------- LOBBY_STATE   |   code + slots + ready flags
 *     |  JOIN_LOBBY (code) ------->  |   validates code, seats player
 *     |  READY (bool) ------------>  |   toggles this player's ready flag
 *     |  START_MATCH ------------->  |   host only; server begins the sim
 *     |  INPUT (seq, cmd, ts) ---->  |   buffered, applied on the next tick
 *     |  <----------- SNAPSHOT      |   authoritative world @ snapshot rate
 *     |  PING (t) ---------------->  |
 *     |  <----------- PONG (t)      |   round-trip time -> ping indicator
 *
 * Everything the client sends is an INTENT. The server owns the truth.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Protocol = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Bumped whenever the packet shapes change incompatibly. Server rejects a
  // client whose PROTOCOL_VERSION doesn't match, so nobody plays on a stale build.
  var PROTOCOL_VERSION = 1;

  // Authoritative simulation runs at this fixed timestep. Independent of the
  // client's render framerate — the client renders as fast as it can and
  // interpolates between the snapshots the server sends.
  var TICK_RATE = 60;                 // authoritative sim steps / second
  var TICK_DT = 1 / TICK_RATE;        // seconds per authoritative step
  var SNAPSHOT_RATE = 30;             // world snapshots broadcast / second
  var PING_INTERVAL_MS = 2000;        // client heartbeat cadence

  // Client -> Server packet types.
  var C2S = {
    HELLO: 'hello',            // { name }               first message after socket open
    CREATE_LOBBY: 'createLobby', // { character?, bg? }  request a new private room
    JOIN_LOBBY: 'joinLobby',   // { code, name }         join an existing room by code
    LEAVE_LOBBY: 'leaveLobby', // {}                     return to menu, free the slot
    SELECT: 'select',          // { character, bg }      pre-match matchup selections
    READY: 'ready',            // { ready:bool }         waiting-room ready toggle
    START_MATCH: 'startMatch', // {}                     host-only; begin the match
    INPUT: 'input',            // { seq, ts, cmd }       per-tick input command (see InputCommand)
    REMATCH: 'rematch',        // {}                     request rematch from victory screen
    RECONNECT: 'reconnect',    // { code, side, token }  Phase 10: reclaim a held-open seat after a drop
    PING: 'ping'               // { t }                  t = client send time (ms)
  };

  // Server -> Client packet types.
  var S2C = {
    WELCOME: 'welcome',        // { clientId, protocol }
    LOBBY_STATE: 'lobbyState', // { code, players[], hostId, phase }
    MATCH_START: 'matchStart', // { seed, leftId, rightId, matchup }
    SNAPSHOT: 'snapshot',      // { tick, ts, ackSeq, world }  authoritative state
    EVENT: 'event',            // { kind, ... }          discrete events (point, win, celebrate)
    PLAYER_JOINED: 'playerJoined',
    PLAYER_LEFT: 'playerLeft',
    ERROR: 'error',            // { code, message }
    PONG: 'pong'               // { t }                  echoes the client's ping time
  };

  // Discrete event kinds carried inside S2C.EVENT (latency-tolerant, fire-and-forget).
  var EVENT = {
    POINT: 'point',            // { scorer, reason, leftScore, rightScore }
    SERVE: 'serve',            // { servingSide }
    CELEBRATE: 'celebrate',    // { side }
    GAME_OVER: 'gameOver',     // { winner, leftScore, rightScore }
    SHAKE: 'shake',            // { mag, duration }      camera event
    HIT: 'hit'                 // { side, kind, x, y }   for client-side juice only
  };

  // Error codes the server may send in S2C.ERROR.
  var ERR = {
    BAD_PROTOCOL: 'badProtocol',
    ROOM_NOT_FOUND: 'roomNotFound',
    ROOM_FULL: 'roomFull',
    NOT_HOST: 'notHost',
    ALREADY_IN_ROOM: 'alreadyInRoom',
    BAD_STATE: 'badState'
  };

  // Waiting-room / match lifecycle phases (server-authoritative, mirrored to clients).
  var PHASE = {
    LOBBY: 'lobby',            // in the waiting room, not yet started
    COUNTDOWN: 'countdown',    // brief start countdown
    PLAYING: 'playing',        // match in progress
    GAME_OVER: 'gameOver'      // victory screen, rematch offered
  };

  // ---- Room code alphabet -------------------------------------------------
  // Among-Us-style codes: 6 uppercase chars, easy to read aloud and type.
  // Deliberately EXCLUDES visually confusable characters: no O/0, I/1, and no
  // vowels (so codes can't accidentally spell words). 24-char alphabet.
  var ROOM_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXYZ2345';
  var ROOM_CODE_LENGTH = 6;

  // ---- Room lifecycle (Phase 4: room codes / expiration) ------------------
  // A room with nobody seated (creator closed the tab before anyone joined, or
  // both players left) is deleted after this many idle ms so codes free up and
  // the registry doesn't grow unbounded. Rooms with a player seated are never
  // swept, even if that player is mid-match and idle for a while.
  var ROOM_EMPTY_TTL_MS = 5 * 60 * 1000;      // 5 minutes
  // A lobby that filled but never started (e.g. the joiner alt-tabbed and never
  // hit ready) is reclaimed after this longer window so an abandoned-but-occupied
  // waiting room doesn't camp a code forever.
  var ROOM_STALE_LOBBY_TTL_MS = 30 * 60 * 1000; // 30 minutes
  // How often the manager sweeps for expired rooms.
  var ROOM_SWEEP_INTERVAL_MS = 60 * 1000;     // 1 minute
  // Safety valve against an (effectively impossible) exhausted code space.
  var ROOM_CODE_MAX_ATTEMPTS = 50;

  return {
    PROTOCOL_VERSION: PROTOCOL_VERSION,
    TICK_RATE: TICK_RATE,
    TICK_DT: TICK_DT,
    SNAPSHOT_RATE: SNAPSHOT_RATE,
    PING_INTERVAL_MS: PING_INTERVAL_MS,
    C2S: C2S,
    S2C: S2C,
    EVENT: EVENT,
    ERR: ERR,
    PHASE: PHASE,
    ROOM_CODE_ALPHABET: ROOM_CODE_ALPHABET,
    ROOM_CODE_LENGTH: ROOM_CODE_LENGTH,
    ROOM_EMPTY_TTL_MS: ROOM_EMPTY_TTL_MS,
    ROOM_STALE_LOBBY_TTL_MS: ROOM_STALE_LOBBY_TTL_MS,
    ROOM_SWEEP_INTERVAL_MS: ROOM_SWEEP_INTERVAL_MS,
    ROOM_CODE_MAX_ATTEMPTS: ROOM_CODE_MAX_ATTEMPTS
  };
});
