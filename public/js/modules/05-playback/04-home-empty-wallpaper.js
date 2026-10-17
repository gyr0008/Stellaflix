var emptyHomeStartEl = document.getElementById('empty-home');
if (emptyHomeStartEl) {
  emptyHomeStartEl.addEventListener('click', function (e) {
    var start = e.target && e.target.closest ? e.target.closest('[data-home-radio-start]') : null;
    if (!start || !emptyHomeStartEl.contains(start)) return;
    e.preventDefault();
    e.stopPropagation();
    if (typeof openHomeDashboardRadio === 'function') openHomeDashboardRadio();
  }, true);
}
function shouldShowEmptyHomeCore(ignoreSplash) {
  if (!ignoreSplash && document.body.classList.contains('splash-active')) return false;
  if (immersiveMode) return false;
  if (homeForcedOpen) return true;
  if (homeSuppressed) return false;
  if (shelfPinnedOpen) return false;
  if (shelfManager && shelfManager.hasOpenContent && shelfManager.hasOpenContent()) return false;
  if (shouldShowHomeForPausedStartupRestore()) return true;
  if (hasRestoredPlaybackCandidate()) return false;
  if (playQueue && playQueue.length) return false;
  if (currentIdx >= 0 && playQueue[currentIdx]) return false;
  if (playing) return false;
  return true;
}
function shouldShowEmptyHome() {
  return shouldShowEmptyHomeCore(false);
}
function shouldShowEmptyHomeAfterSplash() {
  return shouldShowEmptyHomeCore(true);
}
function shouldForceEmptyHomeAfterSplash() {
  if (immersiveMode) return false;
  if (shelfPinnedOpen) return false;
  if (shelfManager && shelfManager.hasOpenContent && shelfManager.hasOpenContent()) return false;
  if (shouldShowHomeForPausedStartupRestore()) return true;
  if (hasRestoredPlaybackCandidate()) return false;
  if (playQueue && playQueue.length) return false;
  if (currentIdx >= 0 && playQueue[currentIdx]) return false;
  if (playing) return false;
  return true;
}
function shouldUseIdleWallpaperPreview(ignoreSplash) {
  if (!ignoreSplash && document.body.classList.contains('splash-active')) return false;
  if (immersiveMode || playing || (audio && !audio.paused)) return false;
  if (hasRestoredPlaybackCandidate() && !shouldShowHomeForPausedStartupRestore()) return false;
  if (shelfPinnedOpen) return false;
  if (shelfManager && shelfManager.hasOpenContent && shelfManager.hasOpenContent()) return false;
  return true;
}
function setHomeControlsLocked(locked) {
  document.body.classList.toggle('home-controls-locked', !!locked);
  var bottom = document.getElementById('bottom-bar');
  if (bottom && locked && !hasActivePlaybackControls()) bottom.classList.add('soft-hidden');
  if (bottom && !locked) bottom.classList.remove('soft-hidden');
  if (locked) closeMiniQueue();
}
function openHomePlayerConsole() {
  setHomeControlsLocked(false);
  var bar = document.getElementById('bottom-bar');
  if (bar) {
    bar.classList.add('visible');
    bar.classList.remove('soft-hidden');
    bar.style.pointerEvents = '';
  }
  wakeBottomHandle(2800);
  setControlsHidden(false);
  forcePlaybackControlsInteractive();
  updateControlsChromeState();
  if (controlsAutoHide) scheduleControlsHide(1800);
  showToast('播放器控制台已展开');
}
function ensureHomeWallpaperParticles(opts) {
  opts = opts || {};
  if (uniforms && uniforms.uAlpha && opts.instant) {
    uniforms.uAlpha.value = 0.96;
  } else if (uniforms && uniforms.uAlpha && uniforms.uAlpha.value < 0.88) {
    tweenParticleAlpha(uniforms.uAlpha.value || 0, 0.96, 920);
  }
  if (uniforms && uniforms.uFloatAlpha) uniforms.uFloatAlpha.value = 0;
  if (floatGroup) destroyFloatLayer();
}
function activateHomeWallpaperPreview(opts) {
  opts = opts || {};
  document.body.classList.add('home-wallpaper-preview');
  ensureHomeWallpaperParticles(opts);
}
var homeWallpaperPrewarmStarted = false;
function prewarmHomeWallpaperPreview() {
  if (homeWallpaperPrewarmStarted) return;
  homeWallpaperPrewarmStarted = true;
  if (!shouldUseIdleWallpaperPreview(true)) return;
  scheduleVisualApply(function () {
    if (!shouldUseIdleWallpaperPreview(true)) return;
    activateHomeWallpaperPreview({ skipTransition: true, instant: true });
  }, 900, 2600);
}
function deactivateHomeWallpaperPreview(playback) {
  document.body.classList.remove('home-wallpaper-preview');
  if (!homeVisualPresetActive) return;
  homeVisualPresetActive = false;
  var nextPreset = typeof homeVisualPrevPreset === 'number' ? homeVisualPrevPreset : (fx && typeof fx.preset === 'number' ? fx.preset : 0);
  if (typeof setPreset === 'function' && fx.preset !== nextPreset) {
    setPreset(nextPreset, { silent: true, preserveCamera: false, skipTransition: false, noSave: true });
  }
}
function switchPlaybackVisualToEmily() {
  if (homeVisualPresetActive) {
    deactivateHomeWallpaperPreview(true);
  }
  document.body.classList.remove('home-wallpaper-preview');
  var targetPreset = typeof playbackVisualPreset === 'number' ? playbackVisualPreset : fxDefaults.preset;
  startupVisualPreviewActive = false;
  if (typeof setPreset === 'function' && fx.preset !== targetPreset) {
    setPreset(targetPreset, { silent: true, preserveCamera: false, noSave: true });
  } else if (typeof syncFxUniforms === 'function') {
    syncFxUniforms();
  }
  if (typeof updateRenderPowerClasses === 'function') updateRenderPowerClasses();
  if (typeof recoverVisualsAfterBackground === 'function' && !isDeepBackgroundMode()) recoverVisualsAfterBackground('playback-visual');
}
function applyStartupStarfieldPreset() {
  if (playing || currentIdx >= 0 || hasRestoredPlaybackCandidate()) return;
  startupVisualPreviewActive = true;
  if (typeof setPreset === 'function' && fx.preset !== 5) {
    setPreset(5, { silent: true, preserveCamera: false, skipTransition: true, noSave: true });
  } else if (typeof syncFxUniforms === 'function') {
    syncFxUniforms();
  }
}
function updateEmptyHomeVisibility(opts) {
  opts = opts || {};
  var show = shouldShowEmptyHome();
  emptyHomeActive = show;
  document.body.classList.toggle('empty-home-active', show);
  if (!show) setHomeControlsLocked(false);
  if (show) activateHomeWallpaperPreview();
  else deactivateHomeWallpaperPreview(false);
  if (show) {
    setPeek(document.getElementById('search-area'), true, 'search');
    renderHomeDiscover();
    if (!hasAnyPlatformLogin()) {
      homeDiscoverState.loading = false;
      homeDiscoverState.loaded = true;
      homeDiscoverState.loggedIn = false;
      homeDiscoverState.mode = 'starter';
      homeDiscoverState.songs = [];
      homeDiscoverState.playlists = [];
      homeDiscoverState.podcasts = [];
      renderHomeDiscover();
    } else {
      renderHomeDiscover();
      scheduleVisualApply(function () { loadHomeDiscover(!!opts.forceLoad); }, 220, 1200);
    }
  }
  return show;
}
function runHomeSearch(query, mode) {
  homeForcedOpen = false;
  homeSuppressed = false;
  setHomeControlsLocked(false);
  updateEmptyHomeVisibility();
  if (mode) setSearchMode(mode);
  else if (searchMode === 'podcast') setSearchMode('song');
  var q = String(query || '').trim();
  var area = document.getElementById('search-area');
  if (area) setPeek(area, true, 'search');
  if ($input) {
    $input.value = q;
    $input.focus();
  }
  if (q) doSearch(q);
  else if (searchMode === 'podcast') loadPodcastHot();
  else renderSearchHistory();
}
function skipLoginAndFocusSearch() {
  closeLoginModal();
  setTimeout(function () { runHomeSearch(''); }, 180);
}
function openHomeLocalImport() {
  homeForcedOpen = false;
  homeSuppressed = false;
  setHomeControlsLocked(false);
  updateEmptyHomeVisibility();
  // 始终打开导入面板：有曲库时面板内提供「播放本地曲库」，避免吞掉二次导入入口
  openUploadPanel();
}
async function waitForHomeDiscoverIdle(timeout) {
  var started = Date.now();
  while (homeDiscoverState.loading && Date.now() - started < (timeout || 2200)) {
    await new Promise(function (resolve) { setTimeout(resolve, 80); });
  }
}
async function playHomeDaily() {
  homeForcedOpen = false;
  homeSuppressed = false;
  setHomeControlsLocked(false);
  if (!hasAnyPlatformLogin() && !homeDiscoverState.loggedIn) {
    showLoginModal({ source: 'home-daily' });
    return;
  }
  await waitForHomeDiscoverIdle();
  if (!homeDiscoverState.loaded || (!homeDiscoverState.songs.length && !homeDiscoverState.loading)) {
    await loadHomeDiscover(true);
  }
  if (!homeDiscoverState.songs.length) {
    runHomeSearch('每日推荐');
    return;
  }
  playQueue = homeDiscoverState.songs.map(cloneSong);
  currentIdx = 0;
  safeRenderQueuePanel('home-daily');
  safeShelfRebuild('home-daily', true);
  forcePlaybackControlsInteractive();
  playQueueAt(0).catch(function (e) { console.warn('[HomeDailyPlay]', e); });
}
async function playHomePrivateRadio() {
  homeForcedOpen = false;
  homeSuppressed = false;
  setHomeControlsLocked(false);
  if (!hasAnyPlatformLogin() && !homeDiscoverState.loggedIn) {
    showLoginModal({ source: 'home-private' });
    return;
  }
  await waitForHomeDiscoverIdle();
  if (!homeDiscoverState.loaded || ((!homeDiscoverState.playlists.length && !homeDiscoverState.songs.length) && !homeDiscoverState.loading)) {
    await loadHomeDiscover(true);
  }
  if (homeDiscoverState.songs.length) {
    playQueue = homeDiscoverState.songs.map(cloneSong);
    currentIdx = 0;
    safeRenderQueuePanel('home-private-radio');
    safeShelfRebuild('home-private-radio', true);
    forcePlaybackControlsInteractive();
    playQueueAt(0).catch(function (e) { console.warn('[HomePrivatePlay]', e); });
    return;
  }
  var item = homeDiscoverState.playlists[0];
  if (item && item.id) {
    await loadPlaylistIntoQueueById(item.id, true, item.name || '私人雷达');
    return;
  }
  openHomeLibrary();
}
function playHomeSong(index) {
  homeForcedOpen = false;
  homeSuppressed = false;
  setHomeControlsLocked(false);
  var song = homeDiscoverState.songs[index];
  if (!song) {
    if (index > 0) playHomePrivateRadio();
    else playHomeDaily();
    return;
  }
  playQueue = homeDiscoverState.songs.map(cloneSong);
  currentIdx = Math.max(0, Math.min(playQueue.length - 1, index));
  safeRenderQueuePanel('home-song-card');
  safeShelfRebuild('home-song-card', true);
  forcePlaybackControlsInteractive();
  playQueueAt(currentIdx).catch(function (e) { console.warn('[HomeSongPlay]', e); });
}
function openHomePlaylist(index) {
  homeForcedOpen = false;
  homeSuppressed = false;
  setHomeControlsLocked(false);
  if (!hasAnyPlatformLogin() && !homeDiscoverState.loggedIn) {
    runHomeSearch('');
    return;
  }
  openPlaylistPanelTab('playlists', true);
  var item = homeDiscoverState.playlists[index];
  if (!item || !item.id) {
    openHomeLibrary();
    return;
  }
  loadPlaylistIntoQueueById(item.id, true, item.name || '');
}
function openHomePodcast(index) {
  homeForcedOpen = false;
  homeSuppressed = false;
  setHomeControlsLocked(false);
  openPlaylistPanelTab('podcasts', true);
  var item = homeDiscoverState.podcasts[index];
  if (!item || !item.id) {
    setSearchMode('podcast');
    loadPodcastHot();
    return;
  }
  loadPodcastRadioIntoQueue(item.id, true, item.name || '');
}
function openHomeThirdCard() {
  if (!hasAnyPlatformLogin() && !homeDiscoverState.loggedIn) {
    openHomeLocalImport();
    return;
  }
  openHomePodcast(0);
}
function openHomeLibrary() {
  if (!hasAnyPlatformLogin() && !homeDiscoverState.loggedIn) {
    showLoginModal({ source: 'home-library' });
    return;
  }
  homeSuppressed = false;
  setHomeControlsLocked(false);
  openPlaylistPanelTab('playlists', true);
  refreshUserPlaylists(true);
}
// ---------------------------------------------------------------- 影视态判定（2026-10-02 契约级根治）
// 影视态标识：00-core-stores.js L16-17 同时写在 documentElement 与 body 上，
// preload-mode.js L10 也会加在 documentElement 上，故两处都判，任一命中即为影视态。
function isVideoSpaceActive() {
  try {
    if (document.documentElement && document.documentElement.classList
      && document.documentElement.classList.contains('video-space-active')) return true;
    if (document.body && document.body.classList
      && document.body.classList.contains('video-space-active')) return true;
  } catch (e) { /* DOM 异常按非影视态处理，退回既有逻辑 */ }
  return false;
}

// 契约（2026-10-02）：「Home 开关」是音乐态专属交互。
//   - 音乐态：#empty-home 是「空壳首页 + 壁纸预览」，点空白/再点 Home 键收起 UI 露出壁纸，是设计本意。
//   - 影视态：#empty-home 就是影视首页本体（video/home.js 的 render() 填充海报/精选片单/继续观看
//     等真实内容），关掉它不会露出任何东西，只会把用户丢进无 UI 的 3D 粒子场景。
// 因此影视态一律不走音乐态这套开关逻辑。这不是给某个浮层加豁免（打地鼠），而是从「当前是哪个态」
// 这一个事实层面切断整条泄漏链，一次性覆盖当前与未来所有影视态全屏层：
// 播放器 #sfv-overlay / 搜索页 #sfv-search-page / 浏览厅 .sfv-hall / 片库 / 历史 / 追番 /
// 精选片单二级页 / 背景 DIY 遮罩 / 片源仓库面板 / TMDB 设置 overlay …
function goHome() {
  // 影视态：委托影视态自己的回首页实现（online-nav.js goHome：关浏览层 + 重渲染影视首页）。
  // 绝不能落进下面的音乐态分支——else 分支会 updateEmptyHomeVisibility() → renderHomeDiscover()
  // 往影视态首页塞音乐内容；if 分支会 dismissHomePage() → homeSuppressed=true（粘性）→
  // 影视态无任何路径复位 → 首页永久透明只剩粒子星空。
  if (isVideoSpaceActive()) {
    var _SFV = (typeof window !== 'undefined') ? window.StellaflixVideo : null;
    if (_SFV && _SFV.online && typeof _SFV.online.goHome === 'function') {
      try { _SFV.online.goHome(); } catch (e) { /* 委托失败不回落音乐态逻辑 */ }
    }
    return;
  }
  if (homeForcedOpen || emptyHomeActive) {
    dismissHomePage({ toast: true });
    showToast('已关闭 Home');
    return;
  }
  homeSuppressed = false;
  homeForcedOpen = true;
  setHomeControlsLocked(true);
  if (shelfManager && shelfManager.hasOpenContent && shelfManager.hasOpenContent()) safeShelfCloseContent('open-empty-home');
  if (typeof setShelfPinnedOpen === 'function') setShelfPinnedOpen(false, true);
  togglePlaylistPanel(false);
  setPeek(document.getElementById('playlist-panel'), false, 'pl');
  setPeek(document.getElementById('fx-panel'), false, 'fx');
  setPeek(document.getElementById('search-area'), true, 'search');
  if (typeof setFocusZone === 'function') setFocusZone(null, true);
  if (orbit && orbit.focus) orbit.focus.active = false;
  updateEmptyHomeVisibility({ forceLoad: true });
  showToast('已回到 Home');
}
function dismissHomePage(opts) {
  opts = opts || {};
  // 影视态不接受「关 Home」（契约见 isVideoSpaceActive 上方注释）。
  // 挡住直接调用路径（goHome() 的 toggle 分支、任何跨模块直调），
  // 否则 homeSuppressed 仍会被写成 true（粘性标志，影视态无复位路径）→ 首页永久透明。
  if (isVideoSpaceActive()) return;
  homeForcedOpen = false;
  homeSuppressed = true;
  setHomeControlsLocked(false);
  updateEmptyHomeVisibility({ forceLoad: false });
  setPeek(document.getElementById('search-area'), false, 'search');
  if (typeof setFocusZone === 'function') setFocusZone(null, true);
}
function isPointInsideRectWithPad(x, y, rect, pad) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  pad = Number(pad) || 0;
  return x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad;
}
function isPointNearHomeContent(x, y) {
  var selectors = [
    '.home-card',
    '.home-tile',
    '.home-chip'
  ];
  for (var i = 0; i < selectors.length; i++) {
    var nodes = document.querySelectorAll(selectors[i]);
    for (var j = 0; j < nodes.length; j++) {
      if (isPointInsideRectWithPad(x, y, nodes[j].getBoundingClientRect(), 12)) return true;
    }
  }
  return false;
}
function isHomeBlankDismissClick(e) {
  if (!emptyHomeActive || !e || e.defaultPrevented) return false;
  // 影视态一律不判定为「Home 空白点击」（契约见 isVideoSpaceActive 上方注释）。
  // 这是从源头切断：影视态任何页面内的点击都不再具备「关掉影视首页」的能力，
  // 因此不可能泄漏到上一页影响上一页显示。下方逐层的 class 豁免清单退化为兜底，
  // 不再是唯一的防线。
  if (isVideoSpaceActive()) return false;
  if (e.button != null && e.button !== 0) return false;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
  // 任一「点外即关」面板打开时，空白点击一律不关 Home（API 守卫，比 class 选择器更稳）
  try {
    // 影视浏览层（#sfv-browse）打开时一律不关 Home：该层透明铺满视口叠在 Home 上，
    // 片库/历史页内的点/拖坐标必然落在 #empty-home 矩形内，若放行会摘掉
    // empty-home-active → 返回后首页透明只剩粒子星空（2026-09-25 片库返回 bug）
    var browseEl = document.getElementById('sfv-browse');
    if (browseEl && browseEl.classList.contains('sfv-show')) return false;
    // 影视播放器（#sfv-overlay）打开时一律不关 Home：播放器是 body 直接子元素、铺满视口
    // 叠在 Home 之上，点画面/拖进度条（.sfv-progress 非 button）的坐标必然落在
    // #empty-home 矩形内，若放行会摘掉 empty-home-active → 退出播放器后首页透明
    // 只剩粒子星空（2026-10-01 复现；与 2026-09-25 片库页同源，同款守卫）。
    var overlayEl = document.getElementById('sfv-overlay');
    if (overlayEl && overlayEl.classList.contains('sfv-show')) return false;
    var SFV = window.StellaflixVideo;
    if (SFV) {
      if (SFV.player && typeof SFV.player.isOpen === 'function' && SFV.player.isOpen()) return false;
      if (SFV.sourcePicker && SFV.sourcePicker.isOpen && SFV.sourcePicker.isOpen()) return false;
      if (SFV.SearchFilter && SFV.SearchFilter.isOpen && SFV.SearchFilter.isOpen()) return false;
    }
    var csOverlay = document.getElementById('custom-source-modal-overlay');
    if (csOverlay && csOverlay.getAttribute('data-open') === '1') return false;
    if (document.querySelector('.sfv-bgm-modal-overlay')) return false;
  } catch (err) { /* 守卫失败不阻断空白关闭 */ }
  var target = e.target;
  if (!target || !target.closest) return false;
  var blockedSelector = [
    'button',
    'a',
    'input',
    'textarea',
    'select',
    '[contenteditable="true"]',
    '#desktop-titlebar',
    '#search-area',
    '#top-right',
    '#bottom-bar',
    '#bottom-handle',
    '#fx-fab',
    '#fx-fab-hide-btn',
    '#fx-panel',
    '#playlist-panel',
    '#mini-queue-popover',
    '#upload-tip',
    '#toast',
    '#trial-banner',
    '#source-fallback-notice',
    '.modal-mask',
    '.modal',
    // 导入歌单弹窗（#sf-ppi-mask）：Home 空白关闭跑在捕获阶段，弹窗自身的冒泡拦截
    // 拦不住它，必须在这里豁免——点暗区只关弹窗，不连带关 Home
    '#sf-ppi-mask',
    '.track-detail-modal',
    '.cover-color-pop',
    '.color-lab-pop',
    // 视影视态弹层与登录 modal 同级保护：点遮罩关面板时不得连带关 Home
    // （home 空白关闭跑在 document 捕获阶段，若不拦截，点四面板遮罩会先 dismissHome）
    '.sfv-bgm-modal-overlay',
    '.sfv-bgm-modal',
    '.sfv-bgm-tl-sheet',
    '.sfv-picker-backdrop',
    '.sfv-picker',
    '.sfv-picker-modal-backdrop',
    '.sfv-picker-captcha-backdrop',
    '.custom-source-modal-overlay',
    '.custom-source-modal',
    '.sf-filter-layer',
    '.sf-filter-scrim',
    '.sf-filter-sheet'
  ].join(',');
  if (target.closest(blockedSelector)) return false;
  var x = e.clientX;
  var y = e.clientY;
  var home = document.getElementById('empty-home');
  if (!home) return false;
  // 归属判定（2026-10-02）：只有真正点在 #empty-home 自己的空白上，才算「Home 空白点击」。
  // 任何盖在 Home 之上的全屏层（搜索页 #sfv-search-page、浏览厅 .sfv-hall、播放器 #sfv-overlay、
  // 背景 DIY 遮罩 .sfv-bg-diy-mask、片源仓库面板、TMDB 设置 overlay…）里的点击，事件 target 都
  // 不属于 Home 子树，一律不关 Home。
  // 这是「一次性覆盖」的根治：逐个 class 加豁免是打地鼠（2026-09-25 片库页、2026-10-01 播放器
  // 各踩一次，搜索页/浏览厅仍漏网），而归属判定不依赖任何具体 class 清单。
  // 防御式调用：测试假 DOM（fakeEl）没有 contains → 跳过该判定，由其余守卫兜底。
  if (typeof home.contains === 'function' && !home.contains(target)) return false;
  var homeRect = home.getBoundingClientRect();
  if (!isPointInsideRectWithPad(x, y, homeRect, 0)) return false;
  if (isPointNearHomeContent(x, y)) return false;
  return true;
}
document.addEventListener('click', function (e) {
  if (!isHomeBlankDismissClick(e)) return;
  e.preventDefault();
  e.stopPropagation();
  dismissHomePage({ reason: 'blank-click' });
}, true);

// 兜底：index-loader 把全部模块源码拼接进一个 try 块执行；
// 按 ES2017 块级作用域，try 块内的 async function 声明不会泄漏到全局
// （普通 function 因 Annex B 3.3 宽松提升仍会泄漏，故无需处理）。
// 显式挂到 window，供首页卡片 onclick / 其他模块跨文件调用。
window.waitForHomeDiscoverIdle = waitForHomeDiscoverIdle;
window.playHomeDaily = playHomeDaily;
window.playHomePrivateRadio = playHomePrivateRadio;
