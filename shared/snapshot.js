/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * shared/snapshot.js
 * ------------------
 * Defines the authoritative world SNAPSHOT: the minimal slice of simulation
 * state the server broadcasts each network tick and the client renders from.
 * Shared so the field names are written once — the server builds snapshots with
 * buildSnapshot() and the client reads the very same shape, so a renamed field
 * can't silently desync the two ends.
 *
 * We deliberately send ONLY what a client needs to draw and interpolate:
 * positions/velocities, animation-relevant timers, scores, and the match state
 * machine. Internal-only physics bookkeeping (dive flags, netCollisionResolved,
 * chargeStart, lastHitTime, per-rally counters) stays server-side — it never
 * affects rendering and shipping it would only widen the packet and the attack
 * surface.
 *
 * Velocities ARE included: the client needs them for dead-reckoning between the
 * 30Hz snapshots (entity interpolation/extrapolation, Phase 7) so motion stays
 * smooth at any render framerate.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Snapshot = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function playerSlice(p) {
    return {
      x: p.x, y: p.y, vx: p.vx, vy: p.vy,
      onGround: p.onGround,
      charging: p.charging,
      swingTimer: p.swingTimer,
      swingKind: p.swingKind,
      swingPowerFrac: p.swingPowerFrac,
      dashTimer: p.dashTimer,
      score: p.score,
      charId: p.character ? p.character.id : null
    };
  }

  function shuttleSlice(s) {
    return {
      x: s.x, y: s.y, vx: s.vx, vy: s.vy,
      active: s.active, kind: s.kind, angle: s.angle
    };
  }

  /**
   * Build a snapshot packet body from the authoritative world.
   * @param {object} w        simulation world
   * @param {number} tick     server tick counter
   * @param {number} ts       server timestamp (ms) — client uses it to order/interp
   * @param {object} ackSeq   { left, right } last input seq the server applied per side
   */
  function buildSnapshot(w, tick, ts, ackSeq) {
    return {
      tick: tick,
      ts: ts,
      state: w.state,
      servingSide: w.servingSide,
      isServeFlight: w.isServeFlight,
      pointPauseTimer: w.pointPauseTimer,
      winner: w.winner,
      ackSeq: ackSeq || { left: 0, right: 0 },
      left: playerSlice(w.left),
      right: playerSlice(w.right),
      shuttle: shuttleSlice(w.shuttle)
    };
  }

  return { buildSnapshot: buildSnapshot, playerSlice: playerSlice, shuttleSlice: shuttleSlice };
});
