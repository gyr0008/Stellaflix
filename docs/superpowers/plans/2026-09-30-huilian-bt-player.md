# 汇联页 BT 磁力播放改造 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将汇联页改造为「磁力/.torrent → qBt 顺序下载 → mpv 嵌入播放」的最小闭环，并全量归档旧实现。

**Architecture:** 渲染层新 `huilian-page.js`（DOM+播控条）+ 纯状态机 `huilian-queue.js`，经现有 `window.stellaflixVideo` 桥调 qbt/mpv；桌面端仅补三个小口：overlay bounds 同步、.torrent multipart 上传、WebUI 随机口令。

**Tech Stack:** 原生 JS（IIFE 挂 `SFV`，无构建）、Electron IPC、qBittorrent Web API、mpv JSON IPC、node:test + node:vm。

**Spec:** `docs/superpowers/specs/2026-09-30-huilian-bt-player-design.md`

## Global Constraints

- **禁止自行 git commit**：本仓库规则=仅在用户明确「提交」指令时 commit，且只 stage 任务文件。各任务末尾的「记录」步骤 = 在会话账本标注"待提交"+建议 commit message，不执行 git 写操作。
- 单文件 ≤ 350 行（public/video 模块惯例）。
- 全量回归 `npm test`；基线 145/146（唯一已知败 = watch-history D1 存量，不得新增失败）。
- 本批只动 `public/video/`、`public/index.html`、`desktop/`、`tests/`：不触碰 `public/js/modules/` → **无需** `npm run bundle`。
- IPC 返回形状一律 `{ok:true,data}` / `{ok:false,error}`（对齐 `desktop/ipc-video.js:34-95` 现状）。
- 归档命名沿用仓库惯例：`<原名>.pre-bt-20260930.js`，移入 `public/video/_archive/`。
- 路由生命周期红线（T158 教训）：任何离开汇联页的路径必须先销毁 overlay。
- 用户可见文案中文；注释中文；不含 emoji 除非本计划明确写出（占位页 🔗 图标随归档作废）。

---

### Task 1: 归档旧实现 + 新页面壳（单注册源 + 非桌面降级）

**Files:**
- Move（重命名加后缀 `.pre-bt-20260930.js`）→ `public/video/_archive/`：
  `huilian-page.js`、`huilian-providers.js`、`huilian-stream.js`、`huilian-provider-hls.js`、`huilian-provider-webdav.js`、`huilian-provider-emby.js`、`huilian-provider-aliyun.js`、`huilian-provider-magnet.js`、`page-discover.js`（共 9 个）
- Create: `public/video/huilian-page.js`（本任务只含壳：mount/unmount/back、桥检测、降级提示、任务列表容器空骨架）
- Create: `tests/helpers/huilian-harness.js`（vm 假 DOM + 假桥加载器，Task 2/3/7 测试复用）
- Modify: `public/index.html`（删 :2147-2155 注释块；`video/page-discover.js` 挂载行替换为 `video/huilian-page.js`）
- Test: `tests/huilian-page-contract.test.js`

**Interfaces:**
- Produces: `SFV.huilianPage = { mount(host), unmount(), back() }`；router 注册唯一 `{id:'discover', title:'汇联'}`；全局检测点 `window.stellaflixVideo.download` 是否存在决定渲染分支。
- Consumes: `SFV.ui.setTitle / setBrowseChrome`（ui.js 现状）。

- [ ] **Step 1: 写失败测试**

`tests/huilian-page-contract.test.js`（先写 4 个契约断言）：

```js
'use strict';
/**
 * 汇联新页契约测：单注册源(id=discover)、mount 必设浏览态 chrome、
 * 非桌面环境降级（输入禁用+桌面版提示）、unmount 幂等。
 * 运行：node --test tests/huilian-page-contract.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { loadPage } = require('./helpers/huilian-harness');

test('注册且仅注册一个 id=discover 页面', () => {
  const { registrations } = loadPage({ bridge: null });
  assert.strictEqual(registrations.length, 1);
  assert.strictEqual(registrations[0].id, 'discover');
  assert.strictEqual(registrations[0].title, '汇联');
});

test('mount 调 setTitle(汇联) 且 setBrowseChrome(true)', () => {
  const { page, uiCalls, host } = loadPage({ bridge: null });
  page.mount(host);
  assert.deepStrictEqual(uiCalls, [['setTitle', '汇联'], ['setBrowseChrome', true]]);
});

test('非桌面：无桥 → 降级提示 + 输入区 disabled', () => {
  const { page, host, doc } = loadPage({ bridge: null });
  page.mount(host);
  const input = doc.querySelector('#huilian-input');
  const hint = doc.querySelector('.huilian-desk-only');
  assert.ok(hint, '缺少降级提示节点');
  assert.ok(hint.textContent.indexOf('桌面版') >= 0);
  assert.strictEqual(input.disabled, true);
});

test('桌面：有桥 → 输入可用且无降级提示', () => {
  const { page, host, doc } = loadPage({ bridge: true });
  page.mount(host);
  assert.strictEqual(doc.querySelector('#huilian-input').disabled, false);
  assert.strictEqual(doc.querySelector('.huilian-desk-only'), null);
});
```

`tests/helpers/huilian-harness.js`：仿 `tests/hex-wall.test.js:158-165` 的 vm 假 DOM 模式，导出 `loadPage({bridge})`，返回 `{ page, registrations, uiCalls, host, doc }`。假 DOM 至少支持：`createElement`（记 tag/attrs/classList/`disabled`）、`appendChild/removeChild/innerHTML=''` 清子、`querySelector` 按 `#id`/`.class` 匹配、`addEventListener` 记录。桥 mock：`window.stellaflixVideo = { player:{...stub}, download:{...stub}, ffmpeg:{} }`（bridge:null 时整体不注入）。

- [ ] **Step 2: 跑测确认失败**

Run: `node --test tests/huilian-page-contract.test.js`
Expected: FAIL（模块不存在 / 无注册）

- [ ] **Step 3: 归档 9 文件**

```bash
mkdir -p public/video/_archive
cd public/video
for f in huilian-page huilian-providers huilian-stream huilian-provider-hls huilian-provider-webdav huilian-provider-emby huilian-provider-aliyun huilian-provider-magnet page-discover; do
  git mv "$f.js" "_archive/$f.pre-bt-20260930.js"
done
```

- [ ] **Step 4: 改 index.html**

删除 :2147-2155 的 9 行注释块；把脚本列表中 `"video/page-discover.js"` 替换为 `"video/huilian-page.js"`（位置不变，保持相对路径与既有数组格式）。

- [ ] **Step 5: 写最小实现 `public/video/huilian-page.js`**

```js
/*
 * Stellaflix 影视模块 — 汇联页（BT 磁力播放·最小闭环入口壳）
 * 依赖：window.stellaflixVideo（desktop/preload-video.js 桥）；无桥时整体降级。
 * 生命周期红线：unmount 必须销毁 mpv overlay（Task 7 接入后强制）。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  function bridge() {
    var b = global.stellaflixVideo;
    return (b && b.download && b.player) ? b : null;
  }

  function el(tag, opts) {
    var n = document.createElement(tag);
    if (opts && opts.id) n.setAttribute('id', opts.id);
    if (opts && opts.cls) n.setAttribute('class', opts.cls);
    return n;
  }

  function mount(host) {
    if (SFV.ui && SFV.ui.setTitle) SFV.ui.setTitle('汇联');
    if (SFV.ui && SFV.ui.setBrowseChrome) SFV.ui.setBrowseChrome(true);
    host.innerHTML = '';
    var wrap = el('div', { cls: 'huilian-wrap' });
    var row = el('div', { cls: 'huilian-input-row' });
    var input = el('input', { id: 'huilian-input', cls: 'huilian-input' });
    input.setAttribute('placeholder', '粘贴磁力链接 magnet:...');
    var btn = el('button', { id: 'huilian-add', cls: 'huilian-btn' });
    btn.textContent = '加入下载';
    var list = el('div', { id: 'huilian-tasks', cls: 'huilian-tasks' });
    if (!bridge()) {
      input.disabled = true; btn.disabled = true;
      var hint = el('div', { cls: 'huilian-desk-only' });
      hint.textContent = 'BT 播放需在 Stellaflix 桌面版中使用';
      wrap.appendChild(hint);
    }
    row.appendChild(input); row.appendChild(btn);
    wrap.appendChild(row); wrap.appendChild(list);
    host.appendChild(wrap);
  }

  var page = {
    mount: mount,
    unmount: function () {},          // Task 7 填 overlay 销毁
    back: function () { page.unmount(); return false; },
  };
  if (SFV.router && SFV.router.register) SFV.router.register({ id: 'discover', title: '汇联', mount: mount, unmount: page.unmount, back: page.back });
  else SFV.huilianPage = page;
})(typeof window !== 'undefined' ? window : this);
```

（若 harness 里 `SFV.router` 存在则断言 registrations；两分支只走其一，测中 mock 有 router。）

- [ ] **Step 6: 跑测确认通过**

Run: `node --test tests/huilian-page-contract.test.js`
Expected: PASS 4/4

- [ ] **Step 7: 记录**（不 commit；账本标"待提交"，建议 message：`feat: 汇联页 BT 改造 Task1 — 旧实现全量归档+新页壳（单注册源+非桌面降级）`）

---

### Task 2: `huilian-queue.js` 纯状态机（add 参数 / hash 认领 / 可播阈值 / 任务视图）

**Files:**
- Create: `public/video/huilian-queue.js`
- Test: `tests/huilian-queue.test.js`

**Interfaces:**
- Produces（挂 `SFV.huilianQueue`）：
  - `makeAddParams(input, fileBase64) → {url} | {torrentBase64, fileName} | null(非法)`
  - `matchHash(torrents, magnetUrl) → hash|string|null`（torrents 元素含 `url`/`magnet_uri` 字段）
  - `isPlayable(file) → boolean`（`file.progress >= 0.05 && file.size > 0`；qbt progress 为 0~1）
  - `reduceTasks(torrents) → [{hash,name,state,progress,pct,dlspeed,upspeed}]`
- Consumes: 无（纯函数）。

- [ ] **Step 1: 写失败测试**

```js
'use strict';
/** 运行：node --test tests/huilian-queue.test.js */
const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');

function load() {
  const sandbox = { window: {}, URL: require('url').URL };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('public/video/huilian-queue.js', 'utf8'), sandbox, { filename: 'huilian-queue.js' });
  return sandbox.window.StellaflixVideo.huilianQueue;
}

test('makeAddParams: magnet 串走 url', () => {
  const q = load();
  const m = 'magnet:?xt=urn:btih:abc123';
  assert.deepStrictEqual(q.makeAddParams(m, null), { url: m });
});
test('makeAddParams: base64 文件走 torrentBase64+fileName', () => {
  const q = load();
  assert.deepStrictEqual(q.makeAddParams('', { base64: 'QUJD', name: 'a.torrent' }),
    { torrentBase64: 'QUJD', fileName: 'a.torrent' });
});
test('makeAddParams: 非 magnet 文本 → null', () => {
  const q = load();
  assert.strictEqual(q.makeAddParams('http://nope', null), null);
});
test('matchHash: 按 magnet url 认领', () => {
  const q = load();
  const ts = [{ hash: 'h1', url: 'magnet:?xt=urn:btih:abc123' }, { hash: 'h2', url: 'x' }];
  assert.strictEqual(q.matchHash(ts, 'magnet:?xt=urn:btih:abc123'), 'h1');
  assert.strictEqual(q.matchHash(ts, 'magnet:?xt=urn:btih:zzz'), null);
});
test('isPlayable: progress 阈值 5%（0~1 制）', () => {
  const q = load();
  assert.strictEqual(q.isPlayable({ progress: 0.049, size: 10 }), false);
  assert.strictEqual(q.isPlayable({ progress: 0.05, size: 10 }), true);
  assert.strictEqual(q.isPlayable({ progress: 0.9, size: 0 }), false);
});
test('reduceTasks: 视图模型字段与百分比', () => {
  const q = load();
  const rows = q.reduceTasks([{ hash: 'h1', name: '片A', state: 'downloading', progress: 0.5, dlspeed: 1024, upspeed: 0, size: 2048, downloaded: 1024 }]);
  assert.deepStrictEqual(rows, [{ hash: 'h1', name: '片A', state: 'downloading', progress: 0.5, pct: 50, dlspeed: 1024, upspeed: 0 }]);
});
```

- [ ] **Step 2:** Run `node --test tests/huilian-queue.test.js` → FAIL（文件不存在）
- [ ] **Step 3: 实现 `huilian-queue.js`**：IIFE 同 Task1 模式；`makeAddParams` 用 `/^magnet:\?/i` 校验文本分支；`matchHash` 比较 `t.url === magnet || t.magnet_uri === magnet`；其余按上述断言直写。目标 <120 行。
- [ ] **Step 4:** Run → PASS 6/6
- [ ] **Step 5: 记录**（message 建议：`feat: 汇联 Task2 — huilian-queue 纯状态机（认领/阈值/视图）+ 契约测`）

---

### Task 3: 页面接线 —— 加入任务、hash 认领、2s 轮询列表与文件选择

**Files:**
- Modify: `public/video/huilian-page.js`（Task 1 壳内填 DOM 逻辑；本任务后仍 ≤350 行，超限则把任务行渲染拆到同文件底部私有函数，不新建文件）
- Modify: `public/index.html`（在 huilian-page.js **之前**补挂 `"video/huilian-queue.js"`，替换 Task1 注释中恢复列表的位置）
- Test: `tests/huilian-page-queue.test.js`（用 Task 1 harness，mock `download.*` 记录调用）

**Interfaces:**
- Consumes: `SFV.huilianQueue.*`（Task 2 精确签名）；`window.stellaflixVideo.download.{addTorrent,list,files,progress,delete}`。
- Produces: 页面内部状态 `tasks[]`；DOM 契约：每任务行 `.huilian-task[data-hash]`、文件行 `.huilian-file[data-index][data-playable="1|0"]`、"浏览…"按钮 `#huilian-browse`（`<input type=file accept=".torrent">` → FileReader → base64 → `makeAddParams('',{base64,name})`）。

- [ ] **Step 1: 写失败测试（4 条）**

```js
test('add 非法输入 → 提示条且不调 download.addTorrent', ...);      // 断言 .huilian-error 文本 + addTorrent 调用数 0
test('add 磁力 → addTorrent({url}) 后进入 解析中 行', ...);          // list mock 空→认领前状态 'stalled-meta'
test('list 轮询认领 hash → 渲染 .huilian-task[data-hash]，含 50% 与速度', ...);
test('files(hash) 返回 2 文件 → 渲染两行，progress 0.9 行 data-playable=1、0.01 行 =0', ...);
```

（具体断言代码在实现时按 harness 现有 querySelector/textContent 能力写全；每条约 10-20 行。）

- [ ] **Step 2:** Run `node --test tests/huilian-page-queue.test.js` → FAIL
- [ ] **Step 3: 实现**：`mount` 里绑 add/browse 事件；`addThenClaim(magnet)`：`addTorrent` → 置 pending 行 → `setInterval(2000)` 轮询 `download.list()` 经 `reduceTasks` 重绘 + pending 用 `matchHash` 认领；展开行时 `download.files(hash)` 渲染文件子行（用 `isPlayable` 打 `data-playable`）；`unmount` 清 interval。IPC 返回 `{ok:false,error}` 统一喂 `.huilian-error` 提示条（Task1 壳里补一个固定节点）。
- [ ] **Step 4:** Run → PASS；再跑 `node --test tests/huilian-page-contract.test.js` 确认未回归
- [ ] **Step 5: 记录**（message 建议：`feat: 汇联 Task3 — 任务列表接线：认领/轮询/文件选择/可播阈值上屏`）

---

### Task 4: 桌面补丁 D2 —— addTorrent 支持 .torrent 文件 base64 上传

**Files:**
- Modify: `desktop/download-manager.js`（`addTorrent` + 新增纯函数 `buildAddFormBody(opts)` 导出）
- Test: `tests/huilian-qbt-upload-form.test.js`

**Interfaces:**
- Consumes: `opts.torrentBase64/fileName`（Task 3 页面产出形状）。
- Produces: `addTorrent(opts)` 现支持两种 opts；qbt `/torrents/add` multipart 表单：file part 字段名 `torrents`，外加 `savepath/autoTMM=false/paused/seedingTimeLimit=0/sequentialDownload/firstLastPiecePrio`（与现有 url 分支同字段集）。

- [ ] **Step 1: 写失败测试**

```js
'use strict';
/** 运行：node --test tests/huilian-qbt-upload-form.test.js */
const test = require('node:test');
const assert = require('node:assert');
const dm = require('../desktop/download-manager');

test('buildAddFormBody: magnet 分支 = urlencoded', () => {
  const r = dm.buildAddFormBody({ url: 'magnet:?xt=urn:btih:abc' }, { qbt: { defaultSavePath: 'D:/x' } });
  assert.strictEqual(r.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.ok(/urls=magnet/.test(r.body.toString()));
  assert.ok(/sequentialDownload=true/.test(r.body.toString()));
});
test('buildAddFormBody: base64 分支 = multipart 含 torrents 文件段', () => {
  const r = dm.buildAddFormBody({ torrentBase64: Buffer.from('TOR').toString('base64'), fileName: 'a.torrent' }, { qbt: { defaultSavePath: 'D:/x' } });
  assert.match(r.headers['Content-Type'], /^multipart\/form-data; boundary=/);
  const s = r.body.toString('latin1');
  assert.ok(s.includes('name="torrents"; filename="a.torrent"'));
  assert.ok(s.includes('Content-Disposition: form-data; name="sequentialDownload"'));
});
test('buildAddFormBody: 两者皆空 → throw', () => {
  assert.throws(() => dm.buildAddFormBody({}, { qbt: {} }));
});
```

- [ ] **Step 2:** Run → FAIL（无导出）
- [ ] **Step 3: 实现**：`buildAddFormBody(opts, cfg)` 纯函数（不发请求）：base64 分支用固定 boundary 拼 Buffer（字段集对齐现 :140-148）；`addTorrent` 改为取 `{body, headers}` 后由 `_http` 发送——`_http` 需加第 4 参 `contentType`（默认沿用 urlencoded，向后兼容其余调用点）。已核实 download-manager 顶层仅 require child_process/fs/path/http（:21-24），无 electron 依赖，`node --test` 可直接 require。
- [ ] **Step 4:** Run → PASS 3/3；`npm test` 无新增败
- [ ] **Step 5: 记录**（message 建议：`feat: 汇联 Task4/D2 — qbt 加任务支持 .torrent base64 multipart 上传`）

---

### Task 5: 桌面补丁 D1 —— overlay bounds 同步（含坐标换算）

**Files:**
- Modify: `desktop/mpv-controller.js`（新增 `setOverlayRect` + 纯函数 `computeOverlayScreenBounds`）
- Modify: `desktop/ipc-video.js`（注册 `stellaflix-video:mpv-overlay-set-bounds`）
- Modify: `desktop/preload-video.js`（`player.setBounds(playerId, rect)`；CHANNELS 补 `mpvOverlaySetBounds`）
- Test: `tests/huilian-overlay-bounds.test.js`

**Interfaces:**
- Consumes: 渲染层 rect = 容器 `getBoundingClientRect()` 的 `{x,y,width,height}`（CSS px）。
- Produces: `computeOverlayScreenBounds(contentBounds, zoomFactor, rect) → {x,y,width,height}`（逻辑 px，四舍五入取整，宽高最小 1）；`setOverlayRect(playerId, rect, mainWindow) → boolean`（无 overlay 句柄返回 false）。

- [ ] **Step 1: 写失败测试**

```js
'use strict';
/** 运行：node --test tests/huilian-overlay-bounds.test.js */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');

// mpv-controller 顶层不 require electron（:33 起惰性 getElectron），node --test 直接 require 已核实可行
const mpv = require('../desktop/mpv-controller');

test('zoom=1：内容偏移 + rect', () => {
  assert.deepStrictEqual(
    mpv.computeOverlayScreenBounds({ x: 100, y: 50, width: 1200, height: 800 }, 1, { x: 20, y: 240, width: 640, height: 360 }),
    { x: 120, y: 290, width: 640, height: 360 });
});
test('zoom=1.25：CSS px 除回逻辑 px', () => {
  const r = mpv.computeOverlayScreenBounds({ x: 0, y: 0, width: 1000, height: 600 }, 1.25, { x: 100, y: 100, width: 500, height: 280 });
  assert.deepStrictEqual(r, { x: 80, y: 80, width: 400, height: 224 });
});
test('内容区顶部偏移不含标题栏（用 getContentBounds 语义：x,y 即客户区）', () => {
  const r = mpv.computeOverlayScreenBounds({ x: 10, y: 10, width: 800, height: 600 }, 1, { x: 0, y: 0, width: 100, height: 60 });
  assert.deepStrictEqual(r, { x: 10, y: 10, width: 100, height: 60 });
});
test('rect 缺字段/负宽高 → throw', () => {
  assert.throws(() => mpv.computeOverlayScreenBounds({ x: 0, y: 0 }, 1, null));
  assert.throws(() => mpv.computeOverlayScreenBounds({ x: 0, y: 0, width: 1, height: 1 }, 1, { x: 0, y: 0, width: -5, height: 10 }));
});
```

- [ ] **Step 2:** Run → FAIL
- [ ] **Step 3: 实现**：
  - `computeOverlayScreenBounds(cb, z, rect)`：校验 `rect` 四字段为有限数、width/height>0；`x = cb.x + Math.round(rect.x / z)`，宽高同理；z 取值 `z>0 ? z : 1`。
  - `setOverlayRect(playerId, rect)`：`_handles.get(playerId)` → 无 `overlayWin` 返回 false → `overlayWin.setBounds(computeOverlayScreenBounds(_mainWindow.getContentBounds(), _mainWindow.webContents.getZoomFactor(), rect))`。注：内容偏移需扣除主窗口**当前 DPR 下窗口原点**，主窗口原点即 `getContentBounds()` 逻辑坐标，直接相加成立。
  - ipc-video：`ipcMain.handle('stellaflix-video:mpv-overlay-set-bounds', async (_e, { id, rect }) => { try { return { ok: true, data: mpvCtrl.setOverlayRect(id, rect) }; } catch (err) { return { ok: false, error: err.message }; } });`
  - preload-video：`setBounds: (playerId, rect) => ipcRenderer.invoke(CHANNELS.mpvOverlaySetBounds, { id: playerId, rect })`。
- [ ] **Step 4:** Run → PASS 4/4；`npm test` 无新增败
- [ ] **Step 5: 记录**（message 建议：`feat: 汇联 Task5/D1 — mpv overlay bounds 同步 IPC（zoom 换算纯函数+契约）`）

---

### Task 6: 桌面补丁 D3 —— qbt WebUI 随机口令（去 admin/adminadmin）

**Files:**
- Modify: `desktop/download-manager.js`（新增 `ensureCredential(_httpImpl, store)`，`start()` 就绪后调用）
- Modify: `desktop/video-config.js`（qbt 节新增 `credStorePath` 默认 userData 下 `huilian-qbt-cred.json`；桌面 userData 已有取法则复用）
- Test: `tests/huilian-qbt-credential.test.js`

**Interfaces:**
- Produces: `ensureCredential({ login, setPassword, saveCred }) → Promise<{username, password}>`（依赖注入，纯编排可测）。行为：store 已存→直接用；否则以默认口令 login 成功后 `setPassword(newPw)`，`saveCred({username:'admin', password: newPw})`。newPw = `crypto.randomBytes(16).toString('hex')`。
- Consumes: `_http` 既有实现（`/api/v2/auth/login`、`/api/v2/app/setPassword` form：`username=&password=`）。

- [ ] **Step 1: 写失败测试**

```js
'use strict';
/** 运行：node --test tests/huilian-qbt-credential.test.js */
const test = require('node:test');
const assert = require('node:assert');
const dm = require('../desktop/download-manager');

test('已有存储 → 不 login 不 setPassword', async () => {
  let calls = [];
  const cred = await dm.ensureCredential({
    stored: { username: 'admin', password: 'old' },
    login: () => { calls.push('login'); return Promise.resolve(true); },
    setPassword: () => { calls.push('set'); return Promise.resolve(true); },
    saveCred: () => calls.push('save'),
    genPw: () => 'newpw',
  });
  assert.deepStrictEqual(calls, []);
  assert.deepStrictEqual(cred, { username: 'admin', password: 'old' });
});
test('首启 → 默认口令 login，setPassword 随机并落盘', async () => {
  let calls = [];
  const cred = await dm.ensureCredential({
    stored: null,
    login: (u, p) => { calls.push(['login', u, p]); return Promise.resolve(true); },
    setPassword: (newPw) => { calls.push(['set', newPw]); return Promise.resolve(true); },
    saveCred: (c) => calls.push(['save', c]),
    genPw: () => 'R'.repeat(32),
    defaults: { username: 'admin', password: 'adminadmin' },
  });
  assert.deepStrictEqual(calls[0], ['login', 'admin', 'adminadmin']);
  assert.deepStrictEqual(calls[1], ['set', 'R'.repeat(32)]);
  assert.deepStrictEqual(calls[2], ['save', { username: 'admin', password: 'R'.repeat(32) }]);
  assert.strictEqual(cred.password, 'R'.repeat(32));
});
test('login 失败 → reject 且不落盘', async () => {
  let saved = 0;
  await assert.rejects(dm.ensureCredential({
    stored: null, login: () => Promise.reject(new Error('403')),
    setPassword: () => Promise.resolve(true), saveCred: () => saved++, genPw: () => 'x',
    defaults: { username: 'admin', password: 'adminadmin' },
  }));
  assert.strictEqual(saved, 0);
});
```

- [ ] **Step 2:** Run → FAIL
- [ ] **Step 3: 实现** `ensureCredential` 编排函数 + 薄封装 `_ensureCredentialReal()`：读 store（fs JSON，路径来自 video-config `qbt.credStorePath`）、注入 `_login`/setPassword(走 `_http('POST','/api/v2/app/setPassword', form)`)/写 store；成功后把凭据覆写进 `_config.qbt` 供后续 `_http` Basic-auth 使用。`start()` 就绪轮询成功后调用一次。
- [ ] **Step 4:** Run → PASS 3/3
- [ ] **Step 5: 记录**（message 建议：`feat: 汇联 Task6/D3 — qbt WebUI 首启随机口令，去 admin/adminadmin`）

---

### Task 7: 播放控件条 + overlay 生命周期红线 + 播完清理

**Files:**
- Modify: `public/video/huilian-page.js`（若超 350 行：把播控条拆 `public/video/huilian-player-bar.js`，页面经 `SFV.huilianPlayerBar.create({bridge, container, onClose})` 使用；预计需拆）
- Modify: `public/index.html`（补挂新文件，huilian-page.js 之前）
- Test: `tests/huilian-player-bar.test.js`（harness 扩展 mock `player.*` 记录）

**Interfaces:**
- Consumes: `player.createOverlay({url,title,x,y,width,height})`（现 preload `player.createOverlay`）→ `{ok,data:{playerId}}`；`player.setBounds(playerId, rect)`（Task 5 产出）；`player.command/getProperty/seek/stopAndClean/destroyOverlay/onEvent`；`download.delete(hash, true)`。
- Produces: 播放契约——点击 `.huilian-file[data-playable="1"]` → `createOverlay`（url=文件 `content_path`），成功后：控件条节点 `.huilian-bar`（`#huilian-toggle/#huilian-seek/#huilian-vol/#huilian-close-del/#huilian-keep`）；`onEvent(playerId,'end-file')` → 播完面板；页面 `unmount` → **必调** `destroyOverlay(playerId)` 且不删任务。

- [ ] **Step 1: 写失败测试（5 条）**
  1. 点可播文件行 → `createOverlay` 收到 `{url: content_path, ...rect 四字段}`；
  2. `resize`/滚动触发（测中手动调 `sync()`）→ `setBounds(playerId, rect)` 被调、参数来自容器 `getBoundingClientRect`；
  3. `onEvent('end-file')` → 出现 `.huilian-done-panel`，点「删任务+删文件」→ `stopAndClean(id)` + `download.delete(hash,true)` 顺序各一次；
  4. `unmount()` → `destroyOverlay(当前id)` 调用一次、`download.delete` **未**被调（红线）；
  5. `createOverlay` 返回 `{ok:false,error}` → `.huilian-error` 显示 error，控件条不出现。

- [ ] **Step 2:** Run `node --test tests/huilian-player-bar.test.js` → FAIL
- [ ] **Step 3: 实现**：`huilian-player-bar.js` ~200 行：`create()` 内 `setInterval(500)` 同步 rect（节流 ≤100ms 变化才发）、暂停=`command(id,['set','pause',true])`、seek input range→`player.seek(id, sec)`、音量 `set_property volume`、`onEvent 'time-pos'` 更新进度、`'shutdown'` 事件=进程退出→按 spec §6 降级「重试/换文件」按钮。页面 unmount 链：`bar.destroy()`（含 interval 清理 + destroyOverlay）。
- [ ] **Step 4:** Run → PASS；`node --test tests/huilian-page-contract.test.js tests/huilian-page-queue.test.js` 回归
- [ ] **Step 5: 记录**（message 建议：`feat: 汇联 Task7 — mpv 播控条+bounds 跟随+unmount 销毁 overlay 红线`）

---

### Task 8: 样式改写 + 全量回归 + 冒烟清单交付

**Files:**
- Modify: `public/video/player.css:1737-1763`（报废 `.huilian-*` 带整段替换为新页样式：`.huilian-wrap/-input-row/-input/-btn/-tasks/-task/-file/-bar/-error/-desk-only/-done-panel`；配色沿用站内变量 `--fc-accent-rgb`，同旧带写法）
- Test: 无新测（样式）；全量回归

- [ ] **Step 1: 写样式**（对照 Task1/3/7 实际 class 清单逐条给规则，暗色站内风格；`pointer-events` 勿学旧占位壳设 none——按钮会点不动）
- [ ] **Step 2:** `node scripts/quick-check.js`（若该脚本覆盖静态检查则跑）
- [ ] **Step 3:** `npm test` → 与基线 145/146 对齐、无新增败（watch-history D1 存量除外）
- [ ] **Step 4: 冒烟清单交用户**（真机，无法自动化）：
  1. 磁力 →「解析中」→ 2s 内认领出任务行；
  2. 文件 ≥5% 后播放钮亮 → mpv 画面贴在页内容器；
  3. 拖动/最大化主窗 → 画面跟位不遮导航；
  4. 切到首页/片库 tab → 画面立即消失、任务保留；
  5. 播完 → 面板删除 → qBt 任务与文件消失；
  6. 选本地 .torrent 上传 → 任务入列；
  7. 浏览器直开 :3000 → 降级提示；
  8. 233% 缩放屏 → overlay 位置正确（DPR 换算验证）。
- [ ] **Step 5: 记录**（message 建议：`feat: 汇联 Task8 — 新页样式落地+全量回归`）

---

## Self-Review 结论

- Spec 覆盖：§4 数据流 → Task 2/3/7；§5 文件清单 → Task 1/3/8；D1→T5，D2→T4，D3→T6；§6 错误处理 → T3(提示条)/T7(降级钮)；§8 测试 → 各 Task Step。无缺口。
- 依赖顺序：T1→T2→T3→T7；T4/T5/T6 独立可并行（分片执行时注意别与前端任务同时改 index.html——T3 与 T1 都改 index.html，串行）。
- 命名一致性：`makeAddParams/matchHash/isPlayable/reduceTasks`、通道 `stellaflix-video:mpv-overlay-set-bounds`、`player.setBounds` 全篇统一。
