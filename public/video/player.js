/*
 * Stellaflix 影视模块 — 视频播放器 (Step 3, 方案 B 全屏弹层)
 *
 * 设计：独立覆盖层承载 <video>，不触碰 Three.js 内部。S4 共存由 player.css 的
 *   body.video-space-active #canvas-container{transition:none!important} + 覆盖层
 *   极高 z-index 保证「粒子视觉让位」；另派发非侵入式 `sfv:render-pause` 钩子
 *   (detail.paused)，供 Three.js 层后续按需暂停渲染以降低 GPU 占用——本文件不修改 Three.js。
 *
 * 约束：单文件 <= 500 行；任何影视逻辑不写进 index.html；仅向 window.StellaflixVideo.player
 *       注册 API，供 Step 4 切换入口与本地媒体库调用。
 *
 * 范围：核心播放器 + 与 source-adapter 协同处理 HLS。HLS(.m3u8) 由 source-adapter
 *       动态加载 hls.js 并经自定义代理 loader 接入（跨域分片统一走 /api/proxy）。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  // T-#6-序6：零依赖纯层（fmt / extractEpisode / normalizeAnimeName）
  // 已抽到 player-core.js，须先于本文件加载
  var PC = SFV.playerCore;
  if (!PC) { throw new Error('[SFV player] playerCore 未加载，请检查 index.html 加载顺序'); }
  var fmt = PC.fmt, extractEpisode = PC.extractEpisode, normalizeAnimeName = PC.normalizeAnimeName;

  var SETTINGS_KEY = 'stellaflix-video-settings';
  var SPEED_STEPS = [0.5, 1, 1.25, 1.5, 2];

  var overlay = null, videoEl = null, controls = null, fileInput = null;
  var playBtn = null, speedBtn = null, qualityBtn = null, fillEl = null, timeEl = null;
  var currentId = null, currentUrl = null;
  var embedFrame = null, embedCloseBtn = null; // 第三方解析器 iframe 嵌入态
  var playNextFn = null, modeBtn = null;            // 连播：下一集回调 / 模式按钮
  var _loadingToastCleared = false;             // 播放初始化 loading toast 是否已成功关闭
  var hideTimer = null, lastSpeedIdx = 1, lastSaveAt = 0;
  // 起播会话序号：每次起播(open*)/退出(close)递增。用于让在途的异步挂载（HLS/FLV 经
  // hls.js/flv.js 异步加载库与分片）在"用户退出或换片"后失效，避免在后台继续起播（有声无画）。
  var playbackSeq = 0;
  // 控制栏静止盒缓存：仅在非 idle（可见且未偏移）时测量，用于悬停命中测试，
  // 避免 idle 态 translateY(88px)/scale 位移导致命中区与可见控制栏错位。
  var barHitRect = null;
  var danmakuLayer = null, danmakuEngine = null;
  var currentMeta = null;            // 当前播放元信息（标题/副标题/封面/id/embed 标志）
  var _posterCachedKey = null;       // 已触发自动海报缓存的进度键（同 key 仅缓存一次，省流量）
  var _watchKey = null;              // 当前累计观看时长的进度键（切集重置）
  var _watchedSeconds = 0;           // 累计实际播放时长（秒），暂停不计、拖拽不计
  var _lastTickTs = 0;               // 上次 timeupdate 时间戳（用于累加真实播放时长）
  var _isPlaying = false;            // 是否处于播放状态（play/pause 跟踪）
  var playlistTracks = null;         // 剧集列表（online.js 注入，用于 prev/next 导航）
  var playlistIndex = -1;            // 当前集在 playlistTracks 中的索引
  var playEpisodeAtFn = null;        // 实际起播某一集回调（online.js 注册，需走源解析）
  var roads = null;                  // 全部线路 [{from, episodes}]（阶段3 线路切换）
  var roadFromIndex = -1;            // 当前线路下标
  var roadSwitchFn = null;           // 线路切换回调（编排器续播用，需走源解析）

  function getDoc() { return global.document; }

  function getSettings() {
    try {
      var raw = global.localStorage.getItem(SETTINGS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }
  function setSetting(k, v) {
    var s = getSettings(); s[k] = v;
    try { global.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
  }

  // ---- 播放模式（③ 连播）----
  // sequence   : 播完自动下一集（无下一集则停）
  // repeat-one : 单集循环
  // off        : 播完即停
  var MODE_ORDER = ['sequence', 'repeat-one', 'off'];
  var MODE_LABEL = { 'sequence': '连播', 'repeat-one': '单集循环', 'off': '不连播' };

  function getPlayMode() {
    var m = getSettings().playMode;
    return MODE_LABEL[m] ? m : 'sequence'; // 默认连播；非法值回落
  }
  function setPlayMode(m) {
    if (!MODE_LABEL[m]) m = 'sequence';
    setSetting('playMode', m);
    if (modeBtn) modeBtn.textContent = MODE_LABEL[m];
    return m;
  }
  function cyclePlayMode() {
    var i = MODE_ORDER.indexOf(getPlayMode());
    return setPlayMode(MODE_ORDER[(i + 1) % MODE_ORDER.length]);
  }

  /**
   * 注册「下一集」回调。由 online.js 在成功起播某一集之后调用（必须在 open 之后，
   * 因为 prepareForPlay / openFile / openEmbed 会主动清空，确保不会跨片残留）。
   * 传 null / 非函数即注销。
   */
  function setPlayNext(fn) { playNextFn = (typeof fn === 'function') ? fn : null; }
  function hasPlayNext() { return !!playNextFn; }

  function onMediaEnded() {
    saveProgress();
    // 播放结束强制标记为观看完成
    try {
      if (SFV.watchHistory && SFV.watchHistory.update && currentId) {
        SFV.watchHistory.update(currentId, { finished: true, ts: Date.now() });
      }
    } catch (e) { /* 非致命 */ }
    var mode = getPlayMode();
    if (mode === 'repeat-one') {
      try { videoEl.currentTime = 0; } catch (e) {}
      var p0 = videoEl.play();
      if (p0 && p0.catch) p0.catch(function () {});
      return;
    }
    if (mode !== 'sequence' || !playNextFn) return;
    var fn = playNextFn;
    playNextFn = null; // 先摘钩再调用，避免异常导致重复触发
    try { fn(); } catch (e) {
      if (global.console) global.console.warn('[SFV player] 连播下一集失败:', e && e.message);
    }
  }

  // 非侵入式 GPU 让位钩子：不修改 Three.js，仅广播意图。
  function emitRenderPause(paused) {
    if (global.CustomEvent && global.dispatchEvent) {
      try {
        global.dispatchEvent(new global.CustomEvent('sfv:render-pause', { detail: { paused: !!paused } }));
      } catch (e) { /* 无监听方则忽略 */ }
    }
  }

  // 播放器事件广播：供 player-controller.js 桥接底部控制器
  function emitPlayerEvent(name, detail) {
    if (global.CustomEvent && global.dispatchEvent) {
      try {
        global.dispatchEvent(new global.CustomEvent(name, { detail: detail || {} }));
      } catch (e) { /* 无监听方则忽略 */ }
    }
  }

  function ensureOverlay() {
    if (overlay) return overlay;
    var d = getDoc();

    overlay = d.createElement('div');
    overlay.id = 'sfv-overlay';
    overlay.className = 'sfv-overlay';

    videoEl = d.createElement('video');
    videoEl.className = 'sfv-video';
    videoEl.playsInline = true;
    videoEl.setAttribute('playsinline', '');
    videoEl.setAttribute('webkit-playsinline', '');
    // 显式禁用浏览器默认控制条，由自定义控制器（#bottom-bar / #sfv-controls）接管
    videoEl.controls = false;
    videoEl.removeAttribute('controls');
    // 默认静音：Chrome 自动播放策略要求未静音视频必须有用户手势才能 play()。
    // HLS 加载链路是异步的（加载 hls.js → 拉取 m3u8 → 解析清单），到 MANIFEST_PARSED 时
    // 早已脱离手势上下文，play() 会被浏览器拦截导致黑屏（有时长无画面）。
    // 默认 muted 保证 autoplay 始终合法；用户可通过音量控制或首次点击取消静音。
    videoEl.muted = true;
    videoEl.setAttribute('muted', '');

    controls = d.createElement('div');
    controls.id = 'sfv-controls';

    var progress = d.createElement('div');
    progress.className = 'sfv-progress';
    fillEl = d.createElement('div');
    fillEl.className = 'sfv-progress-fill';
    progress.appendChild(fillEl);
    progress.addEventListener('click', function (ev) {
      var rect = progress.getBoundingClientRect ? progress.getBoundingClientRect() : { width: 1, left: 0 };
      var x = (ev && typeof ev.offsetX === 'number') ? ev.offsetX : 0;
      var ratio = rect.width ? (x - (rect.left || 0)) / rect.width : 0;
      seek(ratio);
    });

    timeEl = d.createElement('div');
    timeEl.className = 'sfv-time';
    timeEl.textContent = '0:00 / 0:00';

    playBtn = mkBtn('sfv-btn-play', '▶', togglePlay);
    speedBtn = mkBtn('sfv-btn-speed', '1x', cycleSpeed);
    qualityBtn = mkBtn('sfv-btn-quality', '画质', function () { /* TODO: 画质切换占位，待接入真实清晰度选择 */ });
    var btnFs = mkBtn('sfv-btn-fs', '⛶', toggleFullscreen);
    var btnClose = mkBtn('sfv-btn-close', '✕', close);

    controls.appendChild(playBtn);
    controls.appendChild(progress);
    controls.appendChild(timeEl);
    controls.appendChild(speedBtn);
    controls.appendChild(qualityBtn);
    var btnDanmaku = mkBtn('sfv-btn-danmaku', '弹幕', function () {
      if (SFV.danmaku && SFV.danmaku.ui && SFV.danmaku.ui.openPanel) SFV.danmaku.ui.openPanel();
    });
    controls.appendChild(btnDanmaku);
    modeBtn = mkBtn('sfv-btn-mode', MODE_LABEL[getPlayMode()], cyclePlayMode);
    controls.appendChild(modeBtn);
    controls.appendChild(btnFs);
    controls.appendChild(btnClose);

    overlay.appendChild(videoEl);

    // 弹幕覆盖层：覆盖整个播放区，穿透点击（pointer-events:none），置于视频之上、控制条之下
    danmakuLayer = d.createElement('div');
    danmakuLayer.id = 'sfv-danmaku-layer';
    danmakuLayer.className = 'sfv-danmaku-layer';
    overlay.appendChild(danmakuLayer);
    if (SFV.danmaku && SFV.danmaku.engine) {
      try {
        danmakuEngine = new SFV.danmaku.engine.DanmakuEngine();
        danmakuEngine.mount(danmakuLayer);
      } catch (e) { danmakuEngine = null; }
    }
    // 注入已保存的弹幕凭证/选项（如 ui.js 已加载）
    if (SFV.danmaku && SFV.danmaku.ui && SFV.danmaku.ui.init) {
      try { SFV.danmaku.ui.init(); } catch (e) {}
    }

    overlay.appendChild(controls);

    // 隐藏的文件选择器，供 openFilePicker 调起
    fileInput = d.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'video/*';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files[0]) openFile(fileInput.files[0]);
    });

    d.body.appendChild(overlay);
    d.body.appendChild(fileInput);

    wireVideoEvents();
    wireIdle();
    wireUnmuteOnInteraction();
    return overlay;
  }

  function mkBtn(cls, label, onClick) {
    var b = getDoc().createElement('button');
    b.className = 'sfv-btn ' + cls;
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  // 观看累计实际播放时长 ≥ 3 分钟（180s）自动把 TMDB 海报缓存到本地，
  // 缓存成功后回写 history.pic，减少「接着看」等场景再次请求 TMDB 的耗时/失败。
  // 语义：仅播放状态累加（pause 不计），拖拽跳变不计入。同 key 仅触发一次（poster-cache 已命中则直接返回）。
  function checkPosterAutoCache() {
    var km = currentMeta && currentMeta.key;
    var pm = currentMeta && (currentMeta.cover || currentMeta.pic) || '';
    if (_posterCachedKey !== km && _watchedSeconds >= 180 && km && pm && pm.indexOf('data:') !== 0 &&
        SFV.posterCache && typeof SFV.posterCache.cache === 'function') {
      SFV.posterCache.cache(km, pm).then(function (dataUrl) {
        if (dataUrl && dataUrl !== pm) {
          _posterCachedKey = km; // 仅成功才标记去重，失败下次重试
          if (SFV.model && typeof SFV.model.updateHistoryPic === 'function') {
            SFV.model.updateHistoryPic(km, dataUrl);
          }
        }
      });
    }
  }

  // 切集（key 变化）重置累计观看计时与去重标记
  function resetWatchTracker(key) {
    if (_watchKey !== key) {
      _watchKey = key;
      _watchedSeconds = 0;
      _posterCachedKey = null;
    }
  }

  function _closeLoadingToast(msg) {
    if (_loadingToastCleared) return;
    _loadingToastCleared = true;
    try {
      if (typeof toast === 'function') toast(msg || '加载完成');
      else if (SFV.online && typeof SFV.online.toast === 'function') SFV.online.toast(msg || '加载完成');
    } catch (e) {}
  }
  function wireVideoEvents() {
    videoEl.addEventListener('loadedmetadata', updateTime);
    // ==== Fix: loadeddata（首帧解码完成）立即替换 loading toast，
    // 解决 detail-source.js / play-orchestrator 非 Kazumi 路径下 loading toast 永久不消失的问题。
    videoEl.addEventListener('loadeddata', function () {
      _closeLoadingToast('影片加载完成');
      if (global.console) global.console.log('[SFV player] loadeddata, first frame decoded OK for', currentId);
    });
    videoEl.addEventListener('timeupdate', function () {
      updateTime();
      var now = Date.now();
      if (now - lastSaveAt > 4000) { lastSaveAt = now; saveProgress(); }
      // 播放状态才累加实际观看时长；拖拽时 currentTime 跳变但时间差极小，不虚增
      if (_isPlaying) {
        _watchedSeconds += (now - _lastTickTs) / 1000;
        _lastTickTs = now;
      }
      checkPosterAutoCache();
      if (danmakuEngine) danmakuEngine.update(videoEl.currentTime);
      // ==== Fix: loading toast 兜底关闭（loadeddata 没命中时的保险）。
      // 某些 MSE/HLS 流在 metadata 阶段无法触发 loadeddata（仅音频轨道时、加密流时），
      // 只要 currentTime 正常推进 >4 秒就视为播放成功，强制清理 loading 状态。
      if (!_loadingToastCleared && videoEl && videoEl.currentTime > 4) {
        _closeLoadingToast('播放开始');
      }
    });
    videoEl.addEventListener('seeked', function () {
      if (danmakuEngine) danmakuEngine.update(videoEl.currentTime);
    });
    videoEl.addEventListener('play', function () {
      setPlayIcon(true);
      resetWatchTracker(currentMeta && currentMeta.key);
      _isPlaying = true;
      _lastTickTs = Date.now();
    });
    videoEl.addEventListener('pause', function () {
      setPlayIcon(false);
      if (_isPlaying) {
        _watchedSeconds += (Date.now() - _lastTickTs) / 1000;
        _isPlaying = false;
      }
      saveProgress();
      checkPosterAutoCache();
    });
    videoEl.addEventListener('ended', onMediaEnded);
    // ==== Fix: MediaError 监听器原来只 console.warn，用户完全不知道哪里错了。
    // 现在把 MediaError.code 翻译成中文并 toast 提示，方便定位通道问题（防盗链403、SSRF拦截、编码不支持等）。
    videoEl.addEventListener('error', function () {
      var code = (videoEl && videoEl.error && videoEl.error.code) || 0;
      var msg = (videoEl && videoEl.error && videoEl.error.message) || '';
      var label = ({
        1: 'MEDIA_ERR_ABORTED：视频加载被用户中止',
        2: 'MEDIA_ERR_NETWORK：网络错误（可能是 CDN 防盗链 403 / 代理拒绝 / 私网 SSRF 拦截）',
        3: 'MEDIA_ERR_DECODE：视频解码失败（编码不支持 / 分片损坏 / 首帧加密）',
        4: 'MEDIA_ERR_SRC_NOT_SUPPORTED：视频格式或源地址不受支持（m3u8 原生不支持、协议不匹配）',
      })[code] || ('未知错误 code=' + code);
      if (global.console) global.console.warn('[SFV player] media error for', currentId, label, msg);
      _closeLoadingToast(''); // 先去掉 loading 状态，避免错误 toast 被秒替换
      try {
        var errToast = '视频播放失败：' + label + (msg ? '（' + String(msg).slice(0, 100) + '）' : '');
        if (typeof toast === 'function') toast(errToast);
        else if (SFV.online && typeof SFV.online.toast === 'function') SFV.online.toast(errToast);
      } catch (e) {}
      try {
        // 把失败的 URL 暴露到控制台，方便 DevTools 直接查看复现
        if (currentUrl) global.__sfv_failed_url = currentUrl;
      } catch (ex) {}
    });
  }

  // 首次用户交互时取消静音（Chrome 自动播放策略兼容）。
  // 仅触发一次：用户首次点击/触摸播放区域后即恢复声音，之后不再干预。
  function wireUnmuteOnInteraction() {
    if (!videoEl || !overlay) return;
    function unmuteOnce() {
      if (videoEl && videoEl.muted) {
        videoEl.muted = false;
        videoEl.removeAttribute('muted');
      }
      overlay.removeEventListener('click', unmuteOnce);
      overlay.removeEventListener('touchstart', unmuteOnce);
      if (videoEl) { videoEl.removeEventListener('click', unmuteOnce); videoEl.removeEventListener('touchstart', unmuteOnce); }
    }
    overlay.addEventListener('click', unmuteOnce);
    overlay.addEventListener('touchstart', unmuteOnce);
    videoEl.addEventListener('click', unmuteOnce);
    videoEl.addEventListener('touchstart', unmuteOnce);
  }

  // 判定指针是否应触发控制栏显示 / 续接隐藏计时。
  //   - 非 idle：命中盒用最近一次测量的静止盒 barHitRect，并与当前 live rect 取并集（覆盖 resize 后的瞬时错位）。
  //   - idle：控制栏已 translateY(88px)，继续用旧静止盒会造成「悬停真实控制栏永远不命中」的死锁，
  //     故退化为"屏幕底部 120px 高的唤醒带 ∪ 控制栏当前 live rect"，保证鼠标靠到底部即点亮控制栏。
  function pointInBar(x, y) {
    var bar = getDoc().getElementById('bottom-bar');
    var body = getDoc().body;
    if (!bar) { barHitRect = null; return false; }
    var isIdle = !!(body && body.classList.contains('video-player-idle'));
    // 非 idle 时刷新静止盒，保证命中区与可见控制栏重合
    if (!isIdle) {
      barHitRect = bar.getBoundingClientRect();
    }
    var r = barHitRect;
    // 取 live rect 参与并集：解决首次命中前/resize 后缓存为空造成的永久不显示
    var live = bar.getBoundingClientRect();
    function inRect(rect) {
      if (!rect) return false;
      // 命中区四周各扩 18px，抵消手指粗 / 变换后的边界误差
      return x >= rect.left - 18 && x <= rect.right + 18 &&
             y >= rect.top - 18 && y <= rect.bottom + 18;
    }
    if (inRect(r)) return true;
    if (r !== live && inRect(live)) return true;
    if (isIdle) {
      var h = global.innerHeight || 0;
      if (h && y >= h - 120) return true; // 屏幕底部唤醒带
    }
    return false;
  }

  // 控制条自动隐藏总开关（与 #controls-hide-btn / 04-bottom-controls-cursor 同一全局偏好）
  // 默认 false：三横线未高亮 = 控制条常驻（与 07-ui-playback-runtime 初始值一致）
  function isControlsAutoHideOn() {
    return typeof controlsAutoHide === 'undefined' ? false : !!controlsAutoHide;
  }
  function forceControlsVisible() {
    clearTimeout(hideTimer);
    hideTimer = null;
    if (overlay) overlay.classList.remove('sfv-idle');
    var b = getDoc().body;
    if (b) b.classList.remove('video-player-idle');
  }
  function armHideTimer(delayMs) {
    // 自动隐藏关闭：控制条常驻，不得进入 idle
    if (!isControlsAutoHideOn()) {
      forceControlsVisible();
      return;
    }
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      if (!isControlsAutoHideOn()) return;
      if (overlay && SFV.state && SFV.state.getSpace() === 'video') {
        overlay.classList.add('sfv-idle');
        var bb = getDoc().body;
        if (bb && bb.classList.contains('video-player-active')) bb.classList.add('video-player-idle');
      }
    }, typeof delayMs === 'number' ? delayMs : 3000);
  }

  function wireIdle() {
    var onMove = function (e) {
      if (!overlay) return;
      var x = e.clientX, y = e.clientY;
      if (e.touches && e.touches[0]) { x = e.touches[0].clientX; y = e.touches[0].clientY; }
      // =====【修复2026-09-06 17:38】控制条显示改为命中制 =====
      // 原逻辑：任意 pointermove 都 preemptive 解除 idle + 续 timer（"主流播放器"任意点亮）。
      // 新需求：仅当鼠标命中控制栏 live rect 或 idle 时的底部 120px 唤醒带，才解除 idle + 续 3s 隐藏计时；
      //         非控制栏区的移动不再 preemptive 点亮，避免用户在看视频时随便动鼠标就被控制条打扰。
      // 注意：pointInBar 在 idle 分支已退化到「屏幕底部 120px 唤醒带 ∪ live rect」，
      // 故不再需要「任意移动都先点亮」的兜底；该兜底只用于解决历史 idle 命中盒错位，已不再相关。
      var near = pointInBar(x, y);
      if (!near) {
        // 自动隐藏关闭：即使指针离开控制栏也保持常驻（防残留 idle）
        if (!isControlsAutoHideOn()) {
          forceControlsVisible();
        }
        // 自动隐藏开启：非命中区不动 idle（已是 idle → 继续；已是 visible → 保持到 arm 到期）
        return;
      }
      overlay.classList.remove('sfv-idle');
      var b = getDoc().body;
      if (b && b.classList.contains('video-player-idle')) b.classList.remove('video-player-idle');
      // 命中控制栏或底部唤醒带：自动隐藏开启时续接 3s 计时；关闭时仅保持显示
      armHideTimer(3000);
      // ===== 修复结束 =====
    };
    // 监听挂到 document：控制栏是 body 直接子元素（非 overlay 后代），
    // 悬停到控制栏上时 mousemove 不会冒泡到 overlay，故必须在 document 捕获。
    getDoc().addEventListener('mousemove', onMove);
    getDoc().addEventListener('touchstart', onMove, { passive: true });
    getDoc().addEventListener('resize', function () { barHitRect = null; });
  }

  function setPlayIcon(playing) {
    if (playBtn) playBtn.textContent = playing ? '⏸' : '▶';
  }

  function updateTime() {
    if (!timeEl || !videoEl) return;
    var c = Math.floor(videoEl.currentTime || 0);
    var d = Math.floor(videoEl.duration || 0);
    timeEl.textContent = fmt(c) + ' / ' + fmt(d);
    // 进度条比例必须用未取整的浮点时间：取整会把 4Hz 的 timeupdate 量化成 1Hz，
    // 进度条每秒才跳一格（肉眼可见的"一跳一跳"）；浮点比例 + CSS transition
    // （player.css .sfv-progress-fill）才能把相邻两次更新插值成平滑滑动。
    var ct = videoEl.currentTime || 0;
    var dur = videoEl.duration || 0;
    var ratio = (dur > 0 && isFinite(dur)) ? (ct / dur) : 0;
    if (fillEl) fillEl.style.width = (ratio * 100) + '%';
  }

  // T-#6-序6：fmt 已抽到 player-core.js（PC.fmt），此处仅保留别名引用

  // ---- 元信息 / 剧集导航（供 player-controller.js 桥接底部控制器）----
  function setCurrentMeta(m) {
    currentMeta = m || { id: currentId, embed: false };
    if (playlistTracks) {
      currentMeta.hasPrev = playlistIndex > 0;
      currentMeta.hasNext = playlistIndex < playlistTracks.length - 1;
    }
    return currentMeta;
  }
  function setMeta(m) {
    if (!m) return currentMeta;
    currentMeta = currentMeta || {};
    for (var k in m) { if (Object.prototype.hasOwnProperty.call(m, k)) currentMeta[k] = m[k]; }
    if (playlistTracks) {
      currentMeta.hasPrev = playlistIndex > 0;
      currentMeta.hasNext = playlistIndex < playlistTracks.length - 1;
    }
    emitPlayerEvent('sfv:player-meta', currentMeta);
    return currentMeta;
  }
  function getMeta() { return currentMeta; }
  function getSpeed() {
    if (videoEl && videoEl.playbackRate) return videoEl.playbackRate;
    return SPEED_STEPS[lastSpeedIdx] || 1;
  }
  function setVolume(v) {
    if (!videoEl) return;
    v = Math.max(0, Math.min(1, parseFloat(v) || 0));
    videoEl.volume = v;
    videoEl.muted = (v === 0);
  }
  function getVolume() { return videoEl ? (videoEl.volume || 0) : 0; }
  function setPlaylist(tracks, index) {
    playlistTracks = (tracks && tracks.length) ? tracks : null;
    playlistIndex = playlistTracks ? (index | 0) : -1;
    if (currentMeta) setCurrentMeta(currentMeta);
    emitPlayerEvent('sfv:player-meta', currentMeta);
  }
  function setPlayEpisodeAt(fn) { playEpisodeAtFn = (typeof fn === 'function') ? fn : null; }
  function playEpisodeAt(i) {
    if (!playlistTracks || i < 0 || i >= playlistTracks.length) {
      console.warn('[SFV player] playEpisodeAt 无效索引', i, playlistTracks && playlistTracks.length);
      if (SFV.online && SFV.online.toast) SFV.online.toast('该集不可用');
      return false;
    }
    if (typeof playEpisodeAtFn !== 'function') {
      console.warn('[SFV player] playEpisodeAtFn 未注册（embed 起播或列表未注入）');
      if (SFV.online && SFV.online.toast) SFV.online.toast('当前无法切换剧集');
      return false;
    }
    var target = playlistTracks[i];
    if (!target || !target.url) {
      if (SFV.online && SFV.online.toast) SFV.online.toast('该集无播放地址');
      return false;
    }
    // 先不要急着改 playlistIndex：异步起播失败时高亮会指错集。
    // 真正起播成功后由 doPlay 的 setPlaylist(play.episodes, ep.index) 回写。
    try {
      var ok = playEpisodeAtFn(i, target);
      // 回调同步抛错才算失败；异步失败由编排器 toast
      if (ok === false) {
        if (SFV.online && SFV.online.toast) SFV.online.toast('切换剧集失败');
        return false;
      }
      return true;
    } catch (e) {
      console.error('[SFV player] playEpisodeAt 回调异常', e);
      if (SFV.online && SFV.online.toast) SFV.online.toast('切换剧集失败');
      return false;
    }
  }
  function playPrevEpisode() { return playEpisodeAt(playlistIndex - 1); }
  function playNextEpisode() { return playEpisodeAt(playlistIndex + 1); }
  function hasPrevEpisode() { return !!(playlistTracks && playlistIndex > 0); }
  function hasNextEpisode() { return !!(playlistTracks && playlistIndex < playlistTracks.length - 1); }

  // ---- 阶段3：线路(Road)切换（全部线路注入 + 当前线路 + 切换回调）----
  function setRoads(plays, fromIndex, onSwitchRoad) {
    roads = (plays && plays.length) ? plays : null;
    roadFromIndex = roads ? (fromIndex | 0) : -1;
    roadSwitchFn = (typeof onSwitchRoad === 'function') ? onSwitchRoad : null;
  }
  function getRoads() { return roads; }
  function switchRoad(toIndex, episodeIndex) {
    if (!roads || toIndex < 0 || toIndex >= roads.length) return false;
    if (!roadSwitchFn) return false;
    roadFromIndex = toIndex;
    try { roadSwitchFn(toIndex, (episodeIndex | 0)); return true; } catch (e) { return false; }
  }
  function getRoadFromIndex() { return roadFromIndex; }

  function openFile(file) {
    if (!file) return false;
    playbackSeq++; // 新会话：使任何在途异步挂载失效
    ensureOverlay();
    clearEmbed();
    playNextFn = null;
    var id = 'file:' + (file.path || file.name || ('blob-' + Date.now()));
    currentId = id;
    var url = null;
    if (typeof URL !== 'undefined' && URL.createObjectURL &&
        (typeof Blob !== 'undefined' && file instanceof Blob) || (typeof File !== 'undefined' && file instanceof File)) {
      url = URL.createObjectURL(file);
    } else {
      url = file.path || file.name || '';
    }
    if (!url) return false;
    currentUrl = url;
    videoEl.src = url;
    restoreProgress();
    var sp = getSettings().speed;
    if (sp) videoEl.playbackRate = sp;
    SFV.model.addToLibrary({ id: id, title: (file.name || id), source: 'local' });
    SFV.state.setSpace('video');
    overlay.classList.add('sfv-show');
    emitRenderPause(true);
    setCurrentMeta({ id: id, seriesKey: id, title: (file.name || id), embed: false });
    emitPlayerEvent('sfv:player-open', currentMeta);
    var p = videoEl.play();
    if (p && p.catch) p.catch(function () {});
    return true;
  }

  // ---- 弹幕自动加载（对齐 Kazumi：播片时根据标题自动搜弹幕）----

  var AUTO_LOAD_KEY = 'stellaflix-danmaku-auto-load';  // localStorage 开关

  // T-#6-序6：extractEpisode 已抽到 player-core.js（PC.extractEpisode），此处仅保留别名引用

  // 番名归一化：去除集数标记与分辨率/编码后缀，仅用于弹弹play 搜索关键词，
  // 提升「脏标题（如 进击的巨人.03.BDRip）」的番剧匹配率。集数已由 extractEpisode 单独提取。
  // T-#6-序6：normalizeAnimeName 已抽到 player-core.js（PC.normalizeAnimeName），此处仅保留别名引用

  // 自动加载弹幕（异步、非阻塞，失败静默但有 toast 提示）
  function autoLoadDanmaku(title) {
    console.log('[Danmaku] autoLoadDanmaku 入口', { title: title, hasEngine: !!danmakuEngine, hasPlayer: !!(SFV.player && SFV.player.danmaku), hasLoadFromClient: !!(SFV.player && SFV.player.danmaku && SFV.player.danmaku.loadFromClient) });
    if (!title || !danmakuEngine || !SFV.player || !SFV.player.danmaku || !SFV.player.danmaku.loadFromClient) {
      console.log('[Danmaku] autoLoadDanmaku 早退', { reason: !title ? 'no title' : !danmakuEngine ? 'no engine' : !SFV.player ? 'no player' : !SFV.player.danmaku ? 'no player.danmaku' : 'no loadFromClient' });
      return;
    }
    // 检查开关
    try {
      if (typeof localStorage !== 'undefined' && localStorage.getItem(AUTO_LOAD_KEY) === 'false') {
        console.log('[Danmaku] autoLoadDanmaku 开关关闭，跳过');
        return;
      }
    } catch (e) { return; }
    // 检查凭证（无凭证则跳过，避免每次都弹错误）
    var hasCred = !!(SFV.danmaku.client && SFV.danmaku.client.hasCredentials());
    console.log('[Danmaku] 凭证检查', { hasCredentials: hasCred });
    if (SFV.danmaku.client && !hasCred) {
      console.log('[Danmaku] 无凭证，跳过');
      return;
    }
    var ep = extractEpisode(title);
    var cleanTitle = normalizeAnimeName(title); // 番名归一化：去集数/后缀，提升弹弹play 匹配率
    console.log('[Danmaku] 归一化结果 原始="' + title + '" → 清洗="' + cleanTitle + '" ep=' + ep);
    // toast: 开始搜索
    if (SFV.online && SFV.online.toast) {
      SFV.online.toast('正在搜索弹幕…');
    }
    SFV.player.danmaku.loadFromClient(cleanTitle, ep).then(function (list) {
      console.log('[Danmaku] loadFromClient 成功', { count: list ? list.length : 0 });
      if (list && list.length) {
        if (SFV.online && SFV.online.toast) {
          SFV.online.toast('弹幕已载入 ' + list.length + ' 条');
        }
      } else {
        // 搜索成功但无结果（该番剧可能暂无弹幕）
        console.log('[Danmaku] 搜索成功但无弹幕条目');
      }
    }).catch(function (e) {
      console.error('[Danmaku] loadFromClient 失败', { error: e, message: e ? e.message : null, stack: e ? e.stack : null });
      // 仅在网络/认证错误时提示一次，避免每次播片都弹
      if (SFV.online && SFV.online.toast && e && e.message !== 'DANMAKU_AUTH_REQUIRED') {
        SFV.online.toast('弹幕加载失败：' + (e.message || '未知错误'));
      }
    });
  }

  // 准备播放（创建 overlay、设置 id/进度/空间态、显示层），但不设置 video.src。
  // 供 HLS 路径复用：hls.js 接管 src 设置。
  function prepareForPlay(id, title) {
    playbackSeq++; // 新会话：使任何在途异步挂载失效
    console.log('[SFV-FREEZE] M1 prepareForPlay entry id=' + id);
    ensureOverlay();
    // ==== Fix: 每次播放前强制清理 SR 激活留下的隐藏类/画布，防止上次崩溃/未正确关闭导致
    // video 元素永久 opacity:0 或残余 canvas display:block 盖在 video 上造成纯黑屏。
    (function _clearStaleSrState() {
      try {
        var d = getDoc();
        if (videoEl) {
          videoEl.classList.remove('sfv-sr-source-hidden');
          videoEl.style.opacity = '';
          videoEl.style.display = '';
        }
        if (d) {
          var stale = d.getElementById('sfv-sr-canvas');
          if (stale) stale.style.display = 'none';
        }
      } catch (e) { /* 非致命 */ }
    })();
    if (danmakuEngine) danmakuEngine.load([]); // 换片清空上一部弹幕
    console.log('[SFV-FREEZE] M2 after clearSr+danmaku-clear');
    playNextFn = null; // 换片默认无下一集；online.js 起播成功后会重新注册
    currentId = id;
    // 保留上一轮已解析出的海报/系列键：异步起播路径（分享页探测 → 晚到的 openUrl/prepareForPlay）
    // 会在 play-orchestrator 的 setMeta({ cover }) 之后才走到这里，直接整体重置会把封面丢掉，
    // 导致底部控制条左侧海报容器永远空白。仅当 id 对得上（同一部片）才继承。
    var prevMeta = currentMeta || {};
    var inheritMeta = (prevMeta.id === id || prevMeta.key === id);
    currentMeta = { id: id, seriesKey: id, title: title || id, embed: false };
    if (inheritMeta) {
      if (prevMeta.seriesKey) currentMeta.seriesKey = prevMeta.seriesKey;
      if (prevMeta.cover) currentMeta.cover = prevMeta.cover;
      if (prevMeta.pic) currentMeta.pic = prevMeta.pic;
      if (prevMeta.subtitle) currentMeta.subtitle = prevMeta.subtitle;
    }
    _loadingToastCleared = false;
    emitPlayerEvent('sfv:player-open', currentMeta); // 所有 URL 播放路径（直链/HLS/FLV）的统一入口
    console.log('[SFV-FREEZE] M3 after emitPlayerEvent');
    restoreProgress();
    console.log('[SFV-FREEZE] M4 after restoreProgress');
    var sp = getSettings().speed;
    if (sp) videoEl.playbackRate = sp;
    if (id.indexOf('file:') === 0 || id.indexOf('url:') === 0) {
      SFV.model.addToLibrary({ id: id, title: title || currentUrl || id, source: 'url' });
    }
    SFV.state.setSpace('video');
    console.log('[SFV-FREEZE] M5a after setSpace');
    overlay.classList.add('sfv-show');
    emitRenderPause(true);
    console.log('[SFV-FREEZE] M5b after emitRenderPause');
    // 自动加载弹幕：根据视频标题搜弹幕（对齐 Kazumi 行为）
    try { autoLoadDanmaku(title); } catch (e) {}
    console.log('[SFV-FREEZE] M6 prepareForPlay done');
    return true;
  }

  // opts 可选：{ id, title } —— 供 source-adapter 在走 /api/proxy 时把进度键锚定到
  // 原始 URL，而非代理后的 URL。不传时行为与旧版完全一致（向后兼容）。
  function openUrl(url, opts) {
    if (!url) return false;
    opts = opts || {};
    ensureOverlay();
    clearEmbed();
    var id = opts.id || ('url:' + url);
    currentUrl = url;
    prepareForPlay(id, opts.title);
    if (opts.subtitle || opts.cover) setMeta({ subtitle: opts.subtitle || '', cover: opts.cover || '' });
    console.log('[SFV-FREEZE] M9 openUrl before src, url=' + String(url).slice(0, 160));
    videoEl.src = url;
    console.log('[SFV-FREEZE] M9b openUrl after src');
    var p = videoEl.play();
    console.log('[SFV-FREEZE] M9c openUrl after play()');
    if (p && p.catch) p.catch(function () {});
    return true;
  }

  function close() {
    if (!overlay) return;
    playbackSeq++; // 失效任何在途异步挂载（HLS/FLV/原生回退），避免退出后仍在后台起播
    // 若处于全屏（影视态全屏基于 documentElement），先退出全屏，避免关闭播放器后仍留在系统全屏露出背景
    var d = getDoc();
    if (d && d.fullscreenElement && d.exitFullscreen) {
      try { d.exitFullscreen(); } catch (e) {}
    }
    emitPlayerEvent('sfv:player-close', {});
    // 影视态：X/ESC 关闭播放器后返回进入播放器前的那一页（详情页/历史页），而非 home
    if (SFV.online && typeof SFV.online.returnFromPlayer === 'function') {
      try { SFV.online.returnFromPlayer(); } catch (e) {}
    }
    saveProgress();
    clearEmbed(); // 移除可能存活的解析器 iframe
    if (danmakuEngine) danmakuEngine.load([]); // 关闭时清空弹幕
    playNextFn = null;
    // 阶段3：关闭时清空线路/选集状态，避免跨片残留
    roads = null; roadFromIndex = -1; roadSwitchFn = null;
    playlistTracks = null; playlistIndex = -1; playEpisodeAtFn = null;
    if (SFV.detailSource && typeof SFV.detailSource.clearPlaybackSession === 'function') {
      try { SFV.detailSource.clearPlaybackSession(); } catch (e) {}
    }
    if (SFV.playerRoadEpisode && typeof SFV.playerRoadEpisode.close === 'function') {
      try { SFV.playerRoadEpisode.close(); } catch (e) {}
    }
    if (videoEl) { try { videoEl.pause(); } catch (e) {} }
    // 通知 source-adapter 销毁可能存活的 hls.js / flv.js 实例（先停 MSE/IO，避免继续下载分片）
    if (SFV.source && typeof SFV.source.onPlayerClose === 'function') {
      try { SFV.source.onPlayerClose(); } catch (e) {}
    }
    // 彻底中止 <video> 媒体加载：清空 src 并 load()。否则退出后视频仍在后台缓冲，
    // 数据就绪后会自行起播，导致"有声音无画面"的 bug（overlay 已隐藏，画面不可见）。
    if (videoEl) {
      try {
        videoEl.removeAttribute('src');
        try { videoEl.src = ''; } catch (e2) {} // 兜底清空内部资源引用
        videoEl.load();
      } catch (e) {}
    }
    overlay.classList.remove('sfv-show');
    if (currentUrl && currentUrl.indexOf('blob:') === 0 && typeof URL !== 'undefined' && URL.revokeObjectURL) {
      try { URL.revokeObjectURL(currentUrl); } catch (e) {}
    }
    currentUrl = null;
    currentId = null;
    // 关闭播放器 ≠ 切换空间（铁律：只有影视/音乐空间按钮能切换空间）
    // 仅隐藏播放器 overlay，保持当前空间状态不变
    emitRenderPause(false);
    // 刷新首页「今日观看」卡片（若加载序尚未就绪则忽略，非致命）
    try {
      if (typeof renderHomeInsightDock === 'function') renderHomeInsightDock();
    } catch (e) { /* 首页卡片刷新失败不应影响关闭播放器 */ }
  }

  function getVideoEl() { ensureOverlay(); return videoEl; }
  function getCurrentMeta() { return currentMeta || null; }
  function setCurrentUrl(u) { currentUrl = u; }

  // 清理嵌入态（移除解析器 iframe + 关闭按钮，恢复原生 video/控制条显示）。
  // 在 openUrl / openFile / openEmbed 入口调用，确保切换播放源时不会残留旧 iframe。
  function clearEmbed() {
    if (embedFrame && overlay) { try { overlay.removeChild(embedFrame); } catch (e) {} }
    embedFrame = null;
    if (embedCloseBtn && overlay) { try { overlay.removeChild(embedCloseBtn); } catch (e) {} }
    embedCloseBtn = null;
    if (videoEl) videoEl.style.display = '';
    if (controls) controls.style.display = '';
  }

  // 嵌入第三方解析器页面播放（解析器自渲染播放器，客户端解密真实流地址）。
  // 用于 agedm.io 等「播放页本身不含直链、真实流由解析器 iframe 客户端解密」的站点。
  // 这类页面无法提取 m3u8/mp4 直链，只能把整个解析器页面嵌入 iframe 由其自行播放。
  function openEmbed(url, opts) {
    if (!url) return false;
    playbackSeq++; // 新会话：使任何在途异步挂载失效（iframe 嵌入态亦递增以保持一致性）
    opts = opts || {};
    ensureOverlay();
    clearEmbed();
    playNextFn = null; // iframe 内播放无 ended 事件，无法连播
    currentId = opts.id || ('embed:' + url);

    // 隐藏原生 video 与控制条（解析器自带完整播放器 UI）
    if (videoEl) videoEl.style.display = 'none';
    if (controls) controls.style.display = 'none';

    embedFrame = getDoc().createElement('iframe');
    embedFrame.className = 'sfv-embed';
    // 放宽权限：自动播放 / 加密媒体 / 全屏 / 画中画，匹配解析器播放器所需能力
    embedFrame.setAttribute('allow', 'autoplay; encrypted-media; fullscreen; picture-in-picture; accelerometer; gyroscope');
    embedFrame.setAttribute('allowfullscreen', '');
    embedFrame.setAttribute('referrerpolicy', 'no-referrer');
    embedFrame.src = url;
    overlay.appendChild(embedFrame);

    // 独立关闭按钮（控制条已隐藏）
    embedCloseBtn = getDoc().createElement('button');
    embedCloseBtn.className = 'sfv-embed-close';
    embedCloseBtn.type = 'button';
    embedCloseBtn.textContent = '✕';
    embedCloseBtn.setAttribute('title', '关闭');
    embedCloseBtn.addEventListener('click', close);
    overlay.appendChild(embedCloseBtn);

    if (opts.title) {
      try { SFV.model.addToLibrary({ id: currentId, title: opts.title, source: 'embed' }); } catch (e) {}
    }
    SFV.state.setSpace('video');
    overlay.classList.add('sfv-show');
    setCurrentMeta({ id: currentId, seriesKey: currentId, title: opts.title || currentId, embed: true });
    if (opts.cover) setMeta({ cover: opts.cover });
    emitPlayerEvent('sfv:player-open', currentMeta);
    emitRenderPause(true);
    return true;
  }

  function saveProgress() {
    if (!videoEl || !currentId) return;
    var pos = Math.floor(videoEl.currentTime || 0);
    var dur = Math.floor(videoEl.duration || 0);
    SFV.model.setProgress(currentId, pos, dur);
    // 同步回写新版「观看历史」页专属存储，使其显示真实观影进度与总时长。
    // 受保护调用：SFV.watchHistory 可能因加载序尚未就绪；embed 模式无 videoEl 不会走到这里。
    try {
      if (SFV.watchHistory && SFV.watchHistory.update && dur > 0) {
        var progress = dur > 0 ? Math.max(0, Math.min(1, pos / dur)) : 0;
        var finished = progress >= 0.98;
        SFV.watchHistory.update(currentId, {
          progress: progress,
          cur: (SFV.watchHistory.formatDuration ? SFV.watchHistory.formatDuration(pos) : ''),
          total: (SFV.watchHistory.formatDuration ? SFV.watchHistory.formatDuration(dur) : ''),
          ts: Date.now(),
          finished: finished,
          watchedSec: Math.floor(_watchedSeconds)
        });
      }
    } catch (e) { /* 历史存储回写失败不应阻塞播放进度保存 */ }
  }

  function restoreProgress() {
    if (!videoEl || !currentId) return;
    var p = SFV.model.getProgress(currentId);
    if (p && p.position && (!videoEl.duration || p.position < videoEl.duration)) {
      try { videoEl.currentTime = p.position; } catch (e) {}
    }
  }

  function togglePlay() {
    if (!videoEl) return;
    if (videoEl.paused) { var p = videoEl.play(); if (p && p.catch) p.catch(function () {}); }
    else videoEl.pause();
  }

  function seek(ratio) {
    if (!videoEl || !videoEl.duration) return;
    ratio = Math.max(0, Math.min(1, ratio));
    try { videoEl.currentTime = ratio * videoEl.duration; } catch (e) {}
  }

  function cycleSpeed() {
    lastSpeedIdx = (lastSpeedIdx + 1) % SPEED_STEPS.length;
    setSpeed(SPEED_STEPS[lastSpeedIdx]);
  }
  function setSpeed(rate) {
    if (!videoEl || !rate) return;
    videoEl.playbackRate = rate;
    setSetting('speed', rate);
    if (speedBtn) speedBtn.textContent = rate + 'x';
  }

  function toggleFullscreen() {
    var d = getDoc();
    if (!d) return;
    // 优先走 Electron 原生全屏（win.setFullScreen），这是标题栏全屏的同一通路。
    // frameless 窗口下 HTML5 requestFullscreen 不可靠（不会真正放大视频）。
    // desktopWindow 由 preload 暴露；不可用时回退 HTML5 API。
    var bridge = global.desktopWindow;
    if (bridge && typeof bridge.toggleFullscreen === 'function') {
      try { bridge.toggleFullscreen(); return; } catch (e) {}
    }
    // 回退：HTML5 Fullscreen API
    try {
      if (d.fullscreenElement) {
        if (d.exitFullscreen) d.exitFullscreen();
      } else {
        // 影视态下 #bottom-bar（含全屏按钮）被提升到 body，若仅全屏 #sfv-overlay 会导致控制条丢失、无法再次退出。
        // 因此全屏根元素 documentElement，使视频铺满且控制条始终可见、可再次点击退出全屏。
        var target = (d.documentElement && d.documentElement.requestFullscreen)
          ? d.documentElement
          : (overlay && overlay.requestFullscreen ? overlay : null);
        if (!target) return;
        if (target.requestFullscreen) target.requestFullscreen();
        else if (target.webkitRequestFullscreen) target.webkitRequestFullscreen();
      }
    } catch (e) {}
  }

  // 全屏状态变化 → 同步 body.sfv-fullscreen，供控制条按钮反馈。
  // 同时兼顾 Electron 原生全屏（body.desktop-fullscreen 类，由窗口状态 IPC 驱动），
  // 因为原生全屏不会触发 HTML5 的 fullscreenchange 事件。
  function onFullscreenChange() {
    var d = getDoc();
    if (!d || !d.body) return;
    var fs = !!d.fullscreenElement || d.body.classList.contains('desktop-fullscreen');
    d.body.classList.toggle('sfv-fullscreen', fs);
  }
  if (global.addEventListener) {
    global.addEventListener('fullscreenchange', onFullscreenChange);
    // 原生全屏经窗口状态 IPC 同步：延迟一拍读取 desktop-fullscreen 类，
    // 确保 music.js 的窗口状态处理器已先更新该类。
    var dw = global.desktopWindow;
    if (dw && typeof dw.onStateChange === 'function') {
      dw.onStateChange(function () {
        if (global.setTimeout) global.setTimeout(onFullscreenChange, 0);
        else onFullscreenChange();
      });
    }
  }

  function openFilePicker() {
    ensureOverlay();
    if (fileInput && fileInput.click) fileInput.click();
  }

  // ============================================================
  //  跨模块桥接面（#6-b）：抽取集群经 SFV.playerBridge.state 读写共享闭包状态 +
  //  经 SFV.playerBridge.fn 回调核心函数。本文件作为状态宿主先加载，故桥接面在抽取
  //  集群（player-*.js）加载时已存在；抽取集群运行时把自己注册到 fn，facade 经 lazy
  //  包装在调用期解析（与加载序解耦）。
  // ============================================================
  var PB = (SFV.playerBridge = { state: {}, fn: {} });
  PB.state = {
    get overlay() { return overlay; }, set overlay(v) { overlay = v; },
    get videoEl() { return videoEl; }, set videoEl(v) { videoEl = v; },
    get controls() { return controls; }, set controls(v) { controls = v; },
    get fileInput() { return fileInput; }, set fileInput(v) { fileInput = v; },
    get playBtn() { return playBtn; }, set playBtn(v) { playBtn = v; },
    get speedBtn() { return speedBtn; }, set speedBtn(v) { speedBtn = v; },
    get qualityBtn() { return qualityBtn; }, set qualityBtn(v) { qualityBtn = v; },
    get fillEl() { return fillEl; }, set fillEl(v) { fillEl = v; },
    get timeEl() { return timeEl; }, set timeEl(v) { timeEl = v; },
    get currentId() { return currentId; }, set currentId(v) { currentId = v; },
    get currentUrl() { return currentUrl; }, set currentUrl(v) { currentUrl = v; },
    get embedFrame() { return embedFrame; }, set embedFrame(v) { embedFrame = v; },
    get embedCloseBtn() { return embedCloseBtn; }, set embedCloseBtn(v) { embedCloseBtn = v; },
    get playNextFn() { return playNextFn; }, set playNextFn(v) { playNextFn = v; },
    get modeBtn() { return modeBtn; }, set modeBtn(v) { modeBtn = v; },
    get hideTimer() { return hideTimer; }, set hideTimer(v) { hideTimer = v; },
    get lastSpeedIdx() { return lastSpeedIdx; }, set lastSpeedIdx(v) { lastSpeedIdx = v; },
    get lastSaveAt() { return lastSaveAt; }, set lastSaveAt(v) { lastSaveAt = v; },
    get barHitRect() { return barHitRect; }, set barHitRect(v) { barHitRect = v; },
    get danmakuLayer() { return danmakuLayer; }, set danmakuLayer(v) { danmakuLayer = v; },
    get danmakuEngine() { return danmakuEngine; }, set danmakuEngine(v) { danmakuEngine = v; },
    get currentMeta() { return currentMeta; }, set currentMeta(v) { currentMeta = v; },
    get _posterCachedKey() { return _posterCachedKey; }, set _posterCachedKey(v) { _posterCachedKey = v; },
    get _watchKey() { return _watchKey; }, set _watchKey(v) { _watchKey = v; },
    get _watchedSeconds() { return _watchedSeconds; }, set _watchedSeconds(v) { _watchedSeconds = v; },
    get _lastTickTs() { return _lastTickTs; }, set _lastTickTs(v) { _lastTickTs = v; },
    get _isPlaying() { return _isPlaying; }, set _isPlaying(v) { _isPlaying = v; },
    get playlistTracks() { return playlistTracks; }, set playlistTracks(v) { playlistTracks = v; },
    get playlistIndex() { return playlistIndex; }, set playlistIndex(v) { playlistIndex = v; },
    get playEpisodeAtFn() { return playEpisodeAtFn; }, set playEpisodeAtFn(v) { playEpisodeAtFn = v; },
    get roads() { return roads; }, set roads(v) { roads = v; },
    get roadFromIndex() { return roadFromIndex; }, set roadFromIndex(v) { roadFromIndex = v; },
    get roadSwitchFn() { return roadSwitchFn; }, set roadSwitchFn(v) { roadSwitchFn = v; }
  };

  // 注册核心函数（留在本文件；抽取集群经 fn 调用）
  function reg(name, fn) { PB.fn[name] = fn; }
  reg('getDoc', getDoc); reg('getSettings', getSettings); reg('setSetting', setSetting);
  reg('emitRenderPause', emitRenderPause); reg('emitPlayerEvent', emitPlayerEvent);
  reg('mkBtn', mkBtn);
  reg('checkPosterAutoCache', checkPosterAutoCache); reg('resetWatchTracker', resetWatchTracker);
  reg('wireVideoEvents', wireVideoEvents); reg('wireUnmuteOnInteraction', wireUnmuteOnInteraction);
  reg('wireIdle', wireIdle); reg('pointInBar', pointInBar); reg('armHideTimer', armHideTimer);
  reg('forceControlsVisible', forceControlsVisible);
  reg('setPlayIcon', setPlayIcon); reg('updateTime', updateTime);
  reg('ensureOverlay', ensureOverlay);
  reg('getPlayMode', getPlayMode); reg('setPlayMode', setPlayMode); reg('cyclePlayMode', cyclePlayMode);
  reg('setPlayNext', setPlayNext); reg('hasPlayNext', hasPlayNext); reg('onMediaEnded', onMediaEnded);
  reg('setCurrentMeta', setCurrentMeta); reg('setMeta', setMeta); reg('getMeta', getMeta);
  reg('getSpeed', getSpeed); reg('setVolume', setVolume); reg('getVolume', getVolume);
  reg('setPlaylist', setPlaylist); reg('setPlayEpisodeAt', setPlayEpisodeAt); reg('playEpisodeAt', playEpisodeAt);
  reg('playPrevEpisode', playPrevEpisode); reg('playNextEpisode', playNextEpisode);
  reg('hasPrevEpisode', hasPrevEpisode); reg('hasNextEpisode', hasNextEpisode);
  reg('setRoads', setRoads); reg('getRoads', getRoads); reg('switchRoad', switchRoad); reg('getRoadFromIndex', getRoadFromIndex);
  reg('openFile', openFile); reg('openUrl', openUrl); reg('openEmbed', openEmbed); reg('close', close);
  reg('prepareForPlay', prepareForPlay); reg('clearEmbed', clearEmbed);
  reg('saveProgress', saveProgress); reg('restoreProgress', restoreProgress);
  reg('togglePlay', togglePlay); reg('seek', seek); reg('cycleSpeed', cycleSpeed); reg('setSpeed', setSpeed);
  reg('toggleFullscreen', toggleFullscreen); reg('onFullscreenChange', onFullscreenChange);
  reg('openFilePicker', openFilePicker); reg('getVideoEl', getVideoEl); reg('getCurrentMeta', getCurrentMeta);
  reg('setCurrentUrl', setCurrentUrl); reg('autoLoadDanmaku', autoLoadDanmaku);

  // 弹幕控制子对象（核心，留在本文件）
  PB.danmaku = {
    setEntries: function (entries) { if (!danmakuEngine) return false; danmakuEngine.load(entries || []); return true; },
    loadFromClient: function (animeTitle, episode) {
      console.log('[Danmaku] loadFromClient 调用', { animeTitle: animeTitle, episode: episode });
      if (!danmakuEngine) { console.error('[Danmaku] loadFromClient: danmakuEngine 为空'); return Promise.reject(new Error('DANMAKU_UNAVAILABLE')); }
      var params = { animeTitle: animeTitle, episode: episode };
      var ctx = { onProgress: function (msg) { if (SFV.online && SFV.online.toast) SFV.online.toast(msg); } };
      var fetcher = null;
      var useSources = !!(SFV.danmaku && SFV.danmaku.sources && SFV.danmaku.sources.fetchAll);
      if (useSources) {
        console.log('[Danmaku] 使用 sources.fetchAll 路径');
        fetcher = function () { return SFV.danmaku.sources.fetchAll(params, ctx); };
      } else if (SFV.danmaku && SFV.danmaku.client) {
        console.log('[Danmaku] 使用 client.fetchForEpisode 路径（无 sources 管理器）');
        fetcher = function () { return SFV.danmaku.client.fetchForEpisode(animeTitle, episode, ctx.onProgress); };
      }
      if (!fetcher) { console.error('[Danmaku] loadFromClient: 无可用 fetcher'); return Promise.reject(new Error('DANMAKU_UNAVAILABLE')); }
      return Promise.resolve(fetcher()).then(function (list) {
        // 检查 sources 路径是否有错误被 allSettled 吞掉
        if (useSources && list && list._sourceErrors && list._sourceErrors.length > 0 && (!list.length || list.length === 0)) {
          var errMsg = list._sourceErrors.map(function(e) { return e && e.message ? e.message : String(e); }).join('; ');
          console.error('[Danmaku] 所有弹幕源均失败:', errMsg);
          throw new Error(errMsg || 'DANMAKU_FETCH_FAILED');
        }
        console.log('[Danmaku] fetch 返回', { count: list ? list.length : 0 });
        danmakuEngine.load(list || []);
        console.log('[Danmaku] danmakuEngine.load 已调用');
        return list;
      });
    },
    clear: function () { if (danmakuEngine) danmakuEngine.load([]); },
    setOptions: function (opts) { if (danmakuEngine) danmakuEngine.setOptions(opts || {}); },
    getOptions: function () { return danmakuEngine ? danmakuEngine.opts : null; },
    setVisible: function (on) { if (danmakuLayer) danmakuLayer.style.display = on ? '' : 'none'; },
    isVisible: function () { return danmakuLayer ? danmakuLayer.style.display !== 'none' : false; },
    engine: function () { return danmakuEngine; },
    setAutoLoad: function (on) {
      try { if (typeof localStorage !== 'undefined') localStorage.setItem(AUTO_LOAD_KEY, on ? 'true' : 'false'); } catch (e) {}
    },
    getAutoLoad: function () { try { return localStorage.getItem(AUTO_LOAD_KEY) !== 'false'; } catch (e) { return true; } },
    AUTO_LOAD_KEY: AUTO_LOAD_KEY
  };

  function bridgeFn(name) { return function () { return PB.fn[name].apply(this, arguments); }; }
  SFV.player = {
    openFile: bridgeFn('openFile'),
    openUrl: bridgeFn('openUrl'),
    openEmbed: bridgeFn('openEmbed'),
    close: bridgeFn('close'),
    togglePlay: bridgeFn('togglePlay'),
    seek: bridgeFn('seek'),
    setSpeed: bridgeFn('setSpeed'),
    cycleSpeed: bridgeFn('cycleSpeed'),
    toggleFullscreen: bridgeFn('toggleFullscreen'),
    openFilePicker: bridgeFn('openFilePicker'),
    getPlaylist: function () { return { tracks: playlistTracks, index: playlistIndex }; },
    setPlayNext: bridgeFn('setPlayNext'),
    hasPlayNext: bridgeFn('hasPlayNext'),
    getPlayMode: bridgeFn('getPlayMode'),
    setPlayMode: bridgeFn('setPlayMode'),
    cyclePlayMode: bridgeFn('cyclePlayMode'),
    isOpen: function () { return !!(overlay && overlay.classList.contains('sfv-show')); },
    currentId: function () { return currentId; },
    getCurrentMeta: bridgeFn('getCurrentMeta'),
    getVideoEl: bridgeFn('getVideoEl'),
    setCurrentUrl: bridgeFn('setCurrentUrl'),
    prepareForPlay: bridgeFn('prepareForPlay'),
    setCurrentMeta: bridgeFn('setCurrentMeta'),
    setMeta: bridgeFn('setMeta'),
    getMeta: bridgeFn('getMeta'),
    getSpeed: bridgeFn('getSpeed'),
    setVolume: bridgeFn('setVolume'),
    getVolume: bridgeFn('getVolume'),
    setPlaylist: bridgeFn('setPlaylist'),
    setPlayEpisodeAt: bridgeFn('setPlayEpisodeAt'),
    playEpisodeAt: bridgeFn('playEpisodeAt'),
    playPrevEpisode: bridgeFn('playPrevEpisode'),
    playNextEpisode: bridgeFn('playNextEpisode'),
    hasPrevEpisode: bridgeFn('hasPrevEpisode'),
    hasNextEpisode: bridgeFn('hasNextEpisode'),
    setRoads: bridgeFn('setRoads'),
    getRoads: bridgeFn('getRoads'),
    switchRoad: bridgeFn('switchRoad'),
    getRoadFromIndex: bridgeFn('getRoadFromIndex'),
    danmaku: PB.danmaku,
    // 起播会话序号 / 失效判定：供 source-adapter 在异步挂载完成后判断是否已被退出/换片
    getPlaybackSeq: function () { return playbackSeq; },
    isStaleSeq: function (seq) { return seq !== playbackSeq; },
    // 供 #controls-hide-btn（04-bottom-controls-cursor）即时切换影视态控制条显隐
    armHideTimer: bridgeFn('armHideTimer'),
    forceControlsVisible: bridgeFn('forceControlsVisible')
  };

  // 音乐态底部控制栏原生按钮的 inline onclick="toggleFullscreen()" 依赖全局符号；
  // 本函数被 IIFE 包裹，须显式挂到 global 才能被音乐态（控制器未激活、未替换 handler 时）调用。
  // 影视态下该 handler 会被 player-controller 替换为 SFV.player.toggleFullscreen，二者同源、无冲突。
  if (global && typeof global.toggleFullscreen !== 'function') {
    global.toggleFullscreen = toggleFullscreen;
  }
})(typeof window !== 'undefined' ? window : this);
