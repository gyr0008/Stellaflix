'use strict';

/**
 * 世界页 Task 3 — 程序化灯塔模型（public/video/world-lighthouse-model.js）
 * 运行：node --test tests/world-lighthouse-model.test.js
 *
 * 纯数学模块（无 DOM/WebGL），经模块尾部 module.exports 守卫直接 require，
 * 替代 brief 里 `.__node || global.window=...` 的装载 hack（断言意图逐条保留）。
 *
 * 版权红线：本模块为原创程序化几何，不下载、不引用、不逐面复刻 HearThere 的
 * lighthouse.obj；仅剪影比例参考计划中公开引用的顶点数据。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const MODULE_PATH = path.join(__dirname, '..', 'public', 'video', 'world-lighthouse-model.js');

// 干净直连 require（exports 守卫启用；文件不存在时此处即 RED）
const { build } = require(MODULE_PATH);

test('几何闭合：索引数=12*段数，法线单位化，heights∈[0,modelHeight]', () => {
  const m = build({ segments: 12 });
  assert.ok(m.indices.length % 3 === 0);
  assert.equal(m.positions.length / 3, m.normals.length / 3);
  assert.equal(m.positions.length / 3, m.heights.length);
  let maxH = 0;
  for (let i = 0; i < m.heights.length; i++) maxH = Math.max(maxH, m.heights[i]);
  assert.ok(Math.abs(maxH - m.modelHeight) < 1e-3);
  for (let i = 0; i < m.normals.length; i += 3) {
    const len = Math.hypot(m.normals[i], m.normals[i + 1], m.normals[i + 2]);
    assert.ok(Math.abs(len - 1) < 1e-4, '法线须单位化');
  }
});

test('API 契约：build({segments}) 返回 SimpleMeshLayer 所需的五个字段（typed arrays）', () => {
  const m = build({ segments: 12 });
  assert.ok(m.positions instanceof Float32Array, 'positions 应为 Float32Array');
  assert.ok(m.normals instanceof Float32Array, 'normals 应为 Float32Array');
  assert.ok(m.heights instanceof Float32Array, 'heights 应为 Float32Array');
  assert.ok(m.indices instanceof Uint16Array, 'indices 应为 Uint16Array（deck.gl SimpleMeshLayer 惯例）');
  assert.strictEqual(typeof m.modelHeight, 'number');
  assert.ok(Number.isFinite(m.modelHeight) && m.modelHeight > 0);
});

test('索引只引用存在的顶点：max index < 顶点数', () => {
  const m = build({ segments: 12 });
  const vertexCount = m.positions.length / 3;
  let maxIdx = -1;
  for (let i = 0; i < m.indices.length; i++) maxIdx = Math.max(maxIdx, m.indices[i]);
  assert.ok(maxIdx < vertexCount, `最大索引 ${maxIdx} 应 < 顶点数 ${vertexCount}`);
  assert.strictEqual(minIndex(m), 0, '最小索引应为 0');

  function minIndex(mm) {
    let v = Infinity;
    for (let i = 0; i < mm.indices.length; i++) v = Math.min(v, mm.indices[i]);
    return v;
  }
});

test('顶点数随 segments 成比例：segments 翻倍顶点数翻倍', () => {
  const a = build({ segments: 8 });
  const b = build({ segments: 16 });
  const va = a.positions.length / 3;
  const vb = b.positions.length / 3;
  assert.strictEqual(vb, va * 2, '16 段顶点数应为 8 段的两倍');
  assert.strictEqual(b.indices.length, a.indices.length * 2);
  assert.notStrictEqual(va, vb, '不同 segments 应产生不同顶点数');
});

test('塔高支配场景：modelHeight > 8 且落在 9.0–9.5（对齐 hearthere 总高 9.22 的剪影量级）', () => {
  const m = build({ segments: 12 });
  assert.ok(m.modelHeight > 8, `modelHeight=${m.modelHeight} 应 > 8（塔须支配场景）`);
  assert.ok(m.modelHeight >= 9.0 && m.modelHeight <= 9.5, `modelHeight=${m.modelHeight} 应落在 9.0–9.5`);
  // +Y 朝上、塔底原点：所有顶点 y∈[0, modelHeight]
  for (let i = 1; i < m.positions.length; i += 3) {
    const y = m.positions[i];
    assert.ok(y >= -1e-6 && y <= m.modelHeight + 1e-6, `顶点 y=${y} 应 ∈ [0, modelHeight]`);
  }
  // heights 即逐顶点的 y（米制高度，供 SimpleMeshLayer 着色）
  for (let i = 0; i < m.heights.length; i++) {
    assert.ok(Math.abs(m.heights[i] - m.positions[i * 3 + 1]) < 1e-5);
  }
});

test('底座剪影含公开引用顶点数据的关键环：r≈0.83@y=0.22 与 r≈0.72@y≈0.29', () => {
  const m = build({ segments: 48 });
  const rings = new Map(); // "y|r" 计数（去重顶点）
  const seen = new Set();
  for (let i = 0; i < m.positions.length; i += 3) {
    const x = m.positions[i], y = m.positions[i + 1], z = m.positions[i + 2];
    const key = y.toFixed(2) + '|' + Math.hypot(x, z).toFixed(2);
    seen.add(key);
  }
  assert.ok(seen.has('0.22|0.83'), '应有底座环 r=0.83 @ y=0.22');
  assert.ok(seen.has('0.29|0.72'), '应有底座环 r=0.72 @ y≈0.29');
});

test('浏览器 IIFE 挂载 window.StellaflixVideo.worldLighthouseModel（双装载契约）', () => {
  const src = fs.readFileSync(MODULE_PATH, 'utf8');
  const sandbox = { window: {} };
  sandbox.window.console = console;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  assert.ok(sandbox.window.StellaflixVideo, '应挂到 window.StellaflixVideo');
  const model = sandbox.window.StellaflixVideo.worldLighthouseModel;
  assert.strictEqual(typeof model.build, 'function');
  const m = model.build({ segments: 10 });
  assert.ok(m.indices.length > 0 && m.positions.length > 0);
});

test('缺省参数：build() 无参也可用（默认 segments），segments 过小被夹到下限', () => {
  const d = build();
  assert.ok(d.positions.length > 0 && d.indices.length % 3 === 0);
  const small = build({ segments: 1 });
  assert.ok(small.positions.length > 0, 'segments=1 应被夹到安全下限而非产生退化几何');
  for (let i = 0; i < small.normals.length; i += 3) {
    const len = Math.hypot(small.normals[i], small.normals[i + 1], small.normals[i + 2]);
    assert.ok(Math.abs(len - 1) < 1e-4);
  }
});
