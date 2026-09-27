'use strict';

/**
 * 世界页独立化 — 不再复用首页 Three.js 星空/相机/3D 空间
 * 运行：node --test tests/world-page-independent.test.js
 *
 * 背景（用户 2026-09-27 反馈 + 截图）：世界页挂在 .sfv-browse--page 透明覆盖层里
 * （player.css「方案 D」：background transparent !important + .sfv-browse-body
 * 同样透明），首页共享 scene 的 backgroundStarRiverParticles（three.js 相机/
 * renderer，#canvas-container z-index 1）直接透出来当世界页背景。
 *
 * 断言面：
 *  1. page-world mount/unmount 切 body 的 sfv-world-page 类（vm 行为测试，
 *     真实 page-world.js + 记账 classList 假 DOM）。
 *  2. player.css 三条 sfv-world-page 规则：
 *     a) #canvas-container 隐藏（opacity 0 + visibility hidden，!important）；
 *     b) .sfv-browse--page 覆盖层实色（赢过行 1650 的 transparent !important）；
 *     c) .sfv-browse-body host 实色（赢过行 1573 的 transparent !important，
 *        即 applyHostChrome #05060a 曾被静默压制的根因）。
 *  3. router.js 提供 leave()：卸载当前页并清 id（vm 行为测试）。
 *  4. online-nav.js close() 经 router.leave() 卸载当前页——修「goHome/退出
 *     浏览层不 unmount 当前页」的在案缺口，否则 body class 残留会把首页
 *     星空一并藏掉。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const WORLD_CLASS = 'sfv-world-page';

// ============================================================
//  1. page-world mount/unmount 切 body class（行为面）
// ============================================================

const ROOMS = [
  { id: 'r1', roomId: 'room-1', name: '上海', lon: 121.47, lat: 31.23, status: 'playing', title: 'X', people: 2 }
];

function makeFakeDom() {
  function el() {
    const n = {
      style: {}, className: '', textContent: '', children: [], parentNode: null,
      _classes: [],
      classList: {
        add(c) { if (n._classes.indexOf(c) < 0) n._classes.push(c); },
        remove(c) { const i = n._classes.indexOf(c); if (i >= 0) n._classes.splice(i, 1); },
        toggle() {}, contains(c) { return n._classes.indexOf(c) >= 0; }
      },
      setAttribute() {},
      appendChild(c) { n.children.push(c); if (c) c.parentNode = n; return c; },
      removeChild(c) { const i = n.children.indexOf(c); if (i >= 0) n.children.splice(i, 1); if (c) c.parentNode = null; return c; }
    };
    return n;
  }
  return {
    document: { createElement: el, querySelector() { return null; }, head: el(), body: el(), addEventListener() {} }
  };
}

function makeFakeMap() {
  const handlers = {};
  const canvas = { style: {} };
  const map = {
    on(ev, h) { (handlers[ev] = handlers[ev] || []).push(h); },
    off(ev, h) { const arr = handlers[ev] || []; const i = arr.indexOf(h); if (i >= 0) arr.splice(i, 1); },
    emit(ev, e) { (handlers[ev] || []).slice().forEach((h) => h(e || {})); },
    getZoom() { return 13; },
    getBearing() { return 0; },
    getCanvas() { return canvas; },
    project() { return { x: 400, y: 300 }; },
    flyTo(o) { return map; },
    easeTo() { return map; }
  };
  return map;
}

function setupWorld() {
  const dom = makeFakeDom();
  const map = makeFakeMap();
  const overlay = { setProps() {} };
  const info = { map, overlay, basemap: 'esri' };
  const sandbox = {
    console, Promise,
    setInterval() { return 1; }, clearInterval() {},
    setTimeout(fn, ms) { return setTimeout(fn, ms); }, clearTimeout(t) { clearTimeout(t); },
    document: dom.document
  };
  sandbox.window = sandbox;
  sandbox.StellaflixVideo = {
    router: { register(p) { sandbox._page = p; }, go() {}, currentId() { return 'world'; } },
    ui: { setTitle() {} },
    worldGlobe: { mount() { return Promise.resolve(info); }, unmount() {} },
    worldUi: {
      mount() { return dom.document.createElement('div'); }, unmount() {},
      showLoading() {}, hideLoading() {}, toast() {}, setStats() {},
      setOnAir() {}, setOnAirHandler() {}, setHintHandler() {}, setCreateHandler() {},
      setRotateState() {}, fireworksCanvas() { return null; },
      showCard() {}, hideCard() {}, cardEl: null
    },
    worldBoundaries: { mount() {}, unmount() {} },
    worldLighthouseDeck: {
      mount() { return Promise.resolve({ count: 1 }); }, unmount() {},
      refreshStations() { return { count: 0 }; }, setSelected() {}, applyTier() {},
      getState() { return { stations: [], selectedId: null, visible: true }; },
      pickStation() { return null; }
    },
    worldMapActions: { mount() {}, unmount() {}, autoRotate: true },
    worldData: { fetchRooms() { return Promise.resolve({ rooms: ROOMS, source: 'demo' }); } },
    worldRoom: { setMapRefreshHandler() {}, leave() {}, joinWatchRoom() { return Promise.resolve(); } }
  };
  vm.createContext(sandbox);
  vm.runInContext(read('public/video/page-world.js'), sandbox);
  const page = sandbox._page;
  const host = dom.document.createElement('div');
  const flush = async () => {
    for (let i = 0; i < 25; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 25; i++) await Promise.resolve();
  };
  return { page, host, body: dom.document.body, flush };
}

test('page-world mount 给 body 挂 sfv-world-page，unmount 摘除（世界页不再共用首页 3D 空间的 CSS 开关）', async () => {
  const t = setupWorld();
  assert.equal(t.body.classList.contains(WORLD_CLASS), false, '初始不得带类');
  t.page.mount(t.host, {});
  assert.equal(t.body.classList.contains(WORLD_CLASS), true, 'mount 入口即挂类（不等 globe 就绪，加载态背景也要独立）');
  await t.flush();
  t.page.unmount();
  assert.equal(t.body.classList.contains(WORLD_CLASS), false, 'unmount 必须摘类，否则退出世界页后首页星空被一并藏掉');
});

test('page-world：globe 挂载失败路径 unmount 同样摘除 body class', async () => {
  const t = setupWorld();
  t.page.mount(t.host, {});
  await t.flush();
  assert.equal(t.body.classList.contains(WORLD_CLASS), true);
  t.page.unmount();
  t.page.unmount(); // 幂等：二次 unmount 不得 throw
  assert.equal(t.body.classList.contains(WORLD_CLASS), false);
});

// ============================================================
//  2. player.css：sfv-world-page 三条规则（源码断言）
// ============================================================

test('player.css：世界页态隐藏首页 three.js 画布（不再共用同一套相机渲染的星空）', () => {
  const css = read('public/video/player.css');
  const re = new RegExp('body\\.' + WORLD_CLASS + '\\s+#canvas-container\\s*\\{[^}]*\\}');
  const block = css.match(re);
  assert.ok(block, '必须有 body.' + WORLD_CLASS + ' #canvas-container 规则');
  assert.match(block[0], /opacity:\s*0\s*!important/);
  assert.match(block[0], /visibility:\s*hidden/);
  assert.match(block[0], /pointer-events:\s*none/);
});

test('player.css：世界页态覆盖层与宿主实色底（压过方案 D 的 transparent !important）', () => {
  const css = read('public/video/player.css');
  // a) 覆盖层：更高特异度 + 文件后置，压过 .sfv-browse.sfv-browse--page 的 transparent
  const reOverlay = new RegExp('body\\.' + WORLD_CLASS + '\\s+\\.sfv-browse\\.sfv-browse--page\\s*\\{[^}]*\\}');
  const b1 = css.match(reOverlay);
  assert.ok(b1, '必须有 body.' + WORLD_CLASS + ' .sfv-browse--page 实色规则');
  assert.match(b1[0], /background:\s*#[0-9a-fA-F]{6}\s*!important/);
  // b) 宿主 bodyEl：压过 .sfv-browse-body 的 background-color transparent !important（1573 行根因）
  const reBody = new RegExp('body\\.' + WORLD_CLASS + '[^{\\n]*\\.sfv-browse-body\\s*\\{[^}]*\\}');
  const b2 = css.match(reBody);
  assert.ok(b2, '必须有 .sfv-browse-body 的世界页实色规则');
  assert.match(b2[0], /background(-color)?:\s*#[0-9a-fA-F]{6}\s*!important/);
  // 顺序面：世界页规则必须排在方案 D 两条 transparent 规则之后（同特异度时后来者胜）
  const iD = css.indexOf('/* 方案 D：电影/动漫页复用首页星空');
  const iWorld = css.indexOf('body.' + WORLD_CLASS);
  assert.ok(iD >= 0 && iWorld > iD, '世界页独立规则必须位于方案 D 透明规则之后');
});

// ============================================================
//  3. router.js leave()（行为面）
// ============================================================

function loadRouter() {
  const sandbox = { console, Promise };
  sandbox.window = sandbox;
  sandbox.StellaflixVideo = {};
  vm.createContext(sandbox);
  vm.runInContext(read('public/video/router.js'), sandbox);
  return sandbox.StellaflixVideo.router;
}

test('router.leave()：卸载当前页并清 currentId；无当前页时静默', () => {
  const router = loadRouter();
  let unmounted = 0;
  router.register({ id: 'world', title: '世界', mount() {}, unmount() { unmounted++; }, back() { return false; } });
  const host = { innerHTML: '' };
  router.setHost(host);
  router.go('world');
  assert.equal(router.currentId(), 'world');
  router.leave();
  assert.equal(unmounted, 1, 'leave 必须 unmount 当前页');
  assert.equal(router.currentId(), null, 'leave 后不得残留当前页 id（防 close 二次卸载）');
  router.leave();
  assert.equal(unmounted, 1, '无当前页时 leave 静默、不重复卸载');
});

test('router.go 页间切换仍先卸载旧页（leave 语义不回归）', () => {
  const router = loadRouter();
  const log = [];
  router.register({ id: 'a', mount() {}, unmount() { log.push('a-unmount'); } });
  router.register({ id: 'b', mount() { log.push('b-mount'); }, unmount() { log.push('b-unmount'); } });
  router.setHost({ innerHTML: '' });
  router.go('a');
  router.go('b');
  assert.deepEqual(log, ['a-unmount', 'b-mount']);
  router.leave();
  assert.deepEqual(log, ['a-unmount', 'b-mount', 'b-unmount']);
});

// ============================================================
//  4. online-nav close() 经 router.leave() 收掉当前分页
// ============================================================

test('online-nav.js：close() 调用 router.leave()（退出浏览层必卸载当前页，goBack 分页分支不再手动 double-unmount）', () => {
  const src = read('public/video/online-nav.js');
  const closeBlock = src.match(/function close\(\)[\s\S]*?\n  \}/);
  assert.ok(closeBlock, '应能定位 close() 函数体');
  assert.match(closeBlock[0], /router\.leave/, 'close() 必须经 router.leave() 卸载当前分页（世界页 body class / globe 泄漏的根修）');
  // goBack 的 page 分支此前手动 p.unmount() 后 close()——leave 落地后必须移除，否则双卸载
  assert.ok(!/if \(p && typeof p\.unmount === 'function'\) \{ try \{ p\.unmount\(\); \} catch \(e\) \{\} \}/.test(src),
    'goBack 分页分支不得再保留手动 unmount（改由 close→leave 统一负责）');
});

test('index.html SFV_SCRIPTS 顺序不受影响（page-world 仍在末段）', () => {
  const html = read('public/index.html');
  const iWg = html.indexOf('"video/world-globe.js"');
  const iPw = html.indexOf('"video/page-world.js"');
  assert.ok(iWg >= 0 && iWg < iPw, 'world-globe.js 仍先于 page-world.js');
  assert.strictEqual((html.match(/video\/page-world\.js/g) || []).length, 1);
});
