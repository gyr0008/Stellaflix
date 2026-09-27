/*
 * Stellaflix 影视模块 — 世界页 Cesium 地球底座（M0）
 *
 * 职责：
 *  - 懒加载 vendor/cesium/Cesium.js（仅在首次进入世界页时注入，启动链不背这 5MB）
 *  - 设置 window.CESIUM_BASE_URL，让 Cesium 找到同目录的 Workers/Assets/Widgets
 *  - 建 / 毁 Cesium Viewer，与 router 的 mount/unmount 一一对应
 *  - 底图走 Esri World Imagery（免 key），失败降级 OSM（对齐 GEV 的 keyless 路径）
 *
 * 生命周期契约（连切多次不泄漏 WebGL 上下文的关键）：
 *  - mount 前若已有实例，先 destroy
 *  - unmount 必须 viewer.destroy() 且清空引用，可重复调用（幂等）
 *  - 异步补底图时校验 viewer 未被销毁，避免向已销毁实例塞图层
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  var CESIUM_ROOT = 'vendor/cesium/';
  // Esri World Imagery：走本地 server.js 瓦片代理（同源，消除 CORS / 网络不稳）
  // 直连外部瓦片域名在 Electron 下偶发「Map data not yet available」占位图
  var ESRI_TILE_TEMPLATE =
    '/api/map-tile/{z}/{y}/{x}';
  var ESRI_CREDIT =
    'Esri, Maxar, Earthstar Geographics, and the GIS User Community';
  // OSM 仅作备选（本机实测 tile.openstreetmap.org 超时，不依赖它）
  var OSM_TILE_TEMPLATE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

  var loadPromise = null;
  var viewer = null;
  var hostEl = null;
  var creditEl = null;
  var mountToken = 0;

  function ensureBaseUrl() {
    if (typeof global.CESIUM_BASE_URL === 'undefined') {
      global.CESIUM_BASE_URL = CESIUM_ROOT;
    }
    return global.CESIUM_BASE_URL;
  }

  function ensureWidgetsCss() {
    if (document.querySelector('link[data-cesium-widgets]')) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CESIUM_ROOT + 'Widgets/widgets.css';
    link.setAttribute('data-cesium-widgets', '1');
    document.head.appendChild(link);
  }

  function ensureCesium() {
    ensureWidgetsCss();
    if (global.Cesium && global.Cesium.Viewer) {
      return Promise.resolve(global.Cesium);
    }
    if (loadPromise) return loadPromise;

    ensureBaseUrl();
    loadPromise = new Promise(function (resolve, reject) {
      var sc = document.createElement('script');
      sc.src = CESIUM_ROOT + 'Cesium.js';
      sc.async = false;
      sc.onload = function () {
        if (global.Cesium && global.Cesium.Viewer) {
          resolve(global.Cesium);
        } else {
          loadPromise = null;
          reject(new Error('[world-cesium] Cesium.js loaded but Viewer is missing'));
        }
      };
      sc.onerror = function () {
        loadPromise = null;
        reject(new Error('[world-cesium] failed to load ' + sc.src));
      };
      document.head.appendChild(sc);
    });
    return loadPromise;
  }

  function isAlive(v, token) {
    return !!v && token === mountToken && !(v.isDestroyed && v.isDestroyed());
  }

  function applyBasemap(v, token, C) {
    // 免 key 首选：Esri World Imagery 瓦片直连（不拉 MapServer 元数据）
    if (!isAlive(v, token) || !C.UrlTemplateImageryProvider) {
      return applyOsm(v, token, C);
    }
    try {
      v.imageryLayers.addImageryProvider(
        new C.UrlTemplateImageryProvider({
          url: ESRI_TILE_TEMPLATE,
          credit: ESRI_CREDIT,
          maximumLevel: 19
        })
      );
      return Promise.resolve('esri');
    } catch (err) {
      console.warn('[world-cesium] Esri 瓦片底图抛错，降级 OSM', err && err.message ? err.message : err);
      return applyOsm(v, token, C);
    }
  }

  function applyOsm(v, token, C) {
    if (!isAlive(v, token) || !C.UrlTemplateImageryProvider) {
      return Promise.resolve(null);
    }
    try {
      v.imageryLayers.addImageryProvider(
        new C.UrlTemplateImageryProvider({
          url: OSM_TILE_TEMPLATE,
          credit: '© OpenStreetMap contributors',
          maximumLevel: 19
        })
      );
      return Promise.resolve('osm');
    } catch (err) {
      console.warn('[world-cesium] OSM 底图也失败', err && err.message ? err.message : err);
      return Promise.resolve(null);
    }
  }

  // ============================================================
  //  地形与 3D 建筑（事实依据见 world-params.js / 三方 API 核实）
  //
  //  三档能力（对照 gods-eye-view 的 basemap ladder）：
  //    keyless  Re:Earth/Mapterhorn 量化网格地形（CC BY 4.0，免 token）
  //             → https://terrain.reearth.land/cesium-mesh/ellipsoid
  //             失败回退纯平面 EllipsoidTerrainProvider
  //    world    Cesium World Terrain（ion asset 1）→ 需 ion token
  //    google   Google Photorealistic 3D Tiles → 需 Google key（计费/条款自担）
  //
  //  合规：ion 免费档仅「个人非商业」，Google key 计费。二者都做成
  //  「用户自填才启用」，产品默认只用 keyless 地形。
  // ============================================================
  var KEYLESS_TERRAIN_URL = 'https://terrain.reearth.land/cesium-mesh/ellipsoid';

  function mapConfig() {
    return (SFV.lighthouse && SFV.lighthouse.MAP_CONFIG) || {};
  }

  function resolveTerrain(C, cfg) {
    var mode = String(cfg.terrainMode || 'auto').toLowerCase();

    // 显式纯平面
    if (mode === 'flat') {
      return Promise.resolve({ provider: new C.EllipsoidTerrainProvider(), source: 'flat' });
    }

    // 用户有 ion token → 用 Cesium World Terrain（质量更好，但条款更严）
    if (cfg.cesiumToken && typeof C.createWorldTerrainAsync === 'function') {
      return C.createWorldTerrainAsync({ requestVertexNormals: true })
        .then(function (provider) { return { provider: provider, source: 'ion-world-terrain' }; })
        .catch(function (e) {
          console.warn('[world-cesium] ion World Terrain 失败，降级 keyless', e && e.message);
          return keylessTerrain(C);
        });
    }

    return keylessTerrain(C);
  }

  function keylessTerrain(C) {
    if (!C.CesiumTerrainProvider || !C.CesiumTerrainProvider.fromUrl) {
      return Promise.resolve({ provider: new C.EllipsoidTerrainProvider(), source: 'flat' });
    }
    return C.CesiumTerrainProvider.fromUrl(KEYLESS_TERRAIN_URL, {
      requestVertexNormals: true,
      requestWaterMask: false
    }).then(function (provider) {
      return { provider: provider, source: 'reearth-keyless' };
    }).catch(function (e) {
      console.warn('[world-cesium] keyless 地形不可用，回退纯平面', e && e.message);
      return { provider: new C.EllipsoidTerrainProvider(), source: 'flat' };
    });
  }

  // Google Photorealistic 3D Tiles：只有用户自填 key 才启用（计费/条款自担）
  function attachGoogle3D(viewer, cfg) {
    if (!cfg.googleKey) return null;
    if (!global.Cesium || !global.Cesium.Cesium3DTileset || !global.Cesium.Cesium3DTileset.fromUrl) {
      console.warn('[world-cesium] Cesium3DTileset 不可用');
      return null;
    }
    var url = 'https://tile.googleapis.com/v1/3dtiles/root.json?key=' +
      encodeURIComponent(cfg.googleKey);
    return global.Cesium.Cesium3DTileset.fromUrl(url).then(function (tileset) {
      viewer.scene.primitives.add(tileset);
      console.log('[world-cesium] Google Photorealistic 3D Tiles 已启用');
      return tileset;
    }).catch(function (e) {
      console.warn('[world-cesium] Google 3D Tiles 加载失败', e && e.message);
      return null;
    });
  }

  function createViewer(container, C, terrainProvider) {
    var initial = (SFV.lighthouse && SFV.lighthouse.MAP_CONFIG && SFV.lighthouse.MAP_CONFIG.initialView) ||
      { longitude: 10, latitude: 20, height: 18000000 };

    // 容器必须有确定尺寸：.sfv-browse-body 是 flex 子项，直接把 Cesium 塞进去
    // 会受 padding/flex 影响。这里放一个绝对定位的铺满层，让画布真正铺满世界页。
    container.style.position = 'relative';
    container.style.overflow = 'hidden';
    var hostInner = document.createElement('div');
    hostInner.className = 'world-cesium-host';
    // pointer-events 必须显式 auto：
    // .sfv-browse.sfv-browse--page 整层是 pointer-events:none（player.css T150，
    // 为了让鼠标穿透到后台共享画布）。但世界页的 Cesium 画布挂在覆盖层内部，
    // 会继承 none，导致地球看得见摸不着。这里只给地球容器开 auto，
    // 覆盖层其余区域继续保持 click-through，FX 面板等仍可用。
    hostInner.style.cssText =
      'position:absolute;left:0;top:0;right:0;bottom:0;width:100%;height:100%;' +
      'pointer-events:auto;touch-action:none;cursor:grab;';
    container.appendChild(hostInner);

    var v = new C.Viewer(hostInner, {
      animation: false,
      timeline: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      creditContainer: creditEl,
      baseLayer: false,
      // 地形由 mount 先解析好再传入：建完 viewer 再换 terrainProvider 会触发地球重铺，影像层会丢
      terrainProvider: terrainProvider || new C.EllipsoidTerrainProvider()
    });

    // 相机：把整颗地球居中取景。
    // 关键：setView 不传 orientation 时 pitch 默认 -90°（垂直俯视），那样只会
    // 看到脚下铺满画面的地表、球沿挤在边缘 —— 必须显式给朝向。
    // pitch = -90° 且从 ~2.8 倍地球半径的高度俯视地心，球体正好落在画面中央。
    var r = 6378137; // WGS84 赤道半径（米）
    var height = Number(initial.height);
    if (!isFinite(height) || height <= 0) height = r * 2.8;
    try {
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(
          Number(initial.longitude) || 0,
          Number(initial.latitude) || 0,
          height
        ),
        orientation: {
          heading: 0,
          pitch: -Math.PI / 2,
          roll: 0
        }
      });
    } catch (e) {
      console.warn('[world-cesium] setView 失败', e);
    }

    // 天空盒 / 大气：Cesium 原生星空观感（对齐 hearthere 的 space:stars）
    try {
      if (v.scene && v.scene.skyAtmosphere) v.scene.skyAtmosphere.show = true;
      if (v.scene && v.scene.sun) v.scene.sun.show = true;
    } catch (e) {}

    // 容器可能刚挂上 DOM，强制同步一次尺寸，避免画布停在默认 300×150
    try {
      if (typeof v.resize === 'function') v.resize();
    } catch (e) {}

    // 3D 建筑：仅当用户自填 Google key（计费/条款自担）
    attachGoogle3D(v, mapConfig());

    return v;
  }

  function destroyViewer() {
    mountToken++;
    if (viewer) {
      // 在 destroy 之前取到已有的 WebGL 上下文（getContext 同类型只会返回既有上下文）。
      // 只调 viewer.destroy() 不会立刻释放上下文，连续建/毁约 16 次后浏览器
      // 会报 "Too many active WebGL contexts"，表现为世界页黑屏。
      var gl = null;
      try {
        var canvas = viewer.canvas || (viewer.scene && viewer.scene.canvas) || null;
        if (canvas && typeof canvas.getContext === 'function') {
          gl = canvas.getContext('webgl2') || canvas.getContext('webgl') ||
            canvas.getContext('experimental-webgl');
        }
      } catch (e) { gl = null; }

      try {
        if (viewer.isDestroyed && viewer.isDestroyed()) {
          // 已销毁，仅清引用
        } else {
          viewer.destroy();
        }
      } catch (e) {
        console.warn('[world-cesium] viewer.destroy 异常', e);
      }
      viewer = null;

      if (gl) {
        try {
          var ext = gl.getExtension && gl.getExtension('WEBGL_lose_context');
          if (ext && typeof ext.loseContext === 'function') ext.loseContext();
        } catch (e) {
          // 上下文可能已被 Cesium 释放，忽略
        }
      }
    }
    if (hostEl) {
      try { hostEl.innerHTML = ''; } catch (e) {}
      hostEl = null;
    }
    if (creditEl && creditEl.parentNode) {
      try { creditEl.parentNode.removeChild(creditEl); } catch (e) {}
    }
    creditEl = null;
  }

  function mount(host) {
    destroyViewer();
    hostEl = host;
    if (!hostEl) return Promise.reject(new Error('[world-cesium] mount: host 为空'));

    // credit 容器：Cesium 强制署名，单独挂一个小节点，避免默认样式污染页面
    creditEl = document.createElement('div');
    creditEl.className = 'world-cesium-credit';
    creditEl.style.cssText =
      'position:absolute;right:6px;bottom:4px;z-index:2;' +
      'font-size:10px;line-height:1.3;color:rgba(255,255,255,0.45);' +
      'pointer-events:auto;user-select:none;';
    hostEl.appendChild(creditEl);

    var token = ++mountToken;
    return ensureCesium().then(function (C) {
      if (token !== mountToken) return null; // 期间已 unmount
      // 顺序不能反：先解析地形，再建 viewer，最后铺影像。
      // 建完 viewer 再换 terrainProvider 会触发地球重铺，Esri 影像层会丢（实测踩过）。
      return resolveTerrain(C, mapConfig()).then(function (tr) {
        if (token !== mountToken) return null;
        console.log('[world-cesium] 地形 =', tr.source);
        viewer = createViewer(hostEl, C, tr.provider);
        return applyBasemap(viewer, token, C).then(function (basemapId) {
          return { basemap: basemapId, terrain: tr.source, viewer: viewer };
        });
      }).catch(function (e) {
        console.warn('[world-cesium] 地形解析失败，回退平面', e && e.message);
        if (token !== mountToken) return null;
        viewer = createViewer(hostEl, C, null);
        return applyBasemap(viewer, token, C).then(function (basemapId) {
          return { basemap: basemapId, terrain: 'flat', viewer: viewer };
        });
      });
    });
  }

  function unmount() {
    destroyViewer();
  }

  function getState() {
    return {
      cesiumLoaded: !!(global.Cesium && global.Cesium.Viewer),
      hasViewer: !!viewer,
      destroyed: !!(viewer && viewer.isDestroyed && viewer.isDestroyed()),
      mountToken: mountToken
    };
  }

  SFV.worldCesium = {
    KEYLESS_TERRAIN_URL: KEYLESS_TERRAIN_URL,
    resolveTerrain: resolveTerrain,
    CESIUM_ROOT: CESIUM_ROOT,
    ensureBaseUrl: ensureBaseUrl,
    ensure: ensureCesium,
    mount: mount,
    unmount: unmount,
    getState: getState,
    get viewer() { return viewer; }
  };
})(typeof window !== 'undefined' ? window : this);
