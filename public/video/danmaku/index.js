/*
 * Stellaflix 影视模块 — 弹幕系统入口（聚合 SFV.danmaku 各子模块）
 *
 * 子模块（均独立 <script> 引入，实际加载顺序：entry → episode → index → client → sources → engine → ui）：
 *   entry.js    DanmakuEntry / DANMAKU_TYPE / 颜色工具（移植自 Kazumi DanDanPlay 数据层）
 *   episode.js  DanmakuEpisode / DanmakuEpisodeResponse（移植自 Kazumi match 接口）
 *   engine.js   弹幕渲染引擎（纯新 JS，Flutter widget 无法移植）
 *   source-*.js 弹幕源客户端（DanDanPlay 等，经 /api/proxy）
 *
 * 合规：弹幕为运行时由用户主动拉取，出厂不内置任何源/规则。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var danmaku = (SFV.danmaku = SFV.danmaku || {});
  // 协议层就绪标记：entry.js / episode.js 必须在 index.js 之前加载（见上方加载顺序）。
  // 不再静默丢弃——若协议层缺失，明确报错以便快速定位加载顺序回归。
  var protocolReady = !!(danmaku.DanmakuEntry && danmaku.DanmakuEpisodeResponse);
  danmaku.PROTOCOL_READY = protocolReady;
  if (!protocolReady && global.console) {
    global.console.error('[SFV danmaku] 协议层未就绪：DanmakuEntry/DanmakuEpisodeResponse 缺失，' +
      '请检查 index.html 中 entry.js / episode.js 是否早于 index.js 加载');
  }
})(typeof window !== 'undefined' ? window : this);
