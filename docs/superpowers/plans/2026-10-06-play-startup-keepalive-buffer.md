# 起播尾段优化（代理连接池 + 播放器缓冲收敛）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 砍掉「点击播放→出画」时间线上 attach→manifest→frag0 尾段的结构性网络开销——/api/proxy 上游连接复用（不再每个分片突发重付 DNS+TCP+TLS）+ hls.js 缓冲策略从 120s 收敛到 30s 使拉取节奏与连接复用互相配合。

**Architecture:** 两层各一个最小改动：① server.js `/api/proxy` 出站从 Node 全局 fetch 换为 npm `undici.fetch` + 专用 `Agent({ keepAliveTimeout: 60000 })`（require 失败退化为全局 fetch，行为=现状态）；② `source-adapter-hls.js` 的 `new Hls({...})` 配置区三个缓冲值收敛到 hls.js 默认量级。两者都只碰「数据面」，不碰解析链（那是 2026-10-02 移植批的地盘）；效果用同一把尺子 `[SFV-TIMING]`（play-timing，已存在于基线分支）量化。

**Tech Stack:** Node v24.16.0（全局 fetch=内置 undici，不可注入 dispatcher，故需 npm undici）、undici@^7（MIT，纯 JS）、hls.js v1.7.1（vendored `public/vendor/hls.min.js`）、node:test 源断言测试风格（照 `tests/hls-proxy-timeout-alignment.test.js`）。

**Spec / 前批:** `docs/superpowers/plans/2026-10-02-kazumi-mechanism-port.md`（本计划是同一时间线的「尾段」批次，消费其 Task 5 play-timing 与 Task 7 直连能力记忆；背景取证与其「验收记录」小节一并阅读）。

## 基线与合并策略（先读这段）

- **执行基线 = `feat/kazumi-mechanism-port` @ `ded04ed`**（`.worktrees/kazumi-mechanism-port` 即此分支，且 :3000 上跑的就是它）。理由：
  1. `[SFV-TIMING]` 尺子（play-timing.js）只在该分支，两个任务的真机验收都要靠它出数；
  2. Task 2 改的 `new Hls({...})` 配置区与该分支 0fd5ec3（按 origin 直连能力）的 loader 选择行同区——在分支上做避免两处分裂，将来随分支一起合 main；
  3. server.js 在该分支与 main 之间 **零 diff**（`git diff main..feat/kazumi-mechanism-port -- server.js` 实测为空），Task 1 放哪边都不冲突。
- main 已前进的 ff3fda1（N1/N2 嗅探排队）只碰 sniff/bridge，与本计划无交集，随前批 merge 时一并处理。
- **npm test 基线 = 174/174**（@ded04ed 实测）。本计划新增 2 个测试文件、6 个用例 → 预期终态 180/180 全绿（run-all.js 按 `tests/*.test.js` 自动发现，已核实）。

## 背景与取证（数据面为何还有肉）

1. **undici 缺省 keep-alive 只有 4s**（有来源：undici v6 `lib/dispatcher/client.js` 实测 grep：`keepAliveTimeout == null ? 4e3 : …`、`keepAliveMaxTimeout == null ? 600e3`）。而 hls.js 现配置 `maxBufferLength: 120`（`source-adapter-hls.js:171`），即「一口气下满 120 秒缓冲 → 播放闲置数十秒 → 再拉下一段」——每次闲置必超 4s，代理→CDN 的连接必被拆，下一个分片突发重付 DNS+TCP+TLS（国内 CDN 跨境/冷路径实测可达数百 ms~1.5s/次）。**两个改动是互相成就的**：缓冲收敛到 30s 让拉取更密（复用率↑），keep-alive 提到 60s 让突发间隙不再拆连接。
2. **Node 全局 fetch 无法注入自定义 dispatcher**（内置 undici 是私有副本，npm `setGlobalDispatcher` 影响不到它——有来源：undici docs Agent/setGlobalDispatcher 说明与 nodejs/undici discussion #2382）。要吃到调优只有换 npm `undici.fetch`，其 API 与全局 fetch 同规（`Response.status/headers.get/ok/text/arrayBuffer/body.getReader()/url` 全兼容，现代理代码用到的每一项都在）。
3. **hls.js v1.7 默认 `maxBufferLength=30`、`maxMaxBufferLength=60`**（有来源：hls.js API 文档）；现值 120/240/120MB 是移植批之前「对标 KVideo」一次配齐的，未见对应收益记录。30s 起播缓冲不影响首帧时机（首帧只等 frag0），但降低内存峰、把带宽集中在真正缺的地方。
4. `abrEwmaDefaultEstimate: 500000` **不动**（AI推理：低估计→首档选低码率→frag0 更小更快，恰是起播友好方向；调高反而拖慢首帧）。
5. 其余已核实不改：`PROXY_TIMEOUT_MS = 12000`（AbortController 语义保留）、m3u8 整包缓冲（广告过滤需要，`&ad=0` 逃生门已有）、分片流式透传+背压+客户端中止传播（:8051-8066 写得没毛病）、三类 LoadingTimeOut（15000/15000/20000 > 12000 不变式）。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `package.json` | Modify | dependencies 追加 `undici`（唯一新运行时依赖） |
| `server.js` | Modify（:2576 区加 dispatcher 工厂；:7911 换 fetch 调用） | /api/proxy 出站连接池；不新建根文件（build.files 白名单坑，见全局约束⑤） |
| `tests/proxy-keepalive-agent.test.js` | Create | ①源不变式（常量/三元退化/dispatcher 接线）②行为测试：60s Agent 空闲 6s 后仍复用单连接，缺省 4s Agent 断言其已断 |
| `public/video/source-adapter-hls.js` | Modify（仅 3 个配置值） | 起播缓冲策略收敛 |
| `tests/hls-buffer-policy.test.js` | Create | 配置值断言 + 超时不变式哨兵 |
| `docs/superpowers/plans/2026-10-06-play-startup-keepalive-buffer.md` | Modify（Task 3 回填） | 验收记录 |

## Global Constraints

- `public/video/kazumi/` 内核零改动（GPL 边界）。
- `manifestLoadingTimeOut/levelLoadingTimeOut/fragLoadingTimeOut` 必须严格 > `PROXY_TIMEOUT_MS=12000`（`tests/hls-proxy-timeout-alignment.test.js` 强制，改后必须仍绿）。
- **不新建仓库根文件**：`build.files` 白名单是逐项列举（package.json:31-48），漏根文件=打包静默丢文件的历史坑；undici 作为 dependencies 由 electron-builder 自动入 `resources/node_modules`，但须按 [[project-win-build-ca]] 配方查 win-unpacked 实证。
- 影视模块改动后必跑 `npm run bundle`（B1 模块束，产物 gitignored）。
- 全量回归以 `npm test` 为准（基线 174/174 @ded04ed）。
- 验证起服一律 `PORT=3999` 且同命令内起→测→杀，严禁残留占 :3000（[[feedback-no-stray-server-on-3000]] 三次实锤）。
- 未经主人明示不 merge、不 push；worktree 本地 commit 按 SDD 流程逐任务执行。
- 不使用 Computer Use/桌面自动化（[[feedback-no-desktop-automation]]）；真机项全部列成主人手动清单。

---

### Task 1: /api/proxy 换用 undici 连接池（keep-alive 4s→60s）

**Files:**
- Modify: `package.json`（dependencies 追加 undici）
- Modify: `server.js`（:2576 区工厂 + :7911 调用点）
- Create: `tests/proxy-keepalive-agent.test.js`

**Interfaces:**
- Consumes: Node v24 本机可 `require('undici')`（装包后）；server.js 现有 `PROXY_TIMEOUT_MS = 12000` AbortController 语义。
- Produces: 模块级 `_proxyUndici`（undici 命名空间或 null）、`_proxyDispatcher`（`undici.Agent` 实例或 null）、常量 `PROXY_KEEPALIVE_MS = 60000`；`/api/proxy` 的上游请求一律 `up = _proxyDispatcher ? await _proxyUndici.fetch(target, { headers, signal: ctrl.signal, dispatcher: _proxyDispatcher }) : await fetch(target, { headers, signal: ctrl.signal })`。返回的 `up` 满足代理后续用到的全部面：`.status .ok .headers.get() .text() .arrayBuffer() .body.getReader()`。

- [ ] **Step 1: 装依赖并冒烟 API 面**

```bash
npm install undici@^7 --save
node -e "const u=require('undici');console.log(typeof u.fetch, typeof u.Agent)"
```
Expected: `function function`。若 registry 受 TLS 拦截装不上，用 `npm config get registry` 现场确认镜像后重试，仍不行则**停下报告**（不得私自换 http/https agent 方案——那要重写流式透传，超出本任务授权）。

- [ ] **Step 2: 写失败测试**

创建 `tests/proxy-keepalive-agent.test.js`：

```js
'use strict';

/**
 * /api/proxy 上游连接池契约（2026-10-06 起播尾段批次 Task 1）
 * 背景：Node 全局 fetch 的内置 undici keepAliveTimeout 缺省仅 4s（undici client.js:4e3），
 * hls.js 拉完一段缓冲即闲置数十秒 → 每个分片突发都重付 DNS+TCP+TLS。
 * 契约：① 代理出站走 undici.Agent(keepAliveTimeout=60s)；② require 失败退化为全局 fetch（=现行为，不崩）；
 * ③ 12s AbortController 超时不变式保留。
 * 运行：node --test tests/proxy-keepalive-agent.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('代理连接池接线：常量/工厂/dispatcher 传参/全局 fetch 退化分支都在', () => {
  const ms = /const PROXY_KEEPALIVE_MS = (\d+);/.exec(serverSrc);
  assert.ok(ms, 'PROXY_KEEPALIVE_MS 常量缺失');
  assert.ok(Number(ms[1]) >= 30000 && Number(ms[1]) <= 120000, 'keep-alive 应取 30~120s，实为 ' + ms[1]);
  assert.match(serverSrc, /require\('undici'\)/);
  assert.match(serverSrc, /keepAliveTimeout: PROXY_KEEPALIVE_MS/);
  assert.match(serverSrc, /dispatcher: _proxyDispatcher/);
  assert.match(serverSrc, /_proxyDispatcher\s*\?/, '缺三元退化分支：undici 不可用必须回落全局 fetch');
});

test('PROXY_TIMEOUT_MS=12000 不变式未被本改动破坏', () => {
  assert.match(serverSrc, /const PROXY_TIMEOUT_MS = 12000;/);
});

test('行为验证：60s Agent 空闲 6s 后仍复用单连接（缺省 4s Agent 此时已断）', async (t) => {
  const http = require('node:http');
  let undici;
  try { undici = require('undici'); } catch (e) { t.skip('undici 未安装'); return; }
  let conns = 0;
  const srv = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
  srv.on('connection', () => conns++);
  srv.keepAliveTimeout = 65000; // 本地测试服务缺省 5s 就拆空闲连接——不对齐的话 60s 客户端保活测不出复用
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port + '/';
  const idle = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const agent = new undici.Agent({ keepAliveTimeout: 60000, keepAliveMaxTimeout: 300000 });
    await undici.fetch(base, { dispatcher: agent });
    await idle(6000); // 超过缺省 4s 保活、低于 60s
    await undici.fetch(base, { dispatcher: agent });
    assert.equal(conns, 1, '60s 保活应复用同一连接，实际新建 ' + conns + ' 次');
    await agent.close();
    conns = 0;
    const dflt = new undici.Agent(); // 缺省 4s —— 复现旧行为对照
    await undici.fetch(base, { dispatcher: dflt });
    await idle(6000);
    await undici.fetch(base, { dispatcher: dflt });
    assert.equal(conns, 2, '缺省 Agent 空闲 6s 应已断连重连（对照组）');
    await dflt.close();
  } finally {
    srv.close();
  }
});
```

Run: `node --test tests/proxy-keepalive-agent.test.js` → 前两例 FAIL（server.js 尚无接线），第三例 PASS 亦正常（它测的是 undici 前提，不是我们的改动）。

- [ ] **Step 3: 实现 server.js 两处改动**

① :2576-2577（`sharedHttpAgent/sharedHttpsAgent` 之后）追加：

```js
// ---- /api/proxy 上游连接池（2026-10-06 起播尾段批 Task 1）----
// Node 全局 fetch 用内置 undici 的私有 Agent，keepAliveTimeout 缺省仅 4s（undici client.js 4e3），
// 且无法从外部注入（内置副本与 npm undici 互不相干）。hls.js「下满缓冲→播放闲置」的节奏下，
// 每次闲置>4s 连接即被拆，下个分片突发重付 DNS+TCP+TLS。这里建专用 Agent（保活 60s），
// /api/proxy 改用 undici.fetch（与全局 fetch 同规 API）；require 失败退化为全局 fetch=现行为，不崩。
const PROXY_KEEPALIVE_MS = 60000;
let _proxyUndici = null;
let _proxyDispatcher = null;
try {
  _proxyUndici = require('undici');
  _proxyDispatcher = new _proxyUndici.Agent({
    keepAliveTimeout: PROXY_KEEPALIVE_MS,
    keepAliveMaxTimeout: 300000,
  });
} catch (e) {
  console.warn('[Proxy] undici 不可用，退化为全局 fetch:', (e && e.message) || e);
}
```

② :7905-7911（`PROXY_TIMEOUT_MS` 注释块的 fetch 调用处）替换为：

```js
      // 出站 fetch：m3u8 分片/列表统一设 connect 超时为 12s，避免 CDN 节点不可达时无限挂起
      const PROXY_TIMEOUT_MS = 12000;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PROXY_TIMEOUT_MS);
      let up;
      try {
        up = _proxyDispatcher
          ? await _proxyUndici.fetch(target, { headers, signal: ctrl.signal, dispatcher: _proxyDispatcher })
          : await fetch(target, { headers, signal: ctrl.signal });
      } catch (fetchErr) {
```
（catch/超时/回包逻辑一字不动；AbortController 对 undici.fetch 同样生效——fetch 规范行为。）

- [ ] **Step 4: 跑测试 + 冒烟流式/整包两条路径**

```bash
node --test tests/proxy-keepalive-agent.test.js            # 3/3 PASS
npm test                                                    # 基线 174 + 本文件 3 = 177 全绿（run-all.js 自动发现 tests/*.test.js，已核实）
PORT=3999 timeout 25 node server.js &  SRV=$!; sleep 3
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' "http://127.0.0.1:3999/api/proxy?url=https%3A%2F%2Ftest-streams.mux.dev%2Fx36729%2Fpts-446146659.m3u8"   # 期望 200，m3u8 整包路径
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' "http://127.0.0.1:3999/api/proxy?url=https%3A%2F%2Ftest-streams.mux.dev%2Fx36729%2Fmedia_0%2Fvideo%2F001.ts" # 期望 200，分片流式路径
kill $SRV 2>/dev/null; wait 2>/dev/null
```
Expected: 两条都 200 且 size_download>0；控制台无 `[Proxy]` 异常栈。**注意**：验证必须在同一命令串里起服→测→杀（全局约束）；若 mux.dev 被网络环境拦，换任一可达 https 直链即可，结论等价。

- [ ] **Step 5: Commit（SDD 工作区内本地提交，merge 另待主人拍板）**

```bash
git add package.json package-lock.json server.js tests/proxy-keepalive-agent.test.js
git commit -m "perf(proxy): /api/proxy 换 undici 连接池（keep-alive 4s→60s），退化分支保全局 fetch 兜底"
```

**收获：** 分片突发之间不再重付 DNS+TCP+TLS；对国内 CDN 冷路径，manifest 与每个分片段的头字节延迟按握手时长（估 0.1~1.5s/次）下降；暂停>4s 后恢复、ABR 切档、二次起播同 origin 都吃复用红利。
**后果/风险：** ① 唯一新运行时依赖 undici（MIT，纯 JS），electron-builder 对 dependencies 自动打包，但必须按 [[project-win-build-ca]] 查 win-unpacked（后续构建批次做一次即可）；② undici.fetch 与内置副本行为差异面（重定向链 `.url`、错误类名）——代理后续只用 status/headers/text/arrayBuffer/body.getReader，已在 Step 4 双路径冒烟覆盖；③ 对端 CDN 自己先关空闲连接时，60s 是上限不是保证（多耗 0 成本，握手行为=现状）；④ 连接数放大：Agent 对每 origin 连接数无上限（undici 缺省 connections=null），与本计划改动前行为一致（全局 fetch 同样无上限），不新增暴露面。

---

### Task 2: hls.js 起播缓冲策略收敛（120s→30s 族）

**Files:**
- Modify: `public/video/source-adapter-hls.js`（`new Hls({...})` 配置区，分支上 loader 行已被 0fd5ec3 改为 directUsed 选择——只动三个缓冲值，其余一字不改）
- Create: `tests/hls-buffer-policy.test.js`

**Interfaces:**
- Consumes: hls.js v1.7.1 配置面（vendored）；Task 1 的 60s 保活（两者互相成就：缓冲 30s → 拉取节奏更密 → 连接复用率↑）。
- Produces: 仅配置值变化——`maxBufferLength: 30`、`maxMaxBufferLength: 60`、`maxBufferSize: 60 * 1000 * 1000`。不改任何事件接线，`[SFV-TIMING]` 打点（manifest/frag0/firstframe）语义不变。

- [ ] **Step 1: 写失败测试**

创建 `tests/hls-buffer-policy.test.js`：

```js
'use strict';

/**
 * 起播尾段缓冲策略契约（2026-10-06 Task 2）——收敛到 hls.js v1 默认量级（30/60/60MB）。
 * 理由：120s 大缓冲使「下载突发→长闲置」交替，闲置必超保活窗（现由 Task 1 提到 60s），
 * 30s 缓冲拉取更密、内存峰值更低，且首帧只等 frag0 不因此变慢。
 * 运行：node --test tests/hls-buffer-policy.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'public/video/source-adapter-hls.js'), 'utf8');

test('缓冲三值 = 30s / 60s / 60MB（hls.js 默认量级）', () => {
  assert.match(src, /maxBufferLength: 30,/, 'maxBufferLength 应收敛为 30');
  assert.match(src, /maxMaxBufferLength: 60,/, 'maxMaxBufferLength 应收敛为 60');
  assert.match(src, /maxBufferSize: 60 \* 1000 \* 1000,/, 'maxBufferSize 应收敛为 60MB');
});

test('起播友好值未被误动：startFragPrefetch/enableWorker/低码率起步估计保留', () => {
  assert.match(src, /startFragPrefetch: true,/);
  assert.match(src, /enableWorker: true,/);
  assert.match(src, /abrEwmaDefaultEstimate: 500000,/);
});

test('三类 LoadingTimeOut 仍严格大于 PROXY_TIMEOUT_MS=12000（哨兵，正式不变式在 alignment 测试）', () => {
  for (const [k, v] of src.matchAll(/(manifest|level|frag)LoadingTimeOut: (\d+)/g)) {
    assert.ok(Number(v) > 12000, k + '=' + v + ' <= 12000');
  }
});
```

Run: `node --test tests/hls-buffer-policy.test.js` → 第一例 FAIL（现值 120/240/120MB），后两例 PASS 正常（它们锁的是「不许顺手改」）。

- [ ] **Step 2: 改三个值**

`new Hls({...})` 内（保持其余行与注释原样）：

```js
        maxBufferLength: 30,          // 120→30：对齐 hls.js 默认；拉取更密配合 Task 1 保活复用
        maxMaxBufferLength: 60,       // 240→60
        maxBufferSize: 60 * 1000 * 1000, // 120MB→60MB
```
同时把 :161 注释「对标 KVideo（缓冲/重试/超时/ABR）」后追加一句：`// 2026-10-06 尾段批：缓冲三值收敛到 hls.js 默认量级（理由见 tests/hls-buffer-policy.test.js 头注）`。

- [ ] **Step 3: 跑测试 + 全量 + 重束模块**

```bash
node --test tests/hls-buffer-policy.test.js   # 3/3 PASS
node --test tests/hls-proxy-timeout-alignment.test.js   # 仍绿（不变式）
npm run bundle                                 # B1：改了影视模块必束（产物 gitignored，运行时生效）
npm test                                         # 预期 180/180 全绿
```

- [ ] **Step 4: Commit**

```bash
git add public/video/source-adapter-hls.js tests/hls-buffer-policy.test.js
git commit -m "perf(video): hls.js 起播缓冲收敛 30/60/60MB，配合代理保活复用并降内存峰值"
```

**收获：** 内存峰值减半（120MB→60MB 上限）；拉取节奏从「百米冲刺+分钟级发呆」变持续小步——与 60s 保活协同，绝大多数分片请求跑在已热连接上；弱网下缓冲决策循环更快。
**后果/风险：** ① 高码率源在带宽差时缓冲更快耗尽 → 卡顿风险↑，这正是真机 A/B 要盯的项（Task 3 清单第 2 项），若实测退化则回退只需还原三行；② `backBufferLength: 90`（回看缓冲）不在本批范围——不动，避免混入非起播变量；③ 与未合并的 0fd5ec3 同区（loader 行），本任务不碰该行，merge 时无冲突增量。

---

### Task 3: 全量回归、真机 A/B 数据回填与记忆更新

**Files:**
- Modify: `docs/superpowers/plans/2026-10-06-play-startup-keepalive-buffer.md`（本文件「验收记录」区回填）
- Modify: 项目记忆（`project-play-startup-keepalive-buffer.md` 新建 + MEMORY.md 索引行；[[project-pre-existing-test-failures]] 基线数刷新）

- [ ] **Step 1: 全量回归**

Run: `npm test` → Expected: **180/180 全绿**（@ded04ed 基线 174 + Task 1 三例 + Task 2 三例）。

- [ ] **Step 2: 真机验收清单（交主人执行，逐项记录；:3000 app 需从 worktree 重启一次以带入新 server.js）**

1. **尾段计时对比**：同一规则源同一集，改动前后各两遍取第二遍的 `[SFV-TIMING]` `manifest/frag0/firstframe` 增量（前批若尚未录改前基线，先在重启前录一条）。预期：同 origin 二次起播 frag0 显著低于首启。
2. **长播稳定性**：连播 ≥20 分钟，主观对比卡顿次数（缓冲 30s 的风险项）；若有源明显变抖，记录源名+频次，回退选项=还原 Task 2 三行。
3. **代理日志**：观察 `[Proxy-ERR]`/`[Proxy] fetch failed` 频率不高于改前（连接池不应引入新错误面）。
4. **暂停恢复**：播放中暂停 >10s 再恢复，秒恢复且控制台无新错误（60s 保活红利点）。
5. **退化分支**：临时 `mv node_modules/undici node_modules/undici_bak` 起服（PORT=3999）播一集 → 应只打 `退化为全局 fetch` 警告且能播；测毕还原目录。
6. **越界回归**：音乐页/世界页/汇联各点一项，确认 server 代理改动无涟漪。

- [ ] **Step 3: 数据回填 + 记忆更新**：把前后 `[SFV-TIMING]` 对比、卡顿主观结论、undici 版本写入本文件「验收记录」，新建项目记忆条目（收益量级 + 是否保留 + 与 kazumi 移植批 merge 联动关系），刷新测试基线数。

- [ ] **Step 4: Commit（待主人明示 merge 与否）** — `docs: 起播尾段批验收记录与 A/B 数据`

**收获：** 数据面（attach→出画）前后对比入档；与解析链批次（10-02 移植）拼成完整「点击→出画」优化账本。
**后果/风险：** 若数据显示 frag 级握手节省被 CDN 端 keep-alive 上限吃掉（对端先断），Task 1 保留（无副作用）但预期下调入档；若 Task 2 卡顿风险实锤，三行还原即可，不牵动 Task 1。

---

## 批次收益/后果总览

| 批次 | 任务 | 一句话收获 | 主要代价 |
|---|---|---|---|
| 一 | 1 | 代理→CDN 连接跨分片突发复用（4s→60s 保活），砍重复握手 | 新运行时依赖 undici；win-unpacked 打包核验一次 |
| 一 | 2 | 缓冲 30/60/60MB：拉取节奏与保活协同、内存峰值减半 | 弱网高码率源卡顿风险↑，真机 A/B 裁决，三行可退 |
| 收尾 | 3 | 回归护栏 + 数据入档 + 与移植批账本合并 | 无 |

## 验收记录（执行时回填）

- 改前基线 `[SFV-TIMING]`（manifest/frag0/firstframe）：
- 改后（Task 1 后 / Task 2 后 各一列）：
- 长播卡顿主观对比：
- undici 版本 / 退化分支冒烟结果：
- npm test 终态：
