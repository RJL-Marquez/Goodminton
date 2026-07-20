/**
 * Phase 1 smoke test. Boots the server in-process, opens a real WebSocket client,
 * and asserts the HELLO->WELCOME handshake and PING->PONG round-trip work.
 * Run: node server/test-phase1.js
 */
'use strict';
const { server } = require('./index.js');
const WebSocket = require('ws');
const Protocol = require('../shared/protocol.js');
const Serialization = require('../shared/serialization.js');

const PORT = server.address() ? server.address().port : 3000;

function run() {
  const url = `ws://localhost:${PORT}/ws`;
  const ws = new WebSocket(url);
  let gotWelcome = false, gotPong = false;

  const done = (ok, msg) => {
    console.log(ok ? 'PASS: ' + msg : 'FAIL: ' + msg);
    ws.close();
    server.close();
    process.exit(ok ? 0 : 1);
  };

  ws.on('open', () => ws.send(Serialization.encode({ type: Protocol.C2S.HELLO, name: 'Tester' })));
  ws.on('message', (data) => {
    const p = Serialization.decode(data);
    if (p.type === Protocol.S2C.WELCOME) {
      gotWelcome = p.clientId > 0 && p.protocol === Protocol.PROTOCOL_VERSION;
      console.log('  welcome:', JSON.stringify(p));
      ws.send(Serialization.encode({ type: Protocol.C2S.PING, t: 12345 }));
    } else if (p.type === Protocol.S2C.PONG) {
      gotPong = p.t === 12345;
      console.log('  pong:', JSON.stringify(p));
      done(gotWelcome && gotPong, 'handshake + ping round-trip');
    }
  });
  ws.on('error', (e) => done(false, 'socket error: ' + e.message));
  setTimeout(() => done(false, 'timeout waiting for welcome/pong'), 3000);
}

// index.js calls server.listen already; wait a tick for the port to bind.
setTimeout(run, 300);
