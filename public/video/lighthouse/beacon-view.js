/*
 * Stellaflix 影视模块 — 灯塔模式 · 灯塔 deck.gl 发光图层 (Phase 4 对照 hearthere.live 重建)
 *
 * 对应文档 §4.9 灯塔视觉模型。改用 deck.gl GlobeView 渲染真 3D 地球后，
 * 信标不再用 Three.js 叠加层，而是作为 deck.gl 图层绘制在地球表面之上。
 *
 * 视觉对标 hearthere.live 的自定义 GlowScatterplotLayer（星点辉光）：
 *   - 参考站片元着色器：combinedGlow = core*0.8 + innerGlow*0.15 + outerGlow*0.05
 *   - 我们用「halo（大半径·低透明度）+ core（小半径·高透明度）」两层 ScatterplotLayer
 *     在 GlobeView 上近似同一观感：核心明亮、外圈微弱光晕。
 *
 * 状态 → 配色（贴近参考站：品牌紫 #C061FF、在线青 #5CE1E6、幽灵灰 #55607A）：
 *   - 离线/幽灵 → 暗淡灰
 *   - 在线(IDLE/在线) → 青
 *   - 正在观看/主播(PLAYING/JOINED_HOST) → 品牌紫
 *   - 观众(JOINED_GUEST) → 青
 *   - 暂停(PAUSED) → 琥珀（区别于播放/在线）
 *
 * 不依赖 DOM / THREE；运行时从全局 deck 取 ScatterplotLayer。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var LH = (SFV.lighthouse = SFV.lighthouse || {});
  var STATE = LH.STATE;

  // 状态 → RGB（0-255）。禁用品牌金，统一参考站紫/青/琥珀/灰体系。
  var COLOR = {
    OFFLINE: [85, 96, 122],       // 暗蓝灰（与参考站 ghost 接近）
    IDLE: [92, 225, 230],         // 青：仅在线（参考站在线/直播青 #5CE1E6）
    PLAYING: [192, 97, 255],      // 品牌紫：正在看（参考站 brand #C061FF）
    PAUSED: [240, 176, 80],       // 琥珀：暂停（区别于播放/在线）
    JOINED_HOST: [192, 97, 255],  // 品牌紫：主播
    JOINED_GUEST: [92, 225, 230], // 青：观众
    GHOST: [85, 96, 122]          // 暗蓝灰：幽灵回放
  };
  var FALLBACK = [85, 96, 122];

  function colorForState(state) {
    var c = COLOR[state];
    if (c) return c;
    if (state === STATE.GHOST) return COLOR.GHOST;
    return FALLBACK;
  }
  function isGhost(beacon) {
    return beacon.state === STATE.GHOST || beacon.isGhost === true;
  }

  // 信标坐标：海拔 80m（与参考站 [lng,lat,80] 一致），GlobeView 上微微浮起
  function positionOf(b) {
    return [b.lng, b.lat, 80];
  }

  // 根据状态/缩放/脉冲返回基础像素半径
  function baseRadius(b, zoom, pulse) {
    var ghost = isGhost(b);
    var playing = b.state === STATE.PLAYING || b.state === STATE.JOINED_HOST;
    var r = ghost ? 7 : (playing ? 13 : 10);
    // 脉冲：活跃非暂停非 ghost 态轻微呼吸（PLAYING 幅度最大）
    if (pulse && !ghost && b.state !== STATE.PAUSED) {
      var amp = b.state === STATE.PLAYING ? 0.18 : 0.10;
      r *= 1 + amp * pulse;
    }
    return r;
  }

  /*
   * 构建信标 deck.gl 图层数组。
   * 返回 [haloLayer, coreLayer]：
   *   - halo：大半径、低透明度、不可拾取（外圈光晕）
   *   - core：小半径、高透明度、可拾取（点击命中）
   * opts.time  ：毫秒时间戳，驱动脉冲（updateTriggers 触发逐帧重算 getRadius/getFillColor）
   * opts.onPick：Deck onClick 已统一处理拾取，这里 core 层也挂 onClick 兜底
   */
  function buildBeaconLayers(beacons, opts) {
    opts = opts || {};
    var time = opts.time || 0;
    var zoom = opts.zoom || 0.6;
    var deck = global.deck;
    if (!deck || !deck.ScatterplotLayer || !beacons || !beacons.length) return [];

    // 脉冲系数 [-1,1]（每 ~3s 一个周期）
    var pulse = Math.sin((time / 3000) * Math.PI * 2);

    var halo = new deck.ScatterplotLayer({
      id: 'beacon-halo',
      data: beacons,
      getPosition: positionOf,
      getRadius: function (b) { return baseRadius(b, zoom, pulse) * 2.6; },
      getFillColor: function (b) {
        var c = colorForState(b.state);
        var ghost = isGhost(b);
        var a = ghost ? 28 : (b.state === STATE.IDLE ? 60 : 80);
        return [c[0], c[1], c[2], a];
      },
      radiusUnits: 'pixels',
      radiusMinPixels: 6, radiusMaxPixels: 90,
      pickable: false,
      stroked: false, filled: true,
      parameters: { depthTest: false },
      updateTriggers: {
        getRadius: [time, zoom],
        getFillColor: [time]
      }
    });

    var core = new deck.ScatterplotLayer({
      id: 'beacon-core',
      data: beacons,
      getPosition: positionOf,
      getRadius: function (b) { return baseRadius(b, zoom, pulse); },
      getFillColor: function (b) {
        var c = colorForState(b.state);
        var ghost = isGhost(b);
        var a = ghost ? 150 : 235;
        return [c[0], c[1], c[2], a];
      },
      radiusUnits: 'pixels',
      radiusMinPixels: 4, radiusMaxPixels: 40,
      pickable: true,
      stroked: false, filled: true,
      parameters: { depthTest: false },
      updateTriggers: {
        getRadius: [time, zoom],
        getFillColor: [time]
      }
    });

    return [halo, core];
  }

  LH.beaconView = {
    buildBeaconLayers: buildBeaconLayers,
    colorForState: colorForState,
    COLOR: COLOR,
    positionOf: positionOf,
    isGhost: isGhost
  };
})(typeof window !== 'undefined' ? window : this);
