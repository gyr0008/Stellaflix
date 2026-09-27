// tests/world-vendor.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const V = p => path.join(__dirname, '..', 'public', 'vendor', p);

test('maplibre UMD 落盘且暴露 maplibregl 全局', () => {
  const s = fs.readFileSync(V('maplibre/maplibre-gl.min.js'), 'utf8');
  assert.ok(s.length > 800_000, 'maplibre-gl.min.js 体积异常');
  assert.match(s, /maplibregl/);
});
test('deck.gl 单体 UMD 含 MapboxOverlay 与 SimpleMeshLayer（luma 已内联）', () => {
  const s = fs.readFileSync(V('deck.gl/deck.gl.min.js'), 'utf8');
  assert.ok(s.includes('MapboxOverlay'));
  assert.ok(s.includes('SimpleMeshLayer'));
  assert.ok(!/window\.luma/.test(s), '不应依赖外部 luma 全局');
});
test('loaders.gl core+obj UMD 落盘', () => {
  // 计划原阈值 50_000 系估算值；@loaders.gl/core@4.3.3 dist.min.js 实测 47_370 字节，降为 40_000 防截断
  assert.ok(fs.readFileSync(V('loaders/loaders.gl.core.min.js')).length > 40_000);
  assert.ok(fs.readFileSync(V('loaders/loaders.gl.obj.min.js')).toString().includes('OBJ'));
});
