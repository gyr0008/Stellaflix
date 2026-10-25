'use strict';

// 批4 修复验证：本地封面 /api/local-file 地址必须直出（不走 /api/cover 代理、不加参数），
// 否则播放器缩略图/舞台 coverProxySrc→'' 而显示灰色（mlib 页用原始 URL 直出所以有图）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', '05-playback', '01-cover-custom-map.js'), 'utf8');
function slice() {
  const s = SRC.indexOf('function isInlineCoverSrc(');
  const e = SRC.indexOf('function songCustomCoverKey(');
  assert.ok(s >= 0 && e > s, '接缝缺失');
  return SRC.slice(s, e);
}
function boot() {
  const ctx = {};
  vm.runInNewContext(slice() + '\nthis.api = { isInlineCoverSrc, isProxyableCoverUrl, coverProxySrc, coverUrlWithSize };', ctx);
  return ctx.api;
}

const LOCAL = 'http://127.0.0.1:3000/api/local-file?token=abc&path=' + encodeURIComponent('C:\\Music\\cover.jpg');

test('本地 /api/local-file 封面：isInlineCoverSrc=true（直出）', () => {
  const a = boot();
  assert.equal(a.isInlineCoverSrc(LOCAL), true);
});

test('本地封面：coverProxySrc 原样返回（不套 /api/cover）', () => {
  const a = boot();
  assert.equal(a.coverProxySrc(LOCAL), LOCAL, '不应被 /api/cover 代理');
});

test('本地封面：coverUrlWithSize 原样返回（不加 param）', () => {
  const a = boot();
  assert.equal(a.coverUrlWithSize(LOCAL, 220), LOCAL, '不应追加 param');
});

test('在线封面仍正常走代理 + 尺寸参数（未误伤）', () => {
  const a = boot();
  const online = 'https://p1.music.126.net/x.jpg';
  assert.equal(a.isInlineCoverSrc(online), false);
  assert.ok(a.coverProxySrc(online).startsWith('/api/cover?url='), '在线封面应走代理');
  assert.ok(/param=220y220/.test(a.coverUrlWithSize(online, 220)), '在线封面应加尺寸');
});
