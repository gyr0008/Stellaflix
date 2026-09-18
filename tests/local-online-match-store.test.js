'use strict';

/**
 * 本地歌 ↔ 在线音源匹配缓存（03c-local-online-match.js）行为测试
 * 运行：node --test tests/local-online-match-store.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appRoot = path.join(__dirname, '..');
const modulePath = path.join(appRoot, 'public', 'js', 'modules', '05-playback', '03c-local-online-match.js');
const STORE_KEY = 'stellaflix-local-online-match-v1';

function makeLocalStorage(initial) {
  const data = Object.assign({}, initial || {});
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
    _dump: () => JSON.parse(JSON.stringify(data)),
  };
}

function makeSandbox(initialStorage, overrides) {
  if (!fs.existsSync(modulePath)) {
    throw new Error('local-online-match module not yet implemented: ' + modulePath);
  }
  const source = fs.readFileSync(modulePath, 'utf8');
  const localStorage = makeLocalStorage(initialStorage);
  const window = {};
  const searches = [];
  const sandbox = Object.assign({
    window,
    localStorage,
    console,
    JSON,
    Math,
    Date,
    String,
    Number,
    Array,
    Object,
    Boolean,
    Promise,
    setTimeout,
    apiJson: async () => ({ songs: [] }),
    controlSourceSearchUrl: (provider, query) => '/api/' + provider + '/search?keywords=' + encodeURIComponent(query),
    accountProviderOrder: () => ['netease', 'qq', 'kugou'],
    isSameTitleArtist: (source, candidate) => !!(source && candidate && source.name === candidate.name),
    queueItemKey: (song) => (song && song.provider ? song.provider + ':' + song.id : 'song:' + song.id),
    playbackRestoreSongSnapshot: (song) => Object.assign({}, song),
  }, overrides || {});
  const rawApiJson = sandbox.apiJson;
  sandbox.apiJson = async (url, opts) => {
    searches.push(url);
    return rawApiJson(url, opts);
  };
  window.localStorage = localStorage;
  vm.runInNewContext(source, sandbox, { filename: modulePath });
  return { window, localStorage, searches, store: window.localOnlineMatchStore };
}

function localTrack(localKey, name) {
  return { type: 'local', source: 'local', localKey: localKey, name: name || 'demo song', artist: 'EKKSTACY', duration: 180 };
}

const VALID_KEY = 'a'.repeat(24);

test('store exposes the dedicated cache key and starts empty', () => {
  const { store } = makeSandbox();
  assert.strictEqual(store.STORE_KEY, STORE_KEY);
  assert.strictEqual(store.get(VALID_KEY), null);
  assert.deepStrictEqual(Object.keys(store.load()), []);
});

test('put persists a normalized entry (provider + online queue key + snapshot) under the dedicated key', () => {
  const { store, localStorage } = makeSandbox();
  const entry = store.put(VALID_KEY, 'netease', { provider: 'netease', id: 12345, name: 'demo song', artist: 'EKKSTACY' });
  assert.strictEqual(entry.provider, 'netease');
  assert.strictEqual(entry.key, 'netease:12345');
  assert.strictEqual(entry.snapshot.name, 'demo song');
  assert.ok(Number(entry.matchedAt) > 0);
  const saved = JSON.parse(localStorage.getItem(STORE_KEY));
  assert.strictEqual(saved[VALID_KEY].key, 'netease:12345');
});

test('corrupted cache JSON degrades to empty instead of throwing', () => {
  const { store } = makeSandbox({ [STORE_KEY]: '{not json' });
  assert.deepStrictEqual(Object.keys(store.load()), []);
  assert.strictEqual(store.get(VALID_KEY), null);
});

test('invalid localKey (not 24-hex) is rejected for get and put', () => {
  const { store } = makeSandbox();
  assert.strictEqual(store.get('zzz'), null);
  assert.strictEqual(store.put('short', 'netease', { id: 1 }), null);
});

test('remove deletes only the given localKey', () => {
  const { store, localStorage } = makeSandbox();
  store.put(VALID_KEY, 'netease', { provider: 'netease', id: 1, name: 'a' });
  store.put('b'.repeat(24), 'qq', { provider: 'qq', id: 2, name: 'b' });
  store.remove(VALID_KEY);
  const saved = JSON.parse(localStorage.getItem(STORE_KEY));
  assert.strictEqual(saved[VALID_KEY], undefined);
  assert.ok(saved['b'.repeat(24)]);
});

test('matchLocalSong returns cached song without any network call', async () => {
  const cachedEntry = { provider: 'netease', key: 'netease:777', matchedAt: 1, snapshot: { provider: 'netease', id: 777, name: 'demo song', artist: 'EKKSTACY' } };
  const { store, searches } = makeSandbox({ [STORE_KEY]: JSON.stringify({ [VALID_KEY]: cachedEntry }) });
  const song = await store.matchLocalSong(localTrack(VALID_KEY));
  assert.ok(song);
  assert.strictEqual(song.id, 777);
  assert.strictEqual(song.localOriginKey, VALID_KEY);
  assert.strictEqual(searches.length, 0);
});

test('matchLocalSong searches providers in order, keeps first title/artist match and caches it', async () => {
  const { store, searches, localStorage } = makeSandbox({}, {
    apiJson: async () => ({ songs: [{ id: 555, name: 'other', artist: 'x' }, { id: 556, name: 'demo song', artist: 'EKKSTACY' }] }),
  });
  const song = await store.matchLocalSong(localTrack(VALID_KEY));
  assert.strictEqual(song.id, 556);
  assert.strictEqual(song.localOriginKey, VALID_KEY);
  assert.strictEqual(searches.length, 1);
  const saved = JSON.parse(localStorage.getItem(STORE_KEY));
  assert.strictEqual(saved[VALID_KEY].key, 'netease:556');
});

test('matchLocalSong tries the next provider when the first has no match', async () => {
  const { store, searches } = makeSandbox({}, {
    apiJson: async (url) => (url.indexOf('/qq/') >= 0
      ? { songs: [{ provider: 'qq', id: 'MID1', name: 'demo song', artist: 'EKKSTACY' }] }
      : { songs: [] }),
  });
  const song = await store.matchLocalSong(localTrack(VALID_KEY));
  assert.strictEqual(song.provider, 'qq');
  assert.strictEqual(song.localOriginKey, VALID_KEY);
  assert.ok(searches.length >= 2);
});

test('matchLocalSong returns null and clears nothing when every provider fails (offline)', async () => {
  const { store, localStorage } = makeSandbox({}, {
    apiJson: async () => { throw new Error('Failed to fetch'); },
  });
  const song = await store.matchLocalSong(localTrack(VALID_KEY));
  assert.strictEqual(song, null);
  assert.strictEqual(localStorage.getItem(STORE_KEY), null);
});

test('matchLocalSong rejects non-local songs (no localKey)', async () => {
  const { store } = makeSandbox();
  const song = await store.matchLocalSong({ type: 'song', id: 1, name: 'x' });
  assert.strictEqual(song, null);
});

test('onlineSongForLocalSong is a synchronous cache-only lookup', () => {
  const cachedEntry = { provider: 'netease', key: 'netease:777', matchedAt: 1, snapshot: { provider: 'netease', id: 777, name: 'demo song' } };
  const { store } = makeSandbox({ [STORE_KEY]: JSON.stringify({ [VALID_KEY]: cachedEntry }) });
  const song = store.onlineSongForLocalSong(localTrack(VALID_KEY));
  assert.strictEqual(song.id, 777);
  assert.strictEqual(song.localOriginKey, VALID_KEY);
  assert.strictEqual(store.onlineSongForLocalSong(localTrack('c'.repeat(24))), null);
});
