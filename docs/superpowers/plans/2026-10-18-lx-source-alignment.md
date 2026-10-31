# LX 音源完整对齐实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Stellaflix 在线音乐完整对齐 Mineradio-LX-Music 1.7.0 的 LX 音源架构：vm 脚本宿主成为唯一播放 URL 供给，内置五家爬虫接管搜索，官方平台 API/登录/写回/播客三阶段退役。

**Architecture:** 三段式「先建后切再拆」——阶段1 并行新建 `lx-source-host.js`（Node vm 沙箱）+ `lx-search.js`（无 cookie 爬虫）+ `/api/lx-source/*` 路由族，旧链不动；阶段2 一次提交把前端播放/搜索/导入消费端全部切到新后端并新增源管理 UI；阶段3 按消费方 grep 逐项拆除旧路由、`desktop/custom-source/`、平台 API 文件与账号 UI。

**Tech Stack:** Node.js 原生（`node:vm`/`node:http`/`node:crypto`/`node:zlib`）、零新增 npm 依赖、`node:test`+`node:assert` 测试、自研 bundle（`npm run bundle`）。

**Spec:** `docs/superpowers/specs/2026-10-18-lx-source-alignment-design.md`（本计划依它撰写，执行时两份同读）

**参照库（移植源）:** `C:\Users\Administrator\Desktop\Mineradio-LX-Music-1.7.0`——下文所有「上游 `文件:行号`」均指该库内文件，执行者直接打开对应区间照抄后做身份转换。**禁止整段照抄不改**（见 Global Constraints）。

## Global Constraints

- 身份转换表（每个移植块逐条套用）：
  - `path.join(app.getPath('userData'),'sources')` 替换上游 `%APPDATA%\Mineradio\sources`（上游 `lx-source-host.js:28-30`）；
  - 错误码前缀 `LX_` 保留（协议词汇），但日志/文案中的产品名一律 Stellaflix；
  - 不引入 `lxmusic://` scheme、不引入 23330 open-API、不引入 `lx.data.db` 读取（spec §8）；
  - 从 `%APPDATA%\lx-music-desktop\LxDatas` 自动迁移的逻辑**照抄保留**（读第三方数据，上游 `lx-source-host.js:22-27,95-161`）。
- 零新增 npm 依赖；`NeteaseCloudMusicApi` 在阶段3 前不许新增消费点。
- 每阶段末 `npm test` 全绿（基线 200 上下，以当次运行为准；bundle-modules 若因并行 WE 会话红，按 [[project-pre-existing-test-failures]] 口径记录不阻塞）。
- 改 `public/js/modules/**` 必跑 `npm run bundle`，并同步 `tests/bundle-modules.test.js` 计数。
- 验证起服务用 `PORT=3999`，严禁占用 3000（[[feedback-no-stray-server-on-3000]]）。
- 与并行会话共用 main：只在收到明确「提交」指令时 commit；stage 与校验同命令内完成；子代理严禁 `git stash -u`（[[project-shared-repo-concurrency]]）。
- 与上游 diff 审计一律 `diff --strip-trailing-cr`。
- 单测风格：`node:test` + `node:assert`，文件头 `'use strict';`，网络全部 fetch 注入桩，脚本用 fixture 假脚本。

---

# 阶段 1 · 新建后端（旧链零改动）

### Task 1: `lx-source-host.js` 沙箱核心 + 脚本存储

**Files:**
- Create: `lx-source-host.js`
- Create: `tests/fixtures/lx-fake-source.js`（协议合规假脚本）
- Test: `tests/lx-source-host.test.js`

**Interfaces:**
- Produces（后续任务消费的确切签名）:
  - `createLxSourceHost({ userDataPath })` → host 对象
  - `host.importSource(name, script) → {id, meta}`；`host.importSourceUrl(urlOrApiKey) → {id, meta}`
  - `host.selectSource(id)`；`host.setSourcesEnabled(ids, enabled)`；`host.deleteSource(id)` / `host.deleteSources(ids)`
  - `host.listSources() → [{id,name,description,version,author,enabled,current,sources:{kw:{qualitys:[...]},...}}]`
  - `host.checkSources(ids?) → [{id, ok, sources, error}]`
  - `host.resolveMusicUrl({source, quality, musicInfo, excludeResolvers?, maxResolvers?}) → {ok, source, url, headers, quality, requestedQuality, actual, probeWarning?, resolver}`
  - `host.getLyric({source, musicInfo}) → {ok, lyric, tlyric, rlyric, lxlyric}`
  - `host.picAction` 同型。

- [ ] **Step 1: 写假脚本 fixture 与失败测试**

`tests/fixtures/lx-fake-source.js`（内容即一份最小 user_api 脚本，头注释含 `@name 假脚本` 等五个 @ 标签，`lx.on('request')` 内对 `action:'musicUrl'` 回 `lx.send('request', {id, data:{ok:true, url:'https://fake.example/song.mp3'}})`，并回 `inited`）：

```js
/*
 * @name 假脚本
 * @description fixture
 * @version 1.0.0
 * @author test
 * @homepage https://example.invalid
 */
;(function () {
  if (typeof lx === 'undefined') return
  lx.on('init', () => {
    lx.send('inited', {
      name: '假脚本', description: 'fixture', version: '1.0.0',
      sources: { kg: { qualitys: ['128k', '320k', 'flac'] } }
    })
  })
  lx.on('request', ({ action, source, quality, musicInfo, id }) => {
    if (action !== 'musicUrl') return
    lx.send('request', { id, data: { ok: true, url: 'https://fake.example/song.mp3', quality } })
  })
  lx.send('inited', { name: '假脚本', sources: { kg: { qualitys: ['128k', '320k', 'flac'] } } })
})()
```

`tests/lx-source-host.test.js` 首批用例（照抄前先失败）：

```js
'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createLxSourceHost } = require('../lx-source-host')

const fixture = () => fs.readFileSync(path.join(__dirname, 'fixtures/lx-fake-source.js'), 'utf8')
const tmpUserData = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sf-lx-host-'))

test('导入合规脚本后 listSources 含元数据且 source keys 过白名单', async () => {
  const host = createLxSourceHost({ userDataPath: tmpUserData() })
  const { id, meta } = await host.importSource('假脚本', fixture())
  assert.equal(meta.name, '假脚本')
  const [row] = await host.listSources()
  assert.equal(row.id, id)
  assert.deepEqual(Object.keys(row.sources), ['kg'])
})

test('缺 lx.on(request) 的脚本报 LX_SOURCE_REQUEST_HANDLER_MISSING 且不落盘', async () => {
  const dir = tmpUserData()
  const host = createLxSourceHost({ userDataPath: dir })
  await assert.rejects(host.importSource('坏', 'lx.send("inited",{sources:{kg:{qualitys:["128k"]}}})'),
    /LX_SOURCE_REQUEST_HANDLER_MISSING/)
  assert.equal((await host.listSources()).length, 0)
})

test('10s 不 inited 报 LX_SOURCE_INIT_TIMEOUT（测试用注入时钟缩短）', async () => {
  const host = createLxSourceHost({ userDataPath: tmpUserData(), initTimeoutMs: 50 })
  await assert.rejects(host.importSource('卡死', 'lx.on("request",()=>{})'), /LX_SOURCE_INIT_TIMEOUT/)
})

test('非白名单源键被过滤（上游 lx-source-host.js:511-514 语义）', async () => {
  const host = createLxSourceHost({ userDataPath: tmpUserData() })
  await host.importSource('杂源', fixture().replace("'kg'", "'bogus'"))
  const [row] = await host.listSources()
  assert.deepEqual(Object.keys(row.sources), [])
})
```

- [ ] **Step 2: 跑测确认失败**

Run: `node tests/lx-source-host.test.js`
Expected: FAIL `Cannot find module '../lx-source-host'`

- [ ] **Step 3: 移植沙箱与存储**

打开上游 `lx-source-host.js`，移植以下区段为新文件（顺序照抄后套身份转换表）：
- `:22-34` 常量区（**把 `%APPDATA%\Mineradio\sources` 三行改为 `path.join(userDataPath,'sources')`**；`ALLOWED_SOURCES/ALLOWED_ACTIONS` 原样）；
- `:406-413` `normalizeSourceConfig`、`:418-420` gz_ 解码、`:431-468` lx 对象（on/send/utils/rawScript）、`:472-505` `vm.runInNewContext` 沙箱注入（含 `process.env` 置空）；
- `:510-528` 三种拒绝码、`:544-558` @ 元数据解析、`:560-591` importSource 校验回滚、`:136-142` writeSourceStore；
- `:95-161` lx-music-desktop 自动迁移（原样保留）；
- 导出工厂 `createLxSourceHost({userDataPath, initTimeoutMs=10000, fetchImpl=fetch})`——`initTimeoutMs/fetchImpl` 是测试注入点，上游没有则包一层默认值。

本 task 只要求 list/import/select + 白名单/超时/回滚语义；resolve/探测在 Task 3。

- [ ] **Step 4: 跑测确认通过**

Run: `node tests/lx-source-host.test.js`
Expected: PASS（4 用例）

- [ ] **Step 5: 全量回归**

Run: `npm test`
Expected: 与基线一致（无新增红）

### Task 2: 解析器回退链 + 90s LRU 缓存

**Files:**
- Modify: `lx-source-host.js`
- Test: `tests/lx-source-host.test.js`（追加）

**Interfaces:**
- Consumes: Task 1 的 host 与 fixture
- Produces: `host.resolveMusicUrl({source,quality,musicInfo,excludeResolvers?,maxResolvers?}) → {ok,source,url,headers,quality,requestedQuality,actual,resolver}`（探测字段 Task 3 追加）

- [ ] **Step 1: 写失败测试**

```js
test('当前脚本解析失败时惰性轮换其它已装脚本，成功 resolver 名回传', async () => {
  const host = createLxSourceHost({ userDataPath: tmpUserData() })
  await host.importSource('坏脚本', fixture().replace('song.mp3', '').replace(/ok: true/, 'ok: false'))
  const good = await host.importSource('好脚本', fixture())
  await host.selectSource('坏脚本-current') // 让坏脚本成为 current（fixture 名改法见下注）
  const r = await host.resolveMusicUrl({ source: 'kg', quality: '320k', musicInfo: { kg: { mid: 'X' }, type: 'music', name: 't', singer: 's' } })
  assert.equal(r.ok, true)
  assert.equal(r.resolver, '假脚本')  // 实际以好脚本 id/name 断言，实施时按 listSources 返回名对齐
})

test('excludeResolvers 命中的脚本被跳过；全部排除报 LX_ALL_RESOLVERS_EXHAUSTED', async () => {
  const host = createLxSourceHost({ userDataPath: tmpUserData() })
  const a = await host.importSource('A', fixture())
  await assert.rejects(host.resolveMusicUrl({ source: 'kg', quality: '128k',
    musicInfo: { type: 'music', name: 't', singer: 's' }, excludeResolvers: [a.id] }),
    /EXHAUSTED|没有可用于这首歌的音源/)
})

test('同参数 90s 内二次解析命中缓存不再执行脚本', async () => {
  const host = createLxSourceHost({ userDataPath: tmpUserData() })
  await host.importSource('A', fixture())
  const q = { source: 'kg', quality: '128k', musicInfo: { type: 'music', name: 't', singer: 's' } }
  const r1 = await host.resolveMusicUrl(q)
  const r2 = await host.resolveMusicUrl(q)
  assert.equal(r2.url, r1.url)
  assert.equal(r2.cached, true)
})
```

（注：fixture 名断言在实施时以 `listSources()` 真实返回为准调整，属测试内容而非契约。）

- [ ] **Step 2: 跑测确认失败** — Run: `node tests/lx-source-host.test.js`；Expected: FAIL（resolveMusicUrl 未定义）

- [ ] **Step 3: 移植上游 `:1087-1218`**：激活脚本先行 → 其余已装脚本惰性 activate 轮换；`maxResolvers` 默认 6 上限 8（`:1110-1127`）；每 resolver 8s 预算（`:1204`）；`:1086-1108` musicUrl 90s LRU-120（命中回 `cached:true`——该字段我方新增，上游无）；穷尽终态文案两种（`:1215-1217`）。

- [ ] **Step 4: 跑测确认通过** — `node tests/lx-source-host.test.js` PASS
- [ ] **Step 5: `npm test`** 无新增红

### Task 3: 音质降级链 + Range 魔数探测

**Files:**
- Modify: `lx-source-host.js`
- Test: `tests/lx-source-host.test.js`（追加）

**Interfaces:**
- Produces: `resolveMusicUrl` 返回值增加 `actual`、可选 `probeWarning`；导出 `QUALITY_ALIASES`、`fallbackChainFor(quality)` 供 Task 9 前端词汇表对齐引用（经路由暴露即可，不跨文件 import）

- [ ] **Step 1: 写失败测试**

```js
test('目标 flac 不被脚本支持时按降级链回 320k 并标 actual', async () => {/* fixture 脚本只报 128k/320k/flac，请求 flac24bit */})
test('探测到 MP3 帧头但请求 flac：仍返回 URL 且 probeWarning=advisory', async () => {/* fetchImpl 桩回 Range 前 128KB = ID3+0xFFFB 帧 */})
test('探测 404：该候选跳过换下一 resolver', async () => {/* fetchImpl 桩 404 */})
```

（三例的桩 fetch 需同时服务脚本沙箱与探测：沙箱注入的 `fetch` 用同一 `fetchImpl`，返回可控。断言字段名以 Step 3 移植后的实际返回为准：`{ok,url,quality,actual,probeWarning}`。）

- [ ] **Step 2: 跑测确认失败**
- [ ] **Step 3: 移植上游 `:980-1062`（魔数/帧头解析 + `audioProbeSatisfiesQuality`）、`:1064-1084`（别名表 + `sourceSupportsQuality`）、`:1092-1100`（fallbackMap）、`:1134-1146`（2 候选×2 变体上限）——`:1134-1136` 针对「念心音源」特定脚本的 320k-first 硬编码**不移植**（生态包袱，我方无该脚本用户），其余照抄；`:1163-1184` 探测失败仅 advisory。**
- [ ] **Step 4: 跑测确认通过**
- [ ] **Step 5: `npm test`**

### Task 4: URL/APIKEY 导入 + checkSources + 批量启停删除

**Files:**
- Modify: `lx-source-host.js`
- Test: `tests/lx-source-host.test.js`（追加）

- [ ] **Step 1: 写失败测试**：`importSourceUrl('https://x/y.js')` 经 fetchImpl 桩取回脚本正文入库；64-hex 输入展开为 `http://ynx.de5.net/API/lx-ynx.php?APIKEY=<hex>`（上游 `:250-270`）；证书失败降级 http 重试（`:230-240`）；`checkSources` 对坏脚本回 `{ok:false,error}` 且 12s 封顶；`setSourcesEnabled([ids],false)` 后 resolve 不再使用它们；`deleteSources` 批量删。
- [ ] **Step 2: 跑测失败确认**
- [ ] **Step 3: 移植上游 `:605-623`（select）、`:630-671`（批量启停）、`:673-708`（checkSources 试跑）、`:710-795`（删除）、`:809-831`（5MB 上限 + importSourceUrl）**。`ynx.de5.net` 端点原样保留（这是脚本生态公共服务，非身份项）。
- [ ] **Step 4: 通过** — [ ] **Step 5: `npm test`**

### Task 5: `lx-search.js` 五家爬虫

**Files:**
- Create: `lx-search.js`
- Test: `tests/lx-search.test.js`

**Interfaces:**
- Produces: `createLxSearch({ fetchImpl }) → { searchAll({query, limit?, sources?}) → {songs, failures}, searchOne(source,{query,limit}) }`；song 形状 `{source, id, songmid?, name, singer, album, interval, pic}`（Task 6/9/10 消费）

- [ ] **Step 1: 写失败测试**（fetch 桩回放真实响应截样本——从上游 scraper 正则反推 fixture JSON 三份：tx/wy/kg 各一；断言解析出 `{name,singer,songmid}` 与 `failures` 上浮）
- [ ] **Step 2: 失败确认**
- [ ] **Step 3: 移植上游 `lx-search.js:66-107`（HTTP 层含 Retry-After）、`:109-261`（五 scraper 含 eapi AES-128-ECB `:149-180`、QQ 签名 `:182-236`、咪咕 md5 `:238-261`）、`:368-411`（allSettled 聚合 + `source|songmid||id` dedupe）**。日志产品名改 Stellaflix。
- [ ] **Step 4: 通过** — [ ] **Step 5: `npm test`**

### Task 6: 搜索熔断冷却 + 搜索缓存

**Files:**
- Modify: `lx-search.js`
- Test: `tests/lx-search.test.js`（追加）

- [ ] **Step 1: 写失败测试**：单源连续 3 败后第 4 次 `searchAll` 不调其 fetch 且 `failures` 含 `{source, code:'SOURCE_COOLDOWN'}`；指数退避（注入时钟断言 2s/4s…封顶 120s）；同 query 2min 内二次调用命中缓存不再出网（`:359-375`）。
- [ ] **Step 2: 失败确认**
- [ ] **Step 3: 移植上游 `:361-394`（strikes/cooldown Map）+ `:406-409,420-446`（缓存 80 条 2min）**。
- [ ] **Step 4: 通过** — [ ] **Step 5: `npm test`**

### Task 7: server 路由族 + 安全闸

**Files:**
- Modify: `server.js`（新增路由集中在 `/api/audio` 之前的路由段；require 区 `:17-22` 附近加 `lx-source-host`/`lx-search`）
- Test: `tests/lx-source-routes.test.js`

**Interfaces:**
- Consumes: Task 1-4 host、Task 5-6 search
- Produces: 12 条路由（形状照上游 `server.js:2725-3145` 各段），`/api/lx-source/resolve` 返回体含 `proxyUrl`（`audioProxyUrl(url,headers)` 包装，我方 `/api/audio` 现有 `:8172`）

- [ ] **Step 1: 写失败测试**——起临时 server（`PORT=3999`，进程内 require 或 spawn 均按现有 e2e 测试的做法，参考任一 `tests/*.test.js` 起服务范式），fetch 断言：
```js
test('POST /api/lx-source/resolve 未装脚本时 200 + ok:false 且带引导码 LX_NO_SOURCES', ...)
test('GET /api/lx-source/status 返回 {sources:[],active:null}', ...)
test('非本地来源请求 /api/lx-source/search 被 isTrustedLocalApiRequest 拒 403', ...)
```
- [ ] **Step 2: 失败确认**
- [ ] **Step 3: 移植上游路由映射**：`status:2725`、`resolve:2734-2752`、`lyric:2755`、`import:2983`、`select:3000`、`toggle:3014`、`check:3029`、`delete:3044`、`search:3105-3116`、`playlist-search:3118`、`playlist-square:3132`、`daily-hot/platform-charts/song-cover-search:3060-3104`。host 单例在 server 启动时以 `userDataPath`（Electron 下由 main 传 env `STELLAFLIX_USER_DATA`，纯 node 下回退 `appData/Stellaflix`——**env 键名用我方前缀**）创建。`LX_NO_SOURCES` 为我方新增（spec §5 未装脚本引导）。
- [ ] **Step 4: 通过** — [ ] **Step 5: `npm test`** — [ ] **Step 6: 删除旧 netease 假桩** `server.js:6020-6037` 一并在此提交（它是 `/api/lx-source/*` 名字占位，现在被真身取代；同 task 内 grep 前端消费方确认无人依赖其 netease-shape 字段，若有则该消费方留给 Task 9/10 处理并在此注明）。

### Task 8: 导入匹配桥换血 + `/api/audio` 增强合并

**Files:**
- Modify: `server.js:441-450`（`platformPlaylistImport.setSearchImplementation`）、`server.js:8172` 附近 `/api/audio`
- Test: `tests/platform-playlist-import.test.js`（若存在则改注入断言；不存在则新建最小契约测试）、`tests/lx-audio-proxy.test.js`

**Interfaces:**
- Consumes: Task 5 `searchOne('wy',…)`
- Produces: 桥返回 `{ok,songs:[{name,singer,songmid,picUrl,interval,source:'wy'}],failures}`（与旧 netease 注入同形，import 模块零改动）

- [ ] **Step 1: 写失败测试**：桥单测断言注入函数内部调的是 `lx-search`（stub 替换计数）；`/api/audio` 断言：Range 透传 206、`url=localhost` 被拒、白名单 header 转发（对照上游 `server.js:3147-3204,944-954` 的三条行为）。
- [ ] **Step 2-5**: 失败→移植→通过→`npm test`。逐条比对现有 `/api/audio`：仅补差分行为，保留我方现有 token/校验逻辑不回归。

---

# 阶段 2 · 消费端一次性切换（单个可回滚提交）

### Task 9: 播放解析统一指 `/api/lx-source/resolve` + 三级失败链

**Files:**
- Modify: `public/js/modules/05-playback/13-playback-start-audio.js:1147-1334`
- Modify: `public/js/modules/05-playback/11-provider-fallback.js:489-512`（查询改指新路由）
- Modify: `public/js/modules/05-playback/14-custom-source-integration.js`（退役：文件保留到 Task 14 删除，此 task 起无人 import）
- Test: `tests/lx-playback-chain.test.js`

**Interfaces:**
- Consumes: Task 7 路由契约
- Produces: 前端函数 `resolveLxPlaybackSong(song, {quality, excludeResolvers}) → {url(proxyUrl), actual, probeWarning, resolver}`；`song._lxResolver` 记忆字段

- [ ] **Step 1: 写失败测试**（模块级纯函数测试法：仿 `tests/home-video-discovery-partial-retry.test.js` 用 vm 加载模块片段 + fetch 桩）：断言 ①官方五分支不再出现在新解析函数；②resolver 失败后 `excludedResolvers` 递增；③穷尽后调跨平台重匹配；④重匹配再穷尽→终态文案。
- [ ] **Step 2: 失败确认**
- [ ] **Step 3: 移植上游前端链**：打开上游 `public/index.html`，移植 `:31941-32005`（playLxSearchResult/resolveImportedLxAudio 三件套）、`:32324-32355`（resolver 重试+死 URL 去重）、`:32358-32372`+`:31889-31936`（跨平台换源+提示）、`:32380-32396`（onerror 重解析≤3）进我方 `13-playback-start-audio.js` 相应位置；`applyCrossPlatformSongMatch:31861-31888` 移植为 `11-provider-fallback.js` 的新查询实现。移植块内 `window.desktopWindow.customSource` 调用一律改 fetch 新路由。本地短路分支（`playLocalQueueSong`）不动。
- [ ] **Step 4: 通过** — [ ] **Step 5: `npm run bundle` + `npm test`**

### Task 10: 客户端缓存 + 在途去重 + 下曲预取

**Files:**
- Modify: `public/js/modules/05-playback/13-playback-start-audio.js`
- Test: `tests/lx-playback-chain.test.js`（追加）

- [ ] **Step 1: 写失败测试**：同曲并发两次只发一次 resolve；90s 内二次播放命中 `lxResolvedAudioCache`；音质切换调 `invalidateLxResolvedAudioCache(song)`；播放成功后 700ms 对 next 曲预取（注入时钟断言）。
- [ ] **Step 3: 移植上游 `:31804-31857`（缓存/去飞/失效）与 `:32026-32043`（700ms 预取）**。
- [ ] Step 2/4/5 同惯例。

### Task 11: 搜索 tabs + 聚合改指 `/api/lx-source/search`

**Files:**
- Modify: `public/js/modules/05-playback/07-search.js:445-477,1000-1137`
- Modify: `public/index.html` 搜索 mode tabs（`:139-151` 区）
- Test: `tests/lx-search-frontend.test.js`

**Interfaces:**
- Consumes: Task 5 song 形状、Task 7 `/search` 的 `{ok,songs,failures}`
- Produces: `fetchLxSearchResults(query,{sources})`；行渲染 `renderLxSongResults`（上游 `index.html:30645-30674`）

- [ ] **Step 1: 写失败测试**：tab 键集 = 综合/kw/kg/tx/wy/mg/本地；聚合单次调新路由；`SOURCE_COOLDOWN` failures 渲染成行内错误条；`.tag-source` 六家映射。
- [ ] **Step 3: 移植**：上游 tabs DOM `:5684-5694`、`renderLxSongResults` `:30645-30674`、dedupe/merge `:33253-33262`、`:30622-30641`；替换我方 `fetchMusicSearchResults` fan-out。qs/sp 参考源标记 `needsCrossPlatformMatch` 沿用现有文案。
- [ ] Step 2/4/5 同惯例（含 bundle）。

### Task 12: 音质词汇统一 + probeWarning 态

**Files:**
- Modify: `public/js/modules/00-state/00-api-quality-output.js`
- Modify: `public/js/modules/00-state/00-core-stores.js:120-146`（PLAYBACK_QUALITY_OPTIONS 重写）
- Test: `tests/lx-quality-vocabulary.test.js`

- [ ] **Step 1: 写失败测试**：`jymaster/hires/lossless/exhigh/standard` → LX `master/flac24bit/flac/320k/128k` 映射表；provider-VIP 门槛函数恒通过（不再按 cookie 判定）；`canReloadCurrentTrackForQuality` 白名单退役；probeWarning 驱动 pill tooltip 文案「在线音源按平台能力自动降级」（上游 `index.html:23228`）。
- [ ] **Step 3: 移植上游 `00-api-quality-output.js:20-27,68-93` 与 `index.html:23164-23191,31807-31822`（lxSourceQualityCandidates）**。本地「本地」项保留（`switchLocalQualityPlaybackTo` 语义不动，URL 供给换脚本后该函数只服务本地文件短路）。
- [ ] Step 2/4/5 同惯例（含 bundle）。

### Task 13: 源管理 UI（徽章 + 面板 + 双通道导入）

**Files:**
- Modify: `public/index.html`（顶栏徽章 DOM、`#lx-source-manager-mask` 面板、`#source-fallback-notice`）
- Create: `public/js/modules/05-playback/15-lx-source-manager.js`
- Modify: `public/css/index.css`（`.lx-source-*` 段）
- Test: `tests/lx-source-manager-ui.test.js`

**Interfaces:**
- Consumes: Task 7 全部路由
- Produces: `window.lxSourceManager.refreshBadge()`；徽章文案「启用数/总数」

- [ ] **Step 1: 写失败测试**：vm 加载新模块 + DOM 桩，断言 status 渲染行（当前/已停用）、批量条四键调 toggle/check/delete 的正确路由、文件导入逐文件校验回执、APIKEY 输入展开同 Task 4 规则、「音源会执行代码」提示存在、未装脚本时 resolve 失败 toast 含打开面板引导（spec §5）。
- [ ] **Step 3: 移植**：徽章 DOM `index.html:5667-5672`+逻辑 `:29506-29530`、面板 `:29553-29595`+handlers `:29640-29830`、文件导入 `:29851-29899`、链接导入 `:29911-29940`、CSS `:2691-2764`（glassmorphism/active 青色辉光随我方主题变量改写）。新模块须在 `bundle-modules` 清单登记 → 同步 `tests/bundle-modules.test.js` 计数。
- [ ] Step 2/4/5 同惯例（含 bundle + `npm run bundle:check`）。

---

# 阶段 3 · 拆除（逐项 grep 销号）

### Task 14: `desktop/custom-source/` + IPC + 集成模块删除

**Files:**
- Delete: `desktop/custom-source/`（14 文件含 bundled/）、`public/js/modules/05-playback/14-custom-source-integration.js`
- Modify: `desktop/main.js`（stellaflix-custom-source-* IPC）、`desktop/preload.js`（customSource 桥）、`public/js/modules/00-state/00-core-stores.js:153` 附近旧偏好键
- Test: 受影响既有测试删除/改写清单随提交说明

- [ ] **Step 1: grep 销号**：`grep -rn "customSource\|custom-source" desktop public tests` 列全部消费方；确认阶段2 后仅剩将删项自身。
- [ ] **Step 2: 删除 + 清 require/import 残链**；`stellaflix-custom-source-v1` 偏好键删除时保留一次性迁移（读旧键→无操作→删键，防真机留残）。
- [ ] **Step 3: `npm run bundle` + `npm test` 全绿** — [ ] **Step 4: 冒烟**：桌面版启动、播放走新链。

### Task 15: 官方平台路由与五平台 API 文件退役

**Files:**
- Modify: `server.js`（删 §4 清单路由、`handleSearch`、cookie 存取 `:475-903`、`qqCookieMusicKey:1657-1665`、NeteaseCloudMusicApi require `:10-39`）
- Delete: `kugou-api.js`、`qishui-api.js`、`qq-vip-api.js`、`spotify-api.js`、`qishui-auth-v6.js`、`qishui-qr-login.js`、`qishui-auth-v6/`、`qishui-audio-decryptor/`
- Modify: `package.json` build.files 白名单剔除上述项（勿漏根文件，[[project-win-build-ca]]）

- [ ] **Step 1: 前端消费方 grep 销号**（`/api/(qq|kugou|qishui|spotify|search|login|song\/url|song\/like|lyric)` 在 `public/js` 全量列表，逐个确认已在阶段2 改道；08-account 属 Task 16）。
- [ ] **Step 2: 路由删除**（每删一条在同 task 内跑 `npm test` 防暗雷）。
- [ ] **Step 3: 文件删除 + package.json 白名单同步 + `npm test`**。
- [ ] **Step 4: 安全复核**：cookie 文件落盘路径、DPAPI/safeStorage 残留清理钩子是否保留一次性清旧 cookie 文件（公开分发要求，参考 10-17 凭据清理块先例——`main.js` 中 subsonic 清理块模式可抄）。

### Task 16: 播客下线 + 平台账号 UI 退役

**Files:**
- Delete: `public/js/modules/03-beat/02-podcast-dj-analysis.js`、`server.js:6981-7092,7240` 播客路由、首页播客卡位
- Modify: `public/js/modules/08-account/*`（音乐平台登录框/cookie 粘贴/VIP 探测展示下线；影视侧登录零波及）、`public/index.html` 对应 DOM
- Test: `tests/` 内 podcast/account 相关既有用例随删清单

- [x] **Step 1: grep 消费方销号**（`podcast|djRadio` 全仓；`08-account` 对五平台登录路由的 fetch 点）。
- [x] **Step 2: 删除 + UI 收口**：音乐侧账号入口隐藏后确认设置页/首页无死链；`getLoginInfo` 等 10-17 双修代码若只剩影视消费方则保留（AI推理：须实测，别按记忆删）。
- [x] **Step 3: bundle + `npm test`** — [x] **Step 4: 冒烟**：首页仪表盘、影视登录不受影响。

### Task 17: 终局回归 + 文档 + 台账

- [x] **Step 1: `npm run bundle:check` + `npm test` 全绿**（200/200，见 task-17-report.md）。
- [ ] **Step 2: 真机冒烟清单**（主人执行）：搜索五源/播放/探音质降级提示/手动切源/源管理面板（导入文件+APIKEY+检查可用性+批量启停删）/重启后激活源保留/D 盘 `sources/` 持久化/未装脚本引导态。
- [x] **Step 3: README 功能段与 `docs/` 相关文档同步**（音源使用指引：脚本导入合规提示）。
- [x] **Step 4: 记忆台账更新**：`project-account-login-fixes`、`reference-music-library-apple-source`、`project-local-music-semantics`、`project-track-canonical-key` 等音乐侧结论标注架构变更；本 plan 完成态入库。

### Task 18: 官方直链取址与试听残留退役（合流前追加，主人 2026-11-01 裁定「2」）

**Files:**
- Modify: `server.js` — `/api/song/url` 路由 + 直链解析 + 站内同曲匹配全机（候选缓存/评分/合并/预算常量/受限分类/匿名登录常量/天气电台可播探测死码）退役，路由登记进统一 REMOVED 守卫
- Modify: `public/js/modules/05-playback/13-playback-start-audio.js` — 同曲候选重试、`sourceMatch` 元数据读写、SVIP/试听横幅点亮支路删除（`#trial-banner` DOM 保留为惰性，由 `tests/local-profile-fix1.test.js` 钉住）
- Modify: `scripts/quick-check.js` — 摘除已失效的官方同曲匹配与字节探测钉桩（`probePlaybackAudioUrl`/`audioProbeMagic` 早在 T15 已删，钉桩长期空挂），改钉「官方链不得接回」+ 每个 `apiJson(` 调用点必须限时
- Modify: `tests/platform-login-removal.test.js` — `/api/song/url` 与 `song_url`/`song_url_v1` 绑定由保留面改判退役
- Test: `tests/official-playback-retirement.test.js`（新增 5 例：服务端符号反证、守卫唯一登记、前端残留反证、lx 主链与公开元数据保留、实服 404 REMOVED）

- [x] **Step 1: RED 先行** — 新契约套件先跑成 4 红 1 控制绿（④）。
- [x] **Step 2: server 侧删除**（+11/−678 行，`node --check` 通过）。
- [x] **Step 3: 前端侧删除** + `npm run bundle` + `npm run bundle:check` 逐字节一致。
- [x] **Step 4: 受影响契约套件**：platform-login-removal 99/99、lx-playback-chain 21/21、quality-preference-normalize 3/3、podcast-removal 18/18、local-profile-fix1 9/9、bundle-modules 9/9、official-playback-retirement 5/5；quick-check 播放相关守卫隔离全绿。
- [x] **Step 5a: 全量 `npm test`** — 201/201 全部通过，退出码 0。
- [ ] **Step 5b: 真机冒烟（主人）**：验证点＝播放只出音源脚本、无「此歌曲需要 SVIP」横幅、失败走音源回退与跨平台换源。

**取证补记（有来源）**：`resolveNeteaseDirectSongUrlInner` 调用的 `probePlaybackAudioUrl` 已在 T15 随音频探测改造删除，server.js 只剩调用点 —— 官方直链即便命中上游 URL 也会在校验一步抛 `ReferenceError` 被本地 catch 吞掉，支路本已断，从未真正产出可播地址。

**保留但已无消费方（待主人裁定）**：`normalizeQualityPreference` + `qualityCandidatesFrom`（仅由 `tests/quality-preference-normalize.test.js` 钉住，已在函数注释处标明退役来历）；前端 `song.vipRequired` 汇总块（服务底部标题 VIP 徽标，`data.trial` 项已摘）。

---

## Self-Review 记录

- spec 覆盖：§1 身份表→Global Constraints；§2.1-2.3→Task 1-8；§3.1-3.4→Task 9-13；§4→Task 14-16；§5→Task 7(LX_NO_SOURCES)+13(引导)+15(cookie 清理)；§6→各 task Step 5 + Task 17；§7→阶段边界与并发规约；§8→Global Constraints「不引入」项。无缺口。
- 类型一致性：`resolveMusicUrl` 返回字段全计划统一 `{ok,source,url,headers,quality,requestedQuality,actual,probeWarning?,resolver,cached?}`；`searchAll` 返回 `{songs,failures}` 统一。
- 占位符扫描：Task 3/6/10 等「Step 2/4/5 同惯例」为重复性运行步骤引用（命令与期望已在惯例定义处写全），非行为占位；跨平台重匹配函数名 `applyCrossPlatformSongMatch` 全链一致。
