/**
 * Phase 2 simulation smoke test. Drives the headless sim through a serve and a
 * rally with no renderer, asserting the state machine and scoring actually fire.
 * Run: node server/test-sim.js
 */
'use strict';
const C = require('../shared/constants.js');
const Sim = require('../shared/simulation.js');

const DT = 1 / 60;
let now = 0;
const w = Sim.createWorld(C.CHARACTERS[0], C.CHARACTERS[1]);

function drain() { const e = w.events.slice(); w.events.length = 0; return e; }

// 1) Fresh world starts in a serve, left to serve.
console.log('initial state:', w.state, 'server:', w.servingSide);
if (w.state !== 'serve') throw new Error('expected serve state');

// 2) Left serves: hold charge one tick, release.
const server = w.servingSide === 'left' ? w.left : w.right;
Sim.startCharge(w, server, now);
now += 0.2;
const contacted = Sim.releaseHit(w, server, now);
console.log('serve contacted:', contacted, '-> state:', w.state, 'shuttle active:', w.shuttle.active);
if (!contacted || w.state !== 'rally') throw new Error('serve did not start rally');

// 3) Run the rally forward with NO returns — shuttle must land and award a point.
let landed = false, pointEvents = [];
for (let i = 0; i < 60 * 8; i++) {
  now += DT;
  Sim.stepWorld(w, DT, now);
  const evs = drain();
  for (const e of evs) {
    if (e.kind === 'point') { pointEvents.push(e); }
    if (e.kind === 'land') landed = true;
  }
  if (w.state === 'pointPause' || w.state === 'gameOver') break;
}
console.log('after rally -> state:', w.state, 'score L/R:', w.left.score, w.right.score);
console.log('point events:', JSON.stringify(pointEvents));
if (!pointEvents.length) throw new Error('no point awarded from an unreturned serve');

// 4) pointPause should auto-advance back to a serve.
for (let i = 0; i < 60 * 2; i++) { now += DT; Sim.stepWorld(w, DT, now); if (w.state === 'serve') break; }
console.log('recovered to serve:', w.state === 'serve');
if (w.state !== 'serve') throw new Error('did not return to serve after pointPause');

// 5) Determinism check: player movement (no RNG) reproduces exactly.
function runMove() {
  const a = Sim.createWorld(C.CHARACTERS[2], C.CHARACTERS[3]);
  a.state = 'rally'; a.shuttle.active = false;
  a.left.inRight = true;
  let t = 0;
  for (let i = 0; i < 100; i++) { t += DT; Sim.stepWorld(a, DT, t); }
  return a.left.x;
}
const x1 = runMove(), x2 = runMove();
console.log('determinism (player move) x1===x2:', x1 === x2, x1.toFixed(4));
if (x1 !== x2) throw new Error('player movement not deterministic');

console.log('PASS: headless simulation plays a point, scores, recovers, deterministic movement');
