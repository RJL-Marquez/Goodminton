/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * server/Room.js
 * ---------------
 * One private match: two seats (left/right), the authoritative simulation
 * world once a match is running, and the lobby-adjacent bookkeeping
 * (ready flags, host, reconnect tokens) that Lobby.js reads and mutates.
 * Room knows NOTHING about sockets/packets beyond the thin `conn` reference
 * it stores per seat (id/name/send()) — server/index.js is the only thing
 * that turns a Room's output into actual socket sends, which keeps this
 * class transport-agnostic and easy to unit test (see test-phase1/2/4/9).
 *
 * SCOPE: seating + room lifecycle (Phase 3/4); the authoritative fixed-step
 * simulation loop, streaming snapshots/events (Phase 2); the FIFO input
 * queue that makes client-side prediction replay exact (Phase 8); and
 * reconnect tokens + a grace window for a mid-match disconnect (Phase 10) —
 * see unseat()/reclaim() below.
 */
'use strict';

const crypto = require('crypto');
const Protocol = require('../shared/protocol.js');
const Sim = require('../shared/simulation.js');
const Snapshot = require('../shared/snapshot.js');
const C = require('../shared/constants.js');

const MAX_QUEUED_INPUTS = 6; // Phase 8: bounded FIFO per side, drop OLDEST under backlog
const SNAPSHOT_INTERVAL = 1 / Protocol.SNAPSHOT_RATE;
// Phase 10: how long a mid-match seat is held open for its original occupant
// to reconnect into before the match is abandoned and the room falls back
// to the waiting room for whoever's left.
const RECONNECT_GRACE_MS = 30 * 1000;

function makeSlot(side) {
  return {
    side: side,
    conn: null,
    name: null,
    character: side === 'left' ? C.CHARACTERS[0] : C.CHARACTERS[1],
    bg: null,
    ready: false,
    queue: [],              // buffered InputCommands, oldest first
    lastQueuedSeq: 0,        // highest seq accepted into the queue (rejects stale/dup/out-of-order)
    lastAppliedSeq: 0,       // highest seq actually applied to the sim -> echoed as ackSeq
    // ---- Phase 10: reconnect ----
    reconnectToken: null,    // set once seated; a RECONNECT packet must present this to reclaim the seat
    disconnectedAt: null     // ms timestamp the seat went empty mid-match; null while occupied/not mid-match
  };
}

class Room {
  constructor(code, manager) {
    this.code = code;
    this.manager = manager; // may be null in tests that construct a Room directly
    this.left = makeSlot('left');
    this.right = makeSlot('right');
    this.hostConnId = null;
    this.phase = Protocol.PHASE.LOBBY;
    this.world = null;
    this.tick = 0;
    this.lastActivity = Date.now();
    this._snapshotAccum = 0;
  }

  // ---- seating -------------------------------------------------------------
  slotForConn(conn) {
    if (this.left.conn === conn) return this.left;
    if (this.right.conn === conn) return this.right;
    return null;
  }

  slotFor(side) {
    return side === 'left' ? this.left : (side === 'right' ? this.right : null);
  }

  get isEmpty() {
    return !this.left.conn && !this.right.conn;
  }

  /** Seat a brand-new connection into the first open slot (left preferred). */
  seat(conn, isHost) {
    const slot = !this.left.conn ? this.left : (!this.right.conn ? this.right : null);
    if (!slot) return null;
    slot.conn = conn;
    slot.name = conn.name;
    slot.ready = false;
    slot.queue = [];
    slot.lastQueuedSeq = 0;
    slot.lastAppliedSeq = 0;
    slot.reconnectToken = crypto.randomBytes(9).toString('base64url');
    slot.disconnectedAt = null;
    conn.room = this;
    conn.roomSide = slot.side;
    if (isHost) this.hostConnId = conn.id;
    this.lastActivity = Date.now();
    return slot;
  }

  /**
   * A connection is leaving its seat — either a clean LEAVE_LOBBY or a
   * dropped socket. `graceful` (LEAVE_LOBBY, or a mid-match drop past its
   * grace window) frees the seat outright. An UNGRACEFUL mid-match drop
   * instead starts the Phase 10 reconnect grace window: the seat keeps its
   * character/score/queue and the match keeps simulating (the disconnected
   * side just stops receiving input), so a quick reconnect resumes cleanly.
   */
  unseat(conn, opts) {
    const graceful = !opts || opts.graceful !== false;
    const slot = this.slotForConn(conn);
    if (!slot) return null;

    const midMatch = this.phase === Protocol.PHASE.PLAYING;
    if (midMatch && !graceful) {
      // Hold the seat open for reconnect — don't clear character/ready/queue.
      slot.conn = null;
      slot.disconnectedAt = Date.now();
      this.lastActivity = Date.now();
      return slot;
    }

    slot.conn = null;
    slot.ready = false;
    slot.queue = [];
    slot.disconnectedAt = null;
    slot.reconnectToken = null;
    if (this.hostConnId === conn.id) {
      const other = this.left.conn ? this.left : (this.right.conn ? this.right : null);
      this.hostConnId = other ? other.conn.id : null;
    }
    if (this.phase === Protocol.PHASE.PLAYING || this.phase === Protocol.PHASE.GAME_OVER) {
      this.returnToLobby();
    }
    this.lastActivity = Date.now();
    return slot;
  }

  /**
   * Phase 10: reclaim a held-open seat with a fresh connection + matching
   * reconnect token. Returns the slot on success, null if the token doesn't
   * match / the seat isn't actually pending reconnect.
   */
  reclaim(conn, side, token) {
    const slot = this.slotFor(side);
    if (!slot || slot.conn || slot.disconnectedAt === null) return null;
    if (!token || slot.reconnectToken !== token) return null;
    slot.conn = conn;
    slot.disconnectedAt = null;
    slot.reconnectToken = crypto.randomBytes(9).toString('base64url'); // rotate for next time
    conn.room = this;
    conn.roomSide = slot.side;
    this.lastActivity = Date.now();
    return slot;
  }

  /** True once a held-open seat's reconnect grace window has expired. */
  reconnectExpired(slot, now) {
    return slot.disconnectedAt !== null && (now - slot.disconnectedAt) >= RECONNECT_GRACE_MS;
  }

  // ---- lobby -> match transition -------------------------------------------
  returnToLobby() {
    this.phase = Protocol.PHASE.LOBBY;
    this.world = null;
    this.tick = 0;
    this._snapshotAccum = 0;
    this.left.ready = false;
    this.right.ready = false;
    this.left.queue = [];
    this.right.queue = [];
    this.left.disconnectedAt = null;
    this.right.disconnectedAt = null;
    this.lastActivity = Date.now();
  }

  startMatch() {
    this.world = Sim.createWorld(this.left.character, this.right.character);
    this.tick = 0;
    this._snapshotAccum = 0;
    this.left.queue = [];
    this.right.queue = [];
    this.left.lastAppliedSeq = 0;
    this.right.lastAppliedSeq = 0;
    this.phase = Protocol.PHASE.PLAYING;
    this.lastActivity = Date.now();
  }

  // ---- authoritative simulation --------------------------------------------
  queueInput(conn, cmd) {
    const slot = this.slotForConn(conn);
    if (!slot || this.phase !== Protocol.PHASE.PLAYING || !cmd) return;
    if (typeof cmd.seq === 'number') {
      if (cmd.seq <= slot.lastQueuedSeq) return; // stale / duplicate / out-of-order
      slot.lastQueuedSeq = cmd.seq;
    }
    slot.queue.push(cmd);
    if (slot.queue.length > MAX_QUEUED_INPUTS) slot.queue.shift(); // drop OLDEST under backlog
  }

  _applyQueuedInput(slot, nowSec) {
    const cmd = slot.queue.shift();
    if (!cmd) return; // dropped packet: hold the player's current input state, don't snap to a stop
    const p = slot === this.left ? this.world.left : this.world.right;
    p.inLeft = !!cmd.left;
    p.inRight = !!cmd.right;
    if (cmd.jump) Sim.tryJump(this.world, p);
    if (cmd.dash === 1 || cmd.dash === -1) Sim.applyDash(this.world, p, cmd.dash, nowSec);
    if (cmd.charge === true && !p.charging) Sim.startCharge(this.world, p, nowSec);
    else if (cmd.charge === false && p.charging) Sim.releaseHit(this.world, p, nowSec);
    if (typeof cmd.seq === 'number') slot.lastAppliedSeq = cmd.seq;
  }

  /**
   * Advance this room by one authoritative tick. Returns a list of
   * {broadcast, packet} / {toSide, packet} descriptors for index.js to
   * actually send — Room stays transport-agnostic.
   */
  fixedStep(dt, simClock) {
    if (this.phase !== Protocol.PHASE.PLAYING) return [];
    this.lastActivity = Date.now();

    // Phase 10: a seat is mid reconnect-grace. Freeze the match entirely
    // (no physics, no snapshots) rather than letting the still-connected
    // player rack up free points against an opponent who's mid-reconnect.
    const now = Date.now();
    for (const slot of [this.left, this.right]) {
      if (slot.disconnectedAt !== null && this.reconnectExpired(slot, now)) {
        this.returnToLobby();
        return [{ broadcast: true, packet: { type: Protocol.S2C.EVENT, kind: 'opponentAbandoned', data: {} } }];
      }
    }
    if (this.left.disconnectedAt !== null || this.right.disconnectedAt !== null) {
      return []; // paused: seat held open, nothing to simulate or broadcast yet
    }

    this.tick++;

    this._applyQueuedInput(this.left, simClock);
    this._applyQueuedInput(this.right, simClock);
    Sim.stepWorld(this.world, dt, simClock);

    const out = [];
    for (let i = 0; i < this.world.events.length; i++) {
      const ev = this.world.events[i];
      out.push({ broadcast: true, packet: { type: Protocol.S2C.EVENT, kind: ev.kind, data: ev } });
    }
    this.world.events.length = 0;

    if (this.world.state === 'gameOver') {
      this.phase = Protocol.PHASE.GAME_OVER;
    }

    this._snapshotAccum += dt;
    if (this._snapshotAccum >= SNAPSHOT_INTERVAL) {
      this._snapshotAccum -= SNAPSHOT_INTERVAL;
      const ackSeq = { left: this.left.lastAppliedSeq, right: this.right.lastAppliedSeq };
      const body = Snapshot.buildSnapshot(this.world, this.tick, Date.now(), ackSeq);
      out.push({ broadcast: true, packet: Object.assign({ type: Protocol.S2C.SNAPSHOT }, body) });
    }

    return out;
  }
}

module.exports = { Room, RECONNECT_GRACE_MS };
