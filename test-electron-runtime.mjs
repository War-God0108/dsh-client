// Run under ELECTRON_RUN_AS_NODE (Electron's Node 20, no global WebSocket)
// to verify the exact runtime environment of the packaged app.
const { createProxyServer } = await import('./server.js');
const { createWsClient, WebSocketClient } = await import('./ws-server.js');

console.log('node version:', process.version);
console.log('global WebSocket present:', typeof globalThis.WebSocket);

const p = await createProxyServer({ port: 0 });
console.log('proxy on', p.port);

// what client does createWsClient pick here?
const ws = createWsClient(`ws://127.0.0.1:${p.port}/api/events.mux`);
console.log('client class:', ws instanceof WebSocketClient ? 'WebSocketClient (polyfill)' : 'global WebSocket');

const frames = [];
ws.addEventListener('message', (evt) => {
  frames.push(evt.data);
  console.log('frame:', String(evt.data).slice(0, 100));
  if (frames.length >= 2) { ws.close(); p.close().then(() => process.exit(0)); }
});
ws.addEventListener('error', (e) => console.log('ws error:', e?.message ?? e));
setTimeout(() => {
  console.log('frames:', frames.length);
  ws.close();
  p.close().then(() => process.exit(frames.length >= 2 ? 0 : 1));
}, 8000);
