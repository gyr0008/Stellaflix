# Wallpaper Engine 兼容模块接入指南（旧版 Stellaflix 分支）

> 配套模块：`desktop/wallpaper-engine-legacy.js`、`desktop/wallpaper-engine-legacy-scene-patch.js`
> 适用目标：Electron ≤ 15 / Node 12 等效、无构建转译链、旧版 Stellaflix 分支
> 原则：**独立兼容模块**，不修改现有壁纸文件；旧版缺失现代 API 时自动降级。

---

## 一、功能用途与预期行为

| 项 | 说明 |
|----|------|
| 用途 | 在旧版 Stellaflix 中复用用户本机已安装的 Steam Wallpaper Engine 壁纸：发现库、索引、静音自带音轨、并以安全媒体流协议供给渲染层。 |
| 预期行为 | 1) 应用启动后自动发现 Steam 库（注册表 + libraryfolders.vdf）；2) 扫描创意工坊/本地项目，识别视频/图片/Scene 三类；3) 对 Scene 包做静音补丁缓存并播放；4) 渲染层通过 `stellaflix-wallpaper-legacy://` 协议安全拉取预览/媒体（带 token）。 |
| 失败时 | 未发现 Steam / WE 未安装 → 返回 `{ ok:false, available:false }`，UI 禁用但**不抛错**；非 Windows → `installProtocol` 仍注册但媒体流路径仅对新版生效，旧版直接 no-op。 |
| 不破坏原有逻辑 | 完整模块独立于现有 `wallpaper-engine-*` 文件；仅由旧版 `main.js` **显式 require** 并接线，新版分支无需引用。 |

---

## 二、兼容性适配对照（已在代码中落实）

| 现代 API（已规避） | 低版本兜底实现 |
|--------------------|----------------|
| `protocol.handle()` | `protocol.registerStreamProtocol()`（回调用 `(request, callback)`，Node Readable 直传） |
| `Response` / `Readable.toWeb` | 返回 `{ statusCode, headers, data: Buffer\|Readable }` |
| 可选链 `?.` / 空值合并 `??` | 全部展开为 `safeGet()` + 显式判空 |
| `Array.prototype.flat` | 递归 `walk` 手工遍历场景对象图 |
| `Object.fromEntries` | `Object.keys().forEach` 手工构造 |
| 异步 `fs.promises` | 优先用 `fs.promises`，缺失时回退回调式 `fs.*`（见 `safeRealpath`） |
| `Buffer.subarray` 等地道用法 | 统一用 `slice`/偏移读取，兼容老 Node |

> 若你的旧分支比 Electron ≤15 更老（如 Node < 12 缺 `Object.entries`），需再补 `Object.keys` 替换与 `Promise` polyfill；本模块已尽量用最保守写法。

---

## 三、核心处理逻辑（入口 → 处理 → 边界）

```
启动 (app ready)
  └─ require 两模块
  └─ new LegacyWallpaperEngineLibrary({ userDataPath })
  └─ library.installProtocol(app.protocol)   // 旧版用 registerStreamProtocol
  └─ ipcMain.handle('stellaflix-wallpaper-legacy-list', list)
  └─ ipcMain.handle('stellaflix-wallpaper-legacy-start-scene', startWithMutePatch)

list:  library.list({force}) → snapshot { projects, count, ... }
startWithMutePatch:
   1) library.list 取得 record
   2) 若是 scene → scene-patch.prepareMutedScenePackage(pkg, cacheRoot) 得静音副本
   3) 交给旧的 WallpaperEngineRuntime（或兼容 Runtime）启动
   4) 失败返回错误码（如 WALLPAPER_SCENE_PACKAGE_PATCH_FAILED），UI 提示，不崩溃
```

### 边界与异常处理清单
- **包体积/条目数上限**：`WALLPAPER_PACKAGE_INDEX_MAX_BYTES=16MB`、`ENTRY_MAX_COUNT=32768`、`SCENE_MAX_BYTES=32MB`、对象图深度 128 / 节点 250k——超限抛错并回退原包。
- **路径穿越防护**：`resolveProjectFile` 用 `realpath` + `isInside` 双重校验；`BLOCKED_PROPERTY_KEYS` 防原型污染。
- **媒体流 token**：每次启动随机 `mediaToken`，URL 必须带 `?token=` 且 `index` 命中，否则 404。
- **静音补丁体积约束**：`encodePatchedScene` 要求 `JSON 长度 ≤ 原始 scene 长度`，否则 `PATCH_TOO_LARGE`（避免破坏 PKGV 索引偏移）。
- **缓存有效性**：`validateMutedScenePackage` 按 `size + 全静音 + 音频对象数` 复校，破损自动重建。
- **跨平台 no-op**：非 `win32` 时 `discoverSteamLibraries` 返回空、`installProtocol` 仍可注册但无源。

---

## 四、可直接集成的代码（旧版 main.js 片段）

```js
// ===== 在旧版 desktop/main.js 顶部（仅在低版本条件引入） =====
const path = require('path');
const { app, protocol, ipcMain } = require('electron');
const { LegacyWallpaperEngineLibrary } = require('./wallpaper-engine-legacy');
const scenePatch = require('./wallpaper-engine-legacy-scene-patch');

const legacyWeLibrary = new LegacyWallpaperEngineLibrary({
  userDataPath: app.getPath('userData')
});
// 旧版 Electron 用 registerStreamProtocol；installProtocol 内部已做特性检测
const protocolReady = legacyWeLibrary.installProtocol(app.protocol);

// ===== IPC：列出壁纸库（与现有 stellaflix-wallpaper-engine-* 风格一致） =====
ipcMain.handle('stellaflix-wallpaper-legacy-list', function (event, payload) {
  return legacyWeLibrary.list({ force: !!(payload && payload.force) }).then(function (snapshot) {
    return { ok: true, projects: snapshot.projects, count: snapshot.count, mediaToken: snapshot.mediaToken };
  }).catch(function (err) {
    return { ok: false, error: String(err && err.message || err) };
  });
});

// ===== IPC：启动某场景并应用静音补丁 =====
ipcMain.handle('stellaflix-wallpaper-legacy-start-scene', function (event, payload) {
  const id = String((payload && payload.id) || '');
  if (!/^[a-f0-9]{24}$/i.test(id)) return Promise.resolve({ ok: false, error: 'WALLPAPER_PROJECT_ID_INVALID' });
  return legacyWeLibrary.list({ force: false }).then(function (snapshot) {
    const record = legacyWeLibrary.index.get(id.toLowerCase());
    if (!record) return { ok: false, error: 'WALLPAPER_PROJECT_NOT_FOUND' };
    let scenePkg = record.scenePackage;
    if (scenePkg) {
      const cacheRoot = path.join(app.getPath('userData'), 'wallpaper-engine-legacy-muted-package-cache');
      try { scenePkg = scenePatch.prepareMutedScenePackage(scenePkg, cacheRoot); }
      catch (e) { return { ok: false, error: 'WALLPAPER_SCENE_PATCH_FAILED:' + (e && e.message) }; }
    }
    // 交给你的旧版运行时启动；此处仅回传路径，由旧版自己 spawn/embed
    return { ok: true, id: id, media: record.media, preview: record.preview, scenePackage: scenePkg, workshopId: record.workshopId };
  }).catch(function (err) {
    return { ok: false, error: String(err && err.message || err) };
  });
});

// ===== 渲染层引用（public/js 中，DOM 容器可复用现有 #wallpaper-engine-layer） =====
// 旧版若不支持 fetch 跨自定义协议，可用 XHR：
//   const url = 'stellaflix-wallpaper-legacy://media/<id>?token=<mediaToken>';
//   const xhr = new XMLHttpRequest(); xhr.open('GET', url); xhr.responseType = 'blob';
```

> 注意：本模块**不包含** Win32 WorkerW 重父化 / 视差指针中继 / 显示捕获回退（那些依赖 Windows 桌面层级 + 内联 C#，与"低版本"无关，是平台特性）。旧版若需"桌面背景"呈现，可沿用你旧分支已有的全桌面模式；若旧分支没有全桌面模式，则本模块仅提供"库 + 静音 + 媒体流"，由你决定呈现方式（如作为本地图片/视频预览）。

---

## 五、与现有代码风格一致性

- 文件头注释块、模块导出 `module.exports`、错误码 `WALLPAPER_*` 命名，均对齐现有 `wallpaper-engine-library.js`；
- IPC 命名沿用 `stellaflix-wallpaper-engine-*`，此处加 `-legacy` 后缀以免与现有通道冲突；
- 同步/异步混合写法与现有 `wallpaper-engine-runtime.js` 的 `fs.openSync`/`fs.promises` 双路径一致。

---

## 六、自测建议（交付前验证）

1. **单元级**：`node -e "require('./desktop/wallpaper-engine-legacy-scene-patch.js')"` 在无 Steam 环境下不应抛错（`readWallpaperPackageScene` 仅在传入合法包时调用）。
2. **库发现**：Windows 装 Steam + WE 后，`library.list()` 应返回 `count>0`；未安装时 `count=0, ok=true`。
3. **媒体流**：用 `stellaflix-wallpaper-legacy://preview/<id>?token=...` 拉取，带错 token 应 404。
4. **静音补丁**：对任一 `type=scene` 项目执行 `prepareMutedScenePackage`，校验缓存副本 `analyzeSceneSilence().allSilent===true` 且原 `.pkg` 字节未变。
5. **降级**：在 Electron ≤15 环境确认 `installProtocol` 走 `registerStreamProtocol` 分支且无报错。
