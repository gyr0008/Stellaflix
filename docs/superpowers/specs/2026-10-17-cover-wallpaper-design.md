# 封面壁纸（Cover Wallpaper）设计规格

日期：2026-10-17　来源：Mineradio-2.5.1 壁纸模式逐文件审计（见实施计划引用）

## 目标

移植 Mineradio"壁纸模式"= 封面光晕粒子壁纸（2D canvas：渐变底 + 居中封面模糊光晕 + 椭圆轨道粒子 + 径向光晕），
双承载面互斥切换：**播放器背景板**（本窗口最底层 canvas）与 **桌面壁纸层**（WorkerW 后独立覆盖窗口）。

## 与既有功能的关系（主人裁定）

1. 与"完整桌面模式"（`fx.wallpaperMode`，整窗进桌面层）**是两个独立功能**；新功能全部用独立命名，不复用其 fx 键、IPC 通道、运行时实例。
2. `payload.preset` **照搬**：全链传输，画面不分支（Mineradio 即如此，前向兼容字段）。
3. 桌面层挂接**复用已写好的稳健链**：`desktop/wallpaper-mode-runtime.js` 的 `DesktopWallpaperRuntime`（挂接校验/reconcileDisplay/代际锁/abort 全部现成），不抄 Mineradio 的一次性 PowerShell。
4. 开关放 **实验功能组**（fx 控制台 `09-console-workspace.js` experimental 组），同时在特效面板有 DOM 开关。

## 命名契约

| 项 | 值 |
|---|---|
| fx 键 | `coverWallpaper`(false) / `coverWallpaperSurface`('desktop'\|'board'，默认 'desktop') / `coverWallpaperOpacity`(1，0.35–1) |
| 画面模块 | `public/js/cover-wallpaper-effect.js`，导出 `window.createCoverWallpaperEffect(canvas)` → `{applyState,setPaused,dispose}` |
| 接线模块 | `public/js/modules/02-visual/18-cover-wallpaper.js` |
| 背景板画布 | `#cover-wallpaper-board`（index.html 中位于 `#custom-bg` 之前）+ `body.cover-wallpaper-board-active` |
| 桌面层页面 | `public/cover-wallpaper.html`（只挂状态桥，禁止重复实现 draw） |
| 主进程模块 | `desktop/cover-wallpaper-runtime.js`（实例化 DesktopWallpaperRuntime + 注册 IPC） |
| IPC | invoke：`stellaflix-cover-wallpaper-set-enabled` / `-update` / `-get-status`；广播：`stellaflix-cover-wallpaper-runtime-state`；覆盖窗口内通道沿用 DesktopWallpaperRuntime 的 `stellaflix-wallpaper-state`（窗口隔离，无冲突） |
| preload API | `desktopWindow.setCoverWallpaperMode/updateCoverWallpaperMode/getCoverWallpaperModeStatus/onCoverWallpaperModeState` |

## 关键机制（源自 Mineradio 审计，逐字移植口径）

- 画面：`alpha:false`、DPR≤1.35、粒子 `clamp(420, w*h/4200, 760)`、播放 RAF / 空闲 30fps / 关闭 1Hz 心跳、`document.hidden` 暂停。
- 推送节流（渲染器侧）：260ms 最小间隔；签名（不含 colors）相同则 1400ms 内抑制。
- 两态互斥单一真源：`applyCoverWallpaperState` 中未选中一侧必发 `{enabled:false}` 并清推送签名；背景板实例切走即 dispose（不 parked）；挂载/淡入分两帧。
- 颜色：读现成 `desktopOverlayColors()`（歌词舞台调色板消费者）；封面 `currentDesktopSongMeta()`。
- 持久化：三个键随 `saveLyricLayout` 存读（与完整桌面模式"本次启动有效"不同，封面壁纸重启后恢复）。
- 平台：桌面层仅 win32（`DesktopWallpaperRuntime.isSupported()`）；背景板全平台。

## 门禁约束（不可违反）

- `scripts/quick-check.js` 禁止 **desktop/main.js** 出现 `DesktopWallpaperRuntime`、`wallpaper-mode-runtime`、`wallpaper.html`、`wallpaper-preload.js` 字样 → 新主进程接线全部放 `desktop/cover-wallpaper-runtime.js`，main.js 只 require 新模块名；页面名字符串不进 main.js。
- 旧资产 `public/wallpaper.html`、`desktop/wallpaper-preload.js` 继续缺席（quick-check 存在性断言不动）。
- 前端模块改动必跑 `npm run bundle`；全量回归 `npm test`（基线 192/192）。
