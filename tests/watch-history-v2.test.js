'use strict';
// watch-history v2 聚合存储测试。运行：node --test tests/watch-history-v2.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const whPath = path.join(__dirname, '..', 'public', 'video', 'watch-history.js');
const modelPath = path.join(__dirname, '..', 'public', 'video', 'model.js');
const V2 = 'stellaflix-watch-history-v2';
const V1 = 'stellaflix-watch-history-v1';
const MODEL_KEY = 'stellaflix-video-history';
const KP = 'stellaflix-video-progress';   // model.js 的集级进度键，remove 连带清理的对象

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

// 把真实 model.js 装进同一个 window + 同一个 localStorage 假件：
// remove 的连带清进度走真实持久化，断言落在真实落盘状态上而非纯桩件。
function attachRealModel(env) {
  const source = fs.readFileSync(modelPath, 'utf8');
  vm.runInNewContext(source, { window: env.window, localStorage: env.localStorage, console }, { filename: modelPath });
  return env.window.StellaflixVideo.model;
}

// 真实 model 包一层调用捕获，既能断言 clearProgressByPrefix 的前缀，也能断言剩余进度。
function spyModel(env) {
  const real = attachRealModel(env);
  const calls = [];
  const model = {
    clearProgressByPrefix: (p) => { calls.push(p); return real.clearProgressByPrefix(p); },
    setProgress: (id, pos, dur) => real.setProgress(id, pos, dur),
    getProgress: (id) => real.getProgress(id),
  };
  env.window.StellaflixVideo.model = model;
  return { calls, model };
}

function progressKeys(env) {
  return Object.keys(JSON.parse(env.localStorage.getItem(KP) || '{}')).sort();
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

test('迁移回退：model 分支缺 sourceId/vodId 字段时不得把 seriesKey 塌成裸 sourceId', () => {
  // 复现评审用例：legacy stellaflix-video-history 记录只有 key，无可用显式字段。
  // 旧实现 seriesKeyOf('s1:1048') → 's1'，卡片显示「第 1049 话」且 remove 会清掉 s1 下所有片。
  const env = loadHistory({
    [MODEL_KEY]: JSON.stringify([{ key: 's1:1048', title: '旧A', pic: '', ts: Date.now() }]),
  });
  const all = env.store.getAll();
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].seriesKey, 's1:1048');   // 粗粒度保留，不是 's1'
  assert.strictEqual(all[0].key, 's1:1048');
  assert.strictEqual(all[0].episodeIndex, null);     // 1048 是 vodId，不是集号
  assert.strictEqual(find(all, 's1'), null);
});

test('迁移回退：含冒号 sourceId 的缺字段记录 seriesKey 保持完整键', () => {
  // 'kazumi:abc:77' 若走 seriesKeyOf 会得 'kazumi:abc'（冒号计数守卫挡不住这种形态）
  const env = loadHistory({
    [MODEL_KEY]: JSON.stringify([{ key: 'kazumi:abc:77', title: '旧B', pic: '', ts: Date.now() }]),
  });
  const all = env.store.getAll();
  assert.strictEqual(all[0].seriesKey, 'kazumi:abc:77');
  assert.strictEqual(all[0].episodeIndex, null);
});

test('迁移：KEY_V1 分支的三段集级键仍折成片级键 + 集号（不得被粗粒度保留回归掉）', () => {
  const env = loadHistory({
    [V1]: JSON.stringify([{ key: 's1:1048:3', title: '旧A', ts: Date.now(), watchedSec: 10 }]),
  });
  const all = env.store.getAll();
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].seriesKey, 's1:1048');
  assert.strictEqual(all[0].key, 's1:1048:3');
  assert.strictEqual(all[0].episodeIndex, 3);
});

test('remove：粗粒度迁移记录只清本部前缀，同 sourceId 的其他片进度不受影响', () => {
  const env = loadHistory({
    [MODEL_KEY]: JSON.stringify([{ key: 's1:1048', title: '旧A', pic: '', ts: Date.now() }]),
  });
  const { calls, model } = spyModel(env);
  model.setProgress('s1:1048:0', 10, 100);
  model.setProgress('s1:9999:0', 20, 100);   // 同 source 's1' 的另一部片
  model.setProgress('s1:77:0', 30, 100);     // 同上
  const rest = env.store.remove('s1:1048');
  assert.strictEqual(rest.length, 0);
  assert.deepStrictEqual(calls, ['s1:1048:']);
  assert.deepStrictEqual(progressKeys(env), ['s1:77:0', 's1:9999:0']);
});

test('remove：seriesKey 结构上不是完整片级键（历史脏塌缩数据）时删记录但跳过清进度', () => {
  // 修复前的迁移已落盘的用户仍可能带 seriesKey === 裸 sourceId 的记录。
  const env = loadHistory();
  const { calls, model } = spyModel(env);
  env.localStorage.setItem(V2, JSON.stringify([
    { key: 's1:1048:0', seriesKey: 's1', title: '脏塌缩', ts: Date.now() },
    { key: 's1:9999:0', seriesKey: 's9', sourceId: 's9', vodId: 9999, title: '别的片', ts: Date.now() },
  ]));
  model.setProgress('s1:1048:0', 10, 100);
  model.setProgress('s9:9999:0', 20, 100);
  const rest = env.store.remove('s1:1048:0');
  assert.strictEqual(rest.length, 1);                        // 记录照删
  assert.strictEqual(rest[0].seriesKey, 's9');
  assert.deepStrictEqual(calls, []);                          // 守卫不过 → 不动任何进度
  assert.deepStrictEqual(progressKeys(env), ['s1:1048:0', 's9:9999:0']);
});

test('remove：一次删除命中多条不同 seriesKey 时逐片清进度（顺序无关、不重复）', () => {
  const env = loadHistory();
  const { calls, model } = spyModel(env);
  // 孪生状态：同一入参 key 经精确 key 分支与 seriesKey 分支各命中一条，seriesKey 不同
  env.localStorage.setItem(V2, JSON.stringify([
    { key: 'a:1:0', seriesKey: 'a:1', sourceId: 'a', vodId: 1, title: 'A', ts: Date.now() },
    { key: 'a:1:0', seriesKey: 'a:1:0', title: 'B（粗粒度孪生）', ts: Date.now() },
    { key: 'z:9:0', seriesKey: 'z:9', sourceId: 'z', vodId: 9, title: 'C', ts: Date.now() },
  ]));
  model.setProgress('a:1:0', 1, 100);
  model.setProgress('a:1:0:5', 2, 100);
  model.setProgress('z:9:0', 3, 100);
  const rest = env.store.remove('a:1:0');
  assert.strictEqual(rest.length, 1);
  assert.strictEqual(rest[0].seriesKey, 'z:9');
  assert.deepStrictEqual(calls.slice().sort(), ['a:1:', 'a:1:0:']);   // 两个不同前缀各一次
  assert.deepStrictEqual(progressKeys(env), ['z:9:0']);
});

test('CAP：迁移溢出 600 部时按 ts 降序截断到 500 部落盘', () => {
  const base = Date.now();
  const v1recs = [];
  for (let i = 0; i < 600; i++) {
    v1recs.push({ key: 'cms:v' + i + ':0', title: '片' + i, ts: base + i * 1000 });
  }
  const env = loadHistory({ [V1]: JSON.stringify(v1recs) });
  const all = env.store.getAll();                    // 触发一次性聚合迁移
  const saved = JSON.parse(env.localStorage.getItem(V2));
  assert.strictEqual(saved.length, 500);
  assert.strictEqual(saved[0].seriesKey, 'cms:v599');        // ts 最大者在头
  assert.strictEqual(saved[499].seriesKey, 'cms:v100');
  assert.strictEqual(find(all, 'cms:v99'), null);            // 最旧 100 部被挤掉
});

test('CAP：add 溢出 500 部时从尾部挤掉 ts 最旧的一部', () => {
  const base = Date.now();
  const seeded = [];
  for (let i = 0; i < 500; i++) {
    seeded.push({ key: 'cms:v' + i + ':0', seriesKey: 'cms:v' + i, title: '片' + i, ts: base - i * 1000 });
  }
  const env = loadHistory();
  env.localStorage.setItem(V2, JSON.stringify(seeded));
  const rest = env.store.add({ key: 'cms:new:0', title: '新片', ts: Date.now() });
  assert.strictEqual(JSON.parse(env.localStorage.getItem(V2)).length, 500);   // 真实落盘也只 500
  assert.strictEqual(rest.length, 500);
  assert.strictEqual(rest[0].seriesKey, 'cms:new');
  assert.strictEqual(find(rest, 'cms:v499'), null);        // 最旧（尾条）被挤掉
  assert.ok(find(rest, 'cms:v498'));                       // 次旧仍在
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
  // sourceId/vodId 与 play-orchestrator.js:92-106 的真实入参一致：remove 的连带清进度守卫
  // 要求记录结构上能证明只覆盖一部番（seriesKey === sourceId + ':' + vodId）。
  store.add({ key: 'cms:s1:100:0', title: '片A', ts: Date.now(), sourceId: 'cms:s1', vodId: 100 });
  store.add({ key: 'cms:s1:100:1', title: '片A', ts: Date.now(), sourceId: 'cms:s1', vodId: 100 });
  store.add({ key: 'cms:s2:200:0', title: '片B', ts: Date.now(), sourceId: 'cms:s2', vodId: 200 });
  const rest = store.remove('cms:s1:100:1', 123); // ts 兼容位：忽略
  assert.strictEqual(rest.length, 1);
  assert.strictEqual(rest[0].seriesKey, 'cms:s2:200');
  assert.deepStrictEqual(calls, ['cms:s1:100:']); // 同片两条命中也只清一次
});

test('remove：SFV.model 未就绪时不抛错，仍删记录', () => {
  const { store } = loadHistory();
  store.add({ key: 'cms:s1:100:0', title: '片A', ts: Date.now() });
  const rest = store.remove('cms:s1:100:0');
  assert.strictEqual(rest.length, 0);
});

test('remove：传裸 seriesKey（非集级 key）也能删整片并落盘', () => {
  const { store, window, localStorage } = loadHistory();
  const calls = [];
  window.StellaflixVideo.model = { clearProgressByPrefix: (p) => { calls.push(p); return 2; } };
  store.add({ key: 'cms:s1:100:0', title: '片A', ts: Date.now(), sourceId: 'cms:s1', vodId: 100 });
  store.add({ key: 'cms:s1:100:1', title: '片A', ts: Date.now(), sourceId: 'cms:s1', vodId: 100 });
  store.add({ key: 'cms:s2:200:0', title: '片B', ts: Date.now(), sourceId: 'cms:s2', vodId: 200 });
  const rest = store.remove('cms:s1:100'); // 记录 key 是 'cms:s1:100:1'，只能按 seriesKey 字段命中
  assert.strictEqual(rest.length, 1);
  assert.strictEqual(rest[0].seriesKey, 'cms:s2:200');
  assert.deepStrictEqual(calls, ['cms:s1:100:']);
  assert.strictEqual(JSON.parse(localStorage.getItem(V2)).length, 1); // 持久化真的被清掉
});

// 卡片状态行渲染：走假 DOM 树找 .sfv-wh-card__status-text 节点的文案
function collectStatusTexts(host) {
  const texts = [];
  (function walk(n) {
    if (n.className === 'sfv-wh-card__status-text') texts.push(n.textContent);
    (n.children || []).forEach(walk);
  })(host);
  return texts;
}

test('卡片状态行：有 episodeIndex 时显示「第 N 话 · 看到 …」', () => {
  const { store } = loadHistory();
  store.add({ key: 'cms:s1:100:3', title: '片A', sub: '第4话', ts: Date.now() });
  store.update('cms:s1:100:3', { progress: 0.3, cur: '06:00', total: '20:00' });
  const host = makeNode('div');
  store.render(host, store.getAll());
  const texts = collectStatusTexts(host);
  assert.ok(texts.some((t) => t.indexOf('第 4 话 · 看到 06:00') === 0), JSON.stringify(texts));
});

test('卡片状态行：无集号（异常旧数据）退回「看到 …」', () => {
  const { store, localStorage } = loadHistory();
  localStorage.setItem(V2, JSON.stringify([{ key: 'weird', seriesKey: '', title: '无集', ts: Date.now(), cur: '01:00', total: '02:00' }]));
  const host = makeNode('div');
  store.render(host, store.getAll());
  const texts = collectStatusTexts(host);
  assert.ok(texts.some((t) => t.indexOf('看到 01:00') === 0 && t.indexOf('话') === -1), JSON.stringify(texts));
});
