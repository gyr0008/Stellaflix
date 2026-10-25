'use strict';
// 方案 B 守卫：壁纸桌面层 = topmost 全屏窗（不 SetParent）+ 真隐藏系统任务栏。
//
// 为什么需要这组守卫（本机实测 2026-10-25，2560x1440 / Win11 NT 10.0.26300，任务栏 auto-hide 开启）：
//   判据 = 光标移到底部后 Shell_TrayWnd 的矩形变不变（1438=隐藏位，1392=弹出位）
//     无全屏窗（对照组）       1438 → 1392  会弹
//     全屏窗 + 前台            1438 → 1438  被抑制
//     全屏窗 + 非前台          1438 → 1392  会弹
//     全屏窗 + topmost + 非前台 1438 → 1392  仍会弹
//   → topmost 挡不住任务栏（它自己是 WS_EX_TOPMOST，光标贴边时 Explorer 把它 raise 到最上方）；
//     而壁纸窗 focusable:false + showInactive() 永远不是前台，所以「前台全屏」的抑制也用不上。
//     唯一解：ShowWindow(Shell_TrayWnd, SW_HIDE)。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const {
  DesktopWallpaperRuntime,
  WALLPAPER_HOST_MODE_TOPMOST,
} = require('../desktop/wallpaper-mode-runtime');
const { taskbarVisibilityScript } = require('../desktop/desktop-taskbar-runtime');

const DISPLAY = { id: 1, bounds: { x: 0, y: 0, width: 2560, height: 1440 } };

function createHarness(options = {}) {
  const log = [];
  const created = [];
  class FakeBrowserWindow {
    constructor(winOptions) {
      this.options = winOptions;
      this.id = created.length + 1;
      this.destroyed = false;
      this.visible = false;
      this.alwaysOnTop = false;
      this.bounds = {
        x: winOptions.x || 0,
        y: winOptions.y || 0,
        width: winOptions.width || 2560,
        height: winOptions.height || 1440,
      };
      this.listeners = new Map();
      this.webContents = {
        on: () => {},
        setWindowOpenHandler: () => {},
        send: () => {},
        isDestroyed: () => false,
      };
      created.push(this);
    }
    on(event, cb) {
      if (!this.listeners.has(event)) this.listeners.set(event, []);
      this.listeners.get(event).push(cb);
      return this;
    }
    once(event, cb) {
      const wrapped = (...args) => {
        this.removeListener(event, wrapped);
        cb(...args);
      };
      return this.on(event, wrapped);
    }
    removeListener(event, cb) {
      const list = this.listeners.get(event) || [];
      const index = list.indexOf(cb);
      if (index >= 0) list.splice(index, 1);
      return this;
    }
    emit(event, ...args) {
      for (const cb of [...(this.listeners.get(event) || [])]) cb(...args);
    }
    loadURL() { return Promise.resolve(); }
    setIgnoreMouseEvents() {}
    setAlwaysOnTop(flag, level) {
      this.alwaysOnTop = flag === true;
      log.push('alwaysOnTop:' + this.alwaysOnTop);
      if (level) log.push('alwaysOnTopLevel:' + String(level));
      return this;
    }
    isAlwaysOnTop() { return this.alwaysOnTop; }
    setBounds(next) {
      this.bounds = { ...next };
      log.push('setBounds');
      return this;
    }
    getBounds() { return { ...this.bounds }; }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    showInactive() {
      this.visible = true;
      log.push('showInactive');
      return this;
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('closed');
    }
    getNativeWindowHandle() {
      const buf = Buffer.alloc(8);
      buf.writeBigUInt64LE(BigInt(913838), 0);
      return buf;
    }
  }

  const taskbarCalls = [];
  const runtime = new DesktopWallpaperRuntime({
    BrowserWindow: FakeBrowserWindow,
    screen: {
      getPrimaryDisplay: () => DISPLAY,
      dipToScreenRect: (_win, rect) => rect,
    },
    preloadPath: path.join(ROOT, 'desktop', 'overlay-preload.js'),
    overlayUrl: () => (Object.prototype.hasOwnProperty.call(options, 'overlayUrl')
      ? options.overlayUrl
      : 'http://127.0.0.1:3000/cover-wallpaper.html'),
    platform: 'win32',
    attachNative: async (input) => {
      log.push('attachNative');
      return { ok: true, targetWindowId: input.hwnd, parentWindowId: '65972', parentClassName: 'Progman', hostStrategy: 'progman-top' };
    },
    setTaskbarHidden: async (hidden) => {
      taskbarCalls.push(hidden);
      log.push('taskbar:' + hidden);
      return { ok: true, visible: hidden !== true, hwnd: '65890', reason: '' };
    },
  });
  return { runtime, created, log, taskbarCalls };
}

test('① 壁纸窗宿主是 topmost 全屏窗：setAlwaysOnTop(screen-saver)，且不再 SetParent', async () => {
  const h = createHarness();
  assert.equal(h.runtime.hostMode, WALLPAPER_HOST_MODE_TOPMOST, '默认宿主必须是 topmost');

  const result = await h.runtime.start({ enabled: true });
  assert.equal(result.ok, true, 'start 必须成功：' + JSON.stringify(result));

  const win = h.created[0];
  assert.equal(win.alwaysOnTop, true, '壁纸窗必须置顶，否则压不住任务栏与其它应用窗口');
  assert.ok(h.log.includes('alwaysOnTopLevel:screen-saver'), '必须用 screen-saver 级别置顶');
  assert.ok(!h.log.includes('attachNative'), 'topmost 宿主不得再走 SetParent 挂载（子窗的 WS_EX_TOPMOST 会被忽略）');

  const status = h.runtime.getStatus('test');
  assert.equal(status.hostStrategy, 'topmost', '宿主策略必须如实上报 topmost');
  assert.equal(status.active, true, 'topmost 宿主也要有 attachment，否则渲染层会误判挂载失败并降级');
  assert.equal(status.hostMode, 'topmost');
});

test('② 进沉浸态隐藏任务栏，退出还原，且顺序是「先上屏再收任务栏」', async () => {
  const h = createHarness();
  await h.runtime.start({ enabled: true });
  assert.deepEqual(h.taskbarCalls, [true], 'start 之后必须隐藏一次任务栏');
  assert.equal(h.runtime.getStatus('test').taskbarHidden, true);

  const shownAt = h.log.indexOf('showInactive');
  const hiddenAt = h.log.indexOf('taskbar:true');
  assert.ok(shownAt >= 0 && hiddenAt > shownAt, '必须先让壁纸窗上屏再隐藏任务栏，否则中途会露出一次桌面');

  await h.runtime.stop('test-disable');
  assert.deepEqual(h.taskbarCalls, [true, false], 'stop 必须把任务栏放回来');
  assert.equal(h.runtime.getStatus('test').taskbarHidden, false);
});

test('③ start 失败必须还原任务栏，不能把用户停在「没有任务栏」的桌面上', async () => {
  const h = createHarness({ overlayUrl: '' });
  const result = await h.runtime.start({ enabled: true });
  assert.equal(result.ok, false, 'overlayUrl 为空时必须启动失败');
  assert.equal(result.error, 'WALLPAPER_URL_UNAVAILABLE');
  assert.deepEqual(h.taskbarCalls, [false], '失败路径必须无条件还原一次任务栏');
  assert.equal(h.runtime.getStatus('test').taskbarHidden, false);
});

test('④ 任务栏脚本：必须用 [NullString]::Value 找 Shell_TrayWnd，且整段是纯 ASCII', async () => {
  const hideScript = taskbarVisibilityScript(true);
  const showScript = taskbarVisibilityScript(false);

  // PowerShell 把 $null 绑到 [string] 形参时传的是空字符串，不是 NULL 指针；
  // 实测 FindWindow("Shell_TrayWnd", $null) = 0，[NullString]::Value 才拿到 65890。
  assert.match(hideScript, /FindWindow\("Shell_TrayWnd", \[NullString\]::Value\)/,
    '必须传 [NullString]::Value，否则找不到任务栏（$null 会被绑成 ""）');
  assert.doesNotMatch(hideScript, /FindWindow\("[A-Za-z_]+", \$null\)/,
    '$null 是已证伪的写法，不得回潮');
  assert.match(hideScript, /ShowWindow\(\$tray, 0\)/, '隐藏用 SW_HIDE(0)');
  assert.match(showScript, /ShowWindow\(\$tray, 5\)/, '还原用 SW_SHOW(5)');
  assert.match(hideScript, /IsWindowVisible\(\$tray\)/, '必须复核真实可见性并回报，不能盲发');
  assert.match(hideScript, /ConvertTo-Json -Compress/, '必须以 JSON 回报，主进程才能判定成败');

  // PowerShell 5.1 的 -Command/-File 在中文系统按 ANSI 解码，脚本里一旦有中文，
  // 多字节字被截断会吞掉字符串结束引号，整段直接语法错误（本次就踩过）。
  for (const [name, script] of [['hide', hideScript], ['show', showScript]]) {
    const bad = [...script].filter((ch) => ch.charCodeAt(0) > 127);
    assert.equal(bad.length, 0, name + ' 脚本必须纯 ASCII，实际出现非 ASCII 字符: ' + JSON.stringify(bad.slice(0, 5)));
  }
});

test('⑤ 接线守卫：cover-wallpaper-runtime 注入任务栏控制器，main.js 有启动自愈与退出兜底', () => {
  const coverSrc = read('desktop/cover-wallpaper-runtime.js');
  assert.match(coverSrc, /require\('\.\/desktop-taskbar-runtime'\)/, '封面壁纸运行时必须拿到任务栏控制器');
  assert.match(coverSrc, /setTaskbarHidden: \(hidden\) => setTaskbarHidden\(hidden/,
    '不注入 setTaskbarHidden 的话运行时永远不会动任务栏（默认惰性）');
  assert.match(coverSrc, /onHostActiveChange/, '必须把桌面层进出事件抛给主进程');

  const mainSrc = read('desktop/main.js');
  assert.match(mainSrc, /ensureTaskbarVisible\(\{ execFileImpl: execFile \}\)/,
    '启动必须无条件还原一次任务栏（上次崩溃/强杀会把它留在隐藏态）');
  assert.match(mainSrc, /restoreTaskbarSync\(\{ execFileSyncImpl: execFileSync \}\)/,
    '退出必须同步兜底还原（异步清理链可能被 15s 超时截断）');
  assert.match(mainSrc, /onHostActiveChange: \(active\) => applyCoverWallpaperHostTopmost\(active\)/,
    '主窗必须跟随壁纸层置顶，否则一开壁纸模式自己的窗口就被壁纸盖住');
  assert.match(mainSrc, /win\.setAlwaysOnTop\(true, 'screen-saver'\)[\s\S]{0,200}moveTop/,
    '主窗置顶后要显式 moveTop，否则落在刚被 raise 的壁纸窗下面');
});

test('⑥ 退出路径不得留下「隐藏任务栏」的残留状态', async () => {
  const h = createHarness();
  await h.runtime.start({ enabled: true });
  assert.deepEqual(h.taskbarCalls, [true]);
  await h.runtime.dispose();
  assert.equal(h.taskbarCalls[h.taskbarCalls.length - 1], false, 'dispose 必须以还原任务栏收尾');
  assert.equal(h.runtime.getStatus('test').taskbarHidden, false);
});
