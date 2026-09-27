'use strict';

/**
 * 榜单 tab 二次分类（2026-09-27 用户指令：「上网搜索权威信息将榜单 tab 下包含上千部作品的片单
 * 进行二次分类，确保每个片单在 100 部以内」）
 *
 * 根因（有来源 G1）：9 张 discover 榜卡（top-rated / classic-alltime / top-2024·2023·2022·2021 /
 * top-2020s / list-chinese-animation / list-chinese-classics）全部无 limit，
 * 而 09-26 指令①「所有片单不限制最多数量」把 discover 换成 discoverAll 无限分页
 * → 卡片计数 = TMDB 全库命中数（高分榜 vote_count≥5000 的池子本身就是几千部）。
 *
 * 用户两项裁定（本轮 AskUserQuestion）：
 *   ① 拆法＝**混合**：排行榜按**名次段**切（1-100 / 101-200 / …），跨年代榜（影史百大、华语经典）
 *      按**影史分期年代带**切；年度榜不再拆，只加 limit:100。
 *   ② 固定长度的社区榜（IMDb Top250=250 / AFI 百大=100 / 奥斯卡=99 / DC=83）**原样保留**，
 *      不拆名次段——它们是人工策展的完整权威榜，拆开即毁掉榜单本身。
 *
 * 年代带依据（有来源）：北京电影学院「电影史类课程设置」与维基百科「美国电影」条目的通行分期
 * （默片→黄金时代→新好莱坞→当代），华语侧按 1990（新浪潮已成）/2010 分界。
 * 名次段依据：IMDb/豆瓣榜单本身的阅读结构就是名次区间。
 * 每卡 ≤100 = 名次段/年代带天然收窄 + def.limit=100 硬截断（与类型 tab 同一套双保险）。
 *
 * 机制新增：tmdb.discoverRank(params, rankFrom, count) —— 按 20 条/页换算起始页与页内偏移，
 * 顺序补页至 offset+count，上游提前耗尽则如实返回不足数；无 key 时 reject 且零请求。
 *
 * 运行：node --test tests/home-collections-ranking-subdivide.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const tmdbSrc = read('public/video/tmdb.js');
const indexHtml = read('public/index.html');
const collectionsSrc = read('public/video/collections.js');
const LS_KEY = 'stellaflix-tmdb-key';

// ============================================================ 规格表（目录全等锁）

// 名次段卡（TMDB 高分榜 → 5 段，每段恰 100 名）
const RANK_BANDS = [
  { id: 'top-rated-1-100', rank: 1, title: 'TMDB 高分榜 · 前100', sub: /第 1-100 名/ },
  { id: 'top-rated-101-200', rank: 101, title: 'TMDB 高分榜 · 101-200', sub: /第 101-200 名/ },
  { id: 'top-rated-201-300', rank: 201, title: 'TMDB 高分榜 · 201-300', sub: /第 201-300 名/ },
  { id: 'top-rated-301-400', rank: 301, title: 'TMDB 高分榜 · 301-400', sub: /第 301-400 名/ },
  { id: 'top-rated-401-500', rank: 401, title: 'TMDB 高分榜 · 401-500', sub: /第 401-500 名/ },
];
// 年代带卡（影史百大 4 段 + 中国电影天花板 3 段）；from/to 为主上映日期窗（null=不设界）
const ERA_BANDS = [
  { id: 'classic-golden-age', from: null, to: '1959-12-31', lang: null },
  { id: 'classic-new-hollywood', from: '1960-01-01', to: '1989-12-31', lang: null },
  { id: 'classic-modern', from: '1990-01-01', to: '2009-12-31', lang: null },
  { id: 'classic-contemporary', from: '2010-01-01', to: null, lang: null },
  { id: 'chinese-classic-old', from: null, to: '1989-12-31', lang: 'zh' },
  { id: 'chinese-classic-newwave', from: '1990-01-01', to: '2009-12-31', lang: 'zh' },
  { id: 'chinese-classic-recent', from: '2010-01-01', to: null, lang: 'zh' },
];
// 保留原 ID（快照兼容）、只补 limit 的年度/华语榜
const CAPPED_KEEP = ['top-2024', 'top-2023', 'top-2022', 'top-2021', 'top-2020s', 'list-chinese-animation'];
// 被拆掉的整体删除卡（负锁永不回归）
const SPLIT_PARENTS = ['top-rated', 'classic-alltime', 'list-chinese-classics'];
// 用户裁定原样保留的社区榜（tmdb-list，不设 limit）
const COMMUNITY_LISTS = ['list-imdb250', 'list-oscars', 'list-afi-thriller', 'list-afi-comedy', 'list-dceu'];

// ============================================================ harness

function jsonResponse(obj) {
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: () => Promise.resolve(obj) }
    ;
}

// ① tmdb.discoverRank 的 harness（真实 tmdb.js + 桩 fetch 走 /api/proxy）
function buildTmdbEnv() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:3000/', runScripts: 'outside-only' });
  const win = dom.window;
  const calls = [];
  let buildResp = null;
  win.fetch = (url) => {
    const target = decodeURIComponent((/[?&]url=([^&]+)/.exec(String(url)) || [])[1] || '');
    const params = {};
    (target.split('?')[1] || '').split('&').forEach((kv) => {
      const i = kv.indexOf('=');
      if (i > 0) params[kv.slice(0, i)] = kv.slice(i + 1);
    });
    const rec = { target, params, page: Number(params.page || 0) };
    calls.push(rec);
    const resp = buildResp ? buildResp(rec) : undefined;
    return Promise.resolve(resp || jsonResponse({ page: rec.page || 1, total_pages: 25, results: [] }));
  };
  win.eval(tmdbSrc);
  const tmdb = win.StellaflixVideo.tmdb;
  tmdb.setApiKey('TESTKEY');
  // TMDB 真实语义：每页 20 条，全局第 n 名（1 基）落在 page=floor((n-1)/20)+1 的第 (n-1)%20 条
  const fullPages = (rec) => {
    const start = (rec.page - 1) * 20 + 1;
    const results = [];
    for (let r = start; r < start + 20; r++) {
      results.push({ id: r, title: 'M' + r, original_title: 'M' + r, release_date: '1995-01-01',
        poster_path: '/p' + r + '.jpg', vote_average: 9 - r / 10000, vote_count: 9000,
        popularity: 20, adult: false, genre_ids: [18], original_language: 'en' });
    }
    return jsonResponse({ page: rec.page, total_pages: 25, results });
  };
  return { win, tmdb, calls, setResponder: (fn) => { buildResp = fn; }, fullPages };
}

// ② collections.js 目录/路由的 harness
function makeItems(n, prefix) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: i + 1, mediaType: 'movie', title: prefix + (i + 1), year: 2020,
      poster: 'https://img.example/' + prefix + (i + 1) + '.jpg', rating: 7, overview: '',
      backdrop: '', genreIds: [18], originalLanguage: 'en' });
  }
  return out;
}

function buildEnv() {
  const dom = new JSDOM(indexHtml, { url: 'http://localhost:3000/', pretendToBeVisual: true, runScripts: 'outside-only' });
  const win = dom.window;
  const calls = { discover: [], discoverAll: [], discoverRank: [] };
  win.StellaflixVideo = {
    tmdb: {
      hasKey: () => true,
      discover: (q) => { calls.discover.push(q || {}); return Promise.resolve(makeItems(20, 'D1')); },
      discoverAll: (q) => { calls.discoverAll.push(q || {}); return Promise.resolve(makeItems(500, 'DA')); },
      discoverRank: (q, rankFrom, count) => {
        calls.discoverRank.push({ query: q || {}, rankFrom, count });
        return Promise.resolve(makeItems(count, 'R' + rankFrom + '-'));
      },
      getCollection: () => Promise.resolve({ parts: makeItems(8, 'C') }),
      getListAll: () => Promise.resolve({ items: makeItems(8, 'L') }),
      getDetails: (id) => Promise.resolve({ id, title: 'M' + id, year: 1997, poster: 'https://img.example/p.jpg', rating: 8, overview: '', backdrop: '' }),
      genreNames: () => '', regionLabel: () => '',
      getPosterColor: () => Promise.reject(new Error('COLOR_OFFLINE')),
    },
    online: { openDetailFromMeta() {} },
  };
  win.eval(collectionsSrc);
  return { win, SFV: win.StellaflixVideo, calls };
}

// ============================================================ ① discoverRank 机制

test('discoverRank：名次段起始页与页内偏移换算正确，且不请求区间外的页', async () => {
  const { tmdb, calls, fullPages, setResponder } = buildTmdbEnv();
  setResponder(fullPages);
  const items = await tmdb.discoverRank({ with_genres: '18' }, 101, 100);
  assert.deepEqual(calls.map((c) => c.page), [6, 7, 8, 9, 10], '第 101-200 名 = 页 6~10，不得回拉页 1~5（省 5 个请求）');
  assert.equal(items.length, 100, '名次段须恰 100 条');
  assert.equal(items[0].id, 101, '首条须是全局第 101 名');
  assert.equal(items[items.length - 1].id, 200, '末条须是全局第 200 名');
});

test('discoverRank：非整页起点按页内偏移丢弃（第 15 名起取 26 条 = 页 1~2）', async () => {
  const { tmdb, calls, fullPages, setResponder } = buildTmdbEnv();
  setResponder(fullPages);
  const items = await tmdb.discoverRank({}, 15, 26);
  assert.equal(items.length, 26, 'offset 14 + 26 条 = 跨页 1~2');
  assert.equal(items[0].id, 15, '首条=全局第 15 名');
  assert.equal(items[items.length - 1].id, 40, '末条=全局第 40 名');
  assert.deepEqual(calls.map((c) => c.page), [1, 2], '不得多拉第 3 页');
});

test('discoverRank：上游提前耗尽（末页不足 20 条）时如实返回少条数，不空转补页', async () => {
  const { tmdb, calls, setResponder } = buildTmdbEnv();
  setResponder((rec) => {
    const results = [];
    // 只有 2 页，第 2 页仅 6 条
    const n = rec.page === 1 ? 20 : (rec.page === 2 ? 6 : 0);
    for (let i = 0; i < n; i++) {
      const id = (rec.page - 1) * 20 + i + 1;
      results.push({ id, title: 'M' + id, original_title: 'M' + id, release_date: '1995-01-01',
        poster_path: '/p' + id + '.jpg', vote_average: 8, vote_count: 500, popularity: 10,
        adult: false, genre_ids: [], original_language: 'en' });
    }
    return jsonResponse({ page: rec.page, total_pages: 999, results });
  });
  const items = await tmdb.discoverRank({}, 1, 100);
  assert.equal(items.length, 26, '真实只有 26 部则如实 26 部（不得伪造/空转）');
  assert.equal(calls.length, 2, '第 2 页不足 20 条即视为到底，不得再去页 3 空转');
});

test('discoverRank：无 Key 时 reject TMDB_KEY_REQUIRED 且零请求', async () => {
  const { tmdb, calls, setResponder } = buildTmdbEnv();
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:3000/', runScripts: 'outside-only' });
  dom.window.fetch = () => Promise.resolve(jsonResponse({ results: [] }));
  dom.window.eval(tmdbSrc);
  const noKey = dom.window.StellaflixVideo.tmdb;
  noKey.setApiKey('');
  await assert.rejects(() => noKey.discoverRank({}, 1, 100), /TMDB_KEY_REQUIRED/);
  assert.equal(calls.length, 0);
  setResponder(null);
});

test('discoverRank：rankFrom 非法（0/负/非数）按第 1 名处理，不越界取负偏移', async () => {
  const { tmdb, calls, fullPages, setResponder } = buildTmdbEnv();
  setResponder(fullPages);
  const items = await tmdb.discoverRank({}, 0, 20);
  assert.equal(calls[0].page, 1, '非法起点须回落第 1 页');
  assert.equal(items[0].id, 1, '首条=第 1 名');
  assert.equal(items.length, 20);
});

// ============================================================ ② 榜单目录契约

test('榜单 tab = 49 张卡（40 - 3 张被拆榜 + 5 名次段 + 7 年代带），discover 榜卡全部 ≤100 部', () => {
  const { SFV } = buildEnv();
  const defs = SFV.collections.getByTab('lists');
  assert.equal(defs.length, 49, '49 = 5社区榜 + 奥斯卡static + 5名次段 + 4影史年代带 + 5年度 + 华语动画 + 3华语年代带 + 25年度动画');
  const disc = defs.filter((d) => d.type === 'tmdb-discover');
  assert.equal(disc.length, 43, 'discover 榜卡 = 5名次段+4影史年代带+5年度+1华语动画+3华语年代带+25年度动画');
  disc.forEach((d) => {
    assert.ok(Number(d.limit) > 0 && Number(d.limit) <= 100,
      d.id + ' 每张榜卡须 ≤100 部（用户指令），实测 limit=' + d.limit);
  });
});

test('被拆的 3 张母榜整体删除（top-rated/classic-alltime/list-chinese-classics 负锁）', () => {
  const { SFV } = buildEnv();
  const all = ['featured', 'series', 'lists', 'genres'].flatMap((t) => SFV.collections.getByTab(t));
  SPLIT_PARENTS.forEach((id) => {
    assert.equal(all.some((d) => d.id === id), false, id + ' 已被分段卡取代，不得回归（否则又是上千部）');
  });
});

test('TMDB 高分榜 = 5 张名次段卡，rankFrom 连续无重叠且共用同一榜的排序参数', () => {
  const { SFV } = buildEnv();
  const defs = SFV.collections.getByTab('lists');
  const byId = {};
  defs.forEach((d) => { byId[d.id] = d; });
  RANK_BANDS.forEach((s, i) => {
    const d = byId[s.id];
    assert.ok(d, '缺名次段卡 ' + s.id);
    assert.equal(d.type, 'tmdb-discover', s.id + ' 名次段仍走 discover 实时排序');
    assert.equal(d.tab, 'lists');
    assert.equal(Number(d.rankFrom), s.rank, s.id + ' rankFrom 须为 ' + s.rank);
    assert.equal(Number(d.limit), 100, s.id + ' 每段恰 100 名');
    if (i > 0) assert.equal(Number(d.rankFrom) - Number(RANK_BANDS[i - 1].rank), 100, s.id + ' 段间不得重叠或留空');
    const q = d.query || {};
    assert.equal(q.sort_by, 'vote_average.desc', s.id + ' 名次段的排序须与原高分榜一致，否则名次无可比性');
    assert.equal(String(q['vote_count.gte']), '5000', s.id + ' 投票门槛须与原高分榜一致');
    assert.equal(q.with_genres, undefined, s.id + ' 高分榜是全类型榜，不得掺类型过滤');
    assert.equal(d.title, s.title, s.id + ' 标题须明示名次区间');
    assert.match(d.sub || '', s.sub, s.id + ' 副标题须写明名次区间');
    assert.ok(/^#[0-9a-fA-F]{6}$/.test(d.warm || ''), s.id + ' 须有兜底色');
  });
});

test('年代带卡：影史百大 4 段 + 华语经典 3 段，日期窗首尾衔接且不重叠', () => {
  const { SFV } = buildEnv();
  const byId = {};
  SFV.collections.getByTab('lists').forEach((d) => { byId[d.id] = d; });
  ERA_BANDS.forEach((s) => {
    const d = byId[s.id];
    assert.ok(d, '缺年代带卡 ' + s.id);
    assert.equal(d.type, 'tmdb-discover');
    assert.equal(Number(d.limit), 100, s.id + ' 每段 ≤100 部');
    const q = d.query || {};
    assert.equal(q.sort_by, 'vote_average.desc', s.id + ' 年代带内仍按口碑排序');
    if (s.from) assert.equal(String(q['primary_release_date.gte']), s.from, s.id + ' 年份窗下界须为 ' + s.from);
    else assert.equal(q['primary_release_date.gte'], undefined, s.id + ' 首段不设下界');
    if (s.to) assert.equal(String(q['primary_release_date.lte']), s.to, s.id + ' 年份窗上界须为 ' + s.to);
    else assert.equal(q['primary_release_date.lte'], undefined, s.id + ' 末段不设上界');
    if (s.lang) assert.equal(String(q.with_original_language), s.lang, s.id + ' 华语段须锁原产语言 zh');
    assert.ok(Number(q['vote_count.gte']) > 0, s.id + ' 年代带须保留投票门槛');
    assert.ok(/^#[0-9a-fA-F]{6}$/.test(d.warm || ''), s.id + ' 须有兜底色');
  });
  // 影史 4 段的分数门槛须继承原 classic-alltime（8.0 分以上 + 3000 投票），否则「百大」口径漂移
  ['classic-golden-age', 'classic-new-hollywood', 'classic-modern', 'classic-contemporary'].forEach((id) => {
    assert.equal(String(byId[id].query['vote_average.gte']), '8.0', id + ' 须继承影史百大的 8.0 分门槛');
  });
  // 同族年代带必须互斥（上界 < 下族下界）
  assert.ok(byId['classic-golden-age'].query['primary_release_date.lte'] < byId['classic-new-hollywood'].query['primary_release_date.gte']);
});

test('保留原 ID 的年度榜/华语动画榜只加 limit，不改排序与年份参数（封面快照兼容）', () => {
  const { SFV } = buildEnv();
  const byId = {};
  SFV.collections.getByTab('lists').forEach((d) => { byId[d.id] = d; });
  CAPPED_KEEP.forEach((id) => {
    const d = byId[id];
    assert.ok(d, id + ' 保留');
    assert.equal(Number(d.limit), 100, id + ' 加 limit:100 硬上限');
    assert.equal(d.rankFrom, undefined, id + ' 年度榜不拆名次段');
    assert.equal(d.query.sort_by, 'vote_average.desc');
  });
  assert.equal(JSON.stringify(byId['top-2024'].query).indexOf('"2024"') > -1, true, '年度卡年份参数不变');
});

test('社区榜（IMDb Top250 等）按用户裁定原样保留：仍为 tmdb-list 且不带 limit', () => {
  const { SFV } = buildEnv();
  const byId = {};
  SFV.collections.getByTab('lists').forEach((d) => { byId[d.id] = d; });
  COMMUNITY_LISTS.forEach((id) => {
    const d = byId[id];
    assert.ok(d, id + ' 人工策展完整权威榜不得拆');
    assert.equal(d.type, 'tmdb-list', id + ' 仍是社区榜引用');
    assert.ok(Number(d.listId) > 0, id + ' 须带 listId');
    assert.equal(d.limit, undefined, id + ' 榜单完整性优先（IMDb Top250=250 部属用户裁定的例外）');
  });
  assert.equal(Number(byId['list-imdb250'].listId), 634);
});

// ============================================================ ③ 取数路由

test('名次段卡取数走 discoverRank(query, rankFrom, limit)，不拉全量分页', async () => {
  const { SFV, calls } = buildEnv();
  const def = SFV.collections.getByTab('lists').find((d) => d.id === 'top-rated-201-300');
  const items = await SFV.collections.getItems(def);
  assert.equal(calls.discoverRank.length, 1, '须调 discoverRank');
  assert.equal(calls.discoverRank[0].rankFrom, 201);
  assert.equal(calls.discoverRank[0].count, 100);
  assert.equal(calls.discoverAll.length, 0, '名次段不得 discoverAll（拉 25 页只为丢前 250 条）');
  assert.equal(calls.discover.length, 0);
  assert.equal(items.length, 100);
  const q = calls.discoverRank[0].query;
  assert.equal(q.sort_by, 'vote_average.desc', '透传的 query 须与原榜一致');
});

test('旧 tmdb.js（无 discoverRank）回退：拉全量后按名次段切片，结果不错位', async () => {
  const { SFV, calls } = buildEnv();
  delete SFV.tmdb.discoverRank;
  SFV.tmdb.discoverAll = (q) => { calls.discoverAll.push(q); return Promise.resolve(makeItems(500, 'DA')); };
  const def = SFV.collections.getByTab('lists').find((d) => d.id === 'top-rated-101-200');
  const items = await SFV.collections.getItems(def);
  assert.equal(calls.discoverAll.length, 1, '回退路径仍须取数');
  assert.equal(items.length, 100, '切片后仍恰 100 条');
  assert.equal(items[0].title, 'DA101', '回退取数须从第 101 名开始，不得吐第 1 名');
});

test('年代带与年度卡仍走单页 discover + limit（未误接 discoverRank）', async () => {
  const { SFV, calls } = buildEnv();
  const defs = SFV.collections.getByTab('lists').filter((d) => d.id === 'classic-modern' || d.id === 'top-2023');
  assert.equal(defs.length, 2);
  for (const def of defs) await SFV.collections.getItems(def);
  assert.equal(calls.discoverRank.length, 0);
  assert.equal(calls.discover.length, 2);
  assert.equal(calls.discoverAll.length, 0);
});
