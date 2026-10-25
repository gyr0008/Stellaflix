'use strict';

/**
 * tests/lx-reroute-batch1.test.js — 批 T15.5b（改道批1）：电台 / 在线匹配 / 切源派发器 / agent
 *
 * 契约（T15.5a §6 + 07-search.js T11 冻结形状）：
 *  ① 07-search controlSourceSearchUrl：一切按源定向改指 /api/lx-source/search?sources=<lx源名>
 *    （netease→wy、qq→tx、kugou→kg、kuwo→kw、migu→mg；非 lx 源 qs/sp 退化五源汇总），
 *    官方 /api/{qq,kugou,qishui,spotify}/search 与 /api/search 消费点退役；
 *  ② 04a-radio-modes buildRadioModeSongs：网络补全走 fetchLxSearchResults（limit=36，
 *    sources=mode.searchSources||'kw,kg,mg'），不再打 /api/search；
 *  ③ 03c-local-online-match searchLocalOnlineMatchOneProvider：走 controlSourceSearchUrl，
 *    其不可用时的兜底 URL 也必须是 lx 形态；
 *  ④ agent-music-tools searchMusic 第三阶段跨平台 fallback：单请求 lx 聚合双源（tx,kg），
 *    不再 fan-out 官方 /api/qq/search + /api/kugou/search。
 * 手法：vm 顶层加载模块片段 + apiJson/fetch 桩记录（沿用 lx-search-frontend / lx-lyric 惯例）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const P_00 = 'public/js/modules/05-playback/00-api-quality-output.js';
const P_07 = 'public/js/modules/05-playback/07-search.js';
const P_RADIO = 'public/js/modules/05-playback/04a-radio-modes.js';
const P_MATCH = 'public/js/modules/05-playback/03c-local-online-match.js';
const P_AGENT = 'public/js/agent-music-tools.js';

const BASE_GLOBALS = {
  console, Date, Math, JSON, String, Number, Array, Object, Boolean, Promise, RegExp, Error,
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

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

function loadBundle(paths, extraGlobals, exportExpr, filename) {
  const sandbox = Object.assign({}, BASE_GLOBALS, {
    document: {
      getElementById: () => makeStubEl(),
      createElement: () => makeStubEl(),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      body: makeStubEl(),
    },
    localStorage: makeStorage(),
  }, extraGlobals || {});
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const source = paths.map(read).join('\n');
  vm.runInContext(
    'try {\n' + source + '\n' + exportExpr + '\n} catch (e) { window.__loadError = e; }\n',
    sandbox,
    { filename: filename || 'lx-reroute-batch1.js' },
  );
  if (sandbox.__loadError) {
    throw new Error('模块装载失败: ' + (sandbox.__loadError.stack || String(sandbox.__loadError)));
  }
  return { sandbox, exports: sandbox.__exports };
}

// ---------- ① controlSourceSearchUrl 派发器（07-search） ----------

// 07-search 装载尾段会跑 updateSearchModeTabs() 等初始化，最小桩沿 lx-search-frontend 惯例。
const SEARCH_LOAD_EXTRAS = {
  searchMode: 'all',
  playlist: [],
  playQueue: [],
  currentIdx: -1,
  userPlaylists: [],
  setPeek() {},
  updateSearchPillGlassDisplacementMap() {},
  animateListItems() {},
  songCoverSrc: (song) => String((song && (song.picUrl || song.cover || song.pic)) || ''),
  isSongLiked: () => false,
  heartIconSvg: () => '<svg class="heart"></svg>',
  playlistPlusIconSvg: () => '<svg class="plus"></svg>',
  syncLikeStatusForSongs() {},
  openArtistDetailForSong() {},
  songSourceLabel: (song) => String((song && song.source) || 'NE').toUpperCase(),
  platformMeta: (provider) => ({ label: provider }),
  cloneSong: (song) => Object.assign({}, song),
  showToast() {},
};

function loadSearchExports() {
  return loadBundle([P_00, P_07], Object.assign({}, SEARCH_LOAD_EXTRAS),
    'window.__exports = { controlSourceSearchUrl, controlSourceProviders };',
    'lx-reroute-batch1.07-search.js');
}

test('改道①-1：controlSourceSearchUrl 全源映射 lx 定向（qq→tx、netease→wy、kugou→kg、kuwo→kw、migu→mg）', () => {
  const { exports } = loadSearchExports();
  const parse = (url) => Object.fromEntries(new URLSearchParams(url.split('?')[1] || ''));
  for (const [provider, expectSources] of [
    ['qq', 'tx'], ['netease', 'wy'], ['kugou', 'kg'], ['kuwo', 'kw'], ['migu', 'mg'],
    ['tx', 'tx'], ['wy', 'wy'], ['kg', 'kg'],
  ]) {
    const url = exports.controlSourceSearchUrl(provider, '晴天 周杰伦');
    assert.ok(url.startsWith('/api/lx-source/search?'), `${provider} 必须走 lx 聚合: ${url}`);
    const q = parse(url);
    assert.equal(q.q, '晴天 周杰伦');
    assert.equal(q.sources, expectSources, `${provider} 应定向单源 ${expectSources}`);
    assert.equal(q.limit, '12');
  }
});

test('改道①-2：非 lx 音源（汽水/Spotify）退化五源汇总；官方按源路由不得回潮', () => {
  const { exports } = loadSearchExports();
  const parse = (url) => Object.fromEntries(new URLSearchParams(url.split('?')[1] || ''));
  for (const provider of ['qishui', 'spotify', 'unknown-provider']) {
    const q = parse(exports.controlSourceSearchUrl(provider, 'x'));
    assert.equal(q.sources, 'tx,wy,kw,kg,mg', `${provider} 无 lx 定向 → 五源汇总交同名匹配筛选`);
  }
  for (const provider of ['qq', 'netease', 'kugou', 'qishui', 'spotify']) {
    const url = exports.controlSourceSearchUrl(provider, 'x');
    assert.ok(!/^\/api\/(search|qq\/search|kugou\/search|qishui\/search|spotify\/search)/.test(url),
      `官方路由不得回潮（${provider}）: ${url}`);
  }
});

// ---------- ② 电台 buildRadioModeSongs → lx 聚合搜索 ----------

test('改道②：buildRadioModeSongs 走 fetchLxSearchResults（默认 kw,kg,mg；DJ 台 mode.searchSources），不再打 /api/search', async () => {
  const calls = [];
  const onlineSong = (source, id, name) => ({ source, id, songmid: 'M' + id, name, singer: '某歌手', album: '', interval: '04:00', pic: '' });
  const { exports } = loadBundle([P_RADIO], {
    homeDashboardLocalSongs: () => [],
    simpleSearchNorm: (v) => String(v || '').trim().toLowerCase(),
    cloneSong: (s) => Object.assign({}, s),
    homeListenSummary: () => null,
    fetchLxSearchResults: async (query, options) => {
      calls.push({ query, options });
      return { songs: [onlineSong('kw', 'k1', query + '命中曲'), onlineSong('kg', 'g1', query + '小狗曲')], failures: [] };
    },
  }, 'window.__exports = { buildRadioModeSongs, radioModeDefinition };', 'lx-reroute-batch1.04a-radio.js');

  const commute = exports.radioModeDefinition('commute');
  const queue = await exports.buildRadioModeSongs(commute);
  assert.ok(calls.length >= 1 && calls.length <= 3, '查询词去重后 ≤3 次 lx 聚合调用: ' + calls.length);
  calls.forEach((c) => {
    assert.equal(c.options.limit, 36);
    assert.equal(c.options.sources, 'kw,kg,mg', '默认电台网络补全 = 上游 kw,kg,mg 三源');
  });
  assert.ok(queue.length > 0, 'lx 命中歌曲必须进入电台队列');
  assert.ok(queue.every((s) => s.radioModeId === undefined || s.radioModeId === 'commute'));

  const dj = exports.radioModeDefinition('dj');
  const djQueue = await exports.buildRadioModeSongs(dj);
  assert.ok(djQueue.length > 0, 'DJ 台同样应产出队列');

  const text = read(P_RADIO);
  assert.ok(!/\/api\/search\?keywords=/.test(text), '电台不得再消费官方 /api/search');
});

// ---------- ③ 在线匹配（03c） ----------

function loadMatchSandbox(withDispatcher) {
  const calls = [];
  const extra = {
    accountProviderOrder: () => ['netease', 'qq'],
    isSameTitleArtist: () => true,
    queueItemKey: () => '',
    playbackRestoreSongSnapshot: (s) => Object.assign({}, s),
    apiJson: async (url) => {
      calls.push(url);
      return { ok: true, songs: [{ source: 'tx', id: 'T1', name: '夜空中最亮的星', singer: '逃跑计划', interval: '04:12' }], failures: [] };
    },
  };
  if (withDispatcher) {
    const { exports } = loadSearchExports();
    extra.controlSourceSearchUrl = exports.controlSourceSearchUrl;
  }
  const { exports } = loadBundle([P_MATCH], extra,
    'window.__exports = { searchLocalOnlineMatchOneProvider };', 'lx-reroute-batch1.03c.js');
  return { calls, exports };
}

test('改道③-1：在线匹配经 controlSourceSearchUrl 命中 lx 定向路由（qq→sources=tx）', async () => {
  const h = loadMatchSandbox(true);
  const hit = await h.exports.searchLocalOnlineMatchOneProvider(
    { type: 'local', name: '夜空中最亮的星', artist: '逃跑计划' }, 'qq');
  assert.equal(h.calls.length, 1);
  assert.ok(h.calls[0].startsWith('/api/lx-source/search?'), '匹配查询必须走 lx: ' + h.calls[0]);
  assert.match(h.calls[0], /sources=tx(&|$)/);
  assert.ok(hit && hit.provider === 'qq', '命中候选须回标 provider');
  assert.ok(!/\/api\/search\?keywords=/.test(read(P_MATCH)), '官方 /api/search 兜底不得残留');
});

test('改道③-2：controlSourceSearchUrl 不可用时兜底 URL 也是 lx 形态（五源汇总）', async () => {
  const h = loadMatchSandbox(false);
  await h.exports.searchLocalOnlineMatchOneProvider(
    { type: 'local', name: '夜空中最亮的星', artist: '逃跑计划' }, 'netease');
  assert.equal(h.calls.length, 1);
  assert.ok(h.calls[0].startsWith('/api/lx-source/search?'), '兜底必须同源 lx 形态: ' + h.calls[0]);
  assert.match(h.calls[0], /sources=tx%2Cwy%2Ckw%2Ckg%2Cmg|sources=tx,wy,kw,kg,mg/);
});

// ---------- ④ agent searchMusic 第三阶段跨平台 fallback ----------

test('改道④：agent searchMusic 跨平台 fallback 单请求 lx 聚合双源（tx,kg），官方 qq/kugou search 清零', async () => {
  const calls = [];
  const { exports } = loadBundle([P_AGENT], {
    apiJson: async (url) => {
      calls.push(url);
      return { ok: true, songs: [], failures: [{ source: 'tx', error: 'HTTP_500' }, { source: 'kg', error: 'HTTP_500' }] };
    },
    fetch: async () => { throw new Error('agent 改道测试不应直接使用 fetch: '); },
  }, 'window.__exports = window.StellaflixAgentMusicTools;', 'lx-reroute-batch1.agent.js');

  const result = await exports.search_music({ title: '东风破', artist: '周杰伦不存在歌手', limit: 5 });
  assert.equal(result.ok, false, '三阶段皆空必须落 NO_MATCH 类失败');
  assert.ok(calls.length >= 3, '阶段1+2+3 至少三次请求: ' + JSON.stringify(calls));
  const crossCall = calls[calls.length - 1];
  assert.ok(crossCall.startsWith('/api/lx-source/search?'), '第三阶段必须 lx 聚合: ' + crossCall);
  assert.match(crossCall, /sources=tx%2Ckg/, '跨平台 fallback = tx,kg 单请求双源: ' + crossCall);
  calls.forEach((url) => {
    assert.ok(!/^\/api\/(qq|kugou|qishui|spotify)\/search/.test(url), `官方按平台 search 不得回潮: ${url}`);
    assert.ok(!/^\/api\/search\?/.test(url), `官方 /api/search 不得回潮: ${url}`);
  });
  const text = read(P_AGENT);
  assert.ok(!/'\/api\/qq\/search/.test(text) && !/'\/api\/kugou\/search/.test(text),
    'agent 文件内官方双平台搜索端点字符串必须退役');
});
