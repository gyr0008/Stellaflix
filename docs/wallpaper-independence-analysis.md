# Stellaflix 壁纸模块独立性分析（耦合关系专项）

> 配套文档：`docs/wallpaper-technical-analysis.md`（整体技术分析）
> 生成日期：2026-08-03
> 结论：**壁纸（Wallpaper）不是独立功能模块，它与项目多个核心系统存在深度双向耦合。**

---

## 一、结论摘要

项目中的"壁纸"相关代码**不构成一个可独立部署、低耦合的功能模块**。它由两个运行时构成（Wallpaper Engine 集成 + 全桌面模式/WorkerW 桌面背景），二者不仅彼此交互，还深度依赖以下项目内系统：

- **主进程 `main.js`**（实例化、IPC、权限、生命周期编排）
- **全桌面模式 `FullDesktopModeRuntime`**（共享桌面窗口层级基础设施、互斥/共存编排）
- **Electron 渲染层 + FX 可视化模块**（共享主渲染进程与 GPU、DOM 容器）
- **存储/设置模块**（用户数据路径、缓存字节统计、FX 自动保存）
- **托盘 / 全局快捷键模块**（Escape 退出、托盘菜单）
- **内存/电源管理模块**（GPU 诊断、`powerMonitor`、内存裁剪调度）

下面按"它调用或共享了什么"逐条列证。

---

## 二、壁纸模块内部边界

| 单元 | 文件 | 角色 |
|------|------|------|
| `WallpaperEngineLibrary` | `wallpaper-engine-library.js` | WE 库发现/索引/安全媒体流协议 |
| `WallpaperEngineRuntime` | `wallpaper-engine-runtime.js` | WE 进程驱动、静音补丁、原生嵌入、指针中继、捕获回退 |
| `attachWallpaperWindowToDesktop` | `wallpaper-engine…wallpaper-mode-runtime.js` | Win32 WorkerW 重父化（C#/PowerShell 内联） |
| `FullDesktopModeRuntime` | `full-desktop-mode-runtime.js` | 全桌面模式生命周期（复用上面的 attach） |
| 渲染层状态机 | `public/js/modules/07-fx/03-wallpaper-engine-library.js` | 库 UI、捕获、冻结、玻璃取样 |
| DOM | `public/index.html` `#wallpaper-engine-*` | 呈现容器 |

---

## 三、与项目其他模块的依赖/交互（重点）

### 3.1 与 `main.js`（强耦合，控制中枢）
`main.js` 不是"被壁纸调用"，而是**壁纸能力的编排者**，体现为：
- 实例化所有壁纸运行时（`main.js:159-186`：`wallpaperEngineLibrary` / `wallpaperEngineRuntime` / `fullDesktopModeRuntime`）；
- 注册自定义协议 scheme（`registerWallpaperEngineScheme(protocol)`，`main.js:33`）；
- 暴露约 **20 个 IPC 通道**供渲染层调用（已查证）：
  - 库与场景：`stellaflix-wallpaper-engine-list`、`-project-details`、`-choose-directory`、`-choose-project-file`、`-remove-directory`、`-runtime-status`、`-start-scene`、`-stop-scene`、`-capture-result`、`-prepare-glass-capture`、`-activate-dwm-surface`
  - 自有壁纸：`stellaflix-wallpaper-set-enabled`、`-wallpaper-update`、`-wallpaper-get-status`
- 接管并显示捕获权限：`isTrustedWallpaperEngineDisplayCapturePermission` / `isTrustedWallpaperEnginePreparationMediaPermission`（`main.js:841-863`）——**壁纸 hijack 了整个渲染进程的 `display-capture`/`media` 权限判定**，影响任何需要捕获的模块；
- 权限 grant 生命周期：`createWallpaperEngineCaptureGrant` / `clearWallpaperEngineCaptureGrant`（`main.js:783-821`），带一次性 session 校验，fail-closed。

### 3.2 与全桌面模式 `FullDesktopModeRuntime`（双向强耦合）
这是最关键的"非独立"证据：
- **共享底层基础设施**：`full-desktop-mode-runtime.js:5-7` 直接 `require('./wallpaper-mode-runtime')` 并复用 `attachWallpaperWindowToDesktop`（`full-desktop-mode-runtime.js:464`）。即"自有桌面背景"与"WE 嵌入"建立在**同一套 Windows 桌面层级操作**之上；
- **互斥/共存编排**：`syncWallpaperEngineWithFullDesktopMode()`（`main.js:1328`）在每次全桌面模式状态变更（enable/disable/resize）时主动同步 WE 会话；`start-scene` 处理器（`main.js:4092, 4146`）读取 `fullDesktopModeRuntime.getStatus()` 决定能否启动、是否叠加图标分层；
- **Z-order 协作**：嵌入后调用 `fullDesktopModeRuntime.ensureIconLayerOrder()`（`main.js:4151`）维护桌面图标与 WE 窗口的层级；
- **可见性挂起**：`prepareWallpaperEngineProjectPreviewBeforeDesktopEmbedding`（`main.js:1040`）在全桌面模式被动态下暂停 WE 可见宿主；
- **快捷键共享**：`registerFullDesktopEscapeShortcut()`（`main.js:1254`，全局 `Escape` 退出全桌面模式）同时作用于 WE 共存态（`main.js:1300-1301`）。

### 3.3 与渲染层 / FX 可视化模块（共享进程与资源）
- 渲染层模块 `03-wallpaper-engine-library.js` 运行在**主 Electron 渲染进程**中，与粒子/歌词舞台（`02-visual`、`06-lyrics`）、FX 面板（`07-fx`）**共享同一 GPU 合成上下文与事件循环**；
- 壁纸层 DOM（`#wallpaper-engine-layer` 的 `<video>`/`<canvas>`）位于主界面层级之下；启用 WE 背景即持续占用主渲染进程绘制预算；
- 渲染层通过 `window.__stellaflixPrepareWallpaperEngineCapture` 等注入函数回调主进程准备捕获（`main.js:877, 916, 949, 983`）；
- 主窗尺寸/圆角/物理像素边界经 `wallpaperEnginePhysicalContentBounds` / `wallpaperEngineHostCornerRadius`（`main.js:221, 212`）传给 WE 嵌入——即依赖主窗口几何，而非自管理。

### 3.4 与存储 / 设置模块（数据耦合）
- 用户数据根：`WallpaperEngineLibrary({ userDataPath: STABLE_USER_DATA_PATH })`（`main.js:159`）依赖主进程的**稳定用户数据路径解析**；
- 缓存字节计入"管理的存储"：静音场景缓存 `wallpaper-engine-muted-package-cache` 被 `directoryUsageBytes` 统计进 `totalManagedBytes`（`main.js:386-420`），与歌词/Chromium/beatmaps 并列呈现在设置页；
- FX 自动保存：`stellaflix-current-fx-autosave-*`（`main.js:4554-4566`）与壁纸选择状态（`kind==='engine'`）同处于 FX 持久化通道。

### 3.5 与托盘 / 全局快捷键 / 内存电源模块
- 托盘菜单的"退出桌面模式"项（`main.js:2034`）直接驱动 `disableFullDesktopMode`，影响 WE 共存；
- `globalShortcut` 的 `Escape` 与 `sendGlobalHotkeyAction` 与全桌面/壁纸状态联动（`main.js:1254-1291, 1683-1699`）；
- `wallpaperEngineTargetFps`（`main.js:202`）依据 GPU 诊断调帧率，依赖 `stellaflix-get-gpu-diagnostics`；`powerMonitor` 与 `scheduleAppMemoryTrim`（`main.js:5438`）在挂起/托盘态裁剪内存，覆盖壁纸相关资源；
- 应用退出/重启：`stellaflix-desktop-lyrics-*`、`stellaflix-restart-app`（`main.js:4645, 4635`）与壁纸状态清理存在时序耦合。

### 3.6 与外部第三方（架构上不属于项目，但属于运行时依赖）
Steam（`431960`）、Wallpaper Engine 二进制（`wallpaper32/64.exe`、类名 `WPEDesktopDX11Window`/`WPELiveWallpaper`、签名 `Skutta Software`）、Windows 桌面窗口层级。这些是"项目之外的依赖"，进一步说明壁纸模块本身无法自包含。

---

## 四、若强行"独立"会怎样（耦合强度验证）

- 删除 `wallpaper-engine-*` 与 `full-desktop-mode-*` 任一运行时，**会同时破坏另一路径**（共享 `attachWallpaperWindowToDesktop`）；
- 删除 `main.js` 中的 IPC 与 grant 逻辑，渲染层壁纸 UI 全部失效（渲染层无独立进程）；
- 移除全桌面模式，WE 嵌入的"桌面背景"语义与图标分层即失去承载；
- 移除存储模块，静音缓存与用户目录管理立即报错。

这说明壁纸在**进程模型、窗口层级、权限、存储、UI 渲染**五个维度均与宿主强绑定，而非插件式独立模块。

---

## 五、潜在耦合风险（即便确认非独立，仍需点明）

1. **权限 hijack 范围过大**：壁纸的 `display-capture`/`media` 权限接管是全局性的，任何未来需要屏幕捕获的模块都会受其 grant 状态影响，存在意外放行/拦截风险。
2. **共享进程资源争用**：壁纸与主可视化器同在主渲染进程，低端机下 GPU 预算被双向挤压，缺资源隔离。
3. **跨模块状态耦合**：壁纸状态散落在 `main.js` 的全局变量（`wallpaperEngineHostVisibilitySuspended` 等 30+ 个 `let`），与全桌面模式状态机相互读写，重构风险高。
4. **无抽象边界**：Windows 专属逻辑直接写入主进程，没有"桌面背景适配器"接口，难以在不触碰主进程的前提下移植或测试。

---

## 六、可独立性的改造建议（若要解耦）

1. **抽象桌面背景适配器接口**：把 `attachWallpaperWindowToDesktop`、WE 嵌入、图标分层收口为统一 `DesktopBackdropAdapter`（本地实现 + WE 实现），由主进程通过接口调用，而非散落 `let` 全局变量。
2. **权限作用域收窄**：将 `display-capture` 接管从"全局"改为"按 webContents 来源 + 白名单频道"精确匹配，避免影响其他模块。
3. **状态集中化**：用单一 `wallpaperState` 对象替代 30+ 全局 `let`，并显式声明与 `fullDesktopModeRuntime` 的订阅关系。
4. **渲染进程隔离（长期）**：考虑将 WE 捕获/冻结单独放到 `BrowserView` 或离屏渲染上下文，降低与主可视化器的 GPU 争用。

---

## 附：耦合点证据索引

- `main.js:33` 注册协议；`:159-186` 实例化；`:3969-4328` WE IPC 簇；`:4733-4759` 自有壁纸 IPC
- `main.js:760` 信任校验；`:783-863` 权限 grant 与捕获权限接管；`:1040` 全桌面态下暂停 WE
- `main.js:4092, 4122, 4146, 4151` 与 `FullDesktopModeRuntime` 协作；`:1328` `syncWallpaperEngineWithFullDesktopMode`
- `full-desktop-mode-runtime.js:5-7, 464` 复用 `attachWallpaperWindowToDesktop`
- `main.js:386-420` 缓存计入存储统计；`:212, 221` 主窗几何输入；`:1254-1291` 快捷键共享
- `public/index.html:66-72` 壁纸 DOM；`public/js/modules/07-fx/03-wallpaper-engine-library.js` 渲染层状态机
