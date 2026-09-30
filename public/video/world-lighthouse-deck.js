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
 *   · 头像贴图层（station-avatar-layer，:13506-13514）—— 步骤④-3 已接（Kh 复合层 + Hh 圆裁头像 + 首字母 SVG 兜底，无 Supabase 面）。
 *   · 选中扫描动画层（entering/exiting rim，:13524-13533）—— 步骤④-1 已接（yh 状态机逐字）。
 *   · 拾取 —— 步骤④-2 已接：SFV.worldPick GPU/CPU 分档（py/om/_c/Cc 逐字），旧 overlay.pickObject(radius) 退役。
 *   · 选中特效三件套（ParticleWave/PulseRing/VolumetricSpotlight）+ 驱动帧循环（:13576-13755）——
 *     步骤④-5a 已接：图层/GLSL/时序在 world-lighthouse-effects.js（index.html 须先于本文件装载）。
 *
 * 自研机制退役（旧版归档 _archive/world-lighthouse-deck.pre-hearthere-20260927.js）：
 *   · 程序化灯塔几何（worldLighthouseModel）→ 真 OBJ（loaders.gl 缓存管线）
 *   · 9.3 等比扫描式（-0.325/1.41、mix(-0.33,1.08)*modelHeight）→ 逐字 9.22、mix(-3,13)
 *   · 自研 rAF 逐帧入场循环 → 退役（常驻批 entranceProgress 恒 1，:13538；
 *     hearthere 的 rAF 仅④-5a 特效帧循环 :13576-13755）
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
  var ELEVATION_BASE = GLOW_ELEVATION;   // fs :10692（选态基高与光晕高度同源）
  var ELEVATION_EXPANDED = 290;      // Mn :10691（选中抬升高度）
  var SELECTION_RISE_DELAY_MS = 50;  // or :10695（抬升/进度翻转前置延时）
  var SELECTION_TWEEN_MS = 700;      // gh :10694（高度 easeOutCubic 时长）
  var SELECTION_TICK_MS = 16;        // yi :10696（setTimeout 步进）
  var ENTRANCE_MS = 1000;            // mh :10693（退场 held 基准）
  var EXIT_HOLD_MS = ENTRANCE_MS + 150; // mh+150（J :10744 退场摘层时点）
  var GLOW_ALPHA = 220;              // getFillColor alpha :11000
  var OBJ_URL = 'vendor/hearthere/lighthouse-DPszrb1Q.obj'; // Vh/Ms :11323-11324（本项目 vendor 落点）
  var GL_BACK = 1029;              // so.BACK = GL_BACK 0x0405（zo() :11529；本 deck bundle 收字符串会 GL_INVALID_ENUM）

  // 步骤④-3 头像层常量（Kh defaultProps qh :11180-11188；调用点覆盖 :13506-13514；
  //   图标像素 Bh/Uh :11020-11021；圆形头像图集宽 zh :11093）
  var AVATAR_LAYER_ID = 'station-avatar-layer'; // :13507
  var AVATAR_GLOW_RADIUS = 200;                 // :13511
  var AVATAR_SIZE = .18;                         // :13512
  var AVATAR_PICKABLE = true;                    // :13514
  var AVATAR_ICON_SIZE_HTTP = 256;               // Bh :11020
  var AVATAR_ICON_SIZE_LOCAL = 128;              // Uh :11021
  var AVATAR_ATLAS_CANVAS_WIDTH = 4096;          // zh :11093（_applyAtlasCanvasWidth :11115-11118）
  var GLOW_AVATAR_DEFAULTS = {                   // qh :11180-11188 逐字
    pickable: false, visible: true, opacity: 1,
    defaultColor: [100, 200, 255], glowRadius: 30, avatarSize: .6, elevation: 50
  };

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
      // ④-3 头像数据面（Ur :7264-7267 所需字段，缺省不凭空造值）
      if (room.avatarUrl !== undefined) passthrough.avatarUrl = room.avatarUrl;
      if (room.avatarInitial !== undefined) passthrough.avatarInitial = room.avatarInitial;
      if (room.avatarSeed !== undefined) passthrough.avatarSeed = room.avatarSeed;
      if (room.countryCode !== undefined) passthrough.countryCode = room.countryCode;
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
    // ④-3 头像数据面（API snake_case / 归一 camelCase 双兼容，缺省不凭空造值）
    if (room.avatar_url != null || room.avatarUrl != null) st.avatarUrl = room.avatar_url != null ? room.avatar_url : room.avatarUrl;
    if (room.avatarInitial !== undefined) st.avatarInitial = room.avatarInitial;
    if (room.avatarSeed !== undefined) st.avatarSeed = room.avatarSeed;
    if (room.countryCode !== undefined) st.countryCode = room.countryCode;
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

  // ============================================================
  //  步骤④-3 头像数据面（Ur :7264-7267 / cs 首字母头像 :4146-4165 / Lm :12978-12987）
  //  · 本地房间数据无 avatarUrl → 首字母渐变 SVG（与 hearthere 无头像用户同路径）
  //  · system+countryCode 的旗标 SVG（Qf/Yl :7240-7262）是听留在线专用资产：
  //    本地放映房间无 system 数据面，旗标分支按首字母兜底，不凭空造旗标。
  // ============================================================

  // Va :4124（色相调色板）/ zd :4127-4131（种子散列）/ Hd :4133-4135（XML 转义）
  var AVATAR_HUE_PALETTE = [260, 200, 340, 160, 30, 290, 180, 50, 320, 120];
  var initialsCache = new Map(); // Ga :4125
  function avatarSeedHash(s) {
    var e = 0;
    for (var n = 0; n < s.length; n++) {
      e = (e << 5) - e + s.charCodeAt(n);
      e |= 0;
    }
    return Math.abs(e);
  }
  function xmlEscape(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  // Wl :4137-4139：取码点首字符（Array.from 保中文码点完整）
  function firstChar(s) {
    var list = Array.from(String(s).trim());
    return list[0] != null ? list[0] : '?';
  }
  // ls :4141-4144
  function nameInitial(name, seed) {
    return firstChar((name && name.trim()) || (seed && seed.trim()) || '?').toUpperCase();
  }
  // cs :4146-4165 逐字（128×128 圆渐变 + 白字 + data URI + 同键缓存）
  function initialsAvatarUrl(text, seed) {
    var n = firstChar(text || '?').toUpperCase();
    var o = seed || n;
    var r = 'initial:' + n + ':' + o;
    var cached = initialsCache.get(r);
    if (cached) return cached;
    var l = AVATAR_HUE_PALETTE[avatarSeedHash(o) % AVATAR_HUE_PALETTE.length];
    var c = (l + 40) % 360;
    var u = xmlEscape(n);
    var d = '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">\n' +
      '        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">\n' +
      '            <stop offset="0%" stop-color="hsl(' + l + ',70%,45%)"/>\n' +
      '            <stop offset="100%" stop-color="hsl(' + c + ',80%,55%)"/>\n' +
      '        </linearGradient></defs>\n' +
      '        <rect width="128" height="128" rx="64" fill="url(#g)"/>\n' +
      '        <text x="64" y="82" text-anchor="middle" font-size="64" font-family="Arial,sans-serif" font-weight="bold" fill="white">' + u + '</text>\n' +
      '    </svg>';
    var f = 'data:image/svg+xml,' + encodeURIComponent(d);
    initialsCache.set(r, f);
    return f;
  }
  // Ur :7264-7267 本地数据面：user 直喂 avatarUrl（ks/Nr CDN 白名单归一链属 Supabase
  //   头像体系，本地无此数据面【用户裁决：不使用 Supabase】）；
  //   无头像 → cs 首字母 SVG；system+countryCode 旗标（Qf）为在线站专属，本地无数据面 → 同落首字母。
  function stationAvatarUrl(st) {
    if (!st) return null;
    var e = st.displayKind != null ? st.displayKind : st.ownerType;
    var initials = st.avatarInitial != null ? st.avatarInitial : nameInitial(st.name, st.id);
    var seed = st.avatarSeed != null ? st.avatarSeed : (st.name != null ? st.name : st.id);
    if (st.avatarUrl) {
      return e === 'user' ? initialsAvatarUrl(initials, seed) : st.avatarUrl;
    }
    return initialsAvatarUrl(initials, seed);
  }
  // $（S :10702）：getAvatarOpacity 恒 1
  function getAvatarOpacity() { return 1; }
  // Lm :12978-12987（Rm :13000-13008 对本地全量 haloIds 恒通过）
  function stationAvatarData(st) {
    if (!st) return null;
    return {
      id: st.id,
      position: st.position,
      avatarUrl: stationAvatarUrl(st),
      color: st.colorTop,
      itemOpacity: getAvatarOpacity(st.id),
      itemElevation: stationElevation(st.id, st)
    };
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

  // detailVisible：Bt 组装门（ht :13523）—— zoom >= St-xt(11.5) 或 detailOpacity > .01
  //（Sr(sc=11, :10633-10635) 为头像 warming 装配门，语义另立，归 ④-5b）
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

  // Hh.getShaders「fs:#main-end」（:11162-11175）逐字：圆形裁剪 + 边缘抗锯齿（拾取态不裁剪）
  var CIRCLE_CROP_FS = `
        if (picking.isActive < 0.5) {
          // uv 范围是 [-1, 1]
          float dist = length(uv);
          
          // 圆形裁剪：距离 > 1 的像素透明
          if (dist > 1.0) {
            discard;
          }
          
          // 边缘抗锯齿
          float edge = smoothstep(0.95, 1.0, dist);
          fragColor.a *= (1.0 - edge);
        }
      `;

  // ============================================================
  //  WebGL 依赖区（仅浏览器路径；Node require 不触以下代码）
  // ============================================================

  var RimLayer = null;   // Qh LighthouseRimLayer
  var GlowLayer = null;  // Ah PresenceGlowScatterplotLayer（rc 星点 + presenceGlow 淡出）
  var CircleAvatarLayer = null; // Hh CircleAvatarLayer :11094-11179
  var AvatarComposite = null;   // Kh GlowAvatarLayer :11189-11320

  function ensureLayerClasses() {
    if (RimLayer && GlowLayer && CircleAvatarLayer && AvatarComposite) return;
    var deckGlobal = global.deck;
    if (!deckGlobal || !deckGlobal.SimpleMeshLayer || !deckGlobal.ScatterplotLayer ||
      !deckGlobal.IconLayer || !deckGlobal.CompositeLayer) {
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
    if (!CircleAvatarLayer) {
      // Hh CircleAvatarLayer（:11094-11179）：IconLayer + 圆形裁剪 fs + 图集宽 4096 +
      //   图标签名变化时重置 iconManager（防 atlas 脏缓存 :11119-11148）
      CircleAvatarLayer = class CircleAvatarLayer extends deckGlobal.IconLayer {
        constructor(props) {
          super(props);
          this._applyAtlasCanvasWidth();
        }
        initializeState(...e) {
          var r = super.initializeState.apply(this, e);
          this._applyAtlasCanvasWidth();
          return r;
        }
        updateState(...e) {
          this._resetIconManagerForIconSetChange(e[0]);
          var r = super.updateState.apply(this, e);
          this._applyAtlasCanvasWidth();
          return r;
        }
        _applyAtlasCanvasWidth() {
          var e = this.state && this.state.iconManager;
          if (e && '_canvasWidth' in e) e._canvasWidth = AVATAR_ATLAS_CANVAS_WIDTH; // zh :11093
        }
        _resetIconManagerForIconSetChange(e) {
          if (!this._shouldCheckIconSignature(e && e.changeFlags)) return;
          var n = (e && e.props) || this.props;
          var o = this.state && this.state.iconManager;
          if (!o || o._pendingCount !== 0) return;
          var r = this.state;
          var i = this._getIconSignature(n);
          if (i === r.avatarAtlasIconSignature) return;
          var l = !!(o._texture || Object.keys(o._mapping || {}).length > 0);
          if (r.avatarAtlasIconSignature = i, !!l) {
            try { if (o._texture && o._texture.destroy) o._texture.destroy(); } catch (err) { /* ignore */ }
            o._texture = null; o._externalTexture = null; o._mapping = {};
            o._xOffset = 0; o._yOffset = 0; o._rowHeight = 0; o._canvasHeight = 0;
            this._applyAtlasCanvasWidth();
          }
        }
        _shouldCheckIconSignature(e) {
          if (!e || e.dataChanged) return true;
          var n = e.updateTriggersChanged;
          return !!(n && (n === true || n.all || n.getIcon));
        }
        _getIconSignature(e) {
          var n = Array.isArray(e.data) ? e.data : [];
          var o = e.getIcon;
          return o ? n.map(function (r) {
            var i = o(r);
            return typeof i == 'string' ? i
              : i ? `${i.id ?? i.url ?? ''}|${i.width ?? ''}|${i.height ?? ''}|${i.anchorX ?? ''}|${i.anchorY ?? ''}|${i.mask ?? ''}` : '';
          }).join('\n') : '';
        }
        getShaders() {
          var e = super.getShaders();
          e.inject = Object.assign({}, e.inject, { 'fs:#main-end': CIRCLE_CROP_FS });
          return e;
        }
      };
    }
    if (!AvatarComposite) {
      // Kh GlowAvatarLayer（:11180-11320）：composite = 光晕子层（rc 同构）+ 头像子层（Hh）
      AvatarComposite = class GlowAvatarLayer extends deckGlobal.CompositeLayer {
        static defaultProps = GLOW_AVATAR_DEFAULTS; // qh :11180-11188（deck 基类构造器合并）
        _getPhotoData(e) {
          if (e === this._cachedPhotoSource) return this._cachedPhotoData;
          this._cachedPhotoSource = e;
          this._cachedPhotoData = e.filter(function (n) { return n.hasPhoto !== false; });
          return this._cachedPhotoData;
        }
        _getUpdateTriggers(e) {
          var self = this;
          if (e.length !== this._cachedDataLength) {
            this._cachedDataLength = e.length;
            this._cachedOpacityTrigger = e.map(function (r) { return r.itemOpacity; });
            this._cachedElevationTrigger = e.map(function (r) { return r.itemElevation; });
            return { opacity: this._cachedOpacityTrigger, elevation: this._cachedElevationTrigger };
          }
          var n = false, o = false;
          for (var r = 0; r < e.length; r++) {
            if (e[r].itemOpacity !== this._cachedOpacityTrigger[r]) n = true;
            if (e[r].itemElevation !== this._cachedElevationTrigger[r]) o = true;
            if (n && o) break;
          }
          if (n) this._cachedOpacityTrigger = e.map(function (x) { return x.itemOpacity; });
          if (o) this._cachedElevationTrigger = e.map(function (x) { return x.itemElevation; });
          return { opacity: this._cachedOpacityTrigger, elevation: this._cachedElevationTrigger };
        }
        renderLayers() {
          var e = this.props;
          var o = e.data, r = e.pickable, i = e.visible, l = e.opacity,
            c = e.defaultColor, u = e.glowRadius, d = e.avatarSize, f = e.elevation;
          if (!o || o.length === 0) return []; // :11244-11248
          var p = this._getUpdateTriggers(o);
          var h = this._getPhotoData(o);
          var m = new GlowLayer({ // rc（:11251-11278；PresenceGlowScatterplotLayer，compact 真→Sh 星点 fs :10890-10898）
            id: e.id + '-glow',
            data: o,
            pickable: false,
            visible: i,
            opacity: l,
            compact: true,
            billboard: true,
            getPosition: function (v) { return [v.position[0], v.position[1], v.itemElevation != null ? v.itemElevation : f]; },
            getRadius: function () { return u; },
            radiusUnits: 'meters',
            getFillColor: function (v) {
              var b = v.color || c, x = v.itemOpacity != null ? v.itemOpacity : 1;
              return [b[0], b[1], b[2], x * 255];
            },
            parameters: {
              blend: true,
              blendFunc: [770, 1], // GL.ONE/GL.ONE（:11268 数值逐字）
              depthWriteEnabled: false
            },
            updateTriggers: {
              getFillColor: p.opacity,
              getPosition: p.elevation
            },
            transitions: { getFillColor: 300 }
          });
          var y = u * 2 * d; // :11279
          var w = new CircleAvatarLayer({ // Hh（:11280-11314）
            id: e.id + '-avatar',
            data: h,
            pickable: r,
            visible: i,
            opacity: l,
            getIcon: function (v) {
              var x = v.avatarUrl.indexOf('http') === 0 ? AVATAR_ICON_SIZE_HTTP : AVATAR_ICON_SIZE_LOCAL; // Bh/Uh :11287
              return { url: v.avatarUrl, width: x, height: x, anchorY: x / 2 };
            },
            getPosition: function (v) { return [v.position[0], v.position[1], v.itemElevation != null ? v.itemElevation : f]; },
            getSize: function () { return y; },
            sizeUnits: 'meters',
            getColor: function (v) { return [255, 255, 255, (v.itemOpacity != null ? v.itemOpacity : 1) * 255]; },
            loadOptions: { fetch: { mode: 'cors' } }, // :11299-11303
            parameters: { depthWriteEnabled: true },
            updateTriggers: {
              getColor: p.opacity,
              getPosition: p.elevation
            },
            transitions: { getColor: 300 }
          });
          return [m, w]; // g=[m,w] :11315
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
    zoom: null,
    mounted: false
  };
  var onZoomHandler = null;
  // mount epoch token（沿用 Task 4/6 修复：过期续体不得在旧 map 上留监听）
  var mountEpoch = 0;

  function currentVisible() {
    return state.mounted && tierVisible(state.zoom);
  }

  // ============================================================
  //  步骤④-1：选中状态机（yh :10698-10779 的命令式转写）
  //  · 进入：选中站独立 rim 层先 entranceProgress=0，or=50ms 后置 1，
  //    由 deck transitions(getEntranceProgress,1000ms) 演入场扫描；
  //    高度 80→290 走 easeOutCubic(gh=700ms / yi=16ms tick)。
  //  · 退场：被取代站 held 290 共 mh+150=1150ms（rim progress 1→0 反扫），
  //    到点摘层并回落 80，完成清 override（getElevation 读回基高）。
  //  · expanded 批内已常驻可见 → skipAnimation（ze :13757-13762）。
  //  · 高度只喂光晕/头像/拾取投影（rim 层 getPosition 恒 [lon,lat]，:11523）；
  //    每 tick 的 ht() 重建在头像层接线（④-3）前无可视差，暂不触发组装。
  // ============================================================

  var sel = {
    selectedId: null,       // v.current / o :10702
    enterProgress: 1,       // A enterProgress
    exitingStation: null,   // c exitingData（退场时冻结的站记录）
    exitProgress: 1,        // d exitProgress
    lastExitedId: null      // b.current（防连点误清后继退场态）
  };
  var elevations = new Map();  // p/m.current 高度 override 表
  var tweenTimers = new Map(); // g 每站过渡 timer
  var exitTimers = new Map();  // y 每站退场摘层 timer
  var riseTimers = new Map();  // w 每站延迟抬升 timer
  var flipTimers = [];         // or 进度翻转匿名 timer（卸载兜底 :10767-10768）

  function later(fn, ms) {
    var id = setTimeout(function () {
      flipTimers = flipTimers.filter(function (t) { return t !== id; });
      fn();
    }, ms);
    flipTimers.push(id);
    return id;
  }

  function findStation(id) {
    for (var i = 0; i < state.stations.length; i++) {
      if (state.stations[i].id === id) return state.stations[i];
    }
    return null;
  }

  function setElevation(id, v) {              // P :10705-10709（undefined=删除）
    if (v === undefined) elevations.delete(id); else elevations.set(id, v);
  }
  function clearTweenTimer(id) {              // M :10710-10712
    var t = tweenTimers.get(id);
    if (t) { clearTimeout(t); tweenTimers.delete(id); }
  }
  function clearRiseTimer(id) {               // R :10713-10715
    var t = riseTimers.get(id);
    if (t) { clearTimeout(t); riseTimers.delete(id); }
  }
  function currentElevation(id) {             // C :10716
    if (elevations.has(id)) return elevations.get(id);
    return sel.selectedId === id ? ELEVATION_EXPANDED : ELEVATION_BASE;
  }

  function tweenTo(id, target, clearOverrideOnComplete) { // A :10716-10731
    clearTweenTimer(id);
    var from = currentElevation(id);
    var start = Date.now();
    var tickFn = function () {
      var k = Math.min(1, (Date.now() - start) / SELECTION_TWEEN_MS);
      var d = 1 - Math.pow(1 - k, 3);          // easeOutCubic :10723
      if (k >= 1) {
        tweenTimers.delete(id);
        setElevation(id, clearOverrideOnComplete ? undefined : target);
        refresh(); // 完成拍同样重组（React 渲染节拍等价）
        return;
      }
      setElevation(id, from + (target - from) * d);
      // ht 依赖含高度面（K/p :13265,13546）：④-3 起每 tick 重建头像数据
      tweenTimers.set(id, setTimeout(tickFn, SELECTION_TICK_MS));
      refresh();
    };
    setElevation(id, from);
    tweenTimers.set(id, setTimeout(tickFn, SELECTION_TICK_MS));
  }

  function triggerExit(id) {                  // J :10732-10744
    var st = findStation(id);
    if (!st) return;
    var et = exitTimers.get(id);
    if (et) { clearTimeout(et); exitTimers.delete(id); }
    clearRiseTimer(id);
    clearTweenTimer(id);
    sel.lastExitedId = id;
    sel.exitingStation = st;
    sel.exitProgress = 1;
    later(function () { sel.exitProgress = 0; refresh(); }, SELECTION_RISE_DELAY_MS);
    setElevation(id, ELEVATION_EXPANDED);      // 退场期 held 290 :10738
    exitTimers.set(id, setTimeout(function () {
      exitTimers.delete(id);
      if (sel.lastExitedId === id) { sel.exitingStation = null; sel.exitProgress = 1; }
      tweenTo(id, ELEVATION_BASE, true);       // 1150ms 后回落 :10741
      refresh();
    }, EXIT_HOLD_MS));
  }

  function selectLighthouse(id, skipAnimation) { // Q :10745-10762 + ze :13757-13762
    if (id === sel.selectedId) return;           // :10746 T !== q
    var prev = sel.selectedId;
    if (prev != null) triggerExit(prev);
    clearRiseTimer(id);
    clearTweenTimer(id);
    if (skipAnimation) {
      setElevation(id, ELEVATION_EXPANDED);      // :10749 P(T,Mn)
    } else {
      setElevation(id, currentElevation(id));    // :10751 置当前高度起步
      riseTimers.set(id, setTimeout(function () {
        riseTimers.delete(id);
        if (sel.selectedId === id) tweenTo(id, ELEVATION_EXPANDED, true); // :10754
      }, SELECTION_RISE_DELAY_MS));
    }
    sel.selectedId = id;                         // :10759 v.current = T
    if (skipAnimation) {
      sel.enterProgress = 1;
    } else {
      sel.enterProgress = 0;                     // :10759-10761 0 →(or)→ 1
      later(function () { sel.enterProgress = 1; refresh(); }, SELECTION_RISE_DELAY_MS);
    }
    refresh();
    scheduleEffectsFrame();                      // ④-5a：空闲挂起后重选中需唤醒驱动
  }

  function setSelected(id) {
    if (id == null) { clearSelection(); return; }
    var st = findStation(id);
    // ze :13758：已在 expanded 批（谓词命中且非当前选中）→ 免扫描动画
    var inExpanded = !!(st && st.id !== sel.selectedId &&
      isExpandedRecord(st, state.opts && state.opts.currentUserId));
    selectLighthouse(id, inExpanded);
  }

  function clearSelection() {                   // X/T :10763-10766
    var cur = sel.selectedId;
    if (cur != null) { triggerExit(cur); sel.selectedId = null; }
    refresh();
    scheduleEffectsFrame();                      // ④-5a：ramp 下行窗需驱动续排
  }

  function getAvatarElevation(id) {             // _ :10702-10704（undefined=不抬升）
    if (elevations.has(id)) return elevations.get(id);
    return id === sel.selectedId ? ELEVATION_EXPANDED : undefined;
  }

  // K :13265（批内恒 290，否则读 override）；record 供数据面直调（ee 命中判断免查表）
  function stationElevation(id, record) {
    var st = record || (typeof id === 'string' ? findStation(id) : id);
    var key = st ? st.id : id;
    if (key != null && key !== sel.selectedId && st &&
      isExpandedRecord(st, state.opts && state.opts.currentUserId)) {
      return ELEVATION_EXPANDED;
    }
    return getAvatarElevation(key);
  }

  function resetSelectionMachine() {
    exitTimers.forEach(function (t) { clearTimeout(t); });
    riseTimers.forEach(function (t) { clearTimeout(t); });
    tweenTimers.forEach(function (t) { clearTimeout(t); });
    flipTimers.forEach(function (t) { clearTimeout(t); });
    exitTimers.clear(); riseTimers.clear(); tweenTimers.clear();
    flipTimers = [];
    elevations.clear();
    sel.selectedId = null; sel.enterProgress = 1;
    sel.exitingStation = null; sel.exitProgress = 1; sel.lastExitedId = null;
  }

  // 组装（ht :13462-13546 的常驻层子集）：
  //   station-glow-layer（全量站，:13501-13505）
  //   → station-avatar-layer（:13506-13514，b.length>0 才挂；每次组装重建，
  //     实例缓存 tt :13498-13499 只作用于光晕层，头像层 hearthere 本就逐拍新建）
  //   → lighthouse-warmup-layer（常驻，:13515-13522）
  //   → Bt 门限（:13523）→ exiting rim → entering rim → expanded-batch（:13524-13538）
  // 光晕层实例缓存 = tt/i.current（:13498-13506）：data（state.stations 引用）未变复用同实例。
  var glowLayerCache = null; // {data, layer}

  function refresh() {
    if (!state.overlay || typeof state.overlay.setProps !== 'function') return;
    if (!RimLayer || !GlowLayer) return;
    var zoom = state.zoom;
    var bands = zoomBands(zoom);
    var detail = bands.detailOpacity;
    slotTouched = Object.create(null); // ④-5b修复轮：本拍装配命中的槽位才允许跨拍复用
    if (!glowLayerCache || glowLayerCache.data !== state.stations) {
      glowLayerCache = {
        data: state.stations,
        layer: makeGlowLayer({ id: 'station-glow-layer', data: state.stations, visible: true })
      };
    }
    var layers = [glowLayerCache.layer];
    // Kh 头像层（:13506-13514）：elevation=fs、glowRadius 200、avatarSize .18、pickable
    // ④-5b：data = Rm（Sr 门控，:12989-13009）；基座槽 + Em 逐拍克隆（:13656-13657）
    if (AvatarComposite && state.stations.length > 0) {
      var byId = stationByIdMap();
      var ze = avatarPrepareSet({
        zoom: Number(zoom),
        detailOpacity: detail,
        forcePrepare: false,                      // ie 网络预热面未移植 → 恒 false（裁决 2026-09-30）
        haloIds: state.stations.map(function (st) { return st.id; }), // 本地全量 ≡「已预热」
        photoIds: EMPTY_ID_SET,                   // 无照片面
        stationById: byId,
        getAvatarOpacity: getAvatarOpacity,
        getElevation: function (id) { return stationElevation(id, byId.get(id)); }
      });
      var avatarBase = slotBase('avatar', avatarSig() + '|' + ze.length, function () {
        return new AvatarComposite({
          id: AVATAR_LAYER_ID,
          data: ze,
          opacity: detail,
          visible: true,
          glowRadius: AVATAR_GLOW_RADIUS,
          avatarSize: AVATAR_SIZE,
          elevation: ELEVATION_BASE,
          pickable: AVATAR_PICKABLE
        });
      });
      layers.push(opacityClone(avatarBase, bands.glowOpacity, detail));
    }
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
      // le :13262 只排除当前选中；exiting 站若命中谓词仍在批内（与扫描层并画）
      if (sel.selectedId != null) {
        expanded = expanded.filter(function (st) { return st.id !== sel.selectedId; });
      }
      // ht :13495-13497：Oe(null=未启用视窗过滤) → 全量；否则 expanded ∩ visibleIds
      var ot = visState.visibleIds;
      if (ot !== null) {
        var atSet = new Set(ot);
        expanded = expanded.filter(function (st) { return atSet.has(st.id); });
      }
      // ht :13524-13528：exiting 层（progress=Q 反扫）
      // meshTag：OBJ 解析态入 sig——基座缓存必须随 meshSource（URL→已解析对象）失效重建
      var meshTag = parsedMesh ? 'm1' : 'm0';
      if (sel.exitingStation) {
        var xBase = slotBase('rim-exiting-' + sel.exitingStation.id,
          rimSig([sel.exitingStation], sel.exitProgress) + meshTag,
          function () {
            return makeRimLayer({
              id: 'lighthouse-rim-layer-' + sel.exitingStation.id,
              data: [sel.exitingStation],
              layerOpacity: detail,
              entranceProgress: sel.exitProgress
            });
          });
        layers.push(opacityClone(xBase, bands.glowOpacity, detail));
      }
      // ht :13529-13533：entering 层（progress=A 入场扫描；选中站被删则无层）
      var entering = sel.selectedId != null ? findStation(sel.selectedId) : null;
      if (entering) {
        var eBase = slotBase('rim-entering-' + entering.id,
          rimSig([entering], sel.enterProgress) + meshTag,
          function () {
            return makeRimLayer({
              id: 'lighthouse-rim-layer-' + entering.id,
              data: [entering],
              layerOpacity: detail,
              entranceProgress: sel.enterProgress
            });
          });
        layers.push(opacityClone(eBase, bands.glowOpacity, detail));
      }
      // ht :13534-13538：expanded 批（恒 progress=1）
      if (expanded.length > 0) {
        var bBase = slotBase('rim-expanded-batch',
          rimSig(expanded, 1) + meshTag,
          function () {
            return makeRimLayer({
              id: 'lighthouse-expanded-batch',
              data: expanded,
              layerOpacity: detail,
              entranceProgress: 1
            });
          });
        layers.push(opacityClone(bBase, bands.glowOpacity, detail));
      }
    }
    // ④-5a 选中特效三件套（:13683-13705）：装配门 on && rn>.01 && tt —— 不吃 Bt 门，
    //   lhOpacity 交叉淡出由 fh 与 opacity=rn×detail 承担；次序 particle→pulse→spotlight
    var rn = fxDriver.ramp.current;
    if (Wave && Ring && Spot && flight.selectedDynamicEffectsReady && rn > .01) {
      var ttSel = selectedStation();
      if (ttSel) {
        var nt = ttSel.colorTop ? [ttSel.colorTop[0] / 255, ttSel.colorTop[1] / 255, ttSel.colorTop[2] / 255] : [0, .9, 1];     // :13684
        var bt = ttSel.colorBottom ? [ttSel.colorBottom[0] / 255, ttSel.colorBottom[1] / 255, ttSel.colorBottom[2] / 255] : [.2, .4, 1]; // :13685
        layers.push(Wave.build({
          data: effectsLib().particleData(ttSel.position),
          time: fxDriver.timeBase,
          audioMid: .3,            // :13690
          isIdle: true,            // :13691（本项目无音频分析器 → 恒待机域，audioHistory 全零）
          opacity: rn * detail,
          colorTop: nt,
          colorMiddle: bt
        }));
        layers.push(Ring.build({
          data: ttSel,
          time: fxDriver.timeBase,
          opacity: rn,             // pulse 只取 rn（不含 lhOpacity，:13697）
          colorTop: nt,
          colorBottom: bt
        }));
        layers.push(Spot.build({
          data: [ttSel],           // Bt=I.current（:13702 聚光数据=选中站单元数组）
          time: fxDriver.timeBase,
          layerOpacity: rn * detail
        }));
      }
    }
    pruneUntouchedSlots(); // 摘拍槽位即失效——deck v9 _initialize 断言 !internalState，
    // 曾被初始化/已 finalize 的实例回加必炸（修复轮根因见 layer-lifecycle 测试头注）
    state.overlay.setProps({ layers: layers });
  }

  // ============================================================
  //  步骤④-5a：选中特效三件套 + 驱动时序（world-lighthouse-effects.js 逐字移植件）
  //  · 驱动 :13576-13707 —— Ze=(ce-Se)/1e3、ot=min(Ze,.025)（只裁 ramp，me 累加原始 Ze）、
  //    Ge ramp ge=2 越界吸附 target（:13674-13678）、vo 三门 on&&Fn&&fh（:13595）、
  //    选中变更 ramp 归零重起（:13596）、装配门 on && rn>.01 && tt（:13683）、
  //    三层次序 particle→pulse→spotlight、色 /255（:13684-13685）、
  //    wave/spotlight opacity=rn×lhOpacity、pulse 只取 rn（:13686-13702）
  //  · 节流 km=1000/30：Am 活跃恒真、空闲 timePassed（:12933-12949）
  //  · 空闲挂起：无选中/展开且特效窗结束 → 不再排帧（:13645-13648）
  //  · 裁决（用户 2026-09-30「可」）：beacon-blink 两层、外部层域与头像网络预热不移植
  //    → hasActiveExternalLayers / hasSelectionAnimationWindow 恒 false
  // ============================================================

  function effectsLib() {
    if (!SFV.worldLighthouseEffects && typeof module !== 'undefined' && module.exports &&
      typeof require === 'function') {
      try { require('./world-lighthouse-effects.js'); } catch (e) { /* 浏览器路径必有 script 标签 */ }
    }
    return SFV.worldLighthouseEffects || null;
  }
  function fxOrThrow() {
    var f = effectsLib();
    if (!f) throw new Error('[world-lighthouse-deck] world-lighthouse-effects 未加载（index.html 须先于 deck）');
    return f;
  }

  var Wave = null, Ring = null, Spot = null;  // {cls, build} 惰性工厂（同 RimLayer/GlowLayer 模式）

  function ensureEffectLayers() {
    var f = effectsLib();
    if (!f) return false;
    var deckGlobal = global.deck;
    if (!deckGlobal || !deckGlobal.ScatterplotLayer || !deckGlobal.SimpleMeshLayer) return false;
    if (!Wave) Wave = f.createParticleWaveLayer(deckGlobal.ScatterplotLayer);
    if (!Ring) Ring = f.createPulseRingLayer(deckGlobal.ScatterplotLayer);
    if (!Spot) Spot = f.createSpotlightLayer(deckGlobal.SimpleMeshLayer);
    return true;
  }

  function buildParticleWave(props) { ensureEffectLayers(); return Wave ? Wave.build(props) : null; }
  function buildPulseRing(props) { ensureEffectLayers(); return Ring ? Ring.build(props) : null; }
  function buildSpotlight(props) { ensureEffectLayers(); return Spot ? Spot.build(props) : null; }

  var fxDriver = {
    timeBase: 0,                        // me.current（原始 Ze 累加，不裁剪 :13591）
    lastNow: null,                      // Se.current
    ramp: { current: 0, target: 0 },    // Ge（xe.current）
    armedId: null,                      // ae.current
    lastVo: false,
    lastUpdateAt: 0,                    // Ne.current
    raf: null                           // _e.current
  };

  function selectedStation() {
    return sel.selectedId != null ? findStation(sel.selectedId) : null;
  }

  // vo 三门（:13595）—— on(selectedDynamicEffectsReady) && Fn(选中 id===armed id) && fh(站, lhOpacity)
  function effectsVo() {
    var f = effectsLib();
    if (!f) return false;
    var tt = selectedStation();
    var Kt = tt ? tt.id : null;
    var Fn = Kt !== null && Kt === sel.selectedId;
    return f.selectedEffectsGate(flight.selectedDynamicEffectsReady, Fn,
      f.effectsGateActive(tt, zoomBands(state.zoom).detailOpacity));
  }

  // 单帧推进（:13591-13597 + :13674-13678）
  function advanceEffectsClock(deltaSec) {
    var f = fxOrThrow();
    fxDriver.timeBase += deltaSec;               // me.current += Ze
    var tt = selectedStation();
    var Kt = tt ? tt.id : null;
    if (Kt !== fxDriver.armedId) {               // 选中变更 → ramp 归零重起（:13596）
      fxDriver.armedId = Kt;
      if (Kt !== null) fxDriver.ramp.current = 0;
    }
    fxDriver.lastVo = effectsVo();
    fxDriver.ramp.target = fxDriver.lastVo ? 1 : 0;   // Ge.target（:13597）
    if (fxDriver.ramp.current !== fxDriver.ramp.target) {
      fxDriver.ramp = f.rampStep(fxDriver.ramp, f.clampFrameDelta(deltaSec)); // nt·ge·ot + 吸附
    }
  }

  function stepSelectedEffects(dtSec) {          // 手动/测试驱动拍：推进一帧并重组
    if (!effectsLib()) return;
    advanceEffectsClock(dtSec);
    refresh();
  }

  // :13604 sn —— !!E.current || 展开批非空
  function selectedOrExpandedPresent() {
    if (sel.selectedId != null) return true;
    for (var i = 0; i < state.stations.length; i++) {
      if (isExpandedRecord(state.stations[i], state.opts && state.opts.currentUserId)) return true;
    }
    return false;
  }

  // :13600 Vt —— vo || rn>.01 || rn!==target
  function effectsWindowActive() {
    return fxDriver.lastVo || fxDriver.ramp.current > .01 ||
      fxDriver.ramp.current !== fxDriver.ramp.target;
  }

  function scheduleEffectsFrame() {
    if (fxDriver.raf != null) return;
    var raf = global.requestAnimationFrame;
    if (typeof raf !== 'function') return;       // Node/vm 沙箱无 rAF → stepSelectedEffects 驱动
    fxDriver.raf = raf(function (now) {
      fxDriver.raf = null;
      effectsFrame(now);
    });
  }

  function stopEffectLoop() {
    if (fxDriver.raf != null && typeof global.cancelAnimationFrame === 'function') {
      try { global.cancelAnimationFrame(fxDriver.raf); } catch (e) { /* ignore */ }
    }
    fxDriver.raf = null;
  }

  function resetEffectDriver() {
    stopEffectLoop();
    fxDriver.timeBase = 0;
    fxDriver.ramp = { current: 0, target: 0 };
    fxDriver.armedId = null;
    fxDriver.lastVo = false;
    fxDriver.lastNow = null;
    fxDriver.lastUpdateAt = 0;
  }

  function effectsFrame(now) {
    if (!state.mounted) return;
    var f = effectsLib();
    if (!f) return;
    var prev = fxDriver.lastNow == null ? now : fxDriver.lastNow;
    var Ze = (now - prev) / 1e3;                  // :13589
    fxDriver.lastNow = now;
    advanceEffectsClock(Ze);
    var sn = selectedOrExpandedPresent();
    var Vt = effectsWindowActive();
    var _t = zoomBands(state.zoom).detailOpacity;
    if (f.shouldUpdateFrame({
      now: now, lastUpdateAt: fxDriver.lastUpdateAt,
      hasActiveSelectedDynamicEffects: Vt,
      hasActiveExternalLayers: false,
      hasSelectionAnimationWindow: false,
      isProgrammaticCameraFlight: flight.isProgrammaticCameraFlight,
      hasVisibleSelectedOrExpandedLighthouse: _t > .01 && sn
    })) {
      fxDriver.lastUpdateAt = now;
      refresh();
    }
    if (!sn && !Vt) return;                       // 空闲挂起（:13645-13648）
    scheduleEffectsFrame();
  }

  // （三层入列直接位于 refresh() 内 setProps 前，见 :13683-13705 对应块）

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
    resetSelectionMachine();
    state.zoom = (map && typeof map.getZoom === 'function') ? map.getZoom() : null;
    return Promise.resolve().then(function () {
      if (epoch !== mountEpoch) return { count: 0 }; // 已被更新的 mount 取代：整段续体止步
      if (!state.overlay) {
        console.warn('[world-lighthouse-deck] mount: overlay 缺失，灯塔层不挂载');
        return { count: 0 };
      }
      ensureLayerClasses();
      resetEffectDriver();
      ensureEffectLayers();
      resetVisibleMachine();
      state.mounted = true;
      if (map && typeof map.on === 'function') {
        onZoomHandler = function () {
          if (epoch !== mountEpoch) return; // 残留监听 no-op（双保险）
          state.zoom = typeof map.getZoom === 'function' ? map.getZoom() : state.zoom;
          refresh();
          updateVisibleIds('replace'); // de 依赖 [t,M] → 跨档 replace（effect :13431-13433）
          scheduleEffectsFrame();
        };
        map.on('zoom', onZoomHandler);
        // ④-5b 事件防抖 :13549-13575：move/zoom → Ri accumulate 尾定时器、moveend → Nm replace
        onVisMoveHandler = function () {
          if (epoch !== mountEpoch) return;
          visOnMove();
        };
        onVisMoveEndHandler = function () {
          if (epoch !== mountEpoch) return;
          visOnMoveEnd();
        };
        map.on('move', onVisMoveHandler);
        map.on('moveend', onVisMoveEndHandler);
      }
      refresh();
      updateVisibleIds('replace'); // 初始 replace（:13573 te.current?.("replace")）
      scheduleEffectsFrame();
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
    if (state.map && typeof state.map.off === 'function') {
      try {
        if (onVisMoveHandler) state.map.off('move', onVisMoveHandler);
        if (onVisMoveEndHandler) state.map.off('moveend', onVisMoveEndHandler);
      } catch (e) { /* ignore */ }
    }
    onVisMoveHandler = null;
    onVisMoveEndHandler = null;
    resetVisibleMachine(); // ④-5b：清定时器/可见集/基座槽（Oe.current 复位）
    clearFlightListener(); // 卸载摘除在途飞行 moveend（zn 卸载 effect :19598-19600）
    resetEffectDriver();   // ④-5a：停 RAF、清 ramp/时基
    flight.isProgrammaticCameraFlight = false;
    flight.selectedDynamicEffectsReady = true;
    flight.target = null;
    flight.seq = 0; flight.activeSeq = 0;
    if (state.overlay && typeof state.overlay.setProps === 'function') {
      try { state.overlay.setProps({ layers: [] }); } catch (e) { /* ignore */ }
    }
    state.map = null;
    state.overlay = null;
    state.opts = null;
    state.stations = [];
    glowLayerCache = null;
    resetSelectionMachine();
    state.zoom = null;
  }

  function refreshStations(rooms) {
    if (Array.isArray(rooms)) {
      state.stations = rooms.map(roomToStation).filter(Boolean);
    }
    refresh();
    updateVisibleIds('replace'); // de 依赖 [le] → 站表变化 replace（effect :13431-13433）
    return { count: state.stations.length };
  }

  function applyTier(zoom) {
    var z = Number(zoom);
    state.zoom = isFinite(z) ? z : state.zoom;
    refresh();
    updateVisibleIds('replace'); // 跨档 replace（同 onZoomHandler 路径）
    return { visible: tierVisible(state.zoom), opacity: detailOpacity(state.zoom) };
  }

  // 点击拾取（步骤④-2，hearthere Us :19810-19828）：
  //   GPU 先行（zoom≥11.5，om radius:0）→ miss 落 CPU 屏幕距（_c + Cc 半径 + 背侧守卫）
  //   → id 再查站表（命中返回 station 记录，ghost id 返回 null）
  function deckInstance() {
    return (state.overlay && state.overlay._deck) || null;
  }

  function projectWithElevation(position) {         // Ct :13763-13779
    var d = deckInstance();
    if (d && typeof d.getViewports === 'function') {
      var vps = d.getViewports();
      if (vps && vps.length > 0 && typeof vps[0].project === 'function') {
        var p = vps[0].project([position[0], position[1], ELEVATION_BASE]);
        return { x: p[0], y: p[1] };
      }
    }
    return { x: 0, y: 0 };                          // :13775-13778
  }

  function pickStation(x, y) {
    var wp = SFV.worldPick;
    var map = state.map;
    if (!wp || !map) return null;
    var zoom = (typeof map.getZoom === 'function') ? map.getZoom() : state.zoom;
    var gpuId = null;
    if (wp.shouldGpuPick(zoom)) gpuId = wp.gpuPick(deckInstance(), { x: x, y: y });
    var id = gpuId;
    if (id == null) {
      var ctr = (typeof map.getCenter === 'function') ? map.getCenter() : null;
      var center = ctr ? [ctr.lng != null ? ctr.lng : ctr[0], ctr.lat != null ? ctr.lat : ctr[1]] : [0, 0];
      var radius = wp.pickRadiusPx(zoom, center, projectWithElevation);
      var guard = (typeof map.unproject === 'function') ? function (sp) {
        var u = map.unproject([sp.x, sp.y]);
        return { lng: u.lng, lat: u.lat };
      } : null;
      var hit = wp.cpuPick({ x: x, y: y }, state.stations, projectWithElevation, radius, guard);
      id = wp.mergePick(null, hit ? hit.id : null);
    }
    return id != null ? findStation(id) : null;      // Us :19827-19828 再查表
  }

  // ============================================================
  //  步骤④-2：电影感飞行 zn/wt（:19601-19653）
  //  stop → 一次性 moveend（isProgrammaticCameraFlight/effectsReady 收敛）→ flyTo
  //  F0=16 / O0=60 / B0=2800（wt :19647-19649）
  // ============================================================

  var flight = {
    seq: 0,                // u.current
    activeSeq: 0,          // c.current
    isProgrammaticCameraFlight: false, // h
    selectedDynamicEffectsReady: true, // g
    target: null,          // y（programmaticCameraFlightTarget）
    moveEnd: null          // f.current
  };

  function clearFlightListener() {
    if (flight.moveEnd && state.map && typeof state.map.off === 'function') {
      try { state.map.off('moveend', flight.moveEnd); } catch (e) { /* ignore */ }
    }
    flight.moveEnd = null;
  }

  function flyToStation(st) {
    var map = state.map;
    if (!map || !st) return;
    clearFlightListener();                         // :19603 在途飞行互摘
    if (typeof map.stop === 'function') { try { map.stop(); } catch (e) { /* ignore */ } }
    var pos = st.position;
    var ctr = (typeof map.getCenter === 'function') ? map.getCenter() : null;
    var bounds = null;
    if (typeof map.getBounds === 'function') {
      var B = map.getBounds();
      if (B) bounds = { west: B.getWest(), east: B.getEast(), south: B.getSouth(), north: B.getNorth() };
    }
    var token = ++flight.seq;
    flight.activeSeq = token;
    // ④-5b zn :19604-19625 —— targetBounds = Om(目标视口)（F0=16/O0=60，:19647-19648）
    var cv = (typeof map.getCanvas === 'function') ? map.getCanvas() : null;
    flight.target = {
      stationId: st.id,
      startBounds: bounds,
      targetBounds: viewportBounds({
        center: pos,
        zoom: 16,
        pitch: 60,
        bearing: (typeof map.getBearing === 'function') ? map.getBearing() : 0,
        viewportWidth: cv ? (cv.clientWidth || cv.width || 0) : 0,
        viewportHeight: cv ? (cv.clientHeight || cv.height || 0) : 0,
        offset: null
      })
    };
    flight.isProgrammaticCameraFlight = true;      // h(!0) :19627
    flight.selectedDynamicEffectsReady = false;    // g(!1)
    updateVisibleIds('accumulate');                // 起飞首拍 de 重算（Fm 双盒并集沿途点亮）
    var gt = function () {
      if (flight.activeSeq === token) {            // gt :19628-19630
        flight.activeSeq = 0;
        flight.isProgrammaticCameraFlight = false;
        flight.target = null;
        flight.selectedDynamicEffectsReady = true; // g(!0) 点亮选中特效
        scheduleEffectsFrame();                    // ④-5a：落地拍唤醒特效 ramp
      }
      clearFlightListener();
    };
    flight.moveEnd = gt;
    if (typeof map.on === 'function') map.on('moveend', gt);
    map.flyTo({ center: pos, zoom: 16, pitch: 60, duration: 2800 });
  }

  function getFlightState() {
    return {
      isProgrammaticCameraFlight: flight.isProgrammaticCameraFlight,
      selectedDynamicEffectsReady: flight.selectedDynamicEffectsReady,
      target: flight.target
    };
  }

  // ============================================================
  //  步骤④-5b：飞行 targetBounds 沿途点亮 + 头像 warming 装配门
  //  · E-10 :13018-13157 —— qr=1.4/Ri=120/Nm=80/jm=2.5 + Dm/Fm/Om/dc + ps/Ii
  //    + Bm/fc/Um/hs/$m/Ni/ji/Cr/Wm；ar :13799-13807、Di :13823-13828
  //  · D-8 Sr :10633-10635（sc = St-xt-.5 = 11，与 Bt(11.5) 双门限并存，G-2 注记）
  //  · F-11 Em/Tm/Lm/Rm :12951-13017
  //  · de 可见 id 机 :13382-13428（Oe.current）；事件防抖 :13549-13575
  //    （move/zoom → Ri accumulate 尾定时器、moveend → Nm replace）；
  //  · ht 消费 :13495-13497（expanded 批 ∩ visibleIds；null → 全量）+
  //    :13485-13514（头像层 data = Rm）+ :13656-13657（Em 静态层逐拍克隆）
  //  · zn :19604-19625 —— target = {stationId, startBounds 快照, targetBounds Om}
  //  裁决（用户 2026-09-30「可」）：网络头像预热队列（we/oe/Mi/Ci/Hm，Supabase 面）
  //  不移植 → 本地 haloIds=全量站表（头像即时可用 ≡「已预热」）、photoIds=空集（无照片面）、
  //  forcePrepare 恒 false（ie 恒 false）；悬停 g 预热 id 未移植，forceInclude 只含选中+飞行目标。
  // ============================================================

  var BOUNDS_SCALE = 1.4;                    // qr :13018
  var MOVE_ACCUMULATE_DEBOUNCE_MS = 120;     // Ri :13019
  var MOVEEND_REPLACE_DELAY_MS = 80;         // Nm :13020
  var PITCH_FOV_CAP = 2.5;                   // jm :13021
  var EMPTY_ID_SET = new Set();              // ps :13110
  var MERCATOR_LAT_CLAMP = 85.05112878;      // Ii :13111
  var AVATAR_WARMING_ZOOM = TIER_ZOOM - TIER_FADE - 0.5; // sc=11 :10611
  var AVATAR_EMPTY_SET = [];                 // Tm :12976

  function degToRad(t) { return t * Math.PI / 180; }                    // Cr :13152
  function radToDeg(t) { return t * 180 / Math.PI; }                    // Wm :13155
  function normalizeLon(t) {                                            // hs :13121-13126
    var e = t;
    for (; e > 180;) e -= 360;
    for (; e < -180;) e += 360;
    return e;
  }
  function boundsValid(t) {                                             // Bm :13113-13115
    return !!t && Number.isFinite(t.west) && Number.isFinite(t.east) &&
      Number.isFinite(t.south) && Number.isFinite(t.north) && t.south <= t.north;
  }
  function pointInBounds(t, e) {                                        // fc :13116-13118
    var n = t[0], o = t[1];
    return o < e.south || o > e.north ? false
      : e.west <= e.east ? (n >= e.west && n <= e.east) : (n >= e.west || n <= e.east);
  }
  function boundsLonSpan(t) {                                           // Um :13119-13120
    return t.west <= t.east ? t.east - t.west : 360 - t.west + t.east;
  }
  function projectMercatorPx(t, e) {                                    // $m :13127-13134
    var o = Math.max(-MERCATOR_LAT_CLAMP, Math.min(MERCATOR_LAT_CLAMP, t[1]));
    var r = Math.sin(degToRad(o));
    return {
      x: (normalizeLon(t[0]) + 180) / 360 * e,
      y: (0.5 - Math.log((1 + r) / (1 - r)) / (4 * Math.PI)) * e
    };
  }
  function pxToLon(t, e) { return normalizeLon(t / e * 360 - 180); }    // Ni :13135-13137
  function pxToLat(t, e) {                                              // ji :13138-13141
    var n = Math.PI - 2 * Math.PI * t / e;
    return radToDeg(Math.atan(Math.sinh(n)));
  }
  function expandBounds(t, e) {                                         // dc :13070-13086
    if (e === void 0) e = BOUNDS_SCALE;
    var n = t.north - t.south, o = boundsLonSpan(t), r = n * (e - 1) / 2, i = o * (e - 1) / 2;
    return o + i * 2 >= 360
      ? { west: -180, east: 180, south: Math.max(-90, t.south - r), north: Math.min(90, t.north + r) }
      : { west: normalizeLon(t.west - i), east: normalizeLon(t.east + i), south: Math.max(-90, t.south - r), north: Math.min(90, t.north + r) };
  }
  function viewportBounds(t) {                                          // Om :13061-13091
    var center = t.center, e = t.zoom, n = t.pitch, o = t.viewportWidth, r = t.viewportHeight,
      i = t.bearing !== void 0 ? t.bearing : 0, l = t.offset != null ? t.offset : null;
    var c = center[0], u = center[1];
    var d = Math.abs(l ? l[0] : 0), f = Math.abs(l ? l[1] : 0);
    if (!Number.isFinite(c) || !Number.isFinite(u) || !Number.isFinite(e) || !Number.isFinite(n) ||
      !Number.isFinite(o) || !Number.isFinite(r) || !Number.isFinite(d) || !Number.isFinite(f) ||
      o <= 0 || r <= 0) return null;
    var p = 512 * Math.pow(2, e);
    if (!Number.isFinite(p) || p <= 0) return null;
    var h = projectMercatorPx(center, p);
    var m = Math.min(PITCH_FOV_CAP, 1 / Math.max(.4, Math.cos(degToRad(Math.max(0, Math.min(85, n)))))); // :13075
    var y = o / 2 + d, w = (r / 2 + f) * m;
    var g = degToRad(i);
    var v = Math.abs(Math.cos(g)) * y + Math.abs(Math.sin(g)) * w;
    var b = Math.abs(Math.sin(g)) * y + Math.abs(Math.cos(g)) * w;
    var x = pxToLon(h.x - v, p), S = pxToLon(h.x + v, p);
    var P = pxToLat(h.y + b, p), _ = pxToLat(h.y - b, p);
    return { west: x, east: S, south: Math.max(-90, Math.min(P, _)), north: Math.min(90, Math.max(P, _)) };
  }
  function filterStationsByBounds(t) {                                  // Dm :13023-13040
    var stations = t.stations, e = t.bounds,
      n = t.boundsScale !== void 0 ? t.boundsScale : BOUNDS_SCALE,
      o = t.forceIncludeIds !== void 0 ? t.forceIncludeIds : EMPTY_ID_SET,
      r = t.previousVisibleIds !== void 0 ? t.previousVisibleIds : EMPTY_ID_SET,
      i = t.mode !== void 0 ? t.mode : 'replace';
    if (stations.length === 0) return [];
    if (!e) return stations;
    var l = expandBounds(e, n), c = new Set();
    for (const u of stations) if (pointInBounds(u.position, l)) c.add(u.id);
    if (i === 'accumulate') for (const u of r) c.add(u);
    for (const u of o) c.add(u);
    return stations.filter(function (u) { return c.has(u.id); });
  }
  function filterStationsForFlight(t) {                                 // Fm :13042-13059
    var stations = t.stations, e = t.flightStartBounds, n = t.flightTargetBounds,
      o = t.boundsScale !== void 0 ? t.boundsScale : BOUNDS_SCALE,
      r = t.forceIncludeIds !== void 0 ? t.forceIncludeIds : EMPTY_ID_SET,
      i = t.previousVisibleIds !== void 0 ? t.previousVisibleIds : EMPTY_ID_SET;
    if (stations.length === 0) return [];
    var l = [e, n].filter(boundsValid);
    if (l.length === 0) return stations;
    var c = l.map(function (d) { return expandBounds(d, o); }), u = new Set();
    for (const d of stations) {
      for (var j2 = 0; j2 < c.length; j2++) {
        if (pointInBounds(d.position, c[j2])) { u.add(d.id); break; }
      }
    }
    for (const d of i) u.add(d);
    for (const d of r) u.add(d);
    return stations.filter(function (d) { return u.has(d.id); });
  }
  function mapSnapshotBounds(map) {                                     // ar :13799-13807
    if (!map || typeof map.getBounds !== 'function') return null;
    var e = map.getBounds();
    return e ? { west: e.getWest(), east: e.getEast(), south: e.getSouth(), north: e.getNorth() } : null;
  }
  function sameIdList(t, e) {                                           // Di :13823-13828
    if (!t || t.length !== e.length) return false;
    for (var n = 0; n < t.length; n++) if (t[n] !== e[n]) return false;
    return true;
  }
  function avatarWarmingGate(zoom, detail) {                            // Sr :10633-10635
    return zoom >= AVATAR_WARMING_ZOOM || detail > .01;
  }
  function lmAvatarData(st, opFn, elevFn) {                             // Lm :12978-12987
    return {
      id: st.id, position: st.position, avatarUrl: stationAvatarUrl(st),
      color: st.colorTop, itemOpacity: opFn(st.id), itemElevation: elevFn(st.id)
    };
  }
  function avatarPrepareSet(t) {                                        // Rm :12989-13009
    var forcePrepare = t.forcePrepare !== void 0 ? t.forcePrepare : false;
    if (!forcePrepare && !avatarWarmingGate(t.zoom, t.detailOpacity)) return AVATAR_EMPTY_SET;
    var out = [];
    for (var i = 0; i < t.haloIds.length; i++) {
      var f = t.stationById.get(t.haloIds[i]);
      if (!f) continue;
      var p = lmAvatarData(f, t.getAvatarOpacity, t.getElevation);
      if (p) out.push(Object.assign({}, p, { hasPhoto: t.photoIds.has(t.haloIds[i]) }));
    }
    return out;
  }
  function createLayerOpacityCache() {                                  // Em :12951-12975
    var t = new WeakMap();
    return function (e, n, o) {
      var r = e.id === AVATAR_LAYER_ID,
        i = typeof e.id === 'string' && (e.id.indexOf('lighthouse-rim-layer-') === 0 || e.id === 'lighthouse-expanded-batch');
      if (!r && !i) return e;
      var l = t.get(e);
      if (l && l.glowOpacity === n && l.detailOpacity === o) return l.clone;
      var c;
      if (r) c = e.clone({ opacity: o, visible: !0 });
      else c = e.clone({
        getLayerOpacity: function () { return o; },
        updateTriggers: Object.assign({}, e.props.updateTriggers, { getLayerOpacity: [o] })
      });
      t.set(e, { glowOpacity: n, detailOpacity: o, clone: c });
      return c;
    };
  }

  // —— de 可见 id 机（Oe.current）+ 事件防抖 ——
  var visState = { visibleIds: null, lastBounds: null, accumTimer: null, replaceTimer: null, lastMoveAt: 0 };
  var onVisMoveHandler = null, onVisMoveEndHandler = null;
  var opacityClone = createLayerOpacityCache(); // j.current :13445
  var staticBaseSlots = new Map();              // 基座层槽（数据同一性 → 基座复用；opacity 走 Em）
  var slotTouched = null;                       // 本拍装配命中的槽位集（refresh 内置位）

  function slotBase(key, sig, build) {
    if (slotTouched) slotTouched[key] = true;
    var e = staticBaseSlots.get(key);
    if (e && e.sig === sig) return e.layer;
    var layer = build();
    staticBaseSlots.set(key, { sig: sig, layer: layer });
    return layer;
  }
  // 邻拍剪枝（④-5b修复轮）：deck 仅对「上一拍同 id 在场」的层走 transfer/update；
  // 槽位若本拍未装配，其下拍再回加时 id 已离表 → deck 会对旧实例重跑 _initialize
  // → 断言失败（internalState 永不清除）。未命中槽位即时作废，回加必交新实例。
  function pruneUntouchedSlots() {
    if (!slotTouched) return;
    staticBaseSlots.forEach(function (v, k) { if (!slotTouched[k]) staticBaseSlots.delete(k); });
    slotTouched = null;
  }
  function rimSig(list, progress) {
    var s = 'p' + progress + ';';
    for (var i = 0; i < list.length; i++) s += list[i].id + '|' + (list[i].status || '') + '|' + (list[i].colorTop || '') + ';';
    return s;
  }
  function avatarSig() {
    var s = '';
    for (var i = 0; i < state.stations.length; i++) {
      var st = state.stations[i];
      s += st.id + ':' + stationElevation(st.id, st) + ';';
    }
    return s;
  }
  var stationByIdCache = null, stationByIdSrc = null;
  function stationByIdMap() {
    if (stationByIdSrc !== state.stations) {
      stationByIdSrc = state.stations;
      stationByIdCache = new Map();
      for (var i = 0; i < state.stations.length; i++) stationByIdCache.set(state.stations[i].id, state.stations[i]);
    }
    return stationByIdCache;
  }

  function updateVisibleIds(mode) {                                     // de :13382-13428
    var map = state.map;
    if (!map) {
      if (visState.visibleIds !== null) { visState.visibleIds = null; refresh(); }
      return;
    }
    var force = new Set();                                              // ce
    if (sel.selectedId != null) force.add(sel.selectedId);              // E.current?.id（悬停 g 未移植）
    if (flight.isProgrammaticCameraFlight) {                            // m.current :13391
      var at = flight.target;                                           // w.current
      if (!at || (!at.startBounds && !at.targetBounds)) {
        if (visState.visibleIds !== null) { visState.visibleIds = null; refresh(); }
        return;
      }
      if (at.stationId) force.add(at.stationId);                        // :13397
      var et = new Set(visState.visibleIds || []);
      var ids = filterStationsForFlight({
        stations: state.stations, flightStartBounds: at.startBounds, flightTargetBounds: at.targetBounds,
        forceIncludeIds: force, previousVisibleIds: et
      }).map(function (s) { return s.id; });
      visState.lastBounds = at.targetBounds != null ? at.targetBounds : at.startBounds; // ?? :13406
      if (sameIdList(visState.visibleIds, ids)) return;                 // :13406-13407
      visState.visibleIds = ids;
      refresh();
      return;
    }
    if (Number(state.zoom) < TIER_ZOOM - TIER_FADE) {                   // :13410-13413（M < St-xt）
      if (visState.visibleIds !== null) { visState.visibleIds = null; refresh(); }
      return;
    }
    var mt = mapSnapshotBounds(map);                                    // ar :13414
    if (!mt) {
      if (visState.visibleIds !== null) { visState.visibleIds = null; refresh(); }
      return;
    }
    var prev = new Set(visState.visibleIds || []);
    var ids2 = filterStationsByBounds({
      stations: state.stations, bounds: mt, forceIncludeIds: force,
      previousVisibleIds: prev, mode: mode || 'replace'
    }).map(function (s) { return s.id; });
    visState.lastBounds = mt;                                           // :13427
    if (!sameIdList(visState.visibleIds, ids2)) { visState.visibleIds = ids2; refresh(); }
  }
  function visAccumulate() {                                            // ve :13557-13559
    visState.accumTimer = null;
    visState.lastMoveAt = Date.now();
    updateVisibleIds('accumulate');
  }
  function visOnMove() {                                                // ie :13560-13567
    var He = Date.now() - visState.lastMoveAt;
    if (He >= MOVE_ACCUMULATE_DEBOUNCE_MS) {
      if (visState.accumTimer != null) { clearTimeout(visState.accumTimer); visState.accumTimer = null; }
      visAccumulate();
      return;
    }
    if (!visState.accumTimer) visState.accumTimer = setTimeout(visAccumulate, MOVE_ACCUMULATE_DEBOUNCE_MS - He);
  }
  function visOnMoveEnd() {                                             // Ye :13568-13572
    if (visState.accumTimer != null) { clearTimeout(visState.accumTimer); visState.accumTimer = null; }
    if (visState.replaceTimer != null) { clearTimeout(visState.replaceTimer); visState.replaceTimer = null; }
    visState.replaceTimer = setTimeout(function () {
      visState.replaceTimer = null;
      visState.lastMoveAt = Date.now();
      updateVisibleIds('replace');
    }, MOVEEND_REPLACE_DELAY_MS);
  }
  function resetVisibleMachine() {
    if (visState.accumTimer != null) { clearTimeout(visState.accumTimer); visState.accumTimer = null; }
    if (visState.replaceTimer != null) { clearTimeout(visState.replaceTimer); visState.replaceTimer = null; }
    visState.visibleIds = null; visState.lastBounds = null; visState.lastMoveAt = 0;
    staticBaseSlots.clear();
    opacityClone = createLayerOpacityCache();
  }
  function getVisibleIds() { return visState.visibleIds; }

  function getState() {
    return {
      stations: state.stations,
      selectedId: sel.selectedId,
      exitingId: sel.exitingStation ? sel.exitingStation.id : null,
      visible: currentVisible(),
      visibleIds: visState.visibleIds
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
    clearSelection: clearSelection,
    applyTier: applyTier,
    getState: getState,
    pickStation: pickStation,
    projectWithElevation: projectWithElevation,
    flyToStation: flyToStation,
    getFlightState: getFlightState,
    getElevation: currentElevation,        // C :10716
    getAvatarElevation: getAvatarElevation, // _ :10702
    stationElevation: stationElevation,     // K :13265
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
    ELEVATION_EXPANDED: ELEVATION_EXPANDED,
    ELEVATION_BASE: ELEVATION_BASE,
    EXIT_HOLD_MS: EXIT_HOLD_MS,
    SELECTION_TWEEN_MS: SELECTION_TWEEN_MS,
    SELECTION_RISE_DELAY_MS: SELECTION_RISE_DELAY_MS,
    SELECTION_TICK_MS: SELECTION_TICK_MS,
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
    SHADER_MODULE_GLOBE_OCCLUSION: GLOBE_OCCLUSION_MODULE,
    // 步骤④-3 头像层（数据面纯函数 Node 可测；类与 GLSL 供 vm 沙箱校验）
    AVATAR_LAYER_ID: AVATAR_LAYER_ID,
    AVATAR_GLOW_RADIUS: AVATAR_GLOW_RADIUS,
    AVATAR_SIZE: AVATAR_SIZE,
    AVATAR_PICKABLE: AVATAR_PICKABLE,
    AVATAR_ICON_SIZE_HTTP: AVATAR_ICON_SIZE_HTTP,
    AVATAR_ICON_SIZE_LOCAL: AVATAR_ICON_SIZE_LOCAL,
    GLOW_AVATAR_DEFAULTS: GLOW_AVATAR_DEFAULTS,
    initialsAvatarUrl: initialsAvatarUrl,
    stationAvatarUrl: stationAvatarUrl,
    stationAvatarData: stationAvatarData,
    getAvatarOpacity: getAvatarOpacity,
    SHADER_INJECT_CIRCLE: CIRCLE_CROP_FS,
    // 步骤④-5a 选中特效三件套（纯函数代理 effects 模块；build*/驱动供沙箱与调试）
    get PARTICLE_MAX_DISTANCE() { var f = effectsLib(); return f && f.PARTICLE_MAX_DISTANCE; },
    get PARTICLE_RINGS() { var f = effectsLib(); return f && f.PARTICLE_RINGS; },
    get PARTICLES_PER_RING() { var f = effectsLib(); return f && f.PARTICLES_PER_RING; },
    particleData: function () { return fxOrThrow().particleData.apply(null, arguments); },
    pulseRingData: function () { return fxOrThrow().pulseRingData.apply(null, arguments); },
    coneGeometry: function () { return fxOrThrow().coneGeometry.apply(null, arguments); },
    spotlightMesh: function () { return fxOrThrow().spotlightMesh(); },
    effectsGateActive: function () { return fxOrThrow().effectsGateActive.apply(null, arguments); },
    selectedEffectsGate: function () { return fxOrThrow().selectedEffectsGate.apply(null, arguments); },
    rampStep: function () { return fxOrThrow().rampStep.apply(null, arguments); },
    clampFrameDelta: function () { return fxOrThrow().clampFrameDelta.apply(null, arguments); },
    shouldUpdateFrame: function () { return fxOrThrow().shouldUpdateFrame.apply(null, arguments); },
    buildParticleWave: buildParticleWave,
    buildPulseRing: buildPulseRing,
    buildSpotlight: buildSpotlight,
    stepSelectedEffects: stepSelectedEffects,
    get __ParticleWaveCtor() { return Wave && Wave.cls; },
    get __PulseRingCtor() { return Ring && Ring.cls; },
    get __SpotlightCtor() { return Spot && Spot.cls; },
    get __GlowAvatarLayerCtor() { return AvatarComposite; },
    // 步骤④-5b 飞行 targetBounds 沿途点亮 + 头像 warming 装配门（纯函数与机器接口）
    BOUNDS_SCALE: BOUNDS_SCALE,
    MOVE_ACCUMULATE_DEBOUNCE_MS: MOVE_ACCUMULATE_DEBOUNCE_MS,
    MOVEEND_REPLACE_DELAY_MS: MOVEEND_REPLACE_DELAY_MS,
    PITCH_FOV_CAP: PITCH_FOV_CAP,
    MERCATOR_LAT_CLAMP: MERCATOR_LAT_CLAMP,
    AVATAR_WARMING_ZOOM: AVATAR_WARMING_ZOOM,
    degToRad: degToRad,
    radToDeg: radToDeg,
    normalizeLon: normalizeLon,
    boundsValid: boundsValid,
    pointInBounds: pointInBounds,
    boundsLonSpan: boundsLonSpan,
    expandBounds: expandBounds,
    viewportBounds: viewportBounds,
    filterStationsByBounds: filterStationsByBounds,
    filterStationsForFlight: filterStationsForFlight,
    mapSnapshotBounds: mapSnapshotBounds,
    sameIdList: sameIdList,
    avatarWarmingGate: avatarWarmingGate,
    lmAvatarData: lmAvatarData,
    avatarPrepareSet: avatarPrepareSet,
    createLayerOpacityCache: createLayerOpacityCache,
    updateVisibleIds: updateVisibleIds,
    getVisibleIds: getVisibleIds
  };

  // Node 直连 require（双装载模式）：只暴露纯数据面；WebGL 依赖在 Node 下不触。
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SFV.worldLighthouseDeck;
  }
})(typeof window !== 'undefined' ? window : globalThis);
