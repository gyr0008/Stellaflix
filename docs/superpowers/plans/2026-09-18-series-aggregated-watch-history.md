# 观看历史番剧聚合模型（方案 A）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `stellaflix-watch-history` 从"每次播放一条流水"升级为"一部番剧一条聚合记录"，指向最近观看集，点卡片直接续播。

**Architecture:** 聚合逻辑全部收敛在 `public/video/watch-history.js` 存储层内部（新键 `stellaflix-watch-history-v2`）；各集细进度继续以 `stellaflix-video-progress` 为唯一真相，新增 `model.clearProgressByPrefix` 支撑"删历史即删进度"。播放器等 4 个调用方零改动（契约兼容：记录保留集级 `key` 字段）。

**Tech Stack:** 原生 JS IIFE（无构建）、localStorage、node:test + vm 假件测试。

**Spec:** `docs/superpowers/specs/2026-09-18-series-aggregated-watch-history-design.md`

## Global Constraints

- 测试命令：`node --test tests/<file>`（本仓库没有 npm test / run-all.js）。
- 已知 3 个预存在失败测试（版本号断言、彩蛋断言、desktop/main.js 断言）与本次无关，不修、不算回归（见项目记忆）。
- 键拆分只允许 `lastIndexOf(':')`（sourceId 可含 `:`，如 `kazumi:` 前缀），禁止 `split(':')`。
- 存储操作维持 try/catch 静默降级风格：读失败回 `[]`，写失败回 `false`，迁移失败不阻断。
- 不删旧键：`stellaflix-watch-history-v1`、`stellaflix-video-history` 保留作回滚，写路径只写 v2。
- 零新依赖；`player.js`、`play-orchestrator.js`、`detail-source.js`、`home-continue-watching.js` 不得改动。
- 提交信息用中文 Conventional Commits（对齐仓库风格，如 `feat: …`）。

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `public/video/model.js` | 进度存储；新增 `clearProgressByPrefix(prefix)` | Modify（`clearProgress` 之后，约 :153） |
| `public/video/watch-history.js` | v2 聚合存储 + 迁移 + 记账 + 卡片文案 | Modify（主体） |
| `tests/model-progress-prefix.test.js` | 任务 1 测试 | Create |
| `tests/watch-history-v2.test.js` | 任务 2-5 测试 | Create |

---

### Task 1: model.clearProgressByPrefix

**Files:**
- Modify: `public/video/model.js`（`clearProgress` 函数后新增；文件末尾 `SFV.model = {` 导出表约 :386-390 加一行）
- Test: `tests/model-progress-prefix.test.js`

**Interfaces:**
- Consumes: `model.js` 既有 `readJSON/writeJSON`、`KEY_PROGRESS = 'stellaflix-video-progress'`（格式 `{ [集级key]: {position,duration,updatedAt} }`）。
- Produces: `SFV.model.clearProgressByPrefix(prefix: string): number`（返回删除条数；Task 4 的 `remove()` 调用它）。

- [ ] **Step 1: 写失败测试**

```js
'use strict';
// model.clearProgressByPrefix 行为测试。运行：node --test tests/model-progress-prefix.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const modelPath = path.join(__dirname, '..', 'public', 'video', 'model.js');

function makeLocalStorage(initial) {
  const data = Object.assign({}, initial || {});
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
    _dump: () => JSON.parse(JSON.stringify(data)),
  };
}

function loadModel(initial) {
  const source = fs.readFileSync(modelPath, 'utf8');
  const localStorage = makeLocalStorage(initial);
  const window = { localStorage, addEventListener() {} };
  window.window = window;
  vm.runInNewContext(source, { window, localStorage, console }, { filename: modelPath });
  return { model: window.StellaflixVideo.model, localStorage };
}

const KP = 'stellaflix-video-progress';

test('clearProgressByPrefix 只删匹配前缀的进度并返回删除数', () => {
  const init = { [KP]: JSON.stringify({
    'cms:s1:100:0': { position: 10, duration: 100, updatedAt: 1 },
    'cms:s1:100:1': { position: 20, duration: 100, updatedAt: 1 },
    'cms:s2:200:0': { position: 30, duration: 100, updatedAt: 1 },
  }) };
  const { model, localStorage } = loadModel(init);
  const n = model.clearProgressByPrefix('cms:s1:100:');
  assert.strictEqual(n, 2);
  const left = JSON.parse(localStorage.getItem(KP));
  assert.deepStrictEqual(Object.keys(left), ['cms:s2:200:0']);
});

test('clearProgressByPrefix 空参数/无命中均安全返回 0', () => {
  const { model } = loadModel({ [KP]: JSON.stringify({ 'a:0': { position: 1 } }) });
  assert.strictEqual(model.clearProgressByPrefix(''), 0);
  assert.strictEqual(model.clearProgressByPrefix(null), 0);
  assert.strictEqual(model.clearProgressByPrefix('zzz:'), 0);
});

test('kazumi 源含冒号的 key 按完整 seriesKey 前缀删除', () => {
  const init = { [KP]: JSON.stringify({
    'kazumi:abc:77:2': { position: 5 },
    'kazumi:abc:7:2': { position: 5 },
  }) };
  const { model, localStorage } = loadModel(init);
  assert.strictEqual(model.clearProgressByPrefix('kazumi:abc:77:'), 1);
  assert.deepStrictEqual(Object.keys(JSON.parse(localStorage.getItem(KP))), ['kazumi:abc:7:2']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/model-progress-prefix.test.js`
Expected: FAIL —— `model.clearProgressByPrefix is not a function`

- [ ] **Step 3: 实现**

在 `public/video/model.js` 的 `clearProgress`（约 :149-153）之后加：

```js
  // 按前缀清除进度（观看历史聚合卡删除时连带清整部番各集进度）；返回删除条数。
  function clearProgressByPrefix(prefix) {
    if (!prefix) return 0;
    var all = readJSON(KEY_PROGRESS, {});
    var n = 0;
    Object.keys(all).forEach(function (k) {
      if (k.indexOf(prefix) === 0) { delete all[k]; n++; }
    });
    if (n) writeJSON(KEY_PROGRESS, all);
    return n;
  }
```

在 `SFV.model = { … }` 导出表中 `clearProgress: clearProgress,`（约 :390）后加：

```js
    clearProgressByPrefix: clearProgressByPrefix,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/model-progress-prefix.test.js`
Expected: 3 pass

- [ ] **Step 5: 提交**

```bash
git add public/video/model.js tests/model-progress-prefix.test.js
git commit -m "feat: model 新增 clearProgressByPrefix 供聚合历史删除联动"
```

---

### Task 2: v2 存储核心（normalize / add 聚合 / 迁移）

**Files:**
- Modify: `public/video/watch-history.js`（:30-31 键定义；:41-99 迁移与 readAll；:100-124 normalize；:159-170 add）
- Test: `tests/watch-history-v2.test.js`（新建，含共享假件脚手架，Task 3-5 追加用例）

**Interfaces:**
- Consumes: 无前置任务依赖。
- Produces:
  - 内部 `seriesKeyOf(key): string`、`episodeIndexOf(key): number|null`、`dayKey(ts?): string`（Task 3/4 复用，均在同文件内）；
  - v2 记录 normalize 后必含：`seriesKey, key, episodeIndex, episodeName, watchedDay, daySec, epSec` + v1 全部字段；
  - `SFV.watchHistory.add(rec)`：入参不变（集级 key），行为改聚合。

- [ ] **Step 1: 写失败测试（脚手架 + 聚合/迁移用例）**

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/watch-history-v2.test.js`
Expected: FAIL（add 后 v2 键无数据 / seriesKey undefined）

- [ ] **Step 3: 实现存储核心**

`public/video/watch-history.js` 修改，全部改动如下：

3a. 键定义（替换 :30-31）：

```js
  var KEY = 'stellaflix-watch-history-v2';   // 聚合模型：一部番一条
  var KEY_V1 = 'stellaflix-watch-history-v1'; // 旧流水键：只读，保留回滚
  var CAP = 500; // 语义：最多 500 部
```

3b. 工具函数（加在 `el()` 之后）：

```js
  // 集级 key（'<sourceId>:<vodId>:<epIdx>'）→ 片级 seriesKey；sourceId 可含 ':'（kazumi:），
  // 只能剥最后一段。尾段非数字或无冒号 → 非法，返回 ''。
  function seriesKeyOf(key) {
    if (!key || typeof key !== 'string') return '';
    var i = key.lastIndexOf(':');
    return i > 0 ? key.slice(0, i) : '';
  }
  function episodeIndexOf(key) {
    if (!key || typeof key !== 'string') return null;
    var i = key.lastIndexOf(':');
    if (i < 0) return null;
    var n = parseInt(key.slice(i + 1), 10);
    return isNaN(n) ? null : n;
  }
  function dayKey(ts) {
    var d = new Date(ts == null ? Date.now() : ts);
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }
```

3c. normalize（整函数替换 :100-124）：

```js
  function normalize(rec) {
    var prog = (typeof rec.progress === 'number') ? rec.progress : (rec.finished ? 1 : 0);
    if (prog < 0) prog = 0; if (prog > 1) prog = 1;
    var key = rec.key || '';
    return {
      key: key,
      seriesKey: rec.seriesKey || seriesKeyOf(key),
      episodeIndex: (typeof rec.episodeIndex === 'number') ? rec.episodeIndex : episodeIndexOf(key),
      episodeName: rec.episodeName || rec.sub || '',
      title: rec.title || '',
      sub: rec.sub || '',
      img: rec.img || '',
      progress: prog,
      cur: rec.cur || '',
      total: rec.total || '',
      ts: rec.ts || Date.now(),
      finished: !!rec.finished,
      sourceId: rec.sourceId || '',
      vodId: rec.vodId != null ? rec.vodId : '',
      pic: rec.pic || '',
      watchedSec: Math.max(0, Number(rec.watchedSec) || 0),
      watchedDay: rec.watchedDay || '',
      daySec: Math.max(0, Number(rec.daySec) || 0),
      epSec: Math.max(0, Number(rec.epSec) || 0),
      lastSourceId: rec.lastSourceId || '',
      lastVodId: rec.lastVodId != null ? rec.lastVodId : '',
      lastSourceName: rec.lastSourceName || '',
      lastPlayFromIndex: (typeof rec.lastPlayFromIndex === 'number') ? rec.lastPlayFromIndex : 0,
      lastPlayEpisodeIndex: (typeof rec.lastPlayEpisodeIndex === 'number') ? rec.lastPlayEpisodeIndex : 0,
    };
  }
```

3d. 迁移（替换 `migrateFromModelIfEmpty` 整函数 :46-83，改名并保留 MODEL_KEY 常量）：

```js
  // v2 键为空时的一次性聚合迁移：优先 v1 流水键，其次 model 粗粒度键。
  // 旧键都不删除（回滚用）；产出按 ts 降序的 v2 数组。
  function migrateToV2IfEmpty() {
    try {
      if (LS.getItem(KEY)) return;
      var src = [];
      var raw1 = LS.getItem(KEY_V1);
      if (raw1) { var p1 = JSON.parse(raw1); if (Array.isArray(p1)) src = p1; }
      if (!src.length) {
        var rawM = LS.getItem(MODEL_KEY);
        if (rawM) {
          var pm = JSON.parse(rawM);
          if (Array.isArray(pm)) {
            for (var i = 0; i < pm.length; i++) {
              var m = pm[i];
              if (!m || !m.key) continue;
              src.push({
                key: m.key, title: m.title || '', sub: (m.year ? (m.year + ' 年') : ''),
                img: m.pic || '', pic: m.pic || '', progress: 0, cur: '00:00', total: '',
                ts: m.ts || Date.now(), finished: false, watchedSec: 0,
                sourceId: m.sourceId || '', vodId: m.vodId,
              });
            }
          }
        }
      }
      if (!src.length) return;
      var best = {};
      src.forEach(function (r) {
        if (!r || !r.key) return;
        var s = seriesKeyOf(r.key);
        if (!s) return;
        if (!best[s] || (Number(r.ts) || 0) > (Number(best[s].ts) || 0)) best[s] = r;
      });
      var today = dayKey(Date.now());
      var arr = Object.keys(best).map(function (s) {
        var r = best[s];
        var isToday = dayKey(Number(r.ts) || 0) === today;
        return normalize(Object.assign({}, r, {
          seriesKey: s,
          watchedDay: isToday ? today : '',
          daySec: isToday ? (Number(r.watchedSec) || 0) : 0,
          epSec: isToday ? (Number(r.watchedSec) || 0) : 0,
        }));
      });
      arr.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
      if (arr.length > CAP) arr = arr.slice(0, CAP);
      writeAll(arr);
      if (typeof console !== 'undefined' && console.info) {
        console.info('[SFV watch-history] 聚合迁移 →v2：' + src.length + ' 条流水 → ' + arr.length + ' 部');
      }
    } catch (e) { /* 迁移失败不阻断读取 */ }
  }
```

3e. readAll 内把 `migrateFromModelIfEmpty()` 调用改为 `migrateToV2IfEmpty()`（:87）。

3f. add（整函数替换 :159-170）：

```js
  // 聚合写入：一部番恒一条。换集 → 进度字段重置、移到头部；
  // 同集重开 → 只刷新元信息与 ts（进度保留）；epSec（本会话已计秒基线）一律清零。
  function add(rec) {
    if (!rec || !rec.key) return readAll();
    var sKey = seriesKeyOf(rec.key);
    if (!sKey) return readAll();
    var a = readAll();
    var now = Date.now();
    var today = dayKey(now);
    var idx = -1;
    for (var i = 0; i < a.length; i++) { if (a[i].seriesKey === sKey) { idx = i; break; } }
    var next;
    if (idx >= 0) {
      var old = a[idx];
      if (old.key === rec.key) {
        next = normalize(Object.assign({}, old, {
          title: rec.title || old.title,
          img: rec.img || old.img,
          pic: rec.pic || old.pic,
          sub: rec.sub != null ? rec.sub : old.sub,
          ts: now,
          watchedDay: today,
          daySec: old.watchedDay === today ? (old.daySec || 0) : 0,
          epSec: 0,
        }));
      } else {
        next = normalize(Object.assign({}, rec, {
          seriesKey: sKey, ts: now,
          progress: 0, cur: '00:00', total: '', finished: false, watchedSec: 0,
          watchedDay: today,
          daySec: old.watchedDay === today ? (old.daySec || 0) : 0,
          epSec: 0,
        }));
      }
      a.splice(idx, 1);
    } else {
      next = normalize(Object.assign({}, rec, { seriesKey: sKey, watchedDay: today, daySec: 0, epSec: 0 }));
    }
    a.unshift(next);
    if (a.length > CAP) a = a.slice(0, CAP);
    writeAll(a); return a;
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/watch-history-v2.test.js`
Expected: 5 pass

- [ ] **Step 5: 提交**

```bash
git add public/video/watch-history.js tests/watch-history-v2.test.js
git commit -m "feat: 观看历史聚合存储 v2 —— 一部番一条 + v1/model 一次性迁移"
```

---

### Task 3: update() 聚合 + stale 防串写 + daySec 记账 + getTodayInsight

**Files:**
- Modify: `public/video/watch-history.js`（update :191-229；getTodayInsight 今日秒数段 :474-489）
- Test: `tests/watch-history-v2.test.js`（追加用例）

**Interfaces:**
- Consumes: Task 2 的 `seriesKeyOf/dayKey/normalize`（同文件）。
- Produces: `SFV.watchHistory.update(集级key, patch)` 签名不变；`getTodayInsight()` 返回结构不变（内部改读 `daySec`）。

- [ ] **Step 1: 追加失败测试**

```js
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
  // 跨天：把记录改到昨天，再回写 → 今日从零起
  rec = find(store.getAll(), 'cms:s1:100');
  rec.watchedDay = '2000-01-01';
  store.getAll(); // 触发下一切片的读—直接改存储模拟跨天：
  const ls = JSON.parse(localStorage.getItem ? 'null' : 'null'); // （占位见下行）
});
```

跨天分支用可控假时钟重写成独立用例（vm context 的 Date 不好打桩，改为预置 `watchedDay` 后直接 update）：

```js
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
```

（追加时删掉上面第一个用例里"跨天"占位段——它由第二个独立用例覆盖。）

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/watch-history-v2.test.js`
Expected: 新增用例 FAIL（update 仍按 v1 同天匹配、无 daySec 记账）

- [ ] **Step 3: 实现**

3a. update 整函数替换（:191-229）：

```js
  // 播放器/续播回写：入参仍是集级 key。先折成 seriesKey 定位聚合记录；
  // 若记录已被更新的一集接管（rec.key !== key）则忽略本次回写（stale 防串写）。
  // watchedSec 按「本会话单调递增」语义做增量记账：daySec += incoming - epSec 基线。
  function update(key, patch) {
    if (!key) return null;
    var sKey = seriesKeyOf(key);
    if (!sKey) return null;
    var a = readAll();
    var idx = -1;
    for (var i = 0; i < a.length; i++) {
      if (a[i].seriesKey === sKey) { idx = i; break; }
    }
    if (idx < 0) return null;
    var rec = a[idx];
    if (rec.key !== key) return rec; // 旧集会播/已被新集接管：不改记录
    if (patch) {
      var today = dayKey(Date.now());
      if (rec.watchedDay !== today) { rec.watchedDay = today; rec.daySec = 0; rec.epSec = 0; }
      if (typeof patch.watchedSec === 'number') {
        var incoming = Math.max(0, Number(patch.watchedSec) || 0);
        var base = Math.max(0, Number(rec.epSec) || 0);
        rec.daySec = (Math.max(0, Number(rec.daySec) || 0)) + Math.max(0, incoming - base);
        rec.epSec = Math.max(base, incoming);
        rec.watchedSec = incoming;
      }
      if (typeof patch.progress === 'number') rec.progress = Math.max(0, Math.min(1, patch.progress));
      if (patch.cur != null) rec.cur = patch.cur;
      if (patch.total != null) rec.total = patch.total;
      if (typeof patch.finished === 'boolean') rec.finished = patch.finished;
      if (patch.ts) rec.ts = patch.ts;
      if (patch.lastSourceId != null) rec.lastSourceId = patch.lastSourceId;
      if (patch.lastVodId != null) rec.lastVodId = patch.lastVodId;
      if (patch.lastSourceName != null) rec.lastSourceName = patch.lastSourceName;
      if (typeof patch.lastPlayFromIndex === 'number') rec.lastPlayFromIndex = patch.lastPlayFromIndex;
      if (typeof patch.lastPlayEpisodeIndex === 'number') rec.lastPlayEpisodeIndex = patch.lastPlayEpisodeIndex;
    }
    var arr2 = a.slice();
    arr2.splice(idx, 1);
    arr2.unshift(rec); // 最近观看移到头部
    writeAll(arr2); return rec;
  }
```

3b. getTodayInsight 取秒段（:477-483 的 forEach 内）改：

```js
    todayRecords.forEach(function (r) {
      var sec = Number(r.daySec) || 0;
      if (sec <= 0) sec = Number(r.watchedSec) || 0;
      if (sec <= 0) {
        // 旧记录兜底：progress × 总时长解析秒（>=0，不会虚增负数）
        sec = Math.max(0, Math.floor((Number(r.progress) || 0) * parseDuration(r.total)));
      }
```

其余不动（`watchedTotalSec += sec` 以下原样）。

- [ ] **Step 4: 跑测试确认通过（含 Task 2 全部旧用例）**

Run: `node --test tests/watch-history-v2.test.js`
Expected: 全 pass

- [ ] **Step 5: 提交**

```bash
git add public/video/watch-history.js tests/watch-history-v2.test.js
git commit -m "feat: 历史回写按片聚合 —— stale 防串写 + daySec 今日记账"
```

---

### Task 4: remove() 删片连带清进度

**Files:**
- Modify: `public/video/watch-history.js`（remove :144-153）
- Test: `tests/watch-history-v2.test.js`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `SFV.model.clearProgressByPrefix(prefix)`（沙箱里用 window.StellaflixVideo.model 假件注入）。
- Produces: `remove(key, ts)` 签名不变、`ts` 忽略；按集级 key 或 seriesKey 都能删整片；返回剩余数组。

- [ ] **Step 1: 追加失败测试**

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/watch-history-v2.test.js`
Expected: 新用例 FAIL（v1 remove 按 key 精确匹配，删不掉整片、无联动）

- [ ] **Step 3: 实现**

remove 整函数替换（:144-153）：

```js
  function remove(key, ts) {
    // 聚合模型：一部番一条，ts 兼容位忽略。传集级 key 或 seriesKey 均可删整片。
    var a = readAll();
    var sKey = seriesKeyOf(key || '') || key;
    var hit = null;
    a = a.filter(function (r) {
      var drop = !!key && (r.seriesKey === sKey || r.key === key);
      if (drop && !hit) hit = r;
      return !drop;
    });
    // 删历史 = 删进度：清掉该剧所有集的 position，避免详情页幽灵进度
    if (hit && SFV.model && typeof SFV.model.clearProgressByPrefix === 'function') {
      try { SFV.model.clearProgressByPrefix((hit.seriesKey || sKey) + ':'); } catch (e) { /* 非致命 */ }
    }
    writeAll(a); return a;
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/watch-history-v2.test.js`
Expected: 全 pass

- [ ] **Step 5: 提交**

```bash
git add public/video/watch-history.js tests/watch-history-v2.test.js
git commit -m "feat: 历史卡片移除改为删除整片并联动清除各集进度"
```

---

### Task 5: 卡片状态行「第 N 话」+ 文件头注释 + 回归

**Files:**
- Modify: `public/video/watch-history.js`（buildCard 状态行 :399-409；文件头注释 :1-24；`getAll()/getCount()` 注释如提及"每条"语义则同步）
- Test: `tests/watch-history-v2.test.js`（追加渲染用例）

**Interfaces:**
- Consumes: Task 2 假 DOM 脚手架（`makeNode/loadHistory`）。
- Produces: 历史页卡片未完成态文案 `第 N 话 · 看到 <cur> / 总时长 · <total>`；已看完仍 `观看完成`。

- [ ] **Step 1: 追加失败测试**

```js
test('卡片状态行：有 episodeIndex 时显示「第 N 话 · 看到 …」', () => {
  const { store } = loadHistory();
  store.add({ key: 'cms:s1:100:3', title: '片A', sub: '第4话', ts: Date.now() });
  store.update('cms:s1:100:3', { progress: 0.3, cur: '06:00', total: '20:00' });
  const host = makeNode('div');
  store.render(host, store.getAll());
  const texts = [];
  (function walk(n) {
    if (n.className === 'sfv-wh-card__status-text') texts.push(n.textContent);
    (n.children || []).forEach(walk);
  })(host);
  assert.ok(texts.some((t) => t.indexOf('第 4 话 · 看到 06:00') === 0), JSON.stringify(texts));
});

test('卡片状态行：无集号（异常旧数据）退回「看到 …」', () => {
  const { store, localStorage } = loadHistory();
  localStorage.setItem(V2, JSON.stringify([{ key: 'weird', seriesKey: '', title: '无集', ts: Date.now(), cur: '01:00', total: '02:00' }]));
  const host = makeNode('div');
  store.render(host, store.getAll());
  const texts = [];
  (function walk(n) {
    if (n.className === 'sfv-wh-card__status-text') texts.push(n.textContent);
    (n.children || []).forEach(walk);
  })(host);
  assert.ok(texts.some((t) => t.indexOf('看到 01:00') === 0 && t.indexOf('话') === -1), JSON.stringify(texts));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/watch-history-v2.test.js`
Expected: 新用例 FAIL（状态行无「第 N 话」前缀）

- [ ] **Step 3: 实现**

3a. buildCard 状态行（替换 :402-408 的 `var status = …` 块）：

```js
    var status = el('div', 'sfv-wh-card__status' + (rec.finished ? ' sfv-wh-card__status--done' : ''));
    if (rec.finished) {
      status.appendChild(el('span', 'sfv-wh-card__dot'));
      status.appendChild(el('span', 'sfv-wh-card__status-text', '观看完成'));
    } else {
      var epPrefix = (typeof rec.episodeIndex === 'number') ? ('第 ' + (rec.episodeIndex + 1) + ' 话 · ') : '';
      status.appendChild(el('span', 'sfv-wh-card__status-text',
        epPrefix + '看到 ' + (rec.cur || '00:00') + ' / 总时长 · ' + (rec.total || '00:00')));
    }
```

3b. 文件头注释（:5-8 schema 描述）改为 v2 聚合契约：`stellaflix-watch-history-v2`，`seriesKey 主键，一部番一条；key=最近观看集的集级键；daySec/epSec 为今日观看秒记账`。职责段补一行"v1/model 旧键一次性聚合迁移（幂等，v2 空才触发，旧键保留）"。

- [ ] **Step 4: 跑本特性全部测试 + 全仓回归**

Run: `node --test tests/watch-history-v2.test.js tests/model-progress-prefix.test.js`
Expected: 全 pass
Run: `node --test tests/`
Expected: 除已知 3 个预存在失败外全 pass（失败名/断言与项目记忆一致即非回归；出现新失败必须排查）

- [ ] **Step 5: 手动冒烟（UI 验证，不可省略）**

启动应用（`npm start` 或既有启动方式），验证链路：
1. 播放某片 ep1 → 历史页单卡显示「第 1 话 · 看到 …」；
2. 换 ep2 续播 → 仍一条卡，进度归零后重新增长；
3. 点卡 → 直接续播 ep2 且进度正确；
4. 移除卡 → 详情页该剧各集不再显示进度；
5. 首页「接着看」与今日观看 Insight 数字正常。

- [ ] **Step 6: 提交**

```bash
git add public/video/watch-history.js tests/watch-history-v2.test.js
git commit -m "feat: 历史卡片显示「第 N 话」并更新存储契约注释"
```

---

## Self-Review 结论

- Spec §2 数据模型 → Task 2；§3 写入端 → Task 2/3；§4 记账 → Task 2/3；§5 UI/迁移/删除 → Task 2/4/5；§6 错误处理 → 各任务实现内；§7 测试 → 全部任务 Step 1；§8 文件清单 → Global Constraints 锁定零改动。
- 命名一致性核对：`seriesKeyOf/episodeIndexOf/dayKey/daySec/epSec/seriesKey/episodeIndex/episodeName` 在代码块与测试中拼写一致；`clearProgressByPrefix` 在 Task 1 定义、Task 4 消费。
- 无占位符；Task 3 首个测试里的"跨天占位段"已在该步内明示删除并由独立用例覆盖。
