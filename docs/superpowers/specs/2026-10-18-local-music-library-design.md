# 本地化音乐资料库（歌单/专辑/艺人）设计

- 日期：2026-10-18
- 状态：已逐节经主人确认（第1~6节）；spec 已自审，待主人最终审阅
- 范围：本窗口只做 **UI 页面 + 入口导航 + 数据缝契约**。导入×本地×源匹配的曲库引擎由并行会话（LX 音源对齐，`docs/superpowers/specs/2026-10-18-lx-source-alignment-design.md`）实施，本文第 3 节即其可直接实现的接口定义。
- 参照物：`Desktop\MineRadio-Apple-Music-Specially-Customized-Edition-2.1.0`（`public/js/modules/10-shell/06-music-library.js`、`public/css/index.css` `.mlib-*` 1693–3157）。注：主人后来提供的 `Mineradio-2.5.1` **没有**音乐资料库页，像素语言实源为 2.1.0 定制版（已报告并经确认沿用）。

## 0. 已锁世界观与决定

1. **一库三轴**：曲库底座 = 本地音频文件 ∪ 导入歌单，经匹配层合并；歌单/专辑/艺人 = 对同一底座的三种聚合视图。专辑按 albumId 归并、艺人按稳定 artistId 归组（绝不按名字字符串）、歌单=导入实体+本地自建。
2. **LX 对齐后世界观**：页面上不出现五平台/登录/源切换器任何残影；参照库的 L2 导航树、`.mlib-source-dot` 源色点、`#mlib-nav` 顶栏入口钮 **不移植**。入口 = 首页三卡（批A 已落地：PLAYLISTS/歌单、ALBUMS/专辑、ARTISTS/艺人，onclick 已摘除待本节接回）。
3. **方案 A**：一套页面骨架 × 三轴视图 × 聚合读层，**首波含二级详情**；~~详情形态 = 参照库原设计（三轴统一全屏层第二级页面）~~ **【10-26 批D 推翻】** 该「三轴统一全屏二级页」口径已被批D 作废，改为按轴分两形态：**专辑/歌单＝居中主题弹窗（`#mlib-detail-modal`，模块 `15-mlib-detail-modal.js`）；艺人＝保留全屏 hero 二级页**（左上 999px 胶囊返回钮 + 返回时滚动位置恢复）。此为参照库实态的 1:1 移植，非自创；下方 §2「二级详情」为现行口径。居中弹窗方案曾短暂圈定→作废→批D 依参照库实态重新采纳。
4. **反向改名铁律**：新命名空间 `.stella-mlib-*`；参照库青色 `rgba(0, 245, 212, …)` 辉光一律替换为 `--home-accent`。
5. 左缘悬停快捷面板（待播音乐+歌单 tab）是独立既有机制，本设计零改动。

## 1. 架构与文件落点

- `index.html`：新增单个全屏层 `<section id="music-library">`（默认隐藏），三轴网格与二级详情都在层内。
- 真相源 = body 类：`mlib-active`（显隐）/ `mlib-axis-playlists|mlib-axis-albums|mlib-axis-artists`（当前轴）/ `mlib-detail-open`（二级详情开启）/ `mlib-leaving`（离场动画）。样式只认 body 类。`mlib-active` 期间 `#empty-home` 置 `opacity:0 + pointer-events:none` 让位。
- 模块三件，全部进既有 `04-shelf` 文件夹（bundle 按文件夹分组，不新增组）：
  | 文件 | 职责 |
  |---|---|
  | `04-shelf/07-mlib-readlayer.js` | 聚合读层：归一函数、比较器、缓存/失效/seq 丢弃、空态与错误文案。不碰 DOM |
  | `04-shelf/08-mlib-page.js` | 页面状态机 + 三轴网格 + 二级详情渲染 + 封面兜底链 + payload Map |
  | `04-shelf/09-mlib-bindings.js` | 三卡 onclick→写 body 类；返回钮；ESC；播放按钮→加入队列 |
- CSS：新文件 `public/css/music-library.css`（不塞 `index.css`——壁纸会话正改它，避免第三处 lockstep）。
- `index-loader.js` 登记三个新模块路径；改模块后必跑 `npm run bundle`（产物 gitignore 不入库）。

## 2. 像素语言规格（数值实读自参照库 index.css）

**页面壳**
- 层：`position:fixed; inset:0; z-index:1`；完全透明压壁纸，无调暗层。
- 安全区变量照抄：`--mlib-safe-top:126px`、`--mlib-safe-bottom:150px`（播放器避让，注释记载 96/132 会压住最后一行）、`--mlib-fade-bottom:22px`、`--mlib-edge-feather:56px`、`--mlib-gutter:clamp(24px,3.2vw,56px)`。mask 渐隐几何与安全区**必须同源变量**（参照库注释记载过分开改导致的 bug）。
- 进入：`opacity / translateY(22px) scale(.994) / blur(10px)` → 归零，`.46s/.58s cubic-bezier(.16,1,.3,1)`；`mlib-leaving` 离场缩到 `.26s`。

**网格与卡片**
- 网格 `repeat(var(--mlib-cols,5),minmax(0,1fr))`，`container-type:inline-size`，容器查询 1080/860/620/380 → 4/3/2/1 列；艺人轴默认 6 列；gap `clamp(16px,1.8vw,26px) / clamp(14px,1.6vw,24px)`。
- 卡片本体零视觉（`border:0; background:none; box-shadow:none`）——**单圆角结构**，圆角只属于封面。
- 封面：1/1、`border-radius:18px`、底 `rgba(255,255,255,.045)`、影 `0 18px 48px rgba(0,0,0,.42)` + `inset 0 1px 0 rgba(255,255,255,.10)`；img opacity 0 → `.is-loaded` 后 `.38s ease` 淡入；加载前 ::after 微光 `1.6s linear` 扫动。
- hover：整卡 `translateY(-4px)`（**不 scale**）`.22s cubic-bezier(.16,1,.3,1)`；封面辉光第二层用 `--home-accent` 替代青色。触屏分支 `html:not(.stella-mlib-has-hover)`：整封面可点即播、播放钮隐藏（参照库双模机制照移植）。
- 播放钮 44×44、`backdrop-filter blur(20px) saturate(1.2)`、绝对定位不占布局。
- 艺人头像：强制 `border-radius:50%`；三级兜底=代表图→名称首字母→音乐图标，**绝不用专辑封面冒充**。
- 文字：卡标题 14px/620 单行 ellipsis；副 11.5px `rgba(255,255,255,.60)`；eyebrow 10.5px/800/.18em 大写 `.42`；页标题 `clamp(30px,3.4vw,44px)`/700。
- payload：卡数据存 `Map<element, card>`，DOM 只放 `data-mlib-id`。

**二级详情（10-26 批D：按轴分两形态，非三轴统一全屏）**
- **形态闸**＝body 类组合：`body.mlib-detail-open.mlib-axis-artists #mlib-view-detail{display:block}`（艺人铺全屏），专辑/歌单轴下 `#mlib-view-detail{display:none}`（文末弹窗段配套闸，特异度 (1,2,1) 压过泛轴旧闸）；专辑/歌单走 `#mlib-detail-modal.modal-mask.show > .modal.stella-mlib-modal` 居中弹窗。页面分派在 `08-mlib-page.js`（`tracksHost(form)` 决定行落地容器），弹窗窗口/信息区在 `15-mlib-detail-modal.js`，绑定在 `09-mlib-bindings.js`。
  **闸的对照实测（10-26 批D evidence round 2，同一枚 fixture `tests/fixtures/mlib-detail-probe-ours.html` 只切 body 轴类，`--window-size=1920,1000`）**：`mlib-active mlib-axis-artists mlib-detail-open` → `#mlib-view-detail`=**1784×238**（被 `music-library.css:725` 那条铺回来）；同一 body 去掉 `mlib-detail-open` → 回到 **0×0**（:725 不再命中，回落 :467 基座）；`mlib-axis-albums`／`mlib-axis-playlists` 带 `mlib-detail-open` → **0×0**（:726-727 与基座同向）。注：**专辑/歌单轴那两档 0×0 的属主是 :467 的无条件 `display:none`**，去掉 :726-727 也照读 0×0——这一档只防「有人把基座改成范围过宽的 `display:block`」，不证按轴闸；按轴闸的证据是上面 artists 档那一对（同带 `mlib-detail-open`，只有轴类不同 → 1784×238 vs 0×0）。
- **弹窗度量**（离屏 Edge `--dump-dom` 实测，非读 CSS；同一 `--window-size` 与参照库逐位对齐，见批D 台账。**口径声明**：量的 `tests/fixtures/mlib-detail-probe-ours.html` 里那棵弹窗子树是 `index.html` 的**手工副本**，不是应用运行时 DOM——两侧 **id 集合**由 `tests/mlib-detail-modal-css.test.js` 末条「夹具与生产的弹窗 id 集合同构（只钉 id，class/嵌套不在射程）」钉住（生产改名／新增弹窗节点而副本没跟上即红；class、嵌套层级与夹具里的手写文案不在射程），副本故意不搬的只有生产带 `hidden` 的布局中性三枚（`-desc`／`-desc-toggle`／`-status`）；因此这组数字是「同一份 CSS 作用在这棵子树上」的实测，不覆盖运行时 JS 改写 DOM 后的形态）：面板 `width:min(1080px,calc(100vw-56px))!important` → 窗口 ≥1136 时 modal=**1080** 居中（`@L=(innerWidth-1080)/2`，实测 1896→@L408、1176→@L48），窗口收窄按 `100vw-56` 收（876→modal **820**、@L28，与参照库 876→820 同值）；`--window-size=924` 让 innerWidth 正好落 **900** ⇒ modal=**844**@L28、`100vw−56=844` 为**实测**（evidence round 2 补的这一刀，此前只由 876→820 反推），参照库同档同跑亦 **844**；封面 **268×268**；曲目行 **1026×52**；曲名列 **587×20**（窄屏 766/404 与参照库同步降）。`.stella-mlib-modal-scroll` 是唯一滚动容器，底栏 `.stella-mlib-modal-foot`（关闭钮）随整窗固定不随内容滚。随机钮 `.stella-mlib-shuffle-btn` 仅歌单轴可见（歌单轴 fixture 实测 shuffle=**44×44**@L861 可见；`music-library.css:674-675` 定寸），专辑轴 `body.mlib-axis-albums … {display:none}`（:696，实测 shuffle=0×0）。**口径精确化**：:696 那条只点名专辑轴，故 fixture 在艺人轴切片上钮仍读 44×44——艺人轴用户看不到它，是因为 08 的 `detailForm` 根本不给艺人轴开这扇弹窗（分派层保证，不是 CSS 保证）。整单钮 `.stella-mlib-modal-play` 补上 `index.html:375` 那颗 18×18 SVG 后实测 **122×44**（此前 fixture 缺 SVG 读到 95×44，属 fixture 私有度量、非验收项）。
- **艺人全屏**（保留旧形态）：同滚动容器第二级视图 + 左上 999px 胶囊返回钮（参照库 `.mlib-artist-back`，`index.css:2942`）；进入详情记录网格滚动位置、返回时恢复（参照库 `06-music-library.js:1015`）。头部=大封面/头像 + eyebrow + 页标题 + `head-meta`；下接曲目列表行。hero 几何 1:1 参照库 `.mlib-artist-hero`（`index.css:2969-3010`）：图块 `clamp(96px,11vw,148px)`（实测 hero **148×148**）、`gap clamp(18px,2.4vw,30px)`、下边距 `clamp(24px,3vw,38px)`、文案侧 `min-width:0`；≤860px 转竖排（同参照库 `index.css:3111-3114`）。
- hero/封面图块按轴别取形：艺人＝圆形头像层（`.stella-mlib-artist-art`），沿用网格三级兜底链（代表图→首字母→音乐图标），**引擎给的 `entity.cover` 是首轨专辑封面，艺人轴绝不吃它**；弹窗封面＝方形（`.stella-mlib-modal-cover` 圆角 18px、`aspect-ratio:1/1`），URL 取 `entity.cover`，取色链见 15 模块。
- **一份行模板两处落**：曲目行的唯一属主是 08 的 `buildTrackRow`（弹窗与全屏共用，`.stella-mlib-track` 五列），15 模块禁止再构建行；两形态只换落地容器，不换行结构。

**布局列（10-26 批C 实测补记）**
- 内容列：`#mlib-grid-wrap` = `max-width:1240px; margin:0 auto`（参照库 `.mlib-section` 同值）。不收这一刀时宽窗口铺满 1784px、专辑卡 338px，且与页头/状态盒/详情头/曲目表的 1240 列错位（实测 1896 窗口左缘 56 vs 328）。
- 列数降级写在轴默认值**之后**且必须带 `body.mlib-axis-` 前缀，否则 (1,0,0) 压不过 (1,1,1) 的轴默认值成为死规则。口径按参照库实测：艺人 6→4(≤1080)→3(≤860)、歌单 5→3(≤860)、专辑恒 5（参照库专辑轴无任何降级档，1:1 不擅自加）；≤620 全轴 2 列、≤380 单列（参照库那套 `@container` 因「容器不能查询自身」从不生效，本仓把上下文挪到包裹层后才真正兑现其意图）。

## 3. 数据缝契约（并行会话照此实现）

挂载点 `window.stellaMlibSeam`，全部 async：

| 方法 | 返回 |
|---|---|
| `getLibraryStats()` | `{ ready, rev, error }` 廉价探针 |
| `getTracks()` | `{ tracks, rev, error }` 已合并去重曲目（本地 ∪ 导入×匹配在缝内完成） |
| `getPlaylists()` | `{ playlists, rev, error }` 歌单实体，含 trackIds |
| `getArtistDetail(id)` / `getAlbumDetail(id)` / `getPlaylistDetail(id)` | `{ entity, tracks, error }` |
| `subscribe(fn)` | unsubscribe；数据变更（导入完成/删曲/引擎就绪）通知 |

- 曲目最小字段：`{ id, name, artist, artistId, album, albumId, cover, duration, source:'local-file'|'imported', localKey, localUrl, localFile, matched }`。
- 本地优先的兑现条件（10-25 措辞更正，原文「`localFile` 有值播放走本地优先」过度承诺了 UI 侧做不到的事）：**播放地址只能来自缝给的 `localUrl`**，页面绝不从路径串合成 scheme。`localUrl` 有值 ⇒ 命中播放层本地分支（`13-playback-start-audio.js:1121` 判 `type==='local' || source==='local' || localUrl`，起播的 `playLocalQueueSong` 只认 `song.localUrl`）；缝没给 ⇒ 该轨按在线轨走既有换源，不是"页面替它造一个本地地址"。`localFile` 是**身份字段**，读层只用它兜 `localKey`（队列 `local:` 身份由 `localKey` 决定），不参与播放判定。
- `matched:false` 的曲目照常显示与聚合，单曲播放钮置灰，整张播放跳过。
- 稳定 id 不变量：无 albumId 的曲目不进专辑轴；artistId 由缝/匹配层负责补出，UI 侧绝不从名字推导 id。
- 排序归读层：缝返回顺序 UI 不解释。
- 失效与并发：`rev` 变化→读层缓存整体作废；`requestedSeq` 晚到旧响应丢弃（参照库切源隔离三件套去掉源维度，保留骨架清空+in-flight discard）。
- 错误口径：缝返回 `{ error:{ code, message } }`，UI 如实渲染 message；**UI 不重试**，重试只由空态「重试」钮手动触发一次，自动重试策略归板B。
- 缝未挂载：页面可开，走「引擎未就绪」空态，不轮询、不报错刷屏。

## 4. 聚合读层与比较器

- IIFE 挂 `window.stellaMlibRead`；纯函数、vm 可测。缝缺方法/未挂载/error → 空集+状态标记，绝不 throw。
- 归一：`albumsFromTracks(tracks)`（按 albumId；代表封面=任一带封面曲目；count）、`artistsFromTracks(tracks)`（按 artistId；代表图三级兜底标记）、`playlistsFrom(playlists)` 直接映射。卡统一形状 `{ id, title, sub, cover, count, sortKey, playable }`，三轴共用一个网格渲染器。
- 详情实体最小字段：`{ id, title, sub, cover, count, meta:{ releaseYear } }`——`cover` 供详情头 hero 图块（见 §2），`sub` 供 eyebrow，艺人不给 `sub`/不给头像时页面按既有链路留空与首字母兜底。缝若返回扁平形状，读层在缝边界合成这五个字段（唯一兼容点，页面层只认 `entity`）。
- **`entity.description` 可选（10-26 批D 补）**：`entity` 可再带一个 `description` 字符串，弹窗信息区据此渲染折叠简介块（默认 clamp 三行 + 「展开简介」钮，见 15 `renderInfo`）。**缝不给（或空串）就整块 `hidden`、不渲染，读层与页面都不合成、不占位、不造文案**——`description` 不在这批「缝边界合成五字段」的兼容点里，它只能来自缝的真实返回。（引擎侧目前不产 `description`，故歌单/专辑弹窗常态无简介块。）
- 比较器：专辑=发行年降序、无年份沉底按标题；艺人=拉丁 A–Z、中文按拼音首字母、数字/符号归「其他」+跨整行分界条（参照库 `.mlib-artist-divider` 机制）；歌单=加入时间。**中文判档=首字符 CJK Unicode 区间检测；拼音 key 由缝侧预计算（`sortKeyPinyin` 字段），读层缺失时退化为「其他」组——不引第三方分词库**。`sortKey` 每实体预计算一次，比较器只做字段比较，localeCompare 不进热路径。
- 缓存：每轴 `{ rev, data, fetchedAt }`，rev 相同即命中；subscribe/探针发现 rev 变化→三轴+详情缓存全废；详情缓存=Map by id；同轴并发请求复用同一 promise。
- 首波不做虚拟列表（百~几千卡一次渲染；实测卡再立专项）。

## 5. 状态与空态文案表

原则：诚实空态，文案是事实陈述。空态盒 22px 圆角（参照库 state-box）。文案由读层给出，页面只显示。

| 状态 | 触发 | 文案 | 动作 |
|---|---|---|---|
| 引擎未挂载 | seam 缺 | 「曲库引擎尚未就绪 · 导入歌单或本地音乐后这里会自动出现」 | 等 subscribe，不轮询 |
| 曲库为空 | tracks+playlists 均空 | 「曲库还是空的 · 从首页「导入」卡片开始」 | 「去导入」钮→唤起既有导入弹窗 |
| 轴为空 | 曲库非空但该轴无数据 | 「这个板块还没有内容 · 专辑按曲库里的专辑信息归组，导入匹配后自动出现」（按轴措辞微调） | 无按钮 |
| 读取失败 | 缝 error | 直接显示 error.message | 「重试」钮手动 fetch 一次 |
| 详情失败 | detail error | 头部照常、列表区错误盒 | 同上 |
| 单曲不可播 | matched:false | 播放钮置灰 + title「未匹配到可播来源」 | 整张播放自动跳过 |

Shell 边界：ESC 两级（详情→网格→关闭回 Home）；播放器条全程可见（safe-bottom 150px）；资料库仅音乐态可达；与 `home-snapshot` 恢复链零冲突（三卡静态 onclick 为空，恢复即无 onclick）。

## 6. 测试策略（node:test + vm，TDD 先红后绿）

1. 读层单测：albumsFromTracks「无 albumId 不进轴」、artistsFromTracks 同 id 异名不并/同名异 id 不并、sortKey 与「其他」分组、rev 失效、seq 丢弃、并发 promise 复用。
2. fake seam 契约测试：桩 `window.stellaMlibSeam` 驱动页面模块，断言空态表全分支、卡对象→DOM、payload 不进 DOM 属性、body 类真相源。
3. CSS token 契约（文本断言）：断点 1080/860/620/380；圆角 18/50%/22/999px；`translateY(-4px)`；`rgba(0, 245, 212` 零出现；`.stella-mlib-` 前缀。
4. 入口绑定契约：三卡→三轴映射、ESC 两级、`video-home-collapsed` 下不响应。
5. 回归：`npm run bundle` 重打 + `npm test` 全量。

## 7. 验证与真机冒烟清单（实现完成后交主人）

- 三卡点击分别进歌单/专辑/艺人网格页；返回钮与 ESC 两级退出。
- 透明压壁纸 + mask 渐隐观感；播放器条不被内容压住。
- hover 动画只位移不缩放；播放钮毛玻璃。
- 空态文案与「去导入」按钮；假数据详情曲数正确。
- 左缘悬停快捷面板零回归；影视↔音乐切态不干扰资料库层。

## 8. 越界声明（本窗口不做）

- 不做导入/匹配/源引擎（板B）；不做五平台相关任何代码；不做「给你看的」第四板块（口误已澄清）；不做虚拟滚动；不改左缘面板机制；不动 Apple 凭证链/UIA 播放（参照库该两块整体不移植）。
