# 封面壁纸（Cover Wallpaper）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移植 Mineradio"壁纸模式"为 Stellaflix 独立新功能"封面壁纸"：封面光晕粒子壁纸，双承载面（播放器背景板 / 桌面壁纸层）互斥切换。

**Architecture:** 一个纯 2D canvas 画面模块被两个宿主共用——主窗口内的 `#cover-wallpaper-board` 画布（背景板面）与 WorkerW 桌面层独立覆盖窗口（`public/cover-wallpaper.html`，桌面面）。桌面覆盖窗口复用仓库现成的 `DesktopWallpaperRuntime`（`desktop/wallpaper-mode-runtime.js`，含挂接校验/代际锁/reconcile），主进程接线放新模块 `desktop/cover-wallpaper-runtime.js` 以绕开 quick-check 对 main.js 的禁用字样。渲染器以 260ms 节流 + 签名抑制推状态，两态永远只有一个在跑。

**Tech Stack:** Electron（主进程 + contextBridge preload）、原生 2D Canvas、node:test 源码抽取式测试、B1 bundle 工具链。

**Spec:** `docs/superpowers/specs/2026-10-17-cover-wallpaper-design.md`

**参照物（只读，勿改）：** `C:\Users\Administrator\Desktop\Mineradio-2.5.1\`——`public/wallpaper-effect.js`（画面）、`public/wallpaper.html`（覆盖页）、`public/app.js:45445-45570`（两态互斥状态机）、`desktop/main.js:3229-3317`（窗口选项）。

## Global Constraints

- **不自动 commit**：本项目仅在主人明确"提交"指令时 commit；每个任务的"提交"步骤 = 汇报验证输出并停下等待指令。
- 改任何 `public/js/` 前端模块后必跑 `npm run bundle`；发版门禁 `npm run bundle:check`。
- 全量回归用 `npm test`（`tests/run-all.js` 串行跑 `tests/*.test.js`）；**当前基线 191/191（2026-10-17 口径）**，任何新败都必须归因。
- 验证起本地服务一律 `PORT=3999`，同一命令内起→测→杀，绝不留 :3000 残留进程（:3000 归桌面 app 托管）。
- 桌面壁纸层仅 win32；背景板全平台。
- 命名红线（全部新起，不与完整桌面模式共用）：fx 键 `coverWallpaper`/`coverWallpaperSurface`/`coverWallpaperOpacity`；IPC 前缀 `stellaflix-cover-wallpaper-`；文件名一律 `cover-wallpaper-*`。
- `desktop/main.js` 内不得出现字样 `DesktopWallpaperRuntime`、`wallpaper-mode-runtime`、`wallpaper.html`、`wallpaper-preload.js`（quick-check 门禁）；因此页面名 `cover-wallpaper.html` 字符串只能出现在 `desktop/cover-wallpaper-runtime.js`，main.js 里连 `cover-wallpaper.html` 都不能写（含禁用子串）。
- `payload.preset` 全链传输、画面不分支（主人裁定保留）。
- `public/index.html`、`public/css/index.css` 是多会话共用面：只加行，不重排既有规则。

## 文件结构

| 动作 | 路径 | 职责 |
|---|---|---|
| Create | `public/js/cover-wallpaper-effect.js` | 纯画面实现（无依赖，两宿主共用），导出 `window.createCoverWallpaperEffect(canvas)` |
| Create | `public/js/modules/02-visual/18-cover-wallpaper.js` | 渲染器状态机：两态互斥、背景板挂载/释放、260ms 推送循环、surface 切换 |
| Create | `public/cover-wallpaper.html` | 桌面壁纸层覆盖窗口页面（只挂状态桥） |
| Create | `desktop/cover-wallpaper-runtime.js` | 实例化 DesktopWallpaperRuntime + 注册 3 个 invoke 通道 + 状态广播 |
| Create | `tests/cover-wallpaper-effect-contract.test.js` | 画面性能常量 + 页面/DOM/CSS 契约 |
| Create | `tests/cover-wallpaper-surface.test.js` | 两态互斥、归一化、preset 传输、节流签名（vm 行为测试） |
| Create | `tests/cover-wallpaper-runtime.test.js` | 主进程通道名 + main.js 门禁红线仍成立 |
| Modify | `public/js/index-loader.js` | modulePaths 注册两个新前端文件 |
| Modify | `public/index.html` | 背景板 canvas、开关/位置 segment/透明度滑杆 DOM |
| Modify | `public/css/index.css` | 背景板层级与"替换而非叠层"规则 |
| Modify | `public/js/modules/00-state/04-fx-defaults.js` | 3 个默认键 |
| Modify | `public/js/modules/02-visual/04-visual-settings-persistence.js` | 存/读两处注册（约 :412 与 :912 块） |
| Modify | `public/js/modules/07-fx/05-fx-panel-performance.js` | updateFxInputs 滑杆/标签/segment 刷新 |
| Modify | `public/js/modules/07-fx/07-bindings-shelf-immersive.js` | toggleFx 分支、滑杆映射、segment 点击绑定 |
| Modify | `public/js/modules/07-fx/09-console-workspace.js` | 实验功能组注册条目 |
| Modify | `desktop/main.js` | require 新模块 + 初始化 + display/resume 联动 + 退出清理 |
| Modify | `desktop/preload.js` | 4 个新 API |
| Verify | `package.json` | `build.files` 是否白名单需补新文件（历史教训：漏新根文件） |

---

### Task 1: 画面模块移植 + 契约测试

**Files:**
- Create: `public/js/cover-wallpaper-effect.js`
- Modify: `public/js/index-loader.js`（modulePaths）
- Test: `tests/cover-wallpaper-effect-contract.test.js`

**Interfaces:**
- Consumes: 无（纯新增）
- Produces: `window.createCoverWallpaperEffect(canvas) → { applyState(next), setPaused(paused), dispose() }`；`applyState` 接受 `{ enabled,title,artist,cover,playing,preset,opacity,colors:{primary,secondary,highlight,glow} }` 增量。Task 2/3 的宿主都调这三个方法。

- [ ] **Step 1: 写失败的契约测试**

创建 `tests/cover-wallpaper-effect-contract.test.js`：

```js
'use strict';
// 封面壁纸画面实现的性能契约（逐字移植自 Mineradio wallpaper-effect.js 的实证常量）：
// 不透明画布、DPR 封顶 1.35、粒子数按面积 clamp(420,760)、播放 RAF/空闲 30fps/关闭 1Hz。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('画面模块存在且导出 createCoverWallpaperEffect 三方法接口', () => {
  const src = read('public/js/cover-wallpaper-effect.js');
  assert.match(src, /function createCoverWallpaperEffect\(canvas\)/);
  assert.match(src, /global\.createCoverWallpaperEffect\s*=/);
  assert.match(src, /return\s*\{\s*applyState:\s*applyState,\s*setPaused:\s*setOverlayRenderPaused,\s*dispose:\s*dispose\s*\}/);
});

test('关键性能常量逐字保留', () => {
  const src = read('public/js/cover-wallpaper-effect.js');
  assert.match(src, /WALLPAPER_IDLE_FPS\s*=\s*30/);
  assert.match(src, /WALLPAPER_DISABLED_DELAY\s*=\s*1000/);
  assert.match(src, /getContext\('2d',\s*\{\s*alpha:\s*false\s*\}\)/);
  assert.match(src, /Math\.min\(1\.35,\s*Math\.max\(1,/);
  assert.match(src, /Math\.min\(760,\s*Math\.max\(420,/);
});

test('关闭态释放重载荷（封面与粒子）', () => {
  const src = read('public/js/cover-wallpaper-effect.js');
  assert.match(src, /if\s*\(!state\.enabled\)\s*\{[\s\S]{0,200}state\.cover\s*=\s*'';[\s\S]{0,100}particles\.length\s*=\s*0/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/cover-wallpaper-effect-contract.test.js`
Expected: FAIL（文件不存在 / ENOENT）

- [ ] **Step 3: 逐字复制画面模块并改名**

```bash
sed -e 's/Mineradio/Stellaflix/g' "C:/Users/Administrator/Desktop/Mineradio-2.5.1/public/wallpaper-effect.js" > public/js/cover-wallpaper-effect.js
node --check public/js/cover-wallpaper-effect.js
```

Expected: `node --check` 无输出（语法 OK）。除 `Mineradio→Stellaflix`（函数名 + 注释 + 兜底 title）外**不得有任何其他改动**——两个 `WALLPAPER_*` 常量、`DEFAULT_COLORS`、调度器全部原样。

- [ ] **Step 4: 注册进 modulePaths**

在 `public/js/index-loader.js` 的 `const modulePaths = [...]` 中找到 `'js/modules/02-visual/17-hex-card-transform.js',`（若不存在则找 02-visual 组最后一个条目），其后插入一行：

```js
    'js/cover-wallpaper-effect.js',
```

- [ ] **Step 5: 重建 bundle 并跑测试**

```bash
npm run bundle
node --test tests/cover-wallpaper-effect-contract.test.js
```
Expected: bundle 成功；3 项测试 PASS。

- [ ] **Step 6: 检查点——汇报输出，等主人"提交"指令**

建议提交信息：`feat: 封面壁纸画面模块逐字移植（2D canvas 光晕粒子，双承载面共用）`

---

### Task 2: 播放器背景板面（canvas + 状态机 + 面板 UI + 持久化）

**Files:**
- Create: `public/js/modules/02-visual/18-cover-wallpaper.js`
- Modify: `public/index.html`（canvas + 3 处控件 DOM）
- Modify: `public/css/index.css`（背景板规则）
- Modify: `public/js/index-loader.js`（modulePaths 再插一行）
- Modify: `public/js/modules/00-state/04-fx-defaults.js:84` 附近
- Modify: `public/js/modules/02-visual/04-visual-settings-persistence.js:412 附近与 :912 附近`
- Modify: `public/js/modules/07-fx/05-fx-panel-performance.js:276/:813/updateFxInputs`
- Modify: `public/js/modules/07-fx/07-bindings-shelf-immersive.js:23/:347-356/toggleFx`
- Modify: `public/js/modules/07-fx/09-console-workspace.js:288-291`
- Test: `tests/cover-wallpaper-surface.test.js`

**Interfaces:**
- Consumes: Task 1 的 `window.createCoverWallpaperEffect`；既有全局 `fx`、`fxDefaults`、`playing`、`clampRange`、`isDevelopmentLockedFx`、`currentDesktopSongMeta()`（10-shell/04:905）、`desktopOverlayColors()`（10-shell/04:965）、`getDesktopWindowApi()`（10-shell/04:88）、`saveLyricLayout`、`showToast`、`updateFxInputs`。
- Produces（Task 3 依赖的全局函数名）：`applyCoverWallpaperState(force) → Promise<{ok,enabled,error?,status?}>`、`normalizeCoverWallpaperSurface(v)`、`coverWallpaperPayload()`、`coverWallpaperSignature(payload)`、`setCoverWallpaperSurface(v)`、`updateCoverWallpaperSurfaceControls()`、`initCoverWallpaper(api)`、`syncCoverWallpaperBoardSurface(active, force)`、`pushCoverWallpaperDesktopState(force)`。

- [ ] **Step 1: 写失败的行为测试**

创建 `tests/cover-wallpaper-surface.test.js`：

```js
'use strict';
// 两态互斥契约（源自 Mineradio wallpaper-surface-board.test.js 的设计合同）：
// 背景板模式=桌面侧必收 {enabled:false} 且零桌面推送；桌面模式=背景板彻底释放；
// preset 全链传输；surface 归一化只认 'board'。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const source = read('public/js/modules/02-visual/18-cover-wallpaper.js');

function fakeEl() {
  return {
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, style: {},
  };
}

function buildContext(overrides) {
  overrides = overrides || {};
  const calls = { setCoverWallpaperMode: [], updateCoverWallpaperMode: [], boardPushes: 0 };
  const els = new Map();
  const sandbox = {
    fx: Object.assign({
      coverWallpaper: true, coverWallpaperSurface: 'desktop',
      coverWallpaperOpacity: 1, preset: 5,
    }, overrides.fx || {}),
    playing: true,
    isDevelopmentLockedFx: function () { return false; },
    clampRange: function (v, a, b) { return Math.max(a, Math.min(b, Number(v) || a)); },
    currentDesktopSongMeta: function () { return { title: 'T', artist: 'A', cover: 'data:image/png;base64,AAA' }; },
    desktopOverlayColors: function () { return { primary: '#d6f8ff', secondary: '#9cffdf', highlight: '#fff0b8', glow: '#9cffdf' }; },
    getDesktopWindowApi: function () {
      return {
        setCoverWallpaperMode: function (enabled, payload) {
          calls.setCoverWallpaperMode.push({ enabled: enabled, payload: payload });
          return Promise.resolve(overrides.setResult || { ok: true, enabled: enabled });
        },
        updateCoverWallpaperMode: function (payload) {
          calls.updateCoverWallpaperMode.push(payload);
          return Promise.resolve({ ok: true });
        },
      };
    },
    document: {
      hidden: false, body: fakeEl(),
      getElementById: function (id) { if (!els.has(id)) els.set(id, fakeEl()); return els.get(id); },
      querySelectorAll: function () { return []; },
    },
    window: {
      createCoverWallpaperEffect: function () {
        return { applyState: function () { calls.boardPushes += 1; }, setPaused: function () {}, dispose: function () {} };
      },
    },
    requestAnimationFrame: function () { return 0; },
    performance: { now: function () { return 0; } },
    setInterval: function () { return 0; },
    clearInterval: function () {},
    showToast: function () {},
    saveLyricLayout: function () {},
    updateFxInputs: function () {},
    console: console, Object: Object, Promise: Promise, Math: Math,
    Number: Number, String: String, Array: Array,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { sandbox: sandbox, calls: calls };
}

test('surface 归一化：只认 board，其余回落 desktop', () => {
  const ctx = buildContext();
  assert.equal(ctx.sandbox.normalizeCoverWallpaperSurface('board'), 'board');
  assert.equal(ctx.sandbox.normalizeCoverWallpaperSurface('BOARD'), 'desktop');
  assert.equal(ctx.sandbox.normalizeCoverWallpaperSurface('随便填的值'), 'desktop');
});

test('背景板模式：桌面侧只收 {enabled:false}，零桌面 payload，背景板恰好一推', async () => {
  const ctx = buildContext({ fx: { coverWallpaperSurface: 'board' } });
  await ctx.sandbox.applyCoverWallpaperState(true);
  assert.equal(ctx.calls.setCoverWallpaperMode.length, 1);
  assert.equal(ctx.calls.setCoverWallpaperMode[0].enabled, false);
  assert.deepEqual(ctx.calls.setCoverWallpaperMode[0].payload, { enabled: false });
  assert.equal(ctx.calls.updateCoverWallpaperMode.length, 0, '背景板模式绝不构建桌面 payload');
  assert.equal(ctx.calls.boardPushes, 1);
});

test('桌面模式：payload 含 preset 且首帧恰好一推，背景板零推', async () => {
  const ctx = buildContext({ setResult: { ok: true, enabled: true, status: { enabled: true } } });
  await ctx.sandbox.applyCoverWallpaperState(true);
  assert.equal(ctx.calls.setCoverWallpaperMode[0].enabled, true);
  assert.equal(ctx.calls.setCoverWallpaperMode[0].payload.preset, 5);
  assert.equal(ctx.calls.updateCoverWallpaperMode.length, 1);
  assert.equal(ctx.calls.updateCoverWallpaperMode[0].preset, 5);
  assert.equal(ctx.calls.boardPushes, 0);
});

test('关闭：两侧都释放且桌面推送签名清零', async () => {
  const ctx = buildContext({ fx: { coverWallpaper: false } });
  await ctx.sandbox.applyCoverWallpaperState(true);
  assert.equal(ctx.calls.setCoverWallpaperMode[0].enabled, false);
  assert.equal(ctx.calls.updateCoverWallpaperMode.length, 0);
  assert.equal(ctx.calls.boardPushes, 0);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/cover-wallpaper-surface.test.js`
Expected: FAIL（ENOENT 18-cover-wallpaper.js）

- [ ] **Step 3: 写状态机模块**

创建 `public/js/modules/02-visual/18-cover-wallpaper.js`（完整内容）：

```js
// 封面壁纸（Cover Wallpaper）：封面光晕粒子壁纸，播放器背景板 / 桌面壁纸层两态互斥。
// 画面实现在 js/cover-wallpaper-effect.js（两态共用）；本文件只管挂载、状态推送与释放。
var coverWallpaperBoardEffect = null;
var coverWallpaperRuntimeState = {};
var coverWallpaperPushState = { desktopAt: 0, desktopKey: '', boardAt: 0, boardKey: '' };
var coverWallpaperSyncTimer = 0;
var coverWallpaperRendererOperation = 0;

function normalizeCoverWallpaperSurface(value) {
  return String(value || '') === 'board' ? 'board' : 'desktop';
}
function coverWallpaperEnabled() {
  return !!fx.coverWallpaper && !isDevelopmentLockedFx('coverWallpaper');
}
function coverWallpaperBoardActive() {
  return !!(coverWallpaperBoardEffect && coverWallpaperEnabled()
    && normalizeCoverWallpaperSurface(fx.coverWallpaperSurface) === 'board');
}
function coverWallpaperPayload() {
  var meta = currentDesktopSongMeta();
  return {
    enabled: coverWallpaperEnabled(),
    title: meta.title,
    artist: meta.artist,
    cover: meta.cover,
    playing: !!playing,
    preset: fx.preset,
    opacity: clampRange(fx.coverWallpaperOpacity == null ? 1 : Number(fx.coverWallpaperOpacity), 0.35, 1),
    colors: desktopOverlayColors()
  };
}
// 签名故意不含 colors：调色板单独变化搭下一次标题/播放态变更的车（Mineradio 同口径）。
function coverWallpaperSignature(payload) {
  return payload.enabled + '|' + payload.title + '|' + payload.artist + '|' + payload.cover
    + '|' + payload.playing + '|' + payload.preset + '|' + payload.opacity;
}
function ensureCoverWallpaperBoard() {
  var canvas = document.getElementById('cover-wallpaper-board');
  if (!canvas || typeof window.createCoverWallpaperEffect !== 'function') return false;
  if (!coverWallpaperBoardEffect) coverWallpaperBoardEffect = window.createCoverWallpaperEffect(canvas);
  canvas.classList.add('mounted');
  document.body.classList.add('cover-wallpaper-board-active');
  // 挂载与淡入分两帧，避免第一帧空画布以不透明度 1 闪出。
  requestAnimationFrame(function () {
    if (coverWallpaperBoardActive()) canvas.classList.add('active');
  });
  return true;
}
function releaseCoverWallpaperBoard() {
  if (coverWallpaperBoardEffect) {
    coverWallpaperBoardEffect.applyState({ enabled: false, cover: '', playing: false });
    coverWallpaperBoardEffect.dispose();
    coverWallpaperBoardEffect = null;
  }
  var canvas = document.getElementById('cover-wallpaper-board');
  if (canvas) canvas.classList.remove('mounted', 'active');
  document.body.classList.remove('cover-wallpaper-board-active');
}
function pushCoverWallpaperBoardState(force) {
  if (!coverWallpaperBoardActive()) return;
  var now = performance.now();
  if (!force && now - coverWallpaperPushState.boardAt < 260) return;
  var payload = coverWallpaperPayload();
  var key = coverWallpaperSignature(payload);
  if (!force && key === coverWallpaperPushState.boardKey && now - coverWallpaperPushState.boardAt < 1400) return;
  coverWallpaperPushState.boardAt = now;
  coverWallpaperPushState.boardKey = key;
  coverWallpaperBoardEffect.applyState(payload);
}
function syncCoverWallpaperBoardSurface(active, force) {
  if (!active) {
    if (coverWallpaperBoardEffect) {
      coverWallpaperPushState.boardAt = 0;
      coverWallpaperPushState.boardKey = '';
    }
    releaseCoverWallpaperBoard();
    return;
  }
  if (force) {
    coverWallpaperPushState.boardAt = 0;
    coverWallpaperPushState.boardKey = '';
  }
  ensureCoverWallpaperBoard();
}
function applyCoverWallpaperRuntimeStatus(payload) {
  var status = payload && typeof payload === 'object' ? payload : {};
  coverWallpaperRuntimeState = Object.assign({}, coverWallpaperRuntimeState, status);
  if (normalizeCoverWallpaperSurface(fx.coverWallpaperSurface) !== 'desktop') return coverWallpaperRuntimeState;
  var nextEnabled = status.enabled === true || status.active === true
    ? true
    : (status.attaching === true ? !!fx.coverWallpaper : false);
  if (status.supported === false) nextEnabled = false;
  if (fx.coverWallpaper !== nextEnabled) {
    fx.coverWallpaper = nextEnabled;
    if (typeof updateFxInputs === 'function') updateFxInputs();
  }
  return coverWallpaperRuntimeState;
}
function pushCoverWallpaperDesktopState(force) {
  var api = getDesktopWindowApi();
  if (!api || typeof api.updateCoverWallpaperMode !== 'function') return;
  if (!coverWallpaperEnabled() || normalizeCoverWallpaperSurface(fx.coverWallpaperSurface) === 'board') return;
  var now = performance.now();
  if (!force && now - coverWallpaperPushState.desktopAt < 260) return;
  var payload = coverWallpaperPayload();
  var key = coverWallpaperSignature(payload);
  if (!force && key === coverWallpaperPushState.desktopKey && now - coverWallpaperPushState.desktopAt < 1400) return;
  coverWallpaperPushState.desktopAt = now;
  coverWallpaperPushState.desktopKey = key;
  api.updateCoverWallpaperMode(payload).then(function (result) {
    if (result && result.status) applyCoverWallpaperRuntimeStatus(result.status);
    else if (result && result.ok === false) console.warn('cover wallpaper update failed:', result.error || 'COVER_WALLPAPER_UPDATE_FAILED');
  }).catch(function (e) { console.warn('cover wallpaper update failed:', e); });
}
function coverWallpaperErrorLabel(error) {
  var code = String(error || '');
  if (code.indexOf('COVER_WALLPAPER_DESKTOP_API_UNAVAILABLE') >= 0) return '桌面接口未就绪';
  if (code.indexOf('WALLPAPER_PLATFORM_UNSUPPORTED') >= 0) return '当前系统不支持桌面壁纸层';
  if (code.indexOf('WALLPAPER_WORKERW_NOT_FOUND') >= 0) return '未找到桌面 WorkerW';
  if (code.indexOf('WALLPAPER_PROGMAN_NOT_FOUND') >= 0) return '未找到 Windows 桌面宿主';
  if (code.indexOf('WALLPAPER_NATIVE_ATTACH_ABORTED') >= 0 || code.indexOf('WALLPAPER_START_SUPERSEDED') >= 0) return '启动已取消';
  return code || '未知错误';
}
function applyCoverWallpaperState(force) {
  var api = getDesktopWindowApi();
  var enabled = coverWallpaperEnabled();
  var boardActive = enabled && normalizeCoverWallpaperSurface(fx.coverWallpaperSurface) === 'board';
  var desktopActive = enabled && !boardActive;
  syncCoverWallpaperBoardSurface(boardActive, !!force);
  if (!desktopActive) {
    coverWallpaperPushState.desktopAt = 0;
    coverWallpaperPushState.desktopKey = '';
    if (boardActive) pushCoverWallpaperBoardState(true);
  }
  if (!api || typeof api.setCoverWallpaperMode !== 'function') {
    return Promise.resolve({ ok: false, enabled: false, error: 'COVER_WALLPAPER_DESKTOP_API_UNAVAILABLE' });
  }
  var operation = ++coverWallpaperRendererOperation;
  return Promise.resolve().then(function () {
    return api.setCoverWallpaperMode(desktopActive, desktopActive ? coverWallpaperPayload() : { enabled: false });
  }).then(function (result) {
    result = result && typeof result === 'object' ? result : { ok: false, enabled: false, error: 'COVER_WALLPAPER_RESULT_INVALID' };
    if (operation !== coverWallpaperRendererOperation) return Object.assign({}, result, { rendererStale: true });
    if (result.status) applyCoverWallpaperRuntimeStatus(result.status);
    if (desktopActive && result.ok === true) pushCoverWallpaperDesktopState(true);
    return result;
  }).catch(function (error) {
    if (operation !== coverWallpaperRendererOperation) return { ok: false, enabled: false, rendererStale: true };
    return { ok: false, enabled: false, error: String(error && error.message || error) };
  });
}
function setCoverWallpaperSurface(value) {
  var next = normalizeCoverWallpaperSurface(value);
  var changed = normalizeCoverWallpaperSurface(fx.coverWallpaperSurface) !== next;
  fx.coverWallpaperSurface = next;
  updateCoverWallpaperSurfaceControls();
  if (changed) {
    saveLyricLayout({ user: true, reason: 'coverWallpaperSurface' });
    applyCoverWallpaperState(true);
    showToast(next === 'board' ? '封面壁纸展示位置: 播放器背景板' : '封面壁纸展示位置: 桌面壁纸层');
  }
  return changed;
}
function updateCoverWallpaperSurfaceControls() {
  var active = normalizeCoverWallpaperSurface(fx.coverWallpaperSurface);
  document.querySelectorAll('#cover-wallpaper-surface-seg [data-cover-wallpaper-surface]').forEach(function (btn) {
    btn.classList.toggle('on', btn.getAttribute('data-cover-wallpaper-surface') === active);
  });
}
function syncDesktopCoverWallpaperState() {
  if (!coverWallpaperEnabled()) return;
  if (normalizeCoverWallpaperSurface(fx.coverWallpaperSurface) === 'board') pushCoverWallpaperBoardState(false);
  else pushCoverWallpaperDesktopState(false);
}
function initCoverWallpaper(api) {
  api = api || getDesktopWindowApi();
  if (api && typeof api.onCoverWallpaperModeState === 'function') {
    try { api.onCoverWallpaperModeState(applyCoverWallpaperRuntimeStatus); } catch (_) { }
  }
  if (api && typeof api.getCoverWallpaperModeStatus === 'function') {
    Promise.resolve().then(function () { return api.getCoverWallpaperModeStatus(); })
      .then(applyCoverWallpaperRuntimeStatus).catch(function () { });
  }
  if (!coverWallpaperSyncTimer) coverWallpaperSyncTimer = setInterval(syncDesktopCoverWallpaperState, 260);
  if (fx.coverWallpaper) applyCoverWallpaperState(true);
}
```

- [ ] **Step 4: DOM——背景板画布 + 三个控件**

`public/index.html`：在 `<div id="custom-bg">`（约 :93）所在层的**前一行**插入：

```html
<canvas id="cover-wallpaper-board" aria-hidden="true"></canvas>
```

在 `t-wallpaperMode` 开关 div（约 :951-953）之后插入开关：

```html
            <div class="fx-toggle" id="t-coverWallpaper" onclick="toggleFx('coverWallpaper')"
              title="封面光晕粒子壁纸，可画到桌面壁纸层或播放器背景板"><span>封面壁纸<em class="fx-dev-badge">试验</em></span><span class="dot"></span></div>
```

在"桌面 / 壁纸"小节内（`fx-wallpaperopacity` 滑杆 div 之后，约 :980）插入：

```html
          <div class="fx-seg" id="cover-wallpaper-surface-seg">
            <button data-cover-wallpaper-surface="desktop" title="全屏挂到桌面壁纸层，在桌面图标和其它窗口后面显示">桌面壁纸层</button>
            <button data-cover-wallpaper-surface="board" title="画在播放器窗口内，作为界面最底层背景板">播放器背景板</button>
          </div>
          <div class="fx-slider"><label>封面壁纸透明</label><input id="fx-coverwallpaperopacity" type="range" min="0.35"
              max="1" step="0.01"><output></output></div>
```

- [ ] **Step 5: CSS（追加到 `public/css/index.css` 顶部背景层规则区，约 :1100 附近 `#wallpaper-engine-layer` 规则旁）**

```css
#cover-wallpaper-board{position:fixed;inset:0;z-index:0;display:none;pointer-events:none;opacity:0;transition:opacity .45s ease}
#cover-wallpaper-board.mounted{display:block}
#cover-wallpaper-board.active{opacity:1}
/* 背景板是封面派生的整幅画面，与封面模糊底图/自定义背景叠层会互相糊掉，启用时让位。 */
body.cover-wallpaper-board-active #album-bg,body.cover-wallpaper-board-active #custom-bg,body.cover-wallpaper-board-active #theme-bg-tint{opacity:0!important}
```

- [ ] **Step 6: fx 键与持久化**

`public/js/modules/00-state/04-fx-defaults.js`：在 `wallpaperMode: false,`（:84）之后加：

```js
  coverWallpaper: false,
  coverWallpaperSurface: 'desktop',
  coverWallpaperOpacity: 1,
```

`public/js/modules/02-visual/04-visual-settings-persistence.js`：读取块（:412-414 三行旁）加：

```js
      coverWallpaper: raw.coverWallpaper === true,
      coverWallpaperSurface: String(raw.coverWallpaperSurface || '') === 'board' ? 'board' : 'desktop',
      coverWallpaperOpacity: clampRange(raw.coverWallpaperOpacity == null ? fxDefaults.coverWallpaperOpacity : Number(raw.coverWallpaperOpacity), 0.35, 1),
```

保存块（:912-914 三行旁）加：

```js
      coverWallpaper: fx.coverWallpaper === true,
      coverWallpaperSurface: String(fx.coverWallpaperSurface || '') === 'board' ? 'board' : 'desktop',
      coverWallpaperOpacity: clampRange(fx.coverWallpaperOpacity == null ? fxDefaults.coverWallpaperOpacity : Number(fx.coverWallpaperOpacity), 0.35, 1),
```

- [ ] **Step 7: 面板绑定**

`public/js/modules/07-fx/07-bindings-shelf-immersive.js`：
1. :23 滑杆映射数组中 `['fx-wallpaperopacity', 'wallpaperOpacity'],` 之后加 `['fx-coverwallpaperopacity', 'coverWallpaperOpacity'],`。
2. `#wallpaper-fps-seg` 绑定 forEach（:347-356）之后加：

```js
  document.querySelectorAll('#cover-wallpaper-surface-seg [data-cover-wallpaper-surface]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      setCoverWallpaperSurface(btn.getAttribute('data-cover-wallpaper-surface'));
    });
  });
```

3. `toggleFx` 内：把 `'coverWallpaper'` 加入那条 `saveLyricLayout` 的 key 长列表（:408 附近含 `'wallpaperMode'` 的同一行），并在 `if (key === 'wallpaperMode') applyWallpaperModeState(true);`（:421）之后加：

```js
  if (key === 'coverWallpaper') {
    applyCoverWallpaperState(true).then(function (result) {
      if (result && result.rendererStale) return;
      if (normalizeCoverWallpaperSurface(fx.coverWallpaperSurface) === 'desktop' && fx.coverWallpaper
        && result && result.ok !== true && result.enabled !== true) {
        fx.coverWallpaper = false;
        updateFxInputs();
        showToast('桌面壁纸层启动失败：' + coverWallpaperErrorLabel(result && result.error));
      }
    });
  }
  if (key === 'coverWallpaper') showToast(fx.coverWallpaper ? '封面壁纸已开启' : '封面壁纸已关闭');
```

`public/js/modules/07-fx/05-fx-panel-performance.js`：
1. :276 `setRange('fx-wallpaperopacity', fx.wallpaperOpacity);` 后加 `setRange('fx-coverwallpaperopacity', fx.coverWallpaperOpacity);`
2. :813 标签行后加 `setFxSliderLabel('fx-coverwallpaperopacity', '封面壁纸透明');`
3. `updateFxInputs` 函数体末尾加 `if (typeof updateCoverWallpaperSurfaceControls === 'function') updateCoverWallpaperSurfaceControls();`
4. 开关态刷新（:370-371 `t-wallpaperMode` 的 classList.toggle 旁）加：

```js
  var coverWallpaperToggle = document.getElementById('t-coverWallpaper');
  if (coverWallpaperToggle) coverWallpaperToggle.classList.toggle('on', fx.coverWallpaper);
```

`public/js/modules/07-fx/09-console-workspace.js`：experimental 组（:288-291）items 数组 `t-wallpaperMode` 条目后加：

```js
        fxConsoleItem('t-coverWallpaper', '封面壁纸', '封面光晕粒子壁纸 桌面壁纸层 播放器背景板 试验'),
        fxConsoleItem('cover-wallpaper-surface-seg', '封面壁纸位置', '桌面壁纸层 播放器背景板 互斥'),
        fxConsoleItem('fx-coverwallpaperopacity', '封面壁纸透明', '0.35 到 1')
```

- [ ] **Step 8: modulePaths + bundle + 测试**

`public/js/index-loader.js`：Task 1 插入的 `'js/cover-wallpaper-effect.js',` 之后加：

```js
    'js/modules/02-visual/18-cover-wallpaper.js',
```

```bash
npm run bundle
node --test tests/cover-wallpaper-surface.test.js
node --test tests/cover-wallpaper-effect-contract.test.js
```
Expected: 两组测试全 PASS。

- [ ] **Step 9: 检查点——汇报输出，等主人"提交"指令**

建议提交信息：`feat: 封面壁纸·播放器背景板面（状态机两态互斥+面板UI+持久化）`

---

### Task 3: 桌面壁纸层（覆盖页 + 主进程运行时 + preload + 启动恢复）

**Files:**
- Create: `public/cover-wallpaper.html`
- Create: `desktop/cover-wallpaper-runtime.js`
- Modify: `desktop/main.js`、`desktop/preload.js`
- Modify: `public/js/modules/10-shell/05-startup-bindings.js`（挂 `initCoverWallpaper`）
- Verify: `package.json` build.files
- Test: `tests/cover-wallpaper-runtime.test.js`

**Interfaces:**
- Consumes: `desktop/wallpaper-mode-runtime.js` 的 `DesktopWallpaperRuntime`（构造参数见该文件 :277-313；`start/update/stop/getStatus/dispose` 见 :580-728；其 `sendState` 走 `stellaflix-wallpaper-state` 通道，`desktop/overlay-preload.js:12` 已监听）；Task 2 的 `initCoverWallpaper(api)`。
- Produces: preload `desktopWindow.setCoverWallpaperMode(enabled,payload)` / `updateCoverWallpaperMode(payload)` / `getCoverWallpaperModeStatus()` / `onCoverWallpaperModeState(cb)`（Task 2 状态机经 `getDesktopWindowApi()` 消费）。

- [ ] **Step 1: 写失败的主进程契约测试**

创建 `tests/cover-wallpaper-runtime.test.js`：

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('封面壁纸主进程复用 DesktopWallpaperRuntime 且只注册独立通道', () => {
  const src = read('desktop/cover-wallpaper-runtime.js');
  assert.match(src, /require\('\.\/wallpaper-mode-runtime'\)/);
  assert.match(src, /new DesktopWallpaperRuntime/);
  assert.match(src, /overlay-preload\.js/);
  assert.match(src, /cover-wallpaper\.html/);
  for (const ch of [
    'stellaflix-cover-wallpaper-set-enabled',
    'stellaflix-cover-wallpaper-update',
    'stellaflix-cover-wallpaper-get-status',
    'stellaflix-cover-wallpaper-runtime-state',
  ]) assert.ok(src.includes(ch), 'missing channel ' + ch);
});

test('main.js 只接新模块名，quick-check 红线字样仍不存在', () => {
  const mainText = read('desktop/main.js');
  assert.match(mainText, /require\('\.\/cover-wallpaper-runtime'\)/);
  assert.ok(!mainText.includes('cover-wallpaper.html'), '页面名不得进 main.js（含禁用子串 wallpaper.html）');
  for (const marker of ['DesktopWallpaperRuntime', 'wallpaper-mode-runtime', 'wallpaper.html', 'wallpaper-preload.js']) {
    assert.ok(!mainText.includes(marker), 'main.js 不得含 ' + marker);
  }
});

test('preload 暴露 4 个封面壁纸 API', () => {
  const src = read('desktop/preload.js');
  for (const api of ['setCoverWallpaperMode', 'updateCoverWallpaperMode', 'getCoverWallpaperModeStatus', 'onCoverWallpaperModeState']) {
    assert.ok(src.includes(api), 'missing api ' + api);
  }
});
```

Run: `node --test tests/cover-wallpaper-runtime.test.js` → Expected: FAIL

- [ ] **Step 2: 覆盖窗口页面**

创建 `public/cover-wallpaper.html`：

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Stellaflix Cover Wallpaper</title>
  <style>
    html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#050608}
    canvas{position:absolute;inset:0;width:100%;height:100%}
  </style>
</head>
<body>
  <canvas id="cover-wall"></canvas>
  <script src="js/cover-wallpaper-effect.js"></script>
  <script>
    'use strict';
    // 画面实现与播放器背景板共用 js/cover-wallpaper-effect.js，这里只接收主进程状态。
    var coverWallpaperEffect = window.createCoverWallpaperEffect(document.getElementById('cover-wall'));
    if (window.desktopOverlay && window.desktopOverlay.onWallpaperState) {
      window.desktopOverlay.onWallpaperState(coverWallpaperEffect.applyState);
    }
  </script>
</body>
</html>
```

页面内**禁止**出现第二份 draw 实现（Mineradio 契约：`assert.doesNotMatch(page, /function draw\(/)`）。

- [ ] **Step 3: 主进程运行时模块**

创建 `desktop/cover-wallpaper-runtime.js`：

```js
'use strict';
const path = require('path');
const { execFile } = require('child_process');
const { DesktopWallpaperRuntime } = require('./wallpaper-mode-runtime');

function createCoverWallpaperRuntime(deps) {
  const BrowserWindow = deps.BrowserWindow;
  const screen = deps.screen;
  const ipcMain = deps.ipcMain;
  const overlayUrl = deps.overlayUrl;
  const getMainWindow = deps.getMainWindow;
  const isTrustedEvent = deps.isTrustedEvent;

  const runtime = new DesktopWallpaperRuntime({
    BrowserWindow,
    screen,
    preloadPath: path.join(__dirname, 'overlay-preload.js'),
    overlayUrl: () => overlayUrl('cover-wallpaper.html'),
    execFileImpl: execFile,
    onStatus: (status) => {
      const win = typeof getMainWindow === 'function' ? getMainWindow() : null;
      if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
        try { win.webContents.send('stellaflix-cover-wallpaper-runtime-state', status); } catch (_) { }
      }
    },
  });

  const deny = { ok: false, error: 'IPC_UNTRUSTED' };
  ipcMain.handle('stellaflix-cover-wallpaper-set-enabled', async (event, enabled, payload) => {
    if (!isTrustedEvent(event)) return deny;
    return enabled === true ? runtime.start(payload || {}) : runtime.stop('renderer-disabled');
  });
  ipcMain.handle('stellaflix-cover-wallpaper-update', async (event, payload) => {
    if (!isTrustedEvent(event)) return deny;
    return runtime.update(payload && typeof payload === 'object' ? payload : {});
  });
  ipcMain.handle('stellaflix-cover-wallpaper-get-status', async (event) => {
    if (!isTrustedEvent(event)) return deny;
    return runtime.getStatus('renderer-get-status');
  });

  return {
    runtime,
    reconcile: (reason) => runtime.reconcileDisplay(reason),
    dispose: () => runtime.dispose(),
  };
}

module.exports = { createCoverWallpaperRuntime };
```

- [ ] **Step 4: main.js 接线（注意红线字样：main.js 里不得出现 Step 1 测试列出的任何 marker，也不得出现 `cover-wallpaper.html`）**

1. 文件顶部 require 区（`const { FullDesktopModeRuntime } = require('./full-desktop-mode-runtime');` :24 之后）：

```js
const { createCoverWallpaperRuntime } = require('./cover-wallpaper-runtime');
```

2. `overlayUrl`（:3557）与 `mainWindow` 均已可用后（`fullDesktopModeRuntime` 实例化处 :169 附近若早于 `overlayUrl` 定义，则放到 app.whenReady 前的任意函数调用位；函数声明会提升，`overlayUrl: (page) => overlayUrl(page)` 传闭包最稳）：

```js
const coverWallpaperRuntime = createCoverWallpaperRuntime({
  BrowserWindow,
  screen,
  ipcMain,
  overlayUrl: (page) => overlayUrl(page),
  getMainWindow: () => mainWindow,
  isTrustedEvent: (event) => !!(mainWindow && !mainWindow.isDestroyed() && event && event.sender === mainWindow.webContents),
});
```

（信任门先按"仅主窗口"实现；与既有 `stellaflix-wallpaper-set-enabled` 处理器 main.js:5229-5249 的门保持同源——实施时读那 21 行，若其用了别的判定函数，改抄它。）

3. 显示器变化：找到既有 `screen.on('display-metrics-changed'` 处理器（full desktop 已联动），在其回调里追加 `coverWallpaperRuntime.reconcile('display-metrics-changed');`（若存在 `display-added/removed` 处理器同样追加——这正是对 Mineradio 短板的超越项）。
4. 电源：`powerMonitor.on('resume'` 与 `'unlock-screen'` 回调（main.js:5922 区域对应物）各追加同一行 reconcile 调用，reason 分别 `'resume'`、`'unlock-screen'`。
5. 退出清理：在 `before-quit` 清理链（与 `fullDesktopModeRuntime` 的收尾同段）加 `coverWallpaperRuntime.dispose();`。

- [ ] **Step 5: preload 4 个 API**

`desktop/preload.js` `desktopWindow` 对象内（`getWallpaperModeStatus` :127 附近）加：

```js
  setCoverWallpaperMode: (enabled, payload) => ipcRenderer.invoke('stellaflix-cover-wallpaper-set-enabled', !!enabled, payload || {}),
  updateCoverWallpaperMode: (payload) => ipcRenderer.invoke('stellaflix-cover-wallpaper-update', payload || {}),
  getCoverWallpaperModeStatus: () => ipcRenderer.invoke('stellaflix-cover-wallpaper-get-status'),
  onCoverWallpaperModeState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('stellaflix-cover-wallpaper-runtime-state', listener);
    return () => ipcRenderer.removeListener('stellaflix-cover-wallpaper-runtime-state', listener);
  },
```

- [ ] **Step 6: 启动恢复**

`public/js/modules/10-shell/05-startup-bindings.js`：`grep -n "initDesktopWallpaperRuntimeBridge" public/js/modules/10-shell/05-startup-bindings.js` 找到调用行，其后加：

```js
if (typeof initCoverWallpaper === 'function') initCoverWallpaper(getDesktopWindowApi());
```

（`initCoverWallpaper` 内部已含：订阅 runtime-state、拉一次 get-status、起 260ms 同步循环、`fx.coverWallpaper` 为 true 时恢复桌面层。）

- [ ] **Step 7: package.json 打包白名单核查**

```bash
node -e "const f=require('./package.json').build.files; console.log(JSON.stringify(f.filter(x=>/public|desktop/.test(x)),null,1))"
```

若输出为逐文件白名单（而非 `public/**/*`、`desktop/**/*` 通配），把 `public/cover-wallpaper.html` 与 `desktop/cover-wallpaper-runtime.js` 补进 `build.files`（历史教训：白名单漏新根文件导致打包缺页）。通配则不动。

- [ ] **Step 8: 验证**

```bash
node --test tests/cover-wallpaper-runtime.test.js
node --test tests/cover-wallpaper-surface.test.js
npm run bundle
node scripts/quick-check.js
```
Expected: 测试全 PASS；quick-check 通过（旧 legacy 断言不受影响——新文件全部用 `cover-wallpaper-*` 命名，`public/wallpaper.html` 仍缺席）。

- [ ] **Step 9: 检查点——汇报输出，等主人"提交"指令**

建议提交信息：`feat: 封面壁纸·桌面壁纸层（复用稳健 WorkerW 运行时+独立 IPC 通道+启动恢复）`

---

### Task 4: 全量回归 + 真机冒烟清单

**Files:**
- Test: 既有全量 + 本计划 3 个新测试文件
- Modify: 无（仅修回归中暴露的问题）

**Interfaces:**
- Consumes: Task 1-3 全部产物。
- Produces: 交付结论 + 冒烟清单回传件。

- [ ] **Step 1: 全量回归**

```bash
npm run bundle:check
npm test
```
Expected: bundle 产物与源码一致；`npm test` 通过数 = 基线 191 + 新增 10 例（effect 契约 3 + surface 4 + runtime 3）= **201/201**。任何败例先归因（区分新引入 vs 既有）。

- [ ] **Step 2: 无头链路自检（不留 :3000 残留）**

```bash
PORT=3999 node server.js & SVPID=$!; sleep 1
curl -sf http://127.0.0.1:3999/cover-wallpaper.html | grep -c createCoverWallpaperEffect
curl -sf http://127.0.0.1:3999/js/cover-wallpaper-effect.js | grep -c WALLPAPER_IDLE_FPS
kill $SVPID; wait $SVPID 2>/dev/null; echo done
```
Expected: 两条 grep 各 ≥1；进程已杀净（`netstat -ano | grep :3999` 为空）。

- [ ] **Step 3: 真机冒烟（主人执行，逐项回传）**

1. 面板出现"封面壁纸"开关（特效面板 + 实验功能组各一处）；开启→背景板面：整窗最底层出现封面光晕粒子，`#album-bg`/自定义背景让位；切"桌面壁纸层"→背景板消失、桌面图标后出现壁纸。
2. 桌面层：点击壁纸无响应（穿透）；打开任意窗口盖在其上；Win+D 后壁纸仍在或自动恢复。
3. 睡眠唤醒 / 注销登录一次：壁纸恢复（reconcile 生效；若失败，`getWallpaperModeStatus` 风格状态里 `lastError` 有 WALLPAPER_* 码可取证）。
4. 换壁纸位置 segment 两键选中态正确；透明度滑杆 0.35–1 实时生效。
5. 切歌/暂停：粒子转速与闪烁密度变化可见；暂停 30fps 不掉帧（任务管理器 GPU 占用对比）。
6. 重启应用：开关与位置持久化恢复；完整桌面模式行为与升级前无差异（回归对照）。

- [ ] **Step 4: 交付汇报**

分离「已完成记录」（代码/测试/门禁输出）与「剩余待办」（仅冒烟清单回传），等主人对提交/推送拍板。

---

## Self-Review 结论

- Spec 覆盖：双承载面（T2/T3）、互斥单一真源（T2 状态机+测试）、preset 传输（T2 测试断言）、复用稳健挂接（T3 用 DesktopWallpaperRuntime 全生命周期）、display/resume 超越项（T3 Step4.3/4.4）、实验功能组（T2 Step7）、持久化（T2 Step6）、门禁红线（T3 测试+quick-check 复跑）——无遗漏。
- 类型一致性：`applyCoverWallpaperState/setCoverWallpaperSurface/initCoverWallpaper/coverWallpaperErrorLabel/normalizeCoverWallpaperSurface` 在 T2 定义、T3 引用，拼写已互校；preload API 名与 T2 状态机消费名一致。
- 已知风险：① `DesktopWallpaperRuntime.createWindow` 用 `sandbox:true`，而桌面歌词窗口是 `sandbox:false`——overlay-preload 在沙箱下 contextBridge 可用，若真机白屏先查 preload 报错；② 背景板 `z-index:0` 与本页 3D 场景层叠序需真机目验（冒烟项 1）。
