'use strict';

/**
 * tests/cover-wallpaper-fullscreen-window.test.js — 壁纸模式不得改动主窗几何（对齐 Mineradio 2.5.1）
 *
 * 【文件名说明】本文件原名守的是 10-24「方案 B：背景板态进原生全屏」。2026-10-25 用户拍板
 * A+B+C 一步到位对齐参照库，方案 B 已整体撤除，本文件随之翻转成**反向契约**（仍沿用原文件名，
 * 避免既有引用/历史断裂）。
 *
 * 取证依据（参照库源码，本次亲自复核）：
 *   - public/app.js:45451-45477 applyWallpaperModeState()：只做 board/desktop 分流 + IPC 下发，
 *     全程不碰主窗（无 fullscreen / minimize / restore / collapse）。
 *   - public/app.js:2613 wallpaperSurface:'desktop'（默认桌面层）；:7855-7857 normalizeWallpaperSurface
 *     默认 desktop。
 *   - desktop/main.js:3236-3258 壁纸窗为独立 BrowserWindow，铺满主屏并挂 WorkerW。
 *   → 用户看到的「居中圆角窗浮在壁纸上」是主窗的**常态窗口化几何**（desktop/main.js getWindowedBounds
 *     3/4 工作区 + 16:9 居中 + CSS 34px 圆角），不是壁纸模式变出来的。
 *
 * 行为规格：
 *   1. 任何路径（开/关/切面/失败回执/无 api）都不得调用 toggleFullscreen / exitFullscreenWindowed；
 *   2. 同样不得调用 collapseToMiniPlayer / minimize / restore；
 *   3. 桌面层挂 Progman（视觉无效）→ 仍降级到背景板并提示，但**降级后也不得全屏**；
 *   4. 桌面层挂 WorkerW → 保持桌面层，主窗不动。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_ROOT = path.join(__dirname, '..');
const SRC_PATH = path.join(APP_ROOT, 'public/js/modules/02-visual/18-cover-wallpaper.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

function buildHarness(options) {
  const opts = options || {};
  const calls = {
    setMode: [], toast: [], save: [],
    minimize: 0, restore: 0, collapse: 0,
    enterFullscreen: 0, exitFullscreen: 0,
  };
  const api = opts.noApi ? null : {
    setCoverWallpaperMode: (enabled, payload) => {
      calls.setMode.push({ enabled: !!enabled, hasPayload: !!(payload && payload.enabled) });
      return Promise.resolve(opts.ack || { ok: true, enabled: true, status: opts.status || null });
    },
    updateCoverWallpaperMode: () => Promise.resolve({ ok: true }),
    getCoverWallpaperModeStatus: () => Promise.resolve(opts.status || {}),
    onCoverWallpaperModeState: () => () => {},
    getState: () => Promise.resolve(Object.assign({ isFullScreen: !!opts.fullscreen, isDesktopEmbedded: false }, opts.windowState)),
    toggleFullscreen: () => { calls.enterFullscreen++; return Promise.resolve({}); },
    exitFullscreenWindowed: () => { calls.exitFullscreen++; return Promise.resolve({}); },
    minimize: () => { calls.minimize++; return Promise.resolve(); },
    restore: () => { calls.restore++; return Promise.resolve(); },
  };
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    Promise,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval,
    performance: { now: () => 0 },
    requestAnimationFrame: (fn) => fn && fn(),
    document: {
      getElementById: () => null,
      querySelectorAll: () => [],
      body: { classList: { add() {}, remove() {} }, offsetWidth: 0 },
    },
    fx: Object.assign({
      coverWallpaper: false,
      coverWallpaperSurface: 'desktop',
      coverWallpaperOpacity: 1,
      preset: '',
      miniPlayerEnabled: true,
    }, opts.fx),
    isDevelopmentLockedFx: () => false,
    clampRange: (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0)),
    currentDesktopSongMeta: () => ({ title: 'T', artist: 'A', cover: 'C' }),
    desktopOverlayColors: () => ({}),
    getDesktopWindowApi: () => api,
    showToast: (msg) => calls.toast.push(msg),
    saveLyricLayout: (payload) => calls.save.push(payload),
    updateFxInputs: () => {},
    playing: false,
    collapseToMiniPlayer: () => { calls.collapse++; return true; },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { sandbox, calls, api };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function assertMainWindowUntouched(calls, label) {
  assert.equal(calls.enterFullscreen, 0, label + '：不得进原生全屏（参照库壁纸模式不碰主窗）');
  assert.equal(calls.exitFullscreen, 0, label + '：不得退出全屏（用户自己的全屏状态不归壁纸管）');
  assert.equal(calls.minimize, 0, label + '：不得最小化主窗');
  assert.equal(calls.restore, 0, label + '：不得还原主窗');
  assert.equal(calls.collapse, 0, label + '：不得收起为迷你条');
}

test('① 桌面层开启 → 只下发桌面层，主窗几何一点不动', async () => {
  const { sandbox, calls } = buildHarness({ fx: { coverWallpaper: true, coverWallpaperSurface: 'desktop' } });
  await sandbox.applyCoverWallpaperState(true);
  assert.deepEqual(calls.setMode, [{ enabled: true, hasPayload: true }], '桌面层要带 payload 起壁纸窗');
  assertMainWindowUntouched(calls, '桌面层开启');
});

test('② 背景板开启 → 同样不得全屏（方案 B 已撤）', async () => {
  const { sandbox, calls } = buildHarness({ fx: { coverWallpaper: true, coverWallpaperSurface: 'board' } });
  await sandbox.applyCoverWallpaperState(true);
  assert.deepEqual(calls.setMode, [{ enabled: false, hasPayload: false }], '背景板不下发桌面层');
  assertMainWindowUntouched(calls, '背景板开启');
});

test('③ 关闭壁纸 → 不得还原/缩回窗口（本来就没动过）', async () => {
  const { sandbox, calls } = buildHarness({ fx: { coverWallpaper: true, coverWallpaperSurface: 'desktop' } });
  await sandbox.applyCoverWallpaperState(true);
  sandbox.fx.coverWallpaper = false;
  await sandbox.applyCoverWallpaperState(true);
  assert.deepEqual(calls.setMode, [
    { enabled: true, hasPayload: true },
    { enabled: false, hasPayload: false },
  ]);
  assertMainWindowUntouched(calls, '关闭壁纸');
});

test('④ 用户自己已经全屏 → 壁纸既不叠加也不退出', async () => {
  const { sandbox, calls } = buildHarness({ fx: { coverWallpaper: true, coverWallpaperSurface: 'board' }, fullscreen: true });
  await sandbox.applyCoverWallpaperState(true);
  assertMainWindowUntouched(calls, '用户已全屏');
});

test('⑤ 桌面层切背景板 → 只切展示面，主窗不动', async () => {
  const { sandbox, calls } = buildHarness({ fx: { coverWallpaper: true, coverWallpaperSurface: 'desktop' } });
  await sandbox.applyCoverWallpaperState(true);
  sandbox.fx.coverWallpaperSurface = 'board';
  await sandbox.applyCoverWallpaperState(true);
  assert.deepEqual(calls.setMode, [
    { enabled: true, hasPayload: true },
    { enabled: false, hasPayload: false },
  ]);
  assertMainWindowUntouched(calls, '切背景板');
});

test('⑥ 桌面层挂 Progman = 视觉无效 → 降级背景板并提示，降级后也不得全屏', async () => {
  const { sandbox, calls } = buildHarness({
    fx: { coverWallpaper: true, coverWallpaperSurface: 'desktop' },
    status: { enabled: true, active: true, parentClassName: 'Progman' },
  });
  await sandbox.applyCoverWallpaperState(true);
  await flush();
  // 契约更新（2026-10-25）：降级只改**渲染位置**，不改用户选择。
  // 旧实现 setCoverWallpaperSurface('board') 会把一次运行时判定写成用户偏好并落盘，
  // 导致「铺满屏幕的那层壁纸」永久出不来；回归守卫见
  // tests/cover-wallpaper-surface-fallback-not-persisted.test.js。
  assert.equal(sandbox.fx.coverWallpaperSurface, 'desktop', '降级不得改写用户选择');
  assert.equal(sandbox.effectiveCoverWallpaperSurface(), 'board', 'Progman 之下的层看不见，本次会话必须降级到背景板');
  assert.ok(calls.toast.some((msg) => /壁纸模式/.test(String(msg))), '降级要有一次说明');
  assertMainWindowUntouched(calls, 'Progman 降级');
});

test('⑦ 桌面层挂 WorkerW（经典 sibling 策略）= 真壁纸层 → 保持桌面层，主窗不动', async () => {
  const { sandbox, calls } = buildHarness({
    fx: { coverWallpaper: true, coverWallpaperSurface: 'desktop' },
    status: { enabled: true, active: true, parentClassName: 'WorkerW', hostStrategy: 'workerw-sibling' },
  });
  await sandbox.applyCoverWallpaperState(true);
  await flush();
  assert.equal(sandbox.fx.coverWallpaperSurface, 'desktop');
  assertMainWindowUntouched(calls, 'WorkerW 桌面层');
});

test('⑦b Windows 11 26xxx 真实回执：子 WorkerW 宿主（类名 WorkerW，strategy=progman-child-workerw）→ 留在桌面层', async () => {
  const { sandbox, calls } = buildHarness({
    fx: { coverWallpaper: true, coverWallpaperSurface: 'desktop' },
    // 实测 NT 10.0.26300：Progman 的子 WorkerW 是该 build 上真正的壁纸层，
    // 其类名是 WorkerW（不是 Progman），由 hostStrategy 标记。
    status: { enabled: true, active: true, parentClassName: 'WorkerW', hostStrategy: 'progman-child-workerw' },
  });
  await sandbox.applyCoverWallpaperState(true);
  await flush();
  assert.equal(sandbox.fx.coverWallpaperSurface, 'desktop', '子 WorkerW 宿主必须留在桌面层');
  assert.equal(calls.toast.filter((m) => /桌面壁纸层不可见/.test(String(m))).length, 0, '不得再弹降级提示');
  assertMainWindowUntouched(calls, 'Progman 子 WorkerW');
});

// 以下两条是**证伪守卫**：旧口径 parentClassName === 'Progman' 即判死，会把下面这两种
// 「类名是 Progman、但 hostStrategy 标明为可用宿主」的回执误杀降级。新口径只有 strategy==='progman'
// 才降级。把函数改回旧版（return parentClassName==='Progman'）这两条必红。
test('⑦c 证伪：类名 Progman + 有效 strategy（progman-child-workerw）→ 不得降级（旧口径会误杀）', async () => {
  const { sandbox, calls } = buildHarness({
    fx: { coverWallpaper: true, coverWallpaperSurface: 'desktop' },
    status: { enabled: true, active: true, parentClassName: 'Progman', hostStrategy: 'progman-child-workerw' },
  });
  await sandbox.applyCoverWallpaperState(true);
  await flush();
  assert.equal(sandbox.fx.coverWallpaperSurface, 'desktop', 'strategy 优先级高于类名：可用宿主不得被判死');
  assertMainWindowUntouched(calls, 'Progman 类名 + 子 WorkerW strategy');
});

test('⑦d 证伪：类名 Progman + 有效 strategy（shelldll-defview）→ 不得降级（旧口径会误杀）', async () => {
  const { sandbox, calls } = buildHarness({
    fx: { coverWallpaper: true, coverWallpaperSurface: 'desktop' },
    status: { enabled: true, active: true, parentClassName: 'Progman', hostStrategy: 'shelldll-defview' },
  });
  await sandbox.applyCoverWallpaperState(true);
  await flush();
  assert.equal(sandbox.fx.coverWallpaperSurface, 'desktop', 'strategy 优先级高于类名：DefView 宿主不得被判死');
  assertMainWindowUntouched(calls, 'Progman 类名 + DefView strategy');
});

test('⑦e 只有走到最后兜底（strategy=progman 且类名 Progman）才降级到背景板', async () => {
  const { sandbox, calls } = buildHarness({
    fx: { coverWallpaper: true, coverWallpaperSurface: 'desktop' },
    status: { enabled: true, active: true, parentClassName: 'Progman', hostStrategy: 'progman' },
  });
  await sandbox.applyCoverWallpaperState(true);
  await flush();
  // 同 ⑥：降级 = 只改渲染位置（会话内），用户选择保持 desktop。
  assert.equal(sandbox.fx.coverWallpaperSurface, 'desktop', '真兜底也不得改写用户选择');
  assert.equal(sandbox.effectiveCoverWallpaperSurface(), 'board', '真兜底才降级');
  assert.ok(calls.toast.some((msg) => /桌面壁纸层不可见/.test(String(msg))));
  assertMainWindowUntouched(calls, 'Progman 兜底降级');
});

// ⑩ 证伪：回执 status 尚未到达（首次开启 / 运行时未上报）时不得判死、不得降级。
// 旧口径 if(!status) return true 会在此时误判降级；改回旧版此测必红（且旧版会抛 null.parentClassName）。
test('⑩ 运行时回执 status 为 null（尚未上报）→ 不得判死、不得降级到背景板', async () => {
  const { sandbox, calls } = buildHarness({
    fx: { coverWallpaper: true, coverWallpaperSurface: 'desktop' },
    status: null, // ack 中 status 字段为 null
  });
  await sandbox.applyCoverWallpaperState(true);
  await flush();
  assert.equal(sandbox.fx.coverWallpaperSurface, 'desktop', 'status 未到不得提前降级');
  assert.equal(calls.toast.filter((m) => /桌面壁纸层不可见/.test(String(m))).length, 0, '不得弹降级提示');
  assertMainWindowUntouched(calls, 'status 为空');
});

test('⑧ 非桌面环境（无 api）→ 静默不动作', async () => {
  const { sandbox, calls } = buildHarness({ fx: { coverWallpaper: true }, noApi: true });
  const result = await sandbox.applyCoverWallpaperState(true);
  assert.equal(result.ok, false);
  assertMainWindowUntouched(calls, '无 api');
});

test('⑨ 源码守卫：壁纸模块不得出现任何主窗几何操作', () => {
  assert.doesNotMatch(SRC, /toggleFullscreen/, '方案 B 已撤：不得再调原生全屏');
  assert.doesNotMatch(SRC, /exitFullscreenWindowed/, '不得由壁纸交还全屏');
  assert.doesNotMatch(SRC, /collapseToMiniPlayer/);
  assert.doesNotMatch(SRC, /\.minimize\s*\(/);
  assert.doesNotMatch(SRC, /\.restore\s*\(/);
  assert.doesNotMatch(SRC, /coverWallpaperFullscreenOwned/, '全屏持有标记应随方案 B 一并移除');
});
