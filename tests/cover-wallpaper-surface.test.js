'use strict';
// 两态互斥契约（源自 Mineradio wallpaper-surface-board.test.js 的设计合同）：
// 背景板模式=桌面侧必收 {enabled:false} 且零桌面推送；桌面模式=背景板彻底释放；
// preset 全链传输；surface 归一化只认 'board'。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const source = read('public/js/modules/02-visual/18-cover-wallpaper.js');

function fakeEl() {
  return {
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, style: {},
  };
}

function buildContext(overrides) {
  overrides = overrides || {};
  const calls = { setCoverWallpaperMode: [], updateCoverWallpaperMode: [], boardPushes: 0 };
  const els = new Map();
  const sandbox = {
    fx: Object.assign({
      coverWallpaper: true, coverWallpaperSurface: 'desktop',
      coverWallpaperOpacity: 1, preset: 5,
    }, overrides.fx || {}),
    playing: true,
    isDevelopmentLockedFx: function () { return false; },
    clampRange: function (v, a, b) { return Math.max(a, Math.min(b, Number(v) || a)); },
    currentDesktopSongMeta: function () { return { title: 'T', artist: 'A', cover: 'data:image/png;base64,AAA' }; },
    desktopOverlayColors: function () { return { primary: '#d6f8ff', secondary: '#9cffdf', highlight: '#fff0b8', glow: '#9cffdf' }; },
    getDesktopWindowApi: function () {
      return {
        setCoverWallpaperMode: function (enabled, payload) {
          calls.setCoverWallpaperMode.push({ enabled: enabled, payload: payload });
          return Promise.resolve(overrides.setResult || { ok: true, enabled: enabled });
        },
        updateCoverWallpaperMode: function (payload) {
          calls.updateCoverWallpaperMode.push(payload);
          return Promise.resolve({ ok: true });
        },
      };
    },
    document: {
      hidden: false, body: fakeEl(),
      getElementById: function (id) { if (!els.has(id)) els.set(id, fakeEl()); return els.get(id); },
      querySelectorAll: function () { return []; },
    },
    window: {
      createCoverWallpaperEffect: function () {
        return { applyState: function () { calls.boardPushes += 1; }, setPaused: function () {}, dispose: function () {} };
      },
    },
    requestAnimationFrame: function () { return 0; },
    performance: { now: function () { return 0; } },
    setInterval: function () { return 0; },
    clearInterval: function () {},
    showToast: function () {},
    saveLyricLayout: function () {},
    updateFxInputs: function () {},
    console: console, Object: Object, Promise: Promise, Math: Math,
    Number: Number, String: String, Array: Array,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { sandbox: sandbox, calls: calls };
}

test('surface 归一化：只认 board，其余回落 desktop', () => {
  const ctx = buildContext();
  assert.equal(ctx.sandbox.normalizeCoverWallpaperSurface('board'), 'board');
  assert.equal(ctx.sandbox.normalizeCoverWallpaperSurface('BOARD'), 'desktop');
  assert.equal(ctx.sandbox.normalizeCoverWallpaperSurface('随便填的值'), 'desktop');
});

test('背景板模式：桌面侧只收 {enabled:false}，零桌面 payload，背景板恰好一推', async () => {
  const ctx = buildContext({ fx: { coverWallpaperSurface: 'board' } });
  await ctx.sandbox.applyCoverWallpaperState(true);
  assert.equal(ctx.calls.setCoverWallpaperMode.length, 1);
  assert.equal(ctx.calls.setCoverWallpaperMode[0].enabled, false);
  // 展开一层以消除 vm  realms 差异（Node 24 deepStrictEqual 对跨 realm 同构对象判不等）。
  assert.deepEqual({ ...ctx.calls.setCoverWallpaperMode[0].payload }, { enabled: false });
  assert.equal(ctx.calls.updateCoverWallpaperMode.length, 0, '背景板模式绝不构建桌面 payload');
  assert.equal(ctx.calls.boardPushes, 1);
});

test('桌面模式：payload 含 preset 且首帧恰好一推，背景板零推', async () => {
  const ctx = buildContext({ setResult: { ok: true, enabled: true, status: { enabled: true } } });
  await ctx.sandbox.applyCoverWallpaperState(true);
  assert.equal(ctx.calls.setCoverWallpaperMode[0].enabled, true);
  assert.equal(ctx.calls.setCoverWallpaperMode[0].payload.preset, 5);
  assert.equal(ctx.calls.updateCoverWallpaperMode.length, 1);
  assert.equal(ctx.calls.updateCoverWallpaperMode[0].preset, 5);
  assert.equal(ctx.calls.boardPushes, 0);
});

test('关闭：两侧都释放且桌面推送签名清零', async () => {
  const ctx = buildContext({ fx: { coverWallpaper: false } });
  await ctx.sandbox.applyCoverWallpaperState(true);
  assert.equal(ctx.calls.setCoverWallpaperMode[0].enabled, false);
  assert.equal(ctx.calls.updateCoverWallpaperMode.length, 0);
  assert.equal(ctx.calls.boardPushes, 0);
});
