'use strict';

/**
 * 世界页 步骤④-5b — 飞行 targetBounds 沿途点亮 + 头像 warming 装配门
 * 运行：node --test tests/world-lighthouse-deck-flight-bounds.test.js
 *
 * 基准：_scratch/hearthere/main.pretty.js + _scratch/effects-spec-4-5.md E/F 段
 *   · E-10 :13018-13157 —— qr=1.4/Ri=120/Nm=80/jm=2.5 + Dm/Fm/Om/dc + ps/Ii=85.05112878
 *     + Bm/fc/Um/hs/$m/Ni/ji/Cr/Wm；ar :13799-13807、Di :13823-13828
 *   · D-8 :10633-10635 —— Sr(t,e)=t>=sc||e>.01（sc=St-xt-.5=11）
 *   · F-11 :12951-13017 —— Em() WeakMap clone 缓存 / Tm=[] / Lm / Rm
 *   · de 可见 id 机 :13382-13428（Oe.current）；事件防抖 :13549-13575（move/zoom→Ri accumulate、
 *     moveend→Nm replace）；ht 消费 :13495-13497（expanded 批 ∩ visibleIds）与
 *     :13506-13514（头像层 data=Rm）；zn :19601-19636（startBounds+Om targetBounds 捕获）
 *
 * 裁决（用户 2026-09-30「可」）：网络头像预热队列（we/oe/Mi/Ci/Hm，Supabase 面）不移植——
 *   本地 haloIds=全量站（头像即时可用等价「已预热」）、photoIds=空集（无照片面）；
 *   仅 Sr 门 + Rm 装配逐字保留。
 *
 * 风格：仓内惯例——纯函数直连 require；装配/事件用 vm 沙箱装载真实模块断言行为。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const MODULE_PATH = path.join(root, 'public', 'video', 'world-lighthouse-deck.js');
const EFFECTS_PATH = path.join(root, 'public', 'video', 'world-lighthouse-effects.js');
const API = require(MODULE_PATH);
const SRC = fs.readFileSync(MODULE_PATH, 'utf8');
const EFFECTS_SRC = fs.readFileSync(EFFECTS_PATH, 'utf8');

// ---------------------------------------------------------------------------
// 1) Om 视口→bounds（Web-Mercator，逐字 :13061-13091）
// ---------------------------------------------------------------------------

test('Om 基础：赤道中心 zoom10 512×512 pitch0 → 半宽 = 256/(512·2^10)·360 = 0.17578125°', () => {
  const b = API.viewportBounds({ center: [0, 0], zoom: 10, pitch: 0, viewportWidth: 512, viewportHeight: 512 });
  assert.ok(b, '合法入参不空');
  assert.ok(Math.abs(b.west + 0.17578125) < 1e-9, `west ${b.west}`);
  assert.ok(Math.abs(b.east - 0.17578125) < 1e-9);
  assert.ok(Math.abs(b.south + 0.17578125) < 1e-3, '赤道 Mercator≈线性（曲率偏差 ~2e-5°）');
  assert.ok(Math.abs(b.north - 0.17578125) < 1e-3);
});

test('Om pitch 视野扩张：pitch60 → m=1/cos60=2（北向加倍）；pitch89 → 1/cos 超上限钳 jm=2.5', () => {
  const flat = API.viewportBounds({ center: [0, 0], zoom: 10, pitch: 0, viewportWidth: 512, viewportHeight: 512 });
  const p60 = API.viewportBounds({ center: [0, 0], zoom: 10, pitch: 60, viewportWidth: 512, viewportHeight: 512 });
  assert.ok(Math.abs(p60.north - 2 * flat.north) < 1e-3, 'pitch60 北向半程 ×2');
  assert.ok(Math.abs(p60.west - flat.west) < 1e-9, 'pitch 不扩东西向（bearing0）');
  const p89 = API.viewportBounds({ center: [0, 0], zoom: 10, pitch: 89, viewportWidth: 512, viewportHeight: 512 });
  assert.ok(Math.abs(p89.north - 2.5 * flat.north) < 1e-3, '钳到 jm=2.5（1/cos89≈57 不取）');
  assert.strictEqual(API.PITCH_FOV_CAP, 2.5, 'jm 逐字（:13021）');
});

test('Om bearing90 → 横纵向半程互换（v=|cos|·y+|sin|·w）；非法入参/退化视口 → null', () => {
  const p0 = API.viewportBounds({ center: [0, 0], zoom: 10, pitch: 60, viewportWidth: 512, viewportHeight: 512 });
  const p90 = API.viewportBounds({ center: [0, 0], zoom: 10, pitch: 60, viewportWidth: 512, viewportHeight: 512, bearing: 90 });
  assert.ok(Math.abs((p90.east - p90.west) - (p0.north - p0.south)) < 1e-4, '东西向吃 pitch 扩张（经度线性 vs 纬度 atan(sinh) 微曲，容 1e-4）');
  assert.ok(Math.abs((p90.north - p90.south) - (p0.east - p0.west)) < 1e-4, '北向回缩（cos90≈0）');
  assert.strictEqual(API.viewportBounds({ center: [NaN, 0], zoom: 10, pitch: 0, viewportWidth: 512, viewportHeight: 512 }), null);
  assert.strictEqual(API.viewportBounds({ center: [0, 0], zoom: 10, pitch: 0, viewportWidth: 0, viewportHeight: 512 }), null);
  assert.strictEqual(API.viewportBounds({ center: [0, 0], zoom: 1e4, pitch: 0, viewportWidth: 512, viewportHeight: 512 }), null, '512·2**zoom 溢出 → null');
});

test('Om 反经线回绕 + fc 跨 180° 判定（west>east 分支，逐字 :13098/:13117）', () => {
  const b = API.viewportBounds({ center: [179, 0], zoom: 4, pitch: 0, viewportWidth: 512, viewportHeight: 512 });
  assert.ok(b.west > b.east, `跨 180° 视口 west(${b.west}) > east(${b.east})`);
  assert.strictEqual(API.pointInBounds([175, 0], b), true);
  assert.strictEqual(API.pointInBounds([-175, 0], b), true, '回绕侧命中');
  assert.strictEqual(API.pointInBounds([0, 0], b), false);
});

// ---------------------------------------------------------------------------
// 2) dc 扩张 / Bm / Um / hs / Di / 常量
// ---------------------------------------------------------------------------

test('dc：1.4 系数四向扩张；经度跨满 → 全球兜底 ±180 + 纬度钳 ±90', () => {
  const d = API.expandBounds({ west: -10, east: 10, south: -10, north: 10 }); // span20 → pad 4
  assert.deepStrictEqual(JSON.parse(JSON.stringify(d)), { west: -14, east: 14, south: -14, north: 14 });
  const g = API.expandBounds({ west: -170, east: 170, south: -80, north: 80 }); // 340+34 ≥ 360
  assert.strictEqual(g.west, -180);
  assert.strictEqual(g.east, 180);
  assert.strictEqual(g.south, -90, '80+35 越 90 钳住');
  assert.strictEqual(g.north, 90);
  assert.strictEqual(API.BOUNDS_SCALE, 1.4, 'qr 逐字（:13018）');
  assert.strictEqual(API.MOVE_ACCUMULATE_DEBOUNCE_MS, 120, 'Ri 逐字（:13019）');
  assert.strictEqual(API.MOVEEND_REPLACE_DELAY_MS, 80, 'Nm 逐字（:13020）');
  assert.strictEqual(API.MERCATOR_LAT_CLAMP, 85.05112878, 'Ii 逐字（:13111）');
  assert.strictEqual(API.boundsValid(null), false);
  assert.strictEqual(API.boundsValid({ west: 1, east: 0, south: -1, north: 1 }), true, '跨 180° 合法（south<=north 即可）');
  assert.strictEqual(API.boundsValid({ west: 0, east: 1, south: 5, north: 1 }), false, 'south>north 非法');
  assert.strictEqual(API.sameIdList(['a', 'b'], ['a', 'b']), true);
  assert.strictEqual(API.sameIdList(['a', 'b'], ['b', 'a']), false, '顺序敏感（数组恒按 stations 序产出）');
  assert.strictEqual(API.sameIdList(null, []), false, '长度不等');
  assert.strictEqual(API.sameIdList([], []), true);
});

// ---------------------------------------------------------------------------
// 3) Dm 单 bounds 过滤 / Fm 飞行双 bounds（逐字 :13023-13059）
// ---------------------------------------------------------------------------

const stn = (id, lon) => ({ id, position: [lon, 0], status: 'online' });
const STATIONS = [stn('a', 0), stn('d', 40), stn('b', 80), stn('c', 120)];
const BOX_A = { west: -10, east: 10, south: -20, north: 20 };
const BOX_B = { west: 70, east: 90, south: -20, north: 20 };

test('Dm replace/accumulate/forceInclude/无 bounds/空站表 五路逐字', () => {
  const rep = API.filterStationsByBounds({ stations: STATIONS, bounds: BOX_A });
  assert.deepStrictEqual(rep.map((s) => s.id), ['a']);
  const acc = API.filterStationsByBounds({ stations: STATIONS, bounds: BOX_A, previousVisibleIds: new Set(['b']), mode: 'accumulate' });
  assert.deepStrictEqual(acc.map((s) => s.id), ['a', 'b'], 'accumulate 并 previous（仍按站表序）');
  const force = API.filterStationsByBounds({ stations: STATIONS, bounds: BOX_A, forceIncludeIds: new Set(['c']) });
  assert.deepStrictEqual(force.map((s) => s.id), ['a', 'c']);
  assert.strictEqual(API.filterStationsByBounds({ stations: [], bounds: BOX_A }).length, 0, '空站表短路');
  assert.strictEqual(API.filterStationsByBounds({ stations: STATIONS, bounds: null }), STATIONS, '无 bounds 全放行');
});

test('Fm 双 bounds 并集 + previous + forceInclude；非法 bounds 剔除；双缺 → 全量', () => {
  const u = API.filterStationsForFlight({ stations: STATIONS, flightStartBounds: BOX_A, flightTargetBounds: BOX_B });
  assert.deepStrictEqual(u.map((s) => s.id), ['a', 'b']);
  const withPrev = API.filterStationsForFlight({ stations: STATIONS, flightStartBounds: BOX_A, flightTargetBounds: BOX_B, previousVisibleIds: new Set(['d']) });
  assert.deepStrictEqual(withPrev.map((s) => s.id), ['a', 'd', 'b']);
  const oneBad = API.filterStationsForFlight({ stations: STATIONS, flightStartBounds: null, flightTargetBounds: BOX_B, forceIncludeIds: new Set(['c']) });
  assert.deepStrictEqual(oneBad.map((s) => s.id), ['b', 'c'], 'Bm 剔非法后单 bounds 生效');
  assert.strictEqual(API.filterStationsForFlight({ stations: STATIONS }), STATIONS, '双缺 → 原数组同引用');
});

// ---------------------------------------------------------------------------
// 4) Sr 门 + Rm 装配 + Em clone 缓存（F-11 逐字）
// ---------------------------------------------------------------------------

test('Sr 头像装配门逐字（:10633-10635）：zoom>=sc(11) 或 detail>.01；与 Bt(11.5) 门并存', () => {
  assert.strictEqual(API.avatarWarmingGate(11, 0), true, 'sc=St-xt-.5=11 含等号');
  assert.strictEqual(API.avatarWarmingGate(10.9, 0.01), false, '> .01 严格大于');
  assert.strictEqual(API.avatarWarmingGate(10.9, 0.011), true);
  assert.strictEqual(API.AVATAR_WARMING_ZOOM, 11);
});

test('Rm 门闭 → Tm 同一引用；门开 → haloIds 查表映射 + hasPhoto 旗标 + 缺站跳过', () => {
  const byId = new Map(STATIONS.map((s) => [s.id, s]));
  const op = () => 1;
  const el = () => 50;
  const closed = API.avatarPrepareSet({ zoom: 10, detailOpacity: 0, forcePrepare: false, haloIds: ['a', 'b'], photoIds: new Set(), stationById: byId, getAvatarOpacity: op, getElevation: el });
  const closed2 = API.avatarPrepareSet({ zoom: 9, detailOpacity: 0, forcePrepare: false, haloIds: ['a'], photoIds: new Set(), stationById: byId, getAvatarOpacity: op, getElevation: el });
  assert.strictEqual(closed.length, 0);
  assert.strictEqual(closed, closed2, 'Tm 常量数组复用（:12976）');
  const open = API.avatarPrepareSet({ zoom: 12, detailOpacity: 0, forcePrepare: false, haloIds: ['a', 'ghost', 'b'], photoIds: new Set(['b']), stationById: byId, getAvatarOpacity: op, getElevation: el });
  assert.deepStrictEqual(open.map((r) => r.id), ['a', 'b'], 'ghost 查无跳过');
  assert.strictEqual(open[1].hasPhoto, true);
  assert.strictEqual(open[0].hasPhoto, false);
  assert.strictEqual(open[0].itemOpacity, 1);
  assert.strictEqual(open[0].itemElevation, 50);
  assert.ok(open[0].avatarUrl, 'Lm avatarUrl 面');
  const forced = API.avatarPrepareSet({ zoom: 10, detailOpacity: 0, forcePrepare: true, haloIds: ['a'], photoIds: new Set(), stationById: byId, getAvatarOpacity: op, getElevation: el });
  assert.strictEqual(forced.length, 1, 'forcePrepare 越门（ie 分支，网络预热面未移植恒 false——接口保真）');
});

test('Em clone 缓存逐字（:12951-12975）：avatar 走 opacity 克隆、rim 走 getLayerOpacity+updateTriggers 合并、他层原样', () => {
  function fakeLayer(id, props) {
    return {
      id, props: props || {},
      clone(patch) { const C = fakeLayer; const l = C(id, Object.assign({}, this.props, patch)); l.__clonedFrom = this; return l; }
    };
  }
  const cache = API.createLayerOpacityCache();
  const avatar = fakeLayer('station-avatar-layer', { data: [1] });
  const c1 = cache(avatar, 0.5, 0.8);
  assert.strictEqual(c1.props.opacity, 0.8, 'avatar 克隆 opacity=detail（:12592）');
  assert.strictEqual(c1.props.visible, true);
  assert.strictEqual(c1.props.data, avatar.props.data, '其余 props 透传');
  assert.strictEqual(cache(avatar, 0.5, 0.8), c1, '同 (glow,detail) 命中 WeakMap');
  const c2 = cache(avatar, 0.4, 0.8);
  assert.notStrictEqual(c2, c1, 'glow 变化也失效（缓存键双通道）');
  const rim = fakeLayer('lighthouse-rim-layer-a', { updateTriggers: { getColor: ['x'] } });
  const r1 = cache(rim, 0.5, 0.7);
  assert.strictEqual(r1.props.getLayerOpacity(), 0.7, 'rim 走 getLayerOpacity 通道（:12596-12603）');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(Object.keys(rim.props.updateTriggers).concat(['getLayerOpacity']).sort())), ['getColor', 'getLayerOpacity'].sort(), 'updateTriggers 合并保留原键');
  assert.strictEqual(r1.props.updateTriggers.getColor[0], 'x', '原 trigger 值不丢');
  assert.strictEqual(r1.props.updateTriggers.getLayerOpacity[0], 0.7);
  const batch = fakeLayer('lighthouse-expanded-batch', {});
  assert.notStrictEqual(cache(batch, 0, 1), batch, '批层 id 亦在克隆域');
  const other = fakeLayer('station-glow-layer', {});
  assert.strictEqual(cache(other, 0, 1), other, '他层原样返回');
  const warm = fakeLayer('lighthouse-warmup-layer', {});
  assert.strictEqual(cache(warm, 0, 1), warm, 'warmup 不在克隆域');
});

// ---------------------------------------------------------------------------
// 5) vm 沙箱：zn targetBounds 捕获 + de 可见机 + 装配/事件
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
  const setPropsCalls = [];
  const overlay = { setProps(p) { setPropsCalls.push(p.layers); } };
  function FakeMap(zoom) {
    const m = this;
    this.zoom = zoom;
    this.handlers = {};
    this.bounds = { west: -10, east: 10, south: -20, north: 20 };
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
  const timers = [];
  const sandbox = {
    console,
    Promise,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
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
  function flush() {
    const q = timers.splice(0, timers.length);
    for (const t of q) if (!t.cancelled) t.fn();
    return q.length;
  }
  return { sandbox, api, created, setPropsCalls, overlay, timers, flush, FakeMap };
}

const room = (id, lon, extra) => Object.assign({
  id, position: [lon, 0], status: 'online', alwaysExpanded: true,
  colorTop: [223, 204, 251], colorBottom: [150, 200, 254]
}, extra || {});

function layersOf(env) { return env.setPropsCalls[env.setPropsCalls.length - 1]; }
function batchOf(env) { const l = layersOf(env); return l && l.find((x) => x.props.id === 'lighthouse-expanded-batch'); }
function avatarOf(env) { const l = layersOf(env); return l && l.find((x) => x.props.id === 'station-avatar-layer'); }

test('zn 飞行捕获逐字（:19604-19625）：target = {stationId, startBounds(快照), targetBounds(Om 目标视口)}', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(13);
  await env.api.mount(map, env.overlay, { stations: [room('a', 0), room('b', 80, { status: 'playing' })] });
  env.api.setSelected('b');
  env.api.flyToStation(env.api.getState().stations.find((s) => s.id === 'b'));
  const t = env.api.getFlightState().target;
  assert.strictEqual(t.stationId, 'b');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(t.startBounds)), { west: -10, east: 10, south: -20, north: 20 }, 'startBounds = 起飞瞬间 getBounds 快照');
  assert.ok(t.targetBounds, 'targetBounds 非空（Om 归 ④-5b）');
  assert.ok(env.api.pointInBounds([80, 0], t.targetBounds), 'targetBounds 罩住目标站（zoom16 pitch60）');
  env.api.unmount();
});

test('沿途点亮装配（de :13399-13407 + ht :13495-13497）：飞行中批 = Fm 双盒并集（起点视野保持点亮）；落地 replace 后摘除', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(13);
  map.bounds = { west: -10, east: 50, south: -20, north: 20 }; // 起点宽视野：罩 a、d
  await env.api.mount(map, env.overlay, {
    stations: [room('a', 0), room('d', 40), room('b', 80, { status: 'playing' }), room('c', 120)]
  });
  // 初始 replace：BOX(-10..50) → visible [a,d]；批 = expanded − selected = [a,d]
  assert.deepStrictEqual(env.api.getVisibleIds(), ['a', 'd'], 'mount 末 de("replace") :13573');
  assert.deepStrictEqual(batchOf(env).props.data.map((s) => s.id), ['a', 'd']);
  env.api.setSelected('b');
  env.api.flyToStation(env.api.getState().stations.find((s) => s.id === 'b'));
  // 飞行分支：Fm(start=起点盒→a,d；target=Om 罩b) ∪ force{b} —— c 双盒皆不罩
  const vis = env.api.getVisibleIds();
  assert.deepStrictEqual(vis, ['a', 'd', 'b'], '起点视野内的 d 飞行期间保持点亮');
  assert.deepStrictEqual(batchOf(env).props.data.map((s) => s.id), ['a', 'd'], 'd 在批内（沿途点亮可视面）');
  map.bounds = { west: 70, east: 90, south: -20, north: 20 }; // 抵达 b 视口
  map.emit('moveend');
  env.flush(); // Nm 80ms replace 定时器
  const after = env.api.getVisibleIds();
  assert.deepStrictEqual(after, ['b'], 'replace 收束：d 摘除、b 由 forceInclude 保留（选中态）');
  assert.strictEqual(batchOf(env), undefined, '批空 → 无层（expanded.length>0 :13534）');
  env.api.unmount();
});

test('事件防抖逐字（:13551-13575）：move 距上次 <Ri 走尾定时器；moveend 清尾 + Nm 后 replace', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(13);
  await env.api.mount(map, env.overlay, { stations: [room('a', 0), room('d', 40)] });
  assert.deepStrictEqual(env.api.getVisibleIds(), ['a']);
  map.bounds = { west: -10, east: 50, south: -20, north: 20 };
  map.emit('move'); // 距 lastMoveAt(≈mount 时刻) <120ms 概率高——两态都收敛 accumulate
  env.flush();
  assert.deepStrictEqual(env.api.getVisibleIds(), ['a', 'd'], 'accumulate 收 d');
  map.bounds = { west: -10, east: 10, south: -20, north: 20 };
  map.emit('move');
  env.flush();
  assert.deepStrictEqual(env.api.getVisibleIds(), ['a', 'd'], 'accumulate 保 previous：d 不缩回');
  map.emit('moveend');
  env.flush();
  assert.deepStrictEqual(env.api.getVisibleIds(), ['a'], 'moveend→Nm replace：previous 丢弃');
  env.api.unmount();
});

test('头像 Sr 门装配（Rm 接入 ht :13485-13514）：zoom10 detail0 → data []；zoom11(=sc) → 全量记录', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(10);
  await env.api.mount(map, env.overlay, { stations: [room('a', 0), room('b', 80)] });
  let av = avatarOf(env);
  assert.ok(av, '头像层常驻（b.length>0 :13506）');
  // Tm 是沙箱上下文域字面量数组，跨域 deepStrictEqual 因原型不同而失败——按长度断言
  assert.strictEqual(av.props.data.length, 0, 'Sr 门闭 → Tm');
  env.api.applyTier(11);
  av = avatarOf(env);
  // Rm 的 out 是上下文域数组，跨域 deepStrictEqual 原型不同——按 JSON 结构比对
  assert.deepStrictEqual(JSON.parse(JSON.stringify(av.props.data.map((r) => r.id))), ['a', 'b'], 'zoom≥sc=11 开门，本地全量 haloIds 即时可用');
  assert.strictEqual(av.props.opacity, env.api.detailOpacity(11));
  env.api.unmount();
});

test('Em 接线：同 (glow,detail) 相邻两拍 avatar/rim 层引用复用；detail 变化出新克隆', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(13);
  await env.api.mount(map, env.overlay, { stations: [room('a', 0)] });
  const first = layersOf(env);
  env.api.applyTier(13); // detail 不变 → 全链同拍
  const second = layersOf(env);
  const a1 = first.find((x) => x.props.id === 'station-avatar-layer');
  const a2 = second.find((x) => x.props.id === 'station-avatar-layer');
  assert.strictEqual(a2, a1, 'avatar 层引用跨拍复用（base+Em 双缓存）');
  const b1 = first.find((x) => x.props.id === 'lighthouse-expanded-batch');
  const b2 = second.find((x) => x.props.id === 'lighthouse-expanded-batch');
  assert.strictEqual(b2, b1, 'expanded 批同');
  env.api.applyTier(14); // detail 变 → 新克隆
  const third = layersOf(env);
  assert.notStrictEqual(third.find((x) => x.props.id === 'station-avatar-layer'), a1);
  env.api.unmount();
});

test('zoom 档变触发 replace（de 依赖 [t,M] → effect :13431-13433）：跨 11.5 下门 → visibleIds 归 null', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(13);
  await env.api.mount(map, env.overlay, { stations: [room('a', 0), room('d', 40)] });
  assert.deepStrictEqual(env.api.getVisibleIds(), ['a']);
  env.api.applyTier(10); // < St-xt → Oe=null（:13410-13413）
  assert.strictEqual(env.api.getVisibleIds(), null);
  assert.strictEqual(batchOf(env), undefined, 'zoom10 detail=0 → Bt 门关无批层（与 Oe 无关）');
  env.api.applyTier(13);
  assert.deepStrictEqual(env.api.getVisibleIds(), ['a'], '回档再 replace');
  env.api.unmount();
});

test('bounds 不可得 → visibleIds null → expanded 批全量（ot===null ? le : filter，:13495-13497）', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(13);
  await env.api.mount(map, env.overlay, { stations: [room('a', 0), room('d', 40)] });
  assert.deepStrictEqual(env.api.getVisibleIds(), ['a']);
  map.getBounds = () => null; // ar 退化（无 getBounds 或返回空）
  env.api.applyTier(13.2);    // detail 变 → 换克隆，触发重装配
  assert.strictEqual(env.api.getVisibleIds(), null, 'mt null → Oe=null（:13414-13418）');
  assert.deepStrictEqual(batchOf(env).props.data.map((s) => s.id), ['a', 'd'], 'null → 全量 expanded');
  env.api.unmount();
});

test('refreshStations 触发 replace（effect :13431-13433 [le]）：新站入视即见', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(13);
  await env.api.mount(map, env.overlay, { stations: [room('a', 0)] });
  assert.deepStrictEqual(env.api.getVisibleIds(), ['a']);
  env.api.refreshStations([room('a', 0), room('e', 5)]);
  assert.deepStrictEqual(env.api.getVisibleIds(), ['a', 'e'], 'BOX_A 罩 e → replace 即收');
  env.api.unmount();
});

// ---------------------------------------------------------------------------
// 6) 源码正则兜底
// ---------------------------------------------------------------------------

test('④-5b 关键算式兜底：Ii 常量 / jm 钳制 / accumulate 分支 / targetBounds 装配 / Tm 复用', () => {
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(CODE, /85\.05112878/, 'Ii 纬度钳逐字');
  assert.match(CODE, /Math\.min\(PITCH_FOV_CAP, *1 \/ Math\.max\(\.4, *Math\.cos/, 'Om pitch 扩张钳逐字（:13075，jm=2.5）');
  assert.match(CODE, /=== ['"]accumulate['"]/, 'Dm accumulate 分支');
  assert.match(CODE, /targetBounds: viewportBounds\(|targetBounds: Om\(/, 'flyToStation targetBounds 经 Om');
  assert.match(CODE, /lighthouse-expanded-batch/, '批层 id 在 Em 克隆域');
  assert.match(CODE, /Tm|AVATAR_EMPTY_SET/, 'Tm 常量数组');
});
