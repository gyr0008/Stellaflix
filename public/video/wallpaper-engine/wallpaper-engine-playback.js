function requestWallpaperEngineVideoPlayback(video, item, kind, token, revealLayer, attempt) {
  cancelWallpaperEngineVideoRetry();
  if (!video || token !== wallpaperEngineLayerToken || !wallpaperEngineSelection.active) return;
  var hostUnavailable = kind === 'engine' ? wallpaperEngineNativeHostUnavailable() : document.hidden;
  if (hostUnavailable) {
    try { video.pause(); } catch (e) { }
    if (revealLayer) wallpaperEngineLayerReady('video', token);
    return;
  }
  var promise;
  try {
    promise = video.play();
  } catch (error) {
    handleWallpaperEngineVideoPlayFailure(error, video, item, kind, token, revealLayer, attempt);
    return;
  }
  if (!promise || !promise.then) {
    if (revealLayer) wallpaperEngineLayerReady('video', token);
    return;
  }
  promise.then(function () {
    if (token !== wallpaperEngineLayerToken || !wallpaperEngineSelection.active) return;
    if (revealLayer) wallpaperEngineLayerReady('video', token);
  }).catch(function (error) {
    handleWallpaperEngineVideoPlayFailure(error, video, item, kind, token, revealLayer, attempt);
  });
}

function handleWallpaperEngineVideoPlayFailure(error, video, item, kind, token, revealLayer, attempt) {
  if (token !== wallpaperEngineLayerToken || !wallpaperEngineSelection.active) return;
  var hostUnavailable = kind === 'engine' ? wallpaperEngineNativeHostUnavailable() : document.hidden;
  var interrupted = hostUnavailable || wallpaperEnginePlayWasInterrupted(error);
  if (!interrupted) {
    wallpaperEngineLayerFailed(item, kind, token);
    return;
  }
  if (revealLayer) wallpaperEngineLayerReady('video', token);
  if (hostUnavailable || Number(attempt) >= 2) return;
  wallpaperEngineVideoRetryTimer = setTimeout(function () {
    wallpaperEngineVideoRetryTimer = 0;
    requestWallpaperEngineVideoPlayback(video, item, kind, token, false, Number(attempt) + 1);
  }, 160);
}

function clearWallpaperEngineLayerMedia(delay) {
  cancelWallpaperEngineVideoRetry();
  cancelWallpaperEngineFirstFrameWait();
  var token = wallpaperEngineLayerToken;
  var layer = document.getElementById('wallpaper-engine-layer');
  var image = document.getElementById('wallpaper-engine-image');
  var video = document.getElementById('wallpaper-engine-video');
  function release() {
    if (token !== wallpaperEngineLayerToken) return;
    if (layer) layer.classList.remove('ready', 'image-ready', 'video-ready', 'engine-ready', 'freeze-ready');
    clearWallpaperEngineFreezeFrame(true);
    if (image) {
      image.onload = null;
      image.onerror = null;
      image.removeAttribute('src');
    }
    if (video) {
      video.onloadeddata = null;
      video.onerror = null;
      try { video.pause(); } catch (e) { }
      if (video.srcObject) {
        try { video.srcObject = null; } catch (e2) { }
      }
      video.removeAttribute('poster');
      video.removeAttribute('src');
      try { video.load(); } catch (e3) { }
    }
    stopWallpaperEngineCaptureStream();
  }
  if (delay) setTimeout(release, delay);
  else release();
}

function restoreOriginalBackgroundAfterWallpaperEngine() {
  document.body.classList.remove('wallpaper-engine-active', 'wallpaper-engine-dwm-active');
  stopWallpaperEngineGlassCaptureStream(false);
  if (typeof syncWallpaperEngineControlGlassSurface === 'function') {
    syncWallpaperEngineControlGlassSurface(true);
  }
  try {
    if (typeof applyCustomBackground === 'function') applyCustomBackground();
  } catch (e) { }
}

function suspendOriginalBackgroundForWallpaperEngine() {
  var video = document.getElementById('custom-bg-video');
  if (video) {
    try { video.pause(); } catch (e) { }
  }
}

function wallpaperEngineLayerReady(kind, token) {
  if (token !== wallpaperEngineLayerToken || !wallpaperEngineSelection.active) return;
  cancelWallpaperEngineHostRecovery(true);
  var layer = document.getElementById('wallpaper-engine-layer');
  if (!layer) return;
  layer.classList.remove('ready', 'image-ready', 'video-ready', 'engine-ready', 'freeze-ready');
  document.body.classList.toggle('wallpaper-engine-dwm-active', kind === 'dwm');
  if (kind !== 'dwm') {
    stopWallpaperEngineGlassCaptureStream(false);
    layer.classList.add(kind === 'video' ? 'video-ready' : 'image-ready', 'ready');
    if (kind === 'video' && wallpaperEngineSelection.kind === 'engine') layer.classList.add('engine-ready');
    if (kind === 'video' && wallpaperEngineSelection.kind === 'engine') queueWallpaperEnginePointerActivity();
  }
  document.body.classList.add('wallpaper-engine-active');
  if (kind === 'dwm' && typeof animateWallpaperEngineControlGlassSurface === 'function') {
    animateWallpaperEngineControlGlassSurface(560);
  }
  if (kind === 'dwm') {
    scheduleWallpaperEngineGlassSamplerCapture(String(wallpaperEngineNativeSessionId || ''), token, 0);
  }
  suspendOriginalBackgroundForWallpaperEngine();
  wallpaperEngineRuntimeError = '';
  updateWallpaperEngineEntryUi();
  renderWallpaperEngineLibrary();
}

function describeWallpaperEngineMediaFailure(item, error) {
  var code = error && error.code;
  var msg = error && error.message ? String(error.message) : '';
  var v = document.getElementById('wallpaper-engine-video');
  var src = v && (v.currentSrc || v.src) || '';
  var projectType = item && item.projectType || '';
  var mediaType = item && item.mediaType || '';
  var safetyMode = item && item.safetyMode || '';
  var title = item && item.title ? '（' + item.title + '）' : '';
  var reason;
  if (code === 3) reason = '音视频编码不被浏览器支持，常见于 AC-3/E-AC-3 音轨或 HEVC/H.265 视频（Chromium 不含杜比授权）';
  else if (code === 4) reason = '媒体格式/容器不被浏览器支持，常见于 .mov 封装、HEVC-in-MOV、ProRes 或文件损坏';
  else if (code === 2) reason = '媒体文件读取失败（路径不可访问或协议返回错误）';
  else if (code === 1) reason = '加载被中断（通常可忽略）';
  else reason = '音视频编码不被浏览器支持';
  console.warn('[Wallpaper Engine Media] 解码失败诊断：MediaError.code=' + code + ' message=' + msg
    + ' | projectType=' + projectType + ' mediaType=' + mediaType + ' safetyMode=' + safetyMode
    + ' | src=' + src);
  return '动态媒体解码失败' + title + '：' + reason + '，已切换到安全预览';
}

function wallpaperEngineLayerFailed(item, attemptedKind, token, error) {
  if (token !== wallpaperEngineLayerToken) return;
  var nativeStopPromise = Promise.resolve({ ok: true });
  if (attemptedKind === 'engine') {
    cancelWallpaperEngineFirstFrameWait();
    var failedSessionId = String(wallpaperEngineNativeSessionId || '');
    if (/^[a-f0-9]{24}$/i.test(failedSessionId)) reportWallpaperEngineCaptureResult(failedSessionId, false);
    stopWallpaperEngineCaptureStream();
    nativeStopPromise = stopWallpaperEngineNativeSession();
    if (wallpaperEngineHostRecoveryInFlight
      && wallpaperEngineHostRecoveryAttempt < WALLPAPER_ENGINE_HOST_RECOVERY_MAX_ATTEMPTS
      && wallpaperEngineDesktopHostIsVisible()) {
      wallpaperEngineHostBoundsPreparing = true;
      wallpaperEngineRuntimeError = '';
      restoreOriginalBackgroundAfterWallpaperEngine();
      clearWallpaperEngineLayerMedia(0);
      updateWallpaperEngineEntryUi('正在恢复 ' + (item && item.title || 'Wallpaper Engine') + '…');
      Promise.resolve(nativeStopPromise).finally(function () {
        if (!wallpaperEngineHostRecoveryInFlight || wallpaperEngineHostRecoveryRetryTimer) return;
        wallpaperEngineHostRecoveryRetryTimer = setTimeout(function () {
          wallpaperEngineHostRecoveryRetryTimer = 0;
          if (!wallpaperEngineHostRecoveryInFlight
            || !wallpaperEngineSelection.active
            || wallpaperEngineSelection.kind !== 'engine'
            || !wallpaperEngineDesktopHostIsVisible()) return;
          wallpaperEngineHostBoundsPreparing = false;
          restartWallpaperEngineAfterHostBoundsChange();
        }, 650);
      });
      return;
    }
    cancelWallpaperEngineHostRecovery(true);
  }
  if ((attemptedKind === 'media' || attemptedKind === 'engine') && item && item.hasPreview) {
    wallpaperEngineSelection.kind = 'preview';
    wallpaperEngineSelection.mediaType = 'image';
    showToast(attemptedKind === 'engine' ? ((wallpaperEngineRuntimeError || 'Wallpaper Engine 实时运行失败') + '，已切换到项目预览；再次点击可重试') : describeWallpaperEngineMediaFailure(item, error));
    applyWallpaperEngineBackground(item, true);
    return;
  }
  wallpaperEngineRuntimeError = attemptedKind === 'engine' ? 'WE 引擎运行失败' : '媒体不可用';
  restoreOriginalBackgroundAfterWallpaperEngine();
  clearWallpaperEngineLayerMedia(0);
  updateWallpaperEngineEntryUi();
  showToast('壁纸媒体不可用，已恢复原背景');
}

function applyWallpaperEngineBackground(item, quiet) {
  // 2026-08-19: 移植自 Stellaflix 2.1.0 — Wallpaper Engine 默认启用，允许壁纸播放/恢复
  item = item || wallpaperEngineProjectById(wallpaperEngineSelection.id);
  console.log('[Wallpaper Engine] applyWallpaperEngineBackground called, item:', item ? item.title : 'null', 'selection.active:', wallpaperEngineSelection.active);
  if (!item || !wallpaperEngineSelection.active) {
    wallpaperEngineRuntimeError = item ? '' : '项目离线';
    restoreOriginalBackgroundAfterWallpaperEngine();
    clearWallpaperEngineLayerMedia(0);
    updateWallpaperEngineEntryUi(item ? '' : '项目离线 · 已显示原背景');
    return false;
  }
  var kind = wallpaperEngineSelection.kind === 'engine' && item.enginePlayable
    ? 'engine'
    : (wallpaperEngineSelection.kind === 'media' && item.playable ? 'media' : 'preview');
  if (kind === 'preview' && !item.hasPreview) {
    wallpaperEngineLayerFailed(item, kind, wallpaperEngineLayerToken);
    return false;
  }
  var layer = document.getElementById('wallpaper-engine-layer');
  var image = document.getElementById('wallpaper-engine-image');
  var video = document.getElementById('wallpaper-engine-video');
  var preserveOutgoingFrame = !!(layer && (layer.classList.contains('ready') || wallpaperEngineSwitchTimer));
  cancelWallpaperEngineSwitchTimer();
  var token = ++wallpaperEngineLayerToken;
  if (kind !== 'engine') stopWallpaperEngineNativeSession();
  restoreOriginalBackgroundAfterWallpaperEngine();
  if (!layer || !image || !video) return false;
  updateWallpaperEngineEntryUi('正在加载 ' + (item.title || '壁纸') + '…');

  function beginWallpaperEngineMediaLoad() {
    if (token !== wallpaperEngineLayerToken || !wallpaperEngineSelection.active || wallpaperEngineSelection.id !== item.id) return;
    if (kind === 'engine' && wallpaperEngineNativeHostUnavailable()) return;
    clearWallpaperEngineLayerMedia(0);
    if (kind === 'engine') {
      startWallpaperEngineNativeBackground(item, token).catch(function (error) {
        if (token !== wallpaperEngineLayerToken) return;
        if (wallpaperEngineNativeHostUnavailable() || /WALLPAPER_ENGINE_START_SUPERSEDED/.test(String(error && (error.code || error.message) || error || ''))) return;
        console.warn('[Wallpaper Engine Scene]', error);
        wallpaperEngineRuntimeError = wallpaperEngineRuntimeErrorText(error);
        wallpaperEngineLayerFailed(item, kind, token);
      });
    } else if (kind === 'media' && item.mediaType === 'video') {
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      if (item.hasPreview) video.poster = wallpaperEngineMediaUrl(item, 'preview');
      video.onloadeddata = function () {
        if (token !== wallpaperEngineLayerToken) return;
        requestWallpaperEngineVideoPlayback(video, item, kind, token, true, 0);
      };
      video.onerror = function () {
        var mediaErr = video.error || null;
        wallpaperEngineLayerFailed(item, kind, token, mediaErr);
      };
      video.src = wallpaperEngineMediaUrl(item, 'media');
      video.load();
    } else {
      image.onload = function () { wallpaperEngineLayerReady('image', token); };
      image.onerror = function () { wallpaperEngineLayerFailed(item, kind, token); };
      image.src = wallpaperEngineMediaUrl(item, kind === 'media' ? 'media' : 'preview');
    }
  }

  if (preserveOutgoingFrame) {
    clearWallpaperEngineLayerMedia(WALLPAPER_ENGINE_SWITCH_FADE_MS);
    wallpaperEngineSwitchTimer = setTimeout(function () {
      wallpaperEngineSwitchTimer = 0;
      beginWallpaperEngineMediaLoad();
    }, WALLPAPER_ENGINE_SWITCH_FADE_MS + 20);
  } else {
    clearWallpaperEngineLayerMedia(0);
    beginWallpaperEngineMediaLoad();
  }
  if (!quiet) showToast(kind === 'engine' ? '正在用 Wallpaper Engine 原生引擎载入 Scene…' : (kind === 'media' ? 'Wallpaper Engine 壁纸已启用' : '已启用安全预览，原背景仍保留'));
  return true;
}

function activateWallpaperEngineItem(id) {
  var item = wallpaperEngineProjectById(id);
  console.log('[Wallpaper Engine] activateWallpaperEngineItem called, id:', id, 'item:', item ? {id: item.id, playable: item.playable, enginePlayable: item.enginePlayable, hasPreview: item.hasPreview, title: item.title} : null);
  if (!item || (!item.playable && !item.enginePlayable && !item.hasPreview)) {
    showToast('该项目没有可安全导入的媒体');
    console.warn('[Wallpaper Engine] Item not playable, skipping');
    return;
  }
  wallpaperEngineSelection = normalizeWallpaperEngineSelection({
    active: true,
    id: item.id,
    title: item.title,
    kind: item.enginePlayable ? 'engine' : (item.playable ? 'media' : 'preview'),
    mediaType: item.enginePlayable ? 'video' : (item.playable ? item.mediaType : 'image'),
    mediaAnimated: item.mediaAnimated,
    projectType: item.projectType,
    hasPreview: item.hasPreview,
    previewAnimated: item.previewAnimated,
    updatedAt: item.updatedAt
  });
  wallpaperEngineDesktopPreviewActive = false;
  wallpaperEngineDesktopPreviewUsesAsset = false;
  cancelWallpaperEngineHostRecovery(true);
  saveWallpaperEngineSelection();
  wallpaperEngineRuntimeError = '';
  applyWallpaperEngineBackground(item, false);
  closeWallpaperEngineLibrary();
}

function deactivateWallpaperEngineBackground(quiet) {
  cancelWallpaperEngineHostRecovery(true);
  wallpaperEngineDesktopPreviewActive = false;
  wallpaperEngineDesktopPreviewUsesAsset = false;
  wallpaperEngineSelection.active = false;
  if (wallpaperEngineHostBoundsRestartTimer) {
    clearTimeout(wallpaperEngineHostBoundsRestartTimer);
    wallpaperEngineHostBoundsRestartTimer = 0;
  }
  saveWallpaperEngineSelection();
  wallpaperEngineRuntimeError = '';
  cancelWallpaperEngineSwitchTimer();
  cancelWallpaperEngineVideoRetry();
  cancelWallpaperEngineFirstFrameWait();
  wallpaperEngineHostBoundsPreparing = false;
  stopWallpaperEngineCaptureStream();
  stopWallpaperEngineNativeSession();
  ++wallpaperEngineLayerToken;
  restoreOriginalBackgroundAfterWallpaperEngine();
  clearWallpaperEngineFreezeFrame(true);
  clearWallpaperEngineLayerMedia(0);
  updateWallpaperEngineEntryUi();
  renderWallpaperEngineLibrary();
  if (!quiet) showToast('已恢复原背景媒体，原设置没有被覆盖');
}

function restartWallpaperEngineAfterHostBoundsChange() {
  if (!wallpaperEngineSelection.active || wallpaperEngineSelection.kind !== 'engine' || wallpaperEngineNativeHostUnavailable()) return;
  var item = wallpaperEngineProjectById(wallpaperEngineSelection.id);
  if (!item || !item.enginePlayable) {
    clearWallpaperEngineFreezeFrame(false);
    return;
  }
  cancelWallpaperEngineSwitchTimer();
  cancelWallpaperEngineVideoRetry();
  cancelWallpaperEngineFirstFrameWait();
  if (wallpaperEngineHostBoundsRestartTimer) {
    clearTimeout(wallpaperEngineHostBoundsRestartTimer);
    wallpaperEngineHostBoundsRestartTimer = 0;
  }
  var token = ++wallpaperEngineLayerToken;
  wallpaperEngineHostRecoveryInFlight = true;
  wallpaperEngineHostRecoveryAttempt += 1;
  wallpaperEngineRuntimeError = '';
  updateWallpaperEngineEntryUi('正在恢复 ' + (item.title || 'Wallpaper Engine') + '…');
  startWallpaperEngineNativeBackground(item, token).catch(function (error) {
    if (token !== wallpaperEngineLayerToken) return;
    if (wallpaperEngineNativeHostUnavailable() || /WALLPAPER_ENGINE_START_SUPERSEDED/.test(String(error && (error.code || error.message) || error || ''))) return;
    console.warn('[Wallpaper Engine Scene bounds restart]', error);
    wallpaperEngineRuntimeError = wallpaperEngineRuntimeErrorText(error);
    wallpaperEngineLayerFailed(item, 'engine', token);
  });
}

function handleWallpaperEngineHostBoundsChange(payload) {
  var phase = String(payload && payload.phase || 'restart');
  if (phase === 'restart') {
    if (!wallpaperEngineHostBoundsPreparing && !wallpaperEngineDesktopPreviewActive) return;
    // BrowserWindow.show()/restore can fire before Chromium has published the
    // visible document state. Keep the session suspended until visibilitychange
    // confirms that capture can be created without an immediate preview fallback.
    if (document.hidden && !(payload && payload.forceVisibleHost === true)) return;
    wallpaperEngineDesktopPreviewActive = false;
    wallpaperEngineDesktopPreviewUsesAsset = false;
    wallpaperEngineHostBoundsPreparing = false;
    restartWallpaperEngineAfterHostBoundsChange();
    return;
  }
  if (phase === 'prepare' && typeof window.__stellaflixPrepareWallpaperEngineHostBoundsChange === 'function') {
    window.__stellaflixPrepareWallpaperEngineHostBoundsChange(payload && payload.sessionId, payload && payload.reason);
  }
}

