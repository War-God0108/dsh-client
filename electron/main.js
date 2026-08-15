/**
 * DSH Client — Electron main process.
 *
 * Boots the embedded local proxy (server.js) and opens the cockpit UI in a
 * desktop window. No external browser needed; the window is the app.
 */
import { app, BrowserWindow, shell, dialog } from 'electron';
import { createProxyServer } from '../server.js';

let win = null;
let proxy = null;
let lastError = null;

const DSH_URL = process.env.DSH_URL ?? 'http://127.0.0.1:3080';

async function startProxy() {
  proxy = await createProxyServer({
    dshUrl: DSH_URL,
    port: Number(process.env.PORT ?? 0), // 0 => ephemeral free port
  });
  console.log(`[dsh-client] proxy listening on ${proxy.port} -> ${proxy.dshUrl}`);
  return proxy;
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 940,
    minHeight: 600,
    title: 'DSH CLIENT — DeepSeek Harness 控制台',
    backgroundColor: '#070b10',
    autoHideMenuBar: true,
    webPreferences: {
      // The UI is a local page proxying a local harness: no node integration.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Open external links in the system browser, never inside the window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${proxy?.port}`)) e.preventDefault();
  });

  win.on('closed', () => { win = null; });

  const url = `http://127.0.0.1:${proxy.port}/`;
  await win.loadURL(url);

  // Surface renderer boot failures (e.g. DSH not reachable) in a dialog.
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log(`[renderer] ${message}`);
  });
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

  app.whenReady().then(async () => {
    try {
      await startProxy();
      await createWindow();
    } catch (err) {
      lastError = err;
      dialog.showErrorBox(
        'DSH CLIENT 启动失败',
        `无法启动本地代理：\n${err.message}\n\n请确认 DSH 实例在 ${DSH_URL} 运行。`,
      );
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && proxy) createWindow();
  });

  app.on('window-all-closed', async () => {
    if (proxy) await proxy.close().catch(() => {});
    if (process.platform !== 'darwin') app.quit();
  });
}
