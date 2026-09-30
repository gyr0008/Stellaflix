'use strict';

/**
 * Stellaflix — 世界页「一起看」房间信令（M5，本地实现）
 *
 * 目标：让 lighthouse/room.js + webrtc.js **不改动**就能跑起来。
 * 约定契约与 edge.js（Cloudflare Worker 版）一致，只是把后端换成本地 server.js。
 *
 * 设计要点（对应此前的安全修正）：
 *   · 只在本机 server.js 上做信令，**不把用户的电脑暴露到公网**
 *   · 不采集/存储/展示 IP；guestId 是设备随机 id，与网络地址无关
 *   · 只中继「建房 / 加入 / 审批 / WebRTC 信令」，**不中继任何媒体流**
 *   · 房间在内存里，进程退出即消失，不落盘
 *
 * 信令通道：WS 对我们太重（server.js 是裸 http），改用「轮询信箱」：
 *   POST /api/room/:code/signal   投递
 *   GET  /api/room/:code/signal   按 seq 拉取
 * 客户端 edge-local.js 把它伪装成 WebSocket 形状，webrtc.js 无需改动。
 */

const crypto = require('crypto');

// ============================================================
//  内存房间表（进程级，不落盘）
// ============================================================
const rooms = new Map(); // code -> room
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;   // 2h 过期
const MAX_GUESTS = 4;                     // 与 room.js 文案「最多 4 人」一致
const SIGNAL_KEEP = 200;                  // 信箱保留条数

// D2：房间码防暴力 —— 失败查找限流
// 不采集 IP（隐私边界），按 deviceId + 全局计数双重限流
const RATE = {
  windowMs: 60 * 1000,     // 1 分钟窗口
  maxPerDevice: 10,        // 单设备每分钟最多 10 次失败查找
  maxGlobal: 200,          // 全局每分钟最多 200 次失败查找
  lockoutMs: 5 * 60 * 1000 // 触发后锁定 5 分钟
};
const rateState = {
  deviceHits: new Map(),   // deviceId -> { count, windowStart }
  globalCount: 0,
  globalWindowStart: 0,
  lockedUntil: 0
};

function rateCheck(deviceId) {
  const now = Date.now();
  // 全局锁定期
  if (now < rateState.lockedUntil) {
    return { ok: false, retryAfter: Math.ceil((rateState.lockedUntil - now) / 1000) };
  }
  // 全局窗口重置
  if (now - rateState.globalWindowStart > RATE.windowMs) {
    rateState.globalCount = 0;
    rateState.globalWindowStart = now;
  }
  // 设备窗口重置
  let d = rateState.deviceHits.get(deviceId);
  if (!d || now - d.windowStart > RATE.windowMs) {
    d = { count: 0, windowStart: now };
    rateState.deviceHits.set(deviceId, d);
  }
  if (d.count >= RATE.maxPerDevice || rateState.globalCount >= RATE.maxGlobal) {
    // 触发全局锁定期
    rateState.lockedUntil = now + RATE.lockoutMs;
    return { ok: false, retryAfter: Math.ceil(RATE.lockoutMs / 1000) };
  }
  return { ok: true, deviceEntry: d };
}

function rateRecordFailure(deviceId) {
  const now = Date.now();
  let d = rateState.deviceHits.get(deviceId);
  if (!d || now - d.windowStart > RATE.windowMs) {
    d = { count: 0, windowStart: now };
    rateState.deviceHits.set(deviceId, d);
  }
  d.count += 1;
  rateState.globalCount += 1;
}

function genCode(len) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去掉易混字符
  let out = '';
  const buf = crypto.randomBytes(len || 6);
  for (let i = 0; i < (len || 6); i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

function getRoom(code) {
  const r = rooms.get(String(code || '').toUpperCase());
  if (!r) return null;
  if (Date.now() - r.createdAt > ROOM_TTL_MS) { rooms.delete(r.code); return null; }
  return r;
}

function publicShape(r, viewerDeviceId) {
  return {
    exists: true,
    code: r.code,
    discovery: r.discovery,
    status: r.status,
    full: r.guests.filter((g) => g.status === 'accepted').length >= MAX_GUESTS,
    createdAt: r.createdAt,
    // 只暴露必要字段，绝不带 IP / 精确位置
    title: r.title || '一起看',
    name: r.name || '放映房间',
    lon: r.lon,
    lat: r.lat,
    host: { nickname: r.hostNickname, isMe: r.hostDeviceId === viewerDeviceId },
    guests: r.guests.map((g) => ({
      deviceId: g.deviceId,
      nickname: g.nickname,
      status: g.status,
      isMe: g.deviceId === viewerDeviceId
    }))
  };
}

function ensureSignal(r) {
  if (!r.signal) r.signal = { seq: 0, items: [] };
  return r.signal;
}

function pushSignal(r, from, to, payload) {
  const s = ensureSignal(r);
  s.seq += 1;
  s.items.push({ seq: s.seq, from, to, payload, at: Date.now() });
  if (s.items.length > SIGNAL_KEEP) s.items.splice(0, s.items.length - SIGNAL_KEEP);
  return s.seq;
}

// ============================================================
//  Task 7：queue_update（Host 广播片单进度）
//  语义移植自 HearThere main.pretty.js :14490-14510；status 推断（:14506）
//  与客户端 world-sync.js inferStatus 保持同一套规则。
// ============================================================
const QUEUE_MAX_LEN = 200;   // 片单长度上限
const TITLE_MAX_LEN = 48;    // 与房间 title 同一克制

// 归一化 host 载荷：只留公开字段（url 等内部字段不落库）
function normalizeQueueUpdate(body) {
  const rawQueue = Array.isArray(body.queue) ? body.queue.slice(0, QUEUE_MAX_LEN) : [];
  return {
    type: String(body.type || 'queue_update'),
    queue: rawQueue.map((t) => ({
      title: String((t && t.title) || '').slice(0, TITLE_MAX_LEN),
      duration_ms: Math.max(0, Number(t && t.duration_ms) || 0)
    })),
    current_position: body.current_position == null || body.current_position === ''
      ? null
      : Number(body.current_position),
    start_time: Number(body.start_time) || 0,
    host_sent_at: Number(body.host_sent_at) || 0
  };
}

// 与客户端 SFV.worldSync.inferStatus 镜像（browser CJS 两端各留一份，不跨层 require）
function inferPlaylistStatus(p) {
  if (!p) return null;
  const t = p.type;
  if (t === 'playlist_replaced' || t === 'playlist_completed' || t === 'broadcast_ended') return 'idle';
  if (t === 'queue_reorder' && p.current_position == null) return 'idle';
  return 'playing';
}

// 房间列表公开面：不回 url 等内部字段
function publicPlaylist(p) {
  if (!p) return null;
  return {
    type: p.type,
    queue: p.queue.map((t) => ({ title: t.title, duration_ms: t.duration_ms })),
    current_position: p.current_position,
    start_time: p.start_time,
    host_sent_at: p.host_sent_at,
    received_at: p.received_at
  };
}

// queue-update / heartbeat 的 host 校验：deviceId 从 body 或 x-device-id 头取，
// 非 host 一律 403（hostDeviceId 建房时保证非空，所以缺 deviceId 也进 403 分支）
function hostOnly(req, body, room) {
  const deviceId = String(body.deviceId || (req.headers && req.headers['x-device-id']) || '');
  return deviceId === room.hostDeviceId;
}

// ============================================================
//  Task 8：全站广播频道（fireworks / likes）
//  进程级环形缓冲信箱，条目与 signal 信箱同形（见 :344-353 GET 面）。
//  库存/扣减【不】在服务端做：库存是客户端 localStorage 语义
//  （HearThere「收听奖励」→ Stellaflix「看完整片奖励」，判定在客户端
//  world-social.js），服务端只是广播信箱。跨站写由 server.js Origin-Guard 挡。
// ============================================================
const BROADCAST_KEEP = 100;   // 环形缓冲保留上限
const broadcastChannels = {
  fireworks: { seq: 0, items: [] },
  likes: { seq: 0, items: [] }
};

function pushBroadcast(ch, deviceId, payload) {
  ch.seq += 1;
  ch.items.push({
    seq: ch.seq,
    from: deviceId,
    to: '',                                  // 全站广播：无定向收件人
    payload: { stationId: String((payload && payload.stationId) || '').slice(0, 32) },
    at: Date.now()
  });
  if (ch.items.length > BROADCAST_KEEP) ch.items.splice(0, ch.items.length - BROADCAST_KEEP);
  return ch.seq;
}

// ============================================================
//  REST 处理器
// ============================================================
async function handle(req, res, url, sendJSON) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api','room',...]
  const method = req.method || 'GET';

  // ---------- GET /api/rooms  地图用的开放房间列表 ----------
  if (parts[2] === undefined && method === 'GET') {
    const list = [];
    rooms.forEach((r) => {
      if (!r.discovery) return;
      if (Date.now() - r.createdAt > ROOM_TTL_MS) return;
      // Task 7：status 沿用 queue_update 推断（playing/idle）；
      // 未广播过 playlist 的房间保持现有 open→playing/offline 逻辑不回退
      const playlistStatus = inferPlaylistStatus(r.playlist);
      list.push({
        id: 'room-' + r.code,
        roomId: r.code,
        name: r.name || '放映房间 ' + r.code,
        lon: r.lon,
        lat: r.lat,
        status: playlistStatus || (r.status === 'open' ? 'playing' : 'offline'),
        title: r.title || '一起看',
        people: r.guests.filter((g) => g.status === 'accepted').length + 1,
        playlist: publicPlaylist(r.playlist),
        lastHeartbeat: r.lastHeartbeat || 0
      });
    });
    sendJSON(res, { ok: true, count: list.length, rooms: list, source: '本地房间信令' });
    return;
  }

  // ---------- POST /api/room  创建（路径无房间号，必须在 code 守卫之前） ----------
  if (parts[2] === undefined && method === 'POST') {
    const body = await readBody(req);
    const deviceId = String(body.deviceId || '');
    if (!deviceId) { sendJSON(res, { ok: false, error: 'BAD_REQUEST', message: '缺少 deviceId' }, 400); return; }
    const c = genCode(6);
    const room = {
      code: c,
      discovery: body.discovery !== false,
      status: 'open',
      createdAt: Date.now(),
      hostDeviceId: deviceId,
      hostNickname: String(body.nickname || '匿名灯塔').slice(0, 24),
      title: String(body.title || '一起看').slice(0, 48),
      name: String(body.name || '放映房间 ' + c).slice(0, 32),
      lon: Number(body.lon) || 0,
      lat: Number(body.lat) || 0,
      guests: [],
      signal: { seq: 0, items: [] },
      // Task 7：最近一次 queue_update 状态 + 房主心跳（内存态，不落盘）
      playlist: null,
      lastHeartbeat: 0
    };
    rooms.set(c, room);
    sendJSON(res, { ok: true, ...publicShape(room, deviceId) });
    return;
  }

  // ---------- Task 8：全站频道 /api/room/fireworks | /api/room/likes ----------
  // 无碰撞论证：房间码恒为 genCode(:82-88) 生成的 6 位字母数字（31 字符表，
  // 无 I/O/0/1），而路由字面量 'fireworks'(9 位)/'likes'(5 位) 长度即不等于 6，
  // 任意大小写形态都不会与真实房间码相等 —— 本分支不可能劫持 /api/room/:code。
  if (parts[2] === 'fireworks' || parts[2] === 'likes') {
    const ch = broadcastChannels[parts[2]];
    if (method === 'POST') {
      const body = await readBody(req);
      const deviceId = String(body.deviceId || '').slice(0, 40);
      if (!deviceId) {
        sendJSON(res, { ok: false, error: 'BAD_REQUEST', message: '缺少 deviceId' }, 400);
        return;
      }
      sendJSON(res, { ok: true, seq: pushBroadcast(ch, deviceId, body.payload) });
      return;
    }
    // GET：?since=N 增量拉取（对齐 signal 信箱形状）
    const since = Number(url.searchParams.get('since')) || 0;
    sendJSON(res, { ok: true, seq: ch.seq, items: ch.items.filter((m) => m.seq > since) });
    return;
  }

  const code = (parts[2] || '').toUpperCase();
  const sub = parts[3] || '';
  if (!code) {
    sendJSON(res, { ok: false, error: 'BAD_REQUEST', message: '缺少房间号' }, 400);
    return;
  }

  // D2：房间码防暴力 —— 限流只管「未命中」流量（修复轮⑥ A1）。
  // 旧序是 rateCheck 先于存在性校验：全局锁定期内连房主对自己房间的
  // GET/close/signal 也被 429 误伤 —— 关不掉房变幽灵灯塔、孤儿轮询
  // 越重试越锁的死循环根源。命中既有房间一律直接放行。
  const deviceIdForRate = String((req.headers && req.headers['x-device-id']) || '');
  const room = getRoom(code);
  if (!room) {
    const rate = rateCheck(deviceIdForRate || 'anon');
    if (!rate.ok) {
      sendJSON(res, {
        ok: false,
        error: 'RATE_LIMITED',
        message: '请求过于频繁，请 ' + rate.retryAfter + ' 秒后再试',
        retryAfter: rate.retryAfter
      }, 429);
      return;
    }
    // D2：记录失败查找
    rateRecordFailure(deviceIdForRate || 'anon');
    sendJSON(res, { ok: false, exists: false, error: 'NOT_FOUND', message: '房间不存在或已过期' }, 404);
    return;
  }

  // ---------- GET /api/room/:code ----------
  if (!sub && method === 'GET') {
    sendJSON(res, { ok: true, ...publicShape(room, url.searchParams.get('deviceId')) });
    return;
  }

  // ---------- POST /api/room/:code/close  结束放映（Host 关闭房间） ----------
  if (sub === 'close' && method === 'POST') {
    const body = await readBody(req);
    const deviceId = String(body.deviceId || '');
    if (deviceId && deviceId !== room.hostDeviceId) {
      sendJSON(res, { ok: false, error: 'FORBIDDEN', message: '只有主播能关闭房间' }, 403);
      return;
    }
    rooms.delete(room.code);
    sendJSON(res, { ok: true, closed: true, code: room.code });
    return;
  }

  // ---------- POST /api/room/:code/queue-update  Host 广播片单进度（Task 7） ----------
  if (sub === 'queue-update' && method === 'POST') {
    const body = await readBody(req);
    if (!hostOnly(req, body, room)) {
      sendJSON(res, { ok: false, error: 'FORBIDDEN', message: '只有主播能广播片单进度' }, 403);
      return;
    }
    const evt = normalizeQueueUpdate(body);
    room.playlist = { ...evt, received_at: Date.now() };
    sendJSON(res, { ok: true, playlist: publicPlaylist(room.playlist) });
    return;
  }

  // ---------- POST /api/room/:code/heartbeat  房主心跳（Task 7：只动 lastHeartbeat） ----------
  if (sub === 'heartbeat' && method === 'POST') {
    const body = await readBody(req);
    if (!hostOnly(req, body, room)) {
      sendJSON(res, { ok: false, error: 'FORBIDDEN', message: '只有主播能发心跳' }, 403);
      return;
    }
    room.lastHeartbeat = Date.now();
    sendJSON(res, { ok: true, lastHeartbeat: room.lastHeartbeat });
    return;
  }

  // ---------- POST /api/room/:code/join ----------
  if (sub === 'join' && method === 'POST') {
    const body = await readBody(req);
    const deviceId = String(body.deviceId || body.guestId || '');
    if (!deviceId) { sendJSON(res, { ok: false, error: 'BAD_REQUEST', message: '缺少 deviceId' }, 400); return; }
    if (deviceId === room.hostDeviceId) {
      sendJSON(res, { ok: true, ...publicShape(room, deviceId) });
      return;
    }
    let g = room.guests.find((x) => x.deviceId === deviceId);
    if (!g) {
      if (room.guests.filter((x) => x.status === 'accepted').length >= MAX_GUESTS) {
        sendJSON(res, { ok: false, error: 'FULL', message: '房间已满' }, 409);
        return;
      }
      g = {
        deviceId,
        nickname: String(body.nickname || '匿名灯塔').slice(0, 24),
        status: 'pending',
        at: Date.now()
      };
      room.guests.push(g);
      pushSignal(room, deviceId, room.hostDeviceId, { kind: 'join-request', nickname: g.nickname });
    }
    sendJSON(res, { ok: true, ...publicShape(room, deviceId) });
    return;
  }

  // ---------- POST /api/room/:code/accept | /reject ----------
  if ((sub === 'accept' || sub === 'reject') && method === 'POST') {
    const body = await readBody(req);
    const guestId = String(body.guestId || '');
    const g = room.guests.find((x) => x.deviceId === guestId);
    if (!g) { sendJSON(res, { ok: false, error: 'NOT_FOUND', message: '未找到该访客' }, 404); return; }
    g.status = sub === 'accept' ? 'accepted' : 'rejected';
    pushSignal(room, room.hostDeviceId, guestId, {
      kind: 'decision',
      accepted: sub === 'accept'
    });
    sendJSON(res, { ok: true, ...publicShape(room, room.hostDeviceId) });
    return;
  }

  // ---------- 信令信箱 ----------
  if (sub === 'signal') {
    if (method === 'POST') {
      const body = await readBody(req);
      const seq = pushSignal(room, String(body.from || ''), String(body.to || ''), body.payload || {});
      sendJSON(res, { ok: true, seq });
      return;
    }
    // GET：按 seq 拉取
    const since = Number(url.searchParams.get('since')) || 0;
    const to = String(url.searchParams.get('deviceId') || '');
    const items = (room.signal && room.signal.items || []).filter((m) => {
      if (m.seq <= since) return false;
      if (!to) return true;
      return m.to === to || m.to === '' || m.from === to;
    });
    sendJSON(res, { ok: true, seq: room.signal ? room.signal.seq : 0, items });
    return;
  }

  sendJSON(res, { ok: false, error: 'UNKNOWN', message: '未知房间接口' }, 404);
}

// 简易 body 解析（≤64KB）
function readBody(req) {
  return new Promise((resolve) => {
    if (req.method === 'GET' || req.method === 'HEAD') return resolve({});
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 64 * 1024) { try { req.destroy(); } catch (e) {} resolve({}); }
    });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

module.exports = {
  handle: handle,
  _rooms: rooms,
  _rateState: rateState,
  _broadcast: broadcastChannels,   // Task 8 测试面：全站频道环形缓冲
  genCode: genCode
};
