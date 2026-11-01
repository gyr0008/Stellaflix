'use strict';

/**
 * tests/podcast-removal.test.js — 播客（podcast）整条下线钉桩（批 T16c）
 *
 * 主人裁定：在线音乐对齐 LX 世界观后，播客不再由官方平台 cookie 供给，整套下线
 * （不是隐藏、不是加开关）。本文件是反证测试（写法沿 lx-source-align-fix1 /
 * lx-reroute-batch1 的「源码切片 + 断言某端点/某符号不再出现」范式）：
 *
 *  ① /api/podcast/{search,hot,detail,programs,my,my/items,dj-beatmap} 进程内起服
 *    （PORT=3992，禁用 3999——他程占用）全部落 404，形态沿用既有 /api/world/* 的
 *    { ok:false, error:'REMOVED' }，不借 LX_ROUTE_NOT_FOUND。
 *  ② server.js 播客实现体（mapPodcast 系列/fetchMyPodcastItems/dj_hot 等官方 dj 接口
 *    常量/require('./dj-analyzer')/handleDiscoverHome 的 podcasts 字段/收听上报的
 *    podcast 豁免行）与前端切片里的 /api/podcast 字面量、播客专用符号全部消失；
 *    07-search 播客分支（doPodcastSearch/loadPodcastHot/renderPodcastRadios 等）整簇退役。
 *  ③ 打包/分发白名单（package.json build.files、electron-builder.internal-beta.json、
 *    scripts/verify-pack-requirements.js）不再含 dj-analyzer.js，且文件本体退役；
 *    产物 bundle 内不再出现 /api/podcast 与播客专用符号。
 *    复核修正（brief 授权「删前自己复核」）：03-beat/02-podcast-dj-analysis.js 仍被
 *    03-local-beat-cache-modal（本地歌 DJ 离线锁拍）消费 analyzePodcastDjBeats/
 *    applyPodcastDjProfileFromMap，06-lyrics/03-podcast-playlist-loaders.js 自
 *    playlistQueueSource 起是歌单队列分页主体（qq/kugou/qishui/spotify/netease，
 *    quick-check 与 lx-reroute-batch2 钉桩在场）——两文件均非整文件专用，保留文件、
 *    只摘播客专用段，本测试同时钉住保留面不被误删。
 *  ④ scripts/quick-check.js：dj-analyzer 引用清零；doPodcastSearch/loadPodcastHot
 *    的搜索历史共享断言随真实删除反证化，不留假绿。
 *
 * 16a 边界钉桩（保留面）：08-account 模块与 public/index.html 账号弹窗区不许动；
 * 08-account 退出登录仍写 myPodcastCollections/myPodcastItems/homeDiscoverState.podcasts
 * 复位，故 00-core-stores 的这三处声明暂留（只留声明，不留任何读取/请求/渲染方），
 * 待账号侧收口后再摘。
 */

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

// ---------- ① 进程内起服：/api/podcast/* 全落 404 REMOVED ----------
const PORT = 3992;
process.env.PORT = String(PORT);
delete process.env.HOST;

const server = require('../server.js');
const BASE = 'http://127.0.0.1:' + PORT;

async function waitListening() {
  if (server.listening) return;
  await new Promise((resolve) => server.once('listening', resolve));
}

const PODCAST_ENDPOINTS = [
  '/api/podcast/search?keywords=test',
  '/api/podcast/hot',
  '/api/podcast/detail?id=1',
  '/api/podcast/programs?id=1',
  '/api/podcast/my',
  '/api/podcast/my/items?key=collect',
  '/api/podcast/dj-beatmap?url=https%3A%2F%2Fexample.com%2Fa.mp3&duration=10',
];

for (const endpoint of PODCAST_ENDPOINTS) {
  test('① ' + endpoint + ' 落 404 REMOVED（播客整条下线）', async () => {
    await waitListening();
    const res = await fetch(BASE + endpoint, { signal: AbortSignal.timeout(15000) });
    const body = await res.json().catch(() => null);
    assert.equal(res.status, 404, endpoint + ' 必须 404，实际 ' + res.status + ' 体=' + JSON.stringify(body));
    assert.ok(body && body.ok === false && body.error === 'REMOVED',
      endpoint + ' 必须沿用既有 { ok:false, error:\'REMOVED\' } 404 形态（/api/world/* 同款），实际=' + JSON.stringify(body));
    assert.ok(!('podcasts' in (body || {})) && !('programs' in (body || {})) && !('collections' in (body || {})),
      endpoint + ' 不得再返回播客数据字段');
  });
}

after(() => { server.close(); });

// ---------- ② server.js / 前端切片反证 ----------
test('② server.js：播客实现体与 dj-analyzer 依赖全部退役', () => {
  const src = read('server.js');
  // 路由实现字面量（'/api/podcast/<sub>'）不得幸存；唯一允许的是 REMOVED 收口的
  // '/api/podcast' + startsWith('/api/podcast/')。
  assert.doesNotMatch(src, /\/api\/podcast\/(search|hot|detail|programs|my|dj-beatmap)/);
  assert.match(src, /pn === '\/api\/podcast' \|\| pn\.startsWith\('\/api\/podcast\/'\)/,
    '必须保留显式 /api/podcast* REMOVED 收口（防「假 404 依赖兜底」）');
  assert.doesNotMatch(src, /require\('\.\/dj-analyzer'\)/);
  for (const dead of ['analyzePodcastDjStream', 'analyzePodcastDjIntro', 'mapPodcastRadio',
    'mapPodcastProgram', 'mapPodcastVoice', 'mapPodcastCollectionRadio', 'podcastCollectionMeta',
    'fetchMyPodcastItems', 'isLowSignalPodcastItem', 'lowSignalText', 'firstArrayFrom',
    "dj_hot", "dj_detail", "dj_program", "dj_sublist", "user_audio", "dj_paygift",
    "record_recent_voice", "sati_resource_sub_list"]) {
    assert.ok(!src.includes(dead), 'server.js 不得再残留 ' + dead);
  }
  // 收听上报的播客豁免行（只服务播客源）随批摘除，local/trial 豁免必须保留。
  assert.doesNotMatch(src, /song\.type !== 'podcast'|song\.source !== 'podcast'/);
  assert.match(src, /song\.type !== 'local'/);
  // discover home 载荷不再挂 podcasts 字段（handleDiscoverHome + /api/discover/home 500 兜底体）。
  assert.doesNotMatch(src, /podcasts:\s*\[\]/);
});

const MODULE_ROOT = 'public/js/modules';

function listModuleSources() {
  const out = [];
  for (const group of fs.readdirSync(path.join(ROOT, MODULE_ROOT))) {
    const dir = path.join(ROOT, MODULE_ROOT, group);
    if (!fs.statSync(dir).isDirectory()) { out.push(path.posix.join(MODULE_ROOT, group)); continue; }
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.js')) continue;
      if (/_1\.js$/.test(f)) continue;   // *_1.js＝历史快照副本（.gitignore `*_1.*`），加载器不引用
      out.push(path.posix.join(MODULE_ROOT, group, f));
    }
  }
  return out;
}

test('② 前端（除 08-account 16a 边界外）不再出现 /api/podcast 字面量', () => {
  const offenders = [];
  for (const rel of listModuleSources()) {
    if (rel.includes('/08-account/')) continue;
    if (read(rel).includes('/api/podcast')) offenders.push(rel);
  }
  for (const rel of ['public/index.html', 'public/js/agent-daily-recommendation.js',
    'public/js/agent-music-tools.js', 'public/js/agent-adapter.js', 'public/js/index-loader.js']) {
    if (read(rel).includes('/api/podcast')) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], '仍引用 /api/podcast 的文件: ' + offenders.join(', '));
});

test('② 07-search：播客 tab / 播客搜索分支整簇退役', () => {
  const src = read('public/js/modules/05-playback/07-search.js');
  assert.doesNotMatch(src, /podcast/i, '07-search.js 不得残留任何 podcast 字面量（含大小写）');
  for (const dead of ['doPodcastSearch', 'loadPodcastHot', 'renderPodcastRadios',
    'renderPodcastPrograms', 'podcastMetaText', 'programMetaText', 'searchThumbHtml',
    'openPodcastPrograms', 'playPodcastProgram', 'queuePodcastProgram']) {
    assert.ok(!src.includes(dead), '07-search 不得再残留 ' + dead);
  }
  // 历史共享迁移与综合搜索面必须完好（quick-check 同源反证）。
  assert.match(src, /function runSearchHistory\(q\)/);
  assert.match(src, /SEARCH_HISTORY_STORE_VERSION\s*=\s*3/);
});

test('② 播客专用符号从各消费模块摘除；电台（radio）主体与 DJ 锁拍保留面完好', () => {
  const shelf = read('public/js/modules/04-shelf/01-manager-core.js');
  assert.doesNotMatch(shelf, /podcast/i, '书架核心不得再承载播客卡');
  const content = read('public/js/modules/04-shelf/03-content-list-manager.js');
  assert.doesNotMatch(content, /podcast/i, '内容列表不得再有 podcast-radio 行形态');
  const cards = read('public/js/modules/04-shelf/05-card-interactions.js');
  assert.doesNotMatch(cards, /podcast/i);
  const panel = read('public/js/modules/06-lyrics/01-playlist-panel-shell.js');
  assert.doesNotMatch(panel, /podcast/i, '歌单面板壳不得再有播客 tab/pane/目录拉取');
  const detail = read('public/js/modules/06-lyrics/02-playlist-detail.js');
  assert.doesNotMatch(detail, /podcast/i, 'renderMyPodcastCollections 须整簇退役');
  const loaders = read('public/js/modules/06-lyrics/03-podcast-playlist-loaders.js');
  for (const dead of ['podcastListEl', 'renderMyPodcastRadioItems', 'openMyPodcastCollection', 'loadPodcastRadioIntoQueue']) {
    assert.ok(!loaders.includes(dead), '03-podcast-playlist-loaders 不得再残留 ' + dead);
  }
  // 保留面：歌单队列分页主体（非播客消费方，quick-check T 系列与 lx-reroute-batch2 钉桩在场）。
  assert.match(loaders, /function playlistQueueSource/);
  assert.match(loaders, /function loadPlaylistIntoQueueById/);

  const dj = read('public/js/modules/03-beat/02-podcast-dj-analysis.js');
  for (const dead of ['schedulePodcastDjAnalysis', 'analyzePodcastDjIntroBeats', 'smoothPodcastDjIntroHandoff', 'smoothPodcastDjMapHandoff']) {
    assert.ok(!dj.includes(dead), '02-podcast-dj-analysis 不得再残留播客专用 ' + dead);
  }
  // 保留面：本地歌 DJ 离线锁拍消费方（03-local-beat-cache-modal:351）——不得连坐误删。
  assert.match(dj, /async function analyzePodcastDjBeats/);
  assert.match(dj, /function applyPodcastDjProfileFromMap/);
  assert.match(dj, /function buildPodcastDjLowOnlyBeatMap/);

  const start = read('public/js/modules/05-playback/13-playback-start-audio.js');
  assert.doesNotMatch(start, /podcast/i, '起播链不得再有播客模式/播客 song-url 豁免/播客歌词兜底');
  assert.match(start, /function startTrackLyricFetch/, '非播客起播面完好');
  const radio = read('public/js/modules/05-playback/04a-radio-modes.js');
  assert.doesNotMatch(radio, /'podcast-radio'/, '电台判型不得再引用播客 radio 形态');
  assert.match(radio, /RADIO_NON_MUSIC_PATTERN/, '电台主体保留（播客词样仅存文本反噪过滤属预期）');

  const homeTiles = read('public/js/modules/05-playback/03-home-discover-weather.js');
  assert.doesNotMatch(homeTiles, /podcast/i, '首页磁贴不得再有播客 tile/tone/fallback 入口');
  const wallpaper = read('public/js/modules/05-playback/04-home-empty-wallpaper.js');
  assert.doesNotMatch(wallpaper, /podcast/i, 'openHomePodcast/openHomeThirdCard 须退役');
  const actions = read('public/js/modules/05-playback/05-home-actions.js');
  assert.doesNotMatch(actions, /podcast/i);
  const dash = read('public/js/modules/05-playback/03a-home-dashboard.js');
  assert.doesNotMatch(dash, /podcast/i, '平台推荐卡不得再拉 /api/podcast/hot');
});

test('② 键位/状态/歌词/封面等散点播客豁免随批摘除', () => {
  const files = [
    'public/js/modules/05-playback/01-cover-custom-map.js',
    'public/js/modules/05-playback/03c-local-online-match.js',
    'public/js/modules/05-playback/09-queue-snapshot-autoplay.js',
    'public/js/modules/05-playback/10-queue-actions.js',
    'public/js/modules/05-playback/11-provider-fallback.js',
    'public/js/modules/06-lyrics/00-lyrics-fetch-parse.js',
    'public/js/modules/06-lyrics/06-lyric-timing-offset.js',
    'public/js/modules/01-scene/02-beat-camera-runtime.js',
    'public/js/modules/03-beat/00-tempo-worker-cache-prefetch.js',
    'public/js/agent-daily-recommendation.js',
  ];
  for (const rel of files) {
    assert.doesNotMatch(read(rel), /'podcast'|"podcast"|'podcast-radio'|"podcast-radio"/, rel + ' 仍残留播客判型字面量');
  }
  const state = read('public/js/modules/00-state/03-beat-dj-state.js');
  assert.doesNotMatch(state, /function isPodcastSong/, 'isPodcastSong 谓词须退役');
  assert.doesNotMatch(state, /'podcast:'/, 'djSongKey 缓存键不再用 podcast 前缀');
  const prefs = read('public/js/modules/00-state/02-preferences-ui-modes.js');
  assert.doesNotMatch(prefs, /'podcasts'/, '面板 tab 归一不再认识播客页');
});

test('② fx 面板 shelfShowPodcasts 开关整套摘除（不是隐藏，是删掉）', () => {
  for (const rel of ['public/index.html',
    'public/js/modules/00-state/04-fx-defaults.js',
    'public/js/modules/02-visual/04-visual-settings-persistence.js',
    'public/js/modules/07-fx/00-preset-archive-data.js',
    'public/js/modules/07-fx/05-fx-panel-performance.js',
    'public/js/modules/07-fx/07-bindings-shelf-immersive.js',
    'public/js/modules/07-fx/09-console-workspace.js',
    'public/default-user-fx-archive.json']) {
    assert.doesNotMatch(read(rel), /shelfShowPodcasts/, rel + ' 仍残留 shelfShowPodcasts');
  }
  // 同组兄弟开关必须保留（防止连坐误删）：
  assert.match(read('public/js/modules/07-fx/07-bindings-shelf-immersive.js'), /shelfMergeCollections/);
});

test('② index.html：播客搜索 tab / 我的播客 tab / podcast-pane / 播客 fx 开关 DOM 退役', () => {
  const html = read('public/index.html');
  for (const dead of ['search-mode-podcast', 'tab-podcast', 'podcast-pane', 'podcast-list',
    'switchPlaylistTab(\'podcasts\')']) {
    assert.ok(!html.includes(dead), 'index.html 不得再残留 ' + dead);
  }
  assert.ok(html.includes('id="search-mode-local"'), '其余搜索 tab DOM 保留');
  assert.ok(html.includes('id="tab-pl"'), '歌单 tab DOM 保留');
});

// ---------- ③ 分发/打包/产物 bundle ----------
test('③ dj-analyzer.js 退役且不再出现在任何分发白名单', () => {
  assert.equal(exists('dj-analyzer.js'), false, 'dj-analyzer.js 必须整文件删除（唯一消费方是播客 DJ 路由）');
  const pkg = JSON.parse(read('package.json'));
  assert.ok(!pkg.build.files.some((f) => f.includes('dj-analyzer')), 'package.json build.files 不得再打包 dj-analyzer.js');
  assert.doesNotMatch(read('electron-builder.internal-beta.json'), /dj-analyzer/);
  assert.doesNotMatch(read('scripts/verify-pack-requirements.js'), /dj-analyzer/, 'verify-pack 不得再要求 dj-analyzer（假绿）');
  assert.doesNotMatch(read('scripts/quick-check.js'), /dj-analyzer/, 'quick-check 不得再引用 dj-analyzer（假绿）');
});

test('③ bundle 产物同步：不再含播客符号，保留面仍在段内', () => {
  const dir = path.join(ROOT, 'public', 'js', 'bundles');
  const bundles = fs.readdirSync(dir).filter((f) => f.endsWith('.bundle.js'));
  assert.ok(bundles.length >= 15, 'bundle 目录应含分段产物（现网 17 段）');
  for (const f of bundles) {
    const src = read(path.join('public', 'js', 'bundles', f));
    assert.ok(!src.includes('/api/podcast'), f + ' 不得再含 /api/podcast 字面量');
  }
  assert.doesNotMatch(read(path.join('public', 'js', 'bundles', '03-beat.bundle.js')), /schedulePodcastDjAnalysis|analyzePodcastDjIntroBeats/);
  assert.match(read(path.join('public', 'js', 'bundles', '03-beat.bundle.js')), /analyzePodcastDjBeats/, '本地 DJ 锁拍消费面须在 bundle 内');
  assert.doesNotMatch(read(path.join('public', 'js', 'bundles', '06-lyrics.bundle.js')), /loadPodcastRadioIntoQueue|openMyPodcastCollection|podcastListEl/);
  assert.match(read(path.join('public', 'js', 'bundles', '05-playback.bundle.js')) + read(path.join('public', 'js', 'bundles', '05-playback-2.bundle.js')), /function doSearch/,
    '搜索主体（含 07-search）仍随段分发');
});

// ---------- ④ quick-check 反证化 ----------
test('④ quick-check.js 的播客断言随真实删除反证，不留假绿', () => {
  const src = read('scripts/quick-check.js');
  assert.doesNotMatch(src, /doPodcastSearch/, 'quick-check 不得再断言 doPodcastSearch 存在');
  assert.doesNotMatch(src, /loadPodcastHot/, 'quick-check 不得再断言 loadPodcastHot 存在');
  assert.doesNotMatch(src, /searchMode === 'podcast'/, 'quick-check 不得再钉播客 tab 行为');
  assert.doesNotMatch(src, /Podcast tabs/, '历史共享断言措辞随播客 tab 退役更新');
  // 搜索历史共享契约本体仍在（非播客面保留）：
  assert.match(src, /function runSearchHistory\(q\)/);
});

// ---------- 16a 边界钉桩：16d 后连声明也清零 ----------
test('边界：00-core-stores 播客声明随 08-account 退役清零，全仓无读写方', () => {
  const core = read('public/js/modules/00-state/00-core-stores.js');
  assert.doesNotMatch(core, /myPodcastCollections|myPodcastItems/, '16d：播客旧声明（原为 08-account 复位而留）须整行退役');
  assert.doesNotMatch(core, /podcasts:\s*\[\]/, '16d：homeDiscoverState.podcasts 字段须整行退役');
  assert.doesNotMatch(core, /podcastResults|podcastPrograms|podcastCurrentRadio/, '07-search 播客态存储须整行退役');
  const readers = [];
  for (const rel of listModuleSources()) {
    if (/myPodcastCollections|myPodcastItems|podcastResults|podcastPrograms|podcastCurrentRadio/.test(read(rel))) readers.push(rel);
  }
  assert.deepEqual(readers, [], '仍有模块读写播客态变量: ' + readers.join(', '));
});
