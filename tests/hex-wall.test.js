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
  };
  el.classList = makeClassList(el);
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

test('蜂窝咬合：spacingY 小于卡高（对齐 Folia ≈0.96×H）', () => {
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
  assert.ok(Math.abs(spacingY - Math.round(h * 0.96)) <= 1,
    'spacingY 应≈0.96×卡高实现行咬合，实际 ' + spacingY + ' vs 卡高 ' + h);
});

test('maxDistance 收紧：远处卡定在最小 scale（Folia ≈2.32×卡宽比例）', () => {
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
    if (node && dist > 350) { found = { dist, transform: node.style.transform }; break; }
  }
  assert.ok(found, '应有距离>350px 的挂载卡（1280 视口卡宽 132，maxDistance≈306）');
  const m = /scale\(([\d.]+)\)/.exec(found.transform);
  assert.ok(m, 'transform 应含 scale');
  assert.ok(Math.abs(parseFloat(m[1]) - 0.45) < 0.02,
    '远处卡应已定底 0.45（半对角旧算法此处约 0.79），实际 ' + m[1]);
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
