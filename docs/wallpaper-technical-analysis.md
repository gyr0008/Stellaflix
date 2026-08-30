# Stellaflix 壁纸（Wallpaper）技术深度分析报告

> 分析对象：Stellaflix 2.1.0（`C:\Users\Administrator\Desktop\Mineradio-2.1.0`）
> 分析范围：项目与"壁纸 / 桌面背景"相关的全部实现，基于实际代码与结构
> 生成日期：2026-08-03

---

## 一、结论先行

Stellaflix 的"壁纸"能力由**两套相互独立、可并存**的技术路径构成，二者共享同一套 Windows 桌面窗口层级（WorkerW / DWM）操作基础设施：

| 路径 | 技术本质 | 核心文件 | 当前状态 |
|------|----------|----------|----------|
| **A. 全桌面模式（自有可视化器作桌面背景）** | 将 Stellaflix 自己的 Electron 渲染窗口（粒子/歌词舞台）重父化（SetParent）到 Windows `WorkerW` 桌面层 | `full-desktop-mode-runtime.js`、`wallpaper-mode-runtime.js`（`attachWallpaperWindowToDesktop`） | **生产启用**，由"全桌面模式"入口驱动 |
| **B. Steam Wallpaper Engine 集成** | 扫描本机 WE 库、对场景做"静音补丁"、原生启动外部 `wallpaper32/64.exe` 并把其窗口嵌入 Stellaflix 主窗，或以显示捕获回退呈现 | `wallpaper-engine-library.js`、`wallpaper-engine-runtime.js`、渲染层 `public/js/modules/07-fx/03-wallpaper-engine-library.js` | **生产启用**，用户可在 FX 面板选择 WE 壁纸 |

需要特别指出：位于 `desktop/wallpaper-mode-runtime.js` 的 `DesktopWallpaperRuntime` 类（把**单个独立壁纸窗口**附加到 WorkerW）依赖 `wallpaper-preload.js` 与 `public/wallpaper.html`，**这两个文件在仓库中并不存在**，且已被 `package.json` 的 `files` 排除规则显式剔除（`!desktop/wallpaper-preload.js`、`!public/wallpaper.html`，见 `package.json:43-44`）。因此该类是一条**遗留/未启用的死代码路径**，实际桌面背景呈现由 `FullDesktopModeRuntime` 复用其 `attachWallpaperWindowToDesktop` 函数完成。

以下分维度展开。

---

## 二、整体架构与实现原理

### 2.1 路径 A：全桌面模式（WorkerW 重父化）

**原理**：Windows 桌面背景的真实绘制面是位于 `Progman` → `WorkerW` → `SHELLDLL_DefView` 之后的 WorkerW 窗口。Stellaflix 的做法是：

1. 创建一个无边框、不可聚焦、不进任务栏、忽略鼠标事件的 Electron `BrowserWindow`（`wallpaper-mode-runtime.js:439` `createWindow()`）；
2. 通过内联 PowerShell + C# 调用 Win32 原生 API（`workerWAttachScript`，`wallpaper-mode-runtime.js:95`）：
   - `FindWindow("Progman")` → `SendMessageTimeout(0x052C)` 触发 Explorer 创建 WorkerW；
   - `EnumWindows` 定位属于桌面的 `WorkerW`；
   - 修改目标窗口样式（去掉 `WS_POPUP`、加 `WS_CHILD`），`SetParent` 到 WorkerW，使其位于桌面图标之下；
   - `SetWindowPos` 对齐主屏物理像素坐标（已做 DPI 处理）。
3. 生命周期由 `start / update / reconcileDisplay / stop / dispose` 管理，内置 `operation` 代际锁防竞态、display-change 自动重连、abort 控制器（`wallpaper-mode-runtime.js:491-729`）。

**实际入口**：`main.js` 的 `createWallpaperWindow → enableFullDesktopMode`、`positionWallpaperWindow → reconcileFullDesktopMode`，并监听 Explorer 重启（`hookExplorerRestartForFullDesktop`，`main.js:3658`）。其设计改编自上游 `Mineradio-LX-Music`，但原生附加/分离代码已重写（`docs/THIRD_PARTY_PORTS.md:11-16`）。

### 2.2 路径 B：Steam Wallpaper Engine 集成

整体数据流：

```
[发现] 注册表/ libraryfolders.vdf 定位 Steam 库
        → steamapps/workshop/content/431960 (appId=431960)
        → steamapps/common/wallpaper_engine/projects/myprojects
[索引] 遍历 project.json：type(video/image/scene)
        → 媒体文件 / .pkg|.pak 场景包(PKGV签名校验) / preview
        → analyzeSceneProperties 用正则识别"音频属性"并生成静音值
[启动] 选场景 → 静音补丁(缓存副本) → 启动 wallpaper32/64.exe (-control openWallpaper)
        → 原生嵌入 WPEDesktopDX11Window / 或 getDisplayMedia 捕获回退
[运行时] 静音再断言循环 + 视差指针中继(独立PowerShell) + DWM图标分层 + 权限Grant
```

#### 2.2.1 库发现与索引（`wallpaper-engine-library.js`）
- `discoverSteamLibraries()`（`wallpaper-engine-library.js:342`）：读注册表 `HKCU\Software\Valve\Steam` 等 + 候选盘符，再 `readSteamLibraryFolders` 解析 `libraryfolders.vdf` 的 `"path"` 字段；
- `performScan()`（`:683`）：每个源目录找含 `project.json` 的项目，最多扫描 **4000 个目录、深度 2**（`manualProjectDirectories`，`:387`）；
- `indexProject()`（`:439`）：解析 `project.json`，识别 `type`，校验 `.pkg/.pak` 的 `PKGV\d{4}` 头（`validateScenePackage`，`:274`），归类 `safetyMode` 为 `direct-media / native-engine / preview-only`；
- `analyzeSceneProperties()`（`:103`）：用约 10 组正则（音频/静音/分贝/开关/可视等）从 `general.properties` 中识别音频相关属性，自动推导静音值 `muteProperties`（音量=0、静音=true、音频关闭等），最多 256 个属性、64 个选项；
- **媒体服务**：自定义协议 scheme `stellaflix-wallpaper`（`registerWallpaperEngineScheme`），`mediaResponse()`（`:823`）提供带随机 `mediaToken` 校验的 HTTP Range 流式响应（图片/视频），防未授权访问；`normalizeScenePropertyValue`、`isInside` + `realpath` 双重路径穿越防护、`BLOCKED_PROPERTY_KEYS`（防原型污染）构成安全边界。

#### 2.2.2 运行时驱动（`wallpaper-engine-runtime.js`，类 `WallpaperEngineRuntime`）
- **引擎发现/就绪**：`_discoverExecutable` 定位 `wallpaper32/64.exe`；`_ensureEngineReady` 轮询 `engineProcessProbe`（PowerShell 探测进程并按目录匹配，`:277`）；
- **静音场景补丁（核心功能）**：`_prepareMutedScenePackage()`（`:2730`）读取 `.pkg` 内 `scene.json`（`readWallpaperPackageScene` 解析 PKGV 索引，`:158`），`forceSceneAudioSilent` 把每个含 `sound` 字段的对象置 `startsilent=true; volume=0`；**就地二进制补丁**（大小不变约束，`encodePatchedScene` 用空格填充，`:255`），写入 `wallpaper-engine-muted-package-cache`（按 `版本+路径+size+mtime` 的 sha256 缓存，**原文件不变**）；
- **原生嵌入**：`start(id)` 启动场景后 `embedActiveWindow()`（`:3595`）用 C# 原生脚本（`nativeWindowControlScript`）把 WE 的 `WPEDesktopDX11Window`/`WPELiveWallpaper` 窗口对齐宿主主窗（含 `SetWindowRgn` 圆角），最多 3 次尺寸校正；
- **视差指针中继**：`nativeParallaxPointerRelayScript` + `pointerRelaySpawn` 启动**长驻 PowerShell 进程**，把 WE 窗口鼠标移动（`WM_MOUSEMOVE`）转发给 WE 进程实现鼠标视差（上限 120fps，带节流/合并/背压，`:2437-2512`）；
- **显示捕获回退**：当无法原生嵌入时，`confirmCaptureReady()` + 渲染层 `getDisplayMedia` 捕获 WE 窗口，在主窗 `#wallpaper-engine-layer` 的 `<video>`/`<canvas>` 回放；
- **静音再断言**：`INITIAL_MUTE_RETRY_DELAYS_MS` / `MUTE_REASSERT_DELAYS_MS`（`:33-35`）持续把静音值写回，对抗 WE 自身覆盖；
- **签名校验**：`signatureScript`（`:263`）用 `Get-AuthenticodeSignature` 校验 WE 二进制（Skutta Software）签名；
- **权限隔离**：捕获 `grant` 机制（`createWallpaperEngineCaptureGrant`/`clearWallpaperEngineCaptureGrant`，`main.js:796-821`），`display-capture`/`media` 权限仅在 grant 匹配时放行，fail-closed。

### 2.3 渲染层呈现（`public/.../03-wallpaper-engine-library.js` + `index.html`）
- DOM：`#wallpaper-engine-layer`（含 `img`/`video`/`canvas#wallpaper-engine-freeze`）、`#wallpaper-engine-glass-sampler`、`#wallpaper-engine-modal`（库浏览）；
- 状态机：管理项目网格、搜索、收藏/隐藏、选择（`kind==='engine'`）、捕获流 `wallpaperEngineCaptureStream`、freeze 帧（`drawImage` 首帧到 canvas 做占位/冻结，`:351-373`）、`dwm-thumbnail` 与 `dwm-glass-svg-sampler` 两种取样模式；
- 指针活动转发到主进程（`wallpaperEnginePointerActivityReady` 等），与运行时指针中继双向配合。

---

## 三、核心功能与职责

1. **桌面视觉沉浸**：把音乐可视化器（路径 A）或用户自选 WE 壁纸（路径 B）作为真实桌面背景，而非普通窗口。
2. **音乐/壁纸音轨冲突消除（B 独有且关键）**：自动识别并静音 WE 场景自带音轨，避免"音乐播放器 + 壁纸自带 BGM"双重声音；通过补丁缓存 + 再断言循环保证持久静音。
3. **WE 生态接入**：无侵入地复用用户已购买的 Steam 创意工坊壁纸，无需把 WE 资源打包进应用。
4. **共存编排**：路径 A 与 B 可在"全桌面模式"下共存（`syncWallpaperEngineWithFullDesktopMode`，`main.js:1328`），并控制桌面图标分层（`updateDwmDesktopIconLayering`，`:2064`）。
5. **安全呈现外部内容**：媒体流 token 校验、权限 grant、原型污染防护、路径穿越防护、二进制签名校验。

---

## 四、关键组件与模块依赖

| 模块 | 职责 | 关键依赖 |
|------|------|----------|
| `wallpaper-engine-library.js` | WE 库发现、索引、场景属性分析、安全媒体流 | `protocol` 自定义 scheme、`fs`/`reg.exe`、Steam 注册表 |
| `wallpaper-engine-runtime.js` | WE 进程驱动、静音补丁、原生嵌入、指针中继、捕获回退 | `child_process`(spawn)、PowerShell/C# 内联、Node `fs` 流 |
| `wallpaper-mode-runtime.js` | `attachWallpaperWindowToDesktop` + 遗留 `DesktopWallpaperRuntime` | `powershell.exe`、Win32 `user32.dll` |
| `full-desktop-mode-runtime.js` | 全桌面模式生命周期，复用上面的 attach | `attachWallpaperWindowToDesktop`、BrowserWindow |
| `public/.../03-wallpaper-engine-library.js` | 渲染层库 UI/捕获/冻结/玻璃取样 | `navigator.mediaDevices.getDisplayMedia`、DOM、主进程 IPC |
| `main.js` | 实例化三者、IPC handler、与全桌面模式/存储/托盘耦合 | 上述全部 + `app`、`BrowserWindow`、`globalShortcut`、托盘 |

**外部第三方强依赖**：Steam（`431960`）、Wallpaper Engine 二进制（`wallpaper32/64.exe`、类名 `WPEDesktopDX11Window`/`WPELiveWallpaper`、签名 `Skutta Software`）、Windows 桌面窗口层级。

---

## 五、性能表现与资源占用

### 5.1 计算/IO
- **库扫描**：并发有 `generation` 保护，`CACHE_TTL_MS=30s`（`wallpaper-engine-library.js:13`），目录扫描上限 4000、深度 2，避免卡死；
- **场景包解析**：只读索引前 **16MB** + `scene.json`（≤32MB），对象图遍历深度 128、节点 **250k** 上限（`wallpaper-engine-runtime.js:38-42, 217`），防膨胀炸弹；
- **媒体流**：Node `fs.createReadStream` + Range，不全量载入内存（`:874`）。

### 5.2 存储占用
- **静音场景缓存**：每个被启用的 WE 场景在 `wallpaper-engine-muted-package-cache` 生成一个与原 `.pkg` 等大的副本，可能数十 MB/场景；主进程已将其纳入"管理的总字节"存储统计（`main.js:386-420` `directoryUsageBytes`），但**代码层无 LRU/容量上限淘汰**，仅按 `size+mtime` 校验复用。

### 5.3 运行时资源
- **显示捕获回退（`getDisplayMedia`）**：持续 GPU 合成 + 主渲染进程持续绘制 `<video>`/`<canvas>`，开销显著高于原生嵌入；低端机（`docs/LOW_SPEC_OPTIMIZATION_DOCTRINE.md` 关注对象）压力明显；
- **指针中继**：每个 WE 会话一个长驻 PowerShell 进程，120fps 上限持续 `WM_MOUSEMOVE`；
- **再断言循环**：静音值持续回写，空闲也有周期性原生调用。

---

## 六、与其他系统模块的耦合关系

1. **全桌面模式（强耦合）**：路径 B 的 `enableFullDesktopMode` 明确要求"不能暂停已运行的 WE 会话"（`main.js:1347` 注释）；DWM 图标分层、可见性挂起/恢复（`suspend/resumeWallpaperEngineForHiddenHost`）与全桌面模式状态机双向联动；
2. **存储/设置模块**：静音缓存目录计入用户数据占用统计，在设置页"管理的存储"呈现；
3. **FX/可视化模块**：渲染层 `03-wallpaper-engine-library.js` 与粒子/歌词舞台（`02-visual`、`06-lyrics`）共享主渲染进程与 GPU，启用 WE 背景会与之争夺合成资源；
4. **托盘/快捷键**：`Escape` 退出全桌面模式（`registerFullDesktopEscapeShortcut`，`main.js:1254`）同时影响 WE 会话；
5. **权限系统**：`display-capture`/`media` 权限被 WE grant 机制 hijack，影响整个渲染进程捕获能力。

这种耦合是**功能性必然**（壁纸本就要改变桌面与窗口层级），但缺乏跨平台抽象层，Windows 专属逻辑散落在主进程与两个 runtime 中。

---

## 七、当前技术局限与潜在风险

1. **平台锁定（最高风险）**：全部路径仅 `win32` 可用（WorkerW、DWM、`powershell.exe`、C# inline、`wallpaper32/64`）。`DesktopWallpaperRuntime.isSupported()` 非 Win32 直接返回 false，WE 集成在其它平台完全失效。
2. **Windows 版本/桌面层级耦合**：依赖于未文档化的 `Progman 0x052C`、`WorkerW`、`WPEDesktopDX11Window` 类名、`SetWindowRgn` 圆角。Windows 更新或 Explorer 行为变化可使其失效（项目已用 Explorer 重启 hook 缓解，但属被动应对）。
3. **第三方版本漂移**：WE 升级若改 appId 之外的进程名、窗口类名、签名主体或 `-control` 协议，即静默失效；类名/签名均硬编码。
4. **启发式静音的误判风险**：`analyzeSceneProperties` 全靠中英正则匹配属性名/标签（`:16-22`），对命名不规范或非中英项目可能漏判/误判；再断言循环只能"尽力"。
5. **维护/审计成本高**：大量 C#/PowerShell 经 base64 内联（`controlBrokerScript`/`nativeWindowControlScript`/`signatureScript` 等），不可读、难单测、难审查；二进制就地补丁（大小不变约束）限制了对 `scene.json` 的某些结构性修改。
6. **Dead code 歧义**：`DesktopWallpaperRuntime` 依赖不存在的 `wallpaper-preload.js`/`wallpaper.html`，属遗留路径，易误导维护者。
7. **资源治理缺失**：静音缓存无容量上限；捕获回退的 GPU 开销在低端设备未做自动降级。

---

## 八、优化方向与改进建议

1. **清理遗留代码**：将 `DesktopWallpaperRuntime` 明确移除或补全 `wallpaper-preload.js`/`wallpaper.html` 并接入构建；否则在文档/注释中标为"实验性未启用"，消除歧义。
2. **原生脚本工程化**：把内联 C#/PowerShell 抽取为独立 `.ps1`/`.cs` 文件（或 Rust/Go 原生插件），加入单元测试与 CI 静态检查，降低 base64 黑盒风险。
3. **缓存治理**：为 `wallpaper-engine-muted-package-cache` 引入 LRU/访问时间淘汰与容量上限；在设置页提供"清理 WE 静音缓存"显式入口（当前仅有统计无清理）。
4. **捕获回退优化**：优先 `DWM thumbnail`（`dwm-thumbnail` 模式）而非 `getDisplayMedia`，降低 GPU 占用；对冻结帧已做 `freezeScale≤3840` 限制，可进一步按设备性能动态降采样。
5. **静音识别增强**：在启发式之外，开放用户手动覆盖/白名单音频属性（详情抽屉已有"项目设置"，可加"音频属性手动指定"），减少误判。
6. **平台抽象层**：把 Windows 专属逻辑收口到统一接口（如 `DesktopBackgroundAdapter`），为 Linux/macOS 提供"仅窗口可视化器"的降级实现，避免散落。
7. **契约测试**：新增针对 WE 类名/签名/`-control` 协议的契约测试与场景包补丁 fuzz 测试（`tests/` 已有很多 wallpaper/desktop 用例，可扩展），在 WE 版本变更时尽早报警。
8. **低端机自适应**：依据 `docs/LOW_SPEC_OPTIMIZATION_DOCTRINE.md` 的既有框架，在检测到低配时自动降低捕获回退帧率、关闭指针中继或回退到 `direct-media`/纯预览模式。

---

## 附：关键证据文件索引

- `desktop/wallpaper-engine-library.js` — 库发现/索引/媒体流（`:342` `:439` `:103` `:823`）
- `desktop/wallpaper-engine-runtime.js` — 进程驱动/静音补丁/嵌入/指针中继（`:2730` `:3595` `:2301` `:158`）
- `desktop/wallpaper-mode-runtime.js` — `attachWallpaperWindowToDesktop` / 遗留 `DesktopWallpaperRuntime`（`:95` `:439` `:491`）
- `desktop/full-desktop-mode-runtime.js` — 全桌面模式（`:5` `:203` `:464`）
- `desktop/main.js` — 实例化与 IPC（`:159-186` `:1328` `:3969-4220` `:3658`）
- `public/index.html` — `#wallpaper-engine-layer` 等 DOM（`:66-72` `:1657`）
- `public/js/modules/07-fx/03-wallpaper-engine-library.js` — 渲染层状态机/捕获/冻结（`:351` `:667` `:1254`）
- `docs/THIRD_PARTY_PORTS.md` — 全桌面模式上游改编说明（`:11-16`）
- `package.json` — 打包排除死代码路径（`:43-44`）
