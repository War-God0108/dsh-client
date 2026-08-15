/**
 * Deepseek Harness — Electron main process.
 *
 * Opens the official DeepSeek Harness web UI (served by DSH itself at
 * DSH_URL) in a standalone desktop window. The web UI already provides every
 * feature and the exact layout the user sees in the browser — nothing is
 * reimplemented here. The shell adds desktop conveniences:
 *   - taskbar presence with its own icon
 *   - single-instance lock (second launch focuses the existing window)
 *   - external links open in the system browser, never in the window
 *   - a clear error box when the DSH host is unreachable
 */
import { app, BrowserWindow, shell, dialog } from 'electron';

let win = null;

const DSH_URL = process.env.DSH_URL ?? 'http://127.0.0.1:3080';

async function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 940,
    minHeight: 600,
    title: 'Deepseek Harness',
    backgroundColor: '#0b0f14',
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

  // If the DSH host is down, the page cannot load at all — surface that.
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    dialog.showErrorBox(
      'Deepseek Harness 无法连接',
      `无法加载 DSH 界面（${DSH_URL}）：\n${desc} (${code})\n\n请确认 DeepSeek Harness 正在运行。`,
    );
    app.quit();
  });

  win.on('closed', () => { win = null; });

  await win.loadURL(DSH_URL);
}

// Single instance: focus the existing window instead of spawning another.
const gotLock = app.requestSingleInstanceLock();
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

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
