'use strict';

/**
 * 轮㉔-C — 真实放映房「换片变色」链：海报 cover 端到端透传
 * 运行：node --test tests/world-poster-switch-color.test.js
 *
 * 链路：Host detectVideoChange → publishQueueUpdate(queue[0].cover)
 *   → 服务端 normalizeQueueUpdate/publicPlaylist 白名单放行 cover
 *   → GET /api/rooms → world-data.normalize 经 currentTrack 取当前轨 cover 作 coverUrl
 *   → deck applyPosterColor（轮㉔-B 已接）提色覆盖散列色。
 *
 * 语义源：HearThere main.pretty.js :2061-2094（色源=当前播放曲目 artwork）+
 *   :1924（换轨后把新 colorTop/colorBottom 批量写回 stations=数据回写，无额外动画）。
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
//  客户端：vm 沙箱加载真实 world-sync.js（复用 world-sync-progress 工装）
// ============================================================
function loadSync(opts) {
  opts = opts || {};
  const calls = [];
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    document: { querySelector: () => null },
    location: { origin: 'http://127.0.0.1:3000' },
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
    }
  };
  sandbox.window = sandbox;
  sandbox.global = sandbox;
  sandbox.StellaflixVideo = {
    lighthouse: null,
    player: opts.player || null,
    worldRoom: opts.worldRoom || null
  };
  vm.createContext(sandbox);
  vm.runInContext(read('public/video/world-sync.js'), sandbox);
  return { S: sandbox.StellaflixVideo.worldSync, sandbox, calls };
}

const HOST_SESSION = { code: 'ABC123', role: 'host', deviceId: 'dev-host-1' };

function playerStub(initial) {
  const state = {
    url: initial.url,
    duration: initial.duration === undefined ? 5400 : initial.duration,
    meta: initial.meta || {}
  };
  return {
    state,
    getVideoEl: () => ({ get currentSrc() { return state.url; }, duration: state.duration }),
    getMeta: () => state.meta
  };
}

// ---------- currentTrack：cover 透传 ----------

test('currentTrack：返回体补 cover 字段（有则透传、无则空串）', () => {
  const { S } = loadSync();
  const room = {
    playlist: {
      queue: [
        { title: 'A', duration_ms: 60000, cover: 'https://img/a.jpg' },
        { title: 'B', duration_ms: 90000 }
      ],
      current_position: 0,
      start_time: 1000
    }
  };
  assert.equal(S.currentTrack(room, 2000).cover, 'https://img/a.jpg');
  assert.equal(S.currentTrack({ ...room, playlist: { ...room.playlist, current_position: 1 } }, 2000).cover, '', '无 cover 轨 → 空串不造值');
});

// ---------- detectVideoChange：首拍基线 + 换片各发一次 queue-update ----------

test('detectVideoChange：首拍立即发布 now-playing（queue 单元素含 title/duration_ms/cover，position 0）', async () => {
  const stub = playerStub({ url: 'file:///a.mp4', duration: 5400, meta: { title: '影片A', cover: 'https://img/a.jpg' } });
  const { S, calls } = loadSync({ worldRoom: { session: HOST_SESSION }, player: stub });
  S.detectVideoChange();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 1, '首拍应发布一次');
  assert.equal(calls[0].url, 'http://127.0.0.1:3000/api/room/ABC123/queue-update');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.type, 'queue_update');
  assert.equal(body.current_position, 0);
  assert.equal(typeof body.start_time, 'number');
  assert.ok(body.start_time > 0);
  assert.equal(body.queue.length, 1);
  assert.equal(body.queue[0].title, '影片A');
  assert.equal(body.queue[0].duration_ms, 5400000, 'duration 秒 → duration_ms');
  assert.equal(body.queue[0].cover, 'https://img/a.jpg');
});

test('detectVideoChange：同一 URL 反复检测不重发；换片后再发一次且 cover 随 meta 更新', async () => {
  const stub = playerStub({ url: 'file:///a.mp4', duration: 5400, meta: { title: '影片A', cover: 'https://img/a.jpg' } });
  const { S, calls } = loadSync({ worldRoom: { session: HOST_SESSION }, player: stub });
  S.detectVideoChange();
  S.detectVideoChange();
  S.detectVideoChange();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 1, '同 URL 只发一次');
  stub.state.url = 'file:///b.mp4';
  stub.state.meta = { title: '影片B', cover: 'https://img/b.jpg' };
  stub.state.duration = 7200;
  S.detectVideoChange();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 2, '换片后再发一次');
  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.queue[0].cover, 'https://img/b.jpg');
  assert.equal(body.queue[0].title, '影片B');
  assert.equal(body.queue[0].duration_ms, 7200000);
});

test('detectVideoChange：meta 无 cover 时发布空 cover 不造值；reset() 后重拍基线再发', async () => {
  const stub = playerStub({ url: 'file:///a.mp4', meta: { title: '无图片' } });
  const { S, calls } = loadSync({ worldRoom: { session: HOST_SESSION }, player: stub });
  S.detectVideoChange();
  await new Promise((r) => setImmediate(r));
  assert.equal(JSON.parse(calls[0].init.body).queue[0].cover, '');
  stub.state.url = '';
  S.detectVideoChange();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 1, '空 currentSrc 不触发发布');
  stub.state.url = 'file:///a.mp4';
  S.detectVideoChange();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 1, 'URL 回到已发布值不重发');
  S.reset();
  stub.state.url = '';
  S.detectVideoChange();
  stub.state.url = 'file:///c.mp4';
  S.detectVideoChange();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 2, 'reset() 清发布门 → 重拍基线再发');
});

// ============================================================
//  服务端：queue-update 白名单放行 cover（走 handle 功能面）
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

test('服务端 queue-update：cover 落库且 GET /api/rooms 透传；无 cover 轨不多键；超长截断 300；url 仍不落库', async () => {
  const code = await createRoom('host-PC1');
  const longCover = 'https://img/cover-' + 'x'.repeat(400) + '.jpg';
  await call('POST', '/api/room/' + code + '/queue-update', {
    deviceId: 'host-PC1',
    type: 'queue_update',
    queue: [
      { title: 'A', duration_ms: 60000, cover: 'https://img/a.jpg', url: 'file:///secret.mp4' },
      { title: 'B', duration_ms: 90000 },
      { title: 'C', duration_ms: 1000, cover: longCover }
    ],
    current_position: 0,
    start_time: 555
  });
  const stored = api._rooms.get(code).playlist;
  assert.deepEqual(stored.queue[0], { title: 'A', duration_ms: 60000, cover: 'https://img/a.jpg' }, 'cover 公开、url 内部字段仍不落库');
  assert.deepEqual(stored.queue[1], { title: 'B', duration_ms: 90000 }, '无 cover 轨不造空键');
  assert.equal(stored.queue[2].cover.length, 300, '超长 cover 截断 300');
  assert.ok(stored.queue[2].cover.startsWith('https://img/cover-'));

  const list = await call('GET', '/api/rooms');
  const item = findRoom(list.payload, code);
  assert.equal(item.playlist.queue[0].cover, 'https://img/a.jpg', '公开列表透传 cover');
  assert.equal(item.playlist.queue[1].cover, undefined);
  assert.equal(item.playlist.queue[2].cover.length, 300);
  api._rooms.delete(code);
});

// ============================================================
//  world-data.normalize：当前轨 cover → room.coverUrl
// ============================================================
function loadDataRealm() {
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    document: { querySelector: () => null },
    location: { origin: 'http://127.0.0.1:3000' },
    fetch: undefined
  };
  sandbox.window = sandbox;
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('public/video/world-sync.js'), sandbox);
  vm.runInContext(read('public/video/world-data.js'), sandbox);
  return { D: sandbox.StellaflixVideo.worldData, sandbox };
}

test('normalize：playlist 当前轨 cover 落为 coverUrl（换片=换 current_position 即换色源）', () => {
  const { D } = loadDataRealm();
  const now = Date.now();
  const r = {
    roomId: 'r9', name: '济宁', lon: 116.59, lat: 35.41, status: 'playing',
    playlist: {
      type: 'queue_update',
      queue: [
        { title: 'A', duration_ms: 60000, cover: 'https://img/a.jpg' },
        { title: 'B', duration_ms: 90000, cover: 'https://img/b.jpg' }
      ],
      current_position: 1,
      start_time: now - 65000
    }
  };
  assert.equal(D.normalize(r).coverUrl, 'https://img/b.jpg');
  const back = D.normalize({ ...r, playlist: { ...r.playlist, current_position: 0 } });
  assert.equal(back.coverUrl, 'https://img/a.jpg');
});

test('normalize：无 playlist / 当前轨无 cover → coverUrl 不造值（falsy）', () => {
  const { D } = loadDataRealm();
  const base = { roomId: 'r8', name: '城', lon: 1, lat: 2, status: 'online' };
  assert.ok(!D.normalize(base).coverUrl, '无 playlist');
  const noCover = {
    ...base,
    playlist: { type: 'queue_update', queue: [{ title: 'A', duration_ms: 1 }], current_position: 0, start_time: Date.now() }
  };
  assert.ok(!D.normalize(noCover).coverUrl, '当前轨无 cover');
});
