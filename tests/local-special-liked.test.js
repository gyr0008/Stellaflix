'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_PATH = path.join(__dirname, '..', 'public', 'js', 'modules', '05-playback', '21-local-special-liked.js');
const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
const PRELOAD_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'preload.js'), 'utf8');
const SLICE_START = 'function specialLikedSongPath(song)';
const SLICE_END = '/* ---- 切片终点（tests/local-special-liked.test.js 的 marker，勿删） ---- */';

/**
 * 读取模块源码里被测试的那一截：门面之上的 Narrative 层（引用表 + 快表 + 开关）。
 * @returns {string} 待求值源码。
 */
function readModuleSlice() {
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  const start = source.indexOf(SLICE_START);
  const end = source.indexOf(SLICE_END, start);
  assert.ok(start > 0, '模块里找不到切片起点：' + SLICE_START);
  assert.ok(end > start, '模块里找不到切片终点 marker');
  return source.slice(start, end);
}

/**
 * 在假上下文里求值中央存储层切片。定时器、真实 localStorage、SQLite 桥全部注入替身。
 * @param {string} initialStorage 引用表初值。
 * @param {object} [extra] 追加到上下文里的成员。
 * @returns {{context: object, storage: Map<string,string>}} 上下文与存储替身。
 */
function createContext(initialStorage = '[]', extra) {
  const storage = new Map([['stellaflix-special-liked-playlist-v1', initialStorage]]);
  const base = {
    Array,
    Object,
    String,
    Set,
    SPECIAL_LIKED_PLAYLIST_STORE_KEY: 'stellaflix-special-liked-playlist-v1',
    specialLikedSongRefs: null,
    specialLikedLookupCache: { refs: null, keys: null, paths: null },
    localLibraryReady: false,
    localLibrarySongs: [],
    playQueue: [],
    localStorage: { getItem: (key) => storage.get(key) || null },
    setPersistentLocalStorageItem: (key, value) => storage.set(key, value),
    songAccountStateKey: (song) => (song && song.provider && song.id ? song.provider + ':' + song.id : ''),
    callLocalLibraryDb: () => {},
    localLibraryPathKeyFromSong: () => '',
    localLibraryDbSongKeyFromSong: () => '',
    syncLocalLibraryDbFavorite: (song, favorite) => { dbWrites.push([song && song.localKey, !!favorite]); },
    showToast: () => {},
  };
  const dbWrites = [];
  const context = Object.assign(base, extra || {}, { dbWrites });
  vm.runInNewContext(
    `${readModuleSlice()}
this.api = { specialLikedSongPath, specialLikedSongKey, compactSpecialLikedSongRefs, readSpecialLikedSongRefs, writeSpecialLikedSongRefs, specialLikedSongRefIndex, isSpecialLikedSong, getSpecialLikedSongs, toggleSpecialLikedSong, syncSpecialLikedOnlineRef };`,
    context,
  );
  return { context, storage, dbWrites };
}

test('特别喜欢支持添加、移除和引用去重', () => {
  const { context, storage } = createContext();
  const song = { type: 'local', localKey: 'track-a', localFilePathAbsolute: 'D:\\Music\\A.mp3', name: 'A', artist: '歌手' };

  assert.equal(context.api.toggleSpecialLikedSong(song), true);
  assert.equal(context.api.specialLikedSongRefIndex(song), 0);
  assert.equal(JSON.parse(storage.get('stellaflix-special-liked-playlist-v1')).length, 1);

  const compacted = context.api.compactSpecialLikedSongRefs([
    { key: 'local-key:track-a', path: 'D:/Music/A.mp3' },
    { key: 'local-key:track-a', path: 'D:/Music/A.mp3' },
  ]);
  assert.equal(compacted.length, 1);

  assert.equal(context.api.toggleSpecialLikedSong(song), false);
  assert.equal(context.api.specialLikedSongRefIndex(song), -1);
  assert.equal(JSON.parse(storage.get('stellaflix-special-liked-playlist-v1')).length, 0);
});

test('引用表读写会把路径里的反斜杠归一成正斜杠', () => {
  const { context, storage } = createContext();
  const song = { type: 'local', localKey: 'track-a', localFilePathAbsolute: 'D:\\Music\\Rock\\A.mp3', name: 'A' };
  context.api.toggleSpecialLikedSong(song);
  const refs = JSON.parse(storage.get('stellaflix-special-liked-playlist-v1'));
  assert.equal(refs[0].path, 'd:/music/rock/a.mp3');
  assert.equal(refs[0].key, 'local-key:track-a');
});

test('快表与线性扫描等价，并在引用变更后失效重建', () => {
  const refs = JSON.stringify([
    { key: 'local-key:a', path: 'd:/music/a.mp3', name: 'A' },
    { key: 'local-key:legacy', path: 'd:/music/b.mp3', name: 'B' },
  ]);
  const { context } = createContext(refs);
  const byKey = { type: 'local', localKey: 'a', localFilePathAbsolute: 'D:\\Music\\A.mp3', name: 'A' };
  // key 不同但路径命中（重新定位后 localKey 变了——正是 09-18 重新本地定位要解的情况）。
  const byPath = { type: 'local', localKey: 'renamed', localFilePathAbsolute: 'D:\\Music\\B.mp3', name: 'B' };
  const miss = { type: 'local', localKey: 'z', localFilePathAbsolute: 'D:\\Music\\Z.mp3', name: 'Z' };

  [byKey, byPath, miss].forEach((song) => {
    assert.equal(context.api.isSpecialLikedSong(song), context.api.specialLikedSongRefIndex(song) >= 0);
  });
  assert.equal(context.api.isSpecialLikedSong(byKey), true);
  assert.equal(context.api.isSpecialLikedSong(byPath), true);
  assert.equal(context.api.isSpecialLikedSong(miss), false);

  context.api.toggleSpecialLikedSong(byKey);
  assert.equal(context.api.isSpecialLikedSong(byKey), false);
  assert.equal(context.api.specialLikedSongRefIndex(byKey), -1);
  assert.equal(context.api.isSpecialLikedSong(byPath), true);
});

test('特别喜欢按保存引用顺序生成播放列表', () => {
  const refs = JSON.stringify([
    { key: 'local-key:b', path: 'd:/music/b.mp3' },
    { key: 'local-key:a', path: 'd:/music/a.mp3' },
    { key: 'local-key:stale', path: 'd:/music/a.mp3' },
  ]);
  const { context } = createContext(refs);
  const songA = { type: 'local', localKey: 'a', localFilePathAbsolute: 'D:\\Music\\A.mp3', name: 'A' };
  const songB = { type: 'local', localKey: 'b', localFilePathAbsolute: 'D:\\Music\\B.mp3', name: 'B' };
  context.localLibraryReady = true;
  context.localLibrarySongs = [songA, songB];

  const songs = context.api.getSpecialLikedSongs();

  assert.deepEqual(Array.from(songs, (song) => song.name), ['B', 'A']);
});

test('失效引用会清理，曲库未加载时不会误清理', () => {
  const refs = JSON.stringify([
    { key: 'local-key:valid', path: 'd:/music/valid.mp3' },
    { key: 'local-key:stale', path: 'd:/music/stale.mp3' },
  ]);
  const { context, storage } = createContext(refs);
  const valid = { type: 'local', localKey: 'valid', localFilePathAbsolute: 'D:\\Music\\Valid.mp3', name: 'Valid' };
  context.localLibraryReady = true;
  context.localLibrarySongs = [valid];

  const restored = context.api.getSpecialLikedSongs();
  assert.equal(restored.length, 1);
  assert.equal(restored[0].localKey, 'valid');
  const cleanedRefs = JSON.parse(storage.get('stellaflix-special-liked-playlist-v1'));
  assert.equal(cleanedRefs.length, 1);
  assert.equal(cleanedRefs[0].key, 'local-key:valid');

  const unloaded = createContext(refs);
  unloaded.context.localLibrarySongs = [];
  unloaded.context.playQueue = [];
  assert.equal(unloaded.context.api.getSpecialLikedSongs().length, 0);
  assert.equal(unloaded.storage.get('stellaflix-special-liked-playlist-v1'), refs);
});

test('本地歌点心会同步 SQLite favorite 镜像', () => {
  const { context, dbWrites } = createContext();
  const song = { type: 'local', localKey: 'track-a', localFilePathAbsolute: 'D:\\Music\\A.mp3', name: 'A' };
  context.api.toggleSpecialLikedSong(song);
  context.api.toggleSpecialLikedSong(song);
  assert.deepEqual(dbWrites, [['track-a', true], ['track-a', false]]);
});

test('Q1=B 双收：在线歌也能进特别喜欢，键是 online:provider:id', () => {
  const { context, storage, dbWrites } = createContext();
  const online = { provider: 'netease', id: '123456', name: '在线歌', type: 'netease' };

  assert.equal(context.api.toggleSpecialLikedSong(online), true);
  const refs = JSON.parse(storage.get('stellaflix-special-liked-playlist-v1'));
  assert.equal(refs[0].key, 'online:netease:123456');
  assert.equal(context.api.isSpecialLikedSong(online), true);

  assert.equal(context.api.toggleSpecialLikedSong(online), false);
  assert.equal(context.api.isSpecialLikedSong(online), false);
  // 在线歌没有本地文件：加/减两条路径都不许往 SQLite 本地统计写 favorite（避免孤儿行）。
  assert.deepEqual(dbWrites, []);
});

test('Q1=B 双收：在线歌列表可由宿主注入曲池参与聚合', () => {
  const refs = JSON.stringify([{ key: 'online:netease:9', path: '', name: '在线' }]);
  const online = { provider: 'netease', id: '9', name: '在线', type: 'netease' };
  const { context } = createContext(refs, { localImportedSongPool: () => [online] });
  context.localLibraryReady = true;
  context.localLibrarySongs = [];

  const songs = context.api.getSpecialLikedSongs();
  // 数组诞生在 vm realm 里，deepStrictEqual 会因为原型不同面红，这里逐个字段断言。
  assert.equal(songs.length, 1);
  assert.equal(songs[0].id, '9');
  assert.equal(songs[0].name, '在线');
  assert.equal(context.api.isSpecialLikedSong(online), true);
});

test('平台红心写回成功后同步本地引用，不重复占位', () => {
  const { context, storage } = createContext();
  const online = { provider: 'netease', id: '7', name: '在线歌' };
  context.api.syncSpecialLikedOnlineRef(online, true);
  context.api.syncSpecialLikedOnlineRef(online, true);
  assert.equal(JSON.parse(storage.get('stellaflix-special-liked-playlist-v1')).length, 1);
  context.api.syncSpecialLikedOnlineRef(online, false);
  assert.equal(JSON.parse(storage.get('stellaflix-special-liked-playlist-v1')).length, 0);
});

test('主进程与 preload 的 favorite 通道已就位且走信任闸', () => {
  assert.match(MAIN_SOURCE, /ipcMain\.handle\('stellaflix-local-library-db-set-favorite',[\s\S]{0,240}isTrustedMainWindowIpc[\s\S]{0,200}store\.setFavorite\(payload \|\| \{\}\)/);
  assert.match(PRELOAD_SOURCE, /setLocalLibraryDbFavorite: \(payload\) => ipcRenderer\.invoke\('stellaflix-local-library-db-set-favorite', payload \|\| \{\}\)/);
});

test('移植层不残留参照库门牌号', () => {
  assert.doesNotMatch(fs.readFileSync(MODULE_PATH, 'utf8'), /mineradio/i, '模块残留参照库门牌号');
  assert.doesNotMatch(MAIN_SOURCE, /mineradio/i, 'main.js 残留参照库门牌号');
  assert.doesNotMatch(PRELOAD_SOURCE, /mineradio/i, 'preload.js 残留参照库门牌号');
});
