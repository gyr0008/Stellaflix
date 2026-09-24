'use strict';

/**
 * 追片 canonical 键（tmdb:<mt>:<id>）+ 多键读写原语行为测试
 * 运行：node --test tests/track-canonical-key.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadModel() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'video', 'model.js'), 'utf8');
  const store = {};
  const sandbox = {
    console, JSON, Math, Date, String, Number, Array, Object, Boolean, Promise, parseInt, setTimeout,
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'model.js' });
  return sandbox.StellaflixVideo.model;
}

test('canonicalTrackKey：TMDB 墙视图（id+mediaType）得 tmdb 键', () => {
  const m = loadModel();
  assert.strictEqual(m.canonicalTrackKey({ id: 284054, mediaType: 'movie' }), 'tmdb:movie:284054');
  assert.strictEqual(m.canonicalTrackKey({ id: 1399, mediaType: 'tv' }), 'tmdb:tv:1399');
});

test('canonicalTrackKey：_tmdb 优先；tmdb: 前缀 key 直通；源键/无 id 得 null', () => {
  const m = loadModel();
  assert.strictEqual(m.canonicalTrackKey({ _tmdb: { id: 5, mediaType: 'tv' }, id: 9, mediaType: 'movie' }), 'tmdb:tv:5');
  assert.strictEqual(m.canonicalTrackKey({ key: 'tmdb:movie:77' }), 'tmdb:movie:77');
  assert.strictEqual(m.canonicalTrackKey({ key: 's1:1048', vodId: 1048 }), null);
  assert.strictEqual(m.canonicalTrackKey(null), null);
  assert.strictEqual(m.canonicalTrackKey({ title: '无id' }), null);
});

test('getTrackStatusForKeys：按候选顺序取首个命中；全 miss 得 null', () => {
  const m = loadModel();
  m.setTrackStatus('s1:1048', 'watching');
  assert.strictEqual(m.getTrackStatusForKeys(['tmdb:movie:284054', 's1:1048']), 'watching');
  assert.strictEqual(m.getTrackStatusForKeys(['tmdb:movie:1']), null);
  assert.strictEqual(m.getTrackStatusForKeys([]), null);
});

test('setTrackStatusForKeys：写主键、清别名键（惰性迁移）、按主键播种 meta', () => {
  const m = loadModel();
  m.setTrackStatus('s1:1048', 'watching');
  const r = m.setTrackStatusForKeys(
    ['tmdb:movie:284054', 's1:1048'], 'planToWatch',
    { title: '末世橡樹街', pic: 'https://x/p.jpg', year: '2026' }
  );
  assert.strictEqual(r, 'planToWatch');
  assert.strictEqual(m.getTrackStatus('tmdb:movie:284054'), 'planToWatch');
  assert.strictEqual(m.getTrackStatus('s1:1048'), null, '别名键必须被清除，避免追片页双条目');
  const meta = m.getMeta('tmdb:movie:284054');
  assert.ok(meta, 'TMDB 主键首次追片须播种 meta，供追片页渲染标题封面');
  assert.strictEqual(meta.title, '末世橡樹街');
});

test('setTrackStatusForKeys(null)：循环回未追时两键全清', () => {
  const m = loadModel();
  m.setTrackStatusForKeys(['tmdb:movie:9', 's2:1'], 'watched', { title: 't' });
  m.setTrackStatusForKeys(['tmdb:movie:9', 's2:1'], null);
  assert.strictEqual(m.getTrackStatus('tmdb:movie:9'), null);
  assert.strictEqual(m.getTrackStatus('s2:1'), null);
});

test('setTrackStatusForKeys：无候选键得 null 且不抛', () => {
  const m = loadModel();
  assert.strictEqual(m.setTrackStatusForKeys([], 'watching'), null);
  assert.strictEqual(m.setTrackStatusForKeys(null, 'watching'), null);
});

// ---- 审查修复 I-1 / I-2 / I-3 + 非字符串候选键 ----

test('setTrackStatusForKeys(null)：clear 恒返 null，两键与主键 meta 全清', () => {
  const m = loadModel();
  m.setMeta({ key: 'tmdb:movie:9', title: '标题', pic: '', year: '' });
  m.setTrackStatusForKeys(['tmdb:movie:9', 's2:1'], 'watched');
  m.setTrackStatus('s2:1', 'watched'); // 存量脏数据：别名键仍有状态
  const r = m.setTrackStatusForKeys(['tmdb:movie:9', 's2:1'], null);
  assert.strictEqual(r, null, '清除动作必须返回 null，不得回吐别名旧状态');
  assert.strictEqual(m.getTrackStatus('tmdb:movie:9'), null);
  assert.strictEqual(m.getTrackStatus('s2:1'), null);
  assert.strictEqual(m.getMeta('tmdb:movie:9'), null, '取消追片须同步清理主键 meta');
});

test('setTrackStatusForKeys：无效状态整体短路——主键与别名键及其 meta 均不触碰', () => {
  const m = loadModel();
  m.setTrackStatus('tmdb:movie:9', 'watching');
  m.setTrackStatus('s2:1', 'planToWatch');
  m.setMeta({ key: 's2:1', title: '別名標題', pic: 'https://x/a.jpg', year: '2024' });
  const r = m.setTrackStatusForKeys(['tmdb:movie:9', 's2:1'], 'banana');
  assert.strictEqual(r, 'watching', '无效状态返回当前状态，等价于无操作');
  assert.strictEqual(m.getTrackStatus('tmdb:movie:9'), 'watching');
  assert.strictEqual(m.getTrackStatus('s2:1'), 'planToWatch', '无效状态不得清除别名键');
  const aliasMeta = m.getMeta('s2:1');
  assert.ok(aliasMeta && aliasMeta.title === '別名標題', '无效状态不得删除别名键 meta');
});

test('setTrackStatusForKeys：无 meta 入参时把别名键 meta 携带到主键，避免合并后未命名', () => {
  const m = loadModel();
  m.setTrackStatus('s2:1', 'watching');
  m.setMeta({ key: 's2:1', title: '異形', pic: 'https://x/a.jpg', year: '1979' });
  const r = m.setTrackStatusForKeys(['tmdb:movie:9', 's2:1'], 'watching');
  assert.strictEqual(r, 'watching');
  assert.strictEqual(m.getTrackStatus('s2:1'), null, '别名键仍须清除');
  const meta = m.getMeta('tmdb:movie:9');
  assert.ok(meta, '清别名键前须把其 meta 携带到 TMDB 主键，供追片页渲染');
  assert.strictEqual(meta.title, '異形');
  assert.strictEqual(meta.pic, 'https://x/a.jpg');
  assert.strictEqual(meta.year, '1979');
});

test('setTrackStatusForKeys：非字符串候选键被忽略且不抛', () => {
  const m = loadModel();
  let r;
  assert.doesNotThrow(() => {
    r = m.setTrackStatusForKeys([undefined, 123, {}, null, 'tmdb:movie:9', 'tmdb:movie:9'], 'watching');
  });
  assert.strictEqual(r, 'watching');
  assert.strictEqual(m.getTrackStatus('tmdb:movie:9'), 'watching');
  assert.strictEqual(m.setTrackStatusForKeys([0, false, {}], 'watching'), null, '全非字符串候选等价于无候选');
});
