/*
 * Stellaflix 影视模块 — 世界页灯塔层（M2）
 *
 * 把 hearthere.live 的灯塔视觉搬到 Cesium：
 *  - 真 3D 模型：models/lighthouse.glb（源自 hearthere 的 lighthouse.obj，POMO Studio）
 *  - LighthouseRimLayer 四段 shader 全量移植 → Cesium CustomShader
 *      · Rim 描边：pow(1 - max(0, N·V), 6)
 *      · 垂直渐变：modelHeight=9.22，colorBottom→colorTop
 *      · 激活扫描：scanY = mix(-3, 13, activation)，扫描线发光
 *      · 入场扫描：entrance 0→1，线以上逐段揭开
 *      · 动态亮度：maxSafeGain = 1/maxComponent，防止过曝
 *  - 缩放档位：MapLibre zoom 11 / 11.5 / 13.5 → Cesium 相机高度
 *  - 选中：点击 → flyTo + 抬升 + 激活扫描动画
 *
 * 术语：信标（beacon）= 地球上一座灯塔；档位（tier）= 按相机高度显示光晕/实体。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var P = SFV.worldParams || {};
  var PG = P.GLOW || {};
  var PS = P.SCALE || {};
  var PSEL = P.SELECT || {};
  var PR = P.RIM || {};

  // ============================================================
  //  常量
  // ============================================================

  // 模型高度（OBJ 的 y 轴范围 0 → 9.22，与 hearthere shader 的 modelHeight 一致）
  var MODEL_HEIGHT = PR.MODEL_HEIGHT || 9.22;
  // 站点根即 public/，模型在 public/models/lighthouse.glb
  var MODEL_URL = 'models/lighthouse.glb';

  // hearthere 的 meshScale = 50000 * 5e-4 = 25（模型单位 → 米）
  var MODEL_SCALE = PS.MESH_SCALE || 25;

  // 选中动画（对齐 hearthere 的 yh hook：Mn=290, fs=80, mh=1e3, gh=700, or=50, yi=16）
  var ELEV_REST = PSEL.ELEV_REST || 80;
  var ELEV_ACTIVE = PSEL.ELEV_ACTIVE || 290;
  var DWELL_MS = PSEL.DWELL_MS || 1000;
  var EASE_MS = PSEL.EASE_MS || 700;
  var FRAME_MS = PSEL.FRAME_MS || 16;

  // ---- 缩放档位：MapLibre zoom → Cesium 相机高度 ----
  // MapLibre 地面分辨率：res(z) = 156543.03 / 2^z  米/像素（赤道，256px 瓦片）
  // Cesium 垂直俯视：res ≈ 2·h·tan(fovy/2) / W
  // 令二者相等：h = 156543.03 · W / (2^z · 2 · tan(fovy/2))
  // 取 W = 800px、fovy = 60°（Cesium 默认）→ h ≈ 1.0843e8 / 2^z  米
  //   z = 11.5 (St-xt) → h ≈ 41,500 m   ← 过渡区上沿
  //   z = 13.5 (St+xt) → h ≈  9,400 m   ← 过渡区下沿
  var TIER_GLOW_MAX_H = 53000;
  var TIER_DETAIL_MIN_H = 9400;

  // 演示信标：对齐 hearthere 的 10 城，颜色取自其配色描述
  var DEMO_STATIONS = [
    { id: 'tokyo',   name: '东京',   lon: 139.6917, lat: 35.6895, colorTop: [1.00, 0.35, 0.30], colorBottom: [0.55, 0.10, 0.12], status: 'playing' },
    { id: 'nyc',     name: '纽约',   lon: -74.0060, lat: 40.7128, colorTop: [0.35, 0.90, 0.55], colorBottom: [0.05, 0.35, 0.22], status: 'playing' },
    { id: 'london',  name: '伦敦',   lon: -0.1276,  lat: 51.5072, colorTop: [0.35, 0.60, 1.00], colorBottom: [0.08, 0.18, 0.55], status: 'playing' },
    { id: 'paris',   name: '巴黎',   lon: 2.3522,   lat: 48.8566, colorTop: [1.00, 0.75, 0.30], colorBottom: [0.50, 0.28, 0.05], status: 'online' },
    { id: 'sydney',  name: '悉尼',   lon: 151.2093, lat: -33.8688, colorTop: [0.40, 0.85, 1.00], colorBottom: [0.05, 0.28, 0.45], status: 'online' },
    { id: 'rio',     name: '里约',   lon: -43.1729, lat: -22.9068, colorTop: [0.55, 1.00, 0.45], colorBottom: [0.12, 0.40, 0.10], status: 'online' },
    { id: 'cairo',   name: '开罗',   lon: 31.2357,  lat: 30.0444, colorTop: [1.00, 0.85, 0.45], colorBottom: [0.45, 0.30, 0.08], status: 'offline' },
    { id: 'moscow',  name: '莫斯科', lon: 37.6173,  lat: 55.7558, colorTop: [0.85, 0.45, 1.00], colorBottom: [0.28, 0.08, 0.45], status: 'online' },
    { id: 'mumbai',  name: '孟买',   lon: 72.8777,  lat: 19.0760, colorTop: [1.00, 0.55, 0.75], colorBottom: [0.48, 0.12, 0.28], status: 'playing' },
    { id: 'capetown',name: '开普敦', lon: 18.4241,  lat: -33.9249, colorTop: [0.45, 0.95, 0.90], colorBottom: [0.06, 0.32, 0.36], status: 'online' }
  ];

  // ============================================================
  //  运行时状态
  // ============================================================
  var viewer = null;
  var stations = [];        // { def, model, glow, baseMatrix, activation, entrance, elevation }
  var selectedId = null;
  var animTimers = {};
  var cameraHandler = null;
  var clickHandler = null;
  var mountToken = 0;

  var glowCache = {};

  // ============================================================
  //  光晕（对齐 hearthere GlowScatterplotLayer 的 compact 星点 shader）
  //
  //  hearthere 原参（见 world-params.js / GLOW）：
  //    getRadius: 50（米）, radiusMinPixels: 17, radiusMaxPixels: 70
  //    —— 注意 deck.gl 的 radius*Pixels 是「半径」，billboard 直径要 ×2
  //    getPosition: [...pos, 80]（海拔 80m）
  //    fillColor alpha 220/255
  //    blendFunc SRC_ALPHA/ONE（加色）
  //    depthCompare:"always" + depthWriteEnabled:false  ← 永不被地表遮挡
  //    compact 星点衰减：
  //      core      = pow(1-smoothstep(0,0.25,d), 1.5)   权重 0.8
  //      innerGlow = pow(1-smoothstep(0,0.45,d), 3.0)   权重 0.15
  //      outerGlow = pow(1-smoothstep(0,0.60,d), 6.0)   权重 0.05
  //      alpha *= (core*0.8 + inner*0.15 + outer*0.05); rgb *= 1.2
  // ============================================================
  var GLOW_RADIUS_PX_MIN = PG.RADIUS_MIN_PX || 17;
  var GLOW_RADIUS_PX_MAX = PG.RADIUS_MAX_PX || 70;
  var GLOW_ALTITUDE_M = PG.ALTITUDE_M || 80;
  var GLOW_ALPHA = (PG.FILL_ALPHA != null ? PG.FILL_ALPHA : 220 / 255);

  // deck.gl 的 smoothstep(edge0, edge1, x) 与 GLSL 同义
  function smoothstep(e0, e1, x) {
    var t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  }

  // 逐像素复刻 compact 星点衰减（比渐变色标精确得多）
  function glowTexture(rgb) {
    var key = rgb.map(function (v) { return Math.round(v * 255); }).join('-');
    if (glowCache[key]) return glowCache[key];
    var size = 128;
    var c = document.createElement('canvas');
    c.width = size; c.height = size;
    var g = c.getContext('2d');
    var img = g.createImageData(size, size);
    var data = img.data;
    var half = size / 2;
    var W = PG.STAR_W || { core: 0.8, inner: 0.15, outer: 0.05 };
    // STAR_INTENSITY = hearthere shader 里的 glowIntensity=1.2，只用于 RGB 提亮（保色相）
    // RENDER_BOOST 只用于 alpha —— 补 Cesium alpha 混合相对 deck.gl 加色混合的亮度差。
    // 二者绝不能一起乘到 RGB，否则高饱和色（如绿色 [0.55,1,0.45]）会三通道全冲 255 变白。
    var intensity = PG.STAR_INTENSITY || 1.2;
    var alphaBoost = PG.RENDER_BOOST || 1;
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var dx = (x - half + 0.5) / half;
        var dy = (y - half + 0.5) / half;
        var dist = Math.sqrt(dx * dx + dy * dy); // unitPosition 的模
        var core = Math.pow(1 - smoothstep(0.0, PG.STAR_CORE_SIZE || 0.25, dist), PG.STAR_CORE_POW || 1.5);
        var inner = Math.pow(1 - smoothstep(0.0, PG.STAR_INNER_SIZE || 0.45, dist), PG.STAR_INNER_POW || 3.0);
        var outer = Math.pow(1 - smoothstep(0.0, PG.STAR_OUTER_SIZE || 0.60, dist), PG.STAR_OUTER_POW || 6.0);
        var combined = core * W.core + inner * W.inner + outer * W.outer;
        // deck.gl 加色混合下暗部光晕会叠加发光；Cesium alpha 混合会把它压没。
        // 用 pow(combined, 0.55) 提亮，保住星点形状的同时把暗部救回来。
        var alphaLift = Math.pow(combined, 0.55);
        var o = (y * size + x) * 4;
        // RGB 只做**保色相**的提亮：乘完若某通道溢出 1，整体等比缩回，
        // 绝不能逐通道夹到 255 —— 那样绿色会被冲成纯白。
        // RENDER_BOOST 不碰颜色，只补透明度（对应 deck.gl 加色混合的亮度差）。
        // 注意：不能用 g/r/b 做变量名 —— g 已经是 canvas 2D 上下文，
        // var 是函数作用域，会把它覆盖掉，最后 g.putImageData 直接崩。
        var cr = rgb[0] * intensity, cg = rgb[1] * intensity, cb = rgb[2] * intensity;
        var mx = Math.max(cr, cg, cb, 0.0001);
        if (mx > 1) { cr /= mx; cg /= mx; cb /= mx; }
        data[o] = Math.round(cr * 255);
        data[o + 1] = Math.round(cg * 255);
        data[o + 2] = Math.round(cb * 255);
        data[o + 3] = Math.min(255, Math.round(255 * alphaLift * GLOW_ALPHA * alphaBoost));
      }
    }
    g.putImageData(img, 0, 0);
    glowCache[key] = c;
    return c;
  }

  // hearthere 的尺寸规则：50m 半径的**投影半径**夹到 [17, 70]px
  // Cesium billboard 的 width/height 是**直径**，所以要 ×2
  // 垂直俯视近似：m/px ≈ 2·h·tan(fovy/2)/W，fovy=60°, W=800px
  function glowPixelSize(cameraHeight) {
    var h = Number(cameraHeight) > 0 ? Number(cameraHeight) : 18000000;
    var mpp = 2 * h * Math.tan(Math.PI / 6) / 800;
    var radiusPx = 50 / mpp; // 50m 半径的投影半径（像素）
    return Math.max(GLOW_RADIUS_PX_MIN, Math.min(GLOW_RADIUS_PX_MAX, Math.round(radiusPx)));
  }

  // 半径 → billboard 直径
  function glowDiameter(cameraHeight) {
    return glowPixelSize(cameraHeight) * 2;
  }

  // ============================================================
  //  Rim shader（移植自 hearthere LighthouseRimLayer）
  // ============================================================
  var FRAGMENT = [
    'void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {',
    '  float y = fsInput.attributes.positionMC.y;',
    '  vec3 n = normalize(fsInput.attributes.normalEC);',
    '  vec3 v = normalize(-fsInput.attributes.positionEC);',
    '  float NdotV = max(0.0, dot(n, v));',
    '  float rim = 1.0 - NdotV;',
    '  float rimIntensity = pow(rim, 6.0);',
    '',
    '  vec3 colorGray = vec3(0.35, 0.4, 0.55);',
    '  float ratio = clamp(y / u_modelHeight, 0.0, 1.0);',
    '  vec3 activeColor = mix(u_colorBottom, u_colorTop, ratio);',
    '',
    '  float scanY = mix(-3.0, 13.0, u_activation);',
    '  float activeness = 1.0 - smoothstep(scanY, scanY + 2.0, y);',
    '  float isAnimating = smoothstep(0.0, 0.1, u_activation) * smoothstep(1.0, 0.9, u_activation);',
    '  float scanLine = exp(-1.0 * abs(y - (scanY + 1.0))) * isAnimating;',
    '',
    '  vec3 baseColor = mix(colorGray, activeColor, activeness);',
    '  baseColor += vec3(1.0) * scanLine * 0.8;',
    '',
    '  float maxComponent = max(baseColor.r, max(baseColor.g, baseColor.b));',
    '  float maxSafeGain = 1.0 / max(0.01, maxComponent);',
    '  float targetActiveBrightness = min(2.0, maxSafeGain);',
    '  float brightness = mix(0.7, targetActiveBrightness, activeness);',
    '  vec3 finalColor = baseColor * brightness;',
    '',
    '  float alphaActive = rimIntensity * 1.5 + 0.6;',
    '  float alphaRest = 0.8;',
    '  float finalAlpha = mix(alphaRest, alphaActive, activeness);',
    '',
    '  float entranceScanY = mix(-3.0, 13.0, u_entrance);',
    '  float entranceVisibility = 1.0 - smoothstep(entranceScanY, entranceScanY + 0.5, y);',
    '  float isEntering = smoothstep(0.0, 0.05, u_entrance) * smoothstep(1.0, 0.95, u_entrance);',
    '  float entranceScanLine = exp(-2.0 * abs(y - entranceScanY)) * isEntering;',
    '  finalColor += vec3(0.8, 1.0, 1.0) * entranceScanLine * 0.6;',
    '  finalAlpha *= entranceVisibility;',
    '  finalAlpha *= u_layerOpacity;',
    '',
    '  material.diffuse = finalColor;',
    '  material.alpha = finalAlpha;',
    '}'
  ].join('\n');

  function buildShader(def) {
    var C = global.Cesium;
    var u3 = function (arr) {
      return new C.Cartesian3(arr[0], arr[1], arr[2]);
    };
    return new C.CustomShader({
      mode: C.CustomShaderMode.MODIFY_MATERIAL,
      lightingModel: C.LightingModel.UNLIT,
      translucencyMode: C.CustomShaderTranslucencyMode.TRANSLUCENT,
      uniforms: {
        u_modelHeight: { type: C.UniformType.FLOAT, value: MODEL_HEIGHT },
        u_colorTop: { type: C.UniformType.VEC3, value: u3(def.colorTop) },
        u_colorBottom: { type: C.UniformType.VEC3, value: u3(def.colorBottom) },
        u_activation: { type: C.UniformType.FLOAT, value: def.status === 'playing' ? 1 : 0 },
        u_entrance: { type: C.UniformType.FLOAT, value: 1 },
        u_layerOpacity: { type: C.UniformType.FLOAT, value: 1 }
      },
      fragmentShaderText: FRAGMENT
    });
  }

  // ============================================================
  //  档位计算
  // ============================================================
  function tierOf(height) {
    if (!(height > 0)) return { glow: 1, detail: 0 };
    if (height >= TIER_GLOW_MAX_H) return { glow: 1, detail: 0 };
    if (height <= TIER_DETAIL_MIN_H) return { glow: 0, detail: 1 };
    var t = (TIER_GLOW_MAX_H - height) / (TIER_GLOW_MAX_H - TIER_DETAIL_MIN_H);
    return { glow: 1 - t, detail: t };
  }

  // 球面剔除：等价于 hearthere 顶点着色器里的 project_globe_is_occluded。
  // 判据：站点外法线与「站点→相机」的点积 > 0（面向相机），否则在球背面。
  // 有了它才能安全地把深度测试关掉（depthCompare:"always"）。
  function isFacingCamera(st) {
    if (!viewer || !viewer.camera || !global.Cesium) return true;
    try {
      // 站点世界坐标在挂载时已显式存好，不再从矩阵抠（Matrix4.getTranslation
      // 对 ENU 帧矩阵虽应等价，但实测在 lookAt 后会被相机变换带偏）。
      var sp = st.worldPos;
      if (!sp) return true;
      var cam = viewer.camera.positionWC;
      // 外法线（地心→站点）
      var nx = sp.x, ny = sp.y, nz = sp.z;
      var nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      // 站点→相机
      var tx = cam.x - sp.x, ty = cam.y - sp.y, tz = cam.z - sp.z;
      var tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
      // 阈值取 -0.05：贴近站点时点积接近 0，留一点余量避免自身被剔除
      return (nx * tx + ny * ty + nz * tz) / (nl * tl) > -0.05;
    } catch (e) {
      return true;
    }
  }

  function applyTier() {
    if (!viewer || !viewer.camera) return;
    var h = viewer.camera.positionCartographic && viewer.camera.positionCartographic.height;
    var t = tierOf(h);
    var dia = glowDiameter(h);
    for (var i = 0; i < stations.length; i++) {
      var st = stations[i];
      try {
        // 球面剔除（背面的整座隐藏，含实体）
        var facing = isFacingCamera(st);

        if (st.model) {
          st.model.show = facing && t.detail > 0.01;
          try { st.model.customShader.setUniform('u_layerOpacity', t.detail); } catch (e) {}
        }
        if (st.glow) {
          // 注意：Entity 的 billboard 属性挂在 st.glow.billboard 上，
          // 直接写 st.glow.alpha / width 是无效的（只是给 Entity 加了个普通字段）。
          var bb = st.glow.billboard;
          var g = t.glow;
          var hideForMesh = t.detail > 0.55;
          var show = facing && !hideForMesh && g > 0.02;
          st.glow.show = show;
          if (bb) {
            bb.alpha = g * (st.def.status === 'offline' ? 0.35 : 1);
            bb.width = dia;
            bb.height = dia;
          }
        }
      } catch (e) {
        // 单座失败不应拖垮整组
        console.warn('[world-lighthouse] applyTier 单座失败', st && st.def && st.def.id, e);
      }
    }
  }

  // ============================================================
  //  选中动画（对齐 hearthere：抬升 → 停留 → 自动回落）
  // ============================================================
  function clearTimer(id) {
    if (animTimers[id]) {
      clearTimeout(animTimers[id].a);
      clearTimeout(animTimers[id].b);
      delete animTimers[id];
    }
  }

  function easeTo(st, from, to, ms, done) {
    var start = Date.now();
    function step() {
      var k = Math.min(1, (Date.now() - start) / ms);
      var e = 1 - Math.pow(1 - k, 3); // easeOutCubic（与 hearthere 一致）
      var v = from + (to - from) * e;
      st.elevation = v;
      applyElevation(st);
      try { st.model.customShader.setUniform('u_activation', st.activation); } catch (err) {}
      if (k < 1) {
        animTimers[st.def.id].a = setTimeout(step, FRAME_MS);
      } else if (done) {
        done();
      }
    }
    step();
  }

  function applyElevation(st) {
    if (!st.model || !st.baseMatrix || !global.Cesium) return;
    var C = global.Cesium;
    var m = C.Matrix4.multiplyByTranslation(
      st.baseMatrix,
      new C.Cartesian3(0, st.elevation, 0),
      new C.Matrix4()
    );
    st.model.modelMatrix = m;
    if (st.glow) {
      // result 必须是新的 Cartesian3：st.glow.position 是 ConstantPositionProperty，
      // 不能当 multiplyByPoint 的输出缓冲区，否则会把 xyz 写到 Property 对象上、
      // 位置不更新（表现为光晕「丢」在原地或消失）。
      var pos = C.Matrix4.multiplyByPoint(
        st.baseMatrix,
        new C.Cartesian3(0, st.elevation + GLOW_ALTITUDE_M, 0),
        new C.Cartesian3()
      );
      st.glow.position = pos;
    }
  }

  function select(id) {
    var st = null;
    for (var i = 0; i < stations.length; i++) {
      if (stations[i].def.id === id) { st = stations[i]; break; }
    }
    if (!st) return;

    // 先收掉上一个
    if (selectedId && selectedId !== id) {
      var prev = null;
      for (var j = 0; j < stations.length; j++) {
        if (stations[j].def.id === selectedId) prev = stations[j];
      }
      if (prev) {
        clearTimer(prev.def.id);
        animTimers[prev.def.id] = {};
        prev.activation = prev.def.status === 'playing' ? 1 : 0;
        easeTo(prev, prev.elevation, ELEV_REST, EASE_MS);
      }
    }

    selectedId = id;
    clearTimer(id);
    animTimers[id] = {};
    st.activation = 1;
    easeTo(st, st.elevation, ELEV_ACTIVE, EASE_MS);

    // 停留后自动回落
    animTimers[id].b = setTimeout(function () {
      if (selectedId !== id) return;
      st.activation = st.def.status === 'playing' ? 1 : 0;
      easeTo(st, st.elevation, ELEV_REST, EASE_MS, function () {
        if (selectedId === id) selectedId = null;
      });
    }, DWELL_MS + EASE_MS);

    // 相机飞过去
    if (viewer && viewer.camera && global.Cesium) {
      var C = global.Cesium;
      try {
        viewer.camera.flyTo({
          destination: C.Cartesian3.fromDegrees(st.def.lon, st.def.lat, 260000),
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
          duration: 1.4
        });
      } catch (e) {}
    }
  }

  // ============================================================
  //  挂载 / 卸载
  // ============================================================
  function destroyStation(st) {
    clearTimer(st.def.id);
    if (viewer && st.model) {
      try { viewer.scene.primitives.remove(st.model); } catch (e) {}
      try { if (!st.model.isDestroyed()) st.model.destroy(); } catch (e) {}
    }
    if (viewer && st.glow) {
      try { viewer.entities.remove(st.glow); } catch (e) {}
    }
    st.model = null; st.glow = null;
  }

  function mount(v, opts) {
    opts = opts || {};
    unmount();
    viewer = v;
    if (!viewer || !global.Cesium) return Promise.resolve({ count: 0 });
    var C = global.Cesium;
    var token = ++mountToken;
    var defs = opts.stations || DEMO_STATIONS;

    // 站点根即 public/，模型在 public/models/lighthouse.glb
    var url = opts.modelUrl || MODEL_URL;

    var loads = defs.map(function (def) {
      var pos = C.Cartesian3.fromDegrees(def.lon, def.lat, 0);
      var base = C.Transforms.eastNorthUpToFixedFrame(pos);
      var st = {
        def: def,
        baseMatrix: base,
        worldPos: pos.clone(),   // 显式存世界坐标，供 isFacingCamera 用
        elevation: ELEV_REST,
        activation: def.status === 'playing' ? 1 : 0,
        model: null,
        glow: null
      };
      stations.push(st);

      // 光晕（远景档）。hearthere 原参：海拔 80m、半径 50m 投影夹到 17~70px（半径！
      // billboard 直径要 ×2）、加色混合、**深度常显**（depthCompare:"always"）。
      // 深度常显会让地球背面的信标透出来，所以配合 applyTier 里的 isFacingCamera
      // 做球面剔除 —— 这正是 hearthere「depthCompare:always + project_globe_is_occluded」
      // 的等价移植。只做其中一半都会出错。
      var glowDia = glowDiameter(18000000);
      var glow = viewer.entities.add({
        position: C.Matrix4.multiplyByPoint(
          base, new C.Cartesian3(0, GLOW_ALTITUDE_M, 0), new C.Cartesian3()
        ),
        billboard: {
          image: glowTexture(def.colorTop),
          width: glowDia,
          height: glowDia,
          heightReference: C.HeightReference.NONE,
          // 对齐 hearthere depthCompare:"always" —— 永不被地表遮挡
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      });
      st.glow = glow;

      // 灯塔实体（近景档）
      return C.Model.fromGltfAsync({
        url: url,
        modelMatrix: C.Matrix4.multiplyByTranslation(
          base, new C.Cartesian3(0, ELEV_REST, 0), new C.Matrix4()
        ),
        scale: MODEL_SCALE,
        minimumPixelSize: 8,
        customShader: buildShader(def),
        allowPicking: true,
        id: def.id
      }).then(function (model) {
        if (token !== mountToken) {
          try { model.destroy(); } catch (e) {}
          return null;
        }
        st.model = model;
        viewer.scene.primitives.add(model);
        return st;
      }).catch(function (err) {
        console.warn('[world-lighthouse] 模型加载失败', def.id, err && err.message ? err.message : err);
        return null;
      });
    });

    return Promise.all(loads).then(function () {
      if (token !== mountToken) return { count: 0 };
      applyTier();
      cameraHandler = function () { applyTier(); };
      try { viewer.camera.changed.addEventListener(cameraHandler); } catch (e) {}
      clickHandler = function (movement) {
        try {
          var picked = viewer.scene.pick(movement.position);
          var id = picked && (picked.id && picked.id.id ? picked.id.id : picked.id);
          if (typeof id !== 'string') return;
          select(id);
          if (opts.onBeaconClick) {
            var st = null;
            for (var k = 0; k < stations.length; k++) {
              if (stations[k].def.id === id) { st = stations[k].def; break; }
            }
            opts.onBeaconClick(st, movement.position);
          }
        } catch (e) {}
      };
      try {
        viewer.screenSpaceEventHandler.setInputAction(
          clickHandler, C.ScreenSpaceEventType.LEFT_CLICK
        );
      } catch (e) {}
      return { count: stations.length, stations: stations.map(function (s) { return s.def; }) };
    });
  }

  function unmount() {
    mountToken++;
    if (viewer && cameraHandler) {
      try { viewer.camera.changed.removeEventListener(cameraHandler); } catch (e) {}
    }
    if (viewer && clickHandler) {
      try {
        viewer.screenSpaceEventHandler.removeInputAction(C.ScreenSpaceEventType.LEFT_CLICK);
      } catch (e) {}
    }
    cameraHandler = null; clickHandler = null;
    for (var i = 0; i < stations.length; i++) destroyStation(stations[i]);
    stations = [];
    selectedId = null;
    viewer = null;
  }

  // ============================================================
  //  导出
  // ============================================================
  // ============================================================
  //  增量刷新（房间上球用）
  //  绝不能 unmount()+mount() 重建——那会反复建毁 WebGL 上下文，
  //  16 次后触发 "Too many active WebGL contexts" 黑屏（M0 验收时踩过）。
  //  这里只做增/删/改。
  // ============================================================
  function makeStation(def, C) {
    var pos = C.Cartesian3.fromDegrees(def.lon, def.lat, 0);
    var base = C.Transforms.eastNorthUpToFixedFrame(pos);
    return {
      def: def,
      baseMatrix: base,
      worldPos: pos.clone(),
      elevation: ELEV_REST,
      activation: def.status === 'playing' ? 1 : 0,
      model: null,
      glow: null
    };
  }

  function createStationAssets(st, C) {
    st.glow = viewer.entities.add({
      position: C.Matrix4.multiplyByPoint(
        st.baseMatrix, new C.Cartesian3(0, GLOW_ALTITUDE_M, 0), new C.Cartesian3()
      ),
      billboard: {
        image: glowTexture(st.def.colorTop),
        width: glowDiameter(18000000),
        height: glowDiameter(18000000),
        heightReference: C.HeightReference.NONE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    });
    return C.Model.fromGltfAsync({
      url: MODEL_URL,
      modelMatrix: C.Matrix4.multiplyByTranslation(
        st.baseMatrix, new C.Cartesian3(0, ELEV_REST, 0), new C.Matrix4()
      ),
      scale: MODEL_SCALE,
      minimumPixelSize: 8,
      customShader: buildShader(st.def),
      allowPicking: true,
      id: st.def.id
    }).then(function (model) {
      if (!viewer) { try { model.destroy(); } catch (e) {} return null; }
      st.model = model;
      viewer.scene.primitives.add(model);
      return st;
    }).catch(function (err) {
      console.warn('[world-lighthouse] 增量建模失败', st.def.id, err && err.message);
      return st;
    });
  }

  function refreshStations(defs) {
    if (!viewer || !global.Cesium) return Promise.resolve({ count: 0 });
    if (!Array.isArray(defs) || !defs.length) return Promise.resolve({ count: stations.length });
    var C = global.Cesium;

    var wanted = {};
    defs.forEach(function (d) { if (d && d.id) wanted[d.id] = d; });

    // 1) 删除：不在新列表里
    for (var i = stations.length - 1; i >= 0; i--) {
      if (!wanted[stations[i].def.id]) {
        destroyStation(stations[i]);
        stations.splice(i, 1);
      }
    }

    // 2) 更新：已存在的只改元数据与光晕贴图，不动 model（省一次建毁）
    var have = {};
    stations.forEach(function (st) { have[st.def.id] = st; });
    defs.forEach(function (d) {
      var st = have[d.id];
      if (!st) return;
      st.def = d;
      st.activation = d.status === 'playing' ? 1 : 0;
      if (st.glow && st.glow.billboard) {
        try {
          st.glow.billboard.image = glowTexture(d.colorTop);
          st.glow.billboard.width = glowDiameter(18000000);
          st.glow.billboard.height = glowDiameter(18000000);
        } catch (e) {}
      }
    });

    // 3) 新增
    var added = defs.filter(function (d) { return d && d.id && !have[d.id]; });
    if (!added.length) {
      applyTier();
      return Promise.resolve({ count: stations.length });
    }
    var jobs = added.map(function (d) {
      var st = makeStation(d, C);
      stations.push(st);
      return createStationAssets(st, C);
    });
    return Promise.all(jobs).then(function () {
      applyTier();
      return { count: stations.length };
    });
  }

  SFV.worldLighthouse = {
    MODEL_HEIGHT: MODEL_HEIGHT,
    MODEL_SCALE: MODEL_SCALE,
    TIER_GLOW_MAX_H: TIER_GLOW_MAX_H,
    TIER_DETAIL_MIN_H: TIER_DETAIL_MIN_H,
    GLOW_RADIUS_PX_MIN: GLOW_RADIUS_PX_MIN,
    GLOW_RADIUS_PX_MAX: GLOW_RADIUS_PX_MAX,
    GLOW_ALTITUDE_M: GLOW_ALTITUDE_M,
    GLOW_ALPHA: GLOW_ALPHA,
    DEMO_STATIONS: DEMO_STATIONS,
    tierOf: tierOf,
    glowPixelSize: glowPixelSize,
    glowDiameter: glowDiameter,
    isFacingCamera: isFacingCamera,
    mount: mount,
    unmount: unmount,
    refreshStations: refreshStations,
    select: select,
    applyTier: applyTier,
    get stations() { return stations; },
    get selectedId() { return selectedId; }
  };
})(typeof window !== 'undefined' ? window : this);
