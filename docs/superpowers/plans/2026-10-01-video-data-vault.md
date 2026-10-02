# 影视数据 vault 化（镜像 + 空桶恢复）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把影视模块 9 个 localStorage 用户数据键镜像到 `userData/video-vault.json`，origin（端口）跳变后启动时自动回填，永久解决"数据消失"。

**Architecture:** localStorage 仍为运行时真源（所有同步读路径零改动）；新增渲染层 `data-vault.js` 做"启动空桶回填 + 变更后防抖镜像"，主进程新增 `stellaflix-video-vault` IPC 文件桥（仿既有 poster-cache 模式）。浏览器直开无桥时全链路 no-op。

**Tech Stack:** Electron IPC（ipcMain/ipcRenderer）、无依赖 IIFE 渲染模块、node:test + vm 单测。

**Spec:** `docs/superpowers/specs/2026-10-01-video-data-vault-design.md`（主人已批准，执行时两份对照）

## Global Constraints

- vault 键清单固定 9 个（spec §3）：`stellaflix-video-progress`、`stellaflix-video-library`、`stellaflix-video-history`、`stellaflix-video-flag`、`stellaflix-video-meta`、`stellaflix-video-track`、`stellaflix-video-failure-log`、`stellaflix-watch-history-v2`、`stellaflix:library:lastPoster`。
- 恢复条件 = **本地 `getItem(key) === null` 且 vault 有字符串值**；两桶都有值一律本地为准（保证"主动清空不复活"）。
- init 结束无条件 flush 一次全量镜像（覆盖首次建档 + 换桶收敛）。
- 防抖 1000ms；`ready` 超时兜底 1500ms（超时 resolve(false) 不 reject）；IPC 失败静默 console.warn，绝不 throw 进业务流程。
- 改任何 `public/video/**` 模块后必须 `npm run bundle`（B1 规则）。
- 全量回归 `npm test`，基线 148/149（唯一已知败 = watch-history D1 存量；不得新增失败）。
- 提交纪律：每任务一笔 commit，**只 stage 本任务文件**（仓库另有未提交的汇联/世界页改动，严禁 `git add -A`）；若主人未批准执行中的逐任务提交，到提交步骤停下询问。
- 平台 win32；测试运行器 = `node tests/run-all.js`（自动收集 `tests/*.test.js`），单文件 `node --test tests/<file>`。

---

### Task 1: data-vault.js 渲染层核心模块（TDD）

**Files:**
- Create: `public/video/data-vault.js`
- Test: `tests/video-vault.test.js`

**Interfaces:**
- Consumes: `global.desktopWindow.videoVault(action, payload) -> Promise<{ok,data}>`（Task 2 才真实存在；本任务用假桥测试）、`global.localStorage`。
- Produces: `SFV.vault = { KEYS: string[], ready: Promise<boolean>, mirror(): void, flush(): Promise<boolean> }`；事件名 `sfv:vault-restored`（window 上派发）。Task 3 依赖 `mirror()` 与 `ready`。

- [ ] **Step 1: 写失败测试**

创建 `tests/video-vault.test.js`：

```js
'use strict';
// data-vault 镜像/回填测试。运行：node --test tests/video-vault.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'video', 'data-vault.js'), 'utf8');
const K_LIB = 'stellaflix-video-library';
const K_WH = 'stellaflix-watch-history-v2';

function makeLocalStorage(initial) {
  const data = Object.assign({}, initial || {});
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
    _dump: () => JSON.parse(JSON.stringify(data)),
  };
}

// 假桥：记录调用；vault 初始内容可控（null/undefined → 视为空对象，避免 set 分支对 null 赋值抛错）
function makeBridge(initialVault) {
  const store = initialVault == null ? {} : JSON.parse(JSON.stringify(initialVault));
  const calls = [];
  return {
    calls,
    videoVault: (action, payload) => {
      calls.push({ action, payload });
      if (action === 'get') return Promise.resolve({ ok: true, data: store });
      if (action === 'set') {
        Object.keys(payload || {}).forEach((k) => { delete store[k]; });
        Object.assign(store, payload || {});
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({ ok: false, error: 'UNKNOWN_ACTION' });
    },
    _store: () => store,
  };
}

function load({ ls, bridge } = {}) {
  const listeners = {};
  const g = {
    localStorage: ls || makeLocalStorage(),
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    dispatchEvent: (ev) => { (listeners[ev.type] || []).forEach((fn) => fn(ev)); return true; },
    Event: function (type) { this.type = type; },
    console: { warn() {} },
    setTimeout, clearTimeout,
  };
  if (bridge) g.desktopWindow = { videoVault: bridge.videoVault };
  g.window = g;
  vm.runInNewContext(SRC, g);
  return { g, listeners };
}

test('空桶回填：本地无键 + vault 有值 → 写回 localStorage 并派发事件', async () => {
  const ls = makeLocalStorage();
  const br = makeBridge({ [K_LIB]: '[{"id":"a"}]', [K_WH]: '[]' });
  const { g, listeners } = load({ ls, bridge: br });
  await g.StellaflixVideo.vault.ready;
  assert.strictEqual(ls.getItem(K_LIB), '[{"id":"a"}]');
  assert.strictEqual(ls.getItem(K_WH), '[]');
  assert.ok((listeners['sfv:vault-restored'] || []).length === 1, '应注册并派发一次 restored 事件');
});

test('本地为准：两桶同键不同值 → 不覆盖本地，vault 被镜像成本地值', async () => {
  const ls = makeLocalStorage({ [K_LIB]: '[{"id":"local"}]' });
  const br = makeBridge({ [K_LIB]: '[{"id":"vault"}]' });
  const { g } = load({ ls, bridge: br });
  await g.StellaflixVideo.vault.ready;
  assert.strictEqual(ls.getItem(K_LIB), '[{"id":"local"}]');
  assert.strictEqual(br._store()[K_LIB], '[{"id":"local"}]', 'init 末尾无条件镜像应覆盖 vault');
});

test('清空不复活：本地键存在且为空数组 → 不回填', async () => {
  const ls = makeLocalStorage({ [K_LIB]: '[]' });
  const br = makeBridge({}); // vault 已被上次镜像清空
  const { g } = load({ ls, bridge: br });
  await g.StellaflixVideo.vault.ready;
  assert.strictEqual(ls.getItem(K_LIB), '[]');
});

test('防抖镜像：连续 mirror 只产生一次 set', async () => {
  const ls = makeLocalStorage({ [K_LIB]: '[]' });
  const br = makeBridge(null); br._store = () => ({});
  const { g } = load({ ls, bridge: br });
  await g.StellaflixVideo.vault.ready;
  const before = br.calls.filter((c) => c.action === 'set').length;
  g.StellaflixVideo.vault.mirror();
  g.StellaflixVideo.vault.mirror();
  g.StellaflixVideo.vault.mirror();
  await new Promise((r) => setTimeout(r, 1300));
  const after = br.calls.filter((c) => c.action === 'set').length;
  assert.strictEqual(after - before, 1, '3 次 mirror 合并为 1 次 set');
});

test('无桥降级：无 desktopWindow → ready 立即 resolve 且零 IPC', async () => {
  const { g } = load({ ls: makeLocalStorage() });
  const restored = await g.StellaflixVideo.vault.ready;
  assert.strictEqual(restored, false);
});

test('pagehide 强制 flush 未决镜像', async () => {
  const ls = makeLocalStorage({ [K_LIB]: '[{"id":"x"}]' });
  const br = makeBridge({});
  const { g, listeners } = load({ ls, bridge: br });
  await g.StellaflixVideo.vault.ready;
  const before = br.calls.filter((c) => c.action === 'set').length;
  g.StellaflixVideo.vault.mirror(); // 起防抖但不等
  (listeners['pagehide'] || []).forEach((fn) => fn());
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(br.calls.filter((c) => c.action === 'set').length >= before + 1, 'pagehide 应立即 set');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/video-vault.test.js`
Expected: FAIL（`data-vault.js` 不存在，readFileSync 抛 ENOENT）

- [ ] **Step 3: 实现 data-vault.js**

创建 `public/video/data-vault.js`：

```js
/*
 * Stellaflix 影视模块 — 用户数据 vault（镜像 + 空桶恢复）
 *
 * localStorage 按 origin 隔离，端口跳变(3000→3001)会让全部影视用户数据"消失"。
 * 本模块把 KEYS 快照镜像到 userData/video-vault.json（经 desktopWindow.videoVault 桥），
 * 启动时仅当本地键完全不存在才从 vault 回填（主动清空不复活）。
 * 无桌面桥（浏览器直开）时整体 no-op，行为与引入前一致。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  var KEYS = [
    'stellaflix-video-progress',
    'stellaflix-video-library',
    'stellaflix-video-history',
    'stellaflix-video-flag',
    'stellaflix-video-meta',
    'stellaflix-video-track',
    'stellaflix-video-failure-log',
    'stellaflix-watch-history-v2',
    'stellaflix:library:lastPoster'
  ];
  var DEBOUNCE_MS = 1000;
  var READY_TIMEOUT_MS = 1500;

  function bridge() {
    return (global.desktopWindow && typeof global.desktopWindow.videoVault === 'function')
      ? global.desktopWindow.videoVault : null;
  }

  function snapshot() {
    var out = {};
    for (var i = 0; i < KEYS.length; i++) {
      var raw = null;
      try { raw = global.localStorage.getItem(KEYS[i]); } catch (e) { raw = null; }
      if (raw != null) out[KEYS[i]] = raw;
    }
    return out;
  }

  var timer = null;

  function flush() {
    var call = bridge();
    if (!call) return Promise.resolve(false);
    return call('set', snapshot())
      .then(function (r) { return !!(r && r.ok); })
      .catch(function (e) {
        if (global.console) global.console.warn('[SFV.vault] flush failed:', e && e.message);
        return false;
      });
  }

  function mirror() {
    if (!bridge()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { timer = null; flush(); }, DEBOUNCE_MS);
  }

  function init() {
    var call = bridge();
    if (!call) return Promise.resolve(false);
    var work = call('get', null).then(function (res) {
      var vault = (res && res.ok && res.data && typeof res.data === 'object' && !Array.isArray(res.data)) ? res.data : null;
      var restored = false;
      if (vault) {
        for (var i = 0; i < KEYS.length; i++) {
          var k = KEYS[i];
          var local = null;
          try { local = global.localStorage.getItem(k); } catch (e) { local = null; }
          if (local == null && typeof vault[k] === 'string') {
            try { global.localStorage.setItem(k, vault[k]); restored = true; } catch (e) { /* 配额等失败保持本地现状 */ }
          }
        }
      }
      if (restored && global.dispatchEvent) {
        try { global.dispatchEvent(new global.Event('sfv:vault-restored')); } catch (e) { /* ignore */ }
      }
      // 无条件镜像一次：首次建档与换桶收敛共用此步
      return flush().then(function () { return restored; });
    }).catch(function () { return false; });
    return new Promise(function (resolve) {
      var settled = false;
      var t = setTimeout(function () { if (!settled) { settled = true; resolve(false); } }, READY_TIMEOUT_MS);
      work.then(function (v) { if (!settled) { settled = true; clearTimeout(t); resolve(v); } });
    });
  }

  if (global.addEventListener) {
    global.addEventListener('pagehide', function () {
      if (timer) { clearTimeout(timer); timer = null; }
      flush();
    });
  }

  SFV.vault = { KEYS: KEYS, ready: init(), mirror: mirror, flush: flush };
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/video-vault.test.js`
Expected: 6 pass / 0 fail

- [ ] **Step 5: 提交（见全局提交纪律）**

```bash
git add public/video/data-vault.js tests/video-vault.test.js
git commit -m "feat: 影视 vault Task1 — data-vault 模块（空桶回填+防抖镜像+无桥降级）"
```

---

### Task 2: 主进程 IPC + preload 桥

**Files:**
- Modify: `desktop/main.js`（在 `stellaflix-poster-cache` handler 结束处 L5349 之后插入）
- Modify: `desktop/preload.js:152`（`posterCache:` 行之后）

**Interfaces:**
- Consumes: 无（新代码）。
- Produces: `window.desktopWindow.videoVault('get'|'set', payload?) -> Promise<{ok,data?}|{ok:false,error}>`；文件 = `path.join(app.getPath('userData'), 'video-vault.json')`，内容 = `{ [lsKey]: string }`。Task 1 的假桥即此契约。

- [ ] **Step 1: main.js 新增 handler**

在 `desktop/main.js` L5349（`stellaflix-poster-cache` 的 `});` 与嗅探段注释之间）插入：

```js
// 影视态用户数据 vault：localStorage 按 origin 隔离、端口跳变即换桶 → 定期整包镜像到
// userData 文件，启动时由渲染层 data-vault.js 做空桶回填。仿 poster-cache 文件桥模式。
const VIDEO_VAULT_FILE = path.join(app.getPath('userData'), 'video-vault.json');
ipcMain.handle('stellaflix-video-vault', async (event, action, payload) => {
  try {
    if (action === 'get') {
      try {
        const text = await fs.promises.readFile(VIDEO_VAULT_FILE, 'utf8');
        const all = JSON.parse(text);
        return { ok: true, data: (all && typeof all === 'object' && !Array.isArray(all)) ? all : null };
      } catch (e) {
        return { ok: true, data: null }; // 不存在/损坏 → 视为无 vault，下次 flush 自愈
      }
    }
    if (action === 'set') {
      const all = (payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload : {};
      const clean = {};
      for (const k of Object.keys(all)) { if (typeof all[k] === 'string') clean[k] = all[k]; }
      const tmp = VIDEO_VAULT_FILE + '.tmp';
      await fs.promises.writeFile(tmp, JSON.stringify(clean), 'utf8');
      await fs.promises.rename(tmp, VIDEO_VAULT_FILE);
      return { ok: true };
    }
    return { ok: false, error: 'UNKNOWN_ACTION' };
  } catch (e) {
    return { ok: false, error: e.message || 'VIDEO_VAULT_FAILED' };
  }
});
```

- [ ] **Step 2: preload.js 暴露桥**

在 `desktop/preload.js` `posterCache:` 行（L152）之后插入：

```js
  videoVault: (action, payload) => ipcRenderer.invoke('stellaflix-video-vault', action, payload || null),
```

- [ ] **Step 3: 语法校验**

Run: `node --check desktop/main.js && node --check desktop/preload.js`
Expected: 无输出、退出码 0
（Electron 主进程/preload 无法在纯 node 单测加载，此处以语法校验 + Task 4 真机验收覆盖——与 poster-cache 同款桥的既有验证方式一致，有来源：main.js:5303 无对应单测。）

- [ ] **Step 4: 提交**

```bash
git add desktop/main.js desktop/preload.js
git commit -m "feat: 影视 vault Task2 — stellaflix-video-vault IPC（原子写）+ preload 桥"
```

---

### Task 3: 挂钩接线（写路径镜像 + 启动时序 + 重绘）

**Files:**
- Modify: `public/video/model.js:69-76`（writeJSON）
- Modify: `public/video/watch-history.js:161-163`（writeAll）
- Modify: `public/video/poster-wall/hex-wall.js:337-347`（publishFocusedPoster）
- Modify: `public/index.html`（SFV_SCRIPTS 数组，`"video/poster-cache.js"` 之后）
- Modify: `public/video/home.js:1218-1236`（boot）
- Modify: `public/video/home-cards.js`（文件末尾 SFV.homeCards 导出附近）
- Test: `tests/video-vault-hooks.test.js`

**Interfaces:**
- Consumes: Task 1 的 `SFV.vault.mirror()` / `SFV.vault.ready`。
- Produces: 写路径变更后 1s 内 vault 落盘；首页首帧渲染前已等待回填（≤1500ms）。

- [ ] **Step 1: 写失败测试（挂钩行为）**

创建 `tests/video-vault-hooks.test.js`：

```js
'use strict';
// 挂钩点测试：model.writeJSON / watch-history.writeAll 触发 vault.mirror。
// 运行：node --test tests/video-vault-hooks.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeLocalStorage(initial) {
  const data = Object.assign({}, initial || {});
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
  };
}

function loadModel(ls, vaultStub) {
  const g = {
    localStorage: ls, console: { warn() {} },
    setTimeout, clearTimeout,
    document: { addEventListener() {}, querySelector() { return null; } },
  };
  g.window = g;
  if (vaultStub) g.StellaflixVideo = { vault: vaultStub };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'video', 'model.js'), 'utf8'), g);
  return g.StellaflixVideo.model;
}

test('model 写库触发 vault.mirror', () => {
  let n = 0;
  const model = loadModel(makeLocalStorage(), { mirror() { n += 1; } });
  model.addToLibrary({ id: 'url:a', title: 'A' });
  assert.ok(n >= 1, 'writeJSON 应调用 SFV.vault.mirror()');
});

test('无 vault（浏览器直开）时 model 写入不报错', () => {
  const model = loadModel(makeLocalStorage(), null);
  assert.doesNotThrow(() => model.addToLibrary({ id: 'url:b', title: 'B' }));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/video-vault-hooks.test.js`
Expected: 第 1 条 FAIL（mirror 未被调用）；第 2 条可能已通过（no-op 也要保留断言）。

- [ ] **Step 3: 实施六处接线**

3a. `public/video/model.js` writeJSON（L69）改为：

```js
  function writeJSON(key, val) {
    try {
      global.localStorage.setItem(key, JSON.stringify(val));
      if (SFV.vault) SFV.vault.mirror();
      return true;
    } catch (e) {
      return false;
    }
  }
```

3b. `public/video/watch-history.js` writeAll（L161）改为：

```js
  function writeAll(arr) {
    try { LS.setItem(KEY, JSON.stringify(arr)); if (SFV.vault) SFV.vault.mirror(); return true; } catch (e) { return false; }
  }
```

（已核实：watch-history.js:36 与 hex-wall.js:10 作用域内均有 `var SFV = (global.StellaflixVideo = global.StellaflixVideo || {})`，可直接引用 `SFV.vault`。）

3c. `public/video/poster-wall/hex-wall.js` publishFocusedPoster 的 try 块 `setItem(...)` 之后同一 try 内追加：

```js
      if (SFV.vault) SFV.vault.mirror();
```

3d. `public/index.html` SFV_SCRIPTS：`"video/poster-cache.js",` 之后插入 `"video/data-vault.js",`（必须早于 `"video/model.js"`）。

3e. `public/video/home.js` boot（L1218-1236）改为等待 vault 回填（不阻塞超时）：

```js
  function boot() {
    // 先异步加载持久化海报 + 等待数据 vault 回填（1.5s 内部超时兜底），
    // 确保首次渲染时自定义海报与换桶回填的数据已就绪；任一失败都不阻塞安装。
    var vaultReady = (SFV.vault && SFV.vault.ready) ? SFV.vault.ready : Promise.resolve(false);
    Promise.all([loadPosterStore(), vaultReady]).then(function () {
      var doc = d();
      if (doc && doc.readyState === 'loading' && doc.addEventListener) {
        doc.addEventListener('DOMContentLoaded', install);
      } else {
        install();
      }
    }, function () {
      var doc = d();
      if (doc && doc.readyState === 'loading' && doc.addEventListener) {
        doc.addEventListener('DOMContentLoaded', install);
      } else {
        install();
      }
    });
  }
  boot();
```

3f. `public/video/home-cards.js` 在 `SFV.homeCards = {` 导出语句之前追加：

```js
  // 换桶回填若晚于首帧（ready 超时路径），回填完成后重绘一次卡片
  if (global.addEventListener) {
    global.addEventListener('sfv:vault-restored', function () {
      if (SFV.home && typeof SFV.home.render === 'function') { try { SFV.home.render(); } catch (e) { /* ignore */ } }
    });
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/video-vault-hooks.test.js`
Expected: 2 pass

- [ ] **Step 5: 打包 + 全量回归**

```bash
npm run bundle
npm test
```
Expected: bundle 成功；npm test 结果不劣于基线 148/149（不得新增失败）。

- [ ] **Step 6: 提交**

```bash
git add public/video/model.js public/video/watch-history.js public/video/poster-wall/hex-wall.js public/index.html public/video/home.js public/video/home-cards.js tests/video-vault-hooks.test.js
git commit -m "feat: 影视 vault Task3 — 写路径镜像钩子+boot 等待回填+restored 重绘"
```

---

### Task 4: 真机验收（主人执行，agent 陪同取证）

**Files:** 无代码改动（如验收暴露 bug，回到对应 Task 修复后重跑）。

**Interfaces:**
- Consumes: Task 1-3 全部产物。
- Produces: 验收记录（写入本计划文件勾选 + 项目记忆）。

- [ ] **Step 1: 环境复位**

杀掉残留 `node server.js`（10-01 取证：PID 4360 类进程；`netstat -ano | grep :3000` 确认 3000 空闲），关闭桌面应用后重启。

- [ ] **Step 2: 回归 3000 验收**

预期：`startup-state.json` 显示 port 3000；首页五卡/今日观看数据原样在；`%APPDATA%\Stellaflix/video-vault.json` 生成且含 9 键快照。

- [ ] **Step 3: 换桶自愈验收**

故意占 3000（`node server.js` 后台跑）→ 重启应用落 3001 → 预期 ≤1.5s 内首页数据完整回填；`video-vault.json` 未被 3001 空桶覆盖（因回填先于镜像，本地=回填后数据）。

- [ ] **Step 4: 单向收养预期确认（终审修订 2026-10-01）**

在 3001 桶新增一条追片 → 等 ≥1s（vault 应含该追片）→ 重启落回 3000：本地键存在 → 本地为准，3001 期间的新追片不回潮、vault 收敛为 3000 现状。此行为属预期（裁决：本期仅保证单向收养，不做逐键时效合并）。验收通过标准 = vault 文件存在且内容 = 当前桶 9 键快照，页面数据与 3000 桶本地一致、无报错。

- [ ] **Step 5: 清空不复活验收**

清空历史（历史页删除全部）→ 等 ≥1s → 重启 → 历史保持为空。

- [ ] **Step 6: 浏览器降级验收**

Chrome 直开 `http://localhost:3000` → 无 `desktopWindow.videoVault`，功能正常、console 无 vault 报错。

- [ ] **Step 7: 记录结果**

验收通过后在记忆 `project-video-data-vault.md` 更新状态；待主人明示"提交/推送"再做后续 git 操作。

---

## Self-Review 记录

- Spec 覆盖：§4.1→T2S1，§4.2→T2S2，§4.3→T1，§4.4 五挂钩→T3S3a-f，§4.5→T3S5，§6 测试→T1/T3（损坏自愈走查在 T1 'get 返回 null' 分支 + T2S1 catch），§7 真机→T4。无遗漏。
- 占位符扫描：无 TBD/类似上文；所有代码块完整可抄。
- 类型一致性：`videoVault(action,payload)`、`SFV.vault.{KEYS,ready,mirror,flush}`、事件 `sfv:vault-restored`、文件 `video-vault.json` 在 T1/T2/T3/T4 全文一致。
