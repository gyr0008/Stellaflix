'use strict';

/**
 * 精选片单 · 官方片单映射批 —— CATALOG 全量重写（2026-09-26 用户裁定：全量替换 + 引用社区名榜）
 * 结构定案（4 tab）：
 *   推荐 featured  = 3 动态卡（trending movie/tv + upcoming）
 *   系列 series    = 26 个 TMDB 官方合集 + 3 影人专区卡（成龙卡 09-26 用户裁定删除 / 周星驰·宫崎骏·新海诚=静态编目）
 *   榜单 lists     = 5 个已核实社区名榜（tmdb-list → tmdb.getListAll，含 DC=8005）+ 高分/恢复/华语 discover + 奥斯卡 static + 25 张年度高分动画卡
 *   类型 genres    = 38 张二次分类子卡（09-27 用户指令：母卡全删、每卡 ≤100 部 = 主题过滤 + limit:100）
 * 契约：
 *   ① getByTab 的 tab 集合恰为上述 4 个；旧 tab（theme/classic/highscore/awards）返回空
 *   ② tmdb-list 定义带 listId 且 getByTab 透传；副标题标「社区榜 · 创建者」（TMDB 无官方榜单）
 *   ③ getItems('tmdb-list') → tmdb.getListAll(listId)，走 10min 缓存；计数语义=「共N部」（全量型）
 *   ④ 合集/榜单 ID 锁死在核实白名单内（防 AI 瞎编 ID 回归——121988 等弃用案例）
 * 运行：node --test tests/home-collections-catalog-official.test.js
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
const overlaySrc = read('public/video/home-collections-overlay.js');

// ---- 2026-09-26 核实白名单（有来源：站内页直连确认标题；09-26 二审：209 页面 404 剔除，DC 改社区榜 8005） ----
const VERIFIED_COLLECTION_IDS = [
  86311, 10, 1241, 328, 9485, // 原有（复核正确；209 已证实不存在→剔除）
  119, 645, 264, 10194, 230, 295, 2344, 87359, 263, 120794, // 新核实
  77816, 86066, 544669, 8354, 8650, 121938, 435259, 556, 125574, 573436,
  814181, // 熊出没电影宇宙（14 部 2013-2026，含年年有熊）
];
const VERIFIED_LIST_IDS = [28, 43, 634, 3682, 8005]; // travisbell / endtheme / Fernando K / Filmsomniac / Harish-P(DCEU)
const VERIFIED_PERSON_IDS = [57607, 18897, 608, 74091]; // 周星驰 / 成龙 / 宫崎骏 / 新海诚（2026-09-26 TMDB 站内搜索核实）

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
  const calls = { trending: 0, upcoming: 0, discover: 0, getCollection: 0, getListAll: [] };
  win.StellaflixVideo = {
    tmdb: {
      hasKey: () => true,
      trending: () => { calls.trending += 1; return Promise.resolve(makeItems(20, 'T')); },
      upcoming: () => { calls.upcoming += 1; return Promise.resolve(makeItems(12, 'U')); },
      discover: () => { calls.discover += 1; return Promise.resolve(makeItems(20, 'D')); },
      getCollection: () => { calls.getCollection += 1; return Promise.resolve({ parts: makeItems(8, 'C') }); },
      getListAll: (listId) => {
        calls.getListAll.push(listId);
        return Promise.resolve({ id: listId, name: 'L' + listId, itemCount: 8, totalPages: 1, items: makeItems(8, 'L') });
      },
      genreNames: () => '',
      regionLabel: () => '',
      getPosterColor: () => Promise.reject(new Error('COLOR_OFFLINE')),
    },
    online: { openDetailFromMeta() {} },
  };
  win.eval(collectionsSrc);
  win.eval(overlaySrc);
  const list = win.document.getElementById('home-video-collections-list');
  const click = (el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
  const switchTab = async (id) => {
    click(win.document.getElementById('home-video-collections-tabs').querySelector('[data-wc-tab="' + id + '"]'));
    await settle();
  };
  return { win, SFV: win.StellaflixVideo, calls, list, click, settle, switchTab };
}

const allDefs = (SFV) => ['featured', 'series', 'lists', 'genres'].flatMap((t) => SFV.collections.getByTab(t));

// ============================================================ 目录骨架

test('tab 集合 = 推荐/系列/榜单/类型 4 个；旧 tab 不再返回条目', () => {
  const { SFV } = buildEnv();
  assert.equal(SFV.collections.getByTab('featured').length, 3, '推荐=3 动态卡');
  assert.equal(SFV.collections.getByTab('series').length, 29, '系列=26 官方合集 + 3 影人静态专区（成龙卡已删）');
  assert.equal(SFV.collections.getByTab('theme').length, 0);
  assert.equal(SFV.collections.getByTab('classic').length, 0);
  assert.equal(SFV.collections.getByTab('highscore').length, 0);
  assert.equal(SFV.collections.getByTab('awards').length, 0);
});

test('def id 全局唯一', () => {
  const { SFV } = buildEnv();
  const ids = allDefs(SFV).map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length, '重复 id: ' + ids.filter((x, i) => ids.indexOf(x) !== i).join(','));
});

test('推荐 tab：trending-week / trending-tv-week / upcoming，全部分页型', () => {
  const { SFV } = buildEnv();
  const defs = SFV.collections.getByTab('featured');
  // 注：数组产自 jsdom realm，跨 realm deepStrictEqual 因原型不同而失败 → join 比较
  assert.equal(defs.map((d) => d.id).sort().join(','), 'trending-tv-week,trending-week,upcoming');
  assert.equal(defs.map((d) => d.type).sort().join(','), 'tmdb-trending,tmdb-trending,tmdb-upcoming');
});

// ============================================================ 系列（官方合集）

test('系列 tab = 26 官方合集 + 3 影人静态专区（合集 ID 白名单锁，防瞎编 ID 回归）', () => {
  const { SFV } = buildEnv();
  const defs = SFV.collections.getByTab('series');
  assert.equal(defs.length, VERIFIED_COLLECTION_IDS.length + 3, '系列 = 26 官方合集 + 3 影人静态专区');
  const colls = defs.filter((d) => d.type === 'tmdb-collection');
  const persons = defs.filter((d) => d.type === 'tmdb-discover');
  const pLists = defs.filter((d) => d.type === 'tmdb-list');
  const pStatics = defs.filter((d) => d.type === 'static-list');
  assert.equal(colls.length, VERIFIED_COLLECTION_IDS.length, '官方合集数=白名单数');
  assert.equal(persons.length, 0, '影人卡已全部改静态编目（discover with_people 会混入非其导演条目）');
  assert.equal(pLists.length, 0, 'series tab 内社区榜已清空（成龙卡 09-26 用户裁定删除）');
  assert.equal(pStatics.length, 3, 'series 内静态编目 = 周星驰 + 宫崎骏 + 新海诚');
  colls.forEach((d) => {
    assert.ok(VERIFIED_COLLECTION_IDS.includes(Number(d.collectionId)), '未核实合集 ID: ' + d.collectionId);
    assert.ok(d.title && d.warm, d.id + ' 须有中文标题与兜底色');
  });
  persons.forEach((d) => {
    const pid = Number(d.query && d.query.with_people);
    assert.ok(VERIFIED_PERSON_IDS.includes(pid), d.id + ' 未核实 person ID: ' + pid);
    assert.equal(d.query.sort_by, 'vote_average.desc', d.id + ' 影人卡须按评分排');
    assert.ok(d.title && d.warm, d.id + ' 须有中文标题与兜底色');
  });
  assert.ok(defs.some((d) => !d.title && !d.warm) === false, '全卡须有标题与兜底色');
  assert.equal(new Set(colls.map((d) => Number(d.collectionId))).size, VERIFIED_COLLECTION_IDS.length, '合集 ID 不得重复');
  assert.equal(defs.some((d) => Number(d.collectionId) === 209), false, '209 页面 404 不存在，永不得作为合集 ID 回归');
  // 抽查代表：原有 MCU + 新核实指环王/蜘蛛侠 + 熊出没 + 影人专区
  assert.ok(defs.some((d) => Number(d.collectionId) === 86311), 'MCU 86311 保留');
  assert.ok(defs.some((d) => Number(d.collectionId) === 119), '指环王 119');
  assert.ok(defs.some((d) => Number(d.collectionId) === 573436), '蜘蛛侠平行宇宙 573436');
  assert.ok(defs.some((d) => Number(d.collectionId) === 814181), '熊出没电影宇宙 814181');
  assert.equal(defs.some((d) => d.id === 'person-jackiechan'), false, '成龙专区已删（09-26 用户裁定）');
  assert.equal(defs.some((d) => Number(d.listId) === 11302), false, '社区榜 11302 不得回归 series');
  assert.ok(pStatics.some((d) => d.id === 'person-stephenchow'), '周星驰专区 = 静态编目（TMDB 无相关社区榜）');
  assert.ok(pStatics.some((d) => d.id === 'person-miyazaki'), '宫崎骏 = 静态编目');
  assert.ok(pStatics.some((d) => d.id === 'person-shinkai'), '新海诚 = 静态编目');
});

// ============================================================ 榜单（社区名榜）

test('榜单 tab 含 5 个已核实社区榜（tmdb-list + listId 透传 + 副标题标创建者）', () => {
  const { SFV } = buildEnv();
  const lists = SFV.collections.getByTab('lists').filter((d) => d.type === 'tmdb-list');
  assert.equal(lists.length, 5);
  lists.forEach((d) => {
    assert.ok(VERIFIED_LIST_IDS.includes(Number(d.listId)), '未核实榜单 ID: ' + d.listId);
    assert.match(d.sub, /社区榜/, '副标题须明示社区榜来源: ' + d.sub);
    assert.ok(d.title, '须有中文标题');
  });
  assert.equal(lists.map((d) => Number(d.listId)).sort((a, b) => a - b).join(','), VERIFIED_LIST_IDS.join(','));
  assert.ok(lists.some((d) => Number(d.listId) === 8005 && d.id === 'list-dceu'), 'DC 卡=社区榜 8005（list-dceu）');
});

test('榜单 tab = 5 社区榜 + 名次段×5 + 年代带×7 + 年度×5 + 奥斯卡static + 25年度动画（09-27 大榜已拆段）', () => {
  const { SFV } = buildEnv();
  const defs = SFV.collections.getByTab('lists');
  assert.equal(defs.length, 49, '5社区榜+奥斯卡+5名次段+4影史年代带+5年度+华语动画+3华语年代带+25年度动画');
  const disc = defs.filter((d) => d.type === 'tmdb-discover');
  assert.equal(disc.length, 43, '5名次段+4影史年代带+5年度+1华语动画+3华语年代带+25年度动画 = 43');
  // 09-27 用户指令：榜单 tab 每个片单 ≤100 部（社区榜属人工策展完整榜，用户裁定原样保留故豁免）
  disc.forEach((d) => {
    assert.ok(Number(d.limit) > 0 && Number(d.limit) <= 100, d.id + ' 榜卡须带 limit ≤100');
  });
  assert.equal(defs.filter((d) => d.type === 'placeholder').length, 0, '金鹰/白玉兰/华表占位卡须移除');
  assert.equal(allDefs(SFV).some((d) => d.type === 'placeholder'), false, '全目录不留 placeholder 条目');
  // 高分榜/影史百大/华语天花板三张母榜已按名次段+年代带拆开（负锁见 ranking-subdivide）
  ['top-rated', 'classic-alltime', 'list-chinese-classics'].forEach((id) => {
    assert.equal(allDefs(SFV).some((d) => d.id === id), false, id + ' 母榜已拆段，不得回归');
  });
  assert.ok(disc.some((d) => d.id === 'top-rated-1-100'), '高分榜名次段首段在册');
  assert.ok(disc.some((d) => d.id === 'classic-golden-age'), '影史百大年代带首段在册');
  assert.ok(disc.some((d) => d.id === 'chinese-classic-recent'), '华语经典年代带末段在册');
  // 年度卡锚点（09-26 用户点名恢复，09-27 只补 limit 不改 ID/参数）
  const byId = (id) => defs.find((d) => d.id === id);
  ['top-2024', 'top-2023', 'top-2022', 'top-2021', 'top-2020s'].forEach((id) => {
    const d = byId(id);
    assert.ok(d, id + ' 恢复');
    assert.equal(d.type, 'tmdb-discover');
    assert.match(JSON.stringify(d.query), /vote_average\.desc/);
  });
  assert.match(JSON.stringify(byId('top-2024').query), /"primary_release_year":"2024"/);
  assert.match(JSON.stringify(byId('top-2021').query), /"primary_release_year":"2021"/);
  const oscar = byId('oscar-best-picture');
  assert.ok(oscar, '奥斯卡 static 10 部恢复');
  assert.equal(oscar.type, 'static-list');
  assert.equal((oscar.tmdbIds || []).length, 10, 'tmdbIds 经 getByTab 透传且保 10 部');
  // 2026-09-26 新增：华语动画榜（保留原 ID），中国电影天花板已拆为三段
  const zhAnim = byId('list-chinese-animation');
  assert.ok(zhAnim, '华语动画榜');
  assert.equal(String(zhAnim.query.with_original_language), 'zh');
  assert.equal(String(zhAnim.query.with_genres), '16');
  assert.equal(byId('list-animation-2002-2026'), undefined, '25 张年度动画卡已取代聚合卡');
});

test('getItems(tmdb-list) 走 getListAll(listId) 且返回全量 items；二次命中缓存', async () => {
  const { SFV, calls } = buildEnv();
  const def = SFV.collections.getByTab('lists').find((d) => d.type === 'tmdb-list');
  const items = await SFV.collections.getItems(def);
  assert.deepEqual(calls.getListAll, [def.listId], '须按 listId 调 getListAll');
  assert.equal(items.length, 8);
  await SFV.collections.getItems(def);
  assert.equal(calls.getListAll.length, 1, '第二次须命中 10min 缓存');
});

test('tmdb-list 缺失 listId：reject TMDB_NO_ID 不发散调用', async () => {
  const { SFV, calls } = buildEnv();
  await assert.rejects(
    () => SFV.collections.getItems({ id: 'bad-list', type: 'tmdb-list' }),
    /TMDB_NO_ID/,
  );
  assert.equal(calls.getListAll.length, 0);
});

// ============================================================ 类型（discover 导航）

test('类型 tab = 38 张二次分类子卡，全部带 limit:100（2026-09-27 用户指令，契约详见 genre-subdivide）', () => {
  const { SFV } = buildEnv();
  const defs = SFV.collections.getByTab('genres');
  assert.equal(defs.length, 38);
  defs.forEach((d) => {
    assert.equal(d.type, 'tmdb-discover', d.id + ' 类型子卡走 TMDB 实时排序');
    assert.equal(Number(d.limit), 100, d.id + ' 每张 ≤100 部');
    assert.ok(d.id.indexOf('genre-') === 0, d.id + ' 子卡 ID 须挂 genre- 前缀');
  });
  // 11 个母类型 ID 已被子卡取代（09-27 裁定「母卡全删」）
  ['genre-action', 'genre-comedy', 'genre-animation', 'genre-drama', 'genre-romance',
    'genre-scifi', 'genre-horror', 'genre-mystery', 'genre-crime', 'genre-family', 'genre-war']
    .forEach((id) => assert.equal(allDefs(SFV).some((d) => d.id === id), false, id + ' 母卡不得回归'));
});

// ============================================================ overlay 4 tab 与计数语义

test('浮层 tab 条渲染 4 个 tab：推荐/系列/榜单/类型', async () => {
  const { SFV, win } = buildEnv();
  SFV.homeCollectionsOverlay.open();
  await new Promise((r) => setTimeout(r, 0));
  const tabs = win.document.querySelectorAll('#home-video-collections-tabs [data-wc-tab]');
  assert.equal(tabs.length, 4);
  assert.deepEqual(
    Array.from(tabs).map((t) => t.getAttribute('data-wc-tab')),
    ['featured', 'series', 'lists', 'genres'],
  );
  assert.deepEqual(Array.from(tabs).map((t) => t.textContent), ['推荐', '系列', '榜单', '类型']);
});

test('社区榜卡计数=「共N部」（全量型），点卡进二级页同语义', async () => {
  const { SFV, list, click, settle, switchTab } = buildEnv();
  SFV.homeCollectionsOverlay.open();
  await switchTab('lists');
  const card = list.querySelector('.home-video-collections-grid [data-wc-id]');
  assert.ok(card, 'lists tab 应渲染卡');
  // 找 L8=8 条的社区榜卡：等 fillCovers 刷新
  await settle();
  const lists = SFV.collections.getByTab('lists').filter((d) => d.type === 'tmdb-list');
  const el = list.querySelector('[data-wc-id="' + lists[0].id + '"] [data-wc-count]');
  assert.ok(el, '社区榜卡应有计数位');
  assert.equal(el.textContent, '共8部', 'tmdb-list 全量型须为「共N部」');
  click(list.querySelector('[data-wc-id="' + lists[0].id + '"]'));
  await settle();
  const hero = list.querySelector('.home-video-collections-hero-copy small');
  assert.equal(hero.textContent, '共8部');
});

test('系列合集二级页取数走 getCollection（tmdb-collection 分支不受重写影响）', async () => {
  const { SFV, calls } = buildEnv();
  const def = SFV.collections.getByTab('series')[0];
  const items = await SFV.collections.getItems(def);
  assert.equal(calls.getCollection, 1);
  assert.equal(items.length, 8);
});
