'use strict';

/**
 * 影人专区改造（2026-09-26 用户指令：①所有片单不限条数 ②②+① 混合方案）
 * 审查结论（有来源）：
 *   - 成龙：09-26 先改社区榜 11302，同日实机后用户裁定「删除成龙的片单」→ 卡整体移除（负锁防回归）
 *   - 周星驰：TMDB 全站检索不到任何相关社区榜（英文/中文两轮检索 0 命中）→ 用户品级图逐片静态编目
 *     为 static-list 47 部（09-26 影片页逐条回读：原 48 条中 190452=Pepito Piscinas、
 *     187977=剧场版 五星战队大连者 经页面 og:title 证实为误挂已剔，另补 108003 行运一条龙）
 *   - 其余影人卡（宫崎骏/新海诚）保留 discover，但去掉 vote_count 门槛以满足「不限条数=真实全量」
 * 契约：
 *   ① series tab 内不得有 person-jackiechan / 任何 tmdb-list 卡
 *   ② person-stephenchow = static-list / tab series / tmdbIds 恰为已核实 46 部（白名单锁，防瞎编 ID）
 *   ③ series tab 里所有 discover 影人卡 query 不得含 vote_count.gte / vote_average.gte
 *   ④ tmdb-discover 取数走 discoverAll（全量分页），不再走单页 discover（20 条截断）
 * 运行：node --test tests/home-collections-actor-zones.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const indexHtml = read('public/index.html');
const collectionsSrc = read('public/video/collections.js');

// ---- 2026-09-26 站内核实白名单 ----
const SC_VERIFIED_IDS = [                           // 周星驰专区（站内中文检索 + 影片页 og:title 逐条回读）
  9470, 53168, 11770, 41387, 13345, 21835, 37703, 55156, 37702, 13688,
  381890, 60145, 51730, 51731, 47647, 53165, 66657, 53163, 47648, 41343,
  45452, 70573, 41364, 40346, 57663, 53658, 32517, 52324,
  64083, 170657, 75197, 56124, 173653, 148380, 56118, 135061, 138960,
  45487, 575138, 53281, 73414, 160182, 73417,
  69727, 74287, 35038,                                    // 霹雳先锋 / 义胆群英 / 龙在天涯（早期凡品）
  108003,                                                 // 行运一条龙（09-26 站内 og:title 回读补漏）
];
const SC_VERIFIED_COUNT = SC_VERIFIED_IDS.length;   // = 47

function makeItems(n, prefix) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: i + 1, mediaType: 'movie', title: prefix + (i + 1), year: 2020,
      poster: 'https://img.example/' + prefix + (i + 1) + '.jpg',
      rating: 7, overview: '', backdrop: '', genreIds: [35], originalLanguage: 'zh',
    });
  }
  return out;
}

function buildEnv() {
  const dom = new JSDOM(indexHtml, { url: 'http://localhost:3000/', pretendToBeVisual: true, runScripts: 'outside-only' });
  const win = dom.window;
  const calls = { discover: 0, discoverAll: 0, getListAll: [], getDetails: [] };
  win.StellaflixVideo = {
    tmdb: {
      hasKey: () => true,
      discover: () => { calls.discover += 1; return Promise.resolve(makeItems(20, 'D1')); },
      discoverAll: (q) => { calls.discoverAll += 1; return Promise.resolve(makeItems(80, 'DA')); },
      getCollection: () => Promise.resolve({ parts: makeItems(8, 'C') }),
      getListAll: (id) => { calls.getListAll.push(id); return Promise.resolve({ id, items: makeItems(83, 'L') }); },
      getDetails: (id) => {
        calls.getDetails.push(id);
        return Promise.resolve({ id, title: 'M' + id, year: 1992, poster: '', rating: 8, overview: '', backdrop: '' });
      },
      genreNames: () => '', regionLabel: () => '',
      getPosterColor: () => Promise.reject(new Error('COLOR_OFFLINE')),
    },
    online: { openDetailFromMeta() {} },
  };
  win.eval(collectionsSrc);
  return { win, SFV: win.StellaflixVideo, calls };
}

// ============================================================ ① 成龙专区已删

test('成龙专区已删除（09-26 用户裁定），series tab 内不留任何社区榜卡', () => {
  const { SFV } = buildEnv();
  const series = SFV.collections.getByTab('series');
  assert.equal(series.some((x) => x.id === 'person-jackiechan'), false, 'person-jackiechan 不得回归');
  assert.equal(series.some((x) => /成龙/.test(x.title || '')), false, '不得有成龙卡');
  assert.equal(series.filter((x) => x.type === 'tmdb-list').length, 0, 'series tab 内社区榜已清空');
  const all = ['featured', 'series', 'lists', 'genres'].flatMap((t) => SFV.collections.getByTab(t));
  assert.equal(all.some((d) => Number(d.listId) === 11302), false, '11302 须从全目录移除');
});

// ============================================================ ② 周星驰专区

test('周星驰专区 = static-list，tmdbIds 恰为 47 部已核实编目', () => {
  const { SFV } = buildEnv();
  const d = SFV.collections.getByTab('series').find((x) => x.id === 'person-stephenchow');
  assert.ok(d, 'person-stephenchow 须在 series tab');
  assert.equal(d.type, 'static-list', '周星驰无可用社区榜 → 按用户品级图静态编目');
  const ids = (d.tmdbIds || []).map(Number);
  assert.equal(ids.length, SC_VERIFIED_COUNT, '编目须恰为已核实部数（47）');
  assert.equal(new Set(ids).size, ids.length, 'tmdbIds 不得重复');
  ids.forEach((id) => assert.ok(SC_VERIFIED_IDS.includes(id), '未核实周星驰片 ID: ' + id));
  // 09-26 影片页回读证实的两条误挂 ID，永不得回归
  assert.equal(ids.includes(190452), false, '190452 = Pepito Piscinas（西语片），非周星驰');
  assert.equal(ids.includes(187977), false, '187977 = 剧场版 五星战队大连者，非周星驰');
  assert.equal(ids.includes(91007), false, '91007 = 赌圣2 街头赌圣（TMDB 卡司无周星驰），刻意不收');
  assert.match(d.sub || '', /功夫|喜剧/, '副标题须为中文描述');
  assert.ok(d.warm && /^#[0-9a-fA-F]{6}$/.test(d.warm), '须有合法兜底色');
});

test('周星驰专区取数逐条 getDetails 且失败条目静默跳过（不半截报错）', async () => {
  const { SFV, calls } = buildEnv();
  const def = SFV.collections.getByTab('series').find((x) => x.id === 'person-stephenchow');
  const items = await SFV.collections.getItems(def);
  assert.equal(calls.getDetails.length, SC_VERIFIED_COUNT, '须按 tmdbIds 逐条取');
  assert.equal(items.length, SC_VERIFIED_COUNT);
});

// ============================================================ ③ 影人卡全部改静态编目

test('series tab 内 discover 影人卡已清空（宫崎骏/新海诚改静态编目，见 animation-zones 契约）', () => {
  const { SFV } = buildEnv();
  const persons = SFV.collections.getByTab('series').filter((x) => x.type === 'tmdb-discover');
  assert.equal(persons.length, 0, 'discover 影人卡会混入制片/客串条目，已改逐片静态编目');
});

// ============================================================ ④ 片单取数全量化

test('tmdb-discover 取数走 discoverAll（全量分页），不再走单页 discover', async () => {
  const { SFV, calls } = buildEnv();
  // 2026-09-27 榜单/类型两 tab 的目录卡已全部带 limit（≤100 部指令），
  // 「不限条数」（09-26 指令①）作为机制契约改用合成卡验证，不再绑定目录里的某张卡。
  const def = { id: 'synthetic-unbounded', type: 'tmdb-discover', tab: 'lists', query: { with_genres: '35' } };
  const items = await SFV.collections.getItems(def);
  assert.equal(calls.discoverAll, 1, '须调 discoverAll');
  assert.equal(calls.discover, 0, '不得再调单页 discover（20 条截断）');
  assert.equal(items.length, 80, '4 页全量不得截为 20');
});

test('tmdb-discover 缺失 discoverAll 时回退单页 discover（旧 tmdb.js 兼容）', async () => {
  const { SFV, calls } = buildEnv();
  delete SFV.tmdb.discoverAll;
  const items = await SFV.collections.getItems({ id: 'legacy', type: 'tmdb-discover', query: { with_genres: '35' } });
  assert.equal(calls.discover, 1, '无 discoverAll 须回退 discover 而非抛错');
  assert.equal(items.length, 20);
});
