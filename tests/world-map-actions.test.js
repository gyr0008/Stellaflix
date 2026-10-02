'use strict';

/**
 * 世界页 Task 6 — 交互行为层（public/video/world-map-actions.js）
 * 运行：node --test tests/world-map-actions.test.js
 *
 * 双装载：__flyOptions / __resetOptions / __spinStep 等纯配置经
 * module.exports 守卫供 Node 直连（同 world-lighthouse-deck.js 模式）；
 * 浏览器面（flyTo/easeTo 接线、自转 rAF 链、拖拽暂停、快捷键）用
 * vm 沙箱 + 假 maplibre map 驱动真实源码。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const MODULE_PATH = path.join(root, 'public', 'video', 'world-map-actions.js');

// 干净直连 require（文件不存在时此处即 RED）
const API = require(MODULE_PATH);
const SRC = fs.readFileSync(MODULE_PATH, 'utf8');

const approx = (a, b, eps) => Math.abs(a - b) < (eps || 1e-9);

// ---------------- 纯配置面（brief Step 1 原文 + 扩展） ----------------

test('flyTo 参数对齐 hearthere：zoom16/pitch60/2800ms（main.pretty.js:19062-19064、:19636）', () => {
  const opts = API.__flyOptions({ position: [116.4, 39.9] });
  assert.deepEqual(opts, { center: [116.4, 39.9], zoom: 16, pitch: 60, duration: 2800 });
});

test('__flyOptions 兼容 station.position 与房间 lon/lat 两种形状', () => {
  assert.deepEqual(API.__flyOptions({ lon: 121.47, lat: 31.23 }).center, [121.47, 31.23]);
  assert.deepEqual(API.__flyOptions({ position: [2.35, 48.86] }).center, [2.35, 48.86]);
});

test('重置视角参数 = world-globe 初始视图同款（center [104,35] / zoom 2.5 / pitch 0 / 1200ms）', () => {
  assert.deepEqual(API.__resetOptions(), { center: [104, 35], zoom: 2.5, pitch: 0, duration: 1200 });
});

test('自转经度步进（轮⑬ 经度漂移法）：0.25°/s 向西 drift = 24h 改 24min，zoom 联动减速', () => {
  // 24min/圈 → 360/1440 = 0.25°/s
  assert.equal(API.SPIN_DEG_PER_SEC, 0.25, '一圈=1440s（真实24h→24min）');
  // 方向：相机中心经度持续减小 → 地表在视野中向东（右）移 = 真实自转方向
  assert.ok(approx(API.__spinStep(10, 2.5, 1000), 9.75), '满速 1s → -0.25°');
  assert.ok(approx(API.__spinStep(0, 2.5, 4000), -1), '4s → -1°');
  assert.ok(approx(API.__spinStep(0, 2.5, 16), -0.004), '帧率无关：16ms → -0.004°');
  // zoom 联动（Mapbox globe-spin 同款）：z≤3 满速，z≥5 停转，中间线性衰减
  assert.ok(approx(API.__spinStep(0, 3, 1000), -0.25), 'z3 满速');
  assert.ok(approx(API.__spinStep(0, 4, 1000), -0.125), 'z4 半速');
  assert.ok(approx(API.__spinStep(0, 5, 1000), 0), 'z5 停转（防城市视角刷屏）');
  assert.ok(approx(API.__spinStep(0, 13, 1000), 0), '高倍恒停');
  // 经度回绕到 [-180,180)
  assert.ok(approx(API.__spinStep(-179.9, 2.5, 1000), 179.85), '过 -180 回绕到东经');
  assert.ok(approx(API.__spinStep(179.9, 2.5, -1000 * 0), 179.9), 'dt=0 不动');
  for (const lng of [-540.5, -181, -180, 0, 45.25, 179.99, 540]) {
    const n = API.__spinStep(lng, 2.5, 1000);
    assert.ok(n >= -180 && n < 180, `步进结果 ${n}（自 ${lng}）应落在 [-180,180)`);
  }
});

// ---------------- 浏览器面（vm 沙箱 + 假 map） ----------------

function makeFakeMap() {
  const handlers = {};
  const canvas = { style: {} };
  const log = { flyTo: [], easeTo: [], jumpTo: [] };
  const map = {
    handlers, canvas, log,
    _bearing: 0, _zoom: 13, _center: { lng: 0, lat: 0 },
    on(ev, h) { (handlers[ev] = handlers[ev] || []).push(h); },
    off(ev, h) {
      const arr = handlers[ev] || [];
      const i = arr.indexOf(h);
      if (i >= 0) arr.splice(i, 1);
    },
    emit(ev, e) { (handlers[ev] || []).slice().forEach((h) => h(e || {})); },
    getZoom() { return map._zoom; },
    getBearing() { return map._bearing; },
    getCenter() { return map._center; },
    getCanvas() { return canvas; },
    project(lngLat) { return { x: 400, y: 300 }; },
    flyTo(o) { log.flyTo.push(o); map._bearing = o.bearing != null ? o.bearing : map._bearing; return map; },
    easeTo(o) { log.easeTo.push(o); if (o.bearing != null) map._bearing = o.bearing; return map; },
    jumpTo(o) {
      log.jumpTo.push(o);
      if (o.center) map._center = { lng: o.center[0], lat: o.center[1] };
      return map;
    }
  };
  return map;
}

function makeUiStub() {
  return {
    calls: { toast: [], hideCard: [], setRotateState: [] },
    cardEl: null,
    toast(msg) { this.calls.toast.push(msg); },
    hideCard() { this.calls.hideCard.push(1); this.cardEl = null; },
    setRotateState(on) { this.calls.setRotateState.push(on); }
  };
}

function makeDeckStub(stations, selectedId) {
  return {
    calls: { setSelected: [] },
    getState() { return { stations: stations || [], selectedId: selectedId || null, visible: true }; },
    setSelected(id) { this.calls.setSelected.push(id); }
  };
}

// rAF 手动泵：队列 + run(n) 执行 n 帧
function makeRaf() {
  let id = 0;
  const queue = new Map();
  return {
    queue,
    requestAnimationFrame(cb) { id++; queue.set(id, cb); return id; },
    cancelAnimationFrame(h) { queue.delete(h); },
    run(n) {
      const count = n || 1;
      for (let i = 0; i < count; i++) {
        const keys = Array.from(queue.keys());
        if (!keys.length) return;
        const cb = queue.get(keys[0]);
        queue.delete(keys[0]);
        cb(performanceNow());
      }
    },
    pending() { return queue.size; }
  };
}
let _t = 0;
function performanceNow() { return (_t += 16); }

function loadActions(sandbox) {
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return sandbox.StellaflixVideo.worldMapActions;
}

function makeSandbox() {
  const raf = makeRaf();
  const keyHandlers = [];
  const store = {};
  const sandbox = {
    console, Promise,
    requestAnimationFrame: raf.requestAnimationFrame,
    cancelAnimationFrame: raf.cancelAnimationFrame,
    performance: { now: performanceNow },
    addEventListener(ev, fn) { if (ev === 'keydown') keyHandlers.push(fn); },
    removeEventListener() {},
    localStorage: {
      getItem(k) { return store[k] != null ? store[k] : null; },
      setItem(k, v) { store[k] = String(v); },
      removeItem(k) { delete store[k]; }
    },
    _store: store,
    _keyHandlers: keyHandlers,
    _raf: raf
  };
  sandbox.window = sandbox;
  return sandbox;
}

function fireKey(sandbox, key, extra) {
  const e = Object.assign({
    key, preventDefault() {}, stopImmediatePropagation() {}, stopPropagation() {},
    target: { tagName: 'BODY' }
  }, extra || {});
  sandbox._keyHandlers.slice().forEach((h) => h(e));
}

const STATIONS = [
  { id: 'a', name: 'A', position: [116.4, 39.9], status: 'playing' },
  { id: 'b', name: 'B', position: [121.5, 31.2], status: 'online' }
];

test('mount 后导出面齐全（page-world 消费面）', () => {
  const sandbox = makeSandbox();
  const acts = loadActions(sandbox);
  for (const fn of ['mount', 'unmount', 'flyTo', 'resetView', 'setAutoRotate', 'isFavorite', 'toggleFavorite']) {
    assert.strictEqual(typeof acts[fn], 'function', `应有 ${fn}`);
  }
  assert.equal(typeof acts.autoRotate, 'boolean');
});

test('flyTo(st) → map.flyTo 收到 __flyOptions 全套参数', () => {
  const sandbox = makeSandbox();
  const map = makeFakeMap();
  const acts = loadActions(sandbox);
  acts.mount(map, { ui: makeUiStub(), deck: makeDeckStub(STATIONS) });
  acts.flyTo(STATIONS[0]);
  assert.equal(map.log.flyTo.length, 1);
  assert.deepEqual(map.log.flyTo[0], { center: [116.4, 39.9], zoom: 16, pitch: 60, duration: 2800 });
  acts.unmount();
});

test('reset（R 语义）→ map.easeTo 回初始全球视图并停自转', () => {
  const sandbox = makeSandbox();
  const map = makeFakeMap();
  const ui = makeUiStub();
  const acts = loadActions(sandbox);
  acts.mount(map, { ui, deck: makeDeckStub(STATIONS) });
  acts.setAutoRotate(true);
  acts.resetView();
  assert.equal(map.log.easeTo.length >= 1, true, 'easeTo 应被调用');
  assert.deepEqual(
    { center: map.log.easeTo[0].center, zoom: map.log.easeTo[0].zoom, pitch: map.log.easeTo[0].pitch, duration: map.log.easeTo[0].duration },
    { center: [104, 35], zoom: 2.5, pitch: 0, duration: 1200 });
  assert.equal(acts.autoRotate, false, '重置视角同时停自转（沿旧 world-actions 语义）');
  acts.unmount();
});

test('自转循环（轮⑬）：flag 开时每帧 jumpTo 向西 drift 中心经度；flag 关不再调用', () => {
  const sandbox = makeSandbox();
  const map = makeFakeMap();
  map._zoom = 2.5; // 全球档满速区
  const acts = loadActions(sandbox);
  acts.mount(map, { ui: makeUiStub(), deck: makeDeckStub(STATIONS) });
  acts.setAutoRotate(true);
  sandbox._raf.run(4); // 首帧只做时基（dt=0 不动相机），第 2 帧起 drift
  assert.equal(map.log.jumpTo.length, 3, '4 帧应有 3 次 jumpTo（首帧时基）');
  assert.ok(approx(map.log.jumpTo[0].center[0], -0.004), '首个 drift 帧 -0.004（16ms×0.25°/s）');
  assert.ok(approx(map.log.jumpTo[2].center[0], -0.012), '第三帧累积 -0.012');
  assert.equal(map.log.jumpTo[0].center[1], 0, '纬度不动（只 drift 经度）');
  acts.setAutoRotate(false);
  map.log.jumpTo.length = 0;
  sandbox._raf.run(3);
  assert.equal(map.log.jumpTo.length, 0, '关旗后不得再驱动相机');
  acts.unmount();
});

test('高倍率（z≥5）自转停转：不产生 jumpTo（Mapbox globe-spin 同款防刷屏）', () => {
  const sandbox = makeSandbox();
  const map = makeFakeMap();
  map._zoom = 13;
  const acts = loadActions(sandbox);
  acts.mount(map, { ui: makeUiStub(), deck: makeDeckStub(STATIONS) });
  acts.setAutoRotate(true);
  sandbox._raf.run(3);
  assert.equal(map.log.jumpTo.length, 0, '城市档零步进即零调用');
  acts.unmount();
});

test('拖拽暂停：dragstart 期间不 drift，dragend 恢复（flag 仍开）', () => {
  const sandbox = makeSandbox();
  const map = makeFakeMap();
  map._zoom = 2.5;
  const acts = loadActions(sandbox);
  acts.mount(map, { ui: makeUiStub(), deck: makeDeckStub(STATIONS) });
  acts.setAutoRotate(true);
  map.emit('dragstart');
  map.log.jumpTo.length = 0;
  sandbox._raf.run(2);
  assert.equal(map.log.jumpTo.length, 0, '拖拽中暂停 drift');
  map.emit('dragend');
  sandbox._raf.run(1);
  assert.equal(map.log.jumpTo.length, 1, '松手且 flag 开 → 恢复');
  acts.unmount();
});

test('unmount 停掉自转 rAF 循环：之后再泵帧不产生 jumpTo', () => {
  const sandbox = makeSandbox();
  const map = makeFakeMap();
  map._zoom = 2.5;
  const acts = loadActions(sandbox);
  acts.mount(map, { ui: makeUiStub(), deck: makeDeckStub(STATIONS) });
  acts.setAutoRotate(true);
  sandbox._raf.run(1);
  acts.unmount();
  map.log.jumpTo.length = 0;
  sandbox._raf.run(5); // 队列应已被 cancel 清空
  assert.equal(map.log.jumpTo.length, 0, 'unmount 后循环必须终止');
  assert.equal(sandbox._raf.pending(), 0, '不应遗留 rAF 排队');
});

test('键盘回归：Esc 关面板 / A 切自转 / F 收藏选中信标 / 输入框内不拦截', () => {
  const sandbox = makeSandbox();
  const map = makeFakeMap();
  const ui = makeUiStub();
  const deck = makeDeckStub(STATIONS, 'a');
  // ④-4 换代：关卡片面从 worldUi.cardEl/hideCard 迁到 worldHtPanel（It(null) 语义）
  const panel = {
    closed: 0, _open: true,
    isOpen() { return panel._open; },
    close() { if (panel._open) { panel.closed++; panel._open = false; } },
    panelEl() { return panel._open ? { __station: STATIONS[0] } : null; }
  };
  const acts = loadActions(sandbox);
  sandbox.StellaflixVideo.worldHtPanel = panel;
  acts.mount(map, { ui, deck });

  let escConsumed = false;
  fireKey(sandbox, 'Escape', { preventDefault() { escConsumed = true; } });
  assert.equal(panel.closed, 1, '面板开着时 Esc 应关面板');
  assert.equal(escConsumed, true, '关面板的 Esc 必须吃掉事件（不冒泡给 App）');

  const before = acts.autoRotate;
  fireKey(sandbox, 'a');
  assert.equal(acts.autoRotate, !before, 'A 切换自转');
  assert.deepEqual(ui.calls.setRotateState[ui.calls.setRotateState.length - 1], acts.autoRotate);

  acts.toggleFavorite(STATIONS[0]); // 预置收藏 a
  assert.equal(acts.isFavorite('a'), true);
  fireKey(sandbox, 'f');
  assert.equal(acts.isFavorite('a'), false, 'F 对 deck 选中信标取反收藏');

  escConsumed = false;
  fireKey(sandbox, 'Escape', { preventDefault() { escConsumed = true; } });
  assert.equal(panel.closed, 1, '面板已关：不再重复 close');
  assert.equal(escConsumed, false, '面板已关的 Esc 放行给 App（关闭浏览层）');

  let consumed = false;
  fireKey(sandbox, 'r', {
    target: { tagName: 'INPUT' },
    preventDefault() { consumed = true; }
  });
  assert.equal(consumed, false, '输入框内不得拦键');
  acts.unmount();
});

test('收藏持久化沿用旧键 stellaflix-world-favorites（旧页收藏不丢）', () => {
  const sandbox = makeSandbox();
  const acts = loadActions(sandbox);
  assert.equal(API.FAV_KEY, 'stellaflix-world-favorites');
  acts.toggleFavorite({ id: 'x', name: 'X' });
  assert.equal(acts.isFavorite('x'), true);
  assert.ok(String(sandbox._store['stellaflix-world-favorites'] || '').indexOf('x') >= 0,
    '应写入 localStorage 同一键');
});

test('index.html 注册 world-map-actions.js 且先于 page-world.js', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const iMa = html.indexOf('"video/world-map-actions.js"');
  const iPw = html.indexOf('"video/page-world.js"');
  assert.ok(iMa >= 0, 'world-map-actions.js 应在 SFV_SCRIPTS 中');
  assert.ok(iMa < iPw, '应先于 page-world.js 加载');
  assert.strictEqual((html.match(/video\/world-map-actions\.js/g) || []).length, 1);
});

test('world-map-actions.js 语法合法', () => {
  const { execFileSync } = require('node:child_process');
  execFileSync(process.execPath, ['--check', MODULE_PATH], {
    encoding: 'utf8', stdio: 'pipe'
  });
});
