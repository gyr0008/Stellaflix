/*
 * Stellaflix 影视模块 — 世界页数据源（M5 房间语义）
 *
 * 产品定位：世界页的信标 = 「正在放映的房间」。
 *   · 每座灯塔 = 一个开放的「一起看」房间
 *   · 卡片显示「N 人一起看《X》」
 *   · 主按钮 = 进入房间（world-room.js）
 *
 * 数据链路：
 *   GET /api/rooms  →  world-room-api.js（本地 server.js，内存房间表）
 *   拉不到就降级演示房间，世界页永远有灯塔可看、可点，不白屏。
 *
 * 隐私边界：房间列表只含 roomId / 城市级坐标 / 人数 / 片名，
 * 不含 IP、deviceId、精确位置。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  var lastResult = null;

  // 演示房间（房间服务不可用时的兜底）
  var DEMO_ROOMS = [
    { id: 'r-sh', roomId: 'room-sh', name: '上海',   lon: 121.47, lat: 31.23,  status: 'playing', title: '《星际穿越》',   people: 3, alwaysExpanded: true },
    { id: 'r-tk', roomId: 'room-tk', name: '东京',   lon: 139.69, lat: 35.69,  status: 'playing', title: '《千与千寻》',   people: 2, alwaysExpanded: true },
    { id: 'r-ny', roomId: 'room-ny', name: '纽约',   lon: -74.01, lat: 40.71,  status: 'playing', title: '《奥本海默》',   people: 5, alwaysExpanded: true },
    { id: 'r-ld', roomId: 'room-ld', name: '伦敦',   lon: -0.13,  lat: 51.51,  status: 'online',  title: '《盗梦空间》',   people: 2, alwaysExpanded: true },
    { id: 'r-pr', roomId: 'room-pr', name: '巴黎',   lon: 2.35,   lat: 48.86,  status: 'online',  title: '《天使爱美丽》', people: 1, alwaysExpanded: true },
    { id: 'r-sy', roomId: 'room-sy', name: '悉尼',   lon: 151.21, lat: -33.87, status: 'online',  title: '《疯狂的麦克斯》', people: 2, alwaysExpanded: true },
    { id: 'r-ri', roomId: 'room-ri', name: '里约',   lon: -43.17, lat: -22.91, status: 'online',  title: '《上帝之城》',   people: 4, alwaysExpanded: true },
    { id: 'r-ct', roomId: 'room-ct', name: '开普敦', lon: 18.42,  lat: -33.92, status: 'online',  title: '《第九区》',     people: 1, alwaysExpanded: true },
    { id: 'r-mb', roomId: 'room-mb', name: '孟买',   lon: 72.88,  lat: 19.08,  status: 'playing', title: '《三傻》',       people: 6, alwaysExpanded: true },
    { id: 'r-ms', roomId: 'room-ms', name: '莫斯科', lon: 37.62,  lat: 55.76,  status: 'online',  title: '《潜行者》',     people: 2, alwaysExpanded: true }
  ];

  // 由 roomId 稳定散列出色相（对齐 hearthere「每座灯塔有自己的颜色」）
  function hashHue(str) {
    var h = 2166136261;
    var s = String(str || 'x');
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h) / 2147483647;
  }
  function hueToRgb(h) {
    var i = Math.floor(h * 6);
    var f = h * 6 - i;
    var q = 1 - f;
    switch (i % 6) {
      case 0: return [1, f, 0];
      case 1: return [q, 1, 0];
      case 2: return [0, 1, f];
      case 3: return [0, q, 1];
      case 4: return [f, 0, 1];
      default: return [1, 0, q];
    }
  }
  function colorsFor(id) {
    var top = hueToRgb(hashHue(id));
    return {
      colorTop: top.map(function (v) { return Math.round(v * 100) / 100; }),
      colorBottom: top.map(function (v) { return Math.round(v * 100) / 100 * 0.32; })
    };
  }

  function normalize(r) {
    if (!r) return null;
    var roomId = r.roomId || r.id;
    var c = colorsFor(roomId);
    return {
      id: 'room-' + roomId,
      roomId: roomId,
      name: r.name || '放映房间',
      lon: Number(r.lon) || 0,
      lat: Number(r.lat) || 0,
      status: r.status === 'playing' ? 'playing' : 'online',
      title: r.title || '一起看',
      people: Number(r.people) || 1,
      // Task 7：queue_update 进度面透传（world-sync.currentTrack 消费）；
      // status 枚举映射保持原样，渲染层语义不回退
      playlist: r.playlist || null,
      lastHeartbeat: Number(r.lastHeartbeat) || 0,
      colorTop: c.colorTop,
      colorBottom: c.colorBottom,
      // 步骤③：塔身展开谓词（hearthere :13262）要求 alwaysExpanded/system/自建三者之一；
      // 本地放映房间按用户裁决走数据层标记，渲染层谓词保持逐字
      alwaysExpanded: true
    };
  }

  function get(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (typeof fetch !== 'function') { reject(new Error('NO_FETCH')); return; }
      var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
      var timer = setTimeout(function () {
        if (ctrl) ctrl.abort();
        reject(new Error('TIMEOUT'));
      }, timeoutMs || 12000);
      fetch(url, ctrl ? { signal: ctrl.signal } : undefined).then(function (r) {
        clearTimeout(timer);
        if (!r.ok) {
          return r.json().then(function (body) {
            var msg = (body && (body.message || body.error)) || ('HTTP_' + r.status);
            throw new Error(msg);
          }, function () {
            throw new Error('HTTP_' + r.status);
          });
        }
        return r.json();
      }).then(function (j) {
        clearTimeout(timer);
        resolve(j);
      }, function (e) {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  // A4（修复轮⑥）：真实房间与演示灯塔 merge 共存（用户裁决）。
  // 旧语义「真实≥1 → 全量替换」会把 10 座演示灯塔从地球上抹掉，
  // 用户感知为「创建了灯塔，其他灯塔全没了」。现真实在前、按 roomId 去重。
  function mergeWithDemo(realRooms) {
    var seen = {};
    var out = [];
    (realRooms || []).forEach(function (r) {
      if (!r) return;
      if (r.roomId) seen['rid:' + r.roomId] = true;
      if (r.id) seen['id:' + r.id] = true;
      out.push(r);
    });
    DEMO_ROOMS.forEach(function (d) {
      if (seen['rid:' + d.roomId] || seen['id:' + d.id]) return;
      out.push(d);
    });
    return out;
  }

  /**
   * 拉取开放的「一起看」房间。
   * @param {object} opts { limit }
   * @returns {Promise<{ok, count, rooms, source, degraded}>}
   */
  function fetchRooms(opts) {
    opts = opts || {};
    return get('api/rooms', 12000).then(function (j) {
      if (j && j.ok && Array.isArray(j.rooms)) {
        var rooms = mergeWithDemo(j.rooms.map(normalize).filter(Boolean));
        if (opts.limit) rooms = rooms.slice(0, opts.limit);
        if (rooms.length) {
          lastResult = { ok: true, count: rooms.length, rooms: rooms, source: '本地房间信令', degraded: false };
          return lastResult;
        }
      }
      throw new Error('EMPTY');
    }).catch(function (e) {
      console.warn('[world-data] 拉取放映房间失败，降级演示房间', e && e.message);
      var demo = DEMO_ROOMS.slice();
      if (opts.limit) demo = demo.slice(0, opts.limit);
      lastResult = {
        ok: true,
        count: demo.length,
        rooms: demo,
        source: '演示房间（' + (e && e.message ? e.message : '房间服务不可达') + '）',
        degraded: true
      };
      return lastResult;
    });
  }

  function demoRooms() {
    return DEMO_ROOMS.slice();
  }

  SFV.worldData = {
    fetchRooms: fetchRooms,
    demoRooms: demoRooms,
    normalize: normalize,
    get lastResult() { return lastResult; }
  };
})(typeof window !== 'undefined' ? window : this);
