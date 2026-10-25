'use strict';

// 批4-A：注册安全性烟测——把 10/11/12/13 + 20-db-bridge 按生产拼接顺序合进同一 vm 全局作用域，
// 确认 block2↔20- 的良性重复声明（normalizeLocalLibraryPathKey/localLibraryPathKeyFromSong）
// 在全量拼接下不报错、且关键函数/句柄都解析成功（模拟 index-loader 的单脚本 sloppy 拼接）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function read(p) { return fs.readFileSync(path.join(__dirname, '..', p), 'utf8'); }
function stripHeader(src) {
  const lines = src.split('\n');
  let i = 0;
  while (i < lines.length && (lines[i].startsWith('//') || lines[i].trim() === '')) i += 1;
  return lines.slice(i).join('\n');
}

const MODULES = [
  'public/js/modules/04-shelf/11-local-track-map.js',
  'public/js/modules/04-shelf/10-local-tag-parser.js',
  'public/js/modules/04-shelf/12-local-cache-bridge.js',
  'public/js/modules/04-shelf/13-local-library-engine.js',
  'public/js/modules/04-shelf/14-mlib-seam.js',
  'public/js/modules/05-playback/20-local-library-db-bridge.js',
];

test('block1/2/3 + engine + db-bridge 全量拼接：无声明冲突、关键函数齐全', () => {
  const source = MODULES.map((m) => stripHeader(read(m))).join('\n');
  const context = {
    Array, Blob, Error, Intl, Math, Number, Object, Promise, String, TextDecoder, Uint8Array, atob,
    console: { warn: () => {}, log: () => {} },
    window: { desktopWindow: { isDesktop: true } },
    localLibraryDbState: { probed: false, available: false, promise: null, status: null },
  };
  // sloppy 单脚本拼接（与 index-loader 一致）；若重复声明在 strict 下会抛，这里必须不抛。
  assert.doesNotThrow(() => {
    vm.runInNewContext(
      source
        + '\nthis.probe = { extractLocalMetadataTags: typeof extractLocalMetadataTags,'
        + ' makeLocalSongFromFile: typeof makeLocalSongFromFile,'
        + ' getLocalLibraryTracks: typeof getLocalLibraryTracks,'
        + ' callLocalLibraryDb: typeof callLocalLibraryDb,'
        + ' normalizeLocalLibraryPathKey: typeof normalizeLocalLibraryPathKey,'
        + ' localLibraryPathKeyFromSong: typeof localLibraryPathKeyFromSong,'
        + ' localLibraryDbTextDigest: typeof localLibraryDbTextDigest,'
      + ' seamGetTracks: (window.stellaMlibSeam && typeof window.stellaMlibSeam.getTracks),'
      + ' seamSubscribe: (window.stellaMlibSeam && typeof window.stellaMlibSeam.subscribe) };',
      context
    );
  }, '全量拼接不应抛声明冲突');

  const probe = context.probe;
  for (const key of Object.keys(probe)) {
    assert.equal(probe[key], 'function', `${key} 应为已定义函数（实际 ${probe[key]}）`);
  }
  // 批4-B：seam provider 已在拼接时挂上 window.stellaMlibSeam。
  assert.ok(context.window.stellaMlibSeam, 'window.stellaMlibSeam 应已被 14-mlib-seam 挂载');
});

test('良性重复声明行为一致：block2 与 20- 的 normalizeLocalLibraryPathKey 结果相同', () => {
  const b2 = read('public/js/modules/04-shelf/11-local-track-map.js');
  const bridge = read('public/js/modules/05-playback/20-local-library-db-bridge.js');
  const grab = (src) => stripHeader(src.match(/function normalizeLocalLibraryPathKey[\s\S]*?\n}/)[0]);
  const ctx = { String };
  vm.runInNewContext(`${grab(b2)}\nthis.fn = normalizeLocalLibraryPathKey;`, ctx);
  const a = ctx.fn('C:\\Users\\A//b//c.flac');
  const ctx2 = { String };
  vm.runInNewContext(`${grab(bridge)}\nthis.fn = normalizeLocalLibraryPathKey;`, ctx2);
  const b = ctx2.fn('C:\\Users\\A//b//c.flac');
  assert.equal(a, b, '两处实现应产出相同归一化键');
  assert.equal(a, 'c:/users/a/b/c.flac');
});
