/*
 * Stellaflix 影视模块 — 世界页地球底座（步骤②：按 hearthere.live cd() 逐字重建）
 *
 * 对照源（_scratch/hearthere/main.pretty.js，2026-09-27 版，逐行标注）：
 *  - hn 常量表 :115-125（INITIAL_ZOOM/MIN_ZOOM/PITCH_DECAY_RATE/API_KEY）
 *  - Gu webgl2 探测 :127-135
 *  - 相机衰减族 sd/Tr/rd/ad/id :843-879，ja/Da setPitch/setBearing :881-890
 *  - Eu.apiKey = hn.API_KEY :891
 *  - Fa 隐藏全部 symbol 层 :893-898，ld 收起 compact attribution :900-903
 *  - cd() 底座 :905-1010（Map options 逐字 / dragRotate / load·styledata·sourcedata
 *    / zoom 缩小自动衰减 pitch+bearing / canvas wheel passive:false 触底衰减）
 *  - deck overlay 实例化 :13539-13543（{interleaved:true, layers:[], _pickable:false}）
 *
 * 与 hearthere 的两处已记录偏差（非修饰，是环境约束）：
 *  1) style：cd() 传私有样式 UUID '019d5159-…'（账号不可见，用户 key 取回 Not found），
 *     此处 fetch 本地解析版副本 vendor/maptiler/hearthere-map-style.json 并把 {KEY}
 *     占位替换为用户 key —— 送达 Map 的样式对象与 hearthere 线上解析结果同源。
 *  2) apiKey：hearthere 硬编自家 key（hn.API_KEY :115），此处同法硬编用户 key。
 *
 * 退役（本文件不再出现，属"仅保留 hearthere 设计"的删除项）：
 *  - Esri/OSM/BARE/DARK/DARK_RASTER 自研五档降级链（hearthere 无降级概念）
 *  - maplibre UMD + maplibre-gl.css（由步骤① ESM 桥接 SFV.maptilerGlobe 取代，
 *    CSS 注入亦在桥内完成）
 *  - localStorage 读 key（stellaflix-maptiler-key-v1）
 *  - 自绘行政边界层挂载（MapTiler 样式自带 Country border，page-world 侧摘除）
 * 旧版全文备份：public/video/_archive/world-globe.pre-hearthere-20260927.js
 *
 * 生命周期契约（连切多次不泄漏 WebGL 上下文，与旧版一致）：
 *  - mount 前若已有实例先销毁；unmount 幂等
 *  - 异步链路每一步校验 seq（seq guard）：过期 mount 的结果绝不写入共享全局，
 *    由产生方就地销毁自己的 map 实例
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  // 注入顺序即依赖顺序（T9 浏览器终验修正）：deck.gl 单体 UMD 自带内联 loaders 副本，
  // 若 window.loaders 已存在（core/obj UMD 先行），deck 初始化会对 getter-only 的
  // loaders 全局赋 fetchFile 而抛错、window.deck 只剩 4 键 —— 故 deck 必须先于 loaders。
  // obj 依附 core 的 loaders 全局：core 先于 obj。maplibre 已退役（走 ESM 桥）。
  var VENDOR = [
    'vendor/deck.gl/deck.gl.min.js',
    'vendor/loaders/loaders.gl.core.min.js',
    'vendor/loaders/loaders.gl.obj.min.js'
  ];

  // hn 常量表（main.pretty.js:115-125）底座相关子集；其余常量属灯塔/网格层，步骤③④随迁
  var API_KEY = 'nMcdjIXAW4OMJZZnckds'; // 对应 hn.API_KEY（:115，偏差2：同法硬编用户 key）
  var INITIAL_ZOOM = 2.5; // hn.INITIAL_ZOOM
  var MIN_ZOOM = 2.5; // hn.MIN_ZOOM
  var PITCH_DECAY_RATE = 0.15; // hn.PITCH_DECAY_RATE
  var STYLE_URL = 'vendor/maptiler/hearthere-map-style.json';

  var map = null;
  var overlay = null;
  var hostEl = null;
  var wheelCleanup = null;
  var seq = 0;
  var vendorPromise = null;

  // ------------------------------------------------------------------
  // 相机衰减族 —— sd/Tr/rd/ad/id/ja/Da 逐字移植（:843-890）
  // ------------------------------------------------------------------

  // Tr :851-854 —— bearing 归一到 [-180,180)，-0 归 0
  function normalizeBearing(t) {
    var e = ((t + 180) % 360 + 360) % 360 - 180;
    return Object.is(e, -0) ? 0 : e;
  }

  // sd :843-849 —— zoom 缩小时 pitch 按档位差线性衰减
  function decayPitch(pitch, prevZoom, zoom) {
    if (zoom >= prevZoom) return pitch;
    var r = prevZoom - zoom;
    var i = 1 - PITCH_DECAY_RATE * r;
    var l = pitch * Math.max(0, i);
    return Math.max(0, l);
  }

  // rd :856-862 —— bearing 版同款
  function decayBearing(bearing, prevZoom, zoom) {
    if (zoom >= prevZoom) return bearing;
    var r = normalizeBearing(bearing);
    var i = prevZoom - zoom;
    var l = 1 - PITCH_DECAY_RATE * i;
    return r * Math.max(0, l);
  }

  // ad :864-870 —— 滚轮 deltaY 衰减（round 两位）
  function decayPitchWheel(pitch, deltaY) {
    if (deltaY <= 0 || pitch <= 0) return pitch;
    var o = Math.min(deltaY / 100, 1);
    var r = 1 - PITCH_DECAY_RATE * o;
    var i = pitch * Math.max(0, r);
    return Math.max(0, Math.round(i * 100) / 100);
  }

  // id :872-879 —— bearing 滚轮版
  function decayBearingWheel(bearing, deltaY) {
    var n = normalizeBearing(bearing);
    if (deltaY <= 0 || n === 0) return bearing;
    var r = Math.min(deltaY / 100, 1);
    var i = 1 - PITCH_DECAY_RATE * r;
    var l = n * Math.max(0, i);
    return Math.round(l * 100) / 100;
  }

  // ja :881-885 —— 优先 transform.setPitch + triggerRepaint（绕开动画器）
  function applyPitch(m, v) {
    var max = typeof m.getMaxPitch === 'function' ? m.getMaxPitch() : 85;
    var o = Math.max(0, Math.min(v, max));
    if (m.transform && typeof m.transform.setPitch === 'function') {
      m.transform.setPitch(o);
      m.triggerRepaint();
    } else {
      m.setPitch(o);
    }
  }

  // Da :887-890 —— bearing 版同款
  function applyBearing(m, v) {
    var n = normalizeBearing(v);
    if (m.transform && typeof m.transform.setBearing === 'function') {
      m.transform.setBearing(n);
      m.triggerRepaint();
    } else {
      m.setBearing(n);
    }
  }

  // ------------------------------------------------------------------
  // 运行时行为族 —— Gu/Fa/ld 逐字移植（:127-135, :893-903）
  // ------------------------------------------------------------------

  // Gu：webgl2 探测，失败则不建图（hearthere 转不可用态；此处 reject 交 page-world 报错）
  function hasWebgl2() {
    if (typeof document === 'undefined') return false;
    var c = document.createElement('canvas');
    try {
      return !!c.getContext('webgl2');
    } catch (e) {
      return false;
    }
  }

  // Fa：样式载入后隐藏所有可见 symbol 层（hearthere 全页无文字标注，图层只剩几何）
  function hideSymbolLayers(m) {
    var style = m.getStyle();
    if (!style || !style.layers) return;
    style.layers.forEach(function (l) {
      if (l.type === 'symbol' && m.getLayoutProperty(l.id, 'visibility') !== 'none') {
        m.setLayoutProperty(l.id, 'visibility', 'none');
      }
    });
  }

  // ld：收起紧凑 attribution 的展开残留（class + open 属性）
  function hideCompactAttribution(container) {
    var el = container && container.querySelector && container.querySelector(
      '.maplibregl-ctrl-attrib.maplibregl-compact.maplibregl-compact-show');
    if (!el) return false;
    if (el.classList && typeof el.classList.remove === 'function') {
      el.classList.remove('maplibregl-compact-show');
    }
    if (typeof el.removeAttribute === 'function') el.removeAttribute('open');
    return true;
  }

  // ------------------------------------------------------------------
  // vendor（仅 deck + loaders；maplibre UMD/CSS 走步骤① ESM 桥 SFV.maptilerGlobe）
  // ------------------------------------------------------------------

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

  function vendorReady() {
    return !!(global.deck && global.deck.MapboxOverlay);
  }

  function ensureVendor() {
    if (vendorReady()) return Promise.resolve();
    if (vendorPromise) return vendorPromise;
    vendorPromise = VENDOR.reduce(function (chain, src) {
      return chain.then(function () { return loadScript(src); });
    }, Promise.resolve())
      .then(function () {
        if (!vendorReady()) {
          vendorPromise = null;
          throw new Error('[world-globe] vendor 注入完成但 deck 全局缺失');
        }
      })
      .catch(function (err) {
        vendorPromise = null;
        throw err;
      });
    return vendorPromise;
  }

  // ------------------------------------------------------------------
  // 样式：本地解析版副本 + {KEY} 替换（偏差1，文件头有案可查）
  // ------------------------------------------------------------------

  function fetchBasemapStyle() {
    var fetchFn = global.fetch;
    if (!fetchFn) return Promise.reject(new Error('[world-globe] fetch 不可用'));
    return fetchFn(STYLE_URL).then(function (res) {
      if (!res || !res.ok) throw new Error('[world-globe] 样式载入 http ' + (res && res.status));
      return res.text();
    }).then(function (text) {
      return JSON.parse(text.split('{KEY}').join(API_KEY));
    });
  }

  // ------------------------------------------------------------------
  // 底座组装
  // ------------------------------------------------------------------

  // 兼容旧 world-cesium 的 Cesium viewer 消费面（world-lighthouse / world-actions 透传）。
  // 刻意最小化：只保 camera.flyTo + resize + __maplibre/__overlay 后门。
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

  // cd() :914-1010 的 effect 主体逐字化：建 Map → 挂行为 → load resolve。
  // hearthere 无降级链、无 idle/dataCount 判定、无超时：load 即成，失败即不可用。
  function buildBaseMap(host, style, mySeq) {
    return new Promise(function (resolve, reject) {
      var globe = SFV.maptilerGlobe;
      if (!globe || !globe.Map) {
        reject(new Error('[world-globe] SFV.maptilerGlobe 桥未就绪（video/world-globe-esm.js）'));
        return;
      }
      var inner = createHost(host);
      var m;
      try {
        m = new globe.Map({
          container: inner,
          style: style,
          // 以下逐字对齐 cd() :932-956（center 是 [0,0]，不是旧自研的 [104,35]）
          center: [0, 0],
          zoom: INITIAL_ZOOM,
          minZoom: MIN_ZOOM,
          logoPosition: 'bottom-right',
          pitch: 0,
          bearing: 0,
          maxPitch: 85,
          projection: 'globe',
          space: { preset: 'stars', color: '#ffffff' },
          halo: {
            scale: 1.2,
            stops: [
              [0, 'rgba(255,255,255,0.35)'],
              [0.4, 'rgba(255,255,255,0.18)'],
              [0.8, 'rgba(255,255,255,0.0)']
            ]
          },
          navigationControl: 'bottom-right',
          geolocateControl: 'bottom-right',
          attributionControl: { compact: true }
        });
      } catch (e) {
        // 对应 cd() :958-961 init-failed：不重试不降级，直接失败上报
        reject(e);
        return;
      }

      // :962 dragRotate.enable()
      m.dragRotate.enable();

      // programmaticCameraLockRef（:909 入参，步骤④程序化相机时启用；常态 0 = 不锁）
      var cameraLock = { current: 0 };

      // wheel handler 先声明（load 里挂 canvas，destroyGlobe 里摘）
      var wheelHandler = function (evt) {
        // :989-1005 canvas wheel（passive:false）：触底继续下滚 → 收敛俯仰/旋向
        var g = m.getZoom();
        var p = m.getPitch();
        var b = m.getBearing();
        if (g <= MIN_ZOOM && (p > 0 || b !== 0) && evt.deltaY > 0) {
          evt.preventDefault();
          if (p > 0) applyPitch(m, decayPitchWheel(p, evt.deltaY));
          if (b !== 0) applyBearing(m, decayBearingWheel(b, evt.deltaY));
        }
      };

      // :967-985 zoom：缩小时自动衰减 pitch/bearing（prevZoom 从 INITIAL_ZOOM 起步）
      var prevZoom = INITIAL_ZOOM;
      m.on('zoom', function () {
        var g = m.getZoom();
        if (cameraLock.current === 0 && g < prevZoom) {
          var p = m.getPitch();
          var b = m.getBearing();
          if (p > 0) applyPitch(m, decayPitch(p, prevZoom, g));
          if (b !== 0) applyBearing(m, decayBearing(b, prevZoom, g));
        }
        prevZoom = g;
      });

      // :962-963 load：藏 symbol + 收 attribution，然后本底座完成
      m.on('load', function () {
        hideSymbolLayers(m);
        hideCompactAttribution(inner);
        if (mySeq !== seq) {
          // seq guard（评审 Critical 1 同款语义）：过期结果绝不写全局，
          // 就地释放本 mount 自建 map；overlay 尚未创建
          try { m.remove(); } catch (e) { /* 尽力释放 */ }
          resolve(null);
          return;
        }
        // :989-1008 wheel 只在存活实例上常驻登记
        m.getCanvas().addEventListener('wheel', wheelHandler, { passive: false });
        var ov = null;
        try {
          // deck overlay 实例化逐字对齐 :13539-13543（不开对象级可拾取、无 glOptions）
          ov = new global.deck.MapboxOverlay({
            interleaved: true,
            layers: [],
            _pickable: false
          });
          m.addControl(ov);
        } catch (e) {
          console.warn('[world-globe] deck MapboxOverlay 挂载失败（底图仍可用）', e);
          ov = null;
        }
        map = m;
        overlay = ov;
        wheelCleanup = function () {
          try {
            m.getCanvas().removeEventListener('wheel', wheelHandler);
          } catch (e) { /* map 已毁 */ }
        };
        resolve({
          map: m,
          overlay: ov,
          viewer: adapter(m, ov),
          basemap: 'maptiler'
        });
      });

      // :964-966 styledata / sourcedata
      m.on('styledata', function () {
        hideSymbolLayers(m);
        hideCompactAttribution(inner);
      });
      m.on('sourcedata', function () {
        hideCompactAttribution(inner);
      });
    });
  }

  function destroyGlobe() {
    seq++;
    if (wheelCleanup) {
      try { wheelCleanup(); } catch (e) { /* ignore */ }
      wheelCleanup = null;
    }
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
    destroyGlobe(); // mount 前若已有实例，先销毁
    hostEl = host || null;
    if (!host) return Promise.reject(new Error('[world-globe] mount: host 为空'));
    var mySeq = ++seq;

    // Gu() :924-927：webgl2 不可用 → 不建图（hearthere 转不可用态，此处 reject 上报）
    if (!hasWebgl2()) {
      return Promise.reject(new Error('[world-globe] webgl2-unavailable（本浏览器无法渲染地球）'));
    }
    var globe = SFV.maptilerGlobe;
    if (!globe || !globe.ready) {
      return Promise.reject(new Error('[world-globe] globe SDK 桥未加载（video/world-globe-esm.js）'));
    }

    return Promise.all([ensureVendor(), globe.ready])
      .then(function () {
        if (mySeq !== seq) return null; // 期间已 unmount / 重进
        // :891 Eu.apiKey = hn.API_KEY（进 ready 之后、建 Map 之前）
        globe.config.apiKey = API_KEY;
        return fetchBasemapStyle();
      })
      .then(function (style) {
        if (mySeq !== seq) return null; // 样式在途过期：止步，不 new Map（评审 Important 2 语义）
        if (!style) return null;
        return buildBaseMap(host, style, mySeq);
      })
      .catch(function (err) {
        if (mySeq !== seq) return null; // 过期链静默丢弃
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
    get map() { return map; }
  };
})(typeof window !== 'undefined' ? window : this);
