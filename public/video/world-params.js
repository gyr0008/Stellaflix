/*
 * Stellaflix 影视模块 — 世界页 · hearthere.live 参数总表
 *
 * 本文件是从 hearthere 线上 bundle（main-B8-gfwD5.js）系统性抽取的**全部图层细节参数**。
 * 任何世界页视觉/交互改动都应以本表为准，避免凭印象改数字。
 *
 * 抽取范围（对应 deck.gl 自定义图层）：
 *   GlowScatterplotLayer / PresenceGlowScatterplotLayer
 *   LighthouseRimLayer / BeaconBlinkLayer
 *   VolumetricSpotlightLayer / PulseRingLayer / ParticleWaveLayer
 *   FireworkPointsLayer / LikePopupLayer
 *   GlowAvatarLayer / CircleAvatarLayer
 *   缩放档位 / 选中状态机 / 预热调度 / 动态天空
 *
 * 单位约定：
 *   In = 5e4, Mt = 5e-4  是 hearthere 的两个全局缩放因子，In*Mt = 25
 *   模型坐标 × meshScale(25) = 米
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  // ============================================================
  //  0. 全局尺度（hearthere: In=5e4, zr=50, Mt=5e-4）
  // ============================================================
  var SCALE = {
    IN: 5e4,
    MT: 5e-4,
    ZR: 50,                 // 光晕半径（米），deck.gl radiusUnits 默认 meters
    MESH_SCALE: 25,         // In*Mt = 25；模型 9.22 单位 → 230.5m 高
    MODEL_HEIGHT: 9.22,     // OBJ 的 y 轴范围上限（shader 里 modelHeight 同值）

    // xr 常量块
    SPOTLIGHT_HEIGHT: 175,        // 7  * In*Mt
    BLINK_LIGHT_HEIGHT: 213.75,   // 8.55 * In*Mt
    PARTICLE_RADIUS_METERS: 2.5,  // 5e3  * Mt
    PARTICLE_RANDOM_HEIGHT_MAX: 25,   // 5e4  * Mt
    PARTICLE_WAVE_AMPLITUDE: 1.5, // 3e3  * Mt
    PARTICLE_MAX_DISTANCE: 500,   // 1e6  * Mt
    PARTICLE_RADIUS_DEG: 0.0025, // 5    * Mt
    NOISE_FREQUENCY: 0.8,
    NOISE_AMPLITUDE: 0.4,
    PARTICLE_RINGS: 30,
    PARTICLES_PER_RING: 60        // 每座灯塔 1800 粒子
  };

  // ============================================================
  //  1. 光晕层 Dh / PresenceGlowScatterplotLayer
  //     —— 远景「看点」的核心，尺寸与深度规则都极敏感
  // ============================================================
  var GLOW = {
    ALTITUDE_M: 80,          // getPosition: [...pos, 80]
    RADIUS_M: 50,            // getRadius: zr
    // hearthere 原值：radiusMinPixels 17 / radiusMaxPixels 70（**半径**）
    SRC_RADIUS_MIN_PX: 17,
    SRC_RADIUS_MAX_PX: 70,
    // 实际渲染值：deck.gl 是加色混合（暗部也发光），Cesium 只有 alpha 混合，
    // 同样的 17px 半径在 Cesium 上有效亮斑只剩核心一小团，太空里几乎看不见。
    // 这里把渲染半径上调一档，让远景也能看清信标。
    // 用户指定的渲染半径：35 / 110（直径 70 / 220）
    RADIUS_MIN_PX: 35,
    RADIUS_MAX_PX: 110,
    FILL_ALPHA: 220 / 255,   // getFillColor alpha 220/255
    COLOR_TRANSITION_MS: 300,
    // deck.gl parameters —— 深度常显 + 加色混合，永不被地表遮挡
    BLEND: true,
    BLEND_FUNC: 'SRC_ALPHA,ONE',   // [770, 1] 加色
    DEPTH_COMPARE: 'always',
    DEPTH_WRITE: false,
    // 引擎差异补偿：deck.gl 的 blendFunc[770,1] 是**加色**（光叠加发光），
    // Cesium 的 billboard 只有 alpha 混合（SRC_ALPHA, ONE_MINUS_SRC_ALPHA）。
    // 同一张贴图在 Cesium 上会明显偏暗，这里显式补亮度。
    RENDER_BOOST: 2,
    // PresenceGlow 的 zoom 淡出：clamp((St+xt - zoom) / (2*xt), 0, 1)
    PRESENCE_FADE_FROM: 13.5,
    PRESENCE_FADE_SPAN: 2,

    // compact 星点 shader（Dh 用 compact:true → Sh 源码）
    STAR_CORE_SIZE: 0.25,
    STAR_CORE_POW: 1.5,
    STAR_INNER_SIZE: 0.45,
    STAR_INNER_POW: 3.0,
    STAR_OUTER_SIZE: 0.60,
    STAR_OUTER_POW: 6.0,
    STAR_W: { core: 0.8, inner: 0.15, outer: 0.05 },
    STAR_INTENSITY: 1.2
  };

  // ============================================================
  //  2. 缩放档位（St=12.5, xt=1 → 过渡区 11.5~13.5）
  // ============================================================
  var TIER = {
    ST: 12.5,        // 档位中心
    XT: 1,           // 过渡半宽
    SC: 11.0,        // St-xt-0.5：glow-only / avatar-preload 分界
    // 展开后的阈值：
    //   zoom < 11.0       glow-only
    //   11.0 ~ 11.5       avatar-preload
    //   11.5 ~ 13.5       transition（glow↔detail 线性交叉）
    //   > 13.5            detail-only
    GLOW_MAX: 11.5,
    DETAIL_MIN: 13.5
  };

  // ============================================================
  //  3. 灯塔实体 LighthouseRimLayer
  // ============================================================
  var RIM = {
    SIZE_SCALE: 25,
    ORIENTATION: [0, 0, 90],      // getOrientation（模型需绕 Z 转 90°）
    CULL: 'BACK',
    DEPTH_TEST: true,
    DEPTH_MASK: false,
    BLEND_FUNC: 'SRC_ALPHA,ONE_MINUS_SRC_ALPHA',
    // transitions（ms）
    T_COLOR: 1000,
    T_COLOR_TOP: 1000,
    T_COLOR_BOTTOM: 1000,
    T_LAYER_OPACITY: 100,
    T_ENTRANCE: 1000,
    // shader 里的模型高度与扫描区间
    MODEL_HEIGHT: 9.22,
    SCAN_FROM: -3.0,
    SCAN_TO: 13.0,
    // 未激活灰
    GRAY: [0.35, 0.4, 0.55],
    // 亮度补偿
    BRIGHT_MIN: 0.7,
    BRIGHT_MAX: 2.0,
    ALPHA_ACTIVE_BASE: 0.6,
    ALPHA_REST: 0.8
  };

  // ============================================================
  //  4. 选中状态机（Mn=290, fs=80, mh=1e3, gh=700, or=50, yi=16）
  // ============================================================
  var SELECT = {
    ELEV_ACTIVE: 290,
    ELEV_REST: 80,
    DWELL_MS: 1000,
    EASE_MS: 700,
    DELAY_MS: 50,
    FRAME_MS: 16,
    // 缓动：1-(1-t)^3（easeOutCubic）
    // 自动回落：mh + 150ms
    AUTO_CLEAR_EXTRA_MS: 150
  };

  // ============================================================
  //  5. 离线闪烁 BeaconBlinkLayer（Xh=4, qo=.15? 见下）
  //     源码：const Xh=4, qo=.15, Jh=.3, em=.01
  //     闪烁：e=t%4; e<0.1? e/0.1 : e<0.3? 1-(e-0.1)/0.1 : 0
  //     —— 注：qo 声明 .15 但 tm() 里用的是硬编码 0.1/0.3
  // ============================================================
  var BLINK = {
    CYCLE_S: 4,
    RISE_END_S: 0.1,
    FALL_END_S: 0.3,
    MIN_ALPHA: 0.01,
    COLOR: [0, 1, 1],             // 青色
    GLOW_BIAS: 0.5,
    GLOW_GAIN: 0.5,
    INTENSITY: 2.0,
    SPHERE_RADIUS: 0.15,          // 半径 0.15 的单位球，sizeScale=25 → 3.75m
    BLEND_FUNC: 'SRC_ALPHA,ONE'
  };

  // ============================================================
  //  6. 脉冲环 PulseRingLayer（hm=1, mm=1e6*Mt=500, gm=8, uc=.3）
  // ============================================================
  var PULSE = {
    RING_COUNT: 1,
    MAX_RADIUS_M: 500,
    CYCLE_S: 8,
    FADE_DISTANCE: 0.3,
    // getRadius: mm*(1+uc) = 650
    DRAW_RADIUS_M: 650,
    // 波公式：sin(distanceRatio*4.0 - time*0.5)，pow(normalizedSin, 8.0)
    WAVE_K: 4.0,
    WAVE_SPEED: 0.5,
    WAVE_POW: 8.0,
    EDGE_FADE_START: 0.75,
    CENTER_FADE_END: 0.05,
    BRIGHTNESS_GAIN: 1.5,
    ALPHA_SCALE: 0.9
  };

  // ============================================================
  //  7. 音波粒子 ParticleWaveLayer
  // ============================================================
  var PARTICLE = {
    RADIUS_M: 2.5,
    WAVE_SPEED: 1.5,
    FILL: [0, 229, 255, 200],
    // 发光：core*0.7 + inner*0.25 + outer*0.15（柔和版）
    CORE_SIZE: 0.25, INNER_SIZE: 0.45, OUTER_SIZE: 0.60,
    W: { core: 0.7, inner: 0.25, outer: 0.15 },
    HEIGHT_BOOST: 0.4,
    // 星星眨眼
    TWINKLE1: 19.3, TWINKLE1_SPD: 0.6,
    TWINKLE2: 37.9, TWINKLE2_SPD: 0.35,
    TWINKLE_W1: 0.6, TWINKLE_W2: 0.4,
    PEAK_COLOR_LO: 0.75, PEAK_COLOR_HI: 0.85,
    BRIGHTNESS_FLICKER: 0.3,
    TWINKLE_SIZE_BOOST: 0.35,
    AUDIO_HISTORY: 64,
    IDLE_WAVE_K: 4.0, IDLE_WAVE_SPEED: 0.5
  };

  // ============================================================
  //  8. 烟花 FireworkPointsLayer
  // ============================================================
  var FIREWORK = {
    POINT_SIZE: 26,
    CORE_SIZE: 0.25, CORE_POW: 1.5,
    INNER_SIZE: 0.5, INNER_POW: 2.0,
    OUTER_SIZE: 1.0, OUTER_POW: 4.0,
    W: { core: 0.7, inner: 0.2, outer: 0.1 },
    WHITE_MIX: 0.5,
    FADE_IN_END: 0.1,
    FADE_OUT_START: 0.5,
    ZOOM_FADE_FROM: 11.5,
    ZOOM_FADE_TO: 12.0,
    COLOR_BOOST: 1.5
  };

  // ============================================================
  //  9. 点赞泡 LikePopupLayer
  // ============================================================
  var LIKE = {
    RISE_HEIGHT_M: 42,
    DRIFT_DISTANCE_M: 12,
    FADE_IN_END: 0.12,
    FADE_OUT_START: 0.55,
    DEEP_RED: [0.95, 0.04, 0.12],
    BRIGHT_RED: [1.0, 0.12, 0.18],
    HIGHLIGHT_MIX: 0.28,
    UV_SCALE: 1.12,
    UV_Y_OFFSET: 0.14
  };

  // ============================================================
  //  10. 头像层 GlowAvatarLayer / CircleAvatarLayer
  // ============================================================
  var AVATAR = {
    GLOW_RADIUS: 30,
    SIZE_RATIO: 0.6,
    ELEVATION: 50,
    DEFAULT_COLOR: [100, 200, 255],
    ATLAS_WIDTH: 4096,
    ICON_HTTP: 256,
    ICON_LOCAL: 128
  };

  // ============================================================
  //  11. 预热调度（lc=100, Fh=50, Oh=1.3, Bh=256, Uh=128）
  // ============================================================
  var WARM = {
    LIMIT: 100,
    RADIUS_KM: 50,
    BOUNDS_PAD: 1.3,
    MAX_LIST: 100
  };

  // ============================================================
  //  12. 动态天空（lh=500ms 节流, ch=60s 全量, halo scale=1.2）
  // ============================================================
  var SKY = {
    THROTTLE_MS: 500,
    REFRESH_MS: 60000,
    HALO_SCALE: 1.2,
    // 太阳高度角(°) → [skyColor, horizonColor]
    STOPS: [
      [-18, [10, 14, 26], [13, 17, 23]],
      [-12, [15, 27, 45], [20, 30, 48]],
      [-6,  [30, 39, 68], [45, 45, 92]],
      [-3,  [44, 63, 100], [142, 69, 133]],
      [0,   [74, 122, 181], [255, 107, 53]],
      [3,   [92, 148, 197], [255, 160, 64]],
      [8,   [107, 163, 208], [255, 204, 112]],
      [15,  [123, 181, 220], [232, 220, 200]],
      [30,  [90, 159, 212], [197, 220, 232]],
      [50,  [74, 144, 217], [176, 207, 224]],
      [70,  [65, 135, 210], [170, 200, 220]]
    ]
  };

  // ============================================================
  //  13. 体积光柱 VolumetricSpotlightLayer（圆锥几何参数）
  // ============================================================
  var SPOTLIGHT = {
    BOTTOM_RADIUS: 0.1,
    TOP_RADIUS: 1.5,
    HEIGHT: 5,
    RADIAL_SEG: 32,
    HEIGHT_SEG: 20,
    CAP: true
  };

  // ============================================================
  //  14. 地形与 3D 建筑（对照 gods-eye-view 的 basemap ladder）
  //
  //  事实依据：
  //    · Cesium 1.124 内置 createWorldTerrainAsync / createOsmBuildingsAsync
  //      / Cesium3DTileset.fromUrl（我们 vendor 的 index.js 里可数）
  //    · GEV README 底图阶梯：🟢 Nothing = Esri + keyless terrain, in 2D
  //                              🟡 ion token = Google Photorealistic 3D（个人非商用）
  //                              🔴 Google key  = 同样 3D，计费
  //    · GEV src/maps/terrain.js 的 createKeylessTerrain()：
  //      Re:Earth / Mapterhorn 量化网格地形，CC BY 4.0，免 token
  //
  //  合规边界：ion 免费档仅「个人非商业」；Google key 计费。二者都必须
  //  「用户自填才启用」，产品默认只用 keyless 地形。
  // ============================================================
  var TERRAIN = {
    // 免 token 的真实地形（CC BY 4.0）
    KEYLESS_URL: 'https://terrain.reearth.land/cesium-mesh/ellipsoid',
    KEYLESS_CREDIT: 'Re:Earth / Mapterhorn · CC BY 4.0',
    // 有 ion token 时的更高质量地形
    ION_ASSET_ID: 1,
    // 兜底：纯平面椭球
    FALLBACK: 'flat',
    // 档位：auto（默认 keyless）/ keyless / world（需 ion）/ flat
    MODES: ['auto', 'keyless', 'world', 'flat']
  };

  var BUILDINGS = {
    // Google Photorealistic 3D Tiles：需用户自填 key（计费/条款自担）
    GOOGLE_TILES_URL: 'https://tile.googleapis.com/v1/3dtiles/root.json',
    // Cesium OSM Buildings：ion asset 96188，需 ion token
    OSM_ION_ASSET_ID: 96188,
    // 合规提示
    LICENSE_NOTE: 'ion 免费档仅个人非商业；Google 3D Tiles 计费'
  };

  SFV.worldParams = {
    SCALE: SCALE,
    GLOW: GLOW,
    TIER: TIER,
    RIM: RIM,
    SELECT: SELECT,
    BLINK: BLINK,
    PULSE: PULSE,
    PARTICLE: PARTICLE,
    FIREWORK: FIREWORK,
    LIKE: LIKE,
    AVATAR: AVATAR,
    WARM: WARM,
    SKY: SKY,
    SPOTLIGHT: SPOTLIGHT,
    TERRAIN: TERRAIN,
    BUILDINGS: BUILDINGS
  };
})(typeof window !== 'undefined' ? window : this);
