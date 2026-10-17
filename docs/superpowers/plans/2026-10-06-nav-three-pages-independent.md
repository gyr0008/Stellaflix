# 顶部导航三页行为独立化 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 世界 / 首页 / 汇联三个顶部导航 tab 成为行为独立的页面：对等 mount/unmount 生命周期、状态零串扰；首页拥有自有 DOM，`#empty-home` 彻底归还音乐态。

**Architecture:** 首页注册为 router 页（`page-home.js`，id 'home'），三 tab 同链路 `handleNavAction→goToNav→router.go`；`goHome()` 签名保留、内部改走 router；宿主 chrome（body 类 / 宿主 inline 样式 / 标题栏 reparent / ← 显隐）从页面私有代码收编为 `router.register({chrome})` 声明，由 router 统一应用、逆序回收。home.js 的"内容大脑"（cardDefs / latestProgress / 继续看 / 海报）迁入 `renderInto(host)`，寄生音乐态 DOM 的整条链路退役。

**Tech Stack:** 原生 JS（IIFE + `StellaflixVideo` 命名空间，无构建）、Electron 渲染进程、node:test + vm 假 DOM 夹具、node tests/run-all.js 聚合。

**Spec:** `docs/superpowers/specs/2026-10-06-nav-three-pages-independent-design.md`（执行者必读，随本计划一同交付）

## Global Constraints

- 事件名 `sfv:home-boot-ready`、`sfv:splash-dismissed` 不改（03-splash.js L659–673 消费）。
- `goHome` 对外签名 `SFV.online.goHome()` 不变——7 个消费方零改动（bootstrap.js L35 / 04-home-empty-wallpaper.js L339 / index.html L435 home-btn / 01-viewport-resize-shortcuts.js L33 / online.js L85,220 / online-nav.js L173）。
- player.css `sfv-world-page` 三条规则（隐藏 #canvas-container、覆盖层实色、宿主实色）与 `#canvas-container` 相关断言**保留不动**；只改挂摘机制。
- X 关闭钮维持 T158 裁决（desktopWindow.close，online-nav.js L54–57）。
- 不做 URL/历史路由；`online.js installNavGuard`（L233–251）不动。
- 影视态代码对 `homeSuppressed / homeForcedOpen / emptyHomeActive` 三全局与 `#empty-home` **零读写**（Phase D 起生效，DoD grep 双证）。
- 任何 index.html 脚本清单增删后必须跑 `npm run bundle`；新增根文件核对 electron-builder `build.files` 白名单。
- 本地验证起服一律 `PORT=3999`，同命令内起→测→杀；视觉验证用离屏 Electron 截图工装，禁用 Computer Use。
- 全量回归 = `npm test`（node tests/run-all.js）；基线数以**当次执行起点**记录（当前记忆有 183/183 与 176/176 两说，Task 0 校准）。
- 提交规约：每任务末的 commit 步骤，仅在主人批准本计划执行方式时明示授权后执行；未授权则跳过 commit 步骤、保留工作区并继续，最终由主人一句话提交。

---

### Task 0: 基线校准

**Files:** 无修改（只测量记录）。

**Interfaces:**
- Produces: 基线数字与 git 干净度记录，写入执行日志。

- [ ] **Step 1:** `git status --porcelain` 确认工作区无未预期改动（`.scratch/`、`sf_seed.html`、本 plan/spec 文件在允许清单）。
- [ ] **Step 2:** `npm test 2>&1 | tail -20`，记录 `pass/fail` 数。任何既有失败先报告，不得带病开工。
- [ ] **Step 3:** `git rev-parse --short HEAD` 记录起点 commit。

---

### Task 1: router.js — chrome 声明机制（纯新增，向后兼容）

**Files:**
- Modify: `public/video/router.js`（全文 78 行，在 `register/go/leave` 内加 chrome 层）
- Create: `tests/router-chrome.test.js`

**Interfaces:**
- Consumes: 现有 `register(p)`，p 可含新字段 `chrome`。
- Produces:
  - `chrome = { fill?:boolean, back?:boolean, bodyClass?:string, titlebarToBody?:boolean, hostStyle?:Object }`
  - 语义：`go(id)` = leave 当前页 chrome（逆序）→ 应用新页 chrome → unmount 旧页 → `host.innerHTML=''` → mount 新页；`leave()` = unmount + 回收 chrome。
  - `back` 缺省 true（`=== false` 才隐藏）；`SFV.router.applyChromeHooks(hooks)` 注入 online-nav 侧钩子：`hooks.setBackVisible(bool)`、`hooks.setTitlebarToParent(bool)`（解决模块加载顺序：router.js 早于 online-nav.js 加载）。
  - mount 抛错：回收该页 chrome、`currentPageId=null`、宿主渲染 `.sfv-router-error` 占位（文案 `'页面加载失败：' + id`）。

- [ ] **Step 1: 写失败测试** `tests/router-chrome.test.js`

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

function loadRouter(opts) {
  opts = opts || {};
  const sandbox = { console, Promise };
  sandbox.window = sandbox;
  sandbox.StellaflixVideo = {};
  vm.createContext(sandbox);
  vm.runInContext(read('public/video/router.js'), sandbox);
  const router = sandbox.StellaflixVideo.router;
  const body = { classes: [], style: {} };
  const host = { innerHTML: '', style: {} };
  const titlebar = { parentNode: null };
  const log = [];
  router.setHost(host);
  if (typeof router.applyChromeHooks === 'function') {
    router.applyChromeHooks({
      setBackVisible(v) { log.push('back:' + v); },
      setTitlebarToParent(v) { log.push('titlebar:' + v); }
    });
  }
  return { router, body, host, log, sandbox };
}
```

断言用例（同文件续写）：
1. `register({id:'a', chrome:{bodyClass:'cls-a', hostStyle:{padding:'0'}}, mount(){}})` → `go('a')` 后 body classList 含 `cls-a`、`host.style.padding === '0'`。
2. 再 `go('b')`（b 无 chrome）→ `cls-a` 摘除、`host.style.padding` 还原为挂载前值（`''`）。
3. 两页各声明 `titlebarToBody:true` 连续挂载 → 钩子调用序列 `['titlebar:true','titlebar:true']`，`leave()` 后回收序列含两次 `titlebar:false`（逆序）。
4. `chrome:{back:false}` → 挂载时 log 出现 `back:false`；无声明页 → `back:true` 复位。
5. mount 抛错页：`currentPageId()===null`、chrome 已回收、`host.innerHTML` 含 `sfv-router-error`。
6. 回归：Task 0 前已有的 `router.go 页间切换先卸载旧页` 断言（world-page-independent.test.js L209–220）不回归。

- [ ] **Step 2:** `node --test tests/router-chrome.test.js` → FAIL（applyChromeHooks 不存在）。
- [ ] **Step 3: 实现 router.js chrome 层。** 核心结构（在现有 IIFE 内）：

```js
var chromeHooks = null;             // online-nav 注入
var chromeStack = [];               // 已应用 chrome 记录（正序应用，逆序回收）
var lastHostStyle = null;

function applyChrome(p) {
  var c = p.chrome || {};
  var rec = { c: c, bodyClasses: [], hostPrev: null };
  var b = global.document && global.document.body;
  if (c.bodyClass && b) { b.classList.add(c.bodyClass); rec.bodyClasses.push(c.bodyClass); }
  if (host && c.hostStyle) {
    rec.hostPrev = {};
    Object.keys(c.hostStyle).forEach(function (k) {
      rec.hostPrev[k] = host.style[k];
      host.style[k] = c.hostStyle[k];
    });
  }
  if (chromeHooks) {
    if (c.titlebarToBody) chromeHooks.setTitlebarToParent(true);
    chromeHooks.setBackVisible(c.back !== false);
  }
  chromeStack.push(rec);
}
function revokeChrome() {
  while (chromeStack.length) {
    var rec = chromeStack.pop();
    var c = rec.c;
    var b = global.document && global.document.body;
    if (c.titlebarToBody && chromeHooks) chromeHooks.setTitlebarToParent(false);
    rec.bodyClasses.forEach(function (cls) { if (b) b.classList.remove(cls); });
    if (rec.hostPrev && host) Object.keys(rec.hostPrev).forEach(function (k) { host.style[k] = rec.hostPrev[k]; });
  }
}
```

`go()` 改为：`leave current page → revokeChrome() → applyChrome(p) → try mount / catch{ revokeChrome(); currentPageId=null; 错误占位 }`；`leave()` 加 `revokeChrome()`。**注意**：先 revoke 后 mount，且 mount 前 `host.innerHTML=''` 保持现有语义。
- [ ] **Step 4:** `node --test tests/router-chrome.test.js tests/world-page-independent.test.js` → 全 PASS（旧用例不许红）。
- [ ] **Step 5:** Commit（若已授权）：`git add public/video/router.js tests/router-chrome.test.js && git commit -m "feat: router chrome 声明机制（应用栈逆序回收+mount 错误占位）"`

---

### Task 2: page-world.js — 私有 chrome 机制迁移到声明（行为等价）

**Files:**
- Modify: `public/video/page-world.js`（删 L293–303 `setWorldPageClass`、L313–332 `liftTitlebar`、L334–347 `applyHostChrome` 及全部调用点：mount L390–394、unmount L589–591）
- Modify: `public/video/online-nav.js`（ensure() 尾部挂 `SFV.router.applyChromeHooks`）
- Modify: `tests/world-page-independent.test.js`（断言面 1 改声明驱动）

**Interfaces:**
- Consumes: Task 1 的 `chrome` 声明 + 钩子。
- Produces: page-world 注册含 `chrome: { bodyClass:'sfv-world-page', titlebarToBody:true, hostStyle:{ padding:'0', height:'100%', overflow:'hidden', background:'#05060a' } }`；页面内零 body/host/标题栏直写。

- [ ] **Step 1: 改测试为声明断言（先红）。** `world-page-independent.test.js` 用例 1 替换为：
  - `sandbox._page.chrome.bodyClass === 'sfv-world-page'`；
  - 经真实 router（vm 载 router.js 于同 sandbox）`go('world')` 后 body 挂类、`unmount+leave` 后摘类——把假 router 换成真 router 夹具（Task 1 的 loadRouter 模式，`applyChromeHooks` 传记账钩子）。
  - player.css 三条源码断言（L153–179）**原样保留**。
- [ ] **Step 2:** 运行确认新断言 FAIL。
- [ ] **Step 3: online-nav.js ensure() 注入钩子**（ensure L26–31 自愈分支旁，两个分支都要覆盖）：

```js
if (SFV.router && typeof SFV.router.applyChromeHooks === 'function') {
  SFV.router.applyChromeHooks({
    setBackVisible: function (v) { if (S.backBtn) S.backBtn.style.display = v ? '' : 'none'; },
    setTitlebarToParent: function (v) { liftTitlebar(v); }   // 把 page-world 的 liftTitlebar 整体搬入 online-nav 作私有函数（含 titlebarAnchor 记账）
  });
}
```

- [ ] **Step 4: page-world.js 三段删除**，注册处加 `chrome` 声明；mount 内不再调 `setWorldPageClass/liftTitlebar/applyHostChrome`，unmount 内去掉对应调用（`savedHostStyle` 变量一并删）。
- [ ] **Step 5:** `node --test tests/world-page-independent.test.js tests/router-chrome.test.js tests/online-nav-router-host-reinject.test.js` → PASS。
- [ ] **Step 6:** `npm test` → 与 Task 0 基线同绿。Commit（若授权）：`feat: 世界页 chrome 收编进 router 声明，删页面私有挂摘`

---

### Task 3: page-home.js — 自有 DOM 骨架 + router 注册（只增不改）

**Files:**
- Modify: `public/video/page-home.js`（11 行 no-op 全文件重写）
- Create: `public/video/home-page.css` + index.html `<head>` 追加 `<link rel="stylesheet" href="video/home-page.css">`（L36 `world-ht-panel.css` 之后）
- Create: `tests/page-home-skeleton.test.js`

**Interfaces:**
- Produces（后续任务与 Task 6/7 依赖的 **DOM 契约**，类名前缀 `sfv-home-`，防与音乐态 `.home-card` 样式互染）：

```
#sfv-home
  .sfv-home-hero            #sfv-home-hero-poster (img/video 容器) #sfv-home-hero-title .sfv-home-hero-actions
  .sfv-home-grid            ×5 .sfv-home-card[data-sfv-home-card=hall|collections|track|history|music]
                            每卡: .sfv-home-card-label / -title / -sub / -art
  .sfv-home-rail            #sfv-home-tile-row（海报轨容器）
  .sfv-home-continue        （继续看行容器）
  .sfv-home-urlbar          （URL 输入条，默认 display:none）
```

  - `SFV.router.register({ id:'home', title:'首页', chrome:{ back:false }, mount, unmount })`
  - mount 依次尝试 `SFV.home.renderInto(host)`（Task 4+ 提供；本任务缺失时静默跳过，骨架仍在）。
  - 页标题：现有 `SFV.ui.setTitle` 机制，标题「首页」。

- [ ] **Step 1: 写失败测试** `tests/page-home-skeleton.test.js`（vm + Task 1 同款记账假 DOM）：
  1. 载 page-home.js → 注册页 id 'home'、`chrome.back === false`。
  2. `router.go('home')` → host 内出现 `#sfv-home`、5 张 `[data-sfv-home-card]`（label 依序含「放映厅/片单/追片/历史/音乐空间」口径以 home-cards.js cardDefs 为准）、`.sfv-home-urlbar`。
  3. **零串扰断言**：假 DOM 里预置 `#empty-home` 兄弟节点 + MutationObserver 记账——`go('home')` 全程其 `subtree/characterData/attributes` 变更数为 0。
  4. `unmount()` 幂等，二次调用不 throw。
- [ ] **Step 2:** FAIL。
- [ ] **Step 3: 实现 page-home.js**（createElement 建骨架，中文文案集中 `COPY` 常量表；`document.createElement` 全走局部 `el()` helper，对齐 online-nav 风格）与 home-page.css（从 player.css 现有影视首页规则**复制**取值：卡片网格 `grid-template-columns`、海报轨尺寸——实施时先 grep player.css 中 `home-quick-grid|#empty-home` 相关影视规则作为样式基线）。
- [ ] **Step 4:** 测试 PASS；`npm test` 全绿。
- [ ] **Step 5:** Commit（若授权）：`feat: page-home 自有 DOM 骨架注册 router（零 #empty-home 断言）`

---

### Task 4: home.js — `renderInto(host)`：五卡迁移

**Files:**
- Modify: `public/video/home.js`（新增 renderInto；现读 home.js L137–320 render() 主体作迁移源）
- Modify: `public/video/home-cards.js`（`setCardText/setCardArt` 已是纯函数目标节点入参，优先直接复用不改；仅当内部写死 `#empty-home` 选择器时参数化）
- Create: `tests/page-home-cards.test.js`

**Interfaces:**
- Consumes: Task 3 DOM 契约（`[data-sfv-home-card]`）。
- Produces: `SFV.home.renderInto(host)`——同步渲染五卡文案/封面 + 绑定点击（`cardDefs()[i].action` 直调，**不再需要捕获拦截**，新 DOM 无音乐内联 onclick）；返回 `true`/`false` 表示是否完成。render() 旧函数本任务**不动**（Phase D 退役）。

- [ ] **Step 1: 写失败测试**：vm 载 home-cards.js + home.js（假 `SFV.model/state/hall/online`），host=Task 3 骨架假 DOM；断言 `renderInto(host)` 后 5 卡 title/sub/label 与 cardDefs 一致；点击 `music` 卡假 action 后 `setSpace('music')` 被调；`#empty-home` 零变更断言复用 Task 3 的 observer 夹具。
- [ ] **Step 2:** FAIL。
- [ ] **Step 3:** 实现 `renderInto`（从 render() L137–320 摘"卡片"子段：`defs=cardDefs()` → `host.querySelectorAll('[data-sfv-home-card]')` → `setCardText/setCardArt`；跨态海报读取 `getMusicCrossPoster()` 保持只读调用 L200–208 的 blob 链，写向新卡 `-art` 节点）。`SFV.home.renderInto` 入导出表（home.js L1262 区）。
- [ ] **Step 4:** PASS + `npm test` 全绿。
- [ ] **Step 5:** Commit（若授权）：`feat: 首页五卡迁入 renderInto（自有 DOM，事件直绑免拦截）`

---

### Task 5: home.js — `renderInto(host)`：海报轨 + 继续看 + hero 海报区 + URL 条

**Files:**
- Modify: `public/video/home.js`（renderInto 扩段；迁移源：hero 改写 L237 区、`#home-tile-row` 海报轨、`SFV.homeContinueWatching.renderContinueWatching`、`toggleUrlBar` L79–122、toast L124）
- Modify: `public/video/home-continue-watching.js`（若其选择器写死音乐 DOM：加 `scope` 参数，缺省保持旧行为——影视态旧 render() 仍在用，Phase D 一并收口）
- Create: `tests/page-home-rail-hero.test.js`

**Interfaces:**
- Consumes: Task 3 契约、Task 4 的 renderInto。
- Produces: `renderInto(host)` 完成全部 1:1 内容；`ensureBackBtn/hideBackBtn`（L349–370）不进新页（chrome.back:false 接管）；URL 条在新 DOM 由 `.sfv-home-urlbar` 承载，粘贴地址→播放链意图不变。

- [ ] **Step 1: 写失败测试**：断言 renderInto 后 `.sfv-home-rail` 有 tile 节点（喂假 `SFV.model` 进度数据，对齐 home-continue-watching 现有测试夹具）、hero 标题文本非空、urlbar 初始 `display:none` 且经 `showUrlBar(host)` 翻显；`#empty-home` 零变更 observer 断言。
- [ ] **Step 2:** FAIL。
- [ ] **Step 3:** 分段迁移（每段一个函数：`renderHeroInto(host)` / `renderRailInto(host)` / `renderContinueInto(host)` / `bindUrlBarInto(host)`，renderInto 顺序调用；异步段全部带 seq token：`home.js` 顶部 `var homeSeq = 0`，renderInto 捕获 `mySeq`，所有 `.then` 回写前 `mySeq !== homeSeq` 即弃——对齐 page-world 模式，防旧请求回写新页）。
- [ ] **Step 4:** PASS + `npm test` 全绿。
- [ ] **Step 5:** Commit（若授权）：`feat: 首页 hero/海报轨/继续看/URL条 迁入 renderInto`

---

### Task 6: 切换 goHome 入口 + spacechange 自动回首页 + bootstrap 分支(C)删除

**Files:**
- Modify: `public/video/online-nav.js`（goHome L293–306 改适配器；goToNav L213–262 加 `instant` 参数；spacechange 监听 L116–150 加影视态自动开首页支）
- Modify: `public/video/bootstrap.js`（删 L63–75 分支(C) 及 L27–29 注释 (C) 段）
- Create: `tests/nav-home-adapter.test.js`
- Modify: `tests/sfv-boot-home-ready-event.test.js`、`tests/startup-navigation-readiness.test.js`（审计更新）

**Interfaces:**
- Consumes: router id 'home'（Task 3）、renderInto（Task 4/5）。
- Produces:

```js
function goHome(opts) {
  opts = opts || {};
  goToNav('home', { instant: !!opts.instant });   // 统一走 router；不再 close()
}
```

`goToNav(key, opts)`：`opts.instant` 时覆盖层加 `sfv-no-anim` 类（player.css 补一条 `transition:none !important`），动画语义其余不变。spacechange 处理器末尾追加：`if (mode === 'video' && !isOpen()) goHome({ instant: true });`

- [ ] **Step 1: 写失败测试**（vm 载 online-nav 或源码行为断言，取仓库既有夹具风格）：
  1. `goHome()` 后 `router.currentId()==='home'` 且 `isOpen()===true`（不再 close）。
  2. spacechange→video 且盖层关 → 自动 goToNav('home')。
  3. 7 个消费方 grep 断言：`SFV.online.goHome` 仍可解析（online.js L85 导出链不变）。
  4. bootstrap.js 源码不再含 `tryEnsureHomeRenderOnly`。
- [ ] **Step 2:** FAIL。
- [ ] **Step 3:** 实现三处修改；bootstrap 轮询 `SFV.online.goHome` 成功后派发 `sfv:home-boot-ready` 的路径不变（启动即 instant 打开首页页）。
- [ ] **Step 4:** PASS + `npm test` 全绿 + **离屏 Electron 截图**：影视态启动首屏与改造前基线截图对照（主人历史截图或现截现比），观感一致。
- [ ] **Step 5:** Commit（若授权）：`feat: goHome 收编进 router（盖层内回首页），bootstrap render-only 兜底退役`

---

### Task 7: 返回栈统一 + 播放器返回 + X/back 语义收尾

**Files:**
- Modify: `public/video/online-nav.js`（goBack L484–537 三处 close-回首页特判统一；returnFromPlayer L442–455 无目标支改 `goHome()`；`ensureOverlayShown` D5 注释更新）
- Modify: `tests/continue-watching-return-home.test.js`、`tests/home-blank-dismiss-browse-guard.test.js`、`tests/browse-note-empty.test.js`（审计更新）

**Interfaces:**
- Consumes: Task 6 的 goHome 适配器。
- Produces: ←（world/discover）= `goToNav('home')`；详情返回经 `_returnPageId` 可为 'home'；播放器无记录退出 → 首页页（不依赖底层 DOM 复位）。

- [ ] **Step 1: 写失败测试**：
  1. `goBack()` 在 `uiMode==='page'` 且页无 back 消费时断言走 `goToNav('home')`（记账 router）。
  2. `returnFromPlayer()` 无 playerReturn 时断言调用链含 goHome。
  3. 源码断言：goBack 函数体内不再出现「close() 后 SFV.home.render()」组合。
- [ ] **Step 2:** FAIL。
- [ ] **Step 3:** 实现：goBack 三分支统一 `goToNav('home', {instant:true})`；`restoreHomeAfterPlayer` 函数体改为一行 `goHome()`（暂保留函数名与导出，Task 8 删）。
- [ ] **Step 4:** PASS + `npm test` 全绿。
- [ ] **Step 5:** Commit（若授权）：`feat: 返回栈与播放器返回统一走首页页，close-回首页特判退役`

---

### Task 8: Phase D 大删除——寄生链退役

**Files:**
- Delete: `public/video/home-snapshot.js`（归档 `public/video/_archive/home-snapshot.js`）
- Modify: `public/index.html`（摘 L2139 脚本项；确认 `home-boot-shell` 相关脚本行一并核）
- Modify: `public/video/home.js`（删：render()、restoreMusic() L1114–1245、dispatch registerSlot L1227、bindGridCapture/bindRailCapture 委托、`#empty-home` 全部查询、toggleUrlBar 旧实现、`_preCapturePosterSnapshot` 影视→音乐方向；保：renderInto 及其依赖、cardDefs/latestProgress/getMusicLeftPoster 委托、海报存储链）
- Modify: `public/video/online-nav.js`（删 `resetHomeVisibilityState` L423–433 及 L688/L704 导出、spacechange 第5卡文案同步 L139–145、`restoreHomeAfterPlayer` 残余）
- Modify: `public/js/modules/05-playback/04-home-empty-wallpaper.js`（`resetHomeVisibilityState` 复用点改内联兜底删除；影视态委托 goHome 不变）
- Modify: `public/video/state.js`（快照钩子 L76–84 改单向：仅 `music→video` 保留读侧）
- Modify: `public/video/player.css`（删 `#empty-home`/`home-quick-grid` 影视改写规则段；`sfv-world-page` 三条**不动**）
- Modify: 受影响测试：`world-page-independent`（已 Task 2 改）、`home-cards-library-link`、`home-video-discovery*`、`home-dashboard-update*`、`home-hero-mp4*`、`home-recent-local-playback`、`home-daily-recommendation*` 中凡断言影视改写 `#empty-home` 者——逐文件 grep `#empty-home` + `video-space` 判定：测音乐态本体的不动，测影视寄生的删/改断言
- Create: `tests/home-empty-immunity.test.js`（**T118 替代断言**）

**Interfaces:**
- Consumes: 前序全部。
- Produces: 影视态零 `#empty-home` 写入的最终形态；`SFV.home` 导出表收敛（`render/restoreMusic/install` 中 `render` 移除，`toast` 保留与否按引用点）。

- [ ] **Step 1: 先写免疫测试**：vm 装配影视全套（router/page-home/home-cards/home），完整跑 `go('home') → go('world') → go('home') → leave()`，observer 记账 `#empty-home` 全子树变更 === 0；再加音乐↔影视来回切 3 轮后 `#empty-home` `innerHTML` 与基线逐字节相等。
- [ ] **Step 2:** 此时应 FAIL（旧 render()/spacechange 仍写音乐 DOM）。
- [ ] **Step 3:** 按文件清单执行删除（每个文件删后立刻 `node --test` 跑它的直接消费测试）。`renderHomeDiscover` 影视守卫**保留**，注释改为"性能守卫：影视态不渲染被盖层遮住的音乐首页"。
- [ ] **Step 4:** `grep -rn "empty-home" public/video --include=*.js` 结果仅剩注释/归档目录；`grep -rn "homeSuppressed\|homeForcedOpen\|emptyHomeActive" public/video` 结果空。
- [ ] **Step 5:** 免疫测试 PASS + `npm test` 全绿。
- [ ] **Step 6:** Commit（若授权）：`refactor!: 影视首页寄生链整体退役，#empty-home 归还音乐态（T118 以免疫断言替代）`

---

### Task 9: 打包、构建白名单与终验

**Files:**
- Modify: B1 bundle 产物（`npm run bundle`）
- Modify: `electron-builder` 配置（若 `build.files` 白名单未含 `public/video/home-page.css` / 新页文件则补）

- [ ] **Step 1:** `npm run bundle`，确认无回退告警。
- [ ] **Step 2:** `npm test` 终跑，记录 pass 数对照 Task 0 基线：只增不减。
- [ ] **Step 3:** 起服验证（`PORT=3999 node server.js` 同命令内起→`curl -s http://localhost:3999/video/page-home.js | head -3` 与 home-page.css 200→杀进程）。
- [ ] **Step 4:** 离屏 Electron 截图五景：影视启动首屏 / 三 tab 互切各一 / 切音乐态原貌 / 世界页星空隐藏。
- [ ] **Step 5:** 输出真机冒烟六项清单（spec §7.4）交主人验收；Commit（若授权）。

---

## Self-Review 结论

1. Spec 覆盖：R1–R7 与 §2–§7 各条均有任务承载（§2.1→T6；§2.2→T1/T2；§3→T3–T5；§4→T6/T7;§5→T1；§6→T8；§7→T0/T9+各任务测试步）。
2. 无占位符；大迁移任务以「迁移源行号 + DOM 契约 + 逐段函数名」替代整段抄码，契约先于实现锁定。
3. 类型一致：`renderInto(host)`、`goHome(opts)`、`goToNav(key, opts)`、`applyChromeHooks({setBackVisible,setTitlebarToParent})`、`chrome{fill?,back?,bodyClass?,titlebarToBody?,hostStyle?}` 全文统一（Task 1 定义与 spec §2.2 对齐；spec 示例中 `fill` 字段实现上以 `hostStyle` 等价表达，Task 1 为准）。
