# Stellaflix 世界页大翻版（HearThere 对齐）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把世界页从 Cesium 迁移到 MapLibre globe + deck.gl，按 HearThere 实测源码复刻「3D 灯塔 + 扫描点亮 + 电影感 flyTo + 实时同步 + 烟花」，语义由「世界在听」改为「看看世界都在看什么」（放映房间）。

**Architecture:** 保留 SFV 路由与 `SFV.world*` 模块契约（mount/unmount/refreshStations 等签名不变），只换实现：`world-cesium.js` 退役 → 新增 `world-globe.js`（MapLibre+deck.gl 底座）与 `world-lighthouse-deck.js`（SimpleMeshLayer 定制 shader 灯塔层）；数据层沿用 `world-data.js`/`world-room-api.js` 并新增服务端 broadcast 频道做进度同步；UI 沿用 `world-ui.js`（已有烟花画布）。

**Tech Stack:** maplibre-gl 5.9.0（globe 投影）+ deck.gl 9.2.4 单体 UMD（内联 luma.gl，含 MapboxOverlay/SimpleMeshLayer）+ @loaders.gl/core+obj 4.3.3（UMD）；Esri World Imagery 免 key 卫星底图；本地 GeoJSON 边界；node:test + jsdom。

**Spec / 证据源:**
- HearThere 抓取分析：`_scratch/hearthere/main.pretty.js`（美化后 20394 行，行号引用均指此文件）与 `index.html`、`assets/StationAdmin-O8YPPgeO.js`
- 本计划执行位置：**主工作区 `C:/Users/Administrator/Desktop/Stellaflix`**（用户已确认「直接改」，现状 9 个 world-*.js 未提交）

## Global Constraints

- 不新增 npm 运行时依赖；第三方库一律以 UMD 落盘 `public/vendor/`（对齐现有 `vendor/cesium` 懒加载模式，world-cesium.js:5-19）。
- 不使用 Supabase；实时走自建 server.js（扩展 `world-api.js`/`world-room-api.js`）。
- 外部只允许 GET；底图失败必须降级（OSM → 无底图深色球）。
- 版权红线：HearThere 灯塔 OBJ 为 POMO Studio 私有素材（main.pretty.js:6301-6310），**禁止下载/使用**；模型用代码程序化生成。
- 文案：口号「看看世界都在看什么」；统计「N 个放映厅 · N 正在放映」；ON AIR 徽章保留。
- 测试命令：`node --test tests/<file>`；全量 `npm test`（tests/run-all.js）。
- **提交策略（用户规则覆盖本技能模板）：每个 Task 结尾不执行 git commit，只跑测试并汇报 checkpoint；commit 必须等用户明确下达「提交」指令。**
- 已声明风险：主工作区现状未提交且本次直接覆盖 `world-lighthouse.js`/`world-cesium.js` 所走链路；执行计划前建议做一次 WIP commit 保底（用户已选择跳过，风险已知）。

## 关键移植参数（全部有行号出处）

| 参数 | HearThere 值 | 出处 | Stellaflix 取值 |
|---|---|---|---|
| 灯塔显示最小 zoom | 12.5（余量 1） | main.pretty.js:10609 `St=12.5, xt=1` | 12.5 起步，R 后目视调 |
| 选中/未选中尺寸 | 290 / 80 | :10691 `Mn=290, fs=80` | 290 / 150（程序模型较小，待调） |
| flyTo | zoom16 / pitch60 / 2800ms | :19062-19064 | 同值 |
| 模型高 | 9.22（扫描 -3→13） | :11390-11396 | 程序模型实测后写死 |
| 默认渐变 | 顶[223,204,251] 底[150,200,254] | :5581-5582 | 同值 |
| rim 指数 | `pow(1-NdotV, 6)` | :11386 | 同值 |
| 颜色过渡 | getColor 1000ms | :11510-11512 | 同值 |
| 预热层 | opacity 0.001 @ (0,0) | :13164-13177 | 同法 |
| 心跳 RPC | record_station_host_heartbeat | :15901-15913 | server.js 房间心跳接口对齐 |
| 轮询兜底 | 3min 增量 | :14039 `gg=3*6e4` | 保留现有 20s（page-world.js:23-38） |

---

### Task 1: vendor 依赖落盘 + 完整性探测测试

**Files:**
- Create: `public/vendor/maplibre/maplibre-gl.min.js`、`public/vendor/maplibre/maplibre-gl.css`
- Create: `public/vendor/deck.gl/deck.gl.min.js`
- Create: `public/vendor/loaders/loaders.gl.core.min.js`、`public/vendor/loaders/loaders.gl.obj.min.js`
- Create: `tests/world-vendor.test.js`
- Modify: 无

**Interfaces:**
- Produces: 全局 `maplibregl`、`deck`、`loaders`、`OBJLoader`（浏览器 script 顺序：core → obj → maplibre → deck）

- [ ] **Step 1: 下载（固定版本，禁止 latest）**

```bash
mkdir -p public/vendor/maplibre public/vendor/deck.gl public/vendor/loaders
curl -s -o public/vendor/maplibre/maplibre-gl.min.js https://cdn.jsdelivr.net/npm/maplibre-gl@5.9.0/dist/maplibre-gl.min.js
curl -s -o public/vendor/maplibre/maplibre-gl.css   https://cdn.jsdelivr.net/npm/maplibre-gl@5.9.0/dist/maplibre-gl.css
curl -s -o public/vendor/deck.gl/deck.gl.min.js     https://cdn.jsdelivr.net/npm/deck.gl@9.2.4/dist.min.js
curl -s -o public/vendor/loaders/loaders.gl.core.min.js https://cdn.jsdelivr.net/npm/@loaders.gl/core@4.3.3/dist/dist.min.js
curl -s -o public/vendor/loaders/loaders.gl.obj.min.js  https://cdn.jsdelivr.net/npm/@loaders.gl/obj@4.3.3/dist/dist.min.js
```

- [ ] **Step 2: 写探测测试（先失败：文件未落盘/内容不对）**

```js
// tests/world-vendor.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const V = p => path.join(__dirname, '..', 'public', 'vendor', p);

test('maplibre UMD 落盘且暴露 maplibregl 全局', () => {
  const s = fs.readFileSync(V('maplibre/maplibre-gl.min.js'), 'utf8');
  assert.ok(s.length > 800_000, 'maplibre-gl.min.js 体积异常');
  assert.match(s, /maplibregl/);
});
test('deck.gl 单体 UMD 含 MapboxOverlay 与 SimpleMeshLayer（luma 已内联）', () => {
  const s = fs.readFileSync(V('deck.gl/deck.gl.min.js'), 'utf8');
  assert.ok(s.includes('MapboxOverlay'));
  assert.ok(s.includes('SimpleMeshLayer'));
  assert.ok(!/window\.luma/.test(s), '不应依赖外部 luma 全局');
});
test('loaders.gl core+obj UMD 落盘', () => {
  assert.ok(fs.readFileSync(V('loaders/loaders.gl.core.min.js')).length > 50_000);
  assert.ok(fs.readFileSync(V('loaders/loaders.gl.obj.min.js')).toString().includes('OBJ'));
});
```

- [ ] **Step 3: 运行** `node --test tests/world-vendor.test.js` → 期望 PASS（若 Step 1 已下载）
- [ ] **Step 4: Checkpoint 汇报（不 commit）**

---

### Task 2: world-globe.js 底座（替换 Cesium mount 契约）

**Files:**
- Create: `public/video/world-globe.js`
- Modify: `public/index.html`（脚本清单 :2078 附近，`"video/world-cesium.js"` → `"video/world-globe.js"`）
- Modify: `public/video/page-world.js`（`SFV.worldCesium.mount` → `SFV.worldGlobe.mount`，返回 `info.viewer` 改为 `info.map` + 兼容 `info.viewer`）
- Test: `tests/world-globe.test.js`

**Interfaces:**
- Consumes: Task 1 vendor 文件
- Produces: `SFV.worldGlobe = { mount(host) -> Promise<{map, overlay, basemap}>, unmount(), getMap() }`；懒加载序列与降级：esri → osm → 无底图（对齐 world-cesium.js 的懒加载注释 :5-6 与降级语义）

- [ ] **Step 1: 写失败测试（jsdom 无 WebGL：只测样式 JSON 与脚本序列与降级分支）**

```js
// tests/world-globe.test.js（节选）
const { test } = require('node:test');
const assert = require('node:assert');
const { loadModule } = require('./helpers/sfv-loader'); // 现有 jsdom 装载 helper，若无则新建：读文件+new Function 注入 fake window

test('world-globe 暴露 mount/unmount 且注册到 SFV.worldGlobe', async () => {
  const { SFV } = loadModule('public/video/world-globe.js');
  assert.equal(typeof SFV.worldGlobe.mount, 'function');
  assert.equal(typeof SFV.worldGlobe.unmount, 'function');
});
test('底图样式：globe 投影 + Esri 影像 URL + OSM 兜底', async () => {
  const { SFV } = loadModule('public/video/world-globe.js');
  const styles = SFV.worldGlobe.__styles || SFV.worldGlobe.styles;
  assert.equal(styles.primary.projection.type, 'globe');
  assert.match(styles.primary.tiles[0], /server.arcgisonline\.com.*World_Imagery/);
  assert.match(styles.fallback.tiles[0], /tile\.openstreetmap\.org/);
});
test('vendor 注入顺序 core→obj→maplibre→deck', async () => {
  const { SFV, injected } = loadModule('public/video/world-globe.js', { captureScript: true });
  await SFV.worldGlobe.mount({ appendChild() {} }).catch(() => {});
  assert.deepEqual(injected().slice(0, 4), [
    'vendor/loaders/loaders.gl.core.min.js',
    'vendor/loaders/loaders.gl.obj.min.js',
    'vendor/maplibre/maplibre-gl.min.js',
    'vendor/deck.gl/deck.gl.min.js']);
});
```

- [ ] **Step 2: 运行确认失败** `node --test tests/world-globe.test.js`
- [ ] **Step 3: 实现 world-globe.js**（要点，全部 <i> 斜体为注释意图）：

```js
/* SFV.worldGlobe：MapLibre globe + deck.gl MapboxOverlay 底座。
   懒加载 vendor（对齐 world-cesium.js 模式）；底图 esri→osm→无。 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var VENDOR = [
    'vendor/loaders/loaders.gl.core.min.js',
    'vendor/loaders/loaders.gl.obj.min.js',
    'vendor/maplibre/maplibre-gl.min.js',
    'vendor/deck.gl/deck.gl.min.js'
  ];
  var VENDOR_CSS = 'vendor/maplibre/maplibre-gl.css';
  var STYLE_ESRI = {
    version: 8, projection: { type: 'globe' },
    sources: { imagery: { type: 'raster', tiles: [
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
    ], tileSize: 256 } },
    layers: [{ id: 'imagery', type: 'raster', source: 'imagery' }]
  };
  var STYLE_OSM = { version: 8, projection: { type: 'globe' },
    sources: { imagery: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256 } },
    layers: [{ id: 'imagery', type: 'raster', source: 'imagery' }] };
  var STYLE_BARE = { version: 8, projection: { type: 'globe' }, sources: {}, layers: [] };
  var map = null, overlay = null, seq = 0;

  function loadScript(src) { /* 与 world-cesium.js:60 同款 <script> 注入 + onload/onerror */ }
  function loadCss(href) { /* <link rel=stylesheet> 注入 */ }

  function mount(host) {
    var mySeq = ++seq;
    host.style.position = 'relative';
    return Promise.all([loadCss(VENDOR_CSS)].concat(VENDOR.map(loadScript)))
      .then(function () {
        if (mySeq !== seq) throw new Error('stale-mount');
        return tryStyles(host, [[STYLE_ESRI, 'esri'], [STYLE_OSM, 'osm'], [STYLE_BARE, 'none']], mySeq);
      });
  }
  function tryStyles(host, list, mySeq) {
    // 每档：new maplibregl.Map({ container: host, style, center:[104,35], zoom:2.5, pitch:0 })
    // map.on('error') 首次瓦片全失败即 reject 进入下一档；'idle' resolve
    // resolve 后：overlay = new deck.MapboxOverlay({ layers: [], pickable: true,
    //   glOptions: { preserveDrawingBuffer: true } }); map.addControl(overlay);
    // 返回 { map: map, overlay: overlay, viewer: adapter(map, overlay), basemap: name }
  }
  function adapter(map, overlay) {
    // 兼容旧 world-actions 的 Cesium viewer 消费面：至少提供
    // { __maplibre: map, __overlay: overlay, camera: { flyTo(o){ map.flyTo(o) } }, resize(){} }
    // Task 6 落地时按 world-actions.js 实际用到的 API 补全，不提前发明。
  }
  function unmount() {
    seq++;
    if (overlay) { overlay.finalize && overlay.finalize(); overlay = null; }
    if (map) { map.remove(); map = null; }
  }
  SFV.worldGlobe = { mount: mount, unmount: unmount, getMap: function () { return map; },
    __styles: { primary: STYLE_ESRI, fallback: STYLE_OSM, bare: STYLE_BARE } };
})(typeof window !== 'undefined' ? window : this);
```

- [ ] **Step 4: page-world.js 换底座调用**：`SFV.worldCesium` → `SFV.worldGlobe`（mount/unmount 两处 + 错误文案 `video/world-globe.js`）；`info.viewer` 消费点暂经 `info.viewer`（adapter）不动其它模块。
- [ ] **Step 5: 运行测试** `node --test tests/world-globe.test.js` → PASS
- [ ] **Step 6: 浏览器手工验证**（`npm start` 或 harness）：进入世界页见 globe 卫星球体、可拖拽/滚轮缩放、离开页无 WebGL 泄漏（重复进出 5 次）。
- [ ] **Step 7: Checkpoint 汇报（不 commit）**

---

### Task 3: 程序化灯塔模型模块

**Files:**
- Create: `public/video/world-lighthouse-model.js`
- Test: `tests/world-lighthouse-model.test.js`

**Interfaces:**
- Consumes: 无（纯数学，Node 可测）
- Produces: `SFV.worldLighthouseModel.build() -> { positions: Float32Array, normals: Float32Array, heights: Float32Array, indices: Uint16Array, modelHeight: number }`（单座塔，米级局部坐标，+Y 朝上，塔底在原点）

- [ ] **Step 1: 写失败测试**

```js
// tests/world-lighthouse-model.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { build } = require('../public/video/world-lighthouse-model.js').__node ||
  (global.window = global, require('../public/video/world-lighthouse-model.js'), global.StellaflixVideo.worldLighthouseModel);

test('几何闭合：索引数=12*段数，法线单位化，heights∈[0,modelHeight]', () => {
  const m = build({ segments: 12 });
  assert.ok(m.indices.length % 3 === 0);
  assert.equal(m.positions.length / 3, m.normals.length / 3);
  assert.equal(m.positions.length / 3, m.heights.length);
  let maxH = 0;
  for (let i = 0; i < m.heights.length; i++) maxH = Math.max(maxH, m.heights[i]);
  assert.ok(Math.abs(maxH - m.modelHeight) < 1e-3);
  for (let i = 0; i < m.normals.length; i += 3) {
    const len = Math.hypot(m.normals[i], m.normals[i + 1], m.normals[i + 2]);
    assert.ok(Math.abs(len - 1) < 1e-4, '法线须单位化');
  }
});
```

- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**：三段式塔（对齐 HearThere 模型剪影：底座锥台 r=0.83→0.72 h=0.22/0.29（main.pretty.js:11390 附近 OBJ 顶点实测值 v -0.832708 0.220000 → v -0.725354 0.293041）、塔身锥台收分、顶部灯室 + 出挑檐）。导出 UMD 风格同时支持 Node `module.exports`。`modelHeight` 取实际最大 Y。
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: Checkpoint 汇报**

---

### Task 4: world-lighthouse-deck.js（rim/渐变/扫描 shader 层 + 预热 + 分级）

**Files:**
- Create: `public/video/world-lighthouse-deck.js`
- Test: `tests/world-lighthouse-deck.test.js`

**Interfaces:**
- Consumes: Task 2 `SFV.worldGlobe`（overlay.setProps/getMap），Task 3 `SFV.worldLighthouseModel.build()`
- Produces: `SFV.worldLighthouseDeck = { mount(map, overlay, opts) -> Promise, unmount(), refreshStations(rooms), setSelected(id), applyTier(zoom), getState() }`；`opts.onBeaconClick(station, screenPos)`、`opts.onHover(bool)`

- [ ] **Step 1: 写失败测试（纯数据/配置断言，不触 WebGL）**

```js
// tests/world-lighthouse-deck.test.js（节选）
test('roomToStation 字段映射：lon/lat/status/双色', () => {
  const st = API.roomToStation({ id: 'r1', longitude: 116.4, latitude: 39.9,
    status: 'playing', color_top: [255, 120, 0], color_bottom: [0, 120, 255] });
  assert.deepEqual(st.position, [116.4, 39.9]);
  assert.equal(st.status, 'playing');
  assert.deepEqual(st.colorTop, [255, 120, 0]);
});
test('离线塔不激活：getColor alpha=0（对齐 main.pretty.js:11506）', () => {
  assert.deepEqual(API.getColor({ status: 'offline' }), [255, 255, 255, 0]);
  assert.deepEqual(API.getColor({ status: 'playing' }), [255, 255, 255, 255]);
});
test('尺寸分级：选中 290 / 未选中 150（:10691 调整值）', () => {
  assert.equal(API.sizeOf({ id: 'a' }, 'a'), 290);
  assert.equal(API.sizeOf({ id: 'b' }, 'a'), 150);
});
test('zoom 门限：12.5 以下灯塔层 visible=false（:10609）', () => {
  assert.equal(API.tierVisible(11.4), false);
  assert.equal(API.tierVisible(12.5), true);
});
test('预热站常量：(0,0) opacity 0.001（:13164-13177）', () => {
  assert.deepEqual(API.WARMUP.data[0].position, [0, 0]);
  assert.equal(API.WARMUP.opacity, 0.001);
});
```

- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现层类**：`class LighthouseRimLayer extends deck.SimpleMeshLayer`，`getShaders()` inject 逐段移植 main.pretty.js:11346-11440（GLSL 原文见下，保留中文注释可删）：

```glsl
// vs:#decl / vs:#main-start：透传 instanceColorTop/Bottom、instanceLayerOpacity、instanceEntranceProgress
// fs:#main-end（核心，与 hearthere 一致）：
float activationProgress = vColor.a;
vec3 viewDir = normalize(cameraPosition - position_commonspace.xyz);
float rim = pow(1.0 - max(0.0, dot(normalize(normals_commonspace), viewDir)), 6.0);
float ratio = clamp(vModelHeight / MODEL_HEIGHT, 0.0, 1.0);
vec3 activeColor = mix(colorBottom, colorTop, ratio);
float scanY = mix(-MODEL_HEIGHT * 0.33, MODEL_HEIGHT * 1.41, activationProgress); // -3→13 @9.22 等比
float activeness = 1.0 - smoothstep(scanY, scanY + 2.0, vModelHeight);
float isAnimating = smoothstep(0.0, 0.1, activationProgress) * smoothstep(1.0, 0.9, activationProgress);
float scanLine = exp(-abs(vModelHeight - (scanY + 1.0))) * isAnimating;
vec3 baseColor = mix(vec3(0.35, 0.4, 0.55), activeColor, activeness) + vec3(1.0) * scanLine * 0.8;
float brightness = mix(0.7, min(2.0, 1.0 / max(0.01, max(baseColor.r, max(baseColor.g, baseColor.b)))), activeness);
float finalAlpha = mix(0.8, rim * 1.5 + 0.6, activeness) * vLayerOpacity;
fragColor = vec4(baseColor * brightness, finalAlpha);
// 入场扫描：entranceScanY = mix(-0.33, 1.08, vEntranceProgress) * MODEL_HEIGHT;
// discard 高于 entranceScanY 的片段（main.pretty.js:11428-11433 语义）
```

- [ ] **Step 4: 实现 mount/refresh**：`load('…', OBJLoader)` 不用（模型为 Task 3 程序几何）→ `new deck.Mesh({ attributes: { positions: {value, size:3}, normals: {…}, indices: {value, size:3, type:'UINT16'} } })`；每帧层数组 = [warmup层, rim-batch(未选中), rim-selected(290), blink?]；`overlay.setProps({ layers })`；`transitions: { getColor: 1000, getColorTop: 1000, getColorBottom: 1000 }`（:11510-11512）；`getOrientation: [0, 0, 90]`（:11529）。
- [ ] **Step 5: 运行测试** PASS；`node --test tests/world-lighthouse-deck.test.js`
- [ ] **Step 6: 浏览器手工验证**：进世界页出现灯塔（先用 world-data 现有房间数据）；缩放跨 12.5 显隐正确；点选放大。
- [ ] **Step 7: Checkpoint 汇报**

---

### Task 5: 边界层 Cesium→MapLibre 移植

**Files:**
- Modify: `public/video/world-boundaries.js`（保持 `mount(viewer)/unmount()` 签名，`mount` 参数改收 maplibre map；内部 Cesium GeoJsonSource → `map.addSource/addLayer`）
- Test: `tests/world-boundaries.test.js`（扩展现有测试或新增）

**Interfaces:**
- Consumes: 本地 `world-countries.geojson` / `china-provinces.geojson` / `china-cities.geojson`（world-boundaries.js:32-46 现有资产，不动）
- Produces: 同签名 `SFV.worldBoundaries`

- [ ] **Step 1: 写失败测试**：`mount(fakeMap)` 后断言 `fakeMap.addSource` 被调 3 次、每档 `minzoom/maxzoom` 递增、layer type 为 `line`、`line-color` 为白色半透明（对齐截图观感）。

```js
test('三档边界以 line layer 注入且按缩放分层', () => {
  const calls = []; const map = fakeMap(calls);
  SFV.worldBoundaries.mount(map);
  const lines = calls.filter(c => c.op === 'addLayer');
  assert.equal(lines.length, 3);
  assert.ok(lines[0].args.minzoom < lines[1].args.minzoom);
  assert.ok(lines.every(c => c.args.type === 'line'));
});
```

- [ ] **Step 2: 确认失败** → **Step 3: 实现**（fetch→geojson 管线复用 :69-80，只换渲染端）→ **Step 4: 测试 PASS** → **Step 5: Checkpoint 汇报**

---

### Task 6: 交互层（悬停/点击/flyTo 电影感 + 快捷键回归）

**Files:**
- Modify: `public/video/world-actions.js`（Cesium camera 调用 → adapter 的 maplibre 实现；`flyTo` 用固定参数）
- Modify: `public/video/page-world.js`（onBeaconClick 流程：先 flyTo，`moveend` 后 showCard）
- Test: `tests/world-actions-interaction.test.js`

**Interfaces:**
- Consumes: Task 4 `onBeaconClick`/`onHover`，Task 2 adapter
- Produces: `SFV.worldActions.flyTo(station)` → `map.flyTo({ center: st.position, zoom: 16, pitch: 60, duration: 2800 })`（main.pretty.js:19062-19064、:19636）；悬停 `canvas.style.cursor = 'pointer'`（:17882）

- [ ] **Step 1: 写失败测试**

```js
test('flyTo 参数对齐 hearthere：zoom16/pitch60/2800ms', () => {
  const opts = SFV.worldActions.__flyOptions({ position: [116.4, 39.9] });
  assert.deepEqual(opts, { center: [116.4, 39.9], zoom: 16, pitch: 60, duration: 2800 });
});
test('卡片在 moveend 后打开而非 flyTo 前（防飞途中挡屏）', async () => {
  const order = [];
  await runClickFlow({ onFlyStart: () => order.push('fly'), onMoveEnd: () => order.push('end'), onCard: () => order.push('card') });
  assert.deepEqual(order, ['fly', 'end', 'card']);
});
```

- [ ] **Step 2: 确认失败** → **Step 3: 实现**（deck overlay `onClick: info => info.object && pick 到 station`；`onHover` 设 cursor；page-world 现有 Esc/R/F/A hintHandler 不动）→ **Step 4: PASS** → **Step 5: 浏览器全流程手测** → **Step 6: Checkpoint 汇报**

---

### Task 7: 实时进度同步（queue_update 语义 + 本地推算播放位置）

**Files:**
- Modify: `world-room-api.js` / `server.js`（新增房间 broadcast：事件 `queue_update`，载荷 `{ type, queue, current_position, start_time, host_sent_at }`；房主心跳 `POST /api/world/rooms/:id/heartbeat`）
- Modify: `public/video/world-sync.js`（SSE/WS 订阅 + 兜底轮询保留 20s）
- Test: `tests/world-sync-progress.test.js`

**Interfaces:**
- Consumes: 现有 `SFV.worldData.fetchRooms`
- Produces: `SFV.worldSync.currentTrack(room, nowMs) -> { index, title, elapsedMs }`，公式 `elapsed = nowMs - start_time + Σ_{k<current_position} duration_ms[k]`（main.pretty.js:14490-14510 语义）；status 推断：`type ∈ {playlist_replaced, playlist_completed, broadcast_ended} || (queue_reorder && current_position==null) → 'idle'` 否则 `'playing'`（:14506）

- [ ] **Step 1: 写失败测试**

```js
test('进度本地推算：start_time + 前置曲目时长和', () => {
  const room = { queue: [{ duration_ms: 60000 }, { duration_ms: 90000 }],
    current_position: 1, start_time: 1000 };
  const cur = currentTrack(room, 1000 + 60000 + 5000);
  assert.equal(cur.index, 1); assert.equal(cur.elapsedMs, 5000);
});
test('broadcast_ended → idle；queue_update 默认 playing', () => {
  assert.equal(inferStatus({ type: 'broadcast_ended' }), 'idle');
  assert.equal(inferStatus({ type: 'queue_update', current_position: 0 }), 'playing');
});
```

- [ ] **Step 2: 确认失败** → **Step 3: 实现服务端广播与客户端订阅（复用 server.js 现有 SSE/WS 基建，不引新依赖）** → **Step 4: PASS** → **Step 5: 双窗口手测**：A 建房播放，B 世界页灯塔 1s 内变色/卡片进度一致 → **Step 6: Checkpoint 汇报**

---

### Task 8: 社交层（看完整片点火烟花 + 全站 broadcast + 点赞气泡）

**Files:**
- Modify: `public/video/world-ui.js`（烟花触发入口已有 canvas :468-472；新增「点火！」按钮与库存计数 UI）
- Modify: `world-room-api.js` / `server.js`（`fireworks`、`like-popups` 两个全站 broadcast 频道；奖励规则改为**观看进度奖励**：每完整看完 1 部得 1 发，替换 hearthere 的收听奖励 :238-240 语义）
- Test: `tests/world-social.test.js`

**Interfaces:**
- Consumes: Task 7 进度事件（到达片尾 → 记一次 complete）
- Produces: `SFV.worldSocial.light(stationId) -> boolean`（扣库存+广播）；`onFirework(payload)` 订阅回调 → world-ui 现有 canvas 粒子（粒子参数对齐复现版：60-100 粒/发、重力、`globalCompositeOperation:'lighter'`，hearthere-3d-earth/js/fireworks.js）

- [ ] **Step 1: 写失败测试**（库存增减、无库存点火返回 false、complete 事件 +1）
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: PASS** → **Step 5: 双窗口手测**：A 点火 B 见烟花 → **Step 6: Checkpoint 汇报**

---

### Task 9: 文案改版 + 旧链路归档 + 全量回归

**Files:**
- Modify: `public/video/page-world.js`（头注释更新；标题「世界 · 卫星」逻辑保留）
- Modify: `public/video/world-ui.js`（口号「看看世界都在看什么」；统计文案「N 个放映厅 · N 正在放映」；卡片「开始观看」）
- Modify: `public/index.html`（移除 `video/world-cesium.js` 与已停用 `video/lighthouse/*` 渲染项；`world-cesium.js` 与 `lighthouse/globe.js` 等**移入 `public/video/_archive/` 目录而非删除**——用户规则：未经确认不删文件）
- Delete: 无
- Test: 全量 `npm test`

- [ ] **Step 1: 文案与标题替换（逐条 grep 验证旧文案清零）**

```bash
grep -rn "功能开发中\|敬请期待\|正在播放信标\|声音信标" public/video/page-world.js public/video/world-ui.js && echo "还有残留" || echo OK
```

- [ ] **Step 2: 归档旧文件**：`git mv public/video/world-cesium.js public/video/_archive/`（若 world-cesium 未被 git 跟踪则用 `mv`，并在汇报中说明）
- [ ] **Step 3: 全量回归** `npm test` → 全部 PASS；`tests/world-cesium-m0.test.js` 若断言 Cesium 行为，改写为 world-globe 等价断言（**先向用户报告断言反转再改**，对齐 A1 协议）
- [ ] **Step 4: 浏览器终验**：进出世界页 10 次无泄漏、灯塔/flyTo/同步/烟花全链路、音乐态↔影视态切换壁纸水合不回归
- [ ] **Step 5: 最终汇报 + 建议提交点**（等用户「提交」指令）

---

## Self-Review 记录

1. **Spec 覆盖**：底座(T2)、模型(T3)、灯塔 shader(T4)、边界(T5)、交互(T6)、实时(T7)、社交(T8)、文案/归档/回归(T9) —— 对应用户「灯塔模型+交互+看看世界都在看什么+大翻版」四个诉求全覆盖；vendor 获取(T1)为前置。
2. **占位符扫描**：无 TBD；Task 2 的 `tryStyles`/`loadScript` 为要点级伪码，执行时按注释展开——已给出行为契约与测试断言兜底。
3. **类型一致性**：`SFV.worldGlobe.mount -> {map, overlay, viewer, basemap}`（T2 产出 = T4/T5/T6 消费）；`roomToStation` 字段 `position/colorTop/colorBottom/status`（T4 = T6/T7）；`currentTrack`（T7 = T8 complete 判定）。已逐一核对命名。
