'use strict';

/**
 * 本地/平台导入歌单详情面板行为测试（冒烟 bug 回归）
 * 运行：node --test tests/local-playlist-panel-detail.test.js
 * 前端：vm 沙箱加载 02-playlist-detail.js，断言 local provider 全链路：
 *   归一化 / 卡片 HTML（provider 徽标 + 封面不加 ?param）/ 详情短路（不请求 API、
 *   直接取内联 songs）/ 播放走 seedTracks；并回归 netease 路径不受影响。
 * 服务端：/api/playlist/tracks 对非数字歌单 id 必须 400 INVALID_PLAYLIST_ID，
 *   不再穿透到 NeteaseCloudMusicApi 抛 TypeError（500）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function makeEl(id) {
  return {
    id: id,
    innerHTML: '',
    scrollTop: 0,
    scrollHeight: 1200,
    clientHeight: 620,
    offsetTop: 0,
    style: {},
    listeners: {},
    addEventListener: function (type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); },
    getBoundingClientRect: function () { return { top: 0, bottom: this.clientHeight, left: 0, right: 800 }; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    scrollTo: function () { },
  };
}

function makeSandbox() {
  const els = {
    'pl-list': makeEl('pl-list'),
    'playlist-panel': makeEl('playlist-panel'),
    'mini-queue-list': makeEl('mini-queue-list'),
    'podcast-list': makeEl('podcast-list'),
  };
  const apiCalls = [];
  const playCalls = [];
  const sandbox = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    document: { getElementById: function (id) { return els[id] || null; } },
    window: { innerHeight: 800 },
    requestAnimationFrame: function () { return 0; },
    getComputedStyle: function () { return {}; },
    localStorage: { getItem: function () { return null; }, setItem: function () { }, },
    escHtml: function (s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
      });
    },
    songCoverSrc: function () { return ''; },
    cloneSong: function (song) { return Object.assign({}, song); },
    apiJson: function (url) { apiCalls.push(String(url)); return Promise.resolve({ tracks: [], hasMore: false, total: 0 }); },
    loadPlaylistIntoQueueById: function () { playCalls.push(Array.prototype.slice.call(arguments)); return Promise.resolve(true); },
    showToast: function () { },
    openArtistDetailForSong: function () { },
    requestNextPlaylistCatalogPage: null,
    PLAYLIST_LAZY_BATCH_SIZE: 48,
    QUEUE_PANEL_BATCH_SIZE: 48,
    QUEUE_VIRTUAL_ROW_STEP: 62,
    QUEUE_VIRTUAL_OVERSCAN: 8,
    PLAYLIST_PANEL_BATCH_SIZE: 48,
    PLAYLIST_CARD_VIRTUAL_OVERSCAN_PX: 760,
    PLAYLIST_DETAIL_INITIAL_RENDER: 48,
    PLAYLIST_DETAIL_BATCH_SIZE: 48,
    PLAYLIST_DETAIL_ROW_STEP: 56,
    PLAYLIST_DETAIL_VIRTUAL_OVERSCAN: 7,
    PLAYLIST_DETAIL_OUTER_CHROME_HEIGHT: 142,
    PLAYLIST_DETAIL_OUTER_FOOTER_HEIGHT: 44,
    PLAYLIST_QUEUE_INITIAL_BATCH_SIZE: 96,
    PLAYLIST_QUEUE_BACKGROUND_BATCH_SIZE: 160,
    userPlaylists: [],
    playlistCatalogRevision: 0,
    playlistRenderSeq: 0,
    playlistPanelRenderLimit: 48,
    queuePanelRenderLimit: 48,
    queuePanelRenderKey: '0',
    queuePanelVirtualState: { raf: 0 },
    miniQueueOpen: false,
    miniQueueLazyBound: true,
    queueViewTab: 'playlists',
    playQueue: [],
    currentIdx: -1,
    playlistPanelLazyBound: true,
    playlistCatalogSyncState: null,
    loginStatus: { loggedIn: false },
    myPodcastCollections: [],
  };
  sandbox.window.window = sandbox.window;
  sandbox.playCalls = playCalls;
  sandbox.apiCalls = apiCalls;
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '06-lyrics', '02-playlist-detail.js'), 'utf8');
  vm.runInContext(src, sandbox, { filename: '02-playlist-detail.js' });
  return { sandbox: sandbox, els: els, apiCalls: apiCalls, playCalls: playCalls };
}

test('normalizePlaylistProvider 认识 local，其余回退 netease', () => {
  const { sandbox } = makeSandbox();
  assert.equal(sandbox.normalizePlaylistProvider('local'), 'local');
  assert.equal(sandbox.normalizePlaylistProvider('qishui'), 'qishui');
  assert.equal(sandbox.normalizePlaylistProvider(undefined), 'netease');
  assert.equal(sandbox.playlistProviderName('local'), '本地歌单');
});

test('本地歌单卡片：provider=local、无 ?param 后缀、归入本地分组', () => {
  const { sandbox, els } = makeSandbox();
  sandbox.userPlaylists = [{
    id: 'local-pl-a', name: '欧美单曲', trackCount: 2, creator: '平台导入',
    cover: 'https://cdn.example/cover.jpg', localUserPlaylist: true,
    songs: [{ id: 's1', name: 'Song A' }, { id: 's2', name: 'Song B' }],
  }];
  sandbox.renderUserPlaylistsList({});
  const html = els['pl-list'].innerHTML;
  assert.match(html, /data-playlist-provider="local"/);
  assert.ok(!html.includes('https://cdn.example/cover.jpg?param='), '本地封面不得追加 ?param 后缀: ' + html);
  assert.match(html, /本地歌单/);
});

test('打开本地歌单详情：直接取内联 songs，不请求 /api/playlist/tracks', async () => {
  const { sandbox, apiCalls } = makeSandbox();
  sandbox.userPlaylists = [{
    id: 'local-pl-a', name: '欧美单曲', trackCount: 2, creator: '平台导入',
    localUserPlaylist: true,
    songs: [{ id: 's1', name: 'Song A' }, { id: 's2', name: 'Song B' }],
  }];
  await sandbox.openPlaylistPanelDetail('local', 'local-pl-a', '欧美单曲');
  const st = sandbox.playlistPanelDetailState;
  assert.equal(st.key, 'local:local-pl-a');
  assert.equal(apiCalls.length, 0, '本地歌单不得发起 tracks API 请求: ' + apiCalls.join(', '));
  assert.equal(st.tracks.length, 2);
  assert.equal(st.tracks[0].name, 'Song A');
  assert.equal(st.hasMore, false);
  assert.equal(st.error, '');
  assert.equal(st.loading, false);

  sandbox.playPlaylistPanelDetail();
  const call = sandbox.playCalls[sandbox.playCalls.length - 1];
  assert.ok(call, '播放歌单必须调用 loadPlaylistIntoQueueById');
  assert.equal(call[0], 'local-pl-a');
  assert.equal(call[1], true);
  const opts = call[3] || {};
  assert.ok(Array.isArray(opts.seedTracks) && opts.seedTracks.length === 2, '本地播放必须走 seedTracks，不打 API');
  assert.equal(opts.hasMore, false);
});

test('网易云歌单回归：provider=netease、封面带 ?param=88y88、详情走 API', async () => {
  const { sandbox, els, apiCalls } = makeSandbox();
  sandbox.userPlaylists = [{ id: '123', provider: 'netease', name: 'NE 歌单', trackCount: 1, cover: 'https://p.example/n.jpg' }];
  sandbox.renderUserPlaylistsList({});
  const html = els['pl-list'].innerHTML;
  assert.match(html, /data-playlist-provider="netease"/);
  assert.ok(html.includes('https://p.example/n.jpg?param=88y88'), '网易云封面应保持 ?param 后缀');
  apiCalls.length = 0;
  sandbox.apiJson = function (url) {
    apiCalls.push(String(url));
    return Promise.resolve({ tracks: [{ id: '9', name: 'NE Song' }], hasMore: false, total: 1 });
  };
  await sandbox.openPlaylistPanelDetail('netease', '123', 'NE 歌单');
  assert.equal(apiCalls.length, 1);
  assert.match(apiCalls[0], /^\/api\/playlist\/tracks\?id=123/);
  assert.equal(sandbox.playlistPanelDetailState.tracks.length, 1);
});

/* ---------------- 服务端守卫（e2e，复用 beatmap 测试拉起模式） ---------------- */

const PORT = 39875;
process.env.PORT = String(PORT);
const server = require('../server.js');
const BASE = 'http://127.0.0.1:' + PORT;

async function ready() {
  if (server.listening) return;
  await new Promise((resolve) => server.once('listening', resolve));
}

test('服务端 /api/playlist/tracks 对非数字 id 返回 400 INVALID_PLAYLIST_ID', async () => {
  await ready();
  const r = await fetch(BASE + '/api/playlist/tracks?id=local-pl-x&limit=48&offset=0');
  assert.equal(r.status, 400, '本地 id 必须 400 而非穿透 500');
  const body = await r.json();
  assert.equal(body.error, 'INVALID_PLAYLIST_ID');
  assert.deepEqual(body.tracks, []);
});

test.after?.(() => {
  try { server.close(); } catch (_) { }
});
