'use strict';

/**
 * 世界页 Task 4/6 消费面契约 — 步骤③ 迁移件
 * 运行：node --test tests/world-lighthouse-deck-contract.test.js
 *
 * 来源：tests/world-lighthouse-deck.test.js（旧版在步骤③整档 _archive/）。
 * 只保留「新实现下仍成立且不在 hearthere 保真测试覆盖内」的契约：
 * 消费方形状（page-world / world-map-actions）、index.html 注册序、
 * mount epoch 竞态。GLSL/尺寸分级/程序化 Mesh 断言随旧机制退役。
 * 逐字保真断言见 tests/world-lighthouse-deck-hearthere.test.js。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const MODULE_PATH = path.join(root, 'public', 'video', 'world-lighthouse-deck.js');

const API = require(MODULE_PATH);
const SRC = fs.readFileSync(MODULE_PATH, 'utf8');

test('roomToStation 字段映射：lon/lat/status/双色', () => {
  const st = API.roomToStation({ id: 'r1', longitude: 116.4, latitude: 39.9,
    status: 'playing', color_top: [255, 120, 0], color_bottom: [0, 120, 255] });
  assert.deepEqual(st.position, [116.4, 39.9]);
  assert.equal(st.status, 'playing');
  assert.deepEqual(st.colorTop, [255, 120, 0]);
  assert.deepEqual(st.colorBottom, [0, 120, 255]);
});

test('roomToStation 兼容 world-data 归一化房间（lon/lat、station 形状透传）', () => {
  const st = API.roomToStation({ id: 'r2', lon: 121.47, lat: 31.23, status: 'online',
    colorTop: [0.3, 0.6, 0.9], colorBottom: [0.1, 0.2, 0.3] });
  assert.deepEqual(st.position, [121.47, 31.23]);
  assert.deepEqual(st.colorTop, [0.3, 0.6, 0.9]);
  const again = API.roomToStation(st);
  assert.strictEqual(again.position, st.position, '已是 station 形状时不应二次包装');
});

test('缺省双色对齐 hearthere :5581-5582（colorTop [223,204,251] / colorBottom [150,200,254]）', () => {
  assert.deepEqual(API.COLOR_TOP_DEFAULT, [223, 204, 251]);
  assert.deepEqual(API.COLOR_BOTTOM_DEFAULT, [150, 200, 254]);
  const st = API.roomToStation({ id: 'r3', longitude: 0, latitude: 0, status: 'online' });
  assert.deepEqual(st.colorTop, API.COLOR_TOP_DEFAULT);
  assert.deepEqual(st.colorBottom, API.COLOR_BOTTOM_DEFAULT);
});

test('离线塔不激活：getColor alpha=0（zo() :11504-11506）', () => {
  assert.deepEqual(API.getColor({ status: 'offline' }), [255, 255, 255, 0]);
  assert.deepEqual(API.getColor({ status: 'playing' }), [255, 255, 255, 255]);
  assert.deepEqual(API.getColor({ status: 'online' }), [255, 255, 255, 255]);
});

test('zoom 门限：12.5 以下塔身档不可见（St :10609）', () => {
  assert.equal(API.tierVisible(11.4), false);
  assert.equal(API.tierVisible(12.5), true);
  assert.equal(API.tierVisible(13.5), true);
});

test('getState 空态契约（Task 6 消费面）', () => {
  const s = API.getState();
  assert.ok(s && Array.isArray(s.stations), 'stations 应为数组');
  assert.equal(s.selectedId, null);
  assert.equal(typeof s.visible, 'boolean');
});

test('接线：pickStation 经 overlay.pickObject radius 10（Task 6 契约，步骤④换分档拾取）', () => {
  assert.match(SRC, /pickObject\(\{ x: x, y: y, radius: 10 \}\)/);
  for (const fn of ['mount', 'unmount', 'refreshStations', 'setSelected', 'applyTier', 'getState', 'pickStation']) {
    assert.ok(new RegExp('\\b' + fn + '\\b').test(SRC), `应提供 ${fn}`);
  }
});

test('浏览器装载面：挂 SFV.worldLighthouseDeck 且契约函数齐全、未 mount 时 getState 可用', () => {
  const sandbox = { console: console };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  assert.ok(sandbox.StellaflixVideo, '应挂到 globalThis.StellaflixVideo');
  const api = sandbox.StellaflixVideo.worldLighthouseDeck;
  for (const fn of ['mount', 'unmount', 'refreshStations', 'setSelected', 'applyTier', 'getState', 'pickStation']) {
    assert.strictEqual(typeof api[fn], 'function');
  }
  const s = api.getState();
  assert.ok(Array.isArray(s.stations));
  assert.strictEqual(s.selectedId, null);
  assert.strictEqual(s.visible, false, '未挂载时不可见');
  assert.strictEqual(api.pickStation(1, 1), null, '无 overlay 时 pickStation 应安全返回 null');
});

test('index.html 按序注册 world-lighthouse-model.js / world-lighthouse-deck.js（都在 world-ui.js 之前）', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const iModel = html.indexOf('"video/world-lighthouse-model.js"');
  const iDeck = html.indexOf('"video/world-lighthouse-deck.js"');
  const iUi = html.indexOf('"video/world-ui.js"');
  assert.ok(iModel >= 0 && iDeck >= 0 && iUi >= 0, '三个模块都应在 SFV_SCRIPTS 中');
  assert.ok(!/video\/world-lighthouse\.js"/.test(html), '旧 Cesium 灯塔面应已摘除（Task 9 归档 _archive/）');
  assert.ok(iModel < iDeck, 'world-lighthouse-model.js 应先于 world-lighthouse-deck.js');
  assert.ok(iDeck < iUi, 'world-lighthouse-deck.js 应先于 world-ui.js');
  assert.strictEqual((html.match(/video\/world-lighthouse-deck\.js/g) || []).length, 1);
  assert.strictEqual((html.match(/video\/world-lighthouse-model\.js/g) || []).length, 1);
});

// ---------------- Task 6 回归：mount epoch token（沙箱桩随步骤③补全） ----------------

function loadContractSandbox() {
  const sandbox = {
    console, Promise,
    deck: {
      SimpleMeshLayer: class { constructor(props) { this.props = props; } },
      ScatterplotLayer: class { constructor(props) { this.props = props; } }
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return sandbox.StellaflixVideo.worldLighthouseDeck;
}

test('mount epoch token：不 await 连挂两图，zoom 监听只落在最新 map，旧图零注册', async () => {
  const api = loadContractSandbox();
  const mkMap = (zoom) => ({
    zoomHandlers: [],
    on(ev, h) { if (ev === 'zoom') this.zoomHandlers.push(h); },
    off(ev, h) {
      const i = this.zoomHandlers.indexOf(h);
      if (i >= 0) this.zoomHandlers.splice(i, 1);
    },
    getZoom() { return zoom; }
  });
  const fakeOverlay = { setProps() {}, pickObject() { return null; } };

  const mapA = mkMap(13);
  const mapB = mkMap(14);
  // 关键竞态：第一 mount 的 Promise 续体未落地就发起第二次 mount
  const p1 = api.mount(mapA, fakeOverlay, { stations: [] });
  const p2 = api.mount(mapB, fakeOverlay, { stations: [] });
  await Promise.all([p1, p2]);

  assert.strictEqual(mapA.zoomHandlers.length, 0,
    '被取代的 mount 不得在旧 map 上注册 zoom 监听（epoch 校验在 map.on 之前）');
  assert.strictEqual(mapB.zoomHandlers.length, 1, '最新 map 应恰好注册一个监听');

  // 顺序重挂（第一 mount 已落地）：unmount-first 应把旧 handler 摘干净
  const mapC = mkMap(15);
  await api.mount(mapC, fakeOverlay, { stations: [] });
  assert.strictEqual(mapB.zoomHandlers.length, 0, '第二次 mount 的 unmount() 应 off 掉 mapB 监听');
  assert.strictEqual(mapC.zoomHandlers.length, 1);

  api.unmount();
});

test('mount epoch：过期 handler 即便残留也 no-op（zoom 回调不改当前状态）', () => {
  // 直接源码面锁死双保险：map.on('zoom') 之前与回调体内都有 epoch 校验
  assert.ok(/epoch\s*!==\s*mountEpoch[\s\S]{0,400}map\.on\('zoom'/.test(SRC),
    'map.on(zoom) 之前应有 epoch 校验（过期续体整段止步）');
  assert.ok(/onZoomHandler\s*=\s*function[\s\S]{0,200}epoch\s*!==\s*mountEpoch/.test(SRC),
    'zoom 回调体内应有 epoch 校验（残留即 no-op）');
});

test('world-lighthouse-deck.js 语法合法', () => {
  const { execFileSync } = require('node:child_process');
  const r = execFileSync(process.execPath, ['--check', MODULE_PATH], {
    encoding: 'utf8', stdio: 'pipe'
  });
  assert.ok(r === '' || r == null, '语法应通过');
});
