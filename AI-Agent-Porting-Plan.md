# Mineradio AI 助手完整移植计划

> 源项目: Mineradio-LX-Music-1.6.0 → 目标项目: Mineradio-2.1.0  
> 策略: 路径A — 完整移植（保留全部功能，通过适配层桥接差异）

---

## 一、执行摘要

AI 助手 "小M" 采用三层架构，共 4 个核心文件。经详细依赖分析：

| 维度 | 总数 | 目标已存在 | 需移植 | 移植率 |
|------|------|-----------|--------|--------|
| 全局变量 | 29 | 27 | 2 | 93% |
| 依赖函数 | 92 | 50 | 42 | 54% |
| 核心文件 | 4 | 0 | 4 | 0% |

**结论**: 目标项目已具备大部分底层能力，移植工作量集中在适配层（42 个缺失函数）而非重写。

---

## 二、核心文件清单

### 2.1 源项目文件

| 文件 | 大小 | 角色 | 耦合度 | 移植方式 |
|------|------|------|--------|----------|
| `agent-api.js` | 1063 行 | 服务端 LLM 通信层 | ★☆☆ 低 | 直接复制 |
| `public/js/agent-music-tools.js` | 2454 行 | 客户端工具执行层 | ★★★ 极高 | 复制 + 适配 |
| `public/js/music-agent-command.js` | 2535 行 | UI 层 + 命令编排 | ★★★ 高 | 复制 + 适配 |
| `public/css/music-agent-command.css` | 874 行 | 样式表 | ★☆☆ 低 | 直接复制 |

### 2.2 文件耦合分析

#### agent-api.js — 低耦合，可直接移植

```
createAgentApi(options) ← 工厂模式，依赖注入
  ├── safeStorage      ← 可注入
  ├── fetchImpl        ← 可注入
  └── configFile       ← 可注入
```

- 不直接访问任何全局变量
- 通过 DI 参数接收所有依赖
- 定义 18 个 Tool Schema（与 UI 层解耦）
- 多 Provider 分发: OpenAI / Anthropic / Gemini

#### agent-music-tools.js — 极高耦合，需适配层

```
IIFE 模块 → window.MineradioAgentMusicTools
  ├── 直接读写 ~30 个全局变量
  └── 直接调用 ~80 个全局函数
```

#### music-agent-command.js — 高耦合，需适配层

```
IIFE 模块 → window.MineradioMusicAgentCommand
  ├── 依赖 window.MineradioAgentMusicTools
  ├── 依赖 window.desktopWindow
  ├── 依赖 window.showToast
  ├── 依赖 window.__mineradioAgentAudio
  └── 依赖 window.LyricAnimation
```

---

## 三、全局变量依赖清单

### 3.1 已存在于目标项目（27/29）

| 变量名 | 目标位置 | 用途 |
|--------|----------|------|
| `playQueue` | `00-state/00-core-stores.js` | 播放队列 |
| `currentIdx` | `00-state/00-core-stores.js` | 当前播放索引 |
| `playMode` | `00-state/01-perf-render-state.js` | 播放模式 |
| `targetVolume` | `00-state/03-beat-dj-state.js` | 目标音量 |
| `audio` | `00-state/00-core-stores.js` | Audio 元素 |
| `fx` | `00-state/06-fx-runtime-layout.js` | FX 状态对象 |
| `diyPlayerMode` | `00-state/00-core-stores.js` | DIY 模式 |
| `userPlaylists` | `00-state/00-core-stores.js` | 用户歌单 |
| `immersiveMode` | `00-state/07-ui-playback-runtime.js` | 沉浸模式 |
| `controlsAutoHide` | `00-state/07-ui-playback-runtime.js` | 控制栏自动隐藏 |
| `fxFabAutoHide` | `00-state/07-ui-playback-runtime.js` | FX FAB 自动隐藏 |
| `searchMode` | `00-state/00-core-stores.js` | 搜索模式 |
| `loginProvider` | `00-state/00-core-stores.js` | 当前登录平台 |
| `activeAccountProvider` | `00-state/00-core-stores.js` | 活跃账号平台 |
| `dualAccountMode` | `00-state/00-core-stores.js` | 双账号模式 |
| `qqLoginStatus` | `00-state/00-core-stores.js` | QQ 登录状态 |
| `kugouLoginStatus` | `00-state/00-core-stores.js` | 酷狗登录状态 |
| `qishuiLoginStatus` | `00-state/00-core-stores.js` | 汽水登录状态 |
| `spotifyLoginStatus` | `00-state/00-core-stores.js` | Spotify 登录状态 |
| `neteasePlaylists` | `00-state/00-core-stores.js` | 网易歌单 |
| `qqPlaylists` | `00-state/00-core-stores.js` | QQ 歌单 |
| `kugouPlaylists` | `00-state/00-core-stores.js` | 酷狗歌单 |
| `qishuiPlaylists` | `00-state/00-core-stores.js` | 汽水歌单 |
| `spotifyPlaylists` | `00-state/00-core-stores.js` | Spotify 歌单 |
| `myPodcastCollections` | `00-state/00-core-stores.js` | 播客收藏 |
| `myPodcastItems` | `00-state/00-core-stores.js` | 播客项目 |
| `queueHydrationState` | `00-state/00-core-stores.js` | 队列加载状态 |

### 3.2 目标项目缺失（2/29）

| 变量名 | 源位置 | 处理方案 |
|--------|--------|----------|
| `lxMirrorPlaylists` | `index.html` 内联 | 需移植声明（LX 镜像歌单专用） |
| `playbackTuning` | `index.html` 内联 | 需移植声明（播放调速/变调状态） |

---

## 四、函数依赖清单

### 4.1 目标项目已存在（50/92）

| 函数名 | 目标位置 | 功能分类 |
|--------|----------|----------|
| `applyDiyMode` | `00-state/02-preferences-ui-modes.js` | DIY 模式 |
| `attemptAudioPlay` | `05-playback/14-player-controls.js` | 播放控制 |
| `clearQueue` | `05-playback/14-player-controls.js` | 队列管理 |
| `currentCoverSong` | `05-playback/06-track-detail-lyrics-actions.js` | 曲目信息 |
| `currentPlaybackQualityProvider` | `05-playback/00-api-quality-output.js` | 音质控制 |
| `forcePlaybackControlsInteractive` | `01-scene/04-bottom-controls-cursor.js` | UI 交互 |
| `getProviderPlaybackQuality` | `05-playback/00-api-quality-output.js` | 音质控制 |
| `nextTrack` | `05-playback/14-player-controls.js` | 播放控制 |
| `normalizePlaybackQualityForProvider` | `05-playback/00-api-quality-output.js` | 音质控制 |
| `openCollectModalForCurrent` | `05-playback/06-track-detail-lyrics-actions.js` | 曲目操作 |
| `openCustomLyricModal` | `05-playback/06-track-detail-lyrics-actions.js` | 歌词操作 |
| `openHomeInsight` | `05-playback/05-home-actions.js` | 导航 |
| `openHotkeySettings` | `07-fx/06-hotkeys.js` | 设置 |
| `openLocalBeatModal` | `03-beat/03-local-beat-cache-modal.js` | 节拍器 |
| `openPlaylistPanelTab` | `06-lyrics/01-playlist-panel-shell.js` | 歌单面板 |
| `openTrackDetailModal` | `05-playback/06-track-detail-lyrics-actions.js` | 曲目详情 |
| `openUpdatePanel` | `08-account/00-update-preview.js` | 更新 |
| `playbackQualityLabel` | `05-playback/00-api-quality-output.js` | 音质控制 |
| `playQueueAt` | `05-playback/13-playback-start-audio.js` | 播放控制 |
| `prevTrack` | `05-playback/14-player-controls.js` | 播放控制 |
| `queueSong` | `05-playback/10-queue-actions.js` | 队列管理 |
| `resetFx` | `07-fx/07-bindings-shelf-immersive.js` | FX 控制 |
| `revealBottomControls` | `01-scene/04-bottom-controls-cursor.js` | UI 交互 |
| `runAppMemoryTrim` | `00-state/11-system-memory-controls.js` | 系统 |
| `runSystemMemoryPurge` | `00-state/11-system-memory-controls.js` | 系统 |
| `safeRenderQueuePanel` | `04-shelf/02-rebuild-panel-sync.js` | 面板渲染 |
| `safeShelfRebuild` | `04-shelf/02-rebuild-panel-sync.js` | 面板渲染 |
| `safeSwitchPlaylistTab` | `04-shelf/02-rebuild-panel-sync.js` | 面板渲染 |
| `setFxPanelTab` | `07-fx/05-fx-panel-performance.js` | FX 控制 |
| `setImmersiveMode` | `07-fx/07-bindings-shelf-immersive.js` | 沉浸模式 |
| `setLyricMotionStyle` | `05-playback/06-track-detail-lyrics-actions.js` | 歌词动画 |
| `setPlaybackQuality` | `05-playback/00-api-quality-output.js` | 音质控制 |
| `setVolume` | `05-playback/08-audio-graph-controls.js` | 音量控制 |
| `showToast` | `09-idle-toast-libraries.js` | 通知 |
| `shuffleQueue` | `05-playback/14-player-controls.js` | 队列管理 |
| `startVisualGuide` | `09-idle-toast-libraries.js` | 引导 |
| `toggleControlsAutoHide` | `01-scene/04-bottom-controls-cursor.js` | UI 设置 |
| `toggleFullscreen` | `10-shell/04-desktop-overlay-fullscreen.js` | 全屏 |
| `toggleFxFabAutoHide` | `00-state/02-preferences-ui-modes.js` | UI 设置 |
| `toggleFxPanel` | `07-fx/07-bindings-shelf-immersive.js` | FX 控制 |
| `toggleLyricsPanel` | `06-lyrics/00-lyrics-fetch-parse.js` | 歌词面板 |
| `togglePlay` | `05-playback/14-player-controls.js` | 播放控制 |

### 4.2 目标项目缺失（42/92）— 需从源项目移植

#### 导航类（6 个）

| 函数名 | 源位置 | 功能 |
|--------|--------|------|
| `openPrimaryView` | index.html:25548 | 打开主视图 |
| `openRadioModes` | index.html:25750 | 打开电台模式 |
| `openPlatformRanking` | index.html:25606 | 打开平台排行榜 |
| `focusGlobalSearch` | index.html:25980 | 聚焦全局搜索 |
| `openDailyReviewManager` | index.html:25007 | 每日回顾管理 |
| `openAuthorSupportPanel` | index.html:45137 | 作者支持面板 |

#### 歌单/导入类（7 个）

| 函数名 | 源位置 | 功能 |
|--------|--------|------|
| `openPlatformPlaylistImport` | index.html:29342 | 平台歌单导入 |
| `openLxPlaylistImport` | index.html:30761 | LX 歌单导入 |
| `openPlaylistSelection` | index.html:29690 | 歌单选择 |
| `openLxSourceImport` | index.html:29148 | LX 音源导入 |
| `openLocalFileImport` | index.html:39281 | 本地文件导入 |
| `openLocalFolderImport` | index.html:39299 | 本地文件夹导入 |
| `refreshSharedPlaylistOrderViews` | index.html:23907 | 刷新共享歌单排序 |

#### 播放控制类（8 个）

| 函数名 | 源位置 | 功能 |
|--------|--------|------|
| `seekNowFlowToRatio` | index.html:37242 | NowFlow 跳转 |
| `setPlaybackSpeed` | index.html:8232 | 播放速度 |
| `setPlaybackPitch` | index.html:8239 | 播放变调 |
| `resetPlaybackTuning` | index.html:8253 | 重置调速 |
| `playCurrentBackingTrack` | index.html:29882 | 播放伴奏 |
| `playLxMirrorSong` | index.html:31581 | 播放 LX 镜像歌曲 |
| `primeOnlineAudioForUserGesture` | index.html:29823 | 在线音频预加载 |
| `nfSelectPlayMode` | index.html:37141 | NowFlow 选择播放模式 |

#### UI/面板类（7 个）

| 函数名 | 源位置 | 功能 |
|--------|--------|------|
| `openAudioOutputSettings` | index.html:7923 | 音频输出设置 |
| `openWallpaperPicker` | index.html:41422 | 壁纸选择器 |
| `nfCloseOptionMenus` | index.html:37106 | 关闭选项菜单 |
| `nowFlowWakeControls` | index.html:7098 | 唤醒 NowFlow 控制 |
| `updateNowFlowActions` | index.html:37351 | 更新 NowFlow 动作 |
| `compactLyricPanelSections` | index.html:43571 | 紧凑歌词面板 |
| `scrollFxFeatureIntoPanel` | index.html:43261 | FX 特性滚动 |

#### 数据管理类（5 个）

| 函数名 | 源位置 | 功能 |
|--------|--------|------|
| `ensureLocalUserPlaylistsLoaded` | index.html:28330 | 确保本地歌单加载 |
| `saveLocalUserPlaylists` | index.html:28251 | 保存本地歌单 |
| `loadLxMirrorPlaylists` | index.html:30788 | 加载 LX 镜像歌单 |
| `showCurrentLxSource` | index.html:28836 | 显示当前 LX 音源 |
| `clearLocalLibraryPassiveQueue` | index.html:25155 | 清除本地被动队列 |

#### 彩蛋/特殊类（4 个）

| 函数名 | 源位置 | 功能 |
|--------|--------|------|
| `playWorldPeaceEasterEgg` | 未找到 | 世界和平彩蛋 |
| `openRemoteControl` | 未找到 | 远程控制 |
| `openMusicPlanet` | 未找到 | 音乐星球 |
| `normalizePlaybackQualityForProvider` | 已存在 | 音质归一化（误报，已确认存在） |

#### 工具类（5 个）

| 函数名 | 源位置 | 功能 |
|--------|--------|------|
| `isMineradioFullscreenActive` | index.html:44826 | 检测全屏状态 |
| `beginVoiceInputIsolation` | index.html:32649 | 开始语音隔离 |
| `endVoiceInputIsolation` | index.html:32660 | 结束语音隔离 |
| `clearFxPanelAutoCloseTimer` | index.html:44627 | 清除 FX 面板自动关闭定时器 |
| `savePlaybackSession` | index.html:32847 | 保存播放会话 |

---

## 五、移植执行计划

### 阶段 1: 基础文件复制（风险: 低）

```
1. 复制 agent-api.js → 目标项目根目录
2. 复制 music-agent-command.css → 目标项目 public/css/
3. 确认 agent-api.js 的 HTML script 引用已添加到 index.html
4. 确认 CSS link 标签已添加到 index.html
```

### 阶段 2: 创建适配层（风险: 中）

创建新文件 `public/js/agent-adapter.js`，提供桥接:

```javascript
// agent-adapter.js — 适配层
// 将目标项目的模块化函数映射到 AI 助手期望的全局函数名
(function () {
  'use strict';

  // === 全局变量声明 ===
  if (typeof window.lxMirrorPlaylists === 'undefined') {
    window.lxMirrorPlaylists = [];
  }
  if (typeof window.playbackTuning === 'undefined') {
    window.playbackTuning = { speed: 1.0, pitch: 0, active: false };
  }

  // === 函数适配 ===
  
  // 这些函数在目标项目中不存在，需从源 index.html 提取
  // 实现方式：直接复制源函数定义或使用目标项目的等效实现
  
  // 示例：使用目标项目的 searchBox 等价实现
  window.focusGlobalSearch = function() {
    var searchBox = document.getElementById('search-box') || document.querySelector('input[type="search"]');
    if (searchBox) {
      searchBox.focus();
      searchBox.select();
    }
  };
  
  // ... 其他 41 个函数的适配定义
  
})();
```

### 阶段 3: 复制 AI 助手核心文件（风险: 中）

```
1. 复制 agent-music-tools.js → 目标项目 public/js/
2. 复制 music-agent-command.js → 目标项目 public/js/
3. 在 index.html 中添加 script 引用（注意顺序）:
   <script src="js/agent-api.js"></script>
   <script src="js/agent-adapter.js"></script>
   <script src="js/agent-music-tools.js"></script>
   <script src="js/music-agent-command.js"></script>
```

### 阶段 4: 功能验证（风险: 低）

- 验证所有 18 个工具调用是否正常工作
- 验证 UI 对话框渲染和交互
- 验证设置面板的保存/加载
- 验证语音输入功能

---

## 六、适配层接口设计

### 6.1 设计原则

1. **最小侵入**: 不修改目标项目现有模块
2. **命名适配**: 将源项目的函数名映射到目标项目的等价实现
3. **降级处理**: 对于目标项目不存在的功能，提供有意义的错误提示

### 6.2 适配层架构

```
┌─────────────────────────────────────────────┐
│           music-agent-command.js            │
│                  调用层                       │
├─────────────────────────────────────────────┤
│           agent-music-tools.js              │
│               工具执行层                      │
├─────────────────────────────────────────────┤
│  agent-adapter.js  ← 新增适配层              │
│  ┌─────────────┬─────────────┬────────────┐ │
│  │ 直接映射     │ 组合实现     │ 空实现      │ │
│  │ (目标已存在) │ (目标部分存  │ (目标完全   │ │
│  │             │  在)         │  不存在)    │ │
│  └─────────────┴─────────────┴────────────┘ │
├─────────────────────────────────────────────┤
│  目标项目模块化 JS (85+ 文件)                 │
└─────────────────────────────────────────────┘
```

### 6.3 适配策略分类

| 策略 | 数量 | 说明 | 示例 |
|------|------|------|------|
| **直接映射** | 50 | 目标项目已有同名函数 | `setVolume`, `togglePlay` |
| **组合实现** | 20 | 目标项目有部分功能，需组合多个调用 | `openPrimaryView`, `focusGlobalSearch` |
| **源码移植** | 15 | 从源 index.html 提取完整定义 | `openDailyReviewManager`, `isMineradioFullscreenActive` |
| **空实现** | 7 | 目标项目无此功能，返回 not-supported | `openRemoteControl`, `openMusicPlanet`, `playWorldPeaceEasterEgg` |

### 6.4 关键适配实现示例

#### 示例 1: 直接映射（最简单）

目标项目已有 `setVolume` 函数，无需适配，agent-music-tools.js 可直接调用。

#### 示例 2: 组合实现

```javascript
// openAudioOutputSettings — 目标项目有状态但无直接打开函数
window.openAudioOutputSettings = function() {
  // 使用目标项目的等价路径
  if (typeof window.openHotkeySettings === 'function') {
    // 先打开设置面板，再切换到音频输出标签
    window.openHotkeySettings();
    // 或通过事件/状态触发UI切换
    var outputDevicePanel = document.querySelector('[data-panel="audio-output"]');
    if (outputDevicePanel) {
      outputDevicePanel.click();
    }
  }
};
```

#### 示例 3: 源码移植

```javascript
// isMineradioFullscreenActive — 完整从源 index.html 移植
window.isMineradioFullscreenActive = function() {
  // === 从源 index.html:44826 复制 ===
  return !!document.fullscreenElement || 
         !!(window.desktopWindow && window.desktopWindow.isFullscreen && window.desktopWindow.isFullscreen());
};
```

#### 示例 4: 空实现（降级）

```javascript
// openRemoteControl — 目标项目无此功能
window.openRemoteControl = function() {
  if (typeof window.showToast === 'function') {
    window.showToast('当前版本暂不支持远程控制功能');
  }
  return { ok: false, reason: 'NOT_SUPPORTED' };
};
```

---

## 七、Script 加载顺序

```html
<!-- 在原有 script 标签之后添加 -->
<script src="js/agent-api.js"></script>
<script src="js/agent-adapter.js"></script>
<script src="js/agent-music-tools.js"></script>
<script src="js/music-agent-command.js"></script>
<link rel="stylesheet" href="css/music-agent-command.css">
```

**加载顺序约束**:
1. `agent-api.js` 必须在 `agent-music-tools.js` 之前（tools 依赖 api）
2. `agent-adapter.js` 必须在 `agent-music-tools.js` 之前（tools 依赖 adapter 提供的全局函数）
3. `agent-music-tools.js` 必须在 `music-agent-command.js` 之前（command 依赖 tools）
4. CSS 可在 `<head>` 中或 DOMContentLoaded 前加载

---

## 八、风险评估

### 8.1 高风险项

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 全局变量命名冲突 | agent-music-tools.js 的全局变量可能与目标项目冲突 | 使用适配器包裹，IIFE 隔离 |
| `window.desktopWindow` 不存在 | music-agent-command.js 依赖此对象 | 在 adapter 中提供 mock 或条件判断 |
| `window.LyricAnimation` 不存在 | 歌词动画控制 | 在 adapter 中条件调用 |

### 8.2 中风险项

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| CSS 样式冲突 | 类名可能与目标项目重复 | 使用 `music-agent-` 前缀隔离 |
| 语音输入依赖 | `webkitSpeechRecognition` 可能不可用 | 已有 typeof 检查，需验证 |
| 事件监听冲突 | 全局 keydown 监听可能与目标项目冲突 | 使用捕获阶段并检查 event.defaultPrevented |

### 8.3 低风险项

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 彩蛋功能缺失 | 3 个函数源项目也找不到 | 空实现 + Toast 提示 |
| 版本兼容性 | 源项目 LX-Music vs 目标 Mineradio | 已通过模块化适配解决 |

---

## 九、移植验证清单

### 功能验证

- [ ] 打开/关闭 AI 助手对话框
- [ ] 发送文本命令
- [ ] 语音输入（如可用）
- [ ] 搜索音乐 → 播放
- [ ] 播放控制（暂停/上一首/下一首）
- [ ] 音量调节
- [ ] 播放模式切换
- [ ] 音质控制
- [ ] 歌单导入
- [ ] FX 面板控制
- [ ] 歌词动画设置
- [ ] DIY 视觉控制
- [ ] 设置面板（API Key 配置）
- [ ] 对话记忆清除
- [ ] 窗口大小/位置重置

### 兼容性验证

- [ ] 不影响原有播放功能
- [ ] 不影响 FX 面板原有交互
- [ ] 不影响歌单面板
- [ ] 不影响搜索功能
- [ ] 不影响登录/账号功能
- [ ] 不影响全屏模式

---

## 十、总结

本移植计划将 AI 助手 "小M" 从 Mineradio-LX-Music-1.6.0 完整移植到 Mineradio-2.1.0。通过适配层设计，将 42 个缺失函数分类处理（直接映射/组合实现/源码移植/空实现），确保:

1. **功能完整性**: 所有 18 个工具调用在目标项目中可用
2. **最小侵入**: 不修改目标项目的模块化 JS 文件
3. **可维护性**: 适配层独立于核心逻辑，便于后续升级
4. **渐进实施**: 可分阶段验证，降低集成风险

预计工作量:
- 阶段 1（文件复制）: 30 分钟
- 阶段 2（适配层）: 4-8 小时（取决于组合实现的复杂度）
- 阶段 3（核心文件）: 30 分钟
- 阶段 4（验证）: 2-4 小时
