/*
 * Stellaflix 影视模块 — page-browse-3d 的 loader 集群（#6-b 抽取，第 7 集群）
 * 数据加载/媒体切换/加载器注入：defaultLoader/loadMore/switchMedia/setLoader。
 * 共享状态经 SFV.browse3dBridge getter/setter；核心函数经函数桥；TMDB_DISABLED 留核心。
 * 经 SFV.browse3dLoader 暴露，page-browse-3d.js 原位置改委托别名，调用点零改动。
 */
(function (global) {
  'use strict';
  if (!global.StellaflixVideo) global.StellaflixVideo = {};
  var SFV = global.StellaflixVideo;
  if (SFV.browse3dLoader) return; // 幂等守卫
  var B = SFV.browse3dBridge;
  if (!B) throw new Error('[SFV browse3d-loader] browse3dBridge 未加载，请检查加载顺序');

  // —— 模块本地（仅 loader 使用） ——
  var COLLAPSE_MS = 360;           // 向心坍缩时长
  var pageNo = 0;

  function defaultLoader(p) {
    if (B.TMDB_DISABLED) return Promise.resolve([]);
    if (!SFV.tmdb || !SFV.tmdb.popular) return Promise.resolve([]);
    return SFV.tmdb.popular(B.mediaType, p);
  }
  function loadMore() {
    if (B.loading || B.TMDB_DISABLED) return;   // 暂停 TMDB 取数（保留无限滚动框架）
    var loader = B.loadPageFn || defaultLoader;
    B.loading = true;
    var p = pageNo + 1;
    Promise.resolve(loader(p)).then(function (resItems) {
      pageNo = p; B.loading = false;
      if (!resItems || !resItems.length) return;
      B.items = B.items.concat(resItems);   // 只追加，不切页
      B.drawWindow();                       // 重绘画布像素（不重建纹理对象）
      B.fitWall();
      B.startWallTick();
    }).catch(function () { B.loading = false; });
  }

  function disposeWall() { return SFV.browse3dDispose.disposeWall(); }


  // ============================================================
  //  orbit 复用 / 还原（相机锁定：recentering + 基准值固定）
  // ============================================================
  function saveOrbit() { return SFV.browse3dOrbit.saveOrbit(); }

  function setOrbitGrid() { return SFV.browse3dOrbit.setOrbitGrid(); }

  function restoreOrbit() { return SFV.browse3dOrbit.restoreOrbit(); }


  // ============================================================
  //  指针 / Raycaster / 滚轮 / 键盘
  // ============================================================
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

  // ============================================================
  //  激活 / 反激活
  // ============================================================
  function switchMedia(newMedia) {
    B.mediaType = newMedia;
    B.wallOpacityTarget = 0; B.wallScaleTarget = 0; B.startWallTick();
    setTimeout(function () {
      B.items = []; pageNo = 0; B.loading = false; B.scrollTop = 0;
      if (B.wallMesh) B.drawWindow();
      B.wallOpacityTarget = 1; B.wallScaleTarget = 1; B.startWallTick();
      loadMore();
    }, COLLAPSE_MS);
  }
  function setLoader(fn) {
    B.loadPageFn = fn || B.loadPageFn;
    if (!B.active) return;
    B.wallOpacityTarget = 0; B.wallScaleTarget = 0; B.startWallTick();
    setTimeout(function () {
      B.items = []; pageNo = 0; B.loading = false; B.scrollTop = 0;
      if (B.wallMesh) B.drawWindow();
      B.wallOpacityTarget = 1; B.wallScaleTarget = 1; B.startWallTick();
      loadMore();
    }, COLLAPSE_MS);
  }
  SFV.browse3dLoader = {
    defaultLoader: defaultLoader,
    loadMore: loadMore,
    switchMedia: switchMedia,
    setLoader: setLoader
  };
})(typeof window !== 'undefined' ? window : this);
