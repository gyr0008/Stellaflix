/*
 * Stellaflix 影视模块 — 世界页地图行为（MapLibre 移植，Task 6）
 *
 * 职责（替换 Cesium 时代 SFV.worldActions 里绑死 viewer 的相机面）：
 *   flyTo        电影感固定参数：{ zoom:16, pitch:60, duration:2800 }
 *                （hearthere main.pretty.js:19062-19064、:19636）
 *   reset (R)    回 world-globe 初始全球视图 { center:[104,35], zoom:2.5, pitch:0, 1200ms }
 *   自转 (A)     maplibre 版 autoRotate：逐帧 bearing+0.0667°（≈4°/s，对齐旧面），
 *                dragstart 暂停 / dragend 恢复（flag 仍开才继续）；unmount 必停循环
 *   快捷键       Esc 关卡片 / R 重置 / F 收藏选中信标 / A 自转（输入框内不拦截）
 *   收藏         localStorage 沿用旧键 stellaflix-world-favorites（旧页收藏不丢）
 *
 * 不做什么：不碰 deck 图层（world-lighthouse-deck）、不建卡片 DOM（world-ui）。
 * 双装载：__flyOptions / __resetOptions / __rotateStep 纯配置经 module.exports
 * 守卫供 Node 测试直连（同 world-lighthouse-deck.js 模式）。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  var FAV_KEY = 'stellaflix-world-favorites';
  var AUTO_ROTATE_KEY = 'stellaflix-world-auto-rotate';

  // ============================================================
  //  纯配置面（Node 可测）
  // ============================================================

  // flyTo 电影感三件套（hearthere :19062-19064）：zoom 16 / pitch 60 / 2800ms
  var FLY_PARAMS = { zoom: 16, pitch: 60, duration: 2800 };
  // 重置视角 = world-globe.js 建图初始视图同款（center/zoom/pitch），1200ms 回退
  var RESET_PARAMS = { center: [104, 35], zoom: 2.5, pitch: 0, duration: 1200 };
  // 自转步进：每帧 bearing +0.0667°（≈4°/秒 @60fps，对齐旧 Cesium 面 rotateRateDeg=4；
  //   T6 评审 minor 调参：原 0.3/帧≈18°/秒 过快。T9 浏览器终验可再目视微调）
  var ROTATE_STEP_DEG = 0.0667;
  // 单帧 easeTo 的过渡时长：小于帧间隔 → 连续 drift 不互相打断堆积
  var ROTATE_EASE_MS = 250;

  function stationPosition(st) {
    if (!st) return null;
    if (Array.isArray(st.position) && st.position.length === 2) return st.position;
    var lon = st.longitude != null ? st.longitude : st.lon;
    var lat = st.latitude != null ? st.latitude : st.lat;
    if (lon == null || lat == null) return null;
    return [Number(lon) || 0, Number(lat) || 0];
  }

  // station（position 或 lon/lat 形状皆可）→ maplibre flyTo 参数
  function __flyOptions(station) {
    var pos = stationPosition(station);
    return {
      center: pos,
      zoom: FLY_PARAMS.zoom,
      pitch: FLY_PARAMS.pitch,
      duration: FLY_PARAMS.duration
    };
  }

  function __resetOptions() {
    return {
      center: RESET_PARAMS.center.slice(),
      zoom: RESET_PARAMS.zoom,
      pitch: RESET_PARAMS.pitch,
      duration: RESET_PARAMS.duration
    };
  }

  // bearing 归一到 [0,360)（maplibre 自身回绕到 [-180,180]，这里显式统一，
  // 步进结果可直接喂 easeTo 且测试可断言 360 处回绕）
  function normalizeBearing(b) {
    var n = Number(b);
    if (!isFinite(n)) return 0;
    return ((n % 360) + 360) % 360;
  }

  function __rotateStep(bearing, stepDeg) {
    var s = (stepDeg == null ? ROTATE_STEP_DEG : Number(stepDeg));
    return normalizeBearing((Number(bearing) || 0) + s);
  }

  // ============================================================
  //  收藏（localStorage 旧键沿用；烟花在 Task 8 回归）
  // ============================================================

  function loadFavs() {
    try {
      var raw = global.localStorage && global.localStorage.getItem(FAV_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function saveFavs(list) {
    try {
      global.localStorage && global.localStorage.setItem(FAV_KEY, JSON.stringify(list));
    } catch (e) {}
  }

  function isFavorite(id) {
    return loadFavs().indexOf(id) >= 0;
  }

  function toggleFavorite(st) {
    if (!st) return false;
    var list = loadFavs();
    var i = list.indexOf(st.id);
    var now;
    if (i >= 0) { list.splice(i, 1); now = false; }
    else { list.push(st.id); now = true; }
    saveFavs(list);
    if (ui) {
      ui.toast(now ? '已收藏「' + (st.name || st.id) + '」'
        : '已取消收藏「' + (st.name || st.id) + '」');
    }
    return now;
  }

  // ============================================================
  //  运行时状态（map 直收 maplibre map；deck/ui 供快捷键查选中与提示）
  // ============================================================

  var map = null;
  var ui = null;
  var deck = null;
  var autoRotate = true;
  var dragging = false;      // dragstart→true，dragend→false：拖拽期间不打架
  var rotateRaf = 0;
  var keydownBound = false;
  var onDragStart = null;
  var onDragEnd = null;

  // ============================================================
  //  相机动作
  // ============================================================

  function flyTo(st) {
    if (!map || !st) return;
    // 用户主动导航 → 停自转（沿旧 world-actions 语义：否则 drift 的 easeTo
    // 与 flyTo 抢相机）。maplibre flyTo 原生支持 {center,zoom,pitch,duration}。
    if (autoRotate) setAutoRotate(false);
    try {
      map.flyTo(__flyOptions(st));
    } catch (e) {
      console.warn('[world-map-actions] flyTo 失败', e);
    }
  }

  function resetView() {
    if (!map) return;
    setAutoRotate(false);
    try {
      map.easeTo(__resetOptions());
      if (ui) ui.toast('视角已重置');
    } catch (e) {
      console.warn('[world-map-actions] resetView 失败', e);
    }
  }

  // ============================================================
  //  自转（maplibre 版：逐帧 easeTo bearing drift，最小实现）
  // ============================================================

  function setAutoRotate(on) {
    autoRotate = !!on;
    try {
      global.localStorage && global.localStorage.setItem(AUTO_ROTATE_KEY, autoRotate ? '1' : '0');
    } catch (e) {}
    if (autoRotate) startRotateLoop();
    else stopRotateLoop();
    if (ui && ui.setRotateState) ui.setRotateState(autoRotate);
  }

  function rotateFrame() {
    rotateRaf = requestAnimationFrame(rotateFrame);
    if (!autoRotate || dragging || !map || typeof map.easeTo !== 'function') return;
    try {
      var b = typeof map.getBearing === 'function' ? map.getBearing() : 0;
      map.easeTo({ bearing: __rotateStep(b), duration: ROTATE_EASE_MS });
    } catch (e) {
      // 用户手势与 easeTo 偶发冲突不打紧，循环继续
    }
  }

  function startRotateLoop() {
    if (rotateRaf || typeof requestAnimationFrame !== 'function') return;
    rotateRaf = requestAnimationFrame(rotateFrame);
  }

  function stopRotateLoop() {
    if (rotateRaf && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(rotateRaf);
    }
    rotateRaf = 0;
  }

  // ============================================================
  //  快捷键（沿旧 world-actions 的按键语义与 consume 策略）
  // ============================================================

  function isTyping(e) {
    var t = e && e.target;
    if (!t) return false;
    var tag = (t.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
  }

  // 吃掉事件，避免触发 App 全局热键（R 自由相机 / Esc 关浏览层）
  function consume(e) {
    if (!e) return;
    if (e.preventDefault) e.preventDefault();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    else if (e.stopPropagation) e.stopPropagation();
  }

  function findSelectedStation() {
    var st = null;
    var id = null;
    if (deck && typeof deck.getState === 'function') {
      var s = deck.getState();
      if (s && s.selectedId != null) id = s.selectedId;
    }
    if (id == null && SFV.worldHtPanel && SFV.worldHtPanel.isOpen()) {
      var p = SFV.worldHtPanel.panelEl();
      if (p && p.__station) id = p.__station.id;
    }
    if (id == null) return null;
    if (deck && typeof deck.getState === 'function') {
      var list = (deck.getState() || {}).stations || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) st = list[i];
      }
    }
    return st;
  }

  function onKeydown(e) {
    if (!map || isTyping(e)) return;
    var k = e.key;
    if (k === 'Escape') {
      // 只有面板开着才吃掉 Esc；否则放行给 App（关闭浏览层）
      if (SFV.worldHtPanel && SFV.worldHtPanel.isOpen()) { SFV.worldHtPanel.close(); consume(e); }
      return;
    }
    if (k === 'r' || k === 'R' || e.code === 'KeyR') {
      resetView();
      consume(e);
      return;
    }
    if (k === 'a' || k === 'A' || e.code === 'KeyA') {
      setAutoRotate(!autoRotate);
      if (ui) ui.toast(autoRotate ? '地球自转已开启' : '地球自转已关闭');
      consume(e);
      return;
    }
    if (k === 'f' || k === 'F' || e.code === 'KeyF') {
      var cur = findSelectedStation();
      if (cur) toggleFavorite(cur);
      else if (ui) ui.toast('先点一座信标，再按 F 收藏');
      consume(e);
    }
    // 空格不劫持：留给 App 的播放/暂停。自转用 A 切换。
  }

  // ============================================================
  //  挂载 / 卸载
  // ============================================================

  function mount(mapRef, opts) {
    unmount();
    opts = opts || {};
    map = mapRef || null;
    ui = opts.ui || null;
    deck = opts.deck || null;
    try {
      var saved = global.localStorage && global.localStorage.getItem(AUTO_ROTATE_KEY);
      autoRotate = saved !== '0';
    } catch (e) { autoRotate = true; }

    if (map && typeof map.on === 'function') {
      // 拖拽暂停自转：dragstart 停 drift，dragend 且 flag 开再恢复
      onDragStart = function () { dragging = true; };
      onDragEnd = function () {
        dragging = false;
        if (autoRotate) startRotateLoop();
      };
      map.on('dragstart', onDragStart);
      map.on('dragend', onDragEnd);
    }
    if (typeof global.addEventListener === 'function') {
      global.addEventListener('keydown', onKeydown, true);
      keydownBound = true;
    }
    if (autoRotate) startRotateLoop();
  }

  function unmount() {
    stopRotateLoop(); // 自转 rAF 循环必须停（page-world unmount 契约）
    dragging = false;
    if (map && onDragStart && typeof map.off === 'function') {
      try {
        map.off('dragstart', onDragStart);
        map.off('dragend', onDragEnd);
      } catch (e) { /* ignore */ }
    }
    onDragStart = null;
    onDragEnd = null;
    if (keydownBound && typeof global.removeEventListener === 'function') {
      global.removeEventListener('keydown', onKeydown, true);
      keydownBound = false;
    }
    map = null;
    ui = null;
    deck = null;
  }

  // ============================================================
  //  导出
  // ============================================================

  SFV.worldMapActions = {
    mount: mount,
    unmount: unmount,
    flyTo: flyTo,
    resetView: resetView,
    setAutoRotate: setAutoRotate,
    isFavorite: isFavorite,
    toggleFavorite: toggleFavorite,
    get autoRotate() { return autoRotate; },
    // 纯配置（测试与调试用）
    __flyOptions: __flyOptions,
    __resetOptions: __resetOptions,
    __rotateStep: __rotateStep,
    ROTATE_STEP_DEG: ROTATE_STEP_DEG,
    FAV_KEY: FAV_KEY
  };

  // Node 直连 require（双装载守卫）：只暴露纯配置面，浏览器依赖不触。
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      __flyOptions: __flyOptions,
      __resetOptions: __resetOptions,
      __rotateStep: __rotateStep,
      normalizeBearing: normalizeBearing,
      stationPosition: stationPosition,
      FLY_PARAMS: FLY_PARAMS,
      RESET_PARAMS: RESET_PARAMS,
      ROTATE_STEP_DEG: ROTATE_STEP_DEG,
      FAV_KEY: FAV_KEY
    };
  }
})(typeof window !== 'undefined' ? window : this);
