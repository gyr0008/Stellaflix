'use strict';

/**
 * tests/daily-hot-api.test.js — 「各平台排行榜」服务端切片单测
 *
 * 移植来源：Mineradio-LX-Music-1.7.0 server.js:2047-2466
 *（逐字摘录见 .scratch/daily-hot-port-source.md §1.2-§1.9）。
 * 断言对象 = LX 原逻辑：6h 缓存窗口、综合榜每平台配额、`归一化歌名|歌手` 去重键、
 * 名次轮转交错合并、tx8/wy4/kw3/kg3/mg1 子榜目录、响应字段名与行字段。
 * 抓取一律走注入 stub，测试不触网；时钟走注入 now 驱动缓存窗口。
 * 运行：node --test tests/daily-hot-api.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const dailyHotModule = require('../daily-hot-api');
const { createDailyHotApi, PLATFORM_CHARTS, mixPlatformCharts } = dailyHotModule;

// ---------------------------------------------------------------- 夹具

const wyTrack = (i) => ({
  id: 1000 + i,
  name: 'WY' + (i + 1),
  duration: (i + 1) * 61 * 1000,
  artists: [{ name: '歌手' + (i + 1) }],
  album: { name: '专辑' + (i + 1), id: 9000 + i, picUrl: 'https://p.music.163.com/' + i + '.jpg' },
});
const wyPool = (n) => ({ result: { tracks: Array.from({ length: n }, (_unused, i) => wyTrack(i)) } });

function counter() {
  return { json: [], text: [] };
}

/** 只有网易能抓到歌，其余平台抛错（fetchSinglePlatformHotResult 兜住 → 空池） */
function wyOnlyFetcher(size, count = counter(), apiOptions = {}) {
  return {
    count,
    api: createDailyHotApi({
      ...apiOptions,
      fetchJson: async (url, options) => {
        count.json.push({ url, options });
        if (/music\.163\.com/.test(url)) return wyPool(size);
        throw new Error('UNEXPECTED_JSON ' + url);
      },
      fetchText: async (url) => {
        count.text.push(url);
        throw new Error('UNEXPECTED_TEXT ' + url);
      },
    }),
  };
}

// ---------------------------------------------------------------- 配额 / clamp

test('综合榜每平台配额 = 模块导出的 dailyHotPerPlatformLimit，且配额真正传达到抓取层', async () => {
  assert.equal(typeof dailyHotModule.dailyHotPerPlatformLimit, 'function');
  const per = dailyHotModule.dailyHotPerPlatformLimit;
  assert.equal(per(100), 35);
  assert.equal(per(1), 25);
  assert.equal(per(300), 60);

  // 行为侧：综合榜只有 wy 出歌时，混榜长度 = 每平台配额（limit=100→35，limit=60→27）
  const a = wyOnlyFetcher(80);
  const mixed100 = await a.api.getDailyHotSongs(100, 'all');
  assert.equal(mixed100.songs.length, 35);
  assert.equal(mixed100.chartMode, 'mixed-native');
  assert.equal(mixed100.chartLabel, '各平台真实榜单交叉汇总');
  assert.equal(mixed100.chartId, '', "all 分支 chart?.id 缺失 → chartId === ''");

  const b = wyOnlyFetcher(80);
  const mixed60 = await b.api.getDailyHotSongs(60, 'all');
  assert.equal(mixed60.songs.length, 27);
  assert.equal(mixed60.chartId, '');

  // 配额值原样出现在传给抓取器的参数里（QQ GetDetail 的 num = Math.max(30, 配额)）
  const txCount = counter();
  const txApi = createDailyHotApi({
    fetchJson: async (url, options) => {
      txCount.json.push({ url, options });
      if (/musicu\.fcg/.test(url)) {
        const body = JSON.parse(options.body);
        if (body.req_1.method === 'GetAll') {
          return { req_1: { data: { group: [{ toplist: [{ topId: 26, period: '2026-04-01' }] }] } } };
        }
        return { req_1: { data: { songInfoList: Array.from({ length: 60 }, (_u, i) => ({ songid: i, songmid: 'M' + i, songname: 'Q' + i, singer: [{ name: 's' + i }], interval: 60 })) } } };
      }
      if (/music\.163\.com/.test(url)) return wyPool(80);
      throw new Error('UNEXPECTED_JSON ' + url);
    },
    fetchText: async (url) => { throw new Error('UNEXPECTED_TEXT ' + url); },
  });
  const all = await txApi.getDailyHotSongs(100, 'all');
  const detail = txCount.json.filter((c) => /musicu\.fcg/.test(c.url)).map((c) => JSON.parse(c.options.body)).find((b2) => b2.req_1.method === 'GetDetail');
  assert.equal(detail.req_1.param.num, 35);
  assert.equal(all.chartMode, 'mixed-native');
});

test('limit clamp 到 1..100 通过抓取结果长度可观测', async () => {
  const a = wyOnlyFetcher(150);
  const upper = await a.api.getDailyHotSongs(300, 'wy');
  assert.equal(upper.songs.length, 100);
  const lower = await a.api.getDailyHotSongs(-5, 'wy');
  assert.equal(lower.songs.length, 1);
  const empty = await a.api.getDailyHotSongs(undefined, 'wy');
  assert.equal(empty.songs.length, 100); // Number(undefined)||100 → 100
  // 字符串入参（路由 query 全是字符串）：LX 的 Number(limit)||100 再 clamp 1..100
  assert.equal((await a.api.getDailyHotSongs('35', 'wy')).songs.length, 35, "'35' → 35");
  assert.equal((await a.api.getDailyHotSongs('', 'wy')).songs.length, 100, "'' → Number('')=0 → ||100");
  assert.equal((await a.api.getDailyHotSongs('abc', 'wy')).songs.length, 100, "'abc' → NaN → ||100");
  assert.equal((await a.api.getDailyHotSongs('0', 'wy')).songs.length, 100, "'0' → Number('0')=0 是假值 → ||100（LX 语义，非下限 1）");
  assert.equal((await a.api.getDailyHotSongs('150', 'wy')).songs.length, 100, "'150' → clamp 上限 100");
});

// ---------------------------------------------------------------- 混榜

test('mixPlatformCharts 按名次轮转交错合并、归一化歌名|歌手去重', () => {
  const api = createDailyHotApi({ fetchJson: async () => ({}), fetchText: async () => '' });
  assert.equal(api.mixPlatformCharts, mixPlatformCharts);
  const rows = (source, list) => ({ songs: list.map(([name, singer]) => ({ name, singer, source })) });
  const results = [
    rows('tx', [['A', 'x'], ['B', 'x']]),
    rows('wy', [['C', 'y'], ['A ', ' x'], ['T&amp;Z - 2', 'q']]),  // 第2条归一化后 = a|x
    rows('kw', [['D', 'z'], ['D2', 'z'], ['t&z  2', 'Q']]),        // 第3条与 wy 第3条同键
    rows('kg', [['E', 'w']]),
    rows('mg', [['F', 'v']]),
  ];
  const mixed = api.mixPlatformCharts(results, 100);
  // LX 原序（server.js:2413-2432）：先各平台第 0 名轮转，再第 1 名……不是逐平台顺序拼接
  assert.deepEqual(mixed.map((s) => s.name), ['A', 'C', 'D', 'E', 'F', 'B', 'D2', 'T&amp;Z - 2']);
  assert.equal(mixed[0].source, 'tx');
  assert.equal(mixed[mixed.length - 1].source, 'wy');
  assert.equal(mixed.some((s) => s.name === 't&z  2'), false, '归一化歌名|歌手去重');
  assert.equal(api.mixPlatformCharts(results, 3).map((s) => s.name).join(','), 'A,C,D');
});

test('source 白名单：非白名单落综合榜并抓五平台', async () => {
  const count = counter();
  const a = wyOnlyFetcher(10, count);
  const res = await a.api.getDailyHotSongs(10, 'qq');
  assert.equal(res.chartSource, 'all');
  assert.equal(res.chartMode, 'mixed-native');
  assert.equal(count.text.length, 2, 'kw/kg 各一次文本抓取');
});

// ---------------------------------------------------------------- 缓存三态

test('6h 缓存窗口：命中 / refresh=1 旁路 / 过期 / 不足 limit / 脏 chartMode 均按 LX 判定', async () => {
  assert.equal(dailyHotModule.DAILY_HOT_CACHE_MS, 6 * 60 * 60 * 1000);
  assert.equal(createDailyHotApi().DAILY_HOT_CACHE_MS, 6 * 60 * 60 * 1000);
  const HOUR = 60 * 60 * 1000;
  let clock = 1700000000000;
  const startedAt = clock;
  const fakeNow = () => clock;

  // (a) 窗口内命中
  const a = wyOnlyFetcher(30, counter(), { now: fakeNow });
  const first = await a.api.getDailyHotSongs(30, 'wy');
  assert.equal(first.cached, false);
  assert.equal(first.updatedAt, startedAt);
  const callsAfterFirst = a.count.json.length;
  clock = startedAt + HOUR;
  const second = await a.api.getDailyHotSongs(30, 'wy');
  assert.equal(second.cached, true);
  assert.equal(a.count.json.length, callsAfterFirst, '命中缓存不得再抓取');
  assert.equal(second.updatedAt, startedAt, '命中时 updatedAt 仍是原写入时刻');
  assert.equal(second.songs.length, 30);
  assert.equal(second.chartMode, 'native');

  // (b) refresh=1 旁路
  clock = startedAt + 2 * HOUR;
  const forced = await a.api.getDailyHotSongs(30, 'wy', true);
  assert.equal(forced.cached, false);
  assert.equal(forced.updatedAt, startedAt + 2 * HOUR);
  assert.equal(a.count.json.length, callsAfterFirst + 1, '旁路后重新抓取');

  // (b2) 窗口到期（>= 6h）→ 不命中
  clock = startedAt + 8 * HOUR;
  const expired = await a.api.getDailyHotSongs(30, 'wy');
  assert.equal(expired.cached, false);
  assert.equal(expired.updatedAt, startedAt + 8 * HOUR);
  assert.equal(a.count.json.length, callsAfterFirst + 2);

  // (c) 缓存条数不足请求 limit → 不命中
  const short = wyOnlyFetcher(10, counter(), { now: fakeNow });
  await short.api.getDailyHotSongs(10, 'wy');
  const shortCalls = short.count.json.length;
  const tooShort = await short.api.getDailyHotSongs(11, 'wy');
  assert.equal(tooShort.cached, false);
  assert.equal(short.count.json.length, shortCalls + 1, '不足 limit 必须重抓');

  // (c2) chartMode 含 fallback/expanded/supplemented 的历史脏缓存 → 不命中
  //      LX 自身抓取路径已不再产出 'fallback'，只能给导出的缓存对象喂旧数据来验这一支判定
  a.api.__dailyHotCache['wy|3778678'].chartMode = 'fallback';
  const dirty = await a.api.getDailyHotSongs(30, 'wy');
  assert.equal(dirty.cached, false);
  assert.equal(dirty.chartMode, 'native');

  // 缓存键 = source|chartId：切子榜不吃旧缓存
  const keyed = wyOnlyFetcher(30, counter(), { now: fakeNow });
  await keyed.api.getDailyHotSongs(30, 'wy', false, '3778678');
  const keyedCalls = keyed.count.json.length;
  await keyed.api.getDailyHotSongs(30, 'wy', false, '19723756');
  assert.equal(keyed.count.json.length, keyedCalls + 1, '不同子榜需重抓');
  assert.equal(Object.keys(keyed.api.__dailyHotCache).sort().join(','), 'wy|19723756,wy|3778678');
});

/**
 * 五平台全部可抓的夹具：每平台 40 首，够综合榜 limit=100 填满 100 首，
 * 从而让 all 分支也能命中 6h 缓存（配额 35×5=175 > 100）。
 */
function fivePlatformFetcher(count = counter(), apiOptions = {}) {
  const kwBody = Array.from({ length: 40 }, (_u, i) =>
    `r.list[${i}]={id:${5000 + i},name:"KW甲${i}",pic:"https://kuwo/${i}.jpg",album_name:"KW专${i}",artist_name:"KW歌${i}"}`).join(';');
  const kwHtml = `<html><script>window.__NUXT__=(function(a){var r={list:[]};${kwBody};return r;}("x"))</script></html>`;
  const kgFeatures = Array.from({ length: 40 }, (_u, i) =>
    `{"Hash":"KGH${i}","author_name":"KG歌${i}","FileName":"KG歌${i} - KG甲${i}","audio_id":${6000 + i},"album_id":"KGA","timeLen":61}`).join(',');
  const kgHtml = `<html><script>global.features = [${kgFeatures}];</script></html>`;
  const miguData = {
    code: '000000',
    columnInfo: {
      contents: Array.from({ length: 40 }, (_u, i) => ({
        objectInfo: {
          songId: 'MGS' + i, copyrightId: 'MGC' + i, songName: 'MG甲' + i, singer: 'MG歌' + i,
          albumImgs: [{ imgSizeType: '01', img: 'https://migu/' + i + '.jpg' }], length: '03:01',
        },
      })),
    },
  };
  return {
    count,
    api: createDailyHotApi({
      ...apiOptions,
      fetchJson: async (url, options) => {
        count.json.push({ url, options });
        if (/music\.163\.com/.test(url)) return wyPool(40);
        if (/musicu\.fcg/.test(url)) {
          const body = JSON.parse(options.body);
          if (body.req_1.method === 'GetAll') {
            return { req_1: { data: { group: [{ toplist: [{ topId: 26, period: '2026-04-01' }] }] } } };
          }
          return { req_1: { data: { songInfoList: Array.from({ length: 40 }, (_u, i) => ({ songid: i, songmid: 'TXM' + i, songname: 'TX甲' + i, singer: [{ name: 'TX歌' + i }], interval: 61 })) } } };
        }
        if (/migu\.cn/.test(url)) return miguData;
        throw new Error('UNEXPECTED_JSON ' + url);
      },
      fetchText: async (url, options) => {
        count.text.push({ url, options });
        if (/kuwo\.cn/.test(url)) return kwHtml;
        if (/kugou\.com/.test(url)) return kgHtml;
        throw new Error('UNEXPECTED_TEXT ' + url);
      },
    }),
  };
}

test('all 分支缓存命中：6h 内二次 getDailyHotSongs(100,\'all\') cached:true、不重抓、chartId 恒为空串', async () => {
  const HOUR = 60 * 60 * 1000;
  let clock = 1700000000000;
  const startedAt = clock;
  const a = fivePlatformFetcher(counter(), { now: () => clock });
  const first = await a.api.getDailyHotSongs(100, 'all');
  assert.equal(first.cached, false);
  assert.equal(first.ok, true);
  assert.equal(first.songs.length, 100, '五平台配额 35×5 足够填满 limit=100');
  assert.equal(first.chartMode, 'mixed-native');
  assert.equal(first.chartLabel, '各平台真实榜单交叉汇总');
  assert.equal(first.chartId, '', 'all 分支无子榜：chartId 恒为 \'\'');
  assert.equal(first.updatedAt, startedAt);

  const callsAfterFirst = a.count.json.length + a.count.text.length;
  assert.equal(callsAfterFirst, 6, '一轮综合榜 = tx 2 次 POST + wy 1 + mg 1 + kw 1 + kg 1');
  clock = startedAt + 5 * HOUR; // 仍在 6h 窗口内
  const second = await a.api.getDailyHotSongs(100, 'all');
  assert.equal(second.cached, true);
  assert.equal(second.songs.length, 100);
  assert.equal(second.updatedAt, startedAt, '命中时 updatedAt 仍是原写入时刻');
  assert.equal(second.chartMode, 'mixed-native');
  assert.equal(second.chartId, '', '缓存分支同样不含子榜 id');
  assert.equal(a.count.json.length + a.count.text.length, callsAfterFirst, 'all 命中缓存不得再抓取');
  assert.deepEqual(Object.keys(a.api.__dailyHotCache), ['all|default'], '综合榜缓存键 = all|default');

  // 过期后重抓（同一实例、同一键），证明上面的 cached:true 确实来自窗口内命中而非短路
  clock = startedAt + 7 * HOUR;
  const expired = await a.api.getDailyHotSongs(100, 'all');
  assert.equal(expired.cached, false);
  assert.equal(a.count.json.length + a.count.text.length, callsAfterFirst + 6, '过期后五平台各重抓一轮');
});

// ---------------------------------------------------------------- 响应契约

test('响应字段名零增删：新鲜分支含 error，缓存分支不含', async () => {
  let clock = 0;
  const api = createDailyHotApi({
    fetchJson: async () => wyPool(20),
    fetchText: async () => '',
    now: () => clock,
  });
  const fresh = await api.getDailyHotSongs(20, 'wy');
  assert.deepEqual(Object.keys(fresh), ['ok', 'songs', 'cached', 'updatedAt', 'chartSource', 'chartMode', 'chartLabel', 'chartId', 'error']);
  assert.equal(fresh.error, '');
  clock = 1000;
  const hit = await api.getDailyHotSongs(20, 'wy');
  assert.deepEqual(Object.keys(hit), ['ok', 'songs', 'cached', 'updatedAt', 'chartSource', 'chartMode', 'chartLabel', 'chartId']);
  assert.equal(hit.cached, true);

  const empty = await createDailyHotApi({ fetchJson: async () => ({}), fetchText: async () => '', now: () => 0 }).getDailyHotSongs(20, 'tx');
  assert.equal(empty.ok, false);
  assert.equal(empty.error, '平台暂未返回可验证的真实榜单');
});

// ---------------------------------------------------------------- 子榜目录

test('子榜目录 tx8/wy4/kw3/kg3/mg1 与 LX PLATFORM_CHART_CATALOG 逐字一致', () => {
  assert.equal(dailyHotModule.PLATFORM_CHART_CATALOG, PLATFORM_CHARTS);
  assert.deepEqual(Object.keys(PLATFORM_CHARTS), ['tx', 'wy', 'kw', 'kg', 'mg']);
  assert.deepEqual(PLATFORM_CHARTS.tx.map((c) => c.id), ['26', '62', '27', '4', '5', '3', '16', '17']);
  assert.deepEqual(PLATFORM_CHARTS.tx.map((c) => c.name), ['热歌榜', '飙升榜', '新歌榜', '流行指数榜', '内地榜', '欧美榜', '韩国榜', '日本榜']);
  assert.deepEqual(PLATFORM_CHARTS.wy, [
    { id: '3778678', name: '热歌榜' },
    { id: '19723756', name: '飙升榜' },
    { id: '3779629', name: '新歌榜' },
    { id: '2884035', name: '原创榜' },
  ]);
  assert.deepEqual(PLATFORM_CHARTS.kw, [
    { id: '16', name: '热歌榜' },
    { id: '17', name: '新歌榜' },
    { id: '93', name: '飙升榜' },
  ]);
  assert.deepEqual(PLATFORM_CHARTS.kg, [
    { id: '8888', name: 'TOP 500' },
    { id: '6666', name: '飙升榜' },
    { id: '31308', name: '新歌榜' },
  ]);
  assert.deepEqual(PLATFORM_CHARTS.mg, [{ id: '27186466', name: '尖叫热歌榜' }]);
});

// ---------------------------------------------------------------- 五平台抓取

test('wy：双端点回落 + 行字段与 types', async () => {
  const count = counter();
  const api = createDailyHotApi({
    fetchJson: async (url, options) => {
      count.json.push({ url, options });
      if (/api\/playlist\/detail/.test(url)) throw new Error('BOOM');
      return { playlist: { tracks: [wyTrack(0), wyTrack(1), { id: 3, artists: [], album: {} }] } };
    },
    fetchText: async (url) => { throw new Error('UNEXPECTED_TEXT ' + url); },
  });
  const res = await api.getDailyHotSongs(30, 'wy');
  assert.deepEqual(count.json.map((c) => c.url), [
    'https://music.163.com/api/playlist/detail?id=3778678',
    'https://music.163.com/api/v6/playlist/detail?id=3778678',
  ]);
  assert.equal(count.json[0].options.timeoutMs, 14000);
  assert.equal(res.ok, true);
  assert.equal(res.chartMode, 'native');
  assert.equal(res.chartLabel, '小芸热歌榜 · 平台原榜 2 首');
  assert.equal(res.chartId, '3778678');
  assert.equal(res.songs.length, 2, '无 name 的行被 filter');
  assert.deepEqual(Object.keys(res.songs[0]), ['id', 'songmid', 'name', 'singer', 'albumName', 'albumId', 'picUrl', 'interval', 'source', 'types']);
  assert.deepEqual(res.songs[0], {
    id: 1000,
    songmid: 1000,
    name: 'WY1',
    singer: '歌手1',
    albumName: '专辑1',
    albumId: 9000,
    picUrl: 'https://p.music.163.com/0.jpg',
    interval: '1:01',
    source: 'wy',
    types: ['flac', '320k', '128k'],
  });
});

test('tx：两段 POST + period 透传 + albumMid/strMediaMid 与封面串', async () => {
  const count = counter();
  const api = createDailyHotApi({
    fetchJson: async (url, options) => {
      count.json.push({ url, options });
      assert.equal(url, 'https://u.y.qq.com/cgi-bin/musicu.fcg');
      const body = JSON.parse(options.body);
      if (body.req_1.method === 'GetAll') {
        return { req_1: { data: { group: [{ toplist: [{ topId: 63, period: 'no' }, { topId: 26, period: '2026-04-01' }] }] } } };
      }
      return { req_1: { data: { songInfoList: [{ songid: 1, songmid: 'MID1', songname: 'QQ1', singer: [{ name: '歌手甲' }, { name: '乙' }], albummid: 'ALB1', strMediaMid: 'MEDIA1', interval: 125 }, { songid: 2, album: { mid: 'ALB2', name: '专辑二' }, file: { media_mid: 'M2' }, title: 'QQ2', singer: '裸串', interval: 61 }, { songid: 3, songname: '' }] } } };
    },
    fetchText: async (url) => { throw new Error('UNEXPECTED_TEXT ' + url); },
  });
  const res = await api.getDailyHotSongs(30, 'tx');
  assert.equal(count.json.length, 2);
  assert.equal(count.json[0].options.method, 'POST');
  assert.equal(count.json[0].options.timeoutMs, 14000);
  assert.equal(count.json[0].options.headers.referer, 'https://y.qq.com/n/ryqq/toplist/26');
  assert.equal(count.json[0].options.headers['content-type'], 'application/json');
  const first = JSON.parse(count.json[0].options.body);
  assert.deepEqual(first.comm, { ct: 24, cv: 0 });
  assert.deepEqual(first.req_1, { module: 'musicToplist.ToplistInfoServer', method: 'GetAll', param: {} });
  const second = JSON.parse(count.json[1].options.body);
  assert.deepEqual(second.req_1.param, { topid: 26, offset: 0, num: 30, period: '2026-04-01' });
  assert.equal(res.songs.length, 2);
  assert.deepEqual(res.songs[0], {
    id: 1,
    songmid: 'MID1',
    name: 'QQ1',
    singer: '歌手甲、乙',
    albumName: '',
    albumId: 'ALB1',
    albumMid: 'ALB1',
    strMediaMid: 'MEDIA1',
    picUrl: 'https://y.gtimg.cn/music/photo_new/T002R500x500M000ALB1.jpg',
    interval: '2:05',
    source: 'tx',
    types: ['flac', '320k', '128k'],
  });
  assert.equal(res.songs[1].albumMid, 'ALB2');
  assert.equal(res.songs[1].albumName, '专辑二');
  assert.equal(res.songs[1].singer, '裸串');
  assert.equal(res.songs[1].strMediaMid, 'M2');

  // 缺 period → 抛 QQ_HOT_CHART_PERIOD_MISSING，由 fetchSinglePlatformHotResult 兜成「暂不可用」
  const noPeriod = await createDailyHotApi({
    fetchJson: async () => ({ req_1: { data: { group: [{ toplist: [{ topId: 26 }] }] } } }),
    fetchText: async () => '',
  }).getDailyHotSongs(30, 'tx');
  assert.equal(noPeriod.ok, false);
  assert.equal(noPeriod.chartMode, 'unavailable');
  assert.equal(noPeriod.chartLabel, '小秋热歌榜 · 暂不可用');
});

const KW_HTML = '<html><script>window.__NUXT__=(function(a){var r={list:[]};'
  + 'r.list[0]={id:11,name:"酷我歌一",pic:"https://kuwo/1.jpg",album_name:"专辑一",artist_name:"歌手一"};'
  + 'r.list[1]={id:12,name:"酷我歌二",pic:"https://kuwo/2.jpg",album_name:"专辑二",artist_name:"歌手二"};'
  + 'return r;}("x"))</script></html>';

test('kw：NUXT 内联 JS 解析 + 行字段与 types', async () => {
  const count = counter();
  const api = createDailyHotApi({
    fetchJson: async (url) => { throw new Error('UNEXPECTED_JSON ' + url); },
    fetchText: async (url, options) => {
      count.text.push({ url, options });
      return KW_HTML;
    },
  });
  const res = await api.getDailyHotSongs(30, 'kw');
  assert.equal(count.text[0].url, 'https://m.kuwo.cn/newh5app/ranklist_detail/16');
  assert.equal(count.text[0].options.timeoutMs, 16000);
  assert.equal(count.text[0].options.headers.referer, 'https://m.kuwo.cn/newh5app/ranklist');
  assert.equal(res.chartLabel, '小蜗热歌榜 · 平台原榜 2 首');
  assert.deepEqual(res.songs[0], {
    id: '11',
    songmid: '11',
    name: '酷我歌一',
    singer: '歌手一',
    albumName: '专辑一',
    albumId: '',
    picUrl: 'https://kuwo/1.jpg',
    interval: '',
    source: 'kw',
    types: ['flac24bit', 'flac', '320k', '128k'],
  });

  // 换子榜 = URL 里的 chartId
  const c2 = counter();
  await createDailyHotApi({ fetchJson: async () => ({}), fetchText: async (url, o) => { c2.text.push({ url, o }); return KW_HTML; } })
    .getDailyHotSongs(30, 'kw', false, '93');
  assert.equal(c2.text[0].url, 'https://m.kuwo.cn/newh5app/ranklist_detail/93');
  // 原「再次 api.getDailyHotSongs(30,'kw') 后 chartLabel 含 平台原榜」的断言已删：同实例同缓存键，
  // 它只是把上文 res.songs / chartLabel 已经深比对过的字符串再读一遍，近乎空转。
  // 缓存命中类断言改由「all 分支缓存命中」用例承担（此前 all 分支从未被验证过命中）。
});

const KG_HTML = '<html><script>global.features = ['
  + '{"Hash":"H1","author_name":"歌手甲","FileName":"歌手甲 - 狗哥一","audio_id":101,"album_id":"A1","timeLen":181},'
  + '{"Hash":"H1","FileName":"重复的 hash","audio_id":101},'
  + '{"Hash":"H2","author_name":"歌手乙","FileName":"狗哥二","Audioid":102,"album_id":"A2","timeLen":60},'
  + '{"Hash":"H3","FileName":"无名 - 狗哥三 - 现场","audio_id":103,"timeLen":121}'
  + '];</script></html>';

test('kg：分页抓 HTML 内嵌 JSON + hash 去重 + 歌名/歌手拆分（无 picUrl/albumName）', async () => {
  const count = counter();
  const api = createDailyHotApi({
    fetchJson: async (url) => { throw new Error('UNEXPECTED_JSON ' + url); },
    fetchText: async (url, options) => {
      count.text.push({ url, options });
      return KG_HTML;
    },
  });
  const res = await api.getDailyHotSongs(30, 'kg');
  // limit=30 → ceil(30/22)=2 页
  assert.deepEqual(count.text.map((c) => c.url), [
    'https://www.kugou.com/yy/rank/home/1-8888.html',
    'https://www.kugou.com/yy/rank/home/2-8888.html',
  ]);
  assert.equal(count.text[0].options.timeoutMs, 16000);
  assert.equal(count.text[0].options.headers.referer, 'https://www.kugou.com/yy/html/rank.html');
  assert.equal(res.songs.length, 3, '同 hash 只留一条，第二页全部命中去重');
  assert.equal(res.chartLabel, '小狗TOP 500 · 平台原榜 3 首');
  assert.deepEqual(res.songs[0], {
    id: 101,
    songmid: 101,
    hash: 'H1',
    name: '狗哥一',
    singer: '歌手甲',
    albumId: 'A1',
    interval: '3:01',
    source: 'kg',
    types: ['flac24bit', 'flac', '320k', '128k'],
  });
  assert.equal('picUrl' in res.songs[0], false);
  assert.equal('albumName' in res.songs[0], false);
  assert.equal(res.songs[1].name, '狗哥二');
  assert.equal(res.songs[1].id, 102, 'audio_id 缺省走 Audioid');
  assert.equal(res.songs[2].name, '狗哥三 - 现场', '无 author_name 时按首个 " - " 之后取歌名');
  assert.equal(res.songs[2].singer, '');

  // 页面无 global.features → 跳过该页 → 空榜
  const none = await createDailyHotApi({ fetchJson: async () => ({}), fetchText: async () => '<html></html>' }).getDailyHotSongs(30, 'kg');
  assert.equal(none.ok, false);
  assert.equal(none.chartMode, 'unavailable');
});

test('mg：querycontentbyId + code 校验 + albumImgs 取 imgSizeType 01 + 词曲串', async () => {
  const count = counter();
  const data = {
    code: '000000',
    columnInfo: {
      contents: [
        {
          objectInfo: {
            songId: 'S1',
            copyrightId: 'CR1',
            songName: '咪咕一',
            singer: '歌手丙',
            album: '专辑丙',
            albumId: 'AM1',
            length: '04:00',
            albumImgs: [{ imgSizeType: '02', img: 'https://migu/big.jpg' }, { imgSizeType: '01', webpImg: 'https://migu/webp.webp' }],
            lrcUrl: 'l', mrcUrl: 'm', trcUrl: 't',
          },
        },
        { songId: 'S2', songName: '咪咕二', albumImgs: [{ img: 'https://migu/only.jpg' }] },
        { songId: 'S3', songName: '' },
      ],
    },
  };
  const api = createDailyHotApi({
    fetchJson: async (url, options) => {
      count.json.push({ url, options });
      return data;
    },
    fetchText: async (url) => { throw new Error('UNEXPECTED_TEXT ' + url); },
  });
  const res = await api.getDailyHotSongs(30, 'mg');
  assert.equal(count.json[0].url, 'https://app.c.nf.migu.cn/MIGUM3.0/v1.0/content/querycontentbyId.do?columnId=27186466&needAll=0');
  assert.equal(count.json[0].options.timeoutMs, 18000);
  assert.deepEqual(count.json[0].options.headers, { referer: 'https://music.migu.cn/' });
  assert.equal(res.chartLabel, '小菇尖叫热歌榜 · 平台原榜 2 首');
  assert.deepEqual(res.songs[0], {
    id: 'S1',
    songmid: 'S1',
    copyrightId: 'CR1',
    name: '咪咕一',
    singer: '歌手丙',
    albumName: '专辑丙',
    albumId: 'AM1',
    picUrl: 'https://migu/webp.webp',
    interval: '04:00',
    lrcUrl: 'l',
    mrcUrl: 'm',
    trcUrl: 't',
    source: 'mg',
    types: ['flac24bit', 'flac', '320k', '128k'],
  });
  assert.equal(res.songs[1].picUrl, 'https://migu/only.jpg', '无 01 尺寸时退回首图');

  const bad = await createDailyHotApi({ fetchJson: async () => ({ code: '999999', info: 'MIGU_DOWN' }), fetchText: async () => '' }).getDailyHotSongs(30, 'mg');
  assert.equal(bad.ok, false);
  assert.equal(bad.chartMode, 'unavailable');
  assert.equal(bad.chartLabel, '小菇尖叫热歌榜 · 暂不可用');
});

test('子榜切换与未知 chartId 回落首榜（platformChartDefinition）', async () => {
  const count = counter();
  const api = createDailyHotApi({
    fetchJson: async (url, options) => {
      count.json.push({ url, options });
      if (/musicu\.fcg/.test(url)) {
        const body = JSON.parse(options.body);
        if (body.req_1.method === 'GetAll') return { req_1: { data: { group: [{ toplist: [{ topId: 62, period: 'P62' }] }] } } };
        return { req_1: { data: { songInfoList: [{ songid: 1, songmid: 'M', songname: '飙升一', singer: [{ name: 's' }], interval: 61 }] } } };
      }
      return wyPool(5);
    },
    fetchText: async () => { throw new Error('no text'); },
  });
  const switched = await api.getDailyHotSongs(30, 'tx', false, '62');
  assert.equal(switched.chartId, '62');
  assert.equal(switched.chartLabel, '小秋飙升榜 · 平台原榜 1 首');
  assert.equal(JSON.parse(count.json[1].options.body).req_1.param.topid, 62);
  const fallback = await api.getDailyHotSongs(30, 'tx', false, '99999');
  assert.equal(fallback.chartId, '26', '未知子榜回落到该平台第一个');
});

// ---------------------------------------------------------------- 归一化 / 缺省抓取

test('normalizeDailyHotSong 分发三平台映射器，字段名保持 LX 原生', () => {
  assert.equal(typeof dailyHotModule.normalizeDailyHotSong, 'function');
  const api = createDailyHotApi();
  assert.equal(api.normalizeDailyHotSong, dailyHotModule.normalizeDailyHotSong);
  assert.deepEqual(api.normalizeDailyHotSong({ id: 9, name: 'N', ar: [{ singerName: '张三' }] }, 'wy').singer, '张三');
  assert.equal(api.normalizeDailyHotSong({ songname: 'N', albummid: 'A1' }, 'tx').picUrl, 'https://y.gtimg.cn/music/photo_new/T002R500x500M000A1.jpg');
  assert.equal(api.normalizeDailyHotSong({ songName: 'N', albumImgs: [{ imgSizeType: '01', img: 'u' }] }, 'mg').picUrl, 'u');
  const raw = { id: 1, name: 'K' };
  assert.equal(api.normalizeDailyHotSong(raw, 'kw'), raw, 'kw/kg 在抓取器内直接建行，无独立映射器');
  assert.equal(api.normalizeDailyHotSong(raw, 'kg'), raw);
  // source 先转小写再分发：大写平台码不再静默返回未映射的原始行
  const rawCase = { id: 9, name: 'N', ar: [{ singerName: '张三' }] };
  assert.deepEqual(api.normalizeDailyHotSong(rawCase, 'WY'), api.normalizeDailyHotSong(rawCase, 'wy'));
  assert.equal(api.normalizeDailyHotSong(rawCase, 'WY').singer, '张三');
  assert.equal(api.normalizeDailyHotSong(rawCase, 'WY').source, 'wy', "'WY' 走 wy 映射器而非原样返回");
  assert.equal(api.normalizeDailyHotSong({ songname: 'N', albummid: 'A1' }, 'TX').picUrl, 'https://y.gtimg.cn/music/photo_new/T002R500x500M000A1.jpg');
});

test('缺省抓取实现 = LX dailyHotFetchJson/Text（globalThis.fetch + 默认 UA/referer + AbortController）', async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    if (/musicu\.fcg|music\.163\.com/.test(url)) return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    return { ok: false, status: 500, json: async () => ({}), text: async () => '' };
  };
  try {
    // 缺省实现同时挂在模块面与工厂返回值上：Task 2 包一层即可复用 LX 的 UA/referer/redirect/超时
    assert.equal(typeof dailyHotModule.dailyHotFetchJsonDefault, 'function', '模块面导出缺省 JSON 抓取');
    assert.equal(typeof dailyHotModule.dailyHotFetchTextDefault, 'function', '模块面导出缺省 TEXT 抓取');
    const api = createDailyHotApi();
    assert.equal(api.dailyHotFetchJsonDefault, dailyHotModule.dailyHotFetchJsonDefault, '工厂面同一函数');
    assert.equal(api.dailyHotFetchTextDefault, dailyHotModule.dailyHotFetchTextDefault);
    await api.getDailyHotSongs(30, 'wy');
    const wyInit = seen[0].init;
    assert.equal(seen[0].url, 'https://music.163.com/api/playlist/detail?id=3778678');
    assert.equal(wyInit.method, 'GET');
    assert.equal(wyInit.redirect, 'follow');
    assert.equal(wyInit.body, undefined);
    assert.equal(typeof wyInit.signal?.aborted, 'boolean', 'AbortController 的 signal 透传给 fetch');
    assert.equal(wyInit.headers['user-agent'], 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    assert.equal(wyInit.headers.referer, 'https://music.163.com/');

    await api.getDailyHotSongs(30, 'kw');
    const kwInit = seen[seen.length - 1].init;
    assert.equal(seen[seen.length - 1].url, 'https://m.kuwo.cn/newh5app/ranklist_detail/16');
    assert.deepEqual(Object.keys(kwInit.headers).sort(), ['referer', 'user-agent']);
    assert.equal(kwInit.headers.referer, 'https://m.kuwo.cn/newh5app/ranklist', '调用方 header 覆盖缺省 referer');
    assert.equal(kwInit.redirect, 'follow');

    // 非 2xx → HTTP_<status>，被 fetchSinglePlatformHotResult 兜成不可用
    const down = await api.getDailyHotSongs(30, 'kg');
    assert.equal(down.ok, false);
    assert.equal(down.chartMode, 'unavailable');

    // Task 2 推荐路径：注入的实现「包装」导出的缺省实现，缺省头/redirect/signal 随之复用
    const beforeWrap = seen.length;
    const wrapped = createDailyHotApi({
      fetchJson: (url, options) => dailyHotModule.dailyHotFetchJsonDefault(url, {
        ...options,
        headers: { ...options.headers, 'x-task2': 'real-fetcher' },
      }),
      fetchText: async () => { throw new Error('UNEXPECTED_TEXT'); },
    });
    await wrapped.getDailyHotSongs(30, 'wy');
    const wrapInit = seen[beforeWrap].init;
    assert.equal(seen[beforeWrap].url, 'https://music.163.com/api/playlist/detail?id=3778678');
    assert.equal(wrapInit.headers['x-task2'], 'real-fetcher', '调用方追加的头保留');
    assert.equal(wrapInit.headers['user-agent'], 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', '包装后仍走 LX 缺省 UA');
    assert.equal(wrapInit.headers.referer, 'https://music.163.com/', '包装后仍走 LX 缺省 referer');
    assert.equal(wrapInit.redirect, 'follow');
    assert.equal(typeof wrapInit.signal?.aborted, 'boolean', '包装后仍带 AbortController signal');
    assert.equal(wrapInit.body, undefined);

    // 直接调用导出的缺省实现（不注入）：options 缺省时也按 LX 形状出参
    const bare = seen.length;
    await assert.rejects(() => dailyHotModule.dailyHotFetchJsonDefault('https://example.com/none', {}), /^Error: HTTP_500$/);
    assert.equal(seen[bare].init.method, 'GET');
    assert.equal(seen[bare].init.redirect, 'follow');
    assert.deepEqual(Object.keys(seen[bare].init.headers).sort(), ['referer', 'user-agent']);
    assert.equal(await dailyHotModule.dailyHotFetchTextDefault('https://music.163.com/api/x', { headers: { referer: 'r' } }), '');
    assert.deepEqual(Object.keys(seen[seen.length - 1].init.headers).sort(), ['referer', 'user-agent']);
  } finally {
    globalThis.fetch = original;
  }
});
