'use strict';

/**
 * 世界页 步骤④ — 卡片+交互 hearthere 保真（public/video/world-lighthouse-deck.js 等）
 * 运行：node --test tests/world-interaction-hearthere.test.js
 *
 * 基准：_scratch/hearthere/main.pretty.js（2026-09-27 线上包）
 *   ④-1 选中状态机 yh :10698-10779（Mn=290/fs=80/mh=1000/gh=700/or=50/yi=16 :10691-10696）
 *        · easeOutCubic 1-(1-K)^3，16ms setTimeout 步进（:10716-10731）
 *        · 进入：置当前高度 → 50ms 后升至 290（:10745-10762）
 *        · 退出：held 290 共 mh+150=1150ms → 回落 80，完成清 override（:10732-10744）
 *        · 已在 expanded 批 → skipAnimation（ze :13757-13762）
 *   ④-1 rim 分层 ht :13523-13538：exiting(id)→entering(id)→expanded-batch，
 *        层 id = `lighthouse-rim-layer-${stationId}`，progress 走 deck 1000ms 过渡
 *   Bt 门限（Sr）同样闸住 entering/exiting 层
 *
 * 风格：vm 沙箱装载真实模块 + 假时钟（Date.now / setTimeout 受控），断言行为序列。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const MODULE_PATH = path.join(root, 'public', 'video', 'world-lighthouse-deck.js');
const PICK_PATH = path.join(root, 'public', 'video', 'world-pick.js');
const PICK_SRC = fs.readFileSync(PICK_PATH, 'utf8');
const API = require(MODULE_PATH);
require(PICK_PATH); // Node 直连面（world-pick 纯函数测试在同仓 world-pick-hearthere.test.js）

// ---------------------------------------------------------------------------
// 假时钟 + 沙箱
// ---------------------------------------------------------------------------

function makeClock() {
  let now = 0;
  let seq = 1;
  const queue = [];
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const t = { id: seq++, at: now + (ms || 0), fn, cancelled: false };
      queue.push(t);
      return t.id;
    },
    clearTimeout: (id) => {
      const t = queue.find((x) => x.id === id);
      if (t) t.cancelled = true;
    },
    advance: (ms) => {
      const target = now + ms;
      for (;;) {
        const due = queue
          .filter((t) => !t.cancelled && t.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        queue.splice(queue.indexOf(due), 1);
        now = due.at;
        due.fn();
      }
      now = target;
    }
  };
}

function makeLayerStubCtor(name) {
  return class {
    constructor(props) {
      // 模拟 deck.gl Layer 基类：static defaultProps 合并进 this.props（v9 构造器行为）
      var ctor = this.constructor;
      this.props = ctor.defaultProps
        ? Object.assign({}, ctor.defaultProps, props)
        : props;
      this.className = name;
    }
    getShaders() { return { inject: {}, modules: [] }; }
    getAttributeManager() { return null; }
  };
}

const SRC = fs.readFileSync(MODULE_PATH, 'utf8');

function loadSandbox() {
  const clock = makeClock();
  const created = [];
  function rec(name) {
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
    this.flyToCalls = [];
    this.stopCount = 0;
    this.on = (ev, fn) => { (m.handlers[ev] = m.handlers[ev] || []).push(fn); };
    this.off = (ev, fn) => { m.handlers[ev] = (m.handlers[ev] || []).filter((f) => f !== fn); };
    this.getZoom = () => m.zoom;
    this.getCenter = () => ({ lng: 121, lat: 31.2 });
    this.getBounds = () => ({
      getWest: () => 100, getEast: () => 140, getSouth: () => 10, getNorth: () => 50
    });
    this.unproject = (p) => ({ lng: p[0] / 10, lat: p[1] / 10 });
    this.flyTo = (opts) => { m.flyToCalls.push(opts); };
    this.stop = () => { m.stopCount += 1; };
    this.emit = (ev) => (m.handlers[ev] || []).slice().forEach((f) => f({ lngLat: { lng: 121, lat: 31.2 }, point: { x: 0, y: 0 } }));
    this.handlerCount = (ev) => (m.handlers[ev] || []).length;
  }
  const sandbox = {
    console,
    Promise,
    Math,
    Set,
    Map,
    Array,
    Object,
    JSON,
    String,
    Number,
    Boolean,
    Error,
    isFinite,
    parseInt,
    parseFloat,
    Date: { now: () => clock.now() },
    requestAnimationFrame: (fn) => clock.setTimeout(() => fn(clock.now()), 16),
    cancelAnimationFrame: (id) => clock.clearTimeout(id),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    deck: { SimpleMeshLayer: rec('rim'), ScatterplotLayer: rec('glow'), IconLayer: rec('icon'), CompositeLayer: makeLayerStubCtor('composite') },
    loaders: {
      parse: () => new Promise(() => {}),
      fetchFile: () => Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }),
      OBJLoader: function OBJLoader() {}
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(PICK_SRC, sandbox); // 浏览器同页加载序：world-pick 先于 deck
  vm.runInContext(SRC, sandbox);
  const api = sandbox.StellaflixVideo.worldLighthouseDeck;
  return { api, clock, created, setPropsCalls, overlay, FakeMap, sandbox };
}

const station = (id, lon, extra) => Object.assign({
  id, position: [lon, 31.2], status: 'online',
  colorTop: [223, 204, 251], colorBottom: [150, 200, 254]
}, extra || {});

function lastLayers(env) { return env.setPropsCalls[env.setPropsCalls.length - 1] || []; }
function layerById(env, id) { return lastLayers(env).find((l) => l.props.id === id); }

// ---------------------------------------------------------------------------
// ④-1 常量（yh :10691-10696）
// ---------------------------------------------------------------------------

test('选中状态机常量逐字：Mn=290 / fs=80 / mh=1000 / gh=700 / or=50 / yi=16（:10691-10696）', () => {
  assert.strictEqual(API.ELEVATION_EXPANDED, 290);   // Mn
  assert.strictEqual(API.ELEVATION_BASE, 80);         // fs
  assert.strictEqual(API.EXIT_HOLD_MS, 1000 + 150);   // mh+150（:10744）
  assert.strictEqual(API.SELECTION_TWEEN_MS, 700);    // gh
  assert.strictEqual(API.SELECTION_RISE_DELAY_MS, 50);// or
  assert.strictEqual(API.SELECTION_TICK_MS, 16);      // yi
});

// ---------------------------------------------------------------------------
// ④-1 进入序列（Q :10745-10762）
// ---------------------------------------------------------------------------

test('选中非展开站：独立 rim 层 `lighthouse-rim-layer-${id}` 先 progress=0，50ms 后置 1（:10759-10761 + ht :13529-13533）', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(14);
  await env.api.mount(map, env.overlay, { stations: [station('a', 121)] });
  env.api.setSelected('a');
  const rim = layerById(env, 'lighthouse-rim-layer-a');
  assert.ok(rim, '选中站必须有独立 rim 层（entering）');
  assert.strictEqual(rim.props.getEntranceProgress(), 0,
    '进入首拍 entranceProgress=0（A=enterProgress 先置 0）');
  assert.strictEqual(rim.props.data.length, 1);
  assert.strictEqual(rim.props.data[0].id, 'a');

  env.clock.advance(50);
  const rim2 = layerById(env, 'lighthouse-rim-layer-a');
  assert.strictEqual(rim2.props.getEntranceProgress(), 1,
    'or=50ms 后置 1，由 deck transitions 演 0→1 入场扫描');
  env.api.unmount();
});

test('进入高度扫描：50ms 起 80→290 easeOutCubic（gh=700，tick=16ms），完成清 override 后按选中态读回 290（A()/·_ :10716-10731, 10702-10704）', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(14);
  await env.api.mount(map, env.overlay, { stations: [station('a', 121)] });
  env.api.setSelected('a');
  assert.strictEqual(env.api.getElevation('a'), 80, '置当前高度起步（C(a)=fs=80）');

  // 21 tick = 336ms：U = 80 + (290-80)*(1-(1-336/700)^3)
  env.clock.advance(50 + 336);
  const k = 336 / 700;
  const expected = 80 + 210 * (1 - Math.pow(1 - k, 3));
  assert.ok(Math.abs(env.api.getElevation('a') - expected) < 1e-9,
    `easeOutCubic 采样：${env.api.getElevation('a')} vs ${expected}`);

  env.clock.advance(700 - 336 + 16);
  assert.strictEqual(env.api.getElevation('a'), 290, '完成后选中态恒 290');
  env.api.unmount();
});

test('已在 expanded 批的站 → skipAnimation：progress 直接 1、高度直接 290（ze :13757-13762）', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(14);
  await env.api.mount(map, env.overlay, {
    stations: [station('sys', 121, { ownerType: 'system' })]
  });
  env.api.setSelected('sys');
  const rim = layerById(env, 'lighthouse-rim-layer-sys');
  assert.ok(rim, 'skipAnimation 也要出独立 rim 层');
  assert.strictEqual(rim.props.getEntranceProgress(), 1);
  assert.strictEqual(env.api.getElevation('sys'), 290);
  env.api.unmount();
});

// ---------------------------------------------------------------------------
// ④-1 退出序列（J :10732-10744）
// ---------------------------------------------------------------------------

test('改选他站：旧站 exiting rim progress 1→0（50ms 后）反扫；1150ms 摘层并回落 290→80（J/A）', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(14);
  await env.api.mount(map, env.overlay, {
    stations: [station('a', 121), station('b', 139)]
  });
  env.api.setSelected('a');
  env.clock.advance(50 + 700 + 16); // a 入场完成
  env.api.setSelected('b');

  const exiting = layerById(env, 'lighthouse-rim-layer-a');
  assert.ok(exiting, '被取代站必须获得 exiting rim 层');
  assert.strictEqual(exiting.props.getEntranceProgress(), 1, 'exitProgress 先置 1');
  assert.strictEqual(env.api.getElevation('a'), 290, '退出期恒 held 290（P(T,Mn) :10738）');

  env.clock.advance(50);
  assert.strictEqual(layerById(env, 'lighthouse-rim-layer-a').props.getEntranceProgress(), 0,
    'or 后 Q=0 → 反扫离场');

  // exiting 层存活至 mh+150=1150ms
  env.clock.advance(1150 - 50 - 1);
  assert.ok(layerById(env, 'lighthouse-rim-layer-a'), '1150ms 前层仍在');
  env.clock.advance(1);
  assert.ok(!layerById(env, 'lighthouse-rim-layer-a'), '1150ms 后摘层');
  // 回落 tween：290→80
  env.clock.advance(350);
  const mid = env.api.getElevation('a');
  assert.ok(mid > 80 && mid < 290, `回落中：${mid}`);
  env.clock.advance(700 - 350 + 16);
  assert.strictEqual(env.api.getElevation('a'), 80, '完成清 override → 非选中读回 fs=80');
  env.api.unmount();
});

test('expanded 批只排除当前选中、不排除 exiting 站（le :13262 `id !== R`）', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(14);
  await env.api.mount(map, env.overlay, {
    stations: [
      station('x', 121, { alwaysExpanded: true }),
      station('y', 139, { alwaysExpanded: true })
    ]
  });
  env.api.setSelected('x');
  env.api.setSelected('y');
  const batch = layerById(env, 'lighthouse-expanded-batch');
  assert.ok(batch);
  const ids = batch.props.data.map((d) => d.id);
  assert.ok(!ids.includes('y'), '批内排除当前选中 y');
  assert.ok(ids.includes('x'), 'exiting 的 x 仍在批内（谓词不排退出态）');
  env.api.unmount();
});

// ---------------------------------------------------------------------------
// ④-1 门限 / 查询面 / 收尾
// ---------------------------------------------------------------------------

test('Bt 门限闸住选中层（ht :13523）：zoom=10 时选中也不出 rim 层，升过 11.5 后补出', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(10);
  await env.api.mount(map, env.overlay, { stations: [station('a', 121)] });
  env.api.setSelected('a');
  assert.ok(!layerById(env, 'lighthouse-rim-layer-a'), 'Bt 关：无选中 rim 层');
  map.zoom = 11.6;
  map.emit('zoom');
  assert.ok(layerById(env, 'lighthouse-rim-layer-a'), 'Bt 开：选中层按当前进度补出');
  env.api.unmount();
});

test('clearSelection + getState 契约：selectedId 同步；退出态可查（X/T :10763-10766）', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(14);
  await env.api.mount(map, env.overlay, { stations: [station('a', 121)] });
  env.api.setSelected('a');
  assert.strictEqual(env.api.getState().selectedId, 'a');
  env.api.clearSelection();
  assert.strictEqual(env.api.getState().selectedId, null);
  assert.ok(env.api.getState().exitingId, '清空选中 → 进入退出动画态');
  assert.ok(layerById(env, 'lighthouse-rim-layer-a'));
  env.clock.advance(50 + 1150 + 700 + 32);
  assert.ok(!layerById(env, 'lighthouse-rim-layer-a'), '收尾后层摘除');
  assert.strictEqual(env.api.getState().exitingId, null);
  env.api.unmount();
});

test('unmount 清干净：在途定时器全部作废，重挂无残留（yh 卸载 effect :10767-10768）', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(14);
  await env.api.mount(map, env.overlay, { stations: [station('a', 121)] });
  env.api.setSelected('a');
  env.api.unmount();
  const before = env.setPropsCalls.length;
  env.clock.advance(3000); // 所有在途 tick 不得再触发 setProps
  assert.strictEqual(env.setPropsCalls.length, before, '卸载后定时器不得复活');
  assert.strictEqual(env.api.getState().selectedId, null);
});

// ---------------------------------------------------------------------------
// ④-2 拾取分档（Us :19810-19828 + om/_c/Cc）与电影感飞行（zn :19601-19637）
// ---------------------------------------------------------------------------

function withDeckOverlay(env, map, opts) {
  opts = opts || {};
  const pickObjectCalls = [];
  env.overlay._deck = {
    deckPicker: { _pickable: false },
    pickObject(o) {
      pickObjectCalls.push({ x: o.x, y: o.y, radius: o.radius, pickable: env.overlay._deck.deckPicker._pickable });
      return opts.gpuResult || null;
    },
    getViewports() {
      // 自洽桩：project 忽略高程、unproject 反投同一映射（真实地图 80m 高程屏幕位移≪1°）
      return opts.viewports || [{ project: (p) => [p[0] * 10, p[1] * 10] }];
    }
  };
  env.map = map;
  return { pickObjectCalls };
}

test('projectWithElevation：走 deck 视口 project([lon,lat,fs=80])，无视口回落 {0,0}（Ct :13763-13779）', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(14);
  const seen = [];
  env.overlay._deck = {
    deckPicker: {},
    getViewports: () => [{ project: (p) => { seen.push(p.slice()); return [p[0], p[1]]; } }]
  };
  await env.api.mount(map, env.overlay, { stations: [station('a', 121)] });
  const out = env.api.projectWithElevation([121, 31.2]);
  assert.strictEqual(seen[0][2], 80, '投影必须带 fs=80 高度分量');
  assert.strictEqual(out.x, 121);
  assert.strictEqual(out.y, 31.2);
  env.overlay._deck = null;
  const fb = env.api.projectWithElevation([1, 2]);
  assert.strictEqual(fb.x, 0);
  assert.strictEqual(fb.y, 0);
  env.api.unmount();
});

test('pickStation 低倍档（zoom<11.5）：不动 GPU，纯 CPU 屏幕距命中（Us :19810-19824）', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(10);
  const probe = withDeckOverlay(env, map, { gpuResult: { object: { id: 'a' } } });
  await env.api.mount(map, env.overlay, { stations: [station('a', 121), station('b', 139)] });
  // project: x=lon*10, y=lat*10（桩忽略高程）；点 (1210, 312) 距 a 投影为 0 → 必中
  const hit = env.api.pickStation(1210, 31.2 * 10);
  assert.strictEqual(hit && hit.id, 'a');
  assert.strictEqual(probe.pickObjectCalls.length, 0, '低倍档严禁触达 GPU pickObject');
  env.api.unmount();
});

test('pickStation 高倍档：GPU 先行 radius:0 + _pickable 临时开，miss 落 CPU 兜底，hit 返站记录（om/Us :19810-19828）', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(14);
  const probe = withDeckOverlay(env, map, { gpuResult: { object: { id: 'b' } } });
  await env.api.mount(map, env.overlay, { stations: [station('a', 121), station('b', 139)] });
  const hit = env.api.pickStation(1390, 356);
  assert.strictEqual(hit && hit.id, 'b', 'GPU 命中直接返站');
  assert.strictEqual(probe.pickObjectCalls.length, 1);
  assert.strictEqual(probe.pickObjectCalls[0].radius, 0);
  assert.strictEqual(probe.pickObjectCalls[0].pickable, true, '拾取窗口内 _pickable 必须临时置 true');
  assert.strictEqual(env.overlay._deck.deckPicker._pickable, false, '事后复位');

  // GPU miss → CPU 兜底命中近旁站
  probe.pickObjectCalls.length = 0;
  env.overlay._deck.pickObject = () => null;
  const hit2 = env.api.pickStation(1210, 31.2 * 10);
  assert.strictEqual(hit2 && hit2.id, 'a', 'GPU null 时 CPU 兜底');
  env.api.unmount();
});

test('GPU/CPU 返回的 id 不在站表 → null（Us :19827-19828 再查表）', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(14);
  withDeckOverlay(env, map, { gpuResult: { object: { id: 'ghost' } } });
  await env.api.mount(map, env.overlay, { stations: [station('a', 121)] });
  assert.strictEqual(env.api.pickStation(1, 1), null);
  env.api.unmount();
});

test('电影感飞行（zn :19601-19637）：stop + flyTo{zoom16,pitch60,2800ms}，程序化 flag 置/落，effects 就绪 gate', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(12);
  withDeckOverlay(env, map, {});
  await env.api.mount(map, env.overlay, { stations: [station('a', 121)] });
  const st = env.api.getState().stations[0];
  env.api.flyToStation(st);
  assert.strictEqual(map.stopCount, 1, '起飞前必须 map.stop()（:19603）');
  // vm 跨 realm 对象不做 deepStrictEqual（原型不同），逐字段钉死 F0/O0/B0 逐字（wt :19647-19649）
  assert.strictEqual(JSON.stringify(map.flyToCalls[0].center), JSON.stringify([121, 31.2]));
  assert.strictEqual(map.flyToCalls[0].zoom, 16);
  assert.strictEqual(map.flyToCalls[0].pitch, 60);
  assert.strictEqual(map.flyToCalls[0].duration, 2800);
  const f1 = env.api.getFlightState();
  assert.strictEqual(f1.isProgrammaticCameraFlight, true, '飞行中 flag（h(!0) :19627）');
  assert.strictEqual(f1.selectedDynamicEffectsReady, false, '飞行中特效不点亮（g(!1)）');
  map.emit('moveend');
  const f2 = env.api.getFlightState();
  assert.strictEqual(f2.isProgrammaticCameraFlight, false);
  assert.strictEqual(f2.selectedDynamicEffectsReady, true, 'moveend 点亮（gt/g(!0) :19629）');
  // ④-5b 后常驻 moveend 视窗机监听 1 个（Ye :13568-13575）；飞行一次性监听自摘 → 再发不变
  assert.strictEqual(map.handlerCount('moveend'), 1, '仅存常驻视窗监听');
  map.emit('moveend');
  assert.strictEqual(map.handlerCount('moveend'), 1, '一次性 gt 已自摘（:19629）');
  env.api.unmount();
});

test('在途飞行互相取消：第二次 flyTo 先摘旧 moveend（moveend 序列不脏）（zn :19603）', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(12);
  withDeckOverlay(env, map, {});
  await env.api.mount(map, env.overlay, { stations: [station('a', 121), station('b', 139)] });
  const sts = env.api.getState().stations;
  env.api.flyToStation(sts[0]);
  env.api.flyToStation(sts[1]);
  // ④-5b：moveend = 常驻视窗机监听 1 + 飞行一次性 1 = 2（旧断言 1 为仅飞行监听）
  assert.strictEqual(map.handlerCount('moveend'), 2, '同一时刻只挂一个飞行 moveend（另 1 为常驻视窗机）');
  map.emit('moveend');
  assert.strictEqual(env.api.getFlightState().isProgrammaticCameraFlight, false);
  assert.strictEqual(map.handlerCount('moveend'), 1, '旧飞行监听被互摘/自摘，仅剩常驻');
  env.api.unmount();
});

test('卸载摘除飞行 moveend 监听（zn 卸载 effect :19598-19600）', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(12);
  withDeckOverlay(env, map, {});
  await env.api.mount(map, env.overlay, { stations: [station('a', 121)] });
  env.api.flyToStation(env.api.getState().stations[0]);
  env.api.unmount();
  assert.strictEqual(map.handlerCount('moveend'), 0);
});

// ---------------------------------------------------------------------------
// ④-3 头像层（Hh :11094-11179 / Kh-qh :11180-11320 / Lm-Rm :12978-13009 / 组装 :13506-13514）
// ---------------------------------------------------------------------------

test('头像常量逐字：Bh=256 / Uh=128（:11020-11021）+ Kh defaultProps 与调用点覆盖（qh :11180-11188 vs :13506-13514）', () => {
  assert.strictEqual(API.AVATAR_ICON_SIZE_HTTP, 256);   // Bh：http(s) 头像
  assert.strictEqual(API.AVATAR_ICON_SIZE_LOCAL, 128);  // Uh：data:/相对
  assert.deepStrictEqual(API.GLOW_AVATAR_DEFAULTS, {
    pickable: false, visible: true, opacity: 1,
    defaultColor: [100, 200, 255], glowRadius: 30, avatarSize: .6, elevation: 50
  });
  // 调用点覆盖值逐字（:13511-13514）
  assert.strictEqual(API.AVATAR_LAYER_ID, 'station-avatar-layer');
  assert.strictEqual(API.AVATAR_GLOW_RADIUS, 200);
  assert.strictEqual(API.AVATAR_SIZE, .18);
  assert.strictEqual(API.ELEVATION_BASE, 80); // 调用点 elevation: fs（:13513，fs :10692）
  assert.strictEqual(API.AVATAR_PICKABLE, true);
});

test('initialsAvatarUrl 逐字：128×128 圆形渐变 SVG + 首字符大写 + Va 调色板 + (hue+40)%360 + 缓存（cs/Wl/ls/zd/Hd :4124-4165）', () => {
  const url = API.initialsAvatarUrl('上海', '上海');
  assert.ok(url.startsWith('data:image/svg+xml,'), '必须 data URI（cs :4163）');
  const svg = decodeURIComponent(url.slice('data:image/svg+xml,'.length));
  assert.match(svg, /width="128" height="128" viewBox="0 0 128 128"/);
  assert.match(svg, /<rect width="128" height="128" rx="64" fill="url\(#g\)"/);
  assert.match(svg, /<text x="64" y="82" text-anchor="middle" font-size="64" font-family="Arial,sans-serif" font-weight="bold" fill="white">上<\/text>/);
  // hash("上海")=647341 → %10=1 → Va[1]=200，c=(200+40)%360=240（zd :4127-4131 + Va :4124）
  assert.match(svg, /stop-color="hsl\(200,70%,45%\)"/);
  assert.match(svg, /stop-color="hsl\(240,80%,55%\)"/);
  // 同 key 缓存命中同一串（Ga :4125/4150-4151）
  assert.strictEqual(API.initialsAvatarUrl('上海', '上海'), url);
  // XML 转义（Hd :4133-4135）：Wl 只取码点首字符，转义作用于该字符
  assert.match(decodeURIComponent(
    API.initialsAvatarUrl('A&B', 'x').slice('data:image/svg+xml,'.length)),
    /fill="white">A</);
  assert.match(decodeURIComponent(
    API.initialsAvatarUrl('<b>', 'x').slice('data:image/svg+xml,'.length)),
    /fill="white">&lt;<\/text>/);
});

test('stationAvatarUrl（Ur :7264-7267 本地数据面）：avatarUrl 直喂；无头像 → 首字母 SVG；system+countryCode 旗标面归④-5', () => {
  const withUrl = API.stationAvatarUrl({ id: 's', name: 'x', avatarUrl: 'https://cdn/a.png' });
  assert.strictEqual(withUrl, 'https://cdn/a.png', '有 avatarUrl 直接透传');
  const plain = API.stationAvatarUrl({ id: 's', name: '东京' });
  assert.strictEqual(plain, API.initialsAvatarUrl('东', '东京'));
  const sys = API.stationAvatarUrl({ id: 's', name: 'Berlin', ownerType: 'system', countryCode: 'DE' });
  // displayKind ?? ownerType === 'system' 且有 countryCode → hearthere 走旗标 SVG（Qf）；
  // 本地无该数据面时按裁决回退首字母，但不得凭空造旗标
  assert.ok(typeof sys === 'string' && sys.length > 0);
});

test('stationAvatarData（Lm :12978-12987）：color=colorTop / itemOpacity 恒 1（S :10702）/ itemElevation=K 逐字', () => {
  const st = station('sys', 121, { ownerType: 'system' });
  const rec = API.stationAvatarData(st);
  assert.strictEqual(rec.id, 'sys');
  assert.strictEqual(rec.position, st.position, 'position 引用透传（Lm :12981）');
  assert.strictEqual(rec.color, st.colorTop, 'color: t.colorTop（Lm :12983）');
  assert.strictEqual(rec.avatarUrl, API.initialsAvatarUrl('S', 'sys'),
    '无 name → Ur 回落 id（ls(t.name ?? t.id) :7266）');
  assert.strictEqual(rec.itemOpacity, 1, 'getAvatarOpacity 恒 1（S :10702）');
  assert.strictEqual(rec.itemElevation, 290, 'expanded 谓词命中 → K=Mn 290（:13265）');
  const plain = API.stationAvatarData(station('p', 139));
  assert.strictEqual(plain.itemElevation, undefined, '非选中非展开 → undefined（q 回落 elevation）');
});

test('CircleAvatarLayer 圆形裁剪 GLSL 逐字（Hh.getShaders :11162-11175）：discard + smoothstep(0.95,1.0)', () => {
  const fs1 = API.SHADER_INJECT_CIRCLE;
  assert.match(fs1, /if \(picking\.isActive < 0\.5\) \{/);
  assert.match(fs1, /float dist = length\(uv\);/);
  assert.match(fs1, /if \(dist > 1\.0\) \{/);
  assert.match(fs1, /discard;/);
  assert.match(fs1, /float edge = smoothstep\(0\.95, 1\.0, dist\);/);
  assert.match(fs1, /fragColor\.a \*= \(1\.0 - edge\);/);
});

test('GlowAvatarLayer.renderLayers 逐字（Kh :11231-11315）：glow 子层半径 200m/加法混合/itemElevation 回落 + avatar 子层图标尺寸 72m/cors', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(14);
  withDeckOverlay(env, map, {});
  await env.api.mount(map, env.overlay, { stations: [station('a', 121)] });
  const Composite = env.sandbox.StellaflixVideo.worldLighthouseDeck.__GlowAvatarLayerCtor;
  assert.ok(Composite, '必须导出 GlowAvatarLayer 类供校验（Kh）');
  const recs = env.api.getState().stations.map(API.stationAvatarData);
  const inst = new Composite({
    id: 'x', data: recs,
    glowRadius: 200, avatarSize: .18, pickable: true // 调用点值（:13511-13514）；elevation 留默认 50 验证 ?? 回落
  });
  const subs = inst.renderLayers();
  assert.strictEqual(subs.length, 2, 'composite = [glow 子层, avatar 子层]（:11315）');
  const glow = subs[0], av = subs[1];
  assert.strictEqual(glow.props.id, 'x-glow');
  assert.strictEqual(av.props.id, 'x-avatar');
  assert.strictEqual(glow.props.getRadius(recs[0]), 200, 'glowRadius 直通（:11259）');
  assert.strictEqual(glow.props.radiusUnits, 'meters');
  assert.strictEqual(JSON.stringify(glow.props.getFillColor({ color: [1, 2, 3], itemOpacity: .5 })),
    JSON.stringify([1, 2, 3, 127.5]), 'alpha = itemOpacity*255（:11261-11265）');
  assert.strictEqual(JSON.stringify(glow.props.getFillColor({ itemOpacity: 1 })),
    JSON.stringify([100, 200, 255, 255]), 'color 缺省回落 defaultColor（:11262）');
  assert.strictEqual(JSON.stringify(glow.props.parameters.blendFunc), JSON.stringify([770, 1]),
    '加法混合逐字（:11268）');
  assert.strictEqual(av.props.getSize(recs[0]), 200 * 2 * .18, 'size = glowRadius*2*avatarSize（:11279）');
  assert.strictEqual(av.props.sizeUnits, 'meters');
  assert.strictEqual(av.props.loadOptions.fetch.mode, 'cors', '头像跨域取图（:11299-11303）');
  assert.strictEqual(JSON.stringify(av.props.getPosition({ position: [1, 2], itemElevation: 290 })),
    JSON.stringify([1, 2, 290]), 'getPosition = [lon,lat, itemElevation ?? elevation]（:11295）');
  assert.strictEqual(JSON.stringify(av.props.getPosition({ position: [1, 2] })),
    JSON.stringify([1, 2, 50]), 'itemElevation 缺省回落 elevation prop（?? f）');
  const icon = av.props.getIcon({ avatarUrl: 'https://cdn/a.png' });
  assert.strictEqual(icon.width, 256); // http → Bh（:11287-11292）
  const icon2 = av.props.getIcon({ avatarUrl: 'data:image/svg+xml,x' });
  assert.strictEqual(icon2.width, 128);
  assert.strictEqual(icon2.anchorY, 64);
  env.api.unmount();
});

test('组装顺序逐字（ht :13506-13514）：glow → station-avatar-layer → warmup；b.length>0 才挂头像层', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(12); // ④-5b：Sr 门 sc=11，zoom10 头像 data 归 Tm 空——升到开门档
  withDeckOverlay(env, map, {});
  await env.api.mount(map, env.overlay, { stations: [station('a', 121)] });
  const ids = lastLayers(env).map((l) => l.props.id);
  assert.strictEqual(JSON.stringify(ids),
    JSON.stringify(['station-glow-layer', 'station-avatar-layer', 'lighthouse-warmup-layer']),
    '头像层必须夹在光晕层与预热层之间（:13506-13514）');
  const av = layerById(env, 'station-avatar-layer');
  assert.strictEqual(av.props.glowRadius, 200);
  assert.strictEqual(av.props.avatarSize, .18);
  assert.strictEqual(av.props.elevation, 80);   // fs
  assert.strictEqual(av.props.pickable, true);
  assert.strictEqual(av.props.visible, true);
  assert.strictEqual(av.props.data.length, 1);
  assert.strictEqual(av.props.data[0].id, 'a');

  // 空站表：不建头像层（b.length>0 守卫 :13506），其余层照常
  await env.api.mount(map, env.overlay, { stations: [] });
  assert.strictEqual(JSON.stringify(lastLayers(env).map((l) => l.props.id)),
    JSON.stringify(['station-glow-layer', 'lighthouse-warmup-layer']));
  env.api.unmount();
});

test('elevation tween 每 tick 重建头像数据（ht 依赖 K/p + A :10729 节拍；P 后必须组装）', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(12); // ④-5b Sr 门（sc=11）：zoom10 头像数据归 Tm，取 12 开门查数据面
  withDeckOverlay(env, map, {});
  await env.api.mount(map, env.overlay, { stations: [station('a', 121)] });
  env.api.setSelected('a');
  env.clock.advance(50 + 336);
  const k = 336 / 700;
  const expected = 80 + 210 * (1 - Math.pow(1 - k, 3));
  const av = layerById(env, 'station-avatar-layer');
  assert.ok(av, '选中态头像层仍在');
  assert.strictEqual(av.props.data.length, 1);
  assert.ok(Math.abs(av.props.data[0].itemElevation - expected) < 1e-9,
    `tick 后组装必须携带新 itemElevation：${av.props.data[0].itemElevation} vs ${expected}`);
  env.clock.advance(700 - 336 + 16);
  assert.strictEqual(layerById(env, 'station-avatar-layer').props.data[0].itemElevation, 290);
  env.api.unmount();
});
