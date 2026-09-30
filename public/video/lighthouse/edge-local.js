/*
 * Stellaflix 影视模块 — 灯塔模式 · 本地边缘接入层（M5）
 *
 * 与 video/lighthouse/edge.js **接口完全一致**，只是把后端从 Cloudflare Worker
 * 换成本地 server.js 的 /api/room/*。因此 room.js / webrtc.js **零改动**即可复用。
 *
 * 信令通道：server.js 是裸 http 没有 ws 库，所以 openSignal 返回的是
 * 「轮询信箱伪装的 WebSocket」——满足 SignalClient 要求的
 *   .send(string) / .readyState === 1 / .close() / onmessage
 * 语义，latency 约 250ms，足够 WebRTC 握手用。
 *
 * 安全边界（与此前修正一致）：
 *   · 只打本机 127.0.0.1，不暴露到公网
 *   · 不采集/上报 IP；deviceId 是本地随机标识
 *   · 只中继信令，不中继媒体
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var LH = (SFV.lighthouse = SFV.lighthouse || {});
  var sec = LH.security;

  // 本机 server.js 地址：默认同源；Electron 下由 server.js 提供 /api
  function baseUrl() {
    if (LH.config && LH.config.localEdge) return LH.config.localEdge;
    if (typeof global.location !== 'undefined' && global.location.origin) {
      return global.location.origin + '/api';
    }
    return 'http://127.0.0.1:3000/api';
  }

  function endpoint() { return baseUrl() + '/room'; }

  function deviceId() {
    return (sec && typeof sec.getDeviceId === 'function') ? sec.getDeviceId() : 'anon';
  }

  function handleStatus(r) {
    if (r.status === 429) { var e = new Error('rate-limited'); e.code = 429; throw e; }
    if (r.status === 403) { var e2 = new Error('forbidden'); e2.code = 403; throw e2; }
    if (!r.ok) { var e3 = new Error('http-' + r.status); e3.code = r.status; throw e3; }
    return r;
  }

  function post(path, body) {
    return fetch(endpoint() + path, {
      method: 'POST',
      // 修复轮⑥ A1：带设备头让服务端 D2 限流按 deviceId 分桶，
      // 不再全员挤进 'anon' 一桶互伤
      headers: { 'content-type': 'application/json', 'x-device-id': deviceId() },
      body: JSON.stringify(body || {})
    }).then(handleStatus).then(function (r) { return r.json(); });
  }

  function get(path) {
    return fetch(endpoint() + path, { method: 'GET', headers: { 'x-device-id': deviceId() } })
      .then(handleStatus).then(function (r) { return r.json(); });
  }

  // ============================================================
  //  房间
  // ============================================================
  /**
   * 创建房间
   * @param {string} code  6 位房间码
   * @param {boolean|object} meta  兼容旧签名：boolean = discovery；
   *   object = { discovery, title, name, lon, lat, nickname }
   */
  function createRoom(code, meta) {
    var discovery = true;
    var extra = {};
    if (typeof meta === 'boolean' || meta === null || meta === undefined) {
      discovery = meta !== false;
    } else if (typeof meta === 'object') {
      discovery = meta.discovery !== false;
      extra.title = meta.title;
      extra.name = meta.name;
      extra.lon = meta.lon;
      extra.lat = meta.lat;
      if (meta.nickname) extra.nickname = meta.nickname;
    }
    var body = {
      code: code,
      discovery: discovery,
      deviceId: deviceId(),
      nickname: extra.nickname || (LH.config && LH.config.nickname) || '匿名灯塔'
    };
    if (extra.title != null) body.title = extra.title;
    if (extra.name != null) body.name = extra.name;
    if (extra.lon != null) body.lon = extra.lon;
    if (extra.lat != null) body.lat = extra.lat;
    return post('', body);
  }

  function getRoom(code) {
    return get('/' + encodeURIComponent(code) + '?deviceId=' + encodeURIComponent(deviceId()));
  }

  function requestJoin(code, guestInfo) {
    return post('/' + encodeURIComponent(code) + '/join', {
      deviceId: deviceId(),
      nickname: (guestInfo && guestInfo.nickname) || '匿名灯塔'
    });
  }

  function hostDecision(code, guestId, accept) {
    return post('/' + encodeURIComponent(code) + (accept ? '/accept' : '/reject'), { guestId: guestId });
  }

  function removeRoom(code) {
    // A3（修复轮⑥）：失败不再 catch 成 true —— 谎报成功会留下幽灵灯塔，
    // 调用方（world-room.leave）据布尔值如实提示
    return post('/' + encodeURIComponent(code) + '/close', {
      deviceId: deviceId()
    }).then(function () { return true; }, function () { return false; });
  }

  function removeBeacon() { return Promise.resolve(true); }
  function writeBeacon() { return Promise.resolve({ ok: true }); }
  function getBeacons() { return getBeaconsList(); }
  function getBeaconsList() {
    return fetch(baseUrl() + '/rooms').then(handleStatus).then(function (r) { return r.json(); });
  }

  function startHeartbeat() { return function () {}; }
  function stopHeartbeat() {}
  function listenBeacons() { return function () {}; }
  function stopListenBeacons() {}

  // ============================================================
  //  信令信箱（伪装成 WebSocket）
  // ============================================================
  function openSignal(code, onMessage) {
    var closed = false;
    var since = 0;
    var self = {
      readyState: 1,
      send: function (payload) {
        if (closed) return false;
        var msg;
        try { msg = JSON.parse(payload); } catch (e) { return false; }
        post('/' + encodeURIComponent(code) + '/signal', {
          from: msg.from || deviceId(),
          to: msg.to || '',
          payload: msg
        }).catch(function () {});
        return true;
      },
      close: function () {
        closed = true;
        self.readyState = 3;
      }
    };

    var miss404 = 0; // 修复轮⑥ A1：房间已消失的止血计数（429 不计，恢复后要能续上）
    (function poll() {
      if (closed) return;
      get('/' + encodeURIComponent(code) + '/signal?deviceId=' + encodeURIComponent(deviceId()) + '&since=' + since)
        .then(function (j) {
          if (closed) return;
          miss404 = 0;
          if (j && Array.isArray(j.items)) {
            for (var i = 0; i < j.items.length; i++) {
              since = Math.max(since, j.items[i].seq || 0);
              if (onMessage && j.items[i].payload) {
                try { onMessage(j.items[i].payload); } catch (e) {}
              }
            }
          }
          if (j && typeof j.seq === 'number') since = Math.max(since, j.seq);
          setTimeout(poll, 250);
        })
        .catch(function (err) {
          if (closed) return;
          // 连续 2 次 404 = 房间已从服务端消失（重启/TTL/close），
          // 自停防孤儿页签把 D2 not-found 计数打满形成全局 429 风暴
          if (err && err.code === 404 && ++miss404 >= 2) {
            closed = true;
            self.readyState = 3;
            return;
          }
          setTimeout(poll, 800);
        });
    })();

    return self;
  }

  function closeSignal() { /* 轮询由 GC 回收；显式关闭由 SignalClient.close 调用 */ }

  LH.edge = {
    writeBeacon: writeBeacon,
    getBeacons: getBeacons,
    createRoom: createRoom,
    getRoom: getRoom,
    requestJoin: requestJoin,
    hostAccept: function (c, g) { return hostDecision(c, g, true); },
    hostReject: function (c, g) { return hostDecision(c, g, false); },
    removeBeacon: removeBeacon,
    removeRoom: removeRoom,
    startHeartbeat: startHeartbeat,
    stopHeartbeat: stopHeartbeat,
    listenBeacons: listenBeacons,
    stopListenBeacons: stopListenBeacons,
    openSignal: openSignal,
    closeSignal: closeSignal
  };
})(typeof window !== 'undefined' ? window : this);
