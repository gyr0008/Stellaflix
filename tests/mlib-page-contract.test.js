'use strict';
/**
 * 音乐资料库页面层契约测试（Task 4，2026-10-18）
 * 断言 public/css/music-library.css 的像素语言 token 与 public/index.html 的骨架。
 * 运行：node --test tests/mlib-page-contract.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'music-library.css'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'modules', '04-shelf', '08-mlib-page.js'), 'utf8');

test('像素 token 契约', () => {
  for (const tok of ['126px', '150px', '22px', '56px', 'clamp(24px,3.2vw,56px)',
    'border-radius: 18px', 'border-radius: 50%', 'border-radius: 999px',
    'translateY(-4px)', 'translateY(22px) scale(.994)', 'blur(10px)', '.26s',
    'max-width: 1080px', 'max-width: 860px', 'max-width: 620px', 'max-width: 380px',
    'aspect-ratio: 1 / 1', 'rgba(255, 255, 255, .045)', '0 18px 48px rgba(0, 0, 0, .42)'])
    assert.ok(css.includes(tok), '缺 token: ' + tok);
  assert.ok(!css.includes('rgba(0, 245, 212'), '青色字面量违禁');
  assert.match(css, /var\(--home-accent\)/);
  assert.ok(/\.stella-mlib-/.test(css));
});

test('index.html 骨架', () => {
  assert.ok(html.includes('href="css/music-library.css"'));
  assert.ok(html.includes('id="music-library"'));
  for (const a of ['playlists', 'albums', 'artists']) assert.ok(html.includes('data-mlib-axis="' + a + '"'));
});

test('页面壳 id 约定到位', () => {
  for (const id of ['music-library', 'music-library-scroll', 'mlib-view-grid', 'mlib-view-detail',
    'mlib-grid-wrap', 'mlib-grid', 'mlib-state-box', 'mlib-detail-back', 'mlib-detail-head',
    'mlib-detail-tracks'])
    assert.ok(html.includes('id="' + id + '"'), '缺 id: ' + id);
  assert.ok(css.includes('#music-library'), 'CSS 必须保留 #music-library 根层选择器');
  // container-type 必须真正声明在 #mlib-grid-wrap 规则体内（挂在包裹层），
  assert.match(css, /#mlib-grid-wrap\s*\{[^}]*container-type/,
    'container-type 必须声明在 #mlib-grid-wrap 规则体内');
  // 且不得声明在滚动容器 #music-library-scroll 上（滚动容器上 container-type 会失效）。
  assert.doesNotMatch(css, /#music-library-scroll\s*\{[^}]*container-type/,
    'container-type 不得挂在滚动容器 #music-library-scroll 上');
});

test('body/html 类名契约（计划命名，非参考仓库命名）', () => {
  for (const cls of ['mlib-active', 'mlib-axis-playlists', 'mlib-axis-albums', 'mlib-axis-artists',
    'mlib-detail-open', 'mlib-leaving', 'stella-mlib-has-hover'])
    assert.ok(css.includes('.' + cls), '缺类名: ' + cls);
  // 参考仓库旧名不得泄漏进移植层
  assert.ok(!css.includes('music-library-active'), '禁止沿用参考仓库 body 类名');
  assert.ok(!css.includes('body.music-library-leaving'), '禁止沿用参考仓库 body 类名');
  assert.ok(!css.includes('html.mlib-has-hover'), 'html 悬停类必须是 stella-mlib-has-hover');
});

test('平台/导航残留违禁', () => {
  assert.ok(!css.includes('#mlib-nav'), '#mlib-nav 入口按钮必须删除');
  assert.ok(!css.includes('.stella-mlib-source-dot') && !css.includes('.mlib-source-dot'),
    '.mlib-source-dot 必须删除');
});

/* ---- Task 9-CSS：历次审查遗留的六条「样式无主」项，收编到唯一一批 owner 改动 ---- */

// ① 列数变量命名空间：--mlib-cols 全域收编为 --stella-mlib-cols。
test('列数变量命名空间收编（--stella-mlib-cols，旧名归零）', () => {
  assert.ok(css.includes('--stella-mlib-cols'), '必须改用 --stella-mlib-cols');
  assert.match(css, /var\(--stella-mlib-cols,\s*5\)/, 'grid-template-columns 的 var() 默认值必须改名');
  assert.ok(!css.includes('--mlib-cols'), '旧名 --mlib-cols 不得再出现（含 var() 默认值与 @container 定义）');
  // 8 处赋值 = 轴默认 3（歌单/专辑/艺人）+ @1080 艺人 1 + @860 艺人/歌单 2 + @620 三轴共用 1 + @380 三轴共用 1。
  // 批C-2（10-26）把 1080/860 两档按轴分开写：裸 #mlib-grid 的选择器特异度压不过轴默认值，
  // 老写法（4 条共用 @container + 3 条轴默认）里的容器查询实测从不生效，所以计数从 7 变 8，不是漂移。
  assert.equal((css.match(/--stella-mlib-cols:/g) || []).length, 8, '列数赋值必须恰为 8 处（3 轴默认 + 5 处降级声明）');
});

// ② 删死样式：.stella-mlib-skeleton 无生产者，整条删除；@keyframes stella-mlib-shimmer 保留。
test('骨架屏死样式删除、微光关键帧保留', () => {
  assert.ok(!css.includes('.stella-mlib-skeleton'), '.stella-mlib-skeleton 零生产者，必须删除');
  assert.match(css, /@keyframes\s+stella-mlib-shimmer/,
    'stella-mlib-shimmer 关键帧仍被 .stella-mlib-art::after 使用，必须保留');
});

// ③ 触摸分支两条规则的选择器同时覆盖方形封面 .stella-mlib-art 与圆形头像 .stella-mlib-artist-art。
test('触摸手势补齐：两条 :not(has-hover) 规则并列覆盖头像', () => {
  const cursorRule = css.match(/html:not\(\.stella-mlib-has-hover\)[^{}]*\{\s*cursor:\s*pointer\s*\}/);
  assert.ok(cursorRule, '缺触摸 cursor:pointer 规则');
  assert.ok(/\.stella-mlib-art(?![a-z])/.test(cursorRule[0]), 'cursor 规则须覆盖方形封面 .stella-mlib-art');
  assert.ok(cursorRule[0].includes('.stella-mlib-artist-art'), 'cursor 规则须并列覆盖圆形头像 .stella-mlib-artist-art');

  const activeRule = css.match(/html:not\(\.stella-mlib-has-hover\)[^{}]*\{\s*filter:\s*brightness\(\.94\)\s*\}/);
  assert.ok(activeRule, '缺触摸 :active 反馈规则');
  assert.ok(/\.stella-mlib-art(?![a-z])/.test(activeRule[0]), ':active 规则须覆盖方形封面 .stella-mlib-art');
  assert.ok(activeRule[0].includes('.stella-mlib-artist-art'), ':active 规则须并列覆盖圆形头像 .stella-mlib-artist-art');
});

// ④ 状态盒子元素三枚类各至少一条样式规则；按钮复用玻璃语汇且 pointer。
test('状态盒子元素三枚类各有样式规则', () => {
  for (const cls of ['stella-mlib-state-heading', 'stella-mlib-state-hint', 'stella-mlib-state-btn']) {
    assert.match(css, new RegExp('\\.' + cls + '[^{}]*\\{[^}]+\\}'), cls + ' 必须有样式规则');
  }
  assert.match(css, /\.stella-mlib-state-btn[^{}]*\{[^}]*cursor:\s*pointer/, 'state-btn 必须 cursor:pointer');
});

// ⑤ 状态盒共享钩子：#mlib-state-box 三条规则改联合形式，详情状态盒 JS 真的打上该类。
test('详情状态盒有样式：.stella-mlib-state-box 联合钩子 + JS 挂类', () => {
  assert.match(css, /#mlib-state-box\s*,\s*\.stella-mlib-state-box\s*\{/, '基础态必须联合 .stella-mlib-state-box');
  assert.match(css, /#mlib-state-box:empty\s*,\s*\.stella-mlib-state-box:empty\s*\{/, ':empty 必须联合类');
  assert.match(css, /#mlib-state-box\[data-tone="warn"\]\s*,\s*\.stella-mlib-state-box\[data-tone="warn"\]\s*\{/,
    'warn 态必须联合类');
  assert.match(js, /classList\.add\(\s*['"]stella-mlib-state-box['"]\s*\)/, '详情状态盒必须挂 .stella-mlib-state-box');
});

// ⑥ 三轴卡一律可开详情（buildCard 无条件挂 is-openable）→ 卡片上的 :not(.is-openable) 手势分支永远命中不到。
test('卡片不可开态死样式不得回归（:not(.is-openable) 分支已删）', () => {
  assert.ok(!css.includes(':not(.is-openable)'),
    '该分支无生产者：留着会让后来人以为存在「不可点的卡」');
});

/* ---- 终审回批 F3/F4/F6：参照库漏移植的三处壳层节点 + 真死样式清除 ---- */

// F3：参照库 index.html:300-302 的壳层页头（在 #music-library-scroll 之内、各视图之前，详情页时也常驻）。
// 当时只搬了 CSS 没搬 DOM，.stella-mlib-page-head/.stella-mlib-title 因此成了死样式，
// #music-library 也缺参照库那份 aria-label。
test('F3 壳层页头已移植：滚动容器首个子节点＝.stella-mlib-page-head（eyebrow + h1 标题）', () => {
  const scrollAt = html.indexOf('<div id="music-library-scroll">');
  assert.ok(scrollAt >= 0, '缺 #music-library-scroll');
  const seg = html.slice(scrollAt, scrollAt + 400);
  assert.match(seg, /^<div id="music-library-scroll">\s*<header class="stella-mlib-page-head">/,
    '页头必须是 #music-library-scroll 的首个子节点（在两个视图之前，详情页时也常驻）');
  assert.match(seg, /<div class="stella-mlib-eyebrow">MUSIC LIBRARY<\/div>/, 'eyebrow 文案照参照库一字不改');
  assert.match(seg, /<h1 class="stella-mlib-title">音乐资料库<\/h1>/, '标题照参照库一字不改');
  // 无障碍名（参照库 #music-library 上就有）：aria-hidden 是页面层的可访问性真相源，二者并存不冲突
  assert.match(html, /<section id="music-library"[^>]*aria-label="音乐资料库"/, '#music-library 必须有无障碍名');
  // 类名一律按本仓改名规则，参照库旧名不得泄漏
  assert.ok(!html.includes('class="mlib-page-head"') && !html.includes('class="mlib-title"'),
    '不得沿用参照库类名');
  // 这两条样式规则本就在 CSS 里（F3 之前是无主死样式，现在终于有节点可挂）
  assert.ok(css.includes('.stella-mlib-page-head') && css.includes('.stella-mlib-title'),
    '页头/标题样式规则保留');
});

// F4：参照库 index.html:424 的收尾占位＝滚动容器最后一个子节点（在两个视图之后）。
// 少了它，列表最后一行会被底部 mask 的淡出带压住——冒烟清单「最后一行不被压住」靠的就是这个节点。
test('F4 列表收尾占位＝滚动容器的最后一个子节点', () => {
  const scrollAt = html.indexOf('<div id="music-library-scroll">');
  const seg = html.slice(scrollAt, html.indexOf('</section>', scrollAt));
  assert.match(seg, /<div class="stella-mlib-end-cap" aria-hidden="true"><\/div>\s*<\/div>\s*$/,
    'end-cap 必须在网格视图与详情视图之后、滚动容器收口之前（参照库同一位置）');
  assert.match(css, /\.stella-mlib-end-cap\s*\{\s*height:\s*24px/, '样式保留（height:24px），现在终于有节点可挂');
});

// F6：返回钮补成参照库形态（svg 折角 + <span> 文本）——#mlib-detail-back svg 那条样式此前无节点可挂。
// 不加自造 aria-label（span 文本已是无障碍名），也不发明按轴文案。
test('F6 返回钮＝svg 折角 + <span>返回</span>', () => {
  assert.match(html,
    /<button id="mlib-detail-back" type="button">\s*<svg viewBox="0 0 16 16" fill="none" stroke="currentColor"[\s\S]*?aria-hidden="true">\s*<path d="M10 4l-4 4 4 4" \/>\s*<\/svg>\s*<span>返回<\/span>\s*<\/button>/,
    '返回钮必须是参照库那枚 svg 折角 + 文本 span（svg 一律 aria-hidden，无障碍名取 span 文本）');
  assert.match(css, /#mlib-detail-back svg/, 'svg 尺寸规则保留');
  assert.ok(!html.includes('返回艺人列表'), '不发明按轴文案：返回钮只写「返回」');
});

// F6：三条真死样式。取证＝参照库 public/ 全库 0 命中、本仓 JS 里没有生产者
// （详情头用的是 -eyebrow/-detail-title/-head-meta；-idle 变量的收紧规则属播放器可见性子系统，不搬）。
test('F6 真死样式清除：详情头两条无生产者规则 + 一枚无人消费的变量归零', () => {
  for (const dead of ['.stella-mlib-detail-artist', '.stella-mlib-detail-facts', '--stella-mlib-safe-bottom-idle']) {
    assert.ok(!css.includes(dead), dead + ' 无生产者也没有消费者，必须删除');
  }
  // 详情头真正在用的三条必须原样健在（别把邻居顺手删了）
  for (const alive of ['.stella-mlib-eyebrow', '.stella-mlib-detail-title', '.stella-mlib-head-meta']) {
    assert.ok(css.includes(alive), alive + ' 是详情头实际挂的类，必须保留');
  }
  assert.match(css, /--stella-mlib-safe-bottom:\s*150px/, '同名在用的 --stella-mlib-safe-bottom 不得被连带删掉');
  // 生产者在场的两条不得被误删（F3 页头、F4 收尾占位各一条）
  assert.ok(css.includes('.stella-mlib-end-cap'), 'end-cap 样式随 F4 一起收编，不是死样式');
});
