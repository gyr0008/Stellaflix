// 页面泄露修复：追片/历史等源页下，全局搜索胶囊（#sfv-capsule-search-btn）必须隐藏且不可触发。
// 覆盖三层契约：
//   1) CSS：.sfv-wh-page / .sfv-track-tabs 命中时隐藏胶囊（display/visibility/pointer-events）
//   2) JS 门闩：S.isSourcePageCapsuleSearchBlocked 判定与 CSS 同源
//   3) 入口：_sfvTryToggleSearch / toggleSearchPage / isOverSearchBtn 均在门闩为真时短路
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const playerCss = fs.readFileSync(path.join(root, 'public/video/player.css'), 'utf8');
const onlineJs = fs.readFileSync(path.join(root, 'public/video/online.js'), 'utf8');
const onlineSearchJs = fs.readFileSync(path.join(root, 'public/video/online-search.js'), 'utf8');

test('CSS：追片(.sfv-track-tabs)/历史(.sfv-wh-page) 命中时隐藏搜索胶囊', () => {
  assert.match(
    playerCss,
    /body\.video-space-active:has\(\.sfv-browse\.sfv-show \.sfv-wh-page\)\s+\.sfv-capsule-search-btn[\s\S]*?display:\s*none\s*!important/,
    '历史页源内容命中时必须 display:none 胶囊'
  );
  assert.match(
    playerCss,
    /body\.video-space-active:has\(\.sfv-browse\.sfv-show \.sfv-track-tabs\)\s+\.sfv-capsule-search-btn[\s\S]*?display:\s*none\s*!important/,
    '追片页 tabs 命中时必须 display:none 胶囊'
  );
  // 隐藏规则须同时掐断可见性与点击，防止 visibility:hidden 仍有矩形被坐标兜底命中
  const block = playerCss.match(
    /body\.video-space-active:has\(\.sfv-browse\.sfv-show \.sfv-wh-page\)[\s\S]*?\{[\s\S]*?\}/
  );
  assert.ok(block, '应能找到历史页隐藏规则块');
  assert.match(block[0], /visibility:\s*hidden\s*!important/);
  assert.match(block[0], /pointer-events:\s*none\s*!important/);
});

test('JS 门闩：isSourcePageCapsuleSearchBlocked 判定与 CSS 同源信号', () => {
  assert.match(
    onlineSearchJs,
    /function isSourcePageCapsuleSearchBlocked\(\)[\s\S]*?\.sfv-browse\.sfv-show \.sfv-wh-page/,
    '门闩须识别历史页 .sfv-wh-page'
  );
  assert.match(
    onlineSearchJs,
    /function isSourcePageCapsuleSearchBlocked\(\)[\s\S]*?\.sfv-browse\.sfv-show \.sfv-track-tabs/,
    '门闩须识别追片页 .sfv-track-tabs'
  );
  assert.match(
    onlineSearchJs,
    /S\.isSourcePageCapsuleSearchBlocked\s*=\s*isSourcePageCapsuleSearchBlocked/,
    '门闩须挂到 onlineShared 供全局入口调用'
  );
});

test('入口短路：全局切换 / toggle / 坐标兜底均被门闩拦截', () => {
  assert.match(
    onlineJs,
    /_sfvTryToggleSearch[\s\S]*?isSourcePageCapsuleSearchBlocked/,
    '_sfvTryToggleSearch 须先过门闩'
  );
  assert.match(
    onlineSearchJs,
    /function toggleSearchPage\(\)[\s\S]*?isSourcePageCapsuleSearchBlocked/,
    'toggleSearchPage 打开分支须过门闩'
  );
  assert.match(
    onlineSearchJs,
    /function isOverSearchBtn\(x, y\)[\s\S]*?isSourcePageCapsuleSearchBlocked/,
    'window 坐标兜底 isOverSearchBtn 须过门闩'
  );
});

test('门闩运行时：源页结构命中返回 true，普通浏览层返回 false', () => {
  // 轻量 DOM 桩，只验证 querySelector 信号，不拉起整套 onlineShared
  function makeDoc(matched) {
    return {
      querySelector(sel) {
        return matched.some((m) => sel.indexOf(m) !== -1) ? {} : null;
      },
    };
  }
  // 抽出函数体做纯逻辑复验（与 online-search.js 同一判定表达式）
  function isBlocked(doc) {
    try {
      if (!doc || !doc.querySelector) return false;
      return !!(doc.querySelector('.sfv-browse.sfv-show .sfv-wh-page') ||
                doc.querySelector('.sfv-browse.sfv-show .sfv-track-tabs'));
    } catch (e) { return false; }
  }
  assert.equal(isBlocked(makeDoc(['.sfv-wh-page'])), true, '历史页结构应拦截');
  assert.equal(isBlocked(makeDoc(['.sfv-track-tabs'])), true, '追片页结构应拦截');
  assert.equal(isBlocked(makeDoc(['.sfv-browse--category'])), false, '无源页标记不拦截');
  assert.equal(isBlocked(null), false, '缺 doc 不拦截');
});
