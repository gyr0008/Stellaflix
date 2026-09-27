'use strict';

/**
 * 封面补拉并发限流（2026-09-26 年度动画卡批的连带后果）
 * 背景：lists tab 由 16 张卡涨到 40 张（+25 年度动画卡），09-27 大榜拆段后再涨到 49 张。fillCovers 原本对 tab 内每张
 *   无新鲜快照的卡同步发起 getItems + getPosterColor（每卡 ≈2 个上游请求），
 *   冷开一个 tab 即 80 个并发 → TMDB 限流（429）与本机代理排队，反而更慢。
 * 契约：
 *   ① 同时在途的封面链 ≤ 4（小并发，不是全量并发）
 *   ② 限流不得饿死：所有卡最终都补到封面/计数，调用总数 = 卡数（每卡一次）
 *   ③ 单卡失败不得卡死队列（后续卡照常补）
 * 运行：node --test tests/home-collections-cover-queue.test.js
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

function makeItems(n, prefix) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: i + 1, mediaType: 'movie', title: prefix + (i + 1), year: 2020,
      poster: 'https://img.example/' + prefix + (i + 1) + '.jpg',
      rating: 7, overview: '', backdrop: '', genreIds: [16], originalLanguage: 'ja',
    });
  }
  return out;
}

// latency 内可注入延迟，便于观测「在途」峰值
// lists 49 卡（09-27 大榜拆段后）+ open() 时首屏 featured 3 卡（切 tab 前已发起）
const ALL_CHAINS = 52;

function buildEnv(opts) {
  const o = opts || {};
  const dom = new JSDOM(indexHtml, { url: 'http://localhost:3000/', pretendToBeVisual: true, runScripts: 'outside-only' });
  const win = dom.window;
  const stat = { items: 0, color: 0, inflight: 0, maxInflight: 0 };
  win.StellaflixVideo = {
    tmdb: {
      hasKey: () => true,
      trending: () => Promise.resolve(makeItems(20, 'T')),
      popular: () => Promise.resolve(makeItems(20, 'P')),
      upcoming: () => Promise.resolve(makeItems(12, 'U')),
      discover: () => Promise.resolve(makeItems(20, 'D')),
      discoverAll: () => Promise.resolve(makeItems(20, 'DA')),
      discoverRank: (q, rankFrom, count) => Promise.resolve(makeItems(count, 'R' + rankFrom)),
      getCollection: () => Promise.resolve({ parts: makeItems(8, 'C') }),
      getListAll: () => Promise.resolve({ items: makeItems(20, 'L') }),
      getDetails: (id) => Promise.resolve({ id, title: 'S' + id, year: 2010, poster: 'https://img.example/s' + id + '.jpg', rating: 7 }),
      genreNames: () => '', regionLabel: () => '',
      getPosterColor: () => Promise.resolve('#112233'),
    },
    online: { openDetailFromMeta() {} },
  };
  win.eval(collectionsSrc);
  const SFV = win.StellaflixVideo;
  const realGetItems = SFV.collections.getItems;
  SFV.collections.getItems = function (def) {
    stat.items += 1;
    stat.inflight += 1;
    if (stat.inflight > stat.maxInflight) stat.maxInflight = stat.inflight;
    return new Promise((resolve) => {
      setTimeout(() => {
        stat.inflight -= 1;
        if (o.failIds && o.failIds.includes(def.id)) { resolve([]); return; }
        resolve(realGetItems(def));
      }, o.latency || 4);
    });
  };
  win.eval(overlaySrc);
  const list = win.document.getElementById('home-video-collections-list');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const switchTab = async (tab) => {
    const bar = win.document.getElementById('home-video-collections-tabs');
    bar.querySelector('[data-wc-tab="' + tab + '"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await sleep(2);
  };
  const cards = () => list.querySelectorAll('.home-video-collections-grid [data-wc-id]');
  const covered = () => list.querySelectorAll('.home-video-collections-grid img').length;
  return { win, SFV, stat, list, sleep, switchTab, cards, covered };
}

test('lists tab 冷开 49 卡：封面链在途峰值 ≤ 4', async () => {
  const { SFV, stat, sleep, switchTab, cards } = buildEnv({ latency: 6 });
  assert.equal(cards().length, 0);
  SFV.homeCollectionsOverlay.open();
  await switchTab('lists');
  assert.equal(cards().length, 49, 'lists tab 须渲染 49 张卡');
  await sleep(120);
  assert.ok(stat.items >= 8, '前置：确已在补封面（已发起 ' + stat.items + ' 次）');
  assert.ok(stat.maxInflight <= 4, '在途封面链须 ≤ 4，实测 ' + stat.maxInflight);
});

test('限流不饿死：49 卡全部补到封面图与计数', async () => {
  const { SFV, stat, sleep, switchTab, covered, list } = buildEnv({ latency: 3 });
  SFV.homeCollectionsOverlay.open();
  await switchTab('lists');
  // open() 先渲染 featured tab，切到 lists 前那 3 张推荐卡的链也已在途 → 总请求 = 49 + 3
  const target = 49 * 3;
  for (let i = 0; i < 80 && covered() < target; i++) await sleep(20);
  assert.equal(covered(), target, '49 卡 × 3 张叠卡封面须全部回填');
  assert.equal(stat.items, ALL_CHAINS, '每卡恰一次 getItems（含年度卡 limit 单页），实测 ' + stat.items);
  const sub = list.querySelectorAll('.home-video-collections-grid .home-video-collections-count-sub');
  assert.equal(sub.length, 0, '计数位不得停留在副标题兜底态');
});

test('单卡空结果不卡队列：其余卡照常补完', async () => {
  const { SFV, stat, sleep, switchTab, covered } = buildEnv({ latency: 3, failIds: ['anim-top-2002', 'anim-top-2003', 'anim-top-2004'] });
  SFV.homeCollectionsOverlay.open();
  await switchTab('lists');
  const target = 46 * 3;
  for (let i = 0; i < 80 && covered() < target; i++) await sleep(20);
  assert.equal(covered(), target, '空结果卡不叠封面，其余 46 卡照补');
  assert.equal(stat.items, ALL_CHAINS, '3 张空结果卡后仍须跑完全部卡');
});
