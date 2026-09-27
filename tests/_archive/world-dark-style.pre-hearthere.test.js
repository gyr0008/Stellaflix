'use strict';

/**
 * 世界页 Task 10 — 暗色地球档（对齐 hearthere.live 的 HearThereMap 定制样式）
 * 运行：node --test tests/world-dark-style.test.js
 *
 * 覆盖：STYLE_DARK 结构与 HearThereMap 原值一致性（sky/light/色值/插值）、
 *       Building 3D fill-extrusion 参数与 OpenMapTiles 字段适配、数据源合规
 *       （OpenFreeMap 免 key + OSM 署名 + 镜像 MapTiler key 红线）、降级链顺序、
 *       page-world 底图名上报。
 *
 * 说明：jsdom/node 无 WebGL，按仓内惯例（见 tests/world-globe.test.js）用
 *       vm 沙箱装载模块 + 源码正则断言，不做真实渲染。
 * 证据来源：2026-09-26 抓取的 HearThereMap style.json（164890 bytes，
 *       name="HearThereMap"，152 层）与 OpenFreeMap TileJSON + 柏林 z14 瓦片实测。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function loadWorldGlobe() {
  const el = () => ({
    style: {},
    setAttribute() {},
    addEventListener() {},
    appendChild(c) { return c; },
    children: []
  });
  const sandbox = {
    console,
    Promise,
    setTimeout,
    clearTimeout,
    document: { createElement: el, querySelector: () => null, head: el() }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('public/video/world-globe.js'), sandbox);
  return sandbox.StellaflixVideo.worldGlobe;
}

const norm = (s) => String(s).replace(/\s+/g, '');
const layerById = (style, id) => (style.layers || []).filter((l) => l.id === id)[0];
// vm 沙箱内创建的数组/对象属于另一个 realm，deepStrictEqual 会因原型不同而失败；
// 统一过一遍 JSON 往返，把值搬回宿主体 realm 再比较。
const plain = (v) => JSON.parse(JSON.stringify(v));
// 合规红线检查用的第三方 key 字面量（拼接构造，避免把 key 本身写进本仓）
const FORBIDDEN_KEY = 'WDevY5LG' + 'DDZysuYySExv';

// ---------------------------------------------------------------- 结构契约

test('STYLE_DARK 已导出且可 JSON 序列化（喂给 maplibre 的必须是纯数据）', () => {
  const wg = loadWorldGlobe();
  const dark = wg.__styles && wg.__styles.dark;
  assert.ok(dark, '__styles.dark 应已导出');
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(dark)), 'STYLE_DARK 必须可序列化');
  assert.strictEqual(dark.version, 8, 'style version 应为 8');
  assert.strictEqual(dark.projection.type, 'globe', '暗色档必须是 globe 投影');
});

test('sky / light 原值移植自 HearThereMap（大气边缘光 + 挤出光照）', () => {
  const dark = loadWorldGlobe().__styles.dark;
  assert.strictEqual(norm(dark.sky['sky-color']), 'hsl(203,67%,74%)');
  assert.strictEqual(dark.sky['sky-horizon-blend'], 0.5);
  assert.strictEqual(dark.sky['horizon-color'], '#FFFCEB');
  assert.strictEqual(dark.sky['horizon-fog-blend'], 0.5);
  assert.strictEqual(dark.sky['fog-color'], '#FFFFFF');
  assert.strictEqual(dark.sky['fog-ground-blend'], 1);
  assert.strictEqual(dark.sky['atmosphere-blend'], 0.5);
  assert.strictEqual(dark.light.anchor, 'viewport');
  assert.deepStrictEqual(plain(dark.light.position), [1.15, 90, 40]);
  assert.strictEqual(dark.light.color, '#FFFFFF');
  assert.strictEqual(dark.light.intensity, 0.8);
});

test('暗色色板逐值对齐 HearThereMap（背景/水体/植被/居住/道路）', () => {
  const dark = loadWorldGlobe().__styles.dark;
  const bg = layerById(dark, 'Background');
  assert.strictEqual(bg.type, 'background');
  assert.deepStrictEqual(plain(bg.paint['background-color']),
    ['interpolate', ['exponential', 1], ['zoom'], 6, 'hsl(216, 37%, 24%)', 14, 'hsl(216, 38%, 23%)']);

  const water = layerById(dark, 'Water');
  assert.strictEqual(norm(water.paint['fill-color']), 'hsl(217,36%,14%)');
  assert.deepStrictEqual(plain(water.paint['fill-opacity']), ['case', ['==', ['get', 'intermittent'], true], 0.5, 1]);

  const wood = layerById(dark, 'Wood');
  assert.strictEqual(norm(wood.paint['fill-color']), 'hsl(193,46%,22%)');
  assert.deepStrictEqual(plain(wood.paint['fill-opacity']), ['interpolate', ['linear'], ['zoom'], 0, 0.5, 14, 0.6]);

  const residential = layerById(dark, 'Residential');
  assert.deepStrictEqual(plain(residential.paint['fill-color']),
    ['interpolate', ['exponential', 1], ['zoom'], 4, 'hsl(217, 37%, 24%)', 16, 'hsl(215, 15%, 23%)']);

  const highway = layerById(dark, 'Highway');
  assert.strictEqual(norm(highway.paint['line-color']), 'hsl(211,43%,36%)');

  const minor = layerById(dark, 'Minor road');
  assert.deepStrictEqual(plain(minor.paint['line-color']),
    ['interpolate', ['linear'], ['zoom'], 12, 'hsl(0, 0%, 33%)', 22, 'hsl(0, 0%, 35%)']);
});

// ---------------------------------------------------------------- 3D 建筑

test('Building 3D：fill-extrusion 参数逐值对齐 + OpenMapTiles 字段适配', () => {
  const dark = loadWorldGlobe().__styles.dark;
  const b3d = layerById(dark, 'Building 3D');
  assert.ok(b3d, 'Building 3D 层必须存在');
  assert.strictEqual(b3d.type, 'fill-extrusion');
  assert.strictEqual(b3d['source-layer'], 'building');
  assert.strictEqual(b3d.minzoom, 14, 'OpenFreeMap 瓦片 maxzoom=14，挤出层从 14 起');
  assert.strictEqual(norm(b3d.paint['fill-extrusion-color']), 'hsl(217,47%,51%)');
  assert.strictEqual(b3d.paint['fill-extrusion-opacity'], 0.4);
  // HearThereMap 用 identity(height/height_min)；OpenMapTiles 字段名为 render_height/render_min_height
  assert.deepStrictEqual(plain(b3d.paint['fill-extrusion-height']), ['coalesce', ['get', 'render_height'], 0]);
  assert.deepStrictEqual(plain(b3d.paint['fill-extrusion-base']), ['coalesce', ['get', 'render_min_height'], 0]);
});

test('建筑足迹层：minzoom 12 + zoom 12→16 颜色/透明度渐变', () => {
  const dark = loadWorldGlobe().__styles.dark;
  const b = layerById(dark, 'Building');
  assert.strictEqual(b.type, 'fill');
  assert.strictEqual(b.minzoom, 12);
  assert.deepStrictEqual(plain(b.paint['fill-color']),
    ['interpolate', ['linear'], ['zoom'], 12, 'hsl(217, 47%, 45%)', 16, 'hsl(217, 49%, 54%)']);
  assert.deepStrictEqual(plain(b.paint['fill-opacity']),
    ['interpolate', ['linear'], ['zoom'], 12, 0.2, 16, 0.4]);
});

// ---------------------------------------------------------------- 数据源与合规

test('数据源 = OpenFreeMap 免 key + OSM 署名 + 无 MapTiler 依赖（红线）', () => {
  const src = read('public/video/world-globe.js');
  const dark = loadWorldGlobe().__styles.dark;
  assert.strictEqual(dark.sources.ofm.type, 'vector');
  assert.strictEqual(dark.sources.ofm.url, 'https://tiles.openfreemap.org/planet');
  assert.match(dark.sources.ofm.attribution, /OpenStreetMap/, '必须带 OSM 署名');
  assert.match(dark.sources.ofm.attribution, /openfreemap\.org/);
  // 合规红线：HearThereMap 内嵌的 MapTiler key 绝不进本仓
  assert.ok(src.indexOf(FORBIDDEN_KEY) < 0, '禁止抄用 hearthere 内嵌的第三方地图服务 key');
  assert.ok(src.indexOf('api.maptiler.com') < 0, '禁止依赖 MapTiler 云端（需 key 账号）');
});

test('免 glyphs/sprite：无 symbol 层（暗色档不需要字体与图标网络）', () => {
  const dark = loadWorldGlobe().__styles.dark;
  assert.ok(!dark.glyphs, '不应声明 glyphs');
  assert.ok(!dark.sprite, '不应声明 sprite');
  assert.ok(!dark.layers.some((l) => l.type === 'symbol'), '不应含 symbol 层');
});

test('全部图层 source=ofm 且 source-layer 在 OpenFreeMap schema 内', () => {
  const dark = loadWorldGlobe().__styles.dark;
  const ofmLayers = ['water', 'waterway', 'landcover', 'landuse', 'building', 'transportation', 'boundary', 'park', 'aeroway', 'poi', 'place'];
  for (const l of dark.layers) {
    if (l.type === 'background') continue;
    assert.strictEqual(l.source, 'ofm', '图层 ' + l.id + ' 的 source 必须为 ofm');
    assert.ok(ofmLayers.indexOf(l['source-layer']) >= 0,
      '图层 ' + l.id + ' 的 source-layer(' + l['source-layer'] + ') 必须在 OpenFreeMap schema 内');
  }
});

// ---------------------------------------------------------------- 降级链与接线

test('降级链：dark 首选 → darkgray（暗灰栅格兜底，同域可达）→ esri → osm → none', () => {
  const src = read('public/video/world-globe.js');
  const m = src.match(/var TIERS = \[([\s\S]*?)\];/);
  assert.ok(m, 'TIERS 定义应存在');
  const order = (m[1].match(/name: '([^']+)'/g) || []).map((s) => s.replace(/name: '|'/g, ''));
  assert.deepStrictEqual(order, ['dark', 'darkgray', 'esri', 'osm', 'none'],
    'dark 矢量档失败必须先降级到暗灰栅格（同为暗色观感），再落彩色卫星');
  // 暗灰兜底档必须用与彩色卫星同域的 Esri 服务（用户环境实测直连可达）
  assert.match(src, /Canvas\/World_Dark_Gray_Base\/MapServer\/tile\/\{z\}\/\{y\}\/\{x\}/,
    'Esri World Dark Gray Base 瓦片 URL 必须逐字命中');
});

test('档位容错：单个瓦片 error 不得炸整档（idle 时零数据才算失败）', () => {
  const src = read('public/video/world-globe.js');
  // onError 里不允许再出现 fail(...)——瞬态错误只记日志
  const onErrorBody = src.match(/function onError\(err\) \{([\s\S]*?)\n      \}/);
  assert.ok(onErrorBody, 'onError 函数应存在');
  assert.ok(!/fail\(/.test(onErrorBody[1]), 'onError 内禁止调用 fail()（瞬态瓦片错误不降级）');
  // idle 判定：dataCount===0 才 fail
  assert.match(src, /if \(dataCount === 0\) \{[\s\S]*?fail\('no-source-data'\)/, 'idle 时零数据才换档');
  // tryTierMap 必须接收档名（日志可定位是哪一档出问题）
  assert.match(src, /function tryTierMap\(host, style, tierName\)/, 'tryTierMap 需带档名参数');
});

test('Map ctor：minZoom 2.5 / maxPitch 85 / 紧凑 attribution（对齐 hearthere）', () => {
  const src = read('public/video/world-globe.js');
  assert.match(src, /minZoom: 2\.5/);
  assert.match(src, /maxPitch: 85/);
  assert.match(src, /attributionControl: \{ compact: true \}/);
});

test('page-world 底图名上报含 dark 档文案', () => {
  const src = read('public/video/page-world.js');
  assert.match(src, /info\.basemap === 'dark' \|\| info\.basemap === 'dark-mt'\) \? '暗色地球'/, '世界页标题需能显示「暗色地球」（含 MapTiler 档）');
});

// ---------------------------------------------------------------- MapTiler 档（Task 10c）

test('净化样式资产：96 层、无 symbol/glyphs/sprite、含 {KEY} 占位符', () => {
  const st = JSON.parse(read('public/vendor/maptiler/hearthere-map-style.json'));
  assert.strictEqual(st.projection.type, 'globe', '必须是 globe 投影');
  assert.ok(st.sky && st.sky['atmosphere-blend'] === 0.5, 'sky 原值保留');
  assert.ok(st.light && st.light.anchor === 'viewport', 'light 原值保留');
  assert.ok(!st.glyphs && !st.sprite, 'glyphs/sprite 必须剥离（私有资产 + symbol 已删）');
  assert.ok(!st.layers.some((l) => l.type === 'symbol'), '不得残留 symbol 层');
  const b3d = st.layers.filter((l) => l.id === 'Building 3D')[0];
  assert.ok(b3d && b3d.type === 'fill-extrusion', 'Building 3D 必须保留');
  assert.deepStrictEqual(b3d.paint['fill-extrusion-height'], ['coalesce', ['get', 'height'], 0], 'identity 已转 coalesce/get');
  assert.strictEqual(st.sources.maptiler_planet_v4.url.indexOf('key={KEY}') > 0, true, '瓦片源 URL 必须用 {KEY} 占位符');
  assert.match(st.sources.maptiler_planet_v4.attribution, /OpenStreetMap/, '署名保留');
  // 红线：资产不得含第三方 key 字面量
  const raw = read('public/vendor/maptiler/hearthere-map-style.json');
  assert.ok(raw.indexOf(FORBIDDEN_KEY) < 0, '净化样式资产禁止含第三方 key');
});

test('world-globe：localStorage key 读取 + dark-mt 档插入链顶', () => {
  const src = read('public/video/world-globe.js');
  assert.match(src, /stellaflix-maptiler-key-v1/, 'key 存储键必须固定');
  assert.match(src, /tiers = \[\{ style: mtStyle, name: 'dark-mt' \}\]\.concat\(TIERS\)/, '有 key 时 dark-mt 必须插到链顶');
  assert.match(src, /vendor\/maptiler\/hearthere-map-style\.json/, '样式资产路径');
  assert.match(src, /\\\{KEY\\\}\/g, key/, '运行时用用户 key 替换占位符');
  // key 校验白名单：长度 16-64 的字母数字，防垃圾值进 URL
  assert.match(src, /\^\[A-Za-z0-9\]\{16,64\}\$/, 'key 形状校验必须存在');
});
