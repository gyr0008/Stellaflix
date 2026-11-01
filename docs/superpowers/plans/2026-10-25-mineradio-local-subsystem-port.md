# Mineradio 本地音乐子系统移植计划（seam 引擎·本地半区）

- 日期：2026-10-25
- 状态：待主人交令 → 由 **LX 音源对齐会话**（`docs/superpowers/specs/2026-10-18-lx-source-alignment-design.md`）按 spec 原分工实施
- 素材库：`Desktop\Mineradio-2.5.1`（引擎与通道素材）；门面=已完成的 mlib 三轴资料库页（`04-shelf/07-09-mlib-*`，本计划零改动，只喂插座）
- 口径：1:1 = 整条垂直切片照搬参照库代码与行为；仅门牌号（channel/键/路径）换 `stellaflix-` 前缀；架构冲突处均已由主人拍板（见下）

## 0. 已拍板决定（10-25）

| # | 决定 | 内容 |
|---|---|---|
| 2A | 媒体通道 | 采用参照库本机 HTTP 代理（`/api/local-file` + token + authorizer 缺省全拒 + Range + APE/DSD 转码），**删除**我方 `stellaflix-local://` 自定义协议层 |
| 3 | 前缀 | IPC channel、localStorage 键、磁盘文件名统一 `mineradio-` → `stellaflix-`；函数/变量名保持参照库原样（inline onclick 契约） |
| 4 | 账本 | **单层 SQLite**（`node:sqlite` 已在 Electron 42.4.1 / Node 24.16.0 实测通过，`.scratch/sqlite-probe`）；参照库 IndexedDB `mineradio-local-assets-v1` 回落层**不搬**；保留 `probeLocalLibraryDb` 一次性降级探测代码路径（1:1 自带） |
| 5B | ReplayGain | 第一批顺搬（标签解析 → WebAudio 增益节点链） |
| 6 | 归属 | seam 引擎（本地半区=本计划 + 在线半区=LX 导入池 + 桥=匹配层）归 LX 音源对齐会话；mlib 保留为门面 |
| — | mlib | 三轴页面/读层/绑定/CSS 零改动；专辑/艺人聚合归 mlib 读层，**参照库的分类/维护面板 UI 不搬** |
| 7（10-25 追加） | ③④ 收编裁定 | **③ 收藏标记 +「特别喜欢」智能歌单＝收编**（本地歌现在点不了红心，是真缺口）；**④ 统计随整机备份＝不搬**（我方无备份体系，且它天生只罩本地半区；等批1-3 落地后再议） |

## 1. 批次划分（垂直切片，每批 npm test 全绿 + npm run bundle）

### 批1 数据层（整文件直搬，~1700 行）
| 动作 | 文件 | 来源/去向 |
|---|---|---|
| 直搬 | `desktop/local-library-store.js` | 参照库同名文件 1313 行：`node:sqlite`、library.db 7 表（meta/roots/dirs/files/song_stats/assets/lyrics）、指纹复用、分批事务、LRU trim |
| 直搬 ✅ | `desktop/local-library-watcher.js` | 373 行：防抖 900ms/4500ms 双阀、512 路径溢出转整根、指数退避、父子目录去重。**10-25 已完成**，与参照库逐字节一致（md5 `5be08d…489b3`） |
| 随迁测试 ✅ | `tests/local-library-sqlite-store.test.js`(711)、`local-library-watcher.test.js`(357，**19/19 绿**) | 改路径与 `mineradio-`→`stellaflix-` 字面量 |
| 随迁测试 ⏸ 推迟到批2 | `local-library-watch-wiring.test.js`(87) | 它断言的是 **main.js/preload 接线**（`LOCAL_LIBRARY_EXTS`、`applyLocalLibraryWatchRoots`、`closeLocalLibraryWatcher()` 必须排在 `closeLocalLibraryStore()` 之前、preload 三件套），这些都属于批2；**批1 阶段随迁必然红**，故推迟。批2 落地时一并迁入并把 channel 改成 `stellaflix-local-library-watch-*` |

### 批2 主进程扫描/授权/IPC + HTTP 通道（抽取切片，~1500 行）
| 动作 | 内容 | 参照库坐标 |
|---|---|---|
| 抽取→`main.js` | 扩展名/MIME 表（17 音频+11 歌词+9 封面）L400-457；全量/增量目录扫描 L463-776；授权根 `authorizedLocalMusicRoots`+`resolveAuthorizedLocalFile` L213/483-495；store 生命周期胶水 L863-1067；watcher 接线 L1069-1182；range/data-url 读取 L1184-1240；22 个 IPC handler L4846-4987（channel 改前缀）；server 启动注入 authorizer+token L5643-5669 | desktop/main.js |
| 抽取→`server.js` | `/api/local-file` 路由 L3295-3372（token 比对、authorizer 缺省 403、Range 206/416、`raw=1`、转码接线）；`parseLocalFileRange` L168-170；`setLocalFileAuthorizer` 导出 L3408。⚠️ **不得带走** server.js L18-20 硬编码翻译端点/密钥 | server.js |
| 直搬 | `desktop/audio/ape-decoder.js`(1511)、`dsf-decoder.js`(322)、`wav-stream.js`(413) | APE/DSD 实时转 WAV，无 ffmpeg |
| 抽取→`preload.js` | 27 个本地曲库 API（L76-107）+ `PERSISTENT_UI_STATE_KEYS` sendSync 回填通道（L18-26、L39-43，键改前缀；顺带是端口漂移桶病的解药） | preload.js |
| 删除（我方） | `desktop/local-music-library.js`(757 整删)；main.js L20-22/L39/L160-161/L4526-4614/L6772-6776；preload.js L42-64；`stellaflix-local` scheme 注册 | 旧协议+JSON 索引层 |
| 迁移器 | 新增一次性脚本：旧 `local-music-library.json` 导入清单 → 合成临时根（或直接提示重选文件夹，二选一在批2 设计节定） | 存量用户 |
| 随迁测试 | `local-file-proxy-authorization`(107)、`local-file-range-memory`(224)、`local-library-deep-scan`(58)、`local-library-incremental-truncation`(126)、`local-library-multi-root`(190)、`local-m4a-support`(301)、`local-media-format-support`(301) | |
| 删除测试（我方） | `local-music-library-persistence.test.js`（+`_1` 双拷贝）、`local-library-view.test.js` 中旧协议断言段 | |

### 批3 渲染层引擎（app.js 切片提取 → `modules/04-shelf/` 新文件，~8000 行）
| 块 | 参照库 app.js 坐标 | 体量 |
|---|---|---|
| 自研标签解析器（ID3/FLAC/M4A/OGG/WAV/APE/DSF + ReplayGain 标签 + range 合并读） | L33833-36700 | ~2900 |
| 扫描记录→曲目对象/文件映射/歌词封面配对 | L32925-33420 | ~500 |
| 资产/歌词/封面缓存 + SQLite 桥（IDB 回落段剔除） | L8326-9730 | ~1000（剔 ~400） |
| 文件夹持久化/快照/索引水合 | L36726-37990 | ~1270 |
| watcher 自动同步/adopt 播中保护 | L38073-38650 | ~580 |
| 播放桥（ensureLocalSongUrl 三级兜底→改两级：代理 URL→createObjectURL；失败处理；会话恢复） | L28363-29000 | ~650 |
| 本地搜索（池+预热+结果缓存） | L24517-24800 | ~500 |
| ReplayGain 链（analyser→gain→input 节点、惰性补齐） | L24908-24926、L26403-26560 | ~200 |
| 鼓点驻留/打包（与现有 `03-beat` 融合：保留我方 beatmap 服务端键与 D 盘目录策略，参照库仅补驻留保护差集） | L13450-16130 | 差集 |
| 随迁测试 | `local-format-tag-parsing`(1196)、`local-tag-range-read-coalescing`(623)、`local-metadata-cache-version`(285)、`local-lyric-cache-residency`(1024)、`local-cover-*` 3 件、`local-media-object-url-*` 2 件、`local-search-cache`(207)、`local-library-db-bridge`(335)、`local-library-persistent-memory`(144)、`local-library-background-*` 2 件、`local-asset-cache-*` 2 件、`local-cache-memory-hot-path`(101)、`indexeddb-transaction-abort-settlement`(181，若 IDB 层剔除则同步不搬) | |

**不搬清单（渲染层）**：`#playlist-panel` 三 tab 面板、分类/维护面板（L21015-22100）、播放源选择器 UI、备份系统（❹，10-25 裁定不搬）、`local-only-mode` 总闸（index.html L2/L34 + app.css L155-167、L1173-1179）、folia-host 交叉 7 处。
> 注：原列在此处的「特别 liked」已按 10-25 裁定**移出**不搬清单，另立 §1 批4「❸ 特别喜欢」一节；但它依赖的参照库 UI 宿主（分类/维护面板 L22313 入口、`#playlist-panel` 卡片 L31864、详情页 L22410-22490）**仍不搬**，UI 宿主需另定（见该节）。

### 批4 seam 接线（新写胶水，~600 行，LX 会话主场）
- `window.stellaMlibSeam` 六方法实现：`getTracks()` = 本地引擎曲目 ∪ LX 导入池曲目（缝内合并去重）；`getPlaylists()` = 导入实体 + `localPlaylistStore` 自建；`getArtistDetail/getAlbumDetail/getPlaylistDetail`；`getLibraryStats`；`subscribe`（mlib F1 通知在途竞态已修，按现契约接）
- 曲目最小字段补齐：`artistId/albumId` 稳定 id 由匹配层产出（spec 铁律：UI 绝不从名字推导）；`source:'local-file'|'imported'`；`matched` 标记
- 03c 在线匹配缓存重接到新指纹（`pathKey|size|mtime`），合并计数读取侧（09-18 口径）保持
- **播放统计升级（10-25 主人指令，照搬参照库设计）**：
  - 本地歌统计双写 SQLite `song_stats`：照搬 `syncLocalLibraryDbPlayStat`（app.js:8907，"song_stats 按 song_key 独立存活"）+ `bumpPlayStat/readStats` 接线；localStorage `listenStatsState` 仍是在线曲目与 UI 的主账，SQLite 为本地歌持久副本（桶丢失后统计可复活）
  - 两档清空历史弹窗：照搬 `listen-history-clear` 模态+语义（app.js:20940-21037：「只清最近播放」保留次数/时长，「全部清空」连次数/时长/断点归零，均不删文件）+ 随迁 `listen-history-clear.test.js`(404)
  - 口径红线：09-18 合并计数（本地键 completed + 匹配在线键 completed）保留在读取侧，SQLite 双写只覆盖本地键一半，不得引入参照库 local-only 直读口径
  - 详情弹窗五行统计段两边已逐字同构（我方 06-track-detail vs app.js:20758 `songListenStatDetailHtml`），展示层零改动
- **❸ 收藏标记 +「特别喜欢」智能歌单（10-25 主人裁定收编）**：
  - 数据层**已随 store 整搬到位、无需再搬**：`song_stats.favorite/favorite_at` 列（store L315-316）、`idx_stats_favorite` 索引（L350）、`setFavorite`（L1031-1055）、`readStats` 返 favorite（L1072/L1109）。
  - 待补四件套：
    | 层 | 动作 | 坐标 |
    |---|---|---|
    | IPC | 新增 `stellaflix-local-library-db-set-favorite`（沿用 `withLocalLibraryStore` + `isTrustedMainWindowIpc`） | 参照 `main.js:4967`；落我方 main.js L4790 旁同形 |
    | preload | `setLocalLibraryDbFavorite`，方法名保持参照库原样 | 参照 `preload.js:96`；落我方 preload.js L67 旁 |
    | 渲染层 | 新模块 `public/js/modules/05-playback/21-local-special-liked.js`：`specialLikedSongPath/Key/Ref/compact*/read/write/index/isSpecialLikedSong/getSpecialLikedSongs/toggleSpecialLikedSong` + SQLite 镜像 `syncLocalLibraryDbFavorite` 照搬 | 参照 `app.js:23821-23966`、`app.js:8930-8941` |
    | 接线 | `06-track-detail-lyrics-actions.js:1290 isSongLiked` / `:1418 toggleLikeSong` 加本地分支；`:1284` 那句「本地文件暂不支持同步…红心」随之作废 | 参照 `app.js:23967-23970` 双分支（本地→特别喜欢表，非本地→平台红心） |
  - 存储口径照搬：**localStorage 引用表是唯一权威**，SQLite `favorite` 只作持久镜像（参照注释 `app.js:8924-8929`）；键名 `mineradio-special-liked-playlist-v1` → **`stellaflix-special-liked-playlist-v1`**。
  - ❸a / ❸b 分工（依 §2.1 Q2=A）：**❸a = IPC + preload + `21-local-special-liked.js` 存储层 + `isSongLiked/toggleLikeSong` 本地分支**（可独立开工，不依赖批3/批4）；**❸b = 「特别喜欢」列表卡片/详情页**（随 UI 宿主定，走 mlib seam 或现有面板，届时单独立项）。
  - UI 宿主另定：参照库三处宿主（分类 tab 入口 `app.js:22313`、`#playlist-panel` 卡片 `:31864`、详情页 `:22410-22490`）全在不搬清单 → **宿主必须我们自己给**，见 §2.1（已裁定走 A，列表入口推迟）。
  - 双收增量（依 §2.1 Q1=B）：在线歌引用键复用 `songAccountStateKey`（`06-track-detail-lyrics-actions.js:1258-1262`）；本地歌键沿用参照库 `local-key:` / `local-path:` / `local-meta:` 三级兜底（`app.js:23826-23832`）。**参照库那条「只支持本地音乐」的拦截（`:23949`）须剔除。**
  - 随迁测试：`tests/special-liked-playlist.test.js`(368)。它是按 marker 从 app.js 切函数源进 vm 跑的（文件头 12-40 行），迁移时改成从 `21-local-special-liked.js` 切同一段 marker 区间。
  - 红线：① 不得把本地红心写成第二个 `likedSongMap`（现有那个是在线平台口径，按 provider:id）；② 不得让 SQLite 反过来当权威——否则清过 localStorage 会出现「界面显示没收藏、库里还有 favorite」的鬼影。
- 保留勿删：`03b-local-playlist-store.js`（平台歌单导入/收藏弹窗共用）、`12-playback-switch-core.js`/`13-playback-start-audio.js` 的 `localUrl` 分支（Subsonic 共用；URL 生成改调 `/api/local-file`）、`05-home-actions.js` 最近播放回解析

### 批5 收编与回归
- 首页：`03a-home-dashboard.js` 本地条带数据源改读新引擎（UI 不动）；`04-home-empty-wallpaper.js`/`05-upload-dragdrop.js` 导入入口改走 `chooseLocalMusicFolder`/watch 根添加流；空态磁贴 local 动作接 seam
- `npm run bundle` + `tests/bundle-modules.test.js` 计数更新；`_1.*` 是 gitignore 里的历史快照副本（bundle 与构建都排除），**不需要**跟着新建/同步
- 全量 `npm test`（当前基线 223/223 + mlib 172 项 + 随迁 ~40 文件，以「除别家 untracked 外全绿」为准）
- 真机冒烟清单：选文件夹→扫描进度→播放(APE/FLAC 各一)→断网续播→改目录文件 watcher 自动同步→切在线音质→重启后库自恢复→mlib 三轴出现本地/导入曲目→影视态零回归

## 2. 风险与红线
1. **安全**：authorizer 缺省必须全拒（随迁 `local-file-proxy-authorization` 守住）；token 不落 localStorage 明文以外路径；不得带入参照库硬编码密钥。
2. **并发**：`main.js`/`preload.js`/`index.html`/`03a` 是多会话共享面，按 hunk 核对提交；严禁 `git stash -u`。
3. **数据桶**：换通道不改 origin 语义；`ui-state-read-sync` 回填键白名单与现有桶迁移（video-data-vault）互不冲突，但批2 需实测 :3000↔QA 端口下曲库与统计不漂移。
4. **beatmap**：临时目录沿用 D 盘策略（C 盘拒绝），勿引参照库 `D:\MineradioCache` 字面量。
5. 体量 ~19-21k 行，按批推进，每批可独立回滚；批内不掺其他会话改动。

### 2.1 ❸ 的两个岔路（10-25 已拍板）

- **Q1 收录范围 → 裁定 B「双收」**：本地歌 + 导入歌单里的在线歌都能进「特别喜欢」（打破参照库 `app.js:23949`「只支持本地音乐」的限制，属双池产品的自研增量）。
  - 由此确定的落地设计：在线歌引用键复用我方既有 `songAccountStateKey(song)`（`06-track-detail-lyrics-actions.js:1258-1262`，形如 `netease:123456`），**不另发明第二套身份键**。
  - 点心时：已登录平台的在线歌**保持现有行为**（走 `toggleLikeSong` 写回平台 + `likedSongMap` 缓存），本地表同步记一条引用；本地歌与未登录/写回失败的在线歌**只写本地表**。
  - 「特别喜欢」列表 = 本地引用表（权威）里所有条目；在线且已登录的歌以平台红心态为准，两边取并集去重。
- **Q2 UI 宿主 → 裁定 A「存算先行」**：先做存储层 + 本地红心按钮（能点心、能持久化），**不动任何列表 UI**；列表入口待宿主（mlib seam / 现有面板）定了一起接，避免返工。
  - 因此 ❸ 拆成 **❸a（可立即开工，独立于批3/批4）** 与 **❸b（列表入口，随宿主批走）** 两截。

## 3. 进度台账

### 3.0 拍板台账追加（10-25 下午）
- 主人裁定「③要」→ ❸ 收藏标记 +「特别喜欢」从不搬清单移出，写入 §1 批4；❹ 备份维持不搬（原因：我方无备份体系、且只罩本地半区）。
- 由此开出两个岔路 Q1（收录范围）/ Q2（UI 宿主），**已当场拍板**：
Q1 = **B 双收**（本地 + 导入歌单里的在线歌；在线歌复用 `songAccountStateKey` 作引用键；剔除参照库「只支持本地音乐」的拦截）；
Q2 = **A 存算先行**（先做存储层 + 本地红心按钮，列表入口推迟到 UI 宿主确定后再接）。
→ ❸ 据此拆成 **❸a（可立即开工，不依赖批3/批4）** 与 **❸b（列表入口待定）**。

### 3.1 「统计 SQL 与数据模型先行」切片已落地（10-25 主人指令，未提交）
主人指令把批4 的播放统计部分提到最前，本切片只动统计垂直链路，不掺扫描/HTTP 通道/引擎。

- `desktop/local-library-store.js`＝参照库同名文件整文件直搬（1313 行，零品牌字面量，7 表 + `song_stats` 语义与组合索引教训全保留）。随迁 `tests/local-library-sqlite-store.test.js`（仅临时目录前缀改 `stellaflix-`），18/18。
- 主进程：`getLocalLibraryStore`/`closeLocalLibraryStore`/`withLocalLibraryStore` 照搬语义（库文件落 `app.getPath('userData')`，与既有 `local-music-library.json` 同目录）；通道 2 条 `stellaflix-local-library-db-status` / `-bump-play`，沿用我方 `isTrustedMainWindowIpc` 信任闸；`before-quit` 里收 WAL。
- `desktop/preload.js`：`localLibraryDbStatus` / `bumpLocalLibraryDbPlayStat` 两个方法名保持参照库原样。
- 渲染层：新模块 `public/js/modules/05-playback/20-local-library-db-bridge.js`（api/probe/active/call + 路径键归一 + `syncLocalLibraryDbPlayStat`，逐条照 app.js:8790-8920 语义）；`02-listen-stats.js` 的 `listenSongSnapshot` 补 `localKey`/`pathKey`，`finalizeListenSession` 在 `if (!effective) return;` 门后落库一次。
- `desktop/local-music-library.js` `serializeRecord` 只加三个字段（`localFilePathAbsolute`/`localFileSize`/`localFileLastModified`），`localKey` 仍是 24 位 id——既有消费方（节拍缓存、歌单、队列键）语义未动。
- 一处有意偏差（须记档）：SQLite 行键由 `localLibraryDbSongKeyFromSong()` 现算成参照库形状 `绝对路径:大小:修改时间`，而不是直接读 `song.localKey`（我方现值是 sha24 id）。这样批3 引擎接管后键值天然一致，统计行不用搬家；届时该 helper 可退化为读 `localKey`。拿不到绝对路径的临时拖入曲目不发 IPC（宁缺勿孤儿行）。
- 后置未做（按功能批走，不做无人调用的通道）：`-clear-play`（② 两档清空弹窗，我方尚无听歌统计页入口）、`-read-stats`（读侧仍以 `listenStatsState` 为权威，09-18 合并计数口径未动）、`-trim`/assets/lyrics 通道（批2/批3）、`-restore-stats`（❹ 备份，10-25 裁定不搬）。
- `-set-favorite`：❸ 收编后**已于 §3.3 落地**（❸a），不再属于"无人调用"。
- 验证：`npm test` 228/228；`npm run bundle` 118 模块（`tests/bundle-modules.test.js` 计数 117→118）；跨层工装实测（渲染层载荷 → `bumpPlayStat` → `song_stats` 行，plays 累加、`last_played_at` 取 MAX）在系统 Node 24.16 与 Electron 42 内置 Node 双跑通过。
- 生效条件：主进程与 preload 改动需重启桌面应用；重启后听本地歌 → `userData/library.db` 的 `song_stats` 应出现以绝对路径为键的行。

### 3.2 批1 收尾切片「local-library-watcher」已落地（10-25 主人指令，未提交）

- `desktop/local-library-watcher.js` ＝ 参照库同名文件**逐字节直搬**（373 行，md5 `5be08d3023dc0b14d81d287f58b489b3`，`diff` 与参照库为空、零品牌字面量）。内容：防抖 900ms / 最长等待 4500ms 双阀门、512 条路径溢出转整根粗粒度、指数退避重连（5s→60s 封顶）、递归优先失败降级单层、父子目录去重（按分隔符边界，`Music2` 不被 `Music` 吞）。
- 随迁 `tests/local-library-watcher.test.js`（357 行）——**唯一改动是临时根目录名 `mineradio-watch-a/b` → `stellaflix-watch-a/b`**（diff 已核对只有这两行）。**19/19 绿**。
- **证伪（三处劣化各自精确变红，非假绿）**：
  | 注入 | 结果 | 含义 |
  |---|---|---|
  | D1 去掉 `watcher.unref()` | 只有第 5 项「setRoots 挂上递归监控」红 | 证明句柄不放 event loop 这条被守住 |
  | D2 取消最长等待阀门 | 第 6、7 项红 | 证明「长时间拷贝也能中途上报」被守住 |
  | D3 去掉递归降备（`[true,false]`→`[true]`） | 只有第 14 项「降级成只看一层」红 | 证明降级路径被守住 |
  每次注入后均用 shell `cp` 从参照库还原并 **md5 双向校验**（`5be08d…489b3`），无脏文件残留。
- ⏸ **`local-library-watch-wiring.test.js`(87) 推迟到批2**：它断言的是 main.js/preload 接线，而我们 `desktop/main.js` 目前只有 `closeLocalLibraryStore()`（L4762 定义、L7105 `before-quit` 调用），尚无 `LOCAL_LIBRARY_EXTS` / `applyLocalLibraryWatchRoots` / `localLibraryWatchStatusSnapshot` / `broadcastLocalLibraryWatchChange`，此时随迁必然红。批2 落地时一并迁入，channel 改 `stellaflix-local-library-watch-*`，并记住参照库那条铁律：**`closeLocalLibraryWatcher()` 必须排在 `closeLocalLibraryStore()` 之前**。
- 回归：`npm test` **232/233 文件通过**，唯一红的是别家会话 12:55 在飞的产品改动 `tests/ranking-radio-content-netvalue.test.js` 第 4 项（断言 CSS `.secondary-toolbar` 全局规则，而 `public/css/index.css` 里 grep 计数为 0）——与本次改动零引用关系，非本切片引入。`bundle:check` 通过（15 段/119 模块，产物与源码逐字节一致；新文件在 `desktop/`，不进 bundle）。

### 3.3 ❸a「特别喜欢」存算先行已落地（10-25 依 Q1=B / Q2=A 开工，未提交）

按 Q2=A 只做存储层与红心按钮，**不碰任何列表 UI**（列表卡片＝❸b，随宿主单独立项）。

- 新模块 `public/js/modules/05-playback/21-local-special-liked.js`：参照库 `app.js:23821-23966` 的引用表/快表/开关直搬（`specialLikedSongPath/Key/Ref/compact*/read/write/index/lookupSets/isSpecialLikedSong/getSpecialLikedSongs/toggleSpecialLikedSong`），并按 Q1=B 做三项双池改造：
  - `specialLikedSongKey` 对非本地曲目返回 **`online:` + `songAccountStateKey()`**（复用既有 `provider:id`，不另发明身份键）；参照库 `app.js:23949` 那句「特别喜欢歌单只支持本地音乐」的拦截**已剔除**。
  - 新增 `syncSpecialLikedOnlineRef(song, liked)`：平台红心写回成功后同步本地引用。**在线歌以平台为准**——`isSongLiked` 在已登录时优先读平台态，未登录/无平台通道才回落本地表。
  - SQLite 镜像 `syncLocalLibraryDbFavorite`（走既有桥 `callLocalLibraryDb('setLocalLibraryDbFavorite', …)`）**只对本地歌写**；在线歌写了就是没人认领的孤儿行。
- 通道：`ipcMain.handle('stellaflix-local-library-db-set-favorite', … )`（沿用 `withLocalLibraryStore` + `isTrustedMainWindowIpc`）+ preload `setLocalLibraryDbFavorite`。store 层无需再动（`setFavorite` 已在 §3.1 随 store 整搬到位）。
- 接线：`06-track-detail-lyrics-actions.js` 的 `isSongLiked` 加分支、`toggleLikeSong` 开头拦截本地曲目改走 `toggleSpecialLikedSong`、平台写回成功后调 `syncSpecialLikedOnlineRef`。
  - 注：`:1284` 那句「本地文件暂不支持同步…红心」**保留未删**（同一函数还服务 `collect`＝收藏到歌单，本地仍不支持），现在只是 `like` 路径走不到它。
- 测试 `tests/local-special-liked.test.js`（新建，11/11 绿）：9 条行为用例 + 通道/门牌号合约 2 条。**证伪两轮**：
  | 注入 | 结果 |
  |---|---|
  | D1 在线歌也写 SQLite | 第 7 项红 —— ⚠️ **首轮注入时它没红**：断言写在移除 toggle 之前，属假守卫；已把断言挪到移除之后并重验证成功 |
  | D2 在线键退回空串（等同参照库 local-only） | 第 7、8、9 项红 |
  还原走 shell `cp` + md5 双向校验，临时文件已清理。
- bundle：`index-loader.js` modulePaths 新增该模块 → 重建 **120 模块**，`tests/bundle-modules.test.js` 计数 119→120，`bundle:check` 通过。

### 3.4 批2-A「watcher 接线上线」已落地（10-25，未提交）

批1 那个 watcher 模块原本是"躺在仓库里不干活"，本单元把它接进主进程，**可以真的挂监控了**。移植自参照库 `main.js` L400-450（扩展名/MIME 表）、L476-487（授权根）、L1069-1182（生命周期+广播）、L4886-4899（IPC）。

- **扩展名/MIME 表**：`LOCAL_LIBRARY_EXTS`(35) / `LOCAL_LIBRARY_AUDIO_EXTS`(17，含 `.ape`/`.dsf`) / `LOCAL_LIBRARY_MIME`(31)。监控的兴趣路径判定 `localLibraryWatchTrackedPath` 只认这些后缀——`.tmp`/`.part`/`Thumbs.db` 在这里就被挡掉。**MIME 表当前无消费方**（批2-B 的 `/api/local-file` 与目录扫描会用），它与前两张表是连续整块，一并直搬避免二次对齐。
- **授权根**：`authorizedLocalMusicRoots` + `normalizeLocalMusicRoot`（非目录抛 `LOCAL_LIBRARY_NOT_DIRECTORY`）+ `rememberLocalMusicRoot`。**渲染层给的每一条根都必须过这道门**，否则能借监控读任意目录。`resolveAuthorizedLocalFile` 未在本次移植——它的唯一消费方是 `/api/local-file`（批2-B），提前建就是死代码。
- **生命周期**：`getLocalLibraryWatcher`（懒创建，创建失败只降级成"没有监控"）/ `applyLocalLibraryWatchRoots`（逐条授权、失败项进 `rejected` 不阻断其余根）/ `localLibraryWatchStatusSnapshot` / `broadcastLocalLibraryWatchChange`（推 `stellaflix-local-library-watch-changed`，路径最多带 64 条）/ `closeLocalLibraryWatcher`。
- **通道**：`stellaflix-local-library-watch-set-roots` / `-watch-status`，均过我方 `isTrustedMainWindowIpc`；preload 三件套 `setLocalLibraryWatchRoots`（只透数组）/ `getLocalLibraryWatchStatus` / `onLocalLibraryWatchChanged`（返回退订函数，避免重复订阅越挂越多）。
- **退出顺序**：before-quit 里 `closeLocalLibraryWatcher()` 已排在 `closeLocalLibraryStore()` **之前**（原 L7329 只剩 store 一处）。
- 随迁 `tests/local-library-watch-wiring.test.js`(87)，**6/6 绿**；两处口径改成我方：信任闸 `trustedMainFrameHandler` → `isTrustedMainWindowIpc`、门牌号 `mineradio-` → `stellaflix-`。**证伪三轮**（每次注入后均用 shell `cp` + md5 双向校验还原）：
  | 注入 | 结果 |
  |---|---|
  | D1 把 `closeLocalLibraryStore()` 排到 watcher 之前 | 第 3 项「主进程接上监控并在退出时关掉」红 |
  | D2 apply 里绕过授权，直接用原路径 | 第 4 项「IPC 走信任闸 + 逐根授权」红 |
  | D3 preload 去掉 `Array.isArray(folders)` 护栏 | 第 5 项「preload 三件套」红 |
- ⚠️ **当前仍无调用方**：渲染层还没有"音乐文件夹根"这个概念（我们是手动导入文件的模型），所以这两个通道现在还没人喊。它们会在批2-B（目录扫描 + `/api/local-file`）接上时第一次被真正调用。这是计划内的排队顺序，不是遗漏。
- 校验：`node --check desktop/main.js`、`desktop/preload.js` 均通过；`bundle:check` 不受影响（本单元没动 `public/`）。

### 3.5 批2-B-1「本地文件 HTTP 通道 + APE/DSD 转码」已落地（10-25，未提交）

参照库 `server.js` L22/L29/L54/L164-271/L3294-3373 与 `main.js` L231/L532/L5653/L5668 的移植。这是"后厨怎么把音频从硬盘递进页面"的通道。

- **解码器三件直搬**：`desktop/audio/ape-decoder.js`(1511)、`dsf-decoder.js`(322)、`wav-stream.js`(413)，`diff` 与参照库**逐字节一致**、零品牌字面量。用途：APE / DSF 浏览器不认识，实时转码成 WAV 再喂 `<audio>`（无 ffmpeg）。
- **server.js**：`LOCAL_FILE_TOKEN`（env `STELLAFLIX_LOCAL_FILE_TOKEN`）/ `setLocalFileAuthorizer`+导出 / `LOCAL_FILE_MIME`+`localContentTypeForPath` / `parseLocalFileRange`（越界与非法 Range 判 invalid→416）/ `loadAudioTranscode`+`openTranscodeSource`+`sendTranscodedAudio`（转码响应头 `X-Stellaflix-Transcode`）/ 路由 `/api/local-file`（token → 授权门 → stat → 转码或 Range 206）。
- **main.js**：补 `resolveAuthorizedLocalFile`（按分隔符边界判定，越权抛 `LOCAL_FILE_NOT_AUTHORIZED`；上一单元刻意留到现在才建，因为它的唯一消费方就是这个通道）；`LOCAL_FILE_TOKEN` 随 server 启动写进 env（**必须在 require server.js 之前**，模块加载即读取）；`waitForLocalHttpReady` 之后注入 `localServer.setLocalFileAuthorizer(resolveAuthorizedLocalFile)`。
- 随迁 `tests/local-file-proxy-authorization.test.js`(107)，**5/5 绿**，两处口径改我方（env 名 `STELLAFLIX_LOCAL_FILE_TOKEN`、切片终点 marker 换成 `function localLibraryWatchTrackedPath(`）。这个测试是真的把我们的 server.js 以 `PORT=0` 拉起来打 HTTP，不是纯字符串断言。
- **证伪两轮**（每次 shell `cp` + md5 还原，临时文件已清）：
  | 注入 | 结果 |
  |---|---|
  | D1 授权门 Fail-Closed 改成 Fail-Open | 只第 1 项「未注入授权函数时默认拒绝」红 |
  | D2 去掉 token 校验 | 只第 5 项「令牌错误仍然拒绝」红 |
  ⚠️ D1 第一次注入方式写错了（只跳过 403 分支、仍调 null 授权函数抛错→全红），误导成"全绿才算抓到"；已改成真正绕过授权调用重做，才得到精确单点变红。
- **仍未接线**：渲染层还没有人生成这个 URL（旧 `stellaflix-local://` 协议仍在使用），URL 构造器与切通道的动作放在批2-B 的收尾子步（删旧协议层 + 迁移器）一起做，避免中途两套通道并存。

### 3.6 批2-B-2「主进程目录扫描（全量/增量）+ SQLite 落库 + 失效探测 + 选文件夹入口」已落地（10-25，未提交）

移植自参照库 `main.js` L451-1067 的垂直切片（与批2-A 的扩展名/MIME 表、`normalizeLocalMusicRoot`/`rememberLocalMusicRoot`/`resolveAuthorizedLocalFile`/`localLibraryWatchTrackedPath` 共用，不重复建）。这是"后厨怎么把整棵音乐目录摸一遍、记进账本、并能判断哪些文件失效"的扫描层。

- **扫描切片**（落在 `desktop/main.js`，接缝起点 `const LOCAL_LIBRARY_EXTS = new Set(`、终点 `// 本地曲库 SQLite 存储句柄`）：
  - 常量：`LOCAL_LIBRARY_SCAN_STAT_CONCURRENCY=24` / `VISIT_LIMIT=60000` / `PROBE_MAX=2000` / `PROBE_CONCURRENCY=8` / `INCREMENTAL_MAX_AGE_MS=12h` / `NAME_COMPARE`(zh-Hans-CN numeric)。
  - `scanLocalMusicFolderFull`（递归收集 `collectLocalLibraryFolderEntries` + 并发 stat `statLocalLibraryFiles`，带访问上限与截断标记）；`scanLocalMusicFolderIncremental`（复用未变文件 `rehydrateLocalLibraryFileRecord`、只重 stat 变化目录、`truncated`/`savedAt` 超龄回退全量）；`scanLocalMusicFolder`（编排：无快照先问 SQLite→有则增量、无则全量，扫完自动 `syncLocalLibraryStoreFromScan` 落库）；`probeAuthorizedLocalFiles`（ok/missing/**blocked** 三态，越权必须和"被删"分开，否则会误报一整批）；`loadLocalLibraryStoreRoot`（从 SQLite 还原快照）。
  - 文件记录 `makeLocalLibraryFileRecord` / 目录记录 `makeLocalLibraryDirectoryRecord` / 相对路径归一 `localLibraryRelativePath`/`normalizeLocalLibraryRelPath`/`localLibraryDirRelPath` / 授权判定 `isPathInsideLocalLibraryRoot` / 代理 URL `localFileProxyUrl`。
- **落库桥**：复用批1 的 `syncRoot`/`saveIndexRecords`/`clearRoot`/`loadRoot`；新增 `syncLocalLibraryStoreFromScan`（把扫描结果写回 SQLite，返回 `{ok,total,audio}`）。`LOCAL_FILE_TOKEN` 在生产是 `crypto.randomBytes(16).toString('hex')`，vm 切片测试里替换成固定串保证可预测。
- **通道**：11 个 `ipcMain.handle`（均过 `isTrustedMainWindowIpc` 信任闸）：`stellaflix-local-music-choose-folder`(dialog 选目录→`scanLocalMusicFolder`) / `-scan-folder` / `-refresh-entries` / `-probe-entries` / `stellaflix-local-library-db-load` / `-db-save-index` / `-db-clear` / `-db-read-assets` / `-db-write-assets` / `-db-read-lyrics` / `-db-restore-lyrics`。preload 对应 11 方法。
- **测试** `tests/local-library-deep-scan.test.js`（新建，4/4 绿）：vm 切片直接从真实 `main.js` 切扫描实现（不复制），注入真实 `node:sqlite` 存储跑端到端——① 三级递归 FLAC ② APE/DSF/FLAC/LRC MIME + `.txt` 收为 text/plain + `.xyz` 排除 ③ 全量落库→db-load 原样取回→二次增量复用(reused=2/refreshed=0) ④ 探针 ok/missing/blocked 三态区分。
- **证伪两轮**（每次注入后 shell `cp` + md5 双向校验还原，基线 md5 `e1a5dd5698a945208cd0a60ca238e22d`，无脏残留）：
  | 注入 | 结果 |
  |---|---|
  | D1 把编排里"有历史快照走增量"分支改成 `if (false)`（强制全量重扫） | 只第 3 项「二次扫描走增量并复用」红（scanMode≠incremental、reused 未定义） |
  | D2 把探针 `catch` 分支 `states[index]='blocked'` 改成 `'missing'` | 只第 4 项「越权必须判 blocked 不能误报成删除」红 |
- **回归**：受影响面（`local-library-*` / `mlib-*` / `local-file-*` 共 14 个测试文件）**189/189 全绿**；`node --check desktop/main.js`、`desktop/preload.js` 均通过。
- ⚠️ **仍未接线**：渲染层还没人调 `chooseLocalMusicFolder` / `scanLocalMusicFolder`（旧 `stellaflix-local://` 协议仍在用），这部分通道会在批2-B-3（渲染层 URL 切到 `/api/local-file` + 删旧协议层 + JSON→新库迁移器）第一次真正被调用。计划内排队，非遗漏。

### 3.7 批2-B-3「旧 JSON→新库一次性迁移器」已落地（10-25，未提交；**采纳重排后本批只做迁移器**）

按用户「采纳重排」决定：**本批只交付 JSON→SQLite 迁移器**；「渲染层 URL 切到 `/api/local-file` + 删旧 `stellaflix-local://` 协议层」**推迟到批4**（新 seam 接管后再删，避免本地音乐中间断档）。旧协议层现阶段仍是本地音乐唯一可用生产路径，port don't delete。

- **策略=合成临时根**：读旧 JSON 的 `audioPath` 列表 → 推导「最小根目录覆盖集」→ 逐个喂批2-B-2 的 `scanLocalMusicFolder` 重建曲库 → 按归一化绝对路径把旧标签叠回新行。旧 JSON 一律保留作回退。
- **`desktop/main.js` 迁移切片**（落在扫描切片内、`// 本地曲库 SQLite 存储句柄` 注释之前，vm 可测）：
  - `legacyLocalMusicRootsFromRecords`（纯函数）：取每个音频**文件所在目录**（`path.dirname`）去重，浅目录优先、被其它根包含的目录剔除，产出最小根覆盖集（避免同棵子树重复扫）。
  - `isLocalMusicRootAncestor`（纯函数）：`path.relative` 判包容。
  - `overlayLegacyMetadataIntoStore`：按 `normalizeStorePathKey` 把旧记录 artist/album/duration 叠到匹配行；**用新 store 原语 `overlayFileMetadata` 做部分列更新**，并置位 `metadata_loaded`/`index_updated_at`（否则 `loadLocalLibraryStoreRoot` 的 index 判据不通过，叠回去的标签渲染层看不见=白写）。
  - `migrateLocalMusicLibraryFromLegacy`（编排，幂等）：无旧 JSON→`no-legacy-json`；marker（`local-music-library.migrated-v1`）已存在→`already-migrated`；version≠1 或 records 非数组→`legacy-json-unrecognized`；单根扫描/叠加失败不阻断其它根；只在有根扫成功且未 `skipMarker` 时写 marker（写失败不影响已完成迁移，下次安全重试）。
- **启动接线**：`app.whenReady()` 内、`localMusicLibrary.installProtocol(protocol)` 之后 fire-and-forget 调 `migrateLocalMusicLibraryFromLegacy`（try 外 `.then/.catch` 只记日志、不阻塞建窗）。⚠️ **`userDataPath` 必须传 `STABLE_USER_DATA_PATH`**（与旧系统 `new LocalMusicLibrary({userDataPath: STABLE_USER_DATA_PATH})` 同源，含 QA 覆盖），不能传 `app.getPath('userData')`——否则 QA 模式下读错目录静默跳过。
- **新 store 原语 `overlayFileMetadata(folderPath, fingerprint, fields)`**（`desktop/local-library-store.js`）：按指纹定位单行，**只 UPDATE 白名单列**（title/artist/album/albumArtist/genre/year/trackNumber/duration + metadata_loaded/index_updated_at）。与 `saveIndexRecords` 的全列 UPDATE 本质不同——迁移只有部分字段，用全列 UPDATE 会把 title/genre/cover/lyric 清空。
- **测试** `tests/local-music-library-legacy-migration.test.js`（新建，6/6 绿）：vm 切片（roots/migrate 编排）+ 真实 store 直测（overlayFileMetadata 不误伤）+ 端到端「叠回后经 `loadLocalLibraryStoreRoot().index.records` 真正浮现」。
- **证伪三轮**（md5 基线 main.js `cbea39c6e7deec940d2afdc69e7d11e1`、store `f1a884a9e8b0f2c9ba9a741bddb751be`，均双向校验还原）：
  | 注入 | 结果 |
  |---|---|
  | F1 `legacyLocalMusicRootsFromRecords` 退回用完整文件路径当根（不取 dirname） | 只 roots/端到端/幂等三项红（test 2 store 直测 + 5/6 优雅跳过不受影响） |
  | F2 `overlayFileMetadata` 改成全列覆写 | 只 test 2「不误伤 title/genre/year」红 |
  | F3 迁移叠加去掉 `updatedAt` 置位 | 只 test 3「标签经 index 判据浮现」红 |
- **回归**：全量 `node --test tests/*.test.js` **1946/1949**，2 个 fail 均为 `proxy-image-disk-cache.test.js` 的 `/api/proxy` 磁盘缓存用例——**与本批无关**，隔离重跑 4/4 绿（已知的全量并发 flaky）。本地库面 `local-library-*` + 迁移 + deep-scan 共 43/43 绿。
- ⚠️ **覆盖范围说明**：本批只迁 artist/album/duration（旧 JSON 持久化的全部标签字段）；**封面（coverPath→assets 表）与歌词（lyric→lyrics 表）迁移未做**，连同完整标签解析一起留到批3。迁移后封面会暂缺，直到批3 标签解析补上——这是已知的、有意的范围裁剪，非遗漏。

### 3.7b 批3-A「自洽数据层」已落地（10-25，未提交；引擎胶水/接线推迟批4）

按「采纳重排 + 继续 A」：批3-A 只交付**自洽、可单测的数据层三件套 + 2 个净新增 IPC**；缠未接线引擎态/DOM 的编排层与 index-loader 接线**推迟到批4**（seam 接线后才有调用方、才能单测）。

- **净新增 IPC ×2**（main + preload，复用批2-A fail-closed authorizer）：`stellaflix-local-file-read-range`（`readAuthorizedLocalFileRange` 1:1 参照移植：授权→clamp→64MB→768KB 分块 base64）+ `stellaflix-local-library-db-write-lyrics`（store.writeLyricRecord）。测试 `tests/local-file-read-range.test.js` 5/5；证伪 RR（`from=0`）→ 子范围/clamp 精准红。
- **block1 解析器** `04-shelf/10-local-tag-parser.js`（参照 `app.js` L33833-36452，**diff 对参照为空=1:1 忠实**）。公开入口 extractLocalMetadataTags / extractEmbeddedCoverSource / extractEmbeddedLyricsText / embeddedLyricSourceLabel；字节读双路（file.slice / IPC readLocalFileRange）。
- **block2 扫描→曲目** `04-shelf/11-local-track-map.js`（参照 L32915-33375 + 传递依赖 localAudioFormatLabel@22800 + 格式能力 5 函数@28558-28594；block1 切片 diff 对参照为空）。提供 localFullPath/desktopLocalMusicApi（block1 运行时依赖）+ localSongKeyFromFile（=abs:size:mtime，与批2-B-2 同构）+ makeLocalSongFromFile/createLocalSongsFromFiles + sidecar 歌词/封面配对。
- **block3 纯原语** `04-shelf/12-local-cache-bridge.js`（90 行，9 纯原语 + 2 状态，diff 对参照为空）。⚠️ block3 其余是引擎胶水（IDB 不搬 / SQLite 桥已在 `20-local-library-db-bridge.js` / persistent-memory+封面管线+protected-keys 缠引擎态+DOM）→ **推迟批4**（task#11）。
- **测试**：`local-format-tag-parsing.test.js`（**参照 companion 1:1 移植，2 slice 改指我方 block1/block2，18/18 绿**——覆盖 Ogg Vorbis/Opus/FLAC、WAV/RF64、APE、DSF + 内嵌封面/歌词/时长 + 分发器 + 格式能力）+ `local-tag-parser-flac.test.js`(3/3) + `local-tag-parser-integration.test.js`(3/3，block1+block2 拼接全链路) + `local-cache-bridge-primitives.test.js`(7/7)。证伪：block1 字节读、B3 常量摘要，均精准红 + 还原。受影响面回归 **90/90 绿**。
- ⚠️ **未注册 index-loader**（推迟批4）：三模块运行时无调用方（安全），且 block2 与 `20-local-library-db-bridge.js` 有 2 处**良性重复声明**（`normalizeLocalLibraryPathKey` 逐字节相同；`localLibraryPathKeyFromSong` 功能等价——内联 vs 委托 `localLibrarySongPath`），去重归属批4 引擎模块结构设计。侧栏歌词解码单源（QRC/KRC/DES，参照 L33382-33832，`readLocalLyricText` 依赖）与 `local-tag-range-read-coalescing` companion 一并随批4。

### 3.8 剩余队列（10-25 更新：批2-A、批2-B-1、批2-B-2、批2-B-3 已完成）

| # | 单元 | 内容 | 依赖 |
|---|---|---|---|
| 1 | **批2-A** ✅（§3.4） | watcher 接线 + 扩展名/授权根 + 通道 + preload 三件套 | 批1 |
| 2 | **批2-B-1** ✅（§3.5） | `/api/local-file` + token/授权门 + Range + APE/DSD 转码器直搬 | 批2-A |
| 3 | **批2-B-2** ✅（§3.6） | 主进程目录扫描（全量/增量）+ store 落库 + 失效探测 + `chooseLocalMusicFolder` 入口（通道已就位，渲染层未接线） | 批2-B-1 |
| 4 | **批2-B-3** ✅（§3.7，迁移器部分） | 旧 JSON→新库一次性迁移器（合成临时根 + 标签叠加 + marker 幂等 + 启动 fire-and-forget） | 批2-B-2 |
| 5 | **批3-A** ✅ 数据层（§3.7b） | 自洽数据层三件套（block1 解析器 + block2 扫描→曲目 + block3 纯原语）+ 2 净新增 IPC（read-range/write-lyrics）+ format-tag-parsing companion 18/18。**引擎胶水/歌词解码/注册接线推迟批4** | 批2-B-2 |
| 6 | **批4**（吸收批3 剩余 + 原批2-B-3 剩余） | 渲染层 URL 切 `/api/local-file` + **删**旧 `stellaflix-local://` + seam 六方法 + **引擎接线**（注册 block1/2/3 到 index-loader、去重 block2↔20- 良性重复、currentLocalSong/playQueue/currentIdx 落地）+ **block3 引擎胶水**（persistent-memory/封面管线/protected-keys）+ **歌词解码单源**（QRC/KRC/DES）+ range-coalescing companion + 播放桥/本地搜索/ReplayGain/鼓点 + ❸b 特别喜欢宿主 + 统计两档清空弹窗 | 批3-A |
| 7 | **批5** | 收编回归 + 真机冒烟 8 项 | 全部 |


---

### 3.9 10-26 缺口盘点 + 缺陷审查（本会话取证）

**实态基线**：本会话修复过程中 `npm test` 从 254/256 → 256/257 → **256/256 全绿**（末尾别家会话删掉了悬空测试，总数随之从 257 降到 256）；`npm run bundle` = 15 段 / 125 模块且校验逐字节通过。批1~批5 的主体已由并发会话推完（引擎 `04-shelf/10~14`、`/api/local-file` 通道、watcher 接线、旧 JSON 迁移器、seam 供数、首页与拖入入口改读新引擎）。
（10-26 ReplayGain 切片落地后复核：`npm run bundle` = 15 段 / **126** 模块逐字节通过，`npm test` = **268/268 全绿**。）

**已修（本会话，未提交）**
1. **统计行键分裂**：`localLibraryDbSongKeyFromSong()` 原先无视引擎的 `song.localKey` 自算路径键；引擎（`11-local-track-map.js:275 localSongKeyFromFile`）、收藏（`21-local-special-liked.js:212`）、索引/封面/歌词全部以 `song.localKey` 为 `song_key`，两套算法一旦在生产数据上不等值，播放次数就会与收藏落到不同行。现改为优先沿用引擎键、仅旧桶缺 `localKey` 时回退同构现算。
2. **悬空测试**：`tests/local-library-db-stats-ipc.test.js` 仍 `require` 已删除的 `desktop/local-music-library.js`（并发批次的删除动作留下的破口，本会话 254/256 之一）。已重新锚定到新引擎面（主进程 `localLibraryStoreFileRecordFromRow` 必须带 `fullPath/size/lastModified/url`），不再依赖已删文件。

**待办（缺口，按优先级）**
| # | 缺口 | 证据 | 归属 |
|---|---|---|---|
| 1 | ~~`tests/local-music-library-persistence.test.js` 悬空失败~~ **已被并发会话收编**（10-26 复核：该测试已随被删模块一并删除，全量 256/256 全绿） | 曾为 256/257 唯一失败项，MODULE_NOT_FOUND | 批4/批5 收编会话 |
| 2 | **单文件导入落库链断成死代码**：`importPersistentLocalAudioFiles()`（:134）全仓无调用方，其门槛 `canUsePersistentLocalMusicLibrary()`（:44）探测的 `desktopWindow.importLocalMusicFiles` 在 preload/main 已不存在 → 恒 false。实际拖入音频只走 `importLocalAudioSongs(localSongFromAudioFile(...))`（:186，内存态/临时队列），**不落 SQLite**；目录导入才持久化。`canRemovePersistentLocalTracks()`（:50）同样探已删通道，仅因被 `||` 到 seam 判断而未阻断删曲 | grep 无 `importLocalMusicFiles` 定义、无 `importPersistentLocalAudioFiles` 调用方 | 批4 会话（要么把单文件导入接到新引擎，要么删死代码并在 UI 明示「仅支持整目录导入」） |
| 3 | ~~**ReplayGain 只搬了一半**~~ **本会话已修完**（见 §3.10）：标签解析与 `song.localReplayGain` 承载已就位（`10-local-tag-parser.js:626+`、`11-local-track-map.js:563`），补齐了引擎 + `replayGainNode` + 音频图插入 + 切歌/启动调用点 + UI + 控制台注册位 | grep `replayGain` 无播放侧消费方 | 拍板 5B「第一批顺搬」已完成 |
| 4 | **②两档清空历史弹窗未建**：store 的 `clearPlayStats('recent'|'all')` 已具备，主进程无 `-clear-play-stats`/`-read-stats`/`-trim` 通道，渲染层无模态与 `listen-history-clear` 随迁测试 | preload 仅 `restore-lyrics` 含 restore 字样 | 统计功能批 |
| 5 | **③收藏读侧未闭环**：`setLocalLibraryDbFavorite` 写通道 + `21-local-special-liked.js` 双写已在，但读取仍以 localStorage 引用表为唯一权威，「清桶后从 SQLite 复活收藏」的回灌路径未接 | `21-local-special-liked.js:204` 注释自陈「只让清了 localStorage 之后还能捞回来」，捞的动作未写 | 批4/批5 |
| 6 | **④统计随整机备份**未做（仍在「不搬清单」，待主人是否改向） | — | 待拍板 |
| 7 | ~~旧 `stellaflix-local://` 协议层实态与注释不符~~ **10-31 本会话已清**：`main.js:8099` 那段空的 `try{…}catch` 与「旧协议层仍在职责内兜底」的假注释删除、就地改写为 `/api/local-file` 现状；`04-shelf/04-cover-api-helpers.js:32` 的特判注释同理更正（`crossOrigin` 那行本身仍对远程源有意义，保留）；`13-playback-start-audio.js` 里调已不存在的 `readLocalMusicLyric` 的死分支整段移除（typeof 守卫恒挡，无行为变化；全仓无测试 pin）。`node --check` + `npm run bundle` 15/126 + 全量回归通过 | grep 全仓无该 scheme 的生产方、`readLocalMusicLyric` 在 preload/main 无定义 | 已闭环 |
| 8 | **顶层同名 helper 双份**：`normalizeLocalLibraryPathKey`/`localLibraryPathKeyFromSong` 在 `04-shelf/11` 与 `05-playback/20` 各一份（行为等价，20- 后加载胜出）。别家 `tests/local-library-registration-smoke.test.js` 明确 pin 为「良性重复」，而计划 §3.8 第 6 行把「去重」列在批4 待办里 —— 意图冲突，本会话不强推 | 见 §3.8 表第 6 行 | 批4 会话定去留 |
| 9 | **`readFileAsDataUrl` 两份语义不同**：`04-shelf/10`（桌面 IPC 读 + 失败 resolve `''`）vs `07-fx/03`（纯 FileReader + 失败 reject `FONT_READ_FAILED`），加载顺序使 07-fx 胜出。当前仅字体上传调用它，标签层那份是死代码，暂无实害但语义相反属真隐患，改名或合并应由其主人做 | dup-scan 工装输出 | 待分派 |
| 10 | **真机冒烟 8 项**未跑（选目录→扫描进度→APE/FLAC 各播一首→断网续播→改目录文件 watcher 自动同步→切在线音质→重启后库自恢复→影视态零回归）；~~全部改动未提交~~ **10-31 已止血**：`fbfcd81` + `f6f4837` 提交并 push 至 `origin/main`。冒烟项已并入合并清单 `docs/superpowers/plans/2026-10-31-consolidated-real-machine-smoke.md` §A/§B（本批 10 + ReplayGain 5 项，含「先重启一次」前置） | `git log` + `git rev-parse HEAD origin/main` 同 SHA | 主人 |

### 3.10 拍板④/5B「ReplayGain 应用链」已落地（10-26 主人指令「先修 ReplayGain」，未提交）

**TDD**：先写 `tests/replay-gain-normalization.test.js`（14 例，参照库同名测试移植 + 按我方 shell 改写接线断言；引擎逻辑用 `vm.runInNewContext` + 源码切片执行，不复制生产代码），逐例见 RED 后实现。全量 `npm test` **268/268**，`npm run bundle` 15 段/**126** 模块逐字节通过。

**落地内容（垂直切片，六层齐）**
| 层 | 文件 | 内容 |
|---|---|---|
| 引擎+UI | `public/js/modules/05-playback/22-replay-gain.js`（净新增 ~300 行） | dB→线性 `10^((gain+preamp)/20)`、clipGuard 按峰值封顶 `1/peak`、钳 `0.05..4`、album/track 互回退、80ms 斜坡、preamp ±12dB/0.1 步进、惰性补标签（promise 去重 + `localReplayGainResolved` 负标记）、`trackSwitchToken` 过期结果丢弃 |
| 状态 | `00-state/00-core-stores.js:54` | 音频图变量链加 `replayGainNode = null` |
| 音频图 | `05-playback/08-audio-graph-controls.js` | 健康检查/断开数组/置空均纳入该节点；`initAudio` 建节点并串 `analyser → replayGainNode → gainNode`（capture 兜底支路原走 `analysisSinkNode` 静音坑，10-26 已按主人拍板改为图形真出声，见 §3.12）；末尾 `setReplayGainNodeGain(replayGainActive.linear, true)`；cuefield「B deck」adopt 分支校验并接管 `preparedGraph.replayGainNode` |
| 预备图 | `05-playback/18-cuefield-automix-integration.js` | prepared graph 增同一节点 + 两处断开数组同步（缺节点会破 `audioGraphHealthy()`/接管） |
| 调用点 | `05-playback/13-playback-start-audio.js` | 本地切歌后 `prepareReplayGainForSong(song, token)`；在线分支 `currentLocalSong = null` 后清成 `prepareReplayGainForSong(null, token)`，防本地增益漏到在线曲 |
| 启动 | `10-shell/05-startup-bindings.js` | `bindVolumeControls()` 后 `initReplayGainControls()` |
| HTML/注册表 | `public/index.html`（~839，`fx-lyric-fold` 之前）+ `07-fx/09-console-workspace.js` | 扁平块：`t-replayGain`/`t-replayGainClipGuard` 双 toggle、`replaygain-mode-seg`（整轨/整专辑）、`.fx-slider#rg-preamp`（-12..12 step .5）、`#replaygain-hint` + `#replaygain-support-hint`；全部登记进控制台 `output`「播放输出」分组 |
| 装载 | `public/js/index-loader.js` | modulePaths 追加 22-replay-gain.js（125→126） |

**架构取证（改设计的那一条）**：我方面板不是参照库的 `fx-fold` 手风琴，`organizeFxConsoleWorkspace()` 会把注册表之外的 `#fx-panel` 直接子节点**清扫删除**（`07-fx/09-console-workspace.js` 末段）。首版按参照库套了 `#fx-volume-fold` 外壳，jsdom 实跑证明整套控件会被摘掉 → 改为「扁平块 + 7 条 `fxConsoleItem()` 注册」，并把该 jsdom 落位测试留在套件里当回归闸（断言 `closest('[data-fx-console-group]')==='output'`、在 `.fx-fold-body` 内、且不游离于 `#fx-panel` 顶层）。

**为本次改动而必须同步的别家测试**（非我方主动改）
- `tests/playback-audio-graph-recovery.test.js`：沙箱补 `replayGainNode` / `replayGainActive` / `setReplayGainNodeGain` 桩（该模块函数体会引用新全局）。
- `tests/bundle-modules.test.js`：模块计数 pin 125→126。

**有意偏差（与参照库不同，需主人知晓/拍板）**
1. ~~**解析结果不回写 SQLite**~~ **已按主人指令「加列持久化」补完，见 §3.11**：解析到的 `localReplayGain` 现落 assets 表 `extra` JSON，水合阶段回灌。
2. ~~**captureStream 兜底支路里听不到效果**~~ **已按主人拍板「让图形真出声（全量生效）」改造完，见 §3.12**：兜底支路不再用静音分析坑，图形独占出声、主元素静音，RG 衰减与提升都真听得见。
3. 存档键 `stellaflix-replay-gain-v1`（拍板③），持久化用本仓 `localStorage.setItem` 惯例（参照库的 `setPersistentLocalStorageItem` 我方不存在）。
4. 曲目身份比对用本仓 `queueItemKey(song)`（参照库 `isCurrentLocalQueueSong` 我方不存在）；提示文案无英文分支（我方无 `uiLanguage`）。

### 3.11 ReplayGain 解析结果落库持久化已落地（10-26 主人指令「加列持久化」，未提交）

**先取证再动手（有来源：参照库源码）**：主人说的是「加列」，但参照库并没有物理列 —— `app.js:9299` 的实现与注释是把 `localReplayGain` 挂进**资产缓存快照的 extra JSON**（原文：「ReplayGain 走 extra JSON 列，只在解析到时写入，缺省时不占用缓存体积」），读回在 `app.js:9523`；参照库全仓 grep `replay_gain` 无列定义。我方 `desktop/local-library-store.js` 的 assets 表本就带同一 `extra` 回环（`collectExtraFields`/`mergeExtraFields`）。故按 1:1 走 extra JSON：零 DDL，也不必补本仓尚不存在的 `ALTER TABLE` 迁移器（现表只 `CREATE TABLE IF NOT EXISTS` + `PRAGMA user_version` 盖章，加物理列会让既有老库缺列、读写直接报错）。**若主人仍要物理列，需另批先做列迁移器**。

**RED→GREEN**：净新增 [tests/replay-gain-persistence.test.js](file:///C:/Users/Administrator/Desktop/Stellaflix/tests/replay-gain-persistence.test.js) 9 例（真实 `node:sqlite` 临时库跑 round-trip，非桩），首跑 **9/9 RED**（失败原因均为「实现不存在」），实现后全绿。

| 层 | 落点 | 内容 |
|---|---|---|
| 存储 | `desktop/local-library-store.js` | 新增 `mergeAssetExtraFields(songKey, fields)`：只改 `assets.extra` 列的合并式 upsert（缺行能建行、破损 JSON 以本次重建、拒空键/非对象字段），并注册进公开 API。`writeAssetRecord` 在快照不带 `localReplayGain` 时先 `readAssetExtraField` 捞回 —— 抄的是本仓 `writeLyricRecord` 保 `localLyricTranslations` 的同款教训（有来源：`tests/local-library-sqlite-store.test.js` 已为该坑立测）。 |
| 通道 | `desktop/preload.js:88` + `desktop/main.js:5851` | `mergeLocalLibraryDbAssetExtra` → `stellaflix-local-library-db-merge-asset-extra`；句柄先验 `isTrustedMainWindowIpc`、再拒空键（`LOCAL_LIBRARY_DB_KEY_EMPTY`）。 |
| 写侧 | [04-shelf/13-local-library-engine.js](file:///C:/Users/Administrator/Desktop/Stellaflix/public/js/modules/04-shelf/13-local-library-engine.js) | 新增 `persistLocalReplayGainAsset(song)`（缺 `localKey`/缺标签直接返回）；`persistLocalTrackMetadata` 索引回写后 await 它（扫库解析链落库）；[22-replay-gain.js:154](file:///C:/Users/Administrator/Desktop/Stellaflix/public/js/modules/05-playback/22-replay-gain.js#L154) 惰性补齐标签后 fire-and-forget 调用（播放时补到的值落库，对应参照库 `scheduleLocalAssetCacheWrite` 的落点）。 |
| 读侧 | 同上 `hydrateLocalLibraryRoot` | 资产记录里的 `localReplayGain` 仅在曲目自身缺值时回灌（参照 `app.js:9523` 语义），重启后首播即有增益。 |

**行为级证据（不只文本 pin）**：`tests/replay-gain-normalization.test.js` 沙箱加了 `persistLocalReplayGainAsset` 计数桩，`切歌后补齐标签会重新应用增益` 现断言 `persisted === 1` —— 证明补齐路径真的发起落库，而非只在源码里出现该调用。

**回归**：`npm run bundle` 15 段 / 126 模块逐字节通过；`npm test` **269/269 全绿**（较上轮 +1 个测试文件）。

**未覆盖**：真机「重启后首播即带增益」仍待主人冒烟 —— 测试用真实 SQLite 证明了落盘与读回，播放侧听感无法自动化。

**10-31 补钉（把上面「未覆盖」的代码半边合上，仍待主人听感）**：新增两例，首跑即绿＝链路本就在码上通、此前无测试看守：
① `tests/local-library-engine.test.js`「水合回灌资产 extra 里的 ReplayGain」—— 假 `readLocalLibraryDbAssets` 按引擎请求的键现场造记录，断言 `readAssetRecords` 的 extra 字段回到 `track.localReplayGain`，且请求键与曲目 `localKey` 逐字相等、同轮封面回灌生效（证明走的是资产记录而非旁路）。
② `tests/replay-gain-normalization.test.js`「水合带回标签时首播即施加且不重读文件」—— 带 `localReplayGain` 的曲目 `prepare()` 后增益立即到 -6dB，`extractLocalMetadataTags` 调用数 0、`persisted` 0（与既有「缺标签才补齐」用例互为镜像）。
同时核过 IPC 全链：preload `readLocalLibraryDbAssets` → `stellaflix-local-library-db-read-assets`（main.js:5833，可信发送方闸）→ `store.readAssetRecords` → `mergeExtraFields`（`record[key] === undefined` 才填，故非列的 `localReplayGain` 必被带入）。全量 **281/281**，bundle 15/127。

### 3.12 captureStream 兜底支路改「图形真出声」（10-26 主人拍板方案 B，未提交）

**主人拍板**：问题「ReplayGain 在 captureStream 兜底支路里要怎么修？」选定 **让图形真出声（全量生效）** —— 不是把增益折进 `audio.volume` 的折中，而是让兜底支路的出声权也交给 Web Audio 图，衰减与提升一并生效。

**改设计前先用工装取证（有来源：离屏 Electron 探针，`.scratch/probe-capture-mute.js` / `.scratch/probe-graph-volume.js`，内核 Electron 42.4.1 / Chromium 148.0.7778.265）**
1. `captureStream()` 出来的音轨**不受**主元素 `muted`/`volume` 影响 —— 静音/音量四种状态下 RMS 恒 0.3548。所以「主元素静音 + 图形出声」在机制上成立，不会把分析信号一起掐掉。
2. `createMediaElementSource` 支路的元素音量**会**乘进图形：`volume=0.25` → RMS 0.0883（≈0.25 的线性映射），`muted=true` → RMS 0。故两支路的音量律**必须不同**，不能一刀切。
3. `AudioContext.setSinkId` / `.sinkId` 可用 —— 图形独占出声后，输出设备路由仍跟着图形走（`applyAudioOutputDevice` 里 `webAudioRouteActive = !!(audioReady && audioCtx && gainNode)` 现在在兜底支路也为真，恰好是正确语义：听得见的那条路就是被改设备的那条路）。

**落地（六处，全部随 RED 一起钉）**
| 落点 | 改动 |
|---|---|
| `05-playback/08-audio-graph-controls.js` `initAudio` | `gainNode` 两支路都建；出声链统一 `analyser → replayGainNode → gainNode → destination`；`analysisSinkNode`（gain=0 的只读分析坑）整条删除 |
| 同上 新增 `audioGraphRunsOutput()` | 判定「当前是 capture 源且图形已独占出声」——刻意**不**依赖 `audioReady`：`initAudio` 末尾 `applyVolumeToAudio()` 时 `audioReady` 还没置真，用健康判定会漏掉这次静音交接，起播那一下变双份声音 |
| 同上 `writeAudioOutputGain()` | 音量律按分支分岔：无图 → 元素吃全量；常规支路 → 元素与图形各担 `sqrt(value)`（原样）；capture 支路 → `audio.muted = true` 且图形吃**全量** `value` |
| 同上 `disconnectAudioGraphNodes()` | 拆图即刻 `audio.muted = false` 把出声权还给元素 —— 否则建图失败会留下一个永久静音的哑巴播放器（本次新增的安全阀） |
| `00-state/00-core-stores.js:54` | 变量链删掉 `analysisSinkNode` |
| `05-playback/00-api-quality-output.js` 镜像同步 | 副设备镜像不再 `mirror.muted = !!audio.muted`（兜底支路主元素静音会把第二块设备一起哑掉），改 `mirror.volume = currentAudioOutputGain()` 取**有效出声音量**。顺带纠正了原实现拿 `sqrt` 后的元素音量、副设备比主机响的既有偏差 |

**RED→GREEN**：净新增 [tests/audio-graph-capture-output.test.js](file:///C:/Users/Administrator/Desktop/Stellaflix/tests/audio-graph-capture-output.test.js) 6 例（vm 沙箱跑真实 `initAudio`/`writeAudioOutputGain`/`syncAudioOutputMirrors` 函数体，断言真实连边与 `muted`/`gain.value` 数值，非文本 pin）。首跑逐例 RED：兜底支路「没有 gainNode」、音量律读空、拆图后仍静音、镜像继承静音、`analysisSinkNode` 仍在源码；实现后 6/6 绿。其中 `testMediaElementBranchStaysUnmuted` 是**防回归守卫**（写它时即绿，钉住常规支路不被改坏）。
同步更新别家断言：`tests/replay-gain-normalization.test.js` 两条 `analysisSinkNode` 文本 pin 改指新链；`tests/playback-audio-graph-recovery.test.js` 沙箱删去该桩位。

**已知取舍（AI推理，非实证结论）**：兜底支路的出声从此完全依赖 Web Audio 图，图挂掉（context 被挂起/建图失败）就是彻底没声，而旧行为下至少还有元素原生声音垫底。缓解是上面那条「拆图即释放静音」安全阀 + 既有 `resumeAudioAnalysis`/`schedulePlaybackAnalyserRecovery` 重建链；真正的听感与稳定性只能主人真机冒烟。

**端到端真机复验（有来源：`.scratch/probe-graph-output-branch.js`，同内核离屏 Electron 实跑）**：按改后的真实链形（`captureStream → analyser → replayGain → gain → destination`，主元素全程 `muted=true`）量得基线 RMS 0.3548；`replayGain=0.5` → 比值 **0.50**（均衡在兜底支路真生效）；`gain=0.25` → 比值 **0.25**（图形吃全量，不是 sqrt 的 0.5）；`gain=0.5` → 比值 0.50（测量点线性可信）；测量期间 `currentTime` 推进 2.9s（元素静音没停解码时钟）。四条判据全部命中设计值。

**回归**：`npm run bundle` 15 段 / 126 模块逐字节通过；`npm test` **272/272 全绿**（含本次净新增 1 个测试文件）。中途一轮出现的 4 例失败为既有网络/端口 flaky（drpy 联网 fetch、`EADDRINUSE 5911`、proxy-image 磁盘缓存），复跑即全绿，与本次改动无关。
