/*
 * Stellaflix 影视模块 — 世界页灯塔层（步骤③：按 hearthere.live 逐字重建）
 *
 * 基准：_scratch/hearthere/main.pretty.js（2026-09-27 线上包，唯一事实源）。
 *   常量：St=12.5/xt=1/sc=11 :10609-10611 · xr.meshScale→Hr=25 :10951-10969
 *         Or/Vl :5581-5582 · fs=80 :10692 · 预热 Zm/Xm/Jm :13168-13178
 *   函数：ds() 光晕↔细节交叉淡出 :10613-10631 · Sr() Bt 门限 :10633-10635
 *         cc()/Gh() OBJ 缓存管线 :11323-11336 · Ai() /255 归一 :11338-11341
 *         Qh LighthouseRimLayer GLSL :11342-11486 · zo() 层工厂 :11488-11536
 *         rc/Ah 光晕层（bh 球面遮挡 + Sh 星点 + Ph zoom 淡出）:10804-10950
 *         Dh 光晕层工厂 :10981-11015 · ht() 组装 :13462-13546
 *         展开谓词（le）:13262
 *
 * 已裁决的等价改写（不进语义）：
 *   · ES2020 语法降级（?. ?? 展开）；类声明改惰性工厂（deck 全局晚到）。
 *   · mesh URL 路径按本项目 vendor 落点（资产同线上版，sha256 记录在案）。
 *   · 头像贴图层（station-avatar-layer，:13506-13514）留待步骤④（卡片+交互）一并接。
 *   · 选中扫描动画层（entering/exiting rim，:13524-13533）属交互态，步骤④接。
 *   · 拾取暂沿用 overlay.pickObject(radius)（hearthere GPU/CPU 分档拾取归步骤④）。
 *
 * 自研机制退役（旧版归档 _archive/world-lighthouse-deck.pre-hearthere-20260927.js）：
 *   · 程序化灯塔几何（worldLighthouseModel）→ 真 OBJ（loaders.gl 缓存管线）
 *   · 9.3 等比扫描式（-0.325/1.41、mix(-0.33,1.08)*modelHeight）→ 逐字 9.22、mix(-3,13)
 *   · rAF 逐帧入场循环 → hearthere 无此物（常驻批 entranceProgress 恒 1，:13538）
 *   · 尺寸分级 290/150 → hearthere 恒 Hr=25
 *
 * 生命周期契约（page-world 消费面不变）：
 *   SFV.worldLighthouseDeck.mount(map, overlay, {stations,onBeaconClick,onHover}) -> Promise
 *   unmount() / refreshStations(rooms) / setSelected(id) / applyTier(zoom)
 *   getState() -> {stations, selectedId, visible} / pickStation(x, y)
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  // ============================================================
  //  常量（hearthere 逐值移植）
  // ============================================================

  var TIER_ZOOM = 12.5;              // St :10609
  var TIER_FADE = 1;                 // xt :10610
  var GLOW_PRELOAD_ZOOM = TIER_ZOOM - TIER_FADE - 0.5; // sc=11 :10611
  var RIM_SIZE_SCALE = 25;           // Hr = xr.meshScale = 5e4 * 5e-4 :10951-10955
  var COLOR_TOP_DEFAULT = [223, 204, 251];    // Or :5581
  var COLOR_BOTTOM_DEFAULT = [150, 200, 254]; // Vl :5582
  var GLOW_RADIUS = 50;              // zr :10952
  var GLOW_ELEVATION = 80;           // fs :10692（getPosition [lon,lat,80]）
  var GLOW_ALPHA = 220;              // getFillColor alpha :11000
  var OBJ_URL = 'vendor/hearthere/lighthouse-DPszrb1Q.obj'; // Vh/Ms :11323-11324（本项目 vendor 落点）
  var GL_BACK = 1029;              // so.BACK = GL_BACK 0x0405（zo() :11529；本 deck bundle 收字符串会 GL_INVALID_ENUM）

  // 预热层 Zm/Xm/Jm :13168-13178：单枚离线假站、opacity .001、不可点、常驻
  var WARMUP = {
    id: 'lighthouse-warmup-layer',
    opacity: 0.001,
    data: [{
      id: '__lighthouse-warmup__',
      position: [0, 0],
      name: 'Lighthouse warmup',
      status: 'offline',
      ownerType: 'system',
      colorTop: [255, 255, 255],
      colorBottom: [255, 255, 255]
    }]
  };

  // ============================================================
  //  纯数据（Node 可测面）
  // ============================================================

  // 房间（world-data 归一化形状 / API 原始形状）→ 灯塔站点
  function roomToStation(room) {
    if (!room) return null;
    if (Array.isArray(room.position)) {
      // 已是 station 形状：补齐谓词所需身份字段（缺省不凭空造值）
      var passthrough = {
        id: room.id,
        roomId: room.roomId != null ? room.roomId : room.id,
        name: room.name || '放映房间',
        position: room.position,
        status: room.status || 'online',
        title: room.title,
        people: room.people,
        colorTop: room.colorTop || COLOR_TOP_DEFAULT.slice(),
        colorBottom: room.colorBottom || COLOR_BOTTOM_DEFAULT.slice()
      };
      if (room.ownerType !== undefined) passthrough.ownerType = room.ownerType;
      if (room.displayKind !== undefined) passthrough.displayKind = room.displayKind;
      if (room.hostUserId !== undefined) passthrough.hostUserId = room.hostUserId;
      if (room.alwaysExpanded !== undefined) passthrough.alwaysExpanded = room.alwaysExpanded;
      return passthrough;
    }
    var lon = room.longitude != null ? room.longitude : room.lon;
    var lat = room.latitude != null ? room.latitude : room.lat;
    var st = {
      id: room.id != null ? room.id : room.roomId,
      roomId: room.roomId != null ? room.roomId : room.id,
      name: room.name || '放映房间',
      position: [Number(lon) || 0, Number(lat) || 0],
      status: room.status || 'online',
      title: room.title,
      people: room.people,
      colorTop: room.color_top || room.colorTop || COLOR_TOP_DEFAULT.slice(),
      colorBottom: room.color_bottom || room.colorBottom || COLOR_BOTTOM_DEFAULT.slice()
    };
    if (room.ownerType !== undefined) st.ownerType = room.ownerType;
    if (room.displayType != null || room.displayKind != null) st.displayKind = room.displayKind;
    if (room.hostUserId !== undefined) st.hostUserId = room.hostUserId;
    if (room.alwaysExpanded !== undefined) st.alwaysExpanded = room.alwaysExpanded;
    return st;
  }

  // zo() getColor（:11504）：vColor.a 兼作激活动画进度，deck 1000ms 过渡 0↔255
  function getColor(st) {
    return [255, 255, 255, st && st.status !== 'offline' ? 255 : 0];
  }

  // Ai()（:11338-11341）：null/undefined 落回默认，整串 /255
  function toColorVec(c, fallback) {
    var n = c != null ? c : fallback;
    return [n[0] / 255, n[1] / 255, n[2] / 255];
  }

  // ds()（:10613-10631）：St±xt 区间内光晕/细节线性交叉淡出
  function zoomBands(zoom) {
    var t = Number(zoom);
    if (!isFinite(t)) return { glowOpacity: 1, detailOpacity: 0 };
    var e = TIER_ZOOM - TIER_FADE;
    var n = TIER_ZOOM + TIER_FADE;
    if (t < e) return { glowOpacity: 1, detailOpacity: 0 };
    if (t > n) return { glowOpacity: 0, detailOpacity: 1 };
    var o = (t - e) / (n - e);
    return { glowOpacity: 1 - o, detailOpacity: o };
  }
  function detailOpacity(zoom) { return zoomBands(zoom).detailOpacity; }
  function glowOpacity(zoom) { return zoomBands(zoom).glowOpacity; }

  // Sr()（:10633-10635）：Bt 门限 —— zoom >= St-xt 或 detailOpacity > .01
  function detailVisible(zoom, detail) {
    return Number(zoom) >= TIER_ZOOM - TIER_FADE || detail > 0.01;
  }

  // tierVisible：塔身实体档（12.5 及以上；getState().visible 口径）
  function tierVisible(zoom) {
    var z = Number(zoom);
    return isFinite(z) && z >= TIER_ZOOM;
  }

  // 展开谓词 le（:13262）：alwaysExpanded || (displayKind ?? ownerType)==='system' || hostUserId===me
  //（本地房间由 world-data 数据层打 alwaysExpanded 标记，用户裁决 2026-09-27；渲染层逐字）
  function isExpandedRecord(rec, currentUserId) {
    if (!rec) return false;
    var kind = rec.displayKind != null ? rec.displayKind : rec.ownerType;
    return !!(rec.alwaysExpanded || kind === 'system' ||
      (currentUserId && rec.hostUserId && rec.hostUserId === currentUserId));
  }

  // ============================================================
  //  GLSL（逐字移植，缩进按源 :11347-11449 / :10804-10927）
  // ============================================================

  var RIM_SHADER_INJECT = {
    'vs:#decl': [
      '        in vec3 instanceColorTop;',
      '        in vec3 instanceColorBottom;',
      '        in float instanceLayerOpacity;',
      '        in float instanceEntranceProgress;',
      '',
      '        out float vModelHeight;',
      '        out vec3 vColorTop;',
      '        out vec3 vColorBottom;',
      '        out float vLayerOpacity;',
      '        out float vEntranceProgress;'
    ].join('\n'),
    'vs:#main-start': [
      '        vModelHeight = positions.y;',
      '        vColorTop = instanceColorTop;',
      '        vColorBottom = instanceColorBottom;',
      '        vLayerOpacity = instanceLayerOpacity;',
      '        vEntranceProgress = instanceEntranceProgress;'
    ].join('\n'),
    'fs:#decl': [
      '        in float vModelHeight;',
      '        in vec3 vColorTop;',
      '        in vec3 vColorBottom;',
      '        in float vLayerOpacity;',
      '        in float vEntranceProgress;'
    ].join('\n'),
    'fs:#main-end': [
      '        // 从 vColor.a 读取激活动画进度 (deck.gl transitions 控制)',
      '        float activationProgress = vColor.a;',
      '',
      '        // 使用传入的颜色',
      '        vec3 colorTop = vColorTop;',
      '        vec3 colorBottom = vColorBottom;',
      '',
      '        // --- Rim 光照计算 ---',
      '        vec3 viewDir = normalize(cameraPosition - position_commonspace.xyz);',
      '        vec3 rimNormal = normalize(normals_commonspace);',
      '        float NdotV = max(0.0, dot(rimNormal, viewDir));',
      '        float rim = 1.0 - NdotV;',
      '        float rimIntensity = pow(rim, 6.0);',
      '',
      '        // --- 垂直渐变颜色 ---',
      '        vec3 colorGray = vec3(0.35, 0.4, 0.55);',
      '        float modelHeight = 9.22;',
      '        float ratio = clamp(vModelHeight / modelHeight, 0.0, 1.0);',
      '        vec3 activeColor = mix(colorBottom, colorTop, ratio);',
      '',
      '        // --- 激活扫描动画 ---',
      '        float scanY = mix(-3.0, 13.0, activationProgress);',
      '        float activeness = 1.0 - smoothstep(scanY, scanY + 2.0, vModelHeight);',
      '',
      '        // 扫描线发光',
      '        float isAnimating = smoothstep(0.0, 0.1, activationProgress) * smoothstep(1.0, 0.9, activationProgress);',
      '        float scanLine = exp(-1.0 * abs(vModelHeight - (scanY + 1.0))) * isAnimating;',
      '',
      '        // 颜色混合',
      '        vec3 baseColor = mix(colorGray, activeColor, activeness);',
      '        baseColor += vec3(1.0) * scanLine * 0.8;',
      '',
      '        // 亮度和透明度',
      '        // --- Dynamic Brightness Adjustment ---',
      '        // Calculate the max component value to check how close we are to white',
      '        float maxComponent = max(baseColor.r, max(baseColor.g, baseColor.b));',
      '',
      '        // Calculate the maximum gain we can apply without clipping to white (>1.0)',
      '        // We cap the max gain at 2.0 (original design) but lower it if the color is too bright',
      '        float maxSafeGain = 1.0 / max(0.01, maxComponent);',
      '        float targetActiveBrightness = min(2.0, maxSafeGain);',
      '',
      '        // Interpolate brightness based on activeness',
      '        float brightness = mix(0.7, targetActiveBrightness, activeness);',
      '        vec3 finalColor = baseColor * brightness;',
      '',
      '        float alphaActive = rimIntensity * 1.5 + 0.6;',
      '        float alphaRest = 0.8;',
      '        float finalAlpha = mix(alphaRest, alphaActive, activeness);',
      '',
      '        // === 入场扫描动画 ===',
      '        // 使用独立的 vEntranceProgress (0->1) 控制入场动画',
      '        float entranceProgress = vEntranceProgress;',
      '',
      '        // 入场扫描线位置：从模型底部扫到顶部',
      '        float entranceScanY = mix(-3.0, 13.0, entranceProgress);',
      '',
      '        // 扫描线以上的部分不可见（平滑过渡边缘）',
      '        float entranceVisibility = 1.0 - smoothstep(entranceScanY, entranceScanY + 0.5, vModelHeight);',
      '',
      '        // 入场扫描线发光效果（仅在动画进行中显示）',
      '        float isEntering = smoothstep(0.0, 0.05, entranceProgress) * smoothstep(1.0, 0.95, entranceProgress);',
      '        float entranceScanLine = exp(-2.0 * abs(vModelHeight - entranceScanY)) * isEntering;',
      '',
      '        // 叠加入场扫描线发光（青白色）',
      '        finalColor += vec3(0.8, 1.0, 1.0) * entranceScanLine * 0.6;',
      '',
      '        // 应用入场扫描效果',
      '        finalAlpha *= entranceVisibility;',
      '',
      '        // 应用图层整体透明度（用于 zoom 过渡淡入淡出）',
      '        finalAlpha *= vLayerOpacity;',
      '',
      '        fragColor = vec4(finalColor, finalAlpha);',
      '        DECKGL_FILTER_COLOR(fragColor, geometry);'
    ].join('\n')
  };

  // bh（:10804-10810）globe 背侧遮挡：置 gl_Position 到远平面外
  var GLOW_VS_MAIN_END = [
    "    if (project.projectionMode == PROJECTION_MODE_GLOBE) {",
    "        if (project_globe_is_occluded(geometry.position.xyz)) {",
    "            gl_Position = vec4(0.0, 0.0, 2.0, 1.0);",
    "        }",
    "    }"
  ].join('\n');

  // Sh（:10811-10835）星点风格光晕（compact 档，hearthere Dh 恒 compact:true :10991）
  var GLOW_FS_COMPACT = [
    "    if (picking.isActive < 0.5) {",
    "        float dist = length(unitPosition);",
    "        ",
    "        // 核心层：明亮的中心星点",
    "        float coreSize = 0.25;",
    "        float core = 1.0 - smoothstep(0.0, coreSize, dist);",
    "        core = pow(core, 1.5);",
    "        ",
    "        // 内光晕：紧凑的柔和扩散",
    "        float innerGlow = 1.0 - smoothstep(0.0, 0.45, dist);",
    "        innerGlow = pow(innerGlow, 3.0);",
    "        ",
    "        // 外光晕：微弱的边缘光芒",
    "        float outerGlow = 1.0 - smoothstep(0.0, 0.6, dist);",
    "        outerGlow = pow(outerGlow, 6.0);",
    "        ",
    "        // 组合光晕（星点风格：核心主导，带微弱光晕）",
    "        float combinedGlow = core * 0.8 + innerGlow * 0.15 + outerGlow * 0.05;",
    "        ",
    "        float glowIntensity = 1.2;",
    "        fragColor.rgb *= glowIntensity;",
    "        fragColor.a *= combinedGlow;",
    "    }"
  ].join('\n');

  // Ph（:10923-10927，kh() :10908-10910 以 ac=13.5 / Ch=2.0 生成）：zoom 语义淡出
  var GLOW_FS_ZOOM_FADE = [
    "    if (picking.isActive < 0.5) {",
    "        fragColor.a *= clamp((13.5 - presenceGlow.zoom) / 2.0, 0.0, 1.0);",
    "    }"
  ].join('\n');

  var GLOW_FS_MAIN_END = GLOW_FS_COMPACT + '\n' + GLOW_FS_ZOOM_FADE;

  // presenceGlow uniform 模块（Mh :10911-10922）
  var PRESENCE_GLOW_SRC = [
    'uniform presenceGlowUniforms {',
    '  float zoom;',
    '} presenceGlow;',
    ''
  ].join('\n');
  var PRESENCE_GLOW_MODULE = {
    name: 'presenceGlow',
    vs: PRESENCE_GLOW_SRC,
    fs: PRESENCE_GLOW_SRC,
    uniformTypes: { zoom: 'f32' }
  };

  // 球面遮挡函数：hearthere 线上 deck 为私有 patch 版（vendor-deck-core-BqZXgCow.js :546-566
  // 的 project 模块 GLSL 多出 project_globe_get_occlusion / project_globe_is_occluded），
  // 官方 deck 9.2.5/9.2.7/9.3.x 均无此函数。我们 vendor 官方 bundle，故以独立 shader
  // 模块自带同款定义（GLSL 逐字抄 patch 版），挂到光晕层 modules 供 bh（:10804-10810）调用。
  var GLOBE_OCCLUSION_GLSL = [
    'float project_globe_get_occlusion(vec3 commonPosition) {',
    '  if (project.projectionMode == PROJECTION_MODE_GLOBE) {',
    '    vec3 normal = normalize(commonPosition);',
    '    vec3 viewDir = normalize(project.cameraPosition - commonPosition);',
    '    float visibility = dot(normal, viewDir);',
    '    return visibility > 0.0 ? 0.0 : 1.0;',
    '  }',
    '  return 0.0;',
    '}',
    'bool project_globe_is_occluded(vec3 commonPosition) {',
    '  return project_globe_get_occlusion(commonPosition) > 0.5;',
    '}'
  ].join('\n');
  var GLOBE_OCCLUSION_MODULE = {
    name: 'projectGlobeOcclusion',
    vs: GLOBE_OCCLUSION_GLSL,
    vertexSource: GLOBE_OCCLUSION_GLSL
  };

  // ============================================================
  //  WebGL 依赖区（仅浏览器路径；Node require 不触以下代码）
  // ============================================================

  var RimLayer = null;   // Qh LighthouseRimLayer
  var GlowLayer = null;  // Ah PresenceGlowScatterplotLayer（rc 星点 + presenceGlow 淡出）

  function ensureLayerClasses() {
    if (RimLayer && GlowLayer) return;
    var deckGlobal = global.deck;
    if (!deckGlobal || !deckGlobal.SimpleMeshLayer || !deckGlobal.ScatterplotLayer) {
      throw new Error('[world-lighthouse-deck] deck.gl 未就绪（应由 world-globe 先行加载）');
    }
    if (!RimLayer) {
      RimLayer = class LighthouseRimLayer extends deckGlobal.SimpleMeshLayer {
        getShaders() {
          var e = Object.getPrototypeOf(RimLayer.prototype).getShaders.call(this);
          e.inject = RIM_SHADER_INJECT; // Qh :11346-11347 整体替换（SimpleMeshLayer 自带 inject 不留）
          return e;
        }
        initializeState() {
          super.initializeState();
          var am = this.getAttributeManager();
          // 四 instanced 属性逐字（:11455-11484）
          if (am) {
            am.addInstanced({
              instanceColorTop: {
                size: 3, type: 'float32', accessor: 'getColorTop',
                defaultValue: [1, 0, 0], transition: true
              },
              instanceColorBottom: {
                size: 3, type: 'float32', accessor: 'getColorBottom',
                defaultValue: [0, 0, 1], transition: true
              },
              instanceLayerOpacity: {
                size: 1, type: 'float32', accessor: 'getLayerOpacity',
                defaultValue: 1, transition: true
              },
              instanceEntranceProgress: {
                size: 1, type: 'float32', accessor: 'getEntranceProgress',
                defaultValue: 1, transition: true
              }
            });
          }
        }
      };
    }
    if (!GlowLayer) {
      GlowLayer = class PresenceGlowScatterplotLayer extends deckGlobal.ScatterplotLayer {
        getShaders() {
          var e = super.getShaders();
          e.modules = (e.modules || []).concat([PRESENCE_GLOW_MODULE, GLOBE_OCCLUSION_MODULE]); // Ah :10934 + patch 版遮挡函数
          var inj = e.inject || {};
          inj['vs:#main-end'] = GLOW_VS_MAIN_END; // rc :10895（bh）
          // rc :10896 compact 档选 Sh（Dh 调用点恒 compact:true :10991）；
          // Ah 在尾部再拼 Ph（:10937 拼接语义）
          inj['fs:#main-end'] = GLOW_FS_MAIN_END;
          e.inject = inj;
          return e;
        }
        draw() {
          // Ah.draw（:10941-10949）：每帧把视口 zoom 推进 presenceGlow uniform
          var vp = this.context && this.context.viewport;
          var model = this.state && this.state.model;
          if (vp && typeof vp.zoom === 'number' && model && model.shaderInputs &&
            typeof model.shaderInputs.setProps === 'function') {
            model.shaderInputs.setProps({ presenceGlow: { zoom: vp.zoom } });
          }
          return super.draw.apply(this, arguments);
        }
      };
    }
  }

  // ------------------------------------------------------------------
  //  OBJ 管线（cc()/Gh() :11325-11336 逐字语义）：
  //   parsedMesh ?? OBJ_URL —— 解析未就绪时把 URL 交给 deck 的 loaders 自解析；
  //   每次组装 fire 一个预热 parse（.catch(()=>{})），就绪后重建换为已解析对象。
  // ------------------------------------------------------------------

  var parsedMesh = null;
  var meshPromise = null;

  function loadersPair() {
    var L = global.loaders;
    if (L && typeof L.parse === 'function' && typeof L.fetchFile === 'function' && L.OBJLoader) {
      return { parseFn: fetchAndParse(L), OBJLoader: L.OBJLoader };
    }
    return null;
  }

  // hearthere Uu = vendor-loaders 导出 l = tn（:22345）：string 入参先 fetch 再 parse。
  // 我们 vendored 的 loaders UMD 无 fetchAndParse，且 parse 把字符串当内容——
  // URL 直喂 parse 会产出 0 顶点空壳（真机验收证伪），故 fetchFile→arrayBuffer→parse 等价实现。
  function fetchAndParse(L) {
    return function (url, loader) {
      return L.fetchFile(url).then(function (res) {
        return res.arrayBuffer();
      }).then(function (buf) {
        return L.parse(buf, loader);
      });
    };
  }

  function ensureMeshLoaded() {
    if (parsedMesh) return Promise.resolve(parsedMesh);
    var pair = loadersPair();
    if (!pair) return Promise.resolve(null); // deck 端 loaders:[OBJLoader] 兜底（Gh 的 URL 形态）
    if (!meshPromise) {
      var parseFn = pair.parseFn, OBJLoader = pair.OBJLoader;
      meshPromise = parseFn(OBJ_URL, OBJLoader).then(function (t) {
        parsedMesh = t;
        meshPromise = null;
        refresh(); // cc() 就绪 → 触发重建，mesh 换为已解析对象
        return t;
      }).catch(function (t) {
        meshPromise = null;
        throw t;
      });
    }
    return meshPromise;
  }

  // Gh()（:11334-11336）
  function meshSource() {
    return parsedMesh ?? OBJ_URL;
  }

  // ============================================================
  //  层工厂（逐字对照）
  // ============================================================

  // zo()（:11488-11536）
  function makeRimLayer(cfg) {
    var data = cfg.data;
    var entranceProgress = cfg.entranceProgress;
    var layerOpacity = cfg.layerOpacity;
    return new RimLayer({
      id: cfg.id,
      data: data,
      visible: cfg.visible !== false,
      pickable: cfg.pickable !== false,
      mesh: meshSource(),
      // Pl 引用：优先 window.loaders 的 OBJLoader；缺失时交回 deck 内联 loaders 注册表
      loaders: loadersPair() ? [loadersPair().OBJLoader] : undefined,
      getColor: function (c) { return getColor(c); },
      getColorTop: function (c) { return toColorVec(c.colorTop, COLOR_TOP_DEFAULT); },
      getColorBottom: function (c) { return toColorVec(c.colorBottom, COLOR_BOTTOM_DEFAULT); },
      getLayerOpacity: function () { return layerOpacity; },
      getEntranceProgress: function () { return entranceProgress; },
      transitions: {
        getColor: 1000,
        getColorTop: 1000,
        getColorBottom: 1000,
        getLayerOpacity: 100,
        getEntranceProgress: 1000
      },
      updateTriggers: {
        getColor: data.map(function (c) { return c.status; }),
        getColorTop: data.map(function (c) { return c.colorTop ? c.colorTop.join(',') : ''; }),
        getColorBottom: data.map(function (c) { return c.colorBottom ? c.colorBottom.join(',') : ''; }),
        getLayerOpacity: [layerOpacity],
        getEntranceProgress: [entranceProgress]
      },
      getPosition: function (c) { return c.position; },
      getOrientation: [0, 0, 90],
      sizeScale: RIM_SIZE_SCALE,
      _lighting: undefined,
      parameters: {
        cull: true,
        cullFace: GL_BACK,
        depthTest: true,
        depthMask: false,
        blend: true,
        blendFunc: [770, 771] // GL.SRC_ALPHA / GL.ONE_MINUS_SRC_ALPHA（so.* 数值等价）
      }
    });
  }

  // Dh()（:10981-11015），hearthere 调用点恒 compact:true（:10991）
  function makeGlowLayer(cfg) {
    var data = cfg.data;
    return new GlowLayer({
      id: cfg.id,
      data: data,
      visible: cfg.visible !== false,
      compact: true,
      pickable: false,
      getPosition: function (r) { return [r.position[0], r.position[1], GLOW_ELEVATION]; },
      getRadius: GLOW_RADIUS,
      radiusMinPixels: 17,
      radiusMaxPixels: 70,
      billboard: true,
      getFillColor: function (r) {
        var c = r.colorTop != null ? r.colorTop : COLOR_TOP_DEFAULT;
        return [c[0], c[1], c[2], GLOW_ALPHA];
      },
      transitions: { getFillColor: 300 },
      updateTriggers: {
        getFillColor: [data.map(function (r) { return r.colorTop ? r.colorTop.join(',') : ''; })]
      },
      parameters: {
        blend: true,
        blendFunc: [770, 1], // GL.ONE / GL.ONE（:11010 数值逐字，加法混合）
        depthCompare: 'always',
        depthWriteEnabled: false
      }
    });
  }

  // ============================================================
  //  运行时状态
  // ============================================================

  var state = {
    map: null,
    overlay: null,
    opts: null,
    stations: [],
    selectedId: null,
    zoom: null,
    mounted: false
  };
  var onZoomHandler = null;
  // mount epoch token（沿用 Task 4/6 修复：过期续体不得在旧 map 上留监听）
  var mountEpoch = 0;

  function currentVisible() {
    return state.mounted && tierVisible(state.zoom);
  }

  // 组装（ht :13462-13546 的常驻层子集）：
  //   station-glow-layer（全量站，:13501-13505）
  //   → lighthouse-warmup-layer（常驻，:13515-13522）
  //   → Bt 门限 → lighthouse-expanded-batch（谓词命中集，:13534-13538）
  // 头像层（:13506-13514）与 entering/exiting 扫描层（:13524-13533）归步骤④。
  function refresh() {
    if (!state.overlay || typeof state.overlay.setProps !== 'function') return;
    if (!RimLayer || !GlowLayer) return;
    var zoom = state.zoom;
    var bands = zoomBands(zoom);
    var detail = bands.detailOpacity;
    var layers = [
      makeGlowLayer({ id: 'station-glow-layer', data: state.stations, visible: true })
    ];
    // cc().catch(()=>{}) —— 每次组装 fire 预热 parse（:13515）
    ensureMeshLoaded().catch(function () {});
    layers.push(makeRimLayer({
      id: WARMUP.id,
      data: WARMUP.data,
      layerOpacity: WARMUP.opacity,
      entranceProgress: 1,
      pickable: false,
      visible: true
    }));
    if (detailVisible(Number(zoom), detail)) {
      var expanded = state.stations.filter(function (st) {
        return isExpandedRecord(st, state.opts && state.opts.currentUserId);
      });
      // selectedId 拆分（entering/exiting 扫描动画）属交互态，步骤④逐字接
      if (state.selectedId != null) {
        expanded = expanded.filter(function (st) { return st.id !== state.selectedId; });
      }
      if (expanded.length > 0) {
        layers.push(makeRimLayer({
          id: 'lighthouse-expanded-batch',
          data: expanded,
          layerOpacity: detail,
          entranceProgress: 1
        }));
      }
    }
    state.overlay.setProps({ layers: layers });
  }

  // ============================================================
  //  生命周期（page-world 契约不变）
  // ============================================================

  function mount(map, overlay, opts) {
    unmount();
    var epoch = mountEpoch;
    opts = opts || {};
    state.opts = opts;
    state.map = map || null;
    state.overlay = overlay || null;
    state.stations = (opts.stations || []).map(roomToStation).filter(Boolean);
    state.selectedId = null;
    state.zoom = (map && typeof map.getZoom === 'function') ? map.getZoom() : null;
    return Promise.resolve().then(function () {
      if (epoch !== mountEpoch) return { count: 0 }; // 已被更新的 mount 取代：整段续体止步
      if (!state.overlay) {
        console.warn('[world-lighthouse-deck] mount: overlay 缺失，灯塔层不挂载');
        return { count: 0 };
      }
      ensureLayerClasses();
      state.mounted = true;
      if (map && typeof map.on === 'function') {
        onZoomHandler = function () {
          if (epoch !== mountEpoch) return; // 残留监听 no-op（双保险）
          state.zoom = typeof map.getZoom === 'function' ? map.getZoom() : state.zoom;
          refresh();
        };
        map.on('zoom', onZoomHandler);
      }
      refresh();
      return { count: state.stations.length };
    }).catch(function (err) {
      console.warn('[world-lighthouse-deck] mount 失败', err && err.message ? err.message : err);
      state.mounted = false;
      return { count: 0 };
    });
  }

  function unmount() {
    mountEpoch++; // 作废所有在途 mount 续体与其可能注册的监听
    state.mounted = false;
    if (state.map && onZoomHandler && typeof state.map.off === 'function') {
      try { state.map.off('zoom', onZoomHandler); } catch (e) { /* ignore */ }
    }
    onZoomHandler = null;
    if (state.overlay && typeof state.overlay.setProps === 'function') {
      try { state.overlay.setProps({ layers: [] }); } catch (e) { /* ignore */ }
    }
    state.map = null;
    state.overlay = null;
    state.opts = null;
    state.stations = [];
    state.selectedId = null;
    state.zoom = null;
  }

  function refreshStations(rooms) {
    if (Array.isArray(rooms)) {
      state.stations = rooms.map(roomToStation).filter(Boolean);
    }
    refresh();
    return { count: state.stations.length };
  }

  function setSelected(id) {
    state.selectedId = id == null ? null : id;
    refresh();
  }

  function applyTier(zoom) {
    var z = Number(zoom);
    state.zoom = isFinite(z) ? z : state.zoom;
    refresh();
    return { visible: tierVisible(state.zoom), opacity: detailOpacity(state.zoom) };
  }

  // 点击拾取（hearthere GPU/CPU 分档拾取归步骤④，暂沿用 pickObject 契约）
  function pickStation(x, y) {
    if (!state.overlay || typeof state.overlay.pickObject !== 'function') return null;
    var picked = null;
    try {
      picked = state.overlay.pickObject({ x: x, y: y, radius: 10 });
    } catch (e) {
      return null;
    }
    if (!picked) return null;
    var inst = picked.instance || null;
    if (!inst && typeof picked.index === 'number' && picked.layer) {
      var data = picked.layer.props && picked.layer.props.data;
      inst = Array.isArray(data) ? data[picked.index]
        : (data && data.getObjectForIndex ? data.getObjectForIndex(picked.index) : null);
    }
    return inst && inst.id != null ? inst : null;
  }

  function getState() {
    return {
      stations: state.stations,
      selectedId: state.selectedId,
      visible: currentVisible()
    };
  }

  // ============================================================
  //  导出
  // ============================================================

  SFV.worldLighthouseDeck = {
    mount: mount,
    unmount: unmount,
    refreshStations: refreshStations,
    setSelected: setSelected,
    applyTier: applyTier,
    getState: getState,
    pickStation: pickStation,
    // 常量 / 纯函数（调试与测试用）
    WARMUP: WARMUP,
    OBJ_URL: OBJ_URL,
    RIM_SIZE_SCALE: RIM_SIZE_SCALE,
    TIER_ZOOM: TIER_ZOOM,
    TIER_FADE: TIER_FADE,
    GLOW_PRELOAD_ZOOM: GLOW_PRELOAD_ZOOM,
    GLOW_RADIUS: GLOW_RADIUS,
    COLOR_TOP_DEFAULT: COLOR_TOP_DEFAULT,
    COLOR_BOTTOM_DEFAULT: COLOR_BOTTOM_DEFAULT,
    roomToStation: roomToStation,
    getColor: getColor,
    toColorVec: toColorVec,
    zoomBands: zoomBands,
    detailOpacity: detailOpacity,
    glowOpacity: glowOpacity,
    detailVisible: detailVisible,
    tierVisible: tierVisible,
    isExpandedRecord: isExpandedRecord,
    SHADER_INJECT: RIM_SHADER_INJECT,
    SHADER_INJECT_GLOW_VS: GLOW_VS_MAIN_END,
    SHADER_INJECT_GLOW_FS: GLOW_FS_MAIN_END,
    SHADER_MODULE_GLOBE_OCCLUSION: GLOBE_OCCLUSION_MODULE
  };

  // Node 直连 require（双装载模式）：只暴露纯数据面；WebGL 依赖在 Node 下不触。
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SFV.worldLighthouseDeck;
  }
})(typeof window !== 'undefined' ? window : globalThis);
