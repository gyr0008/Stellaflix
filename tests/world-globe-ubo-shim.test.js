'use strict';

/**
 * 轮㉑c 回归 — UBO bindBufferBase 垫片（world-globe.js）
 * 运行：node --test tests/world-globe-ubo-shim.test.js
 *
 * 根因（h115 dt-run1/run2，本机 ANGLE/NVIDIA）：
 *   bindBufferBase(UNIFORM_BUFFER, i, buf) 静默不生效（draw 时报 1280、UBO 数据不达
 *   shader → IconLayer sizePixels=clamp(0)=0 → 零片元），而等价 bindBufferRange(i, buf,
 *   0, BUFFER_SIZE) 完全正常。vendor luma _applyBindings 走 base 路径（deck.gl.min.js
 *   idx≈146069），故在应用侧对共享 GL 上下文包一层转发垫片，vendor 逐字保留。
 *
 * 垫片语义：
 *  - target === UNIFORM_BUFFER 且 buf 非空 → bindBufferRange(target, index, buf, 0, BUFFER_SIZE)
 *  - 其余（其他 target / buf=null）→ 原样透传 bindBufferBase
 *  - gl 不形状匹配（缺方法/缺常量）或已打过垫片 → 返回 false，幂等
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function loadShim() {
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    Promise, setTimeout, clearTimeout,
    document: { createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {},
      getContext() { return null; }, appendChild() {} }), querySelector: () => null, head: {} },
    deck: { MapboxOverlay: function () { this.finalize = () => {}; } },
    StellaflixVideo: {}
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('public/video/world-globe.js'), sandbox);
  return sandbox.StellaflixVideo;
}

function makeFakeGl() {
  const calls = [];
  const bufA = { name: 'bufA' }, bufB = { name: 'bufB' };
  const sizes = new Map([[bufA, 288], [bufB, 40]]);
  const gl = {
    UNIFORM_BUFFER: 35345,
    ARRAY_BUFFER: 34962,
    ELEMENT_ARRAY_BUFFER: 34963,
    BUFFER_SIZE: 34660,
    __bufA: bufA,
    __bufB: bufB,
    bindBufferBase(t, i, b) { calls.push({ f: 'base', t, i, b }); },
    bindBufferRange(t, i, b, o, s) { calls.push({ f: 'range', t, i, b, o, s }); },
    getParameter(t) { return t === 34660 ? 0 : null; },
    bindBuffer() {},
    UNIFORM_BUFFER_BINDING: 35368
  };
  gl.__calls = calls;
  gl.__sizes = new Map([[bufA, 288], [bufB, 40]]);
  gl.bindBuffer = () => {};
  gl.getBufferParameter = (t, pname) => (t === gl.UNIFORM_BUFFER && pname === gl.BUFFER_SIZE ? 288 : 0);
  gl.getParameter = (pname) => (pname === gl.UNIFORM_BUFFER_BINDING ? null : 0);
  return gl;
}

// 真机语义 fake：按绑定句柄返回各自尺寸
function makeSizedGl(sizes) {
  const gl = makeFakeGl();
  let bound = null;
  gl.bindBuffer = (t, b) => { bound = b; };
  gl.getBufferParameter = (t, pname) => {
    if (t === gl.UNIFORM_BUFFER && pname === gl.BUFFER_SIZE) return sizes.get(bound) || 0;
    return 0;
  };
  return gl;
}

test('install 存在且幂等：首次 true，重复 false，bindBufferBase 只包一层', () => {
  const SFV = loadShim();
  assert.strictEqual(typeof SFV.worldUboShim.install, 'function',
    'world-globe.js 应导出 SFV.worldUboShim.install（轮㉑c 垫片）');
  const gl = makeFakeGl();
  assert.strictEqual(SFV.worldUboShim.install(gl), true);
  assert.strictEqual(SFV.worldUboShim.install(gl), false, '重复安装应返回 false');
  gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, gl.__bufA);
  const bases = gl.__calls.filter((c) => c.f === 'base');
  assert.strictEqual(bases.length, 0, 'UNIFORM_BUFFER 应全部改走 range');
});

test('UNIFORM_BUFFER + 非空 buf → bindBufferRange(target, i, buf, 0, BUFFER_SIZE)', () => {
  const SFV = loadShim();
  const sizes = new Map([[{ n: 1 }, 288]]);
  const gl = makeSizedGl(sizes);
  const buf = Array.from(sizes.keys())[0];
  gl.__bufA = buf;
  SFV.worldUboShim.install(gl);
  gl.bindBufferBase(gl.UNIFORM_BUFFER, 2, buf);
  const ranges = gl.__calls.filter((c) => c.f === 'range');
  assert.strictEqual(ranges.length, 1);
  assert.strictEqual(ranges[0].t, gl.UNIFORM_BUFFER);
  assert.strictEqual(ranges[0].i, 2);
  assert.strictEqual(ranges[0].b, buf);
  assert.strictEqual(ranges[0].o, 0);
  assert.strictEqual(ranges[0].s, 288);
  assert.strictEqual(gl.__calls.filter((c) => c.f === 'base').length, 0);
});

test('透传纪律：非 UNIFORM_BUFFER 目标与 buf=null 原样走 bindBufferBase', () => {
  const SFV = loadShim();
  const gl = makeFakeGl();
  SFV.worldUboShim.install(gl);
  gl.bindBufferBase(gl.ARRAY_BUFFER, 0, gl.__bufA);
  gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, null);
  const bases = gl.__calls.filter((c) => c.f === 'base');
  assert.strictEqual(bases.length, 2, '两类调用应透传给原 bindBufferBase');
  assert.strictEqual(bases[0].t, gl.ARRAY_BUFFER);
  assert.strictEqual(bases[1].b, null);
  assert.strictEqual(gl.__calls.filter((c) => c.f === 'range').length, 0);
});

test('形状守卫：null / 缺 bindBufferRange / 缺 UNIFORM_BUFFER 常量 → false 且不动 gl', () => {
  const SFV = loadShim();
  assert.strictEqual(SFV.worldUboShim.install(null), false);
  assert.strictEqual(SFV.worldUboShim.install({}), false);
  const noRange = makeFakeGl();
  delete noRange.bindBufferRange;
  const before = noRange.bindBufferBase;
  assert.strictEqual(SFV.worldUboShim.install(noRange), false);
  assert.strictEqual(noRange.bindBufferBase, before, '安装失败不得替换原方法');
});

test('接线：world-globe.js load 回调在 deck MapboxOverlay 实例化前安装垫片', () => {
  const src = read('public/video/world-globe.js');
  const iInstall = src.search(/worldUboShim\.install\(/);
  const iDeck = src.indexOf('new global.deck.MapboxOverlay');
  assert.ok(iInstall >= 0, 'load 路径应调用 worldUboShim.install');
  assert.ok(iDeck >= 0);
  assert.ok(iInstall < iDeck, '垫片必须先于 deck overlay 实例化（luma _applyBindings 在 draw 前重绑）');
});

test('world-globe.js 语法合法', () => {
  const { execFileSync } = require('node:child_process');
  execFileSync(process.execPath, ['--check', path.join(root, 'public/video/world-globe.js')], {
    encoding: 'utf8', stdio: 'pipe'
  });
});
