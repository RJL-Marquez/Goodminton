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
    SHUTTLE_GRAVITY: 950,
    SHUTTLE_TERMINAL_VY: 260,
    HORIZONTAL_DRAG: 1.1,
    HIT_COOLDOWN: 1.0,
    HIT_REACH_X: 72,
    MAX_CHARGE_TIME: 0.8,
    MIN_POWER_MULT: 0.5,
    MAX_POWER_MULT: 1.0,

    // --- Float / clear ---
    FLOAT_BASE_SPEED: 1440,
    FLOAT_ANGLE_NEAR: 24,
    FLOAT_ANGLE_FAR: 37,

    // --- Smash ---
    SMASH_BASE_SPEED: 2185,
    SMASH_NET_SLOWDOWN: 0.55,
    SMASH_NET_STEEP_ANGLE: 46,
    SMASH_BACK_ANGLE: 23,
    NET_CLOSE_RANGE: 90,
    SMASH_MAXPOWER_DIVE_DIST: 45,
    SMASH_MAXPOWER_DIVE_GRAVITY: 1900,
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
    SERVE_BASE_SPEED: 1130,
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
      stats: { speed: 3, power: 4, control: 5 }, tagline: 'Well-rounded, with real punch behind it.' }
  ];

  return C;
});
