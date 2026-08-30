/*
 * Stellaflix 影视模块 — 灯塔模式 · 边缘接入层 (Phase 2)
 *
 * 对应文档 §7.1 / §7.2 / §7.4。封装 Cloudflare Worker 的 REST + WS 信令。
 * 依赖 security.js（HMAC / Turnstile）、geo.js（地理缓存注入）。
 * 纯逻辑 + fetch / WebSocket；vm 可直接加载（注入 fetch / WebSocket 桩）。
 *
 * 路由（与 Worker 端 §7.1 一一对应）：
 *  POST   /beacon              写/更新信标（Turnstile + HMAC + 限流）
 *  GET    /beacons             列出在线 + 幽灵灯
 *  POST   /room                创建房间
 *  GET    /room/:code          读取房间（公开发现层）
 *  POST   /room/:code/join     加入请求 → Host 待确认队列
 *  POST   /room/:code/accept    Host 接受
 *  POST   /room/:code/reject    Host 拒绝
 *  WS     /signal/:code         信令通道（Phase 3 业务；此处仅建立连接预留）
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var LH = (SFV.lighthouse = SFV.lighthouse || {});
  var sec = LH.security, geo = LH.geo;

  function endpoint() { return (LH.config && LH.config.edgeEndpoint) || ''; }

  function authHeaders(auth) {
    return {
      'content-type': 'application/json',
      'x-device-id': auth.deviceId,
      'x-nonce': auth.nonce,
      'x-sig': auth.sig || ''
    };
  }

  function handleStatus(r) {
    if (r.status === 429) { var e = new Error('rate-limited'); e.code = 429; throw e; }
    if (r.status === 403) { var e2 = new Error('forbidden'); e2.code = 403; throw e2; }
    if (!r.ok) { var e3 = new Error('http-' + r.status); e3.code = r.status; throw e3; }
    return r;
  }

  // 写/更新信标（含 Turnstile + HMAC）；响应含 geo 时缓存到 geo 层
  function writeBeacon(payload) {
    var ep = endpoint();
    if (!ep) return Promise.reject(new Error('no-endpoint'));
    return Promise.all([sec.makeAuthPayload(), sec.getTurnstileToken()]).then(function (res) {
      var auth = res[0], turn = res[1];
      var headers = authHeaders(auth);
      if (turn) headers['x-turnstile'] = turn;
      return fetch(ep + '/beacon', { method: 'POST', headers: headers, body: JSON.stringify(payload) });
    }).then(handleStatus).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.geo) geo.setCfGeo(j.geo);
      return j;
    });
  }

  function getBeacons() {
    var ep = endpoint();
    if (!ep) return Promise.reject(new Error('no-endpoint'));
    return fetch(ep + '/beacons', { method: 'GET' }).then(handleStatus).then(function (r) { return r.json(); });
  }

  function createRoom(code, discovery) {
    var ep = endpoint();
    if (!ep) return Promise.reject(new Error('no-endpoint'));
    return Promise.all([sec.makeAuthPayload(), sec.getTurnstileToken()]).then(function (res) {
      var auth = res[0], turn = res[1];
      var headers = authHeaders(auth);
      if (turn) headers['x-turnstile'] = turn;
      return fetch(ep + '/room', { method: 'POST', headers: headers, body: JSON.stringify({ code: code, discovery: discovery }) });
    }).then(handleStatus).then(function (r) { return r.json(); });
  }

  function getRoom(code) {
    var ep = endpoint();
    if (!ep) return Promise.reject(new Error('no-endpoint'));
    return fetch(ep + '/room/' + encodeURIComponent(code), { method: 'GET' })
      .then(handleStatus).then(function (r) { return r.json(); });
  }

  function requestJoin(code, guestInfo) {
    var ep = endpoint();
    if (!ep) return Promise.reject(new Error('no-endpoint'));
    return sec.makeAuthPayload().then(function (auth) {
      return fetch(ep + '/room/' + encodeURIComponent(code) + '/join', {
        method: 'POST', headers: authHeaders(auth), body: JSON.stringify({ guest: guestInfo })
      });
    }).then(handleStatus).then(function (r) { return r.json(); });
  }

  function hostDecision(code, guestId, accept) {
    var ep = endpoint();
    if (!ep) return Promise.reject(new Error('no-endpoint'));
    return sec.makeAuthPayload().then(function (auth) {
      var path = accept ? '/accept' : '/reject';
      return fetch(ep + '/room/' + encodeURIComponent(code) + path, {
        method: 'POST', headers: authHeaders(auth), body: JSON.stringify({ guestId: guestId })
      });
    }).then(handleStatus).then(function (r) { return r.json(); });
  }

  function removeBeacon(deviceId) {
    var ep = endpoint();
    if (!ep) return Promise.reject(new Error('no-endpoint'));
    return sec.makeAuthPayload().then(function (auth) {
      return fetch(ep + '/beacon', { method: 'DELETE', headers: authHeaders(auth) });
    }).then(handleStatus).then(function () { return true; });
  }

  function removeRoom(code) {
    var ep = endpoint();
    if (!ep) return Promise.reject(new Error('no-endpoint'));
    return sec.makeAuthPayload().then(function (auth) {
      return fetch(ep + '/room/' + encodeURIComponent(code), { method: 'DELETE', headers: authHeaders(auth) });
    }).then(handleStatus).then(function () { return true; });
  }

  // ---- 心跳定时器（含 Turnstile + 签名；离线 → Worker 侧转 ghost）----
  var _hbTimer = null, _hbPayload = null, _hbInterval = 30000;
  function startHeartbeat(payload, intervalMs) {
    stopHeartbeat();
    _hbPayload = Object.assign({}, payload || {}, { lastSeen: Date.now() });
    _hbInterval = intervalMs || 30000;
    writeBeacon(_hbPayload).catch(function () {}); // 首跳立即写
    _hbTimer = setInterval(function () {
      _hbPayload.lastSeen = Date.now();
      writeBeacon(_hbPayload).catch(function () {});
    }, _hbInterval);
    if (_hbTimer && typeof _hbTimer.unref === 'function') _hbTimer.unref();
    return _hbTimer;
  }
  function stopHeartbeat() { if (_hbTimer) { clearInterval(_hbTimer); _hbTimer = null; } }

  // ---- 长轮询监听远程信标（Phase 2：GET /beacons 轮询；WS 留给信令）----
  var _listenTimer = null, _seen = {};
  function listenBeacons(onUpsert, onRemove, pollMs) {
    stopListenBeacons();
    pollMs = pollMs || 5000;
    function tick() {
      getBeacons().then(function (data) {
        var list = ((data && data.online) || []).concat((data && data.ghosts) || []) || [];
        var now = {};
        list.forEach(function (b) {
          now[b.id] = true;
          if (!_seen[b.id] || _seen[b.id] !== b.state) { if (onUpsert) onUpsert(b); }
          _seen[b.id] = b.state;
        });
        Object.keys(_seen).forEach(function (id) {
          if (!now[id]) { if (onRemove) onRemove(id); delete _seen[id]; }
        });
      }).catch(function () {});
    }
    tick();
    _listenTimer = setInterval(tick, pollMs);
    if (_listenTimer && typeof _listenTimer.unref === 'function') _listenTimer.unref();
  }
  function stopListenBeacons() { if (_listenTimer) { clearInterval(_listenTimer); _listenTimer = null; } _seen = {}; }

  // ---- 信令 WS（Phase 3 业务；此处仅建立连接预留）----
  var _ws = null;
  function openSignal(code, onMessage) {
    var ep = endpoint();
    if (!ep || typeof WebSocket === 'undefined') return null;
    var wsUrl = ep.replace(/^http/, 'ws') + '/signal/' + encodeURIComponent(code);
    try { _ws = new WebSocket(wsUrl); } catch (e) { return null; }
    _ws.onmessage = function (ev) {
      if (!onMessage) return;
      try { onMessage(JSON.parse(ev.data)); } catch (e) {}
    };
    return _ws;
  }
  function closeSignal() { if (_ws) { try { _ws.close(); } catch (e) {} _ws = null; } }

  LH.edge = {
    writeBeacon: writeBeacon, getBeacons: getBeacons,
    createRoom: createRoom, getRoom: getRoom,
    requestJoin: requestJoin,
    hostAccept: function (c, g) { return hostDecision(c, g, true); },
    hostReject: function (c, g) { return hostDecision(c, g, false); },
    removeBeacon: removeBeacon, removeRoom: removeRoom,
    startHeartbeat: startHeartbeat, stopHeartbeat: stopHeartbeat,
    listenBeacons: listenBeacons, stopListenBeacons: stopListenBeacons,
    openSignal: openSignal, closeSignal: closeSignal
  };
})(typeof window !== 'undefined' ? window : this);
