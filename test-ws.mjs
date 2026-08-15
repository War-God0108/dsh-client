// WS proxy smoke test: boot the embedded proxy (as the desktop app does) and
// connect through it to DSH downlink streams.
import { WebSocket } from 'ws';
import { createProxyServer } from './server.js';

const p = await createProxyServer({ port: 0 });
const MUX = `ws://127.0.0.1:${p.port}/api/events.mux`;
const HOST = `ws://127.0.0.1:${p.port}/api/events.host`;

function waitFrames(url, n, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const frames = [];
    const timer = setTimeout(() => { ws.close(); reject(new Error(`timeout after ${frames.length} frames: ${url}`)); }, timeoutMs);
    ws.on('open', () => console.log(`[open] ${url}`));
    ws.on('message', (data) => {
      frames.push(data.toString());
      if (frames.length >= n) { clearTimeout(timer); ws.close(); resolve(frames); }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// events.host is a PURE push stream (session-added/removed/status, agent-error):
// it sends no initial snapshot on connect (verified against the DSH API). The
// smoke check therefore verifies the upgrade + upstream bridge stays healthy
// for a quiet window instead of expecting frames.
function waitQuiet(url, quietMs = 3000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const frames = [];
    let done = false;
    const finish = (fn, arg) => { if (!done) { done = true; clearTimeout(timer); fn(arg); } };
    const timer = setTimeout(() => { ws.close(); finish(resolve, frames); }, quietMs);
    ws.on('open', () => console.log(`[open] ${url}`));
    ws.on('message', (data) => frames.push(data.toString()));
    ws.on('error', (e) => finish(reject, e));
    ws.on('close', (code) => {
      // closing after our own ws.close() (1000/1005) is fine; anything else
      // means the bridge dropped during the quiet window
      if (code !== 1000 && code !== 1005) finish(reject, new Error(`${url} closed early: code ${code}`));
    });
  });
}

const [muxFrames, hostFrames] = await Promise.all([
  waitFrames(MUX, 2),
  waitQuiet(HOST),
]);
console.log(`mux frames: ${muxFrames.length}`);
for (const f of muxFrames.slice(0, 2)) console.log(' mux>', f.slice(0, 220));
console.log(`host frames during quiet window: ${hostFrames.length} (0 expected — pure push stream)`);
await p.close();
console.log('WS PROXY OK');
