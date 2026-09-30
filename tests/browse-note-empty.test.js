'use strict';

/**
 * 空 .sfv-browse-note 不得占位（2026-09-27 用户截图：世界页顶部一条玻璃长条）
 * 运行：node --test tests/browse-note-empty.test.js
 *
 * 根因（像素取证 + 源码指纹，唯一命中）：
 *  - .sfv-browse-note（player.css:1550）自带 margin:4px 2px 10px + padding:8px 12px
 *    + 1px 边框 + rgba(255,255,255,.04) 底 + rgba(255,255,255,.07) 边。
 *  - .sfv-browse--page 覆盖层 padding 归零（player.css:1645+）→ note 落在 (2,4)，
 *    满宽减左右各 2px；内容为空时高度 = 8+8+1+1 = 18px。
 *  - 实测截图 Screenshot 2026-09-27 123124.png：色带矩形 (2,4)-(2557,21)，
 *    填充 rgb(15,16,20) = #05060a 上叠 .04 白；边框 rgb(31,32,36) = 同一 .04 底上
 *    再叠 .07 白（31.8,32.8,36.8）。margin:4px 2px 在全项目 CSS 中仅此一处。
 *  - online-nav.js:62 创建 note 时不给 display:none，只有 setNote('')（:617）才隐藏
 *    → 从未调用 setNote 的分页（世界页）留下这条空玻璃带。
 *
 * 契约：note 为空时必须零占位，且有文案时照常显示。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'video', 'player.css'),
  'utf8'
);

function block(selector) {
  const m = css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'));
  return m ? m[1] : null;
}

test('空 note 必须零占位：存在 .sfv-browse-note:empty 且 display:none !important', () => {
  const b = block('.sfv-browse-note:empty');
  assert.ok(b, '必须有 .sfv-browse-note:empty 规则');
  // 行内 style="display:block"（online-nav.js:618）会压过普通声明，必须 !important
  assert.match(b, /display:\s*none\s*!important/);
});

test('基础 .sfv-browse-note 规则仍在（有文案时照常渲染玻璃提示条）', () => {
  const b = block('.sfv-browse-note');
  assert.ok(b, '.sfv-browse-note 基础规则不得删除');
  assert.match(b, /background:\s*rgba\(255,\s*255,\s*255,\s*\.?0?\.04\)/);
});

test('作用域纪律：:empty 规则不得挂在页面/世界页专属选择器上（所有分页同病同治）', () => {
  const lines = css.split('\n').filter((l) => /sfv-browse-note:empty/.test(l));
  assert.strictEqual(lines.length, 1, ':empty 规则只应有一条');
  assert.match(lines[0].trim(), /^\.sfv-browse-note:empty\s*\{/, '必须是全分页通用的裸类选择器');
});
