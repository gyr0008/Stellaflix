/*
 * Stellaflix 影视模块 — 世界页行政边界层（MapLibre 移植，Task 5）
 *
 * 职责：
 *  - 按缩放层级显示国家/省/市边界（maplibre geojson source + line layer）
 *  - 数据源：本地 GeoJSON（public/data/boundaries/），keyless
 *  - 失败静默降级（不影响地球主功能）
 *
 * 合规：
 *  - 只用公有领域 / 开放许可边界数据（Natural Earth CC0、DataV 开放数据）
 *  - 不引入需授权的商业数据集
 *
 * 缩放档位（自 Cesium 相机高度阈值移植；maplibre zoom↔altitude 换算
 *  zoom = log2(78271516 / h)，78271516 m ≈ zoom 0，即 mapbox-gl-native
 *  zoomConstant 同款）：
 *   原：h > 2.0e7 m → 只见国家界   ↔ province 层 minzoom ≈ 1.97
 *   原：h > 5.0e6 m → 国家+省      ↔ city    层 minzoom ≈ 3.97
 *   原：近档无上限                 ↔ 各层 maxzoom = 24
 *  可见分带改由 layer minzoom/maxzoom 声明式控制，不再挂 postRender 监听。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  // 数据路径用绝对路径，避免按页面 URL 相对解析出 404（沿原语义）
  var DATA_BASE = '/data/boundaries/';
  var SOURCE_PREFIX = 'sfv-boundary-';
  var KINDS = ['country', 'province', 'city'];
  var LAYER_MAX_ZOOM = 24;

  // maplibre 相机：zoom = log2(ALT_REF / altitude米)
  var ALT_REF = 78271516;

  function zoomForAltitude(altMeters) {
    if (!(altMeters > 0)) return 0;
    var z = Math.log(ALT_REF / altMeters) / Math.LN2;
    return Math.round(Math.max(0, z) * 100) / 100;
  }

  // 各层级的数据文件与样式（stroke/宽度逐档移植自原 Cesium 常量：
  //  color = 原 stroke[r,g,b]×255 取整转 hex；opacity = 原 stroke[3]；width = 原 strokeWidth；
  //  farCameraHeight = 原 applyZoomLevel 生效阈值（该高度以外不可见 = 层 minzoom 换算基准））
  var BOUNDARY_SPECS = {
    country: {
      file: 'world-countries.geojson',
      color: '#ffffff',   // 原 [1, 1, 1, 0.70]
      opacity: 0.70,
      width: 2.5,
      farCameraHeight: Infinity // 原实现三档均保持国家界可见，远景不截断
    },
    province: {
      file: 'china-provinces.geojson',
      color: '#d9ebff',   // 原 [0.85, 0.92, 1, 0.65] → (217,235,255)
      opacity: 0.65,
      width: 2.0,
      farCameraHeight: 2.0e7 // 原 applyZoomLevel：h > 2.0e7 隐藏省级
    },
    city: {
      file: 'china-cities.geojson',
      color: '#b3d9ff',   // 原 [0.7, 0.85, 1, 0.55] → (179,217,255)
      opacity: 0.55,
      width: 1.8,
      farCameraHeight: 5.0e6 // 原 applyZoomLevel：h > 5.0e6 隐藏市级
    }
  };

  var layers = {};   // kind -> { ds(sourceId|null), loaded, visible, promise, sourceAdded, layerAdded, styleWaitArmed, renderFailed }
  var map = null;    // 当前挂载的 maplibre map
  var mountSeq = 0;  // stale guard：unmount/重挂后 +1，过期 fetch 兑现不再渲染
  var currentLevel = null;
  // Task 6 携带修复（Task 5 评审）：模块级 geojson 缓存。
  // 边界数据是静态本地文件（三档合计 ~2.5MB），页面重进（router 切走再切回、
  // 换 map 实例重建）不该重拉一遍。unmount 只回收 map 上的源，不清此缓存。
  var dataCache = {};

  function ensureLayer(kind) {
    if (layers[kind]) return layers[kind];
    layers[kind] = {
      ds: null, loaded: false, visible: true, promise: null,
      sourceAdded: false, layerAdded: false,
      styleWaitArmed: false, renderFailed: false
    };
    return layers[kind];
  }

  function isMapLike(t) {
    return !!t && typeof t.addSource === 'function' && typeof t.addLayer === 'function' &&
      typeof t.removeLayer === 'function' && typeof t.removeSource === 'function';
  }

  function minzoomOf(spec) {
    return isFinite(spec.farCameraHeight) ? zoomForAltitude(spec.farCameraHeight) : 0;
  }

  // 渲染端：geojson → maplibre source + line layer（原 Cesium Polyline 实体手工
  // 抽边的做法取消——maplibre line 层原生描 Polygon/MultiPolygon 轮廓，宽度可控）
  // 返回 true = 本次已实际注入；false = 样式未就绪（已挂 styledata 等待）或失败。
  function renderBoundary(kind, spec, geojson) {
    var id = SOURCE_PREFIX + kind;
    var entry = ensureLayer(kind);
    if (!map) return false;
    // Fix round 1（I-1）：幂等守卫——本轮挂载已完整注入过就不再二添
    // （过期微任务/残留监听打上新图时，addSource 重复会抛并冒伪失败）
    if (entry.sourceAdded && entry.layerAdded) return true;
    // Task 6 携带修复（Task 5 评审）：样式守卫。maplibre 在 style 未加载时
    // addLayer 必抛——先等一次性 styledata 再补渲染（dataCache 供数据，不重 fetch）。
    if (typeof map.isStyleLoaded === 'function' && !map.isStyleLoaded()) {
      if (!entry.styleWaitArmed) {
        entry.styleWaitArmed = true;
        // Fix round 1（I-1）：waiter 捕获挂载身份（map 实例 + mountSeq）；
        // 触发即自摘（一次性），过期监听（旧图/旧挂载代）只退出不搅动新图。
        var waitMap = map;
        var waitSeq = mountSeq;
        var onStyle = function () {
          try { waitMap.off('styledata', onStyle); } catch (e) { /* 图已销毁 */ }
          if (waitSeq !== mountSeq || map !== waitMap) return; // stale：随旧代作废
          entry.styleWaitArmed = false;
          if (map && dataCache[kind] && !entry.layerAdded) {
            renderBoundary(kind, spec, dataCache[kind]);
          }
        };
        waitMap.on('styledata', onStyle);
      }
      return false;
    }
    try {
      map.addSource(id, { type: 'geojson', data: geojson });
      entry.sourceAdded = true;
      entry.ds = id;
    } catch (e) {
      failRender(kind, 'addSource', e);
      return false;
    }
    try {
      map.addLayer({
        id: id,
        type: 'line',
        source: id,
        minzoom: minzoomOf(spec),
        maxzoom: LAYER_MAX_ZOOM,
        paint: {
          'line-color': spec.color,
          'line-width': spec.width,
          'line-opacity': spec.opacity
        }
      });
      entry.layerAdded = true;
      entry.loaded = true;
      entry.renderFailed = false;
      if (!entry.visible) {
        // 原 ds.show = entry.visible 语义：加载完成前已被隐藏则保持隐藏
        try { map.setLayoutProperty(id, 'visibility', 'none'); } catch (e) { /* 静默 */ }
      }
    } catch (e) {
      failRender(kind, 'addLayer', e);
      return false;
    }
    return true;
  }

  // 持续失败不再静默（Task 5 评审携带修复）：console.error 上报 +
  // 清空 promise 成可重试态——下次 mount/toggleAll 会从 dataCache 再渲染。
  function failRender(kind, step, err) {
    console.error('[world-boundaries] ' + step + ' 失败（' + kind + '，可重试）:',
      err && err.message ? err.message : err);
    var entry = ensureLayer(kind);
    entry.renderFailed = true;
    entry.loaded = false;
    entry.promise = null; // 可重试态：下一次 loadBoundary 不会被旧 promise 短路
  }

  function loadBoundary(kind) {
    var spec = BOUNDARY_SPECS[kind];
    if (!spec || !map) return Promise.resolve(null);
    var entry = ensureLayer(kind);
    if (entry.promise) return entry.promise;

    // dataCache 命中：页面重进/换图重挂时零 fetch，直接渲染
    if (dataCache[kind]) {
      // Fix round 1（I-1）：与 fetch 支路同款 mount-seq 守卫——同 tick 的
      // unmount+remount 会让本微任务过期，过期渲染不得打上新图。
      var cacheSeq = mountSeq;
      entry.promise = Promise.resolve().then(function () {
        if (cacheSeq !== mountSeq || !map) return null; // stale guard
        renderBoundary(kind, spec, dataCache[kind]);
        return entry.ds;
      });
      return entry.promise;
    }

    var url = DATA_BASE + spec.file;
    var mySeq = mountSeq;
    // fetch/缓存管线沿用原实现（:69-80 语义），仅换渲染端
    entry.promise = fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (geojson) {
      dataCache[kind] = geojson; // 模块级缓存与 stale 无关：数据本身有效
      if (mySeq !== mountSeq || !map) return null; // stale guard：unmount 后兑现不注层
      renderBoundary(kind, spec, geojson);
      return entry.ds;
    }).catch(function (e) {
      if (mySeq !== mountSeq) return null; // 过期失败也静默
      console.warn('[world-boundaries] 加载失败:', kind, e && e.message);
      entry.promise = null;
      return null;
    });
    return entry.promise;
  }

  /**
   * 兼容保留：相机高度（米）→ 等效 maplibre zoom，仅做 currentLevel 记账；
   * 可见分带已由 layer minzoom/maxzoom 声明式接管，不再命令式开关数据源。
   */
  function applyZoomLevel(cameraHeight) {
    if (!isFinite(cameraHeight)) return;
    currentLevel = zoomForAltitude(cameraHeight);
  }

  /**
   * 挂载：接受 maplibre map（page-world 传 info.map）。
   * 也认 world-globe adapter 的 __maplibre 后门；无 addSource 面的输入静默 no-op。
   * 幂等：重复 mount 先走 unmount（unmount-first），绝不双挂源。
   */
  function mount(target) {
    unmount();
    map = isMapLike(target) ? target
      : (target && isMapLike(target.__maplibre) ? target.__maplibre : null);
    if (!map) return;
    currentLevel = null;
    KINDS.forEach(function (kind) { ensureLayer(kind).visible = true; });
    KINDS.forEach(function (kind) { loadBoundary(kind); });
  }

  function unmount() {
    mountSeq++; // 作废所有在途 fetch 的渲染步（stale guard）
    if (map) {
      KINDS.forEach(function (kind) {
        var entry = layers[kind];
        if (!entry) return;
        var id = SOURCE_PREFIX + kind;
        // 恰好移除本次注入的：先 layer 后 source
        if (entry.layerAdded) {
          try { map.removeLayer(id); } catch (e) { /* 尽力释放 */ }
        }
        if (entry.sourceAdded) {
          try { map.removeSource(id); } catch (e) { /* 尽力释放 */ }
        }
        entry.layerAdded = false;
        entry.sourceAdded = false;
        entry.ds = null;
        entry.loaded = false;
        entry.promise = null;
        entry.visible = false;
        // 旧 map 上的 styledata 等待随图作废：新 map 重挂时重新 arm
        entry.styleWaitArmed = false;
      });
    }
    map = null;
    currentLevel = null;
  }

  function toggleAll(show) {
    KINDS.forEach(function (kind) {
      var entry = ensureLayer(kind);
      if (show && map && !entry.promise) loadBoundary(kind);
      if (map && entry.layerAdded) {
        try {
          map.setLayoutProperty(SOURCE_PREFIX + kind, 'visibility', show ? 'visible' : 'none');
        } catch (e) { /* 静默 */ }
      }
      entry.visible = !!show;
    });
  }

  SFV.worldBoundaries = {
    mount: mount,
    unmount: unmount,
    applyZoomLevel: applyZoomLevel,
    toggleAll: toggleAll,
    zoomForAltitude: zoomForAltitude,
    get level() { return currentLevel; },
    get layers() { return layers; }
  };
})(typeof window !== 'undefined' ? window : this);
