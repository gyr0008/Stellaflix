'use strict';

/**
 * tests/cover-wallpaper-window-inert.test.js — 壁纸模式不得收起/最小化主窗（参照契约）
 *
 * 依据 Mineradio 2.5.1 源码：public/app.js:45451-45474 的 applyWallpaperModeState() 全程不碰主窗，
 * collapseToMiniPlayer() 只绑在最小化按钮（app.js:46133）。10-18 的 R1「开壁纸即自动收起」把两个
 * 动作压成一个，真机表现=一点开关就像退出了软件，故撤销。
 *
 * 10-24 方案 B 只新增「背景板态进原生全屏」这一条（见 cover-wallpaper-fullscreen-window.test.js）；
 * 本文件守的是另一半：任何路径都不得再走 minimize/restore/collapse。
 *
 * 行为规格：
 *   1. 任何路径（开/关/切面/失败回执/无 api）都不得调用 collapseToMiniPlayer / minimize / restore；
 *   2. 桌面层开关仍按 surface 与 enabled 正确下发 setCoverWallpaperMode；
 *   3. 源码层守卫：本模块不再引用主窗收放接口。
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
  const calls = { minimize: 0, restore: 0, collapse: 0, setMode: [], toast: [], save: [] };
  const api = opts.noApi ? null : {
    setCoverWallpaperMode: (enabled, payload) => {
      calls.setMode.push({ enabled: !!enabled, hasPayload: !!(payload && payload.enabled) });
      return Promise.resolve(opts.ack || { ok: true, enabled: true });
    },
    updateCoverWallpaperMode: () => Promise.resolve({ ok: true }),
    getCoverWallpaperModeStatus: () => Promise.resolve({}),
    onCoverWallpaperModeState: () => () => {},
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

test('① 用户开启桌面层成功回执 → 只下发壁纸状态，主窗一律不动', async () => {
  const { sandbox, calls } = buildHarness({ fx: { coverWallpaper: true }, ack: { ok: true, enabled: true } });
  await sandbox.applyCoverWallpaperState(true);
  assert.deepEqual(calls.setMode, [{ enabled: true, hasPayload: true }]);
  assert.equal(calls.collapse, 0, '壁纸开关不得收起主窗');
  assert.equal(calls.minimize, 0, '壁纸开关不得最小化主窗');
  assert.equal(calls.restore, 0);
});

test('② 关闭壁纸、切到背景板、重复调用 → 全程不动主窗', async () => {
  const { sandbox, calls } = buildHarness({ fx: { coverWallpaper: true }, ack: { ok: true, enabled: true } });
  await sandbox.applyCoverWallpaperState(true);
  sandbox.fx.coverWallpaperSurface = 'board';
  await sandbox.applyCoverWallpaperState(true);
  sandbox.fx.coverWallpaper = false;
  await sandbox.applyCoverWallpaperState(true);
  await sandbox.applyCoverWallpaperState(true);
  assert.equal(calls.collapse, 0);
  assert.equal(calls.minimize, 0);
  assert.equal(calls.restore, 0, '退出壁纸也不得代唤主窗（回窗由 pill 关闭链负责）');
  assert.deepEqual(calls.setMode, [
    { enabled: true, hasPayload: true },
    { enabled: false, hasPayload: false },
    { enabled: false, hasPayload: false },
    { enabled: false, hasPayload: false },
  ], '桌面层下发必须随 surface/开关正确收放');
});

test('③ 失败回执与非桌面环境同样不动主窗', async () => {
  const failing = buildHarness({ fx: { coverWallpaper: true }, ack: { ok: false, error: 'WALLPAPER_NATIVE_ATTACH_ABORTED' } });
  await failing.sandbox.applyCoverWallpaperState(true);
  assert.equal(failing.calls.collapse, 0);
  assert.equal(failing.calls.minimize, 0);

  const noApi = buildHarness({ fx: { coverWallpaper: true }, noApi: true });
  const result = await noApi.sandbox.applyCoverWallpaperState(true);
  assert.equal(result.ok, false);
  assert.equal(noApi.calls.collapse, 0);
  assert.equal(noApi.calls.minimize, 0);
});

test('④ 源码守卫：本模块不再引用主窗收放接口', () => {
  assert.doesNotMatch(SRC, /collapseToMiniPlayer/, '壁纸模块不得再触发迷你窗收起');
  assert.doesNotMatch(SRC, /\.minimize\s*\(/, '壁纸模块不得再最小化主窗');
  assert.doesNotMatch(SRC, /\.restore\s*\(/, '壁纸模块不得再代唤主窗');
  assert.doesNotMatch(SRC, /coverWallpaperAutoCollapsed/, '自动收起标志应随 R1 一并撤除');
});
