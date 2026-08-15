/**
 * Deepseek Harness — Electron main process.
 *
 * Opens the official DeepSeek Harness web UI (served by DSH itself) in a
 * standalone desktop window. If the DSH host is not already running, the app
 * starts it itself (`npx -y @deepseek-ai/dsh web`), waits for it to come up,
 * and only then opens the page — double-clicking the exe is enough.
 *
 * The shell adds desktop conveniences:
 *   - taskbar presence with its own icon
 *   - single-instance lock (second launch focuses the existing window)
 *   - external links open in the system browser, never in the window
 *   - clear error boxes when the DSH host cannot be started
 */
import { app, BrowserWindow, shell, dialog } from 'electron';
import { spawn } from 'node:child_process';
import { openSync, appendFileSync } from 'node:fs';

let win = null;
let hostProc = null; // the DSH host child we spawned (if any)
let hostSpawnedByUs = false;

const DSH_URL = process.env.DSH_URL ?? 'http://127.0.0.1:3080';

// Optional debug trace (DSH_CLIENT_DEBUG=<file path>) for diagnosing startup.
const debugLog = process.env.DSH_CLIENT_DEBUG
  ? (msg) => { try { appendFileSync(process.env.DSH_CLIENT_DEBUG, `${new Date().toISOString()} ${msg}\n`); } catch { /* noop */ } }
  : () => {};
debugLog(`main.js loaded, DSH_URL=${DSH_URL}`);

const HOST_START_TIMEOUT_MS = 120000; // first `npx` run may download the package

/** True when the DSH host answers on the configured URL. */
async function probeDsh(timeoutMs = 1500) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(DSH_URL, { signal: ctrl.signal });
    clearTimeout(t);
    return res.status < 500; // any real HTTP answer means the host is up
  } catch {
    return false;
  }
}

/** Start `npx -y @deepseek-ai/dsh web` in a hidden console; logs to userData. */
function startDshHost() {
  const u = new URL(DSH_URL);
  const args = ['/c', 'npx', '-y', '@deepseek-ai/dsh', 'web'];
  if (u.port && u.port !== '80') args.push('--port', u.port);
  let logFd;
  try {
    logFd = openSync(`${app.getPath('userData')}\\dsh-host.log`, 'a');
  } catch {
    logFd = 'ignore';
  }
  const child = spawn('cmd.exe', args, {
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  });
  hostProc = child;
  hostSpawnedByUs = true;
  child.on('error', (err) => { debugLog(`host spawn error: ${err.message}`); console.error('[host] spawn failed', err.message); });
  child.on('exit', (code) => { debugLog(`host exited with code ${code}`); console.log('[host] exited with code', code); });
  debugLog(`spawning: ${args.join(' ')}`);
  console.log('[host] spawning', args.join(' '));
  return child;
}

async function waitForDsh(timeoutMs = HOST_START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeDsh()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/**
 * Kill the DSH host we spawned and wait until it is actually gone.
 *
 * Two layers:
 *  1. taskkill the spawn tree (cmd -> npx -> node) by PID;
 *  2. netstat the DSH port and taskkill whatever listens there — catches
 *     orphaned trees whose cmd wrapper died early.
 * Returns a promise; the app stays alive until it settles (see will-quit),
 * because Chromium's job object would otherwise kill our taskkill children
 * together with the exiting browser process.
 */
function killHostTree() {
  if (!hostProc || !hostSpawnedByUs) return Promise.resolve();
  debugLog('killing spawned host (tree + port)');
  const port = new URL(DSH_URL).port || '80';
  const taskkill = (pid) => new Promise((resolve) => {
    try {
      const tk = spawn('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore',
      });
      tk.on('exit', resolve);
      tk.on('error', resolve);
    } catch { resolve(); }
  });

  // 1) the spawn tree
  const treeKill = taskkill(hostProc.pid);

  // 2) whatever listens on the DSH port
  const portKill = new Promise((resolve) => {
    try {
      const netstat = spawn('netstat.exe', ['-ano', '-p', 'tcp'], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
      let out = '';
      netstat.stdout.on('data', (d) => (out += d.toString('latin1')));
      netstat.on('exit', async () => {
        const re = new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`);
        const pids = [...new Set(
          out.split(/\r?\n/).map((l) => l.match(re)?.[1]).filter(Boolean),
        )];
        debugLog(`port ${port} listeners: ${pids.join(',') || 'none'}`);
        await Promise.all(pids.map(taskkill));
        resolve();
      });
      netstat.on('error', resolve);
    } catch { resolve(); }
  });

  return Promise.all([treeKill, portKill]).then(() => {
    hostProc = null;
    debugLog('host killed');
  });
}

/** Minimal dark splash shown while the DSH host is starting. */
const SPLASH = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{height:100%;margin:0;background:#070b10;color:#e8eef4;
    font-family:"Segoe UI",system-ui,sans-serif;display:flex;align-items:center;justify-content:center}
  .box{text-align:center}
  .title{font-size:22px;font-weight:600;letter-spacing:.5px}
  .sub{margin-top:12px;font-size:13px;color:#8fa3b8}
  .dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#5ff0e8;
    margin-top:18px;animation:pulse 1.2s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:.25}50%{opacity:1}}
</style></head><body><div class="box">
  <div class="title">Deepseek Harness</div>
  <div class="sub">正在启动本地服务…</div>
  <div class="dot"></div>
</div></body></html>`)}`;

async function createWindow() {
  debugLog('createWindow start');
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 940,
    minHeight: 600,
    title: 'Deepseek Harness',
    backgroundColor: '#070b10',
    autoHideMenuBar: true,
    webPreferences: {
      // The page is the official DSH web UI: plain web content, no node access.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // External links -> system browser; navigation stays inside the DSH origin.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    let target;
    try { target = new URL(url); } catch { e.preventDefault(); return; }
    if (target.origin !== new URL(DSH_URL).origin) e.preventDefault();
  });
  win.on('closed', () => { win = null; });

  // Splash while we make sure the DSH host is (or becomes) reachable.
  await win.loadURL(SPLASH);
  debugLog('splash loaded');

  const dshUp = await probeDsh();
  debugLog(`probeDsh -> ${dshUp}`);
  if (!dshUp) {
    const host = new URL(DSH_URL).hostname;
    const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    if (!isLoopback) {
      debugLog('non-loopback DSH_URL, giving up');
      dialog.showErrorBox(
        'Deepseek Harness 无法连接',
        `无法连接 DSH 服务（${DSH_URL}）。\n\n请确认服务已启动，或检查 DSH_URL 环境变量。`,
      );
      app.quit();
      return;
    }
    startDshHost();
    const started = await waitForDsh();
    debugLog(`waitForDsh -> ${started}`);
    if (!started) {
      dialog.showErrorBox(
        'Deepseek Harness 启动失败',
        `本地 DSH 服务在 ${Math.round(HOST_START_TIMEOUT_MS / 1000)} 秒内未能启动。\n\n` +
        `请确认已安装 Node.js 且能访问网络（首次启动需下载 dsh 包，约 1-2 分钟）。\n` +
        `日志：${app.getPath('userData')}\\dsh-host.log`,
      );
      app.quit();
      return;
    }
  }

  await win.loadURL(DSH_URL);
  debugLog('official UI loaded');
}

// Single instance: focus the existing window instead of spawning another.
const gotLock = app.requestSingleInstanceLock();
debugLog(`single instance lock -> ${gotLock}`);
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(createWindow).catch((err) => {
    dialog.showErrorBox('Deepseek Harness 启动失败', `无法启动窗口：\n${err.message}`);
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('will-quit', (e) => {
    if (hostProc && hostSpawnedByUs) {
      // Stay alive until the spawned host is really gone (see killHostTree).
      e.preventDefault();
      killHostTree().finally(() => app.exit(0));
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
