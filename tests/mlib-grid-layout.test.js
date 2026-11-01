// tests/mlib-grid-layout.test.js —— 批C-1/C-2（10-26）：资料库网格「显示区域 + 列数降级」两条结构性约束
// 起因：无头 Edge 实测（1896/976/756 三档）发现
//   ①我们的 #mlib-grid 铺满视口减去 gutter（内容列 1784，专辑卡 338px），
//     而参照库每一轴都在 .mlib-section{max-width:1240px;margin:auto} 里（内容列 1240，专辑卡 229px）；
//   ②轴默认列数规则 body.mlib-axis-* #mlib-grid（特异度 1,1,1）永远压过
//     @container 里的 #mlib-grid（1,0,0），四档容器查询形同废纸 → 窗口再窄也是 5/6 列，卡片缩成 106px。
//     （参照库自己那套 @container 也不生效——容器不能查询自身；它的轴降级靠视口 @media。）
// 这两条都是「读源码看不出来、量出来的」缺陷，故锁成结构断言，防止将来又被写回裸 #mlib-grid。
// 运行：node --test tests/mlib-grid-layout.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'music-library.css'), 'utf8');

// 极简括号匹配：从条件规则头之后第一个 '{' 起，配对摘出整块正文（嵌套计深，不怕块里再有 @media/@container）。
function blockBodyAfter(source, openBraceIndex) {
  let depth = 0;
  for (let i = openBraceIndex; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(openBraceIndex + 1, i);
    }
  }
  throw new Error('大括号不平衡：CSS 正文截断，测试无法判定作用域');
}

// 扫出所有 @container 块：prelude（查询条件）+ 配对的块正文；扫描位置跳到块尾，嵌套块不会被重复计为顶层档。
function containerBlocks(source) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf('@container', from);
    if (at < 0) return out;
    const open = source.indexOf('{', at);
    if (open < 0) throw new Error('@container 没有块正文：CSS 被截断');
    out.push({ query: source.slice(at + '@container'.length, open).trim(), body: blockBodyAfter(source, open) });
    from = open + 1 + blockBodyAfter(source, open).length + 1;
  }
}

// 收集一个块内「选择器 → --stella-mlib-cols 值」的映射（只认声明里带 cols 的规则）。
function colsDeclarations(body) {
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(body))) {
    const decl = m[2];
    const v = /--stella-mlib-cols:\s*(\d+)/.exec(decl);
    if (v) rules.push({ selector: m[1].trim(), cols: Number(v[1]) });
  }
  return rules;
}

test('批C-1：#mlib-grid-wrap 把内容列收到 1240 并居中（与页头/状态盒/详情头/曲目表同一列）', () => {
  const i = CSS.indexOf('#mlib-grid-wrap');
  assert.ok(i >= 0, '必须存在 #mlib-grid-wrap 规则');
  const body = blockBodyAfter(CSS, CSS.indexOf('{', i));
  assert.match(body, /container-type:\s*inline-size/, '包裹层仍是容器查询上下文');
  assert.match(body, /max-width:\s*1240px/, '内容列上限 1240px（参照库 .mlib-section:1854 同值）');
  assert.match(body, /margin:\s*0\s+auto/, '居中：窄窗口靠 gutter，宽窗口两侧留白');
});

test('批C-2：列数降级规则一律带 body.mlib-axis- 前缀——裸 #mlib-grid 会被轴默认值压成死规则', () => {
  const blocks = containerBlocks(CSS);
  assert.ok(blocks.length >= 2, '至少要有 1080/860 两档容器查询');
  const bare = [];
  blocks.forEach((b) => {
    colsDeclarations(b.body).forEach((r) => {
      if (!/#mlib-grid/.test(r.selector)) return;
      if (!/body\.mlib-axis-[a-z]+/.test(r.selector)) bare.push(b.query + ' → ' + r.selector);
    });
  });
  assert.deepEqual(bare, [], '以下 @container 列数规则特异度不足，永远不会生效：\n' + bare.join('\n'));
});

test('批C-2：按参照库实测口径降级——艺人 6→4(≤1080)→3(≤860)，歌单 5→3(≤860)', () => {
  const at = (px) => {
    const b = containerBlocks(CSS).find((x) => new RegExp('max-width:\\s*' + px + 'px').test(x.query));
    assert.ok(b, '缺少 @container (max-width: ' + px + 'px) 档');
    return colsDeclarations(b.body);
  };
  const colsFor = (rules, axis) => {
    const hit = rules.filter((r) => r.selector.indexOf('body.mlib-axis-' + axis) >= 0);
    if (!hit.length) return null;
    assert.equal(hit.length, 1, axis + ' 在同一档里被写了多次，列数不确定');
    return hit[0].cols;
  };
  assert.equal(colsFor(at(1080), 'artists'), 4, '艺人轴 ≤1080 降到 4 列（参照库 index.css:3126-3129）');
  assert.equal(colsFor(at(860), 'artists'), 3, '艺人轴 ≤860 降到 3 列（参照库 index.css:3132-3134）');
  assert.equal(colsFor(at(860), 'playlists'), 3, '歌单轴 ≤860 降到 3 列（参照库 index.css:3137-3138）');
});

test('批C-2：专辑轴不因 1080/860 掉列——参照库实测就是恒 5 列，1:1 不擅自加降级', () => {
  const rules = [1080, 860].flatMap((px) => colsDeclarations(
    containerBlocks(CSS).find((x) => new RegExp('max-width:\\s*' + px + 'px').test(x.query)).body,
  ));
  assert.equal(rules.filter((r) => /body\.mlib-axis-albums/.test(r.selector)).length, 0,
    '专辑轴在 1080/860 档不该出现列数声明（参照库 .mlib-grid-releases 是艺人详情的发行区，不是专辑轴）');
});
