function reportWallpaperEngineCaptureResult(sessionId, ok) {
  var api = wallpaperEngineDesktopApi();
  if (!api || typeof api.reportWallpaperEngineCaptureResult !== 'function') return Promise.resolve({ ok: false });
  return Promise.resolve(api.reportWallpaperEngineCaptureResult({ sessionId: String(sessionId || ''), ok: ok === true })).catch(function () {
    return { ok: false };
  });
}

function waitForWallpaperEngineVideoFirstFrame(video, item, token, sessionId, runtime) {
  cancelWallpaperEngineFirstFrameWait();
  var wait = {
    video: video,
    callbackId: 0,
    loadedDataHandler: null,
    timer: 0,
    raf1: 0,
    raf2: 0
  };
  wallpaperEngineFirstFrameWait = wait;

  function releaseWait() {
    if (wallpaperEngineFirstFrameWait !== wait) return false;
    wallpaperEngineFirstFrameWait = null;
    if (wait.timer) clearTimeout(wait.timer);
    wait.timer = 0;
    if (wait.video && wait.loadedDataHandler) {
      try { wait.video.removeEventListener('loadeddata', wait.loadedDataHandler); } catch (e) { }
    }
    if (wait.raf1 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(wait.raf1);
    if (wait.raf2 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(wait.raf2);
    wait.raf1 = 0;
    wait.raf2 = 0;
    wait.loadedDataHandler = null;
    return true;
  }

  function firstFrameReady() {
    if (!releaseWait()) return;
    if (!wallpaperEngineNativeStartIsCurrent(item, token)
      || wallpaperEngineNativeSessionId !== sessionId
      || wallpaperEngineCaptureStream !== video.srcObject) return;
    reportWallpaperEngineCaptureResult(sessionId, true).then(function (acknowledgement) {
      if (!wallpaperEngineNativeStartIsCurrent(item, token)
        || wallpaperEngineNativeSessionId !== sessionId
        || wallpaperEngineCaptureStream !== video.srcObject) return;
      if (!acknowledgement
        || acknowledgement.ok !== true
        || acknowledgement.accepted !== true
        || acknowledgement.captureReady !== true) {
        wallpaperEngineRuntimeError = String(acknowledgement && acknowledgement.error || 'WALLPAPER_CAPTURE_CONFIRMATION_FAILED');
        wallpaperEngineLayerFailed(item, 'engine', token);
        return;
      }
      calibrateWallpaperEngineCaptureViewport(video, runtime);
      wallpaperEngineLayerReady('video', token);
      clearWallpaperEngineFreezeFrame(false);
    });
  }

  function firstFrameTimedOut() {
    if (!releaseWait()) return;
    if (!wallpaperEngineNativeStartIsCurrent(item, token) || wallpaperEngineNativeSessionId !== sessionId) return;
    wallpaperEngineLayerFailed(item, 'engine', token);
  }

  wait.timer = setTimeout(firstFrameTimedOut, WALLPAPER_ENGINE_FIRST_FRAME_TIMEOUT_MS);
  if (typeof video.requestVideoFrameCallback === 'function') {
    wait.callbackId = video.requestVideoFrameCallback(function () { firstFrameReady(); });
  } else {
    wait.loadedDataHandler = function () {
      // loadeddata can reflect the reused video element's previous source.
      // Two paints after this session's event ensure its new pixels presented.
      wait.raf1 = requestAnimationFrame(function () {
        wait.raf2 = requestAnimationFrame(function () { firstFrameReady(); });
      });
    };
    video.addEventListener('loadeddata', wait.loadedDataHandler, { once: true });
  }
}

function wallpaperEngineNativeStartIsCurrent(item, token) {
  return token === wallpaperEngineLayerToken
    && wallpaperEngineSelection.active
    && wallpaperEngineSelection.id === item.id
    && !wallpaperEngineNativeHostUnavailable();
}

