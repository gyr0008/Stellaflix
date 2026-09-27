'use strict';

/**
 * 世界页 Task 4 — deck 灯塔层（public/video/world-lighthouse-deck.js）
 * 运行：node --test tests/world-lighthouse-deck.test.js
 *
 * 纯数据断言（roomToStation / getColor / sizeOf / tierVisible / WARMUP）经
 * 双装载守卫直接 require（同 world-lighthouse-model.js 模式）；
 * WebGL 依赖部分（层类 / mount）用源码正则断言 GLSL 移植与接线保真度。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const MODULE_PATH = path.join(root, 'public', 'video', 'world-lighthouse-deck.js');

// 干净直连 require（exports 守卫启用；文件不存在时此处即 RED）
const API = require(MODULE_PATH);
const SRC = fs.readFileSync(MODULE_PATH, 'utf8');

// ---------------- 纯数据 / 配置断言（brief Step 1 原文） ----------------

test('roomToStation 字段映射：lon/lat/status/双色', () => {
  const st = API.roomToStation({ id: 'r1', longitude: 116.4, latitude: 39.9,
    status: 'playing', color_top: [255, 120, 0], color_bottom: [0, 120, 255] });
  assert.deepEqual(st.position, [116.4, 39.9]);
  assert.equal(st.status, 'playing');
  assert.deepEqual(st.colorTop, [255, 120, 0]);
  assert.deepEqual(st.colorBottom, [0, 120, 255]);
});

test('roomToStation 兼容 world-data 归一化房间（lon/lat、colorTop 已在 station 形状则透传）', () => {
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

test('离线塔不激活：getColor alpha=0（对齐 main.pretty.js:11506）', () => {
  assert.deepEqual(API.getColor({ status: 'offline' }), [255, 255, 255, 0]);
  assert.deepEqual(API.getColor({ status: 'playing' }), [255, 255, 255, 255]);
  assert.deepEqual(API.getColor({ status: 'online' }), [255, 255, 255, 255]);
});

test('尺寸分级：选中 290 / 未选中 150（:10691 调整值）', () => {
  assert.equal(API.sizeOf({ id: 'a' }, 'a'), 290);
  assert.equal(API.sizeOf({ id: 'b' }, 'a'), 150);
  assert.equal(API.sizeOf({ id: 'a' }, null), 150, '无选中时一律 150');
});

test('zoom 门限：12.5 以下灯塔层 visible=false（:10609）', () => {
  assert.equal(API.tierVisible(11.4), false);
  assert.equal(API.tierVisible(12.5), true);
  assert.equal(API.tierVisible(13.5), true);
});

test('预热站常量：(0,0) opacity 0.001（:13164-13177）', () => {
  assert.deepEqual(API.WARMUP.data[0].position, [0, 0]);
  assert.equal(API.WARMUP.opacity, 0.001);
  assert.equal(API.WARMUP.data[0].id, '__lighthouse-warmup__');
  assert.equal(API.WARMUP.id, 'lighthouse-warmup-layer');
});

test('getState 空态契约（Task 6 消费面）', () => {
  const s = API.getState();
  assert.ok(s && Array.isArray(s.stations), 'stations 应为数组');
  assert.equal(s.selectedId, null);
  assert.equal(typeof s.visible, 'boolean');
});

// ---------------- GLSL 移植保真（源码正则，repo 风格） ----------------

test('GLSL 移植：rim pow 6 / 垂直渐变 / 等比扫描 / 亮度 / 入场 discard 全部在 inject 段内', () => {
  // rim 光照（hearthere :11365-11369）
  assert.match(SRC, /float rim = 1\.0 - NdotV;/);
  assert.match(SRC, /float rimIntensity = pow\(rim, 6\.0\);/);
  // 垂直渐变 mix(colorBottom, colorTop, ratio)（:11372-11375）
  assert.match(SRC, /float ratio = clamp\(vModelHeight \/ modelHeight, 0\.0, 1\.0\);/);
  assert.match(SRC, /vec3 activeColor = mix\(colorBottom, colorTop, ratio\);/);
  // 激活扫描 -3→13 @9.22 等比到 MODEL_HEIGHT=9.3：-0.325 / +1.41（controller ruling 3）
  assert.match(SRC, /float scanY = mix\(modelHeight \* -0\.325, modelHeight \* 1\.41, activationProgress\);/);
  assert.match(SRC, /float activeness = 1\.0 - smoothstep\(scanY, scanY \+ 2\.0, vModelHeight\);/);
  // 扫描线辉光 exp(-|h-(scanY+1)|)（:11379-11380）
  assert.match(SRC, /float isAnimating = smoothstep\(0\.0, 0\.1, activationProgress\) \* smoothstep\(1\.0, 0\.9, activationProgress\);/);
  assert.match(SRC, /float scanLine = exp\(-1\.0 \* abs\(vModelHeight - \(scanY \+ 1\.0\)\)\) \* isAnimating;/);
  // 灰底 vec3(0.35, 0.4, 0.55)（:11372）
  assert.match(SRC, /vec3 colorGray = vec3\(0\.35, 0\.4, 0\.55\);/);
  assert.match(SRC, /baseColor \+= vec3\(1\.0\) \* scanLine \* 0\.8;/);
  // 动态亮度 mix(0.7, min(2.0, 1/max(0.01, maxComponent)), activeness)（:11388-11397）
  assert.match(SRC, /float maxSafeGain = 1\.0 \/ max\(0\.01, maxComponent\);/);
  assert.match(SRC, /float targetActiveBrightness = min\(2\.0, maxSafeGain\);/);
  assert.match(SRC, /float brightness = mix\(0\.7, targetActiveBrightness, activeness\);/);
  // alpha mix(0.8, rim*1.5+0.6, activeness)（:11399-11402）
  assert.match(SRC, /float alphaActive = rimIntensity \* 1\.5 \+ 0\.6;/);
  assert.match(SRC, /float finalAlpha = mix\(alphaRest, alphaActive, activeness\);/);
  // 入场扫描（entranceProgress）：brief Step 3 等比式 + 高于入场扫描线的片段 discard（:11428-11433 语义）
  assert.match(SRC, /float entranceProgress = vEntranceProgress;/);
  assert.match(SRC, /float entranceScanY = mix\(-0\.33, 1\.08, entranceProgress\) \* modelHeight;/);
  assert.ok(new RegExp('entranceScanY[\\s\\S]{0,600}discard').test(SRC),
    'discard 应位于入场扫描段内（高于 entranceScanY 不可见）');
  // vs 透传四属性（:11346-11360）
  assert.match(SRC, /in vec3 instanceColorTop;/);
  assert.match(SRC, /in vec3 instanceColorBottom;/);
  assert.match(SRC, /in float instanceLayerOpacity;/);
  assert.match(SRC, /in float instanceEntranceProgress;/);
  assert.match(SRC, /vModelHeight = positions\.y;/);
});

// ---------------- 接线保真（层工厂 / 预热 / 分级 / picking） ----------------

test('接线：transitions 1000ms、getOrientation [0,0,90]、程序化 Mesh（UINT16 索引）', () => {
  assert.match(SRC, /transitions: \{/);
  assert.match(SRC, /getColor: 1000/);
  assert.match(SRC, /getColorTop: 1000/);
  assert.match(SRC, /getColorBottom: 1000/);
  assert.match(SRC, /getOrientation: \[0, 0, 90\]/);
  assert.match(SRC, /deck\.Mesh/);
  assert.match(SRC, /UINT16/);
  assert.match(SRC, /positions: \{ value: [^\n]+, size: 3 \}/);
  assert.match(SRC, /normals: \{ value: [^\n]+, size: 3 \}/);
  assert.match(SRC, /indices: \{ value: [^\n]+, size: 3, type: 'UINT16' \}/);
});

test('接线：层数组 = 预热层 + 未选中批(150) + 选中单层(290)，overlay.setProps({layers}) 驱动', () => {
  assert.match(SRC, /SimpleMeshLayer/);
  assert.match(SRC, /setProps\(\{ layers/);
  assert.match(SRC, /SIZE_SELECTED = 290/);
  assert.match(SRC, /SIZE_REST = 150/);
  assert.match(SRC, /TIER_ZOOM = 12\.5/);
  assert.match(SRC, /lighthouse-expanded-batch/);
  assert.match(SRC, /entranceProgress/);
});

test('接线：pickStation 经 overlay.pickObject radius 10（Task 6 契约）', () => {
  assert.match(SRC, /pickObject\(\{ x: x, y: y, radius: 10 \}\)/);
  for (const fn of ['mount', 'unmount', 'refreshStations', 'setSelected', 'applyTier', 'getState', 'pickStation']) {
    assert.ok(new RegExp('\\b' + fn + '\\b').test(SRC), `应提供 ${fn}`);
  }
});

// ---------------- 浏览器装载面（无 deck 时只挂 API，不炸） ----------------

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

// ---------------- index.html 注册顺序 ----------------

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

// ---------------- Task 6 回归：mount epoch token（Task 4 评审 Important） ----------------

test('mount epoch token：不 await 连挂两图，zoom 监听只落在最新 map，旧图零注册', async () => {
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
  const fakeBuilt = {
    indices: new Uint16Array([0, 1, 2]),
    positions: new Float32Array(9).fill(1),
    normals: new Float32Array(9).fill(0),
    modelHeight: 9.3
  };
  const sandbox = {
    console, Promise,
    requestAnimationFrame() { return 1; },
    cancelAnimationFrame() {},
    deck: { SimpleMeshLayer: class { constructor(props) { this.props = props; } } },
    StellaflixVideo: { worldLighthouseModel: { build: () => fakeBuilt } }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const api = sandbox.StellaflixVideo.worldLighthouseDeck;

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

test('mount epoch：过期 handler 即便残留也 no-op（zoom 回调不改当前状态）', async () => {
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
