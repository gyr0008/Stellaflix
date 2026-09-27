'use strict';

/**
 * 世界页 M5 — 一起看房间（本地信令 + WebRTC 接线）
 * 运行：node --test tests/world-room-m5.test.js
 *
 * 覆盖：服务端房间生命周期 / 信令信箱 / 客户端 edge 契约 / 房间编排 / 加载链
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('server.js 挂了 /api/rooms 与 /api/room/*', () => {
  const src = read('server.js');
  assert.match(src, /require\('\.\/world-room-api'\)/);
  assert.match(src, /pn === '\/api\/rooms'/);
  assert.match(src, /pn\.startsWith\('\/api\/room'\)/);
  assert.match(src, /worldRoomApi\.handle/);
});

test('world-room-api：创建 / 加入 / 审批 / 信令 全链路', async () => {
  const api = require(path.join(root, 'world-room-api.js'));
  const mk = () => ({ _c: 200, _b: null, writeHead(c) { this._c = c; }, end(b) { this._b = b ? JSON.parse(b) : null; } });
  const doCall = async (method, pathname, body, q) => {
    const res = mk();
    const url = new URL('http://127.0.0.1' + pathname + (q || ''));
    const req = { method, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    // 模拟 Node 流：先 data 后 end
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

  // 创建
  const created = await doCall('POST', '/api/room', { deviceId: 'host-1', nickname: '主播', title: '《星际穿越》', lon: 121, lat: 31 });
  assert.strictEqual(created.status, 200);
  assert.strictEqual(created.body.exists, true);
  assert.strictEqual(created.body.role, undefined);
  const code = created.body.code;
  assert.ok(code && code.length === 6, '房间码应为 6 位');

  // 加入（pending）
  const joined = await doCall('POST', '/api/room/' + code + '/join', { deviceId: 'guest-1', nickname: '阿May' });
  assert.strictEqual(joined.status, 200);
  const g = joined.body.guests.find((x) => x.deviceId === 'guest-1');
  assert.strictEqual(g.status, 'pending');

  // 审批
  const accepted = await doCall('POST', '/api/room/' + code + '/accept', { guestId: 'guest-1' });
  assert.strictEqual(accepted.body.guests.find((x) => x.deviceId === 'guest-1').status, 'accepted');

  // 信令投递 + 拉取
  const sig = await doCall('POST', '/api/room/' + code + '/signal', { from: 'guest-1', to: 'host-1', payload: { kind: 'offer', sdp: 'x' } });
  assert.strictEqual(sig.status, 200);
  const pulled = await doCall('GET', '/api/room/' + code + '/signal?deviceId=host-1&since=0');
  assert.ok(pulled.body.items.length >= 1);
  assert.strictEqual(pulled.body.items[pulled.body.items.length - 1].payload.kind, 'offer');

  // 房间列表（地图用）：只暴露 discovery 的房间，且不带 IP
  const list = await doCall('GET', '/api/rooms');
  assert.strictEqual(list.status, 200);
  assert.ok(list.body.rooms.length >= 1);
  const r0 = list.body.rooms[0];
  assert.ok(r0.roomId && r0.title, '应有 roomId/title');
  assert.ok(!('ip' in r0) && !('deviceId' in r0), '列表不得泄露 IP / deviceId');

  // B3：结束放映 —— Host 关闭房间
  const closed = await doCall('POST', '/api/room/' + code + '/close', { deviceId: 'host-1' });
  assert.strictEqual(closed.status, 200);
  assert.strictEqual(closed.body.closed, true);
  // 关闭后房间不存在
  const gone = await doCall('GET', '/api/room/' + code);
  assert.strictEqual(gone.status, 404);
  // 地图列表里也没了
  const list2 = await doCall('GET', '/api/rooms');
  assert.ok(!list2.body.rooms.find((x) => x.roomId === code), '关闭后不应出现在地图列表');
});

test('房间信令绝不暴露 IP / 位置精度', () => {
  const src = read('world-room-api.js');
  // 房间接口不得读取/转发 IP（与此前安全修正一致）
  assert.ok(!/x-forwarded-for/i.test(src), '房间接口不得读取 x-forwarded-for');
  assert.ok(!/remoteAddress/.test(src), '房间接口不得读取 remoteAddress');
  // publicShape 只输出白名单字段
  assert.match(src, /function publicShape/);
  assert.match(src, /isMe: r\.hostDeviceId === viewerDeviceId/);
  // 响应里只能出现这些字段
  assert.match(src, /host: \{ nickname: r\.hostNickname, isMe:/);
  assert.match(src, /guests: r\.guests\.map/);
});

test('edge-local.js 满足 LH.edge 契约（room.js / webrtc.js 零改动可用）', () => {
  const src = read('public/video/lighthouse/edge-local.js');
  for (const fn of ['createRoom', 'getRoom', 'requestJoin', 'hostAccept', 'hostReject',
                    'openSignal', 'closeSignal', 'getBeacons', 'writeBeacon', 'removeBeacon', 'removeRoom']) {
    assert.ok(new RegExp(fn).test(src), `LH.edge 应提供 ${fn}`);
  }
  // 伪装 WebSocket 的形状（对象字面量写法：readyState: 1, send: fn, close: fn）
  assert.match(src, /readyState: 1/);
  assert.match(src, /send: function \(payload\)/);
  assert.match(src, /close: function \(\)/);
  // 只打本机
  assert.match(src, /127\.0\.0\.1|location\.origin/);
  // 不用 Cloudflare / Turnstile
  assert.ok(!/turnstile/i.test(src), '本地信令不需要 Turnstile');
});

test('world-room.js 编排：进入失败自动改当主播', () => {
  const src = read('public/video/world-room.js');
  assert.match(src, /joinAsGuest/);
  assert.match(src, /createAsHost/);
  assert.match(src, /RtcSession/);
  assert.match(src, /showRoomPanel/);
  assert.match(src, /joinWatchRoom/);
  assert.match(src, /leave/);
  // 安全边界
  assert.ok(!/x-forwarded-for|remoteAddress/.test(src), '不得采集 IP');
});

test('A 段：createHost 主动创建放映（discovery 字段 + 自动 startBroadcast）', () => {
  const src = read('public/video/world-room.js');
  // A3：createHost 入口
  assert.match(src, /function createHost/);
  assert.match(src, /createHost: createHost/);
  // A4：discovery 字段接线
  assert.match(src, /discovery: opts\.discovery !== false/);
  assert.match(src, /title: opts\.title/);
  assert.match(src, /name: opts\.name/);
  assert.match(src, /lon: Number\(opts\.lon\)/);
  assert.match(src, /lat: Number\(opts\.lat\)/);
  // A5：建完自动 startBroadcast
  assert.match(src, /startRtc\(\)/);
  assert.match(src, /startBroadcast/);
  // 面板挂载点
  assert.match(src, /openPanel\(\)/);
});

test('A 段：edge-local createRoom 支持元数据（title/name/lon/lat/discovery）', () => {
  const src = read('public/video/lighthouse/edge-local.js');
  // 兼容 boolean 和 object 两种签名
  assert.match(src, /typeof meta === 'boolean'/);
  assert.match(src, /meta\.discovery !== false/);
  assert.match(src, /body\.title/);
  assert.match(src, /body\.name/);
  assert.match(src, /body\.lon/);
  assert.match(src, /body\.lat/);
});

test('A 段：room.js createAsHost 兼容 boolean 与 object 签名', () => {
  const src = read('public/video/lighthouse/room.js');
  assert.match(src, /typeof opts === 'boolean'/);
  assert.match(src, /opts\.discovery !== false/);
  assert.match(src, /meta\.title/);
});

test('A 段：world-ui 创建面板 + 主按钮（片名/城市/权限）', () => {
  const src = read('public/video/world-ui.js');
  // A1：主按钮
  assert.match(src, /world-create-btn/);
  assert.match(src, /buildCreateBtn/);
  assert.match(src, /创建放映/);
  // A2：创建面板
  assert.match(src, /showCreatePanel/);
  assert.match(src, /hideCreatePanel/);
  assert.match(src, /world-create-panel/);
  assert.match(src, /world-create-input/);
  assert.match(src, /world-create-perm/);
  assert.match(src, /公开地图/);
  assert.match(src, /仅房间码/);
  // 处理器接线
  assert.match(src, /setCreateHandler/);
  assert.match(src, /createHandler/);
});

test('A 段：page-world 接通创建入口（setCreateHandler → createHost）', () => {
  const src = read('public/video/page-world.js');
  assert.match(src, /setCreateHandler/);
  assert.match(src, /createHost/);
  assert.match(src, /discovery: opts\.discovery !== false/);
});

test('index.html 加载顺序：security → edge-local → room → webrtc → sync → ui → world-room', () => {
  const html = read('public/index.html');
  const order = [
    'video/lighthouse/security.js',
    'video/lighthouse/edge-local.js',
    'video/lighthouse/state.js',
    'video/lighthouse/room.js',
    'video/lighthouse/webrtc.js',
    'video/lighthouse/sync.js',
    'video/lighthouse/ui.js',
    'video/world-room.js',
    'video/page-world.js'
  ];
  let prev = -1;
  for (const f of order) {
    const i = html.indexOf('"' + f + '"');
    assert.ok(i >= 0, f + ' 应在 SFV_SCRIPTS 中');
    assert.ok(i > prev, f + ' 顺序应在前一个之后');
    prev = i;
  }
  // Cloudflare 版 edge.js 不得加载（由 edge-local 取代）
  assert.ok(!/"video\/lighthouse\/edge\.js"/.test(html), '不得加载 Cloudflare 版 edge.js');
  assert.ok(!/"video\/lighthouse\/globe\.js"/.test(html), 'deck.gl 版 globe 不得回归');
});

test('房间上球：fetchRooms 真的打 /api/rooms，并映射成信标', () => {
  const src = read('public/video/world-data.js');
  assert.match(src, /api\/rooms/);
  assert.match(src, /function normalize/);
  assert.match(src, /roomId/);
  assert.match(src, /colorTop/);
  assert.match(src, /colorBottom/);
  // 失败要降级演示房间，不白屏
  assert.match(src, /degraded: true/);
  assert.match(src, /demoRooms/);
  // 不得带 IP / deviceId
  assert.ok(!/remoteAddress|x-forwarded-for/.test(src), '房间映射不得带 IP');
});

test('灯塔层增量刷新，绝不 unmount()+mount() 重建（防 WebGL 上下文泄漏）', () => {
  const src = read('public/video/_archive/world-lighthouse.js');
  assert.match(src, /function refreshStations/);
  assert.match(src, /refreshStations: refreshStations/);
  // 增删改三步
  assert.match(src, /destroyStation\(stations\[i\]\)/);
  assert.match(src, /function createStationAssets/);
  // 必须有「不能重建」的告诫
  assert.match(src, /Too many active WebGL contexts/);
  // refreshStations 里不得调用 unmount/mount
  const i = src.indexOf('function refreshStations');
  const j = src.indexOf('SFV.worldLighthouse = {');
  const fn = src.slice(i, j > i ? j : src.length);
  assert.ok(!/\bunmount\(\)/.test(fn), 'refreshStations 不得调用 unmount');
  assert.ok(!/\bmount\(/.test(fn), 'refreshStations 不得调用 mount');
});

test('世界页每 20s 增量拉房间上球，切页停止轮询', () => {
  const src = read('public/video/page-world.js');
  assert.match(src, /function startRoomPolling/);
  assert.match(src, /function stopRoomPolling/);
  assert.match(src, /setInterval\(tick, 20000\)/);
  assert.match(src, /refreshStations/);
  // unmount 必须停
  const u = src.indexOf('unmount: function');
  assert.ok(/stopRoomPolling\(\)/.test(src.slice(u, u + 400)), 'unmount 里要停轮询');
});

test('A 段：创建按钮/面板样式到位', () => {
  const src = read('public/video/lighthouse/lighthouse.css');
  assert.match(src, /world-create-btn/);
  assert.match(src, /world-create-panel/);
  assert.match(src, /world-create-submit/);
  assert.match(src, /world-create-perm-btn/);
});

test('B1：建房后即时上球（refreshMap 不等 20s 轮询）', () => {
  const src = read('public/video/world-room.js');
  assert.match(src, /function refreshMap/);
  assert.match(src, /refreshMap: refreshMap/);
  assert.match(src, /setMapRefreshHandler/);
  // 建房成功后立刻调 refreshMap
  assert.match(src, /refreshMap\(\)/);
  // page-world 注册即时刷新
  const pw = read('public/video/page-world.js');
  assert.match(pw, /setMapRefreshHandler/);
});

test('B2：进度可视化（同步状态/人数上卡片）', () => {
  const ui = read('public/video/world-ui.js');
  assert.match(ui, /world-card-live/);
  assert.match(ui, /updateCardLive/);
  assert.match(ui, /data-live/);
  // world-room 驱动 updateCardLive
  const room = read('public/video/world-room.js');
  assert.match(room, /updateCardLive/);
  assert.match(room, /getPlaybackState/);
  assert.match(room, /同步播放中/);
  // world-sync 暴露 getPlaybackState
  const sync = read('public/video/world-sync.js');
  assert.match(sync, /getPlaybackState/);
  // CSS 样式
  const css = read('public/video/lighthouse/lighthouse.css');
  assert.match(css, /world-card-live/);
});

test('B3：结束放映（服务端 close + 客户端清理 + 刷地图）', () => {
  // 服务端 close 接口
  const api = read('world-room-api.js');
  assert.match(api, /sub === 'close'/);
  assert.match(api, /rooms\.delete/);
  assert.match(api, /只有主播能关闭房间/);
  // edge-local 调 close
  const edge = read('public/video/lighthouse/edge-local.js');
  assert.match(edge, /\/close/);
  assert.match(edge, /deviceId/);
  // world-room leave 做完整清理
  const room = read('public/video/world-room.js');
  assert.match(room, /removeRoom/);
  assert.match(room, /放映已结束/);
  assert.match(room, /refreshMap\(\)/);
});

test('C1：群聊 UI 接通（onOpenChat → showChat，消息事件刷新）', () => {
  const room = read('public/video/world-room.js');
  assert.match(room, /onOpenChat: function \(\) \{ openChat\(\); \}/);
  assert.match(room, /function openChat/);
  assert.match(room, /function refreshChatPanel/);
  assert.match(room, /showChat/);
  assert.match(room, /chatData/);
  assert.match(room, /sendChat/);
  // 消息事件触发刷新
  assert.match(room, /evt\.type === 'chat'/);
  assert.match(room, /refreshChatPanel/);
  // world-sync 有 sendChat/chatLog
  const sync = read('public/video/world-sync.js');
  assert.match(sync, /sendChat/);
  assert.match(sync, /chatLog/);
});

test('C2：切集同步（notifyVideoChange + detectVideoChange + 当前片信息）', () => {
  const sync = read('public/video/world-sync.js');
  assert.match(sync, /function notifyVideoChange/);
  assert.match(sync, /function detectVideoChange/);
  assert.match(sync, /function getCurrentVideoInfo/);
  assert.match(sync, /notifyVideoChange: notifyVideoChange/);
  assert.match(sync, /detectVideoChange: detectVideoChange/);
  assert.match(sync, /getCurrentVideoInfo: getCurrentVideoInfo/);
  // 广播循环里检测换片
  assert.match(sync, /detectVideoChange\(\)/);
  // switchVideo 仍然存在
  assert.match(sync, /switchVideo/);
  // reset 清状态
  assert.match(sync, /_lastBroadcastUrl/);
  // room 面板展示当前片
  const room = read('public/video/world-room.js');
  assert.match(room, /currentVideo/);
  assert.match(room, /getCurrentVideoInfo/);
});

test('B 段：模块语法合法（含 world-sync）', () => {
  const { execFileSync } = require('node:child_process');
  for (const f of ['world-room-api.js', 'public/video/world-room.js',
                   'public/video/lighthouse/edge-local.js',
                   'public/video/world-ui.js',
                   'public/video/page-world.js',
                   'public/video/lighthouse/room.js',
                   'public/video/world-sync.js']) {
    execFileSync(process.execPath, ['--check', path.join(root, f)], { encoding: 'utf8', stdio: 'pipe' });
  }
});

test('C 段：模块语法合法', () => {
  const { execFileSync } = require('node:child_process');
  for (const f of ['public/video/world-room.js', 'public/video/world-sync.js',
                   'public/video/lighthouse/ui.js']) {
    execFileSync(process.execPath, ['--check', path.join(root, f)], { encoding: 'utf8', stdio: 'pipe' });
  }
});

test('D1：隐私说明 UI（位置精度/数据流/不采集/可关闭）', () => {
  const src = read('public/video/world-ui.js');
  assert.match(src, /world-create-privacy/);
  assert.match(src, /隐私说明/);
  assert.match(src, /位置精度/);
  assert.match(src, /数据流向/);
  assert.match(src, /不采集/);
  assert.match(src, /可关闭/);
  assert.match(src, /WebRTC/);
  assert.match(src, /城市级/);
  // CSS 样式
  const css = read('public/video/lighthouse/lighthouse.css');
  assert.match(css, /world-create-privacy/);
});

test('D2：房间码防暴力（限流）', () => {
  const src = read('world-room-api.js');
  assert.match(src, /rateCheck/);
  assert.match(src, /rateRecordFailure/);
  assert.match(src, /RATE_LIMITED/);
  assert.match(src, /maxPerDevice/);
  assert.match(src, /maxGlobal/);
  assert.match(src, /lockedUntil/);
  // 限流触发返回 429
  assert.match(src, /429/);
  // 导出供测试
  assert.match(src, /_rateState/);
});

test('D4：行政边界数据已换成真实数据集', () => {
  const countries = path.join(root, 'public/data/boundaries/world-countries.geojson');
  const provinces = path.join(root, 'public/data/boundaries/china-provinces.geojson');
  assert.ok(fs.existsSync(countries), '世界国家界应存在');
  assert.ok(fs.existsSync(provinces), '中国省界应存在');
  // 国家界应 > 500KB（真实数据，非简化 demo）
  assert.ok(fs.statSync(countries).size > 500 * 1024, '国家界应是完整数据集');
  // 省界应 > 100KB
  assert.ok(fs.statSync(provinces).size > 100 * 1024, '省界应是完整数据集');
  // 验证 JSON 合法
  const c = JSON.parse(fs.readFileSync(countries, 'utf-8'));
  const p = JSON.parse(fs.readFileSync(provinces, 'utf-8'));
  assert.ok(c.features.length > 100, '国家界应含 100+ 国家');
  assert.ok(p.features.length >= 30, '省界应含 30+ 省');
});

test('D 段：模块语法合法', () => {
  const { execFileSync } = require('node:child_process');
  for (const f of ['world-room-api.js', 'public/video/world-ui.js']) {
    execFileSync(process.execPath, ['--check', path.join(root, f)], { encoding: 'utf8', stdio: 'pipe' });
  }
});

test('M5 模块语法合法', () => {
  const { execFileSync } = require('node:child_process');
  for (const f of ['world-room-api.js', 'public/video/world-room.js',
                   'public/video/lighthouse/edge-local.js',
                   'public/video/world-ui.js',
                   'public/video/page-world.js',
                   'public/video/lighthouse/room.js']) {
    execFileSync(process.execPath, ['--check', path.join(root, f)], { encoding: 'utf8', stdio: 'pipe' });
  }
});
