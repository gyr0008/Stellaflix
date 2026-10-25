'use strict';

/**
 * Stellaflix 迷你播放器（pill 窗口）主进程 runtime。
 * 逐字移植自 源 main.js 的迷你播放器子系统（行段对照 task-4-brief），
 * 闭包全局量改为 createMiniPlayerRuntime(deps) 的局部状态与依赖注入，
 * IPC 通道统一改名 stellaflix-*。DI 风格对齐 desktop/cover-wallpaper-runtime.js：
 * BrowserWindow / screen / ipcMain 经 deps 注入，模块顶层不 require electron。
 *
 * Task 4 范围：窗口生命周期 + 状态同步 + 命令路由。
 * Task 5 范围：拖动 / 指针穿透 / 右键菜单 / 显示拓扑 / 电源会话 / prewarm 转场 / 坐标持久化。
 */

const fs = require('fs');
const path = require('path');
const { MiniPlayerStateCache, miniPlayerThemeSignature } = require('./mini-player-state-cache');
const { MiniPlayerRecoverySession } = require('./mini-player-recovery-session');
const {
  beginMiniPlayerCoverDrag,
  miniPlayerCoverBounds,
  updateMiniPlayerCoverDrag,
} = require('./mini-player-cover-drag');

// —— 尺寸常量（源 :220-226）——
const MINI_PLAYER_WIDTH = 360;
const MINI_PLAYER_HEIGHT = 84;
const MINI_PLAYER_COVER_SIZE = 54;
const COMPACT_MINI_PLAYER_WIDTH = 268;
const COMPACT_MINI_PLAYER_HEIGHT = 58;
const MINI_PLAYER_MARGIN = 14;
const MINI_PLAYER_RECOVERY_INTERVAL = 5000;
// 迷你播放器崩溃/加载失败恢复的退避与上限：反复失败按 200·n²ms 退避，达到上限就停手并回退主窗口，
// 避免把「加载不起来的页面」无限重建成「黑窗 + 满负载」。成功加载后计数清零（见 did-finish-load）。
const MINI_PLAYER_CRASH_RECOVERY_LIMIT = 3;
// 预热窗口最长存活时间（源 :229）；主窗口最终没有进入迷你模式时按 TTL 回收。
const MINI_PLAYER_PREWARM_TTL = 2600;
// 坐标持久化文件（源 writeDesktopShellSettings 的角色，落在 Stellaflix userData）。
const MINI_PLAYER_BOUNDS_FILE = 'mini-player-bounds.json';

// —— IPC 通道（Task 3 preload 契约，名称必须逐字一致）——
const CHANNEL_SET_ENABLED = 'stellaflix-mini-player-set-enabled';
const CHANNEL_SET_MODE = 'stellaflix-mini-player-set-mode';
const CHANNEL_PREPARE_TRANSITION = 'stellaflix-mini-player-prepare-transition';
const CHANNEL_UPDATE = 'stellaflix-mini-player-update';
const CHANNEL_COMMAND = 'stellaflix-mini-player-command';
const CHANNEL_STATE = 'stellaflix-mini-player-state';
const CHANNEL_MOVE_BY = 'stellaflix-mini-player-move-by';
const CHANNEL_WINDOW_MOVE_BY = 'stellaflix-mini-player-window-move-by';
const CHANNEL_SET_POINTER_PASSTHROUGH = 'stellaflix-mini-player-set-pointer-passthrough';
const CHANNEL_SET_POINTER_PASSTHROUGH_SYNC = 'stellaflix-mini-player-set-pointer-passthrough-sync';

// —— 纯函数（无 electron 依赖，供测试与 runtime 内部共用）——

function normalizeMiniPlayerMode(value) {
  return value === 'compact' ? 'compact' : 'standard';
}

function miniPlayerSize(mode) {
  return normalizeMiniPlayerMode(mode) === 'compact'
    ? { width: COMPACT_MINI_PLAYER_WIDTH, height: COMPACT_MINI_PLAYER_HEIGHT }
    : { width: MINI_PLAYER_WIDTH, height: MINI_PLAYER_HEIGHT };
}

/**
 * 纯版默认边界：右下角、留 14px 边距。display 由调用方注入（{workArea} 形状），
 * runtime 内部传 screen.getDisplayMatching(...) 的真实显示器。
 * @param {unknown} mode 'standard'|'compact'（其它值按 standard）。
 * @param {{workArea:{x:number,y:number,width:number,height:number}}} display 目标显示器。
 * @returns {{x:number,y:number,width:number,height:number}} 默认边界。
 */
function miniPlayerDefaultBounds(mode, display) {
  const size = miniPlayerSize(mode);
  const workArea = (display && display.workArea) || { x: 0, y: 0, width: size.width, height: size.height };
  return {
    x: workArea.x + workArea.width - size.width - MINI_PLAYER_MARGIN,
    y: workArea.y + workArea.height - size.height - MINI_PLAYER_MARGIN,
    width: size.width,
    height: size.height,
  };
}

/**
 * 把越界坐标弹回工作区，并强制按样式固定尺寸。
 * @param {{x:number,y:number}|null} bounds 待校正坐标。
 * @param {unknown} mode 'standard'|'compact'。
 * @param {{workArea:{x:number,y:number,width:number,height:number}}} display 目标显示器。
 * @returns {{x:number,y:number,width:number,height:number}} 工作区内边界。
 */
function clampMiniPlayerBounds(bounds, mode, display) {
  const size = miniPlayerSize(mode);
  const source = bounds || miniPlayerDefaultBounds(mode, display);
  const workArea = (display && display.workArea) || { x: 0, y: 0, width: size.width, height: size.height };
  return {
    x: Math.round(Math.max(workArea.x, Math.min(source.x, workArea.x + workArea.width - size.width))),
    y: Math.round(Math.max(workArea.y, Math.min(source.y, workArea.y + workArea.height - size.height))),
    width: size.width,
    height: size.height,
  };
}

/**
 * 判断当前会话是否允许显示迷你播放器；锁屏或休眠期间必须保持关闭。
 * 纯版接状态对象（源 :3793-3802 的等价条件）：
 * !paused && enabled && active && 主窗存在未销毁 && (最小化 || 不可见)。
 * @param {{paused?:boolean,enabled?:boolean,active?:boolean,windowAlive?:boolean,windowDestroyed?:boolean,hiddenOrMinimized?:boolean}} state
 * @returns {boolean}
 */
function shouldShowMiniPlayer(state) {
  const s = state || {};
  return !!(
    !s.paused
    && s.enabled
    && s.active
    && s.windowAlive
    && !s.windowDestroyed
    && s.hiddenOrMinimized
  );
}

/**
 * 根据迷你窗口距离显示器左右工作区边缘的空间决定展开方向。
 * 右侧可用空间更少时返回 left，让完整控制栏向封面左侧展开；其余位置保持向右展开。
 * @param {{x:number,y:number,width:number,height:number}} bounds 当前迷你窗口边界。
 * @param {{workArea:{x:number,y:number,width?:number}}} display 目标显示器。
 * @returns {'left'|'right'} 标准迷你播放器的展开方向。
 */
function miniPlayerExpandDirectionForBounds(bounds, display) {
  const source = bounds || { width: MINI_PLAYER_WIDTH };
  const workArea = (display && display.workArea) || { x: 0, width: 0 };
  const width = Number.isFinite(Number(source.width)) ? Number(source.width) : MINI_PLAYER_WIDTH;
  const leftSpace = Number(source.x) - Number(workArea.x || 0);
  const rightSpace = Number(workArea.x || 0) + Number(workArea.width || 0) - (Number(source.x) + width);
  return rightSpace < leftSpace ? 'left' : 'right';
}

/**
 * 从持久化边界中恢复显式方向；旧设置没有方向字段时按校正后的窗口位置生成一次默认值。
 * @param {{x:number,y:number,width:number,height:number,expandDirection?:unknown}|null} bounds 标准迷你播放器边界。
 * @param {{workArea:{x:number,y:number,width?:number}}} display 目标显示器。
 * @returns {'left'|'right'} 可直接用于布局和后续持久化的方向。
 */
function miniPlayerExpandDirectionFromBoundsState(bounds, display) {
  if (bounds && (bounds.expandDirection === 'left' || bounds.expandDirection === 'right')) {
    return bounds.expandDirection;
  }
  return miniPlayerExpandDirectionForBounds(bounds, display);
}

/**
 * 生成迷你播放器坐标签名，用于区分用户拖动、程序校正和重复持久化。
 * @param {{x:number, y:number}} bounds 窗口坐标。
 * @returns {string} 取整后的坐标签名。
 */
function miniPlayerBoundsSignature(bounds) {
  if (!bounds) return '';
  const direction = bounds.expandDirection === 'left' || bounds.expandDirection === 'right'
    ? `|${bounds.expandDirection}`
    : '';
  return `${Math.round(bounds.x)}|${Math.round(bounds.y)}${direction}`;
}

/**
 * 把数值夹进 [min, max]，非有限值回退到 fallback（源 :2463-2467）。
 * @param {unknown} value 待夹取的值。
 * @param {number} min 下界。
 * @param {number} max 上界。
 * @param {number} fallback 非法值时的回退。
 * @returns {number} 夹取后的有限数值。
 */
function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * 校验 renderer 附带的封面拖动锚点与代际。缺失元数据代表旧的无锚点调用，
 * 但一旦提供对象就必须完整、可排序且只包含当前拖动所需的字段。
 * @param {unknown} value IPC 附带的拖动元数据。
 * @returns {{generation:number,anchor?:{x:number,y:number},layout?:'collapsed'|'expanded'}|null} 已确认的元数据。
 */
function normalizeMiniPlayerCoverDragMeta(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('dragMeta 必须是对象');
  }
  if (!Number.isSafeInteger(value.generation) || value.generation <= 0) {
    throw new TypeError('dragMeta.generation 必须是正整数');
  }
  const result = { generation: value.generation };
  if (value.anchor !== undefined && value.anchor !== null) {
    if (typeof value.anchor !== 'object' || Array.isArray(value.anchor)) {
      throw new TypeError('dragMeta.anchor 必须是坐标对象');
    }
    if (typeof value.anchor.x !== 'number' || !Number.isFinite(value.anchor.x)
      || typeof value.anchor.y !== 'number' || !Number.isFinite(value.anchor.y)) {
      throw new TypeError('dragMeta.anchor 必须是有限坐标');
    }
    result.anchor = { x: value.anchor.x, y: value.anchor.y };
  }
  if (value.layout !== undefined && value.layout !== null) {
    if (value.layout !== 'collapsed' && value.layout !== 'expanded') {
      throw new RangeError('dragMeta.layout 必须是 collapsed 或 expanded');
    }
    result.layout = value.layout;
  }
  return result;
}

function createMiniPlayerRuntime(deps) {
  const BrowserWindow = deps.BrowserWindow;
  const screen = deps.screen;
  const ipcMain = deps.ipcMain;
  const Menu = deps.Menu;
  const powerMonitor = deps.powerMonitor;
  const overlayUrl = deps.overlayUrl;
  const getMainWindow = deps.getMainWindow;
  const focusMainWindow = deps.focusMainWindow;
  const isWallpaperDesktopActive = deps.isWallpaperDesktopActive;
  const isTrustedMainWindowEvent = deps.isTrustedMainWindowEvent;
  const getMainServerPort = deps.getMainServerPort;
  const isQuitting = deps.isQuitting;
  const APP_ICON_ICO = deps.icon;

  // —— 源 :170-202 全局量 → 局部状态 ——
  let miniPlayerWindow = null;
  let miniPlayerEnabled = true;
  let miniPlayerActive = false;
  let miniPlayerMode = 'standard';
  // 以下四项由 Task 5 拖动/穿透/拓扑逻辑驱动，并在生命周期节点复位。
  let miniPlayerUserMovePending = false;
  let miniPlayerCoverDragSession = null;
  let miniPlayerCoverDragGeneration = 0;
  let miniPlayerDisplayTopologyDirty = false;
  let miniPlayerPointerPassthrough = false;
  let miniPlayerLastSentState = null;
  let miniPlayerRecoveryTimer = null;
  let miniPlayerRecreateTimer = null;
  let miniPlayerCrashFailureCount = 0;
  // 主窗口开始收缩动画时预热的迷你窗口（Task 5 prewarm 移植前恒为 null）。
  let miniPlayerPrewarmWindow = null;
  let miniPlayerPrewarmTimer = null;
  const miniPlayerUserBoundsByMode = { standard: null, compact: null };
  const miniPlayerSavedBoundsSignatures = { standard: '', compact: '' };
  const miniPlayerProgrammaticCloseWindows = new WeakSet();
  const miniPlayerRendererReloadWindows = new WeakSet();
  const miniPlayerWindowModes = new WeakMap();
  const miniPlayerExpandDirections = new WeakMap();
  const miniPlayerCoverLayouts = new WeakMap();
  const miniPlayerStateCache = new MiniPlayerStateCache(miniPlayerEnabled);

  // —— 尺寸/边界（display 参数版纯函数的 screen 适配，源 :3329-3359）——
  function miniPlayerModeForWindow(win) {
    return normalizeMiniPlayerMode(win ? miniPlayerWindowModes.get(win) : miniPlayerMode);
  }

  function defaultBoundsForMode(mode) {
    const referenceBounds = getMainWindow() && !getMainWindow().isDestroyed()
      ? getMainWindow().getBounds()
      : screen.getPrimaryDisplay().bounds;
    const display = screen.getDisplayMatching(referenceBounds) || screen.getPrimaryDisplay();
    return miniPlayerDefaultBounds(mode, display);
  }

  function clampBounds(bounds, mode) {
    const display = (bounds && (screen.getDisplayMatching(bounds) || screen.getPrimaryDisplay()))
      || screen.getPrimaryDisplay();
    return clampMiniPlayerBounds(bounds, mode, display);
  }

  /**
   * 读取标准迷你播放器当前显式展开方向。拖动换边后优先保留会话写入的方向，
   * 避免按补偿后的透明窗口边界重新计算并把封面推回旧侧。
   * @param {Electron.BrowserWindow} win 当前迷你播放器窗口。
   * @returns {'left'|'right'} 当前标准迷你播放器展开方向。
   */
  function miniPlayerExpandDirectionForWindow(win) {
    const cached = win ? miniPlayerExpandDirections.get(win) : '';
    if (cached === 'left' || cached === 'right') return cached;
    const rawBounds = win && !win.isDestroyed() ? win.getBounds() : null;
    const display = rawBounds ? (screen.getDisplayMatching(rawBounds) || screen.getPrimaryDisplay()) : screen.getPrimaryDisplay();
    const next = miniPlayerExpandDirectionFromBoundsState(rawBounds, display);
    if (win) miniPlayerExpandDirections.set(win, next);
    return next;
  }

  /**
   * 迷你播放器坐标落盘文件路径（Stellaflix userData；idiom 对齐 main.js 的
   * `path.join(app.getPath('userData'), '*.json')`）。未注入 userDataDir 时返回空串，
   * 持久化降级为纯内存，测试与无盘环境不炸。
   * @returns {string} 边界文件绝对路径或空串。
   */
  function miniPlayerBoundsFilePath() {
    try {
      const dir = typeof deps.userDataDir === 'function' ? deps.userDataDir() : deps.userDataDir;
      return dir ? path.join(String(dir), MINI_PLAYER_BOUNDS_FILE) : '';
    } catch (_error) {
      return '';
    }
  }

  /**
   * 读取已落盘的坐标设置；文件缺失或损坏按空设置处理，不影响默认定位。
   * @returns {Record<string, unknown>} 设置对象。
   */
  function readMiniPlayerBoundsState() {
    const file = miniPlayerBoundsFilePath();
    if (!file) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_error) {
      return {};
    }
  }

  /**
   * 坐标设置落盘：合并写回 runtime 自有的 mini-player-bounds.json（源 writeDesktopShellSettings
   * 在迷你播放器坐标面上的角色），并转发可选 deps.persistSettings 镜像给后续设置面板。
   * @param {{miniPlayerBounds?:object, miniPlayerCompactBounds?:object}} payload 增量设置。
   * @returns {void}
   */
  function persistMiniPlayerBoundsSettings(payload) {
    if (typeof deps.persistSettings === 'function') {
      try { deps.persistSettings(payload); } catch (e) { console.warn('Mini player bounds mirror failed:', e.message); }
    }
    const file = miniPlayerBoundsFilePath();
    if (!file) return;
    try {
      const next = { ...readMiniPlayerBoundsState(), ...payload };
      fs.writeFileSync(file, JSON.stringify(next), 'utf8');
    } catch (e) {
      console.warn('Mini player bounds persist failed:', e.message);
    }
  }

  /**
   * 读取并校正已保存的迷你播放器坐标。非法设置直接忽略，不改变当前默认定位。（源 :3594-3609）
   * @param {unknown} value 设置文件中的坐标值。
   * @param {'standard'|'compact'} mode 迷你播放器样式。
   * @returns {{x:number, y:number, width:number, height:number, expandDirection?:'left'|'right'}|null} 当前显示器内的固定尺寸坐标。
   */
  function savedMiniPlayerBounds(value, mode) {
    if (!value || typeof value !== 'object') return null;
    if (typeof value.x !== 'number' || !Number.isFinite(value.x)) return null;
    if (typeof value.y !== 'number' || !Number.isFinite(value.y)) return null;
    const normalizedMode = normalizeMiniPlayerMode(mode);
    const size = miniPlayerSize(normalizedMode);
    const nextBounds = clampBounds({ x: value.x, y: value.y, ...size }, normalizedMode);
    if (normalizedMode !== 'standard') return nextBounds;
    return {
      ...nextBounds,
      expandDirection: miniPlayerExpandDirectionFromBoundsState({
        ...nextBounds,
        expandDirection: value.expandDirection,
      }, screen.getDisplayMatching(nextBounds) || screen.getPrimaryDisplay()),
    };
  }

  /**
   * 保存迷你播放器坐标到内存并按签名去重落盘。
   * @param {{x:number,y:number,width?:number,height?:number}} bounds 用户或系统校正后的坐标。
   * @param {'standard'|'compact'} mode 迷你播放器样式。
   * @returns {{x:number,y:number,width:number,height:number}} 实际保存的工作区内坐标。
   */
  function persistMiniPlayerUserBounds(bounds, mode) {
    const normalizedMode = normalizeMiniPlayerMode(mode);
    const nextBounds = clampBounds(bounds, normalizedMode);
    const storedBounds = normalizedMode === 'standard'
      ? {
        ...nextBounds,
        expandDirection: miniPlayerExpandDirectionFromBoundsState(
          { ...bounds, expandDirection: bounds && bounds.expandDirection },
          screen.getDisplayMatching(bounds || nextBounds) || screen.getPrimaryDisplay(),
        ),
      }
      : nextBounds;
    const signature = miniPlayerBoundsSignature(storedBounds);
    miniPlayerUserBoundsByMode[normalizedMode] = storedBounds;
    if (signature === miniPlayerSavedBoundsSignatures[normalizedMode]) return nextBounds;
    const settingKey = normalizedMode === 'compact' ? 'miniPlayerCompactBounds' : 'miniPlayerBounds';
    const settingValue = normalizedMode === 'standard'
      ? { x: storedBounds.x, y: storedBounds.y, expandDirection: storedBounds.expandDirection }
      : { x: storedBounds.x, y: storedBounds.y };
    persistMiniPlayerBoundsSettings({ [settingKey]: settingValue });
    miniPlayerSavedBoundsSignatures[normalizedMode] = signature;
    return storedBounds;
  }

  /**
   * 推进当前迷你文档的拖动代际；renderer 重载前先推进，迟到的旧 IPC 就不能复用新页面会话。
   * @returns {number} 当前有效的正整数代际。
   */
  function advanceMiniPlayerCoverDragGeneration() {
    if (!Number.isSafeInteger(miniPlayerCoverDragGeneration)
      || miniPlayerCoverDragGeneration >= Number.MAX_SAFE_INTEGER) {
      miniPlayerCoverDragGeneration = 1;
    } else {
      miniPlayerCoverDragGeneration += 1;
    }
    miniPlayerCoverDragSession = null;
    // renderer 重载会让旧的 moved 事件迟到；清掉原生移动标记，避免它把新页面状态误写入设置。
    miniPlayerUserMovePending = false;
    return miniPlayerCoverDragGeneration;
  }

  /**
   * 选择本次封面拖动应使用的显示器工作区。按累计逻辑封面矩形而非已夹紧窗口判断，
   * 封面大部分进入相邻显示器后即可切换目标工作区，不会被旧屏边缘持续吞掉增量。（源 :3411-3419）
   * @param {{coverX:number,coverY:number}} session 当前封面拖动会话。
   * @param {number} dx 本次水平增量。
   * @param {number} dy 本次垂直增量。
   * @returns {{x:number,y:number,width:number,height:number}} 目标显示器工作区。
   */
  function miniPlayerCoverDragWorkArea(session, dx, dy) {
    const display = screen.getDisplayMatching({
      x: Math.round(session.coverX + dx),
      y: Math.round(session.coverY + dy),
      width: MINI_PLAYER_COVER_SIZE,
      height: MINI_PLAYER_COVER_SIZE,
    }) || screen.getPrimaryDisplay();
    return display.workArea;
  }

  /**
   * 生成封面拖动使用的虚拟桌面工作区。跨显示器时只在整个桌面边缘夹紧，
   * 不把窗口强行吸回某一块显示器，避免封面经过屏幕接缝时跳动。（源 :3426-3439）
   * @returns {{x:number,y:number,width:number,height:number}} 所有显示器工作区的外接矩形。
   */
  function miniPlayerCoverDragClampWorkArea() {
    const displays = typeof screen.getAllDisplays === 'function' ? screen.getAllDisplays() : [];
    const areas = displays
      .map(display => display && display.workArea)
      .filter(area => area && Number.isFinite(Number(area.x)) && Number.isFinite(Number(area.y))
        && Number.isFinite(Number(area.width)) && Number.isFinite(Number(area.height))
        && Number(area.width) > 0 && Number(area.height) > 0);
    if (!areas.length) return screen.getPrimaryDisplay().workArea;
    const left = Math.min(...areas.map(area => Number(area.x)));
    const top = Math.min(...areas.map(area => Number(area.y)));
    const right = Math.max(...areas.map(area => Number(area.x) + Number(area.width)));
    const bottom = Math.max(...areas.map(area => Number(area.y) + Number(area.height)));
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  /**
   * 标记用户开始手动拖动迷你播放器。Electron 的 will-move 不会由 setBounds 触发。（源 :3641-3645）
   * @param {Electron.BrowserWindow} win 即将被用户手动移动的迷你播放器窗口。
   * @returns {void}
   * @see https://www.electronjs.org/docs/latest/api/browser-window#event-will-move-macos-windows
   */
  function beginMiniPlayerUserMove(win) {
    if (miniPlayerWindow !== win || win.isDestroyed()) return;
    miniPlayerCoverDragSession = null;
    miniPlayerUserMovePending = true;
  }

  /**
   * 在用户拖动结束后保存坐标。没有 will-move 标记的程序移动事件直接忽略。（源 :3652-3668）
   * @param {Electron.BrowserWindow} win 触发移动完成事件的迷你播放器窗口。
   * @returns {void}
   */
  function handleMiniPlayerMoved(win) {
    if (miniPlayerWindow !== win || win.isDestroyed() || !miniPlayerUserMovePending) return;
    miniPlayerUserMovePending = false;
    const mode = miniPlayerModeForWindow(win);
    const bounds = win.getBounds();
    if (mode === 'standard') {
      const direction = miniPlayerExpandDirectionForBounds(
        bounds,
        screen.getDisplayMatching(bounds) || screen.getPrimaryDisplay(),
      );
      miniPlayerExpandDirections.set(win, direction);
      persistMiniPlayerUserBounds({ ...bounds, expandDirection: direction }, mode);
    } else {
      persistMiniPlayerUserBounds(bounds, mode);
    }
    sendMiniPlayerState();
    if (typeof miniPlayerDisplayTopologyDirty !== 'undefined' && miniPlayerDisplayTopologyDirty) {
      reconcileMiniPlayerAfterDisplayTopology();
    }
  }

  /**
   * 在显示器拓扑改变后校正迷你播放器；拖动尚未结束时保留封面锚点，避免系统事件抢走指针位移。（源 :3463-3523）
   * @param {{x:number,y:number,layout?:'collapsed'|'expanded'}=} anchorOverride 拖动结束时保存的封面屏幕锚点。
   * @returns {void}
   */
  function reconcileMiniPlayerAfterDisplayTopology(anchorOverride) {
    const win = miniPlayerWindow;
    if (!win || win.isDestroyed()) {
      miniPlayerDisplayTopologyDirty = false;
      return;
    }
    if (miniPlayerCoverDragSession || miniPlayerUserMovePending) {
      miniPlayerDisplayTopologyDirty = true;
      return;
    }
    miniPlayerDisplayTopologyDirty = false;
    const mode = miniPlayerModeForWindow(win);
    if (mode !== 'standard') {
      positionMiniPlayerWindow();
      return;
    }
    try {
      const bounds = win.getBounds();
      const storedBounds = miniPlayerUserBoundsByMode.standard;
      const currentDirection = miniPlayerExpandDirectionForWindow(win);
      const rememberedLayout = miniPlayerCoverLayouts.get(win);
      const layout = anchorOverride && (anchorOverride.layout === 'expanded' || anchorOverride.layout === 'collapsed')
        ? anchorOverride.layout
        : rememberedLayout === 'expanded' ? 'expanded' : 'collapsed';
      miniPlayerCoverLayouts.set(win, layout);
      const coverAnchor = anchorOverride && Number.isFinite(anchorOverride.x) && Number.isFinite(anchorOverride.y)
        ? { x: anchorOverride.x, y: anchorOverride.y }
        : miniPlayerCoverBounds(bounds, currentDirection, layout);
      // 用真实封面锚点重算方向；只移动透明窗口，避免拓扑变化时封面横跳。
      const session = beginMiniPlayerCoverDrag({
        bounds,
        direction: currentDirection,
        anchor: coverAnchor,
        layout,
      });
      const workArea = miniPlayerCoverDragWorkArea(session, 0, 0);
      const result = updateMiniPlayerCoverDrag(
        session,
        0,
        0,
        workArea,
        miniPlayerCoverDragClampWorkArea(),
      );
      const nextBounds = result.bounds;
      const direction = result.direction;
      if (nextBounds.x !== bounds.x || nextBounds.y !== bounds.y) win.setBounds(nextBounds, false);
      miniPlayerExpandDirections.set(win, direction);
      miniPlayerUserBoundsByMode.standard = { ...nextBounds, expandDirection: direction };
      if (storedBounds && (storedBounds.x !== nextBounds.x
        || storedBounds.y !== nextBounds.y
        || storedBounds.expandDirection !== direction)) {
        persistMiniPlayerUserBounds({ ...nextBounds, expandDirection: direction }, mode);
      }
      sendMiniPlayerState();
    } catch (error) {
      // 拓扑变化期间原生窗口可能短暂不可写；保留 dirty 标记，让下一次系统事件重试。
      miniPlayerDisplayTopologyDirty = true;
      console.warn('Mini player topology reconcile skipped:', error.message);
      return;
    }
  }

  /**
   * 处理显示器增删或参数变化；用户拖动/原生移动期间只记脏，结束后再校正。（源 :3529-3539）
   * @returns {void}
   */
  function handleMiniPlayerDisplayTopologyChanged() {
    if (!miniPlayerWindow || miniPlayerWindow.isDestroyed()) {
      miniPlayerDisplayTopologyDirty = false;
      return;
    }
    if (miniPlayerCoverDragSession || miniPlayerUserMovePending) {
      miniPlayerDisplayTopologyDirty = true;
      return;
    }
    reconcileMiniPlayerAfterDisplayTopology();
  }

  /**
   * 判断当前会话是否允许显示迷你播放器（真实状态版，委托纯函数）。
   * @returns {boolean}
   */
  function shouldShowMiniPlayerNow() {
    const win = getMainWindow();
    let hiddenOrMinimized = false;
    if (win && !win.isDestroyed()) {
      hiddenOrMinimized = win.isMinimized() || !win.isVisible();
    }
    return shouldShowMiniPlayer({
      paused: miniPlayerRecoverySession.paused,
      enabled: miniPlayerEnabled,
      active: miniPlayerActive,
      windowAlive: !!win,
      windowDestroyed: win ? win.isDestroyed() : false,
      hiddenOrMinimized,
    });
  }

  function stopMiniPlayerRecoveryTimer() {
    if (!miniPlayerRecoveryTimer) return;
    clearTimeout(miniPlayerRecoveryTimer);
    miniPlayerRecoveryTimer = null;
  }

  function stopMiniPlayerRecreateTimer() {
    if (!miniPlayerRecreateTimer) return;
    clearTimeout(miniPlayerRecreateTimer);
    miniPlayerRecreateTimer = null;
  }

  // 预热窗口丢弃计时器（源 :3816-3820；丢弃逻辑 discardMiniPlayerPrewarm 见下方转场段）。
  function stopMiniPlayerPrewarmTimer() {
    if (!miniPlayerPrewarmTimer) return;
    clearTimeout(miniPlayerPrewarmTimer);
    miniPlayerPrewarmTimer = null;
  }

  function scheduleMiniPlayerRecovery(delay = MINI_PLAYER_RECOVERY_INTERVAL) {
    stopMiniPlayerRecoveryTimer();
    if (!shouldShowMiniPlayerNow()) return;
    miniPlayerRecoveryTimer = setTimeout(() => {
      miniPlayerRecoveryTimer = null;
      if (shouldShowMiniPlayerNow()) showMiniPlayerWindow();
    }, Math.max(0, Number(delay) || 0));
    if (typeof miniPlayerRecoveryTimer.unref === 'function') miniPlayerRecoveryTimer.unref();
  }

  /**
   * 恢复迷你播放器的置顶层级。健康窗口只刷新 Z 序，避免恢复轮询重复写原生置顶状态。
   * @param {Electron.BrowserWindow} win 当前迷你播放器窗口。
   * @returns {void}
   */
  function keepMiniPlayerOnTop(win) {
    if (!win || win.isDestroyed()) return;
    try {
      if (!win.isAlwaysOnTop()) win.setAlwaysOnTop(true, 'screen-saver');
      if (win.isVisible()) win.moveTop();
    } catch (e) {
      console.warn('Mini player topmost recovery skipped:', e.message);
    }
  }

  /**
   * 销毁指定迷你窗口，并在其仍是当前所有者时释放主进程状态缓存。
   * @param {Electron.BrowserWindow} win 待销毁的迷你播放器窗口。
   * @returns {void}
   */
  function destroyMiniPlayerWindowInstance(win) {
    if (!win) return;
    miniPlayerRendererReloadWindows.delete(win);
    if (miniPlayerWindow === win) {
      miniPlayerWindow = null;
      miniPlayerUserMovePending = false;
      miniPlayerCoverDragSession = null;
      miniPlayerCoverDragGeneration = 0;
      miniPlayerDisplayTopologyDirty = false;
      miniPlayerPointerPassthrough = false;
      miniPlayerStateCache.setResident(false);
    }
    miniPlayerLastSentState = null;
    if (win.isDestroyed()) return;
    miniPlayerProgrammaticCloseWindows.add(win);
    win.destroy();
  }

  /**
   * 安排指定迷你窗口的 renderer 恢复；暂停会话和失去所有权的旧窗口直接忽略。
   * @param {Electron.BrowserWindow} win 触发故障的迷你播放器窗口。
   * @param {string} reason 恢复原因或 renderer 故障标识。
   * @returns {void}
   */
  function scheduleMiniPlayerWindowRecovery(win, reason) {
    if ((typeof isQuitting === 'function' ? isQuitting() : false)
      || miniPlayerRecoverySession.paused || !win || miniPlayerWindow !== win || miniPlayerProgrammaticCloseWindows.has(win)) return;
    if (miniPlayerRecreateTimer) return;
    if (miniPlayerCrashFailureCount >= MINI_PLAYER_CRASH_RECOVERY_LIMIT) {
      console.warn(`Mini player recovery hit limit (${MINI_PLAYER_CRASH_RECOVERY_LIMIT}); restoring main window: ${reason || 'unknown'}`);
      destroyMiniPlayerWindowInstance(win);
      if (typeof focusMainWindow === 'function') focusMainWindow();
      return;
    }
    miniPlayerCrashFailureCount += 1;
    const attempt = miniPlayerCrashFailureCount;
    const delay = Math.min(2400, 200 * attempt * attempt);
    console.warn(`Mini player recovery scheduled (attempt ${attempt}, ${delay}ms): ${reason || 'unknown'}`);
    miniPlayerRecreateTimer = setTimeout(() => {
      miniPlayerRecreateTimer = null;
      if (miniPlayerWindow !== win || win.isDestroyed()) {
        if (shouldShowMiniPlayerNow()) showMiniPlayerWindow();
        return;
      }
      const contents = win.webContents;
      const rendererGone = String(reason || '').startsWith('renderer-gone:');
      if (!contents.isDestroyed() && (rendererGone || contents.isCrashed()) && !miniPlayerRendererReloadWindows.has(win)) {
        try {
          miniPlayerRendererReloadWindows.add(win);
          advanceMiniPlayerCoverDragGeneration();
          contents.reload();
          scheduleMiniPlayerRecovery(800);
          return;
        } catch (e) {
          console.warn('Mini player renderer reload failed:', e.message);
        }
      }
      destroyMiniPlayerWindowInstance(win);
      if (shouldShowMiniPlayerNow()) showMiniPlayerWindow();
    }, delay);
    if (typeof miniPlayerRecreateTimer.unref === 'function') miniPlayerRecreateTimer.unref();
  }

  // —— 可信文档/frame 校验（源 :3920-3984）——

  /**
   * 校验迷你播放器主文档 URL，只允许当前本地服务端口与当前样式对应的单一页面。
   * @param {string} value 待校验的文档地址。
   * @param {'standard'|'compact'} mode 当前迷你播放器样式。
   * @returns {boolean} 地址属于当前可信迷你文档时返回 true。
   */
  function isTrustedMiniPlayerDocumentUrl(value, mode) {
    try {
      const parsed = new URL(String(value || ''));
      if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') return false;
      const expectedPort = Number((typeof getMainServerPort === 'function' ? getMainServerPort() : 0) || 3000);
      if (Number(parsed.port || 0) !== expectedPort) return false;
      const page = normalizeMiniPlayerMode(mode) === 'compact'
        ? '/mini-player-compact.html'
        : '/mini-player.html';
      return parsed.pathname === page;
    } catch (_error) {
      return false;
    }
  }

  /**
   * 校验迷你 IPC 是否来自当前窗口、当前主 frame 与当前样式对应的可信本地文档。
   * @param {Electron.IpcMainInvokeEvent} event IPC 调用事件。
   * @returns {boolean} 事件来自当前可信迷你主文档时返回 true。
   */
  function isTrustedMiniPlayerFrameSender(event) {
    try {
      if (!event || !event.sender || !miniPlayerWindow || miniPlayerWindow.isDestroyed()) return false;
      if (event.sender !== miniPlayerWindow.webContents) return false;
      if (typeof event.sender.isDestroyed === 'function' && event.sender.isDestroyed()) return false;
      const mode = miniPlayerModeForWindow(miniPlayerWindow);
      const frame = event.senderFrame || null;
      // senderFrame 缺失时无法证明调用来自主 frame；getURL 只代表主文档，不能替代来源身份。
      if (!frame || frame.parent) return false;
      if (event.sender.mainFrame && frame !== event.sender.mainFrame) return false;
      return isTrustedMiniPlayerDocumentUrl(frame.url, mode);
    } catch (_error) {
      return false;
    }
  }

  /**
   * 校验右键事件是否来自当前迷你窗口的可信主 frame。
   * renderer context-menu 会带 frame；Windows 的 system-context-menu 没有 frame，
   * 此时只回退到当前 mainFrame 或当前文档 URL，不能接受任意缺失来源。
   * @param {Electron.BrowserWindow} win 当前迷你播放器窗口。
   * @param {'standard'|'compact'} mode 当前窗口创建时固定的样式。
   * @param {Electron.WebFrameMain=} frame renderer 传来的右键 frame。
   * @returns {boolean} 可信主 frame 时返回 true。
   */
  function isTrustedMiniPlayerMainFrame(win, mode, frame) {
    try {
      if (!win || win.isDestroyed() || miniPlayerWindow !== win || !win.webContents) return false;
      const contents = win.webContents;
      const mainFrame = contents.mainFrame || null;
      if (frame) {
        if (frame.parent) return false;
        if (mainFrame && frame !== mainFrame) return false;
        return isTrustedMiniPlayerDocumentUrl(frame.url, mode);
      }
      if (mainFrame) {
        if (mainFrame.parent) return false;
        return isTrustedMiniPlayerDocumentUrl(mainFrame.url, mode);
      }
      const url = typeof contents.getURL === 'function' ? contents.getURL() : '';
      return isTrustedMiniPlayerDocumentUrl(url, mode);
    } catch (_error) {
      return false;
    }
  }

  /**
   * 安装迷你窗口导航守卫，阻止 URL 拖放、未来链接或子 frame 把带 preload 的窗口导航到外部页面。
   * @param {Electron.BrowserWindow} win 当前迷你播放器窗口。
   * @param {'standard'|'compact'} mode 当前窗口创建时固定的样式。
   * @returns {void}
   */
  function installMiniPlayerNavigationGuard(win, mode) {
    if (!win || !win.webContents || typeof win.webContents.on !== 'function') return;
    win.webContents.on('will-navigate', (event, details, _url, _isInPlace, isMainFrame) => {
      const url = details && typeof details === 'object' ? details.url : String(details || '');
      const fromMainFrame = details && typeof details === 'object' && 'isMainFrame' in details
        ? details.isMainFrame
        : isMainFrame !== false;
      if (fromMainFrame && isTrustedMiniPlayerDocumentUrl(url, mode)) return;
      event.preventDefault();
    });
    win.webContents.on('will-frame-navigate', (event, details) => {
      const url = details && typeof details === 'object' ? details.url : String(details || '');
      const frame = details && typeof details === 'object' ? (details.frame || null) : null;
      if (frame && frame.parent) {
        event.preventDefault();
        return;
      }
      if (details && details.isMainFrame === true && isTrustedMiniPlayerDocumentUrl(url, mode)) return;
      event.preventDefault();
    });
    win.webContents.on('will-redirect', (event, details, _url, _isInPlace, isMainFrame) => {
      const targetUrl = details && typeof details === 'object' ? details.url : String(details || '');
      const fromMainFrame = details && typeof details === 'object' && 'isMainFrame' in details
        ? details.isMainFrame
        : isMainFrame !== false;
      if (fromMainFrame && isTrustedMiniPlayerDocumentUrl(targetUrl, mode)) return;
      event.preventDefault();
    });
  }

  /**
   * pill 右键菜单命令分支（R2 语义，与 CHANNEL_COMMAND 的 'close' 路由同一实现，不 fork 逻辑）：
   * 恒隐藏 pill；壁纸桌面层在跑时另唤回主窗并转发 exit-wallpaper，否则不唤窗。
   * @returns {{ok:boolean}} 处理结果。
   */
  function handleMiniPlayerCloseCommand() {
    hideMiniPlayerWindow();
    const wallpaperActive = typeof isWallpaperDesktopActive === 'function' && isWallpaperDesktopActive();
    if (wallpaperActive) {
      if (typeof focusMainWindow === 'function') focusMainWindow();
      const win = getMainWindow();
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(CHANNEL_COMMAND, { action: 'exit-wallpaper' });
      }
    }
    return { ok: true };
  }

  /**
   * 迷你播放器右键菜单模板（项形状对照源托盘模板 :2088-2093 的 checkbox+click 惯用法）：
   * 恢复 / 极简（模式切换，radio 于标准↔极简间切换）/ 关闭壁纸模式（复用 R2 close 路由）。
   * @returns {Array<{label:string, click?:Function, type?:string, checked?:boolean}>} 菜单模板。
   */
  function buildMiniPlayerContextMenuTemplate() {
    return [
      { label: '恢复', click: () => { if (typeof focusMainWindow === 'function') focusMainWindow(); } },
      {
        label: '极简',
        type: 'checkbox',
        checked: miniPlayerMode === 'compact',
        click: (item) => setMode(item.checked ? 'compact' : 'standard'),
      },
      { label: '关闭壁纸模式', click: () => handleMiniPlayerCloseCommand() },
    ];
  }

  /**
   * 在迷你播放器上弹出应用右键菜单，每一项都可点，菜单弹在鼠标当前位置。（源 :4029-4034）
   * @param {Electron.BrowserWindow} win 当前迷你播放器窗口。
   * @param {Electron.WebFrameMain=} frame renderer 右键事件所属的主 frame；系统菜单兜底没有该参数。
   * @returns {void}
   */
  function showMiniPlayerContextMenu(win, frame) {
    if (!win || win.isDestroyed() || miniPlayerWindow !== win) return;
    const mode = miniPlayerModeForWindow(win);
    if (!isTrustedMiniPlayerMainFrame(win, mode, frame)) return;
    if (!Menu || typeof Menu.buildFromTemplate !== 'function') return;
    Menu.buildFromTemplate(buildMiniPlayerContextMenuTemplate()).popup({ window: win });
  }

  /**
   * 处理 renderer 客户区右键。renderer 事件必须带真实主 frame；缺失 frame 不能先 preventDefault，
   * 否则既不能证明来源，又会把浏览器/桌面原本的右键吞掉。（源 :4045-4051）
   * @param {Electron.BrowserWindow} win 当前迷你播放器窗口。
   * @param {'standard'|'compact'} mode 当前窗口创建时固定的样式。
   * @param {Electron.Event} event 右键事件。
   * @param {Electron.ContextMenuParams=} params Electron 右键参数。
   * @returns {boolean} 已接管应用菜单时返回 true。
   */
  function handleMiniPlayerRendererContextMenu(win, mode, event, params) {
    const frame = params && params.frame;
    if (!frame || !isTrustedMiniPlayerMainFrame(win, mode, frame)) return false;
    event.preventDefault();
    showMiniPlayerContextMenu(win, frame);
    return true;
  }

  /**
   * 处理 Windows/Linux 非客户区右键兜底。该事件没有 frame，只能校验当前 webContents 的主 frame。（源 :4060-4065）
   * @param {Electron.BrowserWindow} win 当前迷你播放器窗口。
   * @param {'standard'|'compact'} mode 当前窗口创建时固定的样式。
   * @param {Electron.Event} event 系统右键事件。
   * @returns {boolean} 已接管应用菜单时返回 true。
   */
  function handleMiniPlayerSystemContextMenu(win, mode, event) {
    if (!isTrustedMiniPlayerMainFrame(win, mode)) return false;
    event.preventDefault();
    showMiniPlayerContextMenu(win);
    return true;
  }

  /**
   * 在系统休眠期间暂停迷你播放器恢复，避免后台重载或重建 renderer。（源 :4071-4073）
   * @returns {void}
   */
  function handleMiniPlayerSystemSuspend() {
    miniPlayerRecoverySession.pause('suspend');
  }

  /**
   * 系统唤醒后解除休眠原因；若屏幕仍锁定则继续保持暂停。（源 :4079-4081）
   * @returns {void}
   */
  function handleMiniPlayerSystemResume() {
    miniPlayerRecoverySession.resume('suspend', 180);
  }

  /**
   * 屏幕锁定时暂停迷你播放器恢复，避免锁屏会话继续占用资源。（源 :4087-4089）
   * @returns {void}
   */
  function handleMiniPlayerScreenLock() {
    miniPlayerRecoverySession.pause('screen');
  }

  /**
   * 屏幕解锁后解除锁屏原因；若系统仍处于休眠原因则不提前恢复。（源 :4095-4097）
   * @returns {void}
   */
  function handleMiniPlayerScreenUnlock() {
    miniPlayerRecoverySession.resume('screen', 180);
  }

  /**
   * 把迷你播放器放回默认或用户坐标。程序定位前清除未完成的用户拖动标记。
   * @returns {void}
   */
  function positionMiniPlayerWindow() {
    if (!miniPlayerWindow || miniPlayerWindow.isDestroyed()) return;
    const mode = miniPlayerModeForWindow(miniPlayerWindow);
    const storedBounds = miniPlayerUserBoundsByMode[mode];
    const nextBounds = clampBounds(storedBounds || defaultBoundsForMode(mode), mode);
    miniPlayerUserMovePending = false;
    miniPlayerCoverDragSession = null;
    miniPlayerWindow.setBounds(nextBounds, false);
    if (mode === 'standard') {
      const direction = miniPlayerExpandDirectionFromBoundsState({
        ...nextBounds,
        expandDirection: storedBounds && storedBounds.expandDirection,
      }, screen.getDisplayMatching(nextBounds) || screen.getPrimaryDisplay());
      miniPlayerExpandDirections.set(miniPlayerWindow, direction);
      if (storedBounds) persistMiniPlayerUserBounds({ ...nextBounds, expandDirection: direction }, mode);
    } else if (storedBounds) {
      persistMiniPlayerUserBounds(nextBounds, mode);
    }
    sendMiniPlayerState();
  }

  const miniPlayerRecoverySession = new MiniPlayerRecoverySession({
    stopRecoveryTimer: stopMiniPlayerRecoveryTimer,
    stopRecreateTimer: stopMiniPlayerRecreateTimer,
    scheduleRecovery: scheduleMiniPlayerRecovery,
  });

  // —— 原生事件自挂（源 :5892-5925 中迷你播放器切片）：init 挂载，dispose 全量解挂 ——
  const nativeEventListenerEntries = [];
  /**
   * 向注入的事件宿主（screen / powerMonitor）挂一个可在 dispose 中解挂的监听。
   * @param {{on?:Function,removeListener?:Function}} emitter 事件宿主；未注入时静默跳过。
   * @param {string} event 事件名。
   * @param {Function} listener 处理函数（保持引用以便 removeListener）。
   * @returns {void}
   */
  function attachNativeEventListener(emitter, event, listener) {
    if (!emitter || typeof emitter.on !== 'function' || typeof emitter.removeListener !== 'function') return;
    emitter.on(event, listener);
    nativeEventListenerEntries.push({ emitter, event, listener });
  }

  /**
   * 解挂全部 runtime 自挂的原生事件监听；dispose() 调用，保证释放后不再有后台回调。
   * @returns {void}
   */
  function detachNativeEventListeners() {
    for (const { emitter, event, listener } of nativeEventListenerEntries) {
      try { emitter.removeListener(event, listener); } catch (_) { /* 宿主已销毁时忽略 */ }
    }
    nativeEventListenerEntries.length = 0;
  }

  // 拓扑变化后先按封面锚点回正窗口，再短延迟补一轮显示恢复（源 display-* 分支的两行迷你播放器调用）。
  function handleMiniPlayerDisplayTopologyEvent() {
    handleMiniPlayerDisplayTopologyChanged();
    scheduleMiniPlayerRecovery(80);
  }

  // screen/powerMonitor 在 app ready 前不可触碰（screen 模块 load 期访问直接抛错），
  // 挂到 whenReady 之后；disposed 置位则不再补挂。
  let nativeListenersInstalled = false;
  let runtimeDisposed = false;
  function installNativeEventListeners() {
    if (nativeListenersInstalled || runtimeDisposed) return;
    nativeListenersInstalled = true;
    attachNativeEventListener(screen, 'display-added', handleMiniPlayerDisplayTopologyEvent);
    attachNativeEventListener(screen, 'display-removed', handleMiniPlayerDisplayTopologyEvent);
    attachNativeEventListener(screen, 'display-metrics-changed', handleMiniPlayerDisplayTopologyEvent);
    attachNativeEventListener(powerMonitor, 'suspend', handleMiniPlayerSystemSuspend);
    attachNativeEventListener(powerMonitor, 'lock-screen', handleMiniPlayerScreenLock);
    attachNativeEventListener(powerMonitor, 'resume', handleMiniPlayerSystemResume);
    attachNativeEventListener(powerMonitor, 'unlock-screen', handleMiniPlayerScreenUnlock);
  }

  // —— 坐标持久化水合（源 savedMiniPlayerBounds :3594-3609 的读取侧）：非法值忽略、合法值夹回工作区 ——
  // 合法坐标的夹取要读 screen.getDisplayMatching，因此必须与原生监听同处 ready 闸内：
  // 落盘文件存在时在 load 期水合会让整个 app 抛错起不来。
  function hydrateSavedMiniPlayerBounds() {
    const initialBoundsState = readMiniPlayerBoundsState();
    miniPlayerUserBoundsByMode.standard =
      savedMiniPlayerBounds(initialBoundsState.miniPlayerBounds, 'standard');
    miniPlayerUserBoundsByMode.compact =
      savedMiniPlayerBounds(initialBoundsState.miniPlayerCompactBounds, 'compact');
  }

  function startReadyGatedStartup() {
    installNativeEventListeners();
    if (!runtimeDisposed) hydrateSavedMiniPlayerBounds();
  }
  const appModule = deps.app && deps.app.isReady ? deps.app : require('electron').app;
  if (appModule && appModule.isReady && appModule.isReady()) startReadyGatedStartup();
  else if (appModule && appModule.whenReady) {
    Promise.resolve(appModule.whenReady()).then(startReadyGatedStartup).catch(function () {});
  } else {
    startReadyGatedStartup();
  }

  /**
   * 把主进程缓存的迷你播放器状态按字段增量发送给迷你 renderer。
   * @param {boolean} force 是否忽略上次发送快照并发送完整状态。
   * @returns {void}
   */
  function sendMiniPlayerState(force = false) {
    const win = miniPlayerWindow;
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    const includeCover = miniPlayerModeForWindow(win) === 'standard';
    const state = miniPlayerStateCache.value;
    const visual = state.visual || {};
    const visualSignature = JSON.stringify(visual);
    const themeVars = state.themeVars || {};
    const next = {
      themeVars,
      themeSignature: miniPlayerThemeSignature(themeVars),
      title: state.title || 'Stellaflix',
      artist: state.artist || '',
      playing: !!state.playing,
      hasTrack: !!state.hasTrack,
      desktopLyrics: state.desktopLyrics === true,
      metaSignature: state.metaSignature || '',
      uiLanguage: state.uiLanguage === 'en' ? 'en' : 'zh-CN',
    };
    if (includeCover) {
      next.cover = state.cover || '';
      next.pulse = Number.isFinite(state.pulse) ? state.pulse : 0;
      next.visual = visual;
      next.visualSignature = visualSignature;
      next.expandDirection = miniPlayerExpandDirectionForWindow(win);
      // renderer 重载后会从这份种子继续递增，迟到的旧拖动请求不会和新页面复用同一代际。
      next.dragGeneration = miniPlayerCoverDragGeneration;
    }
    const previous = miniPlayerLastSentState;
    const patch = {};
    let changed = false;
    const metadataChanged = force || !previous
      || next.metaSignature !== previous.metaSignature
      || next.title !== previous.title
      || next.artist !== previous.artist
      || (includeCover && next.cover !== previous.cover);
    if (metadataChanged) {
      patch.title = next.title;
      patch.artist = next.artist;
      if (includeCover) patch.cover = next.cover;
      changed = true;
    }
    if (force || !previous || next.playing !== previous.playing) {
      patch.playing = next.playing;
      changed = true;
    }
    if (force || !previous || next.hasTrack !== previous.hasTrack) {
      patch.hasTrack = next.hasTrack;
      changed = true;
    }
    if (force || !previous || next.desktopLyrics !== previous.desktopLyrics) {
      patch.desktopLyrics = next.desktopLyrics;
      changed = true;
    }
    if (force || !previous || next.uiLanguage !== previous.uiLanguage) {
      patch.uiLanguage = next.uiLanguage;
      changed = true;
    }
    // 主题变量整表发：迷你窗口拿到的是最终值，自己不需要知道哪个插件在生效。
    if (force || !previous || next.themeSignature !== previous.themeSignature) {
      patch.themeVars = next.themeVars;
      changed = true;
    }
    if (includeCover && (force || !previous || next.pulse !== previous.pulse)) {
      patch.pulse = next.pulse;
      changed = true;
    }
    if (includeCover && (force || !previous || next.visualSignature !== previous.visualSignature)) {
      patch.visual = next.visual;
      changed = true;
    }
    if (includeCover && (force || !previous || next.expandDirection !== previous.expandDirection)) {
      patch.expandDirection = next.expandDirection;
      changed = true;
    }
    if (includeCover && (force || !previous || next.dragGeneration !== previous.dragGeneration)) {
      patch.dragGeneration = next.dragGeneration;
      changed = true;
    }
    if (!changed) return;
    try {
      // 只发给 pill 窗口；绝不把该事件回发 pill 之外的窗口，pill→main 命令事件也只发给主窗。
      win.webContents.send(CHANNEL_STATE, patch);
      miniPlayerLastSentState = next;
    } catch (e) {
      console.warn('Mini player state sync failed:', e.message);
      scheduleMiniPlayerWindowRecovery(win, 'state-sync-failed');
    }
  }

  /**
   * 创建当前迷你播放器窗口，并建立只属于该窗口生命周期的状态缓存驻留。
   * @returns {Electron.BrowserWindow} 当前可复用或新创建的迷你播放器窗口。
   */
  function createMiniPlayerWindow() {
    if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) return miniPlayerWindow;
    miniPlayerWindow = null;
    miniPlayerUserMovePending = false;
    miniPlayerCoverDragSession = null;
    miniPlayerCoverDragGeneration = 0;
    miniPlayerDisplayTopologyDirty = false;
    // 新窗口默认参与命中，穿透缓存必须重置，否则新 renderer 的首次上报会被当成重复请求丢掉。
    miniPlayerPointerPassthrough = false;
    miniPlayerStateCache.setResident(false);
    const mode = normalizeMiniPlayerMode(miniPlayerMode);
    const storedBounds = miniPlayerUserBoundsByMode[mode];
    const bounds = clampBounds(storedBounds || defaultBoundsForMode(mode), mode);
    const win = new BrowserWindow({
      ...bounds,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      movable: true,
      focusable: true,
      skipTaskbar: true,
      show: false,
      autoHideMenuBar: true,
      title: 'Stellaflix Mini Player',
      icon: APP_ICON_ICO,
      webPreferences: {
        preload: path.join(__dirname, 'mini-player-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    miniPlayerWindow = win;
    miniPlayerWindowModes.set(win, mode);
    if (mode === 'standard') {
      miniPlayerCoverLayouts.set(win, 'collapsed');
      miniPlayerExpandDirections.set(win, miniPlayerExpandDirectionFromBoundsState({
        ...bounds,
        expandDirection: storedBounds && storedBounds.expandDirection,
      }, screen.getDisplayMatching(bounds) || screen.getPrimaryDisplay()));
    }
    // state-cache apply() 需要 enabled && resident 双门；pill 窗口存在即驻留，否则补丁会被静默丢弃。
    miniPlayerStateCache.setResident(true);
    requestMiniPlayerStateSync();
    keepMiniPlayerOnTop(win);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    installMiniPlayerNavigationGuard(win, mode);
    win.webContents.on('context-menu', (event, params) => {
      handleMiniPlayerRendererContextMenu(win, mode, event, params);
    });
    // 两套外壳都固定为 `-webkit-app-region: no-drag`，右键由 renderer 客户区统一接管，窗口移动走指针事件 + IPC。
    // 保留 system-context-menu 仅作平台兜底：若宿主仍把某个区域当成非客户区，先校验当前主 frame 再换成应用菜单。
    win.on('system-context-menu', (event) => {
      handleMiniPlayerSystemContextMenu(win, mode, event);
    });
    win.once('ready-to-show', () => {
      if (miniPlayerWindow !== win || win.isDestroyed() || !shouldShowMiniPlayerNow()) return;
      if (!isTrustedMiniPlayerDocumentUrl(win.webContents.getURL(), mode)) {
        scheduleMiniPlayerWindowRecovery(win, 'untrusted-document');
        return;
      }
      positionMiniPlayerWindow();
      if (win.isMinimized()) win.restore();
      win.showInactive();
      keepMiniPlayerOnTop(win);
      sendMiniPlayerState(true);
      scheduleMiniPlayerRecovery();
    });
    win.webContents.on('did-finish-load', () => {
      if (miniPlayerWindow !== win) return;
      advanceMiniPlayerCoverDragGeneration();
      if (!isTrustedMiniPlayerDocumentUrl(win.webContents.getURL(), mode)) {
        scheduleMiniPlayerWindowRecovery(win, 'untrusted-document');
        return;
      }
      miniPlayerRendererReloadWindows.delete(win);
      miniPlayerCrashFailureCount = 0;
      miniPlayerLastSentState = null;
      if (shouldShowMiniPlayerNow()) showMiniPlayerWindow();
      else sendMiniPlayerState(true);
    });
    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (isMainFrame === false || errorCode === -3) return;
      scheduleMiniPlayerWindowRecovery(win, `load-failed:${errorCode}:${errorDescription}`);
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      scheduleMiniPlayerWindowRecovery(win, `renderer-gone:${details && details.reason || 'unknown'}`);
    });
    win.on('will-move', beginMiniPlayerUserMove.bind(null, win));
    win.on('moved', handleMiniPlayerMoved.bind(null, win));
    win.on('show', () => {
      if (miniPlayerWindow !== win || !shouldShowMiniPlayerNow()) return;
      keepMiniPlayerOnTop(win);
      scheduleMiniPlayerRecovery();
    });
    win.on('hide', () => {
      if (miniPlayerWindow === win && shouldShowMiniPlayerNow()) scheduleMiniPlayerRecovery(0);
    });
    win.on('minimize', () => {
      if (miniPlayerWindow === win && shouldShowMiniPlayerNow()) scheduleMiniPlayerRecovery(0);
    });
    win.on('always-on-top-changed', (_event, isAlwaysOnTop) => {
      if (!isAlwaysOnTop && miniPlayerWindow === win && shouldShowMiniPlayerNow()) scheduleMiniPlayerRecovery(0);
    });
    win.on('close', (event) => {
      if ((typeof isQuitting === 'function' ? isQuitting() : false) || miniPlayerProgrammaticCloseWindows.has(win)) return;
      event.preventDefault();
      if (typeof focusMainWindow === 'function') focusMainWindow();
    });
    /**
     * 在当前窗口意外关闭时释放其状态所有权；旧窗口迟到事件不得清理替代窗口缓存。
     * @returns {void}
     */
    win.on('closed', () => {
      const wasCurrent = miniPlayerWindow === win;
      if (wasCurrent) {
        miniPlayerWindow = null;
        miniPlayerUserMovePending = false;
        miniPlayerCoverDragSession = null;
        miniPlayerPointerPassthrough = false;
        miniPlayerLastSentState = null;
        miniPlayerStateCache.setResident(false);
      }
      if (wasCurrent && !(typeof isQuitting === 'function' ? isQuitting() : false)
        && !miniPlayerProgrammaticCloseWindows.has(win) && shouldShowMiniPlayerNow()) {
        scheduleMiniPlayerRecovery(120);
      }
    });
    const page = mode === 'compact' ? 'mini-player-compact.html' : 'mini-player.html';
    win.loadURL(overlayUrl(page)).catch((e) => {
      console.warn('Mini player load failed:', e.message);
      scheduleMiniPlayerWindowRecovery(win, 'load-rejected');
    });
    return win;
  }

  /**
   * 显示或恢复迷你播放器。已健康显示时只校正层级，不重复触发显示和状态同步。
   * @returns {void}
   */
  function showMiniPlayerWindow() {
    if (!shouldShowMiniPlayerNow()) {
      stopMiniPlayerRecoveryTimer();
      return;
    }
    // 已经进入迷你模式，预热窗口转为正常生命周期，不能再被丢弃计时器回收。
    stopMiniPlayerPrewarmTimer();
    miniPlayerPrewarmWindow = null;
    const win = createMiniPlayerWindow();
    scheduleMiniPlayerRecovery();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    if (win.webContents.isCrashed()) {
      scheduleMiniPlayerWindowRecovery(win, 'guard-detected-crash');
      return;
    }
    if (win.webContents.isLoadingMainFrame()) return;
    if (!isTrustedMiniPlayerDocumentUrl(win.webContents.getURL(), miniPlayerModeForWindow(win))) {
      // 恢复可能跨过锁屏/休眠暂停边界，显示前再拦一次，避免旧窗口留在外部文档。
      destroyMiniPlayerWindowInstance(win);
      if (shouldShowMiniPlayerNow()) scheduleMiniPlayerRecovery(120);
      return;
    }
    const wasVisible = win.isVisible();
    const wasMinimized = win.isMinimized();
    if (wasMinimized) win.restore();
    if (!wasVisible || wasMinimized) {
      positionMiniPlayerWindow();
      win.showInactive();
    }
    keepMiniPlayerOnTop(win);
    if (!wasVisible || wasMinimized) sendMiniPlayerState(true);
  }

  /**
   * 在主窗口恢复后释放迷你播放器。隐藏 BrowserWindow 仍会保留独立渲染进程，
   * 下次进入迷你模式时按当前主进程状态重新创建即可，不需要为不可见窗口常驻内存。
   * @returns {void}
   */
  function hideMiniPlayerWindow() {
    closeMiniPlayerWindow();
  }

  function closeMiniPlayerWindow() {
    stopMiniPlayerRecoveryTimer();
    stopMiniPlayerRecreateTimer();
    stopMiniPlayerPrewarmTimer();
    miniPlayerPrewarmWindow = null;
    const win = miniPlayerWindow;
    if (win) destroyMiniPlayerWindowInstance(win);
    miniPlayerLastSentState = null;
  }

  /**
   * 计算迷你窗口中心相对主窗口内容区的归一化坐标，供主 renderer 作为收缩动画原点。
   * 越界坐标按 -0.6 ~ 1.6 收敛，异常主窗口尺寸直接返回 null 让 renderer 用默认原点。（源 :4303-4315）
   * @returns {{x:number,y:number}|null} 归一化收缩原点。
   */
  function miniPlayerTransitionOrigin() {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return null;
    const mode = normalizeMiniPlayerMode(miniPlayerMode);
    const target = clampBounds(miniPlayerUserBoundsByMode[mode] || defaultBoundsForMode(mode), mode);
    const main = win.getBounds();
    if (!main || !(Number(main.width) > 0) || !(Number(main.height) > 0)) return null;
    const centerX = Number(target.x) + Number(target.width) / 2;
    const centerY = Number(target.y) + Number(target.height) / 2;
    return {
      x: Math.round(clampNumber((centerX - Number(main.x)) / Number(main.width), -0.6, 1.6, 0.5) * 1000) / 1000,
      y: Math.round(clampNumber((centerY - Number(main.y)) / Number(main.height), -0.6, 1.6, 0.5) * 1000) / 1000,
    };
  }

  /**
   * 丢弃未被使用的预热窗口。主窗口最终没有进入迷你模式时必须释放，
   * 已经进入迷你模式或窗口已经显示时保持原生命周期，不误关正在服务的窗口。（源 :4322-4330）
   * @returns {void}
   */
  function discardMiniPlayerPrewarm() {
    stopMiniPlayerPrewarmTimer();
    const win = miniPlayerPrewarmWindow;
    miniPlayerPrewarmWindow = null;
    if (!win || win.isDestroyed()) return;
    if (miniPlayerWindow !== win) return;
    if (shouldShowMiniPlayerNow() || win.isVisible()) return;
    closeMiniPlayerWindow();
  }

  /**
   * 主窗口开始收缩动画时预热迷你窗口，让最小化落地时首帧已经就绪，消除冷启动空白间隙。
   * 同时回传收缩动画原点，使主界面朝迷你播放器实际所在的角落收拢。（源 :4337-4356）
   * @returns {{ok:boolean,prepared:boolean,enabled:boolean,mode:string,origin:({x:number,y:number}|null),error?:string}} 预热结果与动画原点。
   */
  function prepareMiniPlayerTransition() {
    const mode = normalizeMiniPlayerMode(miniPlayerMode);
    const win = getMainWindow();
    if (!win || win.isDestroyed()) {
      return { ok: false, prepared: false, enabled: !!miniPlayerEnabled, mode, origin: null, error: 'MAIN_WINDOW_UNAVAILABLE' };
    }
    const result = { ok: true, prepared: false, enabled: !!miniPlayerEnabled, mode, origin: miniPlayerTransitionOrigin() };
    if (!miniPlayerEnabled || miniPlayerRecoverySession.paused) return result;
    // 主窗口已经隐藏或最小化时迷你窗口归正常生命周期管理，不能再挂预热丢弃计时器。
    if (win.isMinimized() || !win.isVisible()) return result;
    const existing = miniPlayerWindow && !miniPlayerWindow.isDestroyed() ? miniPlayerWindow : null;
    if (existing && existing.isVisible()) return result;
    const nextWin = existing || createMiniPlayerWindow();
    if (!nextWin || nextWin.isDestroyed()) return result;
    miniPlayerPrewarmWindow = nextWin;
    result.prepared = true;
    stopMiniPlayerPrewarmTimer();
    miniPlayerPrewarmTimer = setTimeout(discardMiniPlayerPrewarm, MINI_PLAYER_PREWARM_TTL);
    if (typeof miniPlayerPrewarmTimer.unref === 'function') miniPlayerPrewarmTimer.unref();
    return result;
  }

  /**
   * 要求主 renderer 重新发送当前完整歌曲状态。
   * 重新启用功能时主进程缓存为空，必须显式补齐而不能等待下一次播放事件。
   * @returns {void}
   */
  function requestMiniPlayerStateSync() {
    const win = getMainWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send(CHANNEL_COMMAND, { action: 'sync-state' });
  }

  /**
   * 切换迷你播放器功能并同步持久化、内存状态和窗口生命周期。
   * @param {boolean} enabled 是否启用迷你播放器。
   * @returns {{ok:boolean, miniPlayerEnabled:boolean}} 主进程确认后的开关状态。
   */
  function setEnabled(enabled) {
    miniPlayerEnabled = !!enabled;
    miniPlayerStateCache.setEnabled(miniPlayerEnabled);
    // Task 6 扩展点：enabled/mode 的设置面板持久化与托盘刷新（源 writeDesktopShellSettings/refreshTrayMenu）；
    // 迷你播放器坐标落盘已由 runtime 自有 mini-player-bounds.json 接线（见 persistMiniPlayerBoundsSettings）。
    if (typeof deps.persistSettings === 'function') deps.persistSettings({ miniPlayer: miniPlayerEnabled });
    if (typeof deps.onSettingsChanged === 'function') deps.onSettingsChanged();
    if (miniPlayerEnabled) {
      const win = getMainWindow();
      if (win && !win.isDestroyed() && (win.isMinimized() || !win.isVisible())) miniPlayerActive = true;
      showMiniPlayerWindow();
    } else {
      miniPlayerActive = false;
      closeMiniPlayerWindow();
    }
    return { ok: true, miniPlayerEnabled };
  }

  function setMode(mode) {
    const nextMode = normalizeMiniPlayerMode(mode);
    const changed = nextMode !== miniPlayerMode;
    miniPlayerMode = nextMode;
    if (typeof deps.persistSettings === 'function') deps.persistSettings({ miniPlayerMode });
    if (typeof deps.onSettingsChanged === 'function') deps.onSettingsChanged();
    if (changed) {
      closeMiniPlayerWindow();
      if (shouldShowMiniPlayerNow()) showMiniPlayerWindow();
    }
    return { ok: true, miniPlayerMode };
  }

  /**
   * 主窗口状态变化的统一入口（源 :5758-5783 minimize/restore/show/hide 语义 + closed 释放）。
   * 主窗最小化或不可见 → 进入迷你模式并显示 pill；主窗可见 → 退出迷你模式并释放 pill；
   * 主窗销毁（closed）→ 同步释放 pill。
   * @returns {void}
   */
  function notifyMainWindowStateChanged() {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) {
      miniPlayerActive = false;
      hideMiniPlayerWindow();
      return;
    }
    if (win.isMinimized() || !win.isVisible()) {
      miniPlayerActive = !!miniPlayerEnabled;
      if (miniPlayerActive) showMiniPlayerWindow();
      else hideMiniPlayerWindow();
      return;
    }
    miniPlayerActive = false;
    hideMiniPlayerWindow();
  }

  /**
   * 主窗口被从迷你模式唤回时的清理：退出迷你模式并释放 pill 窗口。
   * focusMainWindow() 头部调用；幂等，不做提前返回。
   * @returns {void}
   */
  function focusFromMini() {
    miniPlayerActive = false;
    hideMiniPlayerWindow();
  }

  /**
   * 迷你播放器 runtime 状态快照。
   * @param {string} reason 调用原因（日志用）。
   * @returns {{ok:boolean,enabled:boolean,active:boolean,mode:string,visible:boolean,resident:boolean,paused:boolean,reason:string}}
   */
  function getStatus(reason = '') {
    const win = miniPlayerWindow && !miniPlayerWindow.isDestroyed() ? miniPlayerWindow : null;
    let visible = false;
    if (win) {
      try { visible = win.isVisible(); } catch (_) { /* 窗口正在销毁 */ }
    }
    return {
      ok: true,
      enabled: !!miniPlayerEnabled,
      active: !!miniPlayerActive,
      mode: normalizeMiniPlayerMode(miniPlayerMode),
      visible,
      resident: miniPlayerStateCache.resident === true,
      paused: miniPlayerRecoverySession.paused,
      reason: String(reason || ''),
    };
  }

  // —— IPC 注册（通道名与 Task 3 preload 逐字一致）——
  const mainWindowDeny = { ok: false, error: 'IPC_FORBIDDEN' };
  const handlerEntries = [];
  function register(channel, listener) {
    ipcMain.handle(channel, listener);
    handlerEntries.push({ channel, listener, kind: 'handle' });
  }
  function registerOn(channel, listener) {
    ipcMain.on(channel, listener);
    handlerEntries.push({ channel, listener, kind: 'on' });
  }

  register(CHANNEL_SET_ENABLED, (event, enabled) => {
    if (typeof isTrustedMainWindowEvent === 'function' && !isTrustedMainWindowEvent(event)) return mainWindowDeny;
    return setEnabled(enabled);
  });

  register(CHANNEL_SET_MODE, (event, mode) => {
    if (typeof isTrustedMainWindowEvent === 'function' && !isTrustedMainWindowEvent(event)) return mainWindowDeny;
    return setMode(mode);
  });

  register(CHANNEL_PREPARE_TRANSITION, (event) => {
    if (typeof isTrustedMainWindowEvent === 'function' && !isTrustedMainWindowEvent(event)) return mainWindowDeny;
    return prepareMiniPlayerTransition();
  });

  /**
   * 接收主 renderer 的迷你播放器状态补丁；禁用期间确认但不保留补丁。
   * @param {Electron.IpcMainInvokeEvent} event IPC 调用事件。
   * @param {unknown} payload 增量状态补丁。
   * @returns {{ok:boolean, ignored?:boolean, error?:string}} 补丁处理结果。
   */
  function handleMiniPlayerStateUpdate(event, payload) {
    const win = getMainWindow();
    if (!win || win.isDestroyed() || event.sender !== win.webContents) {
      return { ok: false, error: 'MINI_PLAYER_INVALID_SENDER' };
    }
    if (!miniPlayerStateCache.apply(payload)) return { ok: true, ignored: true };
    sendMiniPlayerState();
    return { ok: true };
  }

  register(CHANNEL_UPDATE, (event, payload) => {
    if (typeof isTrustedMainWindowEvent === 'function' && !isTrustedMainWindowEvent(event)) return mainWindowDeny;
    return handleMiniPlayerStateUpdate(event, payload);
  });

  /**
   * pill 窗口命令路由（R2 语义）。
   * 'restore' → focusMainWindow()；
   * 'close' → 恒隐藏 pill；壁纸桌面层在跑时另唤回主窗并转发 {action:'exit-wallpaper'}，
   * 否则（普通最小化）只隐藏 pill、不唤窗；
   * previous/toggle-play/next/toggle-desktop-lyrics → 原样转发主 renderer。
   * 注意：CHANNEL_COMMAND 双身份（pill→main invoke；main→主窗 event），
   * 事件只发主窗，绝不回发 pill 窗口，避免回声。
   */
  register(CHANNEL_COMMAND, (event, action) => {
    if (!isTrustedMiniPlayerFrameSender(event)) {
      return { ok: false, error: 'MINI_PLAYER_INVALID_SENDER' };
    }
    const command = String(action || '');
    if (command === 'restore') return { ok: !!(typeof focusMainWindow === 'function' && focusMainWindow()) };
    if (command === 'close') return handleMiniPlayerCloseCommand();
    if (!['toggle-play', 'previous', 'next', 'toggle-desktop-lyrics'].includes(command)) {
      return { ok: false, error: 'MINI_PLAYER_INVALID_COMMAND' };
    }
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return { ok: false, error: 'MAIN_WINDOW_UNAVAILABLE' };
    win.webContents.send(CHANNEL_COMMAND, { action: command });
    return { ok: true };
  });

  /**
   * 按标准迷你播放器封面的拖动偏移移动当前窗口，并同步内存坐标与展开方向。
   * 只有当前迷你播放器 renderer 可以调用，旧窗口或伪造 sender 直接忽略。（源 :4488-4580）
   * @param {Electron.IpcMainInvokeEvent} event IPC 调用事件。
   * @param {number} dx 水平位移，单次限制在 160 像素内。
   * @param {number} dy 垂直位移，单次限制在 160 像素内。
   * @param {boolean} commit 是否为拖动结束；只在结束时把内存坐标写入设置文件。
   * @param {{generation:number,anchor?:{x:number,y:number},layout?:'collapsed'|'expanded'}} dragMeta renderer
   *   首帧锚点与拖动代际；无元数据的旧调用只允许继续已有会话，不能凭空开启新会话。
   * @returns {{ok:boolean,ignored?:boolean,error?:string}} 移动结果。
   */
  function handleMiniPlayerMoveBy(event, dx, dy, commit, dragMeta) {
    if (!isTrustedMiniPlayerFrameSender(event)) {
      return { ok: true, ignored: true };
    }
    try {
      const request = normalizeMiniPlayerCoverDragMeta(dragMeta);
      if (request && request.generation < miniPlayerCoverDragGeneration) {
        // 旧拖动的 commit 可能在新拖动开始后才抵达；它不能覆盖新会话或清空新会话。
        return { ok: true, ignored: true };
      }
      const mode = miniPlayerModeForWindow(miniPlayerWindow);
      if (mode !== 'standard') return { ok: true, ignored: true };
      const bounds = miniPlayerWindow.getBounds();
      miniPlayerUserMovePending = false;
      if (request && (request.layout === 'collapsed' || request.layout === 'expanded')) {
        miniPlayerCoverLayouts.set(miniPlayerWindow, request.layout);
      }
      if (!request && !miniPlayerCoverDragSession) {
        // 无代际的迟到调用无法证明属于当前拖动；拒绝新开会话，避免重载后旧 commit 改写坐标。
        return { ok: true, ignored: true };
      }
      if (request && request.generation === miniPlayerCoverDragGeneration && !miniPlayerCoverDragSession) {
        // 同一代际已经 commit、原生移动或重定位后，迟到的重复请求不能重新开启会话。
        return { ok: true, ignored: true };
      }
      if (request && request.generation > miniPlayerCoverDragGeneration) {
        miniPlayerCoverDragGeneration = request.generation;
        miniPlayerCoverDragSession = beginMiniPlayerCoverDrag({
          bounds,
          direction: miniPlayerExpandDirectionForWindow(miniPlayerWindow),
          anchor: request.anchor,
          layout: request.layout,
        });
        miniPlayerCoverDragSession.generation = request.generation;
        miniPlayerCoverDragSession.lastBounds = { ...bounds };
      }
      if (!miniPlayerCoverDragSession) {
        miniPlayerCoverDragSession = beginMiniPlayerCoverDrag({
          bounds,
          direction: miniPlayerExpandDirectionForWindow(miniPlayerWindow),
          layout: miniPlayerCoverLayouts.get(miniPlayerWindow) || 'collapsed',
        });
        miniPlayerCoverDragSession.lastBounds = { ...bounds };
      }
      if (commit === true) {
        const session = miniPlayerCoverDragSession;
        const committedBounds = session.lastBounds || bounds;
        const direction = session.direction || miniPlayerExpandDirectionForWindow(miniPlayerWindow);
        const topologyAnchor = {
          x: session.coverX,
          y: session.coverY,
          layout: session.layout,
        };
        const storedBounds = { ...committedBounds, expandDirection: direction };
        miniPlayerUserBoundsByMode[mode] = storedBounds;
        persistMiniPlayerUserBounds(storedBounds, mode);
        miniPlayerCoverLayouts.set(miniPlayerWindow, topologyAnchor.layout);
        miniPlayerCoverDragSession = null;
        sendMiniPlayerState();
        if (typeof miniPlayerDisplayTopologyDirty !== 'undefined' && miniPlayerDisplayTopologyDirty) {
          reconcileMiniPlayerAfterDisplayTopology(topologyAnchor);
        }
        return { ok: true };
      }
      const deltaX = clampNumber(dx, -160, 160, 0);
      const deltaY = clampNumber(dy, -160, 160, 0);
      if (!deltaX && !deltaY) return { ok: true, ignored: true };
      const workArea = miniPlayerCoverDragWorkArea(miniPlayerCoverDragSession, deltaX, deltaY);
      const clampWorkArea = miniPlayerCoverDragClampWorkArea();
      try {
        const result = updateMiniPlayerCoverDrag(
          miniPlayerCoverDragSession,
          deltaX,
          deltaY,
          workArea,
          clampWorkArea,
        );
        const next = result.bounds;
        if (next.x !== bounds.x || next.y !== bounds.y) miniPlayerWindow.setBounds(next, false);
        miniPlayerExpandDirections.set(miniPlayerWindow, result.direction);
        miniPlayerCoverDragSession.lastBounds = { ...next };
        miniPlayerUserBoundsByMode[mode] = { ...next, expandDirection: result.direction };
        sendMiniPlayerState();
        return { ok: true };
      } catch (error) {
        // setBounds 失败时回滚逻辑坐标并结束本代会话，避免下一次增量沿着未落地的位置继续漂移。
        miniPlayerCoverDragSession = null;
        return { ok: false, error: error.message || 'MINI_PLAYER_MOVE_FAILED' };
      }
    } catch (e) {
      return { ok: false, error: e.message || 'MINI_PLAYER_MOVE_FAILED' };
    }
  }

  register(CHANNEL_MOVE_BY, handleMiniPlayerMoveBy);

  /**
   * 按极简外壳或展开态空白区的拖动偏移移动当前窗口。
   * 这是独立于封面代际会话的窗口移动通道；整窗 no-drag 后仍保留原本的拖动能力。（源 :4594-4623）
   * @param {Electron.IpcMainInvokeEvent} event IPC 调用事件。
   * @param {number} dx 水平位移，单次限制在 160 像素内。
   * @param {number} dy 垂直位移，单次限制在 160 像素内。
   * @param {boolean} commit 是否为拖动结束；只在结束时把内存坐标写入设置文件。
   * @param {'collapsed'|'expanded'} layout renderer 当前布局状态。
   * @returns {{ok:boolean,ignored?:boolean,error?:string}} 移动结果。
   */
  function handleMiniPlayerWindowMoveBy(event, dx, dy, commit, layout) {
    if (!isTrustedMiniPlayerFrameSender(event)) {
      return { ok: true, ignored: true };
    }
    const win = miniPlayerWindow;
    try {
      const mode = miniPlayerModeForWindow(win);
      const bounds = win.getBounds();
      const deltaX = clampNumber(dx, -160, 160, 0);
      const deltaY = clampNumber(dy, -160, 160, 0);
      if (layout === 'collapsed' || layout === 'expanded') miniPlayerCoverLayouts.set(win, layout);
      miniPlayerUserMovePending = false;
      const next = clampBounds({
        ...bounds,
        x: Math.round(bounds.x + deltaX),
        y: Math.round(bounds.y + deltaY),
      }, mode);
      if (next.x !== bounds.x || next.y !== bounds.y) win.setBounds(next, false);
      const storedBounds = mode === 'standard'
        ? {
          ...next,
          expandDirection: miniPlayerExpandDirectionForBounds(
            next,
            screen.getDisplayMatching(next) || screen.getPrimaryDisplay(),
          ),
        }
        : next;
      if (mode === 'standard') miniPlayerExpandDirections.set(win, storedBounds.expandDirection);
      miniPlayerUserBoundsByMode[mode] = storedBounds;
      if (commit === true) persistMiniPlayerUserBounds(storedBounds, mode);
      sendMiniPlayerState();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message || 'MINI_PLAYER_WINDOW_MOVE_FAILED' };
    }
  }

  register(CHANNEL_WINDOW_MOVE_BY, handleMiniPlayerWindowMoveBy);

  /**
   * 按标准迷你播放器收回态让出窗口鼠标事件。收回后窗口仍是固定的 360 × 84 透明窗口，
   * 只有封面热区需要参与命中；其余透明区域必须交还桌面，不能吞掉点击或被误拖动。
   * 只有当前迷你播放器 renderer 可以调用，旧窗口或伪造 sender 直接忽略。（源 :4635-4663）
   * @param {Electron.IpcMainInvokeEvent} event IPC 调用事件。
   * @param {boolean} passthrough 是否让出窗口鼠标事件。
   * @returns {{ok:boolean,ignored?:boolean,error?:string}} 穿透设置结果。
   */
  function handleMiniPlayerPointerPassthrough(event, passthrough) {
    if (!isTrustedMiniPlayerFrameSender(event)) {
      return { ok: true, ignored: true };
    }
    const mode = miniPlayerModeForWindow(miniPlayerWindow);
    if (mode !== 'standard') {
      // 极简播放器整窗必须保持可命中，切换模式时先撤销旧标准窗口遗留的穿透状态。
      if (miniPlayerPointerPassthrough) {
        try {
          miniPlayerWindow.setIgnoreMouseEvents(false);
          miniPlayerPointerPassthrough = false;
        } catch (e) {
          return { ok: false, error: e.message || 'MINI_PLAYER_PASSTHROUGH_FAILED' };
        }
      }
      return { ok: true, ignored: true };
    }
    const next = passthrough === true;
    if (miniPlayerPointerPassthrough === next) return { ok: true, ignored: true };
    try {
      // forward 保留鼠标移动转发，穿透期间 renderer 仍能靠转发坐标发现指针回到封面热区。
      if (next) miniPlayerWindow.setIgnoreMouseEvents(true, { forward: true });
      else miniPlayerWindow.setIgnoreMouseEvents(false);
      miniPlayerPointerPassthrough = next;
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || 'MINI_PLAYER_PASSTHROUGH_FAILED' };
    }
  }

  register(CHANNEL_SET_POINTER_PASSTHROUGH, handleMiniPlayerPointerPassthrough);

  // 收回态从穿透切回可命中必须同步完成，否则封面刚命中时的右键可能先落到桌面。（源 :4668-4674）
  registerOn(CHANNEL_SET_POINTER_PASSTHROUGH_SYNC, (event, passthrough) => {
    try {
      event.returnValue = handleMiniPlayerPointerPassthrough(event, passthrough);
    } catch (error) {
      event.returnValue = { ok: false, error: error.message || 'MINI_PLAYER_PASSTHROUGH_FAILED' };
    }
  });

  /**
   * 释放迷你播放器：停计时器、解挂原生事件、销毁 pill、注销 IPC 通道。app 退出路径调用。
   * @returns {void}
   */
  function dispose() {
    runtimeDisposed = true;
    for (const { channel, listener, kind } of handlerEntries) {
      try {
        if (kind === 'on') ipcMain.removeListener(channel, listener);
        else ipcMain.removeHandler(channel);
      } catch (_) { /* 通道未注册时忽略 */ }
    }
    handlerEntries.length = 0;
    detachNativeEventListeners();
    stopMiniPlayerRecoveryTimer();
    stopMiniPlayerRecreateTimer();
    stopMiniPlayerPrewarmTimer();
    miniPlayerPrewarmWindow = null;
    const win = miniPlayerWindow;
    if (win) destroyMiniPlayerWindowInstance(win);
    miniPlayerLastSentState = null;
    miniPlayerActive = false;
    miniPlayerStateCache.setEnabled(false);
  }

  return {
    notifyMainWindowStateChanged,
    focusFromMini,
    setEnabled,
    isEnabled: () => !!miniPlayerEnabled,
    getStatus,
    dispose,
  };
}

module.exports = {
  createMiniPlayerRuntime,
  // 纯函数导出（供测试与 Task 5 复用）；签名见各 JSDoc。
  clampMiniPlayerBounds,
  miniPlayerDefaultBounds,
  miniPlayerSize,
  miniPlayerBoundsSignature,
  normalizeMiniPlayerCoverDragMeta,
  normalizeMiniPlayerMode,
  shouldShowMiniPlayer,
};
