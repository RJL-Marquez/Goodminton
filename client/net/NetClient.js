/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * client/net/NetClient.js
 * ------------------------
 * Thin WebSocket wrapper the browser client talks to. Owns exactly one
 * connection's lifecycle: opening the socket, the HELLO/WELCOME handshake,
 * the PING/PONG heartbeat (-> `.ping`), encode/decode via shared/serialization.js,
 * and a plain event-emitter surface (`.on`/`.off`) keyed by packet `type` so
 * game code never touches a raw WebSocket or JSON directly.
 *
 * Phase 10 also lives here: an UNINTENTIONAL close (server restart, wifi
 * drop — anything that isn't our own `.disconnect()`) triggers a capped,
 * backed-off series of automatic reconnect attempts at the SOCKET level
 * (re-open + re-HELLO). NetClient has no idea what a "room" is, so it just
 * announces `'reconnecting'` (about to retry) and `'reconnected'` (a new
 * WELCOME landed) — index.html's online-match code listens for
 * `'reconnected'` and, if it was mid-match, sends its own C2S.RECONNECT
 * with the room code/side/token it remembered to actually reclaim the seat.
 * Exhausting every attempt (or a drop before the very first WELCOME ever
 * arrived) falls back to the ordinary `'close'` event.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../../shared/protocol.js'), require('../../shared/serialization.js'));
  } else {
    root.NetClient = factory(root.Protocol, root.Serialization);
  }
})(typeof self !== 'undefined' ? self : this, function (Protocol, Serialization) {
  'use strict';

  // Capped backoff: 5 attempts over ~23s before giving up and telling the
  // game layer the connection is really gone.
  var RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 8000];

  function NetClient() {
    this.clientId = null;
    this.connected = false;
    this.ping = 0;

    this._socket = null;
    this._handlers = Object.create(null);
    this._name = 'Player';
    this._intentionalClose = false;
    this._everConnected = false;   // true once the very first WELCOME lands
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._pingTimer = null;
  }

  NetClient.prototype.on = function (event, handler) {
    (this._handlers[event] || (this._handlers[event] = [])).push(handler);
    return this;
  };

  NetClient.prototype.off = function (event, handler) {
    var list = this._handlers[event];
    if (!list) return this;
    var i = list.indexOf(handler);
    if (i !== -1) list.splice(i, 1);
    return this;
  };

  NetClient.prototype._emit = function (event, packet) {
    var list = this._handlers[event];
    if (!list || !list.length) return;
    list.slice().forEach(function (h) { h(packet); }); // copy: a handler may on()/off() mid-iteration
  };

  /** Open the socket and perform the HELLO/WELCOME handshake. */
  NetClient.prototype.connect = function (name) {
    this._intentionalClose = false;
    if (typeof name === 'string' && name) this._name = name;
    this._open();
  };

  NetClient.prototype._wsUrl = function () {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/ws';
  };

  NetClient.prototype._open = function () {
    var self = this;
    var isReconnectAttempt = this._everConnected;
    var socket;
    try {
      socket = new WebSocket(this._wsUrl());
    } catch (e) {
      this._onCloseOrFail(isReconnectAttempt);
      return;
    }
    this._socket = socket;

    socket.addEventListener('open', function () {
      socket.send(Serialization.encode({ type: Protocol.C2S.HELLO, name: self._name }));
    });

    socket.addEventListener('message', function (evt) {
      var packet = Serialization.decode(evt.data);
      if (!packet) return;
      if (packet.type === Protocol.S2C.WELCOME) {
        var wasReconnecting = self._everConnected;
        self.clientId = packet.clientId;
        self.connected = true;
        self._everConnected = true;
        self._reconnectAttempt = 0;
        self._startPing();
        if (wasReconnecting) self._emit('reconnected', packet);
      } else if (packet.type === Protocol.S2C.PONG) {
        self.ping = Math.max(0, Math.round(performance.now() - packet.t));
      }
      self._emit(packet.type, packet);
    });

    socket.addEventListener('close', function () {
      self.connected = false;
      self._stopPing();
      self._onCloseOrFail(isReconnectAttempt);
    });

    socket.addEventListener('error', function () { /* 'close' always follows; nothing extra to do */ });
  };

  NetClient.prototype._onCloseOrFail = function () {
    if (this._intentionalClose || !this._everConnected) {
      this._emit('close', {});
      return;
    }
    this._attemptReconnect();
  };

  NetClient.prototype._attemptReconnect = function () {
    var self = this;
    if (this._reconnectAttempt >= RECONNECT_DELAYS_MS.length) {
      this._emit('close', {});
      return;
    }
    var delay = RECONNECT_DELAYS_MS[this._reconnectAttempt];
    this._reconnectAttempt++;
    this._emit('reconnecting', { attempt: this._reconnectAttempt, max: RECONNECT_DELAYS_MS.length, delayMs: delay });
    this._reconnectTimer = setTimeout(function () {
      self._reconnectTimer = null;
      self._open();
    }, delay);
  };

  NetClient.prototype._startPing = function () {
    var self = this;
    this._stopPing();
    this._pingTimer = setInterval(function () {
      if (self.connected) self.send(Protocol.C2S.PING, { t: performance.now() });
    }, Protocol.PING_INTERVAL_MS);
  };

  NetClient.prototype._stopPing = function () {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  };

  NetClient.prototype.send = function (type, fields) {
    if (!this._socket || this._socket.readyState !== WebSocket.OPEN) return;
    this._socket.send(Serialization.encode(Object.assign({ type: type }, fields || {})));
  };

  /** User-initiated disconnect — no automatic reconnect follows this. */
  NetClient.prototype.disconnect = function () {
    this._intentionalClose = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._stopPing();
    if (this._socket) { try { this._socket.close(); } catch (e) { /* already closing */ } }
    this.connected = false;
  };

  return NetClient;
});
