'use strict';

/**
 * 世界页 ④-5b 修复轮 — deck 图层实例生命周期（复活禁止）
 * 运行：node --test tests/world-lighthouse-deck-layer-lifecycle.test.js
 *
 * 事故（用户 2026-09-30 浏览器验收截图）：
 *   deck: initialization of SimpleMeshLayer({id:'lighthouse-rim-layer-r-sh'}):
 *   deck.gl: assertion failed.
 *
 * 根因【有来源：public/vendor/deck.gl/deck.gl.min.js :3198 + LayerManager 区段】：
 *   · SimpleMeshLayer._initialize 断言 !this.internalState；internalState 仅构造器置 null，
 *     _finalize() 不清除 → 已被 deck 初始化过的实例永远不能再走 _initialize。
 *   · LayerManager._updateSublayersRecursively：仅当同 id 存在于上一拍 layersById 才
 *     transfer+update；id 缺席（层被摘拍/新 deck）→ _initializeLayer(新到实例)。
 *   · 我们的 slotBase（基座槽）+ Em opacityClone（WeakMap 克隆缓存）在「摘拍后同 sig 回加」
 *     时把曾被初始化的克隆再交给 deck → 复活 → 断言 → 下游 finalized GL 资源
 *     被 draw（bufferSubData/bindTexture/UBO 连锁）。
 *
 * 触发面（演示房 alwaysExpanded → skipAnimation → enterProgress 恒 1，sig 摘拍前后不变）：
 *   ① expanded 批层被视窗过滤摘除后回加；② 信标 选中→取消→再选中（r-sh/r-tk/r-ny 即此路径）。
 *
 * 修复语义（本测试钉死）：层实例只在「相邻两拍都在装配列表里」时复用——
 *   refresh() 末尾对未命中槽位剪枝（对齐 deck 的 id-邻接 MATCHED 规则；
 *   hearthere 靠 React 逐拍重建天然无复活路径）。
 *
 * 风格：vm 沙箱装载真实模块 + 仿 deck LayerManager 的假 overlay（初始化断言机）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const MODULE_PATH = path.join(root, 'public', 'video', 'world-lighthouse-deck.js');
const EFFECTS_PATH = path.join(root, 'public', 'video', 'world-lighthouse-effects.js');
const SRC = fs.readFileSync(MODULE_PATH, 'utf8');
const EFFECTS_SRC = fs.readFileSync(EFFECTS_PATH, 'utf8');

// ---------------------------------------------------------------------------
// 仿 deck LayerManager 的 overlay：初始化断言机
//   规则逐字对齐 :731186 区段 —— 同 id 在上拍 → transfer/update（实例可换可同）；
//   id 不在上拍 → 必须 _initialize → 实例若曾被初始化过则 deck.gl 断言失败。
// ---------------------------------------------------------------------------

function makeLifecycleOverlay() {
  const ov = {
    emissions: [],
    initialized: new Set(), // 曾被 deck「初始化」的实例（internalState 置位，不可逆）
    prev: new Map(),        // 上一拍 id → instance（layersById 近似）
    failure: null,
    setProps(p) {
      const layers = p.layers;
      ov.emissions.push(layers);
      try {
        const next = new Map();
        for (const L of layers) {
          const id = L.props.id;
          if (!ov.prev.has(id)) {
            if (ov.initialized.has(L)) {
              throw new Error(`deck.gl: assertion failed — layer "${id}" re-initialized`);
            }
            ov.initialized.add(L);
          }
          next.set(id, L);
        }
        ov.prev = next;
      } catch (e) {
        ov.failure = ov.failure || e; // 真实 deck：_handleError("initialization") 记录不崩页
        throw e;
      }
    }
  };
  return ov;
}

// ---------------------------------------------------------------------------
// 沙箱（同 flight-bounds 惯例：层 stub 可 clone、timers 手动 flush）
// ---------------------------------------------------------------------------

function makeLayerStubCtor(name) {
  return class {
    constructor(props) {
      this.props = props;
      this.className = name;
    }
    get id() { return this.props.id; }
    getShaders() { return { inject: {}, modules: [] }; }
    getAttributeManager() { return null; }
    clone(patch) {
      const C = this.constructor;
      const c = new C(Object.assign({}, this.props, patch));
      c.__clonedFrom = this;
      return c;
    }
  };
}

function loadSandbox() {
  const created = [];
  function record(name) {
    const Base = makeLayerStubCtor(name);
    return class extends Base {
      constructor(props) { super(props); created.push(this); }
    };
  }
  const overlay = makeLifecycleOverlay();
  const timers = [];
  const sandbox = {
    console,
    Promise,
    setTimeout: (fn, ms) => { timers.push({ fn, ms, cancelled: false }); return timers.length; },
    clearTimeout: (id) => { const t = timers[id - 1]; if (t) t.cancelled = true; },
    Math,
    Date,
    Set,
    Map,
    WeakMap,
    JSON,
    Object,
    Array,
    Number,
    String,
    isFinite,
    isNaN,
    performance: { now: () => Date.now() },
    Float32Array,
    Uint16Array,
    deck: {
      SimpleMeshLayer: record('rim'),
      ScatterplotLayer: record('glow'),
      IconLayer: makeLayerStubCtor('icon'),
      CompositeLayer: makeLayerStubCtor('composite')
    },
    loaders: {
      parse: () => new Promise(() => {}),
      fetchFile: () => Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }),
      OBJLoader: function OBJLoader() {}
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(EFFECTS_SRC, sandbox);
  vm.runInContext(SRC, sandbox);
  const api = sandbox.StellaflixVideo.worldLighthouseDeck;
  function FakeMap(zoom) {
    const m = this;
    this.zoom = zoom;
    this.handlers = {};
    this.bounds = { west: -10, east: 50, south: -20, north: 20 }; // 罩 a(0) 与 d(40)
    this.on = (ev, fn) => { (m.handlers[ev] = m.handlers[ev] || []).push(fn); };
    this.off = (ev, fn) => { m.handlers[ev] = (m.handlers[ev] || []).filter((f) => f !== fn); };
    this.getZoom = () => m.zoom;
    this.getCenter = () => ({ lng: 0, lat: 0 });
    this.getBounds = () => {
      const b = m.bounds;
      return { getWest: () => b.west, getEast: () => b.east, getSouth: () => b.south, getNorth: () => b.north };
    };
    this.getCanvas = () => ({ clientWidth: 512, clientHeight: 512 });
    this.getBearing = () => 0;
    this.getPitch = () => 0;
    this.flyTo = () => {};
    this.stop = () => {};
    this.unproject = (p) => ({ lng: p[0], lat: p[1] });
    this.emit = (ev) => (m.handlers[ev] || []).slice().forEach((f) => f());
  }
  function flush() {
    const q = timers.splice(0, timers.length);
    for (const t of q) if (!t.cancelled) t.fn();
    return q.length;
  }
  return { sandbox, api, overlay, created, timers, flush, FakeMap };
}

const room = (id, lon, extra) => Object.assign({
  id, position: [lon, 0], status: 'online', alwaysExpanded: true,
  colorTop: [223, 204, 251], colorBottom: [150, 200, 254]
}, extra || {});

function lastLayers(env) { return env.overlay.emissions[env.overlay.emissions.length - 1] || []; }
function layerById(env, id) { return lastLayers(env).find((l) => l.props.id === id); }

// ---------------------------------------------------------------------------
// 1) expanded 批层：视窗过滤摘拍 → 同 sig 回加 → 禁复活
// ---------------------------------------------------------------------------

test('批层摘拍后同 sig 回加 —— 不得把 deck 已初始化的克隆实例再交出去（r-sh 事故路径①）', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(13);
  await env.api.mount(map, env.overlay, { stations: [room('a', 0), room('d', 40)] });
  const batch1 = layerById(env, 'lighthouse-expanded-batch');
  assert.ok(batch1, '初始装配批层在场（visible [a,d]）');

  // 视野移开：moveend replace → visibleIds [] → 批层摘拍（deck finalize 之）
  map.bounds = { west: 200, east: 260, south: -20, north: 20 };
  map.emit('moveend');
  env.flush();
  assert.strictEqual(layerById(env, 'lighthouse-expanded-batch'), undefined, '批层已摘拍');

  // 移回原位：同 sig（progress 恒 1、站表与 bands 未变）→ 现实现从槽位+Em 复活同一实例
  map.bounds = { west: -10, east: 50, south: -20, north: 20 };
  map.emit('moveend');
  let revived = null;
  try { env.flush(); } catch (e) { revived = e; }
  assert.strictEqual(revived, null,
    `回加必须交出「未被 deck 初始化」的新实例；复活=断言崩溃（根因见文件头）`);
  const batch2 = layerById(env, 'lighthouse-expanded-batch');
  assert.ok(batch2, '回加后批层在场');
  assert.notStrictEqual(batch2, batch1, '隔拍复用禁止：新克隆');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(batch2.props.data.map((s) => s.id))), ['a', 'd']);
  env.api.unmount();
});

// ---------------------------------------------------------------------------
// 2) 信标 选中→取消→再选中（alwaysExpanded → skipAnimation → p1 恒同 sig）
// ---------------------------------------------------------------------------

test('entering 层 选中→取消→再选中 —— 同 sig 摘拍回加禁复活（r-sh 事故路径②）', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(13);
  await env.api.mount(map, env.overlay, { stations: [room('a', 0), room('d', 40)] });

  env.api.setSelected('a'); // inExpanded → skipAnimation → enterProgress 恒 1
  const enter1 = layerById(env, 'lighthouse-rim-layer-a');
  assert.ok(enter1, 'entering a 层在场（p1）');

  // 取消：entering 摘拍 → 同名 exiting 层接管 id（r-sh 事故里是退场窗走完后 id 彻底离表）
  env.api.setSelected(null);
  for (let i = 0; i < 8 && layerById(env, 'lighthouse-rim-layer-a'); i++) env.flush();
  assert.strictEqual(layerById(env, 'lighthouse-rim-layer-a'), undefined, '退场窗结束：id 离表');

  let err = null;
  try { env.api.setSelected('a'); } catch (e) { err = e; }
  assert.strictEqual(err, null, '再选中必须建新实例，不得复活曾被 deck 初始化的 entering 克隆');
  const enter2 = layerById(env, 'lighthouse-rim-layer-a');
  assert.ok(enter2, 'entering a 回加');
  assert.notStrictEqual(enter2, enter1);
  env.api.unmount();
});

// ---------------------------------------------------------------------------
// 3) 防过度剪枝：相邻两拍都在列表 → 同实例复用照旧（uniform transition 依赖）
// ---------------------------------------------------------------------------

test('相邻复用保持：sig 不变的连续两拍仍交同一克隆实例（Em/slotBase 相邻语义不回归）', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(13);
  await env.api.mount(map, env.overlay, { stations: [room('a', 0)] });
  env.api.applyTier(13); // zoom 不变 → 全链 sig 不变 → 相邻复用
  const e1 = env.overlay.emissions[env.overlay.emissions.length - 2];
  const e2 = lastLayers(env);
  const b1 = e1.find((x) => x.props.id === 'lighthouse-expanded-batch');
  const b2 = e2.find((x) => x.props.id === 'lighthouse-expanded-batch');
  assert.ok(b1 && b2);
  assert.strictEqual(b2, b1, '相邻拍克隆引用复用');
  const g1 = e1.find((x) => x.props.id === 'station-glow-layer');
  assert.strictEqual(lastLayers(env).find((x) => x.props.id === 'station-glow-layer'), g1,
    '光晕层实例缓存（tt）跨拍复用不受剪枝影响');
  assert.strictEqual(env.overlay.failure, null, '全程无 deck 初始化断言');
  env.api.unmount();
});

// ---------------------------------------------------------------------------
// 4) Bt 门开合摘回同 sig 亦禁复活（zoom 下穿 11.5 再回到同一连续值）
// ---------------------------------------------------------------------------

test('zoom 下穿 Bt 门再回到同值 —— rim 槽位已剪枝，回加交新实例', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(13);
  await env.api.mount(map, env.overlay, { stations: [room('a', 0), room('d', 40)] });
  const b1 = layerById(env, 'lighthouse-expanded-batch');
  assert.ok(b1);
  env.api.applyTier(10); // 门关 → rim 批摘拍；槽若不清 → 回 13 复活
  assert.strictEqual(layerById(env, 'lighthouse-expanded-batch'), undefined, '门关摘层');
  let err = null;
  try { env.api.applyTier(13); } catch (e) { err = e; }
  assert.strictEqual(err, null, '门关→门开同 bands 不得复活 finalized 克隆');
  assert.notStrictEqual(layerById(env, 'lighthouse-expanded-batch'), b1);
  env.api.unmount();
});
