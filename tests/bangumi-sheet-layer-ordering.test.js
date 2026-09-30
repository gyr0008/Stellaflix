'use strict';

/**
 * 番剧「时间机器」季度面板：全屏遮罩 -> 按钮下拉（用户 2026-09-27 确认方案）
 * 运行：node --test tests/bangumi-sheet-layer-ordering.test.js
 *
 * 历史根因（同日上一批修复）：
 *  - 旧版 .sfv-bgm-tl-sheet-mask 与 .sfv-bgm-modal-overlay 平级 2147482000，
 *    靠 DOM 挂载顺序决胜，面板会被每周新番弹窗压住 → 曾抬到 2147482010。
 *
 * 本批形态变更：
 *  - 删除全屏遮罩 sheet-mask：点「2026年夏季新番 ▾」后面板直接锚定在按钮下方弹出；
 *  - .sfv-bgm-tl-sheet 自持 position:fixed + z-index，仍严格高于弹窗遮罩
 *    (.sfv-bgm-modal-overlay 2147482000)，且守 z-index 铁律 < 2147482099；
 *  - JS 不再构造 .sfv-bgm-tl-sheet-mask。
 *
 * 断言面为 CSS/JS 源码契约（与 world-titlebar-peek.test.js 同风格）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const calCss = fs.readFileSync(path.join(root, 'public/video/bangumi-calendar.css'), 'utf8');
const tlCss = fs.readFileSync(path.join(root, 'public/video/bangumi-timeline.css'), 'utf8');
const tlJs = fs.readFileSync(path.join(root, 'public/video/bangumi-timeline.js'), 'utf8');
const playerCss = fs.readFileSync(path.join(root, 'public/video/player.css'), 'utf8');

function rule(selector, css) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
  const m = css.match(re);
  assert.ok(m, `缺少规则 ${selector}`);
  return m[1];
}

test('全屏遮罩已删除：CSS 无 .sfv-bgm-tl-sheet-mask 规则，JS 不再构造该节点', () => {
  assert.doesNotMatch(tlCss, /\.sfv-bgm-tl-sheet-mask\s*\{/, 'CSS 不应再有 sheet-mask 规则');
  assert.doesNotMatch(tlJs, /sfv-bgm-tl-sheet-mask/, 'JS 不应再创建 sheet-mask 节点');
});

test('时间机器面板为 fixed 下拉，z-index 严格高于弹窗遮罩且守铁律', () => {
  const b = rule('.sfv-bgm-tl-sheet', tlCss);
  assert.match(b, /position:\s*fixed/, '面板必须 fixed，锚定按钮下方挂 body');
  const z = b.match(/z-index:\s*(\d+)/);
  assert.ok(z, '.sfv-bgm-tl-sheet 必须显式 z-index');
  const overlayZ = Number(rule('.sfv-bgm-modal-overlay', calCss).match(/z-index:\s*(\d+)/)[1]);
  assert.ok(Number(z[1]) > overlayZ, `sheet ${z[1]} 应 > overlay ${overlayZ}`);
  assert.ok(Number(z[1]) < 2147482099, `sheet ${z[1]} 越过 2147482099 铁律`);
  assert.match(b, /max-height:/, '20 年季度列表必须限高内滚，防下拉撑出视口');
});

test('追番弹层仍高于每周新番弹窗遮罩（上一批约束不回退）', () => {
  const popZ = Number(rule('.sfv-bgm-pop', calCss).match(/z-index:\s*(\d+)/)[1]);
  const overlayZ = Number(rule('.sfv-bgm-modal-overlay', calCss).match(/z-index:\s*(\d+)/)[1]);
  assert.ok(popZ > overlayZ, `pop ${popZ} 应 > overlay ${overlayZ}`);
  assert.ok(popZ < 2147482099, `pop ${popZ} 越过 2147482099 铁律`);
});

// 2026-09-27 真机「点击无反应」根因：影视态下 player.css 把每周新番遮罩整体抬到
// 2147483500（高于铁律上限），而 sheet/pop 仍按 2147482010/2020 挂 body →
// 下拉被 78% 黑遮罩盖住且点外即被自己的捕获监听关掉。影视态两套 body class 都须同步抬升。
test('影视态下时间机器下拉与追番弹层仍高于被抬升的每周新番遮罩', () => {
  const stateOverlayZ = Number(
    playerCss.match(/body\.video-space-active > \.sfv-bgm-modal-overlay[^{]*\{[^}]*z-index:\s*(\d+)/)[1]
  );
  for (const cls of ['sfv-bgm-tl-sheet', 'sfv-bgm-pop']) {
    const m = playerCss.match(
      new RegExp('body\\.video-space-active > \\.(' + cls + ')[^{]*\\{([^}]*)\\}')
    );
    assert.ok(m, `player.css 缺 body.video-space-active > .${cls} 抬升规则`);
    const z = m[2].match(/z-index:\s*(\d+)/);
    assert.ok(z, `.${cls} 影视态规则必须显式 z-index`);
    assert.ok(Number(z[1]) > stateOverlayZ, `${cls} ${z[1]} 应 > 影视态 overlay ${stateOverlayZ}`);
    assert.match(
      playerCss,
      new RegExp('body\\.video-player-active > .' + cls),
      `.${cls} 缺 video-player-active 变体（播放态同样会盖）`
    );
  }
});

// 2026-09-27 第二批形态：面板宽度对齐「2026年夏季新番 ▾」按钮，× 关闭钮与可见滚动条删除，
// 年份列表仍可滚（overflow 保留）但滚动条隐藏；再点一次按钮 = 向上收起。
test('面板去掉 × 关闭钮：CSS 无 sheet-close 规则，JS 不再构造该节点', () => {
  assert.doesNotMatch(tlCss, /\.sfv-bgm-tl-sheet-close\s*\{/, 'CSS 不应再有 sheet-close 规则');
  assert.doesNotMatch(tlJs, /sfv-bgm-tl-sheet-close/, 'JS 不应再创建 sheet-close 节点');
});

test('面板仍可滚但隐藏滚动条，且宽度改为跟随按钮', () => {
  const b = rule('.sfv-bgm-tl-sheet', tlCss);
  assert.match(b, /overflow:\s*(auto|scroll)/, '年份列表仍须可滚，只是不显示滚动条');
  assert.match(b, /scrollbar-width:\s*none/, 'Firefox/标准侧须隐藏滚动条');
  assert.match(
    tlCss,
    /\.sfv-bgm-tl-sheet::-webkit-scrollbar\s*\{[^}]*display:\s*none/,
    'Chromium 侧须隐藏滚动条'
  );
  const open = tlJs.slice(tlJs.indexOf('function openSeasonSheet'), tlJs.indexOf('function closeSeasonSheet'));
  assert.match(open, /r\.width/, '面板宽度须取按钮矩形宽');
  assert.doesNotMatch(open, /Math\.max\(320/, '不得再硬下限 320px（比按钮宽即违约）');
  assert.match(open, /sheet\.style\.width\s*=/, 'JS 仍按按钮矩形写宽度');
});

test('再次点击季度按钮向上收起：外点监听须放过按钮，切换判定交给按钮', () => {
  assert.match(
    tlJs,
    /_sheetDocClick = function \(e\) \{[\s\S]{0,200}?_seasonSheetAnchor[\s\S]{0,120}?contains/,
    'document 捕获阶段的外点监听若不排除按钮，二次点击会被先关后开，toggle 失效'
  );
  const handler = tlJs.slice(tlJs.indexOf('seasonBtn.addEventListener'), tlJs.indexOf('seasonBtn.addEventListener') + 400);
  assert.match(
    handler,
    /if \(_seasonSheet\)[\s\S]{0,120}?closeSeasonSheet\(\);[\s\S]{0,160}?return;/,
    '按钮点击处理须先判已开即收'
  );
});
