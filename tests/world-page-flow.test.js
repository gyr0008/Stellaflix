'use strict';

/**
 * 世界页 Task 6 — page-world 接线流程（public/video/page-world.js）
 * 运行：node --test tests/world-page-flow.test.js
 *
 * vm 沙箱装假 SFV（worldGlobe/deck/worldUi/boundaries/data/mapActions 桩），
 * 跑真实 page-world.js 的注册路由 mount/unmount，断言交互契约：
 *  (a) 点击命中站点 → setSelected + flyTo，卡片只在该飞行的 moveend 之后打开
 *      （hearthere :19620-19650 token 模式）
 *  (b) 被取代飞行的 moveend 不开旧卡片（token 不等 → 直接摘监听）
 *  (c) unmount 取消在途飞行 token + 停自转（worldMapActions.unmount）
 *  (d) 房间轮询走 deck.refreshStations，不再回老 worldLighthouse
 * 悬停 cursor / 空点关卡片也在此契约内。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const ROOMS = [
  { id: 'r1', roomId: 'room-1', name: '上海', lon: 121.47, lat: 31.23, status: 'playing', title: 'X', people: 2 },
  { id: 'r2', roomId: 'room-2', name: '巴黎', lon: 2.35, lat: 48.86, status: 'online', title: 'Y', people: 1 }
];
const STATIONS = [
  { id: 'r1', name: '上海', position: [121.47, 31.23], status: 'playing' },
  { id: 'r2', name: '巴黎', position: [2.35, 48.86], status: 'online' }
];

function makeFakeDom() {
  function el() {
    const n = {
      style: {}, className: '', textContent: '', children: [], parentNode: null,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      setAttribute() {}, appendEventListener: null,
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
  const log = { flyTo: [], easeTo: [] };
  const map = {
    handlers, canvas, log,
    on(ev, h) { (handlers[ev] = handlers[ev] || []).push(h); },
    off(ev, h) {
      const arr = handlers[ev] || [];
      const i = arr.indexOf(h);
      if (i >= 0) arr.splice(i, 1);
    },
    emit(ev, e) { (handlers[ev] || []).slice().forEach((h) => h(e || {})); },
    getZoom() { return 13; },
    getBearing() { return 0; },
    getCanvas() { return canvas; },
    project(lngLat) { return { x: 400, y: 300 }; },
    flyTo(o) { log.flyTo.push(o); return map; },
    easeTo(o) { log.easeTo.push(o); return map; }
  };
  return map;
}

// 组装一个完整假 SFV 环境并跑真实 page-world.js，返回驱动句柄
function setup() {
  const dom = makeFakeDom();
  const map = makeFakeMap();
  const overlay = { setProps() {} };
  const info = { map, overlay, viewer: { camera: {} }, basemap: 'esri' };

  const calls = {
    globeUnmounted: 0, deckMounted: [], deckUnmounted: 0, deckSetSelected: [],
    deckRefresh: [], deckApplyTier: [], oldLighthouseMounted: 0, oldLighthouseRefresh: 0,
    actionsMounts: [], actionsUnmounted: 0, flyTo: [], showCard: [], hideCard: 0,
    toasts: [], stats: [], boundariesUnmounted: 0, order: [], roomPollHandlers: []
  };

  const ui = {
    mounted: false, cardEl: null,
    mount() { this.mounted = true; return dom.document.createElement('div'); },
    unmount() { this.mounted = false; this.cardEl = null; },
    showLoading() {}, hideLoading() {},
    toast(m) { calls.toasts.push(m); },
    setStats(s) { calls.stats.push(s); },
    setOnAir() {}, setOnAirHandler(fn) { ui._onAir = fn; },
    setHintHandler(fn) { ui._hint = fn; },
    setCreateHandler(fn) { ui._create = fn; },
    setRotateState() {}, fireworksCanvas() { return null; },
    showCard(st, pos, opts) {
      calls.showCard.push({ st, pos, opts });
      calls.order.push('card');
      this.cardEl = { getAttribute: (k) => (k === 'data-station-id' ? st.id : null) };
    },
    hideCard() { calls.hideCard++; this.cardEl = null; }
  };

  const deck = {
    _picked: null,
    mount(m, ov, opts) {
      calls.deckMounted.push({ m, ov, opts });
      calls.order.push('deck-mount');
      return Promise.resolve({ count: (opts && opts.stations ? opts.stations.length : 0) });
    },
    unmount() { calls.deckUnmounted++; },
    refreshStations(rooms) { calls.deckRefresh.push(rooms); return { count: rooms.length }; },
    setSelected(id) { calls.deckSetSelected.push(id); },
    applyTier(z) { calls.deckApplyTier.push(z); },
    getState() { return { stations: STATIONS, selectedId: null, visible: true }; },
    pickStation(x, y) { return deck._picked; }
  };

  const acts = {
    autoRotate: true,
    mount(m, opts) { calls.actionsMounts.push({ m, opts }); },
    unmount() { calls.actionsUnmounted++; calls.order.push('actions-unmount'); },
    flyTo(st) { calls.flyTo.push(st); calls.order.push('fly'); },
    resetView() {}, setAutoRotate(on) { acts.autoRotate = !!on; },
    isFavorite() { return false; }, toggleFavorite() { return true; }
  };

  const intervals = [];
  const sandbox = {
    console, Promise,
    setInterval(fn, ms) { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval(id) { const it = intervals[id - 1]; if (it) it.cleared = true; },
    setTimeout(fn, ms) { return setTimeout(fn, ms); },
    clearTimeout(t) { clearTimeout(t); },
    document: dom.document,
    worldGlobeStubInfo: info
  };
  sandbox.window = sandbox;

  sandbox.StellaflixVideo = {
    router: { register(p) { sandbox._page = p; }, go() {}, currentId() { return 'world'; } },
    ui: { setTitle() {} },
    worldGlobe: {
      mount() { return Promise.resolve(info); },
      unmount() { calls.globeUnmounted++; }
    },
    worldUi: ui,
    worldBoundaries: { mount() {}, unmount() { calls.boundariesUnmounted++; } },
    // 老 Cesium 灯塔/行为模块：Task 6 起 page-world 不得再调 mount/refreshStations
    worldLighthouse: {
      mount() { calls.oldLighthouseMounted++; return Promise.resolve({ stations: [] }); },
      unmount() {}, refreshStations(r) { calls.oldLighthouseRefresh++; return { count: r.length }; },
      applyTier() {}
    },
    worldLighthouseDeck: deck,
    worldMapActions: acts,
    worldData: { fetchRooms() { return Promise.resolve({ rooms: ROOMS, source: 'demo' }); } },
    worldRoom: {
      setMapRefreshHandler(fn) { calls.roomPollHandlers.push(fn); },
      leave() {}, joinWatchRoom() { return Promise.resolve(); },
      createHost() { return Promise.resolve(); }
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(read('public/video/page-world.js'), sandbox);

  const page = sandbox._page;
  const host = dom.document.createElement('div');

  const flush = async (n) => {
    for (let i = 0; i < (n || 25); i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < (n || 25); i++) await Promise.resolve();
  };

  return { page, host, map, overlay, deck, ui, acts, calls, intervals, flush, SFV: sandbox.StellaflixVideo };
}

test('mount 流程：globe→ui→boundaries→deck(map,overlay)，老 worldLighthouse 不再挂载', async () => {
  const t = setup();
  t.page.mount(t.host, {});
  await t.flush();

  assert.equal(t.calls.deckMounted.length, 1, 'deck 层应挂载一次');
  const dm = t.calls.deckMounted[0];
  assert.equal(dm.m, t.map, 'deck.mount 第一参应为 maplibre map');
  assert.equal(dm.ov, t.overlay, 'deck.mount 第二参应为 deck MapboxOverlay');
  assert.deepEqual(dm.opts.stations, ROOMS, 'stations 应为 fetchRooms 的房间表');
  assert.equal(typeof dm.opts.onBeaconClick, 'function');
  assert.equal(typeof dm.opts.onHover, 'function');
  assert.equal(t.calls.oldLighthouseMounted, 0, 'Task 6 反转：page-world 不再调老 Cesium 灯塔 mount');
  assert.equal(t.calls.actionsMounts.length, 1, 'worldMapActions.mount 应被调用');
  assert.equal(t.calls.actionsMounts[0].m, t.map, '行为层直收 maplibre map');
  assert.deepEqual(t.calls.deckApplyTier, [13], '挂载后应把当前 zoom 推给 applyTier');
  t.page.unmount();
  await t.flush();
});

test('(a) 点击命中：setSelected + flyTo 先行，卡片只在 moveend 后打开（fly→end→card）', async () => {
  const t = setup();
  t.page.mount(t.host, {});
  await t.flush();

  t.deck._picked = STATIONS[0];
  t.map.emit('click', { point: { x: 120, y: 220 } });
  await t.flush();

  assert.deepEqual(t.calls.deckSetSelected, ['r1'], '命中即 setSelected');
  assert.deepEqual(t.calls.flyTo.map((s) => s.id), ['r1'], 'flyTo 应飞向该站');
  assert.equal(t.calls.showCard.length, 0, '飞行途中不开卡');
  assert.ok(t.calls.order.indexOf('fly') > t.calls.order.indexOf('deck-mount'), 'flyTo 应在 deck 挂载之后');

  t.calls.order.push('end');
  t.map.emit('moveend');
  await t.flush();
  assert.equal(t.calls.showCard.length, 1, 'moveend 后卡片打开');
  assert.equal(t.calls.showCard[0].st.id, 'r1');
  assert.deepEqual(t.calls.showCard[0].pos, { x: 400, y: 300 }, '卡片锚点取 moveend 后的投影位置');
  const tail = t.calls.order.slice(t.calls.order.indexOf('fly'));
  assert.deepEqual(tail, ['fly', 'end', 'card'], '顺序契约：fly → moveend → card');
  t.page.unmount();
});

test('(b) 被取代飞行：过期飞行绝不开出旧站点卡片，只开最新站且仅一次', async () => {
  const t = setup();
  t.page.mount(t.host, {});
  await t.flush();

  t.deck._picked = STATIONS[0];
  t.map.emit('click', { point: { x: 1, y: 1 } });
  await t.flush();
  t.deck._picked = STATIONS[1];
  t.map.emit('click', { point: { x: 2, y: 2 } });
  await t.flush();
  assert.equal(t.calls.showCard.length, 0, '两段飞行均未落地：不开卡');

  // token 契约：moveend 到来时只可能开出「最新 pending 站点」的卡片——
  // 被飞行 2 取代后的杂散 moveend（maplibre 中断旧动画时同样派发 moveend，
  // 事件无飞行身份）不得打开 r1 的过期卡片（token1 !== flySeq → 直接自摘）。
  t.map.emit('moveend');
  await t.flush();
  assert.equal(t.calls.showCard.filter((c) => c.st.id === 'r1').length, 0,
    '被取代飞行(r1)的 moveend 不得打开过期卡片（token 校验）');

  // 飞行 2 落地：开 r2 卡片，且只开这一次（一次性监听消费后自摘）
  t.map.emit('moveend');
  await t.flush();
  const r2cards = t.calls.showCard.filter((c) => c.st.id === 'r2');
  assert.ok(r2cards.length >= 1, '最新飞行落地的 moveend 应打开 r2 卡片');
  t.map.emit('moveend');
  await t.flush();
  assert.equal(t.calls.showCard.length, r2cards.length,
    '杂散 moveend 不得重复开卡（一次性监听消费后自摘）');
  assert.equal(t.calls.showCard.every((c) => c.st.id === 'r2'), true, '全程未出现 r1 过期卡片');
  t.page.unmount();
});

test('(c) unmount 取消在途飞行 token 并停自转循环（worldMapActions.unmount）', async () => {
  const t = setup();
  t.page.mount(t.host, {});
  await t.flush();

  t.deck._picked = STATIONS[0];
  t.map.emit('click', { point: { x: 5, y: 5 } });
  await t.flush();
  assert.equal(t.calls.flyTo.length, 1);

  t.page.unmount();
  t.map.emit('moveend');
  await t.flush();
  assert.equal(t.calls.showCard.length, 0, 'unmount 后迟到的 moveend 不得开卡');
  assert.equal(t.calls.actionsUnmounted, 1, '行为层 unmount 必须被调（内部停 rAF 自转循环）');
  assert.equal(t.calls.deckUnmounted, 1);
  assert.equal(t.calls.globeUnmounted, 1);
  assert.equal(t.calls.boundariesUnmounted, 0, '步骤②：boundaries 已停挂，unmount 链不再调用');
});

test('(d) 房间轮询走 deck.refreshStations，不再回老 worldLighthouse', async () => {
  const t = setup();
  t.page.mount(t.host, {});
  await t.flush();

  const poll = t.intervals.find((i) => i.ms === 20000);
  assert.ok(poll, '应注册 20s 房间轮询');
  poll.fn();
  await t.flush(40);
  assert.equal(t.calls.deckRefresh.length, 1, '轮询结果应推给 deck.refreshStations');
  assert.deepEqual(t.calls.deckRefresh[0], ROOMS);
  assert.equal(t.calls.oldLighthouseRefresh, 0, '老灯塔层不得再接收刷新');
  // B1：worldRoom.setMapRefreshHandler 的即时刷新同样走 deck
  assert.equal(t.calls.roomPollHandlers.length, 1);
  t.calls.roomPollHandlers[0]();
  await t.flush(40);
  assert.equal(t.calls.deckRefresh.length, 2);
  t.page.unmount();
});

test('悬停 pointer / 空点关卡片（Esc 语义）', async () => {
  const t = setup();
  t.page.mount(t.host, {});
  await t.flush();

  t.deck._picked = STATIONS[0];
  t.map.emit('mousemove', { point: { x: 9, y: 9 } });
  assert.equal(t.map.canvas.style.cursor, 'pointer', '悬停站点应显示 pointer');
  t.deck._picked = null;
  t.map.emit('mousemove', { point: { x: 9, y: 9 } });
  assert.equal(t.map.canvas.style.cursor, '', '离开站点应恢复');

  // 开卡后点空处 → 关卡片
  t.deck._picked = STATIONS[0];
  t.map.emit('click', { point: { x: 1, y: 1 } });
  t.map.emit('moveend');
  await t.flush();
  assert.equal(t.calls.showCard.length, 1);
  const before = t.calls.hideCard;
  t.deck._picked = null;
  t.map.emit('click', { point: { x: 2, y: 2 } });
  assert.ok(t.calls.hideCard > before, '点空处应关卡片');
  t.page.unmount();
});

test('Fix round 1 (I-2)：在途 rooms fetch 在 unmount 后才兑现，不得再调 deck.refreshStations', async () => {
  const t = setup();
  t.page.mount(t.host, {});
  await t.flush();

  const poll = t.intervals.find((i) => i.ms === 20000);
  assert.ok(poll, '前置：20s 轮询已注册');

  // 换成手动兑现的 fetchRooms：tick 发起后请求挂起
  let release;
  const pending = new Promise((res) => { release = res; });
  t.SFV.worldData.fetchRooms = function () { return pending; };
  poll.fn(); // 在途请求
  await t.flush();
  assert.equal(t.calls.deckRefresh.length, 0, '请求未兑现前不刷新');

  t.page.unmount(); // 切页：轮询周期停 + seq 自增
  release({ rooms: ROOMS, source: 'demo' }); // 过期请求这时才回来
  await t.flush(40);
  assert.equal(t.calls.deckRefresh.length, 0,
    'unmount 后兑现的旧请求不得再碰已卸载的 deck');
});

test('Fix round 1 (I-2)：unmount 清空 room 模块即时刷新 handler（setMapRefreshHandler(null)）', async () => {
  const t = setup();
  t.page.mount(t.host, {});
  await t.flush();

  const registered = t.calls.roomPollHandlers.filter((f) => typeof f === 'function');
  assert.equal(registered.length, 1, '前置：挂载注册了一个即时刷新 handler');

  t.page.unmount();
  const last = t.calls.roomPollHandlers[t.calls.roomPollHandlers.length - 1];
  assert.strictEqual(last, null, 'unmount 必须以 null 注销 handler（world-room 真实面：非函数即清空）');

  // 注销后即便有人拿着旧 handler 再调，也不得刷新已卸载的 deck
  const before = t.calls.deckRefresh.length;
  registered[0]();
  await t.flush(40);
  assert.equal(t.calls.deckRefresh.length, before, '过期 tick 兑现不得触达 deck');
});

test('统计/快捷键语义保留：setStats 按 deck 状态计数，hint reset/rotate 走行为层', async () => {
  const t = setup();
  t.page.mount(t.host, {});
  await t.flush();
  assert.equal(t.calls.stats.length, 1);
  assert.equal(t.calls.stats[0].total, 2);
  assert.equal(t.calls.stats[0].playing, 1);
  assert.equal(t.calls.stats[0].online, 1);
  assert.equal(t.calls.stats[0].offline, 0);
  assert.equal(typeof t.ui._hint, 'function', 'Esc/R/F/A hintHandler 应保留');
  assert.equal(typeof t.ui._onAir, 'function', 'ON AIR handler 应保留');
  // R → resetView；A → setAutoRotate 取反并回推 setRotateState
  let resetCalls = 0;
  let rotateArg = null;
  t.acts.resetView = function () { resetCalls++; };
  t.acts.setAutoRotate = function (on) { rotateArg = on; t.acts.autoRotate = on; };
  t.ui._hint('reset');
  t.ui._hint('rotate');
  assert.equal(resetCalls, 1, 'reset 走行为层 resetView');
  assert.equal(rotateArg, false, 'rotate 切到关（挂载桩默认 autoRotate=true → 取反 false）');
  assert.ok(t.calls.toasts.length >= 1, 'toast 语义保留');
  t.page.unmount();
});
