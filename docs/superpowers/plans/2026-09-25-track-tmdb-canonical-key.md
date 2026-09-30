# 追片键统一为 TMDB canonical key（方案 A）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复「电影详情页点追片无反应」并把追片状态读写收口到统一键 `tmdb:<mediaType>:<id>`，消除详情页/播放器双键分裂。

**Architecture:** 在 `model.js` 新增 canonical 键推导 + 多键读写三个纯函数（单一真相源）；详情页、起播链路（detail-source → play-orchestrator → player meta）、播放器 heart-btn 三处调用方全部改走「主键=TMDB 键、别名键=源键」的候选列表；写入时落主键并清别名键（惰性迁移，不做全量存量迁移）。

**Tech Stack:** 浏览器端 ES5 IIFE（`public/video/*.js`）、node:test + vm/正则两类测试（`tests/`）、localStorage 命名空间 `stellaflix-video-*`。

**Spec:** 本文档「诊断结论」一节 = 2026-09-25 审查定案（无独立 spec 文件）。

## 诊断结论（本计划论证依据）

1. `detail.js:121-122` `cycleTrackStatus` 要求 `view.key`，TMDB 墙/片单入口的详情视图无 `key`（`wall-adapter.js:52-60` meta 只有 `id/mediaType`）→ 静默 return，按钮"没反应"。
2. 播放器 heart-btn 用的是起播时构造的 `v2.key = 'sourceId:vodId'`（`detail-source.js:162` → `play-orchestrator.js:142` `seriesKey`）→ 有反应。
3. 退出播放器 `online-nav.js:405` 用带源键的 `v2` 重建详情页 → 返回后按钮"又好了"。
4. 双键隐患：同一部片详情页与播放器各存一份追片状态，互不相通。

## Global Constraints

- 浏览器端代码保持 ES5：`var`/`function`，不用箭头函数/let/模板串（对齐现有 `public/video/*.js` 风格）。
- canonical 键格式固定为 `'tmdb:' + (mediaType∈{movie,tv}) + ':' + id`；`_tmdb.mediaType` 非 `'tv'` 一律归 `'movie'`（与 `detail.js:68` 现口径一致）。
- 迁移策略 = **惰性合并**：写主键（TMDB 键，取不到则源键）、读按候选顺序取首个命中、写成功后删除其余候选键。不做一次性全量迁移（源键→TMDB 键的映射需联网匹配，破坏性且不可靠）。
- 只动「追片」(KEY_TRACK / KEY_META 播种)；观看进度、观看历史、flag 的键体系本次**不动**。
- 测试两类风格并存：可执行 vm 沙箱测试（同 `tests/local-collect-adapter.test.js`）、源码正则接线测试（同 `tests/home-collections-detail-page.test.js`）。全量回归 `npm test`，基线 89/89（见项目记忆）。
- **提交纪律（用户规则优先）**：仅当用户明确下达"提交"指令时才 `git commit`；各任务末尾的提交步骤默认跳过、保留工作区变更，只 stage 本任务文件。

---

### Task 1: model.js — canonical 键推导 + 多键读写原语

**Files:**
- Modify: `public/video/model.js`（追片区 266-316 行附近新增函数；导出表 400-439 行新增 3 个键）
- Test: `tests/track-canonical-key.test.js`（新建，vm 可执行）

**Interfaces:**
- Consumes: 既有 `getTrackStatus(key)` / `setTrackStatus(key, status)` / `getMeta(key)` / `setMeta(rec)`（model.js:266-358）
- Produces:
  - `SFV.model.canonicalTrackKey(view) -> 'tmdb:<mt>:<id>' | null`
  - `SFV.model.getTrackStatusForKeys(keys: string[]) -> status | null`
  - `SFV.model.setTrackStatusForKeys(keys: string[], status, meta?: {title,pic,year}) -> status | null`（Task 2/4 调用）

- [ ] **Step 1: 写失败测试**

创建 `tests/track-canonical-key.test.js`：

```js
'use strict';

/**
 * 追片 canonical 键（tmdb:<mt>:<id>）+ 多键读写原语行为测试
 * 运行：node --test tests/track-canonical-key.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadModel() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'video', 'model.js'), 'utf8');
  const store = {};
  const sandbox = {
    console, JSON, Math, Date, String, Number, Array, Object, Boolean, Promise, parseInt, setTimeout,
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'model.js' });
  return sandbox.StellaflixVideo.model;
}

test('canonicalTrackKey：TMDB 墙视图（id+mediaType）得 tmdb 键', () => {
  const m = loadModel();
  assert.strictEqual(m.canonicalTrackKey({ id: 284054, mediaType: 'movie' }), 'tmdb:movie:284054');
  assert.strictEqual(m.canonicalTrackKey({ id: 1399, mediaType: 'tv' }), 'tmdb:tv:1399');
});

test('canonicalTrackKey：_tmdb 优先；tmdb: 前缀 key 直通；源键/无 id 得 null', () => {
  const m = loadModel();
  assert.strictEqual(m.canonicalTrackKey({ _tmdb: { id: 5, mediaType: 'tv' }, id: 9, mediaType: 'movie' }), 'tmdb:tv:5');
  assert.strictEqual(m.canonicalTrackKey({ key: 'tmdb:movie:77' }), 'tmdb:movie:77');
  assert.strictEqual(m.canonicalTrackKey({ key: 's1:1048', vodId: 1048 }), null);
  assert.strictEqual(m.canonicalTrackKey(null), null);
  assert.strictEqual(m.canonicalTrackKey({ title: '无id' }), null);
});

test('getTrackStatusForKeys：按候选顺序取首个命中；全 miss 得 null', () => {
  const m = loadModel();
  m.setTrackStatus('s1:1048', 'watching');
  assert.strictEqual(m.getTrackStatusForKeys(['tmdb:movie:284054', 's1:1048']), 'watching');
  assert.strictEqual(m.getTrackStatusForKeys(['tmdb:movie:1']), null);
  assert.strictEqual(m.getTrackStatusForKeys([]), null);
});

test('setTrackStatusForKeys：写主键、清别名键（惰性迁移）、按主键播种 meta', () => {
  const m = loadModel();
  m.setTrackStatus('s1:1048', 'watching');
  const r = m.setTrackStatusForKeys(
    ['tmdb:movie:284054', 's1:1048'], 'planToWatch',
    { title: '末世橡樹街', pic: 'https://x/p.jpg', year: '2026' }
  );
  assert.strictEqual(r, 'planToWatch');
  assert.strictEqual(m.getTrackStatus('tmdb:movie:284054'), 'planToWatch');
  assert.strictEqual(m.getTrackStatus('s1:1048'), null, '别名键必须被清除，避免追片页双条目');
  const meta = m.getMeta('tmdb:movie:284054');
  assert.ok(meta, 'TMDB 主键首次追片须播种 meta，供追片页渲染标题封面');
  assert.strictEqual(meta.title, '末世橡樹街');
});

test('setTrackStatusForKeys(null)：循环回未追时两键全清', () => {
  const m = loadModel();
  m.setTrackStatusForKeys(['tmdb:movie:9', 's2:1'], 'watched', { title: 't' });
  m.setTrackStatusForKeys(['tmdb:movie:9', 's2:1'], null);
  assert.strictEqual(m.getTrackStatus('tmdb:movie:9'), null);
  assert.strictEqual(m.getTrackStatus('s2:1'), null);
});

test('setTrackStatusForKeys：无候选键得 null 且不抛', () => {
  const m = loadModel();
  assert.strictEqual(m.setTrackStatusForKeys([], 'watching'), null);
  assert.strictEqual(m.setTrackStatusForKeys(null, 'watching'), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/track-canonical-key.test.js`
Expected: FAIL（`m.canonicalTrackKey is not a function`）

- [ ] **Step 3: 实现 model.js 三个函数**

在 `public/video/model.js` 的 `clearTrack`（296-316 行区）之后、`getKeysByFlag` 之前插入：

```js
  // ---- 追片 canonical 键（方案 A，2026-09-25）----
  // canonical 键 = 'tmdb:<movie|tv>:<id>'，一部片全局唯一，不随片源漂移。
  // 推导优先级：view._tmdb → view.key 已是 tmdb: 前缀 → view.id+view.mediaType（TMDB 墙/片单形态）。
  // 取不到返回 null，调用方回退源键（view.key / seriesKey）。
  function canonicalTrackKey(view) {
    if (!view) return null;
    var t = view._tmdb;
    if (t && t.id != null) {
      return 'tmdb:' + (t.mediaType === 'tv' ? 'tv' : 'movie') + ':' + t.id;
    }
    if (typeof view.key === 'string' && view.key.indexOf('tmdb:') === 0) return view.key;
    if (view.id != null && (view.mediaType === 'movie' || view.mediaType === 'tv')) {
      return 'tmdb:' + view.mediaType + ':' + view.id;
    }
    return null;
  }

  // 多候选键读取：按顺序返回首个命中（主键=TMDB 键，别名=源键，兼容存量数据）
  function getTrackStatusForKeys(keys) {
    var list = keys || [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i] ? getTrackStatus(list[i]) : null;
      if (s) return s;
    }
    return null;
  }

  // 多候选键写入：落主键、清其余别名键（惰性迁移）；
  // 主键为 tmdb: 且尚无 meta 时用 meta 信息播种，保证追片页可渲染标题/封面。
  function setTrackStatusForKeys(keys, status, meta) {
    var list = [];
    (keys || []).forEach(function (k) { if (k && list.indexOf(k) < 0) list.push(k); });
    if (!list.length) return null;
    var primary = list[0];
    var result = setTrackStatus(primary, status);
    for (var i = 1; i < list.length; i++) {
      if (!result && getTrackStatus(list[i])) result = status || getTrackStatus(list[i]);
      setTrackStatus(list[i], null);
    }
    if (status && result && primary.indexOf('tmdb:') === 0 && meta && meta.title && !getMeta(primary)) {
      setMeta({ key: primary, title: meta.title, pic: meta.pic || '', year: meta.year || '' });
    }
    return result;
  }
```

导出表 `SFV.model = { ... }`（400-439 行）"追片"段追加：

```js
    canonicalTrackKey: canonicalTrackKey,
    getTrackStatusForKeys: getTrackStatusForKeys,
    setTrackStatusForKeys: setTrackStatusForKeys,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/track-canonical-key.test.js`
Expected: PASS（6 tests）

- [ ] **Step 5: 提交（条件步骤：仅用户已下达"提交"指令时执行，否则跳过）**

```bash
git add public/video/model.js tests/track-canonical-key.test.js
git commit -m "feat: 追片 canonical 键原语 —— model 层 tmdb:<mt>:<id> 推导 + 多键读写惰性迁移"
```

---

### Task 2: detail.js — 详情页追片按钮改走候选键（修复原始 bug）

**Files:**
- Modify: `public/video/detail.js:115-134`（cycleTrackStatus）、`public/video/detail.js:506`（curTrack 初始化）
- Test: `tests/track-key-wiring.test.js`（新建，正则接线测试，Task 2-4 共用一个文件、逐任务追加用例）

**Interfaces:**
- Consumes: Task 1 的 `SFV.model.canonicalTrackKey(view)` / `getTrackStatusForKeys(keys)` / `setTrackStatusForKeys(keys, status, meta)`
- Produces: `trackKeysForView(view) -> string[]`（模块内私有；Task 4 不依赖它，各自从 meta 组键）

- [ ] **Step 1: 写失败测试**

创建 `tests/track-key-wiring.test.js`：

```js
'use strict';

/**
 * 追片 canonical 键接线测试：详情页 / 起播链路 / 播放器三处必须走
 * model.canonicalTrackKey + get/setTrackStatusForKeys，禁止再直接读写裸 view.key。
 * 运行：node --test tests/track-key-wiring.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const detailSrc = read('public/video/detail.js');

test('detail.js：trackKeysForView 以 canonical 键为主、view.key 兜底', () => {
  const fn = /function\s+trackKeysForView\s*\([\s\S]*?\n  \}/.exec(detailSrc);
  assert.ok(fn, 'expected trackKeysForView()');
  assert.match(fn[0], /canonicalTrackKey\s*\(/);
  assert.match(fn[0], /view\.key/);
});

test('detail.js：cycleTrackStatus 不再因缺 view.key 静默 return（原始 bug 回归锁）', () => {
  const fn = /function\s+cycleTrackStatus\s*\([\s\S]*?\n  \}/.exec(detailSrc);
  assert.ok(fn, 'expected cycleTrackStatus()');
  assert.match(fn[0], /trackKeysForView\s*\(/);
  assert.match(fn[0], /getTrackStatusForKeys\s*\(/);
  assert.match(fn[0], /setTrackStatusForKeys\s*\(/);
  assert.equal(/if\s*\(\s*!\s*key\s*\|\|/.test(fn[0]), false, '不得残留裸 key 早退守卫');
});

test('detail.js：首屏 curTrack 图标/标题也走候选键（进页即显示已追状态）', () => {
  const init = /var\s+curTrack\s*=[\s\S]{0,220}/.exec(detailSrc);
  assert.ok(init, 'expected curTrack init');
  assert.match(init[0], /getTrackStatusForKeys\s*\(/);
  assert.match(init[0], /trackKeysForView\s*\(/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/track-key-wiring.test.js`
Expected: FAIL（`expected trackKeysForView()`）

- [ ] **Step 3: 实现 detail.js 改动**

3a. 在 `_trackTriggerBtn` 声明（115-116 行）后、`cycleTrackStatus` 前新增：

```js
  // 追片候选键：主键=TMDB canonical（一部片跨源稳定），别名=源键（存量/无 TMDB id 时）。
  // 读写均经 model.get/setTrackStatusForKeys，写入时惰性清别名键。
  function trackKeysForView(view) {
    var keys = [];
    if (SFV.model && typeof SFV.model.canonicalTrackKey === 'function') {
      var c = SFV.model.canonicalTrackKey(view);
      if (c) keys.push(c);
    }
    if (view && view.key && keys.indexOf(view.key) < 0) keys.push(view.key);
    return keys;
  }
```

3b. `cycleTrackStatus`（120-134 行）整体替换为：

```js
  function cycleTrackStatus(view) {
    var keys = trackKeysForView(view);
    if (!keys.length || !SFV.model ||
        typeof SFV.model.getTrackStatusForKeys !== 'function' ||
        typeof SFV.model.setTrackStatusForKeys !== 'function') return;
    var status = SFV.model.getTrackStatusForKeys(keys);
    var menuKeys = TRACK_MENU.map(function (m) { return m.key; });
    var idx = menuKeys.indexOf(status);
    var next = menuKeys[(idx + 1) % menuKeys.length];
    SFV.model.setTrackStatusForKeys(keys, next, { title: view.title, pic: view.pic, year: view.year });
    // 纯图标刷新（对照 heart-btn：仅图标，无文字），并同步 title
    if (_trackTriggerBtn) {
      _trackTriggerBtn.innerHTML = trackIcon(next);
      _trackTriggerBtn.title = '追片：' + trackLabel(next);
    }
    toast('已设为：' + trackLabel(next));
  }
```

3c. 506 行 curTrack 初始化替换为：

```js
    var curTrack = (SFV.model && typeof SFV.model.getTrackStatusForKeys === 'function')
      ? SFV.model.getTrackStatusForKeys(trackKeysForView(view))
      : null;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/track-key-wiring.test.js`
Expected: PASS（3 tests）

- [ ] **Step 5: 提交（条件步骤，同 Task 1）**

```bash
git add public/video/detail.js tests/track-key-wiring.test.js
git commit -m "fix: 详情页追片按钮改走候选键 —— TMDB 墙/片单入口无源键也能追片（原始 bug 修复）"
```

---

### Task 3: 起播链路透传 tmdbKey（detail-source v2 ×4 + play-orchestrator setMeta）

**Files:**
- Modify: `public/video/detail-source.js`（v2 字面量 4 处：~134、~161、~574、~593）
- Modify: `public/video/play-orchestrator.js:142`
- Test: `tests/track-key-wiring.test.js`（追加用例）

**Interfaces:**
- Consumes: Task 1 `canonicalTrackKey`；detail 视图（可能带 `_tmdb` / `id+mediaType` / `tmdb:` key）
- Produces: `v2.tmdbKey: string|null` → `player.getMeta().tmdbKey`、`player.getMeta().seriesTitle`（Task 4 消费）

- [ ] **Step 1: 写失败测试（追加到 tests/track-key-wiring.test.js 末尾）**

```js
const detailSourceSrc = read('public/video/detail-source.js');
const orchestratorSrc = read('public/video/play-orchestrator.js');

test('detail-source.js：全部 4 处 v2 构造透传 tmdbKey（起播链路带 canonical 键）', () => {
  const hits = detailSourceSrc.match(/tmdbKey:\s*\(/g) || [];
  assert.strictEqual(hits.length, 4, 'v2 字面量应有且仅有 4 处注入 tmdbKey');
  assert.match(detailSourceSrc, /SFV\.model\.canonicalTrackKey/);
});

test('play-orchestrator.js：setMeta 透传 tmdbKey + seriesTitle 供 heart-btn 消费', () => {
  const call = /SFV\.player\.setMeta\(\{[^}]*\}\)/.exec(orchestratorSrc);
  assert.ok(call, 'expected setMeta({...}) call');
  assert.match(call[0], /tmdbKey:\s*view\.tmdbKey\s*\|\|/);
  assert.match(call[0], /seriesTitle:\s*view\.title/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/track-key-wiring.test.js`
Expected: FAIL（hits.length === 0）

- [ ] **Step 3: 实现**

3a. `detail-source.js` 4 处 v2 对象字面量各追加一行（视图引用不同）：

- 切换源 kazumi v2（~134，引用 `playbackSession.view`）与 CMS v2（~161，同）：

```js
          tmdbKey: (SFV.model && SFV.model.canonicalTrackKey) ? SFV.model.canonicalTrackKey(playbackSession.view) : null,
```

- 起播候选 kazumi v2（~574，引用形参 `view`）与 CMS v2（~593，同）：

```js
          tmdbKey: (SFV.model && SFV.model.canonicalTrackKey) ? SFV.model.canonicalTrackKey(view) : null,
```

3b. `play-orchestrator.js:142` 替换为：

```js
      if (SFV.player && SFV.player.setMeta) SFV.player.setMeta({ key: id, seriesKey: view.key, tmdbKey: view.tmdbKey || (SFV.model && SFV.model.canonicalTrackKey ? SFV.model.canonicalTrackKey(view) : null) || null, seriesTitle: view.title || '', cover: coverUrl, subtitle: sourceName });
```

（`player.js setMeta` 为逐字段合并（player.js:496-506），新字段随 open 后的 currentMeta 存活，无需改 player.js。）

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/track-key-wiring.test.js`
Expected: PASS（5 tests）

- [ ] **Step 5: 提交（条件步骤）**

```bash
git add public/video/detail-source.js public/video/play-orchestrator.js tests/track-key-wiring.test.js
git commit -m "feat: 起播链路透传 tmdbKey/seriesTitle —— 播放器追片键与详情页对齐"
```

---

### Task 4: player-controller.js — heart-btn 改走候选键

**Files:**
- Modify: `public/video/player-controller.js:259-290`（getSeriesKey / refreshHeartBtn / onHeartClick）
- Test: `tests/track-key-wiring.test.js`（追加用例）

**Interfaces:**
- Consumes: Task 1 `getTrackStatusForKeys` / `setTrackStatusForKeys`；Task 3 `meta.tmdbKey` / `meta.seriesKey` / `meta.seriesTitle` / `meta.cover`
- Produces: 播放器与详情页对同一部片读写同一主键（双键分裂消除的播放器侧）

- [ ] **Step 1: 写失败测试（追加）**

```js
const playerCtrlSrc = read('public/video/player-controller.js');

test('player-controller：候选键组装 tmdbKey 优先、seriesKey 兜底', () => {
  const fn = /function\s+getHeartTrackKeys\s*\([\s\S]*?\n  \}/.exec(playerCtrlSrc);
  assert.ok(fn, 'expected getHeartTrackKeys()');
  assert.match(fn[0], /meta\.tmdbKey/);
  assert.match(fn[0], /meta\.seriesKey/);
});

test('player-controller：onHeartClick/refreshHeartBtn 走 ForKeys 原语，不再裸用 seriesKey 写读', () => {
  const click = /function\s+onHeartClick\s*\([\s\S]*?\n  \}/.exec(playerCtrlSrc);
  assert.ok(click, 'expected onHeartClick()');
  assert.match(click[0], /getTrackStatusForKeys\s*\(/);
  assert.match(click[0], /setTrackStatusForKeys\s*\(/);
  assert.match(click[0], /getHeartTrackKeys\s*\(/);
  const refresh = /function\s+refreshHeartBtn\s*\([\s\S]*?\n  \}/.exec(playerCtrlSrc);
  assert.ok(refresh, 'expected refreshHeartBtn()');
  assert.match(refresh[0], /getTrackStatusForKeys\s*\(/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/track-key-wiring.test.js`
Expected: FAIL（`expected getHeartTrackKeys()`）

- [ ] **Step 3: 实现（259-290 行区替换）**

```js
  // ---------- 追片状态按钮（影视态下心形按钮改为6态图标，无文字） ----------
  // 候选键：主=TMDB canonical（起播链路透传 meta.tmdbKey），别名=源键 seriesKey（存量兼容）。
  // 与详情页 cycleTrackStatus 经 model.setTrackStatusForKeys 落同一主键，双键状态互通。
  function getHeartTrackKeys() {
    var meta = (SFV.player && SFV.player.getMeta) ? SFV.player.getMeta() : null;
    var keys = [];
    if (meta && meta.tmdbKey) keys.push(meta.tmdbKey);
    if (meta && meta.seriesKey && keys.indexOf(meta.seriesKey) < 0) keys.push(meta.seriesKey);
    return keys;
  }
  function getSeriesKey() {
    var keys = getHeartTrackKeys();
    return keys[0] || null;
  }
```

`refreshHeartBtn`（268-278 行）内两行改为：

```js
    var keys = getHeartTrackKeys();
    currentSeriesKey = keys[0] || null;
    var status = (keys.length && SFV.model && typeof SFV.model.getTrackStatusForKeys === 'function')
      ? SFV.model.getTrackStatusForKeys(keys) : null;
```

`onHeartClick`（279-290 行）整体替换为：

```js
  function onHeartClick(e) {
    e && e.preventDefault();
    var keys = getHeartTrackKeys();
    if (!keys.length) {
      var legacy = currentSeriesKey;
      if (legacy) keys = [legacy];
    }
    if (!keys.length || !SFV.model ||
        typeof SFV.model.getTrackStatusForKeys !== 'function' ||
        typeof SFV.model.setTrackStatusForKeys !== 'function') return;
    var status = SFV.model.getTrackStatusForKeys(keys);
    var idx = heartBtnStates.indexOf(status);
    var next = heartBtnStates[(idx + 1) % heartBtnStates.length];
    var meta = (SFV.player && SFV.player.getMeta) ? SFV.player.getMeta() : null;
    SFV.model.setTrackStatusForKeys(keys, next, { title: (meta && meta.seriesTitle) || '', pic: (meta && meta.cover) || '', year: '' });
    refreshHeartBtn();
    var label = (next && SFV.model.TRACK_LABELS) ? SFV.model.TRACK_LABELS[next] : '未追';
    toast('已设为：' + label);
  }
```

（`getTrackIconHtml`、`setupHeartBtn`、`currentSeriesKey` 声明等其余不动；`heartBtnStates` 沿用 37 行。）

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/track-key-wiring.test.js && node --test tests/track-canonical-key.test.js`
Expected: 两文件全 PASS（3 + 6 tests）

- [ ] **Step 5: 提交（条件步骤）**

```bash
git add public/video/player-controller.js tests/track-key-wiring.test.js
git commit -m "feat: 播放器 heart-btn 走候选键 —— 与详情页共享 TMDB 主键追片状态"
```

---

### Task 5: 全量回归 + 真机冒烟（无代码改动）

**Files:**
- 无新增；仅验证

- [ ] **Step 1: 全量回归**

Run: `npm test`
Expected: 原基线 89/89 + 新增 2 文件 9 用例全绿（98/98）

- [ ] **Step 2: 真机冒烟清单（需用户操作，:3000 桌面 app）**

1. 蜂窝墙点 TMDB 卡进详情 → 直接点追片 → 图标切换 + toast「已设为：在看」（**原始 bug 场景**）。
2. 同片点播放进播放器 → heart-btn 图标应显示「在看」（主键已互通）。
3. 播放器里切到「想看」→ 退出返回详情页 → 图标应为「想看」。
4. 追片页（在线-追片）出现该条目、标题封面正常（meta 播种生效）。
5. 旧存量：此前在播放器里追过的老片（仅源键）在追片页仍可见、点追片不报错。

- [ ] **Step 3: 结果回传后按用户指令决定是否提交/推送**

## Known Limitations（有意为之，非遗漏）

- 存量"仅源键"记录不做批量迁移：同一部片若新旧键都追过，追片页可能短暂出现双条目，新写入会惰性清旧键；用户可手动清。
- 无 TMDB id 的条目（本地文件、部分搜索结果直开）仍按源键追片（`canonicalTrackKey` 返回 null 时的既有行为），语义不变。
- 观看进度/历史（`seriesKey=sourceId:vodId`）体系本次不动，与追片键解耦。
