'use strict';

/**
 * tests/lx-metadata-routes.test.js — 批 T15.5a：LX 元数据路由补移植
 * （daily-hot 日榜 / platform-charts 静态目录 / playlist-search 歌单搜索 / playlist-square 广场）
 *
 * 两层测试：
 *  ① 单元层：createLxSearch({ fetchImpl }) 桩回放 —— fixture 按上游解析路径的字段反推
 *     （上游 server.js:2145-2358 日榜种子、lx-search.js:263-352 五家 playlist 变体），零真实网络。
 *  ② 路由层：进程内 require('../server.js')（PORT 先于模块加载就位，取 3998 避开既有
 *     3999 / 398xx 段），globalThis.fetch 在 require 之前替换为 URL 前缀路由桩 ——
 *     与 tests/lx-source-routes.test.js 同款起服方式（run-all.js 逐文件串行、各文件独立进程）。
 *
 * 冷却/缓存（T6 providerHealth、searchCache）刻意不进本批新链路（brief YAGNI），
 * 因此本文件不注入 now 时钟，也不断言 cached/updatedAt 字段。
 */

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PORT = 3998;
process.env.PORT = String(PORT);
delete process.env.HOST;

// 裁决7：host 单例 userDataPath 取 env STELLAFLIX_USER_DATA —— 指向临时目录。
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-lx-meta-'));
process.env.STELLAFLIX_USER_DATA = USER_DATA;
process.env.APPDATA = path.join(USER_DATA, 'isolated-appdata');
process.env.LOCALAPPDATA = process.env.APPDATA;

const realFetch = globalThis.fetch;
const stubRoutes = new Map(); // url 前缀 -> (url, init) => response
globalThis.fetch = async (input, init) => {
  const url = String((input && input.url) || input);
  if (url.startsWith('http://127.0.0.1:' + PORT)) return realFetch(input, init);
  for (const [prefix, make] of stubRoutes) {
    if (url.startsWith(prefix)) return make(url, init);
  }
  // 命名避开可重试词（fetch/network/socket…），未路由即快速失败，测试不吞退避等待。
  throw new Error('LX_META_NO_ROUTE:' + url);
};

const lxSearchModule = require('../lx-search');
const server = require('../server.js');
const BASE = 'http://127.0.0.1:' + PORT;

after(() => {
  globalThis.fetch = realFetch;
  server.close();
  try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
});

async function waitListening() {
  if (server.listening) return;
  await new Promise(resolve => server.once('listening', resolve));
}

async function apiJson(pathname, options = {}) {
  await waitListening();
  const res = await realFetch(BASE + pathname, options);
  let body = null;
  try { body = await res.json(); } catch (_) {}
  return { status: res.status, body };
}

async function quiet(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try { return await fn(); } finally { console.warn = warn; }
}

// ---------- 单元层 fetch 桩 ----------

function reply(payload, status = 200) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => (typeof payload === 'string' ? JSON.parse(text) : payload),
    text: async () => text,
  };
}

function stubFetch(routes) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, options });
    for (const [key, handler] of routes) {
      if (!url.includes(key)) continue;
      if (typeof handler === 'function') return handler(url, options);
      return reply(handler);
    }
    throw new Error('LX_META_NO_ROUTE:' + url);
  };
  return { impl, calls };
}

const HOSTS = {
  tx: 'u.y.qq.com/cgi-bin/musicu.fcg',
  wy: 'music.163.com/api/playlist/detail',
  wyv6: 'music.163.com/api/v6/playlist/detail',
  kw: 'm.kuwo.cn/newh5app/ranklist_detail',
  kg: 'kugou.com/yy/rank/home',
  mg: 'app.c.nf.migu.cn/MIGUM3.0/v1.0/content/querycontentbyId.do',
  txPl: 'c.y.qq.com/soso/fcgi-bin/client_music_search_songlist',
  wyPl: 'music.163.com/api/cloudsearch/pc',
  kwPl: 'search.kuwo.cn/r.s',
  kgPl: 'specialsearch.kugou.com/special_search',
  mgPl: 'jadeite.migu.cn/music_search/v3/search/searchAll',
};

// ---------- 五家日榜 fixture（字段形态取自上游解析路径） ----------

const WY_HOT = { result: { tracks: [
  { id: 111, name: '半岛铁盒', artists: [{ name: '周杰伦' }],
    album: { id: 222, name: '八度空间', picUrl: 'https://p1.music.126.net/badu.jpg' }, duration: 315000 },
  { id: 112, name: '开不了口', ar: [{ name: '周杰伦' }],
    al: { name: '范特西', picUrl: 'https://p1.music.126.net/fantexi.jpg' }, dt: 300000 },
] } };

const TX_HOT_GETALL = { req_1: { data: { group: [
  { toplist: [{ topId: 62, period: ['2026_03_04'] }, { topId: 26, period: ['2026_03_05'] }] },
] } } };
const TX_HOT_DETAIL = { req_1: { data: { songInfoList: [
  { songid: 100200, mid: '004TesTx', songmid: '004TesTx', title: '夜曲', singer: [{ name: '周杰伦' }, { name: '费玉清' }],
    albummid: '08g20Z3F47tQQ0', albumname: '十一月的萧邦', interval: 214 },
] } } };

// 每行行尾再带一个字段：上游 rowPattern 的 artist_name 分支 `[^,]+` 会吞到下一个逗号，
// 真实 __NUXT__ 载荷行内字段更多，此处照此形态构造，避免相邻行被吞。
const KW_HOT_HTML = '<html><script>window.__NUXT__=(function(a,b,c,d,e){var r={};'
  + 'r[0]={id:900001,name:a,pic:b,album_name:c,artist_name:d,mv:0};'
  + 'r[1]={id:900002,name:e,pic:b,album_name:c,artist_name:d,mv:1};'
  + 'return {rank:r}}("蜗榜单曲","https://img1.kuwo.cn/star/albumcover/500/12/34/abcd.jpg","蜗专辑","蜗歌手","蜗榜单曲两"));'
  + '</script></html>';

const KG_HOT_HTML = '<html><script>var global={};global.features='
  + '[{"Hash":"HASH_KG_1","audio_id":700001,"author_name":"狗歌手","FileName":"狗歌手 - 狗榜单曲","timeLen":180,"album_id":42},'
  + '{"Hash":"HASH_KG_2","audio_id":700002,"author_name":"狗歌手","FileName":"狗歌手 - 狗榜单曲","timeLen":200,"album_id":43}];'
  + '</script></html>';

const MG_HOT = { code: '000000', columnInfo: { contents: [
  { objectInfo: { songId: 'MG_SONG_1', copyrightId: 'CR_MG_1', songName: '菇榜单曲', singer: '菇歌手',
    album: '菇专辑', albumId: 'MG_ALB_1', length: '240',
    albumImgs: [{ imgSizeType: '02', img: 'https://img.migu.cn/normal.jpg' }, { imgSizeType: '01', webpImg: 'https://img.migu.cn/big.webp' }],
    lrcUrl: 'https://a.migu.cn/1.lrc' } },
] } };

// 日榜五家路由表；extra 传 null 表示摘除该平台（未路由 → 快速失败）。
function hotRoutes(extra = {}) {
  const routes = {
    [HOSTS.wy]: WY_HOT, [HOSTS.wyv6]: WY_HOT,
    [HOSTS.kw]: KW_HOT_HTML, [HOSTS.kg]: KG_HOT_HTML, [HOSTS.mg]: MG_HOT,
    [HOSTS.tx]: (url, options) => (String(options.body || '').includes('GetAll') ? reply(TX_HOT_GETALL) : reply(TX_HOT_DETAIL)),
  };
  Object.assign(routes, extra);
  return Object.entries(routes).filter(([, handler]) => handler !== null);
}

// ---------- 五家歌单 fixture ----------

const TX_PL = { data: { list: [
  { dissid: 'D1', dissname: '秋日推歌单', creator: { name: ' 秋达人 ' }, introduction: '每日更新',
    imgurl: 'http://p.qpic.cn/cover_d1.jpg', song_count: 30, listennum: 12345 },
] } };
const WY_PL = { result: { playlists: [
  { id: 555, name: '芸小馆', creator: { nickname: '芸达人' }, description: '安静听歌',
    coverImgUrl: 'https://p1.music.126.net/pl_555.jpg', trackCount: 50, playCount: 999,
    bookCount: 12, officialTags: ['流行', '&amp;经典'] },
] } };
const KW_PL = { abslist: [
  { playlistid: 'PL_KW_1', name: '蜗歌单', nickname: '蜗达人', intro: '老歌',
    hts_pic: 'https://img1.kuwo.cn/star/albumcover/500/pl1.jpg', songnum: 20, playcnt: 5, tags: '华语;怀旧，经典' },
] };
const KG_PL = { data: { lists: [
  { specialid: 'SP1', specialname: '狗歌单', nickname: '狗达人', intro: '网络热歌',
    img: 'https://imgsearchs.kgimg.com/sp1.jpg', song_count: 44, total_play_count: 777,
    play_count: 1, collect_count: 9, tag_str: '热门,洗脑' },
] } };
const MG_PL = { songListResultData: { result: [
  { id: 'MG_PL_1', name: '菇歌单', userName: '菇达人', intro: '咪咕精选',
    musicListPicUrl: 'https://img.migu.cn/pl1.jpg', musicNum: 12, playNum: 34, keepNum: 5, ts: ['轻音乐'] },
] } };

const PLAYLIST_CARD_KEYS = ['id', 'input', 'source', 'sourceName', 'name', 'creator',
  'description', 'cover', 'trackCount', 'playCount', 'collectCount', 'tags', 'url'];

// ==================================================================
// ① 单元层：chartCatalog / searchPlaylists / fetchDailyHot
// ==================================================================

test('chartCatalog：已知平台返回榜单目录（id/name 行副本），未知平台返回 null', () => {
  const tx = lxSearchModule.chartCatalog('tx');
  assert.ok(Array.isArray(tx) && tx.length >= 8);
  assert.deepEqual(tx[0], { id: '26', name: '热歌榜' });
  assert.deepEqual(lxSearchModule.chartCatalog('WY').map(row => row.id),
    ['3778678', '19723756', '3779629', '2884035']);
  assert.deepEqual(lxSearchModule.chartCatalog('mg'), [{ id: '27186466', name: '尖叫热歌榜' }]);
  assert.equal(lxSearchModule.chartCatalog('spotify'), null);
  assert.equal(lxSearchModule.chartCatalog(''), null);
  // 副本语义：调用方改不动模块级目录
  const again = lxSearchModule.chartCatalog('kw');
  again[0].name = '被改写';
  assert.equal(lxSearchModule.chartCatalog('kw')[0].name, '热歌榜');
});

test('SOURCE_NAMES：五家展示名沿用本仓前端标签表（07-search.js LX_SEARCH_SOURCE_LABELS）', () => {
  assert.deepEqual(lxSearchModule.SOURCE_NAMES, { tx: '小秋', wy: '小芸', kw: '小蜗', kg: '小狗', mg: '小菇' });
});

test('searchPlaylists tx：client_music_search_songlist 行 → 13 键歌单卡（creator 去空白、http 封面升 https）', async () => {
  const { impl } = stubFetch([[HOSTS.txPl, TX_PL]]);
  const { searchPlaylists } = createImpl(impl);
  const result = await searchPlaylists({ query: '周杰伦', sources: 'tx', limit: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.query, '周杰伦');
  assert.equal(result.page, 1);
  assert.deepEqual(result.failures, []);
  assert.equal(result.playlists.length, 1);
  const card = result.playlists[0];
  assert.deepEqual(Object.keys(card), PLAYLIST_CARD_KEYS);
  assert.deepEqual(card, {
    id: 'D1', input: 'D1', source: 'tx', sourceName: '小秋', name: '秋日推歌单',
    creator: '秋达人', description: '每日更新', cover: 'https://p.qpic.cn/cover_d1.jpg',
    trackCount: 30, playCount: 12345, collectCount: 0, tags: [],
    url: 'https://y.qq.com/n/ryqq/playlist/D1',
  });
});

test('searchPlaylists wy：cloudsearch type=1000 分页偏移 + bookCount→collectCount + 标签 HTML 实体清洗', async () => {
  const { impl, calls } = stubFetch([[HOSTS.wyPl, WY_PL]]);
  const { searchPlaylists } = createImpl(impl);
  const { playlists } = await searchPlaylists({ query: '轻音乐', sources: 'wy', limit: 6, page: 2 });
  assert.deepEqual(playlists[0], {
    id: '555', input: '555', source: 'wy', sourceName: '小芸', name: '芸小馆',
    creator: '芸达人', description: '安静听歌', cover: 'https://p1.music.126.net/pl_555.jpg',
    trackCount: 50, playCount: 999, collectCount: 12, tags: ['流行', '&经典'],
    url: 'https://music.163.com/playlist?id=555',
  });
  const url = calls[0].url;
  assert.match(url, /type=1000/);
  assert.match(url, /offset=6/);
  assert.match(url, /limit=6/);
});

test('searchPlaylists kw：abslist（ft=playlist）行 + tags 按 ;;，切分 + 封面 hts_pic 优先', async () => {
  const { impl, calls } = stubFetch([[HOSTS.kwPl, KW_PL]]);
  const { searchPlaylists } = createImpl(impl);
  const { playlists } = await searchPlaylists({ query: '老歌', sources: 'kw', page: 3 });
  assert.match(calls[0].url, /ft=playlist/);
  assert.match(calls[0].url, /pn=2/); // page 从 1 起，上游偏移 page-1
  assert.deepEqual(playlists[0], {
    id: 'PL_KW_1', input: 'PL_KW_1', source: 'kw', sourceName: '小蜗', name: '蜗歌单',
    creator: '蜗达人', description: '老歌', cover: 'https://img1.kuwo.cn/star/albumcover/500/pl1.jpg',
    trackCount: 20, playCount: 5, collectCount: 0, tags: ['华语', '怀旧', '经典'],
    url: 'https://www.kuwo.cn/playlist_detail/PL_KW_1',
  });
});

test('searchPlaylists kg：special_search 行 + total_play_count 优先 play_count', async () => {
  const { impl } = stubFetch([[HOSTS.kgPl, KG_PL]]);
  const { searchPlaylists } = createImpl(impl);
  const { playlists } = await searchPlaylists({ query: '热歌', sources: 'kg' });
  assert.equal(playlists[0].playCount, 777);
  assert.equal(playlists[0].collectCount, 9);
  assert.deepEqual(playlists[0].tags, ['热门', '洗脑']);
  assert.equal(playlists[0].url, 'https://www.kugou.com/yy/special/single/SP1.html');
  assert.equal(playlists[0].sourceName, '小狗');
});

test('searchPlaylists mg：songListResultData.result 行 + songlist 开关 + 签名头透传', async () => {
  const { impl, calls } = stubFetch([[HOSTS.mgPl, MG_PL]]);
  const { searchPlaylists } = createImpl(impl);
  const { playlists } = await searchPlaylists({ query: '钢琴', sources: 'mg' });
  assert.deepEqual(playlists[0], {
    id: 'MG_PL_1', input: 'MG_PL_1', source: 'mg', sourceName: '小菇', name: '菇歌单',
    creator: '菇达人', description: '咪咕精选', cover: 'https://img.migu.cn/pl1.jpg',
    trackCount: 12, playCount: 34, collectCount: 5, tags: ['轻音乐'],
    url: 'https://music.migu.cn/v3/music/playlist/MG_PL_1',
  });
  const headers = calls[0].options.headers;
  assert.equal(headers.uiVersion, 'A_music_3.6.1');
  assert.equal(headers.channel, '0146921');
  assert.equal(typeof headers.sign, 'string');
  assert.match(calls[0].url, /songlist%22%3A1/); // searchSwitch 只开歌单位
});

test('searchPlaylists 聚合：逐源 failures 用本仓 {source,error} 形状（不带上游 name 别名），跨源同 id 去重', async () => {
  const { impl } = stubFetch([
    [HOSTS.txPl, TX_PL],
    [HOSTS.wyPl, WY_PL],
    [HOSTS.kgPl, () => reply({ data: { lists: [{ specialid: '555', specialname: '同号狗歌单' }] } })],
  ]);
  const { searchPlaylists } = createImpl(impl);
  const result = await searchPlaylists({ query: '周杰', sources: 'tx,wy,kg,kw,mg' });
  assert.equal(result.ok, true); // 部分失败仍 ok（上游 :432 语义）
  assert.deepEqual(result.failures.map(f => f.source).sort(), ['kw', 'mg']);
  assert.deepEqual(Object.keys(result.failures[0]), ['source', 'error']);
  assert.match(result.failures[0].error, /LX_META_NO_ROUTE/);
  // 去重键为 source|id：wy/555 与 kg/555 分属两源，均保留
  assert.deepEqual(result.playlists.map(item => `${item.source}/${item.id}`).sort(), ['kg/555', 'tx/D1', 'wy/555']);
});

test('searchPlaylists 空 q 早退 {ok:true,playlists:[],failures:[]}；limit 钳制 1..30', async () => {
  const { impl, calls } = stubFetch([[HOSTS.kwPl, KW_PL]]);
  const { searchPlaylists } = createImpl(impl);
  const empty = await searchPlaylists({ query: '   ', sources: 'kw' });
  assert.deepEqual(empty, { ok: true, playlists: [], failures: [] });
  assert.equal(calls.length, 0);
  await searchPlaylists({ query: 'x', sources: 'kw', limit: 999, page: 999 });
  assert.match(calls[0].url, /rn=30/); // clampLimit 上限
});

test('fetchDailyHot wy：playlist/detail 主端点 → 冻结 song 形状（8 键，album/pic 我方命名）', async () => {
  const { impl } = stubFetch(hotRoutes());
  const { fetchDailyHot } = createImpl(impl);
  const result = await fetchDailyHot({ source: 'wy', limit: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.chartMode, 'native');
  assert.equal(result.chartId, '3778678');
  assert.equal(result.chartSource, 'wy');
  assert.equal(result.chartName, '热歌榜');
  assert.equal(result.chartLabel, '小芸热歌榜 · 平台原榜 2 首');
  assert.deepEqual(result.songs, [
    { source: 'wy', id: 111, songmid: 111, name: '半岛铁盒', singer: '周杰伦', album: '八度空间', interval: '5:15', pic: 'https://p1.music.126.net/badu.jpg' },
    { source: 'wy', id: 112, songmid: 112, name: '开不了口', singer: '周杰伦', album: '范特西', interval: '5:00', pic: 'https://p1.music.126.net/fantexi.jpg' },
  ]);
  assert.equal(result.nativeError, undefined);
});

test('fetchDailyHot wy：主端点缺数据时回落 v6/playlist/detail（上游双端点语义）', async () => {
  const { impl, calls } = stubFetch([[HOSTS.wyv6, WY_HOT]]);
  const { fetchDailyHot } = createImpl(impl);
  const result = await fetchDailyHot({ source: 'wy', chart: '19723756', limit: 5 });
  assert.equal(result.songs.length, 2);
  assert.equal(result.chartId, '19723756');
  assert.equal(result.chartName, '飙升榜');
  assert.ok(calls.some(call => call.url.includes(HOSTS.wy)), '先打主端点');
  assert.ok(calls.some(call => call.url.includes(HOSTS.wyv6)), '再打 v6 端点');
});

test('fetchDailyHot tx：GetAll 定位 topId 的 period → GetDetail songInfoList', async () => {
  const { impl, calls } = stubFetch(hotRoutes());
  const { fetchDailyHot } = createImpl(impl);
  const result = await fetchDailyHot({ source: 'tx', limit: 5 });
  assert.equal(result.chartId, '26');
  assert.equal(result.chartLabel, '小秋热歌榜 · 平台原榜 1 首');
  assert.deepEqual(result.songs, [
    { source: 'tx', id: 100200, songmid: '004TesTx', name: '夜曲', singer: '周杰伦、费玉清',
      album: '十一月的萧邦', interval: '3:34', pic: 'https://y.gtimg.cn/music/photo_new/T002R500x500M00008g20Z3F47tQQ0.jpg' },
  ]);
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[1].options.body).req_1.param, { topid: 26, offset: 0, num: 30, period: ['2026_03_05'] });
  assert.equal(calls[0].options.headers.referer, 'https://y.qq.com/n/ryqq/toplist/26');
});

test('fetchDailyHot tx：catalog 无该 chartId 时取首个榜单（platformChartDefinition 回退）', async () => {
  const { impl } = stubFetch(hotRoutes());
  const { fetchDailyHot } = createImpl(impl);
  const result = await fetchDailyHot({ source: 'tx', chart: '4', limit: 5 });
  assert.equal(result.chartId, '4');
  assert.equal(result.chartName, '流行指数榜');
});

test('fetchDailyHot kw：__NUXT__ 行解析（去重同名行 + 专辑/歌手字段我方命名）', async () => {
  const { impl, calls } = stubFetch(hotRoutes());
  const { fetchDailyHot } = createImpl(impl);
  const result = await fetchDailyHot({ source: 'kw', chart: '17', limit: 5 });
  assert.match(calls[0].url, /ranklist_detail\/17/);
  assert.equal(result.chartName, '新歌榜');
  assert.equal(result.chartLabel, '小蜗新歌榜 · 平台原榜 2 首');
  assert.deepEqual(result.songs, [
    { source: 'kw', id: '900001', songmid: '900001', name: '蜗榜单曲', singer: '蜗歌手', album: '蜗专辑', interval: '', pic: 'https://img1.kuwo.cn/star/albumcover/500/12/34/abcd.jpg' },
    { source: 'kw', id: '900002', songmid: '900002', name: '蜗榜单曲两', singer: '蜗歌手', album: '蜗专辑', interval: '', pic: 'https://img1.kuwo.cn/star/albumcover/500/12/34/abcd.jpg' },
  ]);
});

test('fetchDailyHot kg：global.features 分页 + 去「歌手 - 」前缀 + hash 扩展键（T9 裁决1 同款）', async () => {
  const { impl, calls } = stubFetch(hotRoutes());
  const { fetchDailyHot } = createImpl(impl);
  const result = await fetchDailyHot({ source: 'kg', limit: 5 });
  assert.match(calls[0].url, /rank\/home\/1-8888\.html/);
  assert.equal(result.chartId, '8888');
  assert.equal(result.chartName, 'TOP 500');
  assert.deepEqual(result.songs, [
    { source: 'kg', id: 700001, songmid: 700001, hash: 'HASH_KG_1', name: '狗榜单曲', singer: '狗歌手', album: '', interval: '3:00', pic: '' },
    { source: 'kg', id: 700002, songmid: 700002, hash: 'HASH_KG_2', name: '狗榜单曲', singer: '狗歌手', album: '', interval: '3:20', pic: '' },
  ]);
});

test('fetchDailyHot mg：querycontentbyId 非 000000 视为失败，000000 时 albumImgs 01 优先 + copyrightId 扩展键', async () => {
  const { impl, calls } = stubFetch(hotRoutes());
  const { fetchDailyHot } = createImpl(impl);
  const result = await fetchDailyHot({ source: 'mg', limit: 5 });
  assert.match(calls[0].url, /columnId=27186466/);
  assert.equal(calls[0].options.headers.referer, 'https://music.migu.cn/');
  assert.deepEqual(result.songs, [
    { source: 'mg', id: 'MG_SONG_1', songmid: 'MG_SONG_1', copyrightId: 'CR_MG_1', name: '菇榜单曲',
      singer: '菇歌手', album: '菇专辑', interval: '4:00', pic: 'https://img.migu.cn/big.webp' },
  ]);
  const bad = createImpl(stubFetch([[HOSTS.mg, { code: '999999', info: '咪咕榜单不可用' }]]).impl).fetchDailyHot;
  const failed = await bad({ source: 'mg', limit: 5 });
  assert.equal(failed.ok, false);
  assert.equal(failed.chartMode, 'unavailable');
  assert.deepEqual(failed.songs, []);
  assert.match(failed.nativeError, /咪咕榜单不可用/);
});

test('fetchDailyHot 单平台全失败 → ok:false + chartMode unavailable + nativeError 透传，不抛异常', async () => {
  const { impl } = stubFetch(hotRoutes({ [HOSTS.kw]: null }));
  const { fetchDailyHot } = createImpl(impl);
  const result = await quiet(() => fetchDailyHot({ source: 'kw', limit: 5 }));
  assert.equal(result.ok, false);
  assert.equal(result.status, undefined);
  assert.equal(result.chartMode, 'unavailable');
  assert.equal(result.chartLabel, '小蜗热歌榜 · 暂不可用');
  assert.equal(result.chartId, '16');
  assert.deepEqual(result.songs, []);
  assert.match(result.nativeError, /LX_META_NO_ROUTE/);
});

test('fetchDailyHot 全平台：五榜交叉汇总 mixed-native，同名去重，单平台失败不影响整体', async () => {
  const { impl } = stubFetch(hotRoutes({ [HOSTS.mg]: null }));
  const { fetchDailyHot } = createImpl(impl);
  const result = await quiet(() => fetchDailyHot({ limit: 10 }));
  assert.equal(result.ok, true);
  assert.equal(result.chartSource, 'all');
  assert.equal(result.chartMode, 'mixed-native');
  assert.equal(result.chartLabel, '各平台真实榜单交叉汇总');
  assert.equal(result.chartId, '');
  assert.deepEqual(result.songs.map(song => song.source).slice(0, 4), ['tx', 'wy', 'kw', 'kg']);
  assert.equal(result.songs.filter(song => !song.name).length, 0);
});

test('fetchDailyHot limit：默认 100、上限 100，非正数按上游回落默认值', async () => {
  const { fetchDailyHot } = createImpl(stubFetch(hotRoutes()).impl);
  const one = await fetchDailyHot({ source: 'wy', limit: 1 });
  assert.equal(one.songs.length, 1);
  assert.equal(one.chartLabel, '小芸热歌榜 · 平台原榜 1 首');
  const huge = await fetchDailyHot({ source: 'wy', limit: 99999 });
  assert.equal(huge.songs.length, 2, '上限钳到 100，实际按平台返回数');
  const zero = await fetchDailyHot({ source: 'wy', limit: 0 });
  assert.equal(zero.songs.length, 2, 'limit 0 走上游 `Number(limit) || 100` 默认 100');
});

// ==================================================================
// ② 路由层：/api/lx-source/{daily-hot,platform-charts,playlist-search,playlist-square}
// ==================================================================

function createImpl(fetchImpl) {
  return lxSearchModule.createLxSearch({ fetchImpl });
}

const NEW_ROUTES = [
  '/api/lx-source/daily-hot',
  '/api/lx-source/platform-charts',
  '/api/lx-source/playlist-search?q=x',
  '/api/lx-source/playlist-square',
];

test('闸：四条元数据路由同样受 isTrustedLocalApiRequest 保护 → 403 FORBIDDEN_ORIGIN', async () => {
  for (const path of NEW_ROUTES) {
    const cross = await apiJson(path, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(cross.status, 403, path + ' cross-site');
    assert.equal(cross.body.code, 'FORBIDDEN_ORIGIN');
    const external = await apiJson(path, { headers: { Origin: 'https://evil.example.com' } });
    assert.equal(external.status, 403, path + ' external origin');
    assert.equal(external.body.code, 'FORBIDDEN_ORIGIN');
  }
});

test('GET /api/lx-source/daily-hot 200：{ok,songs,chartMode,chartLabel,chartId} + platform/chart 参数', async () => {
  stubRoutes.set('https://m.kuwo.cn/newh5app/ranklist_detail/', () => reply(KW_HOT_HTML));
  const { status, body } = await apiJson('/api/lx-source/daily-hot?platform=kw&chart=17&limit=3');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.chartMode, 'native');
  assert.equal(body.chartLabel, '小蜗新歌榜 · 平台原榜 2 首');
  assert.equal(body.chartId, '17');
  assert.equal(body.chartSource, 'kw');
  assert.equal(body.songs.length, 2);
  assert.deepEqual(Object.keys(body.songs[0]), ['source', 'id', 'songmid', 'name', 'singer', 'album', 'interval', 'pic']);
  stubRoutes.delete('https://m.kuwo.cn/newh5app/ranklist_detail/');
});

test('GET /api/lx-source/daily-hot 空榜 → 502 + ok:false + 机器码 DAILY_HOT_FAILED', async () => {
  const { status, body } = await quiet(() => apiJson('/api/lx-source/daily-hot?platform=kg&limit=2'));
  assert.equal(status, 502);
  assert.equal(body.ok, false);
  assert.deepEqual(body.songs, []);
  assert.equal(body.chartMode, 'unavailable');
  assert.equal(body.code, 'DAILY_HOT_FAILED');
  assert.match(body.error, /平台暂未返回可验证的真实榜单/);
});

test('GET /api/lx-source/platform-charts 200：静态目录；未知 platform → 400 UNSUPPORTED_CHART_SOURCE', async () => {
  const ok = await apiJson('/api/lx-source/platform-charts?platform=tx');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.platform, 'tx');
  assert.deepEqual(ok.body.charts[0], { id: '26', name: '热歌榜' });
  const legacy = await apiJson('/api/lx-source/platform-charts?source=kw');
  assert.equal(legacy.status, 200);
  assert.deepEqual(legacy.body.charts.map(row => row.name), ['热歌榜', '新歌榜', '飙升榜']);
  const bad = await apiJson('/api/lx-source/platform-charts?platform=qishui');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.ok, false);
  assert.deepEqual(bad.body.charts, []);
  assert.equal(bad.body.code, 'UNSUPPORTED_CHART_SOURCE');
});

test('GET /api/lx-source/playlist-search 200：{ok,playlists,failures,page,query}，sources/platform 两种参数名', async () => {
  stubRoutes.set('https://search.kuwo.cn/r.s', () => reply(KW_PL));
  const a = await apiJson('/api/lx-source/playlist-search?q=' + encodeURIComponent('蜗歌单') + '&sources=kw&limit=4&page=2');
  assert.equal(a.status, 200);
  assert.equal(a.body.ok, true);
  assert.equal(a.body.query, '蜗歌单');
  assert.equal(a.body.page, 2);
  assert.deepEqual(a.body.failures, []);
  assert.deepEqual(Object.keys(a.body.playlists[0]), PLAYLIST_CARD_KEYS);
  const b = await apiJson('/api/lx-source/playlist-search?q=' + encodeURIComponent('同名') + '&platform=kw');
  assert.equal(b.status, 200);
  assert.equal(b.body.playlists[0].id, 'PL_KW_1');
  stubRoutes.delete('https://search.kuwo.cn/r.s');
});

test('GET /api/lx-source/playlist-search 无 q → 200 空列表；全源失败 → 502 ok:false 带逐源 failures', async () => {
  const empty = await apiJson('/api/lx-source/playlist-search');
  assert.equal(empty.status, 200);
  assert.deepEqual({ ok: empty.body.ok, playlists: empty.body.playlists, failures: empty.body.failures },
    { ok: true, playlists: [], failures: [] });
  const fail = await quiet(() => apiJson('/api/lx-source/playlist-search?q=nope&sources=kw'));
  assert.equal(fail.status, 502);
  assert.equal(fail.body.ok, false);
  assert.deepEqual(fail.body.playlists, []);
  assert.equal(fail.body.failures[0].source, 'kw');
});

test('GET /api/lx-source/playlist-square 200：歌单卡列表 + category + browseMode:public-playlist-search', async () => {
  stubRoutes.set('https://search.kuwo.cn/r.s', () => reply(KW_PL));
  const { status, body } = await apiJson('/api/lx-source/playlist-square?platform=kw&limit=5&page=1');
  assert.equal(status, 200);
  assert.equal(body.browseMode, 'public-playlist-search');
  assert.equal(body.category, '流行', '缺省分类词照上游「流行」');
  assert.equal(body.query, '流行');
  assert.equal(body.playlists[0].source, 'kw');
  const named = await apiJson('/api/lx-source/playlist-square?platform=kw&category=' + encodeURIComponent('民谣'));
  assert.equal(named.body.category, '民谣');
  assert.equal(named.body.query, '民谣');
  stubRoutes.delete('https://search.kuwo.cn/r.s');
});

test('GET /api/lx-source/playlist-square 全源失败 → 502 ok:false + 逐源 failures（沿 T7 search 同款裸形状）', async () => {
  const { status, body } = await quiet(() => apiJson('/api/lx-source/playlist-square?platform=kw'));
  assert.equal(status, 502);
  assert.equal(body.ok, false);
  assert.deepEqual(body.playlists, []);
  assert.equal(body.browseMode, 'public-playlist-search');
  assert.equal(body.category, '流行');
  assert.equal(body.failures[0].source, 'kw');
  assert.match(body.failures[0].error, /LX_META_NO_ROUTE/);
});

test('元数据路由不碰平台官方模块：五家 API 文件零引用（裸 HTTP 免登录）', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'lx-search.js'), 'utf8');
  for (const forbidden of ['kugou-api', 'kuwo-api', 'netease-api', 'qq-api', 'migu-api', 'platform-account']) {
    assert.equal(text.includes(forbidden), false, 'lx-search.js 不得引用 ' + forbidden);
  }
  // 免登录裸爬：新链路不携带任何 Cookie 请求头（cookie 一词仅出现在注释自述里）
  assert.equal(/headers\s*:\s*\{[^}]*cookie/i.test(text), false);
  const serverText = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  for (const route of ['/api/lx-source/daily-hot', '/api/lx-source/platform-charts',
    '/api/lx-source/playlist-search', '/api/lx-source/playlist-square']) {
    assert.ok(serverText.includes(route), 'server.js 应含 ' + route);
  }
});

test('仍未移植的子路径继续落 404 LX_ROUTE_NOT_FOUND（song-cover-search 无消费方，本批不建）', async () => {
  const gone = await apiJson('/api/lx-source/song-cover-search?q=x');
  assert.equal(gone.status, 404);
  assert.equal(gone.body.code, 'LX_ROUTE_NOT_FOUND');
});
