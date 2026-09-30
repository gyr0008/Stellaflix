'use strict';

/**
 * 片库蜂窝卡片墙 DOM 层（hex-wall.js）
 * 运行：node --test tests/hex-wall.test.js
 *
 * 假 DOM 沙箱验证：池化挂载/回收、居中位移、中心卡按钮浮现、
 * 点击/双击/滚轮语义、空态与卸载。几何与衰减数学由 hex-card-wall.test.js 覆盖。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function makeClassList(el) {
  const set = new Set();
  return {
    add(...names) { names.forEach((n) => set.add(n)); },
    remove(...names) { names.forEach((n) => set.delete(n)); },
    toggle(name, force) {
      const want = force === undefined ? !set.has(name) : !!force;
      if (want) set.add(name); else set.delete(name);
      return want;
    },
    contains(name) { return set.has(name); },
    _set: set,
  };
}

function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parent: null,
    style: {
      setProperty(name, value) { this[name] = value; },
    },
    attributes: {},
    listeners: {},
    textContent: '',
    _innerHTML: '',
    clientWidth: 1280,
    clientHeight: 720,
    tabIndex: -1,
    _captureId: null,
  };
  el.classList = makeClassList(el);
  el.setPointerCapture = function (id) { this._captureId = id; };
  el.releasePointerCapture = function (id) {
    if (this._captureId === id) {
      this._captureId = null;
      // 浏览器在释放捕获时会派发 lostpointercapture
      (this.listeners.lostpointercapture || []).slice().forEach((fn) => fn({
        type: 'lostpointercapture',
        pointerId: id,
        target: this,
        preventDefault() {},
        stopPropagation() {},
      }));
    }
  };
  el.hasPointerCapture = function (id) { return this._captureId === id; };
  el.appendChild = function (child) {
    child.parent = this;
    this.children.push(child);
    return child;
  };
  el.removeChild = function (child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parent = null;
    return child;
  };
  el.setAttribute = function (name, value) { this.attributes[name] = String(value); };
  el.getAttribute = function (name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  };
  el.addEventListener = function (type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  };
  el.removeEventListener = function (type, fn) {
    const list = this.listeners[type] || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
  el.querySelectorAll = function (selector) {
    const wantTag = selector.toUpperCase();
    const out = [];
    (function walk(node) {
      node.children.forEach((child) => {
        if (child.tagName === wantTag) out.push(child);
        walk(child);
      });
    })(el);
    return out;
  };
  el.querySelector = function (selector) {
    if (selector[0] === '#') {
      const id = selector.slice(1);
      const want = this;
      let found = null;
      (function walk(node) {
        node.children.forEach((child) => {
          if (!found && child.attributes && child.attributes.id === id) found = child;
          walk(child);
        });
      })(want);
      return found;
    }
    return this.querySelectorAll(selector)[0] || null;
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._innerHTML; },
    set(value) {
      this._innerHTML = value;
      this.children.forEach((c) => { c.parent = null; });
      this.children = [];
    },
  });
  return el;
}

function fire(el, type, event) {
  const ev = Object.assign({
    type,
    stopPropagation() {},
    preventDefault() {},
    target: el,
  }, event || {});
  (el.listeners[type] || []).slice().forEach((fn) => fn(ev));
}

function buttonsOf(el) {
  return el.querySelectorAll('BUTTON');
}

function loadHexWall(options) {
  const opts = options || {};
  const sandbox = { console, Math, Number, Array, Object, String, Boolean, Promise, Set, Map, JSON, Date, setTimeout, clearTimeout };
  sandbox.window = sandbox;
  const store = {};
  sandbox.localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  sandbox.__store = store;
  sandbox.document = {
    createElement: (tag) => makeEl(tag),
    getElementById: () => null,
    body: makeEl('body'),
  };
  vm.createContext(sandbox);
  vm.runInContext(read('public/js/modules/02-visual/16-hex-grid-viewport.js'), sandbox, { filename: 'hex-grid-viewport.js' });
  vm.runInContext(read('public/js/modules/02-visual/17-hex-card-transform.js'), sandbox, { filename: 'hex-card-transform.js' });

  sandbox.StellaflixVideo = {};
  sandbox.StellaflixVideo.posterWallAdapter =
    (opts.adapter && typeof opts.adapter === 'object') ? opts.adapter : makeStubAdapter(opts);
  vm.runInContext(read('public/video/poster-wall/hex-wall.js'), sandbox, { filename: 'hex-wall.js' });
  return { sandbox, wall: sandbox.StellaflixVideo.posterWall };
}

function makeItems(count) {
  const items = [];
  for (let i = 0; i < count; i += 1) {
    items.push({
      id: 'tmdb:movie:' + i,
      title: '片名 ' + i,
      year: '202' + (i % 10),
      rating: 6 + (i % 4),
      poster: 'https://example.com/p' + i + '.jpg',
      section: i === 5 ? 'continue' : 'catalog',
      sectionLabel: i === 5 ? '接着看' : '本周热门电影',
      category: '本周热门电影',
      source: 'tmdb',
      progress: i === 5 ? 0.4 : 0,
      key: i === 5 ? 'hist-key' : '',
      mediaType: 'movie',
      meta: { id: i, mediaType: 'movie', title: '片名 ' + i },
    });
  }
  return items;
}

function makeStubAdapter(opts) {
  const calls = { openDetail: [], playOrResume: [], openKeySettings: 0 };
  return {
    calls,
    collectWallItemsAsync() {
      return Promise.resolve({
        items: opts.keyMissing ? [] : makeItems(240),
        keyMissing: !!opts.keyMissing,
        errors: [],
      });
    },
    collectWallItems() { return []; },
    formatMetaLine(item) { return item.sectionLabel; },
    openDetail(item) { calls.openDetail.push(item); return true; },
    playOrResume(item) { calls.playOrResume.push(item); return true; },
    openTmdbKeySettings() { calls.openKeySettings += 1; return true; },
  };
}

function mountReady(wall, count) {
  const host = makeEl('div');
  wall.mount(host, { items: makeItems(count || 240) });
  return host;
}

test('mount：蜂窝墙就绪并池化挂载，可见卡数远小于总数', () => {
  const { wall } = loadHexWall({ adapter: null });
  const host = mountReady(wall);
  const state = wall.getState();
  assert.equal(host.getAttribute('data-sfv-library-wall'), 'ready');
  assert.equal(state.count, 240);
  assert.ok(state.mountedCount > 8, '应有可见卡挂载');
  assert.ok(state.mountedCount < 120, '视口裁剪应生效，实际 ' + state.mountedCount);
  assert.equal(wall.getNode(state.focusIndex).classList.contains('is-focused'), true);
});

test('centerOnIndex：世界偏移等于目标卡座位的反向量', () => {
  const { wall } = loadHexWall({ adapter: null });
  mountReady(wall);
  wall.centerOnIndex(50, { immediate: true });
  const state = wall.getState();
  assert.equal(state.focusIndex, 50);
  const seat = wall.coordOf(50);
  assert.equal(state.offset.dx, -seat.baseX);
  assert.equal(state.offset.dy, -seat.baseY);
});

test('聚焦提交：中心卡浮现「看详情」，continue 条目另给「续播」', () => {
  const { wall } = loadHexWall({ adapter: null });
  mountReady(wall);
  wall.centerOnIndex(5, { immediate: true });
  const node = wall.getNode(5);
  const labels = buttonsOf(node).map((b) => b.textContent);
  assert.ok(labels.includes('看详情'), '应有看详情按钮');
  assert.ok(labels.includes('续播'), 'continue 条目应有续播按钮');

  wall.centerOnIndex(0, { immediate: true });
  const catalogLabels = buttonsOf(wall.getNode(0)).map((b) => b.textContent);
  assert.ok(catalogLabels.includes('看详情'));
  assert.ok(!catalogLabels.includes('续播'), '目录条目不应出现续播');
});

test('点击非中心卡=居中；点击中心卡=看详情；双击任意卡=看详情', () => {
  const adapter = makeStubAdapter({});
  const { wall } = loadHexWall({ adapter });
  mountReady(wall);
  wall.centerOnIndex(0, { immediate: true });

  fire(wall.getNode(3), 'click');
  assert.equal(wall.getState().focusIndex, 3);
  assert.equal(adapter.calls.openDetail.length, 0, '首次点击不该开详情');

  fire(wall.getNode(3), 'click');
  assert.equal(adapter.calls.openDetail.length, 1);
  assert.equal(adapter.calls.openDetail[0].id, 'tmdb:movie:3');

  fire(wall.getNode(7), 'dblclick');
  assert.equal(adapter.calls.openDetail.length, 2);
});

test('滚轮平移世界；方向键移动焦点卡', () => {
  const { wall } = loadHexWall({ adapter: null });
  const host = mountReady(wall);
  wall.centerOnIndex(0, { immediate: true });
  const before = wall.getState().offset.dy;
  const field = wall.getState().dom.field;
  fire(field, 'wheel', { deltaY: 120, deltaMode: 0 });
  assert.notEqual(wall.getState().offset.dy, before, '滚轮应平移世界');

  wall.centerOnIndex(1, { immediate: true });
  fire(field, 'keydown', { key: 'ArrowRight' });
  assert.notEqual(wall.getState().focusIndex, 1, '方向键应移动焦点');
  assert.equal(wall.getNode(wall.getState().focusIndex).classList.contains('is-focused'), true);
});

test('refresh 走异步 adapter：拉取后重建墙', async () => {
  const adapter = makeStubAdapter({});
  const { wall } = loadHexWall({ adapter });
  const host = makeEl('div');
  await wall.mount(host);
  assert.equal(wall.getState().count, 240);
  assert.equal(host.getAttribute('data-sfv-library-wall'), 'ready');
});

test('refresh 节流：拉取进行中重复调用不再发起新请求，完成后仍可刷新', async () => {
  let resolveFirst;
  let collectCalls = 0;
  const adapter = {
    collectWallItemsAsync() {
      collectCalls += 1;
      if (collectCalls === 1) return new Promise((r) => { resolveFirst = r; });
      return Promise.resolve({ items: makeItems(10), keyMissing: false, errors: [] });
    },
    collectWallItems() { return []; },
    formatMetaLine() { return ''; },
    openDetail() { return true; },
    playOrResume() { return true; },
    openTmdbKeySettings() { return true; },
  };
  const { wall } = loadHexWall({ adapter });
  const host = makeEl('div');
  const first = wall.mount(host);
  const blocked = await wall.refresh();
  assert.equal(blocked, false, '进行中 refresh 应被节流');
  assert.equal(collectCalls, 1, '节流期间不得重发 TMDB 拉取');
  resolveFirst({ items: makeItems(20), keyMissing: false, errors: [] });
  await first;
  assert.equal(wall.getState().count, 20);
  await wall.refresh();
  assert.equal(collectCalls, 2, '上一轮完成后 refresh 应再次拉取');
  assert.equal(wall.getState().count, 10);
});

test('refresh 未挂载：toast 提示而非静默失败', async () => {
  const { sandbox, wall } = loadHexWall({ adapter: null });
  const toasts = [];
  sandbox.StellaflixVideo.online = { toast: (m) => toasts.push(m) };
  const ok = await wall.refresh();
  assert.equal(ok, false);
  assert.equal(toasts.length, 1, '未挂载时 refresh 应给出 toast 提示');
});

test('keyMissing：空态给出「去设置 TMDB Key」按钮并接通 adapter', async () => {
  const adapter = makeStubAdapter({ keyMissing: true });
  const { wall } = loadHexWall({ adapter });
  const host = makeEl('div');
  await wall.mount(host);
  assert.equal(host.getAttribute('data-sfv-library-wall'), 'need-tmdb-key');
  const btn = host.querySelector('#sfv-hex-set-key');
  assert.ok(btn, '空态应含设置按钮');
  fire(btn, 'click');
  assert.equal(adapter.calls.openKeySettings, 1);
});

test('聚焦提交：选中卡海报/片名写入 localStorage，供首页片库卡连线', () => {
  const { sandbox, wall } = loadHexWall({ adapter: null });
  mountReady(wall);
  wall.centerOnIndex(3, { immediate: true });
  const raw = sandbox.__store['stellaflix:library:lastPoster'];
  assert.ok(raw, 'commitFocus 应写入 lastPoster');
  const saved = JSON.parse(raw);
  assert.equal(saved.poster, 'https://example.com/p3.jpg');
  assert.equal(saved.title, '片名 3');

  wall.centerOnIndex(5, { immediate: true });
  const saved2 = JSON.parse(sandbox.__store['stellaflix:library:lastPoster']);
  assert.equal(saved2.title, '片名 5', '再次聚焦应覆写');
});

test('蜂窝咬合：spacingY 小于卡高（Folia desktop 档 320/330≈0.970）', () => {
  const { wall } = loadHexWall({ adapter: null });
  mountReady(wall);
  const state = wall.getState();
  const h = parseFloat(wall.getNode(state.focusIndex).style.height);
  // 找一个 z=1 的坐标反推 spacingY
  let spacingY = null;
  for (let i = 0; i < state.count && spacingY === null; i += 1) {
    const c = wall.coordOf(i);
    if (c && c.cube.z === 1) spacingY = c.baseY;
  }
  assert.ok(spacingY !== null, '应有 z=1 的坐标');
  assert.equal(h, 330, '1280 视口应为 Folia desktop 档卡高 330');
  assert.ok(Math.abs(spacingY - 320) <= 1,
    'spacingY 应为 Folia desktop 档 320（行咬合），实际 ' + spacingY);
});

test('maxDistance 收紧：远处卡定在最小 scale（Folia desktop 档 maxDistance=500）', () => {
  const { wall } = loadHexWall({ adapter: null });
  mountReady(wall);
  wall.centerOnIndex(0, { immediate: true });
  const st = wall.getState();
  const c0 = wall.coordOf(0);
  let found = null;
  for (let i = 1; i < st.count; i += 1) {
    const c = wall.coordOf(i);
    const dist = Math.sqrt((c.baseX - c0.baseX) ** 2 + (c.baseY - c0.baseY) ** 2);
    const node = wall.getNode(i);
    if (node && node.style.transform && dist > 520) { found = { dist, transform: node.style.transform }; break; }
  }
  assert.ok(found, '应有距离>520px 的挂载卡（1280 视口 desktop 档 maxDistance=500）');
  const m = /scale\(([\d.]+)\)/.exec(found.transform);
  assert.ok(m, 'transform 应含 scale');
  assert.ok(Math.abs(parseFloat(m[1]) - 0.45) < 0.02,
    '超出 maxDistance 的卡应定底 0.45，实际 ' + m[1]);
});

test('四档表：卡片/间距/衰减参数逐档照抄 Folia resolveGridViewCardBox（GridView.tsx:130-172）', () => {
  const TIERS = [
    { viewW: 600,  cardW: 180, cardH: 280, spacingX: 205, spacingY: 270, maxDistance: 420, lodStart: 280, lodEnd: 320 },
    { viewW: 1280, cardW: 220, cardH: 330, spacingX: 250, spacingY: 320, maxDistance: 500, lodStart: 340, lodEnd: 385 },
    { viewW: 1600, cardW: 250, cardH: 375, spacingX: 285, spacingY: 365, maxDistance: 580, lodStart: 400, lodEnd: 450 },
    { viewW: 2560, cardW: 280, cardH: 420, spacingX: 320, spacingY: 410, maxDistance: 660, lodStart: 450, lodEnd: 510 },
  ];
  TIERS.forEach((tier) => {
    const { wall } = loadHexWall({ adapter: null });
    const host = makeEl('div');
    host.clientWidth = tier.viewW;
    wall.mount(host, { items: makeItems(60) });
    const m = wall.getState().metrics;
    assert.ok(m, 'getState 应暴露 metrics');
    assert.deepEqual(
      { cardW: m.cardW, cardH: m.cardH, spacingX: m.spacingX, spacingY: m.spacingY,
        maxDistance: m.maxDistance, lodStart: m.lodStart, lodEnd: m.lodEnd },
      { cardW: tier.cardW, cardH: tier.cardH, spacingX: tier.spacingX, spacingY: tier.spacingY,
        maxDistance: tier.maxDistance, lodStart: tier.lodStart, lodEnd: tier.lodEnd },
      '视口 ' + tier.viewW + ' 应命中 Folia 对应档');
    wall.unmount();
  });
});

test('边界回弹：滚轮/拖拽越界后被钳回内容边界（Folia dragBounds 语义）', () => {
  const { wall } = loadHexWall({ adapter: null });
  mountReady(wall);
  wall.centerOnIndex(0, { immediate: true });
  const st = wall.getState();

  // 扫出内容包围盒
  let maxY = 0, maxX = 0;
  for (let i = 0; i < st.count; i += 1) {
    const c = wall.coordOf(i);
    if (c.baseY > maxY) maxY = c.baseY;
    if (c.baseX > maxX) maxX = c.baseX;
  }
  // 假 DOM host 1280×720：bufferY=max(0,360-2*spacingY)=0，top 边界=-maxY
  const field = wall.getState().dom.field;
  fire(field, 'wheel', { deltaY: 100000, deltaMode: 0 });
  const afterWheel = wall.getState().offset.dy;
  assert.ok(Math.abs(afterWheel - (-maxY)) <= 2,
    '滚轮越界应钳制到 top 边界 -maxY=' + (-maxY) + '，实际 ' + afterWheel);

  // 拖拽：向上拖 5000px（远超界）后松手，应回弹到边界
  fire(field, 'pointerdown', { button: 0, clientX: 100, clientY: 5000 });
  fire(field, 'pointermove', { clientX: 100, clientY: 5000 - 5000 });
  fire(field, 'pointerup', {});
  const afterDrag = wall.getState().offset.dy;
  assert.ok(Math.abs(afterDrag - (-maxY)) <= 2,
    '松手后应回弹钳制到边界，实际 ' + afterDrag);
});

test('入场动画：首现卡挂 enter 类与翻转包裹层；已见条目重挂载不再播；unmount 后重置', () => {
  const { wall } = loadHexWall({ adapter: null });
  mountReady(wall);
  const node0 = wall.getNode(0);
  assert.ok(node0.classList.contains('sfv-hex-card--enter'), '首次挂载应有入场类');
  let hasFlip = false;
  (function walk(n) {
    n.children.forEach((c) => {
      if (c.className && String(c.className).indexOf('sfv-hex-flip') >= 0) hasFlip = true;
      walk(c);
    });
  })(node0);
  assert.ok(hasFlip, '卡内容应包在 .sfv-hex-flip 翻转层内（rotateY 不得绕座位公转）');

  wall.centerOnIndex(239, { immediate: true });
  assert.ok(!wall.getNode(0), '远端聚焦后 index 0 应被回收');
  wall.centerOnIndex(0, { immediate: true });
  const node0Again = wall.getNode(0);
  assert.ok(node0Again, '回到 0 应重新挂载');
  assert.equal(node0Again.classList.contains('sfv-hex-card--enter'), false, '已见条目不应重播入场');

  wall.unmount();
  mountReady(wall);
  assert.ok(wall.getNode(0).classList.contains('sfv-hex-card--enter'), 'unmount 重挂后入场应重置');
});

test('入场 CSS：关键参数对齐 Folia（rotateY -90→0 / scale .98→1 / .36s cubic-bezier(.4,0,.2,1) / 1200px 透视）', () => {
  const css = read('public/video/poster-wall/poster-wall.css');
  assert.ok(/rotateY\(-90deg\)/.test(css), '应有 rotateY(-90deg) 起始帧');
  assert.ok(/scale\(0\.98\)/.test(css), '应有 scale(0.98) 起始帧');
  assert.ok(/cubic-bezier\(\s*0?\.4\s*,\s*0\s*,\s*0?\.2\s*,\s*1\s*\)/.test(css), '缓动曲线应为 Folia 标准曲线');
  assert.ok(/0?\.36s/.test(css), '时长应为 .36s');
  assert.ok(/perspective:\s*1200px/.test(css), '应有 1200px 透视（对齐 Folia）');
});

test('片库返回按钮：复用详情页 .sfv-plex-back 圆钮，点击走 SFV.online.goBack', () => {
  const { sandbox, wall } = loadHexWall({ adapter: null });
  let goBackCalls = 0;
  sandbox.StellaflixVideo.online = { goBack() { goBackCalls += 1; } };
  const host = mountReady(wall);
  const btn = host.children.find((c) => c.className === 'sfv-plex-back');
  assert.ok(btn, 'mount 应挂出 .sfv-plex-back 返回钮');
  assert.equal(btn.attributes['aria-label'], '返回');
  assert.ok(/M14\.5 6/.test(btn.innerHTML), '应复用详情页 chevron SVG');

  fire(btn, 'click');
  assert.equal(goBackCalls, 1, '点击应走 SFV.online.goBack');

  wall.unmount();
  assert.equal(host.children.some((c) => c.className === 'sfv-plex-back'), false, 'unmount 后应移除');
});

test('unmount：清空 DOM 与状态，可再次 mount', () => {
  const { wall } = loadHexWall({ adapter: null });
  const host = mountReady(wall);
  wall.unmount();
  assert.equal(wall.getState().count, 0);
  assert.equal(wall.getState().mountedCount, 0);
  assert.equal(host.children.length, 0);

  mountReady(wall, 60);
  assert.equal(wall.getState().count, 60);
});

test('拖拽过程即时钳制：move 越界后 offset 不得滑出内容边界', () => {
  const { wall } = loadHexWall({ adapter: null });
  mountReady(wall);
  wall.centerOnIndex(0, { immediate: true });
  const st = wall.getState();
  let maxY = 0;
  for (let i = 0; i < st.count; i += 1) {
    const c = wall.coordOf(i);
    if (c.baseY > maxY) maxY = c.baseY;
  }
  const field = wall.getState().dom.field;
  fire(field, 'pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 5000 });
  fire(field, 'pointermove', { pointerId: 1, clientX: 100, clientY: 0 });
  const mid = wall.getState().offset.dy;
  assert.ok(Math.abs(mid - (-maxY)) <= 2,
    'move 过程中就应钳在 top 边界 -maxY=' + (-maxY) + '，实际 ' + mid);
  fire(field, 'pointerup', { pointerId: 1 });
  // 松手后即使不再 move，offset 也必须仍在边界内（不得因 moved<6 跳过钳制留脏值）
  const after = wall.getState().offset.dy;
  assert.ok(Math.abs(after - (-maxY)) <= 2, '松手后 offset 仍须在界内，实际 ' + after);
});

test('指针捕获：拖过阈值才 setPointerCapture，纯点击不得抢占 click', () => {
  const { wall } = loadHexWall({ adapter: null });
  mountReady(wall);
  const field = wall.getState().dom.field;
  assert.equal(typeof field.setPointerCapture, 'function', '测试沙箱应提供 setPointerCapture');

  // 纯点击：不得捕获（否则 click 会被重定向到 field，卡片收不到）
  fire(field, 'pointerdown', { button: 0, pointerId: 7, clientX: 10, clientY: 10 });
  assert.equal(field._captureId, null, 'pointerdown 即刻不得 setPointerCapture');
  fire(field, 'pointerup', { pointerId: 7, clientX: 11, clientY: 11 });
  assert.equal(field._captureId, null, '纯点击不应产生捕获');

  // 真正拖拽：超过 6px 后才捕获
  fire(field, 'pointerdown', { button: 0, pointerId: 8, clientX: 10, clientY: 10 });
  fire(field, 'pointermove', { pointerId: 8, clientX: 40, clientY: 10 });
  assert.equal(field._captureId, 8, '拖过阈值后应捕获指针');
  fire(field, 'pointerup', { pointerId: 8, clientX: 40, clientY: 10 });
  assert.equal(field._captureId, null, 'cleanup 应释放指针捕获');
});

test('点击卡片：非中心卡选中居中，中心卡开详情（click 不被指针捕获吞掉）', () => {
  const { sandbox, wall } = loadHexWall({ adapter: null });
  mountReady(wall, 80);
  wall.centerOnIndex(0, { immediate: true });
  const calls = sandbox.StellaflixVideo.posterWallAdapter.calls;

  // 找一张池内且非中心的卡
  let otherIdx = -1;
  for (let i = 1; i < 80; i += 1) {
    if (wall.getNode(i)) { otherIdx = i; break; }
  }
  assert.ok(otherIdx > 0, '应有非中心卡在池内');
  fire(wall.getNode(otherIdx), 'click');
  assert.equal(wall.getState().focusIndex, otherIdx, '点击非中心卡应切到选中态');
  assert.equal(calls.openDetail.length, 0, '第一次点击只选中，不开详情');

  // 再点同一张（已是中心）→ 开详情
  const centered = wall.getNode(otherIdx);
  assert.ok(centered, '居中后该卡应仍在池内');
  fire(centered, 'click');
  assert.equal(calls.openDetail.length, 1, '点击中心卡应进详情');

  // 拖拽后的合成 click 不得开详情（先居中回池，suppressClick 仍应生效）
  const field = wall.getState().dom.field;
  fire(field, 'pointerdown', { button: 0, pointerId: 9, clientX: 0, clientY: 0 });
  fire(field, 'pointermove', { pointerId: 9, clientX: 80, clientY: 0 });
  fire(field, 'pointerup', { pointerId: 9, clientX: 80, clientY: 0 });
  wall.centerOnIndex(otherIdx, { immediate: true });
  const again = wall.getNode(otherIdx);
  assert.ok(again, '居中后该卡应回池');
  fire(again, 'click');
  assert.equal(calls.openDetail.length, 1, '拖拽松手后的 click 不得再开详情');
  wall.unmount();
});

test('lostpointercapture / 重复 down 不叠加拖拽监听（防多组 onMove 抢写 offset）', () => {
  const { wall } = loadHexWall({ adapter: null });
  mountReady(wall);
  const field = wall.getState().dom.field;
  const countMoves = () => (field.listeners.pointermove || []).length;
  const countUps = () => (field.listeners.pointerup || []).length;

  fire(field, 'pointerdown', { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
  assert.equal(countMoves(), 1);
  assert.equal(countUps(), 1);

  // 必须先拖过阈值才会 setPointerCapture；随后模拟捕获丢失
  fire(field, 'pointermove', { pointerId: 1, clientX: 30, clientY: 0 });
  assert.equal(field._captureId, 1, '拖过阈值后应已捕获');
  field.releasePointerCapture(1);
  assert.equal(countMoves(), 0, 'lostpointercapture 后不得残留 pointermove');
  assert.equal(countUps(), 0, 'lostpointercapture 后不得残留 pointerup');

  // 再次 down 仍只允许一组监听
  fire(field, 'pointerdown', { button: 0, pointerId: 2, clientX: 0, clientY: 0 });
  assert.equal(countMoves(), 1, '重复 down 不得叠多层 onMove');
  assert.equal(countUps(), 1);
  fire(field, 'pointerup', { pointerId: 2 });
  assert.equal(countMoves(), 0);
  assert.equal(countUps(), 0);
});

test('视口尺寸缓存：帧循环读 state.vp，不在 applyFrames 里反复读 clientWidth', () => {
  const src = read('public/video/poster-wall/hex-wall.js');
  assert.match(src, /function syncViewport\(/, '应有 syncViewport');
  assert.match(src, /visibilityBuffer:\s*Math\.min\(m\.spacingX,\s*m\.spacingY\)\s*\/\s*2/,
    '可见缓冲应取半个蜂窝间距，避免边缘卡 0↔1 闪断');
  // applyFrames 不得直接读 host.clientWidth/Height（强制回流源）
  const applyStart = src.indexOf('function applyFrames()');
  const applyEnd = src.indexOf('function requestFrame()');
  const applyBody = src.slice(applyStart, applyEnd);
  assert.ok(applyStart > 0 && applyEnd > applyStart);
  assert.doesNotMatch(applyBody, /clientWidth|clientHeight/,
    'applyFrames 读布局 = Forced reflow，必须走缓存视口');
});

test('0 尺寸 host 挂载后补帧：布局完成后仍能出卡，不整面消失', async () => {
  const { wall } = loadHexWall({ adapter: null });
  const host = makeEl('div');
  host.clientWidth = 0;
  host.clientHeight = 0;
  wall.mount(host, { items: makeItems(80) });
  // 挂载瞬间 host 未布局：不应把 vp 写成 0×0
  const st0 = wall.getState();
  assert.ok(st0.count > 0, 'items 应已就绪');
  // 模拟布局完成后 ResizeObserver / rAF 补帧
  host.clientWidth = 1920;
  host.clientHeight = 1080;
  // scheduleLayoutRetry 在有 rAF 时走下一帧；沙箱无 rAF 时同步补
  await new Promise((r) => setTimeout(r, 30));
  const st = wall.getState();
  assert.ok(st.mountedCount > 0, '布局完成后必须有卡在池内，实际 ' + st.mountedCount);
  let visible = 0;
  for (let i = 0; i < st.count; i += 1) {
    const n = wall.getNode(i);
    if (n && n.style.display !== 'none') visible += 1;
  }
  assert.ok(visible > 0, '必须有可见卡（display!==none），实际 ' + visible);
  wall.unmount();
});

test('HexGrid 未就绪：applyFrames 不静默丢帧，会 scheduleLayoutRetry', () => {
  const { sandbox, wall } = loadHexWall({ adapter: null });
  // 先正常挂载
  const host = mountReady(wall, 40);
  assert.ok(wall.getState().mountedCount > 0);
  // 卸掉几何模块后触发一次补帧
  const savedGrid = sandbox.StellaflixHexGrid;
  delete sandbox.StellaflixHexGrid;
  const { wall: w2 } = loadHexWall({ adapter: null });
  // 在 w2 的沙箱里删掉 HexGrid 再 mount
  assert.ok(w2);
  // 恢复
  sandbox.StellaflixHexGrid = savedGrid;
  wall.unmount();
  // 源码级断言：缺模块时不得直接 return，应排重试
  const src = read('public/video/poster-wall/hex-wall.js');
  const applyBody = src.slice(src.indexOf('function applyFrames()'), src.indexOf('function requestFrame()'));
  assert.match(applyBody, /!HexGrid\s*\|\|\s*!HexCard/, '应检测几何模块是否就绪');
  assert.match(applyBody, /scheduleLayoutRetry\(\)/, '缺模块时应 scheduleLayoutRetry 而非静默 return');
});

test('syncViewport：0 尺寸不写坏缓存，保留上次有效视口', () => {
  const { wall } = loadHexWall({ adapter: null });
  const host = makeEl('div');
  host.clientWidth = 1600;
  host.clientHeight = 900;
  wall.mount(host, { items: makeItems(20) });
  // 再挂一次：host 仍是 1600×900
  const st = wall.getState();
  assert.ok(st.metrics);
  assert.equal(st.metrics.cardW, 250, '1600 宽应命中 <2000 档 cardW=250');
  // 源码级：client* 为 0 时不得覆盖成 0
  const src = read('public/video/poster-wall/hex-wall.js');
  assert.match(src, /if \(w > 0 && h > 0\)/, '0 尺寸不得写入 vp');
  assert.match(src, /scheduleLayoutRetry/, '应有布局补帧');
  assert.match(src, /ResizeObserver/, '应监听 host 自身尺寸变化');
  wall.unmount();
});
