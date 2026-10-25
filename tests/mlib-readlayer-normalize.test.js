'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..',
  'public', 'js', 'modules', '04-shelf', '07-mlib-readlayer.js'), 'utf8');

function load() {
  const sandbox = { console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: '07-mlib-readlayer.js' });
  return sandbox.window.stellaMlibRead;
}

const T = (o) => Object.assign({
  id: 't' + Math.random(), name: 'n', artist: 'a', artistId: 'A1',
  album: 'al', albumId: 'AL1', cover: '', duration: 200,
  source: 'local-file', localFile: 'x.mp3', matched: true,
}, o);

test('albumsFromTracks: 按 albumId 归并，无 albumId 不进轴', () => {
  const { albumsFromTracks } = load();
  const cards = albumsFromTracks([
    T({ albumId: 'AL1', album: 'X', cover: '' }),
    T({ albumId: 'AL1', album: 'X', cover: 'c1.jpg' }),
    T({ albumId: '', album: 'Y' }),
  ]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, 'AL1');
  assert.equal(cards[0].count, 2);
  assert.equal(cards[0].cover, 'c1.jpg', '代表封面=任一带封面曲目');
  assert.equal(cards[0].title, 'X');
});

test('artistsFromTracks: 同 artistId 异名并一张，同名异 id 不并', () => {
  const { artistsFromTracks } = load();
  const cards = artistsFromTracks([
    T({ artistId: 'A1', artist: '张三' }),
    T({ artistId: 'A1', artist: 'Zhang San' }),
    T({ artistId: 'A2', artist: '张三' }),
  ]);
  assert.deepEqual(cards.map((c) => c.id).sort(), ['A1', 'A2']);
  assert.equal(cards.find((c) => c.id === 'A1').count, 2);
});

test('sortKey/sortBucket: 拉丁按名、CJK 判档、数字符号归 other、拼音缺失常 latin 档走 pinyin 兜底键', () => {
  const { artistsFromTracks } = load();
  const cards = artistsFromTracks([
    T({ artistId: 'L1', artist: 'Beatles' }),
    T({ artistId: 'C1', artist: '张三' }),
    T({ artistId: 'N1', artist: '100%' }),
  ]);
  const byId = Object.fromEntries(cards.map((c) => [c.id, c]));
  assert.equal(byId.L1.sortBucket, 'latin');
  assert.equal(byId.C1.sortBucket, 'other', 'CJK 无 sortKeyPinyin → 其他组');
  assert.equal(byId.N1.sortBucket, 'other');
  assert.equal(byId.L1.sortKey, 'Beatles'.toLowerCase());
});

test('拼音提供时 CJK 进 cjk 档', () => {
  const { artistsFromTracks } = load();
  const cards = artistsFromTracks([T({ artistId: 'C1', artist: '张三', sortKeyPinyin: 'zhangsan' })]);
  assert.equal(cards[0].sortBucket, 'cjk');
  assert.equal(cards[0].sortKey, 'zhangsan');
});

test('playlistsFrom: 直接映射不聚合，count 缺省用 trackIds 长度', () => {
  const { playlistsFrom } = load();
  const cards = playlistsFrom([{ id: 'P1', title: '我的', cover: 'c', trackIds: ['a', 'b'], addedAt: 5 }]);
  assert.deepEqual(cards[0], {
    id: 'P1', title: '我的', sub: '', cover: 'c', count: 2,
    sortKey: 'p1', sortBucket: 'playlist', playable: true,
    meta: { addedAt: 5 },
  });
});
