'use strict';

/**
 * tests/lx-reroute-batch2.test.js — 批 T15.5b（改道批2）：红心/评论/专辑艺人 + 歌单族 + 推荐卡
 *
 * 契约（brief + T15.5a §6 + 上游 index.html 参照）：
 *  ① 红心 = 本地 localStorage 桩（上游 :28893-28926 形态）：toggleLikeSong 零网络、
 *     markSongsLiked 落盘、restoreLocalLikedSongs 启动回填、无稳定标识时隐藏 #heart-btn；
 *     syncLikeStatusForSongs 直接 return（上游 :28861 同款）。
 *  ② 评论 = 不加载 + 一句说明（上游 :28354-28390 detailCanLoadComments=false 形态）。
 *  ③ 专辑/歌手详情改由 /api/lx-source/search 五源派生（上游 :28261 loadOnlineArtistDetail），
 *     lx 冻结形状（singer/album/pic/interval）在消费侧归一为曲目口径（artist/albumName/cover/duration）。
 *  ④ 歌单族：官方平台 `:playlist/tracks` 四路退役 → POST /api/platform-playlist/import 全量 +
 *     前端切片分页（server.js:5870）；网易云 cookie 路由保留待 T16；失败不落缓存。
 *  ⑤ 推荐卡：官方 feed / recommendations 路由 → 一等公民 /api/daily-hot + /api/platform-charts
 *     （10-26 排行榜归一：lx-source 侧的重复实现已退役）；字段映射 cover = song.pic（15.5a §6.1）。
 * 手法：marker 切片 / 具名函数切片 + vm + apiJson 桩（沿用 lx-reroute-batch1 / local-collect-adapter 惯例）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const P_DETAIL = 'public/js/modules/05-playback/06-track-detail-lyrics-actions.js';
const P_PLAYLIST_DETAIL = 'public/js/modules/06-lyrics/02-playlist-detail.js';
const P_CONTENT = 'public/js/modules/04-shelf/03-content-list-manager.js';
const P_QUEUE_LOADERS = 'public/js/modules/06-lyrics/03-podcast-playlist-loaders.js';
const P_DASHBOARD = 'public/js/modules/05-playback/03a-home-dashboard.js';
const P_STARTUP = 'public/js/modules/10-shell/05-startup-bindings.js';

// 注释允许保留「官方路由已退役」的说明文字，销号类断言只看可执行代码。
function codeOnly(text) {
  return text.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
}

function sliceBetween(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  assert.notStrictEqual(start, -1, `${label || 'file'} 缺少起始标记: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notStrictEqual(end, -1, `${label || 'file'} 缺少结束标记: ${endMarker}`);
  return source.slice(start, end);
}

function namedFunctionSource(source, name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  if (!declaration) return '';
  const bodyStart = source.indexOf('{', declaration.index + declaration[0].length);
  if (bodyStart < 0) return '';
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(declaration.index, index + 1);
    }
  }
  return '';
}

function makeStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

function makeEl(id) {
  return {
    id,
    style: {},
    dataset: {},
    classList: {
      _set: new Set(),
      add(name) { this._set.add(name); },
      remove(name) { this._set.delete(name); },
      toggle(name, on) { if (on === false || !on) this._set.delete(name); else this._set.add(name); },
      contains(name) { return this._set.has(name); },
    },
    innerHTML: '', textContent: '', value: '', title: '',
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null, contains: () => false,
    addEventListener() {}, focus() {},
  };
}

const BASE_GLOBALS = {
  console, Date, Math, JSON, String, Number, Array, Object, Boolean, Promise, RegExp, Error,
  parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
  URLSearchParams, AbortController, Set, Map, Symbol, TypeError, RangeError,
  setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 0; },
  clearTimeout() {}, setInterval: () => 0, clearInterval() {},
};

function load(source, globals, exportExpr, filename) {
  const sandbox = Object.assign({}, BASE_GLOBALS, globals || {});
  sandbox.window = sandbox;
  if (!sandbox.document) {
    const els = new Map();
    sandbox.document = {
      getElementById(id) { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
      createElement: () => makeEl('created'),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      body: makeEl('body'),
    };
  }
  vm.createContext(sandbox);
  vm.runInContext('try {\n' + source + '\n' + exportExpr + '\n} catch (e) { window.__loadError = e; }\n',
    sandbox, { filename: filename || 'lx-reroute-batch2.js' });
  if (sandbox.__loadError) throw new Error('模块装载失败: ' + (sandbox.__loadError.stack || String(sandbox.__loadError)));
  return { sandbox, exports: sandbox.__exports };
}

// ── ① 红心本地桩 ──────────────────────────────────────────────────────────────

const LIKE_SEGMENT = () => sliceBetween(read(P_DETAIL),
  'function songAccountProvider(song)', 'function toggleLikeCurrent', '06-track-detail');

function loadLikeSandbox(options) {
  const storage = options.storage || makeStorage();
  const httpCalls = [];
  const toasts = [];
  const globals = {
    localStorage: storage,
    httpCalls,
    toasts,
    likedSongMap: Object.create(null),
    likeBusyMap: Object.create(null),
    collectBusy: false,
    miniQueueOpen: false,
    playlist: [],
    $results: { classList: { contains: () => false }, children: [], querySelectorAll: () => [] },
    songProviderKey: (song) => String((song && (song.provider || song.source)) || 'netease'),
    currentCoverSong: () => null,
    safeRenderQueuePanel() {},
    showToast: (msg) => { toasts.push(String(msg)); },
    apiJson: async (url) => { httpCalls.push(String(url)); return { liked: {} }; },
    ensureLoggedInForAction: () => true,
    playlistAccountProvider: (pl) => (pl && pl.provider) || 'netease',
    userPlaylists: [],
  };
  return load(LIKE_SEGMENT(), globals,
    'window.__exports = { toggleLikeSong, restoreLocalLikedSongs, markSongsLiked,' +
    ' isSongLiked, updateLikeButtons, syncLikeStatusForSongs, syncLikeStatusForSong, songAccountStateKey };',
    'lx-reroute-batch2.like.js');
}

test('红心①：toggleLikeSong 零网络并写入 localStorage；syncLikeStatus* 不再有在线核查', async () => {
  const storage = makeStorage();
  const { exports, sandbox } = loadLikeSandbox({ storage });
  const song = { provider: 'qq', id: '00123', name: '晴天', artist: '周杰伦' };

  await exports.toggleLikeSong(song);
  assert.equal(sandbox.httpCalls.length, 0, '红心不得打任何账号接口');
  assert.equal(exports.isSongLiked(song), true);
  const saved = JSON.parse(storage.getItem('stellaflix-liked-songs-local-v1') || '{}');
  assert.deepEqual(saved, { 'qq:00123': true }, '本地红心须落盘（重进不丢）');

  await exports.toggleLikeSong(song);
  assert.equal(exports.isSongLiked(song), false);
  assert.deepEqual(JSON.parse(storage.getItem('stellaflix-liked-songs-local-v1')), {}, '取消红心同样落盘');

  // 队列/搜索结果批量标记同样要持久化（否则切歌后红心丢）。
  exports.markSongsLiked([{ provider: 'kugou', hash: 'H1' }, null], true);
  assert.deepEqual(JSON.parse(storage.getItem('stellaflix-liked-songs-local-v1')), { 'kugou:h1': true });

  assert.equal(exports.syncLikeStatusForSongs([song]), undefined, '批量在线红心核查已退役为 no-op');
});

test('红心②：restoreLocalLikedSongs 从 localStorage 回填（启动链路 05-startup-bindings 调用）', () => {
  const storage = makeStorage({ 'stellaflix-liked-songs-local-v1': JSON.stringify({ 'qq:00123': true, 'wy:9': false }) });
  const { exports } = loadLikeSandbox({ storage });
  exports.restoreLocalLikedSongs();
  assert.equal(exports.isSongLiked({ provider: 'qq', id: '00123' }), true, '存档的 true 必须回填');
  assert.equal(exports.isSongLiked({ provider: 'netease', id: '9' }), false, '存档的 false 不得变红心');
  const startup = read(P_STARTUP);
  assert.match(startup, /restoreLocalLikedSongs\(\);\s*\n\s*updateLikeButtons\(\);/, '启动须先回填再刷按钮');
});

test('红心③：无稳定标识时隐藏 #heart-btn（上游 :28895 同款，不留死按钮）', () => {
  const { exports, sandbox } = loadLikeSandbox({});
  const heart = sandbox.document.getElementById('heart-btn');
  exports.updateLikeButtons({ provider: 'qq', id: '', name: '无标识' });
  assert.equal(heart.style.display, 'none', 'stateKey 为空必须隐藏');
  exports.updateLikeButtons({ provider: 'qq', id: '00123', name: '有标识' });
  assert.equal(heart.style.display, '', '有标识恢复显示');
});

test('红心④：账号 adapter 整套退役，官方红心/歌单写回端点字符串清零', () => {
  const text = read(P_DETAIL);
  assert.ok(!/SONG_ACCOUNT_ACTION_ADAPTERS/.test(text), '五平台账号 adapter 表须随 16d 物理删除');
  assert.ok(!/'\/api\/(song\/like|kugou\/song\/like|spotify\/song\/like|qishui\/song\/like)/.test(text),
    '06-track-detail 内官方红心端点字符串须清零');
  assert.ok(!/apiJson\(adapter\.likeUrl/.test(text), '在线红心请求链必须整体删除');
  const likeSegment = LIKE_SEGMENT();
  assert.ok(!/likeUrl|likeCheckUrl|playlistTracksUrl|playlistAddUrl/.test(likeSegment), '适配器字段在本段内零残留');
});

// ── ② 评论：不加载 + 文案 ─────────────────────────────────────────────────────

test('评论：detailCommentsConfig 恒空（不读不写），官方评论端点与写评论入口清零', () => {
  const source = read(P_DETAIL);
  const { exports } = load(namedFunctionSource(source, 'detailCommentsConfig'), {},
    'window.__exports = { detailCommentsConfig };', 'lx-reroute-batch2.comments.js');
  for (const song of [
    { provider: 'netease', id: '123' },
    { provider: 'qq', qqId: '1', mid: 'm' },
    { provider: 'qishui', providerSongId: 'p' },
    { provider: 'local', type: 'local', id: 'l1' },
  ]) {
    assert.equal(exports.detailCommentsConfig(song), null, '任何源都不得再声明评论读写配置');
  }
  const detailBranch = sliceBetween(source, "heading.textContent = '歌曲详情';", 'var removeLocalBtn =', '06-track-detail');
  assert.match(detailBranch, /detailCanLoadComments\s*=\s*!!\(commentConfig && commentConfig\.readUrl\)/);
  assert.match(detailBranch, /音源模式不加载在线评论/);
  assert.ok(!/['"]\/api\/(song\/comments|qq\/song\/comments|qishui\/song\/comments)/.test(source),
    '官方评论读写端点字符串须整体退役');
});

// ── ③ 专辑 / 歌手详情：lx-search 派生 ────────────────────────────────────────

function loadDetailHelpers() {
  const source = read(P_DETAIL);
  const segment = sliceBetween(source, 'var LX_DETAIL_SEARCH_SOURCES', 'function albumDetailMissingText', '06-track-detail');
  return load(segment + '\n' + namedFunctionSource(source, 'resolveArtistSongForDetail') + '\n', {
    calls: [],
    simpleSearchNorm: (v) => String(v || '').trim().toLowerCase(),
    songProviderKey: (song) => String((song && (song.provider || song.source)) || 'netease'),
    artistNameMatches: (wanted, value) => String(value || '').indexOf(String(wanted[0] || '')) >= 0,
    currentArtistId: (song) => (song && song.artistId) || '',
    currentQQArtistMid: (song) => (song && song.singerMid) || '',
    apiJson: async (url) => {
      loadDetailHelpers.calls.push(url);
      return {
        ok: true,
        songs: [
          { source: 'tx', songmid: 'A1', id: 'A1', name: '专辑同名单曲', singer: '周杰伦', album: '范特西', pic: 'http://p/1.jpg', interval: '03:51' },
          { source: 'wy', id: 7, songmid: '7', name: '另一张专辑', singer: '周杰伦', album: '叶惠美', pic: 'http://p/2.jpg', interval: '4:00' },
          { source: 'kw', id: 'k1', songmid: 'k1', name: '无关歌手', singer: '蔡依林', album: '范特西', pic: '', interval: '' },
        ],
        failures: [],
      };
    },
  }, 'window.__exports = { lxDetailSearchUrl, isLxDetailResponse, lxDetailSongView, detailAlbumSongsFromLx,' +
    ' albumDetailUrlForSong, resolveArtistSongForDetail };', 'lx-reroute-batch2.detail.js');
}
loadDetailHelpers.calls = [];

test('派生①：专辑 URL = lx 五源聚合搜索（专辑名+歌手），官方专辑详情路由清零', () => {
  const { exports } = loadDetailHelpers();
  const url = exports.albumDetailUrlForSong({ provider: 'qq', album: '范特西', artist: '周杰伦' });
  assert.ok(url.startsWith('/api/lx-source/search?'), '专辑详情须走 lx 聚合: ' + url);
  const q = Object.fromEntries(new URLSearchParams(url.split('?')[1] || ''));
  assert.equal(q.q, '范特西 周杰伦');
  assert.equal(q.sources, 'wy,tx,kw,kg,mg');
  assert.equal(q.limit, '60');
  const netease = exports.albumDetailUrlForSong({ provider: 'netease', albumId: '99', album: '范特西' });
  assert.equal(netease, '/api/album/detail?id=99&limit=120', '网易云 cookie 专辑路由不属本批改道目标');
  assert.equal(exports.albumDetailUrlForSong({ provider: 'kugou', album: '', artist: 'x' }), '', '缺专辑名 → 无派生入口（优雅空态）');
  const text = codeOnly(read(P_DETAIL));
  assert.ok(!/\/api\/(qq|spotify)\/album\/detail/.test(text) && !/\/api\/(qq|kugou|qishui|spotify)\/artist\/detail/.test(text),
    '官方专辑/歌手详情端点须从前端清零（注释里的退役说明除外）');
  assert.match(read(P_DETAIL), /lx 五源派生/, '派生入口须写明 lx 五源口径');
});

test('派生②：lx 冻结形状归一（singer→artist、pic→cover、interval→duration）+ 按专辑名过滤', () => {
  const { exports } = loadDetailHelpers();
  const raw = { source: 'tx', songmid: 'A1', name: '曲', singer: '周杰伦', album: '范特西', pic: 'http://p/1.jpg', interval: '03:51' };
  const view = exports.lxDetailSongView(raw);
  assert.equal(view.artist, '周杰伦');
  assert.equal(view.cover, 'http://p/1.jpg');
  assert.equal(view.picUrl, 'http://p/1.jpg');
  assert.equal(view.albumName, '范特西');
  assert.equal(view.duration, 231, 'mm:ss 须换算成秒');
  assert.equal(exports.lxDetailSongView({ interval: '4:00' }).duration, 240);
  assert.equal(exports.lxDetailSongView({}).duration, 0, '无时长也要给出数值，渲染侧不必再判 undefined');
  assert.equal(exports.lxDetailSongView({ duration: 99, interval: '4:00' }).duration, 99, '已有 duration 不被覆盖');

  const filtered = exports.detailAlbumSongsFromLx({ album: '范特西' }, [raw,
    { name: '同专辑', singer: '周杰伦', album: '范特西', pic: 'http://p/3.jpg' },
    { name: '别的专辑', singer: '周杰伦', album: '叶惠美', pic: '' }]);
  assert.equal(filtered.length, 2, '仅保留同专辑曲目');
  assert.deepEqual(filtered.map((s) => s.name), ['曲', '同专辑']);
  assert.equal(filtered[1].cover, 'http://p/3.jpg', '过滤后仍须归一形状');
});

test('派生③：歌手热门歌曲走 lx 派生并精确过滤；resolveArtistSongForDetail 不再打官方 search', async () => {
  const { exports } = loadDetailHelpers();
  const before = loadDetailHelpers.calls.length;
  const candidate = await exports.resolveArtistSongForDetail({ provider: 'qq' }, '周杰伦');
  assert.ok(candidate, '须命中同名 lx 结果');
  const url = loadDetailHelpers.calls[loadDetailHelpers.calls.length - 1];
  assert.ok(url.startsWith('/api/lx-source/search?'), '派生须走 lx: ' + url);
  assert.ok(!/^\/api\/(qq\/)?search\?/.test(url), '官方 /api/qq/search、/api/search 消费点不得回潮');
  const empty = await exports.resolveArtistSongForDetail({ provider: 'qq' }, '   ');
  assert.equal(empty, null, '空歌手名直接返回 null');
  assert.equal(loadDetailHelpers.calls.length, before + 1, '空歌手名不得出网');
  const detailBranch = sliceBetween(read(P_DETAIL), "} else if (type === 'artist') {", "  } else {\n    heading.textContent = '歌曲详情';", '06-track-detail');
  assert.match(detailBranch, /lxDetailSearchUrl\(artistName/, '无 artistId 的歌手须改由 lx 派生');
  assert.match(detailBranch, /isLxDetailResponse\(r\)/, 'lx 响应分支须做形状归一');
});

// ── ④ 歌单族：import 全量 + 切片分页 ─────────────────────────────────────────

const LX_IMPORT_SONGS = (count) => Array.from({ length: count }, (_, i) => ({
  source: 'tx', id: 1000 + i, songmid: 'S' + (1000 + i), name: '曲目' + (i + 1), singer: '歌手' + (i % 3),
  albumName: '专辑' + (i % 4), picUrl: 'http://c/' + i + '.jpg', interval: '04:0' + (i % 9),
}));

function loadPlaylistPageSandbox(importResponses) {
  const calls = [];
  const source = read(P_PLAYLIST_DETAIL);
  const segment = sliceBetween(source, 'function playlistTracksEndpoint', 'function playlistPanelDetailHtml', '02-playlist-detail') + '\n';
  // 缺省给一份成功响应；显式给失败样本时保持「粘住最后一个样本」，
  // 这样第二次读取仍是同一失败，可验证「失败不落缓存 → 重新出网」。
  const responses = (importResponses && importResponses.length ? importResponses : [{ ok: true, playlist: { songs: LX_IMPORT_SONGS(110) } }]);
  let cursor = 0;
  const { exports } = load(segment, {
    calls,
    PLAYLIST_DETAIL_BATCH_SIZE: 48,
    normalizePlaylistProvider: (provider) => (['qq', 'kugou', 'qishui', 'spotify', 'local'].indexOf(provider) >= 0 ? provider : 'netease'),
    apiJson: async (url, opts) => {
      calls.push({ url, opts: opts || {} });
      if (url === '/api/platform-playlist/import') {
        return responses[Math.min(cursor++, responses.length - 1)];
      }
      return { tracks: [], nextOffset: 0, total: 0, hasMore: false };
    },
  }, 'window.__exports = { playlistTracksPage, playlistTracksEndpoint, playlistDetailPageFromFullTracks };',
    'lx-reroute-batch2.playlist.js');
  return { calls, exports };
}

test('歌单①：qq/kugou/qishui/spotify 曲目读取 = POST /api/platform-playlist/import（全量一次）', async () => {
  const { calls, exports } = loadPlaylistPageSandbox();
  const page = await exports.playlistTracksPage('qq', '7788', 0);
  const post = calls.find((c) => c.url === '/api/platform-playlist/import');
  assert.ok(post, '必须打导入路由: ' + JSON.stringify(calls.map((c) => c.url)));
  assert.equal(post.opts.method, 'POST');
  assert.deepEqual(JSON.parse(post.opts.body), { input: '7788', source: 'tx' }, 'source 须映射为 lx 源名');
  assert.equal(page.tracks.length, 48);
  assert.equal(page.nextOffset, 48);
  assert.equal(page.total, 110);
  assert.equal(page.hasMore, true);
  assert.equal(page.playlist.trackCount, 110, '消费方读 playlist.trackCount 取总数');
  assert.equal(page.tracks[0].cover, 'http://c/0.jpg', 'lx pic/picUrl → 曲目 cover');
  assert.equal(page.tracks[0].artist, '歌手0', 'lx singer → 曲目 artist');
  assert.equal(page.tracks[0].duration, 240, 'interval mm:ss → duration 秒');
  assert.equal(calls.filter((c) => c.url === '/api/platform-playlist/import').length, 1, '全量只取一次');
  const second = await exports.playlistTracksPage('qq', '7788', 48);
  assert.equal(second.tracks.length, 48);
  assert.equal(calls.filter((c) => c.url === '/api/platform-playlist/import').length, 1, '同歌单二次分页走缓存');
  assert.ok(!/\/api\/qq\/playlist\/tracks/.test(read(P_PLAYLIST_DETAIL)), '官方平台曲目路由字符串须退役');
});

test('歌单②：末页切片 hasMore=false；网易云仍走 GET /api/playlist/tracks（cookie 路由待 T16）', async () => {
  const { calls, exports } = loadPlaylistPageSandbox();
  const tail = await exports.playlistTracksPage('kugou', 'kg-1', 96);
  assert.equal(tail.tracks.length, 14, '110 - 96 = 14 首页尾量');
  assert.equal(tail.hasMore, false);
  assert.equal(tail.nextOffset, 110);

  const neteaseCalls = [];
  const netease = loadPlaylistPageSandbox([{ ok: true, playlist: { songs: LX_IMPORT_SONGS(3) } }]);
  const plPage = await netease.exports.playlistTracksPage('netease', '5', 0);
  netease.calls.forEach((c) => neteaseCalls.push(c.url));
  assert.ok(neteaseCalls[0].startsWith('/api/playlist/tracks?id=5'), '网易云须走 cookie 路由: ' + neteaseCalls[0]);
  assert.equal(neteaseCalls.length, 1);
  assert.equal(plPage.tracks.length, 0, '桩里网易云 tracks 空响应');
});

test('歌单③：导入失败/空歌单不落缓存，下次读取重新出网', async () => {
  const harness = loadPlaylistPageSandbox([{ ok: false, error: 'IMPORT_FAILED', message: '链接无法识别' }]);
  await assert.rejects(() => harness.exports.playlistTracksPage('spotify', 'sp-1', 0), /PLAYLIST_IMPORT_EMPTY/);
  const failedPosts = harness.calls.filter((c) => c.url === '/api/platform-playlist/import').length;
  assert.equal(failedPosts, 1);
  await assert.rejects(() => harness.exports.playlistTracksPage('spotify', 'sp-1', 0), /PLAYLIST_IMPORT_EMPTY/);
  assert.equal(harness.calls.filter((c) => c.url === '/api/platform-playlist/import').length, 2,
    '失败结果不得写进缓存（否则一次抖动后永远读到空列表）');
  // 取消信号必须透传导入请求（面板切换时不再留孤儿请求）。
  const signal = { aborted: false };
  const withSignal = loadPlaylistPageSandbox();
  await withSignal.exports.playlistTracksPage('qq', '7788', 0, { signal });
  const post = withSignal.calls.find((c) => c.url === '/api/platform-playlist/import');
  assert.equal(post.opts.signal, signal, '调用方的 AbortController signal 须透传');
});

test('歌单④：平台歌单收藏/写回整簇退役（LX 世界观无账号写回）', () => {
  const source = read(P_PLAYLIST_DETAIL);
  assert.ok(!/\/api\/(qishui|spotify|playlist)\/(playlist\/collect|subscribe)/.test(source), '官方歌单收藏写回须退役');
  assert.ok(!/togglePlaylistPanelCollection|canUncollect/.test(source), '收藏按钮与判定函数须随 16d 退役');
  assert.match(source, /pl-detail-play/);
});

// ── ④b 3D 货架曲目读取 / ④c 队列灌页：共用 lx 导入契约 ───────────────────────

function loadContentPageFetchSandbox(provider) {
  const calls = [];
  const delegated = [];
  const source = read(P_CONTENT);
  const segment = sliceBetween(source, 'var CONTENT_IMPORT_PROVIDERS', 'async function loadMoreContentRows', '03-content-list-manager');
  const { exports } = load(segment, {
    calls,
    delegated,
    contentSource: { provider, id: provider + '-id-1' },
    PLAYLIST_LAZY_BATCH_SIZE: 48,
    // 货架复用 06-lyrics 的统一契约：本文件不应再自己打导入路由。
    playlistTracksPage: async (pageProvider, id, offset, options, limit) => {
      delegated.push({ provider: pageProvider, id, offset, options, limit });
      return { tracks: LX_IMPORT_SONGS(60).slice(offset, offset + 48), nextOffset: offset + 48, total: 60, hasMore: offset + 48 < 60 };
    },
    apiJson: async (url, opts) => { calls.push({ url, opts: opts || {} }); return { tracks: [] }; },
  }, 'window.__exports = { contentPageFetch };', 'lx-reroute-batch2.content.js');
  return { calls, delegated, exports };
}

test('货架：平台歌单首屏/懒加载均复用 playlistTracksPage（不重复一套切片实现）', async () => {
  const shelf = read(P_CONTENT);
  assert.ok(!/\/api\/(qq|kugou|qishui|spotify)\/playlist\/tracks/.test(codeOnly(shelf)), '官方平台曲目路由须从货架清零');
  assert.match(shelf, /playlistTracksPage\(contentSource\.provider/, '货架须复用统一契约');
  assert.ok(!/\/api\/platform-playlist\/import/.test(codeOnly(shelf)), '导入请求只由统一契约发起一次');
  const qq = loadContentPageFetchSandbox('qq');
  const page = await qq.exports.contentPageFetch(0);
  assert.deepEqual(qq.delegated, [{ provider: 'qq', id: 'qq-id-1', offset: 0, options: undefined, limit: undefined }]);
  assert.equal(page.tracks.length, 48);
  assert.equal(page.total, 60);
  assert.equal(qq.calls.length, 0, '复用 playlistTracksPage 时本文件不再自己出网');
  // 非曲库来源（如本地/未知 provider）直接空页，不再打任何路由。
  const other = loadContentPageFetchSandbox('local');
  assert.equal((await other.exports.contentPageFetch(0)).tracks.length, 0);
  assert.equal(other.delegated.length, 0, 'local 不由货架路径复用歌单契约');
});

test('队列灌页：平台歌单走 playlistTracksPage，网易云继续走官方 URL 构造', async () => {
  const source = read(P_QUEUE_LOADERS);
  const segment = sliceBetween(source, 'var PLAYLIST_QUEUE_IMPORT_PROVIDERS', 'function cancelPlaylistQueueHydration', '03-podcast-playlist-loaders');
  const seen = [];
  const { exports } = load(segment, {
    seen,
    PLAYLIST_QUEUE_INITIAL_BATCH_SIZE: 60,
    playlistTracksPage: async (provider, id, offset, options, limit) => {
      seen.push({ kind: 'import', provider, id, offset, options, limit });
      return { tracks: [], nextOffset: 0, total: 0, hasMore: false };
    },
    playlistQueuePageUrl: (source, offset, limit) => '/api/playlist/tracks?id=' + source.id +
      '&offset=' + offset + '&limit=' + limit,
    apiJson: async (url, opts) => { seen.push({ kind: 'apiJson', url, opts }); return { tracks: [] }; },
  }, 'window.__exports = { playlistQueuePage };', 'lx-reroute-batch2.queue.js');
  for (const provider of ['qq', 'kugou', 'qishui', 'spotify']) {
    await exports.playlistQueuePage({ provider, id: provider + ':123' }, 0, 50);
    const hit = seen[seen.length - 1];
    assert.equal(hit.kind, 'import', provider + ' 必须走 lx 导入契约');
    assert.equal(hit.limit, 50, '调用方页宽须透传（切片分页）');
  }
  await exports.playlistQueuePage({ provider: 'netease', id: '555' }, 0, 96);
  assert.equal(seen[seen.length - 1].kind, 'apiJson');
  assert.match(seen[seen.length - 1].url, /^\/api\/playlist\/tracks\?id=555&offset=0&limit=96$/);
});

// ── ⑤ 推荐卡 → daily-hot / platform-charts ──────────────────────────────────

const dashboardSource = () => read(P_DASHBOARD);

test('推荐卡①：feedConfig 只留 lx 平台映射，官方 feed/recommendations 端点从前端清零', () => {
  const source = dashboardSource();
  const config = namedFunctionSource(source, 'homePlatformRecommendationFeedConfig');
  assert.match(config, /lxPlatform:\s*'tx'/);
  assert.match(config, /lxPlatform:\s*'kg'/);
  assert.ok(!/\/api\/(qishui\/feed|kugou\/recommendations|spotify\/recommendations)/.test(codeOnly(source)),
    '官方推荐端点须整体退役（注释里的退役说明除外，路由删除归 T16）');
});

test('推荐卡②：loader = platform-charts 目录 + daily-hot?source=&limit=12&chart=，cover=song.pic', () => {
  // 排行榜归一（10-26 主人裁定「留 main 版」）：端点从 /api/lx-source/{daily-hot,platform-charts}
  // 改指 main 侧 1:1 上游切片的第一方端点；参数名随上游回归 source（我方 lx 版曾用 platform）。
  const loader = namedFunctionSource(dashboardSource(), 'loadHomePlatformFeedRecommendations');
  assert.match(loader, /apiJson\('\/api\/platform-charts\?source='[\s\S]*config\.lxPlatform/);
  assert.match(loader, /apiJson\('\/api\/daily-hot\?source='[\s\S]*config\.lxPlatform/);
  assert.match(loader, /&limit=12/);
  assert.match(loader, /'&chart='[\s\S]*feedState\.chartId/);
  assert.match(loader, /song\.cover = song\.pic \|\| song\.picUrl/);
  assert.match(loader, /feedState\.mode = data && data\.chartMode/);
  assert.match(loader, /feedState\.chartLabel = data && data\.chartLabel/);
  assert.ok(!/apiJson\(\s*config\.endpoint/.test(loader), '旧的 config.endpoint 官方请求形态不得回潮');
});

test('推荐卡③：渲染消费 chartLabel/榜单选择条，unavailable 走空态非错误告警', () => {
  const render = namedFunctionSource(dashboardSource(), 'renderHomePlatformRecommendations');
  const chips = namedFunctionSource(dashboardSource(), 'homePlatformRecommendationChartChipsHtml');
  assert.ok(chips, '须有榜单选择条渲染（platform-charts 的消费方）');
  assert.match(chips, /data-home-chart-id=/);
  assert.match(render, /homePlatformRecommendationChartChipsHtml\(source, feedState\)/);
  assert.match(render, /feedState\.chartLabel/);
  assert.match(render, /chartUnavailable/);
  assert.ok(!/liked-affinity|personal-top/.test(render), '登录态推荐模式分支随官方路由一并退役');
});

test('推荐卡④：卡片点击派发覆盖 lx 榜单源（qq 卡不再掉进无人处理的分支）', () => {
  const binding = sliceBetween(dashboardSource(), 'if (list) list.addEventListener(\'click\'', 'if (list) list.addEventListener(\'scroll\'', '03a-home-dashboard');
  assert.match(binding, /data-home-chart-id/);
  assert.match(binding, /playHomePlatformFeedSong/);
  assert.match(binding, /homePlatformRecommendationFeedConfig\(kind\.replace\(\/-song\$\/, ''\)\)/,
    '派发须按 feedConfig 表驱动，不能再用硬编码平台名单');
  assert.ok(!/\^\(qishui\|kugou\|spotify\)-song\$/.test(binding), '旧硬编码名单已失效（qq 漏网）');
});

// ── 全批销号：旧端点字符串只剩 08-account 与注释 ─────────────────────────────

test('销号：批2 五件内官方消费端点仅剩注释与网易云 cookie 路由', () => {
  const allowed = [
    /\/api\/album\/detail/, /\/api\/artist\/detail/, /\/api\/album\/subscribe/,
    /\/api\/playlist\/tracks/, /\/api\/playlist\/subscribe/, /\/api\/playlist\/add-song/,
    /\/api\/playlist\/create/, /\/api\/song\/comments/, /\/api\/search\?keywords=/,
  ];
  for (const rel of [P_DETAIL, P_PLAYLIST_DETAIL, P_CONTENT, P_QUEUE_LOADERS, P_DASHBOARD]) {
    const text = codeOnly(read(rel));
    const hits = (text.match(/\/api\/(qq|kugou|qishui|spotify)\/[a-z/]+/gi) || []);
    assert.deepEqual(hits, [], `${rel} 不应再消费平台前缀官方路由: ${hits.join(', ')}`);
    // 归一后 daily-hot / platform-charts 不再算「官方端点」：它们是本仓第一方共享切片
    // （daily-hot-api.js + server.js 路由，10-26 主人裁定留 main 版），03a 推荐卡正是其消费方。
    // 其余仍在禁止名单内的才是官方 cookie 路由；`/api/search?keywords=`（网易云）另列白名单。
    const generic = (text.match(/'\/api\/(song\/like|song\/comments|search)[^']*'/g) || []);
    assert.deepEqual(generic.filter((h) => !allowed.some((re) => re.test(h))), [], `${rel} 官方端点: ${generic.join(', ')}`);
  }
});
