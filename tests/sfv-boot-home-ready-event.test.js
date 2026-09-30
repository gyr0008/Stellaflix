'use strict';

/**
 * 影视 bootstrap：goHome 成功后派发 'sfv:home-boot-ready'
 * 该事件是 03-splash.js 秒启动黑屏 gate 的唯一放行信号。
 * 运行：node --test tests/sfv-boot-home-ready-event.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'video', 'bootstrap.js'), 'utf8');

function loadBootstrap() {
  const pending = [];
  const dispatched = [];
  const winListeners = {};
  const SFV = {
    state: { init() {}, isVideo: () => true },
    dispatch: { bind() {} },
    online: null,
    home: null,
  };
  const sandbox = {
    console, Math, JSON, Date, Object, Array, String, Number, Boolean, Error, setTimeout,
    document: { readyState: 'complete', body: null },
    // 不提供 Promise → bootstrap 走 setTimeout 轮询，测试可用假定时器确定性驱动
    setTimeout: (fn, ms) => { pending.push({ fn, ms }); return pending.length - 1; },
    addEventListener: (ev, fn) => { (winListeners[ev] = winListeners[ev] || []).push(fn); },
    removeEventListener: () => {},
    CustomEvent: function (type) { this.type = type; },
    dispatchEvent: (ev) => { dispatched.push(ev.type); (winListeners[ev.type] || []).slice().forEach((f) => f(ev)); return true; },
    StellaflixVideo: SFV,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'bootstrap.js' });
  return {
    SFV, dispatched,
    // bootstrap 的 Promise 是 vm 内建 → tryEnsureHome 首轮走微任务，先冲刷再驱动假定时器
    flushMicrotasks: () => new Promise((r) => setImmediate(r)),
    drain: () => {
      const batch = pending.splice(0, pending.length);
      batch.forEach((t) => t.fn());
    },
  };
}

test('goHome 就绪并调用后派发 sfv:home-boot-ready', async () => {
  const env = loadBootstrap();
  let goHomeCalls = 0;
  env.SFV.online = { goHome: () => { goHomeCalls++; } };
  await env.flushMicrotasks(); // 首轮微任务即就绪
  assert.equal(goHomeCalls, 1);
  assert.ok(env.dispatched.includes('sfv:home-boot-ready'),
    'goHome 成功后必须派发 sfv:home-boot-ready，实际: ' + env.dispatched.join('/'));
});

test('online 延迟就绪：就绪前不派发，就绪后派发且只派发一次', async () => {
  const env = loadBootstrap();
  await env.flushMicrotasks(); // 第 1 轮未就绪 → 重排 100ms 假定时器
  assert.ok(!env.dispatched.includes('sfv:home-boot-ready'), '未就绪不得提前放行 splash');
  env.drain(); // 第 2 轮仍未就绪
  assert.ok(!env.dispatched.includes('sfv:home-boot-ready'));
  env.SFV.online = { goHome: () => {} };
  env.drain(); // 第 3 轮就绪
  assert.ok(env.dispatched.includes('sfv:home-boot-ready'));
  env.drain();
  env.drain();
  assert.equal(env.dispatched.filter((t) => t === 'sfv:home-boot-ready').length, 1, '只派发一次');
});
