/**
 * Live end-to-end integration test: boots the real server, drives two real
 * WebSocket clients through the FULL flow (host -> join -> ready -> start ->
 * live snapshots) and then exercises Phase 10 for real — closes one socket
 * mid-match, confirms the match pauses and the other player is notified, and
 * confirms a fresh socket presenting the right room code/side/token resumes
 * the same match. Everything else in this suite unit-tests Lobby.js/Room.js
 * directly (test-phase3/4/9/10.js); this is the one test that proves the
 * real transport wiring in server/index.js (the socket 'close' handler ->
 * Lobby.disconnect(), the RECONNECT packet route) actually works over a
 * real socket, not just via a hand-built fake `conn`.
 * Run: node server/test-live-e2e.js
 */
'use strict';
const { server } = require('./index.js');
const WebSocket = require('ws');
const Protocol = require('../shared/protocol.js');
const Serialization = require('../shared/serialization.js');

function connect(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
  });
}
const send = (ws, type, fields) => ws.send(Serialization.encode(Object.assign({ type }, fields)));
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function collector(ws) {
  const msgs = [];
  ws.on('message', (d) => { const p = Serialization.decode(d); if (p) msgs.push(p); });
  return msgs;
}
function latestOfType(msgs, type) {
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].type === type) return msgs[i];
  return null;
}

async function main() {
  const PORT = server.address().port;
  const url = `ws://localhost:${PORT}/ws`;
  let ok = true;
  const assert = (cond, msg) => { if (!cond) { ok = false; console.log('FAIL:', msg); } else { console.log('PASS:', msg); } };

  // ---- host + join ----
  const a = await connect(url);
  const aMsgs = collector(a);
  send(a, Protocol.C2S.HELLO, { name: 'Alice' });
  await wait(100);
  send(a, Protocol.C2S.CREATE_LOBBY, {});
  await wait(100);
  const lobby1 = latestOfType(aMsgs, Protocol.S2C.LOBBY_STATE);
  assert(lobby1 && lobby1.code && lobby1.code.length === 6, 'host received a 6-char room code');
  const code = lobby1.code;

  const b = await connect(url);
  const bMsgs = collector(b);
  send(b, Protocol.C2S.HELLO, { name: 'Bob' });
  await wait(100);
  send(b, Protocol.C2S.JOIN_LOBBY, { code, name: 'Bob' });
  await wait(150);
  const lobby2 = latestOfType(bMsgs, Protocol.S2C.LOBBY_STATE);
  assert(lobby2 && lobby2.players.every((p) => p.occupied), 'both slots occupied after join');

  // ---- ready + start ----
  send(a, Protocol.C2S.READY, { ready: true });
  send(b, Protocol.C2S.READY, { ready: true });
  await wait(100);
  send(a, Protocol.C2S.START_MATCH, {});
  await wait(200);
  const matchStartA = latestOfType(aMsgs, Protocol.S2C.MATCH_START);
  const matchStartB = latestOfType(bMsgs, Protocol.S2C.MATCH_START);
  assert(matchStartA && matchStartA.yourSide === 'left' && matchStartA.yourToken, 'A got matchStart with left seat + private token');
  assert(matchStartB && matchStartB.yourSide === 'right' && matchStartB.yourToken, 'B got matchStart with right seat + private token');
  assert(matchStartA.yourToken !== matchStartB.yourToken, 'tokens differ per side');

  await wait(300);
  assert(latestOfType(aMsgs, Protocol.S2C.SNAPSHOT) !== null, 'snapshots are flowing during the match');

  // ---- Phase 10: live disconnect + reconnect ----
  const aToken = matchStartA.yourToken;
  a.close(); // simulate a dropped connection (not a clean LEAVE_LOBBY)
  await wait(150);
  const discEvt = bMsgs.filter((m) => m.type === Protocol.S2C.EVENT && m.kind === 'opponentDisconnected').pop();
  assert(discEvt && discEvt.data.side === 'left', 'B was told A (left) disconnected mid-match');

  const snapshotsBeforePause = bMsgs.filter((m) => m.type === Protocol.S2C.SNAPSHOT).length;
  await wait(300);
  const snapshotsDuringPause = bMsgs.filter((m) => m.type === Protocol.S2C.SNAPSHOT).length;
  assert(snapshotsDuringPause === snapshotsBeforePause, 'match is paused (no new snapshots) while A is disconnected');

  const a2 = await connect(url);
  const a2Msgs = collector(a2);
  send(a2, Protocol.C2S.HELLO, { name: 'Alice' });
  await wait(100);
  send(a2, Protocol.C2S.RECONNECT, { code, side: 'left', token: aToken });
  await wait(150);
  const resumePacket = latestOfType(a2Msgs, Protocol.S2C.MATCH_START);
  assert(resumePacket && resumePacket.yourSide === 'left', 'reconnected socket got matchStart to resume as left');

  await wait(300);
  assert(latestOfType(a2Msgs, Protocol.S2C.SNAPSHOT) !== null, 'match resumed streaming snapshots after reconnect');

  a2.close(); b.close();
  server.close();
  console.log(ok ? '\nALL PASS (live end-to-end + Phase 10 reconnect)' : '\nSOME FAILURES ABOVE');
  process.exit(ok ? 0 : 1);
}
setTimeout(main, 300);
