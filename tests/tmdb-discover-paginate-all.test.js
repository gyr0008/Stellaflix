'use strict';

/**
 * tmdb.discoverAll + getListAll 无限分页（2026-09-26 用户指令：所有片单不限制最多数量）
 * 背景契约：
 *   ① discover 单页只回 20 条 → 影人/类型/年度卡在「分页被截断」下永远不完整（周星驰 40+ 部只显 20）
 *   ② discoverAll(params)：顺序逐页拉至响应 total_pages 全量合并；单页型（total_pages<=1）只发 1 个请求
 *   ③ total_pages 缺失/非法（0、负、非数字、超 TMDB 上限 500）→ 不追页、不失控，只取首页
 *   ④ getListAll 同义：不再 15 页封顶，按 pages 全取（同 ③ 的非法值守卫）
 * 运行：node --test tests/tmdb-discover-paginate-all.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const tmdbSrc = read('public/video/tmdb.js');
const LS_KEY = 'stellaflix-tmdb-key';

function jsonResponse(obj) {
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: () => Promise.resolve(obj) };
}

function buildEnv() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:3000/', runScripts: 'outside-only' });
  const win = dom.window;
  const calls = []; // { target, page, params }
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
    const resp = buildResp ? buildResp(rec, calls.length) : undefined;
    return Promise.resolve(resp || jsonResponse({ page: rec.page || 1, results: [] }));
  };
  win.eval(tmdbSrc);
  const tmdb = win.StellaflixVideo.tmdb;
  return {
    win, tmdb, calls,
    withKey: () => { win.localStorage.removeItem(LS_KEY); tmdb.setApiKey('TESTKEY'); },
    withoutKey: () => { tmdb.setApiKey(''); },
    setResponder: (fn) => { buildResp = fn; },
  };
}

const movieItem = (id, title) => ({
  id, title, original_title: title, release_date: '1995-01-01',
  poster_path: '/p' + id + '.jpg', vote_average: 8, vote_count: 900,
  popularity: 20, adult: false, genre_ids: [35], original_language: 'zh',
});

function discoverPayload(page, total_pages, results) {
  return { page, total_pages, total_results: total_pages * 20, results };
}

function pageItems(page, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(movieItem(page * 100 + i, 'M' + page + '_' + i));
  return out;
}

// ============================================================ 导出与校验

test('discoverAll 已导出到 SFV.tmdb', () => {
  const { tmdb } = buildEnv();
  assert.equal(typeof tmdb.discoverAll, 'function');
});

test('discoverAll 无 key：reject TMDB_KEY_REQUIRED 且不发请求', async () => {
  const { tmdb, calls, withoutKey } = buildEnv();
  withoutKey();
  await assert.rejects(() => tmdb.discoverAll({ with_people: '57607' }), /TMDB_KEY_REQUIRED/);
  assert.equal(calls.length, 0);
});

// ============================================================ 端点与参数

test('discoverAll 打 /3/discover/movie，params 原样合并且不带 page=undefined 脏串', async () => {
  const { tmdb, calls, withKey, setResponder } = buildEnv();
  withKey();
  setResponder((rec) => Promise.resolve(jsonResponse(discoverPayload(1, 1, pageItems(1, 3)))));
  const items = await tmdb.discoverAll({ with_people: '57607', sort_by: 'vote_average.desc' });
  assert.match(calls[0].target, /api\.tmdb\.org\/3\/discover\/movie\?/);
  assert.equal(calls[0].params.with_people, '57607');
  assert.equal(calls[0].params.sort_by, 'vote_average.desc');
  assert.equal(calls[0].params.api_key, 'TESTKEY');
  assert.doesNotMatch(calls[0].target, /page=undefined/);
  assert.equal(items.length, 3, '单页结果须为归一化条目数组');
  assert.equal(items[0].title, 'M1_0');
  assert.equal(items[0].year, '1995');
  assert.match(items[0].poster, /\/api\/proxy\?url=/, '海报须走本地代理');
});

// ============================================================ 无限分页

test('discoverAll 逐页拉全：total_pages=4 → 页序 1,2,3,4 且条目全量合并', async () => {
  const { tmdb, calls, withKey, setResponder } = buildEnv();
  withKey();
  setResponder((rec) => Promise.resolve(jsonResponse(discoverPayload(rec.page || 1, 4, pageItems(rec.page || 1, 20)))));
  const items = await tmdb.discoverAll({ with_genres: '35' });
  assert.deepEqual(calls.map((c) => c.page), [1, 2, 3, 4], '须按页序拉取');
  assert.equal(items.length, 80, '4 页 80 条不得截断');
  assert.equal(items[79].id, 4 * 100 + 19);
});

test('discoverAll 突破旧 20 条上限：成龙早期低投票片在第 2 页也必须拿到', async () => {
  const { tmdb, withKey, setResponder } = buildEnv();
  withKey();
  setResponder((rec) => {
    const p = rec.page || 1;
    const results = p === 1 ? pageItems(1, 20) : [movieItem(12094, 'Project A'), movieItem(27593, 'The Young Master')];
    return Promise.resolve(jsonResponse(discoverPayload(p, 2, results)));
  });
  const items = await tmdb.discoverAll({ with_people: '18897' });
  assert.equal(items.length, 22, '20+2 条：第 2 页不得丢');
  assert.ok(items.some((it) => it.id === 12094), 'A计划（第 2 页）须在结果内');
});

test('discoverAll total_pages 非法（缺失/0/负/超 500）：只取首页，不失控发请求', async () => {
  for (const bad of [undefined, 0, -3, 9999]) {
    const { tmdb, calls, withKey, setResponder } = buildEnv();
    withKey();
    setResponder((rec) => Promise.resolve(jsonResponse({ page: rec.page || 1, total_pages: bad, results: pageItems(rec.page || 1, 5) })));
    const items = await tmdb.discoverAll({ with_people: '608' });
    assert.equal(calls.length, 1, 'total_pages=' + bad + ' 时不得追页');
    assert.equal(items.length, 5);
  }
});

test('discoverAll 中途页失败：整体 reject，不吐半截列表', async () => {
  const { tmdb, withKey, setResponder } = buildEnv();
  withKey();
  setResponder((rec) => {
    if ((rec.page || 1) === 2) {
      return Promise.resolve({ ok: false, status: 500, headers: { get: () => 'application/json' }, json: () => Promise.resolve({}) });
    }
    return Promise.resolve(jsonResponse(discoverPayload(rec.page || 1, 3, pageItems(rec.page || 1, 20))));
  });
  await assert.rejects(() => tmdb.discoverAll({ with_genres: '28' }), /TMDB_HTTP_500/);
});

// ============================================================ getListAll 同步放开

test('getListAll 不再 15 页封顶：pages=40 全取 40 页 800 条', async () => {
  const { tmdb, calls, withKey, setResponder } = buildEnv();
  withKey();
  setResponder((rec) => Promise.resolve(jsonResponse({
    id: 634, name: 'Top 250 IMDB', created_by: 'x', item_count: 800,
    page: rec.page || 1, pages: 40, items: pageItems(rec.page || 1, 20),
  })));
  const r = await tmdb.getListAll(634);
  assert.equal(calls.length, 40, '40 页须全发');
  assert.equal(r.items.length, 800);
});

test('getListAll pages 非法（缺失/0/超 500）：只取首页', async () => {
  for (const bad of [undefined, 0, 9999]) {
    const { tmdb, calls, withKey, setResponder } = buildEnv();
    withKey();
    setResponder((rec) => Promise.resolve(jsonResponse({
      id: 1, name: 'L', page: rec.page || 1, pages: bad, items: pageItems(rec.page || 1, 4),
    })));
    const r = await tmdb.getListAll(1);
    assert.equal(calls.length, 1, 'pages=' + bad + ' 时不得追页');
    assert.equal(r.items.length, 4);
  }
});
