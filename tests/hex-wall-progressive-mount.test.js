'use strict';

/**
 * 海报墙渐进挂载（C 方案）测试：
 * ① wall-adapter.collectWallItemsAsync({ onBatch })：10 个品类乱序返回时，
 *    按 CATEGORY_JOBS 定义顺序 flush 前缀快照——前导品类未回前不发批，
 *    每批 items 是上一批的前缀扩展（id 顺序稳定，蜂窝墙索引不漂移）。
 * ② hex-wall.mount：首批到达即脱离 loading 挂载；后续批次只增数据，
 *    保留焦点与平移偏移；最终 resolve 不重置视图。
 * 运行：node --test tests/hex-wall-progressive-mount.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const drain = () => new Promise((r) => setImmediate(r));

// ---------- 沙箱（vm 内跑真实源文件，不 mock 被测逻辑） ----------

function makeSandbox(useDom) {
  const sandbox = {
    console, Math, Number, Array, Object, String, Boolean, Promise, Set, Map, JSON, Date,
    setTimeout, clearTimeout,
  };
  sandbox.window = sandbox;
  const store = {};
  sandbox.localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  sandbox.document = useDom
    ? { createElement: (tag) => makeEl(tag), getElementById: () => null, body: makeEl('body') }
    : { createElement: () => ({}), getElementById: () => null, body: {} };
  vm.createContext(sandbox);
  return sandbox;
}

// ---------- ① wall-adapter 顺序 flush ----------

const CATEGORY_ORDER = [
  '本周热门电影', '本周趋势电影', '本周热播剧集', '即将上映',
  '动作', '科幻', '动画', '喜剧', '悬疑惊悚', '高分剧情',
];
const JOB_COUNT = CATEGORY_ORDER.length;

function rawFor(jobIdx) {
  const out = [];
  for (let i = 0; i < 3; i += 1) {
    out.push({ id: jobIdx * 10 + i, title: 'T' + jobIdx + '-' + i, poster: 'pp' + jobIdx + '_' + i });
  }
  return out;
}

function expectedIds(jobIdx) {
  const label = CATEGORY_ORDER[jobIdx];
  const mt = label.indexOf('剧') >= 0 ? 'tv' : 'movie';
  return rawFor(jobIdx).map((r) => 'tmdb:' + mt + ':' + r.id);
}

function deferred() {
  let resolve; let reject;
  const p = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { p, resolve, reject };
}

function loadAdapterWithQueue() {
  const sandbox = makeSandbox();
  const queue = [];
  const next = () => { const d = deferred(); queue.push(d); return d.p; };
  sandbox.StellaflixVideo = {
    tmdb: {
      hasKey: () => true,
      popular: next,
      trending: next,
      upcoming: next,
      discover: next,
    },
  };
  vm.runInContext(read('public/video/poster-wall/wall-adapter.js'), sandbox, { filename: 'wall-adapter.js' });
  return { A: sandbox.StellaflixVideo.posterWallAdapter, queue };
}

test('adapter：前导品类未回时不发批；补齐后一次发出全量合并快照', async () => {
  const { A, queue } = loadAdapterWithQueue();
  const batches = [];
  const done = A.collectWallItemsAsync({ onBatch: (items) => batches.push(items.map((i) => i.id)) });
  await drain();
  assert.equal(queue.length, JOB_COUNT, '应有 10 个品类任务');

  // 乱序积压：9..1 全部完成，唯一缺前导 job0
  for (let i = JOB_COUNT - 1; i >= 1; i -= 1) queue[i].resolve(rawFor(i));
  await drain();
  assert.equal(batches.length, 0, '前导品类未回前不应发批');

  queue[0].resolve(rawFor(0));
  const res = await done;
  assert.equal(batches.length, 1, '积压场景只发一份合并快照');
  assert.equal(res.items.length, JOB_COUNT * 3);
  assert.deepEqual(batches[0], res.items.map((i) => i.id), '合并快照与最终结果一致');
});

test('adapter：逐批到达时按定义顺序发前缀扩展快照（索引稳定）', async () => {
  const { A, queue } = loadAdapterWithQueue();
  const batches = [];
  const done = A.collectWallItemsAsync({ onBatch: (items) => batches.push(items.map((i) => i.id)) });
  await drain();

  queue[0].resolve(rawFor(0));
  await drain();
  assert.equal(batches.length, 1, 'job0 回后发第 1 批');
  assert.deepEqual(batches[0], expectedIds(0));

  queue[2].resolve(rawFor(2));
  await drain();
  assert.equal(batches.length, 1, '缺口(job1)未补时不得跳头发批');
  queue[1].resolve(rawFor(1));
  await drain();
  assert.equal(batches.length, 2, '缺口补齐后一次发出合并快照');
  assert.deepEqual(batches[1].slice(0, 3), batches[0], '前缀必须原样保留（索引稳定）');
  assert.deepEqual(batches[1].slice(3, 6), expectedIds(1));
  assert.deepEqual(batches[1].slice(6, 9), expectedIds(2));
  assert.equal(batches[1].length, 9);

  for (let i = JOB_COUNT - 1; i >= 3; i -= 1) queue[i].resolve(rawFor(i));
  const res = await done;
  assert.equal(batches.length, 3, 'job3 补上前导缺口后剩余一次合并为第 3 批');
  assert.equal(res.items.length, JOB_COUNT * 3);
  assert.deepEqual(batches[2], res.items.map((i) => i.id), '末批与最终结果一致');
});

test('adapter：不传 options 行为不变（老调用方兼容）', async () => {
  const { A, queue } = loadAdapterWithQueue();
  const done = A.collectWallItemsAsync();
  await drain();
  for (let i = 0; i < JOB_COUNT; i += 1) queue[i].resolve(rawFor(i));
  const res = await done;
  assert.equal(res.items.length, JOB_COUNT * 3);
  assert.equal(res.keyMissing, false);
});

// ---------- ② hex-wall 挂载/保焦点增量 ----------

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
    children: [], parent: null,
    style: { setProperty(name, value) { this[name] = value; } },
    attributes: {}, listeners: {}, textContent: '', _innerHTML: '',
    clientWidth: 1280, clientHeight: 720, tabIndex: -1,
  };
  el.classList = makeClassList(el);
  el.appendChild = function (child) { child.parent = this; this.children.push(child); return child; };
  el.removeChild = function (child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parent = null; return child;
  };
  el.setAttribute = function (name, value) { this.attributes[name] = String(value); };
  el.getAttribute = function (name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  };
  el.addEventListener = function (type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); };
  el.removeEventListener = function (type, fn) {
    const list = this.listeners[type] || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
  el.querySelectorAll = function (selector) {
    const wantTag = selector.toUpperCase();
    const out = [];
    (function walk(node) {
      node.children.forEach((child) => { if (child.tagName === wantTag) out.push(child); walk(child); });
    })(el);
    return out;
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._innerHTML; },
    set(value) { this._innerHTML = value; this.children.forEach((c) => { c.parent = null; }); this.children = []; },
  });
  return el;
}

function wallItems(count) {
  const items = [];
  for (let i = 0; i < count; i += 1) {
    items.push({
      id: 'tmdb:movie:' + i, title: '片名 ' + i, year: '2024', rating: 7,
      poster: 'https://example.com/p' + i + '.jpg', section: 'catalog',
      sectionLabel: '本周热门电影', category: '本周热门电影', source: 'tmdb',
      progress: 0, key: '', mediaType: 'movie', meta: { id: i, mediaType: 'movie', title: '片名 ' + i },
    });
  }
  return items;
}

function loadHexWall(adapter) {
  const sandbox = makeSandbox(true);
  vm.runInContext(read('public/js/modules/02-visual/16-hex-grid-viewport.js'), sandbox, { filename: 'hex-grid-viewport.js' });
  vm.runInContext(read('public/js/modules/02-visual/17-hex-card-transform.js'), sandbox, { filename: 'hex-card-transform.js' });
  sandbox.StellaflixVideo = { posterWallAdapter: adapter };
  vm.runInContext(read('public/video/poster-wall/hex-wall.js'), sandbox, { filename: 'hex-wall.js' });
  return sandbox.StellaflixVideo.posterWall;
}

function makeProgressiveAdapter() {
  let emit = null;
  let resolveFinal;
  const p = new Promise((r) => { resolveFinal = r; });
  return {
    collectWallItemsAsync(options) {
      emit = (options && typeof options.onBatch === 'function') ? options.onBatch : null;
      return p;
    },
    emitBatch(items) {
      assert.ok(emit, 'mount 应把 onBatch 传进 collectWallItemsAsync');
      emit(items);
    },
    finish(items) { resolveFinal({ items, keyMissing: false, errors: [] }); },
    formatMetaLine() { return ''; },
    openDetail() { return true; },
    playOrResume() { return true; },
    openTmdbKeySettings() { return true; },
  };
}

test('wall：首批即挂载脱离 loading；后续批次增数据但保留焦点与偏移', async () => {
  const adapter = makeProgressiveAdapter();
  const wall = loadHexWall(adapter);
  const host = makeEl('div');
  const mounted = wall.mount(host);

  assert.equal(host.getAttribute('data-sfv-library-wall'), 'loading');
  adapter.emitBatch(wallItems(20));
  assert.equal(host.getAttribute('data-sfv-library-wall'), 'ready', '首批到达应立刻 ready');
  assert.equal(wall.getState().count, 20);

  wall.centerOnIndex(10, { immediate: true });
  const before = wall.getState();
  assert.notEqual(before.offset.dx, 0, '居中后应有世界偏移');

  adapter.emitBatch(wallItems(40));
  const mid = wall.getState();
  assert.equal(mid.count, 40, '后续批次应增量并入');
  assert.equal(mid.focusIndex, 10, '焦点不得被批次刷新重置');
  assert.equal(mid.offset.dx, before.offset.dx, '平移偏移不得被批次刷新重置');
  assert.equal(mid.offset.dy, before.offset.dy);

  adapter.finish(wallItems(40));
  assert.equal(await mounted, true);
  const fin = wall.getState();
  assert.equal(fin.count, 40);
  assert.equal(fin.focusIndex, 10, '最终 resolve 也不得重置视图');
  assert.equal(fin.offset.dx, before.offset.dx);
});
