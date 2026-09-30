'use strict';

/**
 * 修复轮⑥ A4 — 演示与真实房间共存（merge 而非 replace）
 * 运行：node --test tests/world-room-a4-merge.test.js
 *
 * 旧语义：/api/rooms 只要返回 ≥1 个真实房间，deck.refreshStations 收到
 * 「纯真实列表」全量替换 → 10 座演示灯塔整体从地球上消失（用户感知
 * 「创建了灯塔，其他灯塔全没了」）。
 * 新语义（用户批准：merge、真实优先、按 id/roomId 去重）：
 *   真实房间在前 + 演示灯塔保留，共同渲染。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const REAL_ONE = {
  ok: true, count: 1, source: '本地房间信令',
  rooms: [{
    id: 'room-ABC123', roomId: 'ABC123', name: '济宁', lon: 116.59, lat: 35.41,
    status: 'playing', title: '你的名字', people: 1, playlist: null, lastHeartbeat: 0,
  }],
};

function setupWorldData(json, opts) {
  opts = opts || {};
  const ctx = vm.createContext({
    console, Promise, Object, Array, JSON, Math, Number, String, Error, RegExp, Date,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref && t.unref(); return t; },
    clearTimeout, AbortController: undefined,
  });
  ctx.window = ctx;
  ctx.StellaflixVideo = {};
  ctx.fetch = (url) => {
    if (opts.fail) return Promise.reject(new Error('ECONNREFUSED'));
    return Promise.resolve({
      ok: !!json.ok, status: json.ok ? 200 : 500,
      json: () => Promise.resolve(json),
    });
  };
  vm.runInContext(read('public/video/world-data.js'), ctx, { filename: 'world-data.js' });
  return ctx.StellaflixVideo.worldData;
}

test('A4-1：服务端有 1 个真实房间 → 真实在前 + 10 座演示灯塔共存（不再全量替换）', async () => {
  const wd = setupWorldData(REAL_ONE);
  const info = await wd.fetchRooms({ limit: 60 });
  assert.equal(info.degraded, false, '真实链路成功仍是非降级');
  assert.equal(info.rooms.length, 11, '1 真实 + 10 演示：' + info.rooms.length);
  assert.equal(info.rooms[0].id, 'room-ABC123', '真实房间排在前');
  assert.equal(info.count, 11);
  const demo = info.rooms.find((r) => r.id === 'r-sh');
  assert.ok(demo, '演示灯塔（上海）必须仍在');
  assert.ok(/本地房间信令/.test(info.source), '来源仍是本地房间信令：' + info.source);
});

test('A4-2：按 roomId 去重 —— 真实房间与演示同城同键时真实优先，不出现双塔', async () => {
  const json = { ok: true, rooms: [REAL_ONE.rooms[0], { id: 'room-sh', roomId: 'room-sh', name: '上海(真实)', lon: 121.5, lat: 31.2, status: 'playing', title: 'REAL', people: 2 }] };
  const wd = setupWorldData(json);
  const info = await wd.fetchRooms({});
  assert.equal(info.rooms.length, 2 + 9, '真实 2 + 演示 10 去掉被撞键的 r-sh：' + info.rooms.length);
  assert.ok(!info.rooms.find((r) => r.roomId === 'room-sh' && r.id === 'r-sh'), '演示上海灯塔被真实同 roomId 房间顶替');
  const realSh = info.rooms.find((r) => r.id === 'room-room-sh');
  assert.ok(realSh && realSh.title === 'REAL', '真实那份经 normalize 保留');
});

test('A4-3：/api/rooms 返回空列表 → 仍显示 10 座演示灯塔', async () => {
  const wd = setupWorldData({ ok: true, rooms: [] });
  const info = await wd.fetchRooms({});
  assert.equal(info.rooms.length, 10, '空真实列表 ≠ 空地球');
});

test('A4-4：请求失败 → 演示兜底 + degraded 语义保留（回归护栏）', async () => {
  const wd = setupWorldData(null, { fail: true });
  const info = await wd.fetchRooms({});
  assert.equal(info.degraded, true);
  assert.equal(info.rooms.length, 10);
  assert.ok(/演示房间/.test(info.source));
});

test('A4-5：limit 在 merge 之后生效', async () => {
  const wd = setupWorldData(REAL_ONE);
  const info = await wd.fetchRooms({ limit: 5 });
  assert.equal(info.rooms.length, 5);
  assert.equal(info.rooms[0].id, 'room-ABC123', '截断也保真实优先');
});
