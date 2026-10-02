'use strict';

/**
 * 世界页 Task 8 — 社交层（看完整片点火烟花 + 全站 broadcast + 点赞）
 * 运行：node --test tests/world-social.test.js
 *
 * 客户端：vm 沙箱加载真实 public/video/world-sync.js + world-social.js，
 *   now/fetch/localStorage/setInterval 全部注入，断言：
 *   light() 无限化恒 true 且 POST（轮⑱ 库存链退役）、since 增量拉取、
 *   onFirework 订阅回调、stop 后 interval 清零。
 * 服务端：直接 require world-room-api.js，用假 req（EventEmitter）驱动 handle，
 *   断言 /api/room/fireworks、/api/room/likes 两个全站频道：seq 单调增、
 *   环形缓冲淘汰（上限 100）、无碰撞论证（房间码恒 6 位，字面量 9/5 位）。
 *
 * 语义源：HearThere main.pretty.js :238-240（收听奖励）——轮⑱（2026-10-02 用户裁决）
 *   改为无限点火：库存/看完整片记账链整体退役，门槛移到 UI 的「选中灯塔」判定；
 *   粒子参数移植自 public/video/world-actions.js:77-177（对齐 hearthere fireworks.js）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ============================================================
//  客户端：vm 沙箱加载真实 world-sync.js + world-social.js
// ============================================================

function fakeStorage(init) {
  const m = Object.assign({}, init || {});
  return {
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; },
    _dump: m
  };
}

function loadSocial(opts) {
  opts = opts || {};
  const posts = [];
  const gets = [];
  const storage = opts.storage || fakeStorage();
  const intervals = []; // { fn, ms, cleared }

  const sandbox = {
    console, Promise,
    setTimeout, clearTimeout,
    document: { querySelector: () => null }
  };
  sandbox.location = { origin: 'http://127.0.0.1:3000' };
  const fetchStub = function (url, init) {
    (init && init.method === 'POST' ? posts : gets).push({ url: String(url), init });
    if (opts.fetch) return opts.fetch(String(url), init);
    const res = opts.fetchResponse
      ? opts.fetchResponse(String(url), init)
      : { ok: true, status: 200, json: () => Promise.resolve({ ok: true, seq: 0, items: [] }) };
    return Promise.resolve(res);
  };
  sandbox.fetch = fetchStub;
  sandbox.StellaflixVideo = {
    lighthouse: null,
    player: null,
    worldData: opts.worldData || null,
    worldUi: opts.worldUi || null,
    worldRoom: opts.worldRoom === undefined
      ? { session: { code: 'ABC123', role: 'guest', deviceId: 'dev-1' } }
      : opts.worldRoom
  };
  vm.createContext(sandbox);  vm.runInContext(read('public/video/world-sync.js'), sandbox);
  vm.runInContext(read('public/video/world-social.js'), sandbox);
  const S = sandbox.StellaflixVideo.worldSocial;

  S.configure({
    now: opts.now || (typeof opts.nowMs === 'number' ? () => opts.nowMs : () => Date.now()),
    fetch: fetchStub,
    localStorage: storage,
    setInterval: (fn, ms) => { intervals.push({ fn, ms, cleared: false }); return intervals.length; },
    clearInterval: (id) => { const it = intervals[id - 1]; if (it) it.cleared = true; }
  });
  return { S, sandbox, posts, gets, storage, intervals };
}

// ---------- light() 无限化（轮⑱）/ 库存链退役 ----------

test('轮⑱：light() 无限化 —— 零库存恒 true 且每点必 POST（可连发）', async () => {
  const { S, posts, storage } = loadSocial();
  assert.equal(S.light('room-1'), true);
  assert.equal(S.light('room-2'), true);
  assert.equal(S.light('room-3'), true);
  assert.equal(posts.length, 3, '无限点火：每点必发');
  assert.equal(storage.getItem('stellaflix-world-fireworks-stock'), null, '不得再读写库存键');
  assert.equal(storage.getItem('stellaflix-world-completed-keys'), null, '不得再读写记账键');
  assert.equal(posts[0].init.method, 'POST');
  assert.match(posts[0].url, /^http:\/\/127\.0\.0\.1:3000\/api\/room\/fireworks$/);
  const body = JSON.parse(posts[0].init.body);
  assert.equal(body.deviceId, 'dev-1');
  assert.equal(body.payload.stationId, 'room-1');
});

test('轮⑱：库存链全退役 —— stock/handleProgress/checkProgress/STOCK_KEY/SEEN_KEY 摘出导出面', () => {
  const { S } = loadSocial();
  assert.equal(typeof S.stock, 'undefined', 'stock() 应已退役');
  assert.equal(typeof S.handleProgress, 'undefined', 'handleProgress() 应已退役');
  assert.equal(typeof S.checkProgress, 'undefined', 'checkProgress() 应已退役');
  assert.equal(S.STOCK_KEY, undefined, 'STOCK_KEY 导出面应已退役');
  assert.equal(S.SEEN_KEY, undefined, 'SEEN_KEY 导出面应已退役');
});

test('轮⑯：like() 发布面退役（轮⑫ 删按钮后零调用方）；onLike 接收面与 likes 轮询保留', () => {
  const { S, posts } = loadSocial();
  assert.equal(typeof S.like, 'undefined', 'like() 应从导出面摘除');
  assert.equal(typeof S.onLike, 'function', 'onLike 接收面保留（轮⑫ 用户裁决）');
  assert.equal(posts.length, 0, '装载即零发布');
});

// ---------- 轮询信箱：since 增量 + 订阅回调 + start/stop ----------

test('pollOnce：GET /api/room/fireworks?since=N 增量投递 onFirework(payload)，since 前移到 seq', async () => {
  let serverSeq = 0;
  const { S, gets } = loadSocial({
    fetch: (url, init) => {
      const u = String(url);
      const channel = u.indexOf('fireworks') >= 0 ? 'fireworks' : 'likes';
      const since = Number((u.match(/since=(\d+)/) || [])[1] || 0);
      const items = [];
      if (channel === 'fireworks' && since === 0) {
        serverSeq = 3;
        for (let s = 1; s <= 3; s++) items.push({ seq: s, from: 'dev-x', to: '', payload: { stationId: 'room-' + s }, at: 1 });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, seq: serverSeq, items }) });
    }
  });
  const fired = [];
  const liked = [];
  const unFw = S.onFirework((p) => fired.push(p));
  const unLk = S.onLike((p) => liked.push(p));

  await S.pollOnce();
  assert.deepEqual(fired.map((p) => p.stationId), ['room-1', 'room-2', 'room-3'], '每条 firework 事件回调订阅者');
  assert.equal(liked.length, 0);
  assert.match(gets[0].url, /^http:\/\/127\.0\.0\.1:3000\/api\/room\/fireworks\?since=0$/);
  assert.match(gets[1].url, /\/api\/room\/likes\?since=0$/);

  await S.pollOnce();
  assert.match(gets[2].url, /fireworks\?since=3$/, 'since 必须前移到上一次的 seq（增量，不重复投递）');
  assert.equal(fired.length, 3, '无新事件不再回调');

  unFw(); unLk();
});

test('start/stop：默认 5000ms 轮询；stop 清 interval；重复 start 可重入不叠加', async () => {
  const { S, intervals } = loadSocial();
  S.start();
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, 5000, '控制方裁决：默认 5000ms（HearThere 20s 延迟无意义）');
  S.start(1234);
  assert.equal(intervals[0].cleared, true, '重复 start 必须先清旧 interval（可重入）');
  assert.equal(intervals.length, 2);
  assert.equal(intervals[1].ms, 1234);
  S.stop();
  assert.equal(intervals[1].cleared, true, 'stop 后 interval 必须清零');
  S.stop();
  assert.equal(S.running(), false);
  // 轮⑱：库存记账链退役后，轮询循环体只驱动 pollOnce（源码面锁死）
  assert.match(read('public/video/world-social.js'),
    /function \(\) \{ pollOnce\(\); \}/);
  assert.ok(!/checkProgress/.test(read('public/video/world-social.js')), 'checkProgress 应已整体退役');
});

test('轮询静默失败：fetch reject 不 throw、不打断订阅', async () => {
  const { S } = loadSocial({
    fetch: () => Promise.reject(new Error('network down'))
  });
  const fired = [];
  S.onFirework((p) => fired.push(p));
  const n = await S.pollOnce();
  assert.equal(n, 0);
  assert.equal(fired.length, 0);
});

// ---------- Fix round 1 · I-2：json 失败 / fetch 同步抛错也必须静默 ----------

test('pollOnce：200 响应但 r.json() reject → 静默 resolve(0)，since 不前移，无未处理拒绝', async () => {
  const { S, gets } = loadSocial({
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error('bad body')) })
  });
  const n = await S.pollOnce(); // 修复前：这里直接 reject（json 错误逃逸 then 第二参）
  assert.equal(n, 0, 'json 失败本轮投递 0 条');
  await S.pollOnce();
  assert.match(gets[2].url, /fireworks\?since=0$/, 'json 失败不得前移 since 游标');
});

test('pollOnce：fetch 同步 throw → pollOnce 仍 resolve(0) 静默', async () => {
  const { S } = loadSocial({
    fetch: () => { throw new Error('sync boom'); }
  });
  assert.equal(await S.pollOnce(), 0);
});

// ---------- 渲染面：粒子引擎移植 + UI 挂点（源码断言） ----------

test('world-social.js 粒子引擎移植自 world-actions.js:77-177（参数对齐 hearthere）', () => {
  const src = read('public/video/world-social.js');
  assert.match(src, /world-actions\.js:77-177/, '注释必须标注移植出处');
  assert.match(src, /60 \+ Math\.floor\(Math\.random\(\) \* 40\)/, '60~100 粒/发');
  assert.match(src, /globalCompositeOperation = 'lighter'/);
  assert.match(src, /vy \+= 0\.045/, '重力参数与旧引擎一致');
  assert.match(src, /vx \*= 0\.985/, '摩擦参数与旧引擎一致');
});

test('world-ui.js：轮⑱ 点火按钮 —— 选中灯塔即点；库存角标与「攒一发」toast 退役', () => {
  const src = read('public/video/world-ui.js');
  assert.match(src, /点火/, '「点火！」按钮');
  assert.match(src, /先选中一座灯塔/, '未选中门槛 toast 文案');
  assert.ok(!/先看完一部片攒一发/.test(src), '旧库存 toast 必须退役');
  assert.ok(!/setFireworkStock/.test(src), '库存徽章链必须退役');
  assert.ok(!/world-firework-count/.test(src), '×N 角标必须退役');
  assert.match(src, /SFV\.worldSocial/, 'world-ui 消费 worldSocial');
  assert.match(src, /setFireworkProjector/);
});

test('index.html SFV_SCRIPTS 注册 world-social.js 于 world-ui.js 之前，不破坏 m3 顺序', () => {
  const html = read('public/index.html');
  const iSocial = html.indexOf('"video/world-social.js"');
  const iUi = html.indexOf('"video/world-ui.js"');
  const iPw = html.indexOf('"video/page-world.js"');
  assert.ok(iSocial >= 0, 'world-social.js 必须列入 SFV_SCRIPTS');
  assert.ok(iSocial < iUi, '消费方是 world-ui → world-social 先于它');
  assert.ok(iUi < iPw, 'm3 顺序断言不受影响');
  assert.strictEqual((html.match(/video\/world-ui\.js/g) || []).length, 1);
  // Task 9 归档：旧 Cesium 时代渲染面已摘除
  assert.ok(!/video\/world-lighthouse\.js"/.test(html), 'world-lighthouse.js 应已归档摘除');
  assert.ok(!/video\/world-actions\.js"/.test(html), 'world-actions.js 应已归档摘除');
});

// ============================================================
//  服务端：world-room-api.js 全站广播频道
// ============================================================

const api = require(path.join(root, 'world-room-api.js'));

function call(method, pathname, body) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = {};
  const url = new URL('http://127.0.0.1:3000' + pathname);
  let captured = null;
  const sendJSON = (res, payload, status) => { captured = { payload, status: status || 200 }; };
  setImmediate(() => {
    if (method !== 'GET' && method !== 'HEAD' && body !== undefined) {
      req.emit('data', JSON.stringify(body));
    }
    req.emit('end');
  });
  return api.handle(req, {}, url, sendJSON).then(() => captured);
}

function resetChannels() {
  api._broadcast.fireworks.seq = 0;
  api._broadcast.fireworks.items.length = 0;
  api._broadcast.likes.seq = 0;
  api._broadcast.likes.items.length = 0;
}

test('服务端 fireworks 频道：POST 发布 seq 单调增，GET ?since 增量拉取（signal 信箱同形）', async () => {
  resetChannels();
  const a = await call('POST', '/api/room/fireworks', { deviceId: 'dev-A', payload: { stationId: 'room-1' } });
  assert.equal(a.status, 200);
  assert.equal(a.payload.ok, true);
  assert.equal(a.payload.seq, 1);
  const b = await call('POST', '/api/room/fireworks', { deviceId: 'dev-B', payload: { stationId: 'room-2' } });
  assert.equal(b.payload.seq, 2, 'seq 单调增');

  const all = await call('GET', '/api/room/fireworks?since=0');
  assert.equal(all.payload.seq, 2);
  assert.equal(all.payload.items.length, 2);
  const item = all.payload.items[0];
  assert.equal(item.from, 'dev-A', 'items 与 signal 信箱同形：{seq,from,to,payload,at}');
  assert.equal(item.to, '');
  assert.equal(item.payload.stationId, 'room-1');
  assert.equal(typeof item.at, 'number');

  const inc = await call('GET', '/api/room/fireworks?since=1');
  assert.equal(inc.payload.items.length, 1);
  assert.equal(inc.payload.items[0].seq, 2, 'since 增量只回新条目');
});

test('服务端 likes 频道独立计数；缺 deviceId 一律 400', async () => {
  resetChannels();
  const noDev = await call('POST', '/api/room/likes', { payload: {} });
  assert.equal(noDev.status, 400);
  assert.equal(noDev.payload.ok, false);

  await call('POST', '/api/room/likes', { deviceId: 'dev-C', payload: { stationId: 'room-3' } });
  const r = await call('GET', '/api/room/likes?since=0');
  assert.equal(r.payload.seq, 1, 'likes 频道独立 seq，不与 fireworks 串扰');
  assert.equal(r.payload.items[0].payload.stationId, 'room-3');
  const fw = await call('GET', '/api/room/fireworks?since=0');
  assert.equal(fw.payload.items.length, 0);
});

test('服务端环形缓冲上限 100：超量淘汰最旧，seq 不回退', async () => {
  resetChannels();
  for (let i = 1; i <= 105; i++) {
    await call('POST', '/api/room/fireworks', { deviceId: 'dev-' + i, payload: { stationId: 's' + i } });
  }
  const r = await call('GET', '/api/room/fireworks?since=0');
  assert.equal(r.payload.seq, 105, 'seq 恒为累计发布数');
  assert.equal(r.payload.items.length, 100, '保留上限 100 条');
  assert.equal(r.payload.items[0].seq, 6, '最旧 5 条已淘汰');
});

test('无碰撞论证：房间码恒 6 位（genCode），字面量 fireworks(9)/likes(5) 不可能撞码；频道不查房间', async () => {
  resetChannels();
  // genCode 恒 6 位、字母表不含 I/O/0/1 —— 长度 9/5 的字面量与任何房间码不相交
  for (let i = 0; i < 200; i++) {
    const c = api.genCode(6);
    assert.match(c, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  }
  assert.notEqual('FIREWORKS'.length, 6);
  assert.notEqual('LIKES'.length, 6);
  // 行为面：不存在任何房间时频道照常工作（未进 code 查找/限流/404 分支）
  assert.equal(api._rooms.size, 0);
  const r = await call('POST', '/api/room/fireworks', { deviceId: 'dev-D', payload: {} });
  assert.equal(r.status, 200, '频道分支必须先于 code 解析，不查房间表');
  const g = await call('GET', '/api/room/likes?since=0');
  assert.equal(g.payload.ok, true);
});

test('闭环：客户端 light() 驱动真实 handle → pollOnce() 收编为 onFirework 事件', async () => {
  resetChannels();
  const bridgedFetch = (url, init) => {
    const pathname = String(url).replace(/^https?:\/\/[^/]+/, '');
    return call(init && init.method === 'POST' ? 'POST' : 'GET', pathname,
      init && init.body ? JSON.parse(init.body) : undefined)
      .then((r) => ({
        ok: r.status === 200, status: r.status,
        json: () => Promise.resolve(r.payload)
      }));
  };
  const { S } = loadSocial({ fetch: bridgedFetch });   // 轮⑱：无限点火，无需预置库存
  const fired = [];
  S.onFirework((p) => fired.push(p));
  assert.equal(S.light('room-42'), true);
  await new Promise((r) => setImmediate(r));  // 等 fire-and-forget 的 POST 信箱落进 handle
  await S.pollOnce();
  assert.equal(fired.length, 1);
  assert.equal(fired[0].stationId, 'room-42', '广播回来的 payload 必须带 stationId');
  await S.pollOnce();
  assert.equal(fired.length, 1, '第二轮 since 前移，不重复收编');
  resetChannels();
});
