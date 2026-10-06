'use strict';

/**
 * 轮㉗：灯塔卡片「看这部」直播（用户批准设计 2026-10-04，方案C双按钮）
 *  ① deck.roomToStation 透传 cc（live 国家热映塔的专属标记；缺省不凭空造值）
 *  ② ht-panel：live 塔（st.cc）CTA 行追加「看这部」按钮 → onAction('watch_movie')；
 *     无 cc 塔（演示十塔/真实房间）维持 hearthere 原样，不出此按钮
 *  ③ page-world handleCta watch_movie → SFV.detailSource.smartResumePlay
 *     （去《》书名号 + coverUrl 作 img）；模块缺席 → toast（行为测在 world-page-flow）
 * 运行：node --test tests/world-watch-movie.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ---------------- 假 DOM（同 world-card-data.test.js 套路） ----------------

function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [], parentNode: null,
    style: { setProperty(k, v) { this[k] = v; } },
    attributes: {}, listeners: {},
    textContent: '', disabled: false,
    offsetWidth: 0, scrollWidth: 0, offsetHeight: 0
  };
  const set = new Set();
  const sync = () => { el._className = Array.from(set).join(' '); };
  el.classList = {
    add() { for (const n of arguments) if (n) set.add(n); sync(); },
    remove() { for (const n of arguments) set.delete(n); sync(); },
    toggle(n, force) { const w = force === undefined ? !set.has(n) : !!force; if (w) set.add(n); else set.delete(n); sync(); return w; },
    contains(n) { return set.has(n); }
  };
  Object.defineProperty(el, 'className', {
    get() { return el._className || ''; },
    set(v) { set.clear(); String(v).split(/\s+/).filter(Boolean).forEach((n) => set.add(n)); sync(); }
  });
  el.appendChild = function (c) { c.parentNode = el; el.children.push(c); return c; };
  el.removeChild = function (c) {
    const i = el.children.indexOf(c);
    if (i >= 0) { el.children.splice(i, 1); c.parentNode = null; }
    return c;
  };
  el.setAttribute = function (k, v) { el.attributes[k] = String(v); if (k === 'class') el.className = v; };
  el.getAttribute = function (k) { return Object.prototype.hasOwnProperty.call(el.attributes, k) ? el.attributes[k] : null; };
  el.addEventListener = function (t, fn) { (el.listeners[t] = el.listeners[t] || []).push(fn); };
  el.removeEventListener = function (t, fn) {
    const a = el.listeners[t] || [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  };
  return el;
}

function loadRealm() {
  const doc = { createElement: makeEl, createElementNS: (ns, tag) => makeEl(tag) };
  const sandbox = { console, Promise, document: doc, Map, Set, encodeURIComponent };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.innerWidth = 1440;
  sandbox.innerHeight = 900;
  vm.createContext(sandbox);
  vm.runInContext(read('public/video/world-lighthouse-deck.js'), sandbox);
  vm.runInContext(read('public/video/world-ht-panel.js'), sandbox);
  vm.runInContext(read('public/video/world-flags.js'), sandbox);
  const SFV = sandbox.StellaflixVideo;
  assert.ok(SFV.worldHtPanel && SFV.worldLighthouseDeck && SFV.worldFlags, '三模块应同 realm 挂载');
  return SFV;
}

function findAll(el, cls, out) {
  out = out || [];
  for (const c of el.children || []) {
    if (c.classList && c.classList.contains(cls)) out.push(c);
    findAll(c, cls, out);
  }
  return out;
}
function textOf(el) {
  let s = el.textContent || '';
  for (const c of el.children || []) s += textOf(c);
  return s;
}
function ctaButtons(p) {
  return findAll(p, 'station-panel__cta').filter((b) => b.tagName === 'BUTTON');
}

const LIVE_ST = {
  id: 'r-KR', roomId: 'room-kr', name: '首尔', position: [126.98, 37.57],
  status: 'playing', ownerType: 'system', countryCode: 'KR', cc: 'KR',
  title: '《韩国热映》', coverUrl: 'https://image.tmdb.org/t/p/w780/kr.jpg'
};
const DEMO_ST = {
  id: 'r-sh', roomId: 'room-sh', name: '上海', position: [121.47, 31.23],
  status: 'playing', ownerType: 'system', title: '夏目友人帐'
};

// ---------------------------------------------------------------- ① deck 透传 cc

test('deck.roomToStation 透传 cc（live 塔标记）；缺省不凭空造值', () => {
  const SFV = loadRealm();
  const raw = { id: 'r-KR', roomId: 'room-kr', name: '首尔', lon: 126.98, lat: 37.57,
    status: 'playing', cc: 'KR', title: '《韩国热映》' };
  const st = SFV.worldLighthouseDeck.roomToStation(raw);
  assert.equal(st.cc, 'KR', 'live 塔 cc 须透传到面板站对象');
  const st2 = SFV.worldLighthouseDeck.roomToStation(Object.assign({ position: [1, 2] }, raw));
  assert.equal(st2.cc, 'KR', 'station 形状 passthrough 分支同透传');
  const bare = SFV.worldLighthouseDeck.roomToStation({ id: 'r-y', roomId: 'room-y', name: '无标', lon: 3, lat: 4 });
  assert.ok(!('cc' in bare), '缺省不得凭空造 cc');
});

// ---------------------------------------------------------------- ② 面板双按钮

test('面板：live 塔（cc）CTA 行含「看这部」，点击 onAction(watch_movie)，进入房间原样共存', () => {
  const SFV = loadRealm();
  const fired = [];
  const p = SFV.worldHtPanel.buildPanel(LIVE_ST, {
    actionState: 'tune_in', canGoNext: false, onAction: (a) => fired.push(a)
  });
  const btns = ctaButtons(p);
  const watch = btns.filter((b) => textOf(b).indexOf('看这部') >= 0);
  assert.equal(watch.length, 1, 'live 塔应恰有一枚「看这部」按钮');
  const tune = btns.filter((b) => textOf(b).indexOf('进入房间') >= 0);
  assert.equal(tune.length, 1, '「进入房间」按钮保留（方案C双按钮）');
  watch[0].listeners.click[0]();
  assert.deepEqual(fired, ['watch_movie'], '点击只发 watch_movie 动作');
});

test('面板：无 cc 塔（演示/真实房）不出现「看这部」（hearthere 单 CTA 原样）', () => {
  const SFV = loadRealm();
  const fired = [];
  const p = SFV.worldHtPanel.buildPanel(DEMO_ST, {
    actionState: 'tune_in', canGoNext: false, onAction: (a) => fired.push(a)
  });
  const btns = ctaButtons(p);
  assert.equal(btns.filter((b) => textOf(b).indexOf('看这部') >= 0).length, 0, '演示塔不得出直播按钮');
  assert.equal(btns.filter((b) => textOf(b).indexOf('进入房间') >= 0).length, 1);
});

// ---------------------------------------------------------------- ③ 接线源断言

test('接线源：page-world handleCta 有 watch_movie 支路（smartResumePlay + 去书名号）', () => {
  const src = read('public/video/page-world.js');
  assert.match(src, /'watch_movie'/, 'handleCta 应含 watch_movie 分支');
  assert.match(src, /smartResumePlay/, '支路应调 detailSource.smartResumePlay');
});
