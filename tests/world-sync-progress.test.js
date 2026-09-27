'use strict';

/**
 * 世界页 Task 7 — 实时进度同步（queue_update 语义 + 本地推算播放位置）
 * 运行：node --test tests/world-sync-progress.test.js
 *
 * 客户端：vm 沙箱加载真实 public/video/world-sync.js，断言纯函数
 *   currentTrack / inferStatus 与发送面 publishQueueUpdate / publishHeartbeat。
 * 服务端：直接 require world-room-api.js，用假 req（EventEmitter）驱动
 *   handle，断言 queue-update / heartbeat 的鉴权、存储与 GET /api/rooms 精简透传。
 *
 * 语义源：HearThere main.pretty.js :14490-14510（queue_update 载荷 + status 推断）。
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
//  客户端：vm 沙箱加载真实 world-sync.js
// ============================================================
function loadSync(opts) {
  opts = opts || {};
  const calls = [];
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    document: { querySelector: () => null },
    location: opts.location === undefined
      ? { origin: 'http://127.0.0.1:3000' }
      : opts.location,
    fetch: opts.fetch === undefined
      ? (url, init) => {
          calls.push({ url, init });
          return Promise.resolve(opts.fetchResponse || { ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
        }
      : opts.fetch
  };
  sandbox.window = sandbox;
  sandbox.global = sandbox;
  sandbox.StellaflixVideo = {
    lighthouse: null,
    player: null,
    worldRoom: opts.worldRoom || null
  };
  vm.createContext(sandbox);
  vm.runInContext(read('public/video/world-sync.js'), sandbox);
  return { S: sandbox.StellaflixVideo.worldSync, sandbox, calls };
}

const HOST_SESSION = { code: 'ABC123', role: 'host', deviceId: 'dev-host-1' };

// ---------- currentTrack：本地推算播放位置 ----------

test('currentTrack：start_time 为播放列表起点，elapsed = now - start_time - 前置曲目时长和', () => {
  const { S } = loadSync();
  const room = {
    queue: [{ title: 'A', duration_ms: 60000 }, { title: 'B', duration_ms: 90000 }],
    current_position: 1,
    start_time: 1000
  };
  const cur = S.currentTrack(room, 1000 + 60000 + 5000);
  assert.equal(cur.index, 1);
  assert.equal(cur.title, 'B');
  assert.equal(cur.elapsedMs, 5000);
});

test('currentTrack：第一轨（无前置时长）直接 now - start_time', () => {
  const { S } = loadSync();
  const room = {
    queue: [{ title: 'A', duration_ms: 60000 }, { title: 'B', duration_ms: 90000 }],
    current_position: 0,
    start_time: 1000
  };
  const cur = S.currentTrack(room, 1000 + 1234);
  assert.equal(cur.index, 0);
  assert.equal(cur.title, 'A');
  assert.equal(cur.elapsedMs, 1234);
});

test('currentTrack：钳制 —— now 早于当前轨起点 → 0；超过当前轨时长 → duration', () => {
  const { S } = loadSync();
  const room = {
    queue: [{ title: 'A', duration_ms: 60000 }, { title: 'B', duration_ms: 90000 }],
    current_position: 1,
    start_time: 1000
  };
  // now 在列表起点之前
  assert.equal(S.currentTrack(room, 500).elapsedMs, 0);
  // now 在 track0 播完之前（elapsed 为负）
  assert.equal(S.currentTrack(room, 1000 + 30000).elapsedMs, 0);
  // now 远超当前轨末尾 → clamp 到 90000
  assert.equal(S.currentTrack(room, 1000 + 60000 + 999999).elapsedMs, 90000);
});

test('currentTrack：缺 queue / current_position / start_time → null；越界 position → null', () => {
  const { S } = loadSync();
  assert.equal(S.currentTrack(null, 5000), null);
  assert.equal(S.currentTrack({}, 5000), null);
  assert.equal(S.currentTrack({ current_position: 0, start_time: 0 }, 5000), null, '缺 queue');
  assert.equal(S.currentTrack({ queue: [], current_position: 0, start_time: 0 }, 5000), null, '空 queue');
  assert.equal(S.currentTrack({ queue: [{ duration_ms: 1 }] , start_time: 0 }, 5000), null, '缺 current_position');
  assert.equal(
    S.currentTrack({ queue: [{ duration_ms: 1 }], current_position: null, start_time: 0 }, 5000),
    null, 'current_position=null（queue_reorder 空闲态）'
  );
  assert.equal(S.currentTrack({ queue: [{ duration_ms: 1 }], current_position: 3, start_time: 0 }, 5000), null, '越界');
  assert.equal(S.currentTrack({ queue: [{ duration_ms: 1 }], current_position: 0 }, 5000), null, '缺 start_time');
});

test('currentTrack：room.playlist 嵌套面（GET /api/rooms 透传形状）同样可用', () => {
  const { S } = loadSync();
  const room = {
    playlist: {
      queue: [{ title: 'A', duration_ms: 60000 }, { title: 'B', duration_ms: 90000 }],
      current_position: 1,
      start_time: 1000
    }
  };
  const cur = S.currentTrack(room, 1000 + 60000 + 5000);
  assert.equal(cur.index, 1);
  assert.equal(cur.elapsedMs, 5000);
});

// ---------- inferStatus：四类事件 ----------

test('inferStatus：playlist_replaced/playlist_completed/broadcast_ended → idle', () => {
  const { S } = loadSync();
  assert.equal(S.inferStatus({ type: 'playlist_replaced', current_position: 0 }), 'idle');
  assert.equal(S.inferStatus({ type: 'playlist_completed' }), 'idle');
  assert.equal(S.inferStatus({ type: 'broadcast_ended' }), 'idle');
});

test('inferStatus：queue_reorder 仅在 current_position==null 时 idle；queue_update 默认 playing', () => {
  const { S } = loadSync();
  assert.equal(S.inferStatus({ type: 'queue_reorder', current_position: null }), 'idle');
  assert.equal(S.inferStatus({ type: 'queue_reorder', current_position: 2 }), 'playing');
  assert.equal(S.inferStatus({ type: 'queue_update', current_position: 0 }), 'playing');
  assert.equal(S.inferStatus({}), 'playing', '无 type 走默认 playing（对齐 HearThere ?? 兜底）');
});

// ---------- publishQueueUpdate / publishHeartbeat：fetch 形状 + 静默失败 ----------

test('publishQueueUpdate：POST /api/room/:code/queue-update，载荷含 type/queue/current_position/start_time/host_sent_at/deviceId', async () => {
  const { S, calls } = loadSync({ worldRoom: { session: HOST_SESSION } });
  const ok = await S.publishQueueUpdate({
    type: 'queue_update',
    queue: [{ title: 'A', duration_ms: 60000 }],
    current_position: 0,
    start_time: 12345
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:3000/api/room/ABC123/queue-update');
  assert.equal(calls[0].init.method, 'POST');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.deviceId, 'dev-host-1');
  assert.equal(body.type, 'queue_update');
  assert.deepEqual(body.queue, [{ title: 'A', duration_ms: 60000 }]);
  assert.equal(body.current_position, 0);
  assert.equal(body.start_time, 12345);
  assert.equal(typeof body.host_sent_at, 'number');
  assert.equal(ok, true);
});

test('publishHeartbeat：POST /api/room/:code/heartbeat 带 deviceId', async () => {
  const { S, calls } = loadSync({ worldRoom: { session: HOST_SESSION } });
  const ok = await S.publishHeartbeat();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:3000/api/room/ABC123/heartbeat');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(JSON.parse(calls[0].init.body).deviceId, 'dev-host-1');
  assert.equal(ok, true);
});

test('发送面静默失败：403/网络异常/无 fetch/无房间码一律 resolve(false)，绝不 throw', async () => {
  const forbidden = loadSync({
    worldRoom: { session: HOST_SESSION },
    fetchResponse: { ok: false, status: 403 }
  });
  assert.equal(await forbidden.S.publishQueueUpdate({ type: 'queue_update', queue: [], current_position: 0, start_time: 0 }), false);
  assert.equal(await forbidden.S.publishHeartbeat(), false);

  const rejecting = loadSync({
    worldRoom: { session: HOST_SESSION },
    fetch: () => Promise.reject(new Error('network down'))
  });
  assert.equal(await rejecting.S.publishHeartbeat(), false);

  const noFetch = loadSync({ worldRoom: { session: HOST_SESSION }, fetch: undefined, location: null });
  noFetch.sandbox.fetch = undefined;
  assert.equal(await noFetch.S.publishHeartbeat(), false);

  const noRoom = loadSync({ worldRoom: null });
  assert.equal(await noRoom.S.publishQueueUpdate({ type: 'queue_update' }), false);
  assert.equal(noRoom.calls.length, 0, '无房间码时不发请求');
});

// ---------- world-data.normalize：playlist 透传（fetchRooms 消费面） ----------

test('world-data.normalize 透传 playlist/lastHeartbeat，status 面不回退', () => {
  const sandbox = { console, setTimeout, clearTimeout, fetch: undefined };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('public/video/world-data.js'), sandbox);
  const D = sandbox.StellaflixVideo.worldData;
  const playlist = { type: 'queue_update', current_position: 1, start_time: 1000, queue: [{ title: 'B', duration_ms: 90000 }] };
  const n = D.normalize({
    roomId: 'r1', name: '上海', lon: 1, lat: 2, status: 'idle',
    title: 'X', people: 1, playlist, lastHeartbeat: 777
  });
  assert.deepEqual(n.playlist, playlist, 'normalize 不得丢弃 playlist');
  assert.equal(n.lastHeartbeat, 777);
  assert.ok(['playing', 'online', 'idle'].indexOf(n.status) >= 0, 'status 仍是已知枚举');
});

// ============================================================
//  服务端：直接 require world-room-api.js，假 req/res 驱动 handle
// ============================================================
const api = require(path.join(root, 'world-room-api.js'));

function call(method, pathname, body, headers) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers || {};
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

async function createRoom(deviceId) {
  const r = await call('POST', '/api/room', { deviceId, discovery: true, title: '一起看' });
  assert.equal(r.status, 200);
  return r.payload.code;
}

function findRoom(listPayload, code) {
  return (listPayload.rooms || []).find((x) => x.roomId === code);
}

test('服务端 queue-update：host 通过、guest/缺 deviceId 一律 403；playlist 落库带 received_at 且队列精简', async () => {
  const code = await createRoom('host-A');
  const guest = await call('POST', '/api/room/' + code + '/queue-update', {
    deviceId: 'guest-X', type: 'queue_update', queue: [], current_position: 0, start_time: 1
  });
  assert.equal(guest.status, 403);
  assert.equal(guest.payload.ok, false);

  const anon = await call('POST', '/api/room/' + code + '/queue-update', {
    type: 'queue_update', queue: [], current_position: 0, start_time: 1
  });
  assert.equal(anon.status, 403, '缺 deviceId 也视为非 host');

  const host = await call('POST', '/api/room/' + code + '/queue-update', {
    deviceId: 'host-A',
    type: 'queue_update',
    queue: [{ title: 'A', duration_ms: 60000, url: 'file:///secret.mp4' }],
    current_position: 0,
    start_time: 555,
    host_sent_at: 999
  }, { 'x-device-id': 'host-A' });
  assert.equal(host.status, 200);
  assert.equal(host.payload.ok, true);

  const stored = api._rooms.get(code).playlist;
  assert.equal(stored.type, 'queue_update');
  assert.equal(stored.start_time, 555);
  assert.equal(stored.current_position, 0);
  assert.equal(stored.host_sent_at, 999);
  assert.equal(typeof stored.received_at, 'number');
  assert.deepEqual(stored.queue, [{ title: 'A', duration_ms: 60000 }], '服务端归一化：url 等内部字段不落库');
  api._rooms.delete(code);
});

test('服务端 heartbeat：host 通过且只动 lastHeartbeat；guest 403', async () => {
  const code = await createRoom('host-B');
  await call('POST', '/api/room/' + code + '/queue-update', {
    deviceId: 'host-B', type: 'queue_update',
    queue: [{ title: 'A', duration_ms: 60000 }], current_position: 0, start_time: 111
  });
  const before = JSON.parse(JSON.stringify(api._rooms.get(code).playlist));

  const guest = await call('POST', '/api/room/' + code + '/heartbeat', { deviceId: 'intruder' });
  assert.equal(guest.status, 403);

  const ok = await call('POST', '/api/room/' + code + '/heartbeat', { deviceId: 'host-B' });
  assert.equal(ok.status, 200);
  assert.equal(ok.payload.ok, true);
  assert.equal(typeof api._rooms.get(code).lastHeartbeat, 'number');
  assert.ok(api._rooms.get(code).lastHeartbeat >= before.received_at);
  assert.deepEqual(api._rooms.get(code).playlist, before, 'heartbeat 不回退 playlist');
  api._rooms.delete(code);
});

test('GET /api/rooms：透传 playlist 精简面 + lastHeartbeat，status 沿用推断不回退', async () => {
  const codeQuiet = await createRoom('host-Q');
  const code = await createRoom('host-C');

  let list = await call('GET', '/api/rooms');
  assert.equal(findRoom(list.payload, codeQuiet).status, 'playing', '无 playlist：open→playing 原逻辑保留');
  assert.equal(findRoom(list.payload, code).playlist, null, '未广播过 → playlist 为 null');

  await call('POST', '/api/room/' + code + '/queue-update', {
    deviceId: 'host-C', type: 'queue_update',
    queue: [{ title: 'A', duration_ms: 60000, url: 's' }, { title: 'B', duration_ms: 90000 }],
    current_position: 1, start_time: 1000, host_sent_at: 1001
  });
  await call('POST', '/api/room/' + code + '/heartbeat', { deviceId: 'host-C' });

  list = await call('GET', '/api/rooms');
  const item = findRoom(list.payload, code);
  assert.equal(item.status, 'playing', '进行中的 queue_update → playing');
  assert.deepEqual(item.playlist.queue, [{ title: 'A', duration_ms: 60000 }, { title: 'B', duration_ms: 90000 }], '列表只回 {title,duration_ms}');
  assert.equal(item.playlist.current_position, 1);
  assert.equal(item.playlist.start_time, 1000);
  assert.equal(typeof item.lastHeartbeat, 'number');

  // 终态事件 → idle
  await call('POST', '/api/room/' + code + '/queue-update', {
    deviceId: 'host-C', type: 'broadcast_ended', queue: [], current_position: null, start_time: 1000
  });
  list = await call('GET', '/api/rooms');
  assert.equal(findRoom(list.payload, code).status, 'idle', 'broadcast_ended → idle');

  await call('POST', '/api/room/' + code + '/queue-update', {
    deviceId: 'host-C', type: 'playlist_completed', queue: [], current_position: null, start_time: 1000
  });
  list = await call('GET', '/api/rooms');
  assert.equal(findRoom(list.payload, code).status, 'idle', 'playlist_completed → idle');

  // queue_reorder：current_position==null → idle；有 position → playing
  await call('POST', '/api/room/' + code + '/queue-update', {
    deviceId: 'host-C', type: 'queue_reorder', queue: [{ title: 'A', duration_ms: 60000 }], current_position: null, start_time: 1000
  });
  list = await call('GET', '/api/rooms');
  assert.equal(findRoom(list.payload, code).status, 'idle', 'queue_reorder 且无 position → idle');

  await call('POST', '/api/room/' + code + '/queue-update', {
    deviceId: 'host-C', type: 'queue_reorder', queue: [{ title: 'A', duration_ms: 60000 }], current_position: 0, start_time: 2000
  });
  list = await call('GET', '/api/rooms');
  assert.equal(findRoom(list.payload, code).status, 'playing', 'queue_reorder 带 position → playing');

  api._rooms.delete(code);
  api._rooms.delete(codeQuiet);
});

test('客户端公式与服务端存储闭环：publishQueueUpdate → room.playlist → currentTrack', async () => {
  const code = await createRoom('host-D');
  // fetch 桩桥接到真实 handle：客户端发的 POST 直接驱动服务端模块
  const bridgedFetch = (url, init) => {
    const pathname = String(url).replace(/^https?:\/\/[^/]+/, '');
    return call('POST', pathname, JSON.parse(init.body)).then((r) => ({ ok: r.status === 200, status: r.status }));
  };
  const { S } = loadSync({
    location: { origin: 'http://127.0.0.1:3000' },
    fetch: bridgedFetch,
    worldRoom: { session: { code, role: 'host', deviceId: 'host-D' } }
  });
  const ok = await S.publishQueueUpdate({
    type: 'queue_update',
    queue: [{ title: 'A', duration_ms: 60000 }, { title: 'B', duration_ms: 90000, url: 'file:///b.mp4' }],
    current_position: 1,
    start_time: 1000
  });
  assert.equal(ok, true, '客户端应能真实驱动本地 API 面（同 handle 契约）');
  const list = await call('GET', '/api/rooms');
  const item = findRoom(list.payload, code);
  const cur = S.currentTrack(item, 1000 + 60000 + 5000);
  assert.equal(cur.index, 1);
  assert.equal(cur.elapsedMs, 5000);
  assert.equal(cur.title, 'B');
  api._rooms.delete(code);
});
