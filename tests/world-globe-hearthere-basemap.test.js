'use strict';

/**
 * 世界页 步骤② — world-globe.js 底图按 hearthere.live cd() 逐字重建
 * 运行：node --test tests/world-globe-hearthere-basemap.test.js
 *
 * 对照源（_scratch/hearthere/main.pretty.js）：
 *   hn 常量表 :115-125 / Gu webgl2 探测 :127-135 / 相机衰减族 sd,Tr,rd,ad,id :843-879
 *   ja,Da setPitch/setBearing :881-890 / apiKey :891 / Fa 藏 symbol :893-898
 *   ld 藏 compact attribution :900-903 / cd() 底座 :905-1010
 *   deck overlay 实例化（Bu {interleaved,layers,_pickable}）:13539-13543
 *
 * 手法：仓内惯例（见 tests/world-globe.test.js）——vm 沙箱 + 假 SDK Map/deck，
 * 手动派发 load/styledata/zoom 事件，真实跑 world-globe.js 时序逻辑。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const USER_KEY = 'nMcdjIXAW4OMJZZnckds';
const STYLE_PATH = 'vendor/maptiler/hearthere-map-style.json';

// ---------------------------------------------------------------------------
// 沙箱装配
// ---------------------------------------------------------------------------

function makeEl(tag) {
  const el = {
    tagName: tag,
    style: {},
    className: '',
    children: [],
    innerHTML: '',
    listeners: [],
    setAttribute() {},
    removeAttribute() {},
    appendChild(c) { el.children.push(c); return c; },
    removeChild(c) {
      const i = el.children.indexOf(c);
      if (i >= 0) el.children.splice(i, 1);
      return c;
    },
    querySelector(sel) { return el._querySelector ? el._querySelector(sel) : null; },
    addEventListener(type, fn, opts) { el.listeners.push({ type, fn, opts }); }
  };
  return el;
}

function makeStyleDoc() {
  return JSON.stringify({
    version: 8,
    projection: { type: 'globe' },
    sources: { planet: { url: 'https://api.maptiler.com/tiles/v4/tiles.json?key={KEY}' } },
    layers: [{ id: 'Background', type: 'background' }]
  });
}

function loadSandbox(opts) {
  opts = opts || {};
  const createdMaps = [];
  const createdOverlays = [];
  const fetchCalls = [];

  function FakeMap(options) {
    const self = this;
    this.options = options;
    this.handlers = {};
    this.removed = 0;
    this.controls = [];
    this.layoutCalls = [];
    this.pitchCalls = [];
    this.bearingCalls = [];
    this.repaints = 0;
    this.state = { zoom: 2.5, pitch: 0, bearing: 0 };
    this.canvasEl = makeEl('canvas');
    this.dragRotateEnabled = 0;
    this.dragRotate = { enable() { self.dragRotateEnabled++; } };
    this.transform = {
      setPitch(v) { self.pitchCalls.push(v); self.state.pitch = v; },
      setBearing(v) { self.bearingCalls.push(v); self.state.bearing = v; }
    };
    this.on = function (ev, fn) { (self.handlers[ev] = self.handlers[ev] || []).push(fn); };
    this.off = function (ev, fn) {
      self.handlers[ev] = (self.handlers[ev] || []).filter((f) => f !== fn);
    };
    this.addControl = function (c) { self.controls.push(c); };
    this.remove = function () { self.removed++; };
    this.triggerRepaint = function () { self.repaints++; };
    this.getZoom = () => self.state.zoom;
    this.getPitch = () => self.state.pitch;
    this.getBearing = () => self.state.bearing;
    this.getCanvas = () => self.canvasEl;
    this.getMaxPitch = () => 85;
    this.setLayoutProperty = function (id, prop, v) { self.layoutCalls.push([id, prop, v]); };
    this.getLayoutProperty = function (id, prop) {
      if (prop !== 'visibility') return undefined;
      return self.hiddenIds && self.hiddenIds.includes(id) ? 'none' : 'visible';
    };
    this.getStyle = function () {
      return {
        layers: [
          { id: 'country-label', type: 'symbol' },
          { id: 'water', type: 'fill' },
          { id: 'road-label', type: 'symbol' }
        ]
      };
    };
    this.flyTo = function () { return self; };
    this.resize = function () {};
    this.setPitch = function (v) { self.pitchCalls.push(v); };
    this.setBearing = function (v) { self.bearingCalls.push(v); };
    this.emit = function (ev) {
      (self.handlers[ev] || []).slice().forEach((fn) => fn({ type: ev }));
    };
    createdMaps.push(this);
  }

  function FakeOverlay(options) {
    this.options = options;
    this.finalized = 0;
    this.finalize = () => { this.finalized++; };
    createdOverlays.push(this);
  }

  const cfgDoc = makeEl('head');
  let scriptInjects = [];
  cfgDoc.appendChild = function (c) {
    if (c.tagName === 'script') scriptInjects.push(c.src);
    return cfgDoc.children.push(c);
  };

  const fetchStub = function (url) {
    fetchCalls.push(url);
    if (opts.fetchFails) {
      return Promise.resolve({ ok: false, status: 500 });
    }
    return Promise.resolve({ ok: true, text: () => Promise.resolve(makeStyleDoc()) });
  };

  const maptilerGlobe = {
    ready: Promise.resolve({}),
    Map: FakeMap,
    config: {}
  };

  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    Promise,
    setTimeout,
    clearTimeout,
    setImmediate,
    fetch: fetchStub,
    document: {
      createElement: (tag) => {
        const el = makeEl(tag);
        if (tag === 'canvas') {
          el.getContext = (kind) => (opts.noWebgl2 ? null : kind === 'webgl2' ? {} : null);
        }
        return el;
      },
      querySelector: () => null,
      head: cfgDoc
    },
    // 常驻 vendor 桩：deck + loaders 全局已就位，ensureVendor 走缓存不注 script
    deck: { MapboxOverlay: FakeOverlay },
    loaders: { OBJLoader: function () {} },
    StellaflixVideo: {}
  };
  sandbox.window = sandbox;
  sandbox.StellaflixVideo.maptilerGlobe = maptilerGlobe;
  vm.createContext(sandbox);
  vm.runInContext(read('public/video/world-globe.js'), sandbox);
  const flush = async () => {
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
  };
  return {
    wg: sandbox.StellaflixVideo.worldGlobe,
    createdMaps, createdOverlays, fetchCalls, scriptInjects,
    maptilerGlobe, sandbox, flush, makeEl
  };
}

// ---------------------------------------------------------------------------
// 1. Map 构造参数逐字对齐 cd()（main.pretty.js:929-957）
// ---------------------------------------------------------------------------

test('mount 走 @maptiler/sdk：Map options 逐字等于 hearthere cd()（center[0,0]/zoom2.5/minZoom2.5/logoPosition/pitch0/bearing0/maxPitch85/globe/space/halo/controls/attribution）', async () => {
  const env = loadSandbox();
  const host = makeEl('div');
  const p = env.wg.mount(host);
  await env.flush();
  assert.strictEqual(env.createdMaps.length, 1, '应经 SFV.maptilerGlobe.Map 建图（不再用全局 maplibregl）');
  const o = JSON.parse(JSON.stringify(env.createdMaps[0].options));
  assert.deepStrictEqual(o.center, [0, 0]);
  assert.strictEqual(o.zoom, 2.5);
  assert.strictEqual(o.minZoom, 2.5);
  assert.strictEqual(o.logoPosition, 'bottom-right');
  assert.strictEqual(o.pitch, 0);
  assert.strictEqual(o.bearing, 0);
  assert.strictEqual(o.maxPitch, 85);
  assert.strictEqual(o.projection, 'globe');
  assert.deepStrictEqual(o.space, { preset: 'stars', color: '#ffffff' });
  assert.deepStrictEqual(o.halo, {
    scale: 1.2,
    stops: [
      [0, 'rgba(255,255,255,0.35)'],
      [0.4, 'rgba(255,255,255,0.18)'],
      [0.8, 'rgba(255,255,255,0.0)']
    ]
  });
  assert.strictEqual(o.navigationControl, 'bottom-right');
  assert.strictEqual(o.geolocateControl, 'bottom-right');
  assert.deepStrictEqual(o.attributionControl, { compact: true });
  env.createdMaps[0].emit('load');
  await p;
  env.wg.unmount();
});

// ---------------------------------------------------------------------------
// 2. apiKey + 本地样式 {KEY} 替换（cd() 用私有样式 UUID 的等价落法）
// ---------------------------------------------------------------------------

test('config.apiKey 硬编用户 key（对齐 hn.API_KEY :891）；样式 fetch 本地 hearthere-map-style.json 且 {KEY} 全部替换', async () => {
  const env = loadSandbox();
  const host = makeEl('div');
  const p = env.wg.mount(host);
  await env.flush();
  assert.strictEqual(env.maptilerGlobe.config.apiKey, USER_KEY,
    'SDK config.apiKey 应等于用户 MapTiler key');
  assert.ok(env.fetchCalls.includes(STYLE_PATH), '应 fetch ' + STYLE_PATH);
  const o = env.createdMaps[0].options;
  assert.strictEqual(typeof o.style, 'object', 'style 应为已解析对象（本地缓存样式，非私有 UUID）');
  const json = JSON.stringify(o.style);
  assert.ok(!json.includes('{KEY}'), '样式里不得残留 {KEY}');
  assert.ok(json.includes('api.maptiler.com/tiles/v4/tiles.json?key=' + USER_KEY),
    '瓦片源 URL 应注入用户 key');
  env.createdMaps[0].emit('load');
  await p;
  env.wg.unmount();
});

// ---------------------------------------------------------------------------
// 3. load：Fa 藏 symbol + ld 藏 compact + deck overlay + dragRotate
// ---------------------------------------------------------------------------

test('load 后：symbol 层 visibility none（Fa :893-898）、dragRotate.enable、resolve 契约 {map,overlay,viewer,basemap:maptiler}', async () => {
  const env = loadSandbox();
  const host = makeEl('div');
  const p = env.wg.mount(host);
  await env.flush();
  const m = env.createdMaps[0];
  assert.strictEqual(m.dragRotateEnabled, 1, 'cd() :962 dragRotate.enable()');
  m.emit('load');
  const info = await p;
  assert.ok(info && info.map === m, 'load 应 resolve（hearthere 无 idle/dataCount 判定）');
  assert.strictEqual(info.basemap, 'maptiler');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(m.layoutCalls)), [
    ['country-label', 'visibility', 'none'],
    ['road-label', 'visibility', 'none']
  ], '只藏 symbol 层，fill 层不动');
  assert.strictEqual(info.overlay.options.interleaved, true);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(info.overlay.options.layers)), []);
  assert.strictEqual(info.overlay.options._pickable, false,
    'hearthere Bu 实例化 :13539-13543 {interleaved,layers,_pickable}');
  assert.ok(m.controls.includes(info.overlay), 'overlay 应 addControl 到 map');
  assert.strictEqual(typeof info.viewer.camera.flyTo, 'function');
  env.wg.unmount();
});

test('styledata 也重跑 Fa+ld；ld 移除 maplibregl-compact-show 并 open 属性（:900-903）', async () => {
  const env = loadSandbox();
  const host = makeEl('div');
  const attribEl = { classes: ['maplibregl-ctrl-attrib', 'maplibregl-compact', 'maplibregl-compact-show'], removed: [], openRemoved: 0 };
  attribEl.classList = { remove(c) { attribEl.removed.push(c); } };
  attribEl.removeAttribute = () => { attribEl.openRemoved++; };
  host._querySelector = (sel) => (
    sel === '.maplibregl-ctrl-attrib.maplibregl-compact.maplibregl-compact-show' ? attribEl : null
  );
  const p = env.wg.mount(host);
  await env.flush();
  const m = env.createdMaps[0];
  // 传给 ld 的容器必须是 map 的 container（即 inner host）
  assert.strictEqual(m.options.container, host.children[0], 'container 应为 inner host');
  m.options.container._querySelector = host._querySelector;
  m.layoutCalls.length = 0;
  m.emit('styledata');
  assert.deepStrictEqual(m.layoutCalls.map((c) => c[0]), ['country-label', 'road-label'],
    'styledata 重跑 Fa');
  assert.ok(attribEl.removed.includes('maplibregl-compact-show'), 'ld 应移除 compact-show');
  assert.strictEqual(attribEl.openRemoved, 1, 'ld 应 removeAttribute(open)');
  m.emit('load');
  await p;
  env.wg.unmount();
});

// ---------------------------------------------------------------------------
// 4. zoom 缩小自动衰减 pitch/bearing（cd() :967-985 + sd/rd :843-862）
// ---------------------------------------------------------------------------

test('zoom 事件：缩小时 pitch 60 @2.5→2.4 变 59.1、bearing 30 变 29.55，优先 transform.setPitch/setBearing + triggerRepaint（ja/Da :881-890）', async () => {
  const env = loadSandbox();
  const host = makeEl('div');
  const p = env.wg.mount(host);
  await env.flush();
  const m = env.createdMaps[0];
  m.emit('load');
  await p;
  m.state.zoom = 2.4;
  m.state.pitch = 60;
  m.state.bearing = 30;
  m.emit('zoom');
  assert.strictEqual(m.pitchCalls.length, 1);
  assert.ok(Math.abs(m.pitchCalls[0] - 59.1) < 1e-9, 'sd: 60*(1-0.15*(2.5-2.4))≈59.1，实得 ' + m.pitchCalls[0]);
  assert.strictEqual(m.bearingCalls.length, 1);
  assert.ok(Math.abs(m.bearingCalls[0] - 29.55) < 1e-9, 'rd: 30*0.985≈29.55，实得 ' + m.bearingCalls[0]);
  assert.ok(m.repaints >= 2, 'transform 路径需 triggerRepaint');
  // 放大不衰减
  m.pitchCalls.length = 0;
  m.state.zoom = 5;
  m.state.pitch = 60;
  m.emit('zoom');
  assert.deepStrictEqual(m.pitchCalls, [], 'zoom 增大不得动 pitch');
  env.wg.unmount();
});

// ---------------------------------------------------------------------------
// 5. 触底滚轮衰减（cd() :990-1005 + ad/id :864-879）
// ---------------------------------------------------------------------------

test('canvas wheel（passive:false）：zoom<=2.5 且 pitch>0 且 deltaY>0 → preventDefault + ad 衰减（pitch 40,deltaY 50 → 37）', async () => {
  const env = loadSandbox();
  const host = makeEl('div');
  const p = env.wg.mount(host);
  await env.flush();
  const m = env.createdMaps[0];
  m.emit('load');
  await p;
  const wheel = m.getCanvas().listeners.find((l) => l.type === 'wheel');
  assert.ok(wheel, '必须在 map canvas 上登记 wheel');
  assert.strictEqual(wheel.opts.passive, false, 'cd() :1006-1008 passive:false');
  let prevented = 0;
  m.state.zoom = 2.5;
  m.state.pitch = 40;
  m.state.bearing = 20;
  wheel.fn({ deltaY: 50, preventDefault() { prevented++; } });
  assert.strictEqual(prevented, 1);
  assert.deepStrictEqual(m.pitchCalls, [37], 'ad: 40*(1-0.15*min(50/100,1))=37');
  assert.deepStrictEqual(m.bearingCalls, [18.5], 'id: 20*0.925=18.5');
  // deltaY<=0 不动作
  prevented = 0;
  m.pitchCalls.length = 0;
  wheel.fn({ deltaY: -10, preventDefault() { prevented++; } });
  assert.strictEqual(prevented, 0);
  assert.strictEqual(m.pitchCalls.length, 0);
  env.wg.unmount();
});

// ---------------------------------------------------------------------------
// 6. webgl2 门槛（Gu :127-135）
// ---------------------------------------------------------------------------

test('无 webgl2：mount reject，且不建 Map', async () => {
  const env = loadSandbox({ noWebgl2: true });
  const host = makeEl('div');
  await assert.rejects(() => env.wg.mount(host), /webgl2/i);
  assert.strictEqual(env.createdMaps.length, 0);
});

// ---------------------------------------------------------------------------
// 7. 自研降级链退役
// ---------------------------------------------------------------------------

test('源面回归：无 arcgisonline/openfreemap/OSM 瓦片/STYLE_TIERS 残留；deck 不再 pickable:true/preserveDrawingBuffer', () => {
  // 剥离块注释与行注释后查「代码面」残留（文件头退役说明允许提及旧域名）
  const src = read('public/video/world-globe.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.ok(!/arcgisonline/.test(src), 'Esri 卫星档已退役');
  assert.ok(!/openfreemap/i.test(src), 'OpenFreeMap 自研暗档已退役');
  assert.ok(!/tile\.openstreetmap\.org/.test(src), 'OSM 兜底档已退役');
  assert.ok(!/STYLE_ESRI|STYLE_OSM|STYLE_BARE|STYLE_DARK_RASTER/.test(src), '自研样式对象全部退役');
  assert.ok(!/preserveDrawingBuffer/.test(src), '对齐 hearthere：不设 preserveDrawingBuffer');
  assert.ok(!/pickable:\s*true/.test(src), '对齐 hearthere：overlay 初始 _pickable false');
  assert.ok(!/localStorage/.test(src), 'key 不再走 localStorage（hearthere 硬编 hn.API_KEY）');
});

test('vendor 注入序列：deck→core→obj（maplibre UMD 退役，CSS 由 ESM 桥接负责）', async () => {
  const src = read('public/video/world-globe.js');
  const m = src.match(/var VENDOR\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(m, '应声明 VENDOR 数组');
  const items = (m[1].match(/'[^']+'/g) || []).map((s) => s.slice(1, -1));
  assert.deepStrictEqual(items, [
    'vendor/deck.gl/deck.gl.min.js',
    'vendor/loaders/loaders.gl.core.min.js',
    'vendor/loaders/loaders.gl.obj.min.js'
  ]);
  assert.ok(!/maplibre-gl\.min\.js/.test(src), 'maplibre UMD 不得再注入');
});

// ---------------------------------------------------------------------------
// 8. seq guard 契约随迁（评审 Critical 1 / Important 2 语义）
// ---------------------------------------------------------------------------

test('mount 竞态：过期 mount 晚到 load 不得覆盖共享全局、不得误毁在用 mount', async () => {
  const env = loadSandbox();
  const hostA = makeEl('div');
  const hostB = makeEl('div');
  const pA = env.wg.mount(hostA);
  await env.flush();
  const mapA = env.createdMaps[0];

  env.wg.unmount();
  const pB = env.wg.mount(hostB);
  await env.flush();
  const mapB = env.createdMaps[1];
  mapB.emit('load');
  await env.flush();
  assert.strictEqual(env.wg.getMap(), mapB, '在用 B 持有共享全局');

  mapA.emit('load'); // A 迟到
  const [resA, resB] = await Promise.all([pA, pB]);
  assert.strictEqual(resA, null, '过期 A 返回 null');
  assert.ok(resB && resB.map === mapB);
  assert.strictEqual(env.wg.getMap(), mapB, 'A 不得覆盖全局');
  assert.strictEqual(mapA.removed, 1, 'A 自毁自己的 map');
  assert.strictEqual(mapB.removed, 0, 'B 的 map 必须活着');
  assert.ok(env.createdOverlays.length <= 1, '过期路径不得留下 overlay');
  env.wg.unmount();
});

test('样式 fetch 期间过期：seq 守卫必须止步，不再建 Map', async () => {
  const env = loadSandbox();
  const hostA = makeEl('div');
  const pA = env.wg.mount(hostA);
  // 不 flush：A 还卡在 ready/fetch 微任务链里
  env.wg.unmount();
  const resA = await pA;
  assert.strictEqual(resA, null, '过期 mount 应返回 null');
  assert.strictEqual(env.createdMaps.length, 0, '过期链不得 new Map（僵尸链止步）');
});
