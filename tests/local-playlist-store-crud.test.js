'use strict';

/**
 * 本地歌单 CRUD（03b-local-playlist-store.js）行为测试
 * 运行：node --test tests/local-playlist-store-crud.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appRoot = path.join(__dirname, '..');
const storePath = path.join(appRoot, 'public', 'js', 'modules', '05-playback', '03b-local-playlist-store.js');
const STORE_KEY = 'stellaflix-local-playlists';
const LEGACY_KEY = 'stellaflix-user-playlists';

function makeLocalStorage(initial) {
  const data = Object.assign({}, initial || {});
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
    _dump: () => JSON.parse(JSON.stringify(data)),
  };
}

function loadStore(initialStorage) {
  if (!fs.existsSync(storePath)) {
    throw new Error('local-playlist-store module not yet implemented: ' + storePath);
  }
  const source = fs.readFileSync(storePath, 'utf8');
  const localStorage = makeLocalStorage(initialStorage);
  const window = {};
  const sandbox = { window, localStorage, console, JSON, Math, Date, String, Number, Array, Object, Boolean };
  window.localStorage = localStorage;
  vm.runInNewContext(source, sandbox, { filename: storePath });
  return { window, localStorage, store: window.localPlaylistStore };
}

function localSong(key, name, extra) {
  return Object.assign({
    type: 'local',
    localKey: key,
    name: name,
    artist: '歌手' + key,
    album: '专辑' + key,
    duration: 200,
  }, extra || {});
}

test('ensureLocalUserPlaylistsLoaded is idempotent and non-recursive', () => {
  const { window } = loadStore();
  assert.strictEqual(typeof window.ensureLocalUserPlaylistsLoaded, 'function');
  const first = window.ensureLocalUserPlaylistsLoaded();
  const second = window.ensureLocalUserPlaylistsLoaded(true);
  assert.ok(first && first.ok === true);
  assert.ok(second && second.ok === true);
  assert.ok(Array.isArray(window.userPlaylists));
});

test('createLocalPlaylist persists a flagged playlist under the dedicated key', () => {
  const { window, localStorage } = loadStore();
  const r = window.localPlaylistStore.create('民谣');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.created, true);
  assert.strictEqual(r.playlist.localUserPlaylist, true);
  const saved = JSON.parse(localStorage.getItem(STORE_KEY));
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].name, '民谣');
});

test('create with duplicate name returns the existing playlist instead of a second one', () => {
  const { window } = loadStore();
  const a = window.localPlaylistStore.create('emo');
  const b = window.localPlaylistStore.create('emo');
  assert.strictEqual(b.ok, true);
  assert.strictEqual(b.created, false);
  assert.strictEqual(a.playlist.id, b.playlist.id);
});

test('renameLocalPlaylist updates name and persists', () => {
  const { window, localStorage } = loadStore();
  const a = window.localPlaylistStore.create('老歌');
  const r = window.localPlaylistStore.rename(a.playlist.id, '华语经典');
  assert.strictEqual(r.ok, true);
  const saved = JSON.parse(localStorage.getItem(STORE_KEY));
  assert.strictEqual(saved[0].name, '华语经典');
});

test('rename to an existing name is rejected', () => {
  const { window } = loadStore();
  const a = window.localPlaylistStore.create('古风');
  const b = window.localPlaylistStore.create('纯音乐');
  const r = window.localPlaylistStore.rename(b.playlist.id, '古风');
  assert.notStrictEqual(r.ok, true);
  assert.strictEqual(window.localPlaylistStore.list().length, 2);
});

test('deleteLocalPlaylist removes and persists', () => {
  const { window, localStorage } = loadStore();
  const a = window.localPlaylistStore.create('贝斯');
  const b = window.localPlaylistStore.create('英文说唱');
  const r = window.localPlaylistStore.remove(a.playlist.id);
  assert.strictEqual(r.ok, true);
  const saved = JSON.parse(localStorage.getItem(STORE_KEY));
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].id, b.playlist.id);
});

test('addSong stores the song and dedupes by localKey', () => {
  const { window } = loadStore();
  const a = window.localPlaylistStore.create('中文说唱');
  const song = localSong('k1', 'roma');
  const r1 = window.localPlaylistStore.addSong(a.playlist.id, song);
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.added, 1);
  const r2 = window.localPlaylistStore.addSong(a.playlist.id, localSong('k1', 'roma 重复'));
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.added, 0);
  assert.strictEqual(r2.duplicate, true);
  assert.strictEqual(window.localPlaylistStore.get(a.playlist.id).songs.length, 1);
});

test('removeSong drops the entry by localKey', () => {
  const { window } = loadStore();
  const a = window.localPlaylistStore.create('悲缓歌区');
  window.localPlaylistStore.addSong(a.playlist.id, localSong('k1', '一'));
  window.localPlaylistStore.addSong(a.playlist.id, localSong('k2', '二'));
  const r = window.localPlaylistStore.removeSong(a.playlist.id, 'k1');
  assert.strictEqual(r.ok, true);
  const pl = window.localPlaylistStore.get(a.playlist.id);
  assert.strictEqual(pl.songs.length, 1);
  assert.strictEqual(pl.songs[0].localKey, 'k2');
});

test('resolveLocalPlaylistSongs refreshes stored songs from the current library by localKey', () => {
  const { window } = loadStore();
  const a = window.localPlaylistStore.create('民谣');
  window.localPlaylistStore.addSong(a.playlist.id, localSong('k1', '旧名', { localUrl: 'stale://old' }));
  const library = [localSong('k1', '新名', { localUrl: 'stellaflix-local://audio/fresh' })];
  const resolved = window.localPlaylistStore.resolveSongs(a.playlist.id, library);
  assert.strictEqual(resolved.songs.length, 1);
  assert.strictEqual(resolved.songs[0].name, '新名');
  assert.strictEqual(resolved.songs[0].localUrl, 'stellaflix-local://audio/fresh');
  assert.strictEqual(resolved.missingCount, 0);
});

test('resolveLocalPlaylistSongs reports songs whose file left the library as missing', () => {
  const { window } = loadStore();
  const a = window.localPlaylistStore.create('民谣');
  window.localPlaylistStore.addSong(a.playlist.id, localSong('k1', '在库'));
  window.localPlaylistStore.addSong(a.playlist.id, localSong('gone', '已删'));
  const resolved = window.localPlaylistStore.resolveSongs(a.playlist.id, [localSong('k1', '在库')]);
  assert.strictEqual(resolved.songs.length, 1);
  assert.strictEqual(resolved.missingCount, 1);
});

test('legacy playlists under stellaflix-user-playlists migrate on first load', () => {
  const legacy = {
    [LEGACY_KEY]: JSON.stringify([
      { id: 'old-1', name: '旧歌单', localUserPlaylist: true, songs: [localSong('k9', '老歌')] },
      { id: 'net-1', name: '在线歌单', provider: 'netease', songs: [] },
    ]),
  };
  const { window, localStorage } = loadStore(legacy);
  const list = window.localPlaylistStore.list();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, 'old-1');
  // 非本地歌单不能被写进专用键
  const saved = JSON.parse(localStorage.getItem(STORE_KEY));
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].id, 'old-1');
});

test('saveLocalUserPlaylists global persists store and never touches the legacy key', () => {
  const legacyRaw = JSON.stringify([{ id: 'net-1', name: '在线', provider: 'netease' }]);
  const { window, localStorage } = loadStore({ [LEGACY_KEY]: legacyRaw });
  window.localPlaylistStore.create('纯音乐');
  assert.strictEqual(window.saveLocalUserPlaylists(), true);
  assert.strictEqual(localStorage.getItem(LEGACY_KEY), legacyRaw);
  const saved = JSON.parse(localStorage.getItem(STORE_KEY));
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].name, '纯音乐');
});

test('store playlists are mirrored into window.userPlaylists for agent tools', () => {
  const { window } = loadStore();
  const a = window.localPlaylistStore.create('民谣');
  assert.ok(Array.isArray(window.userPlaylists));
  const mirrored = window.userPlaylists.filter((pl) => pl && pl.localUserPlaylist);
  assert.strictEqual(mirrored.length, 1);
  assert.strictEqual(mirrored[0].id, a.playlist.id);
  // 幂等：再同步一次不产生重复
  window.ensureLocalUserPlaylistsLoaded(true);
  assert.strictEqual(window.userPlaylists.filter((pl) => pl && pl.localUserPlaylist).length, 1);
});

test('agent-adapter self-recursive stubs are gone', () => {
  const adapter = fs.readFileSync(path.join(appRoot, 'public', 'js', 'agent-adapter.js'), 'utf8');
  assert.doesNotMatch(adapter, /window\.ensureLocalUserPlaylistsLoaded = function \(\) \{\s*\n\s*if \(typeof window\.ensureLocalUserPlaylistsLoaded === 'function'\)/);
  assert.doesNotMatch(adapter, /window\.saveLocalUserPlaylists = function \(\) \{\s*\n\s*if \(typeof window\.saveLocalUserPlaylists === 'function'\)/);
});
