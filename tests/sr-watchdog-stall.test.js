'use strict';

/*
 * SR 看门狗误判回归测试（vm 沙箱驱动浏览器端 IIFE sr-engine.js）。
 * 背景：切内嵌字幕/切清晰度/暂停/切后台时 video 短暂停止呈现帧，rVFC 静默，
 * 旧看门狗仅比对 paintedFrames，2s 内无新帧即误报「画质增强渲染挂死」。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ENGINE = path.resolve(__dirname, '..', 'public', 'video', 'sr', 'sr-engine.js');

function makeEl(tag) {
  return {
    tagName: tag,
    style: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    firstChild: null,
    parentNode: null,
    insertBefore(child) { child.parentNode = this; this.firstChild = child; },
    removeChild() { this.firstChild = null; },
    appendChild(child) { child.parentNode = this; },
    clientWidth: 1920,
    clientHeight: 1080,
    width: 0,
    height: 0,
    _listeners: {},
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    removeEventListener() {},
    dispatch(ev, e) {
      e = e || {};
      if (!e.preventDefault) {
        e.preventDefault = function () { e.defaultPrevented = true; };
      }
      (this._listeners[ev] || []).forEach((fn) => fn(e));
      return e;
    },
  };
}

const glStub = new Proxy({}, {
  get(t, p) {
    if (!(p in t)) t[p] = function () { return 0; };
    return t[p];
  },
});

function makeHarness() {
  const h = { toasts: [], now: 0, timers: [], nextTimer: 1, createCoreCalls: 0 };
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
  h.sandbox = sandbox;
  h.overlay = overlayHost;

  sfv.player = { getVideoEl: () => video };
  sfv.srUi = { toast: (m) => h.toasts.push(m) };
  sfv.srHook = {
    parseShader: () => [],
    buildFragment: () => 'fs',
    evalRPN: () => 0,
  };
  sfv.srCore = { createCore() { h.createCoreCalls++; return core; } };

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
  // 视频源呈现新帧：触发 rVFC 回调（一次性语义）
  h.presentFrame = function () {
    video._presented++;
    video.currentTime += 0.04;
    const cbs = video._rvfcCbs;
    video._rvfcCbs = {};
    Object.keys(cbs).forEach((k) => cbs[k](h.now, {}));
  };
  // 源在推进但不回调 rVFC（模拟后台标签页：解码继续、画面不呈现）
  h.progressOnly = function () {
    video._presented++;
    video.currentTime += 0.04;
  };

  vm.runInNewContext(fs.readFileSync(ENGINE, 'utf8'), sandbox, { filename: 'sr-engine.js' });
  h.engine = sfv.srEngine;
  h.preset = { id: 'test-anime', label: '测试档', mode: 'rgb', files: [], refine: false };
  h.stalledToast = () => h.toasts.some((t) => t.indexOf('渲染挂死') >= 0);
  return h;
}

function startAndPaintOne(h) {
  h.engine.setPreset(h.preset);
  h.presentFrame();
  assert.ok(h.engine._state.paintedFrames >= 1, '前置条件：已绘制首帧');
}

test('暂停超过看门狗窗口：不得误报渲染挂死，SR 保持运行', () => {
  const h = makeHarness();
  startAndPaintOne(h);
  h.video.paused = true;
  h.advance(8000);
  assert.equal(h.stalledToast(), false, '暂停期间弹出了挂死 toast：' + JSON.stringify(h.toasts));
  assert.equal(h.engine._state.running, true);
});

test('切字幕/切清晰度引起的重缓冲（源停止出帧>2s）：不得误报挂死', () => {
  const h = makeHarness();
  startAndPaintOne(h);
  // 模拟 seek + waiting：paused 仍为 false，currentTime 会跳变但无新帧呈现
  h.video.readyState = 0;
  h.advance(3500);
  h.video.currentTime += 30; // seek 目标时间跳变
  h.advance(2500);
  h.advance(2500);
  assert.equal(h.stalledToast(), false, '缓冲期间弹出了挂死 toast：' + JSON.stringify(h.toasts));
  assert.equal(h.engine._state.running, true);
  // 缓冲恢复后继续正常渲染
  h.video.readyState = 4;
  h.presentFrame();
  assert.equal(h.engine._state.running, true);
});

test('后台标签页（源推进但不呈现帧）：不得误报挂死', () => {
  const h = makeHarness();
  startAndPaintOne(h);
  h.sandbox.document.hidden = true;
  h.advance(3500); h.progressOnly();
  h.advance(2500); h.progressOnly();
  h.advance(2500);
  assert.equal(h.stalledToast(), false, '后台期间弹出了挂死 toast：' + JSON.stringify(h.toasts));
  assert.equal(h.engine._state.running, true);
});

test('源在出帧而 canvas 冻结（真挂死）：仍须降级并回退原生', () => {
  const h = makeHarness();
  startAndPaintOne(h);
  h.engine._state.preset = null; // 模拟 renderFrame 内部卡死：源推进但永不绘制
  h.advance(3500); // 越过 3s 初始窗口，进入续跑检查
  h.progressOnly();
  h.advance(2500); // 越过 +2s 续跑检查点
  assert.equal(h.stalledToast(), true, '真挂死未被检出');
  assert.equal(h.engine._state.running, false);
  assert.equal(h.video.classList.contains('sfv-sr-source-hidden'), false, '须恢复原生 video 可见');
});

test('单帧渲染抛异常不得断裂 rVFC 调度链', () => {
  const h = makeHarness();
  startAndPaintOne(h);
  const paintedBefore = h.engine._state.paintedFrames;
  let boom = true;
  h.core.drawPass = function () { if (boom) { boom = false; throw new Error('gl boom'); } };
  h.presentFrame(); // 异常帧：引擎应吞掉并继续调度下一帧
  assert.equal(Object.keys(h.video._rvfcCbs).length, 1, '异常后未再注册下一帧回调');
  h.presentFrame();
  assert.equal(h.engine._state.paintedFrames, paintedBefore + 1, '异常后的正常帧未恢复绘制');
});

test('webglcontextlost：立即回退原生；webglcontextrestored：按原档位自动重启', () => {
  const h = makeHarness();
  startAndPaintOne(h);
  const canvas = h.overlay.firstChild;
  assert.ok(canvas, '前置条件：SR canvas 已挂载');
  const evt = canvas.dispatch('webglcontextlost', {});
  assert.equal(evt.defaultPrevented, true, 'contextlost 必须 preventDefault 才能收到 restored');
  assert.equal(h.engine._state.running, false);
  assert.equal(h.video.classList.contains('sfv-sr-source-hidden'), false, '上下文丢失后须恢复原生画面');
  canvas.dispatch('webglcontextrestored', {});
  assert.equal(h.createCoreCalls, 2, 'restored 后应重建 GL core');
  assert.equal(h.engine._state.running, true, 'restored 后应自动恢复 SR');
});
