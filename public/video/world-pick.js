/*
 * Stellaflix 影视模块 — 世界页拾取分档（步骤④-2，按 hearthere 逐字移植）
 *
 * 基准：_scratch/hearthere/main.pretty.js（2026-09-27 线上包）
 *   · om()  GPU 拾取 :11691-11705（临时 _pickable → pickObject radius:0 → object.id）
 *   · _c()  CPU 最近点 :16645-16662（平方距 + 球面背侧守卫 tl=1°）
 *   · nl()  米→px :16670-16679（111320·cos(lat)）
 *   · Cc()  拾取半径分档 :16681-16688（far 50m clamp[8,70] / near 36m min15）
 *   · dy()  GPU 优先合并 :16690 · py()/fy() 门限 :16693-16697（zoom≥St−xt=11.5）
 *   · el()  点击决策 :16620-16641
 * 消费面：world-lighthouse-deck.pickStation（map/deck 注入）+ page-world 点击派发。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  // ---- 常量（逐字） ----
  var CPU_RADIUS_DEFAULT_PX = 40;  // sy :16642
  var GUARD_DEG = 1;               // tl :16643（背侧守卫阈值）
  var RADIUS_BIAS_PX = 0;          // ry :16663
  var FAR_RADIUS_M = 50;           // ay :16664
  var FAR_MIN_PX = 8;              // iy :16665
  var FAR_MAX_PX = 70;             // ly :16666
  var NEAR_RADIUS_M = 36;          // cy :16667
  var NEAR_MIN_PX = 15;            // uy :16668
  var TIER_ZOOM = 12.5;            // St :10609（与 deck 同源；不 require 避免环依赖）
  var TIER_FADE = 1;               // xt :10610
  var GPU_PICK_MIN_ZOOM = TIER_ZOOM - TIER_FADE; // fy :16693 = 11.5
  var FLY_ZOOM = 16;               // F0 :19062（wt 电影感飞行落点档）
  var FLY_PITCH = 60;              // O0 :19063
  var FLY_DURATION_MS = 2800;      // B0 :19064

  // nl()（:16670-16679）：t=[lon,lat]，e=米，n=project([lon,lat(,z)])→{x,y}
  function metersToPx(t, e, n) {
    if (e === 0) return 0;
    var o = 111320 * Math.cos(t[1] * Math.PI / 180);
    var r = e / o;
    var i = n(t);
    var l = n([t[0] + r, t[1]]);
    var c = l.x - i.x;
    var u = l.y - i.y;
    return Math.sqrt(c * c + u * u);
  }

  // Cc()（:16681-16688）：zoom 分档 + clamp；e=center [lon,lat]
  function pickRadiusPx(zoom, center, projectFn) {
    var o = TIER_ZOOM - TIER_FADE;
    var r = TIER_ZOOM + TIER_FADE;
    var i = Math.max(FAR_MIN_PX, Math.min(FAR_MAX_PX, metersToPx(center, FAR_RADIUS_M, projectFn)));
    var l = Math.max(NEAR_MIN_PX, metersToPx(center, NEAR_RADIUS_M, projectFn));
    var c;
    var t = Number(zoom);
    if (t < o) c = i;
    else if (t > r) c = l;
    else c = Math.max(i, l);
    return c + RADIUS_BIAS_PX;
  }

  // _c()（:16645-16662）：屏幕平方距最近点；guardFn(projectedPoint)→{lng,lat} 背侧守卫
  function cpuPick(point, stations, projectFn, radiusPx, guardFn) {
    var best = null;
    var bestSq = (radiusPx == null ? CPU_RADIUS_DEFAULT_PX : radiusPx);
    bestSq = bestSq * bestSq;
    for (var i = 0; i < stations.length; i++) {
      var c = stations[i];
      if (!c || !c.position) continue;
      var u = projectFn(c.position);
      if (guardFn) {
        var h = guardFn(u);
        var m = Math.abs(h.lng - c.position[0]);
        var y = Math.abs(h.lat - c.position[1]);
        if (m > GUARD_DEG || y > GUARD_DEG) continue;   // 球面背面：屏幕近但经度差 180° 之类
      }
      var dx = point.x - u.x;
      var dy = point.y - u.y;
      var d2 = dx * dx + dy * dy;
      if (d2 < bestSq) { bestSq = d2; best = c; }
    }
    return best;
  }

  // om()（:11691-11705）：GPU pickObject radius:0，拾取窗口内临时放开 _pickable
  function gpuPick(deck, point) {
    if (!deck || !deck.deckPicker) return null;
    deck.deckPicker._pickable = true;
    try {
      var picked = deck.pickObject({ x: point.x, y: point.y, radius: 0 });
      return (picked && picked.object && picked.object.id != null) ? picked.object.id : null;
    } catch (e) {
      return null;
    } finally {
      deck.deckPicker._pickable = false;
    }
  }

  // dy()（:16690）
  function mergePick(gpuId, cpuId) {
    return gpuId != null ? gpuId : (cpuId != null ? cpuId : null);
  }

  // py()（:16695-16697）
  function shouldGpuPick(zoom) {
    return Number(zoom) >= GPU_PICK_MIN_ZOOM;
  }

  // el()（:16620-16641）：点击命中后的业务决策
  function decideClick(d) {
    var c = d.myStationId != null && d.clickedStationId === d.myStationId;
    var u = d.listeningStationId === d.clickedStationId;
    if (c) return { type: 'open_station_panel', stationId: d.clickedStationId, autoTune: false };
    if (d.isBroadcasting) return { type: 'confirm_stop_broadcast', stationId: d.clickedStationId };
    return {
      type: 'open_station_panel',
      stationId: d.clickedStationId,
      autoTune: !!(d.isMusicAuthorized && !u &&
        (d.stationStatus === 'playing' || d.stationStatus === 'live_idle'))
    };
  }

  SFV.worldPick = {
    CPU_RADIUS_DEFAULT_PX: CPU_RADIUS_DEFAULT_PX,
    GUARD_DEG: GUARD_DEG,
    RADIUS_BIAS_PX: RADIUS_BIAS_PX,
    FAR_RADIUS_M: FAR_RADIUS_M,
    FAR_MIN_PX: FAR_MIN_PX,
    FAR_MAX_PX: FAR_MAX_PX,
    NEAR_RADIUS_M: NEAR_RADIUS_M,
    NEAR_MIN_PX: NEAR_MIN_PX,
    GPU_PICK_MIN_ZOOM: GPU_PICK_MIN_ZOOM,
    FLY_ZOOM: FLY_ZOOM,
    FLY_PITCH: FLY_PITCH,
    FLY_DURATION_MS: FLY_DURATION_MS,
    metersToPx: metersToPx,
    pickRadiusPx: pickRadiusPx,
    cpuPick: cpuPick,
    gpuPick: gpuPick,
    mergePick: mergePick,
    shouldGpuPick: shouldGpuPick,
    decideClick: decideClick
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SFV.worldPick;
  }
})(typeof window !== 'undefined' ? window : globalThis);
