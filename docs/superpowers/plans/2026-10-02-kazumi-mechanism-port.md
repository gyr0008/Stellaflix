# Kazumi 机制定点移植（嗅探事件驱动 / 播放内核 A/B / 代理降级）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Kazumi 的三条核心机制（事件驱动竞态、抢占式取消、原生直连播放）移植进 Stellaflix 自己的胶水层，消除「点击→出画」链路中约 2~5s 的结构性白等，并建立首帧耗时测量与 mpv 在线内核 A/B 能力。

**Architecture:** 不触碰 `public/video/kazumi/`（GPL-3.0 移植内核）；嗅探编排从 `desktop/main.js:5383-5739` 抽为可测服务 `desktop/media-sniff.js`，会话 promise 与页面导航驱动解耦；播放数据面按 origin 能力记忆「直连优先、代理兜底」；测量模块 `play-timing.js` 为后续 A/B 提供同一把尺子。

**Tech Stack:** Electron ^42.4.1（package.json:204）、Node 24 + `node:test`、hls.js 1.7.1（public/vendor/hls.min.js）、desktop/mpv-controller.js（既有 mpv IPC 通道）、无新依赖。

**Spec:** 本文件 §背景取证（即上轮 2026-10-02 逐字对比报告的结论，随计划同行）。

## 背景取证（关键代码事实，计划各任务以此为论据）

- 旧嗅探是「await 整页加载 + 固定 sleep」批处理：`desktop/main.js:5704-5714`（`await win.loadURL(hopUrl)` → `setTimeout(min(2200, timeout/4))` → `readNextHop`，最多 3 跳），尾段 `main.js:5717-5721` 再睡 1500ms+800ms；`await result` 排在 5724 行——即使 webRequest 通道已在 `main.js:5449-5452` 提前 settle，调用方也要等完整链走完才拿到值。
- 旧并发模型是全局单飞锁 BUSY：`main.js:5638` `if (sfvSniffBusy) return { ok:false, error:'BUSY' }`；Kazumi 对应物是抢占取消：`webview_video_source_service.dart:17,36-51`。
- Kazumi 事件驱动命中：`webview_video_source_service.dart:86-96` `Future.any([parserFuture, cancelFuture])` + `.timeout`，命中即 `unloadPage()`（`video_webview_impl.dart:48-50`）。
- 钩子注入晚于页面脚本：`main.js:5705-5706` `injectAll()` 在 `await loadURL` 之后。
- 嗅探命中后真实流被强制回穿代理：`public/video/kazumi-bridge.js:417-418` `playUrl = '/api/proxy?url=' + encodeURIComponent(rawUrl)`；hls.js 再以 `makeProxyLoader`（`public/video/source-adapter-hls.js:61-95`）把所有清单/分片 XHR 走 `server.js:7844` `/api/proxy`（上游超时 `server.js:7906` PROXY_TIMEOUT_MS=12000）。Kazumi 则是裸 URL+httpHeaders 直喂 mpv（`player_playback_controller.dart:459-463`）。
- Kazumi 路径客户端超时缺省为 0（不超时）：`public/video/kazumi/http-client.js:60-71,81`，仅靠 server 代理 12s 兜底；调用点 `kazumi-bridge.js:71,445`。
- 编排看门狗 30s：`public/video/play-orchestrator.js:255-262`。
- 渲染层 mpv 通道已存在但只服务汇联本地库：`desktop/preload-video.js:52-63`（create/destroy/command/setProperty/seek/overlay…）→ `desktop/ipc-video.js:34-74` → `desktop/mpv-controller.js:561-568`；调用范式在 `public/video/huilian-page.js:29`。

---

## Global Constraints

- `public/video/kazumi/` 目录内部零改动（GPL-3.0 移植声明 `index.js:1-20`「禁止改动内部」）；需要扩展时在 `kazumi-bridge.js` / 新建装饰模块层做。
- 超时对齐不变式（`tests/hls-proxy-timeout-alignment.test.js` 强制）：hls.js `manifestLoadingTimeOut/levelLoadingTimeOut/fragLoadingTimeOut` 必须严格 > `server.js` 的 `PROXY_TIMEOUT_MS = 12000`。本计划不得改动这两个数。
- 影视模块单文件 ≤500 行铁律（`play-orchestrator.js:17` 注释）。
- 新增渲染层脚本一律追加进 `public/index.html` 的 `SFV_SCRIPTS` 数组（2019-2152 区段），排在依赖它的文件之前；带幂等守卫（`if (SFV.xxx) return;` 范式）。
- 测试基线：`npm test`（`node tests/run-all.js`）当前 148/149，唯一失败为 watch-history D1 存量项，不得新增失败。
- 提交仅在主人明示「提交」后执行（用户工作流规则）；本文各任务的 Commit 步骤是暂停点，不是自动动作。
- 运行单个测试文件：`node --test tests/<name>.test.js`。

---

### Task 1: 抽出 desktop/media-sniff.js 嗅探服务（保持旧行为）

**Files:**
- Create: `desktop/media-sniff.js`
- Create: `tests/media-sniff.test.js`
- Modify: `desktop/main.js:5383-5739`（该区内逻辑迁出，main.js 只留窗口工厂 + IPC 接线）

**Interfaces:**
- Produces: `createSniffService(deps)` → `{ resolve(url, {timeoutMs}) => Promise<result>, report(rawUrl, extra, settleAt) => {cancel:boolean}, settleSniff(force) => boolean, _debug() => {busy, active} }`；`result` 形状与现 IPC 完全一致：命中 `{ok:true, best:{url,score,mime}, candidates:[…]}`、未命中 `{ok:false, error:'TIMEOUT'|'BUSY'|'NO_URL'|…, candidates?}`。`deps = { ensureWindow, injectScript(win), readNextHop(win), sleep?, timeoutFloor? }`。另导出纯函数 `scoreMediaUrl(u, extra)`、`decodedMaccmsUrl(raw, encrypt)`、常量 `SFV_SNIFF_MARK = '[SFV-MEDIA]'`。Task 2/3/8 消费本接口。

- [ ] **Step 1: 写失败的纯函数测试（先钉住评分语义不被重构改坏）**

```js
// tests/media-sniff.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSniffService, scoreMediaUrl, decodedMaccmsUrl } = require('../desktop/media-sniff.js');

test('scoreMediaUrl: m3u8=120/mp4=90/flv=80/广告与图片=-1/命中词加成', () => {
  assert.equal(scoreMediaUrl('http://x/index.m3u8', {}), 120 + 10); // /index/ 命中 playlist|index|master
  assert.equal(scoreMediaUrl('http://x/v.mp4', {}), 90);
  assert.equal(scoreMediaUrl('http://x/v.flv', {}), 80);
  assert.equal(scoreMediaUrl('http://x/ad-banner.png', {}), -1);
  assert.equal(scoreMediaUrl('blob:https://x/abc', {}), -1);
  // 黑名单在前（main.js:5392 原语义）：.jpg 即使带内容嗅探证据也回 -1——迁移必须保持该优先级
  assert.equal(scoreMediaUrl('http://x/a.jpg', { fromExtM3u: true }), -1);
  assert.equal(scoreMediaUrl('http://x/play/seg', { fromExtM3u: true }), 120); // 内容嗅探证据
});

test('decodedMaccmsUrl: encrypt=1 base64 / encrypt=2 base64+URI / 0 原样', () => {
  assert.equal(decodedMaccmsUrl(Buffer.from('http://a/p.html').toString('base64'), 1), 'http://a/p.html');
  assert.equal(decodedMaccmsUrl(Buffer.from(encodeURIComponent('http://a/%2Ehtml')).toString('base64'), 2), 'http://a/.html');
  assert.equal(decodedMaccmsUrl('http://a/p.html', 0), 'http://a/p.html');
});
```

Run: `node --test tests/media-sniff.test.js` → Expected: FAIL（模块不存在）。

- [ ] **Step 2: 创建 desktop/media-sniff.js —— 迁移 + 行为保持版**

`scoreMediaUrl` / `decodedMaccmsUrl` 从 `main.js:5389-5406` / `main.js:5408-5419` **逐字迁移**（仅重命名 `sfvScoreMediaUrl→scoreMediaUrl`、`sfvDecodedMaccmsUrl→decodedMaccmsUrl`，`sfvScoreMediaUrl` 内 `extra.fromExtM3u` 分支顺序不动）。会话服务：

```js
function createSniffService(deps) {
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let busy = false;
  let active = null; // { settled, candidates, seen, resolve, timer, win }

  function settleSniff(force) {           // 原 main.js:5499-5514
    const s = active;
    if (!s || s.settled) return false;
    if (!s.candidates.length) return false;
    s.candidates.sort((a, b) => b.score - a.score);
    const best = s.candidates[0];
    if (!force && best.score < 50) return false;
    s.settled = true;
    clearTimeout(s.timer);
    s.resolve({ ok: true, best: { url: best.url, score: best.score, mime: best.mime },
                candidates: s.candidates.slice(0, 6) });
    return true;
  }

  // 统一上报入口：webRequest 通道(settleAt=90, extra.fromWebRequest=true)与 js-hook/console 通道(settleAt=100)
  function report(rawUrl, extra, settleAt) {
    const s = active;
    if (!s || s.settled) return { cancel: false };
    const u = String(rawUrl || '').trim();
    if (!u || s.seen.has(u)) return { cancel: false };
    if (/^blob:|^data:|^about:/.test(u)) return { cancel: false };
    const score = scoreMediaUrl(u, extra);
    if (score <= 0) return { cancel: false };
    s.seen.add(u);
    s.candidates.push({ url: u, score, mime: (extra && extra.resourceType) || (extra && extra.fromRange ? 'range' : '') });
    if (score >= (settleAt || 90)) {
      settleSniff(true);
      return { cancel: !!(extra && extra.fromWebRequest) }; // 命中即掐掉该请求，同旧 5450 行
    }
    return { cancel: false };
  }

  // ⚠️ 行为保持版：await 链与 BUSY 语义逐字沿用 main.js:5637-5739，Task 2 才改语义
  async function resolve(url, opts) {
    if (busy) return { ok: false, error: 'BUSY' };
    busy = true;
    try {
      if (!url) return { ok: false, error: 'NO_URL' };
      const timeoutMs = Math.max(deps.timeoutFloor || 6000, (opts && opts.timeoutMs) || 18000);
      const win = deps.ensureWindow(report);
      if (win.isDestroyed()) return { ok: false, error: 'WIN_DESTROYED' };
      let resolveFn;
      const result = new Promise((r) => { resolveFn = r; });
      active = { settled: false, candidates: [], seen: new Set(), resolve: resolveFn, win };
      active.timer = setTimeout(() => {
        if (active && !active.settled) {
          if (!settleSniff(true)) {
            active.settled = true;
            active.resolve({ ok: false, error: 'TIMEOUT', candidates: active.candidates.slice(0, 5) });
          }
        }
      }, timeoutMs);
      const injectAll = () => { try { deps.injectScript(win); } catch (e) {} };
      let hopUrl = url;
      for (let hop = 0; hop < 3 && !active.settled; hop++) {
        try { await win.loadURL(hopUrl); } catch (e) { injectAll(); }
        injectAll();
        await sleep(Math.min(2200, Math.floor(timeoutMs / 4)));
        if (active.settled) break;
        const next = await deps.readNextHop(win);
        if (!next || next === hopUrl) break;
        hopUrl = next;
      }
      if (active && !active.settled) {
        await sleep(1500); injectAll(); await sleep(800); settleSniff(true);
      }
      const r = await result;
      clearTimeout(active && active.timer);
      try { win.loadURL('about:blank'); } catch (e) {}
      return r;
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'SNIFF_ERROR' };
    } finally {
      active = null; busy = false;
    }
  }

  return { resolve, report, settleSniff, _debug: () => ({ busy, active }) };
}
module.exports = { createSniffService, scoreMediaUrl, decodedMaccmsUrl, SFV_SNIFF_MARK };
```

- [ ] **Step 3: 补行为保持测试（fake 窗口，不依赖 electron）**

```js
function fastWin() {
  const w = { loads: [], isDestroyed: () => false };
  w.loadURL = (u) => { w.loads.push(u); return Promise.resolve(); };
  return w;
}
function harness(deps) {
  const win = (deps && deps.win) || fastWin();
  const svc = createSniffService(Object.assign({
    ensureWindow: () => win,
    injectScript: () => {},
    readNextHop: async () => null,
    timeoutFloor: 20,
  }, deps || {}));
  return { win, svc };
}

test('保持：webRequest 命中(score>=90)返回 ok 且建议 cancel', async () => {
  const { svc } = harness();
  const p = svc.resolve('http://site/play/1.html', { timeoutMs: 30 });
  const res = await p;               // 行为保持版：走完 sleep 后由 settleSniff(true) 收割
  assert.equal(res.ok, true);
  assert.match(res.best.url, /m3u8/);
});

test('保持：会话进行中第二请求得到 BUSY', async () => {
  const { svc } = harness();
  const p1 = svc.resolve('http://site/play/1.html', { timeoutMs: 40 });
  assert.deepEqual(await svc.resolve('http://site/play/2.html', { timeoutMs: 40 }),
    { ok: false, error: 'BUSY' });
  await p1;
});
```

（第一条测试里 `report` 的驱动：在 `ensureWindow` 工厂返回的 win 上，让 `loadURL('http://site/play/1.html')` 的 Promise resolve 前先调用 `report('http://cdn/index.m3u8', { resourceType:'media', fromWebRequest:true }, 90)` —— harness 用 `new Promise(r => { report(...); r(); })` 版 win 实现，写成 `hitWin(svc)` 工厂。）

Run: `node --test tests/media-sniff.test.js` → Expected: 全 PASS。

- [ ] **Step 4: main.js 接线（删除区内旧实现，保留窗口工厂）**

`desktop/main.js`：`sfvEnsureSniffWindow(report)` 保留（`main.js:5421-5497` 的窗口创建），内部两处上报路径改为调用传入的 `report`：
- `onBeforeRequest` 回调改为：
```js
sfvSniffWin.webContents.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
  const headers = details.headers || {};
  const range = headers.Range || headers.range || '';
  const u = details.url || '';
  const isRangeVideo = /^bytes=/i.test(range) &&
    !/\.(js|css|html|json|png|jpe?g|gif|svg|woff2?|wasm)(\?|$)/i.test(u);
  const verdict = boundReport && boundReport(u,
    { resourceType: details.resourceType, fromRange: isRangeVideo, fromWebRequest: true }, 90);
  callback(verdict && verdict.cancel ? { cancel: true } : {});
});
```
（`boundReport` 由 `sfvEnsureSniffWindow(report)` 参数捕获；`sfvSniffWin` 常驻复用逻辑 `main.js:5422` 不变。）
- js-hook 与 console 兜底改为：
```js
ipcMain.on('sfv-sniff-media', (_e, url, tag) => {
  const t = String(tag || '');
  sfvSniff && sfvSniff.report(url,
    { fromExtM3u: t.indexOf('EXTM3U') >= 0, fromVideoTag: t.indexOf('VIDEO') >= 0, resourceType: 'js-hook' }, 100);
});
// console-message 兜底同款：msg.startsWith(SFV_SNIFF_MARK) → sfvSniff.report(msg.slice(SFV_SNIFF_MARK.length).trim(), 同上extra, 100)
```
- 服务实例与 IPC：
```js
const { createSniffService } = require('./media-sniff.js');
sfvSniff = createSniffService({
  ensureWindow: (report) => sfvEnsureSniffWindow(report),
  injectScript: (win) => {
    try { win.webContents.executeJavaScript(SFV_SNIFF_INJECT, true).catch(() => {}); } catch (e) {}
    try {
      const frames = win.webContents.mainFrame && win.webContents.mainFrame.frames;
      for (const f of (frames || [])) { try { f.executeJavaScript(SFV_SNIFF_INJECT).catch(() => {}); } catch (e) {} }
    } catch (e) {}
  },
  readNextHop: (win) => sfvReadNextHop(win), // 原 main.js:5682-5700 的 player_aaaa executeJavaScript，逐字迁移为具名函数
});
ipcMain.handle('stellaflix-resolve-media-sniff', (_e, payload = {}) =>
  sfvSniff.resolve(payload && payload.url, { timeoutMs: payload && payload.timeoutMs }));
```
删除旧 `sfvSniffBusy/sfvSniffActive/sfvSettleSniff/scoreMediaUrl 区段/handler`（5383-5739 中被迁走部分）。`SFV_SNIFF_INJECT` 字符串留在 main.js（Task 3 才动）。

- [ ] **Step 5: 全量回归 + 真机冒烟**

Run: `npm test` → Expected: 不新增失败（基线 148/149）。真机：开一个规则源点一集，`[KazumiBridge] 隐藏窗口嗅探命中` 日志行为与改动前一致。

- [ ] **Step 6: Commit（待主人明示「提交」）**

```bash
git add desktop/media-sniff.js desktop/main.js tests/media-sniff.test.js
git commit -m "refactor: 嗅探编排抽出 desktop/media-sniff.js 服务（行为保持）"
```

**收获：** 嗅探核心第一次变成可用 fake 窗口做行为测试的模块，后续 Task 2/3 的改动全部有测试护栏；main.js 该区域从 ~360 行降到 ~120 行接线。
**后果/风险：** 纯迁移也可能在 `report` 参数捕获（窗口创建早于服务实例存在）上出时序 bug——用 Step 5 冒烟兜底；IPC 契约与 result 形状未变，前端零改动。

---

### Task 2: 嗅探事件驱动化 + BUSY→抢占（计划的核心收益点）

**Files:**
- Modify: `desktop/media-sniff.js`（resolve/收尾路径）
- Modify: `tests/media-sniff.test.js`（新增语义测试）

**Interfaces:**
- Consumes: Task 1 的 `createSniffService` 接口。
- Produces: 语义变化——`resolve()` 不再 await 导航驱动，命中/超时即刻返回；BUSY 分支删除，改为旧会话收到 `{ok:false, error:'SUPERSEDED'}`。`settleSniff` 改为按会话作用域 `settleSniff(session, force)`（内部方法，签名不出模块）；对外 API 名不变。

- [ ] **Step 1: 先写三个失败的语义测试**

```js
function hangWin() { // loadURL 永不完成（模拟慢页），about:blank 例外
  const w = { loads: [], isDestroyed: () => false };
  w.loadURL = (u) => { w.loads.push(u);
    return u === 'about:blank' ? Promise.resolve() : new Promise(() => {}); };
  return w;
}

test('事件驱动：页面永不出加载完成时，命中即返回且导航现场被卸载', async () => {
  const win = hangWin();
  const svc = createSniffService({ ensureWindow: (report) => { svcReport = report; return win; },
    injectScript: () => {}, readNextHop: async () => null, timeoutFloor: 50 });
  let svcReport;
  const p = svc.resolve('http://site/play/1.html', { timeoutMs: 5000 });
  await new Promise(setImmediate);
  svcReport('http://cdn/index.m3u8', { resourceType: 'media', fromWebRequest: true }, 90);
  const res = await p;                     // 旧实现会卡死在 loadURL——本测试即红
  assert.equal(res.ok, true);
  assert.equal(res.best.url, 'http://cdn/index.m3u8');
  assert.ok(win.loads.includes('about:blank'));
});

test('抢占：第二会话使第一会话 SUPERSEDED，而非 BUSY 拒绝', async () => {
  const { svc } = harness();
  const p1 = svc.resolve('http://site/play/1.html', { timeoutMs: 3000 });
  await new Promise(setImmediate);
  const p2 = svc.resolve('http://site/play/2.html', { timeoutMs: 3000 });
  assert.deepEqual(await p1, { ok: false, error: 'SUPERSEDED' });
  svc.report('http://cdn/2.m3u8', { resourceType: 'media' }, 90); // 驱动 p2 收敛：命中
  const r2 = await p2;
  assert.equal(r2.ok, true);
});

test('超时仍由会话计时器收敛为 TIMEOUT', async () => {
  const win = hangWin();
  const svc = createSniffService({ ensureWindow: () => win, injectScript: () => {},
    readNextHop: async () => null, timeoutFloor: 40 });
  const res = await svc.resolve('http://site/play/1.html', { timeoutMs: 40 });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'TIMEOUT');
});
```

Run: `node --test tests/media-sniff.test.js` → Expected: 新增三条 FAIL（旧 resolve 阻塞）。

- [ ] **Step 2: 重写 resolve 为「返回会话 promise + 后台驱动」结构**

```js
  async function resolve(url, opts) {
    if (!url) return Promise.resolve({ ok: false, error: 'NO_URL' });
    const timeoutMs = Math.max(deps.timeoutFloor || 6000, (opts && opts.timeoutMs) || 18000);
    if (active) {                       // 抢占式取消（对齐 Kazumi _activeRequest?.cancel()，service.dart:36）
      const prev = active;
      prev.settled = true;
      clearTimeout(prev.timer);
      prev.resolve({ ok: false, error: 'SUPERSEDED' });
      try { prev.win.loadURL('about:blank'); } catch (e) {}
    }
    const win = deps.ensureWindow(report);
    if (win.isDestroyed()) return { ok: false, error: 'WIN_DESTROYED' };
    const session = { settled: false, candidates: [], seen: new Set(), win };
    session.promise = new Promise((r) => { session.resolve = r; });
    session.timer = setTimeout(() => {
      if (session.settled) return;
      if (!settleSniff(session, true)) {
        session.settled = true;
        if (active === session) active = null;
        session.resolve({ ok: false, error: 'TIMEOUT', candidates: session.candidates.slice(0, 5) });
      }
      try { session.win.loadURL('about:blank'); } catch (e) {}
    }, timeoutMs);
    active = session;
    driveSession(session, url, timeoutMs);   // 后台导航驱动：不阻塞返回
    return session.promise;                  // ← 命中/超时即刻出画链路继续
  }

  function settleSniff(session, force) {
    const s = session;
    if (!s || s.settled || !s.candidates.length) return false;
    const best = s.candidates.reduce((a, b) => (b.score > a.score ? b : a));
    if (!force && best.score < 50) return false;
    s.settled = true;
    clearTimeout(s.timer);
    if (active === s) active = null;
    s.resolve({ ok: true, best: { url: best.url, score: best.score, mime: best.mime },
                candidates: s.candidates.slice(0, 6) });
    try { s.win.loadURL('about:blank'); } catch (e) {}   // 对齐 Kazumi unloadPage
    return true;
  }

  async function driveSession(session, url, timeoutMs) {
    const perHop = Math.min(2200, Math.floor(timeoutMs / 4));
    let hopUrl = url;
    for (let hop = 0; hop < 3 && !session.settled; hop++) {
      try { await session.win.loadURL(hopUrl); } catch (e) {}
      if (session.settled) return;
      try { deps.injectScript(session.win); } catch (e) {}
      await sleep(perHop);
      if (session.settled) return;
      let next = null;
      try { next = await deps.readNextHop(session.win); } catch (e) {}
      if (session.settled || !next || next === hopUrl) return;
      hopUrl = next;
    }
    if (!session.settled) { await sleep(Math.min(1500, perHop)); settleSniff(session, false); }
    // 仍未命中：不发 TIMEOUT——由 session.timer 到点统一收敛，避免早于站点自身慢加载判死
  }

  function report(rawUrl, extra, settleAt) { /* 同 Task1，但命中调 settleSniff(active, true)，返回 {cancel: hit && fromWebRequest} */ }
```

删除 `busy` 变量与 BUSY 分支。

- [ ] **Step 3: 跑测试**

Run: `node --test tests/media-sniff.test.js` → Expected: 全部 PASS（含 Task 1 的 BUSY 保持测试**删除或改写**为 SUPERSEDED 断言——BUSY 测试在语义变更后作废，删除之，不留兼容壳）。`npm test` 无新增失败。

- [ ] **Step 4: Commit（待主人明示）** — `refactor(media-sniff): 嗅探事件驱动返回 + 抢占式会话取消（去 BUSY）`

**收获：** 真机「点击→出画」最坏路径从「整页加载+2.2s/hop+尾 2.3s+等 result」变为「首个 ≥90 分候选出现即返回」；连点切集不再被 BUSY 打进 12s HTML 降级链，而是旧会话即刻让位（对齐 Kazumi 语义）。
**后果/风险：** ① 抢占让被超集的前一次解析以 `SUPERSEDED` 失败收场——`kazumi-bridge.js:382-387` 会把它当未命中转 HTML 降级，给陈旧集多发一次代理请求；需在 bridge 侧把 `SUPERSEDED` 视为静默中止（bridge 判 `sniffRes.error === 'SUPERSEDED'` 直接 `return null` 且降级仅当 `mySeq === playSeq`——编排器已有 C2 令牌 `play-orchestrator.js:86,264`，陈旧 doPlay 不会落地，风险已被上层闸住，但 bridge 仍加 error 透传日志）。② `about:blank` 抢占卸载与在途 `loadURL` 竞态：Electron 会以 reject/中断告终，driveSession 全部 try/catch。③ js-hook 阈值 100 与 webRequest 阈值 90 并存保留（不改判定，只改时序）。

---

### Task 3: 嗅探钩子提前注入（dom-ready / 帧导航），不再只靠 did-finish-load

**Files:**
- Modify: `desktop/main.js`（`sfvEnsureSniffWindow` 事件绑定区）
- Create: `tests/media-sniff-early-inject.test.js`

**Interfaces:**
- Consumes: Task 1 保留在 main.js 的 `SFV_SNIFF_INJECT` 与 `sfvSniffInjectTo(win)`（接线时把 injectScript 体内提为具名函数）。
- Produces: 无对外接口；新增具名函数 `sfvOnEarlyNav` 供测试断言。

- [ ] **Step 1: 写失败测试（源码断言，理由：executeJavaScript 时序无法在 node:test 驱动真窗口）**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');

test('sniff 窗口在 dom-ready 与帧导航即注入钩子（早于 did-finish-load）', () => {
  assert.match(src, /webContents\.on\('dom-ready', sfvOnEarlyNav\)/);
  assert.match(src, /webContents\.on\('did-frame-navigate', sfvOnEarlyNav\)/);
  assert.match(src, /function sfvOnEarlyNav\(\)/);
});
```

Run: `node --test tests/media-sniff-early-inject.test.js` → Expected: FAIL。

- [ ] **Step 2: 实现**（`desktop/main.js`，sfvEnsureSniffWindow 内、`return sfvSniffWin;` 前）

```js
  const sfvOnEarlyNav = () => { try { sfvSniffInjectTo(sfvSniffWin); } catch (e) {} };
  sfvSniffWin.webContents.on('dom-ready', sfvOnEarlyNav);
  sfvSniffWin.webContents.on('did-frame-navigate', sfvOnEarlyNav);
```

`sfvSniffInjectTo(win)` = Task 1 接线时抽出的 injectScript 主体（主框架 + `mainFrame.frames` 遍历 executeJavaScript，幂等由注入串自带的 `window.__sfvSniffHooked` 守卫，main.js:5517）。保留 did-finish-load/did-navigate-in-page 原绑定作为晚帧兜底。
**Electron ^42 备注：** `media-sniff-preload.js` 运行在 isolated world，包装页世界 `Response.prototype.text` 无效，故不走 `registerPreloadScript(main world)`（其跨版本 API 面不稳，[AI推理]），维持 executeJavaScript 提前时机的方案。

- [ ] **Step 3: 跑测试** → PASS；`npm test` 无新增失败。
- [ ] **Step 4: Commit（待主人明示）** — `perf(media-sniff): 钩子注入提前至 dom-ready/帧导航`

**收获：** fetch/XHR/Response 钩子从「整页加载后」提前到「DOMContentLoaded」，站点在 DOM ready 后动态取流（MacCMS player.js 常见形态）可被 js-hook 通道即时捕获（120 分即 settle）；配合 Task 2，js-hook 通道首次具备实际提前命中能力，而不是形同虚设。
**后果/风险：** dom-ready 时对 `<video>` 静态 src 的初扫 `scanVideo(document)` 可能 DOM 未全 → 靠既有 400ms×24 次轮询（main.js:5625-5631）与 MutationObserver 补，不新增逻辑；注入次数增多但有 `__sfvSniffHooked` 幂等守卫，重复 executeJavaScript 成本微。

---

### Task 4: Kazumi 路径客户端超时（装饰器注入，不动 GPL 内核）

**Files:**
- Create: `public/video/http-timeout-decorator.js`（UMD，可 node 测）
- Create: `tests/http-timeout-decorator.test.js`
- Modify: `public/video/kazumi-bridge.js`（`getManager()` 117-130 区：manager 建立后包一层）
- Modify: `public/index.html`（SFV_SCRIPTS 在 kazumi-bridge.js 之前插入）

**Interfaces:**
- Consumes: `KazumiHttpClient.get/post(url, {timeoutMs})` 原生支持（kazumi/http-client.js:81,90）。
- Produces: `SFVHttpTimeoutDecorator.withDefaultTimeout(client, ms)` → 新 client（`Object.create` 委托，`get/post` 默认注入 `timeoutMs`，显式传入可覆盖）。bridge 暴露的 `SFV.kazumi.getManager()` 返回值即装饰后 client 挂在 `mgr.httpClient`。Task 8 消费日志前缀 `[SFV-HTTP-TIMEOUT]`。

- [ ] **Step 1: 写失败测试**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { withDefaultTimeout } = require('../public/video/http-timeout-decorator.js');

test('withDefaultTimeout: 缺省注入 timeoutMs，显式值不被覆盖，其余方法委托', async () => {
  const calls = [];
  const base = {
    get: (u, o) => { calls.push(['get', u, o]); return Promise.resolve('ok'); },
    post: (u, b, o) => { calls.push(['post', u, o]); return Promise.resolve('ok'); },
    toProxyUrl: (u) => 'P' + u,
  };
  const w = withDefaultTimeout(base, 12000);
  await w.get('http://x', { useProxy: true });
  await w.get('http://y', { timeoutMs: 5000 });
  assert.deepEqual(calls[0][2], { useProxy: true, timeoutMs: 12000 });
  assert.deepEqual(calls[1][2], { timeoutMs: 5000 });
  assert.equal(w.toProxyUrl('a'), 'Pa');
  assert.equal(withDefaultTimeout(w, 9).get, w.get); // 二次包裹幂等
});
```

Run: `node --test tests/http-timeout-decorator.test.js` → FAIL（模块不存在）。

- [ ] **Step 2: 实现 `public/video/http-timeout-decorator.js`**

```js
/* Kazumi HttpClient 超时装饰层 — 不触碰 public/video/kazumi/ 内核（GPL 边界） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SFVHttpTimeoutDecorator = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function withDefaultTimeout(client, ms) {
    if (!client || typeof client.get !== 'function' || client.__sfvTimeoutWrapped) return client;
    var wrapped = Object.create(client);
    wrapped.get = function (url, opts) {
      return client.get(url, Object.assign({ timeoutMs: ms }, opts || {}));
    };
    if (typeof client.post === 'function') {
      wrapped.post = function (url, body, opts) {
        return client.post(url, body, Object.assign({ timeoutMs: ms }, opts || {}));
      };
    }
    wrapped.__sfvTimeoutWrapped = true;
    return wrapped;
  }
  return { withDefaultTimeout: withDefaultTimeout };
});
```

- [ ] **Step 3: 接线 + 内核引用方式验证（关键前置）**

先验证核心是否每次请求现读 `mgr.httpClient`：
```bash
grep -n "httpClient" public/video/kazumi/*.js
```
- 若核心形如 `this.httpClient.get(...)` 现读属性 → 在 `kazumi-bridge.js` `getManager()` 返回前：
```js
      var wrap = global.SFVHttpTimeoutDecorator && global.SFVHttpTimeoutDecorator.withDefaultTimeout;
      if (wrap && _manager) {
        _manager.httpClient = wrap(_manager.httpClient || global.KazumiHttpClient, 12000);
      }
```
- 若核心在构造时快照了局部引用 → 改为在 `public/index.html` SFV_SCRIPTS 中把 `video/http-timeout-decorator.js` 排在 `video/kazumi/index.js` **之前**，并在装饰器文件尾部加：
```js
if (typeof window !== 'undefined' && window.KazumiHttpClient) {
  window.KazumiHttpClient = withDefaultTimeout(window.KazumiHttpClient, 12000);
}
```
两种落点二选一，以 grep 结果为准，在本 task 的 commit message 里记录选中的分支。

- [ ] **Step 4: 跑测试**：单测 PASS；`npm test` 无新增失败；真机冒烟：断网/挂慢源时 `[SFV HLS]`/bridge 日志出现 AbortError 而非无限挂起。
- [ ] **Step 5: Commit（待主人明示）** — `feat(kazumi-bridge): HTTP 客户端 12s 超时装饰（内核零改动）`

**收获：** 弱源/半死连接不再无限吊尾——与 server 代理 12s、Kazumi 原版 Dio 12s（network_config.dart:11-12）三方对齐；编排器 30s 看门狗（play-orchestrator.js:255-262）从常态兜底退化为真兜底。
**后果/风险：** 阈值取 12000 是拍定于「>server 12s」的边界值——search/chapters 走代理时两端同为 12s 有竞态，故 client 侧应取 13000 留余量（实现里 `withDefaultTimeout(..., 13000)`），显式测试断言同步改 13000；慢但健康的源（>13s 响应）将首次被判失败，行为与原版「干等」不同，若真机有此类源属预期内的取舍。

---

### Task 5: 首帧耗时测量 play-timing（后续 A/B 的同一把尺子）

**Files:**
- Create: `public/video/play-timing.js`（UMD）
- Create: `tests/play-timing.test.js`
- Modify: `public/video/play-orchestrator.js`（打点 3 处）
- Modify: `public/video/source-adapter-hls.js`（打点 3 处）
- Modify: `public/video/kazumi-bridge.js`（打点 2 处）
- Modify: `public/index.html`（SFV_SCRIPTS 最前段，早于 detail-source/play-orchestrator）

**Interfaces:**
- Produces: `SFVPlayTiming.mark(stage, extra)`、`SFVPlayTiming.summary()`；stage 序列固定为 `play-click → resolve-start → resolve-done → attach-start → manifest → frag0 → firstframe`；`play-click` 会清空上一轮 marks 并 `seq++`。Task 6/7/8 消费同一序列。

- [ ] **Step 1: 写失败测试**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../public/video/play-timing.js');

test('play-click 重置序号与 marks；summary 按固定序列输出增量', () => {
  T.mark('play-click');
  const s1 = T.seq;
  T.mark('resolve-done', 'media-sniff');
  T.mark('manifest');
  assert.equal(Object.keys(T._marks()).length, 3);
  T.mark('play-click');
  assert.equal(T.seq, s1 + 1);
  assert.deepEqual(Object.keys(T._marks()), ['play-click']);
});

test('未打满序列时 summary 只输出已有阶段且不抛错', () => {
  T.mark('play-click');
  T.mark('firstframe');
  const out = T.summary();
  assert.match(out, /play-click/);
  assert.match(out, /firstframe/);
  assert.doesNotThrow(() => T.summary());
});
```

Run: `node --test tests/play-timing.test.js` → FAIL。

- [ ] **Step 2: 实现 `public/video/play-timing.js`**

```js
/* 点击→出画阶段测量 —— 对齐 Kazumi「没有计时就没有优化」；纯旁路，不参与控制流 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.SFVPlayTiming = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (global) {
  'use strict';
  var marks = {};
  var seq = 0;
  var ORDER = ['play-click', 'resolve-start', 'resolve-done', 'attach-start', 'manifest', 'frag0', 'firstframe'];
  function now() {
    return (global.performance && global.performance.now) ? global.performance.now() : Date.now();
  }
  function mark(stage, extra) {
    if (stage === 'play-click') { marks = {}; seq++; }
    marks[stage] = { t: now(), extra: extra == null ? null : String(extra) };
    try { global.console && console.log('[SFV-TIMING] seq=' + seq + ' ' + stage + '@' + Math.round(marks[stage].t)); } catch (e) {}
  }
  function summary() {
    var lines = []; var prev = null;
    for (var i = 0; i < ORDER.length; i++) {
      var m = marks[ORDER[i]];
      if (!m) continue;
      lines.push(ORDER[i] + (prev ? '(+' + Math.round(m.t - prev.t) + 'ms)' : '') );
      prev = m;
    }
    return lines.join(' ');
  }
  return { mark: mark, summary: summary, seq: function () { return seq; }, _marks: function () { return marks; } };
});
```

浏览器分支收口时补一行别名接线（与 UMD 同文件末尾）：`if (global.StellaflixVideo) global.StellaflixVideo.playTiming = global.SFVPlayTiming;` —— 后续打点全部按 `SFV.playTiming` 引用。

- [ ] **Step 3: 打点接线（每处两行以内，旁路 try/catch）**

- `play-orchestrator.js:84` play() 首行后：`try { SFV.playTiming && SFV.playTiming.mark('play-click'); } catch (e) {}`
- `play-orchestrator.js:251` isKazumi 分支进入处：`mark('resolve-start')`；`.then` 拿到 `resolved` 后：`mark('resolve-done', resolved && resolved.method)`。
- `play-orchestrator.js:125` doPlay 进入：`mark('attach-start')`。
- `kazumi-bridge.js:397` resolvePlayUrlWebview 起：`SFV.playTiming && SFV.playTiming.mark('sniff-start')`、IPC 返回后 `mark('sniff-done')`（sniff-* 不在 ORDER 内，单独成行输出即可，summary 不受影响）。
- `source-adapter-hls.js`：`hls.on(Hls.Events.MANIFEST_PARSED` 首次回调处 `mark('manifest')`（用局部 `var manifestMarked=false` 守卫）；`FRAG_LOADED` 首次（start===0 分支，约 :237）`mark('frag0')`；`videoEl.addEventListener('playing', …, { once: true })` 里 `mark('firstframe'); console.log('[SFV-TIMING] ' + SFV.playTiming.summary())`。

- [ ] **Step 4: 跑测试 + 真机**：单测 PASS；`npm test` 无新增失败；真机点一集规则源，控制台出现完整 `[SFV-TIMING] … +Xms` 链。**记录一条改前基线数据（同集两遍取第二遍）。**
- [ ] **Step 5: Commit（待主人明示）** — `feat(video): play-timing 点击→出画阶段测量`

**收获：** 之后每个优化都有前后数字；「慢」从体感变成 `[SFV-TIMING]` 可对比数据；给 Task 6 A/B 提供同一把尺子。
**后果/风险：** 全局脚本新增一个加载项（数组顺序错误会导致 `SFV.playTiming` undefined——所有打点均带 `SFV.playTiming &&` 短路，无崩溃风险）；marks 是内存态，重启即失，不落盘。

---

### Task 6: mpv 在线内核实验开关（A/B 数据收集器，默认关）

**Files:**
- Create: `public/video/source-adapter-mpv.js`
- Modify: `public/video/play-orchestrator.js`（doPlay 前置实验分支）
- Modify: `public/index.html`（SFV_SCRIPTS 追加，排在 play-orchestrator.js 后）
- Create: `tests/source-adapter-mpv-strip.test.js`

**Interfaces:**
- Consumes: `window.stellaflixVideo` mpv API（`desktop/preload-video.js:52-63`：create/destroy/command/setProperty/seek/createOverlay/destroyOverlay/setBounds）与事件广播（`mpv-controller.setEventBroadcast` 既有）；`SFV.playTiming`（Task 5）。
- Produces: `SFV.sourceAdapterMpv = { enabled(), open(videoElHostRectGetter, url, meta), close() }`；开关存储键 `localStorage['sfv-online-kernel'] === 'mpv'`（DevTools 里 `localStorage.setItem('sfv-online-kernel','mpv')` 开启，默认关）。

- [ ] **Step 1: 前置勘察（读现有调用范式，不猜测 API 形状）**

```bash
grep -n "stellaflixVideo\|mpv\.\|createOverlay\|loadfile\|file-loaded\|event" public/video/huilian-page.js public/video/huilian-player-bar.js | head -40
```
把 huilian 的「create → overlay 绑定 → setProperty → loadfile → 事件回收」顺序抄录进实现注释，参数形状逐字对齐。

- [ ] **Step 2: 写失败测试（纯函数：剥代理层 + UA 提取）**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../public/video/source-adapter-mpv.js')._test;

test('stripProxyLayer: /api/proxy?url=… 还原真实直链，裸 URL 原样', () => {
  assert.equal(M.stripProxyLayer('/api/proxy?url=' + encodeURIComponent('http://cdn/a.m3u8')), 'http://cdn/a.m3u8');
  assert.equal(M.stripProxyLayer('http://cdn/b.mp4'), 'http://cdn/b.mp4');
});
test('ruleHeaders: 从规则生成 mpv http-header-fields', () => {
  var h = M.ruleHeaders({ referer: 'http://v.org/' }, 'http://cdn/a.m3u8');
  assert.match(h.join(';'), /Referer=http:\/\/v\.org\/);?/);
  assert.match(h.join(';'), /User-Agent=/);
});
```

Run: `node --test tests/source-adapter-mpv-strip.test.js` → FAIL。

- [ ] **Step 3: 实现 `public/video/source-adapter-mpv.js`**

```js
/*
 * 在线规则源 mpv 实验内核（A/B 用，默认关）——对齐 Kazumi：裸 URL + UA/Referer 直喂 mpv，
 * 绕开 hls.js 事件管线与 /api/proxy 数据面（背景取证 §player_playback_controller.dart:350-370,459-463 同源机制）。
 * 调用序列照抄 huilian-page.js（Step 1 抄录），仅两处不同：
 *   1) URL 是网络直链而非本地文件；2) overlay 几何跟随在线播放器 #video-container 矩形，用 ResizeObserver 同步 setBounds。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  if (SFV.sourceAdapterMpv) return;

  function enabled() { try { return global.localStorage.getItem('sfv-online-kernel') === 'mpv'; } catch (e) { return false; } }
  function stripProxyLayer(u) {
    var m = /[?&]url=([^&]+)/.exec(String(u || ''));
    if (m && /^\/api\/proxy/.test(String(u))) { try { return decodeURIComponent(m[1]); } catch (e) {} }
    return u;
  }
  function ruleHeaders(rule, targetUrl) {
    var ref = (rule && rule.referer) || '';
    if (!ref) { try { ref = new URL(targetUrl).origin + '/'; } catch (e) {} }
    var ua = (rule && rule.userAgent) || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
    return ['User-Agent: ' + ua, 'Referer: ' + ref, 'Origin: ' + (function(){ try { return new URL(targetUrl).origin; } catch(e){ return ''; } })()];
  }
  var session = null; // { id, overlayId, ro }
  async function open(getRect, rawUrl, meta) {
    var b = global.stellaflixVideo;
    if (!b || !b.mpv) return false;
    var url = stripProxyLayer(rawUrl);
    try {
      await close();
      var created = await b.mpv.create({});            // 形状以 Step 1 抄录为准
      session = { id: created.id || created.playerId };
      var ov = await b.mpv.createOverlay({ playerId: session.id });
      session.overlayId = ov && ov.id;
      var sync = function () {
        var r = getRect(); if (r && session) b.mpv.setBounds(session.id, r);
      };
      sync();
      if (global.ResizeObserver) { session.ro = new ResizeObserver(sync); session.ro.observe(document.getElementById('video-container') || document.body); }
      await b.mpv.setProperty(session.id, 'http-header-fields', ruleHeaders(meta.rule, url).join(';'));
      await b.mpv.command(session.id, ['loadfile', url]);
      SFV.playTiming && SFV.playTiming.mark('mpv-loadfile');
      return true;
    } catch (e) {
      console.warn('[SFV-MPV-ONLINE] 起播失败回退 hls:', e && e.message);
      await close();
      return false;
    }
  }
  async function close() {
    if (!session) return;
    var s = session; session = null;
    try { s.ro && s.ro.disconnect(); } catch (e) {}
    try { var b = global.stellaflixVideo; b && s.overlayId && await b.mpv.destroyOverlay(s.overlayId); b && s.id && await b.mpv.destroy(s.id); } catch (e) {}
  }
  SFV.sourceAdapterMpv = { enabled: enabled, open: open, close: close,
    _test: { stripProxyLayer: stripProxyLayer, ruleHeaders: ruleHeaders } };
})(typeof window !== 'undefined' ? window : globalThis);
```

（**注：** `b.mpv.create({})` 的入参/返回字段、事件订阅名（`file-loaded` 等）以 Step 1 抄录的 huilian 实际用法为准修正——本骨架的 create/overlay/setBounds 调用次序若与 huilian 不同，以 huilian 为准，改在实现 commit 里注明。）

- [ ] **Step 4: doPlay 实验分支接线**（`play-orchestrator.js:125` doPlay 内、`SFV.source.open(meta)` 之前）

```js
      if (SFV.sourceAdapterMpv && SFV.sourceAdapterMpv.enabled()) {
        var hostEl = document.getElementById('video-container');
        SFV.sourceAdapterMpv.open(function () { var r = hostEl && hostEl.getBoundingClientRect(); return r && { x: r.left, y: r.top, width: r.width, height: r.height }; }, playUrl, { rule: view && view.rule })
          .then(function (ok) { if (!ok && mySeq === playSeq) { /* 落回原 hls 路径：继续执行下面的 source.open */ } });
        // 成功时跳过 source.open：实现为 if(ok) return; else 原路径（编写时用 try/catch 包裹保持序号令牌语义）
      }
```
（接线时按现读 doPlay 结构改写为早退形式，不保留注释伪代码；`SFV.player` 的 UI 控制器在 mpv 模式下仅保留进度条时间从 `getProperty('time-pos')` 轮询——照搬 huilian-player-bar 既有做法。）

- [ ] **Step 5: 测试 + 真机 A/B 数据**

`node --test tests/source-adapter-mpv-strip.test.js` → PASS；`npm test` 无新增失败。真机：同一规则源同一集，各录 `[SFV-TIMING]` 两条（kernel=hls / kernel=mpv，各两遍取第二次），连同「seek 拖动、切集、断网重连」三项主观对比**交主人目验**，数据记入项目记忆。
- [ ] **Step 6: Commit（待主人明示）** — `feat(video): 在线源 mpv 实验内核开关（默认关，sfv-online-kernel）`

**收获：** 拿到「hls.js vs mpv 首帧/卡顿」的本项目真机数据，决定第三阶段是否正式换内核——这是唯一需要架构级取舍的点，先用数据裁决而非先翻版。
**后果/风险：** 实验路径，默认关；mpv overlay 与影视页 z-index/主题类的历史坑（hex-card-wall 教训：勿在 unmount 删宿主主题类）要求 close 路径只清理自己创建的 overlay；若 Step 1 发现 mpv 通道被 huilian 独占（单例限制），A/B 改为「本地起 mpv 独立窗口对比录屏计时」，不动生产代码路径。

---

### Task 7: 按 origin 直连能力记忆 —— 代理从默认路径降级为兜底路径

**Files:**
- Create: `public/video/direct-capability.js`（UMD）
- Create: `tests/direct-capability.test.js`
- Modify: `public/video/kazumi-bridge.js:414-421`（sniff 命中不再无条件包装 `/api/proxy?url=`）
- Modify: `public/video/source-adapter-hls.js`（loader 选择 + 失败降级 + 成功升格）
- Modify: `public/index.html`（direct-capability 排在 source-adapter-hls.js 之前）

**Interfaces:**
- Consumes: `SFV.directCap`（本任务产出）。
- Produces: `SFVDirectCap = { shouldProxy(url), promote(url), demote(url), originOf(url), _store(): {} }`，localStorage 键 `sfv-direct-cap-v1`，值 `{ '<origin>': 'direct'|'proxy' }`；**未知 origin 默认试直连**（shouldProxy=false）。`kazumi-bridge` 的 `resolvePlayUrl` 返回体 `url` 字段从代理包装串变为裸直链（media-sniff 路径；HTML 嗅探路径本就返回原样串，契约统一）。

- [ ] **Step 1: 写失败测试**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const mem = {};
globalThis.localStorage = {
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
};
const C = require('../public/video/direct-capability.js');

test('未知 origin 默认试直连（shouldProxy=false）', () => {
  assert.equal(C.shouldProxy('http://fresh-cdn.org/a.m3u8'), false);
});
test('demote 持久化后该 origin 走代理；promote 清除记录', () => {
  C.demote('http://d.cdn/x/a.m3u8');
  assert.equal(C.shouldProxy('http://d.cdn/x/b.m3u8'), true);
  C.promote('http://d.cdn/x/a.m3u8');
  assert.equal(C.shouldProxy('http://d.cdn/x/b.m3u8'), false);
  assert.equal(JSON.parse(mem['sfv-direct-cap-v1'])['http://d.cdn'], undefined);
});
test('非 http(s)/坏 URL 一律走代理', () => {
  assert.equal(C.shouldProxy('blob:abc'), true);
  assert.equal(C.shouldProxy(''), true);
});
```

Run: `node --test tests/direct-capability.test.js` → FAIL。

- [ ] **Step 2: 实现 `public/video/direct-capability.js`**

```js
/* 按 origin 记忆「直连能力」：CDN 发 ACAO 头则 hls.js 可直连；403/CORS 失败降格走 /api/proxy。
   未知 origin 试直连——首通升格(direct)，首败降格(proxy)并自动带代理重试一次（见 source-adapter-hls）。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.SFVDirectCap = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (global) {
  'use strict';
  var KEY = 'sfv-direct-cap-v1';
  function store() {
    var ls = global.localStorage;
    if (!ls) return null;
    return {
      get: function () { try { return JSON.parse(ls.getItem(KEY) || '{}'); } catch (e) { return {}; } },
      set: function (m) { try { ls.setItem(KEY, JSON.stringify(m)); } catch (e) {} },
    };
  }
  function originOf(u) {
    try { return new URL(String(u)).origin; } catch (e) { return ''; }
  }
  function shouldProxy(url) {
    var o = /^https?:/i.test(String(url)) ? originOf(url) : '';
    if (!o) return true;
    var s = store();
    if (!s) return true;
    return s.get()[o] === 'proxy';
  }
  function mark(url, val) {
    var o = originOf(url); if (!o) return;
    var s = store(); if (!s) return;
    var m = s.get();
    if (val === null) delete m[o]; else m[o] = val;
    s.set(m);
  }
  return { shouldProxy: shouldProxy, promote: function (u) { mark(u, null); },
           demote: function (u) { mark(u, 'proxy'); }, originOf: originOf, KEY: KEY };
});
```

浏览器分支收口时补一行别名接线（同文件末尾）：`if (global.StellaflixVideo) global.StellaflixVideo.directCap = global.SFVDirectCap;` —— Step 4 的 `SFV.directCap` 引用以此落地。

- [ ] **Step 3: bridge 去包装**（`kazumi-bridge.js:414-421`）

```js
        if (best && best.url) {
          var rawUrl = best.url;
          // Task 7: 返回裸直链；是否经 /api/proxy 由播放层按 origin 能力记忆决定（direct-capability）
          var playUrl = rawUrl;
          console.log('[KazumiBridge] 隐藏窗口嗅探命中(score=' + (best.score || 0) + '): ' + rawUrl.slice(0, 120));
          return { url: playUrl, method: 'media-sniff', embed: false };
```
（删除 `if (/^https?… /api/proxy?url=…` 两行。防盗链头问题由 server 代理继续兜：能力记忆降格的 origin 会重新被包。）

- [ ] **Step 4: attachHls 三处改造**（`source-adapter-hls.js`）

① loader 按能力选择——`new Hls({...})` 处（:167）：
```js
      var cap = SFV.directCap;
      var directUsed = !opts.__sfvProxyRetried && cap && !cap.shouldProxy(playUrl);
      var hls = new Hls({
        loader: directUsed ? ((Hls.DefaultConfig && Hls.DefaultConfig.loader) || global.XMLHttpRequest) : makeProxyLoader(Hls),
```
（其余 config 值一字不动，保住 tests/hls-proxy-timeout-alignment.test.js 的超时不变式。）
② 成功升格——`MANIFEST_PARSED` 首次回调（约 :246）内：
```js
        if (directUsed && cap) { cap.promote(playUrl); }
```
③ 失败降格 + 单次自动重试——fatal ERROR 处理入口（现 :278-301 区域）最前：
```js
        if (directUsed && (data.details === 'manifestLoadError' || data.details === 'levelLoadError') && !opts.__sfvProxyRetried) {
          if (cap) cap.demote(playUrl);
          global.console && global.console.info('[SFV HLS] 直连失败→降格代理并重试一次:', urlSummary(playUrl));
          try { activeHls && activeHls.destroy(); } catch (e) {} activeHls = null;
          return attachHls(videoEl, rawUrl, Object.assign({}, opts, { __sfvProxyRetried: true }));
        }
```

- [ ] **Step 5: 跑测试 + 真机验证**：单测 PASS；`npm test`（超时对齐测试必须仍绿）；真机：播 2 个不同源各一遍，查 localStorage `sfv-direct-cap-v1` 出现 direct/proxy 记录，二次起播同集时 Network 面板确认代理分片请求数下降，记录 `[SFV-TIMING]` 对比。
- [ ] **Step 6: Commit（待主人明示）** — `feat(video): 按 origin 直连能力记忆，/api/proxy 降级为兜底路径`

**收获：** 能力合格（发 CORS 头）的 CDN 上，清单+全部分片回到 mpv 式直连：砍掉每一跳 localhost 中转、代理 12s 超时天花板、server 侧 m3u8 整包缓冲（server.js:7999-8013）与浏览器同源连接数约束；二次起播同 origin 不再交首次探测学费。
**后果/风险：** ① 未知源首通可能多付一次「直连失败→代理重试」往返（一次 manifest 失败 + 重新 attach，估 <2s）；② CORS 判定与防盗链判定混在 `manifestLoadError` 一个事件里，误降格方向是「退回代理=现行为」，无损只慢；③ mp4/flv 直喂 `<video>` 的分支（player.js:769）不走 hls loader，本次不动，直连失败暴露面不变；④ 若某 origin 时而直连时而 403（多 CDN 调度同 origin），demote 后不再自动升格——留一个 DevTools 逃生门：清 localStorage 键即重置，写进 Task 8 文档。

---

### Task 8: 全量回归、A/B 数据汇总与真机验收清单

**Files:**
- Modify: `docs/superpowers/plans/2026-10-02-kazumi-mechanism-port.md`（本文件末尾「验收记录」区回填数据）

- [ ] **Step 1: 全量回归**

Run: `npm test` → Expected: 仅 watch-history 存量 1 败（基线 148/149 + 本计划新增 5 个测试文件全绿）。

- [ ] **Step 2: 真机验收清单（交主人执行，逐项记录）**

1. 规则源 A（MacCMS 类，走多跳嗅探）：点击→出画计时，对比 Task 5 基线记录（预期降 3~6s）。
2. 规则源 B（直连能力差的防盗链源）：确认降格走代理仍能播、无重试风暴（观察 `[Proxy-ERR]` 频率）。
3. 连点切 3 集：无 BUSY 日志、无陈旧集回写（C2 令牌生效，画面对应最后点的集）。
4. 断网后点播放：≤13s 报「无法解析/网络不通」，不无限转圈。
5. `localStorage['sfv-online-kernel']='mpv'`：mpv 路径首帧数据入表；主观对比 seek/切集/长播稳定性，**决定后续走向由主人拍板**。
6. 音乐/世界页/汇联本地库回归各一项：确认 mpv 通道、proxy、脚本数组改动无越界影响。

- [ ] **Step 3: 数据回填 + 记忆更新**：把 `[SFV-TIMING]` 前后对比、直连比例、A/B 结论写入本文件「验收记录」小节与项目记忆（[[reference-kazumi-source]] 相关条目追加），并更新 [[project-pre-existing-test-failures]] 基线数。
- [ ] **Step 4: Commit（待主人明示）** — `docs: Kazumi 机制移植验收记录与 A/B 数据`

**收获：** 整包可量化的前后对比 + 「是否正式换 mpv 内核」的决策依据。
**后果/风险：** 若数据证明收益低于预期（如防盗链源占比高、直连收益小），Task 7 可整层回滚（清 localStorage 键 + bridge 还原两行），架构不倒退。

---

## 批次收益/后果总览

| 批次 | 任务 | 一句话收获 | 主要代价 |
|---|---|---|---|
| 一 | 1-4 | 结构性白等（≥2.2s/hop + 尾 2.3s + BUSY 降级链）消除；弱源 13s 判死 | 陈旧解析请求 SUPERSEDED 后仍可能多发一次降级请求；注入提前增加少量 executeJavaScript 次数 |
| 二 | 5-6 | 首帧可测量；mpv vs hls.js 有真机数据可拍板 | mpv 分支是实验开关，默认关，双路径维护成本到决策日为止 |
| 三 | 7 | CORS 合格 CDN 回到全直连，砍数据面多一跳+12s 天花板 | 未知源首通多付一次探测重试；origin 级记忆可能误降格（代价=退回现行为） |
| 收尾 | 8 | 回归护栏 + 数据入档 | 无 |

## 验收记录（执行时回填）

- 改前基线 `[SFV-TIMING]`：
- 改后（Task 2/3 后）：
- 直连比例（Task 7 后）：
- mpv A/B（Task 6 后）：
