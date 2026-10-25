// 壁纸模式（Cover Wallpaper）：封面光晕粒子壁纸，播放器背景板 / 桌面壁纸层两态互斥。
// 画面实现在 js/cover-wallpaper-effect.js（两态共用）；本文件只管挂载、状态推送与释放。
var coverWallpaperBoardEffect = null;
var coverWallpaperRuntimeState = {};
var coverWallpaperPushState = { desktopAt: 0, desktopKey: '', boardAt: 0, boardKey: '' };
var coverWallpaperSyncTimer = 0;
var coverWallpaperRendererOperation = 0;

function normalizeCoverWallpaperSurface(value) {
  return String(value || '') === 'board' ? 'board' : 'desktop';
}
// 桌面壁纸层在当前 Windows 版本上挂不上时的**会话内降级**。
//
// 旧实现在降级分支里直接 setCoverWallpaperSurface('board')，而那函数内部是
// saveLyricLayout({ user: true, ... }) —— 一次「运行时判定不可见」被写成了
// 用户本人的选择，下次启动也不再试桌面层。用户可见面就是：壁纸模式永远只剩
// 窗口内一块背景板，屏幕上没有「铺满屏幕的那层壁纸」，怎么点都回不来。
//
// 契约：
//   ① 运行时降级只活在本次会话，绝不写盘、绝不改 fx.coverWallpaperSurface；
//   ② 用户重新点分段按钮（setCoverWallpaperSurface）= 重新尝试，降级立即作废；
//   ③ 判定是否走桌面层一律用 effectiveCoverWallpaperSurface()，
//      分段控件的选中态仍读用户选择，两者不得互相污染。
var coverWallpaperRuntimeSurfaceFallback = '';
function effectiveCoverWallpaperSurface() {
  var chosen = normalizeCoverWallpaperSurface(fx.coverWallpaperSurface);
  return chosen === 'desktop' && coverWallpaperRuntimeSurfaceFallback === 'board' ? 'board' : chosen;
}
function coverWallpaperEnabled() {
  return !!fx.coverWallpaper && !isDevelopmentLockedFx('coverWallpaper');
}
function coverWallpaperBoardActive() {
  return !!(coverWallpaperBoardEffect && coverWallpaperEnabled()
    && effectiveCoverWallpaperSurface() === 'board');
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
// 运行时回执只做「诊断读数」，不得反写用户开关。
//
// 参照库对壁纸层是**纯单向下发**：desktop/preload.js:169-170 只暴露
// setWallpaperMode / updateWallpaperMode，public/ 全目录搜不到任何回执订阅
// （onWallpaperModeState / getWallpaperModeStatus / WallpaperModeStatus 零命中），
// app.js:45467-45468 只 `.catch(console.warn)`，从不读结果、不改 fx.wallpaperMode。
//
// 本项目额外加了回执通道（desktop/preload.js:165-170），旧实现在这里做了
// 「缺 enabled:true 即置否」的兜底，形成一条**只能减、不能加**的单向棘轮：
//   ① 冷启动毒丸：DEFAULT_WALLPAPER_STATE.enabled=false，未建窗时 getStatus() 回
//      {supported:true, enabled:false, active:false, attaching:false, windowId:null}
//      （wallpaper-mode-runtime.js:4 / 376-390）——这句「运行时还没启动」的空回执
//      会被当成「用户不要壁纸」。
//   ② 运行期毒丸：runStop()（708-716）无条件把 state.enabled 置 false 并 emitStatus(730)，
//      reconcileDisplay 失败路径（696）直接走 stop —— 显示器热插拔 / explorer 重启 /
//      远程桌面都会把用户开的壁纸模式永久关掉。
//   ③ 关掉后的连锁：pushCoverWallpaperDesktopState 首行 `if (!coverWallpaperEnabled()) return;`
//      让 260ms 节拍从此不推任何状态，壁纸停在旧帧或整窗空白 ——
//      用户可见面就是「有时候开壁纸模式不出壁纸 / 切歌后壁纸不更新」。
//
// 因此这里只在「平台确实不支持」时置否，其余一切回执都不动 fx.coverWallpaper。
// 守卫见 tests/cover-wallpaper-status-no-silent-disable.test.js。
function applyCoverWallpaperRuntimeStatus(payload) {
  var status = payload && typeof payload === 'object' ? payload : {};
  coverWallpaperRuntimeState = Object.assign({}, coverWallpaperRuntimeState, status);
  if (effectiveCoverWallpaperSurface() !== 'desktop') return coverWallpaperRuntimeState;
  if (status.supported === false && fx.coverWallpaper === true) {
    fx.coverWallpaper = false;
    if (typeof updateFxInputs === 'function') updateFxInputs();
  }
  return coverWallpaperRuntimeState;
}
function pushCoverWallpaperDesktopState(force) {
  var api = getDesktopWindowApi();
  if (!api || typeof api.updateCoverWallpaperMode !== 'function') return;
  if (!coverWallpaperEnabled() || effectiveCoverWallpaperSurface() === 'board') return;
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
// 桌面层是否视觉无效：只有宿主解析一路退到最后兜底（'progman' 本体）时才判无效。
// 旧口径是「parentClassName === 'Progman' 即无效」，依据是 Win10 / 早期 Win11 上 Progman 不再转发
// 0x052C、覆盖窗永远落在系统壁纸之下。但 Windows 11 26xxx（实测 NT 10.0.26300，2026-10-25）上
// DefView 的宿主本来就是 Progman，且有 progman-child-workerw、shelldll-defview 两个可用宿主，
// 一律判死会把这些本来能用的路径无差别降级到背景板 —— 这正是「壁纸只进窗口」的根因之一。
function coverWallpaperDesktopLayerHidden(status) {
  // 回执还没到（首次开启 / 运行时未上报）时不做判定，避免把还没结果的一次尝试判死。
  if (!status) return false;
  var strategy = String(status.hostStrategy || '');
  if (!strategy) return String(status.parentClassName || '') === 'Progman';
  return strategy === 'progman';
}
function applyCoverWallpaperState(force) {
  var api = getDesktopWindowApi();
  var enabled = coverWallpaperEnabled();
  var boardActive = enabled && effectiveCoverWallpaperSurface() === 'board';
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
    if (operation !== coverWallpaperRendererOperation) return Object.assign({}, result, { rendererStale: true });
    if (desktopActive && result.ok === true && coverWallpaperDesktopLayerHidden(result.status)) {
      // 只在本次会话降级：不写盘、不改用户选择，并用降级后的位置重入一次。
      // 不能调 setCoverWallpaperSurface —— 它会 saveLyricLayout({ user: true })，
      // 把运行时判定永久写成用户偏好（回归守卫见
      // tests/cover-wallpaper-surface-fallback-not-persisted.test.js）。
      if (coverWallpaperRuntimeSurfaceFallback !== 'board') {
        coverWallpaperRuntimeSurfaceFallback = 'board';
        showToast('当前 Windows 版本下桌面壁纸层不可见，壁纸模式本次改用播放器背景板');
      }
      return applyCoverWallpaperState(force);
    }
    if (desktopActive && result.ok === true) pushCoverWallpaperDesktopState(true);
    // 壁纸模式全程不碰主窗几何（对齐 Mineradio 2.5.1 public/app.js:45451-45477）：
    // 「居中圆角窗浮在壁纸上」是主窗的常态窗口化几何，不是壁纸模式变出来的。
    return result;
  }).catch(function (error) {
    if (operation !== coverWallpaperRendererOperation) return { ok: false, enabled: false, rendererStale: true };
    return { ok: false, enabled: false, error: String(error && error.message || error) };
  });
}
function setCoverWallpaperSurface(value) {
  var next = normalizeCoverWallpaperSurface(value);
  var changed = normalizeCoverWallpaperSurface(fx.coverWallpaperSurface) !== next;
  // 手动换位置（或原地重选）＝ 重新尝试桌面层，会话内降级立即作废。
  var fallbackCleared = coverWallpaperRuntimeSurfaceFallback !== '';
  coverWallpaperRuntimeSurfaceFallback = '';
  fx.coverWallpaperSurface = next;
  updateCoverWallpaperSurfaceControls();
  if (changed || fallbackCleared) {
    if (changed) saveLyricLayout({ user: true, reason: 'coverWallpaperSurface' });
    applyCoverWallpaperState(true);
    if (changed) showToast(next === 'board' ? '壁纸模式展示位置: 播放器背景板' : '壁纸模式展示位置: 桌面壁纸层');
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
  if (effectiveCoverWallpaperSurface() === 'board') pushCoverWallpaperBoardState(false);
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
  if (!coverWallpaperSyncTimer) coverWallpaperSyncTimer = setInterval(function () {
    syncDesktopCoverWallpaperState();
    // 迷你播放器沿用同一 260ms 播放态同步节拍：playbackOnly 推送只比对标题/歌手/封面/播放态。
    if (typeof pushMiniPlayerState === 'function') pushMiniPlayerState(false, true);
  }, 260);
  if (fx.coverWallpaper) applyCoverWallpaperState(true);
}
