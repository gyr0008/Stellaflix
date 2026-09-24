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
