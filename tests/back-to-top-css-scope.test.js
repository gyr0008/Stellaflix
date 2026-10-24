'use strict';
// 源钉测试：.sfv-backtotop 样式必须位于全局作用域
// 回归背景：整套「回到顶部」按钮样式曾掉进 @media (max-width: 639px) 内，
// 桌面宽度下拿不到 position/opacity/visibility，退化成左上角灰色 UA 方块。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

function stripComments(css) {
  // 保留换行，索引可直接映射回原文件行号
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

// 返回每个 @media 规则体的字符区间 [preludeIdx, closeBraceIdx]
function mediaRanges(css) {
  const s = stripComments(css);
  const ranges = [];
  const stack = [];
  let tokenStart = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{') {
      const prelude = s.slice(tokenStart, i).trim();
      stack.push({ media: /^@media\b/.test(prelude), start: i - prelude.length });
      tokenStart = i + 1;
    } else if (c === '}') {
      const frame = stack.pop();
      if (frame && frame.media) ranges.push([frame.start, i]);
      tokenStart = i + 1;
    } else if (c === ';' && !stack.length) {
      tokenStart = i + 1;
    }
  }
  assert.strictEqual(stack.length, 0, 'unbalanced braces in player.css');
  return ranges;
}

function selectorIndex(css, selector) {
  const s = stripComments(css);
  const idx = s.indexOf(selector);
  assert.notStrictEqual(idx, -1, `selector not found in player.css: ${selector}`);
  return idx;
}

function insideAnyMedia(ranges, idx) {
  return ranges.some(([start, end]) => idx > start && idx < end);
}

test('player.css braces balance', () => {
  const css = stripComments(read('public/video/player.css'));
  let depth = 0;
  for (const c of css) {
    if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  assert.strictEqual(depth, 0, 'unbalanced braces in player.css');
});

test('back-to-top button styles live at global scope (not inside @media)', () => {
  const css = read('public/video/player.css');
  const ranges = mediaRanges(css);
  for (const selector of [
    '.sfv-backtotop {',
    '.sfv-backtotop.is-visible {',
    'body:not(.video-space-active) .sfv-backtotop',
  ]) {
    const idx = selectorIndex(css, selector);
    assert.strictEqual(
      insideAnyMedia(ranges, idx),
      false,
      `"${selector}" is nested inside a @media block — desktop viewers lose it`,
    );
  }
});
