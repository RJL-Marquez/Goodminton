/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * shared/serialization.js
 * -----------------------
 * The one place that knows how packets are turned into bytes and back. Every
 * send/receive on both ends funnels through encode()/decode(), so the transport
 * encoding can be swapped (JSON now, binary later) without touching gameplay,
 * lobby, or networking code.
 *
 * A packet is always a plain object with a `type` field (one of Protocol.C2S /
 * Protocol.S2C) plus type-specific payload fields. We keep it JSON for now:
 * readable in devtools, trivial to debug, and comfortably fast for a 2-player
 * match at 30 snapshots/sec. The seams for a binary format (a shared field
 * schema per type) are intentionally left in encode()/decode() so upgrading is
 * a local change here.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Serialization = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Encode an outgoing packet object into a string ready for socket.send().
   * @param {object} packet - must have a string `type`.
   * @returns {string}
   */
  function encode(packet) {
    if (!packet || typeof packet.type !== 'string') {
      throw new Error('serialization.encode: packet needs a string `type`');
    }
    return JSON.stringify(packet);
  }

  /**
   * Decode an incoming socket message into a packet object. Returns null on
   * malformed data rather than throwing, so a single bad frame can't crash the
   * server's message loop or the client's handler — the caller just ignores null.
   * @param {string|ArrayBuffer|Buffer} data
   * @returns {object|null}
   */
  function decode(data) {
    try {
      var text = typeof data === 'string' ? data : bufferToString(data);
      var obj = JSON.parse(text);
      if (!obj || typeof obj.type !== 'string') return null;
      return obj;
    } catch (e) {
      return null;
    }
  }

  // Handles the browser (ArrayBuffer / Blob-less string) and Node (Buffer) cases
  // for a message that didn't arrive as a plain string.
  function bufferToString(data) {
    if (typeof data === 'string') return data;
    if (typeof Buffer !== 'undefined' && data instanceof Buffer) return data.toString('utf8');
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(data);
    return String(data);
  }

  return { encode: encode, decode: decode };
});
