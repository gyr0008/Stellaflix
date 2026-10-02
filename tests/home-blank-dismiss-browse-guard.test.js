'use strict';

/**
 * 回归测试：影视浏览层（#sfv-browse）内的空白点击不得触发音乐态「点空白关 Home」。
 *
 * 背景（2026-09-25 实测复现）：home→片库页浏览（海报墙挂载后点/拖任意非按钮区域）
 * → 04-home-empty-wallpaper.js 的 document 捕获阶段空白关闭处理器把 body.empty-home-active
 * 摘掉（片库页覆盖层透明铺满视口，点击坐标必然落在 #empty-home 矩形内）→
 * 点返回关闭浏览层后首页已透明 → 用户只见粒子星空。
 *
 * 契约：isHomeBlankDismissClick 在 #sfv-browse.sfv-show（浏览层可见）时一律返回 false；
 * 音乐态（无浏览层）行为不变。
 *
 * 运行：node --test tests/home-blank-dismiss-browse-guard.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'modules', '05-playback', '04-home-empty-wallpaper.js'),
  'utf8'
);

function fakeClassList() {
  const s = new Set();
  return {
    add: (c) => s.add(c),
    remove: (c) => s.delete(c),
    toggle: (c, on) => { if (on === undefined) on = !s.has(c); on ? s.add(c) : s.delete(c); },
    contains: (c) => s.has(c),
  };
}

function makeEl(rect) {
  return {
    classList: fakeClassList(),
    style: {},
    children: [],
    getBoundingClientRect: () => rect || { left: 0, top: 0, width: 1280, height: 800, right: 1280, bottom: 800 },
    addEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    setAttribute() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    // 归属判定依赖：真实 DOM 的 contains 含自身，深度优先递归子节点
    contains(node) {
      if (node === this) return true;
      for (const c of this.children) { if (c && c.contains && c.contains(node)) return true; }
      return false;
    },
    closest() { return null; }, // 模拟：不在任何受保护选择器内
  };
}

function loadModule() {
  const body = makeEl();
  const home = makeEl();
  const browse = makeEl();
  const overlay = makeEl(); // 影视播放器 #sfv-overlay（body 直接子元素，铺满视口）
  const doc = {
    body,
    documentElement: makeEl(),
    createElement: () => makeEl(),
    getElementById: (id) => (id === 'empty-home' ? home : id === 'sfv-browse' ? browse : id === 'sfv-overlay' ? overlay : null),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
  };
  const sandbox = {
    document: doc,
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    clearTimeout,
    Promise, Date, Math, JSON, RegExp, String, Number, Object, Array, Error, Set, Map,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  sandbox.emptyHomeActive = true; // 模拟 Home 正显示
  // Home 内的空白节点：真实「点空白关 Home」的 target 必须属于 #empty-home 子树。
  // 旧用例直接传 { closest: () => null } 的游离对象，加归属判定后会被判 false，
  // 故统一改为 Home 后代，保证每个用例考验的是它该考验的守卫，而不是碰巧命中归属判定。
  const homeBlank = makeEl();
  home.appendChild(homeBlank);
  HOME_BLANK = homeBlank;
  return { sandbox, doc, body, home, browse, overlay, homeBlank };
}

// 默认点击目标 = Home 内的空白节点（音乐态语义）
let HOME_BLANK = null;
function blankClickEvent(target) {
  return {
    button: 0,
    defaultPrevented: false,
    clientX: 640,
    clientY: 400,
    target: target || HOME_BLANK,
  };
}

test('音乐态基线：Home 显示时空白点击仍判定为关闭 Home（行为不变）', () => {
  const { sandbox } = loadModule();
  assert.strictEqual(sandbox.isHomeBlankDismissClick(blankClickEvent()), true);
});

test('片库页可见时：浏览层内空白点击不得判定为关闭 Home', () => {
  const { sandbox, browse } = loadModule();
  browse.classList.add('sfv-show'); // #sfv-browse 覆盖层打开（片库/历史/任何浏览页）
  assert.strictEqual(
    sandbox.isHomeBlankDismissClick(blankClickEvent()),
    false,
    '浏览层在 Home 之上，其内点击不是「Home 空白」语义，否则返回后首页已被摘类 → 只剩粒子星空'
  );
});

test('对照：浏览层存在但未显示（sfv-show 已移除）时不拦截', () => {
  const { sandbox, browse } = loadModule();
  browse.classList.add('sfv-browse--browse'); // 有类但层未打开
  assert.strictEqual(sandbox.isHomeBlankDismissClick(blankClickEvent()), true);
});

// ---------------------------------------------------------------- 影视播放器守卫
// 背景（2026-10-01 复现）：影视播放器 #sfv-overlay 铺满视口叠在 Home 之上，
// 点画面（取消静音）/ 拖进度条（.sfv-progress 是非 button 的 div）的坐标必然落在
// #empty-home 矩形内 → 捕获阶段的「点空白关 Home」摘掉 empty-home-active →
// 退出播放器后首页透明只剩粒子星空。修复：播放器可见时一律不判定为 Home 空白点击。

test('影视播放器打开时（#sfv-overlay.sfv-show）：播放器内点击不得判定为关闭 Home', () => {
  const { sandbox, overlay } = loadModule();
  overlay.classList.add('sfv-show'); // 播放器可见
  assert.strictEqual(
    sandbox.isHomeBlankDismissClick(blankClickEvent()),
    false,
    '播放器铺满视口叠在 Home 之上，其内点击不是「Home 空白」语义，否则退出播放器后只剩粒子星空'
  );
});

test('对照：播放器存在但未显示（sfv-show 已移除）时不拦截', () => {
  const { sandbox, overlay } = loadModule();
  overlay.classList.add('sfv-overlay'); // 有类但播放器未打开
  assert.strictEqual(sandbox.isHomeBlankDismissClick(blankClickEvent()), true);
});

test('API 兜底守卫：DOM 未就绪时 SFV.player.isOpen() 为真也不判定为关闭 Home', () => {
  const { sandbox } = loadModule();
  // 模拟 #sfv-overlay 尚未插入 DOM（getElementById 返回 null），但播放器模块已自报打开
  sandbox.StellaflixVideo = { player: { isOpen: () => true } };
  assert.strictEqual(sandbox.isHomeBlankDismissClick(blankClickEvent()), false);
});

// ---------------------------------------------------------------- 归属判定（2026-10-02 根治）
// 背景：逐个 class 加豁免是打地鼠——2026-09-25 片库页、2026-10-01 播放器各补一次，
// 搜索页 #sfv-search-page（player.css:485 全屏不透明，openSearchPage 不动 empty-home-active）、
// 浏览厅 .sfv-hall（hall.css:22 fixed inset:0；#empty-home 仅 visibility:hidden → rect 仍非零）、
// 背景 DIY 遮罩 / 片源仓库面板 / TMDB 设置 overlay 仍会漏网。
// 契约：点击目标不属于 #empty-home 子树 → 一律不算「Home 空白点击」。

test('归属判定：点击目标不属于 #empty-home 子树（搜索页/浏览厅等全屏层）时不关 Home', () => {
  const { sandbox, body } = loadModule();
  const foreignLayer = makeEl(); // 独立全屏层（如 #sfv-search-page / .sfv-hall），不在 Home 树内
  body.appendChild(foreignLayer);
  assert.strictEqual(
    sandbox.isHomeBlankDismissClick(blankClickEvent(foreignLayer)),
    false,
    '点在任何盖住 Home 的全屏层里都不是「Home 空白」语义，否则关闭该层后首页已被摘类 → 只剩粒子星空'
  );
});

test('对照：归属判定不误伤 Home 自身——点在 Home 容器空白仍判定为关闭 Home', () => {
  const { sandbox, home } = loadModule();
  assert.strictEqual(
    sandbox.isHomeBlankDismissClick(blankClickEvent(home)),
    true,
    '#empty-home 自身属于 Home 子树（contains 含自身），音乐态既有行为不得被归属判定改坏'
  );
});

// ---------------------------------------------------------------- 影视态契约（2026-10-02 根治）
// 背景：上面所有守卫都是「给某个具体浮层加豁免」，属于打地鼠——2026-09-25 片库页、
// 2026-10-01 播放器各补一次，搜索页 / 浏览厅 / 精选片单二级页 / DIY 遮罩 / 片源仓库仍漏网，
// 且每新增一个影视态全屏层就要再补一次。
// 契约：影视态（body/documentElement 带 video-space-active）下，「Home 开关」整体不生效。
//   - 影视态 #empty-home 就是影视首页本体，关掉它不会露出任何东西，只会把用户丢进粒子星空；
//   - 音乐态「点空白收起空壳首页露出壁纸」的语义在影视态根本不存在。
// 这一条不依赖任何 class 清单，因而一次覆盖当前与未来所有影视态页面。

test('影视态（body.video-space-active）：Home 内空白点击不得判定为关闭 Home', () => {
  const { sandbox, body } = loadModule();
  body.classList.add('video-space-active');
  assert.strictEqual(
    sandbox.isHomeBlankDismissClick(blankClickEvent()),
    false,
    '影视态首页是本体的内容载体，任何点击都不该具备「关掉影视首页」的能力'
  );
});

test('影视态（documentElement.video-space-active）：同样拦截（preload-mode 只加在 html 上）', () => {
  const { sandbox, doc } = loadModule();
  doc.documentElement.classList.add('video-space-active');
  assert.strictEqual(
    sandbox.isHomeBlankDismissClick(blankClickEvent()),
    false,
    '00-core-stores/preload-mode 会分别或同时写在 html 与 body 上，两处都必须命中'
  );
});

test('影视态：dismissHomePage 直接调用不得污染 homeSuppressed（粘性标志）', () => {
  const { sandbox, body } = loadModule();
  body.classList.add('video-space-active');
  sandbox.homeSuppressed = false;
  sandbox.dismissHomePage();
  assert.strictEqual(
    sandbox.homeSuppressed,
    false,
    'homeSuppressed 一旦被写成 true，影视态无任何复位路径 → 首页永久透明只剩粒子星空'
  );
});

test('影视态：goHome() 委托 SFV.online.goHome()，不得走音乐态开关分支', () => {
  const { sandbox, body } = loadModule();
  body.classList.add('video-space-active');
  let delegated = 0;
  sandbox.StellaflixVideo = { online: { goHome: () => { delegated += 1; } } };
  sandbox.homeSuppressed = false;
  sandbox.goHome();
  assert.strictEqual(delegated, 1, '影视态回首页必须走 online-nav 的实现（关浏览层 + 重渲染影视首页）');
  assert.strictEqual(
    sandbox.homeSuppressed,
    false,
    '影视态 goHome 不得落进音乐态 toggle 分支 → 不得调 dismissHomePage'
  );
});

test('影视态：online.goHome 不可用时 goHome() 静默返回，绝不回落音乐态逻辑', () => {
  const { sandbox, body } = loadModule();
  body.classList.add('video-space-active');
  sandbox.StellaflixVideo = undefined; // 影视态导航未就绪
  sandbox.homeSuppressed = false;
  sandbox.goHome();
  assert.strictEqual(
    sandbox.homeSuppressed,
    false,
    '委托失败时什么都不做，绝不回落「homeSuppressed=true + updateEmptyHomeVisibility 塞音乐内容」'
  );
});
