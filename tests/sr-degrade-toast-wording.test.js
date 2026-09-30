'use strict';

/*
 * SR 降级弹窗回归测试（2026-09-30「渲染9999ms」弹窗 bug）。
 * 根因：sr-engine 看门狗/编译超时降级把内部哨兵值（9999 / SR_COMPILE_DEADLINE_MS）
 * 当实测帧耗时传给 degradeCb，sr-ui 直接拼出「渲染约 9999 ms/帧」的误导文案；
 * 且引擎自身先 toast 一次、sr-ui 收到 degradeCb 又 toast 一次 → 同一事件双弹窗。
 *
 * 契约：
 *  E1/E2 引擎：非测量降级（watchdog / compile-timeout）degradeCb 第三参必须带原因；
 *      引擎不再自发 toast（弹窗文案归 sr-ui 统一负责，防双弹）。
 *  U1/U2 sr-ui：带原因分支的文案不得出现 ms 数字，且只弹一次。
 *  U3 回归：真实慢帧（无 reason）文案保持「xx ms/帧」+自动降档。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SR_DIR = path.resolve(__dirname, '..', 'public', 'video', 'sr');

function readSrc(name) {
  return fs.readFileSync(path.join(SR_DIR, name), 'utf8');
}

function makeEl(tag) {
  return {
    tagName: tag,
    style: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
      toggle() {},
    },
    firstChild: null,
    parentNode: null,
    insertBefore(child) { child.parentNode = this; this.firstChild = child; },
    removeChild() { this.firstChild = null; },
    appendChild(child) { child.parentNode = this; },
    children: [],
    clientWidth: 1920,
    clientHeight: 1080,
    width: 0,
    height: 0,
    textContent: '',
    innerHTML: '',
    title: '',
    id: '',
    className: '',
    _listeners: {},
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    removeEventListener() {},
    dispatch(ev, e) {
      e = e || {};
      if (!e.preventDefault) e.preventDefault = function () { e.defaultPrevented = true; };
      (this._listeners[ev] || []).forEach((fn) => fn(e));
      return e;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    setAttribute() {},
    getAttribute() { return null; },
  };
}

const glStub = new Proxy({}, {
  get(t, p) {
    if (!(p in t)) t[p] = function () { return 0; };
    return t[p];
  },
});

// ---------------- 引擎沙箱（同 sr-watchdog-stall 骨架） ----------------

function makeEngineHarness() {
  const h = { toasts: [], now: 0, timers: [], nextTimer: 1, degradeEvents: [] };
  const overlayHost = makeEl('div');
  const video = makeEl('video');
  Object.assign(video, {
    videoWidth: 1280,
    videoHeight: 720,
    currentTime: 0,
    paused: false,
    readyState: 4,
    src: '',
    currentSrc: '',
    _presented: 0,
    _rvfcCbs: {},
    _rvfcSeq: 0,
    requestVideoFrameCallback(cb) { const id = ++this._rvfcSeq; this._rvfcCbs[id] = cb; return id; },
    cancelVideoFrameCallback(id) { delete this._rvfcCbs[id]; },
    getVideoPlaybackQuality() { return { totalVideoFrames: this._presented, droppedVideoFrames: 0 }; },
    load() {},
    play() { return Promise.resolve(); },
  });
  h.video = video;

  const core = {
    gl: glStub,
    maxTex: 8192,
    getProgram() { return { id: 'prog' }; },
    uploadVideoFrame() { return { id: 'srctex' }; },
    acquireTarget(w, hh) { return { tex: { w, h: hh }, w, h: hh }; },
    drawPass() {},
    resetTargets() {},
    dispose() {},
  };
  h.core = core;

  const sfv = {};
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    performance: { now: () => h.now },
    devicePixelRatio: 1,
    setTimeout(fn, ms) {
      const t = { id: h.nextTimer, fn, time: h.now + (ms || 0) };
      h.timers.push(t);
      return h.nextTimer++;
    },
    clearTimeout(id) {
      const i = h.timers.findIndex((t) => t.id === id);
      if (i >= 0) h.timers.splice(i, 1);
    },
    requestAnimationFrame(fn) { return sandbox.setTimeout(() => fn(h.now), 16); },
    cancelAnimationFrame(id) { sandbox.clearTimeout(id); },
    addEventListener() {},
    removeEventListener() {},
    document: {
      hidden: false,
      getElementById(id) { return id === 'sfv-overlay' ? overlayHost : null; },
      createElement(tag) { return makeEl(tag); },
      addEventListener() {},
      body: makeEl('body'),
    },
    StellaflixVideo: sfv,
  };
  sandbox.window = sandbox;

  sfv.player = { getVideoEl: () => video };
  sfv.srUi = { toast: (m) => h.toasts.push(m) };
  sfv.srHook = {
    parseShader: () => [],
    buildFragment: () => 'fs',
    evalRPN: () => 0,
  };
  sfv.srCore = { createCore() { return core; } };

  h.advance = function (ms) {
    const target = h.now + ms;
    for (;;) {
      const due = h.timers.filter((t) => t.time <= target).sort((a, b) => a.time - b.time || a.id - b.id);
      if (!due.length) break;
      const t = due[0];
      h.timers.splice(h.timers.indexOf(t), 1);
      h.now = t.time;
      t.fn();
    }
    h.now = target;
  };

  vm.runInNewContext(readSrc('sr-engine.js'), sandbox, { filename: 'sr-engine.js' });
  h.engine = sfv.srEngine;
  h.sfv = sfv;
  h.engine.onDegrade((avgMs, presetId, reason) => h.degradeEvents.push({ avgMs, presetId, reason }));
  h.preset = { id: 'test-anime', label: '测试档', mode: 'rgb', files: [], refine: false };
  return h;
}

// E1 首帧看门狗（3s 未出帧）：degradeCb 须带 reason='watchdog'，引擎不得自发 toast
test('E1 首帧看门狗降级：degradeCb 带 watchdog 原因，且引擎不自发 toast（防双弹）', () => {
  const h = makeEngineHarness();
  h.engine.setPreset(h.preset);
  h.advance(3500); // 无 presentFrame → 3s 看门狗判初始化失败
  assert.equal(h.degradeEvents.length, 1, 'watchdog 降级应回调 degradeCb 一次');
  assert.equal(h.degradeEvents[0].reason, 'watchdog',
    'degradeCb 第三参须为 "watchdog"，供 sr-ui 输出无 ms 的准确文案');
  assert.deepEqual(h.toasts, [],
    '弹窗文案归 sr-ui 统一负责：引擎侧再 toast 会造成同一事件双弹窗');
  assert.equal(h.engine._state.running, false, 'watchdog 后须停止 SR');
});

// E2 编译超时：degradeCb 须带 reason='compile-timeout'，引擎不自发 toast
test('E2 编译超时降级：degradeCb 带 compile-timeout 原因，且引擎不自发 toast', () => {
  const h = makeEngineHarness();
  h.sfv.srHook.parseShader = () => [{ hook: 'MAIN' }];
  h.core.getProgram = function () {
    const e = new Error('compile boom');
    e.code = 'SR_COMPILE_TIMEOUT';
    throw e;
  };
  h.engine.setPreset({ id: 'test-boom', label: '炸档', mode: 'rgb', files: [{ text: 'x' }], refine: false });
  assert.equal(h.degradeEvents.length, 1, '编译超时应回调 degradeCb 一次');
  assert.equal(h.degradeEvents[0].reason, 'compile-timeout',
    'degradeCb 第三参须为 "compile-timeout"');
  assert.deepEqual(h.toasts, [], '编译超时弹窗同样归 sr-ui，引擎不重复 toast');
});

// ---------------- sr-ui 沙箱 ----------------

function makeUiHarness(opts) {
  opts = opts || {};
  const h = { toastMessages: [], degradeCb: null };
  const doc = {
    hidden: false,
    createElement(tag) {
      const el = makeEl(tag);
      return el;
    },
    getElementById() { return null; },
    addEventListener() {},
    removeEventListener() {},
    body: (() => {
      const body = makeEl('body');
      const origAppend = body.appendChild.bind(body);
      body.appendChild = function (c) {
        origAppend(c);
        // 记录每次 textContent 赋值 = 一次 toast 展示
        let v = '';
        Object.defineProperty(c, 'textContent', {
          get() { return v; },
          set(x) { v = x; h.toastMessages.push(String(x)); },
          configurable: true,
        });
        return c;
      };
      return body;
    })(),
  };
  const engineStub = {
    onStats() {},
    onDegrade(cb) { h.degradeCb = cb; },
    setPreset() {},
    getStatus() { return { preset: opts.enginePreset || 'off' }; },
  };
  const presetsStub = {
    byId(id) { return { id, label: id === 'ultra' ? '超清档' : '高清档' }; },
    degrade(id) { return id === 'ultra' ? 'hd' : null; },
    load(id) { return Promise.resolve({ id, label: '高清档' }); },
  };
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    document: doc,
    localStorage: {
      getItem() { return JSON.stringify({ preset: 'ultra', autoDegrade: true }); },
      setItem() {},
    },
    setTimeout(fn, ms) { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; },
    clearTimeout(id) { clearTimeout(id); },
    Promise,
    JSON,
    Math,
    Date,
    String,
    Number,
    Object,
    Array,
    Error,
    RegExp,
    addEventListener() {},
    removeEventListener() {},
    StellaflixVideo: { srEngine: engineStub, srPresets: presetsStub },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(readSrc('sr-ui.js'), sandbox, { filename: 'sr-ui.js' });
  return h;
}

// U1 watchdog：文案不含 9999 / ms/帧，只弹一次
test('U1 sr-ui watchdog 降级：单次弹窗且文案不含哨兵 ms 数字', () => {
  const h = makeUiHarness();
  assert.ok(h.degradeCb, 'sr-ui 装载时应注册 onDegrade 回调');
  h.degradeCb(9999, 'ultra', 'watchdog');
  assert.equal(h.toastMessages.length, 1, 'watchdog 降级只允许弹一次');
  assert.ok(!/9999/.test(h.toastMessages[0]), '不得把哨兵值 9999 渲染进文案：' + h.toastMessages[0]);
  assert.ok(h.toastMessages[0].indexOf('ms/帧') < 0, '非测量降级不得出现 ms/帧 字样：' + h.toastMessages[0]);
  assert.ok(h.toastMessages[0].indexOf('回退原生') >= 0, '须告知用户已回退原生播放：' + h.toastMessages[0]);
});

// U2 compile-timeout：文案不含 ms 数字，只弹一次
test('U2 sr-ui 编译超时降级：单次弹窗且文案不含哨兵 ms 数字', () => {
  const h = makeUiHarness();
  h.degradeCb(5000, 'off', 'compile-timeout');
  assert.equal(h.toastMessages.length, 1, '编译超时只允许弹一次');
  assert.ok(h.toastMessages[0].indexOf('ms/帧') < 0, '不得出现 ms/帧 字样：' + h.toastMessages[0]);
  assert.ok(h.toastMessages[0].indexOf('编译超时') >= 0, '须说明编译超时原因：' + h.toastMessages[0]);
});

// U3 回归：真实慢帧（无 reason）保持原「xx ms/帧 + 自动降档」文案
test('U3 慢帧降级（无 reason）：文案仍含实测 ms/帧并自动降档', () => {
  const h = makeUiHarness();
  h.degradeCb(120.4, 'ultra');
  assert.equal(h.toastMessages.length, 1);
  assert.ok(h.toastMessages[0].indexOf('120 ms/帧') >= 0, '慢帧实测耗时须保留展示：' + h.toastMessages[0]);
  assert.ok(h.toastMessages[0].indexOf('超清档') >= 0 && h.toastMessages[0].indexOf('高清档') >= 0,
    'autoDegrade 降档信息须在文案中：' + h.toastMessages[0]);
});
