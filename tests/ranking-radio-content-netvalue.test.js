'use strict';
// 源钉测试：排行榜行墙 + 电台内容层 = 参照库(Mineradio-LX-Music-1.7.0 public/index.html:740-745/4451-4503/4628-4644)净值。
// 口径：逐条比较「级联折叠后的最终生效值」，允许 SF 把同一选择器拆成承载覆写规则，只要结果数值一致。
// 作用域双向钉：行墙/卡片主体规则必须在全局；退化四列必须在 @media (max-width:820px) 内。
const test = require('node:test');
const assert = require('node:assert/strict');
const { read, stripComments, mediaRanges, findRule, assertGlobalScope } = require('./css-source-helpers');

const css = read('public/css/index.css');
const html = read('public/index.html');
const RANGES = mediaRanges(css);
const STRIPPED = stripComments(css);

function ruleEntries(scopeText, ranges, insideMedia) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(scopeText))) {
    const open = scopeText.indexOf('{', m.index);
    const isIn = ranges.some(([a, b]) => open >= a && open <= b);
    if (isIn !== insideMedia) continue;
    out.push({ start: m.index, selectors: m[1].split(',').map(x => x.trim()).filter(Boolean), body: m[2] });
  }
  return out;
}

function mergeBodies(entries, selector) {
  const decls = new Map();
  let hits = 0;
  let firstStart = -1;
  for (const rule of entries) {
    if (!rule.selectors.includes(selector)) continue;
    hits += 1;
    if (firstStart < 0) firstStart = rule.start;
    for (const decl of rule.body.split(';')) {
      const at = decl.indexOf(':');
      if (at < 0) continue;
      decls.set(decl.slice(0, at).trim().toLowerCase(), decl.slice(at + 1).trim());
    }
  }
  return { decls, hits, firstStart };
}

function globalCascade(selector, label) {
  const { decls, hits, firstStart } = mergeBodies(ruleEntries(STRIPPED, RANGES, false), selector);
  assert.ok(hits > 0, `缺少全局作用域规则：${label || selector}`);
  return { props: decls, start: firstStart };
}

function mediaCascade(selector, mediaFragment, label) {
  const ranges = RANGES.filter(([a, b]) => css.slice(a - 60, a).includes(mediaFragment));
  assert.ok(ranges.length >= 1, `CSS 里没有 ${mediaFragment} 的媒体查询`);
  const entries = [];
  for (const [a, b] of ranges) entries.push(...ruleEntries(STRIPPED.slice(a, b + 1), [], false));
  const { decls, hits } = mergeBodies(entries, selector);
  assert.ok(hits > 0, `缺少 ${mediaFragment} 内规则：${label || selector}`);
  return decls;
}

function assertProps(actual, expected, label) {
  for (const [prop, value] of Object.entries(expected)) {
    assert.equal(actual.get(prop), value, `${label} 的 ${prop} 与参照库净值不符`);
  }
}

test('行墙网格与行高 = 参照库 46px 50px minmax(0,1fr) 72px 112px / 68px / 8px 13px', () => {
  const row = globalCascade('.ranking-row');
  assertGlobalScope(css, { start: row.start }, '.ranking-row');
  assertProps(row.props, {
    'display': 'grid',
    'grid-template-columns': '46px 50px minmax(0,1fr) 72px 112px',
    'align-items': 'center',
    'gap': '12px',
    'min-height': '68px',
    'padding': '8px 13px',
    'border-bottom': '1px solid rgba(255,255,255,.05)',
    'transition': 'background .18s,transform .18s',
    'content-visibility': 'auto',
    'contain': 'layout paint style',
    'contain-intrinsic-size': '0 68px',
  }, '.ranking-row');
  const hover = globalCascade('.ranking-row:hover');
  assertProps(hover.props, {
    'background': 'linear-gradient(90deg,rgba(var(--fc-accent-rgb),.09),rgba(255,255,255,.025))',
    'transform': 'translateX(2px)',
  }, '.ranking-row:hover');
});

test('序号/封面/平台徽标/行内钮净值逐条对齐', () => {
  assertProps(globalCascade('.ranking-number').props, {
    'font-size': '17px', 'font-weight': '850', 'text-align': 'center',
    'color': 'rgba(255,255,255,.38)', 'font-variant-numeric': 'tabular-nums',
  }, '.ranking-number');
  const top3 = findRule(css, /\.ranking-row:nth-child\(-n\+3\) \.ranking-number\s*\{/);
  assert.ok(top3, '缺前三名强调色');
  assertGlobalScope(css, top3, '.ranking-row:nth-child(-n+3) .ranking-number');
  assert.match(top3.body, /color:rgba\(var\(--fc-accent-rgb\),\.90\)/);
  assert.match(top3.body, /text-shadow:0 0 18px rgba\(var\(--fc-accent-rgb\),\.18\)/);
  assertProps(globalCascade('.ranking-cover').props, {
    'width': '50px', 'height': '50px', 'border-radius': '13px', 'object-fit': 'cover',
  }, '.ranking-cover');
  assertProps(globalCascade('.ranking-source').props, {
    'justify-self': 'end', 'border-radius': '999px', 'font-size': '9.5px', 'font-weight': '760',
  }, '.ranking-source');
  assertProps(globalCascade('.ranking-icon-btn').props, {
    'width': '32px', 'height': '32px', 'display': 'grid', 'place-items': 'center',
    'border-radius': '10px', 'font': '800 13px/1 inherit',
  }, '.ranking-icon-btn');
  assertProps(globalCascade('.ranking-load-more').props, { 'width': '100%', 'height': '46px' }, '.ranking-load-more');
  assertProps(globalCascade('.ranking-state').props, { 'padding': '54px 20px', 'font-size': '12px' }, '.ranking-state');
  assertProps(globalCascade('.ranking-state strong').props, { 'font-size': '16px', 'margin-bottom': '8px' }, '.ranking-state strong');
});

test('列表容器与摘要条净值：20px 圆角黑底 + 18px 摘要条', () => {
  const list = globalCascade('.ranking-list');
  assertGlobalScope(css, { start: list.start }, '.ranking-list');
  assertProps(list.props, {
    'border-radius': '20px', 'background': 'rgba(0,0,0,.16)', 'overflow': 'hidden',
    'display': 'flex', 'flex-direction': 'column',
  }, '.ranking-list');
  assertProps(globalCascade('.ranking-summary').props, {
    'border-radius': '18px', 'padding': '14px 16px', 'gap': '16px', 'margin-bottom': '12px',
  }, '.ranking-summary');
  assertProps(globalCascade('.ranking-summary-note').props, { 'font-size': '10.5px' }, '.ranking-summary-note');
  assertProps(globalCascade('.ranking-summary-title').props, { 'font-size': '16px', 'font-weight': '790' }, '.ranking-summary-title');
});

test('平台 tab 走 nowrap 横向滚动，六钮胶囊净值', () => {
  assertProps(globalCascade('.ranking-platform-tabs').props, {
    'flex-wrap': 'nowrap', 'overflow-x': 'auto', 'scrollbar-width': 'none', 'padding-bottom': '4px',
  }, '.ranking-platform-tabs');
  const hide = findRule(css, /\.ranking-platform-tabs::-webkit-scrollbar\s*\{/);
  assert.match(hide.body, /display:none/);
  assertProps(globalCascade('.ranking-platform-btn').props, {
    'height': '34px', 'padding': '0 13px', 'border-radius': '999px', 'font': '750 11px inherit',
  }, '.ranking-platform-btn');
  assertProps(globalCascade('.ranking-platform-btn.active').props, {
    'border-color': 'rgba(var(--fc-accent-rgb),.48)',
    'background': 'rgba(var(--fc-accent-rgb),.15)',
  }, '.ranking-platform-btn.active');
  assertProps(globalCascade('.secondary-toolbar').props, { 'gap': '7px', 'padding': '12px 22px 0' }, '.secondary-toolbar');
  assertProps(globalCascade('.secondary-action').props, { 'min-height': '36px', 'border-radius': '12px' }, '.secondary-action');
});

test('820px 退化四列必须落在 @media (max-width:820px) 内（与全局规则相反口径）', () => {
  const narrow = mediaCascade('.ranking-row', 'max-width:820px');
  assert.equal(narrow.get('grid-template-columns'), '34px 44px minmax(0,1fr) 92px');
  assert.equal(narrow.get('padding'), '8px');
  const cover = mediaCascade('.ranking-cover', 'max-width:820px');
  assert.equal(cover.get('width'), '44px');
  assert.equal(cover.get('height'), '44px');
  const source = mediaCascade('.ranking-source', 'max-width:820px');
  assert.equal(source.get('display'), 'none');
});

test('电台卡渐变换成参照库 138deg + color-mix 压暗（覆盖自家 135deg 旧值）', () => {
  const card = globalCascade('.radio-mode-card');
  assertGlobalScope(css, { start: card.start }, '.radio-mode-card');
  assert.equal(
    card.props.get('background'),
    'linear-gradient(138deg,color-mix(in srgb,var(--radio-a) 65%,#10131a),color-mix(in srgb,var(--radio-b) 72%,#080a10))',
    '电台卡底色必须是参照库 138deg + color-mix 压暗净值');
});

test('电台 intro 条 + 分类 tab nowrap 净值', () => {
  const intro = globalCascade('.radio-intro');
  assertGlobalScope(css, { start: intro.start }, '.radio-intro');
  assertProps(intro.props, {
    'padding': '15px 18px', 'border-radius': '19px', 'gap': '18px',
    'background': 'linear-gradient(120deg,rgba(var(--fc-accent-rgb),.10),rgba(255,255,255,.035),rgba(0,0,0,.14))',
  }, '.radio-intro');
  assertProps(globalCascade('.radio-intro strong').props, { 'font-size': '16px', 'color': '#fff' }, '.radio-intro strong');
  assertProps(globalCascade('.radio-intro span').props, { 'font-size': '10.5px' }, '.radio-intro span');
  assertProps(globalCascade('.radio-intro-mark').props, {
    'border-radius': '999px', 'background': 'rgba(var(--fc-accent-rgb),.12)', 'font-size': '10px', 'font-weight': '760',
  }, '.radio-intro-mark');
  assertProps(globalCascade('.home-radio-modes-tabs').props, {
    'flex-wrap': 'nowrap', 'overflow-x': 'auto', 'scrollbar-width': 'none',
  }, '.home-radio-modes-tabs');
  assertProps(globalCascade('.radio-category-btn').props, {
    'height': '34px', 'padding': '0 14px', 'border-radius': '999px', 'font': '750 11px inherit',
  }, '.radio-category-btn');
});

test('排行榜弹窗内壳=尺寸唯一钳制者（玻璃壳同款约束，勿写 auto/none）', () => {
  const shell = findRule(css, /\.modal-mask\.sfv-glass-modal \.daily-hot-ranking-modal\s*\{/);
  assert.ok(shell, '缺排行榜弹窗内壳尺寸钳制规则');
  assertGlobalScope(css, shell, '.daily-hot-ranking-modal 尺寸');
  assert.match(shell.body, /width:\s*min\(1480px, calc\(100vw - 144px\)\)/);
  assert.match(shell.body, /height:\s*min\(790px, calc\(100vh - 150px\)\)/);
  assert.doesNotMatch(shell.body, /width:\s*auto/, '尺寸撤成 auto 会把头部顶没（首版事故）');
  const content = findRule(css, /\.modal-mask\.sfv-glass-modal \.ranking-content\s*\{/);
  assert.match(content.body, /overflow-y:\s*auto/);
  assert.match(content.body, /min-height:\s*0/);
});

test('级联顺序钉：.secondary-* 外壳必须排在 ranking/playlist tab 之后（参照库 premium 层同序）', () => {
  const s = stripComments(css);
  const at = (sel) => {
    const i = s.lastIndexOf(sel);
    assert.ok(i > -1, `缺规则 ${sel}`);
    return i;
  };
  assert.ok(at('.secondary-toolbar{') > at('.ranking-platform-tabs{'), 'secondary-toolbar 上移会把平台 tab 的 padding 抢走');
  assert.ok(at('.secondary-toolbar{') > at('.playlist-square-tabs{'), '#ranking-chart-tabs 同时挂两类，后者须在前');
  assert.ok(at('.secondary-content{') > at('.ranking-content{'), '.secondary-content 的 padding 才是最终生效值');
});

test('电台弹窗头部插入 intro 条，且旧的同义 head 文案不重复留存', () => {
  const at = html.indexOf('id="home-radio-modes-mask"');
  assert.ok(at > -1);
  const block = html.slice(at, html.indexOf('id="home-local-modes-mask"', at));
  const introAt = block.indexOf('class="radio-intro"');
  assert.ok(introAt > -1, '电台弹窗缺 .radio-intro');
  assert.ok(block.indexOf('id="radio-mode-grid"') > introAt, 'intro 必须在网格之前');
  assert.match(block, /<strong>选一个状态，让音乐自己往下走<\/strong>/);
  assert.match(block, /优先从你的本地音乐与常听偏好中挑选，再由多平台搜索补足，每次生成 60 首。/);
  assert.match(block, /class="radio-intro-mark">点击卡片立即播放<\/div>/);
  assert.match(block, /aria-label="电台说明"/);
  assert.doesNotMatch(block, /<p>选一个状态，让音乐自己往下走/, 'head 里的同义旧文案须由 intro 取代，不留两条');
});
