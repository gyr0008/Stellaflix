/*
 * Stellaflix 影视模块 — 双态状态机 (Step 2)
 * 持有 spaceMode('music'|'video')，翻转 body.video-space-active，派发 spacechange。
 * 硬约束：逻辑独立成文件，不写入 index.html。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  var STORAGE_KEY = 'stellaflix-space-mode';
  var START_SPACE_KEY = 'stellaflix-start-space'; // 用户在设置面板中选择的「启动默认空间」
  var EVENT = 'spacechange';

  var spaceMode = 'music'; // 'music' | 'video'
  var initialized = false;
  var startSpacePreference = 'music'; // 'music' | 'video' — 与运行态解耦的启动偏好

  function getBody() {
    return global.document ? global.document.body : null;
  }

  function applyBodyClass() {
    var body = getBody();
    if (!body || !body.classList) return;
    var isVideo = spaceMode === 'video';
    body.classList.toggle('video-space-active', isVideo);
    /* T137：同步 html 元素 class（供影视态专用规则使用） */
    var root = document.documentElement;
    if (root) root.classList.toggle('video-space-active', isVideo);
  }

  function persist() {
    try {
      if (global.localStorage) global.localStorage.setItem(STORAGE_KEY, spaceMode);
    } catch (e) {
      /* 隐私模式 / 配额溢出时静默降级 */
    }
  }

  function emit() {
    var detail = { spaceMode: spaceMode };
    try {
      if (global.CustomEvent) {
        global.dispatchEvent(new global.CustomEvent(EVENT, { detail: detail }));
        return;
      }
    } catch (e) {
      /* fallthrough */
    }
    try {
      var ev = global.document.createEvent('Event');
      ev.initEvent(EVENT, false, false);
      ev.detail = detail;
      global.dispatchEvent(ev);
    } catch (e2) {
      /* 无法派发则忽略，调用方仍可通过 getSpace() 读最新态 */
    }
  }

  function setSpace(mode, opts) {
    opts = opts || {};
    if (mode !== 'music' && mode !== 'video') return;
    if (mode === spaceMode && initialized && !opts.force) return;
    // 诊断日志：追踪所有空间切换调用（铁律：只有影视/音乐空间按钮能切换）
    var stack = '';
    try { stack = (new Error()).stack || ''; } catch(e) {}
    console.log('[SFV-STATE] setSpace(' + mode + ') ← ' + spaceMode + ' | caller:\n' + stack.split('\n').slice(1,4).join('\n'));

    // ═══════════════════════════════════════════════════════════════
    // 切态前同步快照钩子：让外部模块（如 home.js）在 DOM 还没被改动之前拍状态快照
    // 特别是音乐态 → 影视态：需要在 renderVideoPoster() 覆盖 #home-poster-media 之前
    // 把音乐态左侧海报保存下来，供影视态「音乐空间」卡跨态连线使用。
    // 同样地：影视态 → 音乐态：需要在 restoreMusic() 覆盖之前把影视态海报快照保存下来。
    // 钩子约定：global.SFV.home._preCapturePosterSnapshot(fromSpace, toSpace)
    // ═══════════════════════════════════════════════════════════════
    try {
      var SFV = global.StellaflixVideo;
      if (SFV && SFV.home && typeof SFV.home._preCapturePosterSnapshot === 'function') {
        SFV.home._preCapturePosterSnapshot(spaceMode, mode);
      }
    } catch (e) {
      // 钩子异常不阻塞主流程
      console.warn('[SFV-STATE] _preCapturePosterSnapshot failed:', e);
    }

    spaceMode = mode;
    initialized = true;
    applyBodyClass();
    persist();
    if (!opts.silent) emit();
  }

  function toggle(opts) {
    setSpace(spaceMode === 'video' ? 'music' : 'video', opts);
  }

  function getSpace() {
    return spaceMode;
  }

  function isVideo() {
    return spaceMode === 'video';
  }

  function isMusic() {
    return spaceMode === 'music';
  }

  // 启动偏好：用户从设置面板「状态切换器」选择的默认进入空间。
  // 与运行态空间（stellaflix-space-mode）解耦：用户运行中切到另一个空间离开，下次仍按偏好启动。
  function readStartSpacePreference() {
    try {
      var raw = global.localStorage ? global.localStorage.getItem(START_SPACE_KEY) : null;
      if (raw === 'video' || raw === 'music') return raw;
    } catch (e) { /* 隐私模式静默降级 */ }
    return 'music';
  }

  function getStartSpace() {
    return startSpacePreference;
  }

  function setStartSpace(mode) {
    if (mode !== 'music' && mode !== 'video') return;
    startSpacePreference = mode;
    try {
      if (global.localStorage) global.localStorage.setItem(START_SPACE_KEY, mode);
    } catch (e) { /* 配额溢出静默降级 */ }
  }

  // 启动时按用户偏好进入对应空间；默认音乐态。
  // 重要：init 必须派发一次初始 spacechange 事件，让 04a 的 deferred-compile 监听器、
  //      applySfvClearColor、online-nav 等所有订阅者知道当前态。
  //      仅 applyBodyClass（只改 class）会让所有通过事件驱动的逻辑永远错过初始态，
  //      导致「启动影视态 deferredDone 卡住 → 画布不渲染粒子」这类死锁。
  function init() {
    if (initialized) return;
    initialized = true;
    startSpacePreference = readStartSpacePreference();
    spaceMode = startSpacePreference; // 按设置决定启动空间
    applyBodyClass();
    persist();
    try {
      emit(); // 初始态通知：所有 spacechange 订阅者得到当前真实 mode
    } catch (e) { /* 监听器异常不阻塞启动 */ }
  }

  SFV.state = {
    init: init,
    setSpace: setSpace,
    toggle: toggle,
    getSpace: getSpace,
    isVideo: isVideo,
    isMusic: isMusic,
    getStartSpace: getStartSpace,
    setStartSpace: setStartSpace,
    EVENT: EVENT,
    STORAGE_KEY: STORAGE_KEY,
    START_SPACE_KEY: START_SPACE_KEY,
  };
})(typeof window !== 'undefined' ? window : this);
