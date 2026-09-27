'use strict';

/**
 * 封面快照陈旧计数（2026-09-26 实机反馈②：「周星驰的片单记录数量还是 17，但里面内容已经为 42」）
 * 根因（有来源：home-collections-overlay.js fillCovers）：
 *   快照只存 { posters, count, ts }，不含片单来源标识；CATALOG 把同一 id 的卡从
 *   discover（旧编目 17 部）改成 static-list（48 部）后，id 不变 → 24h 内命中
 *   「新鲜快照跳过 getItems」短路，卡片一直显示上一次的 count，而二级页现拉现算 → 两处不一致。
 * 契约：
 *   ① 快照须记 def.type；type 不符（片单数据源换了）→ 视为陈旧，重拉并回填真实计数
 *   ② 无 type 的历史快照（本次改动前写下的）→ 同样视为陈旧，用户端自愈无需清库
 *   ③ 同 type 且新鲜 → 仍走跳过路径（保住冷启动零请求）
 *   ④ 卡片计数与二级页 hero 计数须同源一致
 * 运行：node --test tests/home-collections-stale-snapshot.test.js
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
const SNAPSHOT_KEY = 'stellaflix-collection-cover-snapshot-v1';

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

function buildEnv(snapshotSeed) {
  const dom = new JSDOM(indexHtml, { url: 'http://localhost:3000/', pretendToBeVisual: true, runScripts: 'outside-only' });
  const win = dom.window;
  const requested = [];
  win.StellaflixVideo = {
    tmdb: {
      hasKey: () => true,
      // trending-week = tmdb-trending → 20 条；用于制造「快照 17 / 实拉 20」的陈旧差
      trending: () => Promise.resolve(makeItems(20, 'T')),
      popular: () => Promise.resolve(makeItems(20, 'P')),
      upcoming: () => Promise.resolve(makeItems(12, 'U')),
      discover: () => Promise.resolve(makeItems(20, 'D')),
      getCollection: () => Promise.resolve({ parts: makeItems(8, 'C') }),
      getDetails: (id) => Promise.resolve({ id, title: 'S' + id, year: 2010, poster: '', rating: 7 }),
      // 社区榜：真实全量 250 条（分页 bug 修复后）
      getList: (id) => Promise.resolve({ id, name: 'Top 250 IMDB', itemCount: 250, totalPages: 13, items: makeItems(20, 'L') }),
      getListAll: () => Promise.resolve({ itemCount: 250, items: makeItems(250, 'L') }),
      genreNames: () => '', regionLabel: () => '',
      getPosterColor: () => Promise.reject(new Error('COLOR_OFFLINE')),
    },
    online: { openDetailFromMeta() {} },
  };
  win.eval(collectionsSrc);
  if (snapshotSeed) win.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshotSeed));
  win.eval(overlaySrc);
  const realGetItems = win.StellaflixVideo.collections.getItems;
  win.StellaflixVideo.collections.getItems = function (def) {
    requested.push(def && def.id);
    return realGetItems(def);
  };
  const list = win.document.getElementById('home-video-collections-list');
  const click = (el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  const switchTab = (tab) => click(win.document.getElementById('home-video-collections-tabs')
    .querySelector('[data-wc-tab="' + tab + '"]'));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
  const snapshots = () => JSON.parse(win.localStorage.getItem(SNAPSHOT_KEY) || '{}');
  const countText = (id) => {
    const card = list.querySelector('[data-wc-id="' + id + '"] [data-wc-count]');
    return card ? card.textContent : null;
  };
  return { win, SFV: win.StellaflixVideo, requested, list, click, switchTab, settle, snapshots, countText };
}

const FRESH = { posters: ['https://img.example/OLD1.jpg'], count: 17, ts: Date.now() };

test('历史快照无 type（老格式）→ 视为陈旧：重拉并把卡片计数从 17 修正为实拉 20', async () => {
  const { SFV, requested, settle, countText, snapshots } = buildEnv({ 'trending-week': FRESH });
  assert.equal(countText('trending-week'), null, '前置：卡未渲染');
  SFV.homeCollectionsOverlay.open();
  await settle();
  assert.equal(requested.includes('trending-week'), true, '老格式快照须重拉');
  assert.equal(countText('trending-week'), '精选20部', '计数须为实拉条数');
  assert.equal(snapshots()['trending-week'].count, 20, '写回快照的 count 须为 20');
});

test('快照 type 与 def.type 不符（数据源换了）→ 陈旧重拉并写回新 type', async () => {
  const { SFV, requested, settle, countText, snapshots } = buildEnv({
    'trending-week': { posters: FRESH.posters, count: 17, ts: Date.now(), type: 'tmdb-discover' },
  });
  SFV.homeCollectionsOverlay.open();
  await settle();
  assert.equal(requested.includes('trending-week'), true, 'type 不符须重拉');
  assert.equal(countText('trending-week'), '精选20部');
  assert.equal(snapshots()['trending-week'].type, 'tmdb-trending', '写回须带当前 def.type');
});

test('同 type 且新鲜 → 仍跳过 getItems（冷启动零请求不回归），卡片沿用快照计数', async () => {
  const { SFV, requested, settle, countText } = buildEnv({
    'trending-week': { posters: FRESH.posters, count: 17, ts: Date.now(), type: 'tmdb-trending' },
  });
  SFV.homeCollectionsOverlay.open();
  await settle();
  assert.equal(requested.includes('trending-week'), false, '同 type 新鲜快照不得重拉');
  assert.equal(countText('trending-week'), '精选17部', '跳过路径下按快照计数显示');
});

test('陈旧修正后：卡片计数与二级页 hero 计数一致', async () => {
  const { SFV, settle, list, click, countText } = buildEnv({ 'trending-week': FRESH });
  SFV.homeCollectionsOverlay.open();
  await settle();
  const cardCount = countText('trending-week');
  click(list.querySelector('[data-wc-id="trending-week"]'));
  await settle();
  const hero = list.querySelector('.home-video-collections-hero-copy small');
  assert.ok(hero, '二级页 hero 应渲染');
  assert.equal(hero.textContent, '精选20部', '前置：二级页现拉现算=20');
  assert.equal(cardCount, hero.textContent, '两处计数须同源');
});

// ============================================================ 社区榜截断计数作废
// 09-27 实机反馈：IMDb Top250 / 奥斯卡 / AFI×2 四张社区榜卡显示「共20部」。
// 根因两层：① tmdb.getList 读不存在的 r.pages → 只拉第 1 页；
// ② 修好分页后，那期间写入的快照 type 相同又没过期 → 卡片会继续沿用 20 最长 24h。
// 契约：tmdb-list 快照须带分页修复标记，无标记即视为陈旧重拉一次（用户端自愈，无需清库）。

const LIST20 = { posters: ['https://img.example/L1.jpg'], count: 20, ts: Date.now(), type: 'tmdb-list' };

test('tmdb-list 旧快照（分页 bug 期间写入的 20）→ 视为陈旧：重拉并修正为共250部', async () => {
  const { SFV, switchTab, settle, requested, countText, snapshots } = buildEnv({ 'list-imdb250': LIST20 });
  SFV.homeCollectionsOverlay.open();
  switchTab('lists');
  for (let i = 0; i < 40 && countText('list-imdb250') !== '共250部'; i++) await settle();
  assert.equal(requested.includes('list-imdb250'), true, '无修复标记的社区榜快照须重拉');
  assert.equal(countText('list-imdb250'), '共250部', '计数须为全量 250');
  assert.ok(snapshots()['list-imdb250'].fullMark, '写回快照须带分页修复标记');
});

test('带修复标记且新鲜 → 仍跳过 getItems（冷启动零请求不回归）', async () => {
  const { SFV, switchTab, settle, requested, countText } = buildEnv({
    'list-imdb250': Object.assign({}, LIST20, { count: 250, fullMark: 'v2' }),
  });
  SFV.homeCollectionsOverlay.open();
  switchTab('lists');
  await settle();
  assert.equal(requested.includes('list-imdb250'), false, '同 type + 带标记 + 新鲜不得重拉');
  assert.equal(countText('list-imdb250'), '共250部');
});
