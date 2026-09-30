'use strict';

/**
 * 步骤④-4：ht-panel 灯塔卡片面板（hearthere 逐字保真）
 * 运行：node --test tests/world-ht-panel-hearthere.test.js
 *
 * 事实源 _scratch/hearthere/main.pretty.js：
 *   Rd .nav-bar 外壳 :3189-3345 · Xf station-showcase :7304-7414 · sp ht-panel :7534-7686
 *   图标 Jf/tp/op :7415-7532 · Yf/Zf :7268-7282
 *   纯函数 $f :7120-7123 · Wf :7125-7127 · el :16620-16641 · ni :7284-7302 · Ur :7264-7267 · Gf/Qf :7245-7262
 *   开卡语义 wt :19638-19653 · 空白点击 no-op Us :19793-19851（dy/el）
 * 已裁决（主人 2026-09-27）：
 *   甲 = DOM/版式/文案槽逐字，CTA 动作文字换本地语义（进入房间/退出观看/离线）；
 *        Supabase 面（聊天/导播台/直播倒计时/主播离开警报/收听数订阅/收藏表）不移植，
 *        收藏星接本地 worldMapActions。
 *   删 = 旧 world-card 的「定位」「房间」按钮与 moveend 开卡退役。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const MODULE_PATH = path.join(root, 'public', 'video', 'world-ht-panel.js');
const CSS_PATH = path.join(root, 'public', 'video', 'world-ht-panel.css');
const DECK_SRC = read('public/video/world-lighthouse-deck.js');

// ---------------- 假 DOM ----------------

function makeClassList(el) {
  const set = new Set();
  const sync = () => { el._className = Array.from(set).join(' '); };
  return {
    add() { for (const n of arguments) if (n) set.add(n); sync(); },
    remove() { for (const n of arguments) set.delete(n); sync(); },
    toggle(n, force) {
      const want = force === undefined ? !set.has(n) : !!force;
      if (want) set.add(n); else set.delete(n);
      sync();
      return want;
    },
    contains(n) { return set.has(n); },
    _set: set,
    _replace(str) { set.clear(); String(str).split(/\s+/).filter(Boolean).forEach((n) => set.add(n)); sync(); }
  };
}

function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    style: { setProperty(k, v) { this[k] = v; } },
    attributes: {},
    listeners: {},
    textContent: '',
    offsetWidth: 0,
    scrollWidth: 0,
    offsetHeight: 0,
    disabled: false
  };
  el.classList = makeClassList(el);
  Object.defineProperty(el, 'className', {
    get() { return el._className || ''; },
    set(v) { el.classList._replace(v); }
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
  el.dispatch = function (t, ev) { (el.listeners[t] || []).slice().forEach((fn) => fn(ev || { type: t })); };
  el.getBoundingClientRect = function () { return { top: 0, left: 0, bottom: el.offsetHeight, right: el.offsetWidth }; };
  return el;
}

// ---------------- 沙箱：deck（头像数据面 ④-3）+ panel（④-4）同 realm ----------------

function loadPanel(extra) {
  assert.ok(fs.existsSync(MODULE_PATH), 'public/video/world-ht-panel.js 应存在（④-4 待实现）');
  const doc = {
    createElement: makeEl,
    createElementNS: function (ns, tag) { return makeEl(tag); }
  };
  const sandbox = Object.assign({ console, Promise, document: doc }, extra || {});
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.innerWidth = 1440;
  sandbox.innerHeight = 900;
  vm.createContext(sandbox);
  vm.runInContext(DECK_SRC, sandbox);        // ④-3 面（Ur/cs 等价物唯一真源）
  vm.runInContext(read('public/video/world-ht-panel.js'), sandbox);
  assert.ok(sandbox.StellaflixVideo && sandbox.StellaflixVideo.worldHtPanel, '应挂 SFV.worldHtPanel');
  return { api: sandbox.StellaflixVideo.worldHtPanel, deck: sandbox.StellaflixVideo.worldLighthouseDeck, doc, sandbox };
}

const station = (id, extra) => Object.assign({
  id, roomId: 'room-' + id, name: '上海', position: [121.47, 31.23],
  status: 'playing', ownerType: 'user', people: 3
}, extra || {});

// 树工具（跨 realm 安全：只读属性）
function findAll(el, cls, out) {
  out = out || [];
  for (const c of el.children || []) {
    if (c.classList && c.classList.contains(cls)) out.push(c);
    findAll(c, cls, out);
  }
  return out;
}
function first(el, cls) { return findAll(el, cls)[0] || null; }
function classesOf(el) { return el && el.className; }

// ---------------- 纯函数逐字 ----------------

test('$f 位置串逐字（:7120-7123）：city/region/country 逗号连；全空回落坐标两位小数', () => {
  const { api } = loadPanel();
  assert.equal(api.locationText(station('a', { city: '上海', region: '华东', country: '中国' })), '上海, 华东, 中国');
  assert.equal(api.locationText(station('a', { country: '日本' })), '日本');
  assert.equal(api.locationText(station('a')), '121.47°, 31.23°', '无行政区字段 → 坐标串逐字');
  assert.equal(api.locationText(station('a', { position: [-0.13, 51.51] })), '-0.13°, 51.51°');
});

test('Wf CTA 态逐字（:7125-7127）：未授权恒 authorize；收听中 stop；离线 offline；否则 tune_in', () => {
  const { api } = loadPanel();
  assert.equal(api.actionState(station('a'), 'a', false), 'authorize');
  assert.equal(api.actionState(station('a'), 'a', true), 'stop');
  assert.equal(api.actionState(station('a', { status: 'offline' }), 'b', true), 'offline');
  assert.equal(api.actionState(station('a'), 'b', true), 'tune_in');
});

test('Xs 动作表逐字（:7507-7532）：六键键序 + labelKey 原样', () => {
  const { api } = loadPanel();
  assert.deepEqual(Object.keys(api.ACTION_TABLE),
    ['authorize', 'tune_in', 'stop', 'next_station', 'offline', 'idle']);
  assert.equal(api.ACTION_TABLE.tune_in.labelKey, 'station.action.tuneIn');
  assert.equal(api.ACTION_TABLE.next_station.labelKey, 'station.action.nextStation');
  assert.equal(api.ACTION_TABLE.offline.labelKey, 'station.action.offline');
  assert.equal(api.ACTION_TABLE.idle.labelKey, 'station.action.idle');
});

test('裁决甲：文案槽逐字保留 hearthere 原文，CTA 动作文字换本地语义', () => {
  const { api } = loadPanel();
  assert.equal(api.TEXT['station.showcase.defaultDescription'], '关于这个声音信标，主播什么也没说');
  assert.equal(api.TEXT['common.closePanel'], '关闭面板');
  assert.equal(api.TEXT['common.loading'], '加载中');
  assert.equal(api.TEXT['station.showcase.unnamed'], '声音信标 {id}');
  assert.equal(api.showcaseText('station.showcase.unnamed', { id: 'r-9' }), '声音信标 r-9');
  assert.equal(api.TEXT['station.action.tuneIn'], '进入房间');
  assert.equal(api.TEXT['station.action.stop'], '退出观看');
  assert.equal(api.TEXT['station.action.offline'], '离线');
});

test('el 点击判定逐字（:16620-16641）：自己台不 autoTune；广播别台先确认；playing/live_idle 才 autoTune', () => {
  const { api } = loadPanel();
  const base = {
    clickedStationId: 'a', myStationId: null, isBroadcasting: false,
    stationStatus: 'playing', listeningStationId: null, isMusicAuthorized: true
  };
  assert.deepEqual(api.clickDecision(base), { type: 'open_station_panel', stationId: 'a', autoTune: true });
  assert.deepEqual(api.clickDecision(Object.assign({}, base, { myStationId: 'a' })),
    { type: 'open_station_panel', stationId: 'a', autoTune: false });
  assert.deepEqual(api.clickDecision(Object.assign({}, base, { isBroadcasting: true })),
    { type: 'confirm_stop_broadcast', stationId: 'a' });
  assert.deepEqual(api.clickDecision(Object.assign({}, base, { stationStatus: 'live_idle' })),
    { type: 'open_station_panel', stationId: 'a', autoTune: true });
  assert.deepEqual(api.clickDecision(Object.assign({}, base, { stationStatus: 'online' })),
    { type: 'open_station_panel', stationId: 'a', autoTune: false });
  assert.deepEqual(api.clickDecision(Object.assign({}, base, { listeningStationId: 'a' })),
    { type: 'open_station_panel', stationId: 'a', autoTune: false });
  assert.deepEqual(api.clickDecision(Object.assign({}, base, { isMusicAuthorized: false })),
    { type: 'open_station_panel', stationId: 'a', autoTune: false });
});

test('canGoNextStation 逐字（:19973 ge.some(playing && id!==)）', () => {
  const { api } = loadPanel();
  const list = [station('a'), station('b', { status: 'online' })];
  assert.equal(api.canGoNextStation(list, 'b'), true);
  assert.equal(api.canGoNextStation(list, 'a'), false);
  assert.equal(api.canGoNextStation([station('z', { status: 'online' })], 'a'), false);
});

// ---------------- DOM 结构逐字 ----------------

test('sp 面板根（:7593-7600）：.ht-panel > 关闭按钮（ht-panel__close + Jf 叉路径 + aria-label 关闭面板）+ .station-showcase', () => {
  const { api } = loadPanel();
  const p = api.buildPanel(station('a'), {});
  assert.equal(classesOf(p), 'ht-panel');
  const close = p.children[0];
  assert.equal(close.tagName, 'BUTTON');
  assert.equal(classesOf(close), 'ht-icon-btn ht-icon-btn--overlay ht-panel__close');
  assert.equal(close.getAttribute('aria-label'), '关闭面板');
  const svg = close.children[0];
  assert.equal(classesOf(svg), 'ht-icon');
  assert.equal(svg.getAttribute('viewBox'), '0 0 24 24');
  assert.equal(svg.children[0].getAttribute('d'), 'M18 6 6 18M6 6l12 12');
  assert.equal(classesOf(p.children[1]), 'station-showcase');
  assert.equal(p.children.length, 2, 'ht-panel 只有关闭按钮 + showcase 两个子（:7595-7600）');
});

test('Xf hero 段（:7327-7350）：vignette 常驻；toolbar+LIVE 徽章仅在线；离线不出徽章与告警槽', () => {
  const { api } = loadPanel();
  // Ur 支路：user 台的 avatarUrl 是 Supabase 存储链（ks 白名单外 → cs 首字母，④-3 已裁决）；
  // 非 user 台直链原样透传 → hero-img src 即该 URL。
  const online = api.buildPanel(station('a', { displayKind: 'system', avatarUrl: 'https://x/y.png' }), {});
  const hero = first(online, 'station-panel__hero');
  assert.ok(hero, '应有 hero');
  const img = first(hero, 'station-panel__hero-img');
  assert.ok(img, 'R = coverUrl || (avatarUrl ? Ur : null) → hero-img（:7331-7333）');
  assert.equal(img.getAttribute('src'), 'https://x/y.png');
  assert.equal(classesOf(first(hero, 'station-panel__hero-vignette')), 'station-panel__hero-vignette');
  const toolbar = first(hero, 'station-panel__toolbar');
  assert.ok(toolbar, 'X=showLiveBadge 真 → toolbar（:7341）');
  const badge = first(toolbar, 'ht-badge');
  assert.ok(badge && badge.classList.contains('live'), 'span.ht-badge.live（:7343-7345）');
  assert.equal(badge.textContent, 'LIVE');
  assert.ok(!first(hero, 'station-panel__hero-thumb'), '无 webp cover 资产 → 不造渐进小图（Dr :4191 本地恒 null）');

  const offline = api.buildPanel(station('a', { status: 'offline' }), {});
  assert.ok(!first(offline, 'station-panel__toolbar'), '离线不渲染 toolbar（:7341 X=p）');
  assert.ok(!first(offline, 'station-panel__alerts'), '主播离开警报属 Supabase 面，裁决甲不 port');
});

test('Xf info 段（:7353-7369）：avatar-box 内 ht-avatar 背景 = Ur 首字母 SVG（接 ④-3 唯一真源）', () => {
  const { api, deck } = loadPanel();
  const p = api.buildPanel(station('a'), {});
  const box = first(p, 'station-panel__avatar-box');
  const av = first(box, 'station-panel__avatar');
  assert.equal(classesOf(av), 'ht-avatar station-panel__avatar');
  assert.match(av.style.background, /^url\('data:image\/svg\+xml,/, '背景应取 Ur 等价物');
  assert.equal(av.style.background, "url('" + deck.stationAvatarUrl(station('a')) + "') center / cover no-repeat");
  assert.equal(av.style.width, '100%');
  assert.equal(av.style.height, '100%');
  assert.equal(av.style.border, 'none');
  assert.ok(!first(box, 'station-panel__flag'), 'user 台不出国旗');
});

test('Gf/Qf 国旗支路（:7324 _/M）：谓词逐字；无国旗资产面时回落 avatar（不凭空造旗）', () => {
  const { api } = loadPanel();
  const noFlag = api.buildPanel(station('s', { ownerType: 'system', countryCode: 'CN' }), {});
  assert.ok(first(noFlag, 'station-panel__avatar'), 'hook 缺省 → M 空串 → avatar 支路（:7361）');
  assert.ok(!first(noFlag, 'station-panel__flag'), '无 Yl 国旗数据集不得凭空造旗');

  const withFlag = api.buildPanel(station('s', { ownerType: 'system', countryCode: 'CN' }),
    { flagUrlFor: function (cc) { return 'data:image/svg+xml,FLAG' + cc; } });
  const flag = first(first(withFlag, 'station-panel__avatar-box'), 'station-panel__flag');
  assert.ok(flag && flag.tagName === 'IMG', '_ = system && countryCode && !avatarUrl → flag img');
  assert.equal(flag.getAttribute('src'), 'data:image/svg+xml,FLAGCN');
  assert.ok(!first(withFlag, 'station-panel__avatar'), '出旗时不出 avatar div（:7357 三元）');
});

test('Xf meta 段（:7370-7395）：h3.station-panel__name 内 span；位置行 = Yf 别针 svg + location-text', () => {
  const { api } = loadPanel();
  const p = api.buildPanel(station('a', { city: '上海', country: '中国' }), {});
  const h3 = first(p, 'station-panel__name');
  assert.equal(h3.tagName, 'H3');
  assert.equal(h3.children[0].textContent, '上海');
  assert.ok(!h3.children[1], '未溢出时不加 aria-hidden 克隆（:7378 ni needsScroll=false）');
  const loc = first(p, 'station-panel__location');
  const pin = loc.children[0];
  assert.equal(classesOf(pin), 'ht-icon filled');
  assert.equal(pin.getAttribute('viewBox'), '0 0 24 24');
  assert.match(pin.children[0].getAttribute('d'), /^M12 2C8\.13 2 5 5\.13 5 9c0 5\.25/);
  const lt = first(loc, 'station-panel__location-text');
  assert.equal(lt.children[0].textContent, '上海, 中国');
});

test('无 name 回落 unnamed 槽；无行政区字段仍出坐标行（:7314 + :7382 f 真值）', () => {
  const { api } = loadPanel();
  const p = api.buildPanel(station('r-9', { name: '' }), {});
  assert.equal(first(p, 'station-panel__name').children[0].textContent, '声音信标 r-9');
  assert.equal(first(p, 'station-panel__location-text').children[0].textContent, '121.47°, 31.23°');
});

test('Xf desc 段（:7397-7399）：p.station-panel__desc.ht-scrollbar；空描述加 --placeholder 且落默认文案', () => {
  const { api } = loadPanel();
  const withDesc = api.buildPanel(station('a', { description: '今晚放映《星际穿越》' }), {});
  const d1 = first(withDesc, 'station-panel__desc');
  assert.equal(classesOf(d1), 'station-panel__desc ht-scrollbar');
  assert.equal(d1.textContent, '今晚放映《星际穿越》');
  const empty = api.buildPanel(station('a'), {});
  const d2 = first(empty, 'station-panel__desc');
  assert.equal(classesOf(d2), 'station-panel__desc ht-scrollbar station-panel__desc--placeholder');
  assert.equal(d2.textContent, '关于这个声音信标，主播什么也没说');
  // 本地数据源 → hearthere 槽位（裁决甲：people→listenerCount，title→description）
  const film = api.buildPanel(station('a', { title: '《星际穿越》' }), {});
  assert.equal(first(film, 'station-panel__desc').textContent, '《星际穿越》');
  assert.ok(!first(film, 'station-panel__desc').classList.contains('station-panel__desc--placeholder'));
});

test('Xf actions 段（:7400-7410）：listeners 取 Zf 图标 + 本地 people；action-group 只收藏星（裁决甲）', () => {
  const { api } = loadPanel();
  const p = api.buildPanel(station('a', { people: 7 }), { isFavorite: false });
  const listeners = first(p, 'station-panel__listeners');
  const z = listeners.children[0];
  assert.equal(classesOf(z), 'ht-icon filled');
  assert.equal(z.getAttribute('viewBox'), '0 0 28 28');
  assert.match(z.children[0].getAttribute('d'), /^M9\.5 14a4\.5 4\.5/);
  assert.equal(String(listeners.children[1].textContent), '7', '无实时订阅面 → people 落 listenerCount 槽');
  const group = first(p, 'station-panel__action-group');
  assert.equal(group.children.length, 1, '收藏星一枚（聊天/导播台不移植）');
  const fav = group.children[0];
  assert.equal(classesOf(fav), 'ht-icon-btn station-panel__action-icon-btn');
  assert.equal(fav.getAttribute('aria-label'), '收藏声音信标');
  assert.equal(first(fav, 'ht-icon').getAttribute('viewBox'), '0 0 24 24');
  assert.equal(first(fav, 'ht-icon').children[0].getAttribute('d'),
    'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14l-5-4.87 6.91-1.01L12 2z');
});

test('收藏星切换（:7627-7631）：已收藏 is-active + aria-label 取消收藏；点击透传回调', () => {
  const { api } = loadPanel();
  let toggled = 0;
  const p = api.buildPanel(station('a'), { isFavorite: true, onFavorite: function () { toggled++; return false; } });
  const fav = first(first(p, 'station-panel__action-group'), 'ht-icon-btn');
  assert.equal(classesOf(fav), 'ht-icon-btn station-panel__action-icon-btn is-active');
  assert.equal(fav.getAttribute('aria-label'), '取消收藏');
  fav.dispatch('click');
  assert.equal(toggled, 1);
});

test('CTA 行逐字（:7656-7674）：tune_in → cta-row 双按钮 current(cyan)+next；离线单按钮 secondary 禁用', () => {
  const { api } = loadPanel();
  const actions = [];
  const p = api.buildPanel(station('a'), {
    listeningStationId: null, canGoNext: true, onAction: function (k) { actions.push(k); }
  });
  const row = first(p, 'station-panel__cta-row');
  assert.ok(row, 'T = (stop|tune_in) → cta-row');
  const cur = row.children[0];
  assert.equal(classesOf(cur), 'ht-btn station-panel__cta station-panel__cta--current primary station-panel__cta--tune-in-cyan');
  assert.equal(cur.children[1].textContent, '进入房间');
  assert.equal(classesOf(first(cur, 'station-panel__cta-icon')), 'station-panel__cta-icon');
  const next = row.children[1];
  assert.equal(classesOf(next), 'ht-btn primary station-panel__cta station-panel__cta--next station-panel__cta--tune-in-cyan');
  assert.equal(next.children[1].textContent, '下一个电台');
  cur.dispatch('click');
  next.dispatch('click');
  assert.deepEqual(actions, ['tune_in', 'next_station']);

  const off = api.buildPanel(station('a', { status: 'offline' }), {});
  assert.ok(!first(off, 'station-panel__cta-row'), 'offline 不在 T 内 → 单按钮分支（:7675-7683）');
  const btn = first(off, 'station-panel__cta');
  assert.equal(classesOf(btn), 'ht-btn station-panel__cta secondary is-disabled station-panel__cta--unavailable');
  assert.equal(btn.children[1].textContent, '离线');
  assert.equal(btn.disabled, true);
});

test('收听中 CTA 落 stop 态（:7659）+ canGoNext=false 禁 next（:7667）', () => {
  const { api } = loadPanel();
  const p = api.buildPanel(station('a'), { listeningStationId: 'a', canGoNext: false });
  const row = first(p, 'station-panel__cta-row');
  assert.equal(classesOf(row.children[0]), 'ht-btn station-panel__cta station-panel__cta--current station-panel__cta--stop danger');
  assert.equal(row.children[0].children[1].textContent, '退出观看');
  assert.equal(row.children[1].disabled, true);
});

test('ni 跑马灯（:7284-7302 + :7378）：文本溢出 → is-scrolling + aria-hidden 克隆 span（挂载后测量，等价 useLayoutEffect）', () => {
  const { api } = loadPanel();
  const host = makeEl('div');
  api.mount(host);
  api.open(station('a', { city: '上海', country: '中国' }), {});
  const h3 = first(host, 'station-panel__name');
  const lt = first(host, 'station-panel__location-text');
  assert.ok(h3 && lt, '面板应在 DOM 上');
  h3.offsetWidth = 100; h3.children[0].offsetWidth = 260; h3.children[0].scrollWidth = 260;
  lt.offsetWidth = 120; lt.children[0].offsetWidth = 10; lt.children[0].scrollWidth = 300;
  api.refreshMarquee();
  assert.ok(h3.classList.contains('is-scrolling'), '站名溢出应加 is-scrolling');
  assert.equal(h3.children.length, 2, '应追加 aria-hidden 克隆');
  assert.equal(h3.children[1].getAttribute('aria-hidden'), 'true');
  assert.equal(h3.children[1].textContent, h3.children[0].textContent);
  assert.ok(lt.classList.contains('is-scrolling'), '位置行同样接 ni');
  assert.equal(lt.children.length, 2);

  h3.children[0].offsetWidth = 40; h3.children[0].scrollWidth = 40;
  api.refreshMarquee();
  assert.ok(!h3.classList.contains('is-scrolling'), '回缩后须摘 is-scrolling');
  assert.equal(h3.children.length, 1, '克隆 span 须移除（幂等重测）');
});

// ---------------- Rd 外壳：.nav-bar > .nav-panel--station ----------------

test('station tab 外壳（:3296-3325）：nav-bar > nav-panel nav-panel--station > ht-panel；station 变体不出 nav-panel__close', () => {
  const { api } = loadPanel();
  const host = makeEl('div');
  api.mount(host);
  api.open(station('a'), {});
  assert.ok(api.isOpen());
  const shell = host.children[0];
  assert.equal(classesOf(shell), 'nav-bar');
  const panel = shell.children[0];
  assert.equal(classesOf(panel), 'nav-panel nav-panel--station');
  assert.equal(classesOf(panel.children[0]), 'ht-panel');
  assert.ok(!first(panel, 'nav-panel__close'), 'A = tab!==station → 外壳关闭钮不渲染（:3301/:3309）');
  assert.ok(!first(panel, 'nav-panel--ghost'), '有 station 内容 → 非 ghost（:3296）');
});

test('open 换台只留一张面板；close 立即卸载（station tab 不接 fi :10393-10404，无退场帧）', () => {
  const { api } = loadPanel();
  const host = makeEl('div');
  api.mount(host);
  api.open(station('a'), {});
  api.open(station('b', { name: '东京' }), {});
  assert.equal(host.children[0].children.length, 1, 'nav-bar 内只应一块面板');
  assert.equal(first(host, 'station-panel__name').children[0].textContent, '东京');
  let closed = 0;
  api.open(station('c'), { onClose: function () { closed++; } });
  api.close();
  assert.equal(api.isOpen(), false);
  assert.equal(host.children[0].children.length, 0, 'close 即卸载，无 exiting 帧');
  assert.equal(api.panelEl(), null);
  api.close();
  assert.equal(api.isOpen(), false, '重复 close 安全');
  assert.equal(closed, 1, 'onClose 回调恰一次（:19971 It(null)）');
});

test('未 mount 时 open/close/isOpen/panelEl 安全（契约面）', () => {
  const { api } = loadPanel();
  assert.equal(api.isOpen(), false);
  assert.equal(api.panelEl(), null);
  api.close();
  api.open(station('a'), {});
  assert.equal(api.isOpen(), false, '未挂载不得凭空建 DOM');
});

// ---------------- CSS 逐字 ----------------

function norm(s) { return s.replace(/\s+/g, ''); }

test('world-ht-panel.css：token 与面板规则逐字搬运（main-CHYeapRt.css）', () => {
  assert.ok(fs.existsSync(CSS_PATH), 'public/video/world-ht-panel.css 应存在（④-4 待实现）');
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  const must = [
    '--layout-panel-width: clamp(17.28rem, 23.04vw, 23.04rem)',
    '--duration-base: .3s',
    '.ht-panel{position:relative;',
    '.nav-panel--station{background:transparent;padding:0;box-shadow:none;',
    '.nav-bar{',
    '@keyframes nav-panel-in{0%{opacity:0;transform:translateY(-8px)}',
    '.station-panel__hero-img.has-progressive-thumb:not(.is-loaded){opacity:0}',
    '.station-panel__name.is-scrolling',
    '@keyframes station-panel-text-scroll{0%{transform:translate(0)}',
    '.station-panel__cta--tune-in-cyan.ht-btn.primary{',
    '.station-panel__cta--current,.station-panel__cta--stop{flex:1.35 1 0}',
    '.station-panel__cta--next{flex:.85 1 0}',
    '.ht-badge.live:before{',
    '@keyframes ht-badge-pulse',
    '.ht-icon-btn--overlay{--icon-size: var(--icon-size-xs)',
    '@keyframes spin-chrome-ring{to{--angle: 360deg}}',
    '@media(max-width:767px)'
  ];
  const ncss = norm(css);
  for (const m of must) assert.ok(ncss.indexOf(norm(m)) >= 0, 'CSS 应含逐字片段：' + m);
});

test('自研卡片面退役：lighthouse.css 不再含 .world-card（规则随面板归档，不删除文件）', () => {
  const lh = read('public/video/lighthouse/lighthouse.css');
  assert.ok(!/\.world-card/.test(lh), '自研 .world-card* 规则应移入 _archive/');
});

// ---------------- index.html 注册 ----------------

test('index.html 注册 world-ht-panel.css 与 world-ht-panel.js（js 在 page-world.js 之前）', () => {
  const html = read('public/index.html');
  const iCss = html.indexOf('video/world-ht-panel.css');
  const iJs = html.indexOf('"video/world-ht-panel.js"');
  const iPage = html.indexOf('"video/page-world.js"');
  assert.ok(iCss >= 0, '应挂 <link> 面板样式');
  assert.ok(iJs >= 0, 'SFV_SCRIPTS 应含 world-ht-panel.js');
  assert.ok(iJs < iPage, '面板模块须先于 page-world 注册');
  assert.strictEqual((html.match(/video\/world-ht-panel\.js"/g) || []).length, 1);
});

// ---------------- page-world 重接线 ----------------

test('page-world：点击命中即开面板（wt :19638 openStationPanel 先于飞行），moveend/showCard 面退役', () => {
  const src = read('public/video/page-world.js');
  assert.match(src, /SFV\.worldHtPanel/, '应改接 ht-panel');
  assert.ok(!/moveend/.test(src), 'moveend 开卡（Task 6 自研）应整条退役');
  assert.ok(!/showCard/.test(src), 'worldUi.showCard 自研卡片面应退役');
  assert.ok(!/openStationCard/.test(src), 'openStationCard 辅助应随之退役');
});

test('page-world：空白点击 no-op（Us :19826 命中空即 return，不关面板、不取消在途飞行）', () => {
  const src = read('public/video/page-world.js');
  assert.ok(!/点空处 = Esc/.test(src), '旧「点空处即关卡」语义应退役');
  const i = src.indexOf('function onMapClick');
  assert.ok(i >= 0, '应保留 onMapClick 入口');
  const body = src.slice(i, i + 900);
  assert.ok(!/hideCard|worldHtPanel\.close\(\)/.test(body), '空白点击分支不得关面板');
});

test('world-ui：自研卡片 DOM 退役（showCard/hideCard/cardEl 移除，HUD 面保留）', () => {
  const src = read('public/video/world-ui.js');
  assert.ok(!/function showCard/.test(src), 'showCard 应移除');
  assert.ok(!/world-card/.test(src), 'world-card DOM 应移除');
  for (const keep of ['setStats', 'setOnAir', 'showLoading', 'hideLoading', 'toast']) {
    assert.ok(new RegExp('\\b' + keep + '\\b').test(src), 'HUD 面 ' + keep + ' 应保留');
  }
});

test('world-ht-panel.js 语法合法', () => {
  const { execFileSync } = require('node:child_process');
  if (!fs.existsSync(MODULE_PATH)) return; // 文件缺失由上面用例判负
  execFileSync(process.execPath, ['--check', MODULE_PATH], { encoding: 'utf8', stdio: 'pipe' });
});
