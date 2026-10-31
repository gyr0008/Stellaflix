'use strict';

/**
 * 本地歌曲收藏到本地歌单（06-track-detail-lyrics-actions.js）行为测试
 * 运行：node --test tests/local-collect-adapter.test.js
 *
 * 批 T16d：平台收藏写回适配器（songAccountAdapter 表）随平台登录退役删除，
 * 收藏弹窗只服务本地歌单（localPlaylistStore）；本测试改钉该现状。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appRoot = path.join(__dirname, '..');
const detailPath = path.join(appRoot, 'public', 'js', 'modules', '05-playback', '06-track-detail-lyrics-actions.js');
const source = fs.readFileSync(detailPath, 'utf8');

function sliceBetween(startMarker, endMarker) {
  const s = source.indexOf(startMarker);
  assert.notStrictEqual(s, -1, 'start marker missing: ' + startMarker);
  const e = source.indexOf(endMarker, s);
  assert.notStrictEqual(e, -1, 'end marker missing: ' + endMarker);
  return source.slice(s, e);
}

function makeSandbox() {
  const calls = { apiJson: 0, toasts: [], ensureLoggedIn: 0 };
  const els = {};
  function fakeEl(id) {
    if (!els[id]) els[id] = { id, innerHTML: '', value: '', textContent: '', style: {}, classList: { add() {}, remove() {}, toggle() {} }, querySelectorAll: () => [], querySelector: () => null, addEventListener() {} };
    return els[id];
  }
  const sandbox = {
    console, JSON, Math, Date, String, Number, Array, Object, Boolean, Promise, setTimeout, encodeURIComponent,
    calls,
    document: { getElementById: fakeEl, querySelector: () => null, querySelectorAll: () => [], body: fakeEl('body') },
    window: {},
    escHtml: (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    showToast: (msg) => { calls.toasts.push(String(msg)); },
    apiJson: async () => { calls.apiJson += 1; return {}; },
    // 反证桩：平台登录闸已退役，收藏路径不得再调用它
    ensureLoggedInForAction: () => { calls.ensureLoggedIn += 1; return true; },
    playlistAccountProvider: (pl) => (pl && pl.provider) || 'netease',
    refreshUserPlaylists: async () => [],
    openGsapModal: (el) => { calls.openedModal = el && el.id; },
    closeGsapModal: (el, done) => { if (done) done(); },
    closeCollectModal: () => { calls.closedModal = true; },
    renderCollectModal: () => {},
    setCollectBusyPid: () => {},
    updateLikeButtons: () => {},
    safeRenderQueuePanel: () => {},
    songCoverSrc: () => '',
    coverUrlWithSize: (u) => String(u || ''),
    miniQueueSkeleton: () => '<div class="skeleton"></div>',
    animateListItems: () => {},
    verifySongInPlaylist: async () => true,
    currentCoverSong: () => null,
    hydrateCustomCover: (s) => s,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

function localSong() {
  return { type: 'local', localKey: 'k1', id: 'local:abc', name: '雨天', artist: '偶尔胆怯', album: '某专辑' };
}

function fakeStore(playlists) {
  const list = (playlists || []).slice();
  return {
    list: () => list.slice(),
    get: (id) => list.find((pl) => String(pl.id) === String(id)) || null,
    create: (name) => {
      const pl = { id: 'local-pl-new', name, songs: [], localUserPlaylist: true, trackCount: 0 };
      list.push(pl);
      return { ok: true, created: true, playlist: pl };
    },
    addSong: (id, song) => {
      const pl = list.find((p) => String(p.id) === String(id));
      if (!pl) return { ok: false, error: 'PLAYLIST_NOT_FOUND' };
      pl.songs.push(song);
      pl.trackCount = pl.songs.length;
      return { ok: true, added: 1, duplicate: false, playlist: pl };
    },
  };
}

test('平台收藏写回适配器已随登录态退役，不再出现在源码里', () => {
  assert.equal(source.indexOf('songAccountAdapter'), -1, 'songAccountAdapter 应随平台登录退役删除');
});

test('openCollectModal for a local song skips platform login', () => {
  const sb = makeSandbox();
  sb.localSong = localSong();
  sb.localPlaylistStore = fakeStore([{ id: 'lp1', name: '民谣', songs: [], localUserPlaylist: true }]);
  vm.runInContext(sliceBetween('function openCollectModal(song)', 'function openCollectModalForCurrent'), sb, { filename: 'openCollectModal.js' });
  vm.runInContext('openCollectModal(localSong)', sb);
  assert.strictEqual(sb.calls.ensureLoggedIn, 0, 'local collect must not require platform login');
  assert.strictEqual(sb.calls.openedModal, 'collect-modal');
});

test('renderCollectModal lists local playlists for a local song', () => {
  const sb = makeSandbox();
  sb.collectTargetSong = localSong();
  sb.localPlaylistStore = fakeStore([
    { id: 'lp1', name: '民谣', songs: [], localUserPlaylist: true },
    { id: 'lp2', name: 'emo', songs: [], localUserPlaylist: true },
  ]);
  vm.runInContext(sliceBetween('function renderCollectModal()', 'async function createPlaylistFromCollect'), sb, { filename: 'renderCollectModal.js' });
  vm.runInContext('renderCollectModal()', sb);
  const html = sb.document.getElementById('collect-list').innerHTML;
  assert.match(html, /民谣/);
  assert.match(html, /emo/);
  assert.match(html, /data-collect-pid="lp1"/);
});

test('addCollectTargetToPlaylist writes a local song through the store without any HTTP call', async () => {
  const sb = makeSandbox();
  const store = fakeStore([{ id: 'lp1', name: '民谣', songs: [], localUserPlaylist: true }]);
  sb.localPlaylistStore = store;
  sb.collectTargetSong = localSong();
  sb.collectBusy = false;
  vm.runInContext(sliceBetween('async function addCollectTargetToPlaylist', 'function cloneSong'), sb, { filename: 'addCollect.js' });
  await vm.runInContext('addCollectTargetToPlaylist("lp1")', sb);
  assert.strictEqual(sb.calls.apiJson, 0, 'local collect must not hit platform APIs');
  assert.strictEqual(store.get('lp1').songs.length, 1);
  assert.strictEqual(sb.collectBusy, false);
});

test('createPlaylistFromCollect creates a local playlist for a local song', async () => {
  const sb = makeSandbox();
  const store = fakeStore([]);
  sb.localPlaylistStore = store;
  sb.collectTargetSong = localSong();
  sb.document.getElementById('collect-new-name').value = '悲缓歌区';
  vm.runInContext(sliceBetween('async function createPlaylistFromCollect', 'async function addCollectTargetToPlaylist'), sb, { filename: 'createCollect.js' });
  await vm.runInContext('createPlaylistFromCollect()', sb);
  assert.strictEqual(sb.calls.apiJson, 0);
  const created = store.list().find((pl) => pl.name === '悲缓歌区');
  assert.ok(created, 'local playlist should be created through the store');
});
