'use strict';

/**
 * 精选片单 P1 三项修复（2026-09-25 审查结论）
 *   1. 占位片单点击不再暴露 UNKNOWN_TYPE_placeholder 错误码，显示「即将上线」
 *   2. 计数语义：分页型片单（trending/popular/upcoming/discover 只取第 1 页）
 *      文案为「精选N部」；完整型片单（tmdb-collection/static-list）保持「共N部」
 *   3. collections.getItems 加内存缓存：同一片单重复打开/切 tab 不再逐条重发 TMDB 请求
 *
 * 策略：jsdom 解析真实 index.html（拿真实弹窗壳），win.eval 真实
 *      collections.js + home-collections-overlay.js，仅桩 SFV.tmdb 并计调用次数。
 * 运行：node --test tests/home-collections-p1-fixes.test.js
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
      rating: 7, overview: '', backdrop: '', genreIds: [28], originalLanguage: 'en',
    });
  }
  return out;
}

function buildEnv() {
  const dom = new JSDOM(indexHtml, { url: 'http://localhost:3000/', pretendToBeVisual: true, runScripts: 'outside-only' });
  const win = dom.window;
  const calls = { trending: 0, popular: 0, upcoming: 0, discover: 0, getCollection: 0, getDetails: 0 };
  const flags = { hasKey: true };
  win.StellaflixVideo = {
    tmdb: {
      hasKey: () => flags.hasKey,
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
  const totalCalls = () => Object.keys(calls).reduce((s, k) => s + calls[k], 0);
  const click = (el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const settle = async () => { await tick(); await tick(); await tick(); };
  return { win, SFV: win.StellaflixVideo, calls, flags, list, totalCalls, click, settle };
}

// ============================================================ 1. 占位片单

test('点占位片单显示「即将上线」，不暴露 UNKNOWN_TYPE 且零请求', async () => {
  const { SFV, list, click, totalCalls, settle } = buildEnv();
  SFV.homeCollectionsOverlay.open();
  click(list.ownerDocument.getElementById('home-video-collections-tabs').querySelector('[data-wc-tab="awards"]'));
  await settle();
  const card = list.querySelector('[data-wc-id="awards-cn-placeholder"]');
  assert.ok(card, '获奖 tab 应渲染占位片单卡');
  const before = totalCalls();
  click(card);
  await settle();
  assert.equal(list.innerHTML.includes('UNKNOWN_TYPE'), false, '二级页不得出现 UNKNOWN_TYPE 错误码');
  assert.match(list.innerHTML, /即将上线/);
  assert.equal(totalCalls(), before, '占位片单不得发起 getItems 请求');
  SFV.homeCollectionsOverlay.close();
});

// ============================================================ 2. 计数语义

test('分页型片单封面卡计数文案为「精选N部」', async () => {
  const { SFV, list, settle } = buildEnv();
  SFV.homeCollectionsOverlay.open();
  await settle();
  const el = list.querySelector('[data-wc-id="trending-week"] [data-wc-count]');
  assert.ok(el, 'trending-week 卡应渲染计数位');
  assert.equal(el.textContent, '精选20部');
});

test('完整型片单（tmdb-collection）计数保持「共N部」', async () => {
  const { SFV, list, click, settle } = buildEnv();
  SFV.homeCollectionsOverlay.open();
  click(list.ownerDocument.getElementById('home-video-collections-tabs').querySelector('[data-wc-tab="theme"]'));
  await settle();
  const el = list.querySelector('[data-wc-id="coll-mcu"] [data-wc-count]');
  assert.ok(el, 'theme tab 应渲染 coll-mcu 卡');
  assert.equal(el.textContent, '共8部');
});

test('二级页 hero 计数与封面卡同语义（分页型=精选N部）', async () => {
  const { SFV, list, click, settle } = buildEnv();
  SFV.homeCollectionsOverlay.open();
  await settle();
  click(list.querySelector('[data-wc-id="trending-week"]'));
  await settle();
  const hero = list.querySelector('.home-video-collections-hero-copy small');
  assert.ok(hero, '二级页 hero 应渲染计数');
  assert.equal(hero.textContent, '精选20部');
});

// ============================================================ 3. getItems 缓存

test('同一片单二次 getItems 只发一次 TMDB 请求', async () => {
  const { SFV, calls } = buildEnv();
  const def = SFV.collections.getByTab('featured').find((d) => d.id === 'trending-week');
  const a = await SFV.collections.getItems(def);
  const b = await SFV.collections.getItems(def);
  assert.equal(calls.trending, 1, '第二次须命中缓存');
  assert.equal(a.length, 20);
  assert.equal(b.length, 20);
});

test('并发 getItems 共享同一在途请求', async () => {
  const { SFV, calls } = buildEnv();
  const def = SFV.collections.getByTab('featured').find((d) => d.id === 'popular-movies');
  const [a, b] = await Promise.all([SFV.collections.getItems(def), SFV.collections.getItems(def)]);
  assert.equal(calls.popular, 1, '在途 promise 须复用');
  assert.equal(a.length, 20);
  assert.equal(b.length, 20);
});

test('失败不进缓存：配置 Key 后下次调用可成功', async () => {
  const { SFV, calls, flags } = buildEnv();
  const def = SFV.collections.getByTab('featured').find((d) => d.id === 'upcoming');
  flags.hasKey = false;
  await assert.rejects(() => SFV.collections.getItems(def), /TMDB_KEY_REQUIRED/);
  flags.hasKey = true;
  const items = await SFV.collections.getItems(def);
  assert.equal(items.length, 12);
  assert.equal(calls.upcoming, 1, '失败不得占用缓存位');
});

test('重开浮层不再逐卡重发请求（缓存贯穿 fillCovers）', async () => {
  const { SFV, calls, settle } = buildEnv();
  SFV.homeCollectionsOverlay.open();
  await settle();
  const afterFirst = calls.trending + calls.popular + calls.upcoming + calls.discover;
  SFV.homeCollectionsOverlay.close();
  SFV.homeCollectionsOverlay.open();
  await settle();
  const afterSecond = calls.trending + calls.popular + calls.upcoming + calls.discover;
  assert.equal(afterSecond, afterFirst, '第二次打开须全部命中缓存');
  assert.ok(afterFirst > 0, '第一次打开确实发过请求');
});
