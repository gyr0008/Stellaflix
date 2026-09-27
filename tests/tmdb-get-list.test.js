'use strict';

/**
 * tmdb.getList / getListAll —— 社区名榜数据层（2026-09-26 官方片单映射·数据层第一步）
 * 契约：
 *   ① 无 key → TMDB_KEY_REQUIRED；无 id → TMDB_NO_ID
 *   ② GET /3/list/{list_id}（经 /api/proxy），page 透传；缺省不发 page 参数（禁 page=undefined 脏串）
 *   ③ resolve 元数据 { id, name, createdBy, description, itemCount, page, totalPages }
 *      + items（normalizeList 同格式：title 兼容 name、poster 走代理、mediaType 由 first_air_date 推断）
 *   ④ getListAll 顺序逐页拉全（1→2→…），页数不设上限（见 tmdb-discover-paginate-all.test.js）；中途失败整体 reject
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

// TMDB /3/list/{id} 真实响应形状（官方 docs 示例字段）：没有 pages / total_pages，
// 只有 page、next_page、item_count、number_of_items，每页固定 20 条。
// 旧单测造了个不存在的 pages 字段，掩盖了「只拉第 1 页 = 共20部」的真 bug（09-27 实机反馈）。
function realListPayload(page, opts) {
  const o = opts || {};
  return {
    id: o.id || 634, name: 'Top 250 IMDB', description: 'desc',
    created_by: 'Fernando K',
    item_count: o.itemCount, number_of_items: o.itemCount,
    page, next_page: o.nextPage || false,
    items: o.items || [],
  };
}
function pageItems(page, n, prefix) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(movieItem(page * 1000 + i, (prefix || 'M') + page + '-' + i));
  return out;
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

// 分页上限契约已随「所有片单不限制最多数量」指令变更，见 tests/tmdb-discover-paginate-all.test.js

test('getListAll 中途页失败：整体 reject 不吐半截列表', async () => {
  const { tmdb, withKey, setResponder } = buildEnv();
  withKey();
  setResponder((rec) => {
    if ((rec.page || 1) === 2) return Promise.resolve({ ok: false, status: 500, headers: { get: () => 'application/json' }, json: () => Promise.resolve({}) });
    return Promise.resolve(jsonResponse(listPayload(rec.page || 1, 3, [movieItem(rec.page, 'M')])));
  });
  await assert.rejects(() => tmdb.getListAll(634), /TMDB_HTTP_500/);
});

// ============================================================ created_by 形状容错
// TMDB 的 created_by 有两种历史形状：旧 v3=字符串，现行=对象 {name, id, gravatar}。
// createdBy 目前无任何 UI 消费者（卡片副标题来自 CATALOG 静态 sub），但把它归一化成字符串
// 才能保证将来被渲染时不会露出 [object Object]。

test('created_by 为对象（现行形状）→ createdBy 归一化为 name 字符串', async () => {
  const { tmdb, withKey, setResponder } = buildEnv();
  withKey();
  setResponder(() => Promise.resolve(jsonResponse({
    id: 634, name: 'Top 250 IMDB', page: 1, item_count: 20,
    created_by: { name: 'Fernando K', id: '5c7d8e', gravatar: { hash: 'abc' } },
    items: pageItems(1, 20),
  })));
  const r = await tmdb.getList(634);
  assert.equal(r.createdBy, 'Fernando K');
  assert.equal(typeof r.createdBy, 'string');
});

test('created_by 缺失或无 name → createdBy 为空串而非 undefined/对象', async () => {
  const { tmdb, withKey, setResponder } = buildEnv();
  withKey();
  for (const cb of [undefined, { hash: 'no-name' }, null]) {
    setResponder(() => Promise.resolve(jsonResponse({
      id: 1, name: 'L', page: 1, item_count: 5, created_by: cb, items: pageItems(1, 5),
    })));
    const r = await tmdb.getList(1);
    assert.equal(r.createdBy, '', 'created_by=' + JSON.stringify(cb) + ' 须回落空串');
  }
});

// ============================================================ 真实响应形状：按 item_count 反推页数
// 回归锁：09-27 实机反馈「IMDb Top250 怎么只有 20 部」——四张社区榜卡全部停在 20。

test('真实响应（无 pages 字段）：totalPages 按 item_count 反推 = ceil(250/20) = 13', async () => {
  const { tmdb, withKey, setResponder } = buildEnv();
  withKey();
  setResponder(() => Promise.resolve(jsonResponse(realListPayload(1, { itemCount: 250, items: pageItems(1, 20) }))));
  const r = await tmdb.getList(634);
  assert.equal(r.itemCount, 250);
  assert.equal(r.totalPages, 13, 'TMDB 不返回 pages，须由 item_count 反推');
});

test('getListAll(634) 拉满 13 页 = 250 条（共20部截断回归锁）', async () => {
  const { tmdb, calls, withKey, setResponder } = buildEnv();
  withKey();
  setResponder((rec) => {
    const p = rec.page || 1;
    const n = p < 13 ? 20 : 10; // 250 = 12×20 + 10
    return Promise.resolve(jsonResponse(realListPayload(p, { itemCount: 250, items: pageItems(p, n) })));
  });
  const r = await tmdb.getListAll(634);
  assert.deepEqual(calls.map((c) => c.page), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.equal(r.items.length, 250, '社区榜全量 = 250 条，不得停在 20');
});

test('number_of_items 作 item_count 的兼容别名', async () => {
  const { tmdb, withKey, setResponder } = buildEnv();
  withKey();
  setResponder(() => Promise.resolve(jsonResponse({
    id: 28, name: 'Oscar BPM', page: 1, number_of_items: 99, items: pageItems(1, 20),
  })));
  const r = await tmdb.getList(28);
  assert.equal(r.itemCount, 99);
  assert.equal(r.totalPages, 5);
});

test('空页早停：item_count 虚高时不得空转，遇 0 条页即收尾', async () => {
  const { tmdb, calls, withKey, setResponder } = buildEnv();
  withKey();
  setResponder((rec) => {
    const p = rec.page || 1;
    return Promise.resolve(jsonResponse(realListPayload(p, { itemCount: 20000, items: p === 1 ? pageItems(1, 20) : [] })));
  });
  const r = await tmdb.getListAll(634);
  assert.equal(r.items.length, 20);
  assert.deepEqual(calls.map((c) => c.page), [1, 2], '空页之后不再发请求');
});

test('item_count 缺失但 next_page=true：逐页爬行拉全', async () => {
  const { tmdb, calls, withKey, setResponder } = buildEnv();
  withKey();
  setResponder((rec) => {
    const p = rec.page || 1;
    const items = p <= 2 ? pageItems(p, 20) : pageItems(p, 3);
    return Promise.resolve(jsonResponse({
      id: 43, name: 'AFI Thriller', page: p, next_page: p < 3, items,
    }));
  });
  const r = await tmdb.getListAll(43);
  assert.equal(r.items.length, 43, '无计数时靠 next_page 爬行：20+20+3');
  assert.deepEqual(calls.map((c) => c.page), [1, 2, 3]);
});

test('页数封顶：item_count 极端口径按 500 页截断，而非退回 1 页', async () => {
  const { tmdb, withKey, setResponder } = buildEnv();
  withKey();
  setResponder(() => Promise.resolve(jsonResponse(realListPayload(1, { itemCount: 20000, items: pageItems(1, 20) }))));
  const r = await tmdb.getList(634);
  assert.equal(r.totalPages, 500, '20000/20=1000 页须夹到 TMDB 硬上限 500，不得视为脏值只取首页');
});

test('getList/getListAll 已导出到 SFV.tmdb', () => {
  const { tmdb } = buildEnv();
  assert.equal(typeof tmdb.getList, 'function');
  assert.equal(typeof tmdb.getListAll, 'function');
});
