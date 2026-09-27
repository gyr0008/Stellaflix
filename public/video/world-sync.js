/*
 * Stellaflix 影视模块 — 世界页「一起看」播放同步（M5d）
 *
 * 把 lighthouse/sync.js 的漂移补偿协议接到 SFV.player：
 *   Host  每 2s 广播 { currentTime, playbackRate, state }
 *   Guest 收到 → LH.sync.applySync：误差 >1s 硬 seek，<1s 用 1.02x/0.98x 微调
 *   切集  buildSwitch → 对端换片
 *   群聊  buildChat + Host 星型中继
 *
 * **只同步播放状态，不传媒体流**——视频/音频仍留在各人本地播放器。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  var LH = null;
  var player = {};            // player 适配器（抽象接口，便于 vm 桩）
  var broadcastCtl = null;
  var currentVideo = null;
  var chatLog = [];
  var chatSeen = {};
  var listeners = [];
  var myId = '';

  function ensureLH() {
    LH = SFV.lighthouse;
    return !!(LH && LH.sync && LH.sync.startBroadcast);
  }

  // ============================================================
  //  播放器适配器（LH.sync 需要的最小接口）
  // ============================================================
  function defaultAdapter() {
    var v = null;
    try {
      if (SFV.player && typeof SFV.player.getVideoEl === 'function') v = SFV.player.getVideoEl();
    } catch (e) {}
    if (!v && typeof global.document !== 'undefined') {
      v = global.document.querySelector('video');
    }
    return {
      getCurrentTime: function () { return (v && Number(v.currentTime)) || 0; },
      getPlaybackRate: function () { return (v && Number(v.playbackRate)) || 1; },
      getState: function () { return (v && !v.paused) ? 'playing' : 'paused'; },
      seek: function (t) {
        if (v) { try { v.currentTime = Number(t) || 0; return true; } catch (e) {} }
        if (SFV.player && SFV.player.seek) { try { SFV.player.seek(Number(t) || 0); return true; } catch (e) {} }
        return false;
      },
      setPlaybackRate: function (r) {
        if (v) { try { v.playbackRate = Number(r) || 1; } catch (e) {} }
        if (SFV.player && SFV.player.setSpeed) { try { SFV.player.setSpeed(Number(r) || 1); } catch (e) {} }
      },
      play: function () {
        if (v && v.play) { try { v.play(); return; } catch (e) {} }
        if (SFV.player && SFV.player.togglePlay) { try { SFV.player.togglePlay(); } catch (e) {} }
      },
      pause: function () {
        if (v && v.pause) { try { v.pause(); return; } catch (e) {} }
        if (SFV.player && SFV.player.togglePlay) { try { SFV.player.togglePlay(); } catch (e) {} }
      }
    };
  }

  function bindPlayer(adapter) {
    player = adapter || defaultAdapter();
    return player;
  }

  function emit(evt) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](evt); } catch (e) {}
    }
  }
  function onUpdate(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  // ============================================================
  //  发送：经 RTC DataChannel（不走服务器）
  // ============================================================
  function sendViaRtc(msg) {
    var rtc = SFV.worldRoom && SFV.worldRoom.rtc;
    if (!rtc) return false;
    try {
      if (typeof rtc.send === 'function') { rtc.send(JSON.stringify(msg)); return true; }
      if (rtc.session && typeof rtc.session.send === 'function') {
        rtc.session.send(JSON.stringify(msg)); return true;
      }
    } catch (e) {}
    return false;
  }

  // ============================================================
  //  Host：广播
  // ============================================================
  function startBroadcast(videoInfo) {
    if (!ensureLH()) return null;
    stopBroadcast();
    if (videoInfo) currentVideo = videoInfo;
    broadcastCtl = LH.sync.startBroadcast(player, currentVideo, function (msg) {
      detectVideoChange(); // C2：自动检测换片并广播
      sendViaRtc(msg);
      emit({ type: 'broadcast', msg });
    }, LH.sync.BROADCAST_MS);
    return broadcastCtl;
  }
  function stopBroadcast() {
    if (broadcastCtl && broadcastCtl.stop) { try { broadcastCtl.stop(); } catch (e) {} }
    broadcastCtl = null;
  }

  // ============================================================
  //  Guest：应用远端同步
  // ============================================================
  function applyRemoteSync(msg) {
    if (!ensureLH()) return null;
    var drift = LH.sync.applySync(msg, player, {
      onSync: function (m, d) { emit({ type: 'sync', msg: m, drift: d }); }
    });
    return drift;
  }

  // ============================================================
  //  消息入口（由 world-room.js 的 RTC onMessage 调用）
  // ============================================================
  function onMessage(raw) {
    if (!ensureLH()) return;
    var msg = raw;
    if (typeof raw === 'string') {
      try { msg = JSON.parse(raw); } catch (e) { return; }
    }
    if (!msg || typeof msg !== 'object') return;

    LH.sync.route(msg, {
      onSync: function (m) {
        // Host 不应用自己的广播；Guest 才对齐
        var role = SFV.worldRoom && SFV.worldRoom.session && SFV.worldRoom.session.role;
        if (role === 'host') return;
        applyRemoteSync(m);
      },
      onAck: function (m) { emit({ type: 'ack', msg: m }); },
      onSwitch: function (m) {
        currentVideo = m && m.videoInfo || currentVideo;
        if (SFV.player && SFV.player.openUrl && currentVideo && currentVideo.url) {
          try { SFV.player.openUrl(currentVideo.url); } catch (e) {}
        }
        emit({ type: 'switch', msg: m });
      },
      onChat: function (m) {
        if (!ensureLH()) return;
        LH.sync.handleChat(m, {
          role: (SFV.worldRoom && SFV.worldRoom.session && SFV.worldRoom.session.role) || 'guest',
          myId: myId,
          seen: chatSeen,
          onAppend: function (c) { chatLog.push(c); emit({ type: 'chat', msg: c }); },
          onRelay: function (c) { sendViaRtc(c); }
        });
      }
    });
  }

  function sendChat(text) {
    if (!ensureLH() || !text) return null;
    var msg = LH.sync.buildChat(text, myId, (SFV.worldRoom && SFV.worldRoom.nickname) || '我');
    chatSeen[msg.id] = true;
    chatLog.push(msg);
    emit({ type: 'chat', msg: msg });
    sendViaRtc(msg);
    return msg;
  }

  function switchVideo(videoInfo) {
    if (!ensureLH()) return null;
    currentVideo = videoInfo;
    var msg = LH.sync.buildSwitch(videoInfo);
    sendViaRtc(msg);
    if (SFV.player && SFV.player.openUrl && videoInfo && videoInfo.url) {
      try { SFV.player.openUrl(videoInfo.url); } catch (e) {}
    }
    emit({ type: 'switch', msg: msg });
    return msg;
  }

  // C2：本端换片通知（Host 换集时调用，自动广播给 Guest）
  function notifyVideoChange(videoInfo) {
    if (!videoInfo) return null;
    var prevUrl = currentVideo && currentVideo.url;
    if (videoInfo.url === prevUrl) return null; // 未变
    return switchVideo(videoInfo);
  }

  // C2：查询当前播放的片名/URL
  function getCurrentVideoInfo() {
    return currentVideo;
  }

  // C2：自动检测换片 —— 比较 player 当前 URL，变了就广播 switch
  var _lastBroadcastUrl = '';
  function detectVideoChange() {
    try {
      var v = (SFV.player && SFV.player.getVideoEl && SFV.player.getVideoEl()) ||
              (global.document && global.document.querySelector('video'));
      var url = v && v.currentSrc;
      if (!url) return;
      if (_lastBroadcastUrl && url !== _lastBroadcastUrl) {
        notifyVideoChange({ url: url, title: (currentVideo && currentVideo.title) || '' });
      }
      _lastBroadcastUrl = url;
    } catch (e) {}
  }

  function setMyId(id) { myId = id || ''; }

  function reset() {
    stopBroadcast();
    chatLog = [];
    chatSeen = {};
    currentVideo = null;
    _lastBroadcastUrl = '';
  }

  // B2：查询当前播放状态（playing / paused / idle）
  function getPlaybackState() {
    try {
      if (player && typeof player.getState === 'function') return player.getState();
    } catch (e) {}
    return 'idle';
  }

  // ============================================================
  //  Task 7：queue_update 语义 + 本地推算播放位置
  //  语义移植自 HearThere main.pretty.js :14490-14510（HearThere「世界在听」
  //  → Stellaflix「世界在看」）。纯函数、无竞态；发送面静默失败绝不 throw。
  // ============================================================

  /**
   * status 推断（:14506）：终态/空位事件 → idle，其余 → playing。
   * @param {{type?:string, current_position?:number|null}} evt queue_update 载荷
   */
  function inferStatus(evt) {
    var t = evt && evt.type;
    if (t === 'playlist_replaced' || t === 'playlist_completed' || t === 'broadcast_ended') return 'idle';
    if (t === 'queue_reorder' && evt.current_position == null) return 'idle';
    return 'playing';
  }

  /**
   * 本地推算当前播放位置（不起计时器，纯算术）。
   * start_time 是「播放列表起点」语义：
   *   elapsed = nowMs - start_time - Σ_{k < current_position} duration_ms[k]
   * 例：queue=[60s,90s], current_position=1, start_time=1000,
   *     now=1000+60000+5000 → elapsedMs=5000。
   * 钳制：elapsed<0 → 0；elapsed 超过当前轨时长 → clamp 到该轨 duration_ms。
   * 缺 queue / current_position / start_time → null（如 queue_reorder 空闲态）。
   * 兼容 GET /api/rooms 列表项的 playlist 嵌套面。
   */
  function currentTrack(room, nowMs) {
    if (!room || typeof nowMs !== 'number' || !isFinite(nowMs)) return null;
    var src = Array.isArray(room.queue) ? room : room.playlist;
    if (!src) return null;
    var queue = src.queue;
    var pos = src.current_position;
    var start = src.start_time;
    if (!Array.isArray(queue) || !queue.length) return null;
    if (typeof pos !== 'number' || !isFinite(pos) || pos < 0 || pos >= queue.length) return null;
    if (typeof start !== 'number' || !isFinite(start)) return null;
    var lead = 0;
    for (var k = 0; k < pos; k++) lead += Number(queue[k] && queue[k].duration_ms) || 0;
    var elapsed = nowMs - start - lead;
    var dur = Number(queue[pos] && queue[pos].duration_ms) || 0;
    if (!(elapsed > 0)) elapsed = 0;
    if (dur > 0 && elapsed > dur) elapsed = dur;
    return { index: pos, title: String((queue[pos] && queue[pos].title) || ''), elapsedMs: elapsed };
  }

  // ---- Host → server.js 广播（沿用 edge-local 的 /api/room/:code/* POST 面） ----
  function roomCodeForPublish() {
    var s = SFV.worldRoom && SFV.worldRoom.session;
    return s && s.code ? String(s.code) : '';
  }

  function deviceIdForPublish() {
    var s = SFV.worldRoom && SFV.worldRoom.session;
    if (s && s.deviceId) return String(s.deviceId);
    try {
      var sec = SFV.lighthouse && SFV.lighthouse.security;
      if (sec && typeof sec.getDeviceId === 'function') return String(sec.getDeviceId());
    } catch (e) {}
    return 'anon';
  }

  // baseUrl 规则与 lighthouse/edge-local.js 一致：同源优先，兜底本机 3000
  function roomApiUrl(code, sub) {
    var base = 'http://127.0.0.1:3000/api';
    if (typeof global.location !== 'undefined' && global.location && global.location.origin) {
      base = global.location.origin + '/api';
    }
    return base + '/room/' + encodeURIComponent(code) + '/' + sub;
  }

  // 投递失败（403/断网/无 fetch/无房间）一律静默 resolve(false)，绝不打扰 UI
  function postRoom(sub, body) {
    var code = roomCodeForPublish();
    if (!code || typeof global.fetch !== 'function') return Promise.resolve(false);
    var payload = body || {};
    payload.deviceId = deviceIdForPublish();
    try {
      return Promise.resolve(global.fetch(roomApiUrl(code, sub), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-device-id': deviceIdForPublish() },
        body: JSON.stringify(payload)
      })).then(function (r) { return !!(r && r.ok); }, function () { return false; });
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  /**
   * Host 广播片单进度。evt = { type, queue, current_position, start_time }
   * 载荷形状对齐 HearThere queue_update（host_sent_at 由本端盖戳）。
   */
  function publishQueueUpdate(evt) {
    evt = evt || {};
    return postRoom('queue-update', {
      type: String(evt.type || 'queue_update'),
      queue: Array.isArray(evt.queue) ? evt.queue : [],
      current_position: evt.current_position == null ? null : Number(evt.current_position),
      start_time: Number(evt.start_time) || 0,
      host_sent_at: Date.now()
    });
  }

  /** Host 心跳：只刷新服务端 lastHeartbeat，不动其它字段。 */
  function publishHeartbeat() {
    return postRoom('heartbeat', {});
  }

  SFV.worldSync = {
    bindPlayer: bindPlayer,
    startBroadcast: startBroadcast,
    stopBroadcast: stopBroadcast,
    applyRemoteSync: applyRemoteSync,
    onMessage: onMessage,
    sendChat: sendChat,
    switchVideo: switchVideo,
    notifyVideoChange: notifyVideoChange,
    detectVideoChange: detectVideoChange,
    setMyId: setMyId,
    reset: reset,
    onUpdate: onUpdate,
    getPlaybackState: getPlaybackState,
    getCurrentVideoInfo: getCurrentVideoInfo,
    // Task 7：queue_update 语义 + 进度推算 + Host 发送面
    currentTrack: currentTrack,
    inferStatus: inferStatus,
    publishQueueUpdate: publishQueueUpdate,
    publishHeartbeat: publishHeartbeat,
    get chatLog() { return chatLog; },
    get currentVideo() { return currentVideo; }
  };
})(typeof window !== 'undefined' ? window : this);
