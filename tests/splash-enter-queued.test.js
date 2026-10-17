'use strict';

/**
 * tests/splash-enter-queued.test.js — 开屏"点击进入"就绪前点击排队契约（B 方案）
 *
 * 背景实测事实（h151-storm）：t=1.2s 连点 12 次全部被 `if (splashReadyToEnter)` 静默丢弃，
 * 界面无任何反馈；用户认知=「按钮点不动」。3803ms 才 ready，而 dismiss 那一刻影视链
 * 只跑到 31/136 个脚本。
 *
 * 契约：
 *   ① 就绪前的点击不再丢弃 —— 记下意图，markSplashReadyToEnter 一到立刻放行
 *   ② 就绪前点击给出可见状态（文案切「正在初始化…」），ready 后恢复
 *   ③ 就绪后点击行为不变（回归护栏）
 *   ④ 无论点多少次，reveal 只发生一次
 *
 * 运行：node --test tests/splash-enter-queued.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'modules', '10-shell', '03-splash.js'),
  'utf8'
);

function makeClassList() {
  const set = new Set();
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    toggle: (c, on) => { if (on === undefined) { set.has(c) ? set.delete(c) : set.add(c); } else if (on) { set.add(c); } else { set.delete(c); } },
    _set: set,
  };
}

function makeEl(label) {
  const listeners = {};
  return {
    classList: makeClassList(),
    style: {},
    attrs: {},
    textContent: label || '',
    listeners,
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    removeEventListener() {},
    querySelector(sel) { return sel === '.splash-enter' ? this._enterEl : null; },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
  };
}

function loadSplash(opts) {
  opts = opts || {};
  const docListeners = {};
  const winListeners = {};
  const timers = [];
  const calls = { revealHome: 0 };
  const splashEl = makeEl();
  const enterEl = makeEl('点击进入');
  splashEl._enterEl = enterEl;
  const bodyEl = makeEl();
  const htmlEl = makeEl();
  const document = {
    body: bodyEl,
    documentElement: htmlEl,
    getElementById: (id) => (id === 'splash' ? splashEl : null),
    addEventListener: (ev, fn) => { (docListeners[ev] = docListeners[ev] || []).push(fn); },
  };
  const sandbox = {
    console, Math, JSON, Date, Object, Array, String, Number, Boolean, Error, Set,
    performance: { now: () => 0 },
    document,
    requestAnimationFrame: (cb) => { cb(); },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    clearTimeout: () => {},
    addEventListener: (ev, fn) => { (winListeners[ev] = winListeners[ev] || []).push(fn); },
    removeEventListener: () => {},
    CustomEvent: function (type) { this.type = type; },
    dispatchEvent: (ev) => { (winListeners[ev.type] || []).slice().forEach((f) => f(ev)); return true; },
    // 跨模块依赖桩（浏览器里由音乐模块链提供）
    markAppPerf: () => {},
    revealIdleParticles: () => {},
    updateEmptyHomeVisibility: () => { calls.revealHome++; return true; },
    shouldForceEmptyHomeAfterSplash: () => false,
    markStartupHomeReadyForAutoplay: () => {},
    maybeRunStartupLoginGuide: () => {},
    maybeShowUploadTipOnce: () => {},
    hasAnyPlatformLogin: () => true,
    activateHomeWallpaperPreview: () => {},
    prewarmHomeWallpaperPreview: () => {},
    shouldUseIdleWallpaperPreview: () => false,
    startupFastSkipPreference: false,
    reduceSplashMotion: true,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: '03-splash.js' });
  return {
    sandbox, splashEl, enterEl, calls,
    fireDOMContentLoaded: () => (docListeners['DOMContentLoaded'] || []).forEach((f) => f()),
    click: () => (splashEl.listeners['click'] || []).forEach((f) => f({ type: 'click' })),
    markReady: () => sandbox.markSplashReadyToEnter(),
    flushTimersUpTo: (maxMs) => {
      const due = timers.filter((t) => t.ms <= maxMs);
      timers.splice(0, timers.length, ...timers.filter((t) => t.ms > maxMs));
      due.forEach((t) => t.fn());
    },
    hidden: () => splashEl.classList.contains('hide'),
    // dismissSplash 非即时路径：先 'exiting'，620ms 后才 'hide' + revealHome
    entered: () => splashEl.classList.contains('exiting') || splashEl.classList.contains('hide'),
  };
}

test('① 就绪前点击不进入，但意图被记住：ready 一到立刻自动放行', () => {
  const env = loadSplash();
  env.fireDOMContentLoaded();
  env.click();
  assert.equal(env.entered(), false, 'ready 前不得进入');
  env.markReady();
  assert.equal(env.entered(), true, 'ready 后必须把排队的点击放行');
  env.flushTimersUpTo(700);
  assert.equal(env.calls.revealHome, 1);
});

test('② 就绪前点击显示「正在初始化…」，ready 后恢复原文案', () => {
  const env = loadSplash();
  env.fireDOMContentLoaded();
  assert.equal(env.enterEl.textContent, '点击进入', '未点击时保持原文案');
  env.click();
  assert.equal(env.enterEl.textContent, '正在初始化…');
  env.markReady();
  assert.equal(env.enterEl.textContent, '点击进入', 'ready 后恢复原文案');
});

test('③ 就绪后点击照常直接进入（回归护栏）', () => {
  const env = loadSplash();
  env.fireDOMContentLoaded();
  env.markReady();
  assert.equal(env.entered(), false, 'ready 本身不应自动进入');
  env.click();
  assert.equal(env.entered(), true);
  env.flushTimersUpTo(700);
  assert.equal(env.calls.revealHome, 1);
});

test('④ 连点 20 次只进入一次', () => {
  const env = loadSplash();
  env.fireDOMContentLoaded();
  for (let i = 0; i < 20; i++) env.click();
  assert.equal(env.calls.revealHome, 0, 'ready 前不得 reveal');
  env.markReady();
  for (let i = 0; i < 20; i++) env.click();
  env.flushTimersUpTo(700);
  assert.equal(env.calls.revealHome, 1, 'reveal 只能发生一次');
});

test('④ 就绪前从未点击时，ready 只点亮按钮不自动进入', () => {
  const env = loadSplash();
  env.fireDOMContentLoaded();
  env.flushTimersUpTo(1500);
  assert.equal(env.entered(), false, '用户没点过就不能自己进去');
  env.click();
  assert.equal(env.entered(), true);
});
