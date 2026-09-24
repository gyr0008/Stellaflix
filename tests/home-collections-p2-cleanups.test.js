'use strict';

/**
 * 精选片单 P2 清理（2026-09-25 审查结论）
 *   1. P2-1 collections.js 死导出：TABS/getTabs/getPosters 零调用方 + calendar 条目
 *      永不被 getByTab 触达（浮层 tab 源是 OVERLAY_TABS；每周新番走 openCalendar），删除
 *   2. P2-2 快照 count 篡改不进 innerHTML（上一轮 countLabel Number 化已修，此处锚定）
 *   3. P2-3 快照 ts 用起来：24h 内新鲜快照跳过 fillCovers，冷启动不再逐卡重发请求
 *
 * 运行：node --test tests/home-collections-p2-cleanups.test.js
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

function buildEnv() {
  const dom = new JSDOM(indexHtml, { url: 'http://localhost:3000/', pretendToBeVisual: true, runScripts: 'outside-only' });
  const win = dom.window;
  const calls = { trending: 0, popular: 0, upcoming: 0, discover: 0, getCollection: 0, getDetails: 0 };
  win.StellaflixVideo = {
    tmdb: {
      hasKey: () => true,
      trending: () => { calls.trending += 1; return Promise.resolve(makeItems(20, 'T')); },
      popular: () => { calls.popular += 1; return Promise.resolve(makeItems(20, 'P')); },
      upcoming: () => { calls.upcoming += 1; return Promise.resolve(makeItems(12, 'U')); },
      discover: () => { calls.discover += 1; return Promise.resolve(makeItems(20, 'D')); },
      getCollection: () => { calls.getCollection += 1; return Promise.resolve({ parts: makeItems(8, 'C') }); },
      getDetails: (id) => { calls.getDetails += 1; return Promise.resolve({ id, title: 'S' + id, year: 2010, poster: 'https://img.example/s' + id + '.jpg' }); },
      genreNames: () => '',
      regionLabel: () => '',
    },
    online: { openDetailFromMeta() {} },
  };
  win.eval(collectionsSrc);
  win.eval(overlaySrc);
  const list = win.document.getElementById('home-video-collections-list');
  const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };
  return { win, SFV: win.StellaflixVideo, calls, list, settle };
}

// featured tab 四个分页型片单（fillCovers 冷启动会逐卡发请求）
const FEATURED_IDS = ['trending-week', 'trending-tv-week', 'popular-movies', 'upcoming'];
function seedSnapshots(win, ts) {
  const snaps = {};
  FEATURED_IDS.forEach((id) => {
    snaps[id] = { posters: ['https://img.example/seed-' + id + '.jpg'], count: 20, ts: ts };
  });
  win.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snaps));
}

// ============================================================ P2-1 死导出清理

test('collections.js 死导出清理：TABS/getTabs/getPosters/calendar 条目已删除', () => {
  assert.equal(collectionsSrc.includes('getTabs'), false, 'getTabs 零调用方，须删除');
  assert.equal(collectionsSrc.includes('getPosters'), false, 'getPosters 零调用方，须删除');
  assert.equal(collectionsSrc.includes('var TABS'), false, 'TABS 与 OVERLAY_TABS 双份漂移，须删除');
  assert.equal(collectionsSrc.includes("{ id: 'calendar'"), false, 'calendar 条目永不被 getByTab 触达，须删除');
});

// ============================================================ P2-2 计数防篡改锚定

test('快照 count 被篡改为 HTML 串时不注入 innerHTML（回退 def.sub 文案）', async () => {
  const { win, SFV, list, settle } = buildEnv();
  win.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({
    'trending-week': { posters: [], count: '<b>xss</b>', ts: Date.now() },
  }));
  SFV.homeCollectionsOverlay.open();
  await settle();
  assert.equal(list.querySelector('b'), null, '篡改的 count 不得成为真实节点');
  const el = list.querySelector('[data-wc-id="trending-week"] [data-wc-count]');
  // 非法计数 → countLabel 拒绝（首屏回退 def.sub），随后合法刷新覆盖为「精选20部」；两者都不含脏串
  assert.equal(el.textContent.includes('xss'), false, '篡改串不得出现在计数位');
});

// ============================================================ P2-3 快照 TTL

test('24h 内新鲜快照：打开浮层零请求', async () => {
  const { win, SFV, calls, settle } = buildEnv();
  seedSnapshots(win, Date.now());
  SFV.homeCollectionsOverlay.open();
  await settle();
  const total = calls.trending + calls.popular + calls.upcoming + calls.discover;
  assert.equal(total, 0, '新鲜快照在场时 fillCovers 须跳过 getItems');
});

test('新鲜快照：卡片直接按快照渲染「精选N部」', async () => {
  const { win, SFV, list, settle } = buildEnv();
  seedSnapshots(win, Date.now());
  SFV.homeCollectionsOverlay.open();
  await settle();
  const el = list.querySelector('[data-wc-id="trending-week"] [data-wc-count]');
  assert.equal(el.textContent, '精选20部');
});

test('过期快照（>24h）：照常逐卡补封面', async () => {
  const { win, SFV, calls, settle } = buildEnv();
  seedSnapshots(win, Date.now() - 25 * 3600 * 1000);
  SFV.homeCollectionsOverlay.open();
  await settle();
  assert.ok(calls.trending >= 1, '过期快照不得阻止刷新');
});
