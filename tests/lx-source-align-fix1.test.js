'use strict';

/**
 * tests/lx-source-align-fix1.test.js — 改道批 T15.5b 修复轮1 钉桩
 *
 * 覆盖评审四条中的前端可测面（Critical-2 的在线匹配修复随批改造
 * tests/lx-reroute-batch1.test.js ③ 段：真实 isSameTitleArtist + lx 冻结形状，见该文件）：
 *
 *  Critical-1（切源匹配恒零命中）：07-search findControlSourceMatchResult 把
 *    /api/lx-source/search 返回的 lx 冻结形状候选（歌手字段为 singer）直接送进
 *    sourceCandidateRejectReason / isSameTitleArtist / scoreSongSearchResult，谓词只读
 *    .artist/.artists → 候选恒被判 artist_mismatch → 切源匹配零命中。钉桩：喂 singer-only
 *    候选，命中歌曲必须回传（singer→artist 边界归一），且不同歌手仍须判 artist_mismatch。
 *
 *  Important-1（冷导入被 12s 腰斩 + 中止卡在「载入中」）：02-playlist-detail 面板 initial
 *    对 lx 导入源挂 12000ms AbortController，把「一次 POST 全表导入」砍到 12s；且 AbortError
 *    分支先 return 未复位 loading → 面板卡在载入中。钉桩：①导入源 abort 预算 = 导入级（≥60000）；
 *    ①b 非导入源（网易云）仍保持 12s（不得整体放大）；②AbortError 后 loading 必须复位。
 *
 *  Important-2（全源失败被当成命中为零）：
 *    ①07-search findControlSourceMatchResult 收到 songs 空 + failures 非空（server.js:8083
 *      ok=false 的 502 全源失败体）必须落 'source_failed'（区别于 'no_source' 的「无正版音源」）；
 *      且 controlSourceIssueLabel('source_failed') 不得再复用「无正版音源」措辞。
 *    ②04a buildRadioModeSongs 全源失败须把 failures 记账进 radioModeState.lastSearchFailures，
 *      供上层区分「音源不可用」与「没有找到可播放的歌曲」。
 *
 * 手法：vm 顶层加载模块片段 + apiJson 桩（沿用 lx-search-frontend / lx-reroute-batch1 惯例）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const P_07 = 'public/js/modules/05-playback/07-search.js';
const P_RADIO = 'public/js/modules/05-playback/04a-radio-modes.js';
const P_PANEL = 'public/js/modules/06-lyrics/02-playlist-detail.js';

const BASE_GLOBALS = {
  console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
  Date, Math, JSON, String, Number, Array, Object, Boolean, Promise, RegExp, Error,
  parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
  URLSearchParams, AbortController, Set, Map, Symbol, TypeError, RangeError,
  setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 0; },
  clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  requestAnimationFrame: (fn) => { if (typeof fn === 'function') fn(); return 0; },
  cancelAnimationFrame() {},
  addEventListener() {}, removeEventListener() {},
};

function makeStubEl() {
  return {
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    children: [], innerHTML: '', textContent: '', value: '',
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    appendChild(c) { return c; }, insertBefore(c) { return c; }, removeChild() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null, contains: () => false,
    addEventListener() {}, removeEventListener() {}, focus() {}, blur() {},
    insertAdjacentHTML() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
  };
}

function makeDomStub() {
  return {
    getElementById: () => makeStubEl(),
    createElement: () => makeStubEl(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: makeStubEl(),
  };
}

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

function runInSandbox(sandbox, source, exportExpr, filename) {
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    'try {\n' + source + '\n' + exportExpr + '\n} catch (e) { window.__loadError = e; }\n',
    sandbox,
    { filename },
  );
  if (sandbox.__loadError) {
    throw new Error('模块装载失败: ' + (sandbox.__loadError.stack || String(sandbox.__loadError)));
  }
  return sandbox;
}

// 07-search 独立装载（不拼 00，避免 00 块内 apiJson 声明遮蔽桩；apiJson 走沙箱全局）。
function loadSearch(apiJsonStub) {
  const sandbox = Object.assign({}, BASE_GLOBALS, {
    document: makeDomStub(),
    localStorage: makeStorage(),
    escHtml: (s) => String(s == null ? '' : s),
    apiJson: apiJsonStub,
    // 07 装载尾段 DOM 初始化最小桩（沿 lx-reroute-batch1 SEARCH_LOAD_EXTRAS）。
    searchMode: 'all', playlist: [], playQueue: [], currentIdx: -1, userPlaylists: [],
    setPeek() {}, updateSearchPillGlassDisplacementMap() {}, animateListItems() {},
    songCoverSrc: (song) => String((song && (song.picUrl || song.cover || song.pic)) || ''),
    isSongLiked: () => false, heartIconSvg: () => '<svg class="heart"></svg>',
    playlistPlusIconSvg: () => '<svg class="plus"></svg>', syncLikeStatusForSongs() {},
    openArtistDetailForSong() {}, songSourceLabel: (song) => String((song && song.source) || 'NE').toUpperCase(),
    platformMeta: (provider) => ({ label: provider }), cloneSong: (song) => Object.assign({}, song), showToast() {},
  });
  runInSandbox(sandbox, read(P_07),
    'window.__exports = { findControlSourceMatchResult, controlSourceIssueLabel, sourceCandidateRejectReason, controlSourceSearchUrl };',
    'lx-source-align-fix1.07-search.js');
  return sandbox.__exports;
}

// ── Critical-1：切源匹配消费 lx 冻结形状（singer）必须命中 ──────────────────────

test('Critical-1：findControlSourceMatchResult 对 lx 冻结形状候选（singer-only）归一后命中（切源匹配不再恒零）', async () => {
  // lx 冻结形状：{source,id,songmid,name,singer,album,interval,pic} —— 无 artist 字段。
  const LX_CAND = { source: 'tx', id: 'T9', songmid: 'SM9', name: '晴天', singer: '周杰伦', album: '叶惠美', interval: '04:29', pic: '' };
  const exports = loadSearch(async () => ({ ok: true, songs: [LX_CAND], failures: [] }));
  const result = await exports.findControlSourceMatchResult({ name: '晴天', artist: '周杰伦' }, 'qq');
  assert.ok(result && result.song, '同名同歌手的 lx 候选必须命中（修复前恒 {song:null}）: ' + JSON.stringify(result));
  assert.equal(result.issue, '', '命中即无拒绝原因');
  assert.equal(result.song.artist, '周杰伦', '命中歌曲须桥接 singer→artist');
  assert.equal(result.song.singer, '周杰伦', '冻结形状 singer 不得丢');
});

test('Critical-1 反证：singer 与源歌手不同名时仍须判 artist_mismatch（归一不得放宽匹配）', async () => {
  const LX_CAND = { source: 'tx', id: 'T9', songmid: 'SM9', name: '晴天', singer: '另一歌手', album: '', interval: '', pic: '' };
  const exports = loadSearch(async () => ({ ok: true, songs: [LX_CAND], failures: [] }));
  const result = await exports.findControlSourceMatchResult({ name: '晴天', artist: '周杰伦' }, 'qq');
  assert.ok(!result.song, '不同歌手不得命中');
  assert.equal(result.issue, 'artist_mismatch');
});

test('Critical-1 同侧：当前播放曲为 lx 冻结形状（电台队列 singer-only）时切源匹配仍须命中', async () => {
  // 复现真实入口：04a radioModeQueueSong 原样 clone lx 搜索结果 → 队列曲只有 singer、无 artist。
  // 未归一入参时 controlSourceSwitchQuery 丢歌手、sourceSwitchArtistParts(source) 为空
  // → sourceCandidateRejectReason 恒判 artist_mismatch（与 Critical-1 同根）。
  const radioQueuedSong = {
    type: 'online-queue', source: 'kw', id: 'K1', songmid: 'KM1',
    name: '海阔天空', singer: 'Beyond', album: '', interval: '05:23', pic: '',
    radioModeId: 'commute', radioModeName: '通勤',
  };
  const LX_CAND = { source: 'tx', id: 'T9', songmid: 'SM9', name: '海阔天空', singer: 'Beyond', album: '', interval: '05:23', pic: '' };
  const calls = [];
  const exports = loadSearch(async (url) => {
    calls.push(url);
    return { ok: true, songs: [LX_CAND], failures: [] };
  });
  const result = await exports.findControlSourceMatchResult(radioQueuedSong, 'qq');
  assert.ok(calls.length === 1 && /q=/.test(calls[0]), '须发起一次定向搜索: ' + JSON.stringify(calls));
  assert.ok(decodeURIComponent(calls[0]).includes('Beyond'),
    '查询词须带上 singer 归一后的歌手（不得退化成仅歌名查询）: ' + decodeURIComponent(calls[0]));
  assert.ok(result && result.song, 'singer-only 队列曲必须能切源命中（修复前恒 artist_mismatch）: ' + JSON.stringify(result));
  assert.equal(result.issue, '');
  assert.equal(result.song.artist, 'Beyond', '命中候选须回带 artist');
});

// ── Important-2 ①：切源匹配把「全源失败」区分于「命中为零」 ─────────────────────

test('Important-2①：songs 空 + failures 非空（502 全源失败体）落 source_failed，而非 no_source', async () => {
  const exports = loadSearch(async () => ({
    ok: false, songs: [], error: 'all sources failed', code: 'LX_SEARCH_FAILED',
    failures: [{ source: 'tx', error: 'HTTP_500' }, { source: 'wy', code: 'SOURCE_COOLDOWN' }],
  }));
  const result = await exports.findControlSourceMatchResult({ name: '某曲', artist: '某歌手' }, 'qq');
  assert.ok(!result.song);
  assert.equal(result.issue, 'source_failed', '全源失败必须区别于「查无结果」的 no_source');
});

test('Important-2①：source_failed 标签不得再呈现为「无正版音源」（须走音源不可用文案）', () => {
  const exports = loadSearch(async () => ({ ok: true, songs: [], failures: [] }));
  const failLabel = exports.controlSourceIssueLabel('source_failed');
  const noSourceLabel = exports.controlSourceIssueLabel('no_source');
  assert.ok(!/无正版音源/.test(failLabel), 'source_failed 不得复用「无正版音源」措辞: ' + failLabel);
  assert.match(failLabel, /音源|暂不可用|失败/, 'source_failed 应呈现音源不可用语义: ' + failLabel);
  assert.equal(noSourceLabel, '无正版音源', 'no_source 仍为既有「无正版音源」标签（不受影响）');
});

// ── Important-1：冷导入预算 + 中止复位载入态 ──────────────────────────────────

function makePanelSandbox() {
  const timers = [];
  const sandbox = Object.assign({}, BASE_GLOBALS, {
    setTimeout: (fn, ms) => { timers.push(Number(ms)); return timers.length; },
    clearTimeout() {},
    document: {
      getElementById: (id) => (id === 'pl-list' || id === 'playlist-panel' || id === 'mini-queue-list' || id === 'podcast-list' ? makeStubEl() : null),
      createElement: () => makeStubEl(), querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, body: makeStubEl(),
    },
    window: { innerHeight: 800 },
    getComputedStyle: () => ({}),
    localStorage: makeStorage(),
    escHtml: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]),
    songCoverSrc: () => '',
    cloneSong: (song) => Object.assign({}, song),
    apiJson: async () => ({ tracks: [], hasMore: false, total: 0 }),
    loadPlaylistIntoQueueById: () => Promise.resolve(true),
    showToast() {}, openArtistDetailForSong() {},
    requestAnimationFrame: () => 0,
    PLAYLIST_LAZY_BATCH_SIZE: 48, QUEUE_PANEL_BATCH_SIZE: 48, QUEUE_VIRTUAL_ROW_STEP: 62,
    QUEUE_VIRTUAL_OVERSCAN: 8, PLAYLIST_PANEL_BATCH_SIZE: 48, PLAYLIST_CARD_VIRTUAL_OVERSCAN_PX: 760,
    PLAYLIST_DETAIL_INITIAL_RENDER: 48, PLAYLIST_DETAIL_BATCH_SIZE: 48, PLAYLIST_DETAIL_ROW_STEP: 56,
    PLAYLIST_DETAIL_VIRTUAL_OVERSCAN: 7, PLAYLIST_DETAIL_OUTER_CHROME_HEIGHT: 142,
    PLAYLIST_DETAIL_OUTER_FOOTER_HEIGHT: 44, PLAYLIST_QUEUE_INITIAL_BATCH_SIZE: 96,
    PLAYLIST_QUEUE_BACKGROUND_BATCH_SIZE: 160,
    userPlaylists: [], playlistCatalogRevision: 0, playlistRenderSeq: 0, playlistPanelRenderLimit: 48,
    queuePanelRenderLimit: 48, queuePanelRenderKey: '0', queuePanelVirtualState: { raf: 0 },
    miniQueueOpen: false, miniQueueLazyBound: true, queueViewTab: 'playlists', playQueue: [], currentIdx: -1,
    playlistPanelLazyBound: true, playlistCatalogSyncState: null, loginStatus: { loggedIn: false },
    myPodcastCollections: [],
    AbortController,
  });
  sandbox.window.window = sandbox.window;
  sandbox.window.AbortController = AbortController;
  runInSandbox(sandbox, read(P_PANEL),
    'window.__exports = { openPlaylistPanelDetail, getState: function () { return playlistPanelDetailState; } };',
    'lx-source-align-fix1.02-playlist-detail.js');
  return { sandbox, timers, exports: sandbox.__exports };
}

test('Important-1①：lx 导入源冷导入不得被 12s 腰斩（abort 预算须为导入级 ≥60000）', async () => {
  const { sandbox, timers, exports } = makePanelSandbox();
  sandbox.userPlaylists = [{ id: '7788', provider: 'qq', name: 'QQ 歌单', trackCount: 500 }];
  // 全表导入：一次 POST 返回首页 + hasMore=false（免得 warm 定时器干扰计时断言）。
  sandbox.apiJson = async (url) => {
    if (url === '/api/platform-playlist/import') {
      return { ok: true, playlist: { songs: [{ source: 'tx', id: 't1', songmid: 't1', name: '曲目1', singer: '歌手', album: '', interval: '04:00', pic: '' }] } };
    }
    return { tracks: [], hasMore: false, total: 0 };
  };
  await exports.openPlaylistPanelDetail('qq', '7788', 'QQ 歌单');
  assert.ok(timers.length > 0, '面板应为请求挂 AbortController 定时器');
  const abortBudget = Math.max.apply(null, timers);
  assert.ok(abortBudget >= 60000,
    '导入源冷导入的 abort 预算必须是导入级（≥60000），不得被 12000 腰斩: 实际定时器=' + JSON.stringify(timers));
  assert.ok(!timers.includes(12000), '导入源不得再挂 12s 腰斩定时器: ' + JSON.stringify(timers));
});

test('Important-1①b：非导入源（网易云 cookie 路由）仍保持 12s 预算（不得整体放大）', async () => {
  const { sandbox, timers, exports } = makePanelSandbox();
  sandbox.userPlaylists = [{ id: '123', provider: 'netease', name: 'NE 歌单', trackCount: 3 }];
  sandbox.apiJson = async () => ({ tracks: [{ id: 'n1', name: 'NE' }], nextOffset: 1, total: 1, hasMore: false });
  await exports.openPlaylistPanelDetail('netease', '123', 'NE 歌单');
  assert.ok(timers.includes(12000), '网易云路径维持既有 12s 预算: ' + JSON.stringify(timers));
  assert.ok(!timers.some((ms) => ms >= 60000), '非导入源不得被放大到导入级: ' + JSON.stringify(timers));
});

test('Important-1②：请求中止（AbortError）后 loading 必须复位，不得卡在「载入中」', async () => {
  const { sandbox, exports } = makePanelSandbox();
  sandbox.userPlaylists = [{ id: '7788', provider: 'qq', name: 'QQ 歌单', trackCount: 500 }];
  sandbox.apiJson = async () => { const err = new Error('aborted'); err.name = 'AbortError'; throw err; };
  await exports.openPlaylistPanelDetail('qq', '7788', 'QQ 歌单');
  const st = exports.getState();
  assert.equal(st.key, 'qq:7788');
  assert.equal(st.loading, false, 'AbortError 后必须复位 loading（修复前该分支先 return 未复位 → 卡在载入中）');
});

// 本仓超时（非外部取消）须落到失败文案。02-playlist-detail.js:172 空曲目时渲染
// playlistPanelNoticeHtml(st.message || st.error || '', !!st.error) —— error/message 皆空
// 则面板呈空白，把「等太久被腰斩」谎报成「这个歌单是空的」。
test('Important-1②b：本模块自己的 abort 预算超时须写失败文案，不得渲染成空白/空歌单', async () => {
  const { sandbox, exports } = makePanelSandbox();
  sandbox.userPlaylists = [{ id: '7788', provider: 'qq', name: 'QQ 歌单', trackCount: 500 }];
  sandbox.apiJson = async () => { const err = new Error('timeout'); err.name = 'AbortError'; throw err; };
  await exports.openPlaylistPanelDetail('qq', '7788', 'QQ 歌单');
  const st = exports.getState();
  assert.ok(st.error, '超时后必须有 error 码（修复前只复位 loading，error 留空 → 面板空白）');
  assert.ok(/重试|失败|超时|稍后/.test(String(st.message)),
    '超时后须给出可重试的失败文案: ' + JSON.stringify(st.message));
});

// 外部主动取消（cancelPlaylistPanelDetailRequest 会把 state.controller 置空后触发 AbortError）
// 是「用户已切走/已收起」，不得反过来给新一次请求扣上失败文案。
test('Important-1②c：外部取消（controller 已被置空）的中止不得写失败文案', async () => {
  const { sandbox, exports } = makePanelSandbox();
  sandbox.userPlaylists = [{ id: '7788', provider: 'qq', name: 'QQ 歌单', trackCount: 500 }];
  sandbox.apiJson = async () => {
    // 模拟 cancelPlaylistPanelDetailRequest：请求在途时外部把当前 controller 置空再中止。
    exports.getState().controller = null;
    const err = new Error('cancelled'); err.name = 'AbortError'; throw err;
  };
  await exports.openPlaylistPanelDetail('qq', '7788', 'QQ 歌单');
  const st = exports.getState();
  assert.equal(st.error, '', '外部取消的中止应保持静默（沿用修复前语义）: ' + JSON.stringify(st.error));
});

// ── Important-2 ②：电台全源失败区分于零命中 ───────────────────────────────────

test('Important-2②：buildRadioModeSongs 全源失败时把 failures 记进 radioModeState.lastSearchFailures（空队列与零命中可区分）', async () => {
  const sandbox = Object.assign({}, BASE_GLOBALS, {
    document: makeDomStub(),
    localStorage: makeStorage(),
    homeDashboardLocalSongs: () => [],
    simpleSearchNorm: (v) => String(v || '').trim().toLowerCase(),
    cloneSong: (s) => Object.assign({}, s),
    homeListenSummary: () => null,
    showToast() {},
    fetchLxSearchResults: async () => ({
      songs: [],
      failures: [{ source: 'kw', error: 'HTTP_503' }, { source: 'kg', code: 'SOURCE_COOLDOWN' }],
    }),
  });
  runInSandbox(sandbox, read(P_RADIO),
    'window.__exports = { buildRadioModeSongs, radioModeDefinition, getRadioModeState: function () { return radioModeState; } };',
    'lx-source-align-fix1.04a-radio.js');
  const exports = sandbox.__exports;
  const mode = exports.radioModeDefinition('commute');
  const queue = await exports.buildRadioModeSongs(mode);
  assert.ok(Array.isArray(queue) && queue.length === 0, '全源失败无命中 → 队列为空（实际长度=' + (queue && queue.length) + '）');
  const failures = exports.getRadioModeState().lastSearchFailures;
  assert.ok(Array.isArray(failures) && failures.length >= 2,
    'buildRadioModeSongs 必须把 failures 记进 radioModeState.lastSearchFailures（区分全源失败与零命中）: ' + JSON.stringify(failures));
});
