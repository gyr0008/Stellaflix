function cancelWallpaperEngineSwitchTimer() {
  if (wallpaperEngineSwitchTimer) clearTimeout(wallpaperEngineSwitchTimer);
  wallpaperEngineSwitchTimer = 0;
}

function cancelWallpaperEngineVideoRetry() {
  if (wallpaperEngineVideoRetryTimer) clearTimeout(wallpaperEngineVideoRetryTimer);
  wallpaperEngineVideoRetryTimer = 0;
}

function cancelWallpaperEngineFirstFrameWait() {
  var wait = wallpaperEngineFirstFrameWait;
  wallpaperEngineFirstFrameWait = null;
  if (!wait) return;
  if (wait.timer) clearTimeout(wait.timer);
  if (wait.video && wait.callbackId && typeof wait.video.cancelVideoFrameCallback === 'function') {
    try { wait.video.cancelVideoFrameCallback(wait.callbackId); } catch (e) { }
  }
  if (wait.video && wait.loadedDataHandler) {
    try { wait.video.removeEventListener('loadeddata', wait.loadedDataHandler); } catch (e2) { }
  }
  if (wait.raf1 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(wait.raf1);
  if (wait.raf2 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(wait.raf2);
}

function resetWallpaperEngineCaptureViewport(video) {
  wallpaperEngineCaptureViewportScaleX = 1;
  wallpaperEngineCaptureViewportScaleY = 1;
  video = video || document.getElementById('wallpaper-engine-video');
  if (video) {
    video.style.removeProperty('transform');
    video.style.removeProperty('transform-origin');
  }
  var layer = document.getElementById('wallpaper-engine-layer');
  if (layer) {
    delete layer.dataset.captureScaleX;
    delete layer.dataset.captureScaleY;
  }
}

function wallpaperEngineCaptureContentSize(runtime) {
  runtime = runtime && typeof runtime === 'object' ? runtime : {};
  var host = runtime.hostWindowRect && typeof runtime.hostWindowRect === 'object'
    ? runtime.hostWindowRect
    : null;
  var width = host ? Math.abs((Number(host.right) || 0) - (Number(host.left) || 0)) : 0;
  var height = host ? Math.abs((Number(host.bottom) || 0) - (Number(host.top) || 0)) : 0;
  if (!(width > 0)) width = Number(runtime.sourceWindowVisibleWidth) || 0;
  if (!(height > 0)) height = Number(runtime.sourceWindowVisibleHeight) || 0;
  return { width: width, height: height };
}

function calibrateWallpaperEngineCaptureViewport(video, runtime) {
  if (!video || !runtime || runtime.sourceWindowAligned !== true) {
    resetWallpaperEngineCaptureViewport(video);
    return { scaleX: 1, scaleY: 1 };
  }
  var content = wallpaperEngineCaptureContentSize(runtime);
  var frameWidth = Number(video.videoWidth) || Number(runtime.width) || 0;
  var frameHeight = Number(video.videoHeight) || Number(runtime.height) || 0;
  var rawScaleX = content.width > 0 ? frameWidth / content.width : 1;
  var rawScaleY = content.height > 0 ? frameHeight / content.height : 1;
  var scaleX = rawScaleX > 1.015 && rawScaleX < 4.01 ? rawScaleX : 1;
  var scaleY = rawScaleY > 1.015 && rawScaleY < 4.01 ? rawScaleY : 1;
  // Wallpaper Engine's play-in-window surface is reported in Windows DIPs,
  // while desktopCapturer exposes a physical-pixel frame on scaled displays.
  // Crop the padded right/bottom portion by enlarging only the captured layer.
  if (scaleX !== 1 && scaleY !== 1 && Math.abs(scaleX - scaleY) <= 0.035) {
    var uniformScale = (scaleX + scaleY) / 2;
    scaleX = uniformScale;
    scaleY = uniformScale;
  }
  wallpaperEngineCaptureViewportScaleX = scaleX;
  wallpaperEngineCaptureViewportScaleY = scaleY;
  video.style.transformOrigin = '0 0';
  video.style.transform = (scaleX === 1 && scaleY === 1)
    ? ''
    : 'scale3d(' + scaleX.toFixed(6) + ',' + scaleY.toFixed(6) + ',1)';
  var layer = document.getElementById('wallpaper-engine-layer');
  if (layer) {
    layer.dataset.captureScaleX = scaleX.toFixed(6);
    layer.dataset.captureScaleY = scaleY.toFixed(6);
  }
  return { scaleX: scaleX, scaleY: scaleY };
}

function captureWallpaperEngineFreezeFrame() {
  var layer = document.getElementById('wallpaper-engine-layer');
  var canvas = document.getElementById('wallpaper-engine-freeze');
  var video = document.getElementById('wallpaper-engine-video');
  if (!layer || !canvas || !video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return false;
  if (wallpaperEngineFreezeReleaseTimer) clearTimeout(wallpaperEngineFreezeReleaseTimer);
  wallpaperEngineFreezeReleaseTimer = 0;
  ++wallpaperEngineFreezeGeneration;
  try {
    var freezeScale = Math.min(1, 3840 / Math.max(1, video.videoWidth), 2160 / Math.max(1, video.videoHeight));
    var width = Math.max(1, Math.round(video.videoWidth * freezeScale));
    var height = Math.max(1, Math.round(video.videoHeight * freezeScale));
    var sourceWidth = Math.max(1, Math.min(video.videoWidth, Math.round(video.videoWidth / Math.max(1, wallpaperEngineCaptureViewportScaleX))));
    var sourceHeight = Math.max(1, Math.min(video.videoHeight, Math.round(video.videoHeight / Math.max(1, wallpaperEngineCaptureViewportScaleY))));
    canvas.width = width;
    canvas.height = height;
    var context = canvas.getContext('2d', { alpha: false, desynchronized: true }) || canvas.getContext('2d');
    if (!context) return false;
    context.globalCompositeOperation = 'copy';
    context.drawImage(video, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height);
  } catch (error) {
    return false;
  }
  wallpaperEngineFreezeVisible = true;
  layer.classList.add('ready', 'video-ready', 'engine-ready', 'freeze-ready');
  document.body.classList.add('wallpaper-engine-active');
  return true;
}

function clearWallpaperEngineFreezeFrame(immediate) {
  var layer = document.getElementById('wallpaper-engine-layer');
  var canvas = document.getElementById('wallpaper-engine-freeze');
  if (wallpaperEngineFreezeReleaseTimer) clearTimeout(wallpaperEngineFreezeReleaseTimer);
  wallpaperEngineFreezeReleaseTimer = 0;
  var generation = ++wallpaperEngineFreezeGeneration;
  wallpaperEngineFreezeVisible = false;
  if (layer) layer.classList.remove('freeze-ready');
  function releaseCanvas() {
    if (generation !== wallpaperEngineFreezeGeneration || wallpaperEngineFreezeVisible || !canvas) return;
    canvas.width = 1;
    canvas.height = 1;
  }
  if (immediate) releaseCanvas();
  else wallpaperEngineFreezeReleaseTimer = setTimeout(function () {
    wallpaperEngineFreezeReleaseTimer = 0;
    releaseCanvas();
  }, WALLPAPER_ENGINE_FREEZE_FADE_MS + 30);
}

function stopWallpaperEngineMediaStream(stream) {
  if (!stream || !stream.getTracks) return;
  stream.getTracks().forEach(function (track) {
    try { track.stop(); } catch (e) { }
  });
}

function stopWallpaperEnginePreparedCaptureStreams(sessionId) {
  var expected = String(sessionId || '');
  wallpaperEnginePreparedCaptureStreams.forEach(function (entry, id) {
    if (expected && id !== expected) return;
    if (entry && entry.timer) clearTimeout(entry.timer);
    stopWallpaperEngineMediaStream(entry && entry.stream);
    wallpaperEnginePreparedCaptureStreams.delete(id);
  });
}

function stopWallpaperEnginePreparedGlassCaptureStreams(sessionId) {
  var expected = String(sessionId || '');
  wallpaperEnginePreparedGlassCaptureStreams.forEach(function (entry, id) {
    if (expected && id !== expected) return;
    if (entry && entry.timer) clearTimeout(entry.timer);
    stopWallpaperEngineMediaStream(entry && entry.stream);
    wallpaperEnginePreparedGlassCaptureStreams.delete(id);
  });
}

function storeWallpaperEnginePreparedCaptureStream(sessionId, stream) {
  sessionId = String(sessionId || '');
  stopWallpaperEnginePreparedCaptureStreams(sessionId);
  var entry = { stream: stream, timer: 0 };
  entry.timer = setTimeout(function () {
    if (wallpaperEnginePreparedCaptureStreams.get(sessionId) !== entry) return;
    wallpaperEnginePreparedCaptureStreams.delete(sessionId);
    stopWallpaperEngineMediaStream(stream);
  }, WALLPAPER_ENGINE_PREPARED_STREAM_TTL_MS);
  wallpaperEnginePreparedCaptureStreams.set(sessionId, entry);
}

function takeWallpaperEnginePreparedCaptureStream(sessionId) {
  sessionId = String(sessionId || '');
  var entry = wallpaperEnginePreparedCaptureStreams.get(sessionId);
  if (!entry) return null;
  wallpaperEnginePreparedCaptureStreams.delete(sessionId);
  if (entry.timer) clearTimeout(entry.timer);
  return entry.stream || null;
}

function storeWallpaperEnginePreparedGlassCaptureStream(sessionId, stream) {
  sessionId = String(sessionId || '');
  stopWallpaperEnginePreparedGlassCaptureStreams(sessionId);
  var entry = { stream: stream, timer: 0 };
  entry.timer = setTimeout(function () {
    if (wallpaperEnginePreparedGlassCaptureStreams.get(sessionId) !== entry) return;
    wallpaperEnginePreparedGlassCaptureStreams.delete(sessionId);
    stopWallpaperEngineMediaStream(stream);
  }, WALLPAPER_ENGINE_PREPARED_STREAM_TTL_MS);
  wallpaperEnginePreparedGlassCaptureStreams.set(sessionId, entry);
}

function takeWallpaperEnginePreparedGlassCaptureStream(sessionId) {
  sessionId = String(sessionId || '');
  var entry = wallpaperEnginePreparedGlassCaptureStreams.get(sessionId);
  if (!entry) return null;
  wallpaperEnginePreparedGlassCaptureStreams.delete(sessionId);
  if (entry.timer) clearTimeout(entry.timer);
  return entry.stream || null;
}

function stopWallpaperEngineGlassCaptureStream(keepPreparedStreams) {
  ++wallpaperEngineGlassCaptureToken;
  if (wallpaperEngineGlassCaptureRetryTimer) clearTimeout(wallpaperEngineGlassCaptureRetryTimer);
  wallpaperEngineGlassCaptureRetryTimer = 0;
  wallpaperEngineGlassCaptureRetryAttempt = 0;
  if (!keepPreparedStreams) stopWallpaperEnginePreparedGlassCaptureStreams();
  var stream = wallpaperEngineGlassCaptureStream;
  wallpaperEngineGlassCaptureStream = null;
  stopWallpaperEngineMediaStream(stream);
  var video = document.getElementById('wallpaper-engine-glass-sampler-video');
  if (video) {
    video.onloadeddata = null;
    video.onerror = null;
    try { video.pause(); } catch (e) { }
    if (video.srcObject) {
      try { video.srcObject = null; } catch (e2) { }
    }
  }
  document.body.classList.remove('wallpaper-engine-glass-sampler-ready');
}

function stopWallpaperEngineCaptureStream(keepPreparedStreams) {
  cancelWallpaperEngineFirstFrameWait();
  cancelWallpaperEnginePointerActivity();
  if (!keepPreparedStreams) stopWallpaperEnginePreparedCaptureStreams();
  var stream = wallpaperEngineCaptureStream;
  wallpaperEngineCaptureStream = null;
  wallpaperEngineCaptureMode = '';
  stopWallpaperEngineMediaStream(stream);
  stopWallpaperEngineGlassCaptureStream(keepPreparedStreams);
  var video = document.getElementById('wallpaper-engine-video');
  resetWallpaperEngineCaptureViewport(video);
  if (video && video.srcObject) {
    try { video.srcObject = null; } catch (e2) { }
  }
}

async function hardenWallpaperEngineCaptureStream(stream) {
  if (!stream) return stream;
  var audioTracks = stream.getAudioTracks ? stream.getAudioTracks() : [];
  audioTracks.forEach(function (track) {
    try { if (stream.removeTrack) stream.removeTrack(track); } catch (e) { }
    try { track.stop(); } catch (e2) { }
  });
  var tracks = stream.getVideoTracks ? stream.getVideoTracks() : [];
  var cursorResults = await Promise.all(tracks.map(function (track) {
    if (!track || typeof track.applyConstraints !== 'function') return Promise.resolve(false);
    return Promise.resolve(track.applyConstraints({ cursor: 'never' })).then(function () {
      try {
        var settings = typeof track.getSettings === 'function' ? track.getSettings() : null;
        // Chromium's legacy chromeMediaSource path can resolve applyConstraints
        // while silently omitting the cursor setting and continuing to bake a
        // delayed software pointer into the captured frame. Only an explicit
        // `never` acknowledgement counts as verified suppression.
        if (!settings || settings.cursor !== 'never') return false;
      } catch (e3) { return false; }
      return true;
    }).catch(function () { return false; });
  }));
  try {
    stream.__stellaflixCursorSuppressed = !!tracks.length && cursorResults.every(function (value) { return value === true; });
  } catch (e4) { }
  return stream;
}

function wallpaperEngineCaptureFpsPreference() {
  var mode = typeof normalizeForegroundFpsMode === 'function'
    ? normalizeForegroundFpsMode(fx && fx.foregroundFpsMode)
    : 'vsync';
  var fixed = typeof foregroundFixedFpsForMode === 'function'
    ? foregroundFixedFpsForMode(mode)
    : (/^(45|60|75|90|120)$/.test(String(mode)) ? Number(mode) : 0);
  return Number(fixed) > 0 ? Math.max(24, Math.min(240, Math.round(Number(fixed)))) : 0;
}

function wallpaperEngineResolvedCaptureFps(value) {
  var fps = Number(value);
  if (!(fps > 0)) {
    fps = typeof estimatedDisplayRefreshHz === 'function' ? estimatedDisplayRefreshHz() : 60;
  }
  return Math.max(24, Math.min(240, Math.round(Number(fps) || 60)));
}

function wallpaperEngineRuntimeCaptureFps() {
  var preferred = wallpaperEngineCaptureFpsPreference();
  return preferred > 0 ? preferred : wallpaperEngineResolvedCaptureFps(0);
}

async function syncWallpaperEngineCaptureFrameRate() {
  var stream = wallpaperEngineCaptureStream;
  var track = stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
  if (!track || typeof track.applyConstraints !== 'function') return { ok: false, skipped: true };
  var target = wallpaperEngineRuntimeCaptureFps();
  try {
    var capabilities = typeof track.getCapabilities === 'function' ? track.getCapabilities() : null;
    var range = capabilities && capabilities.frameRate;
    if (range && Number(range.min) > 0) target = Math.max(Number(range.min), target);
    if (range && Number(range.max) > 0) target = Math.min(Number(range.max), target);
  } catch (e) { }
  try {
    await track.applyConstraints({ frameRate: { ideal: target, max: target } });
    try { track.contentHint = 'motion'; } catch (e2) { }
    return { ok: true, fps: target };
  } catch (error) {
    return { ok: false, error: String(error && (error.message || error.name) || error || 'FRAME_RATE_CONSTRAINT_FAILED').slice(0, 240) };
  }
}

window.__stellaflixSyncWallpaperEngineCaptureFrameRate = syncWallpaperEngineCaptureFrameRate;

function stopWallpaperEngineNativeSession(sessionId) {
  var api = wallpaperEngineDesktopApi();
  var stopAll = arguments.length === 0;
  var expected = String(sessionId || wallpaperEngineNativeSessionId || '');
  if (stopAll || !sessionId || expected === wallpaperEngineNativeSessionId) wallpaperEngineNativeSessionId = '';
  if (!api || typeof api.stopWallpaperEngineScene !== 'function') return Promise.resolve({ ok: true });
  return Promise.resolve(api.stopWallpaperEngineScene({ sessionId: expected, all: stopAll })).catch(function () {
    return { ok: false };
  });
}

async function openWallpaperEngineCaptureStream(sessionId, fps, sourceId, options) {
  if (!navigator.mediaDevices || !/^[a-f0-9]{24}$/i.test(String(sessionId || ''))) {
    throw new Error('WALLPAPER_CAPTURE_UNSUPPORTED');
  }
  options = options && typeof options === 'object' ? options : {};
  sourceId = String(sourceId || '');
  var maxFrameRate = wallpaperEngineResolvedCaptureFps(fps);
  var diagnostics = {
    sessionId: String(sessionId || ''),
    sourceId: sourceId,
    maxFrameRate: maxFrameRate,
    attempts: [],
    selectedPath: '',
    purpose: options.purpose === 'dwm-glass' ? 'dwm-glass' : 'scene',
    trustedCursorFreeSurface: options.trustedCursorFreeSurface === true
  };
  try {
    if (diagnostics.purpose === 'dwm-glass') window.__stellaflixWallpaperEngineGlassCaptureDiagnostics = diagnostics;
    else window.__stellaflixWallpaperEngineCaptureDiagnostics = diagnostics;
  } catch (e) { }
  function recordAttempt(path, stream, error) {
    var track = stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
    var entry = {
      path: path,
      ok: !!track,
      cursorSuppressed: !!(stream && stream.__stellaflixCursorSuppressed),
      settings: null,
      constraints: null,
      error: error ? String(error && (error.message || error.name) || error).slice(0, 500) : ''
    };
    try { entry.settings = track && typeof track.getSettings === 'function' ? track.getSettings() : null; } catch (e2) { }
    try { entry.constraints = track && typeof track.getConstraints === 'function' ? track.getConstraints() : null; } catch (e3) { }
    diagnostics.attempts.push(entry);
    return entry;
  }
  // The exact desktop-source path is the only built-in Chromium route that may
  // omit the captured cursor while keeping the real WE window under the host.
  // Use it only when the video track explicitly acknowledges cursor: never.
  // A resolved request without that acknowledgement is stopped immediately.
  var sourceError = null;
  if (/^window:\d+:\d+$/.test(sourceId) && typeof navigator.mediaDevices.getUserMedia === 'function') {
    try {
      var sourceStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          cursor: { exact: 'never' },
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId,
            maxFrameRate: maxFrameRate
          }
        }
      });
      if (sourceStream && sourceStream.getVideoTracks && sourceStream.getVideoTracks().length) {
        var hardenedSourceStream = await hardenWallpaperEngineCaptureStream(sourceStream);
        try { hardenedSourceStream.__stellaflixCapturePath = 'source-id-media'; } catch (e4) { }
        var sourceAttempt = recordAttempt('source-id-media', hardenedSourceStream, null);
        if (sourceAttempt.cursorSuppressed || options.trustedCursorFreeSurface === true
          || window.__stellaflixAllowUnverifiedSourceCapture === true) {
          try { hardenedSourceStream.__stellaflixUnverifiedCursorCapture = !sourceAttempt.cursorSuppressed; } catch (e5) { }
          diagnostics.selectedPath = 'source-id-media';
          return hardenedSourceStream;
        }
        stopWallpaperEngineMediaStream(hardenedSourceStream);
        sourceError = new Error('WALLPAPER_CAPTURE_CURSOR_SUPPRESSION_UNVERIFIED');
      } else {
        stopWallpaperEngineMediaStream(sourceStream);
        throw new Error('WALLPAPER_CAPTURE_STREAM_EMPTY');
      }
    } catch (error) {
      sourceError = error;
      recordAttempt('source-id-media', null, error);
    }
  }
  var displayError = null;
  // Electron still grants only the exact WE source here. On current Chromium,
  // getDisplayMedia can report cursor: always even when never was requested;
  // retain it as the visual compatibility fallback and record that fact rather
  // than treating the requested constraint as proof of cursor suppression.
  if (options.sourceIdOnly !== true && typeof navigator.mediaDevices.getDisplayMedia === 'function') {
    try {
      var displayStream = await navigator.mediaDevices.getDisplayMedia({
        audio: false,
        video: { frameRate: { ideal: maxFrameRate, max: maxFrameRate }, displaySurface: 'window', cursor: 'never' }
      });
      if (displayStream && displayStream.getVideoTracks && displayStream.getVideoTracks().length) {
        var hardenedDisplayStream = await hardenWallpaperEngineCaptureStream(displayStream);
        try { hardenedDisplayStream.__stellaflixCapturePath = 'display-media'; } catch (e6) { }
        recordAttempt('display-media', hardenedDisplayStream, null);
        diagnostics.selectedPath = 'display-media';
        return hardenedDisplayStream;
      }
      stopWallpaperEngineMediaStream(displayStream);
      throw new Error('WALLPAPER_CAPTURE_STREAM_EMPTY');
    } catch (error) {
      displayError = error;
      recordAttempt('display-media', null, error);
    }
  }
  var displayName = String(displayError && displayError.name || 'Error');
  var displayMessage = String(displayError && displayError.message || displayError || 'display-media unavailable');
  var sourceMessage = String(sourceError && (sourceError.message || sourceError.name) || 'source-id-media unavailable');
  throw new Error('WALLPAPER_CAPTURE_FAILED: ' + displayName + ': ' + displayMessage + ' (source: ' + sourceMessage + ')');
}

