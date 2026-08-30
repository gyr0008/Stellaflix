/*
 * Stellaflix 影视模块 — 灯塔模式 · 状态机与信标存储 (Phase 1)
 *
 * 对应文档 §2.6 灯塔实体状态机（领域模型）。
 * 纯逻辑模块：不依赖 DOM / THREE / MapLibre，可被 vm 直接加载冒烟。
 *
 * 职责：
 *  - 定义灯塔（beacon）互斥状态集合与事件→迁移表；
 *  - 维护信标列表（Map<id, Beacon>）、当前模式（mode）、角色（role）、房间码（roomCode）；
 *  - 提供订阅/发布，供 globe.js / ui.js 监听变化。
 *
 * 说明：心跳超时→GHOST、GHOST 过期→OFFLINE 的判定由 edge.js（Phase 2）驱动；
 *   Phase 1 的幽灵灯由 mock.js 直接预置 isGhost，本模块仅提供迁移能力与存储。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var LH = (SFV.lighthouse = SFV.lighthouse || {});

  // ----------------------------------------------------------------- 状态集合
  var STATE = {
    OFFLINE: 'OFFLINE',       // 不存在 / 已删除（地图无灯）
    IDLE: 'IDLE',             // 在线但无播放 → 仅城市灯
    PLAYING: 'PLAYING',       // 在线播放中 → 卡片显示海报+片名+进度
    PAUSED: 'PAUSED',         // 在线暂停 → 灯仍亮，≠离线
    JOINED_HOST: 'JOINED_HOST', // 本端作为 Host 开了房间 → 主播环
    JOINED_GUEST: 'JOINED_GUEST', // 本端作为 Guest 加入他人房间 → 观众环
    GHOST: 'GHOST'            // 离线 24h 内回放 → 暗淡无脉冲
  };

  // 是否为“有脉冲的活跃在线态”（用于外观与动画）
  function isLive(state) {
    return state === STATE.IDLE || state === STATE.PLAYING ||
           state === STATE.PAUSED || state === STATE.JOINED_HOST ||
           state === STATE.JOINED_GUEST;
  }

  // ----------------------------------------------------------------- 事件→迁移表（§2.6）
  // key = 当前态 + '>' + 事件；value = 目标态
  var TRANSITIONS = {
    'OFFLINE>open_lighthouse': STATE.IDLE,
    'IDLE>start_play': STATE.PLAYING,
    'PLAYING>pause': STATE.PAUSED,
    'PAUSED>resume': STATE.PLAYING,
    'PLAYING>stop_play': STATE.IDLE,
    'PAUSED>stop_play': STATE.IDLE,
    'IDLE>create_room': STATE.JOINED_HOST,
    'PLAYING>create_room': STATE.JOINED_HOST,
    'PAUSED>create_room': STATE.JOINED_HOST,
    'IDLE>join_room': STATE.JOINED_GUEST,
    'PLAYING>join_room': STATE.JOINED_GUEST,
    'PAUSED>join_room': STATE.JOINED_GUEST,
    'JOINED_HOST>leave_room': STATE.IDLE,
    'JOINED_GUEST>leave_room': STATE.IDLE,
    'IDLE>heartbeat_timeout': STATE.GHOST,
    'PLAYING>heartbeat_timeout': STATE.GHOST,
    'PAUSED>heartbeat_timeout': STATE.GHOST,
    'JOINED_HOST>heartbeat_timeout': STATE.GHOST,
    'JOINED_GUEST>heartbeat_timeout': STATE.GHOST,
    'GHOST>ghost_expire': STATE.OFFLINE,
    'ANY>close_lighthouse': STATE.OFFLINE
  };

  function transition(state, event) {
    if (!state || !event) return state;
    var direct = TRANSITIONS[state + '>' + event];
    if (direct) return direct;
    if (TRANSITIONS['ANY>' + event]) return TRANSITIONS['ANY>' + event];
    return state; // 非法迁移：保持原态
  }

  // ----------------------------------------------------------------- Beacon 工厂
  function makeBeacon(o) {
    o = o || {};
    return {
      id: o.id || ('b-' + Math.random().toString(36).slice(2, 10)),
      lat: typeof o.lat === 'number' ? o.lat : 0,
      lng: typeof o.lng === 'number' ? o.lng : 0,
      city: o.city || '',
      country: o.country || '',
      nickname: o.nickname || '匿名灯塔',
      state: o.state || STATE.IDLE,
      video: o.video || null, // { title, episode, season, posterUrl, quality }
      viewers: typeof o.viewers === 'number' ? o.viewers : 1,
      roomCode: o.roomCode || null,
      lastSeen: o.lastSeen || Date.now(),
      isGhost: !!o.isGhost,
      // 渲染层附加（由 beacon-view.js 填充，存储层不依赖）
      _view: null
    };
  }

  // ----------------------------------------------------------------- 状态容器
  function LighthouseState() {
    this.mode = 'off';        // 'off' | 'on'
    this.role = null;         // null | 'host' | 'guest'
    this.roomCode = null;
    this.localBeaconId = null; // 本端信标 id（自建）
    this._beacons = {};       // id -> Beacon
    this._listeners = [];     // { type, fn }
  }

  LighthouseState.prototype.setMode = function (on) {
    this.mode = on ? 'on' : 'off';
    this._emit({ type: 'mode', mode: this.mode });
  };

  LighthouseState.prototype.upsertBeacon = function (b) {
    if (!b || !b.id) return null;
    var existing = this._beacons[b.id];
    var beacon = existing ? Object.assign(existing, b) : makeBeacon(b);
    this._beacons[b.id] = beacon;
    this._emit({ type: 'beacon:upsert', beacon: beacon });
    return beacon;
  };

  LighthouseState.prototype.removeBeacon = function (id) {
    var b = this._beacons[id];
    if (!b) return false;
    delete this._beacons[id];
    this._emit({ type: 'beacon:remove', id: id, beacon: b });
    return true;
  };

  LighthouseState.prototype.getBeacon = function (id) { return this._beacons[id] || null; };

  LighthouseState.prototype.getBeacons = function () {
    var self = this, out = [];
    Object.keys(this._beacons).forEach(function (k) { out.push(self._beacons[k]); });
    return out;
  };

  LighthouseState.prototype.getBeaconsByState = function (state) {
    return this.getBeacons().filter(function (b) { return b.state === state; });
  };

  // 事件迁移（§2.6）。返回迁移后的新状态；若非法迁移则保持原态。
  LighthouseState.prototype.applyEvent = function (id, event) {
    var b = this._beacons[id];
    if (!b) return null;
    var next = transition(b.state, event);
    if (next !== b.state) {
      b.state = next;
      if (next === STATE.GHOST) b.isGhost = true;
      if (next === STATE.OFFLINE) { this.removeBeacon(id); return STATE.OFFLINE; }
      this._emit({ type: 'beacon:state', id: id, state: next, beacon: b });
    }
    return b.state;
  };

  // 直接设置状态（用于 mock / 外部权威源覆盖）
  LighthouseState.prototype.setState = function (id, state) {
    var b = this._beacons[id];
    if (!b || !STATE[state]) return false;
    if (b.state !== state) {
      b.state = state;
      if (state === STATE.GHOST) b.isGhost = true;
      this._emit({ type: 'beacon:state', id: id, state: state, beacon: b });
    }
    return true;
  };

  LighthouseState.prototype.clearBeacons = function () {
    this._beacons = {};
    this._emit({ type: 'beacons:clear' });
  };

  // ----------------------------------------------------------------- 订阅/发布
  LighthouseState.prototype.subscribe = function (fn) {
    if (typeof fn !== 'function') return function () {};
    this._listeners.push(fn);
    var self = this;
    return function unsubscribe() {
      var i = self._listeners.indexOf(fn);
      if (i >= 0) self._listeners.splice(i, 1);
    };
  };

  LighthouseState.prototype._emit = function (evt) {
    for (var i = 0; i < this._listeners.length; i++) {
      try { this._listeners[i](evt); } catch (e) { /* 单个监听器异常不影响其它 */ }
    }
  };

  // ----------------------------------------------------------------- 导出
  LH.STATE = STATE;
  LH.isLive = isLive;
  LH.transition = transition;
  LH.makeBeacon = makeBeacon;
  LH.LighthouseState = LighthouseState;
  // 单例（视图层共享）
  LH.state = new LighthouseState();
})(typeof window !== 'undefined' ? window : this);
