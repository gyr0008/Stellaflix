'use strict';

/**
 * static-list 批量取详情（2026-09-26 周星驰专区 39 部首屏）
 * 根因：resolveStatic 逐条串行 getDetails → 39 部 = 39 个串行往返（单程 0.3~0.8s ≈ 20s），专区必卡。
 * 方案：TMDB 原生 chunk 端点 GET /3/movie?ids=1,2,... （每请求 ≤20 id，服务端支持多 id）
 *   - 39 部 → 3 个请求，且返回顺序按 tmdbIds 保序（TMDB 按 requested 顺序回）
 *   - chunk 整体失败 → 该批降级为逐条 getDetails（个别坏 ID 不拖垮整张卡）
 *   - 旧 tmdb.js 无 request 时 → 回退串行 getDetails（兼容）
 * 运行：node --test tests/home-collections-static-chunk.test.js
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
const tmdbSrc = read('public/video/tmdb.js');
const LS_KEY = 'stellaflix-tmdb-key';

function jsonResponse(obj) {
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: () => Promise.resolve(obj) };
}

const raw = (id) => ({
  id, title: '片' + id, original_title: 'o' + id, release_date: '1992-08-01',
  overview: 'ov' + id, poster_path: '/p' + id + '.jpg', backdrop_path: '/b' + id + '.jpg',
  vote_average: 8.1, genres: [{ id: 35, name: '喜剧' }], original_language: 'zh',
});

// 只装 collections.js；tmdb 用桩（可注入 request / getDetails 计数）
function buildCollections(tmdbStub) {
  const dom = new JSDOM(indexHtml, { url: 'http://localhost:3000/', pretendToBeVisual: true, runScripts: 'outside-only' });
  const win = dom.window;
  if (!tmdbStub.posterUrl) tmdbStub.posterUrl = (pth, size) => '/api/proxy?url=' + encodeURIComponent('https://image.tmdb.org/t/p/' + (size || 'w342') + pth);
  win.StellaflixVideo = { tmdb: tmdbStub, online: { openDetailFromMeta() {} } };
  win.eval(collectionsSrc);
  return { win, SFV: win.StellaflixVideo };
}

// 真 tmdb.js + 假 fetch：统计打到的端点与 ids 参数
function buildTmdb() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:3000/', runScripts: 'outside-only' });
  const win = dom.window;
  const hits = [];
  let responder = null;
  win.fetch = (url) => {
    const target = decodeURIComponent((/[?&]url=([^&]+)/.exec(String(url)) || [])[1] || '');
    const ids = (new URL(target).searchParams.get('ids') || '').split(',').filter(Boolean);
    hits.push({ target, pathname: new URL(target).pathname, ids });
    return Promise.resolve(responder ? responder(hits[hits.length - 1]) : jsonResponse({ results: [] }));
  };
  win.eval(tmdbSrc);
  const tmdb = win.StellaflixVideo.tmdb;
  tmdb.setApiKey('TESTKEY');
  win.localStorage.removeItem(LS_KEY);
  return { win, tmdb, hits, setResponder: (fn) => { responder = fn; } };
}

const def = (ids) => ({ id: 'sc', type: 'static-list', tmdbIds: ids, tab: 'series' });
const IDS_39 = Array.from({ length: 39 }, (_, i) => 1000 + i);

// ============================================================ 请求数

test('39 部 static-list → 2 个 chunk 请求（非 39 个串行 getDetails）', async () => {
  const calls = { paths: [], getDetails: 0 };
  const { SFV } = buildCollections({
    hasKey: () => true,
    request: (path) => {
      calls.paths.push(path);
      return Promise.resolve({ results: IDS_39.map(raw) });
    },
    getDetails: () => { calls.getDetails += 1; return Promise.resolve(raw(1)); },
  });
  const items = await SFV.collections.getItems(def(IDS_39));
  assert.equal(calls.paths.length, 2, '39 id → 20+19 分 2 批');
  assert.equal(calls.paths.join(','), '/movie,/movie', '须全部走 TMDB chunk 端点 /3/movie?ids=');
  assert.equal(calls.getDetails, 0, '批量成功时不得再逐条 getDetails');
  assert.equal(items.length, 39);
});

test('chunk 请求按 tmdbIds 顺序保序返回（专区编目顺序=用户品级顺序，不得乱序）', async () => {
  const order = [];
  const { SFV } = buildCollections({
    hasKey: () => true,
    request: (p, q) => {
      const ids = String(q.ids).split(',').map(Number);
      order.push(...ids);
      return Promise.resolve({ results: ids.map(raw) });
    },
  });
  const items = await SFV.collections.getItems(def(IDS_39));
  assert.equal(order.join(','), IDS_39.join(','), '请求批次拼接后须与原 tmdbIds 同序');
  assert.equal(items.map((i) => i.id).join(','), IDS_39.join(','), '条目顺序须与 tmdbIds 同序');
});

test('chunk 漏返某 id：该 id 降级逐条 getDetails 补齐，坏 id 静默跳过', async () => {
  const ids = [11, 22, 33];
  const tried = [];
  const { SFV } = buildCollections({
    hasKey: () => true,
    request: () => Promise.resolve({ results: [raw(11), raw(33)] }),
    getDetails: (id) => {
      tried.push(id);
      return id === 33 ? Promise.resolve(raw(33)) : Promise.reject(new Error('HTTP_404'));
    },
  });
  const items = await SFV.collections.getItems(def(ids));
  assert.equal(tried.join(','), '22', '仅缺失的 id 须补拉');
  assert.equal(items.length, 2, '补拉失败的 22 静默跳过，不得整卡报错');
  assert.equal(items.map((i) => i.id).join(','), '11,33', '保序：缺失项剔除后相对顺序不变');
});

test('chunk 整体失败：降级逐条 getDetails（个别坏 ID 不拖垮专区）', async () => {
  const ids = [7, 8];
  const got = [];
  const { SFV } = buildCollections({
    hasKey: () => true,
    request: () => Promise.reject(new Error('TMDB_HTTP_500')),
    getDetails: (id) => { got.push(id); return Promise.resolve(raw(id)); },
  });
  const items = await SFV.collections.getItems(def(ids));
  assert.equal(got.join(','), '7,8');
  assert.equal(items.length, 2);
});

test('旧 tmdb.js 无 request：回退串行 getDetails（兼容不抛错）', async () => {
  const ids = [1, 2, 3];
  const got = [];
  const { SFV } = buildCollections({
    hasKey: () => true,
    getDetails: (id) => { got.push(id); return Promise.resolve(raw(id)); },
  });
  const items = await SFV.collections.getItems(def(ids));
  assert.equal(got.join(','), '1,2,3');
  assert.equal(items.length, 3);
});

test('条目字段完整：title/year/poster/backdrop/rating/overview 均来自详情响应', async () => {
  const { SFV } = buildCollections({
    hasKey: () => true,
    request: () => Promise.resolve({ results: [raw(9470)] }),
  });
  const items = await SFV.collections.getItems(def([9470]));
  const it = items[0];
  assert.equal(it.id, 9470);
  assert.equal(it.title, '片9470');
  assert.equal(it.year, '1992');
  assert.equal(it.mediaType, 'movie');
  assert.match(it.poster, /\/api\/proxy\?url=/, '海报须走本地代理');
  assert.match(it.backdrop, /w780/);
  assert.equal(it.rating, 8.1);
  assert.equal(it.overview, 'ov9470');
});

// ============================================================ tmdb.request 真实链路

test('tmdb.request 直调 chunk 端点：/3/movie?ids=… 且带 api_key/language，不带 page 脏串', async () => {
  const { tmdb, hits, setResponder } = buildTmdb();
  setResponder(() => jsonResponse({ results: [raw(9470)] }));
  const j = await tmdb.request('/movie', { ids: '9470,11770' });
  assert.equal(hits.length, 1);
  assert.match(hits[0].target, /api\.tmdb\.org\/3\/movie\?/);
  assert.equal(hits[0].pathname, '/3/movie');
  assert.equal(hits[0].ids.join(','), '9470,11770');
  assert.match(hits[0].target, /api_key=TESTKEY/);
  assert.doesNotMatch(hits[0].target, /page=undefined/);
  assert.ok(j.results.length === 1);
});
