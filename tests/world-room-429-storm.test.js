'use strict';

/**
 * 修复轮⑥ A1 — 429 风暴根因回归（2026-09-30 用户实测）
 *
 * 缺陷链（诊断记录）：
 *   1) world-room-api.js 的 rateCheck 在「房间是否存在」校验之前拦截，
 *      全局锁定期内连合法房主的 GET/close/signal 也一律 429；
 *   2) edge-local.js 的 GET 不带 x-device-id 头 → 全部流量归 'anon' 一桶，
 *      点演示灯塔的必然 404 探针快速攒满 10 次失败触发自锁循环；
 *   3) openSignal 250ms 信箱轮询在服务端房间消失（重启/TTL/close）后
 *      无限重试，孤儿页签持续把 not-found 计数打满 → 锁定刚到期又自锁。
 *
 * 契约（GREEN 目标）：
 *   - 命中既有房间的请求（GET/POST 任何子路径）永不进限流分支；
 *   - 未命中请求仍按 D2 限流（防房间码暴力枚举，语义不回退）；
 *   - edge-local GET/POST 均带 x-device-id 头（按设备分桶）；
 *   - openSignal 连续 2 次 404 即自停（孤儿轮询止血），429 仍退避重试。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ---------------- 服务端：假 req/res 驱动 handle ----------------

function freshApi() {
  delete require.cache[require.resolve(path.join(root, 'world-room-api.js'))];
  const api = require(path.join(root, 'world-room-api.js'));
  api._rooms.clear();
  api._rateState.deviceHits.clear();
  api._rateState.globalCount = 0;
  api._rateState.globalWindowStart = 0;
  api._rateState.lockedUntil = 0;
  return api;
}

function makeDoCall(api) {
  const mk = () => ({ _c: 200, _b: null, writeHead(c) { this._c = c; }, end(b) { this._b = b ? JSON.parse(b) : null; } });
  return async (method, pathname, body, headers) => {
    const res = mk();
    const url = new URL('http://127.0.0.1' + pathname);
    const req = { method, headers: headers || {}, socket: { remoteAddress: '127.0.0.1' } };
    const handlers = {};
    req.on = (ev, fn) => { handlers[ev] = fn; };
    if (body) {
      queueMicrotask(() => {
        if (handlers['data']) handlers['data'](JSON.stringify(body));
        if (handlers['end']) handlers['end']();
      });
    } else {
      queueMicrotask(() => { if (handlers['end']) handlers['end'](); });
    }
    await api.handle(req, res, url, (r, d, s) => { r.writeHead(s || 200); r.end(JSON.stringify(d)); });
    return { status: res._c, body: res._b };
  };
}

test('A1-1：锁定生效期间，命中既有房间的请求不得 429（GET/signal/close 全放行）', async () => {
  const api = freshApi();
  const call = makeDoCall(api);

  const created = await call('POST', '/api/room', { deviceId: 'host-1', nickname: '房主', title: 'T', lon: 121, lat: 31 });
  assert.strictEqual(created.status, 200);
  const code = created.body.code;

  // 恶意枚举把全局锁定打满（not-found 计数 10 次 → lockedUntil）
  for (let i = 0; i < 10; i++) {
    await call('GET', '/api/room/ZZ9ZZZ?deviceId=attacker', null, { 'x-device-id': 'attacker' });
  }
  const probe = await call('GET', '/api/room/ZZ9ZZZ?deviceId=attacker', null, { 'x-device-id': 'attacker' });
  assert.strictEqual(probe.status, 429, '前置：枚举探针应已被限流');

  // —— 既有房间的合法面：当前实现会 429（RED），修复后必须 200 ——
  const own = await call('GET', '/api/room/' + code + '?deviceId=host-1', null, { 'x-device-id': 'host-1' });
  assert.strictEqual(own.status, 200, '存在房间的 GET 不得被限流误伤');

  const sig = await call('GET', '/api/room/' + code + '/signal?deviceId=host-1&since=0', null, { 'x-device-id': 'host-1' });
  assert.strictEqual(sig.status, 200, '存在房间的信箱轮询不得被限流误伤');

  const closed = await call('POST', '/api/room/' + code + '/close', { deviceId: 'host-1' }, { 'x-device-id': 'host-1' });
  assert.strictEqual(closed.status, 200, '房主关房不得被限流误伤（幽灵灯塔根源）');
  assert.strictEqual(closed.body.closed, true);
});

test('A1-2：未命中请求仍限流 —— D2 防暴力语义不回退', async () => {
  const api = freshApi();
  const call = makeDoCall(api);

  let first = null;
  for (let i = 0; i < 10; i++) {
    first = await call('GET', '/api/room/NOPE11?deviceId=attacker', null, { 'x-device-id': 'attacker' });
    assert.strictEqual(first.status, 404, '前 10 次未命中应照常 404');
  }
  const blocked = await call('GET', '/api/room/NOPE11?deviceId=attacker', null, { 'x-device-id': 'attacker' });
  assert.strictEqual(blocked.status, 429, '攒满失败计数后未命中探针必须 429');
  assert.strictEqual(blocked.body.error, 'RATE_LIMITED');

  // 列表面（无房间码路径）不受影响
  const list = await call('GET', '/api/rooms');
  assert.strictEqual(list.status, 200);
});

// ---------------- edge-local：设备头 + 孤儿轮询自停 ----------------

function loadEdge(fetchStub) {
  const timers = [];
  const ctx = vm.createContext({
    console: { warn() {}, log() {} },
    Promise, JSON, Math, setTimeout: (fn, ms) => timers.push(fn), clearTimeout() {},
    fetch: fetchStub,
    location: { origin: 'http://127.0.0.1:3000' },
  });
  ctx.window = ctx;
  ctx.StellaflixVideo = {
    lighthouse: { security: { getDeviceId: () => 'dev-test-1' } },
  };
  vm.runInContext(read('public/video/lighthouse/edge-local.js'), ctx, { filename: 'edge-local.js' });
  const flush = () => {
    const batch = timers.splice(0);
    batch.forEach((f) => f());
    return batch.length;
  };
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  return { edge: ctx.StellaflixVideo.lighthouse.edge, flush, settle };
}

test('A1-3：edge-local GET/POST 都带 x-device-id 头（服务端按设备分桶的前提）', async () => {
  const seen = [];
  const env = loadEdge((url, opts) => {
    seen.push({ url: String(url), opts: opts || {} });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
  });
  await env.edge.getRoom('ABC123');
  await env.edge.createRoom('ABC123', { discovery: true, title: 'T', name: 'N', lon: 1, lat: 2 });
  assert.strictEqual(seen.length, 2);
  for (const s of seen) {
    assert.ok(s.opts.headers && s.opts.headers['x-device-id'] === 'dev-test-1',
      s.opts.method + ' ' + s.url + ' 应带 x-device-id 头');
  }
});

test('A1-4：openSignal 连续 2 次 404 自停（孤儿轮询止血），429 仍退避续轮', async () => {
  // —— 404 风暴止血
  let calls = 0;
  const env404 = loadEdge(() => {
    calls++;
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ exists: false }) });
  });
  const ws = env404.edge.openSignal('GONE01', () => {});
  for (let round = 0; round < 8; round++) {
    await env404.settle();
    env404.flush();
  }
  await env404.settle();
  env404.flush();
  assert.strictEqual(calls, 2, '连续 404 应只轮 2 次即自停（当前无限重试 = 429 风暴燃料）');
  assert.strictEqual(ws.readyState, 3, '自停后应等价关闭（readyState 3）');

  // —— 429 不许误停（对端可能只是短暂限流）
  let calls429 = 0;
  const env429 = loadEdge(() => {
    calls429++;
    return Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({ error: 'RATE_LIMITED' }) });
  });
  env429.edge.openSignal('LIVE01', () => {});
  for (let round = 0; round < 5; round++) {
    await env429.settle();
    env429.flush();
  }
  assert.ok(calls429 >= 3, '429 退避重试不得自停（真实会话恢复后要能续上）');
});
