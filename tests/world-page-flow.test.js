'use strict';

/**
 * 世界页 Task 6 — page-world 接线流程（public/video/page-world.js）
 * 运行：node --test tests/world-page-flow.test.js
 *
 * vm 沙箱装假 SFV（worldGlobe/deck/worldUi/worldHtPanel/boundaries/data/mapActions 桩），
 * 跑真实 page-world.js 的注册路由 mount/unmount，断言交互契约（④-4 起 hearthere 逐字）：
 *  (a) 点击命中站点 → setSelected → ht-panel 即点即开（wt :19638 It('station')
 *      先于相机动作）→ deck.flyToStation 独立飞行（card→fly 顺序）
 *  (b) 换台点击：面板即时替换为最新站点（无 moveend 开卡环节）
 *  (c) unmount 卸载面板 + 停自转（worldMapActions.unmount）
 *  (d) 房间轮询走 deck.refreshStations，不再回老 worldLighthouse
 * 悬停 cursor / 空白点击 no-op（Us :19793-19851 命中空即 return）也在此契约内。
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
    getCenter() { return { lng: 10.5, lat: 20.25 }; },
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
    actionsMounts: [], actionsUnmounted: 0, flyTo: [], panelOpened: [], panelClosed: 0,
    panelUnmounted: 0, toasts: [], stats: [], boundariesUnmounted: 0, order: [], roomPollHandlers: [],
    createHostCalls: []
  };

  const ui = {
    mounted: false,
    mount() { this.mounted = true; return dom.document.createElement('div'); },
    unmount() { this.mounted = false; },
    showLoading() {}, hideLoading() {},
    toast(m) { calls.toasts.push(m); },
    setStats(s) { calls.stats.push(s); },
    setOnAir() {}, setOnAirHandler(fn) { ui._onAir = fn; },
    setHintHandler(fn) { ui._hint = fn; },
    setCreateHandler(fn) { ui._create = fn; },
    setRotateState() {}, fireworksCanvas() { return null; }
  };

  // 假 ht-panel（④-4）：open 即同步记账（对应 wt It('station') 先于飞行），
  // close 计次；__station 由 buildPanel 挂真实面板上，桩这里直接带上。
  const panel = {
    _current: null,
    mount() { calls.order.push('panel-mount'); },
    unmount() { calls.panelUnmounted++; this._current = null; },
    open(st, opts) {
      calls.panelOpened.push({ st, opts });
      calls.order.push('card');
      this._current = { __station: st };
    },
    close() { calls.panelClosed++; this._current = null; },
    isOpen() { return !!this._current; },
    // :19973 ge.some(playing && id!==)
    canGoNextStation(list, id) { return (list || []).some((k) => k.status === 'playing' && k.id !== id); },
    panelEl() { return this._current; }
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
    flyToStation(st) { calls.flyTo.push(st); calls.order.push('fly'); },
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
    worldHtPanel: panel,
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
      createHost(o) { calls.createHostCalls.push(o); return Promise.resolve(); }
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

  return { page, host, map, overlay, deck, ui, acts, panel, calls, intervals, flush, SFV: sandbox.StellaflixVideo };
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

test('(a) 点击命中：setSelected → 面板即点即开 → 相机独立飞行（card→fly，wt :19638 顺序逐字）', async () => {
  const t = setup();
  t.page.mount(t.host, {});
  await t.flush();

  t.deck._picked = STATIONS[0];
  t.map.emit('click', { point: { x: 120, y: 220 } });
  await t.flush();

  assert.deepEqual(t.calls.deckSetSelected, ['r1'], '命中即 setSelected');
  assert.equal(t.calls.panelOpened.length, 1, '点击即开面板（不等飞行落地）');
  assert.equal(t.calls.panelOpened[0].st.id, 'r1');
  assert.deepEqual(t.calls.flyTo.map((s) => s.id), ['r1'], '相机飞向该站');
  const tail = t.calls.order.slice(t.calls.order.indexOf('deck-mount') + 1);
  assert.ok(tail.indexOf('card') < tail.indexOf('fly'), '面板先于飞行（It(station) 先于 zn）');
  const opts = t.calls.panelOpened[0].opts;
  assert.equal(typeof opts.onAction, 'function', 'CTA 动作回调应接线');
  assert.equal(typeof opts.onFavorite, 'function', '收藏星回调应接线');
  assert.equal(opts.isFavorite, false);
  assert.equal(opts.canGoNext, false, 'r1 是唯一 playing 台 → 无下一个（:19973 ge.some(playing && id!==)）');
  t.page.unmount();
});

test('(b) 换台点击：面板即时替换为最新站点，无落地开卡环节', async () => {
  const t = setup();
  t.page.mount(t.host, {});
  await t.flush();

  t.deck._picked = STATIONS[0];
  t.map.emit('click', { point: { x: 1, y: 1 } });
  await t.flush();
  t.deck._picked = STATIONS[1];
  t.map.emit('click', { point: { x: 2, y: 2 } });
  await t.flush();

  assert.equal(t.calls.panelOpened.length, 2, '两次点击各开一次（替换语义在真面板 clearShell）');
  assert.equal(t.calls.panelOpened[1].st.id, 'r2', '最后命中的是最新站点');
  assert.deepEqual(t.calls.deckSetSelected, ['r1', 'r2']);
  assert.deepEqual(t.calls.flyTo.map((s) => s.id), ['r1', 'r2'], '两次点击各自发起飞行');
  t.page.unmount();
});

test('(c) unmount 卸载面板并停自转循环（worldMapActions.unmount）', async () => {
  const t = setup();
  t.page.mount(t.host, {});
  await t.flush();

  t.deck._picked = STATIONS[0];
  t.map.emit('click', { point: { x: 5, y: 5 } });
  await t.flush();
  assert.equal(t.calls.flyTo.length, 1);
  assert.equal(t.panel.isOpen(), true, '前置：面板开着');

  t.page.unmount();
  await t.flush();
  assert.equal(t.panel.isOpen(), false, 'unmount 必须收掉面板');
  assert.equal(t.calls.panelUnmounted, 1, 'unmount 链应卸载 worldHtPanel');
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

test('悬停 pointer / 空白点击 no-op（Us :19826：命中为空不关面板）', async () => {
  const t = setup();
  t.page.mount(t.host, {});
  await t.flush();

  t.deck._picked = STATIONS[0];
  t.map.emit('mousemove', { point: { x: 9, y: 9 } });
  assert.equal(t.map.canvas.style.cursor, 'pointer', '悬停站点应显示 pointer');
  t.deck._picked = null;
  t.map.emit('mousemove', { point: { x: 9, y: 9 } });
  assert.equal(t.map.canvas.style.cursor, '', '离开站点应恢复');

  // 开面板后点空处 = hearthere 语义：no-op，面板保持开着
  t.deck._picked = STATIONS[0];
  t.map.emit('click', { point: { x: 1, y: 1 } });
  await t.flush();
  assert.equal(t.calls.panelOpened.length, 1);
  t.deck._picked = null;
  t.map.emit('click', { point: { x: 2, y: 2 } });
  assert.equal(t.calls.panelClosed, 0, '空白点击不得关面板（旧「点空处即关」已退役）');
  assert.equal(t.calls.panelOpened.length, 1, '空白点击也不得重复开');
  assert.equal(t.panel.isOpen(), true);
  t.page.unmount();
});

test('CTA 接线：tune_in→joinWatchRoom（收听态重开）/ stop→leave / next_station→换台', async () => {
  const t = setup();
  const joinIds = [];
  let leaveCount = 0;
  t.SFV.worldRoom.joinWatchRoom = function (st) { joinIds.push(st.id); return Promise.resolve(); };
  t.SFV.worldRoom.leave = function () { leaveCount++; };
  // 换台靶子：:19973 逐字语义只在 playing 信标间跳转，本用例需 r2 也是 playing
  t.deck.getState = () => ({
    stations: [STATIONS[0], Object.assign({}, STATIONS[1], { status: 'playing' })],
    selectedId: null, visible: true
  });
  t.page.mount(t.host, {});
  await t.flush();

  // r1（playing）CTA = tune_in → 进入房间
  t.deck._picked = STATIONS[0];
  t.map.emit('click', { point: { x: 1, y: 1 } });
  await t.flush();
  t.calls.panelOpened[0].opts.onAction('tune_in');
  await t.flush();
  assert.deepEqual(joinIds, ['r1'], 'tune_in 走 worldRoom.joinWatchRoom');
  assert.equal(t.calls.panelOpened.length, 2, '入房后面板以收听态重开（stop 态）');
  assert.equal(t.calls.panelOpened[1].opts.listeningStationId, 'r1');

  // stop → 退房并关面板（It(null) 等价），非重开
  t.calls.panelOpened[1].opts.onAction('stop');
  assert.equal(leaveCount, 1, 'stop 走 worldRoom.leave');
  assert.equal(t.calls.panelClosed, 1, 'stop 后面板关闭（收听态清空 = It(null)）');
  assert.equal(t.calls.panelOpened.length, 2, 'stop 不再重开面板');

  // 重开 r1（已非收听）→ next_station 跳到另一座非收听信标（r2）
  t.map.emit('click', { point: { x: 3, y: 3 } });
  await t.flush();
  const before = t.calls.panelOpened.length;
  t.calls.panelOpened[before - 1].opts.onAction('next_station');
  await t.flush();
  assert.equal(t.calls.panelOpened.length, before + 1, 'next_station 开出 r2 面板');
  assert.equal(t.calls.panelOpened[before].st.id, 'r2');
  assert.deepEqual(t.calls.deckSetSelected, ['r1', 'r1', 'r2'], '选中态：点卡一次一 setSelected，换台跳到 r2（tune_in 重开不重复 setSelected）');
  t.page.unmount();
});

test('Esc（ESC 快捷键）关面板 = It(null) 语义', async () => {
  const t = setup();
  t.page.mount(t.host, {});
  await t.flush();

  t.deck._picked = STATIONS[0];
  t.map.emit('click', { point: { x: 1, y: 1 } });
  await t.flush();
  assert.equal(t.panel.isOpen(), true);
  t.ui._hint('esc');
  assert.equal(t.panel.isOpen(), false, 'ESC 快捷键应关面板');
  t.ui._hint('esc');
  assert.equal(t.panel.isOpen(), false, '重复 ESC 幂等不抛');
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

test('A2（修复轮⑥）：创建放映缺坐标时取当前视野中心，绝不落 (0,0) 零点岛', async () => {
  const t = setup();
  t.page.mount(t.host, {});
  await t.flush();
  assert.equal(typeof t.ui._create, 'function', 'setCreateHandler 应接线');

  // 世界 UI 契约：创建面板只收片名/城市名/权限，不带经纬度（world-ui.js:297-307）
  t.ui._create({ title: '测试片', name: '济宁', discovery: true });
  assert.equal(t.calls.createHostCalls.length, 1, 'createHandler 应转给 worldRoom.createHost');
  const o = t.calls.createHostCalls[0];
  assert.equal(o.lon, 10.5, 'lon 应回填当前地图视野中心（fake getCenter lng=10.5）');
  assert.equal(o.lat, 20.25, 'lat 应回填当前地图视野中心（fake getCenter lat=20.25）');

  // 显式给了坐标则原样透传
  t.ui._create({ title: 'X', name: 'Y', lon: 139.69, lat: 35.69, discovery: true });
  assert.equal(t.calls.createHostCalls[1].lon, 139.69, '显式坐标不得被覆盖');
  t.page.unmount();
});
