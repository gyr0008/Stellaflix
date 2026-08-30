/*
 * Stellaflix 影视模块 — 灯塔模式 · WebRTC P2P 同步通道 (Phase 3)
 *
 * 对应文档 §6.3（DataChannel "sync" 同步）/ §6.4（断线重连）/ §6.2 审批后建连。
 *  - 星型拓扑：Host 为 offerer，且为每条 Guest 连接 createDataChannel("sync")；
 *    Guest 为 answerer，监听 pc.ondatachannel。媒体不外泄——仅走 DataChannel，
 *    不经任何中继服务器（§6.0 硬约束：零媒体服务器）。
 *  - 信令经 edge.openSignal 的 Cloudflare WS /signal/:code 中继（Task #18 在 worker.mjs 实现）。
 *  - 纯逻辑 + 全局 RTCPeerConnection；Node 无 RTCPeerConnection 时降级 hasRTC=false，
 *    vm 加载不崩溃，no-rtc 路径可被测试覆盖。
 *
 * 信令协议（client ↔ Cloudflare WS）：
 *  client→server:
 *    { type:"identify", from:<deviceId>, role:<"host"|"guest"> }
 *    { type:"signal",  from:<deviceId>, to:<peerId>, payload:{ sdp|ice } }
 *    { type:"leave" }
 *  server→client:
 *    { type:"peer-enter", from, role }          // 新成员进入，广播给其他成员
 *    { type:"peer-list",  peers:[{from,role}] } // 新成员接入时，回发已在场成员
 *    { type:"signal",     from, payload }        // 转发给 to 指定成员
 *    { type:"peer-leave", from }                 // 成员离开
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var LH = (SFV.lighthouse = SFV.lighthouse || {});

  // ---- 配置：ICE servers（中国可达 STUN 运行时注入；离线 mock 不触发）----
  LH.config = LH.config || {};
  if (!LH.config.iceServers) {
    // 占位默认值：运行时务必由 Electron main 重写为中国可达 STUN/TURN。
    // 否则公网 NAT 穿透可能失败（Google STUN 在中国大陆部分网络不可达）。
    LH.config.iceServers = [
      { urls: 'stun:stun.miwifi.com:3478' },          // 占位（运行时覆盖）
      { urls: 'stun:stun.l.google.com:19302' }         // 通用兜底
    ];
  }

  // ---- 运行时能力探测 ----
  var RTC = (typeof RTCPeerConnection !== 'undefined') ? RTCPeerConnection
    : (global.RTCPeerConnection || null);
  var hasRTC = !!RTC;

  // ============================================================
  //  SignalClient — 封装 edge.openSignal 的 WS，转发中继消息
  // ============================================================
  function SignalClient(code, deviceId, role, onMessage) {
    this.code = code;
    this.deviceId = deviceId;
    this.role = role;
    this.onMessage = onMessage || function () {};
    this._ws = null;
  }
  SignalClient.prototype.connect = function () {
    if (!LH.edge || !LH.edge.openSignal) return null;
    var self = this;
    this._ws = LH.edge.openSignal(this.code, function (msg) { self._onRaw(msg); });
    if (this._ws) this.identify(this.role);
    return this._ws;
  };
  SignalClient.prototype._onRaw = function (msg) {
    if (msg && this.onMessage) this.onMessage(msg);
  };
  SignalClient.prototype._ready = function () {
    return this._ws && typeof this._ws.send === 'function' && this._ws.readyState === 1;
  };
  SignalClient.prototype._send = function (m) {
    if (this._ready()) { try { this._ws.send(JSON.stringify(m)); return true; } catch (e) {} }
    return false;
  };
  SignalClient.prototype.identify = function (role) {
    this.role = role || this.role;
    return this._send({ type: 'identify', from: this.deviceId, role: this.role });
  };
  SignalClient.prototype.sendSignal = function (to, payload) {
    return this._send({ type: 'signal', from: this.deviceId, to: to, payload: payload });
  };
  SignalClient.prototype.leave = function () { this._send({ type: 'leave' }); };
  SignalClient.prototype.close = function () {
    if (this._ws) { try { this.leave(); } catch (e) {} try { this._ws.close(); } catch (e) {} this._ws = null; }
  };

  // ============================================================
  //  PeerLink — 单条 RTCPeerConnection + DataChannel("sync")
  // ============================================================
  function PeerLink(opts) {
    opts = opts || {};
    this.id = opts.peerId || null;          // 远端 peerId
    this.role = opts.role || 'host';        // host=offerer+datachannel；guest=answerer
    this.signal = opts.signal || null;      // SignalClient
    this.channel = null;                    // RTCDataChannel
    this.pc = null;
    this.status = 'idle';                   // idle|connecting|connected|failed|closed|no-rtc
    this.onState = opts.onState || function () {};
    this.onMessage = opts.onMessage || function () {};
    this._pendingIce = [];
  }
  PeerLink.prototype._setStatus = function (s) { this.status = s; this.onState(s, this); };
  PeerLink.prototype._newPC = function () {
    var self = this;
    var pc = new RTC({ iceServers: LH.config.iceServers || [] });
    pc.onicecandidate = function (e) {
      if (e.candidate && self.signal) self.signal.sendSignal(self.id, { ice: e.candidate });
    };
    pc.onconnectionstatechange = function () {
      var s = pc.connectionState;
      if (s === 'connected') self._setStatus('connected');
      else if (s === 'failed') self._setStatus('failed');
      else if (s === 'disconnected') self._setStatus('disconnected');
    };
    if (this.role === 'guest') {
      pc.ondatachannel = function (e) { self.channel = e.channel; self._bindChannel(); };
    }
    this.pc = pc;
    return pc;
  };
  PeerLink.prototype._bindChannel = function () {
    var self = this, ch = this.channel;
    if (!ch) return;
    ch.onopen = function () { self._setStatus('connected'); };
    ch.onclose = function () { self._setStatus('closed'); };
    ch.onmessage = function (ev) { self._onChannelMessage(ev.data); };
  };
  PeerLink.prototype._onChannelMessage = function (data) {
    var msg; try { msg = JSON.parse(data); } catch (e) { return; }
    this.onMessage(msg);
  };

  // Host 发起：建 pc + datachannel + offer → 经信令发给 Guest
  PeerLink.prototype.startHost = function () {
    if (!hasRTC) { this._setStatus('no-rtc'); return Promise.resolve(false); }
    var self = this;
    var pc = this._newPC();
    this.channel = pc.createDataChannel('sync');
    this._bindChannel();
    return pc.createOffer().then(function (offer) { return pc.setLocalDescription(offer); })
      .then(function () { return self.signal.sendSignal(self.id, { sdp: pc.localDescription }); })
      .then(function () { self._setStatus('connecting'); return true; })
      .catch(function () { self._setStatus('failed'); return false; });
  };

  // Guest 收到 offer：建 pc + answer → 经信令回 Host
  PeerLink.prototype.handleOffer = function (sdp) {
    if (!hasRTC) { this._setStatus('no-rtc'); return Promise.resolve(false); }
    var self = this;
    var pc = this._newPC();
    return pc.setRemoteDescription(sdp).then(function () { return pc.createAnswer(); })
      .then(function (answer) { return pc.setLocalDescription(answer); })
      .then(function () { return self.signal.sendSignal(self.id, { sdp: pc.localDescription }); })
      .then(function () { self._setStatus('connecting'); return true; })
      .catch(function () { self._setStatus('failed'); return false; });
  };

  // 处理来自信令的 relay 消息（signal/sdp/ice）
  PeerLink.prototype.handleSignal = function (msg) {
    var p = msg && msg.payload;
    if (!p) return;
    var self = this;
    if (p.sdp) {
      if (this.role === 'guest' && (!this.pc || p.sdp.type === 'offer')) this.handleOffer(p.sdp);
      else if (this.role === 'host' && p.sdp.type === 'answer') {
        if (this.pc) { this.pc.setRemoteDescription(p.sdp).catch(function () {}); this._flushIce(); }
      }
    }
    if (p.ice) {
      if (this.pc && this.pc.remoteDescription) this.pc.addIceCandidate(p.ice).catch(function () {});
      else this._pendingIce.push(p.ice);
    }
  };
  PeerLink.prototype._flushIce = function () {
    var self = this;
    this._pendingIce.forEach(function (c) { if (self.pc) self.pc.addIceCandidate(c).catch(function () {}); });
    this._pendingIce = [];
  };

  PeerLink.prototype.send = function (obj) {
    if (this.channel && this.channel.readyState === 'open') {
      try { this.channel.send(JSON.stringify(obj)); return true; } catch (e) {}
    }
    return false;
  };
  PeerLink.prototype.close = function () {
    if (this.channel) { try { this.channel.close(); } catch (e) {} this.channel = null; }
    if (this.pc) { try { this.pc.close(); } catch (e) {} this.pc = null; }
    this._setStatus('closed');
  };

  // ============================================================
  //  RtcSession — Host(多 Guest 链路) / Guest(单链路) 调度
  //  仅提供建连与消息转发骨架；同步语义(broadcast/applySync)由 view.js 接线。
  // ============================================================
  function RtcSession(opts) {
    opts = opts || {};
    this.role = opts.role || 'host';
    this.code = opts.code || null;
    this.deviceId = (LH.security && LH.security.getDeviceId) ? LH.security.getDeviceId() : 'anon';
    this.signal = null;
    this.links = {};                 // peerId -> PeerLink
    this.onLinkState = opts.onLinkState || function () {};
    this.onMessage = opts.onMessage || function () {};
    this._started = false;
  }
  RtcSession.prototype.start = function () {
    if (this._started) return this.signal != null;
    this._started = true;
    if (!hasRTC) { this.onLinkState('no-rtc', null, null); return false; }
    var self = this;
    this.signal = new SignalClient(this.code, this.deviceId, this.role, function (msg) { self._onSignal(msg); });
    var ws = this.signal.connect();
    if (!ws) { this.onLinkState('no-signal', null, null); return false; }
    return true;
  };
  RtcSession.prototype._onSignal = function (msg) {
    if (!msg) return;
    var self = this;
    if (msg.type === 'peer-list') {
      (msg.peers || []).forEach(function (p) {
        if (p.from === self.deviceId) return;
        var link = self._ensureLink(p.from, self.role === 'host' ? 'host' : 'guest');
        if (self.role === 'host') link.startHost();
      });
      return;
    }
    if (msg.type === 'peer-enter' && msg.from !== this.deviceId) {
      var link = this._ensureLink(msg.from, this.role === 'host' ? 'host' : 'guest');
      if (this.role === 'host') link.startHost();
      return;
    }
    if (msg.type === 'signal' && msg.from) {
      var l = this._ensureLink(msg.from, this.role === 'host' ? 'host' : 'guest');
      l.handleSignal(msg);
      return;
    }
    if (msg.type === 'peer-leave' && msg.from) this._dropLink(msg.from);
  };
  RtcSession.prototype._ensureLink = function (peerId, role) {
    if (!this.links[peerId]) {
      var self = this;
      this.links[peerId] = new PeerLink({
        peerId: peerId, role: role, signal: this.signal,
        onState: function (s, link) { self.onLinkState(s, peerId, link); },
        onMessage: function (m) { self.onMessage(m, peerId); }
      });
    }
    return this.links[peerId];
  };
  RtcSession.prototype._dropLink = function (peerId) {
    if (this.links[peerId]) { this.links[peerId].close(); delete this.links[peerId]; }
  };
  // Host → 所有 Guest 广播对象
  RtcSession.prototype.broadcast = function (obj) {
    var self = this, sent = 0;
    Object.keys(this.links).forEach(function (k) { if (self.links[k].send(obj)) sent++; });
    return sent;
  };
  // 向指定 Guest 发送对象（Host 零源路径 B：resolve 定向下发）
  RtcSession.prototype.sendTo = function (peerId, obj) {
    return this.links[peerId] ? this.links[peerId].send(obj) : false;
  };
  // 向除 exceptPeerId 外的所有链路广播（Host 中继群聊：排除原发送者，避免其收到自己消息的回声）
  RtcSession.prototype.broadcastExcept = function (exceptPeerId, obj) {
    var self = this, sent = 0;
    Object.keys(this.links).forEach(function (k) {
      if (k === exceptPeerId) return;
      if (self.links[k].send(obj)) sent++;
    });
    return sent;
  };
  RtcSession.prototype.peerCount = function () {
    return Object.keys(this.links).filter(function (k) { return this.links[k].status === 'connected'; }, this).length;
  };
  RtcSession.prototype.close = function () {
    var self = this;
    Object.keys(this.links).forEach(function (k) { self.links[k].close(); });
    this.links = {};
    if (this.signal) this.signal.close();
    this.signal = null;
  };

  LH.webrtc = {
    hasRTC: hasRTC,
    RTC: RTC,
    SignalClient: SignalClient,
    PeerLink: PeerLink,
    RtcSession: RtcSession
  };
})(typeof window !== 'undefined' ? window : this);
