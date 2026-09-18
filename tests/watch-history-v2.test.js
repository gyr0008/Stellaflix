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

test('迁移：model 粗粒度两段 vodKey 不被剥集号，episodeIndex 为 null', () => {
  const init = {
    'stellaflix-video-history': JSON.stringify([
      { key: 's1:1048', title: '旧A', pic: '', ts: Date.now(), sourceId: 's1', vodId: 1048 },
      { key: 's1:9', title: '旧B', pic: '', ts: Date.now() - 100, sourceId: 's1', vodId: 9 },
    ]),
  };
  const { store } = loadHistory(init);
  const all = store.getAll();
  assert.strictEqual(all.length, 2);                      // 不塌缩成一条
  assert.ok(find(all, 's1:1048'));
  assert.strictEqual(find(all, 's1:1048').episodeIndex, null);
  assert.strictEqual(find(all, 's1:9').episodeIndex, null);
});

test('normalize：三段集级 key 正常解析集号，两段 vodKey 得 null', () => {
  const { store, localStorage } = loadHistory();
  localStorage.setItem('stellaflix-watch-history-v2', JSON.stringify([
    { key: 'cms:s1:100:5', seriesKey: 'cms:s1:100', title: 'X', ts: Date.now() },
    { key: 's2:77', seriesKey: 's2:77', title: 'Y', ts: Date.now() },
  ]));
  const all = store.getAll();
  assert.strictEqual(find(all, 'cms:s1:100').episodeIndex, 5);
  assert.strictEqual(find(all, 's2:77').episodeIndex, null);
});

test('update：集级 key 命中片级记录；旧集回写被忽略（stale）', () => {
  const { store } = loadHistory();
  store.add({ key: 'cms:s1:100:0', title: '片A', ts: Date.now() });
  store.add({ key: 'cms:s1:100:1', title: '片A', ts: Date.now() }); // 换到第2集
  const stale = store.update('cms:s1:100:0', { progress: 0.9, cur: '18:00' });
  const rec = find(store.getAll(), 'cms:s1:100');
  assert.strictEqual(rec.progress, 0);            // 未被旧集回写污染
  assert.ok(stale);                               // 返回记录本身而非 null
  store.update('cms:s1:100:1', { progress: 0.3, cur: '06:00', total: '20:00', finished: false });
  assert.strictEqual(find(store.getAll(), 'cms:s1:100').progress, 0.3);
});

test('update：无对应记录返回 null（embed/url 不入历史的现状不变）', () => {
  const { store } = loadHistory();
  assert.strictEqual(store.update('url:whatever:0', { progress: 0.5 }), null);
});

test('daySec：同集多会话/跨集累加，跨天清零，回写抖动不虚增', () => {
  const { store } = loadHistory();
  // 会话1：ep0 看了 100s
  store.add({ key: 'cms:s1:100:0', title: '片A', ts: Date.now() });
  store.update('cms:s1:100:0', { watchedSec: 40, progress: 0.2 });
  store.update('cms:s1:100:0', { watchedSec: 100, progress: 0.5 });
  let rec = find(store.getAll(), 'cms:s1:100');
  assert.strictEqual(rec.daySec, 100);
  // 会话2：重开 ep0（add 清基线），又看 30s → 今日累计 130
  store.add({ key: 'cms:s1:100:0', title: '片A', ts: Date.now() });
  store.update('cms:s1:100:0', { watchedSec: 30, progress: 0.6 });
  rec = find(store.getAll(), 'cms:s1:100');
  assert.strictEqual(rec.daySec, 130);
  // 换 ep1：累计保留 130，基线清零
  store.add({ key: 'cms:s1:100:1', title: '片A', ts: Date.now() });
  store.update('cms:s1:100:1', { watchedSec: 20, progress: 0.1 });
  rec = find(store.getAll(), 'cms:s1:100');
  assert.strictEqual(rec.daySec, 150);
  // 乱序回写（10 < 20）不重复计数也不倒退
  store.update('cms:s1:100:1', { watchedSec: 10 });
  assert.strictEqual(find(store.getAll(), 'cms:s1:100').daySec, 150);
});

test('daySec：watchedDay 不是今天时先清零再记账', () => {
  const { store, localStorage } = loadHistory();
  store.add({ key: 'cms:s1:100:0', title: '片A', ts: Date.now() });
  store.update('cms:s1:100:0', { watchedSec: 100 });
  const saved = JSON.parse(localStorage.getItem(V2));
  saved[0].watchedDay = '2000-01-01';
  localStorage.setItem(V2, JSON.stringify(saved));
  store.update('cms:s1:100:0', { watchedSec: 10 }); // 新的一天，会话已计 10s
  const rec = find(store.getAll(), 'cms:s1:100');
  assert.strictEqual(rec.daySec, 10);
});

test('update：coarse 两段 key 记录（model 迁移产物）可被 smartResumePlay 回写', () => {
  const { store, localStorage } = loadHistory();
  // 手工塞入一条 model 迁移形态的 coarse 记录：rec.key === rec.seriesKey === 's1:1048'
  localStorage.setItem(V2, JSON.stringify([
    { key: 's1:1048', seriesKey: 's1:1048', title: '旧A', ts: Date.now() },
  ]));
  // 先折片级会得 's1' 命中不了 → 必须靠精确 key 匹配（fix 前返回 null）
  const rec = store.update('s1:1048', { lastSourceId: 's9', lastVodId: 5, ts: Date.now() });
  assert.ok(rec, 'coarse 记录应被命中而非 null');
  const saved = find(store.getAll(), 's1:1048');
  assert.strictEqual(saved.lastSourceId, 's9');
  assert.strictEqual(saved.lastVodId, 5);
  // 无冒号且无对应记录 → 仍返回 null
  assert.strictEqual(store.update('nocolon-x', { lastSourceId: 'zz' }), null);
});

test('getTodayInsight：daySec 汇总今日观看秒', () => {
  const { store } = loadHistory();
  store.add({ key: 'cms:s1:100:0', title: '片A', ts: Date.now() });
  store.update('cms:s1:100:0', { watchedSec: 120 });
  store.add({ key: 'cms:s2:200:0', title: '片B', ts: Date.now() });
  store.update('cms:s2:200:0', { watchedSec: 30 });
  const ins = store.getTodayInsight();
  assert.strictEqual(ins.watchMs, 150 * 1000);
  assert.strictEqual(ins.watchCount, 2);
});

test('remove：删整片记录并联动 clearProgressByPrefix(前缀)', () => {
  const { store, window } = loadHistory();
  const calls = [];
  window.StellaflixVideo.model = { clearProgressByPrefix: (p) => { calls.push(p); return 2; } };
  store.add({ key: 'cms:s1:100:0', title: '片A', ts: Date.now() });
  store.add({ key: 'cms:s1:100:1', title: '片A', ts: Date.now() });
  store.add({ key: 'cms:s2:200:0', title: '片B', ts: Date.now() });
  const rest = store.remove('cms:s1:100:1', 123); // ts 兼容位：忽略
  assert.strictEqual(rest.length, 1);
  assert.strictEqual(rest[0].seriesKey, 'cms:s2:200');
  assert.deepStrictEqual(calls, ['cms:s1:100:']);
});

test('remove：SFV.model 未就绪时不抛错，仍删记录', () => {
  const { store } = loadHistory();
  store.add({ key: 'cms:s1:100:0', title: '片A', ts: Date.now() });
  const rest = store.remove('cms:s1:100:0');
  assert.strictEqual(rest.length, 0);
});
