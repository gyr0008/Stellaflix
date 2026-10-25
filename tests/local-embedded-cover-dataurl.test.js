'use strict';

// 批4 修复验证：loadCoverFromUrl 必须接受内嵌封面 data: URL（原来只认 http/stellaflix-local → 清灰）。
// data: 早退到 applyCoverDataUrl；不该走进「清空封面」分支。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', '03-beat', '05-cover-loading-crop.js'), 'utf8');
function slice() {
  const s = SRC.indexOf('function loadCoverFromUrl(');
  const e = SRC.indexOf('function cssBackgroundUrl(');
  assert.ok(s >= 0 && e > s);
  return SRC.slice(s, e);
}

function boot() {
  const calls = { dataUrl: [], cleared: 0 };
  const ctx = {
    // data: 早退只用到 applyCoverDataUrl；其余 DOM 桩仅在走非 data: 分支才触及（本用例不走）。
    applyCoverDataUrl: (url) => calls.dataUrl.push(url),
    coverApplyStillCurrent: () => true,
    uniforms: { uHasCover: { value: 0 } },
    resetFloatColorsToIdle: () => {},
    setCoverDepthState: () => {},
    setAlbumBackground: () => {},
    setControlCoverSrc: () => { calls.cleared += 1; },
    document: { getElementById: () => ({ removeAttribute: () => { calls.cleared += 1; }, classList: { add(){}, remove(){} }, style: {} }) },
    Image: function () {},
    coverProcessToken: 0,
  };
  vm.runInNewContext(slice() + '\nthis.fn = loadCoverFromUrl;', ctx);
  return { fn: ctx.fn, calls };
}

test('内嵌封面 data: URL → 交给 applyCoverDataUrl（不清灰）', () => {
  const h = boot();
  h.fn('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg', {});
  assert.equal(h.calls.dataUrl.length, 1, 'data: 应进 applyCoverDataUrl');
  assert.equal(h.calls.cleared, 0, 'data: 不应触发清空封面分支');
});
