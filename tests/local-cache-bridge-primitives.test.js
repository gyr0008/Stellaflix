'use strict';

// 批3-A：block3 纯原语（12-local-cache-bridge.js）契约测试。
// 从新模块切出（状态注释→EOF）在 vm 里跑；这些原语自洽、无引擎/DOM/桥依赖。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'modules', '04-shelf', '12-local-cache-bridge.js'),
  'utf8'
);

function load() {
  const start = SRC.indexOf('var localLibraryDbIndexDigests');
  assert.ok(start >= 0, 'block3 原语缺失：localLibraryDbIndexDigests');
  const context = { String, Math, Number, Object, Array };
  vm.runInNewContext(
    SRC.slice(start)
      + '\nthis.api = { localAssetCacheKey, localLibraryDbTextDigest, localLibraryDbIndexDigest,'
      + ' resetLocalLibraryDbIndexDigests, localCoverThumbCacheKey, estimateDataUrlBytes,'
      + ' estimateTextBytes, estimateLocalAssetRecordBytes, estimateLocalLyricRecordBytes };',
    context
  );
  return context.api;
}

test('localAssetCacheKey：取 song.localKey，缺失为空串', () => {
  const api = load();
  assert.equal(api.localAssetCacheKey({ localKey: 'C:/a.flac:1:2' }), 'C:/a.flac:1:2');
  assert.equal(api.localAssetCacheKey({}), '');
  assert.equal(api.localAssetCacheKey(null), '');
});

test('localLibraryDbTextDigest：确定性 + 异文异值', () => {
  const api = load();
  const a1 = api.localLibraryDbTextDigest('hello');
  const a2 = api.localLibraryDbTextDigest('hello');
  assert.equal(a1, a2, '同输入应同摘要');
  assert.notEqual(a1, api.localLibraryDbTextDigest('hello!'), '差一个字符应不同');
  assert.match(a1, /^[0-9a-f]+$/, '应为十六进制串');
  assert.equal(api.localLibraryDbTextDigest(''), api.localLibraryDbTextDigest(''), '空串稳定');
});

test('localLibraryDbIndexDigest：同记录同摘要、改字段变摘要、空记录空串', () => {
  const api = load();
  const base = { fileSignature: 'fp', pathKey: 'pk', name: 'n', artist: 'a', album: 'b', duration: 100 };
  const same = { fileSignature: 'fp', pathKey: 'pk', name: 'n', artist: 'a', album: 'b', duration: 100 };
  assert.equal(api.localLibraryDbIndexDigest(base), api.localLibraryDbIndexDigest(same), '等价记录应同摘要');
  assert.notEqual(api.localLibraryDbIndexDigest(base), api.localLibraryDbIndexDigest({ ...base, artist: 'z' }), '改 artist 应变摘要');
  assert.notEqual(api.localLibraryDbIndexDigest(base), api.localLibraryDbIndexDigest({ ...base, duration: 999 }), '改 duration 应变摘要');
  assert.equal(api.localLibraryDbIndexDigest(null), '', '空记录应空串');
  // 空对象也有确定性摘要（各字段取默认值 join 后哈希），非空且稳定。
  assert.match(api.localLibraryDbIndexDigest({}), /^[0-9a-f]+$/, '空对象摘要应为十六进制串');
  assert.equal(api.localLibraryDbIndexDigest({}), api.localLibraryDbIndexDigest({}), '空对象摘要稳定');
});

test('resetLocalLibraryDbIndexDigests：代次变化不抛、摘要仍稳定', () => {
  const api = load();
  assert.doesNotThrow(() => api.resetLocalLibraryDbIndexDigests(0));
  assert.doesNotThrow(() => api.resetLocalLibraryDbIndexDigests(1));
  assert.doesNotThrow(() => api.resetLocalLibraryDbIndexDigests(1)); // 同代次幂等
  // 摘要函数与代次无关，reset 后仍确定性。
  assert.equal(api.localLibraryDbTextDigest('x'), api.localLibraryDbTextDigest('x'));
});

test('estimateTextBytes / estimateDataUrlBytes：按口径估算', () => {
  const api = load();
  assert.equal(api.estimateTextBytes('abcd'), 8, '文本按 长度*2');
  assert.equal(api.estimateTextBytes(''), 0);
  // data URL：逗号后 body * 0.75 四舍五入。
  assert.equal(api.estimateDataUrlBytes('data:image/png;base64,AAAA'), 3, '4 字节 body → 3');
  assert.equal(api.estimateDataUrlBytes(''), 0);
});

test('estimateLocalAssetRecordBytes / estimateLocalLyricRecordBytes：汇总各字段估算', () => {
  const api = load();
  const asset = api.estimateLocalAssetRecordBytes({
    name: 'ab', artist: 'cd', album: 'ef',
    localCoverThumbDataUrl: 'data:x,AAAA', localCoverDataUrl: 'data:x,AAAA',
  });
  // 256 基础 + (2+2+2)*2 文本 + 两次 (4*0.75≈3) = 256 + 12 + 6 = 274
  assert.equal(asset, 274);
  assert.equal(api.estimateLocalAssetRecordBytes(null), 0);

  const lyric = api.estimateLocalLyricRecordBytes({
    localLyricText: 'abcd', localLyricFileName: 'ab', localLyricTagName: '',
    localLyricFileSignature: 'xy', localLyricSource: 'z',
  });
  // 128 + text(4*2=8) + name(2*2=4) + tag(0) + sig(2*2=4) + source(1*2=2) = 146
  assert.equal(lyric, 146);
  assert.equal(api.estimateLocalLyricRecordBytes(null), 0);
});

test('localCoverThumbCacheKey：确定性 + 含长度信息', () => {
  const api = load();
  const k1 = api.localCoverThumbCacheKey('data:image/png;base64,AAAAAAA');
  const k2 = api.localCoverThumbCacheKey('data:image/png;base64,AAAAAAA');
  assert.equal(k1, k2, '同 dataUrl 同键');
  assert.ok(k1.includes(':'), '键应含冒号分段');
  assert.ok(k1.includes(':' + 'data:image/png;base64,AAAAAAA'.length + ':'), '键中段应含长度');
  assert.notEqual(k1, api.localCoverThumbCacheKey('data:image/png;base64,BBBBBBB'), '异文异键');
});
