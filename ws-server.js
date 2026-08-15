/**
 * Minimal RFC6455 WebSocket server for the DSH downlink proxy.
 *
 * The browser connects with a plain WebSocket upgrade; this module completes
 * the handshake and then relays frames. The DSH downlink streams
 * (/api/events.mux, /api/events.host) are downlink-only: the browser sends no
 * application data, so the server side only needs to decode control frames
 * (close/ping/pong — client frames are masked) and send unmasked text frames.
 *
 * Zero dependencies: uses node:crypto for the accept key.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Socket } from 'node:net';
import { request as httpRequest } from 'node:http';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Read one client frame from a buffer. Returns {opcode, payload, consumed} or null when incomplete. */
function decodeClientFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const hi = buf.readUInt32BE(2);
    const lo = buf.readUInt32BE(6);
    len = hi * 0x100000000 + lo;
    offset = 10;
  }
  if (len > 16 * 1024 * 1024) throw new Error('frame too large');
  const maskKeyLen = masked ? 4 : 0;
  if (buf.length < offset + maskKeyLen + len) return null;
  let payload = buf.subarray(offset + maskKeyLen, offset + maskKeyLen + len);
  if (masked) {
    const key = buf.subarray(offset, offset + 4);
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i++) payload[i] ^= key[i % 4];
  }
  return { fin, opcode, payload, consumed: offset + maskKeyLen + len };
}

/** Encode a server->client text frame (unmasked). */
function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function encodeControlFrame(opcode, payload = Buffer.alloc(0)) {
  const header = Buffer.from([0x80 | opcode, payload.length]);
  return Buffer.concat([header, payload]);
}

/**
 * Handle a WebSocket upgrade request.
 * @param {import('node:http').IncomingMessage} req
 * @param {Socket} socket
 * @param {Buffer} head
 * @param {(ws: import('./ws-server.js').WSConnection) => void} onOpen
 */
export function handleUpgrade(req, socket, head, onOpen) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const conn = new WSConnection(socket);
  if (head && head.length) conn._push(head);
  onOpen(conn);
}

class WSConnection {
  constructor(socket) {
    this.socket = socket;
    this._buffer = Buffer.alloc(0);
    this.closed = false;
    this.onmessage = null;   // (data: Buffer, isBinary: boolean) => void
    this.onclose = null;     // () => void
    socket.on('data', (chunk) => this._push(chunk));
    socket.on('close', () => {
      this.closed = true;
      this.onclose?.();
    });
    socket.on('error', () => {
      this.closed = true;
      try { socket.destroy(); } catch { /* noop */ }
      this.onclose?.();
    });
  }

  _push(chunk) {
    this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : chunk;
    for (;;) {
      let frame;
      try {
        frame = decodeClientFrame(this._buffer);
      } catch {
        this.close(1002, 'bad frame');
        return;
      }
      if (!frame) break;
      this._buffer = this._buffer.subarray(frame.consumed);
      this._handleFrame(frame);
    }
  }

  _handleFrame({ opcode, payload }) {
    switch (opcode) {
      case 0x1: // text
      case 0x2: // binary
        this.onmessage?.(payload, opcode === 0x2);
        break;
      case 0x8: { // close
        this.socket.write(encodeControlFrame(0x8, payload.subarray(0, 2)));
        this.socket.end();
        this.closed = true;
        this.onclose?.();
        break;
      }
      case 0x9: // ping -> pong
        this.socket.write(encodeControlFrame(0xA, payload));
        break;
      case 0xA: // pong: ignore
        break;
      default: // unknown opcode
        this.close(1002, 'unsupported opcode');
    }
  }

  /** Send a text message to the browser. */
  sendText(text) {
    if (this.closed) return;
    try {
      this.socket.write(encodeTextFrame(text));
    } catch { /* socket dying */ }
  }

  /** Send raw bytes as a text frame (callers pass JSON strings). */
  send(data, opts = {}) {
    if (opts.binary) {
      if (this.closed) return;
      try { this.socket.write(encodeBinaryFrame(data)); } catch { /* noop */ }
    } else {
      this.sendText(data.toString());
    }
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closed = true;
    try {
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
      payload.writeUInt16BE(code, 0);
      payload.write(reason, 2);
      this.socket.write(encodeControlFrame(0x8, payload));
      this.socket.end();
    } catch { /* noop */ }
    this.onclose?.();
  }
}

function encodeBinaryFrame(payload) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x82, len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x82; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x82; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Encode a client->server frame. Client frames MUST be masked per RFC6455. */
function encodeClientFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.alloc(2 + 4);
  else if (len < 65536) header = Buffer.alloc(4 + 4);
  else header = Buffer.alloc(10 + 4);
  header[0] = 0x80 | opcode;
  if (len < 126) {
    header[1] = 0x80 | len;
    header.writeUInt32BE(0, 2);
  } else if (len < 65536) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
    header.writeUInt32BE(0, 4);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
    header.writeUInt32BE(0, 10);
  }
  // random mask key
  const maskKey = randomBytes(4);
  const maskOffset = header.length - 4;
  maskKey.copy(header, maskOffset);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= maskKey[i % 4];
  return Buffer.concat([header, masked]);
}

/**
 * Minimal RFC6455 WebSocket CLIENT for environments without a global
 * WebSocket (Node < 22 — e.g. Electron's bundled Node 20). Implements the
 * subset the proxy uses: addEventListener, send(string|Buffer), close().
 * Zero dependencies: node:http + node:crypto.
 */
export class WebSocketClient {
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this._listeners = { open: [], message: [], close: [], error: [] };
    this._buffer = Buffer.alloc(0);
    this._closed = false;
    this._connect();
  }

  addEventListener(type, fn) {
    (this._listeners[type] ??= []).push(fn);
  }

  _emit(type, arg) {
    for (const fn of this._listeners[type] ?? []) {
      try { fn(arg); } catch (e) { console.error('[ws-client] listener error', e); }
    }
  }

  _connect() {
    const u = new URL(this.url);
    const key = randomBytes(16).toString('base64');
    const headers = {
      Host: u.host,
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
    };
    const req = httpRequest({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method: 'GET',
      headers,
    });
    req.on('upgrade', (res, socket) => {
      this._socket = socket;
      this.readyState = 1; // OPEN
      this._emit('open');
      socket.on('data', (chunk) => this._push(chunk));
      socket.on('close', () => {
        if (this._closed) return;
        this._closed = true;
        this.readyState = 3; // CLOSED
        this._emit('close', { code: 1006, reason: 'connection closed' });
      });
      socket.on('error', (err) => {
        if (this._closed) return;
        this._emit('error', err);
      });
    });
    req.on('response', (res) => {
      // server refused the upgrade (e.g. 403) — drain and fail
      res.resume();
      this.readyState = 3;
      this._emit('error', new Error(`upgrade rejected: HTTP ${res.statusCode}`));
      this._emit('close', { code: 1006, reason: `HTTP ${res.statusCode}` });
    });
    req.on('error', (err) => {
      if (this._closed) return;
      this.readyState = 3;
      this._emit('error', err);
      this._emit('close', { code: 1006, reason: err.message });
    });
    req.end();
  }

  _push(chunk) {
    this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : chunk;
    for (;;) {
      let frame;
      try {
        frame = decodeClientFrame(this._buffer); // server frames are unmasked — decoder handles both
      } catch {
        this.close();
        return;
      }
      if (!frame) break;
      this._buffer = this._buffer.subarray(frame.consumed);
      if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        this._emit('message', { data: frame.opcode === 0x1 ? frame.payload.toString('utf8') : frame.payload });
      } else if (frame.opcode === 0x8) { // close
        this._closed = true;
        this.readyState = 3;
        try { this._socket?.end(); } catch { /* noop */ }
        this._emit('close', { code: 1000, reason: 'closed by peer' });
        return;
      } else if (frame.opcode === 0x9) { // ping -> pong
        try { this._socket?.write(encodeClientFrame(0xA, frame.payload)); } catch { /* noop */ }
      }
    }
  }

  send(data) {
    if (this.readyState !== 1) return;
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    try {
      this._socket.write(encodeClientFrame(0x1, buf));
    } catch { /* noop */ }
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    try {
      if (this._socket && this.readyState === 1) {
        this._socket.write(encodeClientFrame(0x8, Buffer.alloc(0)));
      }
    } catch { /* noop */ }
    this.readyState = 3;
    try { this._socket?.end(); } catch { /* noop */ }
    this._emit('close', { code: 1000, reason: 'closed by client' });
  }
}

/** Pick the best WebSocket client available: global (Node>=22) or our polyfill. */
export function createWsClient(url) {
  if (typeof globalThis.WebSocket === 'function') return new globalThis.WebSocket(url);
  return new WebSocketClient(url);
}

/** Connection helper used by the proxy: same interface subset as `ws`. */
export function connectWs(url) {
  return createWsClient(url);
}

export { randomBytes };
