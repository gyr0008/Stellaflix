// 封面壁纸（Cover Wallpaper）：封面光晕粒子壁纸，播放器背景板 / 桌面壁纸层两态互斥。
// 画面实现在 js/cover-wallpaper-effect.js（两态共用）；本文件只管挂载、状态推送与释放。
var coverWallpaperBoardEffect = null;
var coverWallpaperRuntimeState = {};
var coverWallpaperPushState = { desktopAt: 0, desktopKey: '', boardAt: 0, boardKey: '' };
var coverWallpaperSyncTimer = 0;
var coverWallpaperRendererOperation = 0;

function normalizeCoverWallpaperSurface(value) {
  return String(value || '') === 'board' ? 'board' : 'desktop';
}
function coverWallpaperEnabled() {
  return !!fx.coverWallpaper && !isDevelopmentLockedFx('coverWallpaper');
}
function coverWallpaperBoardActive() {
  return !!(coverWallpaperBoardEffect && coverWallpaperEnabled()
    && normalizeCoverWallpaperSurface(fx.coverWallpaperSurface) === 'board');
}
function coverWallpaperPayload() {
  var meta = currentDesktopSongMeta();
  return {
    enabled: coverWallpaperEnabled(),
    title: meta.title,
    artist: meta.artist,
    cover: meta.cover,
    playing: !!playing,
    preset: fx.preset,
    opacity: clampRange(fx.coverWallpaperOpacity == null ? 1 : Number(fx.coverWallpaperOpacity), 0.35, 1),
    colors: desktopOverlayColors()
  };
}
// 签名故意不含 colors：调色板单独变化搭下一次标题/播放态变更的车（Mineradio 同口径）。
function coverWallpaperSignature(payload) {
  return payload.enabled + '|' + payload.title + '|' + payload.artist + '|' + payload.cover
    + '|' + payload.playing + '|' + payload.preset + '|' + payload.opacity;
}
function ensureCoverWallpaperBoard() {
  var canvas = document.getElementById('cover-wallpaper-board');
  if (!canvas || typeof window.createCoverWallpaperEffect !== 'function') return false;
  if (!coverWallpaperBoardEffect) coverWallpaperBoardEffect = window.createCoverWallpaperEffect(canvas);
  canvas.classList.add('mounted');
  document.body.classList.add('cover-wallpaper-board-active');
  // 挂载与淡入分两帧，避免第一帧空画布以不透明度 1 闪出。
  requestAnimationFrame(function () {
    if (coverWallpaperBoardActive()) canvas.classList.add('active');
  });
  return true;
}
function releaseCoverWallpaperBoard() {
  if (coverWallpaperBoardEffect) {
    coverWallpaperBoardEffect.applyState({ enabled: false, cover: '', playing: false });
    coverWallpaperBoardEffect.dispose();
    coverWallpaperBoardEffect = null;
  }
  var canvas = document.getElementById('cover-wallpaper-board');
  if (canvas) canvas.classList.remove('mounted', 'active');
  document.body.classList.remove('cover-wallpaper-board-active');
}
function pushCoverWallpaperBoardState(force) {
  if (!coverWallpaperBoardActive()) return;
  var now = performance.now();
  if (!force && now - coverWallpaperPushState.boardAt < 260) return;
  var payload = coverWallpaperPayload();
  var key = coverWallpaperSignature(payload);
  if (!force && key === coverWallpaperPushState.boardKey && now - coverWallpaperPushState.boardAt < 1400) return;
  coverWallpaperPushState.boardAt = now;
  coverWallpaperPushState.boardKey = key;
  coverWallpaperBoardEffect.applyState(payload);
}
function syncCoverWallpaperBoardSurface(active, force) {
  if (!active) {
    if (coverWallpaperBoardEffect) {
      coverWallpaperPushState.boardAt = 0;
      coverWallpaperPushState.boardKey = '';
    }
    releaseCoverWallpaperBoard();
    return;
  }
  if (force) {
    coverWallpaperPushState.boardAt = 0;
    coverWallpaperPushState.boardKey = '';
  }
  ensureCoverWallpaperBoard();
}
function applyCoverWallpaperRuntimeStatus(payload) {
  var status = payload && typeof payload === 'object' ? payload : {};
  coverWallpaperRuntimeState = Object.assign({}, coverWallpaperRuntimeState, status);
  if (normalizeCoverWallpaperSurface(fx.coverWallpaperSurface) !== 'desktop') return coverWallpaperRuntimeState;
  var nextEnabled = status.enabled === true || status.active === true
    ? true
    : (status.attaching === true ? !!fx.coverWallpaper : false);
  if (status.supported === false) nextEnabled = false;
  if (fx.coverWallpaper !== nextEnabled) {
    fx.coverWallpaper = nextEnabled;
    if (typeof updateFxInputs === 'function') updateFxInputs();
  }
  return coverWallpaperRuntimeState;
}
function pushCoverWallpaperDesktopState(force) {
  var api = getDesktopWindowApi();
  if (!api || typeof api.updateCoverWallpaperMode !== 'function') return;
  if (!coverWallpaperEnabled() || normalizeCoverWallpaperSurface(fx.coverWallpaperSurface) === 'board') return;
  var now = performance.now();
  if (!force && now - coverWallpaperPushState.desktopAt < 260) return;
  var payload = coverWallpaperPayload();
  var key = coverWallpaperSignature(payload);
  if (!force && key === coverWallpaperPushState.desktopKey && now - coverWallpaperPushState.desktopAt < 1400) return;
  coverWallpaperPushState.desktopAt = now;
  coverWallpaperPushState.desktopKey = key;
  api.updateCoverWallpaperMode(payload).then(function (result) {
    if (result && result.status) applyCoverWallpaperRuntimeStatus(result.status);
    else if (result && result.ok === false) console.warn('cover wallpaper update failed:', result.error || 'COVER_WALLPAPER_UPDATE_FAILED');
  }).catch(function (e) { console.warn('cover wallpaper update failed:', e); });
}
function coverWallpaperErrorLabel(error) {
  var code = String(error || '');
  if (code.indexOf('COVER_WALLPAPER_DESKTOP_API_UNAVAILABLE') >= 0) return '桌面接口未就绪';
  if (code.indexOf('WALLPAPER_PLATFORM_UNSUPPORTED') >= 0) return '当前系统不支持桌面壁纸层';
  if (code.indexOf('WALLPAPER_WORKERW_NOT_FOUND') >= 0) return '未找到桌面 WorkerW';
  if (code.indexOf('WALLPAPER_PROGMAN_NOT_FOUND') >= 0) return '未找到 Windows 桌面宿主';
  if (code.indexOf('WALLPAPER_NATIVE_ATTACH_ABORTED') >= 0 || code.indexOf('WALLPAPER_START_SUPERSEDED') >= 0) return '启动已取消';
  return code || '未知错误';
}
function applyCoverWallpaperState(force) {
  var api = getDesktopWindowApi();
  var enabled = coverWallpaperEnabled();
  var boardActive = enabled && normalizeCoverWallpaperSurface(fx.coverWallpaperSurface) === 'board';
  var desktopActive = enabled && !boardActive;
  syncCoverWallpaperBoardSurface(boardActive, !!force);
  if (!desktopActive) {
    coverWallpaperPushState.desktopAt = 0;
    coverWallpaperPushState.desktopKey = '';
    if (boardActive) pushCoverWallpaperBoardState(true);
  }
  if (!api || typeof api.setCoverWallpaperMode !== 'function') {
    return Promise.resolve({ ok: false, enabled: false, error: 'COVER_WALLPAPER_DESKTOP_API_UNAVAILABLE' });
  }
  var operation = ++coverWallpaperRendererOperation;
  return Promise.resolve().then(function () {
    return api.setCoverWallpaperMode(desktopActive, desktopActive ? coverWallpaperPayload() : { enabled: false });
  }).then(function (result) {
    result = result && typeof result === 'object' ? result : { ok: false, enabled: false, error: 'COVER_WALLPAPER_RESULT_INVALID' };
    if (operation !== coverWallpaperRendererOperation) return Object.assign({}, result, { rendererStale: true });
    if (result.status) applyCoverWallpaperRuntimeStatus(result.status);
    if (desktopActive && result.ok === true) pushCoverWallpaperDesktopState(true);
    return result;
  }).catch(function (error) {
    if (operation !== coverWallpaperRendererOperation) return { ok: false, enabled: false, rendererStale: true };
    return { ok: false, enabled: false, error: String(error && error.message || error) };
  });
}
function setCoverWallpaperSurface(value) {
  var next = normalizeCoverWallpaperSurface(value);
  var changed = normalizeCoverWallpaperSurface(fx.coverWallpaperSurface) !== next;
  fx.coverWallpaperSurface = next;
  updateCoverWallpaperSurfaceControls();
  if (changed) {
    saveLyricLayout({ user: true, reason: 'coverWallpaperSurface' });
    applyCoverWallpaperState(true);
    showToast(next === 'board' ? '封面壁纸展示位置: 播放器背景板' : '封面壁纸展示位置: 桌面壁纸层');
  }
  return changed;
}
function updateCoverWallpaperSurfaceControls() {
  var active = normalizeCoverWallpaperSurface(fx.coverWallpaperSurface);
  document.querySelectorAll('#cover-wallpaper-surface-seg [data-cover-wallpaper-surface]').forEach(function (btn) {
    btn.classList.toggle('on', btn.getAttribute('data-cover-wallpaper-surface') === active);
  });
}
function syncDesktopCoverWallpaperState() {
  if (!coverWallpaperEnabled()) return;
  if (normalizeCoverWallpaperSurface(fx.coverWallpaperSurface) === 'board') pushCoverWallpaperBoardState(false);
  else pushCoverWallpaperDesktopState(false);
}
function initCoverWallpaper(api) {
  api = api || getDesktopWindowApi();
  if (api && typeof api.onCoverWallpaperModeState === 'function') {
    try { api.onCoverWallpaperModeState(applyCoverWallpaperRuntimeStatus); } catch (_) { }
  }
  if (api && typeof api.getCoverWallpaperModeStatus === 'function') {
    Promise.resolve().then(function () { return api.getCoverWallpaperModeStatus(); })
      .then(applyCoverWallpaperRuntimeStatus).catch(function () { });
  }
  if (!coverWallpaperSyncTimer) coverWallpaperSyncTimer = setInterval(syncDesktopCoverWallpaperState, 260);
  if (fx.coverWallpaper) applyCoverWallpaperState(true);
}
