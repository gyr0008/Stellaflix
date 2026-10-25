'use strict';
const path = require('path');
const { execFile } = require('child_process');
const { DesktopWallpaperRuntime } = require('./wallpaper-mode-runtime');
const { setTaskbarHidden } = require('./desktop-taskbar-runtime');

function createCoverWallpaperRuntime(deps) {
  const BrowserWindow = deps.BrowserWindow;
  const screen = deps.screen;
  const ipcMain = deps.ipcMain;
  const overlayUrl = deps.overlayUrl;
  const getMainWindow = deps.getMainWindow;
  const isTrustedEvent = deps.isTrustedEvent;
  // 壁纸桌面层进出时通知外层（主进程据此把主窗顶到 topmost，避免被 topmost 壁纸盖住）。
  const onHostActiveChange = typeof deps.onHostActiveChange === 'function' ? deps.onHostActiveChange : null;
  let hostActive = false;

  const runtime = new DesktopWallpaperRuntime({
    BrowserWindow,
    screen,
    preloadPath: path.join(__dirname, 'overlay-preload.js'),
    overlayUrl: () => overlayUrl('cover-wallpaper.html'),
    execFileImpl: execFile,
    // 沉浸态：壁纸窗是 topmost 全屏窗，任务栏必须真隐藏（topmost 挡不住它自动弹出，
    // 实测见 desktop/desktop-taskbar-runtime.js 顶部注释）。
    setTaskbarHidden: (hidden) => setTaskbarHidden(hidden, { execFileImpl: execFile }),
    onStatus: (status) => {
      const win = typeof getMainWindow === 'function' ? getMainWindow() : null;
      if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
        try { win.webContents.send('stellaflix-cover-wallpaper-runtime-state', status); } catch (_) { }
      }
      const nextActive = !!(status && status.active === true);
      if (nextActive !== hostActive) {
        hostActive = nextActive;
        if (onHostActiveChange) {
          try { onHostActiveChange(nextActive); } catch (_) { }
        }
      }
    },
  });

  const deny = { ok: false, error: 'IPC_UNTRUSTED' };
  ipcMain.handle('stellaflix-cover-wallpaper-set-enabled', async (event, enabled, payload) => {
    if (!isTrustedEvent(event)) return deny;
    return enabled === true ? runtime.start(payload || {}) : runtime.stop('renderer-disabled');
  });
  ipcMain.handle('stellaflix-cover-wallpaper-update', async (event, payload) => {
    if (!isTrustedEvent(event)) return deny;
    return runtime.update(payload && typeof payload === 'object' ? payload : {});
  });
  ipcMain.handle('stellaflix-cover-wallpaper-get-status', async (event) => {
    if (!isTrustedEvent(event)) return deny;
    return runtime.getStatus('renderer-get-status');
  });

  return {
    runtime,
    reconcile: (reason) => runtime.reconcileDisplay(reason),
    dispose: () => runtime.dispose(),
  };
}

module.exports = { createCoverWallpaperRuntime };
