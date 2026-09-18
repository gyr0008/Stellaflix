'use strict';

/**
 * 回归测试：进入播放器前不得暴露影视首页（星空页）。
 *
 * 背景（2026-09-18 实测复现）：详情页→多源面板→点播放后，play-orchestrator.doPlay
 * 无条件同步 dep('close')() 关闭浏览层；而 source-adapter 的「无扩展名直链（分享页
 * 探测）」分支在最长 8s 的异步探测完成后才点亮播放器 → 中间窗口用户看到首页星空。
 *
 * 契约：
 *  A. 编排器：仅当播放器已可见（isOpen 或 sfv:player-open 事件）后才关闭浏览层。
 *  B. 适配层：unknown-extension 分支在发起探测 fetch 之前同步 prepareForPlay 点亮播放器。
 *
 * 运行：node --test tests/playback-browse-close-order.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const VIDEO_DIR = path.join(__dirname, '..', 'public', 'video');

function readSrc(name) {
  return fs.readFileSync(path.join(VIDEO_DIR, name), 'utf8');
}

function makeSandbox(extra) {
  const listeners = {};
  const sandbox = Object.assign({
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    clearTimeout: (id) => clearTimeout(id),
    Promise: Promise,
    Date: Date,
    URL: URL,
    Math: Math,
    JSON: JSON,
    RegExp: RegExp,
    String: String,
    Number: Number,
    Object: Object,
    Array: Array,
    Error: Error,
    encodeURIComponent,
    decodeURIComponent,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const arr = listeners[type] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    __dispatch(type, detail) {
      (listeners[type] || []).slice().forEach((fn) => fn({ type, detail }));
    },
    __listenerCount(type) { return (listeners[type] || []).length; },
  }, extra || {});
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

function runIn(sandbox, code) {
  vm.runInContext(code, sandbox);
}

// ---------------------------------------------------------------- A. 编排器关层时序

function loadOrchestrator(sandbox) {
  runIn(sandbox, readSrc('play-orchestrator.js'));
  return sandbox.StellaflixVideo;
}

const fakeView = {
  key: 'cms:1', title: '测试片', year: '2026',
  source: { id: 'cms:1', name: '源1' }, vodId: '9',
};
const fakeEp = { index: 0, name: '第1集', url: 'http://elsewhere.example.com/share/hash123' };
const fakePlay = { episodes: [fakeEp] };

function baseDeps(counter) {
  return {
    toast() {},
    recordMeta() {},
    recordHistory() {},
    resolvePic() { return ''; },
    captureReturn() {},
    close() { counter.closeCount += 1; },
  };
}

test('A1 播放器未可见时，编排器不得提前关闭浏览层；sfv:player-open 后才关', () => {
  const counter = { closeCount: 0 };
  let playerShown = false;
  const sandbox = makeSandbox({
    StellaflixVideo: {
      player: {
        isOpen: () => playerShown,
        getVideoEl: () => null,
        setMeta() {}, setPlaylist() {}, setPlayEpisodeAt() {}, setRoads() {}, setPlayNext() {},
        openUrl() { playerShown = true; },
      },
      // 异步接管（分享页探测类路径）：返回 pending Promise，播放器稍后才显示
      source: { open: () => new Promise(() => {}) },
    },
  });
  const SFV = loadOrchestrator(sandbox);
  SFV.playOrchestrator.init(baseDeps(counter));
  SFV.playOrchestrator.play(fakeView, fakeEp, fakePlay);

  assert.strictEqual(counter.closeCount, 0, '播放器尚未显示，浏览层不得关闭');

  playerShown = true;
  sandbox.__dispatch('sfv:player-open', { id: 'cms:1:9:0' });
  assert.strictEqual(counter.closeCount, 1, '播放器显示后应关闭浏览层');

  // 事件只消费一次：再次派发不得重复关闭
  sandbox.__dispatch('sfv:player-open', {});
  assert.strictEqual(counter.closeCount, 1, '重复事件不得二次关闭');
  assert.strictEqual(sandbox.__listenerCount('sfv:player-open'), 0, '关闭后应移除监听');
});

test('A2 播放器已同步可见时，编排器立即关闭浏览层（不等待事件）', () => {
  const counter = { closeCount: 0 };
  const sandbox = makeSandbox({
    StellaflixVideo: {
      player: {
        isOpen: () => true,
        getVideoEl: () => null,
        setMeta() {}, setPlaylist() {}, setPlayEpisodeAt() {}, setRoads() {}, setPlayNext() {},
      },
      source: { open: () => true }, // 同步接管（hls/flv/直链路径）
    },
  });
  const SFV = loadOrchestrator(sandbox);
  SFV.playOrchestrator.init(baseDeps(counter));
  SFV.playOrchestrator.play(fakeView, fakeEp, fakePlay);
  assert.strictEqual(counter.closeCount, 1, '播放器已显示应立即关浏览层');
});

test('A3 播放器模块缺失时降级为立即关闭（不得挂死浏览层）', () => {
  const counter = { closeCount: 0 };
  const sandbox = makeSandbox({
    StellaflixVideo: { source: { open: () => false } },
  });
  const SFV = loadOrchestrator(sandbox);
  SFV.playOrchestrator.init(baseDeps(counter));
  SFV.playOrchestrator.play(fakeView, fakeEp, fakePlay);
  assert.strictEqual(counter.closeCount, 1);
});

// ---------------------------------------------------------------- B. 分享页探测先显播放器

function loadSourceAdapter(sandbox) {
  runIn(sandbox, readSrc('source-adapter-core.js'));
  runIn(sandbox, readSrc('source-adapter.js'));
  return sandbox.StellaflixVideo;
}

test('B1 unknown-extension 分支：探测 fetch 发起前必须已 prepareForPlay 点亮播放器', () => {
  const calls = [];
  let fetchStarted = false;
  const sandbox = makeSandbox({
    location: { href: 'http://localhost:3000/', origin: 'http://localhost:3000' },
    fetch() {
      fetchStarted = true;
      // 永不 resolve：模拟慢探测，仅验证同步顺序
      return { then(onOk, onErr) { this._cbs = [onOk, onErr]; return this; }, catch() { return this; } };
    },
    document: undefined,
    StellaflixVideo: {
      player: {
        prepareForPlay(id, title) { calls.push(['prepareForPlay', id, title, fetchStarted]); },
        openUrl(url, opts) { calls.push(['openUrl', url, fetchStarted]); },
        setCurrentUrl() {},
        getVideoEl() { return null; },
      },
      online: { toast() {} },
      sourceAdapterHls: { attachHls: () => Promise.resolve(true), destroy() {} },
      sourceAdapterDiag: { showDiagnosticOverlay() {} },
    },
  });
  const SFV = loadSourceAdapter(sandbox);
  const r = SFV.source.open({ url: 'http://elsewhere.example.com/share/hash123', title: 'T', id: 'cms:1:9:0' });
  assert.ok(r && typeof r.then === 'function', 'unknown-extension 应返回探测 Promise');
  const prep = calls.find((c) => c[0] === 'prepareForPlay');
  assert.ok(prep, '必须在 open() 同步阶段调用 prepareForPlay');
  assert.strictEqual(prep[3], false, 'prepareForPlay 必须早于探测 fetch');
  assert.strictEqual(fetchStarted, true, '探测应已发起');
});
