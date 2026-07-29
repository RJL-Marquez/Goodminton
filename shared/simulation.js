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
    var base = C.HIT_REACH_X + diff * 14 + sign * diff * diff * 3;
    if (ch && (ch.id === 'ninjja' || ch.passive === 'UNTOUCHABLE')) {
      base *= 1.25;
    }
    return base;
  }
  function dashDistanceMultFor(ch) { return statMult(ch && ch.stats && ch.stats.speed, C.DASH_DIST_LINEAR, C.DASH_DIST_KICKER); }

  // ==== MOMENTUM ENGINE (MOMENTUM_SPEC Parts 0-2) =========================
  // Phase 1: the meter and its per-character fill weights only. No ultimates,
  // no stamina spend, no physics changes — just the numbers and the tiers.
  //
  // DETERMINISM (Part 0.1): no Math.random, no Date.now. Every input comes from
  // simulation state or the `now` already threaded through the sim. All mutable
  // state lives on the player object, so this same engine drives BOTH the
  // authoritative server world here AND the local/AI-vs-AI sim inlined in
  // index.html — they cannot compute a different meter from the same contact.
  var MO = C.MOMENTUM;

  function mechFor(ch) {
    return (ch && ch.id && C.CHARACTER_MECHANICS && C.CHARACTER_MECHANICS[ch.id]) || null;
  }

  // 0-49 Building, 50-99 Momentum Shift, 100 PEAK (Part 1.1).
  function momentumTierOf(m) {
    if (m >= MO.MAX) return 2;
    if (m >= MO.TIER_1) return 1;
    return 0;
  }

  // Initialise / reset every field the engine reads or writes. Called from the
  // player factory and at the start of each GAME (Part 1.2 — momentum resets per
  // game, not per rally, so nothing here is touched on a serve).
  function initMomentum(p) {
    p.momentum = 0;
    p.momentumTier = 0;
    p.moStreak = 0;        // maya: consecutive clean contacts (escalation)
    p.moVarStreak = 0;     // rodrigo: consecutive different-kind contacts
    p.moReturnStreak = 0;  // benjamin: consecutive returns w/o initiating offense
    p.moLastKind = null;   // rodrigo/sofia: previous shot type
    p.moContacts = 0;      // clean counting contacts this game (instrumentation)
    p.moPeakContacts = 0;  // contacts taken to first reach PEAK (0 until reached)
    p.moPeakTime = 0;      // `now` at first PEAK (0 until reached)
    p.moGainSum = 0;       // Part 0.3: running total gain, for weighted-avg readout
    p.moGainCount = 0;     // Part 0.3: number of gains, for weighted-avg readout
    p.moPeakEmitted = false; // one-shot guard for the PEAK-reached event
  }
  function resetMomentum(p) { initMomentum(p); }

  function oppDistFrac(p, opp) {
    if (!opp) return 0;
    return Math.min(1, Math.abs((opp.x || 0) - (p.x || 0)) / (C.COURT_RIGHT - C.COURT_LEFT));
  }

  // Tags active on one contact. The weight table takes the MAX weight among the
  // tags it has an entry for; unlisted tags fall back to BASE_GAIN (Part 2.1/2.2).
  function contactTags(ctx) {
    var tags = {};
    if (ctx.event) tags[ctx.event] = true;
    if (ctx.aerial) tags.aerial = true;
    if (ctx.aerial && ctx.event === 'smash') tags.aerialSmash = true;
    if (ctx.dashSave) tags.dashSave = true;
    if (ctx.stretch) tags.stretch = true;
    if (ctx.event && ctx.event !== 'serve') tags.returns = true; // any rally return
    return tags;
  }

  function weightForTags(weights, tags) {
    var best = null;
    for (var k in weights) {
      if (tags[k] && (best === null || weights[k] > best)) best = weights[k];
    }
    return best === null ? MO.BASE_GAIN : best;
  }

  // Signature rules that can't be flat weights (Part 2 note). Deterministic; read
  // per-player streak counters updated in applyMomentumGain. Multipliers are kept
  // deliberately conservative and are the primary knob for the Part 0.3 tuning
  // pass (target: weighted-average gain <= 1.15). Adjust here, not in the weights.
  function applySignature(sig, p, opp, ctx, tags, gain) {
    var behind = opp && (opp.score || 0) > (p.score || 0);
    switch (sig) {
      case 'MAYA_ESCALATION':
        return gain * Math.min(1.5, 1 + 0.06 * Math.max(0, (p.moStreak || 1) - 1));
      case 'JORDAN_WEAK_RETURN':
        // committed jump smash is what forces the weak return
        return gain * (tags.aerialSmash ? 1.8 : 1.0);
      case 'KENJI_DISTANCE':
        return gain * (tags.dashSave ? 1.2 : 1.0);
      case 'AMARA_PLACEMENT':
        // rewards placing the shot far from the opponent (proxy: current spread)
        return gain * (ctx.event === 'smash' ? 1.0 : (1 + 0.4 * oppDistFrac(p, opp)));
      case 'SOFIA_ALTERNATE':
        return gain * (tags.repeats ? 0.8 : (tags.variety ? 1.3 : 1.0));
      case 'PRIYA_ADRENALINE':
        return gain * (behind ? 1.5 : 1.0); // +50% fill while behind (Part 2.3)
      case 'LIAM_RALLY5':
        return gain + ((ctx.rallyHitCount && ctx.rallyHitCount % 5 === 0) ? 1.0 : 0);
      case 'RODRIGO_VARIETY':
        return gain * Math.min(1.5, 1 + 0.1 * (p.moVarStreak || 0));
      case 'MATEO_NO_MOVE':
        return gain * (ctx.moved ? 1.0 : 1.3); // bonus for hits made without moving
      case 'BENJAMIN_RETURN_STREAK':
        return gain * Math.min(1.4, 1 + 0.05 * Math.max(0, (p.moReturnStreak || 1) - 1));
      case 'CRISTIANO_SPOTLIGHT':
        return gain + (behind ? 0.5 : 0); // Spotlight trickle while behind
      case 'NINJJA_OMNISCIENCE':
        return 2.5; // Every clean contact grants highest weight (2.5) regardless of shot type
      case 'DIEGO_MAX_CHARGE_WHIFF': // clean contacts gain normally; whiffs: see applyMomentumWhiff
      case 'ELIJAH_ANY_CONTACT':     // flat weights already cover "any contact"
      case 'LINDAN_POINT_BONUS':     // handled in applyMomentumPoint
      default:
        return gain;
    }
  }

  function addMomentum(p, gain, ctx) {
    if (!(gain > 0)) return 0;
    // gain is the WEIGHT-based amount (the value the 1.15 ceiling governs); the
    // meter climbs by gain * FILL_RATE so a ~1.0-weight character peaks in ~30
    // contacts. Instrumentation records the raw weight-gain, not the scaled add.
    p.moGainSum = (p.moGainSum || 0) + gain;
    p.moGainCount = (p.moGainCount || 0) + 1;
    p.moContacts = (p.moContacts || 0) + 1;
    var before = p.momentum || 0;
    p.momentum = Math.min(MO.MAX, before + gain * MO.FILL_RATE);
    p.momentumTier = momentumTierOf(p.momentum);
    if (before < MO.MAX && p.momentum >= MO.MAX && !p.moPeakContacts) {
      p.moPeakContacts = p.moContacts;
      if (ctx && typeof ctx.now === 'number') p.moPeakTime = ctx.now;
    }
    return gain;
  }

  // Main entry for a racket-on-shuttle contact. Mutates p.momentum; returns the
  // gain applied (for instrumentation). `ctx` = {event, aerial, dashSave, stretch,
  // moved, maxCharge, rallyHitCount, now, clean}. opp is the other player.
  function applyMomentumGain(p, opp, ctx) {
    var mech = mechFor(p.character);
    var clean = ctx.clean !== false;

    // Sherman copies the opponent's whole table + signature (Part 2.3); in the
    // mirror (Sherman vs Sherman) fall back to Liam-flat with a 10% fill bonus.
    var weights, sig, mirrorBonus = 1;
    if (mech && mech.signature === 'SHERMAN_INHERIT') {
      var om = mechFor(opp && opp.character);
      if (om && om.signature !== 'SHERMAN_INHERIT') { weights = om.weights; sig = om.signature; }
      else { weights = { float: 1.2, smash: 1.2, dink: 1.2, serve: 1.2 }; sig = 'LIAM_RALLY5'; mirrorBonus = 1.10; }
    } else if (mech) {
      weights = mech.weights; sig = mech.signature;
    } else {
      weights = {}; sig = null;
    }

    var tags = contactTags(ctx);
    // rodrigo variety/repeats depend on the player's own shot history
    if (p.moLastKind !== null && ctx.event && ctx.event !== 'serve') {
      if (ctx.event !== p.moLastKind) tags.variety = true; else tags.repeats = true;
    }

    // Update streak counters BEFORE the signature reads them.
    if (clean && ctx.event && ctx.event !== 'serve') {
      p.moStreak = (p.moStreak || 0) + 1;
      if (p.moLastKind !== null) p.moVarStreak = (ctx.event !== p.moLastKind) ? (p.moVarStreak || 0) + 1 : 0;
      p.moReturnStreak = (ctx.event === 'smash') ? 0 : (p.moReturnStreak || 0) + 1;
      p.moLastKind = ctx.event;
    } else if (!clean) {
      p.moStreak = 0; p.moVarStreak = 0;
    }

    var gain = weightForTags(weights, tags);       // base 1.0 * weight
    gain = applySignature(sig, p, opp, ctx, tags, gain) * mirrorBonus;
    if (clean) gain = Math.max(gain, MO.MIN_GAIN); // Part 0.4 minimum-gain floor

    return addMomentum(p, gain, ctx);
  }

  // Diego builds from a WHIFFED max-charge swing (Part 2.3) — effort, not accuracy.
  // Called from releaseHit's whiff early-returns.
  function applyMomentumWhiff(p, ctx) {
    var mech = mechFor(p.character);
    if (mech && mech.signature === 'DIEGO_MAX_CHARGE_WHIFF' && ctx.maxCharge) {
      return addMomentum(p, (mech.weights.smash || MO.BASE_GAIN) * 0.7, ctx);
    }
    return 0;
  }

  // ---- Ultimate spend resource rules (MOMENTUM_SPEC Part 1.3, Phase 3) ----
  // Only the resource half lives here so both sims agree on WHEN a spend is legal
  // and that it zeroes the meter. The shot/cinematic effect is applied by each
  // sim's releaseHit. Stamina cost (Part 5) is not wired yet — Phase 5.
  function canSpendMomentum(p) { return (p.momentum || 0) >= MO.MAX; }
  function spendMomentum(p) {
    p.momentum = 0;
    p.momentumTier = 0;
    p.moPeakEmitted = false;
    p.moStreak = 0; p.moVarStreak = 0; // spending is a hard reset of the run
  }

  // Point resolution bonuses (Part 2.2/2.3): Lin Dan +2.0 on a point won, stacked;
  // Cristiano's feast pointWon 2.5. `winner`/`loser` are the two players.
  function applyMomentumPoint(winner, loser, ctx) {
    var wm = mechFor(winner && winner.character);
    if (wm) {
      if (wm.signature === 'LINDAN_POINT_BONUS') addMomentum(winner, 2.0, ctx);
      else if (wm.signature === 'CRISTIANO_SPOTLIGHT') addMomentum(winner, 2.5, ctx);
    }
  }

  // ---- world / player factories ------------------------------------------
  function makePlayer(side) {
    var onLeft = side === 'left';
    var pl = {
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
    initMomentum(pl);       // Momentum meter state (MOMENTUM_SPEC Part 1)
    return pl;
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
    if (p.onGround) {
      p.vy = C.JUMP_VELOCITY;
      p.onGround = false;
      p.jumpsUsed = 1;
    } else if (p.transform && p.transform.type === 'ANCHOR' && (!p.jumpsUsed || p.jumpsUsed < 2)) {
      p.vy = C.JUMP_VELOCITY;
      p.jumpsUsed = (p.jumpsUsed || 1) + 1;
    }
  }

  /**
   * Server-side dash. The original detected a double-tap of the movement key
   * and set dashTimer; here the client sends an explicit dash intent (dir) — the
   * server keeps the SAME cooldown gate so it stays authoritative and un-cheatable.
   */
  function applyDash(w, p, dir, now) {
    if (w.state !== 'rally' && w.state !== 'serve') return;
    var cd = (p && p.character && (p.character.id === 'ninjja' || p.character.glow === '#6ef3ff')) ? C.DASH_COOLDOWN * 0.5 : C.DASH_COOLDOWN;
    if (now - p.lastDashTime >= cd) {
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
    // Momentum: a max-charge swing that never connects still counts for Diego
    // (Part 2.3). chargeFrac is already clamped to 1, so >=0.99 means overhold.
    var moMaxCharge = chargeFrac >= 0.99;
    if (now - p.lastHitTime < C.HIT_COOLDOWN) return false;

    var headX = p.x + C.PLAYER_W / 2;
    var headY = p.y;
    var dx = Math.abs(shuttle.x - headX);
    if (dx > reachFor(p.character)) { applyMomentumWhiff(p, { maxCharge: moMaxCharge, now: now }); return false; }

    var smashTop = headY - 90;
    var smashBottom = headY + 220;
    var dy = shuttle.y;
    if (dy < smashTop || dy > smashBottom) { applyMomentumWhiff(p, { maxCharge: moMaxCharge, now: now }); return false; } // out of reach

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
      shuttle.ultSmashArc = false;
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

    // ---- Momentum gain for this clean contact (MOMENTUM_SPEC Part 1/2) ----
    var moOpp = p.side === 'left' ? w.right : w.left;
    applyMomentumGain(p, moOpp, {
      event: kind,
      aerial: !p.onGround,
      dashSave: (now - p.lastDashTime) <= C.DASH_WINDOW,
      stretch: dx >= reachFor(p.character) * 0.8,
      moved: !!(p.inLeft || p.inRight || p.dashTimer > 0),
      maxCharge: moMaxCharge,
      rallyHitCount: w.rallyHitCount,
      now: now,
      clean: true
    });
    if (p.momentumTier === 2 && !p.moPeakEmitted) { p.moPeakEmitted = true; emit(w, { kind: 'momentumPeak', side: p.side }); }
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
    // Momentum: the serve is a clean contact too (Part 2.1).
    applyMomentumGain(p, p.side === 'left' ? w.right : w.left, {
      event: 'serve', aerial: false, moved: false,
      rallyHitCount: w.rallyHitCount, now: now, clean: true
    });
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
    // Momentum point bonuses (Part 2.2/2.3): winner of the rally, then loser.
    var moWinner = sideThatScores === 'left' ? w.left : w.right;
    var moLoser = sideThatScores === 'left' ? w.right : w.left;
    applyMomentumPoint(moWinner, moLoser, { now: null });
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
    if (p.transform && p.transform.type === 'AMEN') {
      vx = 0;
      p.dashTimer = 0;
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
      p.jumpsUsed = 0;
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
          : (shuttle.ultFastDrop && shuttle.vy > 0) ? C.SHUTTLE_GRAVITY * shuttle.ultFastDrop
            : C.SHUTTLE_GRAVITY;
  }
  function currentShuttleTerminalVy(shuttle) {
    return shuttle.maxPowerDiveApplied ? C.SMASH_MAXPOWER_DIVE_TERMINAL_VY
      : shuttle.dinkDiveApplied ? C.DINK_POST_NET_TERMINAL_VY
        : shuttle.kind === 'dink' ? C.DINK_PRE_NET_TERMINAL_VY
          : (shuttle.ultFastDrop && shuttle.vy > 0) ? 1400
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
    // Momentum engine (MOMENTUM_SPEC) — reused by index.html's local sim so the
    // AI-vs-AI meter and the server meter are computed by the exact same code.
    mechFor: mechFor,
    momentumTierOf: momentumTierOf,
    initMomentum: initMomentum,
    resetMomentum: resetMomentum,
    applyMomentumGain: applyMomentumGain,
    applyMomentumWhiff: applyMomentumWhiff,
    applyMomentumPoint: applyMomentumPoint,
    canSpendMomentum: canSpendMomentum,
    spendMomentum: spendMomentum,
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
