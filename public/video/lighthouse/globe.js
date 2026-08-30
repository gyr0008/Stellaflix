/*
 * Stellaflix 影视模块 — 灯塔模式 · deck.gl 真 3D 地球 (Phase 4 对照 hearthere.live 重建)
 *
 * 对标实现：hearthere.live 用 deck.gl GlobeView 渲染真 3D 球体 + MapTiler 地表 +
 * 自定义 GlowScatterplotLayer 发光信标。本文件复刻同一管线：
 *  - deck.gl Deck + GlobeView（真 3D 地球，可拖拽环绕、滚轮缩放）；
 *  - 有 MapTiler Key → MVTLayer 拉取 MapTiler v3 矢量瓦片，渲染陆地/海洋/国界几何（矢量暗色地球，与参考站一致）；
 *  - 无 Key → 近黑太空 + 大气辉光 + 发光信标（无大陆/海洋贴图，离线观感）；
 *  - 信标经 LH.beaconView.buildBeaconLayers 绘制（halo+core 两层，星点辉光）；
 *  - Deck onClick / pickable → onBeaconClick(beacon, screenPos)；
 *  - 缓慢自转（autoRotate）+ 信标脉冲，均经 rAF 驱动；
 *  - 订阅 LH.state，信标增删改自动刷新图层；
 *  - deck 未加载（离线/CDN 失败）→ 返回 { ok:false } 离线守卫，保留太空背景与提示。
 *
 * 不依赖业务模块；仅消费 LH.state 与 LH.beaconView。无 THREE 依赖。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var LH = (SFV.lighthouse = SFV.lighthouse || {});

  function initLighthouseGlobe(opts) {
    opts = opts || {};
    var container = opts.container;
    var state = opts.state || LH.state;
    var onBeaconClick = typeof opts.onBeaconClick === 'function' ? opts.onBeaconClick : function () {};
    console.log('[globe] initLighthouseGlobe called', 'container=', !!container, 'state=', !!state, 'deck=', typeof global.deck);
    if (!container) return { ok: false, destroy: function () {} };

    var deck = global.deck;
    // deck.gl 9.0.38 独立 UMD 仅以私有名 _GlobeView 导出 GlobeView（公开名 GlobeView 为 undefined），
    // 已用 Node 探针实测确认：deck._GlobeView 是真实可构造类（new _GlobeView({resolution:1}) 成功）。
    // 故取「公开名优先、私有名回退」以保持版本兼容。
    var GlobeView = (deck && (deck.GlobeView || deck._GlobeView)) || null;
    // 离线守卫：deck.gl 未加载（无网络 / CDN 失败）→ 仅保留太空背景与提示
    if (!deck || !deck.Deck || !GlobeView) {
      console.warn('[globe] offline guard triggered', 'deck=', typeof deck, 'deck.Deck=', !!(deck && deck.Deck), 'GlobeView=', !!GlobeView);
      container.classList.add('lighthouse-fallback');
      var guard = document.createElement('div');
      guard.className = 'lighthouse-guard';
      guard.textContent = '3D 地球需要联网加载 deck.gl，并配置 MapTiler Key（见 LH.MAP_CONFIG）。' +
        '当前为离线降级视图：仅显示太空背景与提示。';
      container.appendChild(guard);
      return {
        ok: false,
        destroy: function () {
          if (guard && guard.parentNode) guard.parentNode.removeChild(guard);
          container.classList.remove('lighthouse-fallback');
        },
        resize: function () {}
      };
    }

    var cfg = (LH.MAP_CONFIG || {});
    var mapTilerKey = opts.mapTilerKey || cfg.mapTilerKey || '';
    console.log('[globe] config', 'mapTilerKey=', mapTilerKey ? 'set(len=' + mapTilerKey.length + ')' : 'empty', 'basemap=', cfg.basemap);
    var initial = cfg.initialView || { longitude: 10, latitude: 20, zoom: 0.6, minZoom: 0, maxZoom: 6 };
    var autoRotate = (cfg.autoRotate != null ? cfg.autoRotate : 4);

    var viewState = {
      longitude: initial.longitude,
      latitude: initial.latitude,
      zoom: initial.zoom,
      minZoom: initial.minZoom,
      maxZoom: initial.maxZoom
    };
    var interacting = false;
    var lastInteract = 0;
    var raf = 0;
    var lastFrame = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    var dirty = true;       // 信标数据变化标记
    var deckInstance = null;
    var unsub = null;

    // ----------------------------------------------------- 地表图层（MapTiler 矢量，有 Key）
    // 用 MVTLayer 直接加载 MapTiler v3 矢量瓦片（OpenMapTiles schema），在 deck.gl
    // GlobeView 上把陆地/海洋/国界几何渲染为矢量暗色地球，对标参考站 hearthere.live。
    // 底图实例缓存（baseLayer），避免每帧重建触发瓦片重拉。
    var baseLayer = null;
    function buildVectorBasemap() {
      if (!mapTilerKey) { console.log('[globe] buildVectorBasemap skipped: no key'); return null; }
      var tileJson = 'https://api.maptiler.com/tiles/v3/tiles.json?key=' + mapTilerKey;
      console.log('[globe] buildVectorBasemap creating MVTLayer', 'tileJson=', tileJson);
      return new deck.MVTLayer({
        id: 'earth-vector',
        data: tileJson,
        minZoom: 0,
        maxZoom: Math.min(initial.maxZoom + 2, 6),
        pickable: false,
        autoHighlight: false,
        stroked: true,
        filled: true,
        lineWidthUnits: 'pixels',
        lineWidthMinPixels: 0.3,
        // 按 source-layer 着色：海洋深蓝、陆地略亮、国界青线、特殊边界紫线
        getFillColor: function (f) {
          var sl = f && f.sourceLayer;
          if (sl === 'water') return [6, 14, 33, 255];
          if (sl === 'landcover' || sl === 'landuse') return [16, 28, 44, 255];
          if (sl === 'boundaries') return [0, 0, 0, 0]; // 边界仅描边
          return [14, 22, 46, 255];                     // 陆地默认
        },
        getLineColor: function (f) {
          var sl = f && f.sourceLayer;
          var a = f && f.properties && f.properties.admin_level;
          if (sl === 'boundaries') {
            if (a === 2) return [92, 225, 230, 130];           // 国界：青
            if (a === 0 || a === 1) return [162, 155, 254, 150]; // 争议/特殊：紫
            return [120, 130, 160, 70];
          }
          if (sl === 'water') return [40, 70, 130, 110];       // 海岸线
          return [120, 130, 160, 40];
        },
        getLineWidth: function (f) {
          var sl = f && f.sourceLayer;
          var a = f && f.properties && f.properties.admin_level;
          if (sl === 'boundaries' && (a === 2 || a === 0)) return 0.7;
          return 0.3;
        }
      });
    }
    function ensureBasemap() {
      if (!baseLayer && mapTilerKey) baseLayer = buildVectorBasemap();
      return baseLayer;
    }

    // ----------------------------------------------------- 构建图层
    function buildLayers(time) {
      var beacons = (state && state.getBeacons) ? state.getBeacons() : [];
      var layers = [];
      var base = ensureBasemap();
      if (base) layers.push(base);
      if (time === 0 && layers.length) console.log('[globe] buildLayers initial', 'base=', base && base.id, 'beaconCount=', beacons.length);
      // 信标图层（halo + core）；core 的 onClick 兜底拾取
      var beaconLayers = LH.beaconView.buildBeaconLayers(beacons, {
        time: time, zoom: viewState.zoom, onPick: onBeaconClick
      });
      for (var i = 0; i < beaconLayers.length; i++) layers.push(beaconLayers[i]);
      return layers;
    }

    // ----------------------------------------------------- 初始化 Deck
    console.log('[globe] creating deck.Deck with GlobeView', 'containerSize=', container.clientWidth, 'x', container.clientHeight);
    try {
      deckInstance = new deck.Deck({
        parent: container,
        views: [new GlobeView({ resolution: 1 })],
        initialViewState: viewState,
        controller: { dragRotate: true, inertia: 200 },
        parameters: { clearColor: [0, 0, 0, 0] }, // 透明，露出容器太空背景
        layers: buildLayers(0), // 首帧即带矢量底图（若有 Key），避免空白闪烁
        onViewStateChange: function (e) {
        viewState = e.viewState;
        interacting = true;
        lastInteract = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        return viewState; // 受控：就地更新
      },
      onClick: function (info) {
        // 点击空白 → info.object 为 null → hideCard；点击信标 → 打开卡片
        onBeaconClick(info && info.object ? info.object : null,
          { x: info ? info.x : 0, y: info ? info.y : 0 });
      },
      getCursor: function (e) {
        return (e && e.isHovering) ? 'pointer' : 'grab';
      }
    });
    } catch (err) {
      console.error('[globe] deck.Deck construction failed', err && err.message, err && err.stack);
      return { ok: false, destroy: function () {}, resize: function () {} };
    }
    console.log('[globe] deck.Deck created ok');

    // ----------------------------------------------------- 状态订阅
    function onStateEvt() { dirty = true; }
    if (state && state.subscribe) unsub = state.subscribe(onStateEvt);

    // ----------------------------------------------------- 渲染循环（自转 + 脉冲）
    var frameCount = 0;
    function frame() {
      var now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      var dt = (now - lastFrame) / 1000;
      lastFrame = now;
      frameCount++;
      if (frameCount === 10) console.log('[globe] frame loop running');

      // 自转：用户静止超过 1.2s 才缓慢自转
      if (autoRotate && (now - lastInteract) > 1200 && !interacting) {
        viewState.longitude = (viewState.longitude + autoRotate * dt + 540) % 360 - 180;
        if (deckInstance) deckInstance.setProps({ viewState: viewState });
      }
      if (interacting && (now - lastInteract) > 300) interacting = false;

      if (dirty && deckInstance) {
        deckInstance.setProps({ layers: buildLayers(now) });
        dirty = false;
      } else if (deckInstance) {
        // 脉冲：持续重算 getRadius/getFillColor（信标数量少，开销可忽略）
        deckInstance.setProps({ layers: buildLayers(now) });
      }
      raf = global.requestAnimationFrame ? global.requestAnimationFrame(frame) : 0;
    }
    dirty = true;
    if (global.requestAnimationFrame) raf = global.requestAnimationFrame(frame);

    // ----------------------------------------------------- 自适应尺寸
    function resize() {
      if (deckInstance) deckInstance.setProps({
        width: container.clientWidth || 1,
        height: container.clientHeight || 1
      });
    }
    var onResize = function () { resize(); };
    global.addEventListener && global.addEventListener('resize', onResize);

    // ----------------------------------------------------- 销毁
    function destroy() {
      if (raf && global.cancelAnimationFrame) global.cancelAnimationFrame(raf);
      raf = 0;
      if (global.removeEventListener) global.removeEventListener('resize', onResize);
      if (unsub) unsub();
      if (deckInstance) { try { deckInstance.finalize(); } catch (e) {} deckInstance = null; }
    }

    return {
      ok: true,
      destroy: destroy,
      resize: resize,
      _deck: function () { return deckInstance; },
      _setViewState: function (v) { viewState = v; if (deckInstance) deckInstance.setProps({ viewState: viewState }); }
    };
  }

  LH.globe = { initLighthouseGlobe: initLighthouseGlobe };
})(typeof window !== 'undefined' ? window : this);
