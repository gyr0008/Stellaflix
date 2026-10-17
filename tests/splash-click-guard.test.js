'use strict';

/**
 * tests/splash-click-guard.test.js — 开屏点击穿透护栏契约（C 方案）
 *
 * 实测事实（h153/h156 CDP 取证）：开屏期间往视口中心点一次，渲染进程抛
 *   Uncaught TypeError: Cannot set properties of undefined (setting 'x')
 *     at addRipple (sonic-topography-preset.js) ← pointerRipple ← window 'mouseup' 监听
 * 即：#splash 虽然 z-index:300 盖住了命中测试，但 window/document 级的全局监听
 * （粒子水波、轨道拖拽、各类面板）照样收到同一个点击 —— 弹窗期间输入不该落到背后。
 *
 * 契约：
 *   ① 开屏仍在挡（body.splash-active 且未 exiting/hide）时，pointerdown/mousedown/mouseup/click
 *      在 window 捕获层被收口：stopPropagation + preventDefault
 *   ② 落在 #splash 内的 click 收口后仍要走到进入逻辑（排队或放行），不能把「点击进入」点死
 *   ③ 落在 #splash 外的指针事件不得触发进入（吞掉就吞掉，不能当成点击开屏）
 *   ④ 一旦 dismissSplash 开始（exiting），不得再吞 —— 淡出 620ms 期间背后 UI 必须可交互，
 *      否则又造出新的「点了没反应」窗口
 *
 * 运行：node --test tests/splash-click-guard.test.js
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
  const el = {
    classList: makeClassList(),
    style: {},
    attrs: {},
    textContent: label || '',
    listeners,
    parentNode: null,
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    removeEventListener() {},
    querySelector(sel) { return sel === '.splash-enter' ? this._enterEl : null; },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
  };
  return el;
}

function loadSplash() {
  const docListeners = {};
  const winListeners = {};
  const timers = [];
  const calls = { revealHome: 0 };
  const splashEl = makeEl();
  const enterEl = makeEl('点击进入');
  enterEl.parentNode = splashEl;
  splashEl._enterEl = enterEl;
  const bodyEl = makeEl();
  const htmlEl = makeEl();
  const outsideEl = makeEl();            // 代表背后的 UI（账户面板/画布）
  outsideEl.parentNode = bodyEl;
  bodyEl.parentNode = htmlEl;
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

  function makeEvent(type, target) {
    const ev = { type, target, defaultPrevented: false, propagated: true };
    ev.preventDefault = () => { ev.defaultPrevented = true; };
    ev.stopPropagation = () => { ev.propagated = false; };
    return ev;
  }

  return {
    sandbox, splashEl, enterEl, bodyEl, outsideEl, calls,
    fireDOMContentLoaded: () => (docListeners['DOMContentLoaded'] || []).forEach((f) => f()),
    winListenerCount: (ev) => (winListeners[ev] || []).length,
    // 走 window 捕获层：先给护栏，再（模拟命中测试）交给 #splash 自己的监听
    fireWindow: (type, target) => {
      const ev = makeEvent(type, target);
      (winListeners[type] || []).slice().forEach((f) => f(ev));
      return ev;
    },
    clickSplash: () => (splashEl.listeners['click'] || []).forEach((f) => f({ type: 'click' })),
    markReady: () => sandbox.markSplashReadyToEnter(),
    flushTimersUpTo: (maxMs) => {
      const due = timers.filter((t) => t.ms <= maxMs);
      timers.splice(0, timers.length, ...timers.filter((t) => t.ms > maxMs));
      due.forEach((t) => t.fn());
    },
    entered: () => splashEl.classList.contains('exiting') || splashEl.classList.contains('hide'),
    queued: () => sandbox.splashEnterRequested,
  };
}

test('① 开屏挡着时指针事件在 window 捕获层被收口（不再落到全局监听）', () => {
  const env = loadSplash();
  assert.ok(env.winListenerCount('mouseup') > 0, '必须注册 mouseup 捕获护栏（水波就是 mouseup 触发的）');
  assert.ok(env.winListenerCount('pointerdown') > 0, '必须注册 pointerdown 捕获护栏');
  for (const type of ['pointerdown', 'mousedown', 'mouseup']) {
    const ev = env.fireWindow(type, env.splashEl);
    assert.equal(ev.propagated, false, type + ' 必须 stopPropagation');
    assert.equal(ev.defaultPrevented, true, type + ' 必须 preventDefault');
  }
});

test('② 落在 #splash 内的 click 收口后仍能进入：点了排队，ready 一到放行', () => {
  const env = loadSplash();
  const ev = env.fireWindow('click', env.enterEl);
  assert.equal(ev.propagated, false, 'click 也要收口，不能放任冒泡');
  assert.equal(env.queued(), true, '落在开屏上的点击必须走到排队逻辑');
  assert.equal(env.enterEl.textContent, '正在初始化…', '要有可见反馈');
  env.markReady();
  assert.equal(env.entered(), true, 'ready 后自动放行那次点击');
  env.flushTimersUpTo(700);
  assert.equal(env.calls.revealHome, 1);
});

test('③ 落在 #splash 外的指针事件被吞掉，且不得触发进入', () => {
  const env = loadSplash();
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
    const ev = env.fireWindow(type, env.outsideEl);
    assert.equal(ev.propagated, false, type + ' 落在背后 UI 上时必须吞掉');
  }
  assert.equal(env.queued(), false, '吞掉的事件不能当成点击开屏');
  assert.equal(env.entered(), false, '更不能进入');
});

test('④ dismissSplash 开始后（exiting 淡出期）不再吞事件——背后 UI 必须立即可交互', () => {
  const env = loadSplash();
  env.fireDOMContentLoaded();
  env.markReady();
  env.clickSplash();
  assert.equal(env.entered(), true, '已进入 exiting');
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
    const ev = env.fireWindow(type, env.outsideEl);
    assert.equal(ev.propagated, true, type + ' 在淡出期必须放行给背后 UI');
    assert.equal(ev.defaultPrevented, false);
  }
});

test('⑤ 键盘事件不受护栏影响（Enter/Space 仍能进入）', () => {
  const env = loadSplash();
  const ev = env.fireWindow('keydown', { nodeName: 'BODY' });
  assert.equal(ev.propagated, true, 'keydown 不得被指针护栏吞掉');
});
