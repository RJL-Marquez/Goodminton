/**
 * Phase 2 integration test. Boots the real server, seats two sockets into a Room
 * manually (lobby comes in Phase 3), starts the match, and verifies the
 * authoritative scheduler streams snapshots + events to the clients and that the
 * server — not the client — owns scoring.
 * Run: node server/test-phase2.js
 */
'use strict';
const { server, rooms, connections, Room } = require('./index.js');
const WebSocket = require('ws');
const Protocol = require('../shared/protocol.js');
const C = require('../shared/constants.js');
const Serialization = require('../shared/serialization.js');

function connect(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
  });
}
const send = (ws, type, fields) => ws.send(Serialization.encode(Object.assign({ type }, fields)));

async function main() {
  const PORT = server.address().port;
  const url = `ws://localhost:${PORT}/ws`;
  const a = await connect(url);
  const b = await connect(url);

  const idOf = (ws) => new Promise((res) => {
    ws.on('message', function onMsg(d) {
      const p = Serialization.decode(d);
      if (p.type === Protocol.S2C.WELCOME) { ws.removeListener('message', onMsg); res(p.clientId); }
    });
    send(ws, Protocol.C2S.HELLO, { name: 'P' });
  });
  const idA = await idOf(a);
  const idB = await idOf(b);

  // Manually create + seat a room (Phase 3 will do this via lobby packets).
  const room = new Room('TEST01', null);
  rooms.set(room.code, room);
  const connA = connections.get(idA);
  const connB = connections.get(idB);
  room.seat(connA, true);
  room.seat(connB, false);
  room.left.character = C.CHARACTERS[0];
  room.right.character = C.CHARACTERS[1];
  room.startMatch();

  // Collect snapshots + point events on client A.
  let snapshots = 0, points = 0, lastSnap = null, gotHitEvent = false;
  a.on('message', (d) => {
    const p = Serialization.decode(d);
    if (p.type === Protocol.S2C.SNAPSHOT) { snapshots++; lastSnap = p; }
    if (p.type === Protocol.S2C.EVENT && p.kind === Protocol.EVENT.POINT) points++;
    if (p.type === Protocol.S2C.EVENT && p.kind === Protocol.EVENT.HIT) gotHitEvent = true;
  });

  // Left serves: press charge, then release (charge=false) a moment later. INPUT
  // carries a monotonically increasing seq the server echoes back as ackSeq.
  let seq = 1;
  send(a, Protocol.C2S.INPUT, { cmd: { seq: seq++, left: false, right: false, charge: true } });
  await wait(200);
  send(a, Protocol.C2S.INPUT, { cmd: { seq: seq++, left: false, right: false, charge: false } });

  // Let the unreturned serve fly and land -> server awards a point.
  await wait(2500);

  const ok =
    snapshots > 10 &&
    points >= 1 &&
    gotHitEvent &&
    lastSnap && lastSnap.shuttle && typeof lastSnap.shuttle.x === 'number' &&
    (lastSnap.left.score + lastSnap.right.score) >= 1 &&
    lastSnap.ackSeq.left >= 1; // server acked our applied input

  console.log('snapshots received:', snapshots);
  console.log('point events:', points, ' hit event:', gotHitEvent);
  console.log('final score (server-authoritative):', lastSnap.left.score, '/', lastSnap.right.score);
  console.log('ackSeq.left (input acked):', lastSnap.ackSeq.left);
  console.log('last shuttle:', JSON.stringify(lastSnap.shuttle));

  a.close(); b.close(); server.close();
  console.log(ok ? 'PASS: authoritative room streams snapshots/events, server owns scoring'
                 : 'FAIL: see values above');
  process.exit(ok ? 0 : 1);
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

setTimeout(main, 300);
