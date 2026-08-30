/*
 * Stellaflix 影视模块 — 灯塔模式 · 视图控制器 (Phase 1)
 *
 * 作为「世界」Tab 的真实视图。由 page-world.js 委托调用：
 *   SFV.lighthouse.view.mount(host, shell) / .unmount()
 *
 * 职责：
 *  - 装配布局（地图容器 + SEE THERE 品牌浮层 + 图例 + 提示）；
 *  - 注入 Phase 1 模拟信标（LH.mock）；
 *  - 初始化地图与灯光层（LH.globe）；
 *  - 接线信标点击 → 浮动卡片（LH.ui）；
 *  - unmount 时彻底清理（destroy globe + 清空信标 + 移除 DOM）。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var LH = (SFV.lighthouse = SFV.lighthouse || {});

  var rootEl = null, mapContainer = null, globe = null, shell = null;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function mount(host, ctx) {
    ctx = ctx || {};
    shell = ctx.shell || SFV.online;
    if (SFV.ui && SFV.ui.setBrowseChrome) SFV.ui.setBrowseChrome(true);
    if (SFV.ui && SFV.ui.setTitle) SFV.ui.setTitle('世界 · 灯塔');

    host.innerHTML = '';
    rootEl = el('div', 'lighthouse-root');
    mapContainer = el('div', 'lighthouse-map-container');
    rootEl.appendChild(mapContainer);

    // 品牌浮层
    var brand = el('div', 'lighthouse-brand');
    brand.appendChild(el('div', 'lighthouse-brand-title', 'SEE THERE'));
    brand.appendChild(el('div', 'lighthouse-brand-sub', '看看世界都在看什么'));
    rootEl.appendChild(brand);

    // 图例
    var legend = el('div', 'lighthouse-legend');
    legend.appendChild(legendItem('#c061ff', '正在观看'));
    legend.appendChild(legendItem('#5ce1e6', '在线'));
    legend.appendChild(legendItem('#55607a', '幽灵回放'));
    rootEl.appendChild(legend);

    // 提示（模拟数据）
    var hint = el('div', 'lighthouse-hint', '演示数据 · 真实在线信标将在第二阶段接入');
    rootEl.appendChild(hint);

    host.appendChild(rootEl);

    // 渲染「创建 / 加入」操作条（Phase 3 加入入口）。离线模式也显示，点击会 toast 提示不可用，
    // 避免用户进入世界页后「没有任何功能按钮」。
    buildActionBar();

    // 数据来源：online 模式接真实边缘，否则演示 mock（默认 offline）
    LH.state.setMode(true);
    if (LH.config && LH.config.online) startOnlineMode();
    else injectMock();

    // 初始化地图 + 灯光层
    console.log('[view] init globe', 'mapTilerKey=', LH.MAP_CONFIG && LH.MAP_CONFIG.mapTilerKey ? 'set' : 'empty');
    globe = LH.globe.initLighthouseGlobe({
      container: mapContainer,
      state: LH.state,
      mapTilerKey: LH.MAP_CONFIG && LH.MAP_CONFIG.mapTilerKey || '',
      onBeaconClick: function (beacon, screenPos) {
        if (!beacon) { LH.ui.hideCard(); return; }
        LH.ui.showCard(beacon, screenPos, mapContainer);
      }
    });
    console.log('[view] globe result', 'ok=', globe && globe.ok, 'hasDestroy=', !!(globe && globe.destroy));
  }

  function legendItem(color, label) {
    var item = el('div', 'lh-legend-item');
    var dot = el('span', 'lh-legend-dot');
    dot.style.background = color;
    item.appendChild(dot);
    item.appendChild(el('span', 'lh-legend-label', label));
    return item;
  }

  function unmount() {
    leaveRoom(true);
    if (globe && globe.destroy) globe.destroy();
    globe = null;
    LH.ui.hideCard();
    LH.ui.hideRoomPanel();
    if (LH.edge) { LH.edge.stopHeartbeat(); LH.edge.stopListenBeacons(); }
    LH.state.clearBeacons();
    LH.state.setMode(false);
    if (rootEl && rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
    rootEl = null; mapContainer = null;
  }

  // ============================================================
  //  Phase 3 加入流程：房间会话 + WebRTC + 同步编排
  // ============================================================
  var roomSession = null;     // LH.room.RoomSession
  var rtcSession = null;      // LH.webrtc.RtcSession
  var broadcastCtl = null;    // LH.sync.startBroadcast 句柄
  var _player = {};           // player 适配器（player-core 经 bindPlayer 注入真实实现）
  var _currentVideo = null;   // Host 当前播放 videoInfo（用于广播）
  var actionBarEl = null;
  var _acceptedConn = {};     // peerId -> bool（已审批且已连）
  var _resolveUrl = '';       // Host 零源模式解析地址（审批后下发 Guest）
  var NICK_KEY = 'stellaflix-lighthouse-nickname';
  var _nickname = (function () { try { return (global.localStorage && global.localStorage.getItem(NICK_KEY)) || ''; } catch (e) { return ''; } })();
  var _myBeacon = null;       // 本端 beacon 负载（在线模式）；昵称/隐私变更时写回 edge
  var _chatLog = [];          // 房间群聊记录（内存态，离开房间清空）
  var _chatSeen = {};         // 群聊去重表 { id:true }（防中继回声/双投）

  // player-core 注入真实播放器适配器（getCurrentTime/getPlaybackRate/...）
  function bindPlayer(adapter) { _player = adapter || {}; }

  // ---- 昵称（localStorage 持久）----
  function getNickname() { return _nickname || '匿名灯塔'; }
  function setNickname(n) {
    _nickname = (n || '').trim().slice(0, 16) || '匿名灯塔';
    try { if (global.localStorage) global.localStorage.setItem(NICK_KEY, _nickname); } catch (e) {}
  }
  // 切换本端灯塔公开性（isPublic）→ 写回 edge，使服务端 GET /beacons 真正过滤
  function setMyPublic(isPublic) {
    if (_myBeacon) { _myBeacon.isPublic = !!isPublic; LH.edge.writeBeacon(_myBeacon).catch(function () {}); }
  }

  function currentVideoInfo() { return _currentVideo; }

  function toast(msg) {
    if (!rootEl) return;
    var t = el('div', 'lighthouse-toast', msg);
    rootEl.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('lighthouse-toast--in'); });
    setTimeout(function () { t.classList.remove('lighthouse-toast--in'); setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 260); }, 2200);
  }

  function buildActionBar() {
    if (actionBarEl) return;
    var bar = el('div', 'lh-room-bar');
    var create = el('button', 'lh-room-bar-btn', '创建房间');
    create.type = 'button';
    create.addEventListener('click', function () { createRoom(true); });
    var input = el('input', 'lh-room-bar-input');
    input.type = 'text'; input.maxLength = 6; input.placeholder = '输入房间码';
    input.className = 'lh-room-bar-input';
    var join = el('button', 'lh-room-bar-btn lh-room-bar-btn--ghost', '加入');
    join.type = 'button';
    join.addEventListener('click', function () { var c = (input.value || '').trim().toUpperCase(); if (c) joinRoom(c); });
    bar.appendChild(create); bar.appendChild(input); bar.appendChild(join);
    rootEl.appendChild(bar);
    actionBarEl = bar;
  }

  // ---- 房间创建 / 加入 ----
  function createRoom(discovery) {
    if (!LH.config.online) { toast('离线演示模式暂不支持真实房间'); return; }
    if (roomSession) { toast('你已在一个房间中'); return; }
    discovery = (typeof discovery === 'boolean') ? discovery : true;
    roomSession = new LH.room.RoomSession();
    roomSession.on(handleRoomEvent);
    roomSession.createAsHost(discovery).then(function () {
      startRtc('host');
      openRoomPanel();
    }).catch(function (e) { toast('创建失败：' + (e && e.message || e)); roomSession = null; });
  }

  function joinRoom(code) {
    if (!LH.config.online) { toast('离线演示模式暂不支持真实房间'); return; }
    if (roomSession) { toast('你已在一个房间中'); return; }
    roomSession = new LH.room.RoomSession();
    roomSession.on(handleRoomEvent);
    roomSession.joinAsGuest(code, { nickname: getNickname() }).then(function () {
      startRtc('guest');
      openRoomPanel();
    }).catch(function (e) {
      toast('加入失败：' + (e && e.message || e));
      roomSession = null;
    });
  }

  function startRtc(role) {
    if (!roomSession || !roomSession.code) return;
    rtcSession = new LH.webrtc.RtcSession({
      role: role, code: roomSession.code, deviceId: LH.security.getDeviceId(),
      onLinkState: onLinkState, onMessage: onRtcMessage
    });
    rtcSession.start();
  }

  // ---- 房间状态事件（来自 room.js）----
  function handleRoomEvent(evt) {
    if (!evt) return;
    if (evt.type === 'status') refreshRoomPanel();
    if (evt.status === 'rejected') toast('未能加入：' + (evt.reason || '被拒绝'));
    if (evt.status === 'full') toast('房间已满（最多 4 人）');
  }

  // ---- RTC 链路状态 ----
  function onLinkState(s, peerId, link) {
    if (s === 'connected' && peerId) {
      var member = roomMember(peerId);
      if (member && (member.status === 'accepted' || member.status === 'connected')) {
        _acceptedConn[peerId] = true;
        if (roomSession && roomSession.role === 'host') startBroadcastIfReady();
      }
    }
    if (s === 'failed' || s === 'disconnected' || s === 'closed') {
      if (peerId) delete _acceptedConn[peerId];
    }
    refreshRoomPanel();
    refreshDiagnostics();
  }

  function roomMember(peerId) {
    if (!roomSession || !roomSession.members) return null;
    for (var i = 0; i < roomSession.members.length; i++) if (roomSession.members[i].id === peerId) return roomSession.members[i];
    return null;
  }

  // ---- RTC 消息分发（sync 协议）----
  function onRtcMessage(msg, peerId) {
    if (!msg) return;
    // Host 决策（经 WS 信令透传，绕过轮询延迟）
    if (msg.kind === 'decision') {
      if (roomSession) roomSession.onHostDecision({ accepted: !!msg.accepted });
      if (msg.accepted) toast('已通过房主审批，开始同步');
      else toast('房主拒绝了你的加入');
      refreshRoomPanel();
      return;
    }
    LH.sync.route(msg, {
      onSync: function (m) {
        // Guest 侧：应用远端同步到本地 player
        if (roomSession && roomSession.role === 'guest') {
          LH.sync.applySync(m, _player, { onSync: function () {} });
          refreshRoomPanel();
        }
      },
      onSwitch: function (m) { _currentVideo = m.videoInfo || _currentVideo; if (roomSession && roomSession.role === 'guest') toast('房主切换了内容'); },
      onResolve: function (m) {
        // 零源路径 B：Guest 收到解析地址 → 注入播放器
        if (roomSession && roomSession.role === 'guest') { _resolveUrl = m.url; toast('已收到播放地址（' + (m.sourceLabel || '源') + '）'); }
      },
      onResolveReq: function () {
        // Host 收到零源 Guest 请求 → 回传解析地址
        if (roomSession && roomSession.role === 'host' && peerId) {
          rtcSession.sendTo(peerId, LH.sync.buildResolve(_resolveUrl || '', 'host'));
        }
      },
      onChat: function (m) { handleIncomingChat(m, peerId); }
    });
  }

  // ---- 房间面板 ----
  function openRoomPanel() {
    if (!roomSession || !mapContainer) return;
    var data = roomPanelData();
    LH.ui.showRoomPanel(data, mapContainer);
  }
  function roomPanelData() {
    var accepted = rtcSession ? rtcSession.peerCount() : 0;
    var members = (roomSession && roomSession.members) ? roomSession.members.map(function (m) {
      return { id: m.id, name: m.nickname, status: m.status };
    }) : [];
    // 已连接链路也算在线（即使 member 状态未刷新）
    Object.keys(_acceptedConn).forEach(function (pid) {
      if (!members.some(function (x) { return x.id === pid; })) members.push({ id: pid, name: '已连接成员', status: 'connected' });
    });
    return {
      role: roomSession.role,
      code: roomSession.code,
      isPublic: _myBeacon ? (_myBeacon.isPublic !== false) : true,
      myNickname: getNickname(),
      statusText: roomStatusText(),
      members: members,
      onCopy: function (code) { copyCode(code); },
      onLeave: function () { leaveRoom(false); },
      onNickname: function (n) {
        setNickname(n);
        if (_myBeacon) { _myBeacon.nickname = getNickname(); LH.edge.writeBeacon(_myBeacon).catch(function () {}); }
        toast('昵称已更新');
      },
      onTogglePrivacy: function (nv) { setMyPublic(nv); toast('公开灯塔：' + (nv ? '开' : '关')); },
      onDiagnostics: function () { openDiagnostics(); },
      onOpenChat: function () { openChat(); },
      onApprove: function (gid) { approveGuest(gid); },
      onReject: function (gid) { rejectGuest(gid); }
    };
  }
  function roomStatusText() {
    if (!roomSession) return '';
    var map = { idle: '空闲', creating: '创建中…', pending: '等待房主审批…', accepted: '已连接 · 同步中', rejected: '未通过审批', full: '房间已满', active: '房间已开启', closed: '已关闭' };
    return map[roomSession.status] || roomSession.status;
  }
  function refreshRoomPanel() { if (roomSession) LH.ui.updateRoomPanel(roomPanelData()); }

  // ---- 网络诊断面板（Phase 4 #4）----
  function diagnosticsData() {
    var links = [];
    if (rtcSession) {
      Object.keys(rtcSession.links).forEach(function (k) {
        links.push({ peer: k, state: rtcSession.links[k].status });
      });
    }
    return {
      online: !!LH.config.online,
      endpoint: (LH.config.edgeEndpoint || '') || '（未配置）',
      stun: (LH.config.iceServers || []).map(function (s) { return s.url || s.urls || ''; }).filter(Boolean),
      mode: 'P2P 直连 · 无媒体中继（§6.0 硬约束）',
      links: links,
      broadcasting: !!broadcastCtl,
      resolveUrl: _resolveUrl || '',
      onClose: function () { LH.ui.hideDiagnostics(); }
    };
  }
  function openDiagnostics() {
    if (!mapContainer) return;
    LH.ui.showDiagnostics(diagnosticsData(), mapContainer);
  }
  function refreshDiagnostics() {
    if (LH.ui.isDiagnosticsOpen && LH.ui.isDiagnosticsOpen()) LH.ui.updateDiagnostics(diagnosticsData());
  }

  // ---- 房间群聊（Phase 4 #7）----
  // 发送：乐观本地追加 + 经 DataChannel 广播（Host→全 Guest；Guest→唯一 Host 链路）。
  function sendChat(text) {
    text = (text || '').trim();
    if (!text) return false;
    if (!roomSession) { toast('你还未在房间中'); return false; }
    if (!rtcSession) { toast('离线演示模式暂不支持聊天'); return false; }
    var msg = LH.sync.buildChat(text, (LH.security && LH.security.getDeviceId) ? LH.security.getDeviceId() : 'anon', getNickname());
    _chatSeen[msg.id] = true;
    _chatLog.push(msg);
    rtcSession.broadcast(msg);
    refreshChatPanel();
    return true;
  }
  // 接收：`LH.sync.handleChat` 负责去重 + Host 中继（排除原发送者）。
  function handleIncomingChat(m, peerId) {
    if (!roomSession) return;
    LH.sync.handleChat(m, {
      role: roomSession.role,
      myId: (LH.security && LH.security.getDeviceId) ? LH.security.getDeviceId() : 'anon',
      seen: _chatSeen,
      onAppend: function (msg) { _chatLog.push(msg); refreshChatPanel(); },
      onRelay: function (msg) { if (rtcSession) rtcSession.broadcastExcept(msg.from, msg); }
    });
  }
  function chatData() {
    return {
      messages: _chatLog.slice(),
      onSend: function (t) { sendChat(t); },
      onClose: function () { LH.ui.hideChat(); }
    };
  }
  function openChat() {
    if (!mapContainer) return;
    LH.ui.showChat(chatData(), mapContainer);
  }
  function refreshChatPanel() {
    if (LH.ui.isChatOpen && LH.ui.isChatOpen()) LH.ui.updateChat(chatData());
  }

  function copyCode(code) {
    try {
      if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
        global.navigator.clipboard.writeText(code);
      } else {
        var ta = document.createElement('textarea'); ta.value = code; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (e) {} document.body.removeChild(ta);
      }
      toast('房间码已复制：' + code);
    } catch (e) { toast('复制失败，请手动记录：' + code); }
  }

  // ---- Host 审批 ----
  function approveGuest(guestId) {
    if (!roomSession || roomSession.role !== 'host') return;
    LH.edge.hostAccept(roomSession.code, guestId).then(function () {
      var m = roomMember(guestId); if (m) m.status = 'accepted';
      if (rtcSession) rtcSession.sendTo(guestId, { kind: 'decision', accepted: true });
      // 若 Host 为零源模式，下发解析地址
      if (_resolveUrl) rtcSession.sendTo(guestId, LH.sync.buildResolve(_resolveUrl, 'host'));
      startBroadcastIfReady();
      refreshRoomPanel();
      toast('已接受成员');
    }).catch(function (e) { toast('审批失败：' + (e && e.message || e)); });
  }
  function rejectGuest(guestId) {
    if (!roomSession || roomSession.role !== 'host') return;
    LH.edge.hostReject(roomSession.code, guestId).then(function () {
      var m = roomMember(guestId); if (m) m.status = 'rejected';
      if (rtcSession) rtcSession.sendTo(guestId, { kind: 'decision', accepted: false });
      refreshRoomPanel();
      toast('已拒绝成员');
    }).catch(function (e) { toast('操作失败：' + (e && e.message || e)); });
  }

  // ---- Host 广播（仅向已审批且已连的 Guest）----
  function startBroadcastIfReady() {
    if (!roomSession || roomSession.role !== 'host') return;
    if (broadcastCtl) return; // 已在广播
    if (!rtcSession || rtcSession.peerCount() < 1) return;
    broadcastCtl = LH.sync.startBroadcast(_player, _currentVideo, function (m) {
      if (rtcSession) rtcSession.broadcast(m);
    });
  }

  // ---- 离开 / 关闭 ----
  function leaveRoom(silent) {
    if (broadcastCtl) { broadcastCtl.stop(); broadcastCtl = null; }
    if (rtcSession) { rtcSession.close(); rtcSession = null; }
    if (roomSession) {
      if (roomSession.role === 'host') { try { LH.edge.removeRoom(roomSession.code); } catch (e) {} }
      roomSession = null;
    }
    _acceptedConn = {};
    _chatLog = [];
    _chatSeen = {};
    if (!silent) refreshRoomPanel();
  }

  function injectMock() {
    var mocks = LH.mock.generateMockBeacons();
    for (var i = 0; i < mocks.length; i++) LH.state.upsertBeacon(mocks[i]);
  }

  function startOnlineMode() {
    var deviceId = LH.security.getDeviceId();
    LH.ui.setJoinHandler(function (code) { joinRoom(code); }); // 卡片加入按钮可用
    var hintEl = rootEl && rootEl.querySelector ? rootEl.querySelector('.lighthouse-hint') : null;
    if (hintEl) hintEl.textContent = '在线模式 · 真实信标接入中';
    LH.geo.resolveGeo().then(function (g) {
      var payload = {
        id: deviceId,
        lat: g.lat, lng: g.lng,
        city: g.city, country: g.country,
        nickname: getNickname(),
        isPublic: true,
        state: LH.STATE.IDLE,
        video: null,
        viewers: 1
      };
      _myBeacon = payload;
      LH.state.upsertBeacon(payload); // 本端灯先亮
      LH.edge.startHeartbeat(payload, 30000);
      LH.edge.listenBeacons(
        function (b) { if (b && b.id !== deviceId) LH.state.upsertBeacon(b); },
        function (id) { LH.state.removeBeacon(id); } // 远端彻底消失（连 ghost 都无）→ 移除
      );
    }).catch(function () {
      if (hintEl) hintEl.textContent = '在线模式 · 地理解析失败，已退回演示数据';
      injectMock();
    });
  }

  LH.view = {
    mount: mount, unmount: unmount,
    createRoom: createRoom, joinRoom: joinRoom, leaveRoom: leaveRoom,
    bindPlayer: bindPlayer, currentVideoInfo: currentVideoInfo,
    getNickname: getNickname, setNickname: setNickname,
    setMyPublic: setMyPublic, openDiagnostics: openDiagnostics,
    sendChat: sendChat, openChat: openChat
  };
})(typeof window !== 'undefined' ? window : this);
