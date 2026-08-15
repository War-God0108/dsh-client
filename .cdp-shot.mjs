// Capture screenshot + extract background image for pixel comparison.
import { writeFileSync } from 'node:fs';

const DEBUG_PORT = process.argv[2] ?? '9243';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tabs = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
const page = tabs.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const pending = new Map();
ws.onmessage = (evt) => {
  const msg = JSON.parse(evt.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const id = ++seq;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};

await send('Runtime.enable');
for (let i = 0; i < 25; i++) {
  const ready = await evalJs(`!!document.querySelector('button')`);
  if (ready) break;
  await sleep(1000);
}
await sleep(2000);

// extract the background layer's image + its CSS
const bgInfo = await evalJs(`(() => {
  const layer = document.getElementById('dsh-web-bg-layer');
  if (!layer) return null;
  const cs = getComputedStyle(layer);
  return {
    image: cs.backgroundImage,
    size: cs.backgroundSize,
    position: cs.backgroundPosition,
    repeat: cs.backgroundRepeat,
    opacity: cs.opacity,
    filter: cs.filter,
  };
})()`);
console.log('bgInfo:', JSON.stringify(bgInfo).slice(0, 200));
if (bgInfo?.image) {
  const m = bgInfo.image.match(/url\("(data:[^"]+)"\)/);
  if (m) writeFileSync('D:/31259/Deepseek Harness/dsh-client/.bg-image.txt', m[1]);
}

// capture screenshot
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) {
  writeFileSync('D:/31259/Deepseek Harness/dsh-client/.page-shot.png', Buffer.from(shot.result.data, 'base64'));
  console.log('screenshot saved');
}

ws.close();
process.exit(0);
