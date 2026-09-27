/*
 * Stellaflix 影视模块 — 世界页地球底座（MapLibre globe + deck.gl）
 *
 * 职责（替换原 Cesium 底座 world-cesium.js，懒加载结构与建毁契约同款）：
 *  - 懒加载 vendor：loaders.gl core→obj → maplibre-gl → deck.gl
 *    （仅首次进入世界页时注入，启动链不背这些 bundle）
 *  - 建 / 毁 maplibregl.Map（globe 投影）+ deck.MapboxOverlay，
 *    与 router 的 mount/unmount 一一对应
 *  - 底图三档降级：Esri World Imagery → OSM → 无底图（对齐 world-cesium.js :8-9 的降级语义）
 *
 * 生命周期契约（连切多次不泄漏 WebGL 上下文的关键，同 world-cesium.js :10-13）：
 *  - mount 前若已有实例，先销毁
 *  - unmount 必须 finalize overlay + map.remove() 且清空引用，可重复调用（幂等）
 *  - 异步链路每一步校验 seq（seq guard）：过期 mount 的结果绝不写入共享全局，
 *    由产生方就地销毁自己的 map 实例（不调 destroyGlobe、不碰在用 mount 的 host）
 *
 * vendor 事实备注（Task 1 核实）：
 *  - loaders.gl 的 obj bundle 与 core 挂在同一个 `loaders` 全局（UMD root['loaders']），
 *    OBJ 加载器以 loaders.OBJLoader 引用；因此脚本注入顺序必须 core→obj，不得并发乱序。
 *  - deck.gl@9.2.4 单文件 UMD 暴露全局 `deck`，MapboxOverlay / SimpleMeshLayer 已内联
 *    （无外部 luma 依赖）；maplibre 全局是 `maplibregl`。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  // 注入顺序即依赖顺序（T9 浏览器终验修正）：deck.gl 单体 UMD 自带内联 loaders 副本，
  // 若 window.loaders 已存在（core/obj UMD 先行），deck 初始化会对 getter-only 的
  // loaders 全局赋 fetchFile 而抛错、window.deck 只剩 4 键 —— 故 deck 必须先于 loaders。
  // obj 依附 core 的 loaders 全局：core 先于 obj；后到的 core UMD 整体替换 root.loaders，
  // 不影响 deck 已在 init 期捕获的内联副本。
  var VENDOR = [
    'vendor/maplibre/maplibre-gl.min.js',
    'vendor/deck.gl/deck.gl.min.js',
    'vendor/loaders/loaders.gl.core.min.js',
    'vendor/loaders/loaders.gl.obj.min.js'
  ];
  var VENDOR_CSS = 'vendor/maplibre/maplibre-gl.css';

  // 三档底图样式（全部 globe 投影；免 key）
  var STYLE_ESRI = {
    version: 8,
    projection: { type: 'globe' },
    sources: {
      imagery: {
        type: 'raster',
        tiles: [
          'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
        ],
        tileSize: 256
      }
    },
    layers: [{ id: 'imagery', type: 'raster', source: 'imagery' }]
  };

  // ------------------------------------------------------------------
  // 暗灰栅格档（Task 10b 兜底）：Esri World Dark Gray Base，免 key。
  // 存在意义：dark 矢量档依赖 tiles.openfreemap.org（Cloudflare），国内直连
  // Electron 可能不通/超时；而 server.arcgisonline.com 与彩色卫星同域（实测
  // 用户环境直连可达）。此档保证「暗色地球」观感永不落空——矢量档失败时
  // 降级到这里仍是暗色，而不是跳回彩色卫星。
  // ------------------------------------------------------------------
  var STYLE_DARK_RASTER = {
    version: 8,
    projection: { type: 'globe' },
    sky: {
      'sky-color': 'hsl(203, 67%, 74%)',
      'sky-horizon-blend': 0.5,
      'horizon-color': '#FFFCEB',
      'horizon-fog-blend': 0.5,
      'fog-color': '#FFFFFF',
      'fog-ground-blend': 1,
      'atmosphere-blend': 0.5
    },
    sources: {
      imagery: {
        type: 'raster',
        tiles: [
          'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'
        ],
        tileSize: 256,
        attribution:
          '<a href="https://www.arcgisonline.com/" target="_blank">&copy; Esri</a>, ' +
          '<a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>'
      }
    },
    layers: [{ id: 'imagery', type: 'raster', source: 'imagery' }]
  };
  var STYLE_OSM = {
    version: 8,
    projection: { type: 'globe' },
    sources: {
      imagery: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256
      }
    },
    layers: [{ id: 'imagery', type: 'raster', source: 'imagery' }]
  };
  var STYLE_BARE = {
    version: 8,
    projection: { type: 'globe' },
    sources: {},
    layers: []
  };

  // ------------------------------------------------------------------
  // 暗色地球档（Task 10：对齐 hearthere.live 的 HearThereMap 定制样式）
  //
  // 视觉参数逐值取自 HearThereMap style.json（2026-09-26 经 Referer 抓取）：
  //   - background / water / wood / farmland / residential / building 色值与 zoom 插值
  //   - sky（大气边缘光）与 light（fill-extrusion 光照）root 配置原样移植
  //   - Building 3D：fill-extrusion，颜色 hsl(217,47%,51%)，opacity 0.4
  // 数据源换为 OpenFreeMap（免 key、免账号、$0，OSM 数据，实测 maxzoom=14，
  // z15+ 由 maplibre 自动 overzoom）。schema 从 MapTiler planet v4 适配到
  // OpenMapTiles：height/height_min → render_height/render_min_height；
  // road → transportation（class 语义一致）；underground → hide_3d。
  // 合规红线：HearThereMap 内嵌的第三方地图服务 key 绝不抄用（本文件不含任何
  // API key；底图数据源为免 key 的 OpenFreeMap）。
  // 行政边界不进本样式（world-boundaries.js 已自绘，避免双重描线）。
  // ------------------------------------------------------------------
  var STYLE_DARK = {
    version: 8,
    projection: { type: 'globe' },
    // HearThereMap sky 原值：白昼天空 + 大气边缘光
    sky: {
      'sky-color': 'hsl(203, 67%, 74%)',
      'sky-horizon-blend': 0.5,
      'horizon-color': '#FFFCEB',
      'horizon-fog-blend': 0.5,
      'fog-color': '#FFFFFF',
      'fog-ground-blend': 1,
      'atmosphere-blend': 0.5
    },
    // HearThereMap light 原值：fill-extrusion 视口锚定光照
    light: {
      anchor: 'viewport',
      position: [1.15, 90, 40],
      color: '#FFFFFF',
      intensity: 0.8
    },
    sources: {
      ofm: {
        type: 'vector',
        url: 'https://tiles.openfreemap.org/planet',
        attribution:
          '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> ' +
          '<a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>'
      }
    },
    layers: [
      {
        id: 'Background',
        type: 'background',
        paint: {
          'background-color': [
            'interpolate', ['exponential', 1], ['zoom'],
            6, 'hsl(216, 37%, 24%)',
            14, 'hsl(216, 38%, 23%)'
          ]
        }
      },
      {
        id: 'Water',
        type: 'fill',
        source: 'ofm',
        'source-layer': 'water',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: {
          'fill-antialias': true,
          'fill-color': 'hsl(217, 36%, 14%)',
          'fill-opacity': ['case', ['==', ['get', 'intermittent'], true], 0.5, 1]
        }
      },
      {
        id: 'River',
        type: 'line',
        source: 'ofm',
        'source-layer': 'waterway',
        minzoom: 3,
        filter: ['all',
          ['==', ['geometry-type'], 'LineString'],
          ['match', ['get', 'class'], ['river', 'stream'], true, false],
          ['!', ['has', 'brunnel']]],
        paint: {
          'line-color': 'hsl(217, 36%, 14%)',
          'line-width': { stops: [[12, 0.5], [20, 6]] }
        }
      },
      {
        id: 'Wood',
        type: 'fill',
        source: 'ofm',
        'source-layer': 'landcover',
        filter: ['all',
          ['==', ['geometry-type'], 'Polygon'],
          ['match', ['get', 'class'], ['wood'], true, false]],
        paint: {
          'fill-antialias': true,
          'fill-color': 'hsl(193, 46%, 22%)',
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.5, 14, 0.6]
        }
      },
      {
        id: 'Farmland',
        type: 'fill',
        source: 'ofm',
        'source-layer': 'landuse',
        filter: ['all',
          ['==', ['geometry-type'], 'Polygon'],
          ['match', ['get', 'class'], ['farmland'], true, false]],
        paint: {
          'fill-color': 'hsl(174, 48%, 19%)',
          'fill-opacity': 0.2
        }
      },
      {
        id: 'Residential',
        type: 'fill',
        source: 'ofm',
        'source-layer': 'landuse',
        filter: ['all',
          ['==', ['geometry-type'], 'Polygon'],
          ['match', ['get', 'class'], ['residential', 'industrial', 'commercial'], true, false]],
        paint: {
          'fill-color': [
            'interpolate', ['exponential', 1], ['zoom'],
            4, 'hsl(217, 37%, 24%)',
            16, 'hsl(215, 15%, 23%)'
          ]
        }
      },
      {
        id: 'Building',
        type: 'fill',
        source: 'ofm',
        'source-layer': 'building',
        minzoom: 12,
        filter: ['all',
          ['==', ['geometry-type'], 'Polygon'],
          ['any',
            ['!', ['has', 'render_height']],
            ['all',
              ['>=', ['get', 'render_height'], 1],
              ['<=', ['get', 'render_height'], 850]]]],
        paint: {
          'fill-color': [
            'interpolate', ['linear'], ['zoom'],
            12, 'hsl(217, 47%, 45%)',
            16, 'hsl(217, 49%, 54%)'
          ],
          'fill-opacity': [
            'interpolate', ['linear'], ['zoom'],
            12, 0.2,
            16, 0.4
          ]
        }
      },
      {
        id: 'Highway',
        type: 'line',
        source: 'ofm',
        'source-layer': 'transportation',
        minzoom: 4,
        filter: ['all',
          ['==', ['get', 'class'], 'motorway'],
          ['!', ['==', ['get', 'brunnel'], 'tunnel']]],
        paint: {
          'line-color': 'hsl(211, 43%, 36%)',
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            4, 0.8,
            6, 1.2,
            10, 2,
            14, 4
          ]
        }
      },
      {
        id: 'Major road',
        type: 'line',
        source: 'ofm',
        'source-layer': 'transportation',
        minzoom: 4,
        filter: ['all',
          ['match', ['get', 'class'], ['primary', 'secondary', 'trunk'], true, false],
          ['!', ['==', ['get', 'brunnel'], 'tunnel']]],
        paint: {
          'line-color': [
            'interpolate', ['linear'], ['zoom'],
            0, 'hsl(210, 47%, 27%)',
            12, ['match', ['get', 'class'],
              'secondary', 'hsl(211, 30%, 30%)',
              'hsl(211, 44%, 40%)']
          ],
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            6, 1.2,
            12, 2.5,
            14, 5
          ]
        }
      },
      {
        id: 'Minor road',
        type: 'line',
        source: 'ofm',
        'source-layer': 'transportation',
        minzoom: 10,
        filter: ['all',
          ['match', ['get', 'class'], ['minor', 'tertiary', 'service', 'track'], true, false],
          ['!', ['==', ['get', 'brunnel'], 'tunnel']]],
        paint: {
          'line-color': [
            'interpolate', ['linear'], ['zoom'],
            12, 'hsl(0, 0%, 33%)',
            22, 'hsl(0, 0%, 35%)'
          ],
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            12, 1.2,
            14, 2,
            20, 8
          ]
        }
      },
      {
        // HearThereMap "Building 3D" 原值：hsl(217,47%,51%) / opacity 0.4 /
        // height=identity(height) / base=identity(height_min)；OpenMapTiles 对应
        // render_height / render_min_height（字段已在 OpenFreeMap z14 瓦片实测存在）。
        id: 'Building 3D',
        type: 'fill-extrusion',
        source: 'ofm',
        'source-layer': 'building',
        minzoom: 14,
        filter: ['all',
          ['==', ['geometry-type'], 'Polygon'],
          ['!', ['==', ['get', 'hide_3d'], true]]],
        paint: {
          'fill-extrusion-color': 'hsl(217, 47%, 51%)',
          'fill-extrusion-opacity': 0.4,
          'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 0],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0]
        }
      }
    ]
  };

  var TIERS = [
    { style: STYLE_DARK, name: 'dark' },
    { style: STYLE_DARK_RASTER, name: 'darkgray' },
    { style: STYLE_ESRI, name: 'esri' },
    { style: STYLE_OSM, name: 'osm' },
    { style: STYLE_BARE, name: 'none' }
  ];

  // ------------------------------------------------------------------
  // MapTiler 档（Task 10c：用户自有 key，$0 免费额度）
  //
  // 资产：vendor/maptiler/hearthere-map-style.json（HearThereMap 96 层净化版：
  // 剥 symbol/glyphs/sprite、key 占位符 {KEY}、identity→coalesce/get）。
  // key 来源：localStorage 'stellaflix-maptiler-key-v1'（用户在 DevTools 设置，
  // 不进 git 仓库）。key 缺失时本档整体跳过，降级链不受影响。
  // ------------------------------------------------------------------
  var MAPTILER_KEY_STORE = 'stellaflix-maptiler-key-v1';
  var MAPTILER_STYLE_URL = 'vendor/maptiler/hearthere-map-style.json';

  function readMapTilerKey() {
    try {
      var k = global.localStorage && global.localStorage.getItem(MAPTILER_KEY_STORE);
      return (typeof k === 'string' && /^[A-Za-z0-9]{16,64}$/.test(k)) ? k : null;
    } catch (e) { return null; }
  }

  // 载入净化样式并注入用户 key；任一步失败返回 null（跳过该档，不阻塞降级链）
  function loadMapTilerStyle(key) {
    var fetchFn = global.fetch || null;
    if (!fetchFn) return Promise.resolve(null);
    return fetchFn(MAPTILER_STYLE_URL).then(function (res) {
      if (!res || !res.ok) throw new Error('style http ' + (res && res.status));
      return res.json();
    }).then(function (style) {
      return JSON.parse(JSON.stringify(style).replace(/\{KEY\}/g, key));
    }).catch(function (err) {
      console.warn('[world-globe] MapTiler 样式载入失败（跳过该档）', err);
      return null;
    });
  }

  var map = null;
  var overlay = null;
  var hostEl = null;
  var seq = 0;
  var vendorPromise = null;

  // 单档底图的最长等待：超时视为失败进下一档（网络悬挂不拖死首屏）
  var TIER_TIMEOUT_MS = 12000;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var sc = document.createElement('script');
      sc.src = src;
      sc.async = false;
      sc.onload = function () { resolve(src); };
      sc.onerror = function () {
        reject(new Error('[world-globe] failed to load ' + sc.src));
      };
      document.head.appendChild(sc);
    });
  }

  // CSS 加载失败不致命（只影响控件样式），best-effort
  function loadCss(href) {
    if (document.querySelector && document.querySelector('link[data-maplibre-style]')) {
      return Promise.resolve();
    }
    return new Promise(function (resolve) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.setAttribute('data-maplibre-style', '1');
      link.onload = function () { resolve(); };
      link.onerror = function () { resolve(); };
      document.head.appendChild(link);
    });
  }

  // vendor 串行注入（core→obj 顺序即语义，见文件头备注）；成功后常驻，二次 mount 走缓存
  function vendorReady() {
    return !!(global.maplibregl && global.maplibregl.Map &&
      global.deck && global.deck.MapboxOverlay);
  }

  function ensureVendor() {
    if (vendorReady()) return Promise.resolve();
    if (vendorPromise) return vendorPromise;
    vendorPromise = loadCss(VENDOR_CSS)
      .then(function () {
        return VENDOR.reduce(function (chain, src) {
          return chain.then(function () { return loadScript(src); });
        }, Promise.resolve());
      })
      .then(function () {
        if (!vendorReady()) {
          vendorPromise = null;
          throw new Error('[world-globe] vendor 注入完成但 maplibregl/deck 全局缺失');
        }
      })
      .catch(function (err) {
        vendorPromise = null;
        throw err;
      });
    return vendorPromise;
  }

  // 兼容旧 world-cesium 的 Cesium viewer 消费面（page-world.js 原样透传给
  // world-boundaries / world-lighthouse / world-actions）。
  // 刻意最小化：只保 camera.flyTo + resize + __maplibre/__overlay 后门；
  // Task 5/6 落地时按实际用到的 API 补全，不提前发明。
  function adapter(m, ov) {
    return {
      __maplibre: m,
      __overlay: ov,
      camera: {
        flyTo: function (options) {
          // 透传 maplibre 语义：{ center, zoom, pitch, duration }
          return m.flyTo(options);
        }
      },
      resize: function () {
        if (m && typeof m.resize === 'function') m.resize();
      }
    };
  }

  // 建一档样式的 map 并等待其可用：'idle' resolve；加载期超时 reject 进下一档。
  // Task 10b 容错重审（用户实测 dark 档被降级的教训）：
  //   - 不再对单个瓦片 'error' 事件立即 reject——瞬态网络抖动会把整档炸掉，
  //     表现为「暗色地球没生效直接跳回彩色卫星」。错误只记日志。
  //   - 判定失败的唯一口径：idle 时一条 source 数据都没拿到（dataCount===0，
  //     域名整体不可达/样式源失败）→ fail 进下一档；或 12s 超时兜底。
  function tryTierMap(host, style, tierName) {
    return new Promise(function (resolve, reject) {
      var m;
      try {
        // minZoom/maxPitch/attributionControl 对齐 hearthere Map ctor（@33168）：
        // zoom 不得缩出 2.5、pitch 上限 85、attribution 紧凑角标（OpenFreeMap 数据
        // 许可要求署名，raster 档无 attribution 时角标自动为空）。
        m = new global.maplibregl.Map({
          container: host,
          style: style,
          center: [104, 35],
          zoom: 2.5,
          minZoom: 2.5,
          pitch: 0,
          maxPitch: 85,
          attributionControl: { compact: true }
        });
      } catch (e) {
        reject(e);
        return;
      }
      var settled = false;
      var timer = null;
      var dataCount = 0;
      var errCount = 0;

      function cleanup() {
        if (timer) { clearTimeout(timer); timer = null; }
        m.off('error', onError);
        m.off('load', onLoad);
        m.off('idle', onIdle);
        m.off('data', onData);
      }
      function fail(why) {
        if (settled) return;
        settled = true;
        cleanup();
        try { m.remove(); } catch (e) { /* 尽力释放 */ }
        console.warn('[world-globe] 底图档 ' + (tierName || '?') + ' 失败: ' + why);
        reject(new Error(why));
      }
      function ok() {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(m);
      }
      function onError(err) {
        // 只记日志不降级：单个瓦片/资源失败是瞬态常态（对齐 hearthere 行为：
        // 底图永不因瓦片错误整体回退）。
        errCount++;
        console.warn('[world-globe] 底图档 ' + (tierName || '?') + ' 资源错误（第 ' + errCount + ' 次，不降级）',
          err && err.error ? err.error.message : err);
      }
      function onData() { dataCount++; }
      function onLoad() {
        if (settled) return;
        // load 后仍需一个 idle 确认首帧渲染完成（对齐简报：'idle' resolve）
      }
      function onIdle() {
        if (settled) return;
        if (dataCount === 0) {
          // 一条数据都没进来 = 该档整体不可达（域名被墙/源失败），换下一档
          fail('no-source-data');
          return;
        }
        ok();
      }

      m.on('error', onError);
      m.on('load', onLoad);
      m.on('idle', onIdle);
      m.on('data', onData);
      timer = setTimeout(function () { fail('style-timeout'); }, TIER_TIMEOUT_MS);
    });
  }

  function createHost(host) {
    // 与 world-cesium.js createViewer 同款坑位：.sfv-browse--page 整层
    // pointer-events:none（player.css），地球画布看得见摸不着。
    // 只给内层铺满容器开 auto，其余覆盖层保持 click-through。
    host.style.position = 'relative';
    host.style.overflow = 'hidden';
    var hostInner = document.createElement('div');
    hostInner.className = 'world-globe-host';
    hostInner.style.cssText =
      'position:absolute;left:0;top:0;right:0;bottom:0;width:100%;height:100%;' +
      'pointer-events:auto;touch-action:none;cursor:grab;';
    host.appendChild(hostInner);
    return hostInner;
  }

  function tryStyles(host, tiers, mySeq) {
    var inner = createHost(host);
    var chain = Promise.reject(new Error('init'));
    var result = null;
    tiers.forEach(function (tier) {
      chain = chain.catch(function (err) {
        if (err && err.__stale) throw err; // 链已止步：只向上传递过期信号，不再构建任何档
        if (err && err.message !== 'init' && err.message !== 'style-error' &&
          err.message !== 'style-timeout' && err.message !== 'no-source-data') {
          throw err; // 非降级类错误不再吞
        }
        if (mySeq !== seq) {
          // 评审修复 Important 2：每档构建前校验 seq——mount 已过期即止步，
          // 不再 new maplibregl.Map / 拉瓦片（僵尸链原本最多空跑 3 档 ~36s）
          var stale = new Error('stale-mount');
          stale.__stale = true;
          throw stale;
        }
        return tryTierMap(inner, tier.style, tier.name).then(function (m) {
          result = { map: m, basemap: tier.name };
        });
      });
    });
    return chain.then(function () {
      if (!result) throw new Error('[world-globe] 三档底图全部失败');
      var m = result.map;
      if (mySeq !== seq) {
        // 评审修复 Critical 1：此刻共享全局（map/overlay/hostEl）已归在用的新 mount
        // 所有——过期结果绝不写全局、绝不调用 destroyGlobe()（那会清空在用 host 的
        // DOM 并误毁在用 map），只就地释放本 mount 刚建的 map；overlay 尚未创建。
        try { m.remove(); } catch (e) { /* 尽力释放 */ }
        return null;
      }
      var ov = null;
      try {
        ov = new global.deck.MapboxOverlay({
          layers: [],
          pickable: true,
          glOptions: { preserveDrawingBuffer: true }
        });
        m.addControl(ov);
      } catch (e) {
        console.warn('[world-globe] deck MapboxOverlay 挂载失败（底图仍可用）', e);
        ov = null;
      }
      map = m;
      overlay = ov;
      return {
        map: m,
        overlay: ov,
        viewer: adapter(m, ov),
        basemap: result.basemap
      };
    });
  }

  function destroyGlobe() {
    seq++;
    if (overlay) {
      try {
        if (typeof overlay.finalize === 'function') overlay.finalize();
      } catch (e) {
        console.warn('[world-globe] overlay.finalize 异常', e);
      }
      overlay = null;
    }
    if (map) {
      try { map.remove(); } catch (e) {
        console.warn('[world-globe] map.remove 异常', e);
      }
      map = null;
    }
    if (hostEl) {
      try { hostEl.innerHTML = ''; } catch (e) { /* ignore */ }
      hostEl = null;
    }
  }

  function mount(host) {
    destroyGlobe(); // mount 前若已有实例，先销毁（同 world-cesium）
    hostEl = host || null;
    if (!host) return Promise.reject(new Error('[world-globe] mount: host 为空'));
    var mySeq = ++seq;

    return ensureVendor().then(function () {
      if (mySeq !== seq) return null; // 期间已 unmount / 重进
      // Task 10c：用户配了 MapTiler key 时，把 MapTiler 档插到链顶（本地 fetch，
      // 失败/无 key 都静默跳过，不影响后续档）
      var key = readMapTilerKey();
      var styleReady = key ? loadMapTilerStyle(key) : Promise.resolve(null);
      return styleReady.then(function (mtStyle) {
        if (mySeq !== seq) return null;
        var tiers = TIERS;
        if (mtStyle) tiers = [{ style: mtStyle, name: 'dark-mt' }].concat(TIERS);
        // tryStyles 全程持有 mySeq：仅当前 mount 可写共享全局；
        // 过期结果由其内部就地销毁，这里不再走 destroyGlobe()（评审 Critical 1）
        return tryStyles(host, tiers, mySeq);
      });
    }).catch(function (err) {
      if (mySeq !== seq) return null; // 过期（含档位链 __stale 止步）：静默丢弃
      throw err;
    });
  }

  function unmount() {
    destroyGlobe();
  }

  function getMap() {
    return map;
  }

  SFV.worldGlobe = {
    mount: mount,
    unmount: unmount,
    getMap: getMap,
    VENDOR: VENDOR,
    __styles: { dark: STYLE_DARK, darkgray: STYLE_DARK_RASTER, primary: STYLE_ESRI, fallback: STYLE_OSM, bare: STYLE_BARE },
    MAPTILER_KEY_STORE: MAPTILER_KEY_STORE,
    get map() { return map; }
  };
})(typeof window !== 'undefined' ? window : this);
