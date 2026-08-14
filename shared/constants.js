/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * shared/constants.js
 * -------------------
 * Faithful extraction of every gameplay tuning constant and the character roster
 * from the original index.html game script. These are the numbers the physics is
 * balanced around — the authoritative server simulation (shared/simulation.js)
 * and the browser client BOTH import this exact object, so server physics and
 * client prediction can never disagree on a single value.
 *
 * NOTHING here reads the DOM or canvas. Values that were derived from the canvas
 * size in the original (W, H, NET_X, court margins) are hard-coded to the same
 * numbers the 1300x730 canvas produced, and re-exported so rendering keeps using
 * them unchanged.
 *
 * If you change a number here it changes BOTH ends at once — that is the point.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GameConstants = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Canvas-derived geometry. Original: canvas 1300x730 => W=1300, H=730, NET_X=W/2.
  var W = 1300, H = 730;

  var C = {
    W: W,
    H: H,

    GROUND_Y: 620,
    SCORE_STRIP_H: 54,
    FANS_TOP: 190,
    FANS_BOTTOM: 280,
    COURT_TOP: 360,
    NET_X: W / 2,
    NET_WIDTH: 8,
    NET_HEIGHT: 80,
    // NET_TOP derived below (GROUND_Y - NET_HEIGHT) after literals are set.

    // --- Net collision tuning ---
    NET_TAPE_BAND: 14,
    NET_CORD_CREEP_SPEED: 70,
    NET_CORD_BOUNCE_VY: -90,
    NET_ENERGY_RETENTION: 0.3,
    NET_MIN_POST_SPEED: 40,
    NET_MAX_POST_SPEED: 320,

    // --- Player movement ---
    PLAYER_W: 40,
    PLAYER_H: 70,
    MOVE_SPEED: 300,
    DASH_SPEED: 780,
    DASH_DURATION: 0.15,
    DASH_COOLDOWN: 0.4,
    DASH_WINDOW: 0.28,
    AI_DASH_TRIGGER_DIST: 160,
    DASH_DIST_LINEAR: 0.14,
    DASH_DIST_KICKER: 0.05,
    PLAYER_GRAVITY: 1500,
    JUMP_VELOCITY: -560,

    // --- Shuttle physics ---
    SHUTTLE_RADIUS: 5.5,
    SHUTTLE_ROTATION_MIN_SPEED_SQ: 25,
    SHUTTLE_GRAVITY: 1200,      // v² drag overhaul: steeper base pull (was 950), paired with SHUTTLE_DRAG_K
                                // DO NOT retune casually: every ultLaunchToward() arc height is derived
                                // from this value, so changing it reshapes all 22 ult launch sites at once.
    SHUTTLE_DRAG_K: 0.0019,     // quadratic (v²) air drag coefficient (1/px) for base float/serve/smash flight
                                // "A2" retune (was 0.0009). Arc SHAPE is set by k×court_width, not k alone:
                                // 0.0009×1240 = 1.12 read as a ball (landed with 29% of launch vx intact);
                                // 0.0019×1240 = 2.36 matches real badminton (~2.84) — the clear now lands
                                // with ~5% of launch vx, i.e. it stops travelling sideways and drops.
                                // Speeds below are scaled up to match: under v² drag range grows with
                                // log(speed), so a shuttle is hit far harder and dies far faster.
    SHUTTLE_TERMINAL_VY: 1200,  // high SAFETY clamp only now (was 260); real fall speed emerges from √(g/k)
    HORIZONTAL_DRAG: 1.1,       // linear drag — dinks + Sherman rain only, NOT base flight
    HIT_COOLDOWN: 1.0,
    HIT_REACH_X: 72,
    MAX_CHARGE_TIME: 0.8,
    MIN_POWER_MULT: 0.5,
    MAX_POWER_MULT: 1.0,

    // --- Float / clear ---
    FLOAT_BASE_SPEED: 3400,     // A2 retune (was 1850, ×1.84) — pairs with SHUTTLE_DRAG_K 0.0019.
                                // Full-charge deep clear: apex at 65% of distance / 37% of flight time,
                                // 78° descent, lands with vx ~151 (was 414). Flight time 1.51s → 1.76s.
    FLOAT_ANGLE_NEAR: 28,       // A2: +4° — the heavier drag eats loft, so the arc needs more of it
    FLOAT_ANGLE_FAR: 44,        // A2: +5° (was 39)

    // --- Smash ---
    SMASH_BASE_SPEED: 3600,     // A2 retune (was 2500) — deliberately ×1.44, NOT the ×1.84 the float got.
                                // The smash now keeps v² drag through the max-power dive (see
                                // usesQuadraticDrag); at a full ×1.84 the extra speed arrived as a flat
                                // laser with a shrinking defender window.
                                // Measured before -> after (dive gravity 950), descent / defender window:
                                //   close  39° / 0.217s  ->  33° / 0.237s   (lands 898 -> 940)
                                //   mid    35° / 0.119s  ->  31° / 0.135s   (lands 796 -> 821)
                                //   deep   35° / 0.073s  ->  33° / 0.100s   (lands 740 -> 761)
                                // So the smash is currently a little FLATTER but lands deeper and gives
                                // the defender more time everywhere. Steepness is not fixed here — that
                                // is the job of the geometric angle-budget model (see the plan), which
                                // replaces the net-distance angle constants entirely.
    SMASH_NET_SLOWDOWN: 0.55,   // still scales ULT smash speed by net proximity; the regular smash
                                // no longer uses it (the steepness cost below does that job instead).

    // --- Smash angle budget -------------------------------------------------------------
    // Replaces the old net-distance angle ramp (SMASH_BACK_ANGLE 23 -> SMASH_NET_STEEP_ANGLE 46
    // across NET_CLOSE_RANGE 90px). That model read two DIFFERENT distance scales — speed off
    // half-court (620px), angle off a 90px window — and knew nothing about contact HEIGHT, which
    // is the variable that actually decides whether a downward shot can reach. Result: a deep
    // jump smash was pinned at 23° with no altitude to spend and went into the net for an
    // instant loss of point.
    //
    // The rule now: a smash is the STEEPEST angle that still clears the tape and still leaves
    // the defender a fair reaction window. The angle is searched against the real integrator
    // (solveSmashAngle), so it self-adapts to any future physics retune instead of needing
    // hand-tuned constants per court region.
    SMASH_ANGLE_MIN: 8,               // flattest smash the search will consider
    SMASH_ANGLE_MAX: 52,              // steepest ditto
    SMASH_STEEP_SPEED_FLOOR: 0.60,    // speed retained at SMASH_ANGLE_MAX (1.0 at SMASH_ANGLE_MIN):
                                      // driving down against a shuttle above you trades pace for angle
    SMASH_NET_MARGIN: 20,             // px of air the shot must keep over the tape
    SMASH_MIN_DEFENSE_WINDOW: 0.20,   // s between net-crossing and landing — human reaction floor
    SMASH_ULT_MIN_DEFENSE_WINDOW: 0.12, // ultimates are allowed to be scarier than a fair rally shot
    // The window owed scales UP with launch speed (never down — the floor above always applies):
    //   owed = floor * max(1, baseSpeed / SMASH_BASE_SPEED)
    // This is what gives Power a real cost, and it had to be added explicitly. The original design
    // assumed the fixed floor alone would make Power self-flattening — measured against the real
    // integrator, it does the OPPOSITE: a faster smash carries farther past the net, so it spends
    // LONGER in the air after crossing, so steeper angles stay inside the window (5★ solved to 33°
    // where 3★ solved to 22°). Power ended up with no downside at all. With the scaling in:
    //   1★  34° / 1432 launch / lands 809      steep, slow, short — a finesse kill
    //   5★  13° / 5104 launch / lands 1215     flat, fast, deep — a power kill
    // Two genuinely different shots, and the hardest hitters owe the most reaction time.
    // (The speed reference is SMASH_BASE_SPEED itself, so no extra constant is needed.)
    SMASH_ANGLE_SEARCH_ITERS: 12,     // bisection steps (~0.01° resolution over the 44° band)
    SMASH_MAXPOWER_DIVE_DIST: 45,
    SMASH_MAXPOWER_DIVE_GRAVITY: 950,   // PARITY FIX (pre-existing desync, found by the A2 parity check):
                                        // index.html was deliberately retuned 1900 -> 950 ("milder downward
                                        // acceleration to keep the curve natural") and this copy never got
                                        // the change, so single-player and the authoritative multiplayer sim
                                        // were dropping max-power smashes at different rates. Client wins:
                                        // that's where the tuning decision was made. At 950 the dive lands
                                        // at 33° with a 0.237s defender window (1900 gave 38° / 0.215s).
    SMASH_MAXPOWER_DIVE_TERMINAL_VY: 900,
    SWING_DURATION: 0.28,
    SHAKE_SMASH_DURATION: 0.28,

    // --- Net dink (soft net shot) ---
    NET_DINK_DISTANCE: 130,
    NET_DINK_TAP_MAX_CHARGE: 0.14,
    DINK_ARC_HEIGHT: 42,
    DINK_PRE_NET_GRAVITY: 700,
    DINK_PRE_NET_TERMINAL_VY: 190,
    DINK_NET_CLEARANCE_MARGIN: 16,
    DINK_POST_NET_TRIGGER_DIST: 22,
    DINK_POST_NET_GRAVITY_BASE: 3400,
    DINK_POST_NET_TERMINAL_VY: 620,
    // Control also scales SHOT VARIANCE on every hit — not just dinks. Before this,
    // HIT_ANGLE_VARIANCE / HIT_SPEED_VARIANCE were a flat ±1.5° / ±3% for every character, so
    // the stat literally named "control" had no effect on shot precision anywhere outside the
    // dink. Both variances are now DIVIDED by statMult(control, ...) below:
    //   1★ ±4.17° / ±8.3%  (≈ ±72px landing scatter)
    //   3★ ±1.50° / ±3.0%  (≈ ±27px — the old flat value, unchanged for neutral characters)
    //   5★ ±0.91° / ±1.8%  (≈ ±16px)
    CONTROL_VARIANCE_LINEAR: 0.22,
    CONTROL_VARIANCE_KICKER: 0.05,

    DINK_CONTROL_ACCURACY_LINEAR: 0.18,
    DINK_CONTROL_ACCURACY_KICKER: 0.05,
    DINK_CONTROL_DIVE_LINEAR: 0.15,
    DINK_CONTROL_DIVE_KICKER: 0.04,
    DINK_LANDING_BASE_DIST: 26,
    DINK_LANDING_VARIANCE_BASE: 22,
    DINK_LANDING_MIN_DIST: 10,

    // --- Charge speed (Speed stat also winds up hits) ---
    CHARGE_SPEED_LINEAR: 0.13,
    CHARGE_SPEED_KICKER: 0.03,

    // --- Regular-hit power scaling (used by AI float placement) ---
    POWER_REGULAR_LINEAR: 0.08,
    POWER_REGULAR_KICKER: 0.02,

    // --- Attack angle (Advanced Controls) ---
    ATTACK_ANGLE_DEFAULT: 0,
    ATTACK_ANGLE_MIN: -35,
    ATTACK_ANGLE_MAX: 35,

    // --- Scoring ---
    WIN_SCORE: 21,
    WIN_CAP: 30,

    // --- Court geometry (verbatim from original) ---
    COURT_MARGIN: 30,
    SERVICE_SHORT_MARGIN: 110, // distance from the net to the short service line
    SERVICE_LONG_MARGIN: 80,   // distance from the outer boundary to the long service line

    // --- Serve ---
    SERVE_BASE_SPEED: 2000,     // A2 retune (was 1300) — ×1.54, not ×1.84: at 2392 serves cleared the
                                // long service line from most legal positions. 2000 preserves the old
                                // landing window, and the charge-to-landing spread tightens 276px → 184px.
    SERVE_MIN_POWER_MULT: 0.7,

    // --- Point pause ---
    POINT_PAUSE_DURATION: 1.1
  };

  // Derived values (kept exactly as the original computed them).
  C.NET_TOP = C.GROUND_Y - C.NET_HEIGHT;
  C.JUMP_PEAK_TIME = -C.JUMP_VELOCITY / C.PLAYER_GRAVITY;
  C.COURT_LEFT = C.COURT_MARGIN;
  C.COURT_RIGHT = C.W - C.COURT_MARGIN;
  C.SERVICE_SHORT_X_LEFT = C.NET_X - C.SERVICE_SHORT_MARGIN;
  C.SERVICE_SHORT_X_RIGHT = C.NET_X + C.SERVICE_SHORT_MARGIN;
  C.SERVICE_LONG_X_LEFT = C.COURT_LEFT + C.SERVICE_LONG_MARGIN;
  C.SERVICE_LONG_X_RIGHT = C.COURT_RIGHT - C.SERVICE_LONG_MARGIN;

  // ---------- character roster (verbatim from the game) ----------
  // stats 1-5: speed -> movement/dash/charge, power -> hit/smash speed,
  // control -> hit forgiveness / dink quality.
  C.CHARACTERS = [
    { id: 'maya', name: 'Maya', skin: '#c68863', hair: '#1b1b1b', hairStyle: 'bun', shirt: '#1f8a8c', shirt2: '#eafffb', shorts: '#123f40', shoe: '#e9e4d8',
      stats: { speed: 3, power: 3, control: 5 }, tagline: 'Precision over power — rarely misses her spot.' },
    { id: 'jordan', name: 'Jordan', skin: '#f0c9a0', hair: '#5a3b23', hairStyle: 'short', shirt: '#2b3a67', shirt2: '#ff9d3d', shorts: '#1c2745', shoe: '#f2ede1',
      stats: { speed: 2, power: 5, control: 3 }, tagline: 'Every swing is meant to end the rally.' },
    { id: 'kenji', name: 'Kenji', skin: '#e8b892', hair: '#161513', hairStyle: 'spiky', shirt: '#b5222c', shirt2: '#161513', shorts: '#161513', shoe: '#e9e4d8',
      stats: { speed: 5, power: 2, control: 4 }, tagline: 'Outruns the shuttle before he outhits it.' },
    { id: 'amara', name: 'Amara', skin: '#6b4226', hair: '#161513', hairStyle: 'braids', shirt: '#6a2ba8', shirt2: '#f2c94c', shorts: '#3a1660', shoe: '#f2ede1',
      stats: { speed: 2, power: 2, control: 5 }, tagline: 'Wins with placement, not force.' },
    { id: 'sofia', name: 'Sofia', skin: '#f4d9c6', hair: '#d9b46a', hairStyle: 'ponytail', shirt: '#ff6f9c', shirt2: '#ffffff', shorts: '#7a2a44', shoe: '#f2ede1',
      stats: { speed: 4, power: 2, control: 5 }, tagline: 'Quick and clean, but light on power.' },
    { id: 'diego', name: 'Diego', skin: '#d99a66', hair: '#20140d', hairStyle: 'short', shirt: '#3fae49', shirt2: '#f2e94c', shorts: '#1d4a20', shoe: '#e9e4d8',
      stats: { speed: 3, power: 5, control: 3 }, tagline: 'Raw strength off every swing, rough around the edges.' },
    { id: 'priya', name: 'Priya', skin: '#a8714a', hair: '#161513', hairStyle: 'long', shirt: '#e0562d', shirt2: '#2b3a67', shorts: '#5c2413', shoe: '#f2ede1',
      stats: { speed: 5, power: 4, control: 2 }, tagline: 'Blazing and heavy-handed — and reckless with it.' },
    { id: 'liam', name: 'Liam', skin: '#f0d5b8', hair: '#a5471f', hairStyle: 'short', shirt: '#5c6770', shirt2: '#3f7cff', shorts: '#2c333a', shoe: '#f2ede1',
      stats: { speed: 3, power: 4, control: 5 }, tagline: 'Well-rounded, with real punch behind it.' },
    { id: 'sherman', name: 'Sherman', skin: '#f4e3cd', hair: '#1b1b1b', hairStyle: 'short', shirt: '#d32f2f', shirt2: '#ffeb3b', shorts: '#111111', shoe: '#ffffff',
      stats: { speed: 4, power: 4, control: 4 }, tagline: 'Balanced at everything, lacking nothing.' },
    { id: 'rodrigo', name: 'Rodrigo', skin: '#e8b892', hair: '#161513', hairStyle: 'short', shirt: '#75aadb', shirt2: '#ffffff', shorts: '#000000', shoe: '#ffffff',
      stats: { speed: 4, power: 3, control: 5 }, tagline: 'Exceptional control with Argentinian flair.' },
    { id: 'mateo', name: 'Mateo', skin: '#d99a66', hair: '#20140d', hairStyle: 'spiky', shirt: '#0038a8', shirt2: '#fcd116', shorts: '#ce1126', shoe: '#ffffff',
      stats: { speed: 1, power: 5, control: 4 }, tagline: 'Powerful but lacks foot speed.' },
    { id: 'lindan', name: 'Lin Dan', skin: '#f4e3cd', hair: '#1b1b1b', hairStyle: 'short', shirt: '#ff0000', shirt2: '#ffff00', shorts: '#ff0000', shoe: '#ffffff',
      stats: { speed: 5, power: 3, control: 4 }, tagline: 'Legendary speed on the court.' },
    { id: 'elijah', name: 'Elijah', skin: '#d99a66', hair: '#161513', hairStyle: 'short', shirt: '#0038a8', shirt2: '#ce1126', shorts: '#000000', shoe: '#ffffff', racketType: 'fish',
      stats: { speed: 4, power: 2, control: 3 }, tagline: 'Slaps shuttles with a wet fish.' },
    { id: 'benjamin', name: 'Benjamin', skin: '#f4d9c6', hair: '#ffffff', hairStyle: 'short', shirt: '#0038b8', shirt2: '#ffffff', shorts: '#ffffff', shoe: '#0038b8', racketType: 'cross', longNose: true,
      stats: { speed: 3, power: 3, control: 3 }, tagline: 'Brings his own wooden plank.' },
    { id: 'cristiano', name: 'Cristiano', skin: '#f0c9a0', hair: '#1b1b1b', hairStyle: 'slick', shirt: '#ff0000', shirt2: '#006600', shorts: '#ff0000', shoe: '#ff0000',
      stats: { speed: 2, power: 5, control: 3 }, tagline: 'SIUUUU! All red, full power.' },
    { id: 'ninjja', name: 'Ninjja', skin: '#e6d2c2', hair: '#0d0d18', hairStyle: 'slick', shirt: '#0a0e2a', shirt2: '#6ef3ff', shorts: '#0a0e2a', shoe: '#101020', glow: '#6ef3ff',
      stats: { speed: 5, power: 5, control: 5 }, hidden: true, tagline: "Hasn't lost focus once. Doesn't plan to start." }
  ];

  // =========================================================================
  // MOMENTUM & ULTIMATES LAYER (MOMENTUM_SPEC.md)
  // -------------------------------------------------------------------------
  // Pure data, consumed identically by the authoritative server sim
  // (shared/simulation.js) and the local/AI-vs-AI sim inlined in index.html.
  // Nothing here reads the DOM. Every value is deterministic (Part 0.1).
  //
  // Build order (spec Part 8): Phase 1 uses MOMENTUM + the `weights`/`signature`
  // of each entry only. `height`, `endurance`, `passive`, `drive`, and `art`
  // are populated now (they are free — pure data) but are not yet wired to
  // physics; they belong to later phases and must not change gameplay until then.
  // =========================================================================

  C.MOMENTUM = {
    MAX: 100,
    TIER_1: 50,
    MIN_GAIN: 0.5,        // Part 0.4 — any clean contact grants at least this
    BASE_GAIN: 1.0,       // Part 2.1 — base per clean contact, × character weight
    NORMALIZE_CEILING: 1.15, // Part 0.3 — weighted-average WEIGHT ceiling to tune to
    // Part 0.3 also targets ~30 clean contacts to PEAK. The weight (compared to
    // NORMALIZE_CEILING) is the cross-character fairness lever; FILL_RATE is the
    // single global scalar that turns a ~1.0-weight character's fill into a
    // ~30-contact climb to MAX (100 / 30). Meter add = weight * FILL_RATE.
    TARGET_PEAK_CONTACTS: 30,
    FILL_RATE: 100 / 30,
    DRIVE_COST: 100,
    ART_COST: 100,
    ART_OVERHOLD_TIME: 0.35,
    GOLDEN_SHUTTLE_ENABLED: false
  };

  C.STAMINA = {
    MAX: 100,
    REGEN_PER_SEC: 8,
    LOW_THRESHOLD: 0.25,
    LOW_POWER_MULT: 0.8,
    COST: { dash: 12, jump: 8, smash: 15, drive: 20, ultimate: 30 }
  };

  // Per-character mechanics, keyed by C.CHARACTERS[].id exactly.
  //   height    — cm (Part 4.2)
  //   endurance — 1..5 (Part 5.2)
  //   weights   — event/modifier -> Momentum weight (Part 2.2). The engine takes
  //               the MAX weight among the tags active on a contact; tags with no
  //               entry fall back to MOMENTUM.BASE_GAIN (1.0). Tag vocabulary:
  //               float / smash / dink / serve / aerial / aerialSmash / dashSave /
  //               stretch / returns / variety / repeats.
  //   signature — named handler for gain rules that can't be a flat weight (Part 2 §note).
  //   passive   — Part 3 (Phase 2, not yet wired).
  //   drive/art — Part 6 (Phase 3, not yet wired).
  C.CHARACTER_MECHANICS = {
    maya: {
      height: 168, endurance: 4,
      weights: { dink: 2.0, stretch: 1.6, smash: 0.5 },
      signature: 'MAYA_ESCALATION', passive: 'MUSCLE_MEMORY',
      drive: 'DEEP_CORNER', art: { id: 'CALLED_SHOT', type: 'cinematic' }
    },
    jordan: {
      height: 186, endurance: 2,
      weights: { smash: 2.2, float: 1.2, dink: 0.4 },
      signature: 'JORDAN_WEAK_RETURN', passive: 'FOLLOW_THROUGH',
      drive: 'GUARANTEED_SMASH', art: { id: 'FULL_STOP', type: 'cinematic' }
    },
    kenji: {
      height: 172, endurance: 3,
      weights: { dashSave: 2.5, float: 1.3, smash: 0.6 },
      signature: 'KENJI_DISTANCE', passive: 'SECOND_WIND',
      drive: 'REPOSITION', art: { id: 'SPLIT_STEP', type: 'transformation' }
    },
    amara: {
      height: 165, endurance: 5,
      weights: { dink: 2.0, placement: 1.8, smash: 0.3 },
      signature: 'AMARA_PLACEMENT', passive: 'READ',
      drive: 'MAX_PLACEMENT', art: { id: 'PUPPETEER', type: 'cinematic' }
    },
    sofia: {
      height: 163, endurance: 3,
      weights: { dink: 1.8, aerial: 1.5, smash: 0.5 },
      signature: 'SOFIA_ALTERNATE', passive: 'LIGHT_FEET',
      drive: 'FREE_FEINT', art: { id: 'GRAND_FEINT', type: 'cinematic' }
    },
    diego: {
      height: 183, endurance: 2,
      weights: { smash: 2.0, float: 1.4, dink: 0.5 },
      signature: 'DIEGO_MAX_CHARGE_WHIFF', passive: 'RECKLESS_SWING',
      drive: 'MAX_POWER_SCATTER', art: { id: 'WRECKING_CLEAR', type: 'cinematic' }
    },
    priya: {
      height: 181, endurance: 1,
      weights: { aerialSmash: 2.2, dashSave: 1.6, dink: 0.4 },
      signature: 'PRIYA_ADRENALINE', passive: 'ADRENALINE',
      drive: 'SPEED_POWER_5', art: { id: 'REDLINE', type: 'transformation' }
    },
    liam: {
      height: 178, endurance: 4,
      weights: { float: 1.2, smash: 1.2, dink: 1.2, serve: 1.2 },
      signature: 'LIAM_RALLY5', passive: 'CONSISTENCY',
      drive: 'NO_MISHIT_3', art: { id: 'RALLY_LOCK', type: 'transformation' }
    },
    sherman: {
      height: 175, endurance: 3,
      weights: { float: 1.5, dink: 1.5, smash: 1.5 },
      signature: 'SHERMAN_FIREWORK', passive: 'MIMICRY',
      drive: 'FIREWORK_RAIN', art: { id: 'FIREWORK_RAIN', type: 'cinematic' }
    },
    rodrigo: {
      height: 174, endurance: 4,
      weights: { variety: 2.0, dink: 1.4, repeats: 0.4 },
      signature: 'RODRIGO_VARIETY', passive: 'FLAIR',
      drive: 'PAUSE_SHOT', art: { id: 'LA_PAUSA', type: 'cinematic' }
    },
    mateo: {
      height: 191, endurance: 5,
      weights: { smash: 2.0, stretch: 2.0 },
      signature: 'MATEO_NO_MOVE', passive: 'ROOT',
      drive: 'DOUBLE_REACH', art: { id: 'ANCHOR', type: 'transformation' }
    },
    lindan: {
      height: 178, endurance: 4,
      weights: { float: 1.1 },
      signature: 'LINDAN_POINT_BONUS', passive: 'COURT_SENSE',
      drive: 'JUMP_SMASH', art: { id: 'LEGEND', type: 'cinematic' }
    },
    elijah: {
      height: 176, endurance: 3,
      weights: { float: 1.3, smash: 1.3, dink: 1.3, serve: 1.3 },
      signature: 'ELIJAH_ANY_CONTACT', passive: 'SLIPPERY',
      drive: 'STIFF_FISH', art: { id: 'FURSONA_UNLEASHED', type: 'transformation' }
    },
    benjamin: {
      height: 170, endurance: 5,
      weights: { returns: 2.0, stretch: 1.5, smash: 0.5 },
      signature: 'BENJAMIN_RETURN_STREAK', passive: 'FLAT_FACE',
      drive: 'WIDE_PLANK', art: { id: 'AMEN', type: 'transformation' }
    },
    cristiano: {
      height: 187, endurance: 2,
      weights: { aerialSmash: 2.5, dink: 0.3, float: 0.7 },
      signature: 'CRISTIANO_SPOTLIGHT', passive: 'SPOTLIGHT',
      drive: 'HANG_TIME', art: { id: 'SIUUUU', type: 'cinematic' }
    },
    ninjja: {
      height: 179, endurance: 5,
      weights: { smash: 2.5, dink: 2.0, aerialSmash: 2.5, dashSave: 2.0, stretch: 2.0 },
      signature: 'NINJJA_OMNISCIENCE', passive: 'UNTOUCHABLE',
      drive: 'PERFECT_READ', art: { id: 'ABSOLUTE_ZONE', type: 'cinematic' }
    }
  };

  return C;
});
