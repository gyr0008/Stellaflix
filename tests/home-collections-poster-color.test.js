'use strict';

/**
 * 精选片单封面卡「色温跟随首张海报」（用户 2026-09-25 裁定）
 *   卡片封面场域底色 --wc-warm 不再只用 CATALOG 手挑色，
 *   改由首张海报平均色（/api/image-color → tmdb.getPosterColor → collections 缓存 → overlay 快照）驱动。
 * 契约：
 *   ① collections.getPosterColor(poster)：同 URL 复用缓存 promise；失败不进缓存
 *   ② overlay：快照带 color → cardHtml 即时回填；新鲜无 color → 只补色不重拉 getItems；
 *      过期 → getItems 后补色并写回快照
 *   ③ color 必须是 #hex 才生效（快照被篡改也不注入样式）
 * 运行：node --test tests/home-collections-poster-color.test.js
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
  const color = { calls: [], impl: () => Promise.resolve('#ff0000') };
  win.StellaflixVideo = {
    tmdb: {
      hasKey: () => true,
      // mediaType 区分双 trending 卡，海报前缀不撞（T=movie / TV=tv）
      trending: (mt) => { calls.trending += 1; return Promise.resolve(makeItems(20, mt === 'tv' ? 'TV' : 'T')); },
      popular: () => { calls.popular += 1; return Promise.resolve(makeItems(20, 'P')); },
      upcoming: () => { calls.upcoming += 1; return Promise.resolve(makeItems(12, 'U')); },
      discover: () => { calls.discover += 1; return Promise.resolve(makeItems(20, 'D')); },
      getCollection: () => { calls.getCollection += 1; return Promise.resolve({ parts: makeItems(8, 'C') }); },
      getDetails: (id) => { calls.getDetails += 1; return Promise.resolve({ id, title: 'S' + id, year: 2010, poster: 'https://img.example/s' + id + '.jpg' }); },
      genreNames: () => '',
      regionLabel: () => '',
      getPosterColor: (p) => { color.calls.push(p); return color.impl(p); },
    },
    online: { openDetailFromMeta() {} },
  };
  win.eval(collectionsSrc);
  win.eval(overlaySrc);
  // 包一层记录「哪些片单真的走了 getItems」，隔离同 tab 其他卡的干扰
  const requested = [];
  const realGetItems = win.StellaflixVideo.collections.getItems;
  win.StellaflixVideo.collections.getItems = function (def) {
    requested.push(def && def.id);
    return realGetItems(def);
  };
  const list = win.document.getElementById('home-video-collections-list');
  const click = (el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
  const snapshots = () => JSON.parse(win.localStorage.getItem(SNAPSHOT_KEY) || '{}');
  const warmOf = (id) => {
    const card = list.querySelector('[data-wc-id="' + id + '"]');
    return card ? (card.getAttribute('style') || '') : null;
  };
  return { win, SFV: win.StellaflixVideo, calls, color, requested, list, click, settle, snapshots, warmOf };
}

// ==================================================== collections 缓存层

test('collections.getPosterColor 存在且同 URL 复用缓存（tmdb 只调一次）', async () => {
  const { SFV, color } = buildEnv();
  assert.equal(typeof SFV.collections.getPosterColor, 'function', '须导出 getPosterColor');
  const a = await SFV.collections.getPosterColor('https://img.example/x1.jpg');
  const b = await SFV.collections.getPosterColor('https://img.example/x1.jpg');
  assert.equal(a, '#ff0000');
  assert.equal(b, '#ff0000');
  assert.equal(color.calls.length, 1, '第二次须命中缓存');
});

test('getPosterColor 失败不进缓存：下次调用重发', async () => {
  const { SFV, color } = buildEnv();
  color.impl = () => Promise.reject(new Error('TMDB_KEY_REQUIRED'));
  await assert.rejects(() => SFV.collections.getPosterColor('https://img.example/y.jpg'));
  color.impl = () => Promise.resolve('#0a0b0c');
  const c = await SFV.collections.getPosterColor('https://img.example/y.jpg');
  assert.equal(c, '#0a0b0c');
  assert.equal(color.calls.length, 2, '失败不得占用缓存位');
});

// ==================================================== overlay 回填路径

test('快照新鲜且带 color：cardHtml 即时回填 --wc-warm，零 getItems、零取色请求', async () => {
  const { SFV, color, requested, warmOf, win, settle } = buildEnv();
  win.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({
    'trending-week': { posters: ['https://img.example/T1.jpg'], count: 20, ts: Date.now(), color: '#123456' },
  }));
  SFV.homeCollectionsOverlay.open();
  await settle();
  assert.match(warmOf('trending-week'), /--wc-warm:\s*#123456/);
  assert.equal(requested.includes('trending-week'), false, '新鲜快照不得重拉该列表');
  assert.equal(color.calls.includes('https://img.example/T1.jpg'), false, '已有 color 不得再取色');
});

test('快照新鲜但无 color（旧格式）：只补色一次并写回快照，不重拉 getItems', async () => {
  const { SFV, color, requested, warmOf, win, settle, snapshots } = buildEnv();
  win.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({
    'trending-week': { posters: ['https://img.example/T1.jpg', 'https://img.example/T2.jpg'], count: 20, ts: Date.now() },
  }));
  SFV.homeCollectionsOverlay.open();
  await settle();
  assert.equal(requested.includes('trending-week'), false, '补色路径不得重拉列表');
  assert.equal(color.calls.includes('https://img.example/T1.jpg'), true, '须按首张海报取色');
  assert.match(warmOf('trending-week'), /--wc-warm:\s*#ff0000/);
  assert.equal(snapshots()['trending-week'].color, '#ff0000', 'color 须写回快照');
});

test('过期快照：getItems 后按首条目海报补色，写回快照并更新卡样式', async () => {
  const { SFV, color, requested, warmOf, win, settle, snapshots } = buildEnv();
  win.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({
    'trending-week': { posters: ['https://img.example/OLD.jpg'], count: 20, ts: Date.now() - 25 * 3600 * 1000, color: '#999999' },
  }));
  SFV.homeCollectionsOverlay.open();
  await settle();
  assert.equal(requested.includes('trending-week'), true, '过期快照须重拉列表');
  assert.equal(color.calls.includes('https://img.example/T1.jpg'), true, '刷新后须按新首海报取色');
  assert.equal(snapshots()['trending-week'].color, '#ff0000');
  assert.match(warmOf('trending-week'), /--wc-warm:\s*#ff0000/);
});

test('取色失败静默：卡片保持 CATALOG warm 兜底色', async () => {
  const { SFV, color, warmOf, win, settle } = buildEnv();
  color.impl = () => Promise.reject(new Error('COLOR_UPSTREAM_DOWN'));
  SFV.homeCollectionsOverlay.open();
  await settle();
  assert.match(warmOf('trending-week'), /--wc-warm:\s*#e74c3c/, '须保持 CATALOG warm');
});

test('快照 color 被篡改为非 #hex：不得注入卡样式（XSS 防线）', async () => {
  const { SFV, color, warmOf, win, settle } = buildEnv();
  color.impl = () => Promise.reject(new Error('COLOR_OFFLINE')); // 补色也不成功 → 只能回落 CATALOG
  win.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({
    'trending-week': { posters: ['https://img.example/T1.jpg'], count: 20, ts: Date.now(), color: 'red;background:url(x)' },
  }));
  SFV.homeCollectionsOverlay.open();
  await settle();
  const style = warmOf('trending-week');
  assert.equal(style.includes('red;background'), false, '非法 color 不得进 style');
  assert.match(style, /--wc-warm:\s*#e74c3c/, '回落后须用 CATALOG warm');
});
