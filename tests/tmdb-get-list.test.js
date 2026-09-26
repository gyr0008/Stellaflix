'use strict';

/**
 * tmdb.getList / getListAll —— 社区名榜数据层（2026-09-26 官方片单映射·数据层第一步）
 * 契约：
 *   ① 无 key → TMDB_KEY_REQUIRED；无 id → TMDB_NO_ID
 *   ② GET /3/list/{list_id}（经 /api/proxy），page 透传；缺省不发 page 参数（禁 page=undefined 脏串）
 *   ③ resolve 元数据 { id, name, createdBy, description, itemCount, page, totalPages }
 *      + items（normalizeList 同格式：title 兼容 name、poster 走代理、mediaType 由 first_air_date 推断）
 *   ④ getListAll 顺序逐页拉全（1→2→…），上限 15 页（20×15=300 条锁请求量）；中途失败整体 reject
 * 运行：node --test tests/tmdb-get-list.test.js
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

function buildEnv() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:3000/', runScripts: 'outside-only' });
  const win = dom.window;
  const calls = []; // 每请求一条：{ url(代理原始串), target(解码后的 TMDB 目标 URL), page }
  win.fetch = (url) => {
    const target = decodeURIComponent((/[?&]url=([^&]+)/.exec(String(url)) || [])[1] || '');
    const rec = { url: String(url), target, page: Number((/[?&]page=(\d+)/.exec(target) || [])[1] || 0) };
    calls.push(rec);
    const resp = (buildResp ? buildResp(rec, calls.length) : undefined);
    if (!resp) return Promise.resolve(jsonResponse({}));
    return resp;
  };
  let buildResp = null; // 测试可注入：(rec, n) => Promise|undefined
  win.eval(tmdbSrc);
  const tmdb = win.StellaflixVideo.tmdb;
  return {
    win, tmdb, calls,
    withKey: () => { win.localStorage.removeItem(LS_KEY); tmdb.setApiKey('TESTKEY'); },
    withoutKey: () => { tmdb.setApiKey(''); },
    setResponder: (fn) => { buildResp = fn; },
  };
}

function jsonResponse(obj) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: () => Promise.resolve(obj),
  };
}

const movieItem = (id, title) => ({
  id, title, original_title: title,
  release_date: '1994-09-10', overview: 'ov', poster_path: '/p' + id + '.jpg',
  vote_average: 8.7, vote_count: 20000, popularity: 50, adult: false,
  genre_ids: [18, 80], original_language: 'en',
});
const tvItem = (id, name) => ({
  id, name, original_name: name,
  first_air_date: '2008-01-20', overview: '', poster_path: '/t' + id + '.jpg',
  vote_average: 9.1, genre_ids: [10765], original_language: 'en',
});

function listPayload(page, pages, items) {
  return {
    id: 634, name: 'Top 250 IMDB', description: 'desc',
    created_by: 'Fernando K', item_count: 250,
    page, pages, results: null, items,
  };
}

// ============================================================ 参数校验

test('getList 无 key：reject TMDB_KEY_REQUIRED，且不发请求', async () => {
  const { tmdb, calls, withoutKey } = buildEnv();
  withoutKey();
  await assert.rejects(() => tmdb.getList(634), /TMDB_KEY_REQUIRED/);
  assert.equal(calls.length, 0);
});

test('getList 无 id：reject TMDB_NO_ID', async () => {
  const { tmdb, withKey } = buildEnv();
  withKey();
  await assert.rejects(() => tmdb.getList(), /TMDB_NO_ID/);
  await assert.rejects(() => tmdb.getListAll(''), /TMDB_NO_ID/);
});

// ============================================================ 单页 getList

test('getList 走 /3/list/{id} 代理端点：page 透传、缺省不发 page 脏串', async () => {
  const { tmdb, calls, withKey, setResponder } = buildEnv();
  withKey();
  setResponder((rec) => Promise.resolve(jsonResponse(listPayload(rec.page || 1, 3, [movieItem(1, 'A')]))) );
  await tmdb.getList(634);
  assert.match(calls[0].target, /api\.tmdb\.org\/3\/list\/634\?/);
  assert.doesNotMatch(calls[0].url, /page=undefined/);
  assert.equal(calls[0].page, 0, '缺省不得带 page 参数');
  await tmdb.getList(634, 2);
  assert.equal(calls[1].page, 2, 'page=2 须透传');
  assert.match(calls[1].target, /api_key=TESTKEY/);
});

test('getList resolve 榜单元数据（name/createdBy/itemCount/totalPages）', async () => {
  const { tmdb, withKey, setResponder } = buildEnv();
  withKey();
  setResponder(() => Promise.resolve(jsonResponse(listPayload(1, 13, [movieItem(1, 'A')]))));
  const r = await tmdb.getList(634);
  assert.equal(r.id, 634);
  assert.equal(r.name, 'Top 250 IMDB');
  assert.equal(r.createdBy, 'Fernando K');
  assert.equal(r.description, 'desc');
  assert.equal(r.itemCount, 250);
  assert.equal(r.page, 1);
  assert.equal(r.totalPages, 13);
});

test('getList items 归一化 = normalizeList 同格式（tv 由 first_air_date 推断、poster 走代理）', async () => {
  const { tmdb, withKey, setResponder } = buildEnv();
  withKey();
  setResponder(() => Promise.resolve(jsonResponse(listPayload(1, 1, [movieItem(680, 'Pulp Fiction'), tvItem(66732, 'Breaking Bad')]))));
  const r = await tmdb.getList(634);
  assert.equal(r.items.length, 2);
  const m = r.items[0];
  assert.equal(m.id, 680);
  assert.equal(m.mediaType, 'movie');
  assert.equal(m.title, 'Pulp Fiction');
  assert.equal(m.year, '1994');
  assert.match(m.poster, /\/api\/proxy\?url=/, '海报须走本地代理（image.tmdb.org 直连被封）');
  assert.ok(m.poster.includes(encodeURIComponent('image.tmdb.org/t/p/w342/p680.jpg')));
  assert.deepEqual(m.genreIds, [18, 80]);
  assert.equal(m.originalLanguage, 'en');
  const t = r.items[1];
  assert.equal(t.mediaType, 'tv', '无 media_type 时须按 first_air_date 推断为 tv');
  assert.equal(t.title, 'Breaking Bad', 'tv 条目 title 须兼容 name 字段');
  assert.equal(t.year, '2008');
});

test('getList 响应缺 items：resolve 空数组不抛错', async () => {
  const { tmdb, withKey, setResponder } = buildEnv();
  withKey();
  setResponder(() => Promise.resolve(jsonResponse({ id: 1, name: 'x', page: 1, pages: 1 })));
  const r = await tmdb.getList(1);
  // 注：items 产自 jsdom realm，跨 realm 数组不可 deepStrictEqual（原型不同），只断言空与非空守卫
  assert.ok(Array.isArray(r.items));
  assert.equal(r.items.length, 0);
});

// ============================================================ 逐页拉全 getListAll

test('getListAll 顺序逐页拉全并合并 items（1→2→3）', async () => {
  const { tmdb, calls, withKey, setResponder } = buildEnv();
  withKey();
  setResponder((rec) => Promise.resolve(jsonResponse(listPayload(rec.page || 1, 3, [movieItem(rec.page, 'M' + rec.page)]))));
  const r = await tmdb.getListAll(634);
  assert.deepEqual(calls.map((c) => c.page), [1, 2, 3], '须按页序拉取');
  assert.equal(r.items.length, 3);
  assert.equal(r.totalPages, 3);
  assert.equal(r.name, 'Top 250 IMDB', '元数据取首页');
});

test('getListAll 上限 15 页：pages=40 也只发 15 个请求（≤300 条）', async () => {
  const { tmdb, calls, withKey, setResponder } = buildEnv();
  withKey();
  setResponder((rec) => {
    const page = rec.page || 1;
    const items = [];
    for (let i = 0; i < 20; i++) items.push(movieItem(page * 100 + i, 'M' + page + '_' + i));
    return Promise.resolve(jsonResponse(listPayload(page, 40, items)));
  });
  const r = await tmdb.getListAll(634);
  assert.equal(calls.length, 15, '15 页封顶');
  assert.equal(r.items.length, 300);
});

test('getListAll 中途页失败：整体 reject 不吐半截列表', async () => {
  const { tmdb, withKey, setResponder } = buildEnv();
  withKey();
  setResponder((rec) => {
    if ((rec.page || 1) === 2) return Promise.resolve({ ok: false, status: 500, headers: { get: () => 'application/json' }, json: () => Promise.resolve({}) });
    return Promise.resolve(jsonResponse(listPayload(rec.page || 1, 3, [movieItem(rec.page, 'M')])));
  });
  await assert.rejects(() => tmdb.getListAll(634), /TMDB_HTTP_500/);
});

test('getList/getListAll 已导出到 SFV.tmdb', () => {
  const { tmdb } = buildEnv();
  assert.equal(typeof tmdb.getList, 'function');
  assert.equal(typeof tmdb.getListAll, 'function');
});
