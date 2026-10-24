'use strict';

/**
 * tests/lx-playback-chain.test.js — T9 播放解析统一指 /api/lx-source/resolve + 三级失败链
 *
 * 手法：复刻 index-loader.js 的运行形态——把 00-api-quality-output / 11-provider-fallback /
 * 13-playback-start-audio 按 modulePaths 顺序拼进同一个外层 `try` 块后交 vm 执行：
 * 普通 function 经 Annex B 块级声明泄漏到全局，async function 留在块作用域内跨模块可见，
 * 与生产 bundle 一致（模式参考 tests/home-video-discovery-partial-retry.test.js）。
 *
 * 覆盖断言（brief Step 1）：
 *  ①官方五分支不再出现在新解析函数；
 *  ②resolver 失败后 excludedResolvers 递增（含死 URL 去重与 _lxResolver 回环）；
 *  ③穷尽后调 /api/lx-source/search 跨平台重匹配并 applyCrossPlatformSongMatch；
 *  ④重匹配再穷尽→按机器 code 分支的终态引导文案；
 *  扩展：audio.onerror 断点重解析封顶 3、proxyUrl 不透明消费（裁决4）、
 *        kg hash / mg copyrightId 透传（裁决1）、CustomSourceIntegration 退役边
 *        （含 index.html 标题栏 #custom-source-btn 内联守卫）、
 *        T9 修复轮1：同一失败 URL 的运行时链与起播失败链合计只重入 playQueueAt 一次。
 *
 * T10 追加（客户端缓存 + 在途去重 + 下曲预取，上游 :31826-31857 / :32026-32043 / :32249 / :32374）：
 *  ①同曲并发两次 resolve 只发一次 fetch（在途共享同一 Promise）；
 *  ②90s 内二次播放命中 lxResolvedAudioCache（0 网络）；
 *  ③音质切换（00 的 applyPlaybackQualityToCurrentTrack）调 invalidateLxResolvedAudioCache → 下次播放重新解析；
 *  ④播放成功后注入时钟 +700ms 对队列下一首预取（stub 槽位记录 ms，断言调度延迟 ===700 行为钉桩）：
 *     不跨平台、单发不重试、失败零提示仅 console.debug，
 *     切曲前定时器可清除（裁决4 计时器卫生）；
 *  ⑤裁决2 计数统一：运行时链与起播失败链合并进 opts.lxChainDepth 一份共享深度，封顶 3。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const P_00 = 'public/js/modules/05-playback/00-api-quality-output.js';
const P_11 = 'public/js/modules/05-playback/11-provider-fallback.js';
const P_13 = 'public/js/modules/05-playback/13-playback-start-audio.js';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const MARK_BEGIN = 'T9 播放链统一：音源解析三级失败链（起）';
const MARK_END = 'T9 播放链统一：音源解析三级失败链（止）';

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function makeSandbox(hooks) {
  hooks = hooks || {};
  const state = {
    resolveCalls: [],
    searchCalls: [],
    unexpectedRoutes: [],
    notices: [],
    toasts: [],
    playQueueAtCalls: [],
    debugs: [],
  };
  const realSetTimeout = setTimeout;
  const deferredTimers = [];
  function stubSetTimeout(fn, ms) {
    if (typeof fn !== 'function') return 0;
    if (!ms || ms <= 0) return realSetTimeout(fn, 0);
    // 槽位记录 ms：T10④ 用它在触发前钉桩「+700ms」延迟本身
    //（runPendingTimers 不看 ms 一律触发，光靠推进时钟无法区分 700 与 100）。
    deferredTimers.push({ fn, ms });
    return deferredTimers.length;
  }
  function stubClearTimeout(id) {
    const i = Number(id) - 1;
    if (Number.isFinite(i) && i >= 0 && i < deferredTimers.length) deferredTimers[i] = null;
    return 0;
  }
  // 注入时钟：T10 预取测试用「+700ms 触发所有在途定时器」模拟；触发前先清空槽位，
  // 使回调内再次 schedule 的定时器留到下一轮 runTimers。
  function runPendingTimers() {
    const snapshot = deferredTimers.slice();
    for (let i = 0; i < deferredTimers.length; i++) deferredTimers[i] = null;
    snapshot.forEach(function (slot) { if (slot) slot.fn(); });
  }
  state.runTimers = runPendingTimers;
  // 只读窥视口：测试在 runTimers 清空槽位前取 {fn, ms} 断言延迟值（如 700ms 预取钉桩）。
  state.pendingTimers = function () { return deferredTimers.filter(Boolean); };
  // 极简 DOM：真 showSourceFallbackNotice（模块声明会覆盖同名 stub）走卡片 DOM 路径，
  // insertBefore 时按卡片结构回收 {title, body} 进 state.notices。
  function makeEl(tag) {
    const el = {
      tagName: String(tag || 'DIV').toUpperCase(),
      className: '',
      id: '',
      textContent: '',
      style: {},
      dataset: {},
      children: [],
      firstChild: null,
      lastElementChild: null,
      parentNode: null,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      setAttribute() {},
      removeAttribute() {},
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
        if (child && child.className === 'source-fallback-card') {
          const head = (child.children && child.children[0]) || {};
          const titleEl = (head.children && head.children[0]) || {};
          const bodyEl = (child.children && child.children[1]) || {};
          state.notices.push({ title: String(titleEl.textContent || ''), body: String(bodyEl.textContent || '') });
        }
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
    return el;
  }
  const sandbox = {
    console: {
      log() {}, info() {}, warn() {}, error() {},
      debug() { state.debugs.push(Array.prototype.slice.call(arguments).map(String).join(' ')); },
    },
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
    setTimeout: stubSetTimeout,
    clearTimeout: stubClearTimeout,
    setInterval: stubSetTimeout,
    clearInterval: stubClearTimeout,
    requestAnimationFrame() { return 0; },
    AbortController,
    trackSwitchToken: 101,
    playQueue: [],
    currentIdx: 0,
    playMode: 'order',
    audio: null,
    forcePlaybackControlsInteractive() {},
    songProviderKey(s) { return String((s && (s.providerKey || s.source || s.provider)) || ''); },
    playbackQualityPrefs: {},
    PLAYBACK_QUALITY_DEFAULTS: {
      netease: 'hires',
      qq: 'lossless',
      kugou: 'lossless',
      qishui: 'standard',
      spotify: 'standard',
    },
    cloneSong(s) { return Object.assign({}, s); },
    hydrateCustomCover(s) { return s; },
    // 注意：11 里的真 showSourceFallbackNotice 声明会经 Annex B 泄漏覆盖此 stub，
    // 实际通知捕获走 makeEl 的 insertBefore（卡片 → state.notices）。
    showSourceFallbackNotice(title, body) { state.notices.push({ title, body }); },
    showToast(text) { state.toasts.push(String(text)); },
    playQueueAt(idx, opts) {
      state.playQueueAtCalls.push({ idx, opts });
      const impl = hooks.playQueueAt || (async () => true);
      return Promise.resolve(impl(idx, opts));
    },
    fetch: async (url, opts) => {
      opts = opts || {};
      let body = null;
      if (typeof opts.body === 'string') {
        try { body = JSON.parse(opts.body); } catch (e) { body = null; }
      }
      const route = String(url || '');
      if (route.indexOf('/api/lx-source/resolve') === 0) {
        state.resolveCalls.push({ url: route, body });
        const payload = hooks.resolve
          ? hooks.resolve(state.resolveCalls.length, body, route)
          : { ok: false, code: 'LX_SOURCE_RESOLVE_ALL_FAILED', error: 'stub-default' };
        return jsonResponse(payload || {});
      }
      if (route.indexOf('/api/lx-source/search') === 0) {
        const query = Object.fromEntries(new URLSearchParams(route.split('?')[1] || ''));
        state.searchCalls.push({ url: route, query });
        const payload = hooks.search
          ? hooks.search(route, state.searchCalls.length)
          : { ok: true, songs: [], failures: [] };
        return jsonResponse(payload || {});
      }
      state.unexpectedRoutes.push(route);
      return jsonResponse({ ok: false, code: 'TEST_UNEXPECTED_ROUTE' });
    },
    document: {
      getElementById() { return null; },
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
  hooks = hooks || {};
  const { sandbox, state } = makeSandbox(hooks);
  const source = [P_00, P_11, P_13]
    .map((p) => read(p))
    .join('\n');
  const wrapped = 'try {\n' + source + '\n' +
    'window.__exports = { lxNormalizeSourceName, lxSourcePlatformLabel, lxPlaybackSongPayload, lxRequestQualityForPlaybackQuality, ' +
    'lxPlaybackLevelFromLxQuality, lxSourceGuidanceText, resolveLxPlaybackSong, resolveCrossPlatformPlaybackFallback, ' +
    'armLxRuntimeErrorFallback, claimLxPlaybackReentry, applyCrossPlatformSongMatch, searchAlternatePlatformSong, ' +
    'lxResolvedAudioCacheKey, invalidateLxResolvedAudioCache, cachedLxResolvedAudio, ' +
    'scheduleLxAudioPrefetch, clearLxAudioPrefetchTimer, nextLxAudioPrefetchSong, applyPlaybackQualityToCurrentTrack };\n' +
    '} catch (e) { window.__loadError = e; }\n';
  vm.createContext(sandbox);
  vm.runInContext(wrapped, sandbox, { filename: 'lx-playback-chain.bundle-sim.js' });
  if (sandbox.__loadError) {
    throw new Error('模块装载失败: ' + (sandbox.__loadError.stack || String(sandbox.__loadError)));
  }
  return { sandbox, state, exports: sandbox.__exports };
}

// ---------- ① 官方五分支不再出现在新解析函数 ----------

test('T9①：新解析区只走 /api/lx-source/*；playQueueAt 官方五分支清零，仅留播客豁免一处', () => {
  const src13 = read(P_13);
  const b = src13.indexOf(MARK_BEGIN);
  const e = src13.indexOf(MARK_END);
  assert.ok(b >= 0 && e > b, '13-playback-start-audio.js 必须包含 T9 三级失败链标记区（起止注释）');
  const region = src13.slice(b, e);
  for (const legacy of ['/api/qq/song/url', '/api/kugou/song/url', '/api/qishui/song/url', '/api/spotify/song/url', '/api/song/url']) {
    assert.ok(!region.includes(legacy), `新解析区不应包含官方路由 ${legacy}`);
  }
  assert.ok(region.includes('/api/lx-source/resolve'), '新解析区必须走 /api/lx-source/resolve');
  assert.ok(region.includes('/api/lx-source/search'), '跨平台重匹配必须走 /api/lx-source/search');

  const play = src13.slice(src13.indexOf('async function playQueueAt'));
  assert.ok(play.length > 4000, 'playQueueAt 区域应存在且完整到文件尾');
  for (const legacy of ['/api/qq/song/url', '/api/kugou/song/url', '/api/qishui/song/url', '/api/spotify/song/url']) {
    assert.ok(!play.includes(legacy), `playQueueAt 不应再包含 ${legacy}`);
  }
  const neteaseHits = (play.match(/\/api\/song\/url/g) || []).length;
  assert.equal(neteaseHits, 1, 'playQueueAt 只允许保留播客豁免一处 /api/song/url（T16 播客下线时清除）');
  assert.ok(play.includes('resolveLxPlaybackSong('), 'playQueueAt 解析段必须调用 resolveLxPlaybackSong');
  assert.ok(read(P_11).includes('/api/lx-source/search'), '11-provider-fallback 新查询实现必须指 /api/lx-source/search');
});

// ---------- ② resolver 级失败后 excludedResolvers 递增 ----------

test('T9②：resolver 级失败后 excludedResolvers 递增（_lxResolver 记忆喂排除，绕开服务端 90s 缓存）', async () => {
  const PROXY_B = '/api/audio?url=https%3A%2F%2Fc1.example%2Fx.mp3&h=abc+def';
  const h = makeHarness({
    resolve: (n) => n === 1
      ? { ok: false, code: 'LX_SOURCE_RESOLVE_ALL_FAILED', error: '当前音源及备用音源均解析失败，请切换音源后重试' }
      : { ok: true, source: 'wy', url: 'https://c1.example/x.mp3', proxyUrl: PROXY_B, headers: {}, quality: 'flac', actual: { codec: 'flac', lossless: true, bitrate: 0, sampleRate: 44100, bitDepth: 16 }, probeWarning: '', resolver: 'B' },
  });
  const song = { source: 'wy', id: '777', name: '测试曲', singer: '歌手A', _lxResolver: 'A' };
  const result = await h.exports.resolveLxPlaybackSong(song, { quality: 'lossless', excludeResolvers: [] });
  assert.equal(h.state.resolveCalls.length, 2);
  assert.deepEqual(h.state.resolveCalls[0].body.excludeResolvers, []);
  assert.deepEqual(h.state.resolveCalls[1].body.excludeResolvers, ['a'], '失败后必须把 _lxResolver 记忆排入 excludeResolvers（客户端归一小写，与 lx-source-host.js:1187 服务端归一语义一致）');
  assert.equal(h.state.resolveCalls[0].body.quality, 'flac', 'Stellaflix lossless 必须映射为 LX flac');
  assert.equal(result.resolver, 'B');
  assert.equal(result.actual, 'flac', '服务端 actual 是 Range 探测对象、音质词在 quality；不得 String(probe) 变成 [object Object] 误判 standard');
  assert.equal(h.exports.lxPlaybackLevelFromLxQuality(result.actual), 'flac', 'T12 词汇总一：level 映射吃到音质词且输出 LX 五档词汇（旧 lossless→flac）');
  assert.equal(result.proxyUrl, PROXY_B, '裁决4：proxyUrl 作不透明字符串原样返回，不得重编码');
  assert.equal(song._lxResolver, 'B', '_lxResolver 记忆字段回环');
});

test('T9②b：死 URL 去重——重解析返回已试过地址按 resolver 级失败处理并排除该 resolver 再试', async () => {
  const DEAD = '/api/audio?url=https%3A%2F%2Fdead.example%2Fa.flac';
  const OK_B = '/api/audio?url=https%3A%2F%2Fok.example%2Fb.flac';
  const h = makeHarness({
    resolve: (n) => n === 1
      ? { ok: true, source: 'wy', url: 'https://dead.example/a.flac', proxyUrl: DEAD, resolver: 'A', actual: 'flac' }
      : { ok: true, source: 'wy', url: 'https://ok.example/b.flac', proxyUrl: OK_B, resolver: 'B', actual: 'flac' },
  });
  const song = { source: 'wy', id: '777', name: 'x', singer: 'y' };
  const r = await h.exports.resolveLxPlaybackSong(song, { quality: 'flac', excludeResolvers: [], attemptedUrls: [DEAD] });
  assert.equal(h.state.resolveCalls.length, 2);
  assert.deepEqual(h.state.resolveCalls[1].body.excludeResolvers, ['a'], '死地址的 resolver 必须被排除（归一小写喂服务端排除集）');
  assert.equal(r.resolver, 'B');
  assert.equal(r.proxyUrl, OK_B);
  assert.equal(song._lxResolver, 'B');
});

// ---------- ③ 穷尽后跨平台重匹配 ----------

test('T9③：一级穷尽后走 /api/lx-source/search 跨平台重匹配并应用 applyCrossPlatformSongMatch', async () => {
  const CAND = { source: 'tx', id: '9527', songmid: 'MID9527', name: '测试曲', singer: '歌手A', album: '', interval: '00:04', pic: '' };
  const PROXY_C = '/api/audio?url=https%3A%2F%2Ftx.example%2Fc.m4a&h=zz%3D1';
  const h = makeHarness({
    resolve: (n, body) => body.source === 'wy'
      ? { ok: false, code: 'LX_SOURCE_RESOLVE_ALL_FAILED', error: '当前音源及备用音源均解析失败，请切换音源后重试' }
      : { ok: true, source: 'tx', url: 'https://tx.example/c.m4a', proxyUrl: PROXY_C, resolver: 'hostT', quality: '320k', actual: { codec: 'm4a', lossless: false, bitrate: 0, sampleRate: 0 } },
    search: () => ({ ok: true, songs: [CAND], failures: [] }),
  });
  const song = { source: 'wy', id: '777', name: '测试曲', singer: '歌手A' };
  const r = await h.exports.resolveLxPlaybackSong(song, { quality: 'flac', excludeResolvers: [] });
  assert.equal(h.state.resolveCalls.filter((c) => c.body.source === 'wy').length, 3, '一级重试预算 ≥3（上游 installedSourceCount 下限 3）');
  assert.equal(h.state.searchCalls.length, 1);
  assert.equal(h.state.searchCalls[0].query.sources, 'kw,kg,mg,tx', '重匹配搜索必须剔除失败源 wy');
  assert.match(h.state.searchCalls[0].query.q, /测试曲/);
  const candCall = h.state.resolveCalls[h.state.resolveCalls.length - 1];
  assert.equal(candCall.body.source, 'tx');
  assert.equal(candCall.body.musicInfo.songmid, 'MID9527');
  assert.equal(r.crossMatched, true);
  assert.equal(r.proxyUrl, PROXY_C);
  assert.equal(r.resolver, 'hostT');
  assert.equal(song.source, 'tx');
  assert.equal(song.provider, 'tx');
  assert.equal(song.resolvedPlaybackProvider, 'lx-custom-source');
  assert.equal(song.needsCrossPlatformMatch, false);
  assert.equal(song._lxResolver, 'hostT', '跨平台命中同样写入 _lxResolver 记忆');
  assert.ok(h.state.notices.some((n) => n.title === '已自动换源'), '命中后要有换源提示');
});

test('T9③b：跨平台命中同样做死URL去重——返回已试过地址则排除其 resolver 换下一候选（上游 :32359）', async () => {
  const DEAD = '/api/audio?url=https%3A%2F%2Fdead.example%2Fx.flac';
  const OK = '/api/audio?url=https%3A%2F%2Fok.example%2Fy.mp3';
  const CAND_DEAD = { source: 'tx', id: '1', songmid: 'D1', name: '测试曲', singer: '歌手A', album: '', interval: '', pic: '' };
  const CAND_OK = { source: 'kw', id: '2', songmid: 'K2', name: '测试曲', singer: '歌手A', album: '', interval: '', pic: '' };
  const h = makeHarness({
    resolve: (n, body) => body.source === 'wy'
      ? { ok: false, code: 'LX_SOURCE_RESOLVE_ALL_FAILED', error: '当前音源及备用音源均解析失败' }
      : (body.source === 'tx'
        ? { ok: true, source: 'tx', url: 'https://dead.example/x.flac', proxyUrl: DEAD, resolver: 'hostDead', quality: 'flac', actual: { codec: 'flac', lossless: true } }
        : { ok: true, source: 'kw', url: 'https://ok.example/y.mp3', proxyUrl: OK, resolver: 'hostOk', quality: '320k', actual: { codec: 'mp3', bitrate: 320 } }),
    search: () => ({ ok: true, songs: [CAND_DEAD, CAND_OK], failures: [] }),
  });
  const song = { source: 'wy', id: '777', name: '测试曲', singer: '歌手A' };
  const r = await h.exports.resolveLxPlaybackSong(song, { quality: 'flac', excludeResolvers: [], attemptedUrls: [DEAD] });
  assert.equal(r.crossMatched, true);
  assert.equal(r.source, 'kw', '换源结果命中已试过的死地址时必须换下一候选');
  assert.equal(r.resolver, 'hostOk');
  assert.equal(song.source, 'kw', '身份改写给的是最终可用候选');
  const candOkCall = h.state.resolveCalls[h.state.resolveCalls.length - 1];
  assert.equal(candOkCall.body.source, 'kw');
  assert.ok(candOkCall.body.excludeResolvers.includes('hostdead'), '死链 resolver 归一小写并入后续候选解析的排除集');
});

// ---------- ④ 重匹配再穷尽→终态引导 ----------
test('T9④：跨平台重匹配再穷尽 → 终态引导文案按机器 code 分支（裁决3）', async () => {
  const h = makeHarness({
    resolve: () => ({ ok: false, code: 'LX_SOURCE_RESOLVE_ALL_FAILED', error: '当前音源及备用音源均解析失败，请切换音源后重试' }),
    search: () => ({ ok: true, songs: [{ source: 'tx', id: '1', songmid: 'X', name: '不相干', singer: '别人', album: '', interval: '', pic: '' }], failures: [] }),
  });
  const song = { source: 'netease', id: '777', name: '测试曲', singer: '歌手A' };
  await assert.rejects(
    () => h.exports.resolveLxPlaybackSong(song, { quality: 'flac', excludeResolvers: [] }),
    (err) => {
      assert.equal(err.code, 'LX_SOURCE_RESOLVE_ALL_FAILED');
      assert.equal(err.lxTerminal, true);
      assert.equal(err.message, h.exports.lxSourceGuidanceText('LX_SOURCE_RESOLVE_ALL_FAILED'));
      assert.match(err.message, /音源/);
      return true;
    },
  );
});

test('T9④b：LX_NO_SOURCES 不空转重试也不跨平台匹配，直接终态引导（导入音源）', async () => {
  const h = makeHarness({
    resolve: () => ({ ok: false, code: 'LX_NO_SOURCES' }),
    search: () => { throw new Error('LX_NO_SOURCES 不该发起跨平台匹配'); },
  });
  const song = { source: 'wy', id: '777', name: 'x', singer: 'y' };
  await assert.rejects(
    () => h.exports.resolveLxPlaybackSong(song, { quality: 'standard', excludeResolvers: [] }),
    (err) => {
      assert.equal(err.code, 'LX_NO_SOURCES');
      assert.equal(err.lxTerminal, true);
      assert.match(err.message, /音源管理|导入/);
      return true;
    },
  );
  assert.equal(h.state.resolveCalls.length, 1, '无音源时不得空转三次重试');
  assert.equal(h.state.searchCalls.length, 0);
});

test('T9④c：sp/qs 等非可解析平台直接跨平台重匹配（上游 needsCrossPlatformMatch 语义）', async () => {
  const CAND = { source: 'wy', id: '3', songmid: 'N3', name: 'x', singer: 'y', album: '', interval: '', pic: '' };
  const h = makeHarness({
    resolve: (n, body) => body.source === 'wy'
      ? { ok: true, source: 'wy', url: 'https://wy.example/s.mp3', proxyUrl: '/api/audio?url=https%3A%2F%2Fwy.example%2Fs.mp3', resolver: 'wyHost', actual: '128k' }
      : { ok: false, code: 'LX_SOURCE_NO_RESOLVER', error: '没有可用于这首歌的音源' },
    search: () => ({ ok: true, songs: [CAND], failures: [] }),
  });
  const song = { source: 'spotify', provider: 'spotify', id: 'SP1', name: 'x', singer: 'y' };
  const r = await h.exports.resolveLxPlaybackSong(song, { quality: 'standard', excludeResolvers: [] });
  assert.equal(h.state.resolveCalls.filter((c) => c.body.source === 'sp').length, 0, 'sp 无解析器，不得发起一级尝试');
  assert.equal(r.crossMatched, true);
  assert.equal(song.source, 'wy');
});

// ---------- 词汇表 / payload 透传（裁决1） ----------

test('T9：源名与音质词汇映射 + lxPlaybackSongPayload 透传（kg hash / mg copyrightId / fallbackId 清零）', () => {
  const h = makeHarness({});
  const ex = h.exports;
  assert.equal(ex.lxNormalizeSourceName('netease'), 'wy');
  assert.equal(ex.lxNormalizeSourceName('qq'), 'tx');
  assert.equal(ex.lxNormalizeSourceName('kuwo'), 'kw');
  assert.equal(ex.lxNormalizeSourceName('kugou'), 'kg');
  assert.equal(ex.lxNormalizeSourceName('migu'), 'mg');
  assert.equal(ex.lxNormalizeSourceName('qishui'), 'qs');
  assert.equal(ex.lxNormalizeSourceName('spotify'), 'sp');
  assert.equal(ex.lxNormalizeSourceName('TX'), 'tx');
  assert.equal(ex.lxNormalizeSourceName('kg'), 'kg');

  // T12 词汇总一：内部键即 LX 协议词——旧词仍映射到同一档位（词汇表兜底），新词直通。
  assert.equal(ex.lxRequestQualityForPlaybackQuality('jymaster'), 'master');
  assert.equal(ex.lxRequestQualityForPlaybackQuality('hires'), 'hires');
  assert.equal(ex.lxRequestQualityForPlaybackQuality('lossless'), 'flac');
  assert.equal(ex.lxRequestQualityForPlaybackQuality('exhigh'), '320k');
  assert.equal(ex.lxRequestQualityForPlaybackQuality('standard'), '128k');
  assert.equal(ex.lxRequestQualityForPlaybackQuality('master'), 'master');
  assert.equal(ex.lxRequestQualityForPlaybackQuality('flac24bit'), 'flac24bit');

  // T12：lx level 回映统一到五档——hires/atmos_plus 折叠进相邻档（flac24bit/master）。
  assert.equal(ex.lxPlaybackLevelFromLxQuality('master'), 'master');
  assert.equal(ex.lxPlaybackLevelFromLxQuality('atmos_plus'), 'master');
  assert.equal(ex.lxPlaybackLevelFromLxQuality('flac24bit'), 'flac24bit');
  assert.equal(ex.lxPlaybackLevelFromLxQuality('hires'), 'flac24bit');
  assert.equal(ex.lxPlaybackLevelFromLxQuality('flac'), 'flac');
  assert.equal(ex.lxPlaybackLevelFromLxQuality('320k'), '320k');
  assert.equal(ex.lxPlaybackLevelFromLxQuality('128k'), '128k');

  const kg = ex.lxPlaybackSongPayload({ source: 'kugou', id: '11', songmid: '11', hash: 'H123456', name: 'n', singer: 's' });
  assert.equal(kg.source, 'kg');
  assert.equal(kg.hash, 'H123456');
  assert.equal(kg.meta.kg.hash, 'H123456', 'kg 解析脚本依赖 meta.kg.hash（Audioid 不能替代）');

  const mg = ex.lxPlaybackSongPayload({ source: 'mg', id: 's1', songmid: 's1', copyrightId: 'C9', name: 'n', singer: 's' });
  assert.equal(mg.copyrightId, 'C9');
  assert.equal(mg.meta.mg.copyrightId, 'C9', 'mg 解析脚本依赖 meta.mg.copyrightId');

  const fb = ex.lxPlaybackSongPayload({ source: 'tx', id: 'tx_0123456789abc', songmid: 'tx_0123456789abc', name: 'n', singer: 's' });
  assert.equal(fb.id, '');
  assert.equal(fb.songmid, '');
  assert.equal(fb.meta.qq.mid, '', 'fallback 合成 id 必须清零，仅留 name/singer 走模糊匹配');
  assert.equal(fb.name, 'n');
});

// ---------- 扩展：audio.onerror 断点重解析封顶 3 ----------

test('T9扩展：audio.onerror 断点重解析封顶 3 次，携带增长的 excluded/attempted（上游 :32380-32396）', async () => {
  const played = [];
  const h = makeHarness({ playQueueAt: async (idx, opts) => { played.push({ idx, opts }); return true; } });
  const media = { currentTime: 12.5, onerror: null };
  const armed = h.exports.armLxRuntimeErrorFallback({
    media,
    token: h.sandbox.trackSwitchToken,
    idx: 3,
    song: { source: 'wy', name: 'x', singer: 'y' },
    opts: { manual: true },
    resolver: 'A',
    excluded: ['X'],
    attempted: [],
    proxyAudioUrl: '/api/audio?url=dead%2B1',
    retryDepth: 0,
    quality: 'flac',
  });
  assert.equal(armed, true);
  assert.equal(typeof media.onerror, 'function');
  media.onerror();
  assert.equal(played.length, 1);
  assert.equal(played[0].idx, 3);
  assert.deepEqual(played[0].opts.lxExcludeResolvers, ['X', 'a'], 'playing resolver 归一小写后并入排除集');
  assert.deepEqual(played[0].opts.lxAttemptedUrls, ['/api/audio?url=dead%2B1']);
  assert.equal(played[0].opts.lxRuntimeRetry, 1);
  assert.equal(played[0].opts.resumeAt, 12.5, '断点续播位置必须携带');
  assert.equal(media.onerror, null, '触发一次即摘钩，防同载体重复 fire');

  const h2 = makeHarness({});
  const capped = h2.exports.armLxRuntimeErrorFallback({
    media: { currentTime: 0, onerror: null },
    token: h2.sandbox.trackSwitchToken,
    idx: 0,
    resolver: 'A',
    excluded: [],
    attempted: [],
    proxyAudioUrl: 'p',
    retryDepth: 3,
    opts: {},
  });
  assert.equal(capped, false, 'retryDepth≥3 不再挂钩（封顶）');
  assert.equal(h2.state.playQueueAtCalls.length, 0);

  const played3 = [];
  const h3 = makeHarness({ playQueueAt: async (idx, opts) => { played3.push({ idx, opts }); return true; } });
  const staleMedia = { currentTime: 0, onerror: null };
  const armed3 = h3.exports.armLxRuntimeErrorFallback({
    media: staleMedia,
    token: 42,
    idx: 0,
    resolver: 'A',
    excluded: [],
    attempted: [],
    proxyAudioUrl: 'p',
    retryDepth: 0,
    opts: {},
  });
  assert.equal(armed3, true);
  h3.sandbox.trackSwitchToken = 43;
  staleMedia.onerror();
  assert.equal(played3.length, 0, 'token 已过期（用户切歌）时不得再重解析');
});

// ---------- T9 修复轮1：自动重试双触发收口（单链闸） ----------
// 手法：不复制逻辑——按花括号配平从 13 的真实文本里切出 playQueueAt 的
// `if (!playbackStarted) { … }` 整块，注入它当时的局部量后执行，
// 于是回归锁的是生产分支本体；运行时链则直接调真 armLxRuntimeErrorFallback。
function extractIfBlock(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('切片锚点缺失: ' + marker);
  const open = src.indexOf('{', start);
  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && n === '/') { blockComment = false; i++; } continue; }
    if (quote) { if (c === '\\') { i++; continue; } if (c === quote) quote = null; continue; }
    if (c === '/' && n === '/') { lineComment = true; i++; continue; }
    if (c === '/' && n === '*') { blockComment = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('切片花括号不配平: ' + marker);
}

const START_FAIL_PARAMS = [
  'claimLxPlaybackReentry', 'data', 'forcePlaybackControlsInteractive', 'idx', 'invalidateLxResolvedAudioCache', 'isQQPlayback',
  'lxAttemptedUrls', 'lxExcludedResolvers', 'opts', 'playbackMedia', 'playbackProvider',
  'playQueueAt', 'proxyAudioUrl', 'requestedQuality', 'retryNeteaseSourceMatchPlayback',
  'retryQQPlaybackWithCompatibleQuality', 'retryPlaybackOpts', 'settleExpiredSourceFallbackPlayback',
  'showSourceFallbackNotice', 'showToast', 'skipFailedQueueItem', 'song',
  'sourceFallbackRecoveryFailureOptions', 'sourceFallbackRecoveryFromOptions',
  'token', 'trackSwitchToken', 'tryAutoPlaybackFallback',
];

function makeStartFailureBranch(h, override) {
  const src = read(P_13);
  const playQueueAtSrc = src.slice(src.indexOf('async function playQueueAt'));
  const segment = extractIfBlock(playQueueAtSrc, 'if (!playbackStarted) {');
  assert.ok(segment.includes('data.lxSource'), '切片必须覆盖 T9 起播失败重进子分支（真实文本，不用副本）');
  const factory = new Function(
    START_FAIL_PARAMS,
    'return async function lxStartFailureBranch(){ var playbackStarted = false;\n' + segment +
    '\nreturn "__fellThrough__"; }',
  );
  const ctx = Object.assign({
    data: { url: 'https://dead.example/x.flac', lxSource: true, resolver: 'A', source: 'wy' },
    idx: 4,
    opts: {},
    playbackMedia: { currentTime: 0, onerror: null },
    playbackProvider: 'wy',
    isQQPlayback: false,
    proxyAudioUrl: '/api/audio?url=https%3A%2F%2Fdead.example%2Fx.flac',
    requestedQuality: 'flac',
    retryPlaybackOpts: {},
    song: { source: 'wy', id: '777', name: 'x', singer: 'y', _lxResolver: 'A' },
    token: 900,
    trackSwitchToken: 900,
    lxExcludedResolvers: [],
    lxAttemptedUrls: [],
    claimLxPlaybackReentry: h.exports.claimLxPlaybackReentry,
    invalidateLxResolvedAudioCache: h.exports.invalidateLxResolvedAudioCache,
    playQueueAt: h.sandbox.playQueueAt,
    showSourceFallbackNotice: h.sandbox.showSourceFallbackNotice,
    showToast: h.sandbox.showToast,
    forcePlaybackControlsInteractive: () => {},
    skipFailedQueueItem: async () => '__skipFailedQueueItem__',
    settleExpiredSourceFallbackPlayback: () => '__settle__',
    sourceFallbackRecoveryFromOptions: () => null,
    sourceFallbackRecoveryFailureOptions: (o) => o || {},
    tryAutoPlaybackFallback: async () => null,
    retryNeteaseSourceMatchPlayback: async () => null,
    retryQQPlaybackWithCompatibleQuality: async () => false,
  }, override || {});
  const branch = factory(...START_FAIL_PARAMS.map((k) => ctx[k]));
  return branch();
}

function armRuntime(h, token, media) {
  const PROXY = '/api/audio?url=https%3A%2F%2Fdead.example%2Fx.flac';
  h.sandbox.trackSwitchToken = token;
  const armed = h.exports.armLxRuntimeErrorFallback({
    media,
    token,
    idx: 4,
    song: { source: 'wy', id: '777', name: 'x', singer: 'y', _lxResolver: 'A' },
    opts: {},
    resolver: 'A',
    excluded: [],
    attempted: [],
    proxyAudioUrl: PROXY,
    retryDepth: 0,
    quality: 'flac',
  });
  assert.equal(armed, true);
  return armed;
}

test('T9修复R1：同一失败 URL 的两条 lx 自动重入链合计只重入一次（运行时 onerror ↔ 起播失败，防 3×3 并发链）', async () => {
  const h = makeHarness({});
  const dispatched = [];
  h.sandbox.playQueueAt = (idx, opts) => {
    dispatched.push({ idx, opts });
    // 叶子桩：不执行真 playQueueAt，因此不模拟其 trackSwitchToken++ ——
    // 不变量必须靠单链闸本身成立，不能指望 token 自增兜底
    // （真代码里 playQueueAt 头两道 return——13:1317 beginSourceFallbackPlaybackInvocation、
    //  13:1318 idx 越界——都在 13:1348 的 trackSwitchToken++ 之前，重入链可能在 bump token 前中止，
    //  此时过期钩仍会被迟到的 error 事件触发）。
    return Promise.resolve(true);
  };

  // 场景 A：运行时 onerror 先 fire 占坑并重入，随后同一 token 的 playAudio 返回 false。
  const tokenA = 900;
  const mediaA = { currentTime: 6.5, onerror: null };
  armRuntime(h, tokenA, mediaA);
  mediaA.onerror();
  assert.equal(dispatched.length, 1, '运行时链先重入一次');
  assert.equal(dispatched[0].opts.lxRuntimeRetry, 1);
  const outcomeA = await makeStartFailureBranch(h, {
    token: tokenA, trackSwitchToken: tokenA, playbackMedia: mediaA,
  });
  assert.equal(dispatched.length, 1, '同一 token 的起播失败链不得再发第二条 playQueueAt');
  assert.equal(mediaA.onerror, null, '起播失败分支必须先摘掉运行时钩');
  assert.equal(outcomeA, false, '运行时链在飞时起播失败分支直接收口，不得落到官方回退/跳过队列项链');

  // 场景 B：反序——起播失败链先重入，之后仍挂在共享载体上的过期钩被迟到 error 触发。
  const tokenB = 910;
  const mediaB = { currentTime: 0, onerror: null };
  armRuntime(h, tokenB, mediaB);
  const staleHandler = mediaB.onerror;
  const outcomeB = await makeStartFailureBranch(h, {
    token: tokenB, trackSwitchToken: tokenB, playbackMedia: mediaB,
  });
  assert.equal(dispatched.length, 2, '本 token 尚无人在飞时起播失败链自身要正常重入（不过度收口）');
  assert.equal(dispatched[1].opts.lxStartRetryDepth, 1);
  assert.equal(outcomeB, true);
  assert.equal(mediaB.onerror, null, '起播失败重入前必须摘掉运行时钩');
  staleHandler();
  assert.equal(dispatched.length, 2, '过期钩即便被迟到 fire，单链闸也必须拦下同 token 的第二条链');

  // 场景 C：闸门只拦同一 token，下一首（新 token）不受影响。
  assert.equal(h.exports.claimLxPlaybackReentry(950), true);
  assert.equal(h.exports.claimLxPlaybackReentry(950), false, '同 token 第二次占坑必须失败');
  assert.equal(h.exports.claimLxPlaybackReentry(951), true, '新 token（换曲/重入后的下一次载入）照常放行');
});

// ---------- 11-provider-fallback：新查询实现 ----------

test('T9：searchAlternatePlatformSong 新查询实现指 /api/lx-source/search 并按 isSameTitleArtist 匹配', async () => {
  const CAND = { source: 'tx', id: '5', songmid: 'MID5', name: '测试曲', singer: '歌手A', album: '', interval: '', pic: '' };
  const h = makeHarness({
    search: () => ({
      ok: true,
      songs: [
        { source: 'kg', id: '9', songmid: 'K9', name: '不相干', singer: 'z', album: '', interval: '', pic: '' },
        CAND,
      ],
      failures: [],
    }),
  });
  const song = { source: 'netease', id: '1', name: '测试曲', singer: '歌手A' };
  const found = await h.exports.searchAlternatePlatformSong(song, 'qq');
  assert.ok(found, '第二个候选同名同歌手必须命中');
  assert.equal(found.source, 'tx');
  assert.equal(found.songmid, 'MID5');
  assert.equal(h.state.searchCalls.length, 1);
  assert.match(h.state.searchCalls[0].url, /^\/api\/lx-source\/search\?/);
  assert.equal(h.state.searchCalls[0].query.sources, 'tx', 'requestedTarget qq 必须映射成 lx 词 tx');
  assert.equal(h.state.searchCalls[0].query.q, '测试曲 歌手A');
  assert.equal(h.state.unexpectedRoutes.length, 0, '不得再请求旧 /api/qq/search 等官方搜索路由');

  const none = await h.exports.searchAlternatePlatformSong({ source: 'netease', name: '', singer: '' }, 'qq');
  assert.equal(none, null, '空 query 不出网直接 null');
});

// ---------- 14-custom-source-integration 退役边 ----------

test('T9：CustomSourceIntegration 退役边——modulePaths/agent/搜索/回退/播放链全部脱钩，文件保留待 T14', () => {
  const loader = read('public/js/index-loader.js');
  assert.ok(!loader.includes('14-custom-source-integration.js'), 'index-loader modulePaths 必须先卸掉 14-custom-source-integration');
  for (const p of ['public/js/agent-adapter.js', P_13, P_11, 'public/js/modules/05-playback/07-search.js']) {
    assert.ok(!read(p).includes('CustomSourceIntegration'), p + ' 不应再引用 CustomSourceIntegration');
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'public/js/modules/05-playback/14-custom-source-integration.js')), '文件本体保留，T14 才删');

  // index.html 侧的入口断边：14 不再被 import → openCustomSourceModal 在生产页面里是未定义全局，
  // 标题栏那颗钮必须带守卫，否则 T9→T14 窗口内点击直接 ReferenceError（T14 删文件+删钮一并收）。
  const indexHtml = read('public/index.html');
  assert.match(
    indexHtml,
    /id="custom-source-btn"[^>]*onclick="window\.openCustomSourceModal && window\.openCustomSourceModal\(\)"/,
    '#custom-source-btn 的内联 onclick 必须是 window.openCustomSourceModal && 守卫式（与弹窗内其余 CustomSourceIntegration 入口同一守卫形态）',
  );
});

// ============================================================
// T10：客户端缓存 + 在途去重 + 下曲预取（上游 :31826-31857 / :32026-32043 / :32249 / :32374）
// ============================================================

const OK_RESOLVE = (proxy, resolver, quality) => () => ({
  ok: true, source: 'wy', url: 'https://cdn.example/' + resolver + '.flac',
  proxyUrl: proxy, resolver, quality: quality || 'flac', actual: { codec: 'flac' },
});

test('T10：缓存键构成——归一源名|songmid/id/hash/FileHash/copyrightId|曲名|歌手|LX音质词（上游 :31830-31840）', () => {
  const h = makeHarness({});
  const ex = h.exports;
  assert.equal(ex.lxResolvedAudioCacheKey({ source: 'netease', id: '1', name: 'a', singer: 'b' }, 'flac'), 'wy|1|a|b|flac');
  assert.equal(ex.lxResolvedAudioCacheKey({ source: 'kugou', hash: 'H9', name: 'a', singer: 'b' }, '320k'), 'kg|H9|a|b|320k', 'kg 冻结形状以 hash 作身份位');
  assert.equal(ex.lxResolvedAudioCacheKey({ source: 'mg', copyrightId: 'C9', name: 'a', singer: 'b' }, '128k'), 'mg|C9|a|b|128k', 'mg 冻结形状以 copyrightId 作身份位');
  assert.equal(ex.lxResolvedAudioCacheKey({ source: 'qq', songmid: 'M1', title: 't', artist: 's' }, 'hires'), 'tx|M1|t|s|hires', 'songmid 优先于 id；title/artist 回退同上游');
});

test('T10①：同曲并发两次 resolve 只发一次 fetch（在途共享同一 Promise，上游 :31961-31967/:32007-32012）', async () => {
  const PROXY = '/api/audio?url=https%3A%2F%2Fcdn.example%2Fa.flac';
  const h = makeHarness({ resolve: OK_RESOLVE(PROXY, 'R1', 'flac') });
  const song = { source: 'wy', id: '777', name: '并发曲', singer: '歌手A' };
  const results = await Promise.all([
    h.exports.resolveLxPlaybackSong(song, { quality: 'lossless', excludeResolvers: [] }),
    h.exports.resolveLxPlaybackSong(song, { quality: 'lossless', excludeResolvers: [] }),
  ]);
  assert.equal(h.state.resolveCalls.length, 1, '并发双 resolve 必须折叠成一次网络请求');
  assert.equal(results[0].proxyUrl, PROXY);
  assert.equal(results[1].proxyUrl, PROXY, '在途去重复用同一结果');
  assert.equal(results[1].fromCache, true);
  assert.equal(song._lxResolver, 'R1', '等待方也要回写 _lxResolver 记忆（上游 :31962-31966 读在途记录）');
  assert.equal(Object.keys(h.sandbox.lxResolveInflight).length, 0, 'settle 后在途表必须清空（finally 回收）');
});

test('T10②：90s 内二次播放命中 lxResolvedAudioCache 零网络；不同音质不同键照常出网', async () => {
  const PROXY = '/api/audio?url=https%3A%2F%2Fcdn.example%2Fa.flac';
  const h = makeHarness({ resolve: OK_RESOLVE(PROXY, 'R1', 'flac') });
  const song = { source: 'wy', id: '777', name: '缓存曲', singer: '歌手A' };
  const first = await h.exports.resolveLxPlaybackSong(song, { quality: 'lossless', excludeResolvers: [] });
  assert.equal(h.state.resolveCalls.length, 1);
  const second = await h.exports.resolveLxPlaybackSong(song, { quality: 'lossless', excludeResolvers: [] });
  assert.equal(h.state.resolveCalls.length, 1, '90s 内二次播放不得再出网');
  assert.equal(second.fromCache, true);
  assert.equal(second.proxyUrl, first.proxyUrl, '缓存的 proxyUrl 原样复用（裁决4 不透明字符串）');
  assert.equal(second.actual, 'flac');
  assert.equal(song._lxResolver, 'R1');
  const key = h.exports.lxResolvedAudioCacheKey(song, 'flac');
  const record = h.sandbox.lxResolvedAudioCache[key];
  assert.ok(record && record.expiresAt - Date.now() <= 90000 && record.expiresAt - Date.now() > 80000, 'TTL=90s（上游 LX_RESOLVED_AUDIO_CACHE_TTL_MS）');
  // 排除集命中缓存记录的 resolver 时缓存视为未命中（失败链重进不被缓存拖住）
  await h.exports.resolveLxPlaybackSong(song, { quality: 'lossless', excludeResolvers: ['R1'] });
  assert.equal(h.state.resolveCalls.length, 2, 'record.resolver 在排除集内必须绕过缓存');
  // 不同音质 → 不同键 → 出网
  await h.exports.resolveLxPlaybackSong(song, { quality: 'exhigh', excludeResolvers: [] });
  assert.equal(h.state.resolveCalls.length, 3);
});

test('T10③：invalidateLxResolvedAudioCache 按曲作废全部音质条目；音质切换路径挂钩（裁决5）', async () => {
  const PROXY = '/api/audio?url=https%3A%2F%2Fcdn.example%2Fa.flac';
  const h = makeHarness({ resolve: OK_RESOLVE(PROXY, 'R1', 'flac') });
  const song = { source: 'netease', id: '777', name: '音质切换曲', singer: '歌手A' };
  await h.exports.resolveLxPlaybackSong(song, { quality: 'lossless', excludeResolvers: [] });
  await h.exports.resolveLxPlaybackSong(song, { quality: 'exhigh', excludeResolvers: [] });
  assert.equal(Object.keys(h.sandbox.lxResolvedAudioCache).length, 2, 'flac + 320k 各占一条');
  h.sandbox.playQueue = [song];
  h.sandbox.currentIdx = 0;
  h.sandbox.audio = { src: 'https://play.example/cur', paused: false, ended: false, currentTime: 3.25 };
  h.exports.applyPlaybackQualityToCurrentTrack('exhigh', 'netease');
  // 注：00 里的裸 playQueueAt 引用解析到 13 的真实声明（同 try 块 Annex B 作用域链），
  // 缺 UI 全局会早退异步 reject（被 applyPlaybackQualityToCurrentTrack 的 .catch 吞掉），
  // 因此这里锁「可重载判定成立（走了切音质 toast）+ 缓存已作废」，不锁桩重入记录。
  assert.ok(h.state.toasts.some((t) => t.indexOf('正在切换音质') === 0), '音质切换必须走 canReload→重载路径');
  assert.equal(Object.keys(h.sandbox.lxResolvedAudioCache).length, 0, '音质切换必须调 invalidateLxResolvedAudioCache(song) 清掉该曲全部缓存（裁决5）');
  await h.exports.resolveLxPlaybackSong(song, { quality: 'exhigh', excludeResolvers: [] });
  assert.equal(h.state.resolveCalls.length, 3, '失效后下一次播放重新解析');
});

test('T10④：播放成功后注入时钟 +700ms 预取队列下一首——单发、禁跨平台、失败零提示仅 console.debug、切曲清定时器（裁决3/4）', async () => {
  const FAIL = () => ({ ok: false, code: 'LX_SOURCE_RESOLVE_ALL_FAILED', error: '预取目标解析失败' });
  const h = makeHarness({ resolve: FAIL });
  const next = { source: 'tx', songmid: 'M1', name: '下一首', singer: '歌手B' };
  h.sandbox.playQueue = [{ source: 'wy', id: '1', name: '当前', singer: 'a' }, next];
  h.sandbox.trackSwitchToken = 55;
  h.exports.scheduleLxAudioPrefetch(55, 0, 'lossless');
  assert.equal(h.state.resolveCalls.length, 0, '定时器未到期不得预取');
  // 行为钉桩 700ms：注入时钟不看 ms 一律触发，必须在触发前查槽位里的 ms 才能锁死延迟值。
  const pend = h.state.pendingTimers();
  assert.equal(pend.length, 1, '调度预取应登记恰一个延迟定时器');
  assert.equal(pend[0].ms, 700, '预取延迟必须为 700ms（简报明文；上游 :32043 同款），改 100ms 必须红');
  h.state.runTimers();
  assert.equal(h.state.resolveCalls.length, 1, '注入时钟推进 700ms 后对下一首发起预取解析');
  assert.equal(h.state.resolveCalls[0].body.source, 'tx');
  assert.equal(h.state.resolveCalls[0].body.quality, 'flac', '预取沿当前播放音质词入键');
  assert.equal(h.state.resolveCalls[0].body.maxResolvers, 3, '上游预取 maxResolvers:3 平价');
  // 失败终态在微任务里落地：冲刷后再断言零提示。
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.state.searchCalls.length, 0, '预取禁跨平台换源（allowCrossPlatformFallback:false）');
  assert.equal(h.state.notices.length, 0, '预取失败不得弹任何换源/终态卡片');
  assert.equal(h.state.toasts.length, 0, '预取失败不得 toast');
  assert.equal(h.state.playQueueAtCalls.length, 0, '预取失败不得触发重试链');
  assert.ok(h.state.debugs.some((d) => d.indexOf('[LXAudioPrefetch]') === 0), '失败仅 console.debug（上游 :32040）');
  // 定时器卫生：清除后到期不触发
  const OK = makeHarness({ resolve: OK_RESOLVE('/api/audio?url=https%3A%2F%2Fcdn.example%2Fb.mp3', 'R2', '320k') });
  OK.sandbox.playQueue = [{ source: 'tx', id: '1', name: '当前', singer: 'a' }, next];
  OK.sandbox.trackSwitchToken = 55;
  OK.exports.scheduleLxAudioPrefetch(55, 0, 'exhigh');
  OK.exports.clearLxAudioPrefetchTimer();
  OK.state.runTimers();
  assert.equal(OK.state.resolveCalls.length, 0, '切曲前必须能 clearTimeout（lxAudioPrefetchTimer 可撤销）');
  // token 过期（已换曲）不触发
  OK.sandbox.trackSwitchToken = 56;
  OK.exports.scheduleLxAudioPrefetch(55, 0, 'exhigh');
  OK.state.runTimers();
  assert.equal(OK.state.resolveCalls.length, 0, 'token 与 trackSwitchToken 不一致不得预取');
  // 单曲循环不预取
  const single = makeHarness({ resolve: OK_RESOLVE('/api/audio?url=https%3A%2F%2Fcdn.example%2Fc.mp3', 'R3', '320k') });
  single.sandbox.playQueue = [{ source: 'tx', id: '1', name: '当前', singer: 'a' }, next];
  single.sandbox.trackSwitchToken = 70;
  single.sandbox.playMode = 'single';
  single.exports.scheduleLxAudioPrefetch(70, 0, 'exhigh');
  single.state.runTimers();
  assert.equal(single.state.resolveCalls.length, 0, 'playMode=single 不预取（上游 :32030）');
  // 正常路径：命中下一首并写入缓存
  const fire = makeHarness({ resolve: OK_RESOLVE('/api/audio?url=https%3A%2F%2Fcdn.example%2Fd.mp3', 'R4', '320k') });
  fire.sandbox.playQueue = [{ source: 'tx', id: '1', name: '当前', singer: 'a' }, { source: 'wy', id: '9', name: '下一首', singer: 'b' }];
  fire.sandbox.trackSwitchToken = 80;
  fire.exports.scheduleLxAudioPrefetch(80, 0, 'exhigh');
  fire.state.runTimers();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fire.state.resolveCalls.length, 1);
  assert.equal(fire.state.resolveCalls[0].body.source, 'wy');
  assert.equal(Object.keys(fire.sandbox.lxResolvedAudioCache).length, 1, '预取成功也要写入缓存（这正是预取的意义）');
  // 队列只有一首歌时不预取
  const solo = makeHarness({ resolve: OK_RESOLVE('/api/audio?url=https%3A%2F%2Fcdn.example%2Fe.mp3', 'R5', '320k') });
  solo.sandbox.playQueue = [{ source: 'tx', id: '1', name: '唯一', singer: 'a' }];
  solo.sandbox.trackSwitchToken = 90;
  solo.exports.scheduleLxAudioPrefetch(90, 0, 'exhigh');
  solo.state.runTimers();
  assert.equal(solo.state.resolveCalls.length, 0);
});

test('T10⑤（裁决2）：运行时链+起播失败链合并进 opts.lxChainDepth 一份共享深度，单曲自动重入合计封顶 3', async () => {
  const h = makeHarness({});
  const dispatched = [];
  h.sandbox.playQueueAt = (idx, opts) => {
    dispatched.push(opts);
    h.sandbox.trackSwitchToken++; // 模拟真 playQueueAt 头部 token++，让下一环的 claim 闸放行
    return Promise.resolve(true);
  };
  h.sandbox.trackSwitchToken = 700;
  // 第 1 次重入：起播失败链（0→1）
  const media1 = { currentTime: 0, onerror: null };
  assert.equal(await makeStartFailureBranch(h, { token: 700, trackSwitchToken: 700, playbackMedia: media1, opts: {} }), true);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].lxChainDepth, 1, '起播失败链要递增共享深度');
  assert.equal(dispatched[0].lxStartRetryDepth, 1, '旧每链计数保留仅作诊断');
  // 第 2 次重入：运行时 onerror 链接棒（1→2）
  h.sandbox.trackSwitchToken = 701;
  const media2 = { currentTime: 8, onerror: null };
  assert.equal(h.exports.armLxRuntimeErrorFallback({
    media: media2, token: 701, idx: 4, song: { source: 'wy', id: '777', name: 'x', singer: 'y' },
    opts: {}, resolver: 'A', excluded: [], attempted: [], proxyAudioUrl: 'p', retryDepth: 0, chainDepth: 1, quality: 'flac',
  }), true, 'chainDepth=1 时运行时链照常挂钩');
  media2.onerror();
  assert.equal(dispatched.length, 2);
  assert.equal(dispatched[1].lxChainDepth, 2, '运行时链与起播失败链共用同一深度');
  assert.equal(dispatched[1].lxRuntimeRetry, 1, '旧每链计数保留仅作诊断');
  // 第 3 次重入（2→3）
  const media3 = { currentTime: 0, onerror: null };
  assert.equal(h.exports.armLxRuntimeErrorFallback({
    media: media3, token: 702, idx: 4, song: { source: 'wy', id: '777', name: 'x', singer: 'y' },
    opts: {}, resolver: 'A', excluded: [], attempted: [], proxyAudioUrl: 'p', retryDepth: 0, chainDepth: 2, quality: 'flac',
  }), true);
  media3.onerror();
  assert.equal(dispatched.length, 3);
  assert.equal(dispatched[2].lxChainDepth, 3);
  // 封顶后：两条链都收口
  const cappedMedia = { currentTime: 0, onerror: null };
  assert.equal(h.exports.armLxRuntimeErrorFallback({
    media: cappedMedia, token: 703, idx: 4, song: {}, opts: {}, resolver: 'A',
    excluded: [], attempted: [], proxyAudioUrl: 'p', retryDepth: 0, chainDepth: 3, quality: 'flac',
  }), false, '共享深度封顶 3：运行时链不再挂钩');
  assert.equal(await makeStartFailureBranch(h, {
    token: 703, trackSwitchToken: 703, playbackMedia: { currentTime: 0, onerror: null }, opts: { lxChainDepth: 3 },
  }), false, '共享深度封顶 3：起播失败链不再重入');
  assert.equal(dispatched.length, 3, '一首失败曲的两条自动重入链合计最多 3 次重入（不再是 3+3=6）');
});

test('T10⑥：接线锁定——切曲清预取定时器/播放成功调度预取/起播失败与解析失败失效缓存/gapless 预载绕缓存（上游 :32249/:32349/:32374）', () => {
  const src13 = read(P_13);
  const play = src13.slice(src13.indexOf('async function playQueueAt'));
  assert.ok(play.includes('clearLxAudioPrefetchTimer();'), 'playQueueAt 头部要清上一曲预取定时器（上游 :32249）');
  assert.ok(play.includes('scheduleLxAudioPrefetch(token, idx, requestedQuality)'), '播放成功后调度 700ms 下曲预取（上游 :32374）');
  assert.ok(play.includes('invalidateLxResolvedAudioCache(song);'), '起播失败链进入重解析前作废客户端缓存（上游 :32349）');
  assert.ok(play.includes('(Number(opts.lxChainDepth) || 0) < 3'), '起播失败链闸门改读共享深度（裁决2）');
  assert.ok(play.includes('chainDepth: Number(opts.lxChainDepth) || 0'), '运行时链闸门喂共享深度');
  const resolveRegion = src13.slice(src13.indexOf('async function resolveLxPlaybackSong'), src13.indexOf('function nextLxAudioPrefetchSong'));
  assert.ok(resolveRegion.includes('cachedLxResolvedAudio(song, lxQuality, excluded)'), 'resolve 入口先查客户端缓存（上游 :31956）');
  assert.ok(resolveRegion.includes('lxResolveInflight[songKey]'), '在途去重表接线（上游 :31961/:32007）');
  assert.ok(resolveRegion.includes('LX_RESOLVED_AUDIO_CACHE_TTL_MS'), '成功解析写入 90s TTL 缓存（上游 :31996-32000）');
  assert.ok((resolveRegion.match(/invalidateLxResolvedAudioCache\(song\)/g) || []).length >= 3, 'resolver 级失败/异常/死URL 都要作废缓存（上游 :32349 循环内语义）');
  assert.ok(src13.includes('allowCacheLayer: false'), 'gapless 预载显式绕缓存（T4 预裁：避免 90s 陈旧 URL 喂进混流交接）');
  assert.ok(src13.includes('options.allowCacheLayer !== false'), 'resolve 入口识别 allowCacheLayer 开关');
  assert.ok(read(P_00).includes('invalidateLxResolvedAudioCache'), '音质切换路径（00）挂钩客户端缓存失效（裁决5）');
});
