'use strict';

/**
 * 回归测试（2026-10-01 需求）：精选片单浮层 4 个 tab（推荐/系列/榜单/类型）的滚动位置必须独立记录。
 *
 * 缺陷现象：4 个 tab 共用同一个滚动容器 #home-video-collections-list，切 tab 走 innerHTML 整体替换，
 * 而浏览器不会因 innerHTML 替换重置 scrollTop → 从「系列」滚到第 3 屏切「榜单」仍停在同一位置
 * （滚轮相互泄露）。
 *
 * 契约：
 *  A. 切 tab 时先把当前容器 scrollTop 记到「旧 tab」名下，渲染后回填「新 tab」自己的记录；
 *  B. 每个 tab 的记录互不影响：A 记的值不会出现在 B，切回 A 能精确复原；
 *  C. 记录值不回写浏览器 clamp 结果 —— 这是「独立记录」相对「共用 scrollTop」的关键差异；
 *  D. 整窗重开按原语义回顶（清空全部 tab 记录，不跨次持久化）；
 *  E. 进二级页前记到当前 tab，返回时由 renderList 按当前 tab 还原（替代旧 listScroll 单值语义）；
 *  F. 源码内不得残留 listScroll 单值字段。
 *
 * 说明：jsdom 不实现布局（scrollHeight/clientHeight 均为 0），scrollTop 是自由可读写的普通属性，
 * 因此本测试校验的是「记录与回填的逻辑正确性」；真实浏览器里的 min(内容高度) 钳制由浏览器承担，
 * 且正因钳制只发生在赋值那一刻、记录值不被覆盖，切回长内容 tab 时位置才不会丢。
 *
 * 运行：node --test tests/home-collections-tab-scroll.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const indexHtml = read('public/index.html');
const collectionsSrc = read('public/video/collections.js');
const overlaySrc = read('public/video/home-collections-overlay.js');

const TABS = ['featured', 'series', 'lists', 'genres'];

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
  const dom = new JSDOM(indexHtml, {
    url: 'http://localhost:3000/',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const win = dom.window;
  win.StellaflixVideo = {
    tmdb: {
      hasKey: () => true,
      trending: () => Promise.resolve(makeItems(20, 'T')),
      popular: () => Promise.resolve(makeItems(20, 'P')),
      upcoming: () => Promise.resolve(makeItems(12, 'U')),
      discover: () => Promise.resolve(makeItems(20, 'D')),
      getCollection: () => Promise.resolve({ parts: makeItems(8, 'C') }),
      getList: () => Promise.resolve(makeItems(20, 'L')),
      getListAll: () => Promise.resolve(makeItems(20, 'L')),
      getDetails: (id) => Promise.resolve({
        id, title: 'S' + id, year: 2010, poster: 'https://img.example/s' + id + '.jpg',
      }),
      genreNames: () => '',
      regionLabel: () => '',
    },
    online: { setDetailOrigin() {}, openDetailFromMeta() {} },
  };
  win.eval(collectionsSrc);
  win.eval(overlaySrc);

  const doc = win.document;
  const mask = doc.getElementById('home-video-collections-mask');
  const list = doc.getElementById('home-video-collections-list');
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const click = (el) => el.dispatchEvent(
    new win.MouseEvent('click', { bubbles: true, cancelable: true }),
  );
  const tabEl = (id) => doc.getElementById('home-video-collections-tab-' + id);
  const switchTab = (id) => {
    const el = tabEl(id);
    assert.ok(el, `tab 按钮 ${id} 须存在于 DOM`);
    click(el);
  };
  // 读私有记录表：state 闭包不可达，改由行为反推（见各用例断言）
  return { win, doc, SFV: win.StellaflixVideo, mask, list, settle, click, tabEl, switchTab };
}

test('A 切 tab 不泄露：新 tab 从顶部开始，不继承上一个 tab 的滚动位置', async () => {
  const env = buildEnv();
  env.SFV.homeCollectionsOverlay.open();
  assert.ok(env.list.querySelector('[data-wc-id]'), '推荐 tab 应有片单卡');

  env.list.scrollTop = 480; // 模拟用户在「推荐」向下滚动
  env.switchTab('series');
  assert.strictEqual(env.list.scrollTop, 0, '「系列」必须从顶部开始，不得继承「推荐」的 480');

  env.list.scrollTop = 220; // 在「系列」滚动
  env.switchTab('lists');
  assert.strictEqual(env.list.scrollTop, 0, '「榜单」必须从顶部开始，不得继承「系列」的 220');

  env.list.scrollTop = 900;
  env.switchTab('genres');
  assert.strictEqual(env.list.scrollTop, 0, '「类型」必须从顶部开始，不得继承「榜单」的 900');
});

test('B 每个 tab 独立记忆：切回时各自精确复原，互不串位', async () => {
  const env = buildEnv();
  env.SFV.homeCollectionsOverlay.open();

  env.list.scrollTop = 480;
  env.switchTab('series');
  env.list.scrollTop = 220;
  env.switchTab('lists');
  env.list.scrollTop = 900;
  env.switchTab('genres');
  env.list.scrollTop = 60;

  // 逆序切回，逐个校验
  env.switchTab('lists');
  assert.strictEqual(env.list.scrollTop, 900, '「榜单」须复原到 900');
  env.switchTab('series');
  assert.strictEqual(env.list.scrollTop, 220, '「系列」须复原到 220');
  env.switchTab('featured');
  assert.strictEqual(env.list.scrollTop, 480, '「推荐」须复原到 480');
  env.switchTab('genres');
  assert.strictEqual(env.list.scrollTop, 60, '「类型」须复原到 60');
});

test('C 记录值不被覆盖：在短内容 tab 上浏览器钳到 0 后，切回长内容 tab 位置仍在', async () => {
  const env = buildEnv();
  env.SFV.homeCollectionsOverlay.open();

  env.list.scrollTop = 700;
  env.switchTab('series');
  assert.strictEqual(env.list.scrollTop, 0, '「系列」首访从顶部开始');

  // 模拟真实浏览器在「系列」里往下滚（此时并不等于「推荐」的 700）
  env.list.scrollTop = 130;
  env.switchTab('featured');
  assert.strictEqual(env.list.scrollTop, 700, '「推荐」的 700 不得被「系列」的 130 覆盖');

  env.switchTab('series');
  assert.strictEqual(env.list.scrollTop, 130, '「系列」的 130 也不得被「推荐」的 700 覆盖');
});

test('D 整窗重开按原语义回顶：全部 tab 记录清零', async () => {
  const env = buildEnv();
  env.SFV.homeCollectionsOverlay.open();
  env.list.scrollTop = 640;
  env.switchTab('lists');
  env.list.scrollTop = 320;

  env.SFV.homeCollectionsOverlay.close();
  env.SFV.homeCollectionsOverlay.open();
  assert.strictEqual(env.list.scrollTop, 0, '重开后当前 tab 须回顶');

  // 旧的 640 / 320 也不得被恢复
  env.switchTab('featured');
  assert.strictEqual(env.list.scrollTop, 0, '重开后「推荐」的旧记录 640 须已清除');
  env.switchTab('lists');
  assert.strictEqual(env.list.scrollTop, 0, '重开后「榜单」的旧记录 320 须已清除');
});

test('E 二级页往返：返回后还原到「当前 tab」自己的一级位置，而非全局单值', async () => {
  const env = buildEnv();
  env.SFV.homeCollectionsOverlay.open();

  // 在「推荐」留一个位置，切到「系列」再留一个，最后在「系列」进二级页
  env.list.scrollTop = 500;
  env.switchTab('series');
  env.list.scrollTop = 260;

  const card = env.list.querySelector('[data-wc-id]');
  assert.ok(card, '「系列」下应有片单卡');
  env.click(card);
  assert.strictEqual(env.list.scrollTop, 0, '二级页须强制回顶');
  await env.settle();
  assert.ok(env.list.querySelector('[data-wc-item]'), '二级页应渲染条目');

  const back = env.list.querySelector('[data-wc-back]');
  assert.ok(back, '二级页应有返回按钮');
  env.click(back);
  assert.strictEqual(env.list.scrollTop, 260, '返回须还原「系列」的 260，不得用「推荐」的 500');
  assert.ok(!env.doc.querySelector('.home-video-collections--detail'), '返回后应退出一级 tab 态');

  env.switchTab('featured');
  assert.strictEqual(env.list.scrollTop, 500, '「推荐」的位置在二级页往返后仍须独立保留');
});

test('F 源码契约：listScroll 单值字段已移除，独立记录函数齐备', () => {
  const fn = (name) => {
    const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(overlaySrc);
    assert.ok(m, `expected ${name}()`);
    return m;
  };
  fn('rememberTabScroll');
  fn('restoreTabScroll');
  fn('resetTabScroll');

  assert.equal(
    /state\.listScroll|listScroll\s*:/.test(overlaySrc),
    false,
    '旧 listScroll 单值字段须彻底移除（改由 tabScroll 按 tab 记录）',
  );
  assert.match(overlaySrc, /tabScroll:\s*Object\.create\(null\)/, 'state 须含 tabScroll 记录表');
  // 切 tab 必须「先记旧、后渲染新」
  const clickBlock = /tabsBar\.addEventListener\('click'[\s\S]*?\n    \}\);/.exec(overlaySrc);
  assert.ok(clickBlock, 'expected tabsBar click handler');
  assert.match(clickBlock[0], /rememberTabScroll\(\)[\s\S]*?renderList\(\)/, '切 tab 须先 rememberTabScroll 再 renderList');
  // renderList 末尾必须回填，覆盖 打开/切 tab/二级页返回 全部渲染路径
  const renderListBody = /function\s+renderList\s*\([\s\S]*?\n  \}/.exec(overlaySrc);
  assert.ok(renderListBody, 'expected renderList()');
  assert.match(renderListBody[0], /restoreTabScroll\(\)/, 'renderList 须在渲染后回填当前 tab 位置');
});

test('G 视觉零改动：本次修复不触碰 index.css 与 index.html 结构', () => {
  const css = read('public/css/index.css');
  assert.match(css, /\.home-video-collections-list\s*\{[^}]*overflow-y:\s*auto/, '滚动容器仍是同一个 list（未新增容器）');
  // tabpanel 数量不变：仍然是单一 role="tabpanel"
  const panels = indexHtml.match(/id="home-video-collections-list"/g) || [];
  assert.strictEqual(panels.length, 1, '未新增 per-tab 容器（DOM 结构不变）');
});

void TABS;
