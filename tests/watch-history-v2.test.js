'use strict';
// watch-history v2 聚合存储测试。运行：node --test tests/watch-history-v2.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const whPath = path.join(__dirname, '..', 'public', 'video', 'watch-history.js');
const V2 = 'stellaflix-watch-history-v2';
const V1 = 'stellaflix-watch-history-v1';

function makeLocalStorage(initial) {
  const data = Object.assign({}, initial || {});
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
    _dump: () => JSON.parse(JSON.stringify(data)),
  };
}

function makeNode(tag) {
  const node = {
    tagName: tag, className: '', textContent: '', children: [], style: {},
    attrs: {}, scrollWidth: 0, clientWidth: 0, scrollLeft: 0, offsetWidth: 0,
    setAttribute(k, v) { this.attrs[k] = String(v); },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {},
    querySelectorAll() { return []; },
    querySelector() { return null; },
    classList: { toggle() {}, add() {}, remove() {} },
    set innerHTML(_v) { this.children = []; },
    get innerHTML() { return ''; },
  };
  Object.defineProperty(node, 'innerHTML', { get() { return ''; }, set() { node.children = []; } });
  return node;
}

function makeFakeDocument() {
  return { createElement: (t) => makeNode(t) };
}

function loadHistory(initial) {
  const source = fs.readFileSync(whPath, 'utf8');
  const localStorage = makeLocalStorage(initial);
  const window = {
    localStorage, document: makeFakeDocument(), console,
    addEventListener() {}, removeEventListener() {},
    getComputedStyle: () => ({ gap: '18px' }),
    confirm: () => true,
  };
  window.window = window;
  vm.runInNewContext(source, { window, localStorage, console }, { filename: whPath });
  return { store: window.StellaflixVideo.watchHistory, localStorage, window };
}

function find(list, seriesKey) {
  for (const r of list) if (r.seriesKey === seriesKey) return r;
  return null;
}

test('add：同片换集只留一条记录且进度字段重置', () => {
  const { store, localStorage } = loadHistory();
  store.add({ key: 'cms:s1:100:0', title: '片A', sub: '第1话', ts: Date.now() });
  store.update('cms:s1:100:0', { progress: 0.5, cur: '10:00', total: '20:00', watchedSec: 100 });
  store.add({ key: 'cms:s1:100:1', title: '片A', sub: '第2话', ts: Date.now() });
  const saved = JSON.parse(localStorage.getItem(V2));
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].key, 'cms:s1:100:1');
  assert.strictEqual(saved[0].episodeIndex, 1);
  assert.strictEqual(saved[0].progress, 0);
  assert.strictEqual(saved[0].cur, '00:00');
  assert.strictEqual(saved[0].finished, false);
  assert.strictEqual(find(store.getAll(), 'cms:s1:100').episodeName, '第2话');
});

test('add：同片同集重开保留进度，仅刷新元信息与 ts', () => {
  const { store } = loadHistory();
  store.add({ key: 'cms:s1:100:2', title: '片A', sub: '第3话', ts: Date.now() - 1000 });
  store.update('cms:s1:100:2', { progress: 0.4, cur: '08:00', total: '20:00', watchedSec: 80 });
  const before = find(store.getAll(), 'cms:s1:100');
  store.add({ key: 'cms:s1:100:2', title: '片A', sub: '第3话', ts: Date.now() });
  const after = find(store.getAll(), 'cms:s1:100');
  assert.strictEqual(after.progress, 0.4);
  assert.strictEqual(after.cur, '08:00');
  assert.ok(after.ts >= before.ts);
});

test('add：非法 key（无冒号）不产生脏记录', () => {
  const { store, localStorage } = loadHistory();
  store.add({ key: 'nocolon', title: 'x', ts: Date.now() });
  assert.strictEqual(JSON.parse(localStorage.getItem(V2) || '[]').length, 0);
});

test('迁移：v1 跨天流水按 seriesKey 合并取最大 ts，v1 键保留', () => {
  const now = Date.now();
  const v1recs = [
    { key: 'cms:s1:100:0', title: '片A', ts: now - 1000, watchedSec: 50, progress: 0.1, cur: '01:00', total: '20:00', finished: false, sourceId: 's1', vodId: 100 },
    { key: 'cms:s1:100:0', title: '片A', ts: now - 86400000, watchedSec: 30, progress: 0.05, sourceId: 's1', vodId: 100 },
    { key: 'kazumi:abc:77:3', title: '片B', ts: now - 200, watchedSec: 10, sourceId: 'abc', vodId: 77 },
  ];
  const { store, localStorage } = loadHistory({ [V1]: JSON.stringify(v1recs) });
  const all = store.getAll();
  assert.strictEqual(all.length, 2);
  assert.strictEqual(all[0].key, 'kazumi:abc:77:3');           // ts 降序
  assert.strictEqual(find(all, 'cms:s1:100').ts, now - 1000);   // 组内取最大 ts
  assert.strictEqual(find(all, 'cms:s1:100').episodeIndex, 0);  // 从 key 尾段解析
  assert.strictEqual(localStorage.getItem(V1), JSON.stringify(v1recs)); // 旧键原样保留
});

test('迁移：v1 为空时从 model 粗粒度键聚合，sourceId 含冒号拆分正确', () => {
  const init = {
    'stellaflix-video-history': JSON.stringify([
      { key: 'kazumi:abc:77:1', title: '旧B', pic: 'p.jpg', ts: Date.now(), sourceId: 'kazumi:abc', vodId: 77 },
    ]),
  };
  const { store } = loadHistory(init);
  const all = store.getAll();
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].seriesKey, 'kazumi:abc:77');
  assert.strictEqual(all[0].episodeIndex, 1);
});
