'use strict';
// data-vault 镜像/回填测试。运行：node --test tests/video-vault.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'video', 'data-vault.js'), 'utf8');
const K_LIB = 'stellaflix-video-library';
const K_WH = 'stellaflix-watch-history-v2';

function makeLocalStorage(initial) {
  const data = Object.assign({}, initial || {});
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
    _dump: () => JSON.parse(JSON.stringify(data)),
  };
}

// 假桥：记录调用；vault 初始内容可控（null/undefined → 视为空对象，避免 set 分支对 null 赋值抛错）
function makeBridge(initialVault) {
  const store = initialVault == null ? {} : JSON.parse(JSON.stringify(initialVault));
  const calls = [];
  return {
    calls,
    videoVault: (action, payload) => {
      calls.push({ action, payload });
      if (action === 'get') return Promise.resolve({ ok: true, data: store });
      if (action === 'set') {
        Object.keys(payload || {}).forEach((k) => { delete store[k]; });
        Object.assign(store, payload || {});
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({ ok: false, error: 'UNKNOWN_ACTION' });
    },
    _store: () => store,
  };
}

function load({ ls, bridge } = {}) {
  const listeners = {};
  const dispatched = {};
  const g = {
    localStorage: ls || makeLocalStorage(),
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    dispatchEvent: (ev) => {
      (listeners[ev.type] || []).forEach((fn) => fn(ev));
      dispatched[ev.type] = (dispatched[ev.type] || 0) + 1;
      return true;
    },
    Event: function (type) { this.type = type; },
    console: { warn() {} },
    setTimeout, clearTimeout,
  };
  if (bridge) g.desktopWindow = { videoVault: bridge.videoVault };
  g.window = g;
  vm.runInNewContext(SRC, g);
  return { g, listeners, dispatched };
}

test('空桶回填：本地无键 + vault 有值 → 写回 localStorage 并派发事件', async () => {
  const ls = makeLocalStorage();
  const br = makeBridge({ [K_LIB]: '[{"id":"a"}]', [K_WH]: '[]' });
  const { g, dispatched } = load({ ls, bridge: br });
  await g.StellaflixVideo.vault.ready;
  assert.strictEqual(ls.getItem(K_LIB), '[{"id":"a"}]');
  assert.strictEqual(ls.getItem(K_WH), '[]');
  assert.strictEqual(dispatched['sfv:vault-restored'], 1, '恢复后应恰派发一次 restored 事件');
});

test('本地为准：两桶同键不同值 → 不覆盖本地，vault 被镜像成本地值', async () => {
  const ls = makeLocalStorage({ [K_LIB]: '[{"id":"local"}]' });
  const br = makeBridge({ [K_LIB]: '[{"id":"vault"}]' });
  const { g } = load({ ls, bridge: br });
  await g.StellaflixVideo.vault.ready;
  assert.strictEqual(ls.getItem(K_LIB), '[{"id":"local"}]');
  assert.strictEqual(br._store()[K_LIB], '[{"id":"local"}]', 'init 末尾无条件镜像应覆盖 vault');
});

test('清空不复活：本地键存在且为空数组 → 不回填', async () => {
  const ls = makeLocalStorage({ [K_LIB]: '[]' });
  const br = makeBridge({}); // vault 已被上次镜像清空
  const { g } = load({ ls, bridge: br });
  await g.StellaflixVideo.vault.ready;
  assert.strictEqual(ls.getItem(K_LIB), '[]');
});

test('防抖镜像：连续 mirror 只产生一次 set', async () => {
  const ls = makeLocalStorage({ [K_LIB]: '[]' });
  const br = makeBridge(null); br._store = () => ({});
  const { g } = load({ ls, bridge: br });
  await g.StellaflixVideo.vault.ready;
  const before = br.calls.filter((c) => c.action === 'set').length;
  g.StellaflixVideo.vault.mirror();
  g.StellaflixVideo.vault.mirror();
  g.StellaflixVideo.vault.mirror();
  await new Promise((r) => setTimeout(r, 1300));
  const after = br.calls.filter((c) => c.action === 'set').length;
  assert.strictEqual(after - before, 1, '3 次 mirror 合并为 1 次 set');
});

test('无桥降级：无 desktopWindow → ready 立即 resolve 且零 IPC', async () => {
  const { g } = load({ ls: makeLocalStorage() });
  const restored = await g.StellaflixVideo.vault.ready;
  assert.strictEqual(restored, false);
});

test('pagehide 强制 flush 未决镜像', async () => {
  const ls = makeLocalStorage({ [K_LIB]: '[{"id":"x"}]' });
  const br = makeBridge({});
  const { g, listeners } = load({ ls, bridge: br });
  await g.StellaflixVideo.vault.ready;
  const before = br.calls.filter((c) => c.action === 'set').length;
  g.StellaflixVideo.vault.mirror(); // 起防抖但不等
  (listeners['pagehide'] || []).forEach((fn) => fn());
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(br.calls.filter((c) => c.action === 'set').length >= before + 1, 'pagehide 应立即 set');
});

test('同步 throw 桥：模块仍可加载、SFV.vault 存在、ready resolve false、无未捕获抛错', async () => {
  const calls = [];
  const br = {
    calls,
    videoVault: function () { calls.push({ action: 'throw' }); throw new Error('boom'); },
  };
  // load() 内 vm.runInNewContext 同步执行 IIFE；若模块加载期抛出则此处直接抛错、用例失败。
  const { g } = load({ ls: makeLocalStorage({ [K_LIB]: '[{"id":"x"}]' }), bridge: br });
  assert.ok(g.StellaflixVideo.vault, 'SFV.vault 必须被赋值');
  assert.strictEqual(typeof g.StellaflixVideo.vault.ready.then, 'function');
  const restored = await g.StellaflixVideo.vault.ready;
  assert.strictEqual(restored, false, '同步 throw 视同拒绝，ready 静默 resolve false');
});

test('get 拒绝但 set 可用：init 结束仍无条件 flush 恰好一次', async () => {
  const calls = [];
  const br = {
    calls,
    videoVault: (action, payload) => {
      calls.push({ action, payload });
      if (action === 'get') return Promise.reject(new Error('get boom'));
      if (action === 'set') return Promise.resolve({ ok: true });
      return Promise.resolve({ ok: false });
    },
  };
  const { g } = load({ ls: makeLocalStorage({ [K_LIB]: '[{"id":"x"}]' }), bridge: br });
  await g.StellaflixVideo.vault.ready;
  assert.strictEqual(calls.filter((c) => c.action === 'get').length, 1);
  assert.strictEqual(calls.filter((c) => c.action === 'set').length, 1, 'get 失败路径仍应恰好 flush 一次（首次建档保护）');
});

test('vault 非空 + 本地全写失败（空快照）：init 末尾跳过 flush，不抹掉健康档案', async () => {
  const ls = makeLocalStorage();
  ls.setItem = () => { throw new Error('QuotaExceededError'); }; // 模拟配额：恢复写回全部失败
  const br = makeBridge({ [K_LIB]: '[{"id":"a"}]' });
  const { g } = load({ ls, bridge: br });
  await g.StellaflixVideo.vault.ready;
  const sets = br.calls.filter((c) => c.action === 'set');
  assert.strictEqual(sets.length, 0, 'vault 非空且本地快照为空时，init 末尾不应发起 set（避免空快照覆盖档案）');
  assert.strictEqual(br._store()[K_LIB], '[{"id":"a"}]', 'vault 档案原内容必须保持完好');
});

test('互补情形：vault 空 + 本地空 → 首次建档仍照常 set 一次', async () => {
  const ls = makeLocalStorage();
  const br = makeBridge(null); // vault 视为 {}
  const { g } = load({ ls, bridge: br });
  await g.StellaflixVideo.vault.ready;
  const sets = br.calls.filter((c) => c.action === 'set');
  assert.strictEqual(sets.length, 1, '两侧皆空属首次建档场景，应保持既有 set 行为');
});
