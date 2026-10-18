# LX 音源完整对齐设计（Mineradio-LX-Music 1.7.0 → Stellaflix）

日期：2026-10-18
参照库：`C:\Users\Administrator\Desktop\Mineradio-LX-Music-1.7.0`
状态：主人已认可四节设计，待审本文档。

## 0. 决策记录（主人圈定）

1. **完整对齐 LX 版世界观**：脚本音源是在线播放 URL 的唯一供给者；官方平台 API 不再承担播放。
2. **执行载体**：Node `vm.runInNewContext` 进 server.js 进程（web/桌面同一条链）；现有 `desktop/custom-source/` BrowserWindow 载体整体删除。
3. **官方平台全拆**：播放/搜索/登录/收藏写回/VIP 探测全部退役；播客随 NetEase 一起下线；`platform-playlist-import.js` 存活，匹配桥 `setSearchImplementation` 改指内置爬虫。
4. **节奏**：先建后切再拆三段式；阶段2 一次提交内完成消费端切换，不留混搭态；每阶段 `npm test` 全绿。

## 1. 身份契约（移植铁律）

沿用 [[reference-mineradio-source]]：禁止整段照抄，复制块必须反向改名保持 Stellaflix 拼写——
- 脚本存储路径：上游 `%APPDATA%\Mineradio\sources\` → 我方 userData 下 `sources/`（桌面版实际落 D 盘数据目录，与真机习惯一致）；
- `lxmusic://` scheme 与 127.0.0.1:23330 open-API 桥**不属身份契约范围——决策为不移植**（见 §8 范围外）；其余上游命名按我方规范改写；
- 例外：从本机 lx-music-desktop 自动迁移（读 `%APPDATA%\lx-music-desktop\LxDatas` 的 `user_api.json`/`apiSource`）保留——读第三方数据不算身份污染；
- 差异审计一律 `diff --strip-trailing-cr`（CRLF/LF 混用坑）。

## 2. 新增后端组件

### 2.1 `lx-source-host.js`（根目录，≈1200 行，移植自上游同名文件）
- vm 沙箱：`vm.runInNewContext(script, sandbox, {timeout:5000})`；注入 `lx`(on/send)、安全 console、Buffer/URL/fetch/webcrypto/计时器；`process.env` 置空（上游 `:472-505`）。
- 脚本协议 = LX user_api：须 `lx.on('request')` + `lx.send('inited', info)`；缺 handler→`LX_SOURCE_REQUEST_HANDLER_MISSING`；10s 未 inited→`LX_SOURCE_INIT_TIMEOUT`（`:431-446,506-510`）。
- 白名单：源 `kw,kg,tx,wy,mg,local`；动作 `musicUrl,lyric,pic`（`:31-32`）；`gz_` base64+zlib 脚本头（`:418-420`）；5MB 脚本上限。
- 解析器回退链 `resolveMusicUrl`：激活脚本先行→惰性轮换其它已装脚本；默认 6 上限 8 个 resolver；每个 8s；HTTP 12s/action 14s 预算（`:1087-1218`）。
- 音质：词汇 `master/atmos_plus/flac24bit/flac/320k/128k` + 别名表 + 降级链（`:1064-1100`）；每 host 只试 2 候选×2 变体（`:1137-1146`）。
- URL 探测：`Range: bytes=0-131071`，FLAC/WAV/M4A 魔数 + MP3 帧头码率解析；不达标带 `probeWarning` 仍返回，仅 404/410 跳下一 resolver（`:980-1184`）。
- 服务端缓存：musicUrl 90s LRU-120（`:1086-1108`）。
- CRUD：importSource（载入校验失败回滚）、importSourceUrl（URL 或 64-hex APIKEY→`http://ynx.de5.net/API/lx-ynx.php?APIKEY=`，含证书降级）、selectSource、setSourcesEnabled（批量）、checkSources（逐脚本试跑 12s 封顶）、deleteSource(s)（`:560-831`）。
- 元数据：`@name/@description/@version/@author/@homepage` 解析（`:544-558`）。

### 2.2 `lx-search.js`（根目录，≈450 行，移植自上游）
- 五个无 cookie 爬虫：`searchTx/Wy/Kw/Kg/Mg`，含网易 eapi AES-128-ECB、QQ `u.y.qq.com` 签名、咪咕 md5 签名（`:109-261`）。
- 聚合：`Promise.allSettled` + `source|songmid||id` 去重 + 逐源 `failures` 上浮（`:368-411`）。
- 熔断：单源 3 连败→指数冷却封顶 120s，冷却报 `SOURCE_COOLDOWN`；HTTP 尊重 `Retry-After`（`:361-394,66-107`）。
- 搜索缓存 2min/80 条（`:359-375`）。

### 2.3 `server.js` 路由族
新增：`/api/lx-source/{status,resolve,lyric,import,select,toggle,check,delete,search,playlist-search}`、`/api/playlist-square`、`/api/daily-hot`、`/api/platform-charts`、`/api/song-cover-search`。
改造：`/api/platform-playlist/import` 匹配桥改指 lx-search 的 wy 爬虫（替换 `server.js:441` 的 netease 注入）；`/api/audio` 对照上游增强（Range 透传、防 localhost、cookie/referer/UA 白名单 `sanitizePlaybackHeaders`），与我方现有 `server.js:8172` 实现比对合并，不盲换。
安全：全部挂现有 `isTrustedLocalApiRequest` 本地来源校验（09-18 加固口径）。
删除：`/api/lx-source/search|status` 两条 netease 假桩（`server.js:6023-6037`）。

## 3. 前端改造（`public/`）

### 3.1 播放链
- `05-playback/13-playback-start-audio.js:1202-1223` 五条官方 `/song/url` 分支删除，统一 `POST /api/lx-source/resolve {source,quality,musicInfo,excludeResolvers}` → `{ok,url,quality,actual,probeWarning,resolver}` → `/api/audio` 包装。
- 三级失败链（上游 `index.html:32324-32396`）：①失败 resolver 入 `excludedResolvers` 顺序重试 + 死 URL 去重；②穷尽后跨平台换源（name+artist 重匹配成 tx/wy/kg/mg/kw 再 resolve，提示「正在跨平台换源」）；③中途 `audio.onerror`/卡流从当前进度重解析 ≤3 次。
- 客户端缓存 `lxResolvedAudioCache` 90s + 在途去重 + 音质变更失效；开播 700ms 后预取下一曲 resolve。
- `05-playback/14-custom-source-integration.js` 整体退役（IPC 桥与三优先级模式消失）；`11-provider-fallback.js` 骨架保留，底层查询改调 `/api/lx-source/search`；本地文件短路（`playLocalQueueSong`）与 `03c-local-online-match.js` 元数据匹配保留，在线 URL 供给改走脚本解析。

### 3.2 搜索层
- `05-playback/07-search.js` mode tabs：综合/kw/kg/tx/wy/mg/本地；聚合 fan-out 改单次 `/api/lx-source/search?sources=`，逐源 failures 渲染行内错误条。
- `.tag-source` 徽章源键改六家；qs/sp 等平台内容作为参考源（`needsCrossPlatformMatch`），「匹配源，播放会自动换源」文案沿用。
- `00-api-quality-output.js`：退役 provider-VIP 门槛与可重载白名单（`:416-422`）；音质词汇统一 LX 六档+降级链；pill 增 `probeWarning` tooltip（「实际音质已降级」）；本地项不动。

### 3.3 源管理 UI（全部新增）
- 顶栏徽章 `#lx-source-top-right`：启用数/总数，点击开面板。
- 面板 `#lx-source-manager-mask`：逐行「当前/已停用」+ 启用·停用/检查/删除；批量条（全选/批量启停/检查可用性/删除）；「检查」→`/api/lx-source/check`。
- 导入双通道：多 `.js` 文件选择（逐文件校验回执）+「导入链接」弹窗（URL 或 64-hex APIKEY，含「音源会执行代码」安全提示）。不做语法高亮编辑器（上游亦无）。
- 手动切源 chips：`07-search.js` 控制源切换器骨架保留，数据源改 `/api/lx-source/status`。

### 3.4 音乐平台账号 UI 退役（阶段3）
- `08-account/` 音乐平台登录框/cookie 粘贴/VIP 探测展示下线；影视侧登录（TMDB、弹幕站、bangumi 等）不受波及。

## 4. 阶段3 退役清单（逐项 grep 消费方后才准删）

- `server.js`：`/api/search`、`/api/{qq,kugou,qishui,spotify}/*`、`/api/login/*`、`/api/lyric`、`/api/song/like*`、`/api/podcast/*`、`/api/custom-source/*`、`NeteaseCloudMusicApi` require 与 `handleSearch`、五平台 cookie 存储/刷新（`:475-903`）、`qqCookieMusicKey`（`:1657-1665`）。
- 根文件：`kugou-api.js`/`qishui-api.js`/`qq-vip-api.js`/`spotify-api.js`/`qishui-auth-v6.js`/`qishui-qr-login.js`/`qishui-audio-decryptor/`/`qishui-auth-v6/` 摘除；同时从 electron-builder `build.files` 白名单剔除（公开分发减面；勿踩 [[project-win-build-ca]] 漏根文件坑）。
- `desktop/`：`custom-source/` 全目录 14 文件 + main.js 相关 IPC + preload `customSource` 桥；netease 登录分区清理块随凭证体系退役（10-17 双修的分区清理其余平台仍服务影视/账号页则保留——按消费方 grep 定夺）。
- 前端：`03-beat/02-podcast-dj-analysis.js`、播客卡片位（`03a-home-dashboard.js`、`03-content-list-manager.js`）、`14-custom-source-integration.js`、`08-account/` 平台音乐登录段、`00-api-quality-output.js` provider-VIP 段。
- **保留**：`platform-playlist-import.js`（换桥后存活）、本地曲库全链、`/api/audio`、`/api/listen/report`、本地歌单存储 `stellaflix-local-playlists`——只断「写回平台」。

## 5. 错误处理边界

- 服务端终态两文案：`当前音源及备用音源均解析失败` / `没有可用于这首歌的音源` → 复用 `11-provider-fallback.js:532-569` 终态 toast 骨架。
- 未装任何脚本：播放失败并引导打开源管理面板（我方新增态，上游无——公开分发用户不能白屏）。
- `probeWarning` 不阻断仅提示；`SOURCE_COOLDOWN` 在搜索面板逐源展示；import 校验失败回滚不落盘。

## 6. 测试策略（TDD 先行）

- 新增：`tests/lx-source-host.test.js`（假脚本 fixture：协议/白名单/gz_/init 超时/resolver 轮换/降级链/探测判定）、`tests/lx-search.test.js`（五爬虫解析 + 熔断冷却，fetch 注入桩）、`tests/lx-source-routes.test.js`（路由契约）、`tests/lx-playback-chain.test.js`（三级失败链/缓存失效/预取）。
- 回归红线：`tests/bundle-modules.test.js` 计数同步、改模块必 `npm run bundle`（[[project-b1-module-bundles]]）、playlist-import 换桥后既有测试仍绿。
- 全量回归 `npm test`（[[project-guide-sandbox-mismatch]]）；验证走 PORT=3999 防串 3000（[[feedback-no-stray-server-on-3000]]）。
- 每阶段末列真机冒烟清单：搜索/播放/切源/检查可用性/音质降级提示/D 盘脚本持久化/重启后激活源保留。

## 7. 风险与依赖

- 阶段1 最重（≈1700 行新后端 + 测试）；阶段2 是行为切换点，一次提交完成；阶段3 纯删除但误伤面最大，须按消费方逐项销号。
- 首日体验取决于用户是否持有音源脚本——「未装脚本引导」（§5）为必做项。
- 与 WE/封面壁纸等并行在途会话共用 main：遵守 [[project-shared-repo-concurrency]]（子代理禁 git stash -u；stage+校验同命令内完成）。
- 记忆台账注意：[[project-account-login-fixes]]、[[project-music-library-apple-source]] 六源注册表等音乐侧旧结论在阶段3 后失效，完成后须更新。

## 8. 范围外（明确不做）

- `lxmusic://` scheme 与 127.0.0.1:23330 open-API 外部桥：不移植（服务的是外部 LX App 生态，我方无此消费方）。
- 只读 `lx.data.db` 歌单导入：不移植——我方已有 `public/js/platform-playlist-import.js:453-458` 的同型导入通道，重复建设。
- 音源脚本语法高亮编辑器：不做（上游亦无，纯 `<input>`）。
- 影视侧（TMDB/bangumi/弹幕/磁力链）零波及。
