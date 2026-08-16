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
import { app, BrowserWindow, shell, dialog, session, screen } from 'electron';
import { spawn } from 'node:child_process';
import { openSync, appendFileSync, writeSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';

let win = null;
let hostProc = null; // the DSH host child we spawned (if any)
let hostSpawnedByUs = false;

const DSH_URL = process.env.DSH_URL ?? 'http://127.0.0.1:3080';

// Records the PID of the DSH host that WE spawned, so a later instance can
// adopt it (clean it up on quit) even though it did not spawn it itself.
const hostPidFile = `${app.getPath('userData')}\\dsh-host.pid`;

function readHostPid() {
  try {
    const v = Number(readFileSync(hostPidFile, 'utf8').trim());
    return v > 0 ? v : null;
  } catch {
    return null;
  }
}

function writeHostPid(pid) {
  try { writeFileSync(hostPidFile, String(pid)); } catch { /* noop */ }
}

function clearHostPid() {
  try { unlinkSync(hostPidFile); } catch { /* noop */ }
}

/** PID currently LISTENING on the DSH port (null if none). */
function listenerOnDshPort() {
  const port = new URL(DSH_URL).port || '80';
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const netstat = spawn('netstat.exe', ['-ano', '-p', 'tcp'], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
      let out = '';
      netstat.stdout.on('data', (d) => (out += d.toString('latin1')));
      netstat.on('exit', () => {
        const re = new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`);
        const pids = [...new Set(
          out.split(/\r?\n/).map((l) => l.match(re)?.[1]).filter(Boolean),
        )];
        finish(pids[0] ? Number(pids[0]) : null);
      });
      netstat.on('error', () => finish(null));
      setTimeout(() => finish(null), 3000);
    } catch { finish(null); }
  });
}

// Always-on lifecycle log (small, append-only) so startup/quit problems are
// diagnosable from the packaged app without any env vars.
let lifeFd = null;
try { lifeFd = openSync(`${app.getPath('userData')}\\app.log`, 'a'); } catch { /* ignore */ }
const lifeLog = (msg) => {
  try { if (lifeFd) writeSync(lifeFd, `${new Date().toISOString()} ${msg}\n`); } catch { /* noop */ }
};

// Optional verbose trace (DSH_CLIENT_DEBUG=<file path>) for deep debugging.
const debugLog = process.env.DSH_CLIENT_DEBUG
  ? (msg) => { try { appendFileSync(process.env.DSH_CLIENT_DEBUG, `${new Date().toISOString()} ${msg}\n`); } catch { /* noop */ } }
  : () => {};
lifeLog(`boot: v${app.getVersion()} DSH_URL=${DSH_URL}`);

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
  writeHostPid(child.pid);
  child.on('error', (err) => { lifeLog(`host spawn error: ${err.message}`); debugLog(`host spawn error: ${err.message}`); });
  child.on('exit', (code) => { lifeLog(`host exited with code ${code}`); debugLog(`host exited with code ${code}`); });
  lifeLog(`spawning: ${args.join(' ')}`);
  debugLog(`spawning: ${args.join(' ')}`);
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
 * Every step is bounded by a timeout so this can never hang the quit.
 */
function killHostTree() {
  if (!hostProc || !hostSpawnedByUs) return Promise.resolve();
  lifeLog('killing spawned host (tree + port)');
  const port = new URL(DSH_URL).port || '80';
  const taskkill = (pid) => new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try {
      const tk = spawn('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore',
      });
      tk.on('exit', finish);
      tk.on('error', finish);
      setTimeout(finish, 3000); // never wait forever on taskkill
    } catch { finish(); }
  });

  // 1) the spawn tree
  const treeKill = taskkill(hostProc.pid);

  // 2) whatever listens on the DSH port
  const portKill = new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
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
        lifeLog(`port ${port} listeners: ${pids.join(',') || 'none'}`);
        await Promise.all(pids.map(taskkill));
        finish();
      });
      netstat.on('error', finish);
      setTimeout(finish, 3000); // netstat must not hang us either
    } catch { finish(); }
  });

  return Promise.all([treeKill, portKill]).then(() => {
    hostProc = null;
    clearHostPid();
    lifeLog('host killed');
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
  lifeLog('createWindow');
  // Stay within the available work area. Electron's screen API and
  // BrowserWindow both report device-independent pixels (the renderer DPR is
  // already factored in), so no extra division is needed — dividing by
  // devicePixelRatio again would shrink the app on high-DPI displays and
  // clip the settings panel.
  const disp = screen.getPrimaryDisplay();
  const wa = disp.workAreaSize;
  const forced = (process.env.DSH_WINDOW_SIZE ?? '').split('x').map(Number);
  let winW = forced[0] > 0 ? Math.min(forced[0], 1280) : Math.min(1280, wa.width);
  let winH = forced[1] > 0 ? Math.min(forced[1], 940) : Math.min(940, Math.max(600, wa.height - 16));
  lifeLog(`window size ${winW}x${winH} (work area ${wa.width}x${wa.height}, scaleFactor ${disp.scaleFactor})`);
  win = new BrowserWindow({
    width: winW,
    height: winH,
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

  // Display-only fix, scoped to the settings modal. The panel keeps the web
  // UI's own layout (size, paddings, native scrolling) — nothing here changes
  // how it looks. On some displays the presented frame misses parts of the
  // panel until the element itself is invalidated (hovering a row makes it
  // appear). Pulse every row's opacity 1 <-> 0.999 while the panel is open:
  // visually identical, but it keeps each row freshly painted every cycle.
  // No-op if the web UI changes.
  const SETTINGS_PAINT_FIX_CSS = `
    .VOzbGW_options [class$="_row"],
    .VOzbGW_options [class$="_group"],
    .VOzbGW_options [class$="_themeCube"],
    .VOzbGW_options .dshbg-row,
    .VOzbGW_options .dshbg-btn {
      animation: dsh-rowpulse 1.2s steps(2, end) infinite;
    }
    @keyframes dsh-rowpulse { 50% { opacity: 0.999; } }
  `;
  win.webContents.on('did-finish-load', () => {
    win.webContents.insertCSS(SETTINGS_PAINT_FIX_CSS).catch(() => {});
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
  lifeLog(`probeDsh -> ${dshUp}`);
  debugLog(`probeDsh -> ${dshUp}`);
  if (dshUp) {
    // The host is up, but it may be an orphan left by a previous run of THIS
    // app (e.g. after a crash). If our pid marker matches the current port
    // listener, adopt it so quitting the app also stops the host. A host the
    // user started themselves (no matching marker) is left alone.
    const marked = readHostPid();
    if (marked !== null) {
      const listener = await listenerOnDshPort();
      if (listener !== null && listener === marked) {
        hostProc = { pid: marked };
        hostSpawnedByUs = true;
        lifeLog(`adopting app-spawned host pid ${marked} (will clean up on quit)`);
      } else {
        clearHostPid(); // stale marker; the host was started by someone else
      }
    }
  }
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
    lifeLog(`waitForDsh -> ${started}`);
    debugLog(`waitForDsh -> ${started}`);
    if (started) {
      // Refresh the marker with the actual port listener (a descendant of the
      // cmd wrapper) so a later instance can adopt it by matching the pid.
      const lp = await listenerOnDshPort();
      if (lp !== null) { writeHostPid(lp); lifeLog(`host listener pid ${lp} marked`); }
    }
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
  lifeLog('official UI loaded');
  debugLog('official UI loaded');
  // Bring the window to the foreground: launched from the background (or
  // double-clicked while another window has focus) it can otherwise stay
  // hidden behind the browser.
  win.show();
  win.moveTop();
  win.focus();
}

// Single instance: focus the existing window instead of spawning another.
const gotLock = app.requestSingleInstanceLock();
lifeLog(`single instance lock -> ${gotLock}`);
debugLog(`single instance lock -> ${gotLock}`);
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      // Aggressively bring the window to the front: plain focus() is often
      // ignored by Windows' foreground-lock when another app has focus.
      win.show();
      win.setAlwaysOnTop(true);
      win.moveTop();
      win.focus();
      setTimeout(() => win.setAlwaysOnTop(false), 250);
    }
  });

  app.whenReady().then(() => {
    // 允许麦克风权限：语音输入插件需要 getUserMedia({ audio: true })
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(permission === 'media');
    });
    session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
      return permission === 'media';
    });
    return createWindow();
  }).catch((err) => {
    dialog.showErrorBox('Deepseek Harness 启动失败', `无法启动窗口：\n${err.message}`);
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('will-quit', (e) => {
    if (!hostProc || !hostSpawnedByUs) return;
    // Stay alive until the spawned host is really gone, but NEVER hang the
    // quit: a hard timeout forces the exit no matter what.
    e.preventDefault();
    lifeLog('quit: waiting for host cleanup');
    let exited = false;
    const exitNow = () => {
      if (exited) return;
      exited = true;
      lifeLog('quit: exiting');
      app.exit(0);
    };
    const timer = setTimeout(exitNow, 6000);
    killHostTree()
      .catch((err) => lifeLog(`quit: cleanup error: ${err?.message ?? err}`))
      .finally(() => { clearTimeout(timer); exitNow(); });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
