'use strict';

/**
 * tests/lx-search-frontend.test.js — 批 T11：搜索 tabs + 聚合改指 /api/lx-source/search
 *
 * 手法：沿用 tests/lx-playback-chain.test.js 的 vm 模块片段 + fetch 桩 harness——
 * 把 00-api-quality-output（真 apiJson/escHtml）与 07-search 按序拼进同一个外层 `try`
 * 块交 vm 执行（普通 function 经 Annex B 块级声明泄漏到全局，async 留在块作用域内
 * 跨模块可见，与生产 bundle 一致）。index.html 的 tabs DOM 走静态断言。
 *
 * 覆盖（brief Step 1 四件套）：
 *  ① tab 键集 = 综合(all)/kw/kg/tx/wy/mg/本地(local)，官方平台 tab 退役；
 *  ② 聚合每次搜索只调一次 /api/lx-source/search（fetch 计数），官方 fan-out 路由清零；
 *  ③ SOURCE_COOLDOWN failures 渲染成行内错误条（连同普通 {source,error} 失败）；
 *  ④ .tag-source 六家映射 kw/kg/tx/wy/mg/local → 小蜗/小狗/小秋/小芸/小菇/本地。
 *  扩展：tab 模式→sources 参数（综合=五家、单源=该源）、local tab 不出网只查本地池、
 *        合并去重（上游 :33259-33265 `source|songmid||id|name`）、
 *        setSearchMode 键集归一（含旧 'song' 兼容别名）。
 *  修复轮1（评审 Important 两条）：
 *        ① kg.hash / mg.copyrightId 经 normalizeLxSearchSong 透传进 playlist 交接钉桩；
 *        ② ok:false 错误体（LX_SEARCH_FAILED 等）必须上浮为失败分支（复用 catch 路径），
 *           不得渲染成「没有找到相关歌曲」；空结果 + failures 的行内条路径同批钉桩。
 *  修复轮2（评审回归）：轮1 的无条件 throw 会吞掉真实「全源失败」体（server.js:8410
 *        ok=false + 非空 failures，502）的逐源熔断/暂不可用行；钉桩改为真实服务端形态，
 *        并区分「无 failures 才 throw」（轮1 测试 T11修复② 保留原意图）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const P_00 = 'public/js/modules/05-playback/00-api-quality-output.js';
const P_07 = 'public/js/modules/05-playback/07-search.js';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function escapeText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function jsonResponse(payload, status) {
  const code = Number(status) || 200;
  return {
    ok: code < 400,
    status: code,
    headers: { get: () => 'application/json' },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function makeEl(tag) {
  const classes = new Set();
  const el = {
    tagName: String(tag || 'DIV').toUpperCase(),
    className: '',
    id: '',
    style: {},
    dataset: {},
    children: [],
    firstChild: null,
    lastElementChild: null,
    parentNode: null,
    value: '',
    placeholder: '',
    scrollTop: 0,
    clientHeight: 0,
    scrollHeight: 0,
    classList: {
      add(...names) { names.forEach((n) => classes.add(n)); },
      remove(...names) { names.forEach((n) => classes.delete(n)); },
      toggle(name, on) {
        const want = on === undefined ? !classes.has(name) : !!on;
        if (want) classes.add(name); else classes.delete(name);
        return want;
      },
      contains(name) { return classes.has(name); },
    },
    addEventListener() {},
    removeEventListener() {},
    setAttribute(key, value) { if (key === 'class') el.className = String(value); },
    getAttribute() { return null; },
    removeAttribute() {},
    insertAdjacentHTML(_position, html) { el.innerHTML += String(html); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    containsChild() { return false; },
    focus() {},
    blur() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
    appendChild(child) {
      child.parentNode = el;
      el.children.push(child);
      el.firstChild = el.children[0] || null;
      el.lastElementChild = el.children[el.children.length - 1] || null;
      return child;
    },
    insertBefore(child, ref) {
      child.parentNode = el;
      const i = ref ? el.children.indexOf(ref) : -1;
      if (i < 0) el.children.push(child); else el.children.splice(i, 0, child);
      el.firstChild = el.children[0] || null;
      el.lastElementChild = el.children[el.children.length - 1] || null;
      return child;
    },
    removeChild(child) {
      const i = el.children.indexOf(child);
      if (i >= 0) el.children.splice(i, 1);
      el.firstChild = el.children[0] || null;
      el.lastElementChild = el.children[el.children.length - 1] || null;
      if (child && child.parentNode === el) child.parentNode = null;
      return child;
    },
  };
  let innerHtmlValue = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return innerHtmlValue; },
    set(value) { innerHtmlValue = String(value == null ? '' : value); },
    configurable: true,
  });
  Object.defineProperty(el, 'textContent', {
    get() { return innerHtmlValue; },
    set(value) { innerHtmlValue = escapeText(value); },
    configurable: true,
  });
  return el;
}

function makeSandbox(hooks) {
  hooks = hooks || {};
  const state = {
    searchCalls: [],
    unexpectedRoutes: [],
  };
  const registry = {
    'search-input': makeEl('input'),
    'search-results': makeEl('div'),
    'search-area': makeEl('div'),
    'search-box': makeEl('div'),
  };
  state.$input = registry['search-input'];
  state.$results = registry['search-results'];
  const storage = new Map();
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    Date,
    Math,
    JSON,
    String,
    Number,
    Array,
    Object,
    Boolean,
    Promise,
    RegExp,
    Error,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    URLSearchParams,
    setTimeout(fn, ms) { if (typeof fn === 'function' && ms > 0) fn(); return 0; },
    clearTimeout() {},
    setInterval() { return 0; },
    clearInterval() {},
    requestAnimationFrame(fn) { if (typeof fn === 'function') fn(); return 0; },
    AbortController,
    addEventListener() {},
    removeEventListener() {},
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => { storage.set(key, String(value)); },
      removeItem: (key) => { storage.delete(key); },
    },
    searchMode: 'all',
    playlist: [],
    playQueue: [],
    currentIdx: -1,
    userPlaylists: [],
    // 07-search 的外部依赖（生产环境由其它模块提供）——harness 最小桩：
    setPeek() {},
    updateSearchPillGlassDisplacementMap() {},
    animateListItems() {},
    songCoverSrc(song) { return String((song && (song.picUrl || song.cover || song.pic)) || ''); },
    isSongLiked() { return false; },
    heartIconSvg() { return '<svg class="heart"></svg>'; },
    playlistPlusIconSvg() { return '<svg class="plus"></svg>'; },
    syncLikeStatusForSongs() {},
    openArtistDetailForSong() {},
    songSourceLabel(song) { return String((song && song.source) || 'NE').toUpperCase(); },
    platformMeta(provider) { return { label: provider }; },
    cloneSong(song) { return Object.assign({}, song); },
    showToast(text) { (state.toasts = state.toasts || []).push(String(text)); },
    fetch: async (url) => {
      const route = String(url || '');
      if (route.indexOf('/api/lx-source/search') === 0) {
        const query = Object.fromEntries(new URLSearchParams(route.split('?')[1] || ''));
        state.searchCalls.push({ url: route, query });
        const payload = hooks.search
          ? hooks.search(route, state.searchCalls.length)
          : { ok: true, songs: [], failures: [] };
        // server.js:8410-8411：顶层 ok = songs.length>0 || failures.length===0，
        // ok:false（含全源失败 502 体）一律随 502 下发——harness 按真实状态码交付。
        return jsonResponse(payload || {}, payload && payload.ok === false ? 502 : 200);
      }
      state.unexpectedRoutes.push(route);
      return jsonResponse({ ok: false, code: 'TEST_UNEXPECTED_ROUTE' });
    },
    document: {
      getElementById(id) { return registry[id] || null; },
      createElement(tag) { return makeEl(tag); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {},
      body: makeEl('body'),
    },
  };
  sandbox.window = sandbox;
  return { sandbox, state };
}

function makeHarness(hooks) {
  const { sandbox, state } = makeSandbox(hooks);
  const source = [P_00, P_07].map((p) => read(p)).join('\n');
  const wrapped = 'try {\n' + source + '\n' +
    'window.__exports = { fetchLxSearchResults, fetchMusicSearchResults, searchLxPoolSongs, ' +
    'lxSearchFailureRowsHtml, renderLxSongResults, songSourceTagHtml, searchSongResultHtml, ' +
    'setSearchMode, doSearch, updateSearchModeTabs };\n' +
    '} catch (e) { window.__loadError = e; }\n';
  vm.createContext(sandbox);
  vm.runInContext(wrapped, sandbox, { filename: 'lx-search-frontend.bundle-sim.js' });
  if (sandbox.__loadError) {
    throw new Error('模块装载失败: ' + (sandbox.__loadError.stack || String(sandbox.__loadError)));
  }
  return { sandbox, state, exports: sandbox.__exports };
}

// ---------- ① index.html 搜索 mode tabs（上游 :5684-5694 键集） ----------

test('T11①：搜索 tabs DOM 键集 = 综合(all)/kw/kg/tx/wy/mg/本地(local)，官方平台 tab 退役', () => {
  const html = read('public/index.html');
  const start = html.indexOf('id="search-mode-tabs"');
  assert.ok(start > 0, 'index.html 必须包含 #search-mode-tabs 区');
  const block = html.slice(start, html.indexOf('</div>', start));
  const keys = [...block.matchAll(/data-search-source="([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(keys, ['all', 'kg', 'kw', 'local', 'mg', 'tx', 'wy'],
    'tab 键集必须与上游 :5687-5693 的 all/kw/kg/tx/wy/mg/local 对齐');
  for (const [key, label] of [
    ['all', '综合'], ['kw', '小蜗'], ['kg', '小狗'], ['tx', '小秋'],
    ['wy', '小芸'], ['mg', '小菇'], ['local', '本地'],
  ]) {
    const btn = /<button[^>]*data-search-source="[^"]*"[^>]*>[^<]*<\/button>/g;
    let hit = false;
    for (const raw of block.match(btn) || []) {
      if (raw.includes(`data-search-source="${key}"`) && raw.includes(`>${label}</button>`)) hit = true;
    }
    assert.ok(hit, `tab ${key} 的展示名必须是「${label}」（上游小名体系）`);
  }
  for (const legacy of ['search-mode-netease', 'search-mode-qq', 'search-mode-kugou', 'search-mode-qishui', 'search-mode-spotify']) {
    assert.ok(!block.includes(legacy), `${legacy} 官方平台 tab 必须退役`);
  }
  assert.ok(/setSearchMode\('all'\)/.test(block) && /setSearchMode\('kw'\)/.test(block),
    'tab 点击必须经 setSearchMode 归一入口');
  assert.ok(!html.includes('id="search-mode-podcast"'), '播客 tab 已整条退役（T16c，原「本轮保留」承诺兑现）');
});

// ---------- ② 聚合单次调用新路由 ----------

test('T11②：综合模式每次搜索只调一次 /api/lx-source/search，官方 fan-out 路由清零', async () => {
  const CAND = { source: 'tx', id: '9527', songmid: 'MID9527', name: '晴天测试曲', singer: '歌手A', album: '叶惠美', interval: '04:29', pic: '' };
  const h = makeHarness({ search: () => ({ ok: true, songs: [CAND], failures: [] }) });
  h.state.$input.value = '晴天测试曲';
  await h.exports.doSearch('晴天测试曲', { autoPlayFirst: false });
  assert.equal(h.state.searchCalls.length, 1, '聚合每次搜索必须恰好一次新路由调用');
  assert.equal(h.state.searchCalls[0].query.q, '晴天测试曲');
  assert.equal(h.state.searchCalls[0].query.sources, 'tx,wy,kw,kg,mg', '综合 = 上游 :33254 五家全开');
  assert.equal(h.state.searchCalls[0].query.limit, '12', 'limit=12 上游 :33255 原样');
  assert.deepEqual(h.state.unexpectedRoutes, [], '不得再有官方平台 fan-out 请求');
  const html = h.state.$results.innerHTML;
  assert.ok(html.includes('晴天测试曲'), '结果行必须渲染歌曲名');
  assert.ok(html.includes('lx-source') && html.includes('tx-source'), '行 DOM 必须带上游 lx-source/<key>-source 类');
  assert.equal(h.sandbox.playlist.length, 1);
  assert.equal(h.sandbox.playlist[0].artist, '歌手A', '冻结形状 singer 必须桥接 artist 供 resolveLxPlaybackSong 消费');
});

test('T11②b：单源 tab 的 sources 参数 = 该源；旧 song/netease 模式归一', async () => {
  const h = makeHarness({ search: () => ({ ok: true, songs: [], failures: [] }) });
  const page = await h.exports.fetchMusicSearchResults('某曲', 'kg');
  assert.equal(h.state.searchCalls.length, 1);
  assert.equal(h.state.searchCalls[0].query.sources, 'kg');
  assert.deepEqual(page.songs, []);
  assert.equal(page.hasMore, false, 'lx 聚合无远端 offset 分页');
  await h.exports.fetchMusicSearchResults('某曲', 'song');
  assert.equal(h.state.searchCalls[1].query.sources, 'tx,wy,kw,kg,mg', "旧 'song' 模式必须兼容为综合");
  assert.equal(h.exports.setSearchMode('netease') , undefined);
  assert.equal(h.sandbox.searchMode, 'all', '官方平台模式键归一为综合');
  h.exports.setSearchMode('wy');
  assert.equal(h.sandbox.searchMode, 'wy');
  h.exports.setSearchMode('song');
  assert.equal(h.sandbox.searchMode, 'all');
});

// ---------- ③ SOURCE_COOLDOWN failures → 行内错误条 ----------

test('T11③：failures 渲染行内错误条，SOURCE_COOLDOWN 与普通失败文案区分', async () => {
  const CAND = { source: 'kw', id: '1', name: '酷我结果', singer: 'B', album: '', interval: '', pic: '' };
  const h = makeHarness({
    search: () => ({
      ok: true,
      songs: [CAND],
      failures: [
        { source: 'kg', code: 'SOURCE_COOLDOWN' },
        { source: 'mg', error: 'HTTP_503' },
      ],
    }),
  });
  h.state.$input.value = '酷我结果';
  await h.exports.doSearch('酷我结果', { autoPlayFirst: false });
  const html = h.state.$results.innerHTML;
  const kgRow = /<div[^>]*data-lx-source-failure="kg"[^>]*>[^<]*<\/div>/.exec(html);
  assert.ok(kgRow, 'kg 冷却失败必须渲染为行内错误条');
  assert.ok(/data-lx-failure-code="SOURCE_COOLDOWN"/.test(kgRow[0]), '冷却条必须带 SOURCE_COOLDOWN code 标记');
  assert.match(kgRow[0], /小狗[\s\S]*熔断/, '冷却条走熔断冷却文案（上游语义 + brief）');
  const mgRow = /<div[^>]*data-lx-source-failure="mg"[^>]*>[^<]*<\/div>/.exec(html);
  assert.ok(mgRow, 'mg 普通失败必须渲染为行内错误条');
  assert.match(mgRow[0], /小菇[\s\S]*暂不可用/, '普通失败沿上游「xx 暂不可用」文案');
  assert.ok(!/>综合</.test(kgRow[0]), '失败条用六家源名而非笼统提示');
});

// ---------- ④ .tag-source 六家映射 ----------

test('T11④：.tag-source 六家映射 kw/kg/tx/wy/mg/local，未命中键回落既有体系', () => {
  const h = makeHarness();
  for (const [key, label] of [
    ['kw', '小蜗'], ['kg', '小狗'], ['tx', '小秋'], ['wy', '小芸'], ['mg', '小菇'], ['local', '本地'],
  ]) {
    const tag = h.exports.songSourceTagHtml({ source: key, name: 'x' });
    assert.ok(tag.includes(`class="tag-source ${key}"`), `${key} 行必须挂 .tag-source.${key}`);
    assert.ok(tag.includes(`>${label}<`), `${key} → 「${label}」（上游 :30655 映射）`);
  }
  const official = h.exports.songSourceTagHtml({ source: 'netease', id: '1', name: 'x' });
  assert.ok(official.includes('class="tag-source netease"') && official.includes('>NE<'),
    '非 lx 源行不得被六家映射劫持（沿用现有 NE/QQ/… 标签）');
  const row = h.exports.searchSongResultHtml({ source: 'mg', id: '2', name: '咪咕曲', singer: 'C' }, 0);
  assert.ok(row.includes('lx-source') && row.includes('mg-source') && row.includes('小菇'),
    'searchSongResultHtml 行必须带上游 lx-source 行类与六家标签');
});

// ---------- 扩展：本地池合并 / local tab 不出网 ----------

test('T11扩展：local tab 只查本地歌单池不出网；综合模式 online 优先并按上游键去重', async () => {
  const h = makeHarness({
    search: () => ({
      ok: true,
      songs: [
        { source: 'tx', id: '9527', songmid: 'MID9527', name: '晴天', singer: '周杰伦', album: '', interval: '', pic: '' },
        { source: 'wy', id: 'DUP1', songmid: 'DUP1', name: '重复曲', singer: 'D', album: '', interval: '', pic: '' },
      ],
      failures: [],
    }),
  });
  h.sandbox.userPlaylists = [{
    id: 'pl1', name: '我的歌单',
    songs: [
      { source: 'wy', id: 'DUP1', name: '重复曲', singer: 'D' },
      { source: 'local', id: 'L1', name: '本地晴天', singer: '周杰伦' },
    ],
  }];
  const all = await h.exports.fetchMusicSearchResults('晴天', 'all');
  assert.equal(h.state.searchCalls.length, 1);
  const keys = all.songs.map((s) => `${s.source}:${s.name}`);
  assert.ok(keys.includes('tx:晴天'), '在线命中必须保留');
  assert.equal(keys.filter((k) => k === 'wy:重复曲').length, 1,
    '上游 :33259-33262：source|songmid||id|name 去重，online 优先');
  assert.ok(keys.includes('local:本地晴天'), '本地池命中歌曲并入结果');

  const local = await h.exports.fetchMusicSearchResults('晴天', 'local');
  assert.equal(h.state.searchCalls.length, 1, 'local 模式不得再触发任何网络调用');
  assert.equal(local.songs.length, 1);
  assert.equal(String(local.songs[0].name), '本地晴天');
});

// ---------- T11 修复轮1：失败态上浮 + hash/copyrightId 透传钉桩 ----------

test('T11修复①：kg.hash / mg.copyrightId 经 normalizeLxSearchSong 原样透传进歌曲与 playlist 交接', async () => {
  const KG = { source: 'kg', id: 'A1', songmid: 'SM1', hash: 'HASH_KG_1', name: '小狗曲', singer: 'G', album: '', interval: '', pic: '' };
  const MG = { source: 'mg', id: 'B2', copyrightId: 'CR_MG_999', name: '小菇曲', singer: 'M', album: '', interval: '', pic: '' };
  const h = makeHarness({ search: () => ({ ok: true, songs: [KG, MG], failures: [] }) });
  const page = await h.exports.fetchMusicSearchResults('某曲', 'all');
  const kg = page.songs.find((s) => s.source === 'kg');
  const mg = page.songs.find((s) => s.source === 'mg');
  assert.ok(kg && mg, 'fixtures 必须进入合并结果');
  assert.equal(kg.hash, 'HASH_KG_1', 'T9 裁决：kg 结果携带 hash，必须透传供 resolveLxPlaybackSong 消费');
  assert.equal(mg.copyrightId, 'CR_MG_999', 'T9 裁决：mg 结果携带 copyrightId，必须透传供播放解析消费');
  // 冻结形状其余键也不得被 Object.assign 桥接吞掉
  assert.equal(kg.songmid, 'SM1');
  assert.equal(kg.singer, 'G');
  assert.equal(kg.artist, 'G', 'singer→artist 桥接保持不变');

  h.state.$input.value = '某曲';
  await h.exports.doSearch('某曲', { autoPlayFirst: false });
  const handed = h.sandbox.playlist;
  assert.equal(handed.find((s) => s.source === 'kg')?.hash, 'HASH_KG_1',
    'hash 必须存活到 renderLxSongResults 的 playlist 交接（07-search.js Object.assign 段）');
  assert.equal(handed.find((s) => s.source === 'mg')?.copyrightId, 'CR_MG_999',
    'copyrightId 必须存活到 playlist 交接');
});

test('T11修复②：ok:false 错误体（LX_SEARCH_FAILED，无 failures）必须走失败分支，不得渲染成"没有找到相关歌曲"', async () => {
  const h = makeHarness({
    search: () => ({ ok: false, songs: [], failures: [], error: 'aggregate blew up', code: 'LX_SEARCH_FAILED' }),
  });
  // 单元层：fetchLxSearchResults 对失败体必须 throw（与网络错误同一条 catch 路径）
  await assert.rejects(
    () => h.exports.fetchLxSearchResults('某曲', { sources: 'tx,wy,kw,kg,mg' }),
    'ok:false / error 响应体必须上浮为异常',
  );
  // 行为层：聚合失败渲染既有失败态，而非空结果文案
  h.state.$input.value = '某曲';
  await h.exports.doSearch('某曲', { autoPlayFirst: false });
  const html = h.state.$results.innerHTML;
  assert.ok(!/没有找到相关歌曲/.test(html),
    '服务端失败体不得再被当成"查无结果"渲染');
  assert.match(html, /音源搜索暂时失败，请稍后重试/,
    '必须复用 fetchMusicSearchResults catch 分支的既有失败提示（searchProviderNotice）');
  assert.deepEqual(h.state.unexpectedRoutes, [], '失败路径同样不得触发官方 fan-out');
});

test('T11修复③轮2：全源失败真实体（ok:false + 非空 failures，502）不得 throw，逐源熔断/暂不可用行必须保留', async () => {
  // server.js:8410 ok = songs.length>0 || failures.length===0：
  // 全源失败的真实响应是 {ok:false, songs:[], failures:[非空], error, code} + HTTP 502，
  // 修复轮1 的无条件 throw 会赶在 caller 赋值 lxSearchFailures（07-search.js:1179）之前，
  // 熔断/暂不可用行被泛化提示吞掉。本钉桩锁死真实形态，回归即 RED。
  const h = makeHarness({
    search: () => ({
      ok: false,
      error: 'all sources failed',
      code: 'LX_SEARCH_FAILED',
      songs: [],
      failures: [
        { source: 'kg', code: 'SOURCE_COOLDOWN' },
        { source: 'mg', error: 'HTTP_503' },
      ],
    }),
  });
  // 单元层：带非空 failures 的失败体必须正常返回（failures 透传给 caller），不得上浮为异常
  const unit = await h.exports.fetchLxSearchResults('查无此曲', { sources: 'tx,wy,kw,kg,mg' });
  assert.deepEqual(unit.songs, [], 'songs 缺失/为空时必须归一为数组');
  assert.equal(unit.failures.length, 2, 'failures 必须原样返回供逐源行渲染');
  // 行为层：per-source 失败行仍在，泛化 catch 提示不得出现
  h.state.$input.value = '查无此曲';
  await h.exports.doSearch('查无此曲', { autoPlayFirst: false });
  const html = h.state.$results.innerHTML;
  const kgRow = /<div[^>]*data-lx-source-failure="kg"[^>]*>[^<]*<\/div>/.exec(html);
  assert.ok(kgRow, '全源失败 502 时 kg 冷却失败条必须挂在空态提示后');
  assert.match(kgRow[0], /小狗[\s\S]*熔断/, '冷却条沿 T11 既有熔断文案');
  const mgRow = /<div[^>]*data-lx-source-failure="mg"[^>]*>[^<]*<\/div>/.exec(html);
  assert.ok(mgRow, '全源失败 502 时 mg 普通失败条必须渲染');
  assert.match(mgRow[0], /小菇[\s\S]*暂不可用/);
  assert.ok(!/音源搜索暂时失败，请稍后重试/.test(html),
    '含非空 failures 的失败体不得走 catch 泛化提示（修复轮1 回归钉桩）');
  assert.equal(h.sandbox.playlist.length, 0, '失败不产出歌曲，playlist 保持空');
});
