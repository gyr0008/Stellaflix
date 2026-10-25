'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

// screen 模块在 app ready 前被触碰会在 load 期抛
// "The 'screen' module can't be used before the app 'ready' event"，
// runtime 原生事件必须等 ready 后再挂。

test('runtime 不在 app ready 前触碰 screen/powerMonitor 事件源', () => {
  let whenReadyResolve = null;
  const screenEvents = [];
  const screen = { on: (name) => screenEvents.push(name), removeListener: () => {} };
  const powerMonitor = { on: (name) => screenEvents.push("power:" + name), removeListener: () => {} };
  const fakeApp = {
    isReady: () => false,
    whenReady: () => new Promise((resolve) => { whenReadyResolve = resolve; }),
  };
  const runtime = require("../desktop/mini-player-runtime.js").createMiniPlayerRuntime({
    app: fakeApp,
    screen,
    powerMonitor,
    ipcMain: fakeIpcMain(),
    Menu: undefined,
    BrowserWindow: FakeBrowserWindow,
    overlayUrl: () => 'http://127.0.0.1:3999/mini-player.html',
    getMainWindow: () => null,
    focusMainWindow: () => {},
    isTrustedMainWindowEvent: () => true,
    isWallpaperDesktopActive: () => false,
    getMainServerPort: () => 3999,
    isQuitting: () => false,
    userDataDir: () => require('node:os').tmpdir(),
  });
  assert.deepEqual(screenEvents, [], 'ready 前不得挂任何 screen/powerMonitor 监听');
  whenReadyResolve();
  return new Promise((r) => setImmediate(r)).then(() => {
    assert.ok(screenEvents.includes('display-added'), 'ready 后必须补挂拓扑监听');
    assert.ok(screenEvents.includes('power:suspend'), 'ready 后必须补挂电源监听');
    runtime.dispose();
    assert.deepEqual(screenEvents.filter(() => true).length, 7, 'dispose 后监听不再增长');
  });
});

test('runtime 在 app 已 ready 时同步挂载原生监听', () => {
  const screenEvents = [];
  const runtime = require("../desktop/mini-player-runtime.js").createMiniPlayerRuntime({
    app: { isReady: () => true, whenReady: () => Promise.resolve() },
    screen: { on: (name) => screenEvents.push(name), removeListener: () => {} },
    powerMonitor: { on: (name) => screenEvents.push('power:' + name), removeListener: () => {} },
    ipcMain: fakeIpcMain(),
    BrowserWindow: FakeBrowserWindow,
    overlayUrl: () => 'http://127.0.0.1:3999/mini-player.html',
    getMainWindow: () => null,
    focusMainWindow: () => {},
    isTrustedMainWindowEvent: () => true,
    isWallpaperDesktopActive: () => false,
    getMainServerPort: () => 3999,
    isQuitting: () => false,
    userDataDir: () => require('node:os').tmpdir(),
  });
  assert.equal(screenEvents.length, 7, '已 ready 时创建即挂 3 screen + 4 powerMonitor');
  runtime.dispose();
});

test('ready 前 dispose 则 whenReady 落地后不再补挂（disposed 闸）', () => {
  let whenReadyResolve = null;
  const screenEvents = [];
  const runtime = require("../desktop/mini-player-runtime.js").createMiniPlayerRuntime({
    app: { isReady: () => false, whenReady: () => new Promise((r) => { whenReadyResolve = r; }) },
    screen: { on: (name) => screenEvents.push(name), removeListener: () => {} },
    powerMonitor: { on: (name) => screenEvents.push('power:' + name), removeListener: () => {} },
    ipcMain: fakeIpcMain(),
    BrowserWindow: FakeBrowserWindow,
    overlayUrl: () => 'http://127.0.0.1:3999/mini-player.html',
    getMainWindow: () => null,
    focusMainWindow: () => {},
    isTrustedMainWindowEvent: () => true,
    isWallpaperDesktopActive: () => false,
    getMainServerPort: () => 3999,
    isQuitting: () => false,
    userDataDir: () => require('node:os').tmpdir(),
  });
  runtime.dispose();
  whenReadyResolve();
  return new Promise((r) => setImmediate(r)).then(() => {
    assert.deepEqual(screenEvents, [], 'dispose 后不得再挂监听');
  });
});

// 真机崩溃复现：userData 里已有 mini-player-bounds.json 时，创建期的坐标水合
// 会走 clampBounds → screen.getDisplayMatching，在 ready 前直接抛错让 app 起不来。
test('存在已保存坐标文件时，ready 前创建 runtime 仍不得触碰 screen', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-mp-bounds-'));
  fs.writeFileSync(path.join(dir, 'mini-player-bounds.json'),
    JSON.stringify({ miniPlayerBounds: { x: 100, y: 200, expandDirection: 'left' } }), 'utf8');

  let appReady = false;
  const display = {
    id: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  };
  const screenTarget = {
    getDisplayMatching: () => display,
    getPrimaryDisplay: () => display,
    on: () => {},
    removeListener: () => {},
  };
  const screen = new Proxy({}, {
    get(_target, prop) {
      if (!appReady) throw new TypeError("The 'screen' module can't be used before the app 'ready' event");
      return screenTarget[prop];
    },
  });

  let whenReadyResolve = null;
  const mainWindow = new FakeWindow();
  mainWindow.isVisible = () => true;
  mainWindow.isMinimized = () => false;
  mainWindow.getBounds = () => ({ x: 0, y: 0, width: 1920, height: 1080 });
  const ipc = fakeIpcMain();
  let runtime = null;
  assert.doesNotThrow(() => {
    runtime = require('../desktop/mini-player-runtime.js').createMiniPlayerRuntime({
      app: { isReady: () => false, whenReady: () => new Promise((r) => { whenReadyResolve = r; }) },
      screen,
      powerMonitor: { on: () => {}, removeListener: () => {} },
      ipcMain: ipc,
      BrowserWindow: FakeBrowserWindow,
      overlayUrl: () => 'http://127.0.0.1:3999/mini-player.html',
      getMainWindow: () => mainWindow,
      focusMainWindow: () => {},
      isTrustedMainWindowEvent: () => true,
      isWallpaperDesktopActive: () => false,
      getMainServerPort: () => 3999,
      isQuitting: () => false,
      userDataDir: () => dir,
    });
  }, 'ready 前不得因坐标水合触碰 screen');

  appReady = true;
  whenReadyResolve();
  return new Promise((r) => setImmediate(r)).then(() => {
    const result = ipc._handlers.get('stellaflix-mini-player-prepare-transition')({ sender: mainWindow.webContents });
    assert.ok(result && result.ok === true, 'ready 后 prepare-transition 必须成功');
    assert.ok(result.origin, 'ready 后必须完成坐标水合，origin 不得为 null');
    // 已保存 x=100（宽 360）→ 中心 280 / 主窗 1920 ≈ 0.146；未水合时默认贴右缘 ≈ 0.9。
    assert.ok(result.origin.x < 0.3, `origin 必须来自已保存坐标，实得 ${result.origin.x}`);
    runtime.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, listener) => handlers.set(channel, listener),
    removeHandler: (channel) => handlers.delete(channel),
    on: () => {},
    removeListener: () => {},
    _handlers: handlers,
  };
}

class FakeWindow extends EventEmitter {
  constructor() { super(); this.webContents = { isDestroyed: () => false, send: () => {}, on: () => {}, once: () => {}, setWindowOpenHandler: () => {} }; }
  isDestroyed() { return false; }
  loadURL() { return Promise.resolve(); }
  hide() {} show() {} close() {} destroy() {} getPosition() { return [0, 0]; }
  getBounds() { return { x: 0, y: 0, width: 360, height: 84 }; }
  setBounds() {} setSize() {} setAlwaysOnTop() {} setSkipTaskbar() {} once() { return this; } on() { return this; }
}
function FakeBrowserWindow() { return new FakeWindow(); }
