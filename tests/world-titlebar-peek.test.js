'use strict';

/**
 * 世界页窗口控制悬浮胶囊化（用户 2026-09-27 方案确认）
 * 运行：node --test tests/world-titlebar-peek.test.js
 *
 * 现状根因（审查结论）：
 *  - #desktop-titlebar 是 position:fixed 满宽 44px 带（index.css:465-481），
 *    左半 .desktop-drag-region 带 -webkit-app-region:drag + pointer-events:auto
 *    （index.css:489/500/479）→ 世界页地球顶部 44px 被当成拖窗区，拖不动。
 *  - .sfv-browse--page 覆盖层 z-index:2147482000（player.css:1501）远高于
 *    titlebar 的 500 → 不抬层级则胶囊被地球盖住。父层 z-index 形成层叠上下文，
 *    子元素自抬无效，必须抬 #desktop-titlebar 本身。
 *
 * 目标：世界页只留右上角 170×12 感应窄条，悬停显现只含 − □ × 的独立玻璃胶囊；
 *  ? / 更新 / 第三方音源 / DIY 在世界页不弹出。
 *
 * 断言面全部为 index.css 源码契约（本仓库 CSS 无运行时 harness，与
 * world-page-independent.test.js 同风格）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'public/css/index.css'), 'utf8');

const SCOPE = 'body\\.desktop-shell\\.sfv-world-page';

function block(selector) {
  const re = new RegExp(selector + '\\s*\\{([^}]*)\\}');
  const m = css.match(re);
  return m ? m[1] : null;
}

test('世界页：感应区逐边 == 浮现后的胶囊（触发面积＝三个按钮那块，不再是 170×12 细条）', () => {
  const b = block(SCOPE + '\\s+#desktop-titlebar');
  assert.ok(b, '必须有 body.desktop-shell.sfv-world-page #desktop-titlebar 规则');
  assert.match(b, /left:\s*auto/, '左边必须放开，否则仍是满宽长条');
  assert.match(b, /top:\s*8px/);
  assert.match(b, /right:\s*24px/);
  assert.match(b, /pointer-events:\s*auto/, 'display:none 的元素收不到 hover，感应区必须常驻可命中');
  assert.match(b, /-webkit-app-region:\s*no-drag/, '感应区本体不得是拖窗区，否则 hover 唤不出胶囊');
  assert.match(b, /z-index:\s*21474820\d\d/, '必须抬到 .sfv-browse--page(2147482000) 之上，否则胶囊被地球盖住');

  // 面积契约（用户 2026-09-30 裁决）：感应矩形逐边等于胶囊，不硬编码数字，全部从供体/本页反推
  const pill = stripComments(block(SCOPE + '\\s+#desktop-titlebar\\s+\\.desktop-window-controls'));
  const btnRow = stripComments(playerCss.match(/\.sfv-plex-win button\s*\{([^}]*)\}/)[1]);
  const btnW = Number(/width:\s*(\d+)px/.exec(btnRow)[1]);
  const borderW = Number(/border:\s*(\d+)px/.exec(pill)[1]);
  const pillH = Number(/height:\s*(\d+)px/.exec(pill)[1]);
  assert.strictEqual(Number(/width:\s*(\d+)px/.exec(b)[1]), 3 * btnW + 2 * borderW,
    '感应宽＝3 颗按钮 + 左右胶囊边框（胶囊可见多宽，触发就多大，不留 42px 空转死区）');
  assert.strictEqual(Number(/height:\s*(\d+)px/.exec(b)[1]), pillH,
    '感应高＝胶囊高（鼠标在胶囊内任意处都不收回；12px 细条时按不准）');
});

test('世界页：.desktop-drag-region 整块摘除（44px 吞点击横带消失，地球顶部恢复可拖）', () => {
  const b = block(SCOPE + '\\s+#desktop-titlebar\\s+\\.desktop-drag-region');
  assert.ok(b, '必须有 .desktop-drag-region 的世界页规则');
  assert.match(b, /display:\s*none\s*!important/);
});

test('世界页：? / 更新 / 第三方音源 / DIY 四个入口不弹出', () => {
  // 选择器必须逐条写全限定：CSS 分组选择器不是相对的，`A B,#C` 会让 #C 全局命中
  const b = block(SCOPE + '\\s+#desktop-titlebar\\s+#diy-mode-btn');
  assert.ok(b, '必须有功能入口的世界页隐藏规则');
  assert.match(b, /display:\s*none\s*!important/);
  ['#visual-guide-btn', '#update-entry', '#custom-source-btn', '#diy-mode-btn'].forEach((id) => {
    assert.ok(
      css.includes(SCOPE.replace(/\\/g, '') + ' #desktop-titlebar ' + id),
      '四个入口必须各自带 sfv-world-page 全限定选择器，缺：' + id
    );
  });
});

test('世界页：− □ × 玻璃胶囊默认隐藏，悬停感应条才显现', () => {
  const hidden = block(SCOPE + '\\s+#desktop-titlebar\\s+\\.desktop-window-controls');
  assert.ok(hidden, '必须有胶囊默认态规则');
  assert.match(hidden, /position:\s*absolute/);
  assert.match(hidden, /top:\s*0/, '胶囊与感应条矩形重叠，鼠标移进胶囊时仍命中感应条后代，:hover 不断');
  assert.match(hidden, /opacity:\s*0/);
  assert.match(hidden, /visibility:\s*hidden/);
  assert.match(hidden, /pointer-events:\s*none/, '收起态必须放行鼠标，地球顶部不被胶囊挡');
  assert.match(hidden, /background:\s*rgba\(/, '胶囊要有自有底色，否则读作隐形按钮');

  const shown = block(SCOPE + '\\s+#desktop-titlebar:hover\\s+\\.desktop-window-controls');
  assert.ok(shown, '必须有 :hover 显现规则');
  assert.match(shown, /opacity:\s*1\s*!important/);
  assert.match(shown, /visibility:\s*visible\s*!important/);
  assert.match(shown, /pointer-events:\s*auto\s*!important/);
});

test('世界页：胶囊本体可拖窗、三个按钮必须显式 no-drag（-webkit-app-region 会向下继承）', () => {
  const pill = block(SCOPE + '\\s+#desktop-titlebar\\s+\\.desktop-window-controls');
  assert.match(pill, /-webkit-app-region:\s*drag/, '无边框窗口在世界页仍需可拖动，拖窗能力收进胶囊空白处');

  const btn = block(SCOPE + '\\s+#desktop-titlebar\\s+\\.desktop-window-btn');
  assert.ok(btn, '必须有世界页 .desktop-window-btn 规则');
  assert.match(btn, /-webkit-app-region:\s*no-drag\s*!important/, '不显式 no-drag 则继承 drag，− □ × 全部点不动');
});

test('世界页：胶囊排在 #top-right(58px) 之上且不与其重叠（top 8 + height 30 < 58）', () => {
  const pill = block(SCOPE + '\\s+#desktop-titlebar\\s+\\.desktop-window-controls');
  const h = Number(pill.match(/height:\s*(\d+)px/)[1]);
  const bar = block(SCOPE + '\\s+#desktop-titlebar');
  const top = Number(bar.match(/top:\s*(\d+)px/)[1]);
  assert.ok(top + h <= 58, '胶囊下沿不得越过账号胶囊(#top-right top:58px, index.css:691-694)');
});

test('作用域纪律：新增段内每条选择器都必须带 sfv-world-page（不污染其它页面/音乐态）', () => {
  const start = css.indexOf('===== 世界页窗口控制悬浮胶囊');
  const end = css.indexOf('===== 世界页悬浮胶囊 end', start);
  assert.ok(start >= 0 && end > start, '必须有成对的世界页悬浮胶囊段落标记');
  const section = css.slice(start, end);
  const selectors = section
    .split('\n')
    .filter((l) => /\{\s*$/.test(l))
    .map((l) => l.trim());
  assert.ok(selectors.length >= 5, '段落内至少 5 条规则，实际 ' + selectors.length);
  selectors.forEach((sel) => {
    assert.ok(
      /^body\.desktop-shell\.sfv-world-page(\s|\S)*\{$/.test(sel),
      '选择器越界（会泄漏到其它页面）：' + sel
    );
  });
});

test('世界页悬浮段必须位于基础标题栏规则之后（同特异度靠后置，且便于阅读定位）', () => {
  const iBase = css.indexOf('body.desktop-shell #desktop-titlebar {');
  const iPeek = css.indexOf('===== 世界页窗口控制悬浮胶囊');
  assert.ok(iBase >= 0 && iPeek > iBase, '悬浮胶囊段必须在 index.css 基础标题栏段之后');
});

// ============================================================
//  层叠上下文：#desktop-titlebar 必须离开 #desktop-window-shell
// ============================================================
/**
 * 真机反馈（2026-09-27 截图）：胶囊「能点击但不显示」。
 * 根因：.sfv-browse 覆盖层挂到 document.body（online-nav.js:68），而 #desktop-titlebar
 * 在 #desktop-window-shell 内，该 shell 因 transform/clip-path 自成层叠上下文
 * （仓库已两处记录：modal-video-reparent.js:4、player-controller.js:27）→ 标题栏的
 * z-index 被封在 shell 内部，对 body 级 z:2147482000 的地球层完全无效；地球层
 * pointer-events:none（player.css:1661）→ 鼠标穿透命中胶囊 = 不可见但可点。
 * 修法沿用仓库既有先例（bottom-bar / track-detail-modal 均 reparent 到 body）：
 * 世界页 mount 把 #desktop-titlebar 提到 body，unmount 原样送回 shell 原位。
 */

const fs2 = require('node:fs');
const vm2 = require('node:vm');

function makeShellDom() {
  function el(id) {
    const n = {
      id: id || '', children: [], parentNode: null, style: {},
      appendChild(c) { n.children.push(c); c.parentNode = n; return c; },
      insertBefore(c, ref) {
        const i = n.children.indexOf(ref);
        c.parentNode = n;
        if (i < 0) n.children.push(c); else n.children.splice(i, 0, c);
        return c;
      },
      removeChild(c) { const i = n.children.indexOf(c); if (i >= 0) n.children.splice(i, 1); c.parentNode = null; return c; }
    };
    Object.defineProperty(n, 'nextSibling', {
      get() {
        if (!n.parentNode) return null;
        const sibs = n.parentNode.children;
        return sibs[sibs.indexOf(n) + 1] || null;
      }
    });
    return n;
  }
  const body = el('body');
  const shell = el('desktop-window-shell');
  const titlebar = el('desktop-titlebar');
  const diyZone = el('fullscreen-diy-zone');
  body.appendChild(shell);
  shell.appendChild(titlebar);
  shell.appendChild(diyZone);
  const byId = { 'desktop-window-shell': shell, 'desktop-titlebar': titlebar, 'fullscreen-diy-zone': diyZone };
  const document = {
    body,
    createElement: () => el(''),
    getElementById: (i) => byId[i] || null,
    querySelector: () => null,
    addEventListener() {}
  };
  body.classList = {
    _c: ['desktop-shell'],
    add(c) { if (this._c.indexOf(c) < 0) this._c.push(c); },
    remove(c) { const i = this._c.indexOf(c); if (i >= 0) this._c.splice(i, 1); },
    contains(c) { return this._c.indexOf(c) >= 0; }
  };
  return { document, body, shell, titlebar, diyZone };
}

function loadWorldPage(dom) {
  const sandbox = {
    console, Promise,
    setInterval: () => 1, clearInterval() {}, setTimeout: (f, m) => setTimeout(f, m), clearTimeout(t) { clearTimeout(t); },
    document: dom.document
  };
  sandbox.window = sandbox;
  const info = {
    map: { on() {}, off() {}, getZoom: () => 13, getCanvas: () => ({ style: {} }), flyTo() {}, project: () => ({ x: 0, y: 0 }) },
    overlay: { setProps() {} }, basemap: 'esri'
  };
  sandbox.StellaflixVideo = {
    router: { register(p) { sandbox._page = p; }, go() {}, currentId: () => 'world' },
    ui: { setTitle() {} },
    worldGlobe: { mount: () => Promise.resolve(info), unmount() {} },
    worldUi: { mount() { return dom.document.createElement('div'); }, unmount() {}, showLoading() {}, hideLoading() {}, toast() {}, setStats() {} },
    worldBoundaries: { mount() {}, unmount() {} },
    worldLighthouseDeck: { mount: () => Promise.resolve({ count: 0 }), unmount() {}, refreshStations: () => ({ count: 0 }), setSelected() {}, applyTier() {}, getState: () => ({ stations: [], selectedId: null, visible: true }), pickStation: () => null },
    worldMapActions: { mount() {}, unmount() {} },
    worldData: { fetchRooms: () => Promise.resolve({ rooms: [], source: 'demo' }) },
    worldRoom: { setMapRefreshHandler() {}, leave() {}, joinWatchRoom: () => Promise.resolve() }
  };
  vm2.createContext(sandbox);
  vm2.runInContext(fs2.readFileSync(path.join(root, 'public/video/page-world.js'), 'utf8'), sandbox);
  return sandbox._page;
}

test('page-world mount：把 #desktop-titlebar 提到 body 末尾（离开 shell 的层叠上下文，胶囊才能盖在地球之上）', () => {
  const dom = makeShellDom();
  const page = loadWorldPage(dom);
  const host = dom.document.createElement('div');
  page.mount(host, {});
  assert.strictEqual(dom.titlebar.parentNode, dom.body, '世界页挂载期 titlebar 必须在 body 下，否则被 .sfv-browse 压在下面不可见');
});

test('page-world unmount：#desktop-titlebar 原样送回 shell 原位（不破坏音乐态 DOM 契约）', () => {
  const dom = makeShellDom();
  const page = loadWorldPage(dom);
  page.mount(dom.document.createElement('div'), {});
  page.unmount();
  assert.strictEqual(dom.titlebar.parentNode, dom.shell, 'unmount 必须送回 #desktop-window-shell');
  assert.strictEqual(dom.shell.children[0], dom.titlebar, '必须回到原来的第一个子节点位置（#fullscreen-diy-zone 之前）');
});

test('page-world：非桌面外壳（浏览器态）不动 titlebar，二次 mount 不重复搬', () => {
  const dom = makeShellDom();
  dom.body.classList.remove('desktop-shell');
  const page = loadWorldPage(dom);
  page.mount(dom.document.createElement('div'), {});
  assert.strictEqual(dom.titlebar.parentNode, dom.shell, '无 desktop-shell 类时不得搬动（该元素本就 display:none）');

  const dom2 = makeShellDom();
  const page2 = loadWorldPage(dom2);
  page2.mount(dom2.document.createElement('div'), {});
  page2.mount(dom2.document.createElement('div'), {});
  assert.strictEqual(dom2.titlebar.parentNode, dom2.body);
  assert.strictEqual(dom2.body.children.filter((c) => c === dom2.titlebar).length, 1, '二次 mount 不得把 titlebar 复制/追加两份');
  page2.unmount();
  page2.unmount();
  assert.strictEqual(dom2.titlebar.parentNode, dom2.shell, '二次 unmount 幂等，仍回到 shell');
});


// ============================================================
//  换皮（2026-09-30 用户裁决：「保留悬停，只换皮」+「ON AIR 外壳复用 hearthere」）
//  供体 = 电影详情页右上 −□× 玻璃胶囊 .sfv-plex-win（player.css:3399-3424）
//  只搬材质/几何：感应条 170×12、liftTitlebar reparent、:hover 显现、drag/no-drag
//  一概不动 —— 上面 5 条断言继续守着行为面。
// ============================================================
const playerCss = fs.readFileSync(path.join(root, 'public/video/player.css'), 'utf8');
const donorBar = playerCss.match(/\.sfv-plex-win\s*\{([^}]*)\}/)[1];
const donorBtn = playerCss.match(/\.sfv-plex-win button\s*\{([^}]*)\}/)[1];

// 供体与本页规则都带 /* */ 注释；声明可能紧跟在注释之后，故比对前先剥注释
function stripComments(t) { return t.replace(/\/\*[\s\S]*?\*\//g, ''); }
function declOf(blockText, prop) {
  const m = stripComments(blockText).match(new RegExp('(?:^|;)\\s*' + prop + ':\\s*([^;]+);'));
  return m ? m[1].trim() : null;
}
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function declares(blockText, prop, value) {
  return new RegExp('(?:^|;)\\s*' + prop + ':\\s*' + esc(value) + '\\s*(?:;|$)').test(stripComments(blockText));
}

test('换皮·胶囊：6 条材质声明必须逐字等于供体 .sfv-plex-win', () => {
  const b = block(SCOPE + '\\s+#desktop-titlebar\\s+\\.desktop-window-controls');
  ['height', 'border-radius', 'background', 'border', 'backdrop-filter', 'box-shadow'].forEach((prop) => {
    const want = declOf(donorBar, prop);
    assert.ok(want, '供体 .sfv-plex-win 缺 ' + prop + '（供体变了，本测试需同步）');
    assert.ok(declares(b, prop, want), prop + ' 必须逐字复用供体值：' + want);
  });
});

test('换皮·按钮：38×30 透明底逐字复用供体，hover 不加底色只放大 svg 1.06', () => {
  const btn = block(SCOPE + '\\s+#desktop-titlebar\\s+\\.desktop-window-btn');
  ['width', 'height', 'background'].forEach((prop) => {
    const want = declOf(donorBtn, prop);
    assert.ok(declares(btn, prop, want), prop + ' 必须等于供体值：' + want);
  });
  const hover = block(SCOPE + '\\s+#desktop-titlebar\\s+\\.desktop-window-btn:hover');
  assert.ok(hover, '缺世界页 .desktop-window-btn:hover');
  // !important 是必需的：本文件 672-675 影视空间段用 rgba(4,8,10,.42)!important 压在 hover 上
  assert.match(hover, /background:\s*transparent\s*!important/);
  const hoverSvg = block(SCOPE + '\\s+#desktop-titlebar\\s+\\.desktop-window-btn:hover svg');
  assert.ok(hoverSvg, '缺世界页 hover svg 规则');
  assert.match(hoverSvg, /transform:\s*scale\(1\.06\)/);
});

test('换皮·配色：不得照搬供体的深黑图标（世界页底 #05060a，黑图标＝隐形）', () => {
  const b = stripComments(block(SCOPE + '\\s+#desktop-titlebar\\s+\\.desktop-window-controls'));
  assert.ok(!/#0d121a/.test(b), '供体 color:#0d121a 只适合海报亮底，世界页必须换成浅色 token');
  assert.match(b, /color:\s*rgba\(224,\s*250,\s*255,/);
});

test('换皮·让位：胶囊长到 50px 后 ON AIR 必须移出胶囊矩形，并复用 hearthere 深玻璃外壳', () => {
  const bar = block(SCOPE + '\\s+#desktop-titlebar');
  const pill = block(SCOPE + '\\s+#desktop-titlebar\\s+\\.desktop-window-controls');
  const pillBottom = Number(bar.match(/top:\s*(\d+)px/)[1]) + Number(pill.match(/height:\s*(\d+)px/)[1]);
  const air = block(SCOPE + '\\s+\\.world-on-air');
  assert.ok(air, '缺世界页 .world-on-air 规则');
  const top = Number(air.match(/top:\s*(\d+)px/)[1]);
  assert.ok(top >= pillBottom, 'ON AIR 顶边(' + top + ') 不得落在胶囊矩形内（胶囊下沿 ' + pillBottom + '）');
  assert.match(air, /background:\s*var\(--surface-control-overlay\)/, '外壳底色取自 .ht-icon-btn--overlay');
  assert.match(air, /border-radius:\s*var\(--shape-pill-radius\)/);
  assert.match(air, /backdrop-filter:\s*blur\(var\(--effect-pill-blur\)\)/);
  assert.ok(!/pointer-events:\s*none/.test(air), 'ON AIR 是可点按钮（world-ui.js:58 pointer-events:auto），不得置 none');
});

test('作用域纪律（换皮后）：新规则仍全部限定在 sfv-world-page，且未误伤其它页面', () => {
  ['.world-on-air', '.desktop-window-btn:hover'].forEach((sel) => {
    assert.ok(css.includes('body.desktop-shell.sfv-world-page #desktop-titlebar ' + sel) ||
      css.includes('body.desktop-shell.sfv-world-page ' + sel), '换皮规则缺世界页全限定：' + sel);
  });
});
