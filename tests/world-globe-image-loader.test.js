'use strict';

/**
 * 轮㉑b — vendor 链尾向共享 registry 注册 image loader
 * 运行：node --test tests/world-globe-image-loader.test.js
 *
 * 真机根因（2026-10-02 复验）：world-globe.js VENDOR 次序 deck 先 → loaders core/obj 后，
 * 两个独立 UMD 以 root['loaders']=factory() 整体替换 globalThis.loaders，deck 初始化时
 * 写进旧对象的 image loader（qn）注册表随之被孤儿化；deck 惰重建的 loaderRegistry 恒空，
 * IconManager 每次图片加载都 "No valid loader found (MIME type: image/png)" 静默失败 →
 * 地球头顶国旗/头像全灭。修复=链尾 unshift 一个最小 image loader（真机探针已验证
 * deck 的 select+parse 接受它：parse 收 ArrayBuffer，返 ImageBitmap）。
 * 不可重排脚本（T9：deck 先于 loaders 是 getter-only 命名空间约束）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function makeEl(tag) {
  return {
    tagName: tag, style: {}, className: '', children: [], innerHTML: '',
    src: '', rel: '', href: '',
    setAttribute() {}, addEventListener() {}, removeEventListener() {},
    getContext(kind) { return kind === 'webgl2' ? {} : null; },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      return c;
    },
    querySelector() { return null; }
  };
}

// 假 loaders 全局：deck 惰重建后的形态 —— _state.loaderRegistry 空数组
function makeFakeLoaders() {
  return { _state: { loaderRegistry: [] } };
}

function makeFakeBitmap() {
  const calls = [];
  const createImageBitmap = function (blob) {
    calls.push(blob);
    return Promise.resolve({ __sentinel: true, width: 128, height: 128 });
  };
  return { calls, createImageBitmap };
}

function loadWorldGlobeWith(extra) {
  const base = {
    console: { warn() {}, log() {}, error() {} },
    Promise, setTimeout, clearTimeout,
    Blob, atob, TextEncoder,
    document: { createElement: makeEl, querySelector: () => null, head: makeEl('head') },
    deck: { MapboxOverlay: function () { this.finalize = () => {}; } },
    StellaflixVideo: {}
  };
  Object.assign(base, extra || {});
  const sandbox = base;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('public/video/world-globe.js'), sandbox);
  return { wg: sandbox.StellaflixVideo.worldGlobe, sandbox };
}

// ---------------------------------------------------------------------------
// 1) 注册结构与幂等
// ---------------------------------------------------------------------------

test('轮㉑b __registerImageLoader：向 globalThis.loaders._state.loaderRegistry 注册 id=image 覆盖 png', () => {
  const loaders = makeFakeLoaders();
  const { wg } = loadWorldGlobeWith({ loaders });
  const ok = wg.__registerImageLoader();
  assert.equal(ok, true, 'registry 就绪应返回 true');
  assert.equal(loaders._state.loaderRegistry.length, 1, '恰注册 1 个 loader');
  const L = loaders._state.loaderRegistry[0];
  assert.equal(L.id, 'image');
  assert.ok(L.mimeTypes.includes('image/png'), 'mimeTypes 须含 image/png（国旗 PNG data-uri 主路径）');
  assert.ok(L.mimeTypes.includes('image/jpeg'), 'http 头像可能是 jpeg');
  assert.ok(L.extensions.includes('png'), 'extensions 须含 png');
  assert.equal(typeof L.parse, 'function');
});

test('轮㉑b __registerImageLoader：幂等 —— 重复调用不重复入表、不覆盖既有', () => {
  const loaders = makeFakeLoaders();
  const { wg } = loadWorldGlobeWith({ loaders });
  wg.__registerImageLoader();
  const first = loaders._state.loaderRegistry[0];
  wg.__registerImageLoader();
  wg.__registerImageLoader();
  assert.equal(loaders._state.loaderRegistry.length, 1, '恒 1 条');
  assert.equal(loaders._state.loaderRegistry[0], first, '同一对象');
});

test('轮㉑b __registerImageLoader：registry 已含 id=image 时不抢注（外部已备则让位）', () => {
  const existing = { id: 'image', mimeTypes: ['image/png'], extensions: ['png'], parse() {} };
  const loaders = { _state: { loaderRegistry: [existing] } };
  const { wg } = loadWorldGlobeWith({ loaders });
  wg.__registerImageLoader();
  assert.equal(loaders._state.loaderRegistry.length, 1, '不新增');
  assert.equal(loaders._state.loaderRegistry[0], existing, '既有 loader 保持');
});

test('轮㉑b __registerImageLoader：loaders 全局缺失时安全返回 false 不抛（不给 vendor 链添新炸点）', () => {
  const { wg } = loadWorldGlobeWith(); // sandbox 无 loaders
  assert.equal(wg.__registerImageLoader(), false);
});

test('轮㉑b __registerImageLoader：_state/loaderRegistry 尚未被 deck 惰建时自建（链尾时机早于 overlay 初始化）', () => {
  // 真机事实：loaders.gl core UMD 命名空间不导出 _state（键表无 _state），
  // _state 是 deck 首次使用时 `e._state||(e._state={})` 惰建的 —— 链尾调用早于该时机，
  // 若只"读不建"就恒空跳过。须自建且保持 deck `||` 语义兼容（已建则沿用）。
  const loaders = {}; // 无 _state
  const { wg } = loadWorldGlobeWith({ loaders });
  const ok = wg.__registerImageLoader();
  assert.equal(ok, true, '缺 _state 也应注册成功');
  assert.equal(loaders._state.loaderRegistry.length, 1);
  assert.equal(loaders._state.loaderRegistry[0].id, 'image');
  // deck 惰建兼容：模拟其 `e._state||(e._state={})` 不覆盖既有
  const keep = loaders._state;
  loaders._state || (loaders._state = {});
  assert.equal(loaders._state, keep, 'deck 的 || 语义保留已建 _state');
});

// ---------------------------------------------------------------------------
// 2) parse 字节路由（deck 传 ArrayBuffer / data-uri 串；须成 Blob 喂 createImageBitmap）
// ---------------------------------------------------------------------------

test('轮㉑b parse(ArrayBuffer)：bytes 入 Blob 喂 createImageBitmap，透传其结果', async () => {
  const loaders = makeFakeLoaders();
  const bm = makeFakeBitmap();
  const { wg } = loadWorldGlobeWith({ loaders, createImageBitmap: bm.createImageBitmap });
  wg.__registerImageLoader();
  const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const out = await loaders._state.loaderRegistry[0].parse(bytes.buffer);
  assert.equal(out.__sentinel, true, 'parse 返回值即 createImageBitmap 结果（deck 要 ImageBitmap）');
  assert.equal(bm.calls.length, 1);
  assert.equal(bm.calls[0] instanceof Blob, true, '喂给 createImageBitmap 的须是 Blob');
  assert.equal(bm.calls[0].size, bytes.length, '字节原样，无字符串化损耗');
});

test('轮㉑b parse(base64 data-uri 串)：解码为字节再入 Blob', async () => {
  const loaders = makeFakeLoaders();
  const bm = makeFakeBitmap();
  const { wg } = loadWorldGlobeWith({ loaders, createImageBitmap: bm.createImageBitmap });
  wg.__registerImageLoader();
  const bytes = Buffer.from([9, 8, 7, 6, 5, 4]);
  const uri = 'data:image/png;base64,' + bytes.toString('base64');
  await loaders._state.loaderRegistry[0].parse(uri);
  assert.equal(bm.calls.length, 1);
  assert.equal(bm.calls[0].size, bytes.length, 'base64 解码后字节数一致');
});

test('轮㉑b parse：无 createImageBitmap 环境 reject 不抛（Node/vm 外其他宿主）', async () => {
  const loaders = makeFakeLoaders();
  const { wg } = loadWorldGlobeWith({ loaders }); // 无 createImageBitmap
  wg.__registerImageLoader();
  await assert.rejects(() => loaders._state.loaderRegistry[0].parse(new Uint8Array([1]).buffer));
});

// ---------------------------------------------------------------------------
// 3) 接线：ensureVendor 链尾（vendorReady 校验之后）调用
// ---------------------------------------------------------------------------

test('轮㉑b 源码接线：ensureVendor 在 vendorReady 校验通过后调用 registerImageLoader', () => {
  const src = read('public/video/world-globe.js');
  const m = src.match(/function ensureVendor\(\)[\s\S]*?\n  \}/);
  assert.ok(m, 'ensureVendor 应存在');
  assert.match(m[0], /registerImageLoader\(\)/, '链须调用 registerImageLoader()');
  const iReady = m[0].indexOf('vendorReady()');
  const iReg = m[0].indexOf('registerImageLoader()');
  assert.ok(iReady >= 0 && iReg > iReady, '次序：vendorReady 校验在前，注册在链尾');
});
