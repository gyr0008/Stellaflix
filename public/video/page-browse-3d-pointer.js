/*
 * Stellaflix 影视模块 — page-browse-3d 的 pointer 集群（#6-b 抽取）
 * 指针/Raycaster/滚轮/键盘/点击命中：attachPointer/detachPointer/onPointerDown/Move/Up/
 * onWheel/onKeyDown/onResize/isInsideBrowse/onClick。
 * 共享状态经 SFV.browse3dBridge getter/setter；核心函数经函数桥；global 取 window。
 * 经 SFV.browse3dPointer 暴露，page-browse-3d.js 原位置改委托别名，调用点零改动。
 */
(function (global) {
  'use strict';
  if (!global.StellaflixVideo) global.StellaflixVideo = {};
  var SFV = global.StellaflixVideo;
  if (SFV.browse3dPointer) return; // 幂等守卫
  var B = SFV.browse3dBridge;
  if (!B) throw new Error('[SFV browse3d-pointer] browse3dBridge 未加载，请检查加载顺序');

  // —— 模块本地（仅指针集群使用） ——
  var MAX_TILT = 0.16;              // 指针视差最大倾角(rad)
  var WINDOW_ROWS = 5;              // 画布窗口行数（可见窗口）
  var pointerAttached = false;
  var pointerDown = null;           // { x, y, t }
  function now() {
    return (global.performance && global.performance.now) ? global.performance.now() : Date.now();
  }

  function attachPointer() {
    if (pointerAttached || !global.addEventListener) return;
    pointerAttached = true;
    global.addEventListener('pointerdown', onPointerDown, true);
    global.addEventListener('pointerup', onPointerUp, true);
    global.addEventListener('pointermove', onPointerMove, true);
    global.addEventListener('wheel', onWheel, true);
    global.addEventListener('keydown', onKeyDown, true);
    global.addEventListener('resize', onResize, true);
  }
  function detachPointer() {
    if (!pointerAttached || !global.removeEventListener) return;
    pointerAttached = false;
    global.removeEventListener('pointerdown', onPointerDown, true);
    global.removeEventListener('pointerup', onPointerUp, true);
    global.removeEventListener('pointermove', onPointerMove, true);
    global.removeEventListener('wheel', onWheel, true);
    global.removeEventListener('keydown', onKeyDown, true);
    global.removeEventListener('resize', onResize, true);
  }
  function onPointerDown(e) {
    if (!B.active) return;
    pointerDown = { x: e.clientX || 0, y: e.clientY || 0, t: now() };
  }
  function onPointerMove(e) {
    if (!B.active) return;
    var nx = ((e.clientX || 0) / (global.innerWidth || 1)) * 2 - 1;
    var ny = ((e.clientY || 0) / (global.innerHeight || 1)) * 2 - 1;
    B.pointerTiltX = nx * MAX_TILT;
    B.pointerTiltY = -ny * MAX_TILT;       // 上移→卡上仰
    // 当用户正在拖拽旋转相机时，跳过卡片命中与视差调制，
    // 避免拖拽动作被误识别为卡片内滚动/悬停。
    if (B.orbit && B.orbit.rotating) {
      B.inCard = false;
      B.startWallTick();
      return;
    }
    // 判定指针是否在卡内（仅当不在 FX 面板/顶栏等排除元素上）
    if (!isInsideBrowse(e) || !B.wallMesh || !B.raycaster || !B.raycaster.setFromCamera) {
      B.inCard = false;
      return;
    }
    var rect = (B.renderer && B.renderer.domElement && B.renderer.domElement.getBoundingClientRect)
      ? B.renderer.domElement.getBoundingClientRect()
      : { left: 0, top: 0, width: global.innerWidth || 1, height: global.innerHeight || 1 };
    var sx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    var sy = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    B.ndc.set(sx, sy);
    B.raycaster.setFromCamera(B.ndc, B.camera);
    var hits = B.raycaster.intersectObject(B.wallMesh, false);
    B.inCard = !!(hits && hits.length);
    // 计算 hover 的海报单元格（用于强调色发光）；变化时才重绘，避免每帧重画
    if (B.inCard && hits && hits[0] && hits[0].uv) {
      var hc = Math.floor(hits[0].uv.x * B.gridCols);
      var hr = Math.floor((1 - hits[0].uv.y) * B.totalRows);
      if (hc < 0) hc = 0; if (hc >= B.gridCols) hc = B.gridCols - 1;
      if (hr < 0) hr = 0; if (hr >= B.totalRows) hr = B.totalRows - 1;
      var hi = hr * B.gridCols + hc;
      if (hi !== B.hoveredIdx) { B.hoveredIdx = hi; B.scheduleRedraw(); }
    } else if (B.hoveredIdx !== -1) {
      B.hoveredIdx = -1; B.scheduleRedraw();
    }
  }
  function onWheel(e) {
    if (!B.active || !B.wallMesh) return;
    if (!isInsideBrowse(e)) return;   // FX 面板/顶栏 → 放行
    // 当前为方案 A 空壳占位卡（B.TMDB_DISABLED）：内部无海报网格可滚动，
    // 滚轮统一交给 B.orbit 做相机缩放（与首页 3D 歌单架行为一致）。
    if (B.TMDB_DISABLED) return;
    if (!B.inCard) return;              // 卡外 → 放行（滚轮不归海报墙，留给普通 3D 歌单架行为）
    e.preventDefault();
    e.stopPropagation();
    var count = B.items.length || 1;
    var maxStartRow = Math.max(0, B.totalRows - WINDOW_ROWS);
    var delta = (e.deltaY || 0) * 0.0016; // 灵敏度
    B.scrollTop += delta / (maxStartRow || 1);
    if (B.scrollTop < 0) B.scrollTop = 0;
    if (B.scrollTop > 1) B.scrollTop = 1;
    B.drawWindow();
    var footRows = Math.min(2, maxStartRow);
    if (B.scrollTop + 1 > (maxStartRow - footRows + 1) / (maxStartRow || 1) && !B.loading) {
      B.loadMore();
    }
  }
  function onPointerUp(e) {
    if (!B.active || !pointerDown) return;
    var dx = (e.clientX || 0) - pointerDown.x, dy = (e.clientY || 0) - pointerDown.y;
    var moved = Math.sqrt(dx * dx + dy * dy);
    var dt = now() - pointerDown.t;
    pointerDown = null;
    if (moved > 6 || dt > 600) return;        // 拖拽/长按 → 视为 B.orbit 操作，非点击
    onClick(e);
  }
  function onKeyDown(e) {
    if (!B.active) return;
    var tag = (e.target && e.target.tagName) ? e.target.tagName : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    var maxStartRow = Math.max(0, B.totalRows - WINDOW_ROWS);
    if (e.key === 'ArrowDown') { B.scrollTop = Math.min(1, B.scrollTop + 0.1); B.drawWindow(); }
    else if (e.key === 'ArrowUp') { B.scrollTop = Math.max(0, B.scrollTop - 0.1); B.drawWindow(); }
    else if (e.key === 'PageDown') { B.scrollTop = Math.min(1, B.scrollTop + 0.5); B.drawWindow(); }
    else if (e.key === 'PageUp') { B.scrollTop = Math.max(0, B.scrollTop - 0.5); B.drawWindow(); }
    if (B.scrollTop + 1 > (maxStartRow - Math.min(2, maxStartRow) + 1) / (maxStartRow || 1) && !B.loading) {
      B.loadMore();
    }
  }
  function onResize() {
    if (!B.active || !B.wallMesh) return;
    B.drawWindow();
    B.fitWall();
    B.startWallTick();
  }
  function isInsideBrowse(e) {
    var t = e.target;
    var doc = global.document;
    while (t && t !== doc && t !== doc.body) {
      if (t.id === 'search-area') return false;             // 红圈区顶栏
      if (t.className && /sfv-mfilter/.test(t.className)) return false; // 过滤条
      if (t.className && /sfv-hall|sfv-picker|fx-panel|fx-fab/.test(t.className)) return false; // 浏览厅/弹窗/ FX 浮层 DOM 不穿透
      if (t.tagName === 'BUTTON' || t.tagName === 'INPUT' || t.tagName === 'A') return false;
      t = t.parentNode;
    }
    return true;
  }
  function onClick(e) {
    if (!B.active || !B.wallMesh) return;
    if (!isInsideBrowse(e)) return;
    var rect = (B.renderer && B.renderer.domElement && B.renderer.domElement.getBoundingClientRect)
      ? B.renderer.domElement.getBoundingClientRect()
      : { left: 0, top: 0, width: global.innerWidth || 1, height: global.innerHeight || 1 };
    var nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    var ny = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    if (!B.raycaster || !B.raycaster.setFromCamera) return;
    B.ndc.set(nx, ny);
    B.raycaster.setFromCamera(B.ndc, B.camera);
    var hits = B.raycaster.intersectObject(B.wallMesh, false);
    if (!hits || !hits.length) return;
    var uv = hits[0].uv;
    if (!uv) return;
    var col = Math.floor(uv.x * B.gridCols);
    var row = Math.floor((1 - uv.y) * B.totalRows); // 纹理 flipY：画布顶部→v=1
    if (col < 0) col = 0; if (col >= B.gridCols) col = B.gridCols - 1;
    if (row < 0) row = 0; if (row >= B.totalRows) row = B.totalRows - 1;
    var idx = row * B.gridCols + col;
    if (idx < 0 || idx >= B.items.length) return;
    var item = B.items[idx];
    if (item && B.onCardClick) B.onCardClick(item);
  }
  SFV.browse3dPointer = {
    attachPointer: attachPointer, detachPointer: detachPointer,
    onPointerDown: onPointerDown, onPointerMove: onPointerMove, onWheel: onWheel,
    onPointerUp: onPointerUp, onKeyDown: onKeyDown, onResize: onResize,
    isInsideBrowse: isInsideBrowse, onClick: onClick
  };
})(typeof window !== 'undefined' ? window : this);
