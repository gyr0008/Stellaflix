'use strict';

// 契约：凡是画进 canvas / 上传为 WebGL 纹理的封面图，若来源是跨源 URL
// （http(s)、stellaflix-local:// 等特权自定义 scheme），必须在赋值 src 前
// 设置 crossOrigin='anonymous'，否则 2D canvas 被污染，THREE.CanvasTexture
// 上传时抛 "Tainted canvases may not be loaded"。
// 仅 data:/blob: 是真正的同源/内联资源，可以省略 crossOrigin。

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function makeSandbox() {
  const loads = [];
  function FakeImage() {
    var self = this;
    var srcValue = '';
    Object.defineProperty(this, 'crossOrigin', {
      value: null, writable: true, enumerable: true, configurable: true
    });
    Object.defineProperty(this, 'src', {
      enumerable: true, configurable: true,
      get: function () { return srcValue; },
      set: function (v) {
        srcValue = v;
        // 记录 src 赋值那一刻的 crossOrigin 值（必须在 src 之前设置才生效）
        loads.push({ src: v, crossOriginAtSrcTime: self.crossOrigin });
      }
    });
  }
  const sandbox = {
    console,
    Image: FakeImage,
    playlistCoverCache: {},
    setTimeout: (fn) => setTimeout(fn, 0),
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    window: {},
    document: {
      addEventListener: () => {},
      getElementById: () => null,
      createElement: () => ({ style: {}, classList: { add() {}, remove() {}, contains: () => false } })
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(read('public/js/modules/05-playback/01-cover-custom-map.js'), sandbox, {
    filename: '01-cover-custom-map.js'
  });
  vm.runInContext(read('public/js/modules/04-shelf/04-cover-api-helpers.js'), sandbox, {
    filename: '04-cover-api-helpers.js'
  });
  return { sandbox, loads };
}

test('requestPlaylistCover 对 stellaflix-local:// 封面在 src 赋值前设置 crossOrigin=anonymous', () => {
  const { sandbox, loads } = makeSandbox();
  const localCoverUrl = 'stellaflix-local://cover/abcdef1234567890abcdef12';
  sandbox.requestPlaylistCover(localCoverUrl, null);
  assert.equal(loads.length, 1, '应发起一次图片加载');
  assert.equal(loads[0].src, localCoverUrl, 'stellaflix-local 封面不应走 /api/cover 代理');
  assert.equal(loads[0].crossOriginAtSrcTime, 'anonymous',
    'stellaflix-local:// 是独立特权 scheme（跨源），未设 crossOrigin 加载会污染书架 canvas，THREE.CanvasTexture 上传即抛 Tainted canvases');
});

test('requestPlaylistCover 对 https 封面走同源 /api/cover 代理且带 crossOrigin（回归护栏）', () => {
  const { sandbox, loads } = makeSandbox();
  const direct = 'https://p1.music.126.net/example/cover.jpg';
  sandbox.requestPlaylistCover(direct, null);
  assert.equal(loads.length, 1);
  assert.match(loads[0].src, /^\/api\/cover\?url=/, 'http(s) 封面应经 coverProxySrc 走同源代理');
  assert.equal(loads[0].crossOriginAtSrcTime, 'anonymous');
});

test('requestPlaylistCover 对 data:/blob: 内联封面不设置 crossOrigin（保持现状）', () => {
  const { sandbox, loads } = makeSandbox();
  const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
  const blobUrl = 'blob:http://127.0.0.1:8123/uuid-1';
  sandbox.requestPlaylistCover(dataUrl, null);
  sandbox.requestPlaylistCover(blobUrl, null);
  assert.equal(loads.length, 2);
  assert.equal(loads[0].src, dataUrl);
  assert.equal(loads[0].crossOriginAtSrcTime, null, 'data: URL 无跨源问题，设置 crossOrigin 反而可能触发无谓的 CORS 检查');
  assert.equal(loads[1].src, blobUrl);
  assert.equal(loads[1].crossOriginAtSrcTime, null);
});

test('requestPlaylistCover 对不可代理的未知 scheme 直接标记失败，不发起加载', () => {
  const { sandbox, loads } = makeSandbox();
  const unknown = 'weird-scheme://cover/abc';
  sandbox.requestPlaylistCover(unknown, null);
  assert.equal(loads.length, 0, 'coverProxySrc 返回空串时不应赋值 src');
  const rec = sandbox.playlistCoverCache[unknown];
  assert.equal(rec.failed, true);
});
