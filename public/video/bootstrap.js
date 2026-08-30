/*
 * Stellaflix 影视模块 — 引导 (Step 2)
 * 桥接钩子：DOM 就绪后初始化状态机并绑定分发层。不含任何影视业务逻辑。
 * 注意：浏览器兼容 global 已在 index.html <head> 顶部统一填充（bootstrap 之前）。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  function boot() {
    if (SFV.state) SFV.state.init();
    if (SFV.dispatch) SFV.dispatch.bind();
    // #22: Wallpaper Engine renderer is a classic global module loaded in <head>.
    // Its original self-invocation was removed (premature in <head>); init is deferred
    // to DOM-ready here so the static #wallpaper-engine-* DOM already exists.
    if (typeof initializeWallpaperEngineLibrary === 'function') initializeWallpaperEngineLibrary();

    // P0：启动偏好为影视态时，保证首屏进入「首页 tab」。
    // 背景：SFV_SCRIPTS 链中 online-nav/home 模块加载在 bootstrap.js 之后，
    // boot() 执行时 SFV.online / SFV.home 均未挂载，直接同步调用无效。
    // 方案：
    //  (A) 用微任务+长轮询等 online-nav / home 就绪（200×100ms = 20s 兜底，远慢
    //      于任何机器的 requestIdleCallback 脚本加载速度）。
    //  (B) 监听 splash 结束事件 'sfv:splash-dismissed'（04a-three-host.js 里
    //      dismissSplash() 派发），事件到后再触发一次 tryEnsureHome，保证用户
    //      点「进入」后立即有内容，而非等轮询节拍。
    //  (C) goHome() 会：关闭浏览层 → SFV.home.render() 重建首页卡片 → 顶栏导航
    //      高亮 active=home → applyVideoPageBg() 同步影视态背景 → 四者一步到位，
    //      避免启动影视态后出现「空页无内容、粒子也未同步 home 态」的视觉真空。
    if (SFV.state && typeof SFV.state.isVideo === 'function' && SFV.state.isVideo()) {
      var _attempts = 0;
      var _done = false;
      function tryEnsureHome() {
        if (_done) return;
        if (SFV.online && typeof SFV.online.goHome === 'function') {
          try { SFV.online.goHome(); }
          catch (e) { if (global.console) console.warn('[SFV-boot] goHome failed:', e); }
          _done = true;
          return;
        }
        if (++_attempts < 200) setTimeout(tryEnsureHome, 100);
        else if (global.console) console.warn('[SFV-boot] SFV.online.goHome 20s 内未就绪，跳过首屏 home 定位');
      }
      // (A)
      if (typeof Promise !== 'undefined') Promise.resolve().then(tryEnsureHome);
      else setTimeout(tryEnsureHome, 0);
      // (B) 挂一次 splash 结束回调；CAP 模式下 addEventListener 已被封装，此监听一定生效
      if (global.addEventListener) {
        global.addEventListener('sfv:splash-dismissed', function onSplashEnd() {
          global.removeEventListener('sfv:splash-dismissed', onSplashEnd);
          // splash-dismissed 发生在用户点击「进入」之后，此时脚本链很可能还在加载，
          // 故直接重启一轮等 goHome 就绪而不是只调用一次
          _attempts = 0; _done = false;
          setTimeout(tryEnsureHome, 300);
        });
      }
      // (C) 兜底：如果 home 先于 online 挂载（模块顺序变化时），直接渲染首页内容。
      // 不设 active=home——仍等 goHome 挂顶栏，至少保证首屏 DOM 不空。
      var _homeAttempts = 0;
      function tryEnsureHomeRenderOnly() {
        if (_done) return;  // goHome 已经成功触发，不用重复渲染
        if (SFV.home && typeof SFV.home.render === 'function') {
          try { SFV.home.render(); }
          catch (e) { if (global.console) console.warn('[SFV-boot] direct home.render failed:', e); }
          return;
        }
        if (++_homeAttempts < 150) setTimeout(tryEnsureHomeRenderOnly, 100);
      }
      setTimeout(tryEnsureHomeRenderOnly, 200);
    }
  }

  if (global.document && global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : this);
