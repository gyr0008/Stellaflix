# 汇联页 BT 磁力播放改造 — 设计文档

日期：2026-09-30
状态：已经用户逐节确认（①-⑥）
范围：`public/video/`、`public/index.html`、`public/video/player.css`、`desktop/`（download-manager / mpv-controller / ipc-video / preload-video / video-config）

## 1. 背景与目标

汇联页旧实现（自研 MSE 流控 + 多源适配器契约层）已于 index.html 注释下线，页面退化为「功能维护中」占位。审查发现旧实现存在 P1 问题（双占位壳注册冲突、CORS 缺失、凭据明文、MSE blob 泄漏等，详见 §9）。

本改造将汇联页重定位为：**粘贴磁力链接 / 上传 .torrent 文件 → qBittorrent 顺序下载 → mpv 嵌入播放的最小闭环**，并全量归档旧实现。

## 2. 决策记录（用户已确认）

| # | 决策 | 选项 |
|---|------|------|
| D-1 | 播放内核 | mpv 嵌入（qBt 顺序下载 + mpv `--wid`），放弃浏览器 MSE |
| D-2 | 旧实现清理 | 全量归档（9 文件进 `public/video/_archive/`，`desktop/protocol-adapters.js` 不动） |
| D-3 | 功能范围 | 最小闭环 + 多文件选择；不做限速/做种管理/保存路径设置 |
| D-4 | 非桌面环境 | 优雅降级提示，输入区禁用 |
| D-5 | 播控 UI | 站内 HTML 控件桥接 mpv IPC（B1），非 mpv 原生 OSC |
| D-6 | qbt 口令随机化 | 纳入本批（§7） |

## 3. 现状基建（取证，勿重复造）

- `desktop/download-manager.js`：qBt 便携版进程管理 + Web API 封装（add/list/files/delete/progress）。加任务已内建 `sequentialDownload=true + firstLastPiecePrio=true + seedingTimeLimit=0`（:144-148）。
- `desktop/mpv-controller.js`：mpv JSON IPC；`createOverlay`（:400）起无边框透明置顶子窗口承载 mpv 画面，鼠标穿透；`createPlayer` exclusive 默认杀旧实例（:144-146）。
- `desktop/preload-video.js`：桥已挂主窗口（`desktop/preload.js:213`），渲染层经 `window.stellaflixVideo.{player,download,ffmpeg}` 调用；目前渲染层零消费方，本页为第一个。
- IPC 统一返回 `{ok:true,data}` / `{ok:false,error}`（ipc-video.js:34-95）。

## 4. 架构与数据流

```
输入区(磁力文本 / .torrent 文件)
  └─ add 任务
      ├─ 磁力: download.addTorrent({url})            [现成]
      ├─ 文件: download.addTorrent({torrentBase64})  [桌面补丁 D2]
      └─ 认领 hash：add 无返回 hash → 轮询 download.list() 按 magnet url 匹配；
         认领前行状态 =「解析中 / 等待元数据」
任务列表（2s 轮询 download.list + getProgress）
  └─ 行：名称 / 状态 / 进度% / 速度 / 展开文件列表(download.files)
      └─ 文件行「播放」钮：progress ≥ 5% 才点亮（可播阈值，宁保守）
播放
  ├─ player.createOverlay({url: content_path, x,y,w,h=页面视频容器矩形})
  ├─ 控件条（HTML）：暂停/继续 command set pause、seek 经 mpv-seek、
  │   音量 set_property volume、进度 onEvent time-pos/duration、
  │   end-file 事件 → 播完面板
  └─ 播完面板：「删任务+删文件」= player.stopAndClean(id) + download.delete(hash,true)
布局同步
  └─ 桌面补丁 D1：mpv-overlay-set-bounds(playerId,{x,y,w,h})；
     页面在 mount/resize/滚动/布局变化时节流(≤100ms)同步容器矩形。
     坐标换算约定：渲染层只传视频容器 getBoundingClientRect（CSS px），
     主进程负责加主窗口 getContentBounds 偏移并按 zoom/DPR 换算后 setBounds；
     Windows 显示缩放正确性列入真机冒烟项。
生命周期红线（T158 教训）
  └─ 路由 unmount / 切离汇联 tab / 页面隐藏 → 立即 destroyOverlay（任务保留，仅杀画面）
```

## 5. 文件清单

**归档**（改名加后缀 `.pre-bt-20260930.js`，移入 `public/video/_archive/`）：
huilian-page.js / huilian-providers.js / huilian-stream.js / huilian-provider-{hls,webdav,emby,aliyun,magnet}.js / page-discover.js（共 9 个）

**新建**：
- `public/video/huilian-page.js`（≤350 行）：页面 + 播控件条；router 注册 `{id:'discover', title:'汇联'}` 不变，导航/语音/agent 入口零改动。

**修改**：
- `public/index.html`：删除 :2147-2155 注释块，原 page-discover.js 挂载位改为新 huilian-page.js。
- `public/video/player.css`：报废的 `.huilian-*` 样式带（:1737-1763）改写为本页样式。
- `desktop/ipc-video.js` + `desktop/preload-video.js`：新增 D1 `mpv-overlay-set-bounds` 通道。
- `desktop/mpv-controller.js`：`setOverlayBounds(playerId,{x,y,w,h})`（overlay win.setBounds + 参数校验，约 15 行）。
- `desktop/download-manager.js`：D2 `addTorrent` 支持 `torrentBase64`（multipart file 字段上传，约 10 行）。
- `desktop/video-config.js`：D3 随机口令读写（§7）。

## 6. 错误处理

- 所有 IPC `{ok:false,error}` → 页面顶部单通道提示条（不用原生 dialog）。
- qbt 启动失败（exe 缺失 / 8080 占用 / 超时）→ 横幅「下载器启动失败：<原因>」，输入仍受理，下轮轮询自动重试 start。
- mpv 错误事件 / 进程意外退出 → 播控条降级为「重试 / 换文件」，不清理下载任务。
- 非桌面环境（`!window.stellaflixVideo?.download`）→ 输入区禁用 + 「此功能需在 Stellaflix 桌面版中使用」。

## 7. 安全（D-6）

qbt WebUI 现硬编码 `admin/adminadmin`（package.json:141-144），本机任意进程可操纵下载器并向磁盘写文件。改造：首次启动生成随机口令 → 写入 qbt portable ini（`--configuration=qbt-portable` 配置目录）→ `_http` 认证读同一值；口令存 userData，不进 git。package.json 默认值仅作首启前的兜底删除。

## 8. 测试策略

- **渲染层契约测**（node vm + mock `window.stellaflixVideo`，沿用现有 public/video 模块测法）：
  1. 磁力认领：list 匹配 url → hash 状态机（解析中→已认领）
  2. 可播阈值：progress<5% 禁用、≥5% 点亮
  3. addTorrent 参数形状（magnet vs torrentBase64）
  4. 非桌面降级分支
  5. unmount 必调 destroyOverlay（红线契约）
- **桌面层**：D2 multipart 表单形状测（HTTP mock）；D1 bounds 参数校验测。
- **全量回归**：`npm test`（基线 145/146，唯一已知败=watch-history D1 存量）。
- **真机冒烟（用户手动）**：磁力→解析→播放→overlay 跟随主窗移动→切页杀画面留任务→播完删任务删文件→.torrent 上传→浏览器降级提示。

## 9. 顺带清除的审查发现（P1 对照）

- 双占位壳 id 冲突 → page-discover.js 与旧壳一并归档，单注册源。
- 旧页缺 `setBrowseChrome(true)` 回归风险 → 新页 mount 内显式调用（T157 约定）。
- MSE blob 泄漏 / HLS 无代理 / 凭据明文 emby:// → 旧实现整体归档，自然消除。
- 来源识别过宽（isMediaServer/isWebDav）→ 契约层归档。

## 10. 超出范围（明确不做）

限速、做种保留策略、保存路径设置 UI、多实例并行播放、RSS 自动追、磁力元数据预览（选文件以 qbt files API 为准）、网页端（非桌面）BT 能力。
