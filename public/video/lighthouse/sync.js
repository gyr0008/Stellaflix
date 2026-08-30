/*
 * Stellaflix 影视模块 — 灯塔模式 · 播放同步协议 (Phase 3)
 *
 * 对应文档 §6.3（含漂移补偿 · 解决 C7）/ §6.2 零源路径 B / §6.4 断线重连。
 * 依赖注入 player 适配器（抽象接口），不直接耦合 player.js，便于 vm 桩验证。
 *
 * 协议（DataChannel "sync"）：
 *  Host→Guest  { type:"sync",   currentTime, playbackRate, state, videoInfo }
 *  Guest→Host  { type:"ack",    receivedAt, currentTime }
 *  Host→Guest  { type:"switch", videoInfo }            // Host 切集/切源
 *  Host→Guest  { type:"resolve", url, sourceLabel }    // ★ 零源路径 B：下发解析地址
 *  Guest→Host  { type:"resolve-req" }                  // 零源 Guest 请求 Host 下发
 *  { type:"chat",  id, from, name, text, ts }   // 群聊（经 DataChannel，Host 中继星型拓扑）
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var LH = (SFV.lighthouse = SFV.lighthouse || {});

  var SMOOTH_THRESHOLD = 1.0;   // delta <= 1.0s → 渐进 playbackRate 微调（不硬 seek）
  var SETTLE_THRESHOLD = 0.2;   // delta < 0.2s → 恢复 1.0x（避免持续微调抖动）
  var CHASE_RATE = 1.02, SLOW_RATE = 0.98;
  var BROADCAST_MS = 2000;      // Host 每 2 秒广播一次（§6.3）

  // ---- 消息构造 ----
  function buildSync(player, videoInfo) {
    return {
      type: 'sync',
      currentTime: player.getCurrentTime ? player.getCurrentTime() : 0,
      playbackRate: player.getPlaybackRate ? player.getPlaybackRate() : 1,
      state: player.getState ? player.getState() : 'playing',
      videoInfo: videoInfo || null
    };
  }
  function buildAck(remoteRecvAt, localTime) {
    return { type: 'ack', receivedAt: remoteRecvAt, currentTime: localTime };
  }
  function buildSwitch(videoInfo) { return { type: 'switch', videoInfo: videoInfo }; }
  function buildResolve(url, sourceLabel) { return { type: 'resolve', url: url, sourceLabel: sourceLabel || '' }; }
  function buildResolveReq() { return { type: 'resolve-req' }; }
  // 群聊消息构造：`from`=设备ID（去重/中继判定），`name`=展示昵称，`id`=唯一（去重），`ts`=epoch ms
  function buildChat(text, from, name) {
    return {
      type: 'chat',
      id: (from || 'x') + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      from: from || '',
      name: name || '',
      text: text || '',
      ts: Date.now()
    };
  }

  // ---- 漂移补偿（§6.3 C7）----
  function computeDrift(local, remote) {
    var delta = Math.abs((local || 0) - (remote || 0));
    return { delta: delta, action: delta > SMOOTH_THRESHOLD ? 'hard' : 'smooth' };
  }

  // Guest 侧应用远端同步状态到本地 player
  function applySync(msg, player, opts) {
    opts = opts || {};
    var local = player.getCurrentTime ? player.getCurrentTime() : 0;
    var drift = computeDrift(local, msg.currentTime);
    if (drift.action === 'hard') {
      if (player.seek) player.seek(msg.currentTime);
      if (player.setPlaybackRate) player.setPlaybackRate(1.0);
    } else {
      if (drift.delta < SETTLE_THRESHOLD) {
        if (player.setPlaybackRate) player.setPlaybackRate(1.0);
      } else if (local < msg.currentTime) {
        if (player.setPlaybackRate) player.setPlaybackRate(CHASE_RATE);
      } else {
        if (player.setPlaybackRate) player.setPlaybackRate(SLOW_RATE);
      }
    }
    if (msg.state === 'playing' && player.play) player.play();
    else if (msg.state === 'paused' && player.pause) player.pause();
    if (opts.onSync) opts.onSync(msg, drift);
    return drift;
  }

  // ---- Host 广播调度 ----
  function startBroadcast(player, videoInfo, sendFn, intervalMs) {
    intervalMs = intervalMs || BROADCAST_MS;
    var timer = setInterval(function () {
      if (sendFn) sendFn(buildSync(player, videoInfo));
    }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return { stop: function () { clearInterval(timer); } };
  }

  // ---- 消息分发（统一入口）----
  function route(msg, handlers) {
    handlers = handlers || {};
    switch (msg && msg.type) {
      case 'sync': if (handlers.onSync) handlers.onSync(msg); break;
      case 'ack': if (handlers.onAck) handlers.onAck(msg); break;
      case 'switch': if (handlers.onSwitch) handlers.onSwitch(msg); break;
      case 'resolve': if (handlers.onResolve) handlers.onResolve(msg); break;
      case 'resolve-req': if (handlers.onResolveReq) handlers.onResolveReq(msg); break;
      case 'chat': if (handlers.onChat) handlers.onChat(msg); break;
      default: if (handlers.onUnknown) handlers.onUnknown(msg);
    }
  }

  // ---- 群聊接收处理（纯逻辑，可在 vm 验证）----
  // 星型拓扑：Guest 之间不直连，消息必须经 Host 中继。
  //  ctx = { role, myId, seen?, onAppend?, onRelay? }
  //   - seen: 可选去重表 { id:true }，重复消息直接丢弃（防中继环路/双投）；
  //   - onAppend: 追加到本端聊天记录（含发送者乐观本地追加后，接收端不再重复）；
  //   - onRelay: 仅 Host 对「他人发来」的消息中继给其他 Guest（排除原发送者自身）。
  function handleChat(msg, ctx) {
    ctx = ctx || {};
    if (!msg || msg.type !== 'chat') return { appended: false };
    var seen = ctx.seen;
    if (seen) {
      if (seen[msg.id]) return { appended: false, duplicate: true };
      seen[msg.id] = true;
    }
    if (ctx.onAppend) ctx.onAppend(msg);
    if (ctx.role === 'host' && msg.from !== ctx.myId && ctx.onRelay) {
      ctx.onRelay(msg); // Host 中继给其余 Guest（排除原发送者）
    }
    return { appended: true };
  }

  LH.sync = {
    SMOOTH_THRESHOLD: SMOOTH_THRESHOLD, SETTLE_THRESHOLD: SETTLE_THRESHOLD, BROADCAST_MS: BROADCAST_MS,
    buildSync: buildSync, buildAck: buildAck, buildSwitch: buildSwitch,
    buildResolve: buildResolve, buildResolveReq: buildResolveReq, buildChat: buildChat,
    computeDrift: computeDrift, applySync: applySync,
    startBroadcast: startBroadcast, route: route, handleChat: handleChat
  };
})(typeof window !== 'undefined' ? window : this);
