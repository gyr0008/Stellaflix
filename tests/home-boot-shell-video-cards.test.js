'use strict';

/**
 * 启动默认空间=影视：00-core-stores 早期骨架改写契约
 * 背景 bug：静态 #empty-home .home-grid 现有 6 卡（含 Video 影视空间），
 * 早期改写只覆盖前 5 张 → 骨架窗口「音乐空间」「影视空间」两卡并存。
 * 运行：node --test tests/home-boot-shell-video-cards.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'modules', '00-state', '00-core-stores.js'),
  'utf8'
);

function extractIife() {
  const start = SRC.indexOf('(function applyStartSpaceVideoShellEarly');
  assert.ok(start >= 0, 'early shell IIFE 必须存在于 00-core-stores.js');
  const end = SRC.indexOf('})();', start);
  assert.ok(end > start, 'IIFE 必须正常闭合');
  return SRC.slice(start, end + '})();'.length);
}

function makeClassList(initial) {
  const set = new Set(initial || []);
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    toggle: (c, on) => { if (on === undefined) { set.has(c) ? set.delete(c) : set.add(c); } else if (on) { set.add(c); } else { set.delete(c); } },
  };
}

function makeTextNode(v) { return { textContent: v }; }

// 与 index.html 静态 6 卡一一对应（顺序即 DOM 顺序）
const STATIC_CARDS = [
  { label: 'CONTINUE', title: '继续播放', sub: '从当前队列或最近播放继续' },
  { label: 'LIBRARY', title: '音乐库', sub: '歌单、本地音乐和已登录平台' },
  { label: 'IMPORT', title: '歌单导入', sub: '平台链接 / LX 文件 / 落雪曲库' },
  { label: 'DAILY MIX', title: '每日推荐', sub: '使用当前 Stellaflix 推荐数据' },
  { label: 'RECENT', title: '最近播放', sub: '播放过的歌曲会出现在这里' },
  { label: 'Video', title: '影视空间', sub: '搜索 / 播放影片' },
];

function makeCard(def) {
  const nodes = {
    '.home-card-label': makeTextNode(def.label),
    '.home-card-title': makeTextNode(def.title),
    '.home-card-sub': makeTextNode(def.sub),
  };
  return {
    style: {},
    attrs: {},
    onclick: function () {},
    querySelector: (sel) => nodes[sel] || null,
    setAttribute(k, v) { this.attrs[k] = v; },
  };
}

function runShell(startSpace) {
  const cards = STATIC_CARDS.map(makeCard);
  const railTitle = makeTextNode('每日推荐');
  const railNote = makeTextNode('');
  const document = {
    documentElement: { classList: makeClassList() },
    body: { classList: makeClassList() },
    querySelectorAll: (sel) => (sel === '#empty-home .home-grid .home-card' ? cards : []),
    getElementById: (id) => (id === 'home-rail-title' ? railTitle : id === 'home-rail-note' ? railNote : null),
  };
  const sandbox = {
    console, document,
    localStorage: { getItem: (k) => (k === 'stellaflix-start-space' ? startSpace : null) },
  };
  vm.createContext(sandbox);
  vm.runInContext(extractIife(), sandbox, { filename: 'applyStartSpaceVideoShellEarly.js' });
  return { cards, railTitle, railNote, document };
}

const visibleTitles = (cards) => cards
  .filter((c) => c.style.display !== 'none')
  .map((c) => c.querySelector('.home-card-title').textContent);

test('启动空间=影视：骨架期「音乐空间」与「影视空间」两卡不并存', () => {
  const { cards } = runShell('video');
  const titles = visibleTitles(cards);
  assert.ok(!(titles.includes('音乐空间') && titles.includes('影视空间')),
    '可见卡不得同时出现 音乐空间+影视空间，实际: ' + titles.join('/'));
});

test('启动空间=影视：第 6 张残留卡在骨架期被隐藏（影视 cardDefs 只有 5 卡）', () => {
  const { cards } = runShell('video');
  assert.equal(cards[5].style.display, 'none');
});

test('启动空间=影视：骨架五卡文案与 video/home-cards.js cardDefs 对齐', () => {
  const { cards } = runShell('video');
  const expect = [
    ['LIKED', '心动', '进入浏览厅 · 挑片即看'],
    ['LIBRARY', '片库', '海报墙筹备中'],
    ['TRACKING', '追片', '标记想看的片子'],
    ['HISTORY', '历史', '看过的会记在这里'],
    ['MUSIC', '音乐空间', '返回音乐空间 · 听歌'],
  ];
  expect.forEach((row, i) => {
    assert.equal(cards[i].querySelector('.home-card-label').textContent, row[0], 'card' + i + ' label');
    assert.equal(cards[i].querySelector('.home-card-title').textContent, row[1], 'card' + i + ' title');
    assert.equal(cards[i].querySelector('.home-card-sub').textContent, row[2], 'card' + i + ' sub');
  });
});

test('启动空间=music：不改写任何卡片', () => {
  const { cards } = runShell('music');
  STATIC_CARDS.forEach((def, i) => {
    assert.equal(cards[i].querySelector('.home-card-title').textContent, def.title, 'card' + i);
    assert.notEqual(cards[i].style.display, 'none', 'card' + i + ' 不应被隐藏');
  });
});
