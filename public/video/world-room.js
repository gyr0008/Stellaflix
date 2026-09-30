/*
 * Stellaflix 影视模块 — 世界页「一起看」编排（M5）
 *
 * 把 lighthouse/ 里的房间会话 + WebRTC + 进度同步接进世界页：
 *   点卡片「▶ 一起看」→ 进入该灯塔的放映房间
 *     · 房间存在 → joinAsGuest（等 Host 审批）
 *     · 房间不存在 → createAsHost（把这座灯塔变成我的放映）
 *   → RtcSession 建 P2P DataChannel
 *   → sync.js 同步播放进度（不传媒体流）
 *
 * 安全边界（延续此前修正）：
 *   · 只打本机 127.0.0.1 的 server.js，不暴露公网
 *   · 不采集/上报 IP；deviceId 是本地随机标识
 *   · 只同步播放状态，视频/音频留在各人本地播放器
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  var LH = null;
  var roomSession = null;
  var rtcSession = null;
  var container = null;
  var _nickname = '匿名灯塔';
  var _public = true;
  var _onMapRefresh = null;
  var memberPollTimer = 0;

  function ensureLH() {
    LH = SFV.lighthouse;
    return !!(LH && LH.room && LH.room.RoomSession && LH.webrtc && LH.webrtc.RtcSession);
  }

  function deviceId() {
    try {
      if (LH && LH.security && LH.security.getDeviceId) return LH.security.getDeviceId();
    } catch (e) {}
    return 'anon-' + Math.random().toString(36).slice(2, 8);
  }

  // B1：地图增量刷新 —— 建房/离房后立刻上球，不等 20s 轮询
  function refreshMap() {
    if (_onMapRefresh) {
      try { _onMapRefresh(); } catch (e) {}
      return;
    }
    // 默认路径：直接走 fetchRooms + refreshStations
    if (SFV.worldData && SFV.worldData.fetchRooms && SFV.worldLighthouse && SFV.worldLighthouse.refreshStations) {
      SFV.worldData.fetchRooms({ limit: 60 }).then(function (info) {
        if (info && info.rooms) SFV.worldLighthouse.refreshStations(info.rooms);
      }).catch(function () {});
    }
  }

  function setMapRefreshHandler(fn) {
    _onMapRefresh = typeof fn === 'function' ? fn : null;
  }

  // A3（修复轮⑥）：网络诊断数据面 —— 与 LH.ui.buildDiagPanel 的字段契约对齐
  function diagnosticsPayload() {
    var links = [];
    try {
      if (rtcSession && rtcSession.links) {
        Object.keys(rtcSession.links).forEach(function (k) {
          links.push({ peer: k, state: (rtcSession.links[k] && rtcSession.links[k].status) || 'unknown' });
        });
      }
    } catch (e) {}
    var stun = [];
    try {
      ((LH && LH.config && LH.config.iceServers) || []).forEach(function (s) {
        if (s && s.urls) stun.push(String(s.urls));
      });
    } catch (e) {}
    var endpoint = '';
    try {
      endpoint = (LH && LH.config && LH.config.localEdge) ||
        ((typeof location !== 'undefined' && location.origin ? location.origin : 'http://127.0.0.1:3000') + '/api');
    } catch (e) {}
    var vid = null;
    try { vid = SFV.worldSync && SFV.worldSync.currentVideo; } catch (e) {}
    return {
      mode: '本地信令 + WebRTC 直连',
      online: !!(roomSession && roomSession.code),
      endpoint: endpoint,
      stun: stun,
      broadcasting: !!(rtcSession && roomSession && roomSession.role === 'host'),
      resolveUrl: vid ? (vid.url || vid.title || null) : null,
      links: links
    };
  }

  function showDiagnosticsPanel() {
    if (!container || !LH || !LH.ui || !LH.ui.showDiagnostics) return;
    try { LH.ui.showDiagnostics(diagnosticsPayload(), container); } catch (e) {}
  }

  // 由 RoomSession 的事件刷新面板
  function buildPanelSession() {
    // C2：当前播放信息
    var vid = null;
    try {
      if (SFV.worldSync && SFV.worldSync.getCurrentVideoInfo) vid = SFV.worldSync.getCurrentVideoInfo();
    } catch (e) {}
    return {
      role: roomSession ? roomSession.role : 'guest',
      code: roomSession ? roomSession.code : '',
      myNickname: _nickname,
      statusText: statusText(),
      members: (roomSession && roomSession.members) || [],
      isPublic: _public,
      currentVideo: vid,
      onCopy: function (code) {
        try {
          if (global.navigator && global.navigator.clipboard) global.navigator.clipboard.writeText(code);
        } catch (e) {}
        if (SFV.worldUi) SFV.worldUi.toast('房间码已复制：' + code);
      },
      onLeave: function () { leave(); },
      onNickname: function (v) {
        _nickname = String(v || '').slice(0, 16) || '匿名灯塔';
        refreshPanel();
      },
      onTogglePrivacy: function () {
        _public = !_public;
        refreshPanel();
      },
      onDiagnostics: function () { showDiagnosticsPanel(); },
      onOpenChat: function () { openChat(); },
      onApprove: function (guestId) {
        if (roomSession && roomSession.approve) roomSession.approve(guestId);
      },
      onReject: function (guestId) {
        if (roomSession && roomSession.reject) roomSession.reject(guestId);
      }
    };
  }

  // C1：群聊面板
  function chatData() {
    return {
      messages: (SFV.worldSync && SFV.worldSync.chatLog) ? SFV.worldSync.chatLog.slice() : [],
      onSend: function (t) {
        if (SFV.worldSync && SFV.worldSync.sendChat) SFV.worldSync.sendChat(t);
        // A3（修复轮⑥）：无链路时 sendViaRtc 静默丢弃 —— 给用户诚实反馈
        var n = 0;
        try { if (rtcSession && rtcSession.links) n = Object.keys(rtcSession.links).length; } catch (e) {}
        if (!n && SFV.worldUi && SFV.worldUi.toast) {
          SFV.worldUi.toast('已发送 · 房间里暂时没有其他观众，消息只有自己可见');
        }
      },
      onClose: function () { if (LH && LH.ui && LH.ui.hideChat) LH.ui.hideChat(); }
    };
  }

  function openChat() {
    if (!container || !LH || !LH.ui || !LH.ui.showChat) return;
    try { LH.ui.showChat(chatData(), container); } catch (e) {}
  }

  function refreshChatPanel() {
    if (!LH || !LH.ui || !LH.ui.isChatOpen) return;
    if (LH.ui.isChatOpen() && LH.ui.updateChat) {
      try { LH.ui.updateChat(chatData()); } catch (e) {}
    }
  }

  function statusText() {
    if (!roomSession) return '';
    switch (roomSession.status) {
      case 'creating': return '正在创建放映…';
      case 'pending':  return '等待主播确认…';
      case 'accepted': return '已加入，正在建立连接…';
      case 'active':   return roomSession.role === 'host' ? '放映中，等待他人加入' : '已连接，一起看';
      case 'full':     return '房间已满（最多 4 人）';
      case 'rejected': return '未能加入：被拒绝';
      case 'closed':   return '放映已结束';
      default:         return '';
    }
  }

  function refreshPanel() {
    if (!container || !LH || !LH.ui || !LH.ui.updateRoomPanel) return;
    try { LH.ui.updateRoomPanel(buildPanelSession()); } catch (e) {}
    // B2：同步状态上卡片（人数 + 播放状态）
    updateCardLive();
  }

  // B2：算出卡片上的实时状态文案
  function updateCardLive() {
    if (!SFV.worldUi || !SFV.worldUi.updateCardLive) return;
    if (!roomSession) {
      SFV.worldUi.updateCardLive('');
      return;
    }
    var n = (roomSession.members || []).filter(function (m) {
      return m.status === 'accepted' || m.status === 'connected';
    }).length + 1; // +1 = 自己
    var playing = '';
    try {
      if (SFV.worldSync && SFV.worldSync.getPlaybackState) {
        playing = SFV.worldSync.getPlaybackState();
      }
    } catch (e) {}
    var roleText = roomSession.role === 'host' ? '主播' : '观众';
    var playText = playing === 'playing' ? ' · 同步播放中' : (playing === 'paused' ? ' · 已暂停' : '');
    SFV.worldUi.updateCardLive(roleText + ' · ' + n + ' 人' + playText);
  }

  function openPanel() {
    if (!container || !LH || !LH.ui || !LH.ui.showRoomPanel) return;
    try { LH.ui.showRoomPanel(buildPanelSession(), container); } catch (e) {}
  }

  // ---- RTC ----
  function startRtc() {
    if (!roomSession || !roomSession.code) return;
    if (!LH.webrtc || !LH.webrtc.RtcSession) return;
    // A3（修复轮⑥）：status=active 事件与建房 .then 双入口都触发 startRtc，
    // 不设防会开出两个 RtcSession = 两份 250ms 信令轮询（限流风暴燃料）
    if (rtcSession) return;
    try {
      rtcSession = new LH.webrtc.RtcSession({
        role: roomSession.role,
        code: roomSession.code,
        deviceId: deviceId(),
        onLinkState: function (state, peerId) {
          if (SFV.worldUi) {
            if (state === 'connected') SFV.worldUi.toast('已与 ' + (peerId || '对方') + ' 建立连接');
          }
          refreshPanel();
        },
        onMessage: function (raw) {
          // M5d：播放同步 / 群聊 / 切集 —— 交给 LH.sync 协议处理
          if (SFV.worldSync && SFV.worldSync.onMessage) SFV.worldSync.onMessage(raw);
        }
      });
      rtcSession.start();
      // M5d：同步编排 —— 绑播放器；Host 自动开始广播进度
      if (SFV.worldSync) {
        SFV.worldSync.setMyId(deviceId());
        SFV.worldSync.bindPlayer();
        // B2：同步事件驱动卡片实时状态 + C1：群聊消息刷新
        if (SFV.worldSync.onUpdate) {
          SFV.worldSync.onUpdate(function (evt) {
            updateCardLive();
            if (evt && evt.type === 'chat') refreshChatPanel();
          });
        }
        if (roomSession.role === 'host') SFV.worldSync.startBroadcast();
      }
    } catch (e) {
      console.warn('[world-room] RTC 启动失败', e);
    }
  }

  // ---- 成员轮询（A3 修复轮⑥）----
  // roomSession.members 此前只初始化从不填充：Host 面板永远「等待他人加入…」，
  // 接受/拒绝按钮根本不渲染；Guest 审批通过后也无人告知、卡在 pending 不建 RTC。
  // 3s 拉 GET /api/room/:code：已存在的房间在 A1 后不走限流，可安全轮询。
  function pollRoomState() {
    if (!roomSession || !roomSession.code) return;
    if (!LH || !LH.edge || !LH.edge.getRoom) return;
    var code = roomSession.code;
    LH.edge.getRoom(code).then(function (room) {
      if (!roomSession || roomSession.code !== code) return;
      if (!room || !room.exists) { onRoomGone(); return; }
      var self = deviceId();
      var guests = (room.guests || [])
        .filter(function (g) { return g.status !== 'rejected'; })
        .map(function (g) { return { id: g.deviceId, name: g.nickname || '匿名灯塔', status: g.status }; });
      var changed = JSON.stringify(guests) !== JSON.stringify(roomSession.members || []);
      roomSession.members = guests;
      if (roomSession.role === 'guest') {
        var mine = null;
        (room.guests || []).forEach(function (g) { if (g.deviceId === self) mine = g; });
        if (mine && mine.status === 'accepted' && roomSession.status !== 'active') {
          roomSession._set('active'); // 事件处理器负责 startRtc + refreshPanel
          return;
        }
        if (mine && mine.status === 'rejected') {
          roomSession._set('rejected', { reason: 'host-rejected' });
          return;
        }
      }
      if (changed) refreshPanel();
    }).catch(function (err) {
      if (err && err.code === 404 && roomSession && roomSession.code === code) onRoomGone();
    });
  }
  function startMemberPolling() {
    stopMemberPolling();
    if (!LH || !LH.edge || !LH.edge.getRoom) return;
    memberPollTimer = setInterval(pollRoomState, 3000);
  }
  function stopMemberPolling() {
    if (memberPollTimer) { clearInterval(memberPollTimer); memberPollTimer = 0; }
  }

  // ---- 主流程 ----
  /**
   * 进入「一起看」
   * @param {object} st  信标 { id, roomId, name, lon, lat, title, people }
   * @param {HTMLElement} panelHost 房间面板挂载点
   */
  function joinWatchRoom(st, panelHost) {
    container = panelHost || container;
    if (!ensureLH()) {
      if (SFV.worldUi) SFV.worldUi.toast('房间模块未加载');
      return Promise.reject(new Error('LH_MISSING'));
    }
    if (roomSession) {
      if (SFV.worldUi) SFV.worldUi.toast('你已在一个放映房间里');
      openPanel();
      return Promise.resolve(roomSession);
    }

    roomSession = new LH.room.RoomSession();
    roomSession.on(function (evt) {
      if (!evt) return;
      if (evt.type === 'status') {
        if (evt.status === 'active' && roomSession.role === 'guest' && !rtcSession) startRtc();
        if (evt.status === 'rejected') {
          if (SFV.worldUi) SFV.worldUi.toast('未能加入：' + (evt.reason || '被拒绝'));
        }
        if (evt.status === 'full' && SFV.worldUi) SFV.worldUi.toast('房间已满（最多 4 人）');
        refreshPanel();
      }
    });

    var code = st && (st.roomId || st.id);
    return roomSession.joinAsGuest(code, { nickname: _nickname }).then(function () {
      openPanel();
      // A3：观众侧轮询审批结果（accepted → 自动建 RTC）
      startMemberPolling();
      return roomSession;
    }).catch(function (err) {
      // 房间不存在 → 我来当主播，把这座灯塔变成我的放映
      var msg = (err && err.message) || '';
      if (msg !== 'not-found' && msg !== 'invalid-code') {
        if (SFV.worldUi) SFV.worldUi.toast('进入失败：' + msg);
        roomSession = null;
        return Promise.reject(err);
      }
      return roomSession.createAsHost({
        discovery: true,
        name: st && st.name || '放映房间',
        title: st && st.title || '一起看',
        lon: st && st.lon || 0,
        lat: st && st.lat || 0
      }).then(function () {
        if (SFV.worldUi) SFV.worldUi.toast('已开启放映，房间码 ' + roomSession.code);
        startRtc();
        openPanel();
        // B1：建房后立刻上球
        refreshMap();
        // A3：主播侧轮询成员，pending 观众进面板
        startMemberPolling();
        return roomSession;
      }).catch(function (e2) {
        if (SFV.worldUi) SFV.worldUi.toast('创建失败：' + (e2 && e2.message || e2));
        roomSession = null;
        return Promise.reject(e2);
      });
    });
  }

  /**
   * A 段：主动创建放映（右下角「+ 创建放映」入口）
   * @param {object} opts
   *   title     片名
   *   name      城市 / 地点名
   *   lon, lat  城市中心坐标（城市级，不含精确位置）
   *   discovery 是否出现在他人世界地图（false = 仅房间码）
   *   nickname  昵称
   * @param {HTMLElement} panelHost 房间面板挂载点
   */
  function createHost(opts, panelHost) {
    opts = opts || {};
    container = panelHost || container;
    if (!ensureLH()) {
      if (SFV.worldUi) SFV.worldUi.toast('房间模块未加载');
      return Promise.reject(new Error('LH_MISSING'));
    }
    if (roomSession) {
      if (SFV.worldUi) SFV.worldUi.toast('你已在一个放映房间里');
      openPanel();
      return Promise.resolve(roomSession);
    }

    if (opts.nickname) _nickname = String(opts.nickname).slice(0, 16) || '匿名灯塔';
    _public = opts.discovery !== false;

    roomSession = new LH.room.RoomSession();
    roomSession.on(function (evt) {
      if (!evt) return;
      if (evt.type === 'status') {
        if (evt.status === 'active' && roomSession.role === 'host' && !rtcSession) startRtc();
        if (evt.status === 'full' && SFV.worldUi) SFV.worldUi.toast('房间已满（最多 4 人）');
        refreshPanel();
      }
    });

    return roomSession.createAsHost({
      discovery: opts.discovery !== false,
      title: opts.title || '一起看',
      name: opts.name || '放映房间',
      lon: Number(opts.lon) || 0,
      lat: Number(opts.lat) || 0
    }).then(function () {
      if (SFV.worldUi) {
        SFV.worldUi.toast('已开启放映，房间码 ' + roomSession.code);
      }
      // A5：建完自动开始广播播放进度
      startRtc();
      openPanel();
      // B1：建房后立刻上球，不等 20s 轮询
      refreshMap();
      // A3：主播侧轮询成员，pending 观众进面板
      startMemberPolling();
      return roomSession;
    }).catch(function (e) {
      if (SFV.worldUi) SFV.worldUi.toast('创建失败：' + (e && e.message || e));
      roomSession = null;
      return Promise.reject(e);
    });
  }

  /**
   * B3：结束放映 / 离开房间
   * 主播 → 服务端 close 房间（从地图移除）
   * 双方 → 停广播、停 RTC、关面板、刷地图
   */
  function leave() {
    var wasHost = roomSession && roomSession.role === 'host';
    var code = roomSession && roomSession.code;
    // B3：主播先关服务端房间，让它从地图消失
    // A3（修复轮⑥）：removeRoom 失败不再被吞 —— 提示用户房间可能仍在
    var closeP = null;
    if (wasHost && code && LH && LH.edge && LH.edge.removeRoom) {
      try { closeP = LH.edge.removeRoom(code); } catch (e) {}
    }
    cleanupLocal(wasHost ? '放映已结束' : '已离开放映房间', closeP);
  }

  function cleanupLocal(okMsg, closeP) {
    stopMemberPolling();
    if (SFV.worldSync && typeof SFV.worldSync.reset === 'function') SFV.worldSync.reset();
    try { if (rtcSession && rtcSession.close) rtcSession.close(); } catch (e) {}
    rtcSession = null;
    if (LH && LH.ui && LH.ui.hideRoomPanel) { try { LH.ui.hideRoomPanel(); } catch (e) {} }
    // 修复轮⑦：聊天/诊断浮层挂在同一容器，房间面板收起后它们会变孤儿悬浮（E2E 实测）
    if (LH && LH.ui && LH.ui.isChatOpen && LH.ui.isChatOpen() && LH.ui.hideChat) { try { LH.ui.hideChat(); } catch (e) {} }
    if (LH && LH.ui && LH.ui.isDiagnosticsOpen && LH.ui.isDiagnosticsOpen() && LH.ui.hideDiagnostics) { try { LH.ui.hideDiagnostics(); } catch (e) {} }
    roomSession = null;
    // B1：刷地图，让已关闭的房间从球上消失
    refreshMap();
    // B2：清掉卡片实时状态
    updateCardLive();
    if (closeP && typeof closeP.then === 'function') {
      closeP.then(function (ok) {
        if (SFV.worldUi) {
          SFV.worldUi.toast(ok === false
            ? '结束放映失败：房间未能从服务端删除，灯塔可能仍对他人可见，请稍后重试'
            : okMsg);
        }
      }, function () {
        if (SFV.worldUi) SFV.worldUi.toast('结束放映失败：房间未能从服务端删除，请稍后重试');
      });
    } else if (SFV.worldUi) {
      SFV.worldUi.toast(okMsg);
    }
  }

  // 轮询发现服务端房间已消失（重启/TTL/主播关闭）：本地同步收场
  function onRoomGone() {
    var wasHost = roomSession && roomSession.role === 'host';
    cleanupLocal(wasHost ? '放映已结束' : '该放映已结束');
  }

  SFV.worldRoom = {
    joinWatchRoom: joinWatchRoom,
    createHost: createHost,
    leave: leave,
    refreshPanel: refreshPanel,
    refreshMap: refreshMap,
    setMapRefreshHandler: setMapRefreshHandler,
    get session() { return roomSession; },
    get rtc() { return rtcSession; },
    // world-sync.sendChat 一直引用 worldRoom.nickname，此前无导出恒走 ||'我' 兜底
    get nickname() { return _nickname; },
  };
})(typeof window !== 'undefined' ? window : this);
