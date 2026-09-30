'use strict';

/**
 * 修复轮⑦ — 房间码双源分裂（acceptance E2E 发现的根因）
 * 运行：node --test tests/world-room-code-source.test.js
 *
 * 根因：edge-local createRoom 把客户端生成的 code 发给服务端，
 * 但服务端 POST /api/room 恒忽略 body.code、自生成 6 位码（world-room-api.js:251）。
 * RoomSession.createAsHost 成功后把「客户端自生码」赋给 self.code ——
 * 于是会话挂着一个服务端不存在的码：signal/heartbeat/close/join 全 404，
 * 灯塔却能出现在 /api/rooms（用服务端的码）。
 * 「还是不能创建房间」的全部症状由此而来。
 *
 * 修法：createAsHost 采用服务端响应里的码（res.code），客户端码仅作生成兜底。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function loadRoom(createRoomImpl) {
  const SFV = {};
  const LH = {};
  LH.edge = { createRoom: createRoomImpl };
  const sandbox = {
    console,
    crypto: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); return a; } },
    require,
    Promise,
    Object,
    Math,
    Uint8Array,
    RegExp,
    String,
    Number,
    Array,
    JSON
  };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  // 直接构造 global=window-like：把 SFV 预置进去
  sandbox.StellaflixVideo = SFV;
  SFV.lighthouse = LH;
  const src = read('public/video/lighthouse/room.js');
  // room.js 的 IIFE 参数是 `typeof window !== 'undefined' ? window : this`；
  // 在 vm 里 this=沙箱本身，window 未定义 → global 即沙箱，SFV 已预置
  vm.runInContext(src, ctx, { filename: 'room.js' });
  return LH.room;
}

test('C-1 RED：createAsHost 采用服务端返回的房间码（服务端忽略客户端码）', async () => {
  let sentCode = null;
  const SERVER_CODE = 'SRV42X';
  const room = loadRoom(function (code, meta) {
    sentCode = code;
    return Promise.resolve({ ok: true, code: SERVER_CODE, exists: true });
  });
  const s = new room.RoomSession();
  await s.createAsHost({ discovery: true, title: 'T', name: 'N', lon: 1, lat: 2 });
  assert.ok(sentCode, 'createRoom 应被调用');
  assert.strictEqual(s.code, SERVER_CODE,
    '会话码必须是服务端响应码，否则后续 signal/close 全打在不存在的客户端码上');
});

test('C-2：服务端响应缺 code 时回退客户端自生码（旧 edge 面兼容）', async () => {
  let sentCode = null;
  const room = loadRoom(function (code) {
    sentCode = code;
    return Promise.resolve({ ok: true });
  });
  const s = new room.RoomSession();
  await s.createAsHost(true);
  assert.strictEqual(s.code, sentCode, '无 res.code 时应保留客户端生成码');
  assert.ok(room.isValidRoomCode(s.code), '回退码必须是合法 6 位码');
});

test('C-3：事件 active 携带的 code 与服务端一致', async () => {
  const SERVER_CODE = 'EVT7Q';
  const room = loadRoom(() => Promise.resolve({ ok: true, code: SERVER_CODE }));
  const s = new room.RoomSession();
  const evt = [];
  s.on((e) => evt.push(e));
  await s.createAsHost({ discovery: true });
  const active = evt.find((e) => e.status === 'active');
  assert.ok(active, '应发出 active 事件');
  assert.strictEqual(active.code, SERVER_CODE, 'active 事件码应为服务端码');
});

test('C-4：world-room 建房 toast 用会话码（回归防串）', () => {
  const src = read('public/video/world-room.js');
  // toast 与 startMemberPolling 均引用 roomSession.code —— 会话码修正后自动跟对；
  // 此处只钉住「不得再引用客户端自生码」的模式不存在
  assert.ok(!/generateRoomCode/.test(src), 'world-room 不得自生成房间码绕开会话码');
});
