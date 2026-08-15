/**
 * dsh-client local proxy server.
 *
 * Serves the browser UI and forwards the DSH wire protocol to a running
 * DeepSeek Harness instance:
 *   - POST /api/<method>   -> forwarded to DSH with the ORIGINAL Host/Origin
 *     headers preserved. The DSH /api trust fence accepts loopback authorities
 *     whose Origin matches the Host authority, so a local proxy on another
 *     loopback port passes exactly like a first-party page.
 *   - WS   /api/events.mux / /api/events.host -> downlink-only streams are
 *     bridged to DSH's WebSockets (the Node client sends no Origin, so the
 *     fence accepts it via the loopback Host it presents).
 *
 * ZERO runtime dependencies: uses node:http + node:crypto + the built-in
 * WebSocket client (Node >= 22) + a minimal RFC6455 server (ws-server.js).
 *
 * Embedded only: `createProxyServer({...})` embeds the proxy in another
 * process (Electron main, tests, …). The desktop app is the only front end;
 * there is no standalone browser mode.
 */
import { createServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleUpgrade, createWsClient } from './ws-server.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/**
 * Start the local proxy.
 * @param {object} opts
 * @param {string} opts.dshUrl      - DSH base URL (default http://127.0.0.1:3080)
 * @param {number} [opts.port]      - port to listen on; 0 = ephemeral (default 0)
 * @param {string} [opts.publicDir] - UI static dir (default ./public)
 * @returns {Promise<{server: import('node:http').Server, port: number, close(): Promise<void>}>}
 */
export function createProxyServer({
  dshUrl: base = process.env.DSH_URL ?? 'http://127.0.0.1:3080',
  port = 0,
  publicDir = process.env.DSH_CLIENT_PUBLIC
    ?? join(fileURLToPath(new URL('.', import.meta.url)), 'public'),
} = {}) {
  const target = new URL(base);

  /** @param {string} path */
  const dshUrl = (path) => new URL(path, target);

  /** Forward one HTTP request to DSH, preserving Host/Origin so the trust fence passes. */
  function forwardHttp(req, res, pathname) {
    const up = dshUrl(pathname);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      if (v !== undefined) headers[k] = v;
    }
    // NOTE: Node's fetch() forbids setting the `host` header, and DSH's /api
    // fence requires Origin === Host. Using http.request lets us forward the
    // browser's original loopback Host header verbatim.
    const bodyChunks = [];
    req.on('data', (c) => bodyChunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(bodyChunks);
      const upstream = httpRequest({
        hostname: up.hostname,
        port: up.port,
        path: up.pathname + up.search,
        method: req.method,
        headers,
      }, (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      });
      upstream.on('error', (err) => {
        console.error('[proxy] upstream error', err.message);
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('502 upstream error');
      });
      if (body.length) upstream.write(body);
      upstream.end();
    });
  }

  /** Bridge one browser WebSocket upgrade to the DSH downlink stream.
   *  Upstream side uses the built-in WebSocket client (Node >= 22) or the
   *  bundled RFC6455 client polyfill (Node < 22, e.g. Electron's Node 20). */
  function bridgeSocket(browserSocket, dshPath) {
    const upstream = createWsClient(dshUrl(dshPath).toString().replace(/^http/, 'ws'));
    const closeBoth = (reason) => {
      try { browserSocket.close(1000, reason); } catch { /* noop */ }
      try { upstream.close(); } catch { /* noop */ }
    };
    // Register the relay listener immediately (not inside 'open') so no frame
    // arriving right after the upstream handshake can fall into the gap.
    upstream.addEventListener('message', (evt) => {
      try {
        const data = evt.data;
        if (typeof data === 'string') browserSocket.sendText(data);
        else browserSocket.send(Buffer.from(data), { binary: true });
      } catch { /* socket dying */ }
    });
    upstream.addEventListener('open', () => {
      upstream.addEventListener('close', () => closeBoth('upstream closed'));
      upstream.addEventListener('error', () => closeBoth('upstream error'));
    });
    upstream.addEventListener('error', () => closeBoth('upstream connect error'));
    browserSocket.onmessage = (data, isBinary) => {
      try {
        if (isBinary) upstream.send(data);
        else upstream.send(data.toString());
      } catch { /* not open yet */ }
    };
    browserSocket.onclose = () => closeBoth('browser closed');
  }

  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;

    // API proxy
    if (pathname.startsWith('/api/')) {
      return forwardHttp(req, res, pathname);
    }

    // Static UI
    let rel = pathname === '/' ? '/index.html' : pathname;
    const filePath = normalize(join(publicDir, rel));
    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('forbidden');
    }
    try {
      const data = await readFile(filePath);
      res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });

  // WebSocket downlink proxy (minimal RFC6455 server)
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/api/events.mux' || pathname === '/api/events.host') {
      handleUpgrade(req, socket, head, (browserSocket) => {
        bridgeSocket(browserSocket, pathname);
      });
      return;
    }
    socket.destroy();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
      const close = () => new Promise((res) => server.close(res));
      resolve({ server, port: actual, close, dshUrl: target.toString() });
    });
  });
}
