/*
 * Stellaflix 影视模块 — 世界页地图行为（MapLibre 移植，Task 6）
 *
 * 职责（替换 Cesium 时代 SFV.worldActions 里绑死 viewer 的相机面）：
 *   flyTo        电影感固定参数：{ zoom:16, pitch:60, duration:2800 }
 *                （hearthere main.pretty.js:19062-19064、:19636）
 *   reset (R)    回 world-globe 初始全球视图 { center:[104,35], zoom:2.5, pitch:0, 1200ms }
 *   自转 (A)     经度漂移法（轮⑬ 2026-10-02，Mapbox globe-spin 官方范例同款）：
 *                逐帧 center.lng -= 0.25°/s（真实 24h 压缩为 24min/圈）jumpTo；
 *                z≤3 满速 / z≥5 停转（zoom 联动防城市视角刷屏）；
 *                dragstart 暂停 / dragend 恢复（flag 仍开才继续）；unmount 必停循环
 *                （旧 bearing 法为「镜头绕地球转」且 deck 灯塔不跟，已退役）
 *   快捷键       Esc 关卡片 / R 重置 / F 收藏选中信标 / A 自转（输入框内不拦截；
 *                轮⑫：条内 Esc/F/点赞按钮退役，键盘面保留）
 *   收藏         localStorage 沿用旧键 stellaflix-world-favorites（旧页收藏不丢）
 *
 * 不做什么：不碰 deck 图层（world-lighthouse-deck）、不建卡片 DOM（world-ui）。
 * 双装载：__flyOptions / __resetOptions / __spinStep 纯配置经 module.exports
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
  // 自转（轮⑬ 经度漂移法）：真实 24h → 24min/圈 = 360°/1440s = 0.25°/s
  var SPIN_SECONDS_PER_REVOLUTION = 1440;
  var SPIN_DEG_PER_SEC = 360 / SPIN_SECONDS_PER_REVOLUTION;
  // zoom 联动减速（Mapbox globe-spin 范例 slowSpinZoom/maxSpinZoom 同款参数）
  var SPIN_SLOW_ZOOM = 3;   // z ≤ 3 满速
  var SPIN_MAX_ZOOM = 5;    // z ≥ 5 停转（城市视角防刷屏）
  // 单帧步进上限：后台标签页恢复/掉帧时防大跳
  var SPIN_MAX_DT_MS = 100;

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

  // 经度归一到 [-180,180)（maplibre 自身回绕，这里显式统一，步进结果可直接
  // 喂 jumpTo 且测试可断言 ±180 处回绕）
  function normalizeLng(l) {
    var n = Number(l);
    if (!isFinite(n)) return 0;
    return ((n % 360) + 540) % 360 - 180;
  }

  // 纯步进：当前中心经度 + zoom + 帧间隔 ms → 新经度。
  // 方向=相机中心持续西移 → 地表在视野中向东（右）移 = 真实自转方向（自西向东）。
  function __spinStep(lng, zoom, dtMs) {
    var z = Number(zoom) || 0;
    var rate = SPIN_DEG_PER_SEC;
    if (z >= SPIN_MAX_ZOOM) rate = 0;
    else if (z > SPIN_SLOW_ZOOM) {
      rate *= (SPIN_MAX_ZOOM - z) / (SPIN_MAX_ZOOM - SPIN_SLOW_ZOOM);
    }
    return normalizeLng((Number(lng) || 0) - rate * (Number(dtMs) || 0) / 1000);
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
  var rotateLastTs = 0;      // 经度漂移法帧时基（0=未就绪，首帧 dt=0）
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
  //  自转（轮⑬ 经度漂移法：逐帧 jumpTo 向西 drift 中心经度，帧率无关；
  //   灯塔 deck 层按 [经度,纬度] 地理锚定，地图每帧重渲染自然跟转）
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

  function rotateFrame(ts) {
    rotateRaf = requestAnimationFrame(rotateFrame);
    var now = typeof ts === 'number' ? ts : 0;
    var prev = rotateLastTs;
    rotateLastTs = now;
    if (!autoRotate || dragging || !map ||
        typeof map.jumpTo !== 'function' || typeof map.getCenter !== 'function') return;
    // 首帧只做时基（dt=0 不动相机）；掉帧/后台恢复钳制到 SPIN_MAX_DT_MS 防大跳
    if (!prev) return;
    var dt = Math.min(Math.max(now - prev, 0), SPIN_MAX_DT_MS);
    try {
      var c = map.getCenter();
      var lng = __spinStep(c.lng, typeof map.getZoom === 'function' ? map.getZoom() : 0, dt);
      if (lng !== c.lng) map.jumpTo({ center: [lng, c.lat] });
    } catch (e) {
      // 用户手势与自转偶发冲突不打紧，循环继续
    }
  }

  function startRotateLoop() {
    if (rotateRaf || typeof requestAnimationFrame !== 'function') return;
    rotateLastTs = 0;
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
    __spinStep: __spinStep,
    SPIN_DEG_PER_SEC: SPIN_DEG_PER_SEC,
    FAV_KEY: FAV_KEY
  };

  // Node 直连 require（双装载守卫）：只暴露纯配置面，浏览器依赖不触。
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      __flyOptions: __flyOptions,
      __resetOptions: __resetOptions,
      __spinStep: __spinStep,
      normalizeLng: normalizeLng,
      stationPosition: stationPosition,
      FLY_PARAMS: FLY_PARAMS,
      RESET_PARAMS: RESET_PARAMS,
      SPIN_DEG_PER_SEC: SPIN_DEG_PER_SEC,
      SPIN_SECONDS_PER_REVOLUTION: SPIN_SECONDS_PER_REVOLUTION,
      FAV_KEY: FAV_KEY
    };
  }
})(typeof window !== 'undefined' ? window : this);
