# 站点源可播化改造（pomo.mom 优先 + 秒播引擎）设计文档

**日期**：2026-10-03
**状态**：待主人审阅（未开工，无代码变更）
**取代关系**：本文档不推翻 `2026-10-01-huilian-magnet-site-source-design.md`，而是在其之上重新定性"磁力站源"的归属层；两者冲突处**以本文为准**。

---

## 0. 目标与非目标

**目标**（主人的原话拆解）：在影视态**公共搜索页**搜片 → 进详情页 → 打开**公共多源面板** → 选择以站点名命名的片源（如 pomo）→ 选择品质 → 进播放器**边看边播**，且**不为省硬盘而堆磁盘占用**。

**非目标**：
- 分类浏览入口（pomo `/sort/12?page=1`、seeduck `/categories/1/types/6/movies/`）——本期不做，schema 不留空位。
- 网盘（夸克/百度/迅雷/UC/阿里）交付——需账号凭据，红线禁止。
- 目录型 BDMV/ISO 原盘的"边下边播"——引擎无 piece 级能力，本期只承诺"下载后本地播放"。

---

## 1. 取证结论（本站设计的 factual 基础）

### 1.1 pomo.mom（有来源 = 真实 HTTP 响应）
- 搜索：`GET https://pomo.mom/?keyword={q}&page=1&pjax=1` + `X-Requested-With: XMLHttpRequest`。
  **`page=1` 是强制项**：不带即返回「暂无符合条件的影片 (No movies found.)」。
- 结果卡：`div.bg-cardbg …` > `a[href="https://pomo.mom/{id}"]` > `img[src="/content/uploadfile/…webp"]`，标题在 `h3.text-white.font-bold.text-[15px]`，原片名 `.text-gray-300`，年份 `.text-gray-400`。站点已从旧模板改版为 Tailwind。
- 磁力：**只在详情页**。`GET /{id}` → `#x-dbjs-download-section` 行 = 名称 | `[7.02GB]` | 复制 | 下载；磁力在 `a.x-dbjs-download-link/@data-url`，且每行**三个重复锚点**（`-download-link` / `-download-btn` / `-copy-btn`）指向同一 `data-url` → 必须按 btih 去重。
- 磁力形态：`magnet:?xt=urn:btih:<40hex>&dn=<名>`，**有 `dn`，无 `tr=`**。
- 原盘样本：`/3934` 头文字D 18 行 / 36 个磁力命中，41.24GB→8.8GB，`REMUX×7 Blu-ray×8 原盘×7`；这些行 `dn` **全部无文件扩展名**（目录型发布）。`ISO/BDMV/CD1/Part/disc` 关键字命中 0。

### 1.2 seeduck.cc（有来源 = 真实 HTTP 响应）
- Cloudflare 前置。Node `fetch`、Node `http2`、以及**任何浏览器 UA 变体均 403**（`Just a moment…` 挑战页）；`curl` 同 UA 200；**Electron 主进程 `net.fetch` 实测 200**。结论：拦截在 **TLS 指纹层**，不在 header 层。
- 搜索：`GET https://seeduck.cc/s/{q}/`（无 `<form>`，页面 JS `window.open('/s/'+val+'/')`）。`/search/?q=` 直连 403。
- 详情页 `GET /movies/58/`：**内联 `magnet:` 命中 0**。130 条种子在 `ul.seeds > li`：`a[title=完整发布名][href="/link_start/?seed_id=N&…"]` + `code.size` + `code.seed-feature`×N（4K/HDR/国语/iNT版…）+ `span.create-time`。
- 二阶页 `GET /link_start/?seed_id=N`（**无需 Referer，`movie_title` 可省**）：磁力以 base64 藏在内联脚本 `const data = "<b64>";` 中，解码后为 `magnet:?xt=urn:btih:<40hex>`，**无 `dn`、无 `tr=`**。
- 网盘 tab（`redirect_to=pan_id_N`）直出 `pan.baidu.com/s/…?pwd=xxxx`，本期不做。

### 1.3 现有代码事实（有来源 = 仓库当前状态）
- `public/video/sources-core.js:349-366` `dedupe()`：跨源归并键 = `title.toLowerCase()+'|'+(year||'')`，产出 `{title, year, pic, remarks, typeName, content, variants[]}`；`:369-393` `SFV.sources` facade 含 `getSources/addSource/normalizeSource/parsePlayUrl/pickMainEpisode/extractList/dedupe`；源对象形状 `:94 { name, api }`。
- `public/video/online-search.js:139-141` 公共搜索页**只并发两路**：`SFV.sources.search(kw,{timeout:12000})` + `SFV.kazumi.search(kw)`，随后 `:157 aggregateByLocalKey`、`:180 rankSearchResults`。
- main 上 `detail-source.js` / `source-picker.js` 对 `huilian*` **零引用**；磁力站点源的详情页分区只存在于未合并分支 `huilian-magnet-site`（d4fe868，其 `detail-source.js` 有 8 处 `huilianMagnet` 引用）。
- 分支 `huilian-magnet-source.js` 已实现两阶段抓取：`searchWorks()`:106 → `absolutize(detailUrl)` → `parseVersions()`:140；`SEARCH_TIMEOUT_MS=15000`、`DETAIL_TIMEOUT_MS=20000`、`MAX_CONCURRENCY=2`、`mapFetchError`:192。
- `huilian-queue.js:67 isPlayable(file)` = `file.progress >= 5% && size > 0`（下载器语义，非 read-through）。
- qbt 已随包分发：`desktop/video-config.js:66 _up_/resources/qbittorrent/qbittorrent.exe`，`desktop/download-manager.js:102-107` 以 `--configuration=qbt-portable` 拉起；凭据落盘见 `desktop/qbt-credential.js:8`。
- 本机 BT 链路**从未真机验证**：全盘未找到 `mpv.exe`（`desktop/mpv-controller.js:340-341` 指向 `_up_/mpv/mpv.exe`），进程列表无 `mpv`/`qbt`。

### 1.4 引擎事实（有来源 = TorrServer MatriX.145.1 仓库）
- `GET /stream?link=<magnet|hash>&index=<n>&play&title&preload&stat&save&m3u&fromlast` → `application/octet-stream`，即"可 Range 的流"。
- `POST /torrents` body `{action: add|get|set|rem|list|drop|wipe, link, hash}`，BasicAuth。
- `GET /settings` / `GET /shutdown`。
- `server/settings/btsets.go`：`CacheSize`(默认 64MB) / `ReaderReadAHead`（`5%-100%, [...S__X__E...] [S-E] not clean` = **读指针周围区间之外的内存即弃**）/ `PreloadCache` / `UseDisk` / `TorrentsSavePath` / `RemoveCacheOnDrop` / `RetrackersMode`(`1`=add) / `TrackersListURL`+内置 ngosang 镜像 / `DefaultTrackers` / `EnableDLNA` / `EnableBonjour` / `DisableUPNP` / `DisableUpload` / `PeersListenPort` / `ConnectionsLimit`。
- `anacrolix/torrent` 公开 API **无 piece 级擦除**（仅 `Torrent.Drop()`、`Piece/File.SetPriority()`）。
- 体积：`TorrServer-windows-amd64.exe` = **60.6 MB**（gst 变体 94.2 MB）。许可 **GPL-3.0**，3085★，2026-10-02 仍在更新。

---

## 2. 架构决策记录（主人逐条裁定）

| # | 决策 | 裁定 |
|---|---|---|
| D1 | 成功标准 | 磁力站作为**同级片源**进公共搜索页与多源面板，点品质即播 |
| D2 | P0 范围 | pomo + 源抽象；**不动 desktop** |
| D3 | 秒播引擎路线 | **A：独立 read-through 引擎**（否决"mpv 接管"——mpv 不做 piece 调度；规则层绝不进播放器层） |
| D4 | 引擎形态 | **A1：TorrServer 随包分发**（60.6MB，与已随包 qbt 同量级） |
| D5 | 代码地基 | **摘纯函数地基进 main + 按新形态重写接线**；不整体 merge 分支，分支保留不删 |
| D6 | YAGNI① | 分类浏览本期不做，schema 不留空位 |
| D7 | YAGNI② | 不开放自定义请求头，只给封闭枚举 `ajax` |
| D8 | YAGNI③ | `fetchChannel` 字段定义保留，M1 值域仅允许 `'node'`；`'chromium'` 校验拒绝并报明确原因 |
| D9 | 边看边删 | 真实意图 = **省硬盘** → 采用引擎内存滚动窗口（`UseDisk=false`），**不做磁盘滚动删除**。技术前提=有来源（`anacrolix/torrent` 无 piece 级擦除 API）；定量论证=AI推理（按 45GB/2h ≈ 6.3MB/s 估：20min 窗口稳态多缓冲约 3.78GB，且"删最早 10 分钟"会把已下好的正片删掉，比引擎默认窗口更差） |
| D10 | 上传 | 秒播引擎**默认允许上传**，须配套设置面板开关 + 首次启用一句告知 |

---

## 3. 分层与命名归属

```
规则层   sourcesite-rules     外置、可导入、可停用、整条 schema 校验
   ↓
源适配层 sourcesite-source    规则 + 抓取通道 → 统一 Work / playItem 模型
   ↓  消费者（公共面）
   ① online-search.js  影视态公共搜索页（新增第三路并发）
   ② source-picker.js + detail-source.js  公共多源面板
   ③ huilian-site-search  汇联站点搜索（M1 摘地基后才有；main 上不存在，
      目前只在未合并分支 huilian-magnet-site 的 public/video/ 下）
   ↓
交付层   http(source-adapter.js 三源适配层 + /api/proxy)  |  bt(秒播引擎 | qbt 持久下载)
```

**硬要求（"公有资产"的可验证形式）**：源适配层的磁力 Work 必须归一为 `dedupe()` 认得的形状（`title/year/pic/remarks/typeName/content`，并以自身 source key 进入 `variants[]`），使其**自动**流经 `online-search.js:157/:180` 的聚合与排行链——不允许出现"磁力专用"的搜索旁路代码。

**接口签名**：`sourcesite-source.search(keyword, { timeout, filters }) → Promise<Work[]>`，与 `SFV.sources.search` / `SFV.kazumi.search` 同形可并发。

**M1 前置取证（已完成；有来源 = `detail-source.js` / `source-picker.js` 当前 main 代码）**：
- 多源面板**不消费搜索页结果**，它有自己的一条按源并发链：`collectSourceUnits()`:523（枚举 `cms:<id>` / `kazumi:<ruleName>` 两类单元）→ `queryOneUnit(u,kw,token,isRetry)`:378（按 `u.kind` 分派 `SFV.sources.search` / `SFV.kazumi.searchRule`）→ `normalizeUnitItems(u,items,view)`:540 拍平成 `{id,label,sub,title,kind,group,isEmbed,_ref,sourceKey}` → `SFV.sourcePicker.open({groups,candidates,onPick})`:354 → `pick(i)`:273 → `playCandidate(c,view,sections)`:577 按 `c.kind` 分派播放器（kazumi 走 `SFV.kazumi.getChapters`+`SFV.online.playEpisode`；cms 走 `SFV.sources.detail`）。
- grep 证实 `detail-source.js` / `source-picker.js` / `online-search.js` **均未引用** `SFV.sourceAdapter`（有来源 = 三文件 grep 无命中）。故 `playItem` 的交接点是上面那四处，`http` 交付沿用 `playCandidate` 现有分派，**不改 `source-adapter.js`**。
- 结论：磁力源要成为"同级片源"必须接**两处**——搜索页（`online-search.js` 第三路并发）与面板（新增 `kind:'magnet'` 源单元）。

**命名归属**：新增中立模块 `public/video/sourcesite-*.js` 持有逻辑；现 `huilian-magnet-*` 降级为**薄委托**（只转发，不持逻辑）。`tests/huilian-magnet-registration.test.js`（分支既有）的顺序契约随之改写为"中立层先于委托层"。**本期不重命名任何 `huilian-*` 文件**，旧名清理不在 M1/M2/M3 任何范围内。

---

## 4. 规则 schema v2

v1 基线（有来源 `huilian-magnet-rules.js:17-23`）：
`REQUIRED = [id,name,origin,searchURL,workItemXPath,magnetItemXPath,magnetAttr]`、`WORK_FIELD_KEYS = [title,altTitle,year,poster,detailUrl]`、`LIMITS = {xpath:1000, tracker:300, trackers:40}`。

v2 新增（全部 optional，v1 规则不改即兼容）：

| 字段 | 类型/取值 | 依据 |
|---|---|---|
| `ajax` | `'none'\|'xhr'`（封闭枚举，值写死在代码） | pomo pjax 需 `X-Requested-With`；D7 禁止自由 header |
| `pageParam` | string（如 `page`） | pomo/seeduck 分页 |
| `firstPageMandatory` | boolean | pomo 无 `page=1` 即空结果（1.1） |
| `maxPages` | number ≤ `LIMITS.pages=5` | 抓取面收敛 |
| `extractor` | `{type:'attr'\|'scriptBase64', path, attr?, pattern?}` | pomo `@data-url`；seeduck 内联 base64 |
| `magnetAttr` | 保留为 `extractor` 的向后兼容简写 | 不破坏 v1 |
| `versionFields` | `size?` / `tags?` / `time?`（XPath） | pomo `[7.02GB]`；seeduck `code.size`/`code.seed-feature`/`span.create-time` |
| `dedupeBy` | `'btih'`（默认启用） | pomo 每行 3 个重复锚点 |
| `fetchChannel` | `'node'\|'chromium'`，**M1 值域仅 `'node'`** | 1.2 CF 指纹；D8 |
| `playability` | `'auto'` 或 `[{match, deliverable}]` 覆盖列表 | 1.1 目录型判定 |

**校验与合规守恒**：新字段并入同一张 `FIELD_LIMIT` 长度表；未知字段仍整条拒绝；`scriptBase64` 解出的字符串**必须过 `extractBtih()` 非 null 才入库**（btih 解析唯一口不变）；trackers 仍只从规则声明列表拼进 URL；`migrateRuleV1→V2` 失败则整条不入库、停用即时生效。

---

## 5. 播放契约与交付分级

统一面板二级条目：
`playItem = { name, kind: 'hls'|'direct'|'magnet', ref, deliverable: 'stream'|'download'|'unsupported', sizeBytes, tags[] }`

`ref` 语义按 `kind` 收敛：`hls`/`direct` = 可播 URL；`magnet` = 完整 magnet URI（含 `dn`，不含任何站点凭据）。`sizeBytes` 缺失时为 `0`，此时体积阈值判定不参与（只走名称/规则两级）。

`deliverable` 判定顺序（**宁保守，不虚报**）：规则 `playability` 覆盖 → 名称扩展启发（`.mkv/.mp4/.ts` = 单文件）→ 体积阈值 → **默认 `download`**。

| deliverable + kind | 点击后行为 | 面板文案 |
|---|---|---|
| `stream` + `hls/direct` | 现有在线播放（`/api/proxy`），**零改动** | 直接播 |
| `stream` + `magnet` | 秒播引擎（§6）取 Range URL 交给播放层 | 秒播 · 不保存 |
| `download` | 入 qbt 队列（现有 `huilian-queue`/`huilian-page`） | 需下载后播放 |
| `unsupported` | 不显示，或灰置并注明原因 | — |

**三条防"等待错配"硬约束**：
1. 三态徽标常显，禁止 `download` 与 `stream` 看起来同级。
2. 定数超时：`STREAM_META_TIMEOUT_MS = 45000`（裸 btih 需连 tracker/DHT 拿 metadata）、`STREAM_FIRST_BYTES_TIMEOUT_MS = 20000`（metadata 到手后须读到首个 piece）。超时动作 = **明示失败 + 该项就地降级为 `download` 并给"加入下载队列"一键**，绝不静默重试。
3. 体积 ≥ `12e9` 字节（12 GB）且 `deliverable='stream'` 时行内追加"高体积，起播可能需数十秒"（不承诺具体秒数）。

**权威划分**：秒播引擎 = ephemeral；**qbt 是唯一持久下载权威**。同 `btih` 若已在 qbt 队列且该文件进度达 `isPlayable` 阈值 → 直接用 qbt 文件路径播，**不起秒播任务**（禁止"同一部片两份下载"）。

**并发**：秒播同时只 1 个任务，新任务**抢占**旧任务（旧任务立即 `POST /torrents {action:'rem'}` 释放），抢占前不询问。

**省硬盘（D9 落地）**：引擎预配置固定 `UseDisk=false`、`CacheSize=64MB`（可在设置面板上调）、`ReaderReadAHead=30`（与下节预配置同源，不是"沿用默认"）→ 已看过的数据不留存，稳态磁盘占用≈0。UI 必须同时告知"秒播不保存成品"，要留档请点"加入下载队列"。

---

## 6. 秒播引擎集成（M2）

**落位**：`_up_/resources/torrserver/TorrServer-windows-amd64.exe`；`build.files` 白名单必须新增该根目录（历史教训：白名单漏新根文件导致产物缺件）。

**只使用以下 5 个端点（四类调用）**：
1. `GET /stream?link=<magnet>&index=<n>&play&title=<名>` → 播放 URL（交现有播放层）。
2. `POST /torrents {action:'get', hash}` → 文件列表与 `index`（多文件种子选路用）。
3. `POST /torrents {action:'rem', hash}` → 关播/抢占时释放。
4. `GET /settings`（首次懒启动后写死预配置）+ `GET /shutdown`（app 退出）。

**预配置（一次写死，用户可见项进设置面板）**：
```
UseDisk=false  CacheSize=64MB  ReaderReadAHead=30
RetrackersMode=1  TrackersListURL=''  DefaultTrackers=<规则声明列表>
EnableDLNA=false  EnableBonjour=false  DisableUPNP=true
DisableUpload=false        // D10 默认允许上传
ResponsiveMode=true
```

> `ResponsiveMode` 未出现在 1.4 的 `btsets.go` 取证清单里（AI推理：它属于 TorrServer 常规 settings 面）。M2 第 0 任务的 spike 必须实测确认该键存在并可写；若不存在则删除该行，不影响其余预配置。

**生命周期**：懒启动（首次点击 `stream+magnet` 才 spawn）→ 端口取随机高位 → 引擎不可用/端口占用/进程崩溃 → 明示并降级 `download`；播放器关闭与页面隐藏 → `rem`；app 退出 → `/shutdown` 再 `kill` 兜底（对齐现有 overlay 生命周期红线）。

**安全边界**：
- **只允许 `127.0.0.1` 监听**是硬需求。M2 第 0 个任务（spike）必须实测并记录：绑定参数是否可用；若引擎无法限定回环，则该里程碑**判不通过**，改走"随机 BasicAuth 强口令 + 关闭 UPnP/DLNA/Bonjour + 首次启用告知"作为最低门槛，仍不满足则不随包分发。
- 随机口令：内存生成 + `userData/huilian-ts-cred.json` 落盘（与 qbt 同族做法），**绝不出现在日志、错误文案、UI 提示**（红线②延长）。
- 上传默认开（D10）→ 设置面板必须提供开关，并在首次启用时一句告知；`PeersListenPort` 取随机高位。

**tracker 责任归属**：规则层**不藏** tracker；裸 `btih`（两站实测无 `tr=`）由引擎 `RetrackersMode=1` + 注入列表解决。红线③在引擎通道的等价形式：**只提交 magnet URL，绝不转发任何站点 header/cookie**。

**第三方许可**：随包附 `LICENSE`(GPL-3.0) + 源码获取地址（THIRD-PARTY-NOTICES 条目）。独立进程聚合不传染本仓库代码。

---

## 7. 里程碑与验收

**本轮只规划 M1**：通过自查后 `superpowers:writing-plans` 只产出 M1 的实施计划。M2/M3 各需主人另行批准才能出计划与动工（它们改动 `desktop/**` 并引入随包二进制，红线 10）。

| 里程碑 | 范围 | 动 desktop | 磁力点击兑现 |
|---|---|---|---|
| **M1 源抽象与同级片源** | 摘地基（`extractBtih`/rules/enrich/source + 契约测试）→ main 中立 `sourcesite-*`；schema v2（`fetchChannel` 仅 `'node'`）；归一进 `dedupe/variants`；`online-search.js` 第三路并发；面板二级统一 `playItem`；三态徽标 + "不保存"文案 | 否 | 走现有 qbt 队列 |
| **M2 秒播引擎** | 随包 + 网关封装 + 随机口令 + 懒启动/抢占/降级/生命周期 + 内存窗口 + 上传开关。**第 0 任务 = 真机 spike**（含 127.0.0.1 绑定取证） | 是 | `deliverable='stream'` 秒播 |
| **M3 seeduck** | `fetchChannel='chromium'` 桌面抓取通道 + `scriptBase64` 提取器 + `ul.seeds` 行映射 | 是 | 同 M2 |

**验收口径**：
1. `npm test` 全量绿（判据是仓库 `tests/run-all.js`，不是文档里的指南通过数）。
2. 真机冒烟硬项：回环端口扫描证明不对外监听；口令零出现在日志/文案/UI；断网与 tracker 全挂时的降级文案；抢占后内存释放；包内含 TorrServer `LICENSE` 与源码地址；`build.files` 含新根目录；60GB 单文件首帧耗时实测记录；秒播结束后磁盘增量≈0。
3. 现有 60 项汇联冒烟清单沿用并增补上述项。

---

## 8. 合规红线（延长而非替换）

1. **零内置规则**：仓库与安装包不得含真实磁力站 origin、XPath 列表、tracker 列表。两站规则只能由用户导入。
2. **口令**：qbt 与 TorrServer 的随机口令一律不进日志/错误文案/UI。
3. **入队/入引擎最小化**：只提交 magnet URL；不转发站点 cookie、session、任何请求头。
4. **fixtures 脱敏**：测试夹具不得含可直接下载的真实 btih。
5. **注入防御**：`extractBtih()` 是 btih 解析唯一口，null 即拒；`dn`/文件名清洗 CR/LF/引号。
6. **抓取面**：只请求规则声明的 origin；`/api/proxy?url=` 恒 `encodeURIComponent`。
7. **XPath=外部输入**：整条 schema 校验，失败即整条不入库，停用即时生效。
8. 新增：**默认允许上传必须可见可控**（开关 + 首次告知）。
9. 新增：**随包第三方二进制的许可与源码获取义务**。
10. 不变：`public/video/kazumi/**` 禁改；M1 阶段 `desktop/**` 零改动（M2/M3 需另行批准）；不新增 npm 依赖（TorrServer 是外部二进制，不是依赖树）；外部文本只走 `el()`/`createElement` + `textContent`，禁 `innerHTML`；异步回调先过 `isStale(gen)`。

---

## 9. 已知风险（pre-mortem 残余）

| 风险 | 缓解 |
|---|---|
| BT 链路至今零真机验证（本机无 `mpv.exe`、无 qbt 进程） | M2 第 0 任务 spike 先验引擎可用性与回环绑定，失败即停，不进实现 |
| 站点机制漂移（pomo 已改版一次） | 规则外置 + 停用即时生效 + 失败可见；不得内置 |
| 原盘目录型被用户期待为可秒播 | `deliverable='download'` 显式标注 + 徽标常显；不在文案中承诺目录型可播 |
| Cloudflare 指纹对 Node 永久生效 | `fetchChannel='chromium'` 推到 M3，M1 明确拒绝该值而非静默降级 |
| 双引擎语义冲突（同一磁力两处下载） | §5 权威划分：qbt 唯一持久，秒播 ephemeral，命中即复用 qbt |
| 60.6MB 引擎拖累包体积 | 已随包 qbt 同量级，接受；若主人后续反悔可切 A2 按需下载 |
