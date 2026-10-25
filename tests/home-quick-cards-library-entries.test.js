'use strict';

/**
 * 首页快捷卡「歌单/专辑/艺人」更名批次契约测试（2026-10-18）
 * 背景：音乐库/每日推荐/最近播放三卡更名为歌单/专辑/艺人，作为本地化
 * 音乐资料库三个板块页的入口占位；卡内旧动态代码（每日推荐播放、
 * 最近播放播放、点音乐库弹面板、计数副文案）从卡上摘除。
 * 左侧悬停快捷面板与其代码零改动（不在本测试范围）。
 * 运行：node --test tests/home-quick-cards-library-entries.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const indexHtml = read('public/index.html');
const dashboard = read('public/js/modules/05-playback/03a-home-dashboard.js');
const snapshot = read('public/video/home-snapshot.js');

function quickGridSegment(html) {
  const start = html.indexOf('home-quick-grid');
  assert.ok(start >= 0, 'index.html 必须存在 home-quick-grid');
  const end = html.indexOf('</div>\n      </button>', start);
  const gridEnd = html.indexOf('<div class="home-rail home-insight-rail">', start);
  assert.ok(gridEnd > start, 'quick grid 段落边界可定位');
  return html.slice(start, gridEnd);
}

const EXPECTED_CARDS = [
  { label: 'PLAYLISTS', title: '歌单', sub: '导入的歌单与本地歌单', axis: 'playlists' },
  { label: 'ALBUMS', title: '专辑', sub: '资料库 · 建设中', axis: 'albums' },
  { label: 'ARTISTS', title: '艺人', sub: '资料库 · 建设中', axis: 'artists' },
];

test('index.html 静态卡：三卡更名到位且旧名消失', () => {
  const seg = quickGridSegment(indexHtml);
  for (const card of EXPECTED_CARDS) {
    assert.ok(seg.includes('>' + card.label + '<'), '静态卡缺 label ' + card.label);
    assert.ok(seg.includes('>' + card.title + '<'), '静态卡缺 title ' + card.title);
  }
  assert.ok(!seg.includes('>音乐库<'), '静态卡不得残留 音乐库');
  assert.ok(!seg.includes('>每日推荐<'), '静态卡不得残留 每日推荐');
  assert.ok(!seg.includes('>最近播放<'), '静态卡标题不得残留 最近播放');
  assert.ok(!seg.includes('>LIBRARY<'), '静态卡不得残留眉标 LIBRARY');
  assert.ok(!seg.includes('>DAILY MIX<'), '静态卡不得残留眉标 DAILY MIX');
  assert.ok(!seg.includes('>RECENT<'), '静态卡不得残留眉标 RECENT');
});

test('index.html 静态卡：三张新卡不携带 onclick（旧点击行为已摘除）', () => {
  const seg = quickGridSegment(indexHtml);
  for (const card of EXPECTED_CARDS) {
    const idx = seg.indexOf('>' + card.title + '<');
    assert.ok(idx >= 0, '缺卡 ' + card.title);
    const btnStart = seg.lastIndexOf('<button', idx);
    const btnSeg = seg.slice(btnStart, seg.indexOf('</button>', idx));
    assert.ok(!btnSeg.includes('onclick='), card.title + ' 卡不得残留 onclick');
  }
});

test('03a 运行时卡表：三名到位，action 置空，旧播放/面板调用摘除', () => {
  const start = dashboard.indexOf('var cards = [');
  assert.ok(start >= 0, '03a 必须存在运行时 cards 表');
  const end = dashboard.indexOf('];', start);
  const seg = dashboard.slice(start, end);
  for (const card of EXPECTED_CARDS) {
    assert.ok(seg.includes("label: '" + card.label + "'"), '运行时缺 ' + card.label);
    assert.ok(seg.includes("title: '" + card.title + "'"), '运行时缺 ' + card.title);
    assert.ok(seg.includes("sub: '" + card.sub + "'"), '运行时缺副文案 ' + card.sub);
  }
  assert.ok(!seg.includes('playHomeDaily()'), '运行时卡表不得再调用 playHomeDaily');
  assert.ok(!seg.includes('playHomeRecent()'), '运行时卡表不得再调用 playHomeRecent');
  assert.ok(!seg.includes('openHomeDashboardLibrary()'), '运行时卡表不得再调用 openHomeDashboardLibrary');
  assert.ok(!seg.includes("'音乐库'") && !seg.includes("'每日推荐'") && !seg.includes("'最近播放'"),
    '运行时卡表不得残留旧卡名');
  // 三张新卡 action 全为空串（CONTINUE 保留恢复链 action、Video 卡为双引号串，不计入）
  const emptyActions = [...seg.matchAll(/action:\s*''/g)];
  assert.equal(emptyActions.length, 3, '三张新卡应各有且仅有一条空 action');
});

test('playHomeDaily/playHomeRecent/openHomeDashboardLibrary 函数本体与其余调用方保留', () => {
  // CONTINUE 恢复播放链仍依赖 playHomeRecent/playHomeDaily
  assert.ok(dashboard.includes('playHomeRecent(recent)'), 'CONTINUE 恢复链不得被误删');
  assert.ok(dashboard.includes('if (typeof playHomeDaily === \'function\') playHomeDaily();'),
    'CONTINUE 兜底播放不得被误删');
  assert.ok(dashboard.includes('function openHomeDashboardLibrary()'), '面板入口函数必须保留');
});

test('home-snapshot musicHtmlDefaults 与静态卡逐字锁步', () => {
  const start = snapshot.indexOf('var musicHtmlDefaults = [');
  assert.ok(start >= 0, '快照基线必须存在');
  const end = snapshot.indexOf('];', start);
  const seg = snapshot.slice(start, end);
  for (const card of EXPECTED_CARDS) {
    assert.ok(seg.includes("label: '" + card.label + "', title: '" + card.title + "', sub: '" + card.sub + "'",),
      '快照基线缺 ' + card.title + '（会与 index.html 漂移，切态回滚还原旧文案）');
    assert.ok(!seg.includes(card.title + "', sub: '" + card.sub + "', onclick: 'playHome")
      && !seg.includes(card.title + "', sub: '" + card.sub + "', onclick: 'openHome"),
      '快照基线 ' + card.title + ' 不得残留旧 onclick');
  }
  assert.ok(!seg.includes("'音乐库'") && !seg.includes("'每日推荐'") && !seg.includes("'最近播放'"),
    '快照基线不得残留旧卡名');
});

test('CONTINUE 兜底副文案指向新卡名', () => {
  assert.ok(dashboard.includes('从歌单或专辑开始'), 'CONTINUE 兜底 sub 应指向 歌单/专辑');
  assert.ok(!dashboard.includes('从音乐库或每日推荐开始'), '旧兜底文案必须移除');
});

test('静态三卡携带 data-mlib-axis（Task 7 委托的唯一映射源）', () => {
  const seg = quickGridSegment(indexHtml);
  for (const card of EXPECTED_CARDS) {
    const idx = seg.indexOf('>' + card.title + '<');
    assert.ok(idx >= 0, '缺卡 ' + card.title);
    const btnStart = seg.lastIndexOf('<button', idx);
    const btnSeg = seg.slice(btnStart, seg.indexOf('>', btnStart));
    assert.ok(btnSeg.includes('data-mlib-axis="' + card.axis + '"'),
      card.title + ' 卡 opening tag 必须带 data-mlib-axis="' + card.axis + '"');
  }
  // 恰好三张：CONTINUE/IMPORT/Video 卡不得混挂该属性（委托入口＝三卡）
  assert.equal(seg.split('data-mlib-axis=').length - 1, 3, 'data-mlib-axis 必须恰为三张资料库入口卡');
});
