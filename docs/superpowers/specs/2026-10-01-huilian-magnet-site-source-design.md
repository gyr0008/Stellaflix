# 汇联 磁力站点源提取与播放 设计（pomo.mom 首个落地站点）

**日期**：2026-10-01
**状态**：设计已逐节确认；2026-10-01 增补同类工具调研（§12），并据此修正认领键（§5.5/§3.2）、tracker 时效（§6.6.5）与真机取证清单（§10）→ 待用户审阅本文 → 转 writing-plans
**前置**：`docs/superpowers/specs/2026-09-30-huilian-bt-player-design.md`（BT 队列 + mpv 起播内核，已合入 main `1dfc63c`）。本设计**只做「从哪里弄到磁力」和「怎么摆给用户看」，不动 desktop 层一行。**

---

## 0. 范围

**做**

1. 从磁力站点的「搜索 → 详情 → 磁力」链路提取种子并入队起播。
2. 详情页多源面板新增**磁力独立分区**（与 CMS 源、Kazumi 规则同级），点击走完整播链路。
3. 汇联页搜索结果**卡片排版**（作品横卡 + 就地展开版本 + 差异徽章）。
4. 站点规则走**远端规则源 + 一键导入**，绝不随包内置。

**不做**（写明以免实施时越界）

- 站点搜索分页破解（机制未研究通，不承诺）。
- 四列海报卡墙与抽屉式版本面板（论证与取舍见 §6.2/§6.3：海报降级为「可缺省的 26×36 缩略」，版本改为就地展开，模态一律复用既有 `openModal`）。
- mpv 属性事件订阅、音轨字幕切换、独立窗口兜底、播放预设（上一轮已被用户改向作废）。
- desktop 层任何改动：`makeAddParams` → `download.addTorrent` → 轮询认领 → overlay 起播是既成能力（`public/video/huilian-queue.js:36`、`public/video/huilian-page.js:183-208`）。**唯一例外**见 §5.5：认领键从「整串相等」扩为「btih 归一」，改动落在渲染层 `huilian-queue.js:52-64`，desktop 仍零改动。
- qBittorrent 客户端侧的**防吸血 / 死种复活 / DoH / 文件级选择性下载 / 端口映射**（调研 qbee、GoPID、Transmission、InFile 后判为不做，逐项理由见 §12）。

---

## 1. 决策台账（D1–D6 用户明示；D7 为用户批准的调研结论，非用户主动提出）

| # | 决策 | 落地约束 |
|---|---|---|
| D1 | 复用 Kazumi 引擎 + 新增 magnet 结果类型 | `kazumi/` 目录内部禁改（`kazumi-bridge.js:1-23`），只在 bridge 层外挂 |
| D2 | 详情页与汇联页两处都要，详情页不是跳转入口而是**独立分区 + 完整播链路** | §5 |
| D3 | 远端规则源 + 一键导入 | 仓库与安装包内**零站点规则**（合规红线） |
| D4 | 总是手动选版本 | UI 不提供「自动挑最佳」 |
| D5 | 卡片形态=**作品横卡 + 就地展开**为主体，加筛选条，海报降级为「可缺省的 26×36 缩略」（三套候选的合成取舍，论证见 §6） | §6 |
| D6 | 徽章=**差异槽**：全集恒定值上提到作品卡头，行内只显有区分度的字段（固定四槽方案经 14 条真实数据核算后否决） | §6.3 |
| D7 | 调研四款同类工具后，只借「tracker 清单外置 + 时效提示」，其余（防吸血/死种复活/DoH/选择性下载/端口映射）逐项判为不做；认领键改为 btih 归一 | §12、§5.5、§6.6.5 |

**存储决策（AI推理，源自代码事实）**：磁力规则**不能**存进 Kazumi 规则对象。`public/video/kazumi/rule-schema.js:85-118` 的 `fromJson` 返回已知字段的新对象字面量，未知字段（`magnetSearchURL`/`magnetItemXPath`/`trackers`…）会被静默丢弃，`index.js:63/75` 的读写都过它。故磁力规则走**独立 localStorage 键** `sfv-huilian-magnet-rules`，由新文件自持 schema。

**同类工具调研结论**：§12 逐项判定四款客户端的可借之处，只落地「tracker 清单时效提示」，其余判为不做。

---

## 2. 站点事实（有来源：2026-10-01 实抓）

| 事实 | 证据 | 设计后果 |
|---|---|---|
| 搜索页是**作品卡**网格，不是版本行 | `grid gap-6 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4` + `relative aspect-[3/4]` 海报 + 中文标题 + 英文原名 + `tag`(IMDB/Dolby/Web) | 两级结构（作品→版本）是站点固有形状，UI 不该假装只有一级 |
| 服务端渲染片段可拿 | `&pjax=1` 返回纯片段（24 KB vs 整页 100 KB） | 抓取用 pjax URL，省带宽且无 JS 依赖 |
| 磁力在 `data-url` 属性 | `data-url="magnet:?xt=urn:btih:…"` ×42 | 选择器取属性而非 href；`xpath-engine.parseChapters` 只读 `href`，**不能直接复用**，需自写属性抽取 |
| **0/42 带 `tr=`、0/42 带 `dn=`** | grep 计数 | 必须注入 tracker；展示名只能来自链接文字 |
| 42 条 `data-url` → **14 个唯一 btih** | 去重实测 | btih 去重是必做项，否则同一版本重复入队 3 次 |
| 体积站点已给 | `.file-size` = `[26.76GB]`…`[2.89GB]` | 体积做主排序键，不需要自己算 |
| 发布名自带结构化线索 | 14 条唯一名的词频（§6.3 表） | 徽章由解析器产出，非人工标注 |

---

## 3. 架构与文件清单

### 3.1 新增（5 个文件，全部挂在 `window.StellaflixVideo` 上，无构建步骤）

| 文件 | 职责 | 预估 |
|---|---|---|
| `public/video/huilian-magnet-enrich.js` | **纯函数**：tracker 注入（拼 `&tr=`，见下方说明）、`dn=` 补写、btih 去重（键取 `SFV.huilianQueue.extractBtih`，单一实现见 §3.2）、发布名 → 徽章族解析、恒定值归约、体积解析与排序 | ~120 行 |
| `public/video/huilian-magnet-rules.js` | 磁力站点规则的 schema、localStorage 读写、远端一键导入（URL → 校验 → 落盘）、启用列表 | ~130 行 |
| `public/video/huilian-magnet-source.js` | 抓取与解析：`searchWorks(title, rule)` / `fetchVersions(detailUrl, rule)`；HTTP 走 `kazumi/http-client.js` 的 `KazumiHttpClient`（`X-Requested-With` 实测非必需，故零改动复用），HTML 解析走 `kazumi/xpath-engine.js` 的 `parseHtml` + `queryXPathAll` | ~200 行 |
| `public/video/huilian-site-search.js` | 汇联页搜索区组件：搜索行、筛选条、作品横卡、就地展开、入队按钮、展开状态机、抓取限流 | ~230 行 |
| `public/video/huilian-magnet-rules-ui.js` | 磁力规则的导入与开关面板（D3 的落地面）：列表 / 从 URL 导入 / 粘贴 JSON / 停用 / 删除 | ~90 行 |

**注册**：`public/index.html` 的视频模块清单内，在 `"video/huilian-page.js"`（现 2148 行）**之前**插入五条，顺序 `enrich → rules → rules-ui → source → site-search`（依赖序）。该位置在 `"video/huilian-queue.js"`（2146）之后，故 `huilian-magnet-enrich.js` 运行时取 `SFV.huilianQueue.extractBtih` 可用。`package.json` 的 `build.files` 已含 `public/**/*`，打包无需改白名单。

**磁力规则 schema（localStorage `sfv-huilian-magnet-rules` 的条目形状，也是导入 JSON 的校验目标）**

```js
{
  id: 'pomo',                 // 稳定标识 → sourceKey = 'magnet:' + id
  name: 'pomo.mom',           // 展示名
  origin: 'https://pomo.mom', // 唯一允许抓取的源（白名单）
  searchURL: '…/search.php?search={query}&pjax=1',  // {query} 由代码 encodeURIComponent
  workItemXPath: '…',         // 作品条目（卡片根）
  workFields: { title, altTitle, year, poster, detailUrl },  // 每项一条 XPath
  magnetItemXPath: '…',       // 详情页内磁力锚点
  magnetAttr: 'data-url',     // 磁力所在属性名（本站非 href）
  sizeXPath: '…',             // 可选：体积所在元素
  trackers: [ … ],            // 注入用；缺省=不注入
  importedAt: 0,              // 由代码在导入时写入（非导入 JSON 字段），用于 §6.6 时效提示
  enabled: true
}
```

字段一律**必填校验 + 长度上限**，XPath 与 tracker 只从导入来，仓库零内置（§9.1）。

**tracker 只能拼进 magnet URL（有来源，代码事实）**：`/api/v2/torrents/add` 的表字段由 `desktop/download-manager.js:192-202` `collectAddFields` 构造，只有 `urls / savepath / autoTMM / paused / seedingTimeLimit / sequentialDownload / firstLastPiecePrio`，**没有 `trackers` 字段**。所以注入必须在渲染层把 `&tr=<encodeURIComponent(tracker)>` 重复拼到 magnet 串上，再由现有 `url` 通道提交；这正是 §5.5 认领键必须换成 btih 的直接原因（qbt 回吐的 `magnet_uri` 是它按内部顺序重建的，不等于我们拼出来的串）。

### 3.2 修改（五处）

| 文件 | 改什么 | 现状行数 |
|---|---|---|
| `public/video/huilian-queue.js` | **认领键扩展**（§5.5）：新增导出 `extractBtih(magnet)`——取 `xt=urn:btih:` 后首个值，**40 位十六进制归一为小写、32 位 base32 归一为大写**，长度或字符集不符返回 `null`（与现有 `MAGNET_RE:12` 同属「磁力识别」职责，故放本文件而非 enrich）；`matchHash:52-64` 先按现有「整串相等」比，未命中再比 `extractBtih(t.url)` / `extractBtih(t.magnet_uri)` 与入队串的归一 btih。**整串相等必须仍是第一路**，否则 `tests/huilian-queue.test.js:30-34` 里 `urn:btih:abc123` 这类非法定长样本的语义会变 | 106 |
| `public/video/huilian-page.js` | `mount` 内挂载 `SFV.huilianSiteSearch`、`unmount` 内销毁；入队改调 site-search 的回调 | 348（上一计划沿用 350 行/文件约定，仓库**无测试把守**，属自觉约束 → 因此渲染逻辑一律放 site-search，不留在此） |
| `public/video/detail-source.js` | `collectSourceUnits:523-534` 加 magnet 单元；`queryOneUnit:378-410` 加分支；`normalizeUnitItems:540-565` 加 magnet 归一；`playCandidate:577-628` 加 magnet 分发 | 1032 |
| `public/video/source-picker.js` | `groupBySource:69-84` 展示名加 magnet 分支；`makeRow:244-271` 图标 `🧲` + 徽章「磁力」；其余（Tab、状态点、`appendSource`、`renderErrorWidget` 的重试/别名/手动检索）**按 sourceKey 通用，零改动复用** | 514 |
| `public/video/player.css` | `huilian-*` 新样式（横卡、卡头、差异徽章、筛选条、窄屏退化） | — |

---

## 4. 数据流

```
详情页：collectSourceUnits(+magnet) → queryOneUnit → huilian-magnet-source.searchWorks
      → enrich.dedupeByBtih + enrich.parseBadges → normalizeUnitItems(kind:'magnet')
      → source-picker 独立分区 → pick → playCandidate 的 magnet 分支
      → makeAddParams(enrichedMagnet) → {url} → download.addTorrent   // 现有签名 (huilian-queue.js:36)
      → 跳汇联页 → pollOnce/matchHash（btih 归一认领，见 §5.5）→ 选文件 → mpv overlay

汇联页：搜索行 → searchWorks → 作品横卡 →（展开时限流抓取）fetchVersions
      → 版本行 → 入队（同一 makeAddParams 通道）
```

单一入队口：两条入口最终都汇到 `submitParams`（`huilian-page.js:236`），不复制第二套入队代码。`makeAddParams` 的入参是**已拼好 tracker 的完整磁力串**，队列快照里存的也是它——认领因此不能靠整串相等（§5.5）。

---

## 5. 详情页磁力分区（D2 定稿）

1. **分区出现条件**：至少一条磁力规则启用。未启用 = 该分区不存在（与「无启用 Kazumi 规则」同构，不是空 Tab）。
2. **身份**：`sourceKey = 'magnet:' + rule.id`，`sourceName = rule.name`（站点名）。同名不同 id 不串台，靠的是 `groupBySource` 已按 key 分组（`source-picker.js:66-68` 注释即为此前修复）。
3. **呈现**：行 = 一个**作品**（不是版本），`label` 中文片名、`sub` = 「N 个版本 · 体积区间」、徽章「磁力」、图标 `🧲`、`isEmbed=false`。
4. **点击行为＝入队并走完整播链路**（用户 2026-10-01 选定，替代早期的「toast + 跳转」占位设计）：弹出版本选择（该作品 `fetchVersions` 的结果，D4 手动选）→ 选定版本 = 选定 btih → `makeAddParams` 入队 → 关闭弹窗 → 跳汇联页 → 由既有轮询认领并起播。**不做 toast 占位，不跳站外。**
5. **重复入队**：入队前用队列快照的 btih（`extractBtih`）比对，**不比对整条磁力串** → 命中则不重复入队，直接进汇联页并高亮定位该任务行。
6. **认领键（btih 归一）**：`matchHash` 必须能认「我们拼过 tracker 的串」对「qbt 回吐的 `url`/`magnet_uri`」。整串相等保留为第一路（既有直链粘贴流程依赖它），第二路比 `extractBtih`。**这条不是优化而是必需**：`/api/v2/torrents/add` 无 `trackers` 字段（§3.1），tracker 只能拼进 URL，而 qbt 回吐的 `magnet_uri` 是它自己重建的，与我们拼出的串**很可能不同序甚至不同条数**（AI推理，取证项见 §10）→ 若只靠整串相等，症状是「入队成功但任务永不被认领、永远播不起来」。真机取证项见 §10。
7. **版本选择器**用 `source-picker.js:372-384` 的 `openModal` 既有模态工具（别名/手动检索已在用），避免新造第三层模态。
8. **版本抓取与汇联页共用同一份缓存**：详情页弹出的版本选择调的也是 `fetchVersions(workKey)`，同 workKey 在一次会话内只抓一次，并同样受 §6.4 的并发上限 2 约束——避免「详情页和汇联页各写一套抓取」。

---

## 6. 汇联页排版与卡片（D5 + D6 定稿）

### 6.1 页面三层

```
[搜索行]  输入框 · 搜索钮 · 「规则」钮(§6.6) · 结果计数
[筛选条]  字幕 / 分辨率 / 体积档 / 排序       ← 生效时相关作品自动全展开
[结果区]  作品横卡列表（就地展开版本行）
[队列区]  现有 huilian-tasks 原样下移，不改结构
```

**筛选条取值写死，不留解释空间**（档位按真实分布 2.89–26.76GB 定）：

| 组 | 选项 | 语义 |
|---|---|---|
| 字幕 | `中字` / `全部` | 行内保留含 `中字` 徽章的版本，作品卡头恒定值不计入判定。若某规则命中的全部作品都恒定含中字，该组筛选钮**照常渲染但不改结果**（不为「无区分度的筛选」做隐藏逻辑——那会让面板形状随数据漂移，测不住） |
| 分辨率 | `2160P` / `1080P` / `全部` | 精确匹配解析后的分辨率族 |
| 体积 | `<5GB` / `5–15GB` / `>15GB` / `全部` | 用剥括号后的数值比较 |
| 排序 | `体积↓`（默认）/ `体积↑` / `版本数↓` | 作品级排序按各作品**最大**体积比较；展开后行内同序 |

### 6.2 作品横卡

```
┌ [缩略26×36] 给阿嬷的情书 · 2026            [展开 ▾]
│            Dear You · 14 个版本 · 2.89–26.76GB
│            全 2160P · 全中字 · 全国配        ← 恒定值徽章（D6）
└ 展开后：版本行 ×N + 「全部 14 / 只看前 3」
```

折叠态**不预显版本行**（未抓详情就没有版本行）；展开后默认按当前排序显示前 3 条，其余折进「全部 14」二次展开钮。

- 海报**可缺省**：直链取不到或加载失败 → 纯文字块占位（不阻塞、不重排），沿用 `source-picker.js:151` 的 `img.onerror` 退化思路。
- 海报经 `/api/proxy?url=` 取（站点直链在应用内可能被 CSP/混合内容拦，列为 §10 待真机项）。
- `workKey` = 详情页 URL（比片名稳定），用于缓存、展开态、去重。

### 6.3 徽章规则（D6：差异槽）

**恒定值上提**：某字段族在该作品**全部版本**内取值唯一且版本数 ≥2 时，从版本行移除、写进卡头一次性说明。否则不上提（例：掺一条 1080p，则分辨率退回行内）。

**行内只显差异**，族序即视觉序（左→右），不设固定槽数上限：

| 族 | 标签归一 | 真实命中（14 条唯一名） | 备注 |
|---|---|---|---|
| 动态范围 | `DV` / `HDR` / `EDR` | `杜比视界版本`2 + `DV`2 / `HDR`4 / `EDR`2 | 族内互斥，优先 DV>HDR>其他；`EDR` 语义未证实，原样显示不改写 |
| 帧率 | `60帧` | `60帧率版本`4 / `60fps`3 / `HFR`1 | 三路归一，可与 DV/HDR 共存（这正是固定四槽丢信息的原因） |
| 编码 | `H.265` / `H.264` / `AV1` | `H.265`8 + `H265`6（同物两写法） | 先去点号再匹配 |
| 码率档 | `高码` | `高码版`8 / `HQ`8 | HQ 归入高码（AI推理，待真机复核） |
| 音轨 | `2Audio` / `DDP` | `AAC2.0`8 / `2Audio`6 / `DDP2.0`2 | 复数 `2Audios` 归一 |
| 平台源 | `YK` / `iQIYI` | `YK`5 / `iQIYI`1 | 只登记已证实两家，未知大写原样，不猜 |
| 发布组 | `QuickIO`… | 4/4/3/2 | 取 `-(组名)$`，**恒末位、弱灰** |
| 字幕/配音 | `中字` / `国配` | 14/14 都命中 | 本站属恒定值 → 上提卡头；行内仅在**不全中文字幕**时才显 |

- **体积不是徽章**：`[26.76GB]` 剥括号后右对齐等宽单列，卡头给区间。
- 色阶两级：字幕族=强调色（用户要的），其余=中性灰；**不给 HDR/帧率上彩色**，避免与站点主色 `#f5c518` 抢焦点。
- 未知 token 一律**不进徽章**，只留在 tooltip（原文发布名）。防徽章随站点自造词爆炸。
- 词表实现为「族正则 + 归一映射」，映射表条目是**种子不是穷举**；样本仅 14 条且全出自一部片（`2160p`/`WEB-DL` 14/14 是样本偏差），因此 §8 的 fixture 测试锁**解析器行为**，不锁词表完整性。

### 6.4 展开状态机与限流

- `expandedWorks: Set<workKey>` 为组件内状态；重渲染保留，`unmount` 清空；一切异步回调回来后先过 `isStale(gen)` 门禁（沿用 `huilian-page.js:204` 的 `mountGen`/`isStale` 红线）。
- 抓取：首屏只抓搜索页；展开才抓该作品详情。**并发上限 2、FIFO 排队、同 workKey 会话内缓存**。防「20 个作品 = 20 并发请求」打爆代理与站点。
- 筛选生效 → 命中作品自动全展开（用户不必先点展开即可一次点击入队）；清空筛选 → 回到手风琴态。

### 6.5 窄屏退化（<420px）

卡头摘要行可截断（ellipsis），展开钮不换行不掉出视口；行内徽章超一行时先裁末位发布组，再裁平台源。

### 6.6 规则导入面板（D3 的落地面）

搜索行右侧「规则」钮 → 打开小面板（复用 `source-picker.js:372-384` 的 `openModal` 模态工具，不新造第三套模态）：

1. 已导入规则列表：`名称 · origin · 启用开关 · 删除`。删除二次确认，且**立即**影响 §5.1 的分区出现与否。
2. `从 URL 导入`：单个输入框，无默认地址（§9.1 红线）；拉取 → 按 §3.1 schema 校验 → 与同 `id` 的既有规则合并（覆盖前显示差异并确认）。
3. `粘贴 JSON`：兜底路径，同一校验函数。
4. 校验失败文案逐字：`规则格式不符：缺少 {field}。未导入任何内容。` —— 校验不通过必须**整条不落盘**，不允许部分写入。
5. **tracker 时效（调研 qbee「服务器列表」/ InFile「每日自动更新」后的取舍）**：列表行显示 `tracker {N} 条 · 导入于 {YYYY-MM-DD}`；距 `importedAt` 超过 **180 天**在行尾追加弱灰提示，文案逐字 `tracker 清单可能已失效，重新导入以提升出种率。`。**不做自动联网刷新**——那要求我们预置一个第三方清单地址，直接撞 §9.1 零内置红线。提示只读 `importedAt`，不引入定时器。

---

## 7. 状态与文案（逐字实现，不即兴）

| 触发 | 文案 | 动作 |
|---|---|---|
| 无启用磁力规则（进页面） | `未导入磁力站点规则。点搜索行的「规则」从远端一键导入。` | 只显队列区，搜索行置灰 |
| 本地代理不可用 | `本地服务未就绪，无法抓取站点。` | 重试钮 |
| 站点 4xx/5xx | `站点无响应（{status}）。稍后再试或换一个规则。` | 该分区状态点转 error + 重试 |
| 抓取超时 | `站点无响应（超时）。稍后再试或换一个规则。` | 同一模板，`{status}` 在超时路径填字面量 `超时` |
| 搜索 0 结果 | `没找到与「{title}」匹配的分享。` | 空态卡 |
| 详情解析 0 条磁力 | `这个条目里没有可用磁力链接。` | 该行折叠并标灰 |
| 入队失败 | `加入下载队列失败：{reason}` | IPC reject 统一喂提示条（沿用 `fail()`） |
| 同 btih 重复入队 | `已在队列中。` | 跳转并高亮定位，不重复入队 |
| 展开后正在抓 | `读取版本…` | 行内骨架，不整页 loading |

---

## 8. 测试策略

**fixture 必须脱敏后入库**（安全红线，见 §9.4）：

- `tests/fixtures/pomo-search-pjax.html`（作品卡结构）
- `tests/fixtures/pomo-detail-sanitized.html`（14 条发布名 + 42 条 `data-url`，btih 全替换为占位哈希，结构与文本保留）

| 测试 | 断言 |
|---|---|
| `huilian-magnet-enrich.test.js` | 42→14 去重；已有 `tr=` 不覆盖；已有 `dn=` 不覆盖；缺 `tr=` 才注入规则声明的 tracker；`[26.76GB]`→`26.76GB`+可排序数值；14 条真名的徽章族输出；恒定值归约（全 2160P/全中字成立；掺一条 1080p 则分辨率退回行内） |
| `huilian-queue.test.js`（扩既有文件） | `extractBtih`：40hex 小写归一、32 位 base32 大小写归一、缺 `xt=urn:btih:` 返回 `null`、多btih取首个；**既有两条 `matchHash` 用例（`:30-34`）必须仍然通过**；新增用例＝入队串带 3 个 `&tr=`、qbt 回吐 `magnet_uri` 只带 1 个且顺序不同 → 仍按 btih 命中同一 hash |
| `huilian-magnet-rules.test.js` | 导入 JSON → 落盘 → 读出字段不丢（证明绕开 `rule-schema.fromJson` 白名单是必要的）；`importedAt` 由导入路径写入且远端 JSON 里的同名字段被忽略；tracker 缺省时不注入；非白名单 origin 拒绝 |
| `huilian-magnet-rules-ui.test.js` | 校验不通过时整条不落盘；同 id 覆盖前要求确认；「停用」后 §5.1 的分区立即消失；`importedAt` 超 180 天才显 §6.6.5 的时效提示（未超期不显，用注入的假时钟断言） |
| `huilian-magnet-source.test.js` | `node:vm` 假 DOM + 假 http-client：search 出作品、detail 出版本；属性取 `data-url` 而非 `href` |
| `huilian-site-search.test.js` | 展开态随 `mountGen` 失效；筛选生效自动展开；unmount 清空；并发不超 2 |
| `detail-source-magnet-partition.test.js` | 无启用规则=无磁力分区；`sourceKey` 稳定；`kind:'magnet'` 候选归一字段齐全 |
| `source-picker-magnet-row.test.js` | 分组名取站点名而非落进 `CMS` 分支；徽章=「磁力」 |

**生命周期红线**：渲染只走 `el()` 构造，禁止绕过既有约定的裸 `innerHTML` 拼接（防发布名注入 DOM）；所有 IPC/网络 reject 必须经 `fail()` 上浮，不许静默。
**全量回归**：`npm test`，不得用管道吞退出码。

---

## 9. 安全与合规

1. **零内置规则**：磁力站点规则、tracker 列表一律不随包内置，只能远端导入或手动粘贴（`kazumi-bridge.js:20` 同一红线；本仓库经网盘公开分发）。
2. **凭据不外泄**：qbt 随机口令不进日志、错误信息、UI 文案（上一计划 D3 已实现，本设计不得新增打印点）。
3. **入队参数最小化**：入队只提交磁力 URL 本身（`makeAddParams` 的 `{url}` 通道），**不转发站点 Cookie / 会话头 / 任何请求头**给下载内核；tracker 只从规则清单拼进 URL，不夹带用户标识。
4. **fixture 脱敏**：仓库与安装包不得包含可直接下载的真实 btih 指纹 → 抓取件入库前必须替换哈希。
5. **magnet 注入防护**：入队前用 `extractBtih`（§3.2，**全仓唯一 btih 解析与归一实现**，去重/认领/校验都走它）取键，返回 `null` 即拒绝入队；不再在任何调用点重复写一遍长度正则。站点给的任意 `dn`/文件名按既有规则清洗 CR/LF/引号。
6. **URL 白名单**：抓取仅允许规则声明 origin；`/api/proxy?url=` 参数一律 `encodeURIComponent`。
7. **XPath 来自远端**：等于执行外部输入的查询，故规则导入必须走 schema 校验（必填字段齐、各 XPath/URL 长度上限、`searchURL` 与 `workFields.*` 的 host 必须等于声明的 `origin`、`trackers` 条数上限），并保留「停用」即时生效。

---

## 10. 未知项 / 待真机（不假装已解决）

- 搜索**分页**机制未破解 → 本设计只取首页结果（不承诺翻页）。
- `EDR` 是否 HDR10 误写；`HQ` 是否等同「高码版」——两者均按 §6.3 保守处理，待真机复核。
- 站点海报直链在应用内是否被 CSP/混合内容拦。
- 裸 btih 注入 tracker 后的**实际可播性**（依赖上一计划未做的真机冒烟：qbt CSRF / `--wid` 嵌入 / 播完判定）。
- **`matchHash` 第二路（btih 归一）是纸面推演，未经真机证明**（AI推理）。真机取证清单：同一磁力入队后，`GET /api/v2/torrents/info` 里该任务的 `url` 与 `magnet_uri` 各自长什么样、是否逐字保留我们拼进去的 `&tr=` 序列。取证前不得把「整串相等」删掉——删了会把现有直链粘贴流程一起拖下水。
- **便携版 qBittorrent 的入站连通性未知**（有来源：`collectAddFields` 与 `download-manager.js` 的启动参数里都没有端口/UPnP 设置；AI推理：NAT 后无端口 → 只能主动连出，peer 发现慢，可能与「注入了 tracker 仍然 0 种子」是同一现象的另一半）。只**读** `GET /api/v2/app/preferences` 的 `upnp`、`listen_port`、`proxy` 做取证，不写、不改配置。
- tracker 清单的**实际时效**未知（§6.6.5 的 180 天阈值是拍的，样本不足以定标）。
- 远端规则 JSON 的**托管地址需用户自备**（§9.1 红线：不预置默认源）；本设计只定 §3.1 的 schema，格式版本随 `id` 演进，导入时字段缺即报错、不做静默默认值。

---

## 11. 与上一计划的关系

`2026-09-30-huilian-bt-player-design.md` 交付的是「拿到 magnet 之后的一切」（队列、认领、mpv overlay、播控条）。本设计交付的是「magnet 从哪来 + 怎么摆」，两者在 `submitParams` 一处对接，不重开 desktop 战场。

---

## 12. 同类工具调研（2026-10-01，用户令「先看成熟项目再提建议」）

对照四款开源 BT/磁力客户端的功能清单，逐项判定「我们是否已用 / 是否该借」。

| 工具 | 与我们的关系（有来源） | 借 / 不借 |
|---|---|---|
| **qbee**（qBittorrent 增强 fork） | 我们的内核是**上游 qBittorrent 便携版 + Web API v2**（`desktop/download-manager.js:4-15`），未用该 fork | 借「tracker 清单是一等公民」的思路 → §6.6.5；**不**借防吸血/死种复活（下条） |
| **GoPID**（90MB 跨协议下载器） | 全仓零引用（grep `gopid` 无命中） | 不借。它的「浏览器扩展接管下载 / 网盘嗅探」前提是浏览器插件形态，我们是桌面 app |
| **Transmission**（极简客户端） | 全仓零引用 | 不借。文中明确它**不支持** tracker 订阅与防吸血，恰是我们不需要的形态 |
| **InFile**（MoretraC 重构） | 全仓零引用 | 借「每日更新 tracker」的**问题意识**，实现降级为时效提示；**不**借选择性下载、**不**借 DoH、**不**借 UPnP（理由见下三条） |

**判为不做的四项与理由**

1. **防吸血 / 死种复活**（qbee）：`collectAddFields:198` 我们显式 `seedingTimeLimit=0`（下完即走）。吸血惩罚的收益建立在「长期做种、依赖被做种」上，我们没有这个形态；在便携版里塞 IP 黑名单还要动 qbt 配置文件，属未验证的额外攻击面。
2. **选择性下载**（InFile）：它的语义是「只下勾上的文件」，靠的是文件级 priority；而我们入队固定 `sequentialDownload=true` + `firstLastPiecePrio=true`（`collectAddFields:199-200`），目标是**边下边播、尽早可播**，跳着下反而打断顺序流。现有 `huilian-page.js:79-105` 提供的是「下完之后**选哪个文件播**」，不是「选哪个文件下」——两者别混。故不借。
3. **DoH 抗 DNS 劫持**（InFile）：我们的网页抓取走渲染进程 → `/api/proxy` → node 侧，DNS 在 OS 层，失败已有专门文案（§7「站点无响应」）；BT 侧的解析发生在 qBittorrent 进程内，而 **qBittorrent 不暴露 DoH 开关**，我们无从注入。
4. **UPnP/NAT-PMP 端口映射**（InFile）：qbt Web API 不提供映射操作。本设计只把它列为**取证项**（§10），不做功能。
