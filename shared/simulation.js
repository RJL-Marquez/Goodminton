/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * shared/simulation.js
 * --------------------
 * The authoritative badminton simulation, ported VERBATIM (same math, same
 * constants) out of the original index.html game script but made HEADLESS:
 *
 *   - no canvas, no DOM, no audio, no particles, no screen-shake side effects;
 *   - operates on a plain `world` object passed in, not module-level globals;
 *   - every former side effect (playSound / spawnHitParticles / triggerShake /
 *     the DOM writes in endGame) becomes an entry pushed onto `world.events`,
 *     which the caller drains and forwards to clients so they can play the sound,
 *     spawn juice, shake the camera, etc. locally.
 *
 * This one file runs in TWO places from the same source:
 *   1. the Node server, ticking it at 60Hz as the single source of truth, and
 *   2. the browser client, re-running it to PREDICT the local player (Phase 8).
 * Because both import shared/constants.js and this file, server truth and client
 * prediction cannot drift on any physics value.
 *
 * INPUT MODEL. The original coupled input through a global keys{} map plus the
 * discrete handlers tryJump/tryDash/startCharge/releaseHit. Here each player
 * carries its held-input state on the player object (inLeft/inRight/inCharge),
 * and the action primitives are exported so the network layer can translate an
 * incoming INPUT packet into the exact same calls a keypress used to make. The
 * server owns the truth; clients only ever express intent.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./constants.js'));
  } else {
    root.Simulation = factory(root.GameConstants);
  }
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  // ---- stat helpers (verbatim) -------------------------------------------
  function statMult(stat, linear, kicker) {
    var diff = (stat || 3) - 3;
    var sign = diff > 0 ? 1 : (diff < 0 ? -1 : 0);
    return 1 + diff * linear + sign * diff * diff * kicker;
  }
  function speedMultFor(ch) { return statMult(ch && ch.stats && ch.stats.speed, 0.10, 0.02); }
  function chargeSpeedMultFor(ch) { return statMult(ch && ch.stats && ch.stats.speed, C.CHARGE_SPEED_LINEAR, C.CHARGE_SPEED_KICKER); }
  function chargeTimeFor(ch) { return C.MAX_CHARGE_TIME / chargeSpeedMultFor(ch); }
  function powerMultFor(ch) { return statMult(ch && ch.stats && ch.stats.power, 0.12, 0.03); }
  function powerMultForRegular(ch) { return statMult(ch && ch.stats && ch.stats.power, C.POWER_REGULAR_LINEAR, C.POWER_REGULAR_KICKER); }
  function reachFor(ch) {
    var c = (ch && ch.stats && ch.stats.control) || 3;
    var diff = c - 3;
    var sign = diff > 0 ? 1 : (diff < 0 ? -1 : 0);
    return C.HIT_REACH_X + diff * 14 + sign * diff * diff * 3;
  }
  function dashDistanceMultFor(ch) { return statMult(ch && ch.stats && ch.stats.speed, C.DASH_DIST_LINEAR, C.DASH_DIST_KICKER); }

  // ---- world / player factories ------------------------------------------
  function makePlayer(side) {
    var onLeft = side === 'left';
    return {
      side: side,
      x: onLeft ? C.COURT_LEFT + 180 : C.COURT_RIGHT - 180 - C.PLAYER_W,
      y: C.GROUND_Y - C.PLAYER_H,
      vx: 0, vy: 0,
      onGround: true,
      score: 0,
      lastHitTime: -999,
      lastDashTime: -999,
      dashTimer: 0,
      dashDir: 0,
      charging: false,
      chargeStart: 0,
      swingTimer: 0,
      swingPowerFrac: 1,
      swingKind: 'float',   // last swing type, for remote animation
      character: null,
      minX: onLeft ? C.COURT_LEFT - 12 : C.NET_X + C.NET_WIDTH / 2 + 8,
      maxX: onLeft ? C.NET_X - C.NET_WIDTH / 2 - 8 - C.PLAYER_W : C.COURT_RIGHT + 12 - C.PLAYER_W,
      attackAngle: C.ATTACK_ANGLE_DEFAULT,
      // ---- network-driven held input (replaces the global keys{} map) ----
      inLeft: false,
      inRight: false,
      inCharge: false,
      isHuman: true         // networked players are human-controlled
    };
  }

  function makeShuttle() {
    return {
      x: C.W / 2, y: C.GROUND_Y - 100, vx: 0, vy: 0, active: false, kind: 'float',
      hitByMaxPower: false, hitDir: 1, maxPowerDiveApplied: false,
      dinkDiveApplied: false, dinkDir: 1, dinkPostNetGravity: 0,
      netCollisionResolved: false,
      angle: -Math.PI / 2
    };
  }

  /**
   * Create a fresh match world. leftChar/rightChar are character objects from
   * C.CHARACTERS (or ids resolved by the caller).
   */
  function createWorld(leftChar, rightChar) {
    var w = {
      state: 'serve',
      servingSide: 'left',
      lastHitBy: null,
      isServeFlight: false,
      rallyHitCount: 0,
      pointPauseTimer: 0,
      winner: null,
      advancedControls: false,
      left: makePlayer('left'),
      right: makePlayer('right'),
      shuttle: makeShuttle(),
      events: []
    };
    w.left.character = leftChar || C.CHARACTERS[0];
    w.right.character = rightChar || C.CHARACTERS[1];
    return w;
  }

  function emit(w, ev) { w.events.push(ev); }

  // ---- input primitives (former keypress handlers) -----------------------
  function tryJump(w, p) {
    if (w.state !== 'rally' && w.state !== 'serve') return;
    if (p.onGround) { p.vy = C.JUMP_VELOCITY; p.onGround = false; }
  }

  /**
   * Server-side dash. The original detected a double-tap of the movement key
   * and set dashTimer; here the client sends an explicit dash intent (dir) — the
   * server keeps the SAME cooldown gate so it stays authoritative and un-cheatable.
   */
  function applyDash(w, p, dir, now) {
    if (w.state !== 'rally' && w.state !== 'serve') return;
    if (now - p.lastDashTime >= C.DASH_COOLDOWN) {
      p.dashTimer = C.DASH_DURATION;
      p.dashDir = dir;
      p.lastDashTime = now;
    }
  }

  function startCharge(w, p, now) {
    if (w.state === 'serve' && w.servingSide === p.side) {
      if (p.charging) return;
      p.charging = true; p.chargeStart = now; return;
    }
    if (w.state !== 'rally') return;
    if (p.charging) return;
    p.charging = true; p.chargeStart = now;
  }

  function manualOffset(w, p) {
    return (w.advancedControls && p.isHuman) ? p.attackAngle : 0;
  }

  /**
   * Release a charged swing. Faithful port of releaseHit(): returns true if the
   * release actually made contact (real hit OR a one-touch fault), false on a whiff.
   */
  function releaseHit(w, p, now) {
    if (!p.charging) return false;
    var chargeFrac = Math.min(1, (now - p.chargeStart) / chargeTimeFor(p.character));
    p.charging = false;
    var shuttle = w.shuttle;

    if (w.state === 'serve' && w.servingSide === p.side) {
      doServe(w, p, chargeFrac, now);
      return true;
    }

    if (w.state !== 'rally') return false;
    if (now - p.lastHitTime < C.HIT_COOLDOWN) return false;

    var headX = p.x + C.PLAYER_W / 2;
    var headY = p.y;
    var dx = Math.abs(shuttle.x - headX);
    if (dx > reachFor(p.character)) return false;

    var smashTop = headY - 90;
    var smashBottom = headY + 220;
    var dy = shuttle.y;
    if (dy < smashTop || dy > smashBottom) return false; // out of reach

    // serve is now returned -> strict service-box rule no longer applies
    w.isServeFlight = false;

    // one-touch rule: can't hit twice in a row on the same side
    if (w.lastHitBy === p.side) {
      shuttle.active = false;
      awardPoint(w, p.side === 'left' ? 'right' : 'left', 'DOUBLE_HIT');
      return true;
    }

    var distFromNetTap = Math.abs(headX - C.NET_X);
    var isNetDink = distFromNetTap <= C.NET_DINK_DISTANCE && chargeFrac <= C.NET_DINK_TAP_MAX_CHARGE;
    var kind = isNetDink ? 'dink' : ((!p.onGround && chargeFrac >= 0.5) ? 'smash' : 'float');
    var power = C.MIN_POWER_MULT + (C.MAX_POWER_MULT - C.MIN_POWER_MULT) * chargeFrac;

    p.lastHitTime = now;
    w.lastHitBy = p.side;
    w.rallyHitCount++;
    p.swingTimer = C.SWING_DURATION;
    p.swingPowerFrac = 0.6 + 0.4 * chargeFrac;
    p.swingKind = kind;
    var dir = p.side === 'left' ? 1 : -1;

    if (kind === 'smash') {
      var distFromNet = Math.abs(headX - C.NET_X);
      var halfCourt = (C.COURT_RIGHT - C.COURT_LEFT) / 2;
      var netProximityFrac = Math.max(0, Math.min(1, distFromNet / halfCourt));
      var netSpeedScale = C.SMASH_NET_SLOWDOWN + (1 - C.SMASH_NET_SLOWDOWN) * netProximityFrac;
      var speed = C.SMASH_BASE_SPEED * power * netSpeedScale * powerMultFor(p.character);
      var netCloseFrac = Math.max(0, Math.min(1, 1 - distFromNet / C.NET_CLOSE_RANGE));
      var angleDeg = C.SMASH_BACK_ANGLE + (C.SMASH_NET_STEEP_ANGLE - C.SMASH_BACK_ANGLE) * netCloseFrac;
      var angleS = (angleDeg - manualOffset(w, p)) * Math.PI / 180;
      shuttle.vx = dir * speed * Math.cos(angleS);
      shuttle.vy = speed * Math.sin(angleS);
      shuttle.kind = 'smash';
      shuttle.hitByMaxPower = !!(p.character && p.character.stats && p.character.stats.power === 5);
      shuttle.hitDir = dir;
      shuttle.maxPowerDiveApplied = false;
      shuttle.dinkDiveApplied = false;
      shuttle.netCollisionResolved = false;
      emit(w, { kind: 'shake', mag: 9, duration: C.SHAKE_SMASH_DURATION });
      emit(w, { kind: 'hit', side: p.side, hitKind: 'smash', x: shuttle.x, y: shuttle.y });
    } else if (kind === 'dink') {
      shuttle.kind = 'dink';
      shuttle.hitByMaxPower = false;
      shuttle.maxPowerDiveApplied = false;
      var control = (p.character && p.character.stats && p.character.stats.control) || 3;
      var dinkAccuracyMult = statMult(control, C.DINK_CONTROL_ACCURACY_LINEAR, C.DINK_CONTROL_ACCURACY_KICKER);
      var dinkDiveMult = statMult(control, C.DINK_CONTROL_DIVE_LINEAR, C.DINK_CONTROL_DIVE_KICKER);
      var meanDist = C.DINK_LANDING_BASE_DIST / dinkAccuracyMult;
      var varianceRange = C.DINK_LANDING_VARIANCE_BASE / dinkAccuracyMult;
      var jitter = (Math.random() * 2 - 1) * varianceRange;
      var targetDist = Math.max(C.DINK_LANDING_MIN_DIST, meanDist + jitter);
      shuttle.dinkPostNetGravity = C.DINK_POST_NET_GRAVITY_BASE * dinkDiveMult;
      shuttle.dinkDiveApplied = false;
      shuttle.dinkDir = dir;
      shuttle.netCollisionResolved = false;
      var dinkLaunch = solveDinkTrajectory(dy, distFromNetTap, shuttle.dinkPostNetGravity, targetDist);
      shuttle.vx = dir * dinkLaunch.vx;
      shuttle.vy = dinkLaunch.vy;
      emit(w, { kind: 'hit', side: p.side, hitKind: 'dink', x: shuttle.x, y: shuttle.y });
    } else {
      shuttle.kind = 'float';
      shuttle.hitByMaxPower = false;
      shuttle.maxPowerDiveApplied = false;
      shuttle.dinkDiveApplied = false;
      shuttle.netCollisionResolved = false;
      var speedF = C.FLOAT_BASE_SPEED * power * powerMultForRegular(p.character);
      var distFromNetF = Math.abs(headX - C.NET_X);
      var halfCourtF = (C.COURT_RIGHT - C.COURT_LEFT) / 2;
      var netDistFrac = Math.max(0, Math.min(1, distFromNetF / halfCourtF));
      var angleDegF = C.FLOAT_ANGLE_NEAR + (C.FLOAT_ANGLE_FAR - C.FLOAT_ANGLE_NEAR) * netDistFrac;
      var angleF = (angleDegF + manualOffset(w, p)) * Math.PI / 180;
      shuttle.vx = dir * speedF * Math.cos(angleF);
      shuttle.vy = -speedF * Math.sin(angleF);
      emit(w, { kind: 'shake', mag: 2.5, duration: 0.12 });
      emit(w, { kind: 'hit', side: p.side, hitKind: 'float', x: shuttle.x, y: shuttle.y });
    }
    shuttle.x = headX + dir * 10;
    shuttle.y = dy;
    return true;
  }

  function doServe(w, p, chargeFrac, now) {
    chargeFrac = (typeof chargeFrac === 'number') ? chargeFrac : 1;
    var power = C.SERVE_MIN_POWER_MULT + (1 - C.SERVE_MIN_POWER_MULT) * chargeFrac;
    var shuttle = w.shuttle;
    w.lastHitBy = p.side;
    w.rallyHitCount = 1;
    if (typeof now === 'number') p.lastHitTime = now;
    p.swingTimer = C.SWING_DURATION;
    p.swingPowerFrac = 0.6 + 0.4 * chargeFrac;
    p.swingKind = 'float';
    var dir = p.side === 'left' ? 1 : -1;
    var speed = C.SERVE_BASE_SPEED * power * powerMultForRegular(p.character);
    var angle = 32 * Math.PI / 180;
    shuttle.vx = dir * speed * Math.cos(angle);
    shuttle.vy = -speed * Math.sin(angle);
    shuttle.active = true;
    w.isServeFlight = true;
    w.state = 'rally';
    emit(w, { kind: 'hit', side: p.side, hitKind: 'serve', x: shuttle.x, y: shuttle.y });
  }

  // ---- serve / scoring (verbatim) ----------------------------------------
  function getServer(scoreA, scoreB) {
    var total = scoreA + scoreB;
    if (scoreA >= 20 && scoreB >= 20) return total % 2 === 0 ? 'left' : 'right';
    return Math.floor(total / 2) % 2 === 0 ? 'left' : 'right';
  }

  function isServiceFault(w, x) {
    if (w.servingSide === 'left') {
      if (x <= C.NET_X) return false;
      return x < C.SERVICE_SHORT_X_RIGHT || x > C.SERVICE_LONG_X_RIGHT;
    } else {
      if (x >= C.NET_X) return false;
      return x > C.SERVICE_SHORT_X_LEFT || x < C.SERVICE_LONG_X_LEFT;
    }
  }

  function setupServe(w) {
    w.servingSide = getServer(w.left.score, w.right.score);
    var server = w.servingSide === 'left' ? w.left : w.right;
    var serveDir = w.servingSide === 'left' ? 1 : -1;
    var shuttle = w.shuttle;
    shuttle.x = server.x + C.PLAYER_W / 2 + serveDir * 10;
    shuttle.y = server.y + C.PLAYER_H * 0.52;
    shuttle.vx = 0; shuttle.vy = 0;
    shuttle.active = false;
    shuttle.kind = 'float';
    shuttle.hitByMaxPower = false;
    shuttle.maxPowerDiveApplied = false;
    shuttle.dinkDiveApplied = false;
    shuttle.netCollisionResolved = false;
    shuttle.angle = -Math.PI / 2;
    w.left.charging = false;
    w.right.charging = false;
    w.left.swingTimer = 0;
    w.right.swingTimer = 0;
    w.isServeFlight = false;
    w.state = 'serve';
    w.rallyHitCount = 0;
    emit(w, { kind: 'serve', servingSide: w.servingSide });
  }

  function awardPoint(w, sideThatScores, reason) {
    if (sideThatScores === 'left') w.left.score++; else w.right.score++;
    var a = w.left.score, b = w.right.score;
    var leader = a >= b ? w.left : w.right;
    var trailer = a >= b ? w.right : w.left;
    emit(w, { kind: 'point', scorer: sideThatScores, reason: reason, leftScore: a, rightScore: b });
    if ((leader.score >= C.WIN_SCORE && leader.score - trailer.score >= 2) || leader.score >= C.WIN_CAP) {
      endGame(w, leader);
      return;
    }
    w.pointPauseTimer = C.POINT_PAUSE_DURATION;
    w.state = 'pointPause';
  }

  function endGame(w, winner) {
    w.state = 'gameOver';
    w.winner = winner.side;
    emit(w, { kind: 'gameOver', winner: winner.side, leftScore: w.left.score, rightScore: w.right.score });
  }

  // ---- per-player movement (verbatim, reads held input off the player) ----
  function updatePlayer(w, p, dt) {
    var vx = 0;
    var spMult = speedMultFor(p.character);
    if (p.dashTimer > 0) {
      vx = p.dashDir * C.DASH_SPEED * dashDistanceMultFor(p.character);
      p.dashTimer -= dt;
    } else {
      if (p.inLeft) vx -= C.MOVE_SPEED * spMult;
      if (p.inRight) vx += C.MOVE_SPEED * spMult;
    }
    p.vx = vx;
    p.swingTimer = Math.max(0, p.swingTimer - dt);
    p.x += vx * dt;

    var minX = p.minX, maxX = p.maxX;
    if (w.state === 'serve') {
      if (p.side === 'left') {
        minX = C.SERVICE_LONG_X_LEFT;
        maxX = C.SERVICE_SHORT_X_LEFT - C.PLAYER_W;
      } else {
        minX = C.SERVICE_SHORT_X_RIGHT;
        maxX = C.SERVICE_LONG_X_RIGHT - C.PLAYER_W;
      }
    }
    if (p.x < minX) p.x = minX;
    if (p.x > maxX) p.x = maxX;

    p.vy += C.PLAYER_GRAVITY * dt;
    p.y += p.vy * dt;
    if (p.y + C.PLAYER_H >= C.GROUND_Y) {
      p.y = C.GROUND_Y - C.PLAYER_H;
      p.vy = 0;
      p.onGround = true;
    }
  }

  // ---- dink trajectory solvers (pure; verbatim) --------------------------
  function simulateDinkFlight(vx0, vy0, startY, distFromNet, postNetGravity) {
    var x = -distFromNet, y = startY, vx = vx0, vy = vy0, dived = false;
    var netClearY = distFromNet <= 0 ? startY : null;
    var dt = 1 / 120;
    for (var i = 0; i < 600; i++) {
      var g = dived ? postNetGravity : C.DINK_PRE_NET_GRAVITY;
      var termVy = dived ? C.DINK_POST_NET_TERMINAL_VY : C.DINK_PRE_NET_TERMINAL_VY;
      vy += g * dt;
      if (vy > termVy) vy = termVy;
      vx -= C.HORIZONTAL_DRAG * vx * dt;
      var prevX = x;
      x += vx * dt;
      y += vy * dt;
      if (prevX < 0 && x >= 0 && netClearY === null) netClearY = y;
      if (!dived && x >= C.DINK_POST_NET_TRIGGER_DIST) dived = true;
      if (y + C.SHUTTLE_RADIUS >= C.GROUND_Y) break;
    }
    return { landDist: x, netClearY: netClearY };
  }
  function solveDinkLaunchSpeed(vy0, startY, distFromNet, postNetGravity, targetDist) {
    var lo = 20, hi = 1600;
    for (var iter = 0; iter < 16; iter++) {
      var mid = (lo + hi) / 2;
      var landDist = simulateDinkFlight(mid, vy0, startY, distFromNet, postNetGravity).landDist;
      if (landDist < targetDist) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }
  function solveDinkTrajectory(startY, distFromNet, postNetGravity, targetDist) {
    var arcHeight = C.DINK_ARC_HEIGHT;
    var vx0, vy0, netClearY;
    for (var attempt = 0; attempt < 8; attempt++) {
      vy0 = -Math.sqrt(2 * C.DINK_PRE_NET_GRAVITY * arcHeight);
      vx0 = solveDinkLaunchSpeed(vy0, startY, distFromNet, postNetGravity, targetDist);
      netClearY = simulateDinkFlight(vx0, vy0, startY, distFromNet, postNetGravity).netClearY;
      if (netClearY !== null && netClearY <= C.NET_TOP - C.DINK_NET_CLEARANCE_MARGIN) break;
      arcHeight *= 1.35;
    }
    return { vx: vx0, vy: vy0 };
  }

  // ---- shuttle gravity selection (verbatim; takes shuttle param) ----------
  function currentShuttleGravity(shuttle) {
    return shuttle.maxPowerDiveApplied ? C.SMASH_MAXPOWER_DIVE_GRAVITY
      : shuttle.dinkDiveApplied ? shuttle.dinkPostNetGravity
        : shuttle.kind === 'dink' ? C.DINK_PRE_NET_GRAVITY
          : C.SHUTTLE_GRAVITY;
  }
  function currentShuttleTerminalVy(shuttle) {
    return shuttle.maxPowerDiveApplied ? C.SMASH_MAXPOWER_DIVE_TERMINAL_VY
      : shuttle.dinkDiveApplied ? C.DINK_POST_NET_TERMINAL_VY
        : shuttle.kind === 'dink' ? C.DINK_PRE_NET_TERMINAL_VY
          : C.SHUTTLE_TERMINAL_VY;
  }

  // ---- shuttle integration + collisions + scoring (verbatim) --------------
  function updateShuttle(w, dt) {
    var shuttle = w.shuttle;
    if (!shuttle.active) return;

    var gravity = currentShuttleGravity(shuttle);
    var terminalVy = currentShuttleTerminalVy(shuttle);
    shuttle.vy += gravity * dt;
    if (shuttle.vy > terminalVy) shuttle.vy = terminalVy;
    shuttle.vx -= C.HORIZONTAL_DRAG * shuttle.vx * dt;
    shuttle.x += shuttle.vx * dt;
    shuttle.y += shuttle.vy * dt;

    if (shuttle.kind === 'smash' && shuttle.hitByMaxPower && !shuttle.maxPowerDiveApplied) {
      var pastNetDist = shuttle.hitDir === 1 ? (shuttle.x - C.NET_X) : (C.NET_X - shuttle.x);
      if (pastNetDist >= C.SMASH_MAXPOWER_DIVE_DIST) shuttle.maxPowerDiveApplied = true;
    }
    if (shuttle.kind === 'dink' && !shuttle.dinkDiveApplied) {
      var pastNetDinkDist = shuttle.dinkDir === 1 ? (shuttle.x - C.NET_X) : (C.NET_X - shuttle.x);
      if (pastNetDinkDist >= C.DINK_POST_NET_TRIGGER_DIST) shuttle.dinkDiveApplied = true;
    }

    // Net collision (tape -> cord dribble; body -> fault).
    var inNetX = shuttle.x + C.SHUTTLE_RADIUS >= C.NET_X - C.NET_WIDTH / 2 &&
      shuttle.x - C.SHUTTLE_RADIUS <= C.NET_X + C.NET_WIDTH / 2;
    if (inNetX && !shuttle.netCollisionResolved && shuttle.y + C.SHUTTLE_RADIUS >= C.NET_TOP) {
      shuttle.netCollisionResolved = true;
      var hitTape = (shuttle.y + C.SHUTTLE_RADIUS) <= C.NET_TOP + C.NET_TAPE_BAND;
      emit(w, { kind: 'net', x: C.NET_X, y: shuttle.y, tape: hitTape });
      if (hitTape) {
        var dir = shuttle.vx >= 0 ? 1 : -1;
        var incomingSpeed = Math.abs(shuttle.vx);
        var retainedEnergy = incomingSpeed * C.NET_ENERGY_RETENTION;
        var postNetSpeed = Math.max(C.NET_MIN_POST_SPEED, Math.min(C.NET_MAX_POST_SPEED, retainedEnergy));
        shuttle.vx = dir * postNetSpeed;
        shuttle.vy = C.NET_CORD_BOUNCE_VY;
        shuttle.x = C.NET_X + dir * (C.NET_WIDTH / 2 + C.SHUTTLE_RADIUS + 1);
        shuttle.kind = 'float';
        shuttle.hitByMaxPower = false;
      } else {
        shuttle.vx = 0;
        shuttle.vy = 0;
        shuttle.active = false;
        w.isServeFlight = false;
        awardPoint(w, w.lastHitBy === 'left' ? 'right' : 'left', 'NET_FAULT');
      }
    }

    // Ground collision -> point.
    if (shuttle.y + C.SHUTTLE_RADIUS >= C.GROUND_Y) {
      emit(w, { kind: 'land', x: shuttle.x, y: C.GROUND_Y });
      shuttle.y = C.GROUND_Y - C.SHUTTLE_RADIUS;
      shuttle.active = false;
      if (shuttle.x < C.COURT_LEFT || shuttle.x > C.COURT_RIGHT) {
        var faultSide = w.lastHitBy;
        awardPoint(w, faultSide === 'left' ? 'right' : 'left', 'OUT');
      } else if (w.isServeFlight && isServiceFault(w, shuttle.x)) {
        awardPoint(w, w.servingSide === 'left' ? 'right' : 'left', 'SERVICE_FAULT');
      } else {
        var landedLeft = shuttle.x < C.NET_X;
        awardPoint(w, landedLeft ? 'right' : 'left', 'SHUTTLE_LANDED');
      }
      w.isServeFlight = false;
    }
  }

  /**
   * Advance the whole world one fixed step. Mirrors the order of the original
   * loop() body (minus rendering/particles, which are client-only). `now` is a
   * monotonic time in SECONDS. Events accumulate on w.events for the caller to drain.
   */
  function stepWorld(w, dt, now) {
    if (w.state === 'rally' || w.state === 'serve') {
      updatePlayer(w, w.left, dt);
      updatePlayer(w, w.right, dt);
    }
    if (w.state === 'serve') {
      // shuttle is held in the server's hand until the serve is struck
      var server = w.servingSide === 'left' ? w.left : w.right;
      var serveDir = w.servingSide === 'left' ? 1 : -1;
      w.shuttle.x = server.x + C.PLAYER_W / 2 + serveDir * 10;
      w.shuttle.y = server.y + C.PLAYER_H * 0.52;
    }
    if (w.state === 'rally') {
      updateShuttle(w, dt);
    }
    if (w.state === 'pointPause') {
      w.pointPauseTimer -= dt;
      if (w.pointPauseTimer <= 0) setupServe(w);
    }
  }

  return {
    createWorld: createWorld,
    makePlayer: makePlayer,
    makeShuttle: makeShuttle,
    stepWorld: stepWorld,
    setupServe: setupServe,
    // input primitives (network layer -> sim):
    tryJump: tryJump,
    applyDash: applyDash,
    startCharge: startCharge,
    releaseHit: releaseHit,
    // exposed for AI / prediction reuse:
    reachFor: reachFor,
    chargeTimeFor: chargeTimeFor,
    currentShuttleGravity: currentShuttleGravity,
    currentShuttleTerminalVy: currentShuttleTerminalVy,
    // Phase 8: the client re-runs ONLY movement (never shuttle/hit resolution,
    // which stays server-authoritative) to predict the local player's own
    // position instantly instead of waiting a round trip. Exporting the exact
    // same function the server steps with means client prediction and server
    // truth can never disagree on the movement math itself — only ever on
    // timing, which reconciliation (see index.html) corrects each snapshot.
    updatePlayer: updatePlayer
  };
});
