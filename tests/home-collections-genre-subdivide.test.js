'use strict';

/**
 * 类型 tab 二次分类（2026-09-27 用户指令：「上网搜索权威信息将类型 tab 下包含上千部作品的
 * 片单进行二次分类，确保每个片单在 100 部以内」；实机截图 = 火爆动作 2003 / 欢乐喜剧 2814 /
 * 动画电影精选 1292 / 剧情佳作 3492）。
 *
 * 根因（有来源 G1）：11 张母类型卡全是 tmdb-discover 且无 limit，2026-09-26 用户指令①
 * 「所有片单不限制最多数量」把 discover 切成 discoverAll 无限分页 → 卡片计数=TMDB 该类型全库命中数。
 *
 * 分桶依据（两条来源）：
 *   1) 类型学（子类型思想）：维基百科「电影类型」条目 / 百度百科「动作片」/ 豆瓣类型子榜
 *      —— TMDB 本身**没有官方子类型体系**，子类型只存在于社区 keywords/lists。
 *   2) 过滤参数只用「本仓库可验证的硬参数」：
 *      - with_genres 交集/并集：ID 全部取自 public/video/tmdb.js GENRE_NAMES（站内 zh-CN 官方译名表）
 *      - with_original_language / with_original_language.not：ISO 639-1
 *      - primary_release_date.gte / .lte：日期窗
 *      - vote_average.gte + vote_count.gte：评分带 + 投票门槛
 *      不用 with_keywords 的原因：无 key 时无法证实关键词 ID 存在（api.tmdb.org 只回
 *      Invalid API key，站内 keyword 页本机不可达），且官方 talk 证实该参数一次只认一个 ID。
 *      凭记忆写 ID 已错过两次（合集 209 = 404、周星驰 190452 = 西语片误挂）。
 *
 * 每卡 ≤100 的保证 = 主题过滤天然收窄 + def.limit=100 硬截断（双保险，2026-09-27 用户选定）。
 * 母卡（genre-action / genre-comedy / … / genre-war）按用户裁定**整体删除**，不做母卡保留。
 *
 * 运行：node --test tests/home-collections-genre-subdivide.test.js
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

// ---- 在册电影类型 ID（与 tmdb.js GENRE_NAMES 同源；测试内重复声明以锁「卡片只用电影类型」）----
const MOVIE_GENRE_IDS = [12, 14, 16, 18, 27, 28, 35, 36, 37, 53, 80, 99, 878, 9648,
  10402, 10749, 10751, 10752, 10770];

// ---- 被删除的 11 张母类型卡（负锁：永不回归）----
const PARENT_IDS = ['genre-action', 'genre-comedy', 'genre-animation', 'genre-drama',
  'genre-romance', 'genre-scifi', 'genre-horror', 'genre-mystery', 'genre-crime',
  'genre-family', 'genre-war'];

// ---- 38 张子卡规格表（id → 过滤轴 + 主题类型集 + 门槛）----
// g = query.with_genres（字符串，逗号=AND 交集）；lang/langNot = 原产语言；lte/gteDate = 年份窗；
// va = vote_average.gte；vc = vote_count.gte
const SPEC = [
  // 动作 (28) → 4
  { id: 'genre-action-kungfu', g: '28', lang: 'zh', vc: 50 },
  { id: 'genre-action-war', g: '28,10752', vc: 150 },
  { id: 'genre-action-fantasy', g: '28,14', vc: 150 },
  { id: 'genre-action-classic', g: '28', lteDate: '1999-12-31', vc: 200 },
  // 喜剧 (35) → 4
  { id: 'genre-comedy-romance', g: '35,10749', vc: 150 },
  { id: 'genre-comedy-noir', g: '35,80', vc: 150 },
  { id: 'genre-comedy-animation', g: '35,16', vc: 150 },
  { id: 'genre-comedy-brit', g: '35', lang: 'en-GB', vc: 80 },
  // 动画 (16) → 4
  { id: 'genre-animation-japan', g: '16', lang: 'ja', vc: 100 },
  { id: 'genre-animation-china', g: '16', lang: 'zh', vc: 50 },
  { id: 'genre-animation-western', g: '16', lang: 'en', vc: 200 },
  { id: 'genre-animation-adult', g: '16,18', vc: 80 },
  // 剧情 (18) → 4
  { id: 'genre-drama-classic', g: '18', lteDate: '1999-12-31', vc: 300 },
  { id: 'genre-drama-epic', g: '18,10752', vc: 150 },
  { id: 'genre-drama-biopic', g: '18,36', vc: 150 },
  { id: 'genre-drama-mystery', g: '18,9648', vc: 150 },
  // 爱情 (10749) → 3
  { id: 'genre-romance-chinese', g: '10749', lang: 'zh', vc: 50 },
  { id: 'genre-romance-classic', g: '10749', lteDate: '1999-12-31', vc: 150 },
  { id: 'genre-romance-music', g: '10749,10402', vc: 100 },
  // 科幻 (878) → 4
  { id: 'genre-scifi-space', g: '878,12', vc: 150 },
  { id: 'genre-scifi-hard', g: '878', va: '8.0', vc: 300 },
  { id: 'genre-scifi-cyber', g: '878,28', vc: 150 },
  { id: 'genre-scifi-intl', g: '878', langNot: 'en', vc: 80 },
  // 恐怖 (27) → 3
  { id: 'genre-horror-supernatural', g: '27,14', vc: 150 },
  { id: 'genre-horror-psychological', g: '27,18,53', vc: 150 },
  { id: 'genre-horror-asia', g: '27', lang: 'ja,ko,zh', vc: 50 },
  // 悬疑 (9648) → 3
  { id: 'genre-mystery-detective', g: '9648,80', vc: 200 },
  { id: 'genre-mystery-thriller', g: '9648,53', vc: 200 },
  { id: 'genre-mystery-young', g: '9648,12', vc: 80 },
  // 犯罪 (80) → 4
  { id: 'genre-crime-classic', g: '80', lteDate: '1989-12-31', vc: 200 },
  { id: 'genre-crime-thriller', g: '80,53', vc: 200 },
  { id: 'genre-crime-drama', g: '80,18', vc: 200 },
  { id: 'genre-crime-biopic', g: '80,36', vc: 80 },
  // 家庭 (10751) → 3
  { id: 'genre-family-animation', g: '10751,16', vc: 200 },
  { id: 'genre-family-romance', g: '10751,10749', vc: 80 },
  { id: 'genre-family-fantasy', g: '10751,14', vc: 150 },
  // 战争 (10752) → 2
  { id: 'genre-war-intl', g: '10752', langNot: 'en', vc: 80 },
  { id: 'genre-war-history', g: '10752,36', vc: 80 },
];

function makeItems(n, prefix) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: i + 1, mediaType: 'movie', title: prefix + (i + 1), year: 2020,
      poster: 'https://img.example/' + prefix + (i + 1) + '.jpg',
      rating: 7, overview: '', backdrop: '', genreIds: [28], originalLanguage: 'en',
    });
  }
  return out;
}

function buildEnv() {
  const dom = new JSDOM(indexHtml, { url: 'http://localhost:3000/', pretendToBeVisual: true, runScripts: 'outside-only' });
  const win = dom.window;
  const calls = { discover: [], discoverAll: [] };
  win.StellaflixVideo = {
    tmdb: {
      hasKey: () => true,
      discover: (q) => { calls.discover.push(q || {}); return Promise.resolve(makeItems(20, 'D1')); },
      discoverAll: (q) => { calls.discoverAll.push(q || {}); return Promise.resolve(makeItems(80, 'DA')); },
      getCollection: () => Promise.resolve({ parts: makeItems(8, 'C') }),
      getListAll: () => Promise.resolve({ items: makeItems(20, 'L') }),
      getDetails: (id) => Promise.resolve({ id, title: 'M' + id, year: 1997, poster: 'https://img.example/p.jpg', rating: 8, overview: '', backdrop: '' }),
      genreNames: () => '', regionLabel: () => '',
      getPosterColor: () => Promise.reject(new Error('COLOR_OFFLINE')),
    },
    online: { openDetailFromMeta() {} },
  };
  win.eval(collectionsSrc);
  return { win, SFV: win.StellaflixVideo, calls };
}

// ============================================================ ① 目录规模与逐卡参数

test('类型 tab = 38 张二次分类卡，逐卡 ID/类型/limit 与规格表全等', () => {
  const { SFV } = buildEnv();
  const defs = SFV.collections.getByTab('genres');
  assert.equal(defs.length, SPEC.length, '类型 tab 须为 ' + SPEC.length + ' 张子卡');
  assert.equal(defs.map((d) => d.id).join(','), SPEC.map((s) => s.id).join(','), '子卡 ID 与须与规格表同序全等');
  defs.forEach((d, i) => {
    assert.equal(d.type, 'tmdb-discover', d.id + ' 子卡仍走 TMDB 实时排序，不人工编目');
    assert.equal(Number(d.limit), 100, d.id + ' 每张片单 ≤100 部（用户指令②：主题过滤 + limit 双保险）');
    assert.ok(d.title && d.title !== SPEC[i].id, d.id + ' 须有中文标题');
    assert.ok(d.sub, d.id + ' 须有副标题');
    assert.ok(/^#[0-9a-fA-F]{6}$/.test(d.warm || ''), d.id + ' 须有合法兜底色');
  });
});

test('逐卡过滤轴与规格表一致（类型交集 / 语言 / 年份窗 / 评分带 / 投票门槛）', () => {
  const { SFV } = buildEnv();
  const byId = {};
  SFV.collections.getByTab('genres').forEach((d) => { byId[d.id] = d; });
  SPEC.forEach((s) => {
    const d = byId[s.id];
    assert.ok(d, '缺子卡 ' + s.id);
    const q = d.query || {};
    assert.equal(String(q.with_genres), s.g, s.id + ' with_genres 须为 ' + s.g);
    assert.equal(q.sort_by, 'vote_average.desc', s.id + ' 须按评分降序');
    assert.equal(String(q['vote_count.gte']), String(s.vc), s.id + ' 投票门槛须为 ' + s.vc);
    if (s.lang) assert.equal(String(q.with_original_language), s.lang, s.id + ' 语言过滤');
    if (s.langNot) assert.equal(String(q['with_original_language.not']), s.langNot, s.id + ' 排除语言');
    if (s.lteDate) assert.equal(String(q['primary_release_date.lte']), s.lteDate, s.id + ' 年份窗上界');
    if (s.gteDate) assert.equal(String(q['primary_release_date.gte']), s.gteDate, s.id + ' 年份窗下界');
    if (s.va) assert.equal(String(q['vote_average.gte']), s.va, s.id + ' 评分带下界');
  });
});

// ============================================================ ② 母卡删除 + 参数合法性

test('11 张母类型卡整体删除（用户裁定「母卡全删，只留子卡」，负锁防回归）', () => {
  const { SFV } = buildEnv();
  const all = ['featured', 'series', 'lists', 'genres'].flatMap((t) => SFV.collections.getByTab(t));
  PARENT_IDS.forEach((id) => {
    assert.equal(all.some((d) => d.id === id), false, '母卡 ' + id + ' 已按 2026-09-27 裁定删除，不得回归');
  });
});

test('with_genres 只用本仓库在册电影类型 ID（tmdb.js GENRE_NAMES），且逐卡过滤签名唯一', () => {
  const { SFV } = buildEnv();
  const defs = SFV.collections.getByTab('genres');
  const sigs = [];
  defs.forEach((d) => {
    const ids = String(d.query.with_genres).split(',').map(Number);
    assert.ok(ids.length >= 1 && ids.every((g) => MOVIE_GENRE_IDS.includes(g)), d.id + ' 含未在册类型: ' + ids.join(','));
    if (/\|/.test(String(d.query.with_genres))) {
      assert.fail(d.id + ' 类型交集/并集混写不可验证：只用逗号（AND）收窄，桶大小由语言/年份/评分轴控制');
    }
    const q = d.query;
    sigs.push([ids.slice().sort((a, b) => a - b).join('+'),
      q.with_original_language || '', q['with_original_language.not'] || '',
      q['primary_release_date.gte'] || '', q['primary_release_date.lte'] || '',
      q['vote_average.gte'] || ''].join('|'));
  });
  assert.equal(new Set(sigs).size, sigs.length, '过滤签名重复＝两张卡拉同一批片，网格出现雷同卡');
});

test('每卡恰有一条正交过滤轴（语言/年份窗/评分带），或纯类型交集', () => {
  const { SFV } = buildEnv();
  SFV.collections.getByTab('genres').forEach((d) => {
    const q = d.query || {};
    const axes = [
      q.with_original_language != null,
      q['with_original_language.not'] != null,
      q['primary_release_date.lte'] != null,
      q['primary_release_date.gte'] != null,
      q['vote_average.gte'] != null,
    ].filter(Boolean);
    const multiGenre = String(q.with_genres).includes(',');
    assert.ok(axes.length <= 1, d.id + ' 过滤轴叠加多于一条 → 桶不可解释: ' + axes.length);
    if (axes.length === 0) {
      assert.ok(multiGenre, d.id + ' 无过滤轴时须为多类型交集桶，否则等于母卡');
    }
  });
});

test('子卡标题与兜底色全局唯一（同色/同名会在 38 卡网格里无法区分）', () => {
  const { SFV } = buildEnv();
  const defs = SFV.collections.getByTab('genres');
  const titles = defs.map((d) => d.title);
  const warms = defs.map((d) => String(d.warm).toLowerCase());
  assert.equal(new Set(titles).size, titles.length, '标题不得重复');
  assert.equal(new Set(warms).size, warms.length, '兜底色不得重复');
});

// ============================================================ ③ limit=100 取数链

test('类型子卡取数走单页 discover + limit 截断，不拉无限分页', async () => {
  const { SFV, calls } = buildEnv();
  const def = SFV.collections.getByTab('genres')[0];
  await SFV.collections.getItems(def);
  assert.equal(calls.discoverAll.length, 0, '带 limit 的子卡不得 discoverAll（母卡上千部正是这么来的）');
  assert.equal(calls.discover.length, 1, '须走单页 discover');
});

test('上游超 100 条时 limit 硬截断为 100', async () => {
  const { SFV } = buildEnv();
  SFV.tmdb.discover = () => Promise.resolve(makeItems(120, 'BIG'));
  const def = SFV.collections.getByTab('genres').find((d) => d.id === 'genre-drama-classic');
  const items = await SFV.collections.getItems(def);
  assert.equal(items.length, 100, '≤100 部是用户指令②的硬上限');
});

// ============================================================ ④ 覆盖度：11 个母类型都有归属子卡

test('原 11 个母类型各自至少有 2 张子卡（拆细后不得出现某类型只剩一张）', () => {
  const { SFV } = buildEnv();
  const defs = SFV.collections.getByTab('genres');
  const PARENT_GIDS = [28, 35, 16, 18, 10749, 878, 27, 9648, 80, 10751, 10752];
  PARENT_GIDS.forEach((gid) => {
    const n = defs.filter((d) => String(d.query.with_genres).split(',').includes(String(gid))).length;
    assert.ok(n >= 2, '母类型 ' + gid + ' 只剩 ' + n + ' 张子卡');
  });
});
