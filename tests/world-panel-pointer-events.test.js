'use strict';

/**
 * 修复轮⑨：世界页面板按钮死功能 —— pointer-events 断链回归锁
 * 运行：node --test tests/world-panel-pointer-events.test.js
 *
 * 根因（真实点击实验证据，Electron 窗口 40307584）：
 *   player.css T150 给世界页宿主 .sfv-browse--page 设了 pointer-events:none
 *   （放行点击给下层星空画布），子层必须各自显式 pointer-events:auto 才可点。
 *   能点的元素都有 auto（.world-create-panel、地球 hostInner、ON AIR），
 *   死按钮面板（.lh-room-panel / .lh-diag-panel / .lh-chat-panel / 桌面 .nav-panel）
 *   全部缺失 → 点击穿透到地图。
 * 本测试从 CSS 源码断言这些规则已补齐 pointer-events: auto。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const lhCss = fs.readFileSync(path.join(root, 'public', 'video', 'lighthouse', 'lighthouse.css'), 'utf8');
const htCss = fs.readFileSync(path.join(root, 'public', 'video', 'world-ht-panel.css'), 'utf8');

// 取某选择器的「基础规则」体（第一个匹配），要求带空格的展开写法与压缩写法都能命中
function baseRuleBody(css, selectorRe, label) {
  const re = new RegExp(selectorRe.source + '\\s*\\{([^}]*)\\}', 'm');
  const m = css.match(re);
  assert.ok(m, label + ' 基础规则应存在于 CSS 中');
  return m[1];
}

function assertPointerAuto(body, label) {
  assert.match(body, /pointer-events\s*:\s*auto\b/i,
    label + ' 必须显式 pointer-events: auto（世界页宿主 T150 为 pointer-events:none，子层不恢复则点击穿透）');
}

test('.lh-room-panel（我的房间面板）带 pointer-events:auto', () => {
  assertPointerAuto(baseRuleBody(lhCss, /\.lh-room-panel\b(?!-)/, '.lh-room-panel'), '.lh-room-panel');
});

test('.lh-diag-panel（网络诊断面板）带 pointer-events:auto', () => {
  assertPointerAuto(baseRuleBody(lhCss, /\.lh-diag-panel\b(?!-)/, '.lh-diag-panel'), '.lh-diag-panel');
});

test('.lh-chat-panel（房间聊天面板）带 pointer-events:auto', () => {
  assertPointerAuto(baseRuleBody(lhCss, /\.lh-chat-panel\b(?!-)/, '.lh-chat-panel'), '.lh-chat-panel');
});

test('world-ht-panel.css 桌面 .nav-panel（电台卡片外壳，首条基础规则）带 pointer-events:auto', () => {
  // 移动端媒体查询里已有 pointer-events:auto，但桌面基础规则缺失；
  // 按文件顺序第一条 .nav-panel{...} 即桌面基础规则
  const blocks = [...htCss.matchAll(/(?:^|\})\s*\.nav-panel\s*\{([^}]*)\}/gm)];
  assert.ok(blocks.length >= 1, '.nav-panel 基础规则应存在');
  assertPointerAuto(blocks[0][1], '桌面 .nav-panel（首条规则）');
});
