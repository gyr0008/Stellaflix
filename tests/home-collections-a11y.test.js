'use strict';

/**
 * 精选片单浮层 P3-1 无障碍补全（2026-09-25 审查结论）
 *   1. tab 按钮：role="tab" + aria-selected（此前只有 aria-current，tablist 语义不完整）
 *   2. 列表容器：role="tabpanel"（index.html）+ aria-labelledby 指向当前 tab
 *   3. 焦点陷阱：aria-modal="true" 承诺兑现——Tab/Shift+Tab 循环不出浮层
 *
 * 运行：node --test tests/home-collections-a11y.test.js
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
  win.StellaflixVideo = {
    tmdb: {
      hasKey: () => true,
      trending: () => Promise.resolve(makeItems(20, 'T')),
      popular: () => Promise.resolve(makeItems(20, 'P')),
      upcoming: () => Promise.resolve(makeItems(12, 'U')),
      discover: () => Promise.resolve(makeItems(20, 'D')),
      getCollection: () => Promise.resolve({ parts: makeItems(8, 'C') }),
      getDetails: (id) => Promise.resolve({ id, title: 'S' + id, year: 2010, poster: 'https://img.example/s' + id + '.jpg' }),
      genreNames: () => '',
      regionLabel: () => '',
    },
    online: { openDetailFromMeta() {} },
  };
  win.eval(collectionsSrc);
  win.eval(overlaySrc);
  const doc = win.document;
  const mask = doc.getElementById('home-video-collections-mask');
  const tabsBar = doc.getElementById('home-video-collections-tabs');
  const list = doc.getElementById('home-video-collections-list');
  const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };
  const pressTab = (shift) => doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Tab', shiftKey: !!shift, bubbles: true, cancelable: true }));
  return { win, doc, SFV: win.StellaflixVideo, mask, tabsBar, list, settle, pressTab };
}

test('tab 按钮具备 role=tab 与 aria-selected（活动项 true 其余 false）', async () => {
  const { SFV, tabsBar } = buildEnv();
  SFV.homeCollectionsOverlay.open();
  const tabs = tabsBar.querySelectorAll('button');
  assert.equal(tabs.length, 5);
  tabs.forEach((btn) => {
    assert.equal(btn.getAttribute('role'), 'tab', 'tab 条按钮须有 role="tab"');
    const selected = btn.getAttribute('aria-selected');
    assert.ok(selected === 'true' || selected === 'false', '须有显式 aria-selected 布尔串：' + btn.dataset.wcTab);
  });
  const active = tabsBar.querySelector('[aria-selected="true"]');
  assert.ok(active, '恰有一个活动 tab');
  assert.equal(active.getAttribute('data-wc-tab'), 'featured');
});

test('列表容器 role=tabpanel 且 aria-labelledby 跟随当前 tab', async () => {
  const { SFV, doc, tabsBar, list, settle } = buildEnv();
  SFV.homeCollectionsOverlay.open();
  assert.equal(list.getAttribute('role'), 'tabpanel', 'index.html 壳须标 role="tabpanel"');
  assert.equal(list.getAttribute('aria-labelledby'), 'home-video-collections-tab-featured');
  const themeTab = tabsBar.querySelector('[data-wc-tab="theme"]');
  themeTab.dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true }));
  await settle();
  assert.equal(list.getAttribute('aria-labelledby'), 'home-video-collections-tab-theme', '切 tab 后 labelledby 须跟随');
});

test('焦点陷阱：末位 Tab 回首位，首位 Shift+Tab 到末位', async () => {
  const { SFV, doc, mask, pressTab, settle } = buildEnv();
  SFV.homeCollectionsOverlay.open();
  await settle();
  const focusables = mask.querySelectorAll('button:not([disabled])');
  assert.ok(focusables.length >= 2, '浮层内须有多个可聚焦元素');
  focusables[focusables.length - 1].focus();
  assert.equal(doc.activeElement, focusables[focusables.length - 1], '前置：焦点在末位');
  pressTab(false);
  assert.equal(doc.activeElement, focusables[0], '末位 Tab 须回到首位（不得走出浮层）');
  pressTab(true);
  assert.equal(doc.activeElement, focusables[focusables.length - 1], '首位 Shift+Tab 须绕回末位');
});

test('焦点在浮层外时按 Tab 拉回浮层内；关闭后陷阱失效', async () => {
  const { SFV, doc, mask, pressTab, settle } = buildEnv();
  const outside = doc.createElement('button');
  doc.body.appendChild(outside);
  outside.focus();
  SFV.homeCollectionsOverlay.open();
  await settle();
  outside.focus(); // 模拟鼠标点击外部把焦点带走
  pressTab(false);
  assert.ok(mask.contains(doc.activeElement), 'Tab 须把焦点拉回浮层内');
  SFV.homeCollectionsOverlay.close();
  outside.focus();
  const before = doc.activeElement;
  pressTab(false);
  assert.equal(doc.activeElement, before, '关闭后不得再劫持全局 Tab');
});
