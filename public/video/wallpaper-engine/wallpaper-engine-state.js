var WALLPAPER_ENGINE_SELECTION_STORE_KEY = 'stellaflix-wallpaper-engine-selection-v1';
var WALLPAPER_ENGINE_HIDDEN_STORE_KEY = 'stellaflix-wallpaper-engine-hidden-v1';
var WALLPAPER_ENGINE_FAVORITE_STORE_KEY = 'stellaflix-wallpaper-engine-favorites-v1';
var wallpaperEngineProjects = [];
var wallpaperEngineLibrarySnapshot = null;
var wallpaperEngineMediaToken = '';
var wallpaperEngineLibraryBusy = false;
var wallpaperEngineLayerToken = 0;
var wallpaperEnginePreviewObserver = null;
var wallpaperEngineSearchRenderTimer = 0;
var wallpaperEnginePreviewScrollTimer = 0;
var wallpaperEngineSwitchTimer = 0;
var wallpaperEngineVideoRetryTimer = 0;
var wallpaperEngineFirstFrameWait = null;
var wallpaperEngineCaptureStream = null;
var wallpaperEnginePreparedCaptureStreams = new Map();
var wallpaperEngineGlassCaptureStream = null;
var wallpaperEnginePreparedGlassCaptureStreams = new Map();
var wallpaperEngineGlassCaptureToken = 0;
var wallpaperEngineGlassCaptureRetryTimer = 0;
var wallpaperEngineGlassCaptureRetryAttempt = 0;
var wallpaperEngineCaptureMode = '';
var wallpaperEngineNativeSessionId = '';
var wallpaperEngineHostBoundsRestartTimer = 0;
var wallpaperEngineHostBoundsUnsubscribe = null;
var wallpaperEngineHostBoundsPreparing = false;
var wallpaperEngineDesktopPreviewActive = false;
var wallpaperEngineDesktopPreviewUsesAsset = false;
var wallpaperEngineHostRecoveryInFlight = false;
var wallpaperEngineHostRecoveryAttempt = 0;
var wallpaperEngineHostRecoveryRetryTimer = 0;
var wallpaperEngineFreezeReleaseTimer = 0;
var wallpaperEngineFreezeGeneration = 0;
var wallpaperEngineFreezeVisible = false;
var wallpaperEngineCaptureViewportScaleX = 1;
var wallpaperEngineCaptureViewportScaleY = 1;
var wallpaperEnginePointerActivityTimer = 0;
var wallpaperEnginePointerActivityLastSentAt = 0;
var wallpaperEnginePointerActivityLatestX = 32768;
var wallpaperEnginePointerActivityLatestY = 32768;
var wallpaperEnginePointerActivityHasPoint = false;
var wallpaperEngineRenderLimit = 240;
var wallpaperEngineRuntimeError = '';
var wallpaperEngineProjectDetailsId = '';
var WALLPAPER_ENGINE_SWITCH_FADE_MS = 440;
var WALLPAPER_ENGINE_RENDER_BATCH = 240;
var WALLPAPER_ENGINE_PREPARED_STREAM_TTL_MS = 12000;
var WALLPAPER_ENGINE_FIRST_FRAME_TIMEOUT_MS = 8000;
var WALLPAPER_ENGINE_FREEZE_FADE_MS = 180;
var WALLPAPER_ENGINE_HOST_RECOVERY_MAX_ATTEMPTS = 3;
var WALLPAPER_ENGINE_POINTER_ACTIVITY_INTERVAL_MS = 8;

// 2026-08-19: 移植自 Stellaflix 2.1.0 — Wallpaper Engine 默认启用
// 渲染侧跟随主进程开关；若主进程未暴露（如浏览器调试），默认启用
var WALLPAPER_ENGINE_ENABLED = (function () {
  try {
    if (window.desktopWindow && typeof window.desktopWindow.wallpaperEngineEnabled === 'boolean') {
      return window.desktopWindow.wallpaperEngineEnabled;
    }
  } catch (e) { }
  return true;
})();

function cancelWallpaperEnginePointerActivity() {
  if (wallpaperEnginePointerActivityTimer) clearTimeout(wallpaperEnginePointerActivityTimer);
  wallpaperEnginePointerActivityTimer = 0;
  wallpaperEnginePointerActivityLastSentAt = 0;
}

function wallpaperEnginePointerActivityReady() {
  // A native WE source is briefly aligned over the Electron host while the
  // capture stream is prepared. Chromium can keep Page Visibility hidden
  // after that source is parked even though the real Stellaflix window is
  // visible. Desktop sessions therefore trust the main-process window state;
  // browser fallback still resolves to document.hidden.
  if (!wallpaperEngineDesktopHostIsVisible()
    || wallpaperEngineHostBoundsPreparing
    || !wallpaperEngineSelection.active
    || wallpaperEngineSelection.kind !== 'engine'
    || !/^[a-f0-9]{24}$/i.test(String(wallpaperEngineNativeSessionId || ''))
    || !wallpaperEngineCaptureStream) return false;
  var layer = document.getElementById('wallpaper-engine-layer');
  return !!(layer && layer.classList.contains('engine-ready'));
}

function flushWallpaperEnginePointerActivity() {
  wallpaperEnginePointerActivityTimer = 0;
  if (!wallpaperEnginePointerActivityHasPoint || !wallpaperEnginePointerActivityReady()) return;
  var api = wallpaperEngineDesktopApi();
  if (!api || typeof api.reportWallpaperEnginePointerActivity !== 'function') return;
  wallpaperEnginePointerActivityLastSentAt = typeof performance !== 'undefined' && performance.now
    ? performance.now() : Date.now();
  try {
    api.reportWallpaperEnginePointerActivity({
      sessionId: String(wallpaperEngineNativeSessionId || ''),
      xUnit: wallpaperEnginePointerActivityLatestX,
      yUnit: wallpaperEnginePointerActivityLatestY
    });
  } catch (e) { }
}

function rememberWallpaperEnginePointerPosition(event) {
  if (!event || !Number.isFinite(Number(event.clientX)) || !Number.isFinite(Number(event.clientY))) return;
  var width = Math.max(1, Number(document.documentElement && document.documentElement.clientWidth) || Number(window.innerWidth) || 1);
  var height = Math.max(1, Number(document.documentElement && document.documentElement.clientHeight) || Number(window.innerHeight) || 1);
  var xRatio = Math.max(0, Math.min(1, Number(event.clientX) / Math.max(1, width - 1)));
  var yRatio = Math.max(0, Math.min(1, Number(event.clientY) / Math.max(1, height - 1)));
  wallpaperEnginePointerActivityLatestX = Math.round(xRatio * 65535);
  wallpaperEnginePointerActivityLatestY = Math.round(yRatio * 65535);
  wallpaperEnginePointerActivityHasPoint = true;
}

function queueWallpaperEnginePointerActivity(event) {
  rememberWallpaperEnginePointerPosition(event);
  if (!wallpaperEnginePointerActivityHasPoint || !wallpaperEnginePointerActivityReady() || wallpaperEnginePointerActivityTimer) return;
  var now = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  var delay = Math.max(0, WALLPAPER_ENGINE_POINTER_ACTIVITY_INTERVAL_MS - Math.max(0, now - wallpaperEnginePointerActivityLastSentAt));
  wallpaperEnginePointerActivityTimer = setTimeout(flushWallpaperEnginePointerActivity, delay);
}

function cancelWallpaperEngineHostRecovery(resetAttempts) {
  if (wallpaperEngineHostRecoveryRetryTimer) clearTimeout(wallpaperEngineHostRecoveryRetryTimer);
  wallpaperEngineHostRecoveryRetryTimer = 0;
  wallpaperEngineHostRecoveryInFlight = false;
  if (resetAttempts !== false) wallpaperEngineHostRecoveryAttempt = 0;
}

function wallpaperEngineDesktopHostIsVisible() {
  if (!wallpaperEngineUsesDesktopHostLifecycle()) return !document.hidden;
  try {
    if (typeof desktopRuntimeState === 'object' && desktopRuntimeState) {
      return desktopRuntimeState.visible !== false && desktopRuntimeState.minimized !== true;
    }
  } catch (e) { }
  return true;
}

function readWallpaperEngineIdSet(key) {
  try {
    var raw = JSON.parse(localStorage.getItem(key) || '[]');
    return new Set((Array.isArray(raw) ? raw : []).map(String).filter(function (id) { return /^[a-f0-9]{24}$/i.test(id); }));
  } catch (e) {
    return new Set();
  }
}

var hiddenWallpaperEngineIds = readWallpaperEngineIdSet(WALLPAPER_ENGINE_HIDDEN_STORE_KEY);
var favoriteWallpaperEngineIds = readWallpaperEngineIdSet(WALLPAPER_ENGINE_FAVORITE_STORE_KEY);

function saveWallpaperEngineIdSet(key, values) {
  try { localStorage.setItem(key, JSON.stringify(Array.from(values))); } catch (e) { }
}

function normalizeWallpaperEngineSelection(value) {
  value = value && typeof value === 'object' ? value : {};
  var id = String(value.id || '').replace(/[^a-f0-9]/gi, '').slice(0, 24);
  return {
    version: 1,
    active: value.active === true && id.length === 24,
    id: id,
    title: String(value.title || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160),
    kind: value.kind === 'engine' ? 'engine' : (value.kind === 'media' ? 'media' : 'preview'),
    mediaType: value.mediaType === 'video' ? 'video' : 'image',
    mediaAnimated: value.mediaAnimated === true,
    projectType: String(value.projectType || 'unknown').slice(0, 32),
    hasPreview: value.hasPreview === true,
    previewAnimated: value.previewAnimated === true,
    updatedAt: Math.max(0, Number(value.updatedAt) || 0)
  };
}

function readWallpaperEngineSelection() {
  // 2026-08-19: 移植自 Stellaflix 2.1.0 — 恢复 localStorage 自动恢复能力
  try { return normalizeWallpaperEngineSelection(JSON.parse(localStorage.getItem(WALLPAPER_ENGINE_SELECTION_STORE_KEY) || '{}')); }
  catch (e) { return normalizeWallpaperEngineSelection({}); }
}

var wallpaperEngineSelection = readWallpaperEngineSelection();

function saveWallpaperEngineSelection() {
  try { localStorage.setItem(WALLPAPER_ENGINE_SELECTION_STORE_KEY, JSON.stringify(normalizeWallpaperEngineSelection(wallpaperEngineSelection))); }
  catch (e) { }
}

function wallpaperEngineDesktopApi() {
  try {
    if (typeof getDesktopWindowApi === 'function') return getDesktopWindowApi();
    return window.desktopWindow || null;
  } catch (e) {
    return null;
  }
}

function wallpaperEngineUsesDesktopHostLifecycle() {
  var api = wallpaperEngineDesktopApi();
  return !!(api && typeof api.onWallpaperEngineHostBoundsChanged === 'function');
}

function wallpaperEngineNativeHostUnavailable() {
  return wallpaperEngineHostBoundsPreparing
    || (!wallpaperEngineUsesDesktopHostLifecycle() && document.hidden);
}

function normalizeWallpaperEngineProject(item) {
  item = item && typeof item === 'object' ? item : {};
  var id = String(item.id || '').replace(/[^a-f0-9]/gi, '').slice(0, 24);
  if (id.length !== 24) return null;
  var projectType = String(item.projectType || 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'unknown';
  var mediaType = item.mediaType === 'video' ? 'video' : (item.mediaType === 'image' ? 'image' : '');
  return {
    id: id,
    title: String(item.title || 'Wallpaper Engine').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) || 'Wallpaper Engine',
    projectType: projectType,
    mediaType: mediaType,
    mediaAnimated: item.mediaAnimated === true,
    playable: item.playable === true && !!mediaType,
    enginePlayable: item.enginePlayable === true && projectType === 'scene',
    previewOnly: item.previewOnly === true || (item.playable !== true && item.enginePlayable !== true),
    hasPreview: item.hasPreview === true,
    previewAnimated: item.previewAnimated === true,
    source: String(item.source || '').slice(0, 32),
    sourceLabel: String(item.sourceLabel || '本地项目').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 80),
    workshopId: String(item.workshopId || '').replace(/\D/g, '').slice(0, 32),
    propertyCount: Math.max(0, Math.min(256, Number(item.propertyCount) || 0)),
    audioPropertyCount: Math.max(0, Math.min(256, Number(item.audioPropertyCount) || 0)),
    mutedAudioPropertyCount: Math.max(0, Math.min(256, Number(item.mutedAudioPropertyCount) || 0)),
    updatedAt: Math.max(0, Number(item.updatedAt) || 0),
    safetyMode: item.safetyMode === 'native-engine' ? 'native-engine' : (item.safetyMode === 'direct-media' ? 'direct-media' : 'preview-only')
  };
}

function wallpaperEngineProjectById(id) {
  id = String(id || '');
  for (var i = 0; i < wallpaperEngineProjects.length; i++) {
    if (wallpaperEngineProjects[i].id === id) return wallpaperEngineProjects[i];
  }
  return null;
}

function wallpaperEngineMediaUrl(item, kind) {
  item = item || {};
  kind = kind === 'media' ? 'media' : 'preview';
  return 'stellaflix-wallpaper://' + kind + '/' + encodeURIComponent(item.id || '') + '?v=' + encodeURIComponent(String(item.updatedAt || 0)) + '&token=' + encodeURIComponent(wallpaperEngineMediaToken);
}

function wallpaperEngineProjectLabel(item) {
  item = item || {};
  if (item.playable && item.mediaType === 'video') return 'Video · 动态播放';
  if (item.playable && item.mediaType === 'image') return '图片 · 原图显示';
  if (item.projectType === 'scene' && item.enginePlayable) return 'Scene · Wallpaper Engine 原生实时运行';
  if (item.projectType === 'scene') return 'Scene · 预览（未找到有效 PKGV 场景包）';
  if (item.projectType === 'web') return 'Web · 安全预览（未执行 HTML）';
  if (item.projectType === 'application') return 'Application · 安全预览（未运行程序）';
  return '本地项目 · 安全预览';
}

function updateWallpaperEngineEntryUi(message) {
  var value = document.getElementById('wallpaper-engine-value');
  var restore = document.getElementById('wallpaper-engine-restore-btn');
  var active = !!wallpaperEngineSelection.active;
  if (value) {
    if (message) value.textContent = message;
    else if (active && wallpaperEngineRuntimeError) value.textContent = wallpaperEngineRuntimeError + ' · 已显示原背景';
    else if (active && wallpaperEngineSelection.kind === 'engine' && wallpaperEngineDesktopPreviewActive) {
      value.textContent = (wallpaperEngineSelection.title || '已选择')
        + (wallpaperEngineDesktopPreviewUsesAsset ? ' · 桌面被动模式 · 项目预览' : ' · 桌面被动模式 · 原背景');
    }
    else if (active && wallpaperEngineSelection.kind === 'engine') value.textContent = (wallpaperEngineSelection.title || '已选择') + ' · WE 引擎实时运行';
    else if (active) value.textContent = (wallpaperEngineSelection.title || '已选择') + ' · 原背景保留';
    else value.textContent = '未启用 · 原背景保留';
  }
  if (restore) restore.disabled = !active;
}

