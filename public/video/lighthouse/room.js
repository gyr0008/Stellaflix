/*
 * Stellaflix 影视模块 — 灯塔模式 · 房间管理 (Phase 2)
 *
 * 对应文档 §6.1 / §6.2（含审批流 · 解决 A3）/ Phase 2 第 5 条。
 *  - 房间码生成（6 位，排除易混淆字符 0O1lI）；
 *  - 创建房间（Host）/ 加入房间（Guest，读发现层 + 发 join 请求 → 待确认队列）；
 *  - Host 审批流状态机（pending / accepted / rejected / full）；
 *  - 成员变更事件。
 *
 * WebRTC 连接（Phase 3）不在本模块；本模块只完成信令层（房间创建 / 审批）。
 * 依赖 edge.js。纯逻辑；vm 可直接加载。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var LH = (SFV.lighthouse = SFV.lighthouse || {});
  var edge = LH.edge;

  // 排除 0O1lI，降低口头/视觉混淆
  var CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  function generateRoomCode(len) {
    len = len || 6;
    var c = global.crypto || (typeof require !== 'undefined' ? require('crypto') : null);
    var out = '';
    if (c && c.getRandomValues) {
      var a = new Uint8Array(len);
      c.getRandomValues(a);
      for (var i = 0; i < len; i++) out += CODE_CHARS[a[i] % CODE_CHARS.length];
    } else {
      for (var j = 0; j < len; j++) out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
    return out;
  }

  function isValidRoomCode(code) {
    return typeof code === 'string' && code.length === 6 && new RegExp('^[' + CODE_CHARS + ']+$').test(code);
  }

  // ---- 房间会话状态机 ----
  function RoomSession() {
    this.code = null;
    this.role = null;        // 'host' | 'guest'
    this.status = 'idle';    // idle|creating|pending|accepted|rejected|full|active|closed
    this.discovery = null;   // 发现层 video（guest 视角）
    this.members = [];       // [{ id, nickname, status }]
    this._listeners = [];
  }
  RoomSession.prototype.on = function (fn) {
    if (typeof fn !== 'function') return function () {};
    this._listeners.push(fn);
    var self = this;
    return function () { var i = self._listeners.indexOf(fn); if (i >= 0) self._listeners.splice(i, 1); };
  };
  RoomSession.prototype._emit = function (evt) {
    for (var i = 0; i < this._listeners.length; i++) { try { this._listeners[i](evt); } catch (e) {} }
  };
  RoomSession.prototype._set = function (status, extra) {
    this.status = status;
    this._emit(Object.assign({ type: 'status', status: status }, extra || {}));
  };

  // Host：创建房间（写 /rooms/{code}）
  // 兼容两种签名：
  //   createAsHost(true|false)           —— 旧版：仅 discovery
  //   createAsHost({discovery,title,name,lon,lat}) —— 新版：带地图元数据
  RoomSession.prototype.createAsHost = function (opts) {
    var self = this;
    self.role = 'host';
    self._set('creating');
    var code = generateRoomCode(6);
    var discovery = true;
    var meta = null;
    if (typeof opts === 'boolean' || opts == null) {
      discovery = opts !== false;
    } else if (typeof opts === 'object') {
      discovery = opts.discovery !== false;
      meta = opts;
    }
    return edge.createRoom(code, meta || discovery).then(function (res) {
      // 修复轮⑦：服务端恒自生成房间码（world-room-api POST /api/room 忽略 body.code），
      // 会话必须采用响应码 —— 沿用客户端自生码会让 signal/close/join 全打在不存在的码上
      self.code = (res && res.code) || code;
      self.discovery = discovery;
      if (meta) {
        self.title = meta.title || null;
        self.roomName = meta.name || null;
        self.lon = meta.lon;
        self.lat = meta.lat;
      }
      self._set('active', { code: self.code });
      return res;
    });
  };

  // Guest：加入房间（读发现层 → 发 join 请求 → pending 待 Host 审批）
  RoomSession.prototype.joinAsGuest = function (code, opts) {
    var self = this;
    opts = opts || {};
    code = (code || '').toUpperCase();
    if (!isValidRoomCode(code)) { self._set('rejected', { reason: 'invalid-code' }); return Promise.reject(new Error('invalid-code')); }
    self.role = 'guest';
    self._set('pending', { code: code });
    return edge.getRoom(code).then(function (room) {
      if (!room || !room.exists) { self._set('rejected', { reason: 'not-found' }); throw new Error('not-found'); }
      if (room.full) { self._set('full'); throw new Error('full'); }
      self.code = code;
      self.discovery = room.discovery || null;
      return edge.requestJoin(code, { deviceId: LH.security.getDeviceId(), nickname: opts.nickname || '匿名灯塔' });
    }).then(function () {
      self._set('pending', { awaitingHost: true }); // 等待 Host 审批（Phase 3 接入信令结果）
      return { code: code, discovery: self.discovery };
    });
  };

  // Host：审批
  RoomSession.prototype.approve = function (guestId) { return edge.hostAccept(this.code, guestId); };
  RoomSession.prototype.reject = function (guestId) { return edge.hostReject(this.code, guestId); };

  // Guest 侧：收到 Host 决策（由信令 / 轮询驱动；Phase 3 接入）
  RoomSession.prototype.onHostDecision = function (decision) {
    if (decision && decision.accepted) this._set('accepted');
    else this._set('rejected', { reason: 'host-rejected' });
  };

  LH.room = {
    generateRoomCode: generateRoomCode,
    isValidRoomCode: isValidRoomCode,
    RoomSession: RoomSession
  };
})(typeof window !== 'undefined' ? window : this);
