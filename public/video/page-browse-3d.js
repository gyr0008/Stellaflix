/*
 * Stellaflix 影视模块 — 电影/动漫分页 3D 海报墙（方案 B · 单张大透明卡 · 窗口自适应 · 卡内滚网格/卡外视差呼吸 · 无 hover 放大）
 *
 * 设计铁律（与影视模块专项守则一致）：
 *   - 全局复用 window.scene / camera / renderer / orbit（经典脚本顶层 var，
 *     即 window.* 全局），**零改动 public/index.html** 的 3D 引擎代码。
 *   - 海报墙 = 单张「大的透明卡片」：一个 PlaneGeometry，其 CanvasTexture 由一张
 *     大 2D 画布绘制——画布内按响应式网格把一张张海报拼进去。
 *   - **进入时只建一次**：wallMesh / wallCanvas / wallTexture 三件套在 activate 时创建，
 *     永不销毁重建；翻页/加载新海报只是「滑动窗口 + 重绘画布像素」，不重建几何体/纹理。
 *   - 无限滚动：应用层 scrollTop(0..1 连续) 驱动画布只画当前窗口 [scrollTop*maxStartRow, +WINDOW]
 *     的海报；靠近末尾自动 loadMore 追加 items（无上限，真·无限）。
 *   - **单卡无 hover 放大**：大卡不做歌单架式 hover 放大；卡片静态边框 1px rgba(255,255,255,.1)
 *     + 静态阴影 0 2px 8px（仅可读性），hover 不放大、不加深。
 *   - **指针在卡内 vs 卡外（方案 B 交互核心）**：
 *       · 指针在卡内 → 整卡静止（倾斜=0、呼吸=0），滚轮只用于滚动内部海报网格（无限）；
 *       · 指针在卡外 → 整卡随指针视差倾斜 + 呼吸（与普通 3D 歌单架观感一致）。
 *     判定：每帧 pointermove 用 Raycaster 命中大平面 → inCard；cardFocus 缓动(卡内→0/卡外→1)
 *     同时调制 tilt 与 breath。
 *   - 点击：Raycaster 命中大平面→取 UV→col/row（全局）→index→onCardClick（单张海报进播放）。
 *   - 卡片绘制管线 = 「Canvas 2D 画 → CanvasTexture → 贴平面合成」，与歌单架 buildOneCard 同款。
 *   - 透明透出首页星空：覆盖层永久透明；大卡材质 depthTest:false（同歌单架）+ renderOrder 排序。
 *   - 响应式网格（Request 2 规格）：<640→2列, 640–767→3列, 768–1023→4列, ≥1024→5列；
 *     容器内边距/间隙：默认16px, ≥640→24px, ≥1024→32px；网格最大宽度 1280（画布逻辑宽封顶）。
 *   - 过渡：向心淡出(scale 1→0) → 卸载，全部手写 rAF lerp，**零 GSAP**。
 *
 * 红圈区（#search-area 顶栏）全程不动：3D 仅渲染于背景 WebGL 画布层，
 * 不触碰顶栏，pointup 命中顶栏/过滤器等交互元素时跳过 raycast。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  if (SFV.browse3d) return; // 防御性：避免重复注册（HMR/重复加载）

  // T-#6-序5：零依赖纯层（normalizeHexColor / hexToRgba / metricsForWidth / roundRect）
  // 已抽到 page-browse-3d-core.js，须先于本文件加载
  var BC = SFV.browse3dCore;
  if (!BC) { throw new Error('[SFV browse3d] browse3dCore 未加载，请检查 index.html 加载顺序'); }
  var normalizeHexColor = BC.normalizeHexColor, hexToRgba = BC.hexToRgba,
      metricsForWidth = BC.metricsForWidth, roundRect = BC.roundRect;

  var THREE = global.THREE;
  // 延迟捕获：index.html 的 3D shelf 全局（scene/camera/renderer/orbit）在 <body> 脚本中定义，
  // 本文件在 <head> 加载时它们尚不存在，故在 activate() 内首次使用时再取全局引用。
  var scene, camera, renderer, orbit;
  var raf = (global.requestAnimationFrame)
    ? global.requestAnimationFrame.bind(global)
    : function (f) { return setTimeout(f, 16); };

  // ---- 常量 ----
  var GRID_RADIUS = 9.2;            // 网格视图相机距离（复用 orbit.userRadius）
  var COLLAPSE_MS = 360;            // 向心坍缩时长
  var LERP_K = 0.12;                // rAF lerp 系数
  var EPS = 0.01;                   // 收敛阈值
  var WINDOW_ROWS = 3;              // T141：固定态画布 3 排
  var WALL_CANVAS_W = 1216;         // T141：固定态画布宽度（与 .sfv-grid 对齐）
  var WALL_CANVAS_H = 1158;         // T141：固定态画布高度
  var LONG_EDGE = 4096;             // 大画布长边封顶，防显存爆炸
  var BASE_ROT_X = 0;               // 大卡固定基础朝向：垂直（不向后仰）
  var BASE_ROT_Y = 0;               // 大卡固定基础朝向：垂直（不左右转）
  var WALL_H_WORLD = 6.0;           // 大卡世界高度（固定 → 卡大小稳定，只滑窗不缩放）
  var WALL_MAX_W = 7.4;             // 大卡世界宽度上限

  // ---- 状态 ----
  var group = null;                 // THREE.Group
  var active = false;
  var mediaType = null;
  var host = null;
  var onCardClick = null;
  var loadPageFn = null;            // 分类感知翻页加载器（湖光浏览厅注入）
  var items = [];                   // 所有已加载海报 meta（跨页，只 append，不切页）
  var pageNo = 0, loading = false;

  var wallMesh = null, wallCanvas = null, wallTexture = null;
  var gridCols = 5;                // T141：固定态 5 列（computeGrid 经桥接固化，此处仅默认值）
  var totalRows = 1;                // 全局网格总行数（供 raycast 命中坐标换算）
  var canvasW = WALL_CANVAS_W, canvasH = WALL_CANVAS_H, wallAspect = WALL_CANVAS_W / WALL_CANVAS_H;
  var W_world = 4, H_world = WALL_H_WORLD;
  var cellW = 0, cellH = 0, gap = 24, PAD = 24;

  var scrollTop = 0;                // 应用层滚动（0..1，连续）
  var winStart = 0;                 // 当前窗口起始海报 index
  var winCount = 0;                 // 当前窗口海报数
  var winToken = 0;                 // 窗口重绘令牌（防旧异步回调画到错位窗口）

  var pointerTiltX = 0, pointerTiltY = 0;   // 原始指针视差（不乘 focus）
  var tiltX = 0, tiltY = 0;                 // 当前倾斜（缓动后）
  var cardFocus = 1;                        // 卡焦点：卡内→0(静止) / 卡外→1(视差+呼吸)，缓动
  var inCard = false;                       // 指针射线是否命中大卡
  var breathT = 0;

  // ============================================================
  //  玻璃 / 相机 对齐歌单架（轻量路线：单 Mesh 不变，仅参数化）
  //  复用歌单架同名配置键 shelfBgOpacity / shelfAccentColor（默认值与歌单架一致），
  //  存于独立 localStorage 键，避免侵入 music.js 构建产物。
  // ============================================================
  // —— 颜色工具（normalizeHexColor / hexToRgba）已抽到 page-browse-3d-core.js ——
  function lsGet(k) {
    try { return global.localStorage ? global.localStorage.getItem(k) : null; } catch (_) { return null; }
  }
  function resolveGridGlass() {
    var def = { bgOpacity: 0.9, accent: '#f4d28a' }; // 默认暗玻璃 + 暗金强调
    try {
      var raw = lsGet('stellaflix-grid-glass');
      if (raw) {
        var o = JSON.parse(raw) || {};
        if (o.bgOpacity != null) def.bgOpacity = Math.max(0.25, Math.min(0.98, Number(o.bgOpacity)));
        if (o.accent) def.accent = normalizeHexColor(o.accent, '#f4d28a');
      }
    } catch (_) {}
    return def;
  }
  function resolveGridCameraMode() {
    try {
      var raw = lsGet('stellaflix-grid-camera');
      if (raw) {
        var m = String(raw).trim();
        if (m === 'static' || m === 'dynamic') return m;
      }
    } catch (_) {}
    return 'static';   // 默认对齐 3D 歌单架（centerLocked，相机锁 home，卡片固定不随旋转倾斜）
  }
  var gridGlass = resolveGridGlass();
  var gridCameraMode = resolveGridCameraMode();
  var hoveredIdx = -1;   // 当前 hover 的海报全局索引（用于强调色发光）
  var wallOpacity = 0, wallOpacityTarget = 0;
  var wallScaleCur = 0.9, wallScaleTarget = 1;

  var redrawScheduled = false;      // 异步图片到达后的去抖重绘

  var ticking = false;
  var pointerAttached = false;
  var pointerDown = null;           // { x, y, t }
  var textureDisposed = 0;          // CanvasTexture 释放计数（用于测试 + 监控）

  var raycaster = (THREE && THREE.Raycaster) ? new THREE.Raycaster() : null;
  var ndc = (THREE && THREE.Vector2) ? new THREE.Vector2()
    : { x: 0, y: 0, set: function (a, b) { this.x = a; this.y = b; } };

  function now() {
    return (global.performance && global.performance.now) ? global.performance.now() : Date.now();
  }

  // ============================================================
  //  2D 圆角矩形路径（roundRect）已抽到 page-browse-3d-core.js
  // ============================================================

  // ============================================================
  //  海报图 LRU（Image 对象，CanvasTexture 跟卡片走）
  // ============================================================
  // ============================================================
  //  海报图 LRU（Image 对象，CanvasTexture 跟卡片走）
  //  已抽到 page-browse-3d-image-cache.js（自拥 imageCache/imageOrder/TEXTURE_MAX，0 桥）
  // ============================================================
  function evictImages() { return SFV.browse3dImageCache.evictImages(); }
  function getPosterImage(url, onReady) { return SFV.browse3dImageCache.getPosterImage(url, onReady); }
  function clearImageCache() { return SFV.browse3dImageCache.clearImageCache(); }


  // ============================================================
  //  卡片绘制（仿歌单架 drawCard 风格，直接画进大画布）
  //  无 hover 放大：静态边框 1px rgba(255,255,255,.1) + 静态阴影 0 2px 8px，海报 scale=1。
  // ============================================================
  function drawCardDirect(ctx, item, img, x, y, w, h, hovered) { return SFV.browse3dDraw.drawCardDirect(ctx, item, img, x, y, w, h, hovered); }


  // ============================================================
  //  空玻璃壳（方案 A 占位）：与 3D 歌单架卡片同款材质——
  //  深色渐变 + 1px 边框 + 圆角 + 顶部微高光，内部不画任何海报/文案。
  //  用户要求卡片内部空着（不调 TMDB、无网格内容），星空透出由覆盖层透明保证。
  //  仅此一个壳卡片，定位于世界中央 (0,0,0)（歌单架在右侧 sideX≈3.18 自动隐藏）。
  // ============================================================
  function drawShell(ctx, w, h) { return SFV.browse3dDraw.drawShell(ctx, w, h); }


  // ============================================================
  //  响应式网格（Request 2 规格）— metricsForWidth 已抽到 page-browse-3d-core.js
  // ============================================================

  // 计算网格几何（cell 尺寸、行数、画布尺寸），随 items 与窗口宽度自适应
  function computeGrid() { if (SFV.browse3dGrid && SFV.browse3dGrid.computeGrid) return SFV.browse3dGrid.computeGrid(); }

  // 把当前滑动窗口的海报拼进大画布（复合绘制）；只动画布像素，不重建纹理对象
  function drawWindow() {
    if (!wallCanvas) return;
    var g = computeGrid();
    var newW = Math.max(2, Math.round(canvasW));
    var newH = Math.max(2, Math.round(canvasH));
    if (wallCanvas.width !== newW || wallCanvas.height !== newH) {
      wallCanvas.width = newW; wallCanvas.height = newH; // 仅尺寸变化时 resize（极少）
    }
    var ctx = wallCanvas.getContext('2d');
    ctx.clearRect(0, 0, wallCanvas.width, wallCanvas.height);

    // 方案 A：无论是否有数据，先画一张可见的空玻璃壳（与歌单架卡片同款材质），
    // 占位显示于 3D 空间中央；无海报时内部为空、星空透出。
    drawShell(ctx, wallCanvas.width, wallCanvas.height);

    var count = items.length;
    var maxStartRow = Math.max(0, totalRows - WINDOW_ROWS);
    var startRow = Math.floor(scrollTop * maxStartRow);
    if (startRow < 0) startRow = 0;
    winStart = startRow * gridCols;
    winCount = Math.min(gridCols * WINDOW_ROWS, count - winStart);
    if (winCount < 0) winCount = 0;
    winToken++;
    var token = winToken;

    for (var i = 0; i < winCount; i++) {
      var item = items[winStart + i];
      if (!item) continue;
      var col = i % gridCols, row = Math.floor(i / gridCols);
      var x = PAD + col * (g.cellW + g.gap);
      var y = PAD + row * (g.cellH + g.gap);
      var img = item.poster ? getPosterImage(item.poster, function (loadedImg) {
        if (token !== winToken) return;
        scheduleRedraw();
      }) : null;
      var isHovered = (winStart + i === hoveredIdx);
      drawCardDirect(ctx, item, img, x, y, g.cellW, g.cellH, isHovered);
    }
    if (wallTexture) wallTexture.needsUpdate = true;
  }

  // 异步图片到达后的去抖重绘（事件驱动，不每帧）
  function scheduleRedraw() {
    if (redrawScheduled) return;
    redrawScheduled = true;
    raf(function () {
      redrawScheduled = false;
      if (active && wallCanvas && wallMesh && wallMesh.parent) drawWindow();
    });
  }

  // 按画布宽高比缩放世界尺寸，并封顶宽度
  // 注意：WALL_H_WORLD 固定 → 卡的大小稳定，只滑窗不缩放
  function fitWall() {
    if (!wallMesh) return;
    H_world = WALL_H_WORLD;
    W_world = H_world * wallAspect;
    if (W_world > WALL_MAX_W) {
      var k = WALL_MAX_W / W_world;
      W_world *= k; H_world *= k;
    }
    wallMesh.position.set(0, 0, 0);
    wallMesh.scale.set(W_world, H_world, 1);
  }

  // 建单张大卡（1 主平面 + 1 倒影平面，共享纹理）—— 只建一次，永不重建
  function makeWall() {
    wallCanvas = global.document.createElement('canvas');
    var g = computeGrid();
    wallCanvas.width = Math.max(2, Math.round(canvasW));
    wallCanvas.height = Math.max(2, Math.round(canvasH));
    wallTexture = new THREE.CanvasTexture(wallCanvas);
    wallTexture.minFilter = THREE.LinearFilter;
    wallTexture.magFilter = THREE.LinearFilter;
    wallTexture.generateMipmaps = false;

    var mat = new THREE.MeshBasicMaterial({
      map: wallTexture, transparent: true, opacity: 0,
      depthTest: false, depthWrite: false, side: THREE.DoubleSide
    });
    wallMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    wallMesh.renderOrder = 6;        // 绘制于背景（紫球/粒子）之上
    group.add(wallMesh);

    drawWindow();
    fitWall();
    wallMesh.material.opacity = 0;
    wallScaleCur = 0.9;
  }

  // ============================================================
  //  过渡动画（手写 rAF lerp，零 GSAP）
  //  wallTick：入场/出场 + 网格墙 group 与歌单架 group 锁步旋转（04b-shelf-3d.js L1114-1122），
  //  wallMesh 保持垂直固定基础朝向（BASE_ROT_X/Y=0），group 锁步旋转保持平行并消除穿模。
  // ============================================================
  function wallTick() {
    if (!ticking) return;

    // 网格墙 group 与歌单架 group 锁步旋转，保持平行。
    if (SFV.browse3dTick) SFV.browse3dTick.updateGroupRotation(group);

    if (wallMesh) {
      // wallMesh 保持垂直（BASE_ROT_X/Y=0），仅由 group 承担与歌单架的锁步旋转。
      wallMesh.rotation.x = BASE_ROT_X;
      wallMesh.rotation.y = BASE_ROT_Y;
    }

    breathT += 0.016;
    var breathScale = 1 + Math.sin(breathT * 0.9 + 1.2) * 0.012;

    wallOpacity += (wallOpacityTarget - wallOpacity) * LERP_K;
    wallScaleCur += (wallScaleTarget - wallScaleCur) * LERP_K;

    if (wallMesh) {
      wallMesh.material.opacity = wallOpacity;
      wallMesh.scale.set(W_world * wallScaleCur * breathScale, H_world * wallScaleCur * breathScale, 1);
    }

    // 激活期间持续 tick；deactivate 后等透明度/缩放收敛。
    if (active || Math.abs(wallOpacityTarget - wallOpacity) > EPS ||
        Math.abs(wallScaleTarget - wallScaleCur) > EPS) raf(wallTick);
    else ticking = false;
  }
  function startWallTick() { if (!ticking) { ticking = true; raf(wallTick); } }

  // ============================================================
  //  数据加载（与 DOM 网格同数据源 SFV.tmdb.popular）—— 只 append，不切页
  // ============================================================
  //  TMDB_DISABLED（2026-08-06）：用户要求暂停电影/动漫分页的 TMDB 取数工作。
  //  保留 defaultLoader 逻辑，仅用开关短路；待「完善其他功能」时置回 false 即可接回。
  var TMDB_DISABLED = true;
  function loadMore() { if (SFV.browse3dLoader && SFV.browse3dLoader.loadMore) return SFV.browse3dLoader.loadMore(); }
  function switchMedia(newMedia) { if (SFV.browse3dLoader && SFV.browse3dLoader.switchMedia) return SFV.browse3dLoader.switchMedia(newMedia); }
  function setLoader(fn) { if (SFV.browse3dLoader && SFV.browse3dLoader.setLoader) return SFV.browse3dLoader.setLoader(fn); }
  function disposeWall() { if (SFV.browse3dDispose && SFV.browse3dDispose.disposeWall) return SFV.browse3dDispose.disposeWall(); }
  function attachPointer() { if (SFV.browse3dPointer && SFV.browse3dPointer.attachPointer) return SFV.browse3dPointer.attachPointer(); }
  function detachPointer() { if (SFV.browse3dPointer && SFV.browse3dPointer.detachPointer) return SFV.browse3dPointer.detachPointer(); }
  function onPointerDown(e) { if (SFV.browse3dPointer && SFV.browse3dPointer.onPointerDown) return SFV.browse3dPointer.onPointerDown(e); }
  function onPointerMove(e) { if (SFV.browse3dPointer && SFV.browse3dPointer.onPointerMove) return SFV.browse3dPointer.onPointerMove(e); }
  function onWheel(e) { if (SFV.browse3dPointer && SFV.browse3dPointer.onWheel) return SFV.browse3dPointer.onWheel(e); }
  function onPointerUp(e) { if (SFV.browse3dPointer && SFV.browse3dPointer.onPointerUp) return SFV.browse3dPointer.onPointerUp(e); }
  function onKeyDown(e) { if (SFV.browse3dPointer && SFV.browse3dPointer.onKeyDown) return SFV.browse3dPointer.onKeyDown(e); }
  function onResize() { if (SFV.browse3dPointer && SFV.browse3dPointer.onResize) return SFV.browse3dPointer.onResize(); }
  function isInsideBrowse(e) { if (SFV.browse3dPointer && SFV.browse3dPointer.isInsideBrowse) return SFV.browse3dPointer.isInsideBrowse(e); }
  function onClick(e) { if (SFV.browse3dPointer && SFV.browse3dPointer.onClick) return SFV.browse3dPointer.onClick(e); }
  function saveOrbit() { if (SFV.browse3dOrbit && SFV.browse3dOrbit.saveOrbit) return SFV.browse3dOrbit.saveOrbit(); }
  function setOrbitGrid() { if (SFV.browse3dOrbit && SFV.browse3dOrbit.setOrbitGrid) return SFV.browse3dOrbit.setOrbitGrid(); }
  function restoreOrbit() { if (SFV.browse3dOrbit && SFV.browse3dOrbit.restoreOrbit) return SFV.browse3dOrbit.restoreOrbit(); }
  function activate(opts) {
    opts = opts || {};
    if (!scene) scene = global.scene;
    if (!camera) camera = global.camera;
    if (!renderer) renderer = global.renderer;
    if (!orbit) orbit = global.orbit;
    mediaType = opts.mediaType || mediaType || 'movie';
    host = opts.host || host;
    onCardClick = opts.onCardClick || onCardClick;
    loadPageFn = opts.loadPage || loadPageFn;   // 湖光：分类感知加载器
    if (!scene || !THREE) return;

    // 防御性挂载：已激活且同组已在场景 → 仅切换加载器/媒体或忽略
    if (active && group && group.parent === scene) {
      if (opts.loadPage && opts.loadPage !== loadPageFn) setLoader(opts.loadPage);
      else if (opts.mediaType && opts.mediaType !== mediaType) switchMedia(opts.mediaType);
      return;
    }

    // 清理可能残留的旧 group（deactivate 后的 360ms 窗口内再次 activate）
    if (group && group.parent) group.parent.remove(group);
    disposeWall();

    active = true;

    if (host && host.classList) host.classList.add('sfv-3d-on');

    saveOrbit();
    setOrbitGrid();

    group = new THREE.Group();
    scene.add(group);
    makeWall();            // 建单张大卡 + 绘制 + 适配（只建一次）
    attachPointer();

    try {
      console.log('[SFV] browse3d activated (' + (opts && opts.mediaType ? opts.mediaType : '?') +
        '); single transparent wall added to scene (built once, no card hover-zoom, in-card=scroll / out-card=parallax+breath)' +
        (host ? '; host.sfv-3d-on set' : '') + '.');
    } catch (_) {}

    items = []; pageNo = 0; loading = false; scrollTop = 0;
    wallOpacityTarget = 1; wallScaleTarget = 1;
    startWallTick();
    loadMore();
  }
  function finalizeDeactivate() {
    if (active) return; // 坍缩期间被重新激活 → 跳过清理
    if (group && group.parent) group.parent.remove(group);
    disposeWall();
    clearImageCache();
    restoreOrbit();
    group = null;
  }
  function deactivate() {
    if (!active) return;
    active = false;
    hoveredIdx = -1;
    if (host && host.classList) host.classList.remove('sfv-3d-on');
    detachPointer();
    wallOpacityTarget = 0; wallScaleTarget = 0;
    if (!group) { finalizeDeactivate(); return; }
    startWallTick();
    setTimeout(finalizeDeactivate, COLLAPSE_MS);
  }

  // ============================================================
  //  spacechange：离开影视态 → 反激活（还原 orbit）
  // ============================================================
  function onSpaceChange() {
    var handler = SFV.browse3dSpacechange && SFV.browse3dSpacechange.onSpaceChange;
    if (typeof handler === 'function') return handler();
  }

  if (global.addEventListener) {
    var evName = (SFV.state && SFV.state.EVENT) ? SFV.state.EVENT : 'spacechange';
    global.addEventListener(evName, onSpaceChange);
  }

  // ============================================================
  //  导出 + 通知动态加载器
  // ============================================================
  // ============================================================
  //  跨模块桥接面（#6-b）：抽取集群经此读写共享闭包状态 + 回调核心函数
  //  加载序保证：本文件先于各抽取模块加载，故 SFV.browse3dBridge 在抽取模块加载时已存在。
  // ============================================================
  SFV.browse3dBridge = {
    // —— 函数桥（核心函数留在本文件）——
    scheduleRedraw: scheduleRedraw,
    startWallTick: startWallTick,
    loadMore: loadMore,
    drawWindow: drawWindow,
    fitWall: fitWall,
    deactivate: deactivate,
    computeGrid: computeGrid,
    // —— 共享状态 getter/setter ——
    get active() { return active; },
    get gridCols() { return gridCols; }, set gridCols(v) { gridCols = v; },
    get totalRows() { return totalRows; }, set totalRows(v) { totalRows = v; },
    get items() { return items; },
    get onCardClick() { return onCardClick; },
    get raycaster() { return raycaster; },
    get ndc() { return ndc; },
    get camera() { return camera; },
    get renderer() { return renderer; },
    get orbit() { return orbit; },
    get gridGlass() { return gridGlass; },
    get canvasW() { return canvasW; }, set canvasW(v) { canvasW = v; },
    get gap() { return gap; }, set gap(v) { gap = v; },
    get PAD() { return PAD; }, set PAD(v) { PAD = v; },
    get cellW() { return cellW; }, set cellW(v) { cellW = v; },
    get cellH() { return cellH; }, set cellH(v) { cellH = v; },
    get canvasH() { return canvasH; }, set canvasH(v) { canvasH = v; },
    get wallAspect() { return wallAspect; }, set wallAspect(v) { wallAspect = v; },
    get gridCameraMode() { return gridCameraMode; },
    get GRID_RADIUS() { return GRID_RADIUS; },
    get TMDB_DISABLED() { return TMDB_DISABLED; },
    get loading() { return loading; },
    get mediaType() { return mediaType; }, set mediaType(v) { mediaType = v; },
    get wallOpacityTarget() { return wallOpacityTarget; }, set wallOpacityTarget(v) { wallOpacityTarget = v; },
    get wallScaleTarget() { return wallScaleTarget; }, set wallScaleTarget(v) { wallScaleTarget = v; },
    get loadPageFn() { return loadPageFn; }, set loadPageFn(v) { loadPageFn = v; },
    set items(v) { items = v; },
    get scrollTop() { return scrollTop; }, set scrollTop(v) { scrollTop = v; },
    get hoveredIdx() { return hoveredIdx; }, set hoveredIdx(v) { hoveredIdx = v; },
    get pointerTiltX() { return pointerTiltX; }, set pointerTiltX(v) { pointerTiltX = v; },
    get pointerTiltY() { return pointerTiltY; }, set pointerTiltY(v) { pointerTiltY = v; },
    get inCard() { return inCard; }, set inCard(v) { inCard = v; },
    get wallMesh() { return wallMesh; }, set wallMesh(v) { wallMesh = v; },
    get wallTexture() { return wallTexture; }, set wallTexture(v) { wallTexture = v; },
    get wallCanvas() { return wallCanvas; }, set wallCanvas(v) { wallCanvas = v; },
    get textureDisposed() { return textureDisposed; }, set textureDisposed(v) { textureDisposed = v; }
  };

  SFV.browse3d = {
    activate: activate,
    deactivate: deactivate,
    setLoader: setLoader,
    isActive: function () { return active; },
    handleResize: function () { if (active) onResize(); },

    // —— 诊断接口（验收用）——
    _state: function () {
      return {
        active: active, media: mediaType,
        total: items.length, scrollTop: +scrollTop.toFixed(3),
        winStart: winStart, winItems: winCount,
        cards: winCount,                // 兼容旧字段（= 当前窗口张数）
        cols: gridCols, rows: totalRows,
        inCard: inCard ? 1 : 0, cardFocus: +cardFocus.toFixed(2),
        groupInScene: (group && group.parent === scene) ? 1 : 0,
        canvasW: Math.round(canvasW), canvasH: Math.round(canvasH),
        worldW: +W_world.toFixed(2), worldH: +H_world.toFixed(2),
        loading: loading,
        customLoader: !!loadPageFn, mediaDefault: mediaType
      };
    },
    _dump: function () {
      var s = this._state();
      try { console.log('[SFV-BROWSE3D-DIAG] dump: ' + JSON.stringify(s)); } catch (_) {}
      return s;
    }
  };

})(typeof window !== 'undefined' ? window : this);
