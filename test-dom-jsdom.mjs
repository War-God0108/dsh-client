// DOM-level integration test: load the real page in jsdom, run the real app.js
// against the embedded proxy (as the desktop app boots it) + real DSH, and
// assert the rendered UI.
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { createProxyServer } from './server.js';

const p = await createProxyServer({ port: 0 });
const BASE = `http://127.0.0.1:${p.port}`;
const html = await readFile('D:/31259/Deepseek Harness/dsh-client/public/index.html', 'utf8');

const dom = new JSDOM(html, {
  url: BASE + '/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;

// --- browser-ish globals ---
window.fetch = (input, init) => fetch(new URL(input, BASE), init);
window.WebSocket = globalThis.WebSocket;
window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
window.Intl = Intl;

// --- load app.js as the page would ---
const appSrc = await readFile('D:/31259/Deepseek Harness/dsh-client/public/app.js', 'utf8');
const boot = window.eval(appSrc);

// wait for boot + first data
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(4000);

const $ = (sel) => window.document.querySelector(sel);
const $$ = (sel) => [...window.document.querySelectorAll(sel)];
const txt = (sel) => $(sel)?.textContent?.trim() ?? '';

const report = {
  conn: txt('#txt-conn'),
  model: txt('#chip-model'),
  version: txt('#chip-version'),
  cwd: txt('#chip-cwd'),
  sessions: $$('.session-item').length,
  firstSessionTitle: txt('.session-item .si-title'),
  convTitle: txt('#conv-title'),
  convMeta: txt('#conv-meta'),
  messages: $$('.msg').length,
  userMessages: $$('.msg.user').length,
  assistantMessages: $$('.msg.assistant').length,
  contextMessages: $$('.msg.context').length,
  toolCards: $$('.tool-card').length,
  turnDividers: $$('.turn-divider').length,
  composerVisible: !$('#composer').hidden,
  telemetry: txt('#telemetry'),
  bodyTextLen: (window.document.body?.textContent ?? '').length,
};

console.log(JSON.stringify(report, null, 2));

// assertions
const failures = [];
const assert = (cond, name) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures.push(name); };

assert(report.conn === '已连接', 'connection status = 已连接');
assert(report.model.includes('deepseek'), 'model chip shows deepseek');
assert(report.sessions >= 1, `session list rendered (${report.sessions})`);
assert(report.convTitle.length > 0, 'conversation title set');
assert(report.messages >= 2, `history messages rendered (${report.messages})`);
assert(report.assistantMessages >= 1, 'assistant message bubbles rendered');
// a busy session's tail window may hold only tool activity; require either
// a human message or tool cards (tool-heavy sessions show tool cards)
assert(report.userMessages >= 1 || report.toolCards >= 1, `user messages or tool cards rendered (user=${report.userMessages}, tools=${report.toolCards})`);
assert(report.composerVisible, 'composer visible');
assert(report.telemetry.length > 0, 'telemetry chips rendered');
assert(report.bodyTextLen > 200, 'page has substantial content');

console.log(failures.length ? `\n${failures.length} FAILURES` : '\nALL DOM CHECKS PASSED');
await p.close().catch(() => {});
process.exit(failures.length ? 1 : 0);
