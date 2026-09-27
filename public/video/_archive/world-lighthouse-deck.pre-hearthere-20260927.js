/*
 * Stellaflix 影视模块 — 世界页灯塔 deck 层（世界页大翻版 Task 4）
 *
 * 职责：在 Task 2 的 deck.gl MapboxOverlay 上渲染「听所在即灯塔」的
 * LighthouseRimLayer（rim 描边 + 垂直渐变 + 激活扫描 + 入场扫描），
 * 模型几何来自 Task 3 程序化灯塔（SFV.worldLighthouseModel.build()）。
 *
 * GLSL 移植源：HearThere main.pretty.js :11342-11470（Qh / LighthouseRimLayer）
 * 层工厂对齐 :11488-11541（zo()），预热层 :13160-13180（Zm/Xm/Jm），
 * 尺寸 290/150 :10691，zoom 门限 12.5 :10609。
 * 等比换算：hearthere modelHeight 9.22 的扫描带 -3→13，本作模型高 9.3，
 * 按 controller ruling 3 用 modelHeight * -0.325 / modelHeight * 1.41 表达。
 *
 * 生命周期（Task 6 契约）：
 *   SFV.worldLighthouseDeck.mount(map, overlay, opts) -> Promise
 *   unmount() / refreshStations(rooms) / setSelected(id) / applyTier(zoom)
 *   getState() -> {stations, selectedId, visible}
 *   pickStation(x, y) -> station | null（Task 6 在 map click 里调用）
 *
 * 双装载：纯数据函数（roomToStation / getColor / sizeOf / tierVisible / WARMUP …）
 * 经 module.exports 守卫供 Node 测试直连；WebGL 依赖（层类 / mount）仅浏览器路径。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  // ============================================================
  //  常量（hearthere 逐值移植）
  // ============================================================

  // 尺寸分级：选中 290 / 未选中 150（:10691 Mn 调整值）
  var SIZE_SELECTED = 290;
  var SIZE_REST = 150;
  // zoom 门限：灯塔实体层 12.5 以下不显示（:10609 St = 12.5）
  var TIER_ZOOM = 12.5;
  // 过渡带半宽（:10607 xt = 1；detailOpacity 在 St±xt 线性渐变）
  var TIER_FADE = 1;
  // Task 3 程序化模型塔高（hearthere 9.22 → 本作 9.3）
  var MODEL_HEIGHT = 9.3;
  // 默认渐变双色（hearthere :5581-5582）
  var COLOR_TOP_DEFAULT = [223, 204, 251];
  var COLOR_BOTTOM_DEFAULT = [150, 200, 254];
  // 激活/去激活的颜色过渡时长（:11510-11512 transitions 1e3）
  var TRANSITION_MS = 1000;
  // 入场扫描动画总时长（rAF 驱动 setProps，约 30 帧档）
  var ENTRANCE_MS = 1000;
  // 预热层（:13164-13177 Zm/Xm/Jm）：单枚假站、opacity 0.001、不可点，
  // 首次 mount 即建 shader/几何，真站点出现时不再卡首帧
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
  //  纯数据 API（Node 可测面）
  // ============================================================

  // 房间（world-data 归一化形状 / API 原始形状）→ 灯塔站点
  function roomToStation(room) {
    if (!room) return null;
    if (Array.isArray(room.position)) return room; // 已是 station 形状，透传
    var lon = room.longitude != null ? room.longitude : room.lon;
    var lat = room.latitude != null ? room.latitude : room.lat;
    return {
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
  }

  // vColor.a 即激活动画进度（deck transitions  tween 0→255）（:11506）
  function getColor(st) {
    return [255, 255, 255, st && st.status !== 'offline' ? 255 : 0];
  }

  // 尺寸分级：选中放大到 290，其余 150（:10691）
  function sizeOf(st, selectedId) {
    return (selectedId != null && st && st.id === selectedId) ? SIZE_SELECTED : SIZE_REST;
  }

  // 灯塔实体层显隐门限（:10609，含 12.5 本身）
  function tierVisible(zoom) {
    var z = Number(zoom);
    return isFinite(z) && z >= TIER_ZOOM;
  }

  // 细节层透明度：St-xt 以下为 0，St+xt 以上为 1，中间线性（:11610 ds()）
  function detailOpacity(zoom) {
    var z = Number(zoom);
    if (!isFinite(z)) return 0;
    var lo = TIER_ZOOM - TIER_FADE;
    var hi = TIER_ZOOM + TIER_FADE;
    if (z < lo) return 0;
    if (z > hi) return 1;
    return (z - lo) / (hi - lo);
  }

  // 0-255 或 0-1 混合输入 → GLSL 用的 0..1 vec3；越界分量等比压回
  function toColorVec(c, fallback) {
    var arr = (Array.isArray(c) && c.length >= 3) ? c : fallback;
    var f = Math.max(arr[0], arr[1], arr[2]) > 1 ? 1 / 255 : 1;
    var r = arr[0] * f, g = arr[1] * f, b = arr[2] * f;
    var mx = Math.max(r, g, b, 0.0001);
    if (mx > 1) { r /= mx; g /= mx; b /= mx; }
    return [Math.max(0, r), Math.max(0, g), Math.max(0, b)];
  }

  // ============================================================
  //  GLSL inject（逐段移植 main.pretty.js:11342-11470）
  //  仅两处按 9.22→9.3 等比改写：
  //   · 激活扫描 scanY：-3→13 ⇒ modelHeight * -0.325 → modelHeight * 1.41
  //   · 入场扫描 entranceScanY：brief Step 3 归一化式 mix(-0.33, 1.08) * modelHeight
  // ============================================================

  var SHADER_INJECT = {
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
      '        float modelHeight = ' + MODEL_HEIGHT.toFixed(2) + ';',
      '        float ratio = clamp(vModelHeight / modelHeight, 0.0, 1.0);',
      '        vec3 activeColor = mix(colorBottom, colorTop, ratio);',
      '',
      '        // --- 激活扫描动画（-3→13 @9.22 等比：-0.325 / +1.41）---',
      '        float scanY = mix(modelHeight * -0.325, modelHeight * 1.41, activationProgress);',
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
      '        // 亮度和透明度（Dynamic Brightness Adjustment，防过曝裁到 <1.0）',
      '        float maxComponent = max(baseColor.r, max(baseColor.g, baseColor.b));',
      '        float maxSafeGain = 1.0 / max(0.01, maxComponent);',
      '        float targetActiveBrightness = min(2.0, maxSafeGain);',
      '        float brightness = mix(0.7, targetActiveBrightness, activeness);',
      '        vec3 finalColor = baseColor * brightness;',
      '',
      '        float alphaActive = rimIntensity * 1.5 + 0.6;',
      '        float alphaRest = 0.8;',
      '        float finalAlpha = mix(alphaRest, alphaActive, activeness);',
      '',
      '        // === 入场扫描动画（独立 vEntranceProgress 0→1 控制）===',
      '        float entranceProgress = vEntranceProgress;',
      '',
      '        // 入场扫描线位置：从模型底部扫到顶部（brief Step 3 归一化式）',
      '        float entranceScanY = mix(-0.33, 1.08, entranceProgress) * modelHeight;',
      '',
      '        // 扫描线以上的部分不可见（平滑过渡边缘）',
      '        float entranceVisibility = 1.0 - smoothstep(entranceScanY, entranceScanY + 0.5, vModelHeight);',
      '',
      '        // 高于入场扫描线的片段直接丢弃（main.pretty.js:11428-11433 语义；',
      '        // 边缘平滑带之外的 visibility 已为 0，discard 与原式等价且省混合）',
      '        if (entranceVisibility <= 0.0) discard;',
      '',
      '        // 入场扫描线发光效果（仅在动画进行中显示）',
      '        float isEntering = smoothstep(0.0, 0.05, entranceProgress) * smoothstep(1.0, 0.95, entranceProgress);',
      '        float entranceScanLine = exp(-2.0 * abs(vModelHeight - entranceScanY)) * isEntering;',
      '',
      '        // 叠加入场扫描线发光（青白色）',
      '        finalColor += vec3(0.8, 1.0, 1.0) * entranceScanLine * 0.6;',
      '',
      '        // 应用入场扫描效果 + 图层整体透明度（zoom 过渡淡入淡出）',
      '        finalAlpha *= entranceVisibility;',
      '        finalAlpha *= vLayerOpacity;',
      '',
      '        fragColor = vec4(finalColor, finalAlpha);',
      '        DECKGL_FILTER_COLOR(fragColor, geometry);'
    ].join('\n')
  };

  // ============================================================
  //  WebGL 依赖区（仅浏览器路径；Node require 不触以下代码）
  // ============================================================

  var RimLayer = null; // 惰性类定义（类体引用 deck 全局）
  var meshCache = null; // Task 3 程序化网格，跨 mount 复用（对齐 hearthere 的 Ho 单例）

  function ensureLayerClass() {
    if (RimLayer) return RimLayer;
    var deckGlobal = global.deck;
    if (!deckGlobal || !deckGlobal.SimpleMeshLayer) {
      throw new Error('[world-lighthouse-deck] deck.gl 未就绪（应由 world-globe 先行加载）');
    }
    RimLayer = class LighthouseRimLayer extends deckGlobal.SimpleMeshLayer {
      getShaders() {
        var e = super.getShaders();
        e.inject = SHADER_INJECT;
        return e;
      }
      initializeState() {
        super.initializeState();
        var am = this.getAttributeManager();
        if (am) {
          // 对齐 hearthere :11470-11488 的四个 instanced 属性
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
              defaultValue: [1], transition: true
            },
            instanceEntranceProgress: {
              size: 1, type: 'float32', accessor: 'getEntranceProgress',
              defaultValue: [1], transition: true
            }
          });
        }
      }
    };
    return RimLayer;
  }

  // Task 3 索引是恒等序（每三角形独占 3 顶点：base, base+1, base+2）。
  // deck v9 的 SimpleMeshLayer 内部把 mesh.attributes 归一化成
  // positions/colors/normals/texCoords 四件套、不保留 indices，
  // 因此按索引展开成非索引 triangle-list（信息零损失，塔 16 段 ≈ 2688 顶点）。
  function expandNonIndexed(built) {
    var idx = built.indices;
    var n = idx.length;
    var positions = new Float32Array(n * 3);
    var normals = new Float32Array(n * 3);
    for (var i = 0; i < n; i++) {
      var v = idx[i];
      positions[i * 3] = built.positions[v * 3];
      positions[i * 3 + 1] = built.positions[v * 3 + 1];
      positions[i * 3 + 2] = built.positions[v * 3 + 2];
      normals[i * 3] = built.normals[v * 3];
      normals[i * 3 + 1] = built.normals[v * 3 + 1];
      normals[i * 3 + 2] = built.normals[v * 3 + 2];
    }
    return { positions: positions, normals: normals };
  }

  function ensureMesh() {
    if (meshCache) return meshCache;
    if (!SFV.worldLighthouseModel || typeof SFV.worldLighthouseModel.build !== 'function') {
      throw new Error('[world-lighthouse-deck] SFV.worldLighthouseModel 缺失（Task 3 模块未加载）');
    }
    var built = SFV.worldLighthouseModel.build(); // 默认 16 段
    // Task 3 已知 Float32 舍入：塔顶量测高与 9.3 允许微小偏差
    if (Math.abs(built.modelHeight - MODEL_HEIGHT) > 1e-3) {
      console.warn('[world-lighthouse-deck] 模型塔高', built.modelHeight,
        '与 shader 常量 MODEL_HEIGHT', MODEL_HEIGHT, '偏差超 eps，着色比例可能有微差');
    }
    var expanded = expandNonIndexed(built);
    var attrs = {
      positions: { value: expanded.positions, size: 3 },
      normals: { value: expanded.normals, size: 3 },
      indices: { value: built.indices, size: 3, type: 'UINT16' }
    };
    // controller ruling 2：优先 deck.Mesh（luma Mesh 支持 indices 属性，
    // UINT16 索引省一半顶点缓冲）；当前 deck.gl 9.2.4 单文件包未导出 Mesh，
    // 回退到 SimpleMeshLayer 认可的纯 {attributes} 对象（非索引 triangle-list）。
    var mesh;
    if (global.deck && typeof global.deck.Mesh === 'function') {
      mesh = new global.deck.Mesh({ attributes: attrs });
    } else {
      mesh = { attributes: { positions: attrs.positions, normals: attrs.normals } };
    }
    meshCache = { mesh: mesh, modelHeight: built.modelHeight };
    return meshCache;
  }

  // ============================================================
  //  层工厂（对齐 hearthere zo() :11488-11541）
  // ============================================================

  function makeRimLayer(cfg) {
    var data = cfg.data;
    return new RimLayer({
      id: cfg.id,
      data: data,
      visible: cfg.visible !== false,
      pickable: cfg.pickable !== false,
      mesh: meshCache.mesh,
      sizeScale: cfg.sizeScale,
      // 离线塔 alpha=0 不激活（:11506）
      getColor: function (c) { return getColor(c); },
      getColorTop: function (c) { return toColorVec(c.colorTop, COLOR_TOP_DEFAULT); },
      getColorBottom: function (c) { return toColorVec(c.colorBottom, COLOR_BOTTOM_DEFAULT); },
      getLayerOpacity: function () { return cfg.layerOpacity; },
      getEntranceProgress: function () { return cfg.entranceProgress; },
      // :11510-11512 逐值
      transitions: {
        getColor: 1000,
        getColorTop: 1000,
        getColorBottom: 1000,
        getLayerOpacity: 100,
        getEntranceProgress: 1000
      },
      updateTriggers: {
        getColor: data.map(function (c) { return c.status; }),
        getColorTop: data.map(function (c) { return (c.colorTop || []).join(','); }),
        getColorBottom: data.map(function (c) { return (c.colorBottom || []).join(','); }),
        getLayerOpacity: [cfg.layerOpacity],
        getEntranceProgress: [cfg.entranceProgress]
      },
      getPosition: function (c) { return c.position; },
      getOrientation: [0, 0, 90], // :11529
      // hearthere parameters（:11534-11540）按 luma.gl v9 语义改写：
      // cull 背面 + 不写深度 + 标准透明混合（默认 SRC_ALPHA/ONE_MINUS_SRC_ALPHA）
      parameters: { cullMode: 'back', depthWriteEnabled: false }
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
    zoom: null,       // null = 未挂载 / 未知 zoom
    entranceProgress: 1,
    raf: null,
    mounted: false
  };
  var onZoomHandler = null;
  // Task 6（Task 4 评审 Important 回归）：mount epoch token。
  // mount 的建层/挂监听在 Promise 续体里执行，不 await 连挂两次时，
  // 第一续体落地时 state 已指向第二次的 map——epoch 让过期续体止步，
  // 绝不在已被取代的 map 上留 zoom 监听（监听体内同样校验，残留即 no-op）。
  var mountEpoch = 0;

  function currentVisible() {
    return state.mounted && tierVisible(state.zoom);
  }

  // 每次刷新重建层数组（controller ruling 4）：
  //   [预热层(0.001/不可点), 未选中批(150, pickable), 选中单层(290)]
  // 选中拆分镜像 hearthere :13525-13540（rim-layer-${id} + lighthouse-expanded-batch）
  function refresh() {
    if (!state.overlay || typeof state.overlay.setProps !== 'function') return;
    if (!RimLayer || !meshCache) return;
    var zoom = state.zoom;
    var visible = tierVisible(zoom);
    var opacity = Math.max(detailOpacity(zoom), 0);
    var layers = [
      makeRimLayer({
        id: WARMUP.id,
        data: WARMUP.data,
        sizeScale: SIZE_REST,
        layerOpacity: WARMUP.opacity,
        entranceProgress: 1,
        pickable: false,
        visible: true // 预热层常驻（:13495-13500 不受档位门限影响）
      })
    ];
    if (opacity < 0.01 && !visible) {
      // hearthere Bt 门限（x >= St-xt || ce > .01）：远景档只留预热层
      state.overlay.setProps({ layers: layers });
      return;
    }
    var selected = null;
    var others = [];
    for (var i = 0; i < state.stations.length; i++) {
      var st = state.stations[i];
      if (state.selectedId != null && st.id === state.selectedId) selected = st;
      else others.push(st);
    }
    if (others.length > 0) {
      layers.push(makeRimLayer({
        id: 'lighthouse-rim-batch',
        data: others,
        sizeScale: sizeOf({ id: '__always_unselected__' }, state.selectedId), // 批内恒未选中 → 150
        layerOpacity: opacity,
        entranceProgress: state.entranceProgress,
        visible: visible
      }));
    }
    if (selected) {
      layers.push(makeRimLayer({
        id: 'lighthouse-expanded-batch',
        data: [selected],
        sizeScale: sizeOf(selected, state.selectedId), // 选中 290
        layerOpacity: opacity,
        entranceProgress: 1,
        visible: visible
      }));
    }
    state.overlay.setProps({ layers: layers });
  }

  // 入场动画：0→1 约 1000ms，rAF 驱动 setProps
  // （deck transitions 不能 tween 普通函数属性的语义 → 单 helper 帧推进）
  function runEntrance() {
    cancelEntrance();
    var startTs = null;
    function step(ts) {
      if (!state.mounted) { state.raf = null; return; }
      if (startTs == null) startTs = ts;
      var t = Math.min(1, (ts - startTs) / ENTRANCE_MS);
      state.entranceProgress = t;
      refresh();
      if (t < 1) {
        state.raf = requestAnimationFrame(step);
      } else {
        state.raf = null;
      }
    }
    state.raf = requestAnimationFrame(step);
  }

  function cancelEntrance() {
    if (state.raf != null) {
      cancelAnimationFrame(state.raf);
      state.raf = null;
    }
  }

  // ============================================================
  //  生命周期（Task 6 契约）
  // ============================================================

  function mount(map, overlay, opts) {
    unmount();
    var epoch = mountEpoch; // unmount() 已推进 epoch：本 mount 的续体只认这个号
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
      ensureLayerClass();
      ensureMesh();
      state.mounted = true;
      if (map && typeof map.on === 'function') {
        onZoomHandler = function () {
          if (epoch !== mountEpoch) return; // 残留监听 no-op（双保险）
          state.zoom = typeof map.getZoom === 'function' ? map.getZoom() : state.zoom;
          refresh();
        };
        map.on('zoom', onZoomHandler);
      }
      runEntrance(); // 首帧起 0→1 入场扫描，每帧 setProps
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
    cancelEntrance();
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
    state.entranceProgress = 1;
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

  // Task 6 点击拾取：deck picking 结果还原成站点对象
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
      inst = Array.isArray(data) ? data[picked.index] : (data && data.getObjectForIndex ? data.getObjectForIndex(picked.index) : null);
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

  var api = {
    mount: mount,
    unmount: unmount,
    refreshStations: refreshStations,
    setSelected: setSelected,
    applyTier: applyTier,
    getState: getState,
    pickStation: pickStation,
    // 常量 / 纯函数（调试与测试用）
    WARMUP: WARMUP,
    SIZE_SELECTED: SIZE_SELECTED,
    SIZE_REST: SIZE_REST,
    TIER_ZOOM: TIER_ZOOM,
    MODEL_HEIGHT: MODEL_HEIGHT,
    COLOR_TOP_DEFAULT: COLOR_TOP_DEFAULT,
    COLOR_BOTTOM_DEFAULT: COLOR_BOTTOM_DEFAULT,
    roomToStation: roomToStation,
    getColor: getColor,
    sizeOf: sizeOf,
    tierVisible: tierVisible,
    detailOpacity: detailOpacity,
    toColorVec: toColorVec
  };
  SFV.worldLighthouseDeck = api;

  // Node 直连 require（双装载模式，同 world-lighthouse-model.js）：
  // 只暴露纯数据面；WebGL 依赖函数在 Node 下不可用也不报错。
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      roomToStation: roomToStation,
      getColor: getColor,
      sizeOf: sizeOf,
      tierVisible: tierVisible,
      detailOpacity: detailOpacity,
      toColorVec: toColorVec,
      getState: getState,
      WARMUP: WARMUP,
      SIZE_SELECTED: SIZE_SELECTED,
      SIZE_REST: SIZE_REST,
      TIER_ZOOM: TIER_ZOOM,
      MODEL_HEIGHT: MODEL_HEIGHT,
      COLOR_TOP_DEFAULT: COLOR_TOP_DEFAULT,
      COLOR_BOTTOM_DEFAULT: COLOR_BOTTOM_DEFAULT,
      SHADER_INJECT: SHADER_INJECT
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
