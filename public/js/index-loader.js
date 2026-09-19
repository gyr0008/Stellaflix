'use strict';

(function loadStellaflixIndexModules() {
  // ==== Fix (splash failsafe): 前序模块抛同步错误导致 splash.js 根本没执行时，
  // 用户会看到"卡在 Stellaflix logo"误以为崩溃。此处先注册一个 2.5s 兜底定时器，
  // 若 2.5s 后启动 logo 仍未被正常关闭 → 强制移除 splash div 露出主界面，
  // 并释放启动快速预加载门闩。保证即便模块链局部失败用户也能看到 UI。
  (function _splashStartupFailSafe() {
    try {
      setTimeout(function () {
        // 如果启动脚本已经正常跑完并写入完成标记 → 跳过 failsafe（splash 由正常的 splash.js 关闭）
        try { if (window.__stellaflixStartupFailSafeDone) return; } catch(e) {}
        var s = document.getElementById('splash');
        if (!s) return;
        if (s.classList.contains('hide') || s.style.display === 'none') return;
        try { console.warn('[Startup] Splash did not exit after 2.5s; force-dismissing (module load abort detected).'); } catch (e) {}
        try {
          if (typeof releaseStartupFastSkipPreload === 'function') {
            try { releaseStartupFastSkipPreload(); } catch (e) {}
          }
        } catch (e) {}
        try { s.classList.add('hide'); } catch (e) {}
        try { s.style.display = 'none'; } catch (e) {}
        try { document.body.classList.remove('splash-active'); } catch (e) {}
        try { document.body.classList.remove('splash-revealing'); } catch (e) {}
        try {
          if (typeof finishSplashReveal === 'function') {
            try { finishSplashReveal(false, { reason: 'splash-failsafe-load-abort' }); } catch (e) {}
          }
        } catch (e) {}
      }, 2500);
    } catch (e) {}
  })();

  const moduleCacheBust = String(Date.now());
  const modulePaths = [
    'js/modules/00-state/00-core-stores.js',
    'js/modules/00-state/01-perf-render-state.js',
    'js/modules/00-state/02-preferences-ui-modes.js',
    'js/modules/00-state/03-beat-dj-state.js',
    'js/modules/00-state/04-fx-defaults.js',
    'js/modules/00-state/05-packaged-fx-archive.js',
    'js/modules/00-state/06-fx-runtime-layout.js',
    'js/modules/00-state/07-ui-playback-runtime.js',
    'js/modules/00-state/08-desktop-render-power.js',
    'js/modules/00-state/09-performance-probe.js',
    'js/modules/00-state/10-frame-scheduler.js',
    'js/modules/00-state/11-system-memory-controls.js',
    'js/modules/01-scene/00-renderer-quality.js',
    'js/modules/01-scene/01-orbit-free-camera.js',
    'js/modules/01-scene/02-beat-camera-runtime.js',
    'js/modules/01-scene/03-focus-cinema-camera.js',
    'js/modules/01-scene/04-bottom-controls-cursor.js',
    'js/modules/02-visual/00-pointer-cover-particles.js',
    'js/modules/02-visual/01-float-skull-backcover.js',
    'js/modules/02-visual/02-lyrics-state-layout.js',
    'js/modules/02-visual/03-lyrics-star-river.js',
    'js/modules/02-visual/04-visual-settings-persistence.js',
    'js/modules/02-visual/05-lyrics-fonts-texture.js',
    'js/modules/02-visual/06-custom-background-colorlab.js',
    'js/modules/02-visual/07-lyrics-palette-text-utils.js',
    'js/modules/02-visual/08-lyrics-display-modes.js',
    'js/modules/02-visual/09-lyrics-payloads.js',
    'js/modules/02-visual/10-lyrics-mask-textures.js',
    'js/modules/02-visual/11-lyrics-shaders.js',
    'js/modules/02-visual/12-lyrics-row-layers.js',
    'js/modules/02-visual/13-lyrics-mesh-build.js',
    'js/modules/02-visual/14-stage-lyrics-rendering.js',
    'js/modules/02-visual/15-ripples-cover-depth.js',
    'js/modules/02-visual/16-hex-grid-viewport.js',
    'js/modules/02-visual/17-hex-card-transform.js',
    'sonic-topography-preset.js',
    'sonic-workshop-preset.js',
    'js/modules/03-beat/00-tempo-worker-cache-prefetch.js',
    'js/modules/03-beat/01-audio-beat-analysis.js',
    'js/modules/03-beat/02-podcast-dj-analysis.js',
    'js/modules/03-beat/03-local-beat-cache-modal.js',
    'js/modules/03-beat/04-beat-map-runtime.js',
    'js/modules/03-beat/05-cover-loading-crop.js',
    'js/modules/03-beat/06-sonic-audio-monitor.js',
    'js/modules/04-shelf/00-layout-hover.js',
    'js/modules/04-shelf/01-manager-core.js',
    'js/modules/04-shelf/02-rebuild-panel-sync.js',
    'js/modules/04-shelf/03-content-list-manager.js',
    'js/modules/04-shelf/04-cover-api-helpers.js',
    'js/modules/04-shelf/05-card-interactions.js',
    'js/modules/04-shelf/06-keyboard-camera-events.js',
    'js/modules/05-playback/00-api-quality-output.js',
    'js/modules/05-playback/01-cover-custom-map.js',
    'js/modules/05-playback/02-listen-stats.js',
    'js/modules/05-playback/03-home-discover-weather.js',
    'js/modules/05-playback/03b-local-playlist-store.js',
    'js/modules/05-playback/03c-local-online-match.js',
    'js/modules/05-playback/03a-home-dashboard.js',
    'js/modules/05-playback/04a-radio-modes.js',
    'js/modules/05-playback/04-home-empty-wallpaper.js',
    'js/modules/05-playback/05-home-actions.js',
    'js/modules/05-playback/06-track-detail-lyrics-actions.js',
    'js/modules/05-playback/07-search.js',
    'js/modules/05-playback/08-audio-graph-controls.js',
    'js/modules/05-playback/09-queue-snapshot-autoplay.js',
    'js/modules/05-playback/10-queue-actions.js',
    'js/modules/05-playback/11-provider-fallback.js',
    'js/modules/05-playback/12-playback-switch-core.js',
    'js/modules/05-playback/13-playback-start-audio.js',
    'js/modules/05-playback/14-custom-source-integration.js',
    'js/modules/05-playback/14-player-controls.js',
    'js/modules/05-playback/15-control-glass-animations.js',
    'js/modules/05-playback/16-cuefield-automix-core.js',
    'js/modules/05-playback/17-cuefield-timeline-executor.js',
    'js/modules/05-playback/18-cuefield-automix-integration.js',
    'js/modules/05-playback/19-outer-poster-bridge.js',
    'js/modules/06-lyrics/00-lyrics-fetch-parse.js',
    'js/modules/06-lyrics/01-playlist-panel-shell.js',
    'js/modules/06-lyrics/02-playlist-detail.js',
    'js/modules/06-lyrics/03-podcast-playlist-loaders.js',
    'js/modules/06-lyrics/07-subsonic-library.js',
    'js/modules/06-lyrics/04-progress-seek.js',
    'js/modules/06-lyrics/05-upload-dragdrop.js',
    'js/modules/06-lyrics/06-lyric-timing-offset.js',
    'js/modules/07-fx/00-preset-archive-data.js',
    'js/modules/07-fx/01-lyric-color-controls.js',
    'js/modules/07-fx/02-accent-background-controls.js',
    'js/modules/07-fx/03-wallpaper-engine-library.js',
    'js/modules/07-fx/03-cover-picker-fonts.js',
    'js/modules/07-fx/04-preset-grid-uniforms.js',
    'js/modules/07-fx/05-fx-panel-performance.js',
    'js/modules/07-fx/06-hotkeys.js',
    'js/modules/07-fx/07-bindings-shelf-immersive.js',
    'js/modules/07-fx/08-cache-storage-settings.js',
    'js/modules/07-fx/09-console-workspace.js',
    'js/modules/08-account/00-update-preview.js',
    'js/modules/08-account/01-login-modal-utils.js',
    'js/modules/08-account/02-login-status.js',
    'js/modules/08-account/03-login-modal-flows.js',
    'js/modules/08-account/04-user-modal-logout.js',
    'js/modules/08-account/05-startup-login-guide.js',
    'js/modules/08-account/06-usage-tracker.js',
    'js/modules/09-idle-toast-libraries.js',
    'js/modules/10-shell/00-gesture-control.js',
    'js/modules/10-shell/01-viewport-resize-shortcuts.js',
    'js/modules/10-shell/02-peek-panels-upload.js',
    'js/modules/10-shell/03-splash.js',
    'js/modules/10-shell/04-desktop-overlay-fullscreen.js',
    'js/modules/10-shell/05-startup-bindings.js',
    'js/modules/11-main-loop.js',
    // 必须放在最后：显式把「被 HTML 内联 handler 调用、但因 async 声明不随 Annex B.3.3
    // 泄漏」的函数挂到 window。详见该文件头部注释。
    'js/modules/12-expose-inline-globals.js',
  ];

  function readModule(path) {
    const request = new XMLHttpRequest();
    request.open('GET', path + (path.indexOf('?') >= 0 ? '&' : '?') + 'v=' + moduleCacheBust, false);
    request.send(null);

    if ((request.status < 200 || request.status >= 300) && request.status !== 0) {
      throw new Error('Failed to load Stellaflix module: ' + path + ' (' + request.status + ')');
    }

    return request.responseText;
  }

  // ==== Fix (final architecture): 全局裸 try/catch + 模块纯拼接（零 IIFE 包裹、零 per-module try/catch）。
  // 上一版在外面套了一层 `(function __stellaflixStartupRunner__(){})()` IIFE，把 100+ 处
  // `function goHome / var fx / shelfManager` 全部封在了 IIFE 函数作用域里，永远不会挂到
  // window 全局 → 结果：
  //   ① HTML 模板 <button onclick="goHome()"> 只能从 window 查 → ReferenceError: goHome not defined
  //   ② 外置独立脚本 home.js / online-shared.js / online-nav.js 也读不到共享变量
  //      (fx, posterStore, immersiveMode 等) → 首页卡片 / 专辑信息全部"有日志但不渲染"
  // 当前结构下，所有 `var` / `function` 都在 <script> 顶层作用域声明：
  //   → sloppy mode Annex B.3 语义保证 function 声明会挂到 window 全局
  //   → var 声明会成为 script-global，可被 home.js/online-xxx.js 访问
  //   → try/catch 仍在最外层包裹：单模块 sync 异常统一 catch + 记录 [Startup FATAL]
  //   → try 块末尾写 `__stellaflixStartupFailSafeDone = true`：正常启动成功时 splash
  //     failsafe 定时器看到标记就跳过，不再 2.5s 必强退 logo
  var modulesSource;
  try {
    modulesSource = modulePaths.map(readModule).join('\n');
  } catch (readErr) {
    modulesSource = 'throw new Error("Module read failed: ' + String(readErr && readErr.message ? readErr.message : readErr) + '");\n';
  }
  const script = document.createElement('script');
  script.text =
    'try {\n' +
    '  ' + modulesSource.replace(/\n/g, '\n  ') + '\n' +
    '  // ==== Startup completed normally: signal splash failsafe to skip 2.5s force-dismiss. ====\n' +
    '  try { __stellaflixStartupFailSafeDone = true; } catch(e){}\n' +
    '} catch (__stellaflixStartupErr__) {\n' +
    '  try { console.error(\'[Startup FATAL] Startup script threw sync error:\', __stellaflixStartupErr__); } catch(e){}\n' +
    '  try { if (typeof __stellaflixStartupErr__ === \'object\' && __stellaflixStartupErr__ &&\n' +
    '         typeof __stellaflixStartupErr__.stack === \'string\')\n' +
    '         console.error(__stellaflixStartupErr__.stack); } catch(e){}\n' +
    '  try { window.__stellaflixStartupFailed = true; } catch(e){}\n' +
    '  // Even on fatal failure, signal the splash guard so the failsafe timer below knows we DID finish executing\n' +
    '  // (the real failure will be surfaced via console.error above; the user still gets the UI exposed after 2.5s).\n' +
    '  try { __stellaflixStartupFailSafeDone = true; } catch(e){}\n' +
    '}\n' +
    '\n//# sourceURL=stellaflix-index-modules.js\n';
  document.currentScript.parentNode.insertBefore(script, document.currentScript.nextSibling);
})();
