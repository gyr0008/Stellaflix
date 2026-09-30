'use strict';

/**
 * 世界页 步骤④-5 — 选中特效三件套 + 驱动时序 hearthere 保真
 * 运行：node --test tests/world-lighthouse-deck-effects.test.js
 *
 * 基准：_scratch/hearthere/main.pretty.js + _scratch/effects-spec-4-5.md
 *   · ParticleWaveLayer dm/fm :12379-12473（layerName/参数形状/pickable false/depthWrite false）
 *   · 粒子数据 Cm :12907-12932（30 环 × 60 粒子/环 = 1860）、缓存 eg/rr :13158-13187
 *   · PulseRingLayer vm/wm :12512-12646（hm=1 环、phaseOffset=n*1、半径 mm*(1+uc)）
 *   · VolumetricSpotlightLayer bm/Sm/xm/_m :12648-12905（锥体几何 21×33 顶点、
 *     旋转 -(time*6)%360、 getColor 离线 alpha 0、cullMode none/additive blend）
 *   · 驱动 :13576-13707（时基 Ze/ot<=.025 裁剪、Ge ramp 步长 ge=2、vo 三门 on&&Fn&&fh、
 *     vn=3 装配）、节流 km=1000/30 + Am :12933-12949、门控 fh :10637-10639
 *
 * 裁决（用户 2026-09-30「可」）：beacon-blink 两层与 preactivate/warm 网络头像预热不移植
 *（Supabase 面）；Sr 门限并入 ④-5b 头像装配。
 *
 * 风格：仓内惯例——纯函数直连 require；图层 props/装配用 vm 沙箱装载真实模块断言行为。
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
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
// GLSL/类体逐字兜底覆盖 deck+effects 两文件（浏览器即两文件顺序装载，index.html 同序）
const CODE = stripComments(SRC) + '\n' + stripComments(EFFECTS_SRC);

// ---------------------------------------------------------------------------
// 1) 粒子数据 Cm/eg（:12907-12932 / :13180-13187）
// ---------------------------------------------------------------------------

test('Cm 粒子波数据逐字（eg → Cm(t, Ih, Nh=30, jh=60) :12907-12932）：每环计数 floor(jh*(c/30)*1.5)+6，Σ=1575 条，字段 position/phase/distance', () => {
  const pts = API.particleData([121, 31]);
  // 逐字双循环：c=1..Nh，每环 d=floor(jh*(c/Nh)*1.5)+6 → Σ=1575（源算式独立复算）
  const n = API.PARTICLE_RINGS, o = API.PARTICLES_PER_RING; // Nh=30, jh=60 :10962-10963
  assert.strictEqual(n, 30);
  assert.strictEqual(o, 60);
  let expected = 0;
  for (let c = 1; c <= n; c++) expected += Math.floor(o * (c / n) * 1.5) + 6;
  assert.strictEqual(expected, 1575, 'Σ(3c+6) c=1..30 = 1575');
  assert.strictEqual(pts.length, expected, 'Cm 环×每环计数逐字');
  const p = pts[0];
  assert.ok(Array.isArray(p.position) && p.position.length === 3, 'position=[lon,lat,alt]');
  assert.strictEqual(typeof p.phase, 'number');
  assert.strictEqual(typeof p.distance, 'number');
  assert.ok(p.distance >= 0, 'distance（米）非负');
});

test('eg/rr 缓存逐字：同位置二次取回同一数组引用；distance=deg×111e3（Ih 半径域 ≤305m）', () => {
  const a1 = API.particleData([0, 0]);
  const a2 = API.particleData([0, 0]);
  assert.strictEqual(a1, a2, 'rr Map 以 "lon,lat" 为 key 缓存');
  assert.notStrictEqual(API.particleData([1, 1]), a1, '不同位置独立缓存条目');
  let maxD = 0;
  for (const p of a1) maxD = Math.max(maxD, p.distance);
  // 半径 Ih=5*Mt=0.0025deg → 277.5m；Cm 内 w*111e3，w 可随抖动超到 ~1.1×Ih
  assert.ok(maxD > 200 && maxD <= 0.0025 * 1.15 * 111e3, `distance 上限贴合 Ih 半径（实测 ${maxD}）`);
  assert.strictEqual(API.PARTICLE_MAX_DISTANCE, 1e6 * 5e-4, 'Rh = 1e6 × Mt = 500 逐字（:10957，shader maxDistance 空间）');
});

// ---------------------------------------------------------------------------
// 2) PulseRing 数据 ym（:12503-12511）
// ---------------------------------------------------------------------------

test('ym 脉冲环数据逐字：hm=1 → 单环，phaseOffset=n*1，position z=.1*n', () => {
  const rings = API.pulseRingData({ position: [121, 31, 0] });
  assert.strictEqual(rings.length, 1, 'hm=1 环（:12498）');
  assert.strictEqual(rings[0].ringIndex, 0);
  assert.strictEqual(rings[0].phaseOffset, 0);
  assert.deepStrictEqual(rings[0].position, [121, 31, 0]);
});

// ---------------------------------------------------------------------------
// 3) 锥体几何 bm（:12648-12699）
// ---------------------------------------------------------------------------

test('bm 锥体几何逐字（xm 调用点 (.1,6,30,32,20,!1,0) :12836-12864）：(rings+1)×(radial+1)+2 心点、侧壁 r×o×6 索引、盖 2×o 三角（!i 才加帽，压缩语义逐字）', () => {
  const g = API.coneGeometry(.1, 6, 30, 32, 20, false, 0); // xm 实参逐字：i=!1 → caps 分支
  assert.ok(g.positions instanceof Float32Array && g.normals instanceof Float32Array && g.indices instanceof Uint16Array);
  const grid = (20 + 1) * (32 + 1); // 纵向 r=20 层 × 环向 o=32 段
  assert.strictEqual(g.positions.length / 3, grid + 2, 'caps 追加底/顶两个心点');
  assert.strictEqual(g.indices.length, 20 * 32 * 6 + 32 * 3 * 2, '侧壁 3840 + 盖 192 索引');
  for (let i = 0; i < g.normals.length; i += 3) {
    const len = Math.hypot(g.normals[i], g.normals[i + 1], g.normals[i + 2]);
    assert.ok(Math.abs(len - 1) < 1e-5, '法线单位化');
  }
  // xm 缓存：同 mesh 引用复用（sr 单例，bm(.1,6,30,32,20,!1,0)）
  assert.strictEqual(API.spotlightMesh(), API.spotlightMesh(), 'sr 缓存单例');
  const mesh = API.spotlightMesh();
  assert.strictEqual(mesh.topology, 'triangle-list');
  assert.strictEqual(mesh.attributes.positions.size, 3);
});

// ---------------------------------------------------------------------------
// 4) 门控 fh / vo 三门 / ramp / 时基 / 节流（纯函数逐字）
// ---------------------------------------------------------------------------

test('fh 门控逐字（:10637-10639）：status playing 且 lhOpacity>.01 才放行特效', () => {
  assert.strictEqual(API.effectsGateActive({ status: 'playing' }, 0.02), true);
  assert.strictEqual(API.effectsGateActive({ status: 'playing' }, 0.01), false, '> .01 严格大于');
  assert.strictEqual(API.effectsGateActive({ status: 'offline' }, 1), false);
  assert.strictEqual(API.effectsGateActive(null, 1), false);
});

test('vo 三门逐字（:13595）：effectsReady && 选中未变 && fh', () => {
  assert.strictEqual(API.selectedEffectsGate(true, true, true), true);
  assert.strictEqual(API.selectedEffectsGate(false, true, true), false, '飞行未落地（g=false）不放');
  assert.strictEqual(API.selectedEffectsGate(true, false, true), false, '选中刚变（Fn=false）不放');
  assert.strictEqual(API.selectedEffectsGate(true, true, false), false);
});

test('Ge ramp 逐字（:13676-13678）：步长 ge=2×dt、开夹 [0,1]、越界吸附到 target', () => {
  let s = { current: 0, target: 1 };
  s = API.rampStep(s, 0.3);
  assert.strictEqual(s.current, 0.6, '2 × 0.3');
  s = API.rampStep(s, 0.3);
  assert.strictEqual(s.current, 1, '0.6+0.6=1.2 越界 → 吸附 target');
  s = { current: 1, target: 0 };
  s = API.rampStep(s, 0.6);
  assert.strictEqual(s.current, 0, '下行同样吸附');
  s = API.rampStep({ current: 0.5, target: 0.5 }, 0.3);
  assert.strictEqual(s.current, 0.5, 'current===target 不动');
});

test('时基逐字（:13589-13590）：ot = min(deltaSec, 0.025)，me 累加的是未裁剪 Ze', () => {
  assert.strictEqual(API.clampFrameDelta(0.1), 0.025);
  assert.strictEqual(API.clampFrameDelta(0.016), 0.016);
});

test('帧节流逐字（km/Mm/Am :12933-12949）：活跃恒过 30fps 闸；空闲仅过 km 间隔', () => {
  const KM = 1000 / 30;
  const active = { hasActiveSelectedDynamicEffects: true, hasActiveExternalLayers: false, hasSelectionAnimationWindow: false, isProgrammaticCameraFlight: true, hasVisibleSelectedOrExpandedLighthouse: true };
  assert.strictEqual(API.shouldUpdateFrame(active), true, ':12948 活跃门任一为真 → true，不看时间');
  const idle = { hasActiveSelectedDynamicEffects: false, hasActiveExternalLayers: false, hasSelectionAnimationWindow: false, isProgrammaticCameraFlight: false, hasVisibleSelectedOrExpandedLighthouse: false, now: 5000, lastUpdateAt: 5000 - KM - 1 };
  assert.strictEqual(API.shouldUpdateFrame(idle), true, '空闲且已过 km → 30fps 例行刷新');
  const idleTooSoon = Object.assign({}, idle, { lastUpdateAt: 5000 - 10 });
  assert.strictEqual(API.shouldUpdateFrame(idleTooSoon), false, '空闲未到 km → 节流');
});

// ---------------------------------------------------------------------------
// 5) vm 沙箱：三层 props 形状 + 装配（复用步骤③ loadSandbox 模式）
// ---------------------------------------------------------------------------

function makeLayerStubCtor(name) {
  return class {
    constructor(props) {
      this.props = props;
      this.className = name;
    }
    getShaders() { return { inject: {}, modules: [] }; }
    getAttributeManager() { return null; }
    draw() {}
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
    this.on = (ev, fn) => { (m.handlers[ev] = m.handlers[ev] || []).push(fn); };
    this.off = (ev, fn) => { m.handlers[ev] = (m.handlers[ev] || []).filter((f) => f !== fn); };
    this.getZoom = () => m.zoom;
    this.emit = (ev) => (m.handlers[ev] || []).slice().forEach((f) => f());
  }
  const timers = [];
  const sandbox = {
    console,
    Promise,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    Math,
    Date,
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
  // index.html 同序：effects 先于 deck（deck 从 SFV.worldLighthouseEffects 取三件套工厂）
  vm.runInContext(EFFECTS_SRC, sandbox);
  vm.runInContext(SRC, sandbox);
  const api = sandbox.StellaflixVideo.worldLighthouseDeck;
  return { sandbox, api, created, setPropsCalls, overlay, timers, FakeMap };
}

const station = (id, lon, extra) => Object.assign({
  id, position: [lon, 31.2], status: 'online',
  colorTop: [223, 204, 251], colorBottom: [150, 200, 254]
}, extra || {});

test('ParticleWaveLayer/PulseRingLayer/VolumetricSpotlightLayer 三 construction 逐字 props（fm/wm/_m）', () => {
  const env = loadSandbox();
  const st = station('a', 121, { status: 'playing', ownerType: 'system' });
  // 直取沙箱内构造器（④-5a 落点：模块内部函数，经 api 暴露给测试装配口）
  const parts = API.particleData(st.position);
  const wave = env.api.buildParticleWave({
    data: parts, time: 2, audioMid: 0.3, isIdle: true, opacity: 0.5,
    colorTop: [223 / 255, 204 / 255, 251 / 255],
    colorMiddle: [150 / 255, 200 / 255, 254 / 255]
  });
  assert.strictEqual(wave.props.id, 'particle-wave-layer', 'fm id 逐字（:12446）');
  assert.strictEqual(wave.props.pickable, false, ':12468');
  assert.strictEqual(wave.props.parameters.depthWriteEnabled, false, ':12470');
  assert.strictEqual(wave.props.billboard, true, ':12467');
  assert.strictEqual(wave.props.radiusUnits, 'meters');
  assert.strictEqual(JSON.stringify(wave.props.getFillColor), JSON.stringify([0, 229, 255, 200]), 'getFillColor 硬编码逐字（:12461；vm 跨 realm 数组 JSON 规范化）');

  const ring = env.api.buildPulseRing({ data: st, time: 2, opacity: 0.5 });
  assert.strictEqual(ring.props.id, 'pulse-ring-layer', 'wm id 逐字（:12626）');
  assert.strictEqual(ring.props.getRadius, (1e6 * 5e-4) * 1.3,
    'getRadius = mm*(1+uc) 逐字（:12624，mm=1e6×Mt=.5、uc=.3 —— 源即 .65「米」，不乘 111e3）');
  assert.strictEqual(ring.props.pickable, false);
  assert.strictEqual(ring.props.parameters.depthWriteEnabled, false);

  const spot = env.api.buildSpotlight({ data: [st], time: 2, layerOpacity: 1 });
  assert.strictEqual(spot.props.id, 'volumetric-spotlight-layer-normal', '_m id 逐字（:12874）');
  assert.strictEqual(spot.props.sizeScale, 25, 'sizeScale = Hr（:12879）');
  assert.strictEqual(spot.props.parameters.cullMode, 'none', ':12893');
  assert.strictEqual(spot.props.parameters.blendColorOperation, 'add', ':12897');
  assert.strictEqual(spot.props.parameters.depthCompare, 'always');
  assert.strictEqual(JSON.stringify(spot.props.getOrientation), JSON.stringify([0, -(2 * 6) % 360, 0]), '旋转 -(time*6)%360 逐字（:12872）');
});

test('_m getColor 逐字（:12880）：非 offline alpha 255，offline alpha 0', () => {
  const env = loadSandbox();
  const playing = station('p', 121, { status: 'playing' });
  const off = station('o', 122, { status: 'offline' });
  const spot = env.api.buildSpotlight({ data: [playing, off], time: 0 });
  assert.strictEqual(JSON.stringify(spot.props.getColor(playing)), JSON.stringify([255, 255, 255, 255]));
  assert.strictEqual(JSON.stringify(spot.props.getColor(off)), JSON.stringify([255, 255, 255, 0]));
});

test('选中特效装配（:13683-13705）：vo 开时三层次序 particle→pulse→spotlight、色归一化 /255、opacity=ramp×detail；门闭整组消失', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(14);
  await env.api.mount(map, env.overlay, {
    stations: [station('a', 121, { status: 'playing', ownerType: 'system' })]
  });
  env.api.setSelected('a');
  // 驱动一帧：ramp 上行到 >.01
  env.api.stepSelectedEffects(0.5); // dt 秒 → ramp 0→1 吸附
  let last = env.setPropsCalls[env.setPropsCalls.length - 1];
  const ids = last.map((l) => l.props.id);
  assert.ok(ids.includes('particle-wave-layer'), '粒子波层入列');
  assert.ok(ids.includes('pulse-ring-layer'), '脉冲环层入列');
  assert.ok(ids.includes('volumetric-spotlight-layer-normal'), '体积光层入列');
  const wave = last.find((l) => l.props.id === 'particle-wave-layer');
  const pw = last.indexOf(wave);
  assert.strictEqual(last[pw + 1].props.id, 'pulse-ring-layer', '次序逐字（:13687-13695）');
  assert.strictEqual(last[pw + 2].props.id, 'volumetric-spotlight-layer-normal');
  assert.strictEqual(JSON.stringify(wave.props.colorTop), JSON.stringify([223 / 255, 204 / 255, 251 / 255]), 'colorTop /255 归一化（:13684）');
  assert.strictEqual(wave.props.isIdle, true, 'isIdle 恒 true（:13691）');
  assert.strictEqual(wave.props.audioMid, 0.3, 'audioMid .3（:13690）');

  // 退房（清选中）→ ramp 下行归零 → 三层摘除
  env.api.clearSelection();
  for (let i = 0; i < 4; i++) env.api.stepSelectedEffects(0.02);
  last = env.setPropsCalls[env.setPropsCalls.length - 1];
  const ids2 = last.map((l) => l.props.id);
  assert.ok(!ids2.includes('particle-wave-layer'), 'ramp 归零后特效摘除');
  assert.ok(!ids2.includes('pulse-ring-layer'));
  assert.ok(!ids2.includes('volumetric-spotlight-layer-normal'));
  env.api.unmount();
});

test('offline 选中不放特效（fh 门 :10637 装配级生效）', async () => {
  const env = loadSandbox();
  const map = new env.FakeMap(14);
  await env.api.mount(map, env.overlay, {
    stations: [station('a', 121, { status: 'offline', ownerType: 'system' })]
  });
  env.api.setSelected('a');
  env.api.stepSelectedEffects(0.5);
  const last = env.setPropsCalls[env.setPropsCalls.length - 1];
  assert.ok(!last.map((l) => l.props.id).includes('particle-wave-layer'),
    'fh(站, detail)：status 非 playing → vo=false → 三层不装配');
  env.api.unmount();
});

// ---------------------------------------------------------------------------
// 5b) 真实 draw() UBO 通道（浏览器验收抓到 gm is not defined——沙箱此前不执行 draw）
// ---------------------------------------------------------------------------

test('PulseRingLayer.draw UBO 逐字（vm.draw :12630-12641）：cycleDuration=gm(8)、fadeDistance=uc(.3)、time/opacity 透传', () => {
  const env = loadSandbox();
  const ring = env.api.buildPulseRing({ data: station('a', 121), time: 3.5, opacity: 0.7 });
  const sets = [];
  ring.state = { model: { shaderInputs: { setProps: (o) => sets.push(o) } } };
  ring.draw(null);
  assert.strictEqual(sets.length, 1, 'draw 向 pulseRing UBO setProps 一次');
  const u = sets[0].pulseRing;
  assert.strictEqual(u.cycleDuration, 8, 'gm=8 周期秒（:12501 pulseBits.gm）');
  assert.strictEqual(u.fadeDistance, 0.3, 'uc=.3');
  assert.strictEqual(u.maxRadius, 1);
  assert.strictEqual(u.time, 3.5);
  assert.strictEqual(u.opacity, 0.7);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(u.colorTop)), [0, 0.9, 1], 'colorTop 兜底 [0,.9,1]');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(u.colorBottom)), [0.2, 0.4, 1], 'colorBottom 兜底 [.2,.4,1]');
});

test('ParticleWaveLayer.draw UBO 逐字（dm.draw :12415-12436）：maxDistance=Rh(500)、waveAmplitude=ic、noise 对、isIdle 0/1', () => {
  const env = loadSandbox();
  const wave = env.api.buildParticleWave({ data: API.particleData([121, 31]), time: 2, audioMid: 0.3, isIdle: true, opacity: 0.5 });
  const sets = [];
  wave.state = { model: { shaderInputs: { setProps: (o) => sets.push(o) } } };
  wave.draw(null);
  assert.strictEqual(sets.length, 1);
  const u = sets[0].particleWave;
  assert.strictEqual(u.maxDistance, 500, 'Rh = 1e6 × Mt = 500（:10957）');
  assert.strictEqual(u.waveAmplitude, 3e3 * 5e-4, 'ic = 3e3 × Mt（xr :10951-10979）');
  assert.strictEqual(u.noiseFrequency, 0.8);
  assert.strictEqual(u.noiseAmplitude, 0.4);
  assert.strictEqual(u.isIdle, 1, 'true → 1');
  assert.strictEqual(u.time, 2);
  assert.strictEqual(u.audioMid, 0.3, 'props.audioMid 优先于 avg(21..42)');
});

// ---------------------------------------------------------------------------
// 6) 源码正则兜底（GLSL/参数形状不ocs）
// ---------------------------------------------------------------------------

test('三件套 GLSL 关键句逐字兜底（Ti/sm-rm-am-im-lm/cm、Li、Sm 注入、bm 参数默认）', () => {
  // 粒子波 UBO + 模块名
  assert.match(CODE, /uniform particleWaveUniforms \{/);
  assert.match(CODE, /particleWave\.time/);
  assert.match(CODE, /isIdle \> 0\.5|isIdle/, 'idle 分支存在');
  assert.match(CODE, /pow\(normalizedSin, 32\.0\)/, 'IDLE 粒子幂次 32.0（A-1 勘误注记：与 pulse 的 8.0 刻意不同构幂）');
  // 粒子 wave 公式（pulse 复用同款）
  assert.match(CODE, /distanceRatio \* 4\.0 - time \* 0\.5/);
  // pulseRing UBO + 幂次 8.0 + fadeStart 0.75 + fadeInEnd 0.05
  assert.match(CODE, /uniform pulseRingUniforms \{/);
  assert.match(CODE, /pow\(normalizedSin, 8\.0\)/);
  assert.match(CODE, /float fadeStart = 0\.75;/);
  assert.match(CODE, /float fadeInEnd = 0\.05;/);
  assert.match(CODE, /fragColor\.a \*= ringIntensity \* 0\.9 \* pulseRing\.opacity;/);
  // 体积光：硬编码参数组 + discard 条件 + smoothstep 双面
  assert.match(CODE, /vec3 spotColor = vec3\(1\.0, 0\.95, 0\.8\);/);
  assert.match(CODE, /float spotAttenuation = 20\.0;/);
  assert.match(CODE, /float extremePower = 3\.0;/);
  assert.match(CODE, /float coneHeight = 30\.0;/);
  assert.match(CODE, /smoothstep\(reachDistance, reachDistance - 3\.0, vLocalPosition\.y\)/);
  assert.match(CODE, /faceVisibility = smoothstep\(0\.2, -0\.2, axisViewDot\)/);
  assert.match(CODE, /faceVisibility = smoothstep\(-0\.2, 0\.2, axisViewDot\)/);
  // 层类名逐字
  assert.match(CODE, /static layerName = ['"]ParticleWaveLayer['"]/);
  assert.match(CODE, /static layerName = ['"]PulseRingLayer['"]/);
  assert.match(CODE, /static layerName = ['"]VolumetricSpotlightLayer['"]/);
  // 实例化属性名逐字
  assert.match(CODE, /instanceDistance/);
  assert.match(CODE, /instancePhaseOffset/);
  assert.match(CODE, /instanceLayerOpacity/);
  // 模块名（shader module）
  assert.match(CODE, /name:\s*['"]particleWave['"]/);
  assert.match(CODE, /name:\s*['"]pulseRing['"]/);
  // 广播间隔之外的特效默认色（dm draw 内 [0,.9,1]/[0,.45,.5]；vm [0,.9,1]/[.2,.4,1]）
  assert.match(CODE, /\[0, *\.9, *1\]/);
  assert.match(CODE, /\[0, *\.45, *\.5\]/);
  assert.match(CODE, /\[\.2, *\.4, *1\]/);
});
