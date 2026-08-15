// Full pipeline E2E: boot the embedded proxy (as the desktop app does), then
// create session -> prompt -> watch live mux events through it.
import { WebSocket } from 'ws';
import { createProxyServer } from './server.js';

const p = await createProxyServer({ port: 0 });
const BASE = `http://127.0.0.1:${p.port}`;
const MUX = `ws://127.0.0.1:${p.port}/api/events.mux`;

let rpcSeq = 0;
const rpcId = () => `e2e-${Date.now().toString(36)}-${(++rpcSeq).toString(36)}`;

async function rpc(method, payload) {
  const id = rpcId();
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: id, method, payload: payload ?? {} }),
  });
  const msg = await res.json();
  if (!msg.result.ok) throw new Error(`${method}: ${msg.result.error.code} ${msg.result.error.message}`);
  return msg.result.value;
}

// 1. create a scratch session
const { sessionId } = await rpc('session.create', {});
console.log('created session:', sessionId);

// 2. open mux and subscribe to events for it
const ws = new WebSocket(MUX);
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

const seen = new Set();
const interesting = [];
ws.on('message', (d) => {
  const frame = JSON.parse(d.toString());
  if (frame.type !== 'server-request') return;
  const p = frame.payload;
  if (p.type === 'session/event' && p.sessionId === sessionId) {
    const t = p.event.type;
    seen.add(t);
    if (['turn/start', 'user/message', 'assistant/chunk', 'assistant/message', 'turn/end'].includes(t)) {
      interesting.push({ t, seq: p.event.seq, data: summarize(p.event) });
    }
  }
  if (p.type === 'session/projection' && p.sessionId === sessionId && p.key === 'title' && p.value) {
    seen.add('projection/title');
    interesting.push({ t: 'projection/title', data: p.value });
  }
});
function summarize(ev) {
  const d = ev.data;
  if (ev.type === 'assistant/chunk') return d.chunk.type;
  if (ev.type === 'assistant/message') return (d.message.content ?? []).map((b) => b.type).join(',');
  if (ev.type === 'user/message') return (d.content ?? []).map((b) => b.type).join(',');
  if (ev.type === 'turn/end') return d.reason.kind;
  return '';
}

// 3. send a prompt
console.log('sending prompt…');
await rpc('session.prompt', {
  sessionId,
  mode: 'queue',
  content: [{ type: 'text', text: '只回复两个字：收到' }],
  clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
});

// 4. wait for turn/end
const deadline = Date.now() + 120000;
while (!seen.has('turn/end') && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
}

console.log('\n=== event types seen ===');
for (const t of seen) console.log('  ', t);
console.log('\n=== interesting events ===');
for (const e of interesting) console.log('  ', e.t, e.seq, JSON.stringify(e.data).slice(0, 120));

if (!seen.has('turn/end')) { console.log('TIMEOUT: no turn/end'); process.exit(1); }
console.log('\nE2E PIPELINE OK');
ws.close();
await p.close().catch(() => {});
process.exit(0);
