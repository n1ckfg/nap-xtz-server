// Client for a Pinopticon (openFrameworks / ofxHTTP) websocket server running on a Raspberry Pi.
//
// Reference implementation: Pinopticon/core/Pinoptiglue (src/ofApp.cpp) and
// Pinopticon/core/common/src/Pinopticon_Http.hpp.
//
// Two quirks of the ofxHTTP server, both confirmed against a live RPi, drive the
// design here:
//
//   1. Sending a websocket PING frame drops the connection immediately (close 1006).
//      An idle connection, by contrast, stays up fine. So we never ping; liveness is
//      handled with TCP-level keepalive on the underlying socket, and an optional
//      text keepalive for hosts that reap idle TCP connections.
//
//   2. ofApp::takePhoto()/streamPhoto() broadcast their JSON without running it
//      through cleanString(), so the base64 payload still carries the line breaks
//      Poco's encoder inserts. That JSON is not parseable until CR/LF are stripped.
//      The senders in Pinopticon_Http.hpp (video/blobs/contours/pixel) do clean their
//      output, so stripping is harmless for them.

const WebSocket = require('ws');
const EventEmitter = require('events');

const DEFAULT_WS_PORT = 7112;
const DEFAULT_STREAM_PORT = 7111;

// Commands ofApp::onWebSocketFrameReceivedEvent() acts on. Anything else is ignored
// by the RPi (it just logs the frame), which makes unknown text safe to send.
const COMMAND_TAKE_PHOTO = 'take_photo';
const COMMAND_STREAM_PHOTO = 'stream_photo';

// Decode a base64 buffer of little-endian float32s (RPi is ARM LE).
function decodeFloats(base64) {
  const buf = Buffer.from(base64, 'base64');
  const count = Math.floor(buf.length / 4);
  const out = new Array(count);
  for (let i = 0; i < count; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

// The RPi quotes most numbers ("x":"12.5") but leaves contour index/timestamp bare.
function num(value) {
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

// Turn one raw frame into a typed message. Never throws; unparseable frames come
// back as { type: 'unknown' } so a malformed frame can't take the connection down.
function parseFrame(raw) {
  const text = raw.toString();

  // ofApp::takePhoto() broadcasts plain text: "<hostname>,<filename>"
  if (!text.startsWith('{')) {
    const parts = text.split(',');
    if (parts.length === 2 && parts[1].endsWith('.jpg')) {
      return { type: 'photo_saved', hostname: parts[0], filename: parts[1], raw: text };
    }
    return { type: 'unknown', raw: text };
  }

  let msg;
  try {
    msg = JSON.parse(text.replace(/[\r\n]/g, ''));
  } catch (err) {
    return { type: 'unknown', raw: text, error: err.message };
  }

  const base = {
    uniqueId: msg.unique_id,
    hostname: msg.hostname,
    // NOTE: getTimestamp() casts ofGetSystemTimeMillis() to a 32-bit int, so this
    // wraps and is frequently negative. It is an ordering token, not a real clock.
    timestamp: num(msg.timestamp),
  };

  if (msg.photo !== undefined) {
    return { ...base, type: 'photo', jpeg: Buffer.from(msg.photo, 'base64') };
  }

  if (msg.video !== undefined) {
    return { ...base, type: 'video', jpeg: Buffer.from(msg.video, 'base64') };
  }

  if (msg.points !== undefined) {
    const [r, g, b] = decodeFloats(msg.colors);
    const flat = decodeFloats(msg.points);
    const points = [];
    for (let i = 0; i + 2 < flat.length; i += 3) {
      points.push({ x: flat[i], y: flat[i + 1], z: flat[i + 2] });
    }
    return { ...base, type: 'contour', index: num(msg.index), color: { r, g, b }, points };
  }

  if (msg.x !== undefined && msg.y !== undefined) {
    // Blobs carry an index; the brightest-pixel message does not.
    if (msg.index !== undefined) {
      return { ...base, type: 'blob', index: num(msg.index), x: num(msg.x), y: num(msg.y) };
    }
    return { ...base, type: 'pixel', x: num(msg.x), y: num(msg.y) };
  }

  return { type: 'unknown', raw: text, json: msg };
}

class RpiClient extends EventEmitter {
  constructor(options = {}) {
    super();

    this.host = options.host || 'nfg-rpi-3-4.local';
    this.port = options.port || DEFAULT_WS_PORT;
    this.streamPort = options.streamPort || DEFAULT_STREAM_PORT;

    this.reconnectDelay = options.reconnectDelay || 2000;
    this.maxReconnectDelay = options.maxReconnectDelay || 30000;
    this.handshakeTimeout = options.handshakeTimeout || 5000;

    // Optional text frame sent on an interval. Off by default: idle connections
    // survive fine, and each keepalive prints a line on the RPi's console.
    this.keepAliveInterval = options.keepAliveInterval || 0;

    this.url = `ws://${this.host}:${this.port}/`;

    this.ws = null;
    this.connected = false;
    this.stopped = false;
    this._retryDelay = this.reconnectDelay;
    this._reconnectTimer = null;
    this._keepAliveTimer = null;
  }

  connect() {
    this.stopped = false;
    if (this.ws) return this;

    const ws = new WebSocket(this.url, { handshakeTimeout: this.handshakeTimeout });
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this._retryDelay = this.reconnectDelay;

      // TCP-level keepalive, so a Pi that vanishes without a FIN is eventually
      // noticed. This is not a websocket ping frame, which the server can't take.
      const socket = ws._socket;
      if (socket) socket.setKeepAlive(true, 10000);

      if (this.keepAliveInterval > 0) {
        this._keepAliveTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send('keepalive');
        }, this.keepAliveInterval);
      }

      this.emit('open');
    });

    ws.on('message', (data) => {
      const msg = parseFrame(data);
      this.emit('message', msg);
      this.emit(msg.type, msg);
    });

    // ofxHTTP usually drops the TCP connection without a close handshake, so a
    // 1006 here is routine rather than a fault worth shouting about.
    ws.on('close', (code) => this._teardown(code));

    ws.on('error', (err) => this.emit('error', err));

    return this;
  }

  _teardown(code) {
    const wasConnected = this.connected;
    this.connected = false;
    this.ws = null;

    if (this._keepAliveTimer) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = null;
    }

    if (wasConnected) this.emit('close', code);

    if (this.stopped) return;

    this._reconnectTimer = setTimeout(() => this.connect(), this._retryDelay);
    this.emit('reconnecting', this._retryDelay);
    this._retryDelay = Math.min(this._retryDelay * 2, this.maxReconnectDelay);
  }

  // Send a raw text frame. Returns false if the socket isn't open.
  send(text) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(text);
    return true;
  }

  // Save a photo on the RPi. Answers with a 'photo_saved' message naming the file.
  takePhoto() {
    return this.send(COMMAND_TAKE_PHOTO);
  }

  // Ask for a photo inline over the socket. Answers with a 'photo' message.
  streamPhoto() {
    return this.send(COMMAND_STREAM_PHOTO);
  }

  // Saved photos are served by the stream server's file route, not the post server.
  photoUrl(filename) {
    return `http://${this.host}:${this.streamPort}/photos/${filename}`;
  }

  close() {
    this.stopped = true;
    clearTimeout(this._reconnectTimer);
    if (this._keepAliveTimer) clearInterval(this._keepAliveTimer);
    if (this.ws) this.ws.close();
  }
}

module.exports = { RpiClient, parseFrame, DEFAULT_WS_PORT, DEFAULT_STREAM_PORT };
