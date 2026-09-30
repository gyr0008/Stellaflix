'use strict';

/**
 * 秒启动 + 启动默认空间=影视：splash 黑屏 gate 契约
 * 背景 bug：fast-skip 在 DOMContentLoaded 立即 reveal home，而影视接管
 * （SFV.online.goHome）要等 40+ 个串行 rIC 脚本加载完 → 用户直面 ~1s 半改写骨架。
 * 契约：影视启动态下 reveal 推迟到 'sfv:home-boot-ready' 事件或超时兜底。
 * 运行：node --test tests/splash-fast-skip-video-boot.test.js
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

function makeEl() {
  return {
    classList: makeClassList(),
    style: {},
    attrs: {},
    querySelector: () => null,
    parentNode: null,
    setAttribute(k, v) { this.attrs[k] = v; },
  };
}

function loadSplash(opts) {
  const docListeners = {};
  const winListeners = {};
  const timers = [];
  const calls = { revealHome: 0 };
  const splashEl = makeEl();
  const bodyEl = makeEl();
  const htmlEl = makeEl();
  if (opts.startSpaceVideo) htmlEl.classList.add('video-space-active');
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
    maybeRunStartupVisualGuide: () => true,
    maybeRunStartupLoginGuide: () => {},
    maybeShowUploadTipOnce: () => {},
    hasAnyPlatformLogin: () => true,
    activateHomeWallpaperPreview: () => {},
    prewarmHomeWallpaperPreview: () => {},
    shouldUseIdleWallpaperPreview: () => false,
    startupFastSkipPreference: !!opts.fastSkip,
    reduceSplashMotion: true, // 非快路径也避免真实动画分支依赖（本测试只走 fast-skip 分支）
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: '03-splash.js' });
  return {
    sandbox, splashEl, htmlEl, calls,
    fireDOMContentLoaded: () => (docListeners['DOMContentLoaded'] || []).forEach((f) => f()),
    fireHomeBootReady: () => sandbox.dispatchEvent({ type: 'sfv:home-boot-ready' }),
    flushTimersUpTo: (maxMs) => {
      const due = timers.filter((t) => t.ms <= maxMs);
      timers.splice(0, timers.length, ...timers.filter((t) => t.ms > maxMs));
      due.forEach((t) => t.fn());
    },
    hidden: () => splashEl.classList.contains('hide'),
  };
}

test('秒启动+影视启动空间：reveal 等待 sfv:home-boot-ready，事件到达前不进 home', () => {
  const env = loadSplash({ fastSkip: true, startSpaceVideo: true });
  env.fireDOMContentLoaded();
  assert.equal(env.hidden(), false, 'splash 应保持黑屏，不得立即隐藏');
  assert.equal(env.calls.revealHome, 0, 'updateEmptyHomeVisibility 不得在事件前被调用');
  env.fireHomeBootReady();
  assert.equal(env.hidden(), true, '事件到达后应立即进入');
  assert.equal(env.calls.revealHome, 1);
});

test('秒启动+影视启动空间：事件永不到达时超时兜底进入（不永久黑屏）', () => {
  const env = loadSplash({ fastSkip: true, startSpaceVideo: true });
  env.fireDOMContentLoaded();
  env.flushTimersUpTo(1500);
  assert.equal(env.hidden(), true, '超时后必须兜底 reveal');
  assert.equal(env.calls.revealHome, 1);
});

test('秒启动+音乐启动空间：保持现状立即进入（回归护栏）', () => {
  const env = loadSplash({ fastSkip: true, startSpaceVideo: false });
  env.fireDOMContentLoaded();
  assert.equal(env.hidden(), true);
  assert.equal(env.calls.revealHome, 1);
});

test('事件与超时先后到达不重复 reveal', () => {
  const env = loadSplash({ fastSkip: true, startSpaceVideo: true });
  env.fireDOMContentLoaded();
  env.fireHomeBootReady();
  env.flushTimersUpTo(1500);
  assert.equal(env.calls.revealHome, 1, 'reveal 只应发生一次');
});
