// Quick acceptance: settings fit + bg visible at scroll 0.
const DEBUG_PORT = process.argv[2] ?? '9244';
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
  if (await evalJs(`!!document.querySelector('button')`)) break;
  await sleep(1000);
}
await evalJs(`(() => {
  if (!document.querySelector('.VOzbGW_panel')) {
    const b = [...document.querySelectorAll('button,[role="button"]')].find(el => /设置/.test(el.textContent + (el.getAttribute('aria-label')||'')));
    if (b) b.click();
  }
  return 'ok';
})()`);
await sleep(2000);
console.log(await evalJs(`(() => {
  const opts = document.querySelector('.VOzbGW_options');
  const bg = document.querySelector('.dshbg-group');
  const voice = document.querySelector('.dshv-group');
  if (!opts || !bg || !voice) return 'missing';
  const or = opts.getBoundingClientRect();
  const gr = bg.getBoundingClientRect();
  const vr = voice.getBoundingClientRect();
  return JSON.stringify({
    inner: innerWidth + 'x' + innerHeight,
    clientH: opts.clientHeight, scrollH: opts.scrollHeight,
    fits: opts.scrollHeight <= opts.clientHeight + 2,
    bgVisibleAtScroll0: gr.top >= or.top - 1 && gr.bottom <= or.bottom + 1,
    voiceAboveBg: vr.top < gr.top,
  }, null, 1);
})()`));
ws.close();
process.exit(0);
