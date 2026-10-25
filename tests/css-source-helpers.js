'use strict';
// CSS 源钉工装：括号作用域扫描器（@media 区间 + 规则体定位）。
// 由来：首版给 tests/back-to-top-css-scope.test.js（.sfv-backtotop 掉进 @media 的事故），
// 第二版 glass-modal-shell.test.js 复制了一份，本文件把两者收拢为单一实现。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

// 返回每个 @media 规则体的字符区间 [openBraceIdx, closeBraceIdx]
function mediaRanges(css) {
  const s = stripComments(css);
  const ranges = [];
  const stack = [];
  let tokenStart = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{') {
      const prelude = s.slice(tokenStart, i).trim();
      stack.push({ media: /^@media\b/.test(prelude), start: i });
      tokenStart = i + 1;
    } else if (c === '}') {
      const frame = stack.pop();
      if (frame && frame.media) ranges.push([frame.start, i]);
      tokenStart = i + 1;
    } else if (c === ';' && !stack.length) {
      tokenStart = i + 1;
    }
  }
  assert.strictEqual(stack.length, 0, 'CSS 括号不平衡');
  return ranges;
}

function findRule(css, selectorRe) {
  const s = stripComments(css);
  const m = selectorRe.exec(s);
  if (!m) return null;
  const open = s.indexOf('{', m.index);
  if (open < 0) return null;
  let depth = 0;
  let close = open;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) { close = i; break; } }
  }
  return { start: m.index, end: close, body: s.slice(open + 1, close) };
}

function assertGlobalScope(css, rule, label) {
  const inMedia = mediaRanges(css).some(([a, b]) => rule.start >= a && rule.start <= b);
  assert.ok(!inMedia, `${label} 必须位于全局作用域，不得掉进 @media`);
}

module.exports = { read, stripComments, mediaRanges, findRule, assertGlobalScope };
