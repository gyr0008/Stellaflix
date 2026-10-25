'use strict';

/**
 * tests/cover-wallpaper-board-hides-crossfade-layer.test.js
 * —— 壁纸背景板态必须同时隐藏封面模糊底图的「交叉淡入孪生层」#album-bg-next
 *
 * 【问题】（2026-10-25 真机录屏复现，19:31）
 *   开壁纸模式（展示位置=播放器背景板）→ 第一首正常显示封面壁纸；
 *   切到第二首 → 壁纸消失，只剩窗口四周一圈光晕，中间变成「项目原有背景」。
 *
 * 【根因】
 *   `#album-bg` 与 `#album-bg-next` 是切歌交叉淡入的两块孪生层
 *   （public/js/modules/03-beat/05-cover-loading-crop.js:80 setAlbumBackground，
 *     按 albumBackgroundSlot 在两者之间交替加 .visible）。
 *   两者都是 position:fixed;inset:0;z-index:0（index.css:1163-1177），
 *   且 #album-bg-next 在 DOM 里排在 #cover-wallpaper-board 之后
 *   （index.html:94 board → :104 #album-bg → :105 #album-bg-next），
 *   = 同 z-index 下后出现的盖住前面的。
 *   而板态隐藏规则（index.css:1126）只写了 #album-bg，**漏了 #album-bg-next**：
 *     body.cover-wallpaper-board-active #album-bg,
 *     body.cover-wallpaper-board-active #custom-bg,
 *     body.cover-wallpaper-board-active #theme-bg-tint { opacity:0!important }
 *
 *   于是：首曲时槽位在 #album-bg（被隐藏）→ 板可见；
 *        切歌时 incoming 换成 #album-bg-next 并加 .visible → 透明度变
 *        var(--custom-bg-album-opacity, 1) ≈ 1 → 一层 blur(120px) brightness(.18)
 *        的新封面糊层盖在板上面：中间被压暗成「原有背景」，只有四边因 blur 采到
 *        透明像素而露出板的亮部 —— 这就是用户说的「窗口周围一圈光晕」。
 *        再切一首槽位回到 #album-bg（被隐藏）→ 又正常，形成「隔一首坏一次」。
 *
 * 【为什么不能照抄参照库】
 *   Mineradio-2.5.1 根本没有 #album-bg-next 这一层（grep public/index.html
 *   public/app.js 零命中），它的板元素是单层 #wallpaper-board，所以它的
 *   `body.wallpaper-board-active #album-bg{opacity:0!important}` 天然不需要孪生层。
 *   #album-bg-next 是本项目后加的交叉淡入层；加的时候只补了
 *   wallpaper-engine-active / wallpaper-engine-dwm-active / custom-background-override /
 *   sonic-workshop-active 四处隐藏列表，独独漏了板态这一处。
 *
 * 【锁定契约】
 *   A. 任何把 #album-bg 置 0 的 body.<class> 规则，必须同时把 #album-bg-next 置 0；
 *   B. 板态规则必须显式覆盖 #album-bg-next；
 *   C. DOM 顺序守卫：board 画布确实排在孪生层之前（否则本条不成立，守卫需重审）；
 *   D. index.html 的 CSS 版本号非空（否则改了 CSS 用户端可能读缓存）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_ROOT = path.join(__dirname, '..');
const CSS_PATH = path.join(APP_ROOT, 'public/css/index.css');
const HTML_PATH = path.join(APP_ROOT, 'public/index.html');
const CROSSFADE_JS = path.join(APP_ROOT, 'public/js/modules/03-beat/05-cover-loading-crop.js');

const CSS = fs.readFileSync(CSS_PATH, 'utf8');
const HTML = fs.readFileSync(HTML_PATH, 'utf8');
// 折叠所有空白，便于用「选择器字面量」直接判定是否覆盖某一层。
const CSS_NORM = CSS.replace(/\s+/g, ' ');

/** 把 CSS 拆成 {selector, body} 列表，够用即可（本文件不含嵌套 @media 干扰项）。 */
function parseRules(css) {
  // 先剥掉注释：否则注释会黏在下一个选择器前面，导致 ^body. 锚点匹配失败（曾造成假绿）。
  const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = re.exec(cleaned))) {
    rules.push({
      selector: match[1].replace(/\s+/g, ' ').trim(),
      body: match[2].replace(/\s+/g, ' ').trim(),
    });
  }
  return rules;
}

/** 找出「在 body.<class> 上下文里把 #album-bg 置 0」的规则，返回涉及的 body class 集合。 */
function boardLikeHideRuleClasses() {
  const classes = new Set();
  for (const rule of parseRules(CSS)) {
    if (!/opacity:\s*0\s*(?:!\s*important)?/i.test(rule.body)) continue;
    const selectors = rule.selector.split(',').map((item) => item.trim());
    for (const selector of selectors) {
      // 只认精确的 #album-bg（负向前瞻排除 #album-bg-next / #album-bg-foo）
      const hit = /body\.([A-Za-z0-9_-]+)\s+#album-bg(?![\w-])/.exec(selector);
      if (hit) classes.add(hit[1]);
    }
  }
  return classes;
}

/** CSS 里是否存在形如 `body.<class> #album-bg-next` 的选择器（后接边界字符）。 */
function hidesCrossfadeLayer(cls) {
  const needle = 'body.' + cls + ' #album-bg-next';
  let from = 0;
  while (true) {
    const at = CSS_NORM.indexOf(needle, from);
    if (at < 0) return false;
    const after = CSS_NORM.charAt(at + needle.length);
    if (!/[\w-]/.test(after)) return true;
    from = at + needle.length;
  }
}

test('① 通用不变量：凡隐藏 #album-bg 的 body 态，必须同时隐藏 #album-bg-next', () => {
  const classes = boardLikeHideRuleClasses();
  assert.ok(classes.size >= 2, `至少要找到多个隐藏态，实际 ${classes.size}`);
  const missing = [...classes].filter((cls) => !hidesCrossfadeLayer(cls));
  assert.deepEqual(missing, [],
    `这些 body 态隐藏了 #album-bg 却没隐藏它的交叉淡入孪生层 #album-bg-next：${missing.join(', ')}`);
});

test('② 板态规则必须显式覆盖 #album-bg-next（切歌后盖住壁纸的就是它）', () => {
  assert.match(CSS, /body\.cover-wallpaper-board-active\s+#album-bg-next(?![\w-])/,
    '缺这一条：切歌时新封面会写入 #album-bg-next 并 .visible，直接盖掉壁纸背景板');
});

test('③ DOM 顺序守卫：board 画布排在孪生层之前，所以必须靠隐藏列表让位', () => {
  const boardAt = HTML.indexOf('id="cover-wallpaper-board"');
  const albumAt = HTML.indexOf('id="album-bg"');
  const nextAt = HTML.indexOf('id="album-bg-next"');
  const canvasAt = HTML.indexOf('id="canvas-container"');
  assert.ok(boardAt > 0 && albumAt > 0 && nextAt > 0 && canvasAt > 0, '四个层都要存在');
  assert.ok(boardAt < albumAt, 'board 画布必须排在 #album-bg 之前（z-index 同为 0 时后者盖前者）');
  assert.ok(albumAt < nextAt, '#album-bg 在 #album-bg-next 之前');
  assert.ok(boardAt < canvasAt, 'board 画布排在 3D 容器之前（3D 为 z=1 透明底，属设计如此）');
});

test('④ 取证守卫：参照库没有 #album-bg-next，所以它的板态规则不能照抄过来', () => {
  const refHtml = path.join(APP_ROOT, '..', 'Mineradio-2.5.1', 'public', 'index.html');
  const refApp = path.join(APP_ROOT, '..', 'Mineradio-2.5.1', 'public', 'app.js');
  if (!fs.existsSync(refHtml) || !fs.existsSync(refApp)) return; // 参照库不在同层时跳过
  const refText = fs.readFileSync(refHtml, 'utf8') + fs.readFileSync(refApp, 'utf8');
  assert.doesNotMatch(refText, /album-bg-next/,
    '参照库确实没有孪生层；若它也有了，说明结论需重审');
});

test('⑤ 交叉淡入层确实是靠 .visible + 交替槽位显示（缺陷链前提）', () => {
  const js = fs.readFileSync(CROSSFADE_JS, 'utf8');
  assert.match(js, /getElementById\('album-bg-next'\)/, '孪生层由 setAlbumBackground 管理');
  assert.match(js, /incoming\.classList\.add\('visible'\)/, '切歌时 incoming 会被点亮');
  assert.match(js, /albumBackgroundSlot\s*=\s*albumBackgroundSlot\s*===\s*0\s*\?\s*1\s*:\s*0/,
    '两块层交替使用 —— 所以表现为「隔一首坏一次」');
});

test('⑥ CSS 版本号非空，保证改动能在客户端生效（不会被缓存）', () => {
  const match = /<link[^>]+href="css\/index\.css\?v=([^"]+)"/.exec(HTML);
  assert.ok(match, 'index.html 必须以 ?v= 形式引用 index.css');
  assert.ok(String(match[1] || '').trim().length >= 8, '版本号不得为空或过短');
});
