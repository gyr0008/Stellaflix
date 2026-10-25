'use strict';
// 源钉测试：发现类弹窗「玻璃壳」必须保持参照库(Mineradio-LX-Music-1.7.0)净值口径
// 移植契约：弹窗载体保留 modal，但壳整体 1:1 换成参照库 premium 玻璃窗：
//   尺寸 min(1480px,100vw-144px)×min(790px,100vh-150px)、blur(42px) saturate(1.48) contrast(1.04)、
//   遮罩减淡让首页场景透出（玻璃才有内容可糊）、render-deep-sleep 降档 blur(8px)。
// 作用域：只挂 .sfv-glass-modal（排行榜/电台两弹窗），本地曲库 home-local-modes-mask 不得染指。
const test = require('node:test');
const assert = require('node:assert/strict');
// 作用域扫描器与规则定位收拢到共用工装（tests/css-source-helpers.js），本文件不再自带副本
const { read, findRule, assertGlobalScope } = require('./css-source-helpers');

const css = read('public/css/index.css');
const html = read('public/index.html');

test('两发现弹窗挂 .sfv-glass-modal，本地曲库弹窗不挂', () => {
  const radio = html.match(/<div id="home-radio-modes-mask" class="([^"]+)"/);
  const recommend = html.match(/<div id="home-platform-recommend-mask" class="([^"]+)"/);
  const local = html.match(/<div id="home-local-modes-mask" class="([^"]+)"/);
  assert.ok(radio && /\bsfv-glass-modal\b/.test(radio[1]), '电台弹窗缺 .sfv-glass-modal');
  assert.ok(recommend && /\bsfv-glass-modal\b/.test(recommend[1]), '平台推荐弹窗缺 .sfv-glass-modal');
  assert.ok(local && !/\bsfv-glass-modal\b/.test(local[1]), '本地曲库弹窗不得挂玻璃壳类');
});

test('玻璃壳净值：参照库 premium 玻璃外观挂在通用 .modal 壳上', () => {
  const shell = findRule(css, /\.modal-mask\.sfv-glass-modal\s+\.modal\s*\{/);
  assert.ok(shell, '缺 .modal-mask.sfv-glass-modal .modal 壳规则');
  assert.match(shell.body, /backdrop-filter:\s*blur\(42px\)\s+saturate\(1\.48\)\s+contrast\(1\.04\)\s*;/, '玻璃净值应为 blur42 sat1.48 contrast1.04');
  assert.match(shell.body, /border-radius:\s*34px/, '壳圆角净值应为 34px');
  assert.match(shell.body, /background:[\s\S]*radial-gradient\(900px 480px/, '壳背景应含参照库第一层 radial 高光');
  assert.match(shell.body, /linear-gradient\(145deg,\s*rgba\(27,\s*30,\s*39,\s*0?\.72\)/, '壳背景基线渐变应为参照库净值');
  assertGlobalScope(css, shell, '玻璃壳规则');
});

test('遮罩减淡：玻璃壳遮罩不得回到通用 rgba(0,0,0,.78)', () => {
  const mask = findRule(css, /\.modal-mask\.sfv-glass-modal\s*\{/);
  assert.ok(mask, '缺 .modal-mask.sfv-glass-modal 遮罩规则');
  assert.match(mask.body, /rgba\(0,\s*0,\s*0,\s*0?\.34\)/, '遮罩黑底应减淡到 .34 让首页场景透出');
  assert.ok(!/rgba\(0,\s*0,\s*0,\s*0?\.78\)/.test(mask.body), '遮罩不得沿用通用 .78 压黑');
  assertGlobalScope(css, mask, '玻璃壳遮罩规则');
});

test('性能降档：render-deep-sleep 下 blur 降到 8px（参照库 eco 口径）', () => {
  const eco = findRule(css, /body\.render-deep-sleep\s+\.modal-mask\.sfv-glass-modal\s+\.modal\s*\{/);
  assert.ok(eco, '缺 render-deep-sleep 降档规则');
  assert.match(eco.body, /backdrop-filter:\s*blur\(8px\)/, '降档 blur 应为 8px');
  assertGlobalScope(css, eco, '降档规则');
});

test('回归钉：内层退役段=尺寸唯一钳制者，只撤外观不撤高度', () => {
  // 首版翻车：退役段写 height:auto/max-height:none 撤掉内层 920×900 钳制，
  // 且其特异性(0,4,0)高于外层 .modal 规则(0,3,1)，外层 premium 尺寸被它打败 →
  // 壳被 29 张电台卡撑到 ~1450px，flex 居中把头部顶出视口顶部。
  for (const sel of [
    /\.modal-mask\.sfv-glass-modal \.home-radio-modes-modal\s*\{/,
    /\.modal-mask\.sfv-glass-modal \.home-platform-recommend-modal\s*\{/
  ]) {
    const rule = findRule(css, sel);
    assert.ok(rule, `缺退役规则 ${sel}`);
    assert.match(rule.body, /width:\s*min\(1480px,\s*calc\(100vw\s*-\s*144px\)\)/, `${sel} 应承载 premium 宽度钳制`);
    assert.match(rule.body, /height:\s*min\(790px,\s*calc\(100vh\s*-\s*150px\)\)/, `${sel} 应承载 premium 高度钳制`);
    assert.ok(!/(^|;)\s*(max-|min-)?(width|height)\s*:\s*(auto|none)/.test(`;${rule.body}`),
      `${sel} 不得出现 auto/none 撤尺寸`);
  }
});

test('入场动画：壳带 transform/filter transition，参照库 0.26s 口径', () => {
  const shell = findRule(css, /\.modal-mask\.sfv-glass-modal\s+\.modal\s*\{/);
  assert.ok(shell, '缺壳规则');
  assert.match(shell.body, /transition:[^;]*transform\s+0?\.26s/, '壳应有 transform .26s 过渡');
  assert.match(shell.body, /filter:\s*saturate\(\.94\)/, '静息态 filter 应为 saturate(.94)');
  const active = findRule(css, /\.modal-mask\.sfv-glass-modal\.show\s+\.modal\s*\{/);
  assert.ok(active, '缺 .show 激活态规则');
  assert.match(active.body, /transform:\s*none/, '激活态 transform 应归零');
  assert.match(active.body, /filter:\s*none/, '激活态 filter 应归零');
});

test('回归钉：壳给确定高度后，平台推荐弹窗的固定行必须退出 flex 收缩', () => {
  // 10-26 真机截图：五个平台 pill 只剩顶部。根因=退役段把内壳钳成 min(790px,100vh-150px) 后，
  // 列内容溢出走 flex 收缩；.home-platform-recommend-tabs 有 overflow-x:auto，
  // 滚动容器的自动最小尺寸为 0 → 被压到 6px（离屏实测复现，修后 32px）。
  // 钉法=从 index.html 取内壳直接子行，除滚动列表外每行都必须在守卫规则里声明 flex:0 0 auto。
  const modalHtml = /<div class="modal home-platform-recommend-modal">([\s\S]*?)<\/div>\s*<\/div>/.exec(html);
  assert.ok(modalHtml, '找不到平台推荐弹窗内壳');
  const rows = [...modalHtml[1].matchAll(/<div\b[^>]*class="(home-platform-recommend-[a-z]+)"/g)].map(m => m[1])
    .filter(cls => cls !== 'home-platform-recommend-list');
  assert.ok(rows.length >= 4, `内壳固定行数异常：${rows.join(',')}`);
  const guard = findRule(css, /\.modal-mask\.sfv-glass-modal \.home-platform-recommend-head,[\s\S]*?\{/);
  assert.ok(guard, '缺平台推荐弹窗固定行 flex 守卫规则');
  assertGlobalScope(css, guard, '固定行 flex 守卫规则');
  const head = css.slice(guard.start, css.indexOf('{', guard.start));
  for (const row of rows) {
    assert.ok(new RegExp(`\\.${row}(?![\\w-])`).test(head), `固定行 .${row} 未列入守卫选择器`);
    assert.match(guard.body, /flex:\s*0 0 auto/, `.${row} 守卫应为 flex:0 0 auto`);
  }
});

test('回归钉：电台网格在弹窗内滚动时保持参照库固定卡高（行不被拉满余量）', () => {
  // 参照库 .radio-mode-grid 处在整页自动高度容器里，卡高=min-height:156px；
  // SF 用弹窗承载后网格拿到确定高度，align-content 默认 normal 会把 auto 行拉满余量
  // （离屏实测：3 张卡时单行 156px→202px，卡内顶对齐文案看起来像「卡片填满页面」）。
  const grid = findRule(css, /\.modal-mask\.sfv-glass-modal \.radio-mode-grid\s*\{/);
  assert.ok(grid, '缺电台网格收口规则');
  assert.match(grid.body, /align-content:\s*start\s*;?/, '网格应 align-content:start 保住 156px 卡高');
  assertGlobalScope(css, grid, '电台网格收口规则');
});
