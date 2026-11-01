// tests/mlib-detail-modal-css.test.js —— 批D Task 1：弹窗壳与度量移植（纯静态断言，不跑 JS）
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'music-library.css'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// 取某选择器块体（做花括号配对；不识别注释，注释里的花括号也会计入配对）
function blockBody(source, selector) {
  const at = source.indexOf(selector + ' {');
  assert.notEqual(at, -1, '找不到选择器 ' + selector);
  let i = source.indexOf('{', at), depth = 0, start = i + 1;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start, i); }
  }
  throw new Error('括号不平衡：' + selector);
}

// 批D 终审 Minor a：blockBody 取「首个文本命中」，而 `.stella-mlib-shuffle-btn {` 同时是
// 轴闸选择器 `body.mlib-axis-albums #mlib-detail-modal .stella-mlib-shuffle-btn {` 的后缀。
// 闸若挪到基座规则前面，度量断言就会量到 `{display:none}` 那档＝假红。
// 行首锚定（前置换行）+ 唯一性断言：不唯一直接报错，不再静默取错档。
function blockBodyAnchored(source, selector) {
  const needle = '\n' + selector + ' {';
  const first = source.indexOf(needle);
  assert.notEqual(first, -1, '找不到行首选择器 ' + selector);
  assert.equal(source.indexOf(needle, first + 1), -1,
    '选择器 ' + selector + ' 在行首出现多次，块体断言会取错档');
  return blockBody(source.slice(first), selector);
}

test('弹窗壳：mask/modal/scroll/foot 与全部 id 在 index.html 就位', () => {
  ['#mlib-detail-modal', '#mlib-detail-modal-scroll', '#mlib-detail-modal-cover',
   '#mlib-detail-modal-kicker', '#mlib-detail-modal-heading', '#mlib-detail-modal-artist',
   '#mlib-detail-modal-desc', '#mlib-detail-modal-desc-toggle', '#mlib-detail-modal-facts',
   '#mlib-detail-modal-play', '#mlib-detail-modal-play-label', '#mlib-detail-modal-shuffle',
   '#mlib-detail-modal-status', '#mlib-detail-modal-tracks'].forEach((id) => {
    // brief 的 id 表带 # 前缀（选择器口径）；HTML 侧逐字比对按本仓既有惯例取 id="..." 属性
    // （同 tests/mlib-page-contract.test.js:38）。id 列表与失败文案保持 brief 原文。
    assert.ok(html.includes('id="' + id.slice(1) + '"'), 'index.html 缺 ' + id);
  });
  assert.match(html, /id="mlib-detail-modal" class="modal-mask"/, 'mask 必须复用既有 .modal-mask 基座');
  assert.match(html, /class="modal stella-mlib-modal"/, '窗口必须带 .modal 基类（GSAP 找它做面板）');
  assert.match(html, /aria-modal="true"[^>]*>\s*<div class="modal stella-mlib-modal"/, 'role=dialog 的 aria-modal 要挂在 mask 上');
});

test('窗口度量＝参照库 2116-2135 逐字（1080/88vh/900/26px/168deg）', () => {
  const b = blockBody(css, '#mlib-detail-modal .modal.stella-mlib-modal');
  ['width: min(1080px, calc(100vw - 56px)) !important',
   'max-width: min(1080px, calc(100vw - 56px)) !important',
   'max-height: min(88vh, 900px) !important',
   'border-radius: 26px !important',
   'padding: 0 !important',
   'linear-gradient(168deg'].forEach((f) => assert.ok(b.includes(f), '窗口缺 ' + f));
});

test('主题变量深色降级默认值写在 mask 节点（关窗即消失）', () => {
  const b = blockBody(css, '#mlib-detail-modal');
  ['--stella-mlib-theme-a: 30, 42, 52', '--stella-mlib-theme-light: 46, 62, 74',
   '--stella-mlib-theme-dark: 16, 23, 29', '--stella-mlib-theme-glow: 64, 104, 120'].forEach((f) =>
    assert.ok(b.includes(f), '降级色缺 ' + f));
  assert.ok(!css.includes('--am-theme-'), '参照库的 --am-theme-* 不得带进本仓');
});

test('信息区/滚动/底栏/操作区度量逐字（268 封面列 / 26 内衬 / 44 播放钮）', () => {
  assert.match(blockBody(css, '.stella-mlib-modal-info'), /grid-template-columns: minmax\(200px, 268px\) minmax\(0, 1fr\)/);
  assert.match(blockBody(css, '.stella-mlib-modal-scroll'), /padding: 26px 26px 8px/);
  assert.match(blockBody(css, '.stella-mlib-modal-cover'), /aspect-ratio: 1 \/ 1/);
  assert.match(blockBody(css, '.stella-mlib-modal-foot'), /padding: 12px 22px 16px/);
  assert.match(blockBody(css, '.stella-mlib-modal-play'), /height: 44px/);
  assert.match(blockBodyAnchored(css, '.stella-mlib-shuffle-btn'), /width: 44px/);
  assert.match(blockBody(css, '.stella-mlib-modal-tracks'), /margin-top: 26px/);
});

test('随机钮只在歌单：CSS 用轴类闸（参照库 index.html:2068 注释口径）', () => {
  assert.match(css, /body\.mlib-axis-albums #mlib-detail-modal \.stella-mlib-shuffle-btn\s*\{\s*display: none/,
    '专辑轴必须隐藏随机钮');
});

test('按轴分流：全屏详情视图只剩艺人轴（专辑/歌单走弹窗）', () => {
  assert.match(css, /body\.mlib-detail-open\.mlib-axis-artists #mlib-view-detail/, '艺人轴才铺全屏详情');
  assert.doesNotMatch(css, /body\.mlib-detail-open #mlib-view-detail\s*\{/,
    '旧的「任何轴都铺全屏详情」闸必须收掉（否则专辑点开是双份）');
});

// 批D 终审 Important⑥：spec §2 那串「实测」数字（1080/268/1026/587）量的是离屏夹具
// tests/fixtures/mlib-detail-probe-ours.html，而夹具的弹窗子树是 index.html 的**手工副本**。
// 手工副本一旦与生产漂移，那些数字会继续以「实测」口径被人信 ⇒ 本条把两侧 id 钉成同一份：
// 生产新增/改名一个弹窗节点而夹具没跟上，这里当场红（不是让夹具永远等于生产，是让「不等」必须被看见）。
// 例外表＝生产里带 hidden、布局中性因此夹具故意不搬的三枚（副本注释也写了这三枚）。
// R14（终审复评 New-Issue）：夹具原在 `.scratch/`（未跟踪、也没被 gitignore）——被跟踪的测试运行期读它，
// 新克隆／CI 会以 ENOENT 红，把「夹具不在」冒充成「副本漂移」⇒ 夹具移进 tests/fixtures/ 随包入库。
// 射程声明（同复评 Minor）：本条只钉 id 集合，class／嵌套／文案不在射程；夹具仍带 `show` 类与手写文案。
test('夹具与生产的弹窗 id 集合同构（只钉 id，class/嵌套不在射程）', () => {
  const probePath = path.join(__dirname, 'fixtures', 'mlib-detail-probe-ours.html');
  assert.ok(fs.existsSync(probePath), '夹具 tests/fixtures/mlib-detail-probe-ours.html 缺席 ⇒ spec §2 的实测数字失去可复算的载体');
  const probe = fs.readFileSync(probePath, 'utf8');
  const MODAL_IDS = ['#mlib-detail-modal', '#mlib-detail-modal-scroll', '#mlib-detail-modal-cover',
    '#mlib-detail-modal-kicker', '#mlib-detail-modal-heading', '#mlib-detail-modal-artist',
    '#mlib-detail-modal-desc', '#mlib-detail-modal-desc-toggle', '#mlib-detail-modal-facts',
    '#mlib-detail-modal-play', '#mlib-detail-modal-play-label', '#mlib-detail-modal-shuffle',
    '#mlib-detail-modal-status', '#mlib-detail-modal-tracks'].map((id) => id.slice(1));
  const LAYOUT_NEUTRAL_OMITTED = ['mlib-detail-modal-desc', 'mlib-detail-modal-desc-toggle', 'mlib-detail-modal-status'];
  MODAL_IDS.forEach((id) => {
    const inProd = html.includes('id="' + id + '"');
    const inProbe = probe.includes('id="' + id + '"');
    assert.equal(inProd, true, '生产 index.html 缺弹窗 id ' + id + '（上面那条 id 表已失效）');
    if (LAYOUT_NEUTRAL_OMITTED.indexOf(id) >= 0) {
      assert.equal(inProbe, false, '夹具故意不搬布局中性的 ' + id + '；它出现在夹具里说明副本改过，请核对度量');
    } else {
      assert.equal(inProbe, true, '夹具缺弹窗 id ' + id + ' ⇒ 它量出的度量不再是生产子树的度量（或本条例外表该更新）');
    }
  });
});
