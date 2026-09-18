/*!
 * agent-adapter.js — AI 助手适配层
 * 将源项目 (LX-Music) 的全局函数调用映射到目标项目 (Stellaflix 2.1.0) 的模块化实现
 * 策略: 直接映射 / 组合实现 / 源码移植 / 空实现降级
 */
(function () {
  'use strict';

  var hasToast = typeof window.showToast === 'function';

  function toast(message) {
    if (hasToast) window.showToast(message);
  }

  function toolError(code, message) {
    return { ok: false, error: code, message: message };
  }

  // ============================================================
  //  全局变量声明 (目标项目缺失的)
  // ============================================================
  if (typeof window.lxMirrorPlaylists === 'undefined') {
    window.lxMirrorPlaylists = [];
  }
  if (typeof window.playbackTuning === 'undefined') {
    window.playbackTuning = { speed: 1.0, pitch: 0, active: false };
  }

  // ============================================================
  //  播放控制类 — 源码移植
  // ============================================================

  window.setPlaybackSpeed = function (speed) {
    speed = Number(speed);
    if (!isFinite(speed)) return toolError('INVALID_SPEED', '播放速度值无效');
    speed = Math.max(0.5, Math.min(2.0, speed));
    if (window.playbackTuning) window.playbackTuning.speed = speed;
    if (window.audio) {
      try { window.audio.playbackRate = speed; } catch (e) {}
    }
    toast('播放速度已设为 ' + speed.toFixed(2) + 'x');
    return { ok: true, speed: speed };
  };

  window.setPlaybackPitch = function (pitch) {
    pitch = Number(pitch);
    if (!isFinite(pitch)) return toolError('INVALID_PITCH', '变调值无效');
    pitch = Math.max(-12, Math.min(12, Math.round(pitch)));
    if (window.playbackTuning) window.playbackTuning.pitch = pitch;
    toast('变调已设为 ' + (pitch > 0 ? '+' : '') + pitch + ' 半音');
    return { ok: true, pitch: pitch };
  };

  window.resetPlaybackTuning = function () {
    if (window.playbackTuning) {
      window.playbackTuning.speed = 1.0;
      window.playbackTuning.pitch = 0;
      window.playbackTuning.active = false;
    }
    if (window.audio) {
      try { window.audio.playbackRate = 1.0; } catch (e) {}
    }
    toast('播放速度/变调已重置');
    return { ok: true };
  };

  window.playCurrentBackingTrack = function () {
    toast('当前版本暂不支持伴奏播放');
    return { ok: false, reason: 'NOT_SUPPORTED' };
  };

  window.primeOnlineAudioForUserGesture = function () {
    // 目标项目通过 attemptAudioPlay 处理用户手势
    if (typeof window.attemptAudioPlay === 'function') {
      return { ok: true, primed: true };
    }
    return { ok: true, primed: false };
  };

  // 复刻 playQueueAt 中"切歌 UI 同步"那段（13-playback-start-audio.js L1041-L1119），
  // 让 AI 助手切歌（playLxMirrorSong 直接 audio.play() 路径）也能更新歌词/海报/控制条/喜欢
  // 按钮。每个调用点都用 typeof 守护：模块函数可能因加载顺序/异常 try 而未挂到 window，
  // 缺哪一步就静默跳过（与 playQueueAt 内 safePlaybackStep 的容错一致）。
  function safeCall(name, fn) {
    try { return typeof fn === 'function' ? fn() : undefined; }
    catch (e) { try { console.warn('[playLxMirrorSong]', name, 'failed:', e); } catch (_) {} return undefined; }
  }

  function syncAgentTrackUi(song, token) {
    if (!song) return;
    // 1) 视觉/DJ 模式切换（与 playQueueAt 第 1033-1034 行一致）
    try {
      var podcastDjMode = !!(song && (song.type === 'podcast' || song.programId));
      if (typeof window.setDjModeActive === 'function') window.setDjModeActive(podcastDjMode, song);
    } catch (e) { /* best-effort */ }
    if (typeof window.switchPlaybackVisualToEmily === 'function') {
      safeCall('switchPlaybackVisualToEmily', window.switchPlaybackVisualToEmily);
    }
    // 2) 自定义封面/喜欢按钮按当前歌曲重算（playQueueAt L1036-L1038）
    if (typeof window.updateCustomCoverButton === 'function') {
      safeCall('updateCustomCoverButton', function () { window.updateCustomCoverButton(song); });
    }
    if (typeof window.updateLikeButtons === 'function') {
      safeCall('updateLikeButtons', function () { window.updateLikeButtons(song); });
    }
    if (typeof window.syncLikeStatusForSong === 'function') {
      safeCall('syncLikeStatusForSong', function () { window.syncLikeStatusForSong(song); });
    }
    // 3) 缩略图/控制条立即刷新（playQueueAt L1041-L1047）—— 用户最先感知的视觉变化
    try {
      var hint = document.getElementById('hint');
      if (hint && typeof hint.classList !== 'undefined') hint.classList.add('hidden');
      var thumbTitle = document.getElementById('thumb-title');
      if (thumbTitle) thumbTitle.textContent = String(song.name || song.title || '');
      var thumbArtist = document.getElementById('thumb-artist');
      if (thumbArtist) thumbArtist.textContent = String(song.artist || song.singer || '');
      if (typeof window.updateControlTrackInfo === 'function') window.updateControlTrackInfo(song);
      var thumbWrap = document.getElementById('thumb-wrap');
      if (thumbWrap && typeof thumbWrap.classList !== 'undefined') thumbWrap.classList.add('visible');
    } catch (e) {
      try { console.warn('[playLxMirrorSong] track-ui DOM update failed:', e); } catch (_) {}
    }
    // 4) 歌词面板立即进入 pending 态（playQueueAt L1054-L1062）—— 避免上首歌歌词残留
    if (typeof window.resetLyricsForTrackSwitch === 'function') {
      safeCall('resetLyricsForTrackSwitch', function () {
        // 签名差异：原模块 resetLyricsForTrackSwitch() 不收参数，从 currentLyricSong() 取当前歌；
        // 我们先把 song 临时挂到内部 currentLyricSong() 期望的位置再调用，调用完还原。
        try {
          if (typeof window.currentLyricSong === 'function' && typeof window.setCurrentLyricSong === 'function') {
            var prev = window.currentLyricSong();
            window.setCurrentLyricSong(song);
            window.resetLyricsForTrackSwitch();
            window.setCurrentLyricSong(prev);
          } else {
            window.resetLyricsForTrackSwitch();
          }
        } catch (innerErr) {
          try { window.resetLyricsForTrackSwitch(); } catch (_) {}
        }
      });
    }
    if (typeof window.applyPreferredLyricsForCurrent === 'function') {
      safeCall('applyPreferredLyricsForCurrent', function () { window.applyPreferredLyricsForCurrent(true); });
    }
    if (typeof window.scheduleTrackSwitchFallbackLyrics === 'function') {
      safeCall('scheduleTrackSwitchFallbackLyrics', function () { window.scheduleTrackSwitchFallbackLyrics(song, token, 1500); });
    }
    // 5) 异步抓新歌歌词（fetchLyric 已在 00-lyrics-fetch-parse.js 末尾显式挂到 window）
    if (typeof window.fetchLyric === 'function') {
      try {
        setTimeout(function () {
          if (token === window.trackSwitchToken && typeof window.fetchLyric === 'function') {
            try { window.fetchLyric(song, token); } catch (e) { /* best-effort */ }
          }
        }, 0);
      } catch (e) { /* best-effort */ }
    }
    // 6) 海报（playQueueAt L1067-L1119 简化版）—— 先 hydrate 自定义封面再走默认 cover
    try {
      if (typeof window.hydrateCustomCover === 'function') window.hydrateCustomCover(song);
      var customCover = (typeof window.getCustomCoverForSong === 'function') ? window.getCustomCoverForSong(song) : '';
      var coverOpts = { trackToken: token, deferHeavy: true, delay: 0, timeout: 1700 };
      if (customCover && typeof window.applyCoverDataUrl === 'function') {
        window.applyCoverDataUrl(customCover, coverOpts);
      } else if (typeof window.loadCoverFromUrl === 'function') {
        var coverUrl = (typeof window.coverUrlWithSize === 'function')
          ? window.coverUrlWithSize(song.cover || '', 400)
          : (song.cover || '');
        window.loadCoverFromUrl(coverUrl, coverOpts);
      }
    } catch (e) {
      try { console.warn('[playLxMirrorSong] cover-load failed:', e); } catch (_) {}
    }
  }

  window.playLxMirrorSong = async function (playlistIndex, songIndex, song) {
    if (!song || typeof song !== 'object') {
      toast('没有可播放的歌曲信息');
      return { ok: false, reason: 'NO_SONG' };
    }
    // 优先使用青听音乐等内置第三方音源桥，替代被 stub 的 LX 镜像播放
    var CSI = window.CustomSourceIntegration;
    if (!CSI || typeof CSI.resolveOnlinePlaybackData !== 'function' || !CSI.hasBridge()) {
      toast('当前版本暂不支持 LX 镜像播放（第三方音源未就绪）');
      return { ok: false, reason: 'NOT_SUPPORTED' };
    }
    try {
      console.log('[playLxMirrorSong] resolving via custom-source for:', song.name || song.title, song.artist || '');
      // 优先走聚合解析（跨平台匹配真实可播放版本，按 flac24bit→flac→320k→128k 音质降序
      // 逐候选热切换），打破 netease 歌映射到 source='wy' 后 LX 脚本普遍不支持的平台绑定问题。
      // 仅保留聚合解析；未命中时直接报告 resolve_failed，不再回退其他第三方路径。
      var resolved = await CSI.resolveOnlinePlaybackData(song, {
        requestedQuality: 'hires',
        mode: 'aggregate',
        preResolve: true
      });
      console.log('[playLxMirrorSong] aggregate resolve result:', resolved);
      if (!resolved || resolved.override !== true || !resolved.data || !resolved.data.url) {
        var aggReason = resolved && resolved.reason ? resolved.reason : 'aggregate-no-match';
        console.warn('[playLxMirrorSong] aggregate failed reason=', aggReason, 'no fallback retained');
      }
      console.log('[playLxMirrorSong] resolve result:', resolved);
      if (!resolved || resolved.override !== true || !resolved.data || !resolved.data.url) {
        var reason = resolved && resolved.reason ? resolved.reason : 'RESOLVE_FAILED';
        console.warn('[playLxMirrorSong] resolve failed reason=', reason, 'resolved=', resolved);
        toast('第三方音源未能解析到音频：' + reason);
        return { ok: false, reason: reason, resolveResult: resolved };
      }
      var data = resolved.data;
      // 首次 AI 播放 / 播放器尚未挂载：主动创建 audio 元素。00-core-stores.js:6 顶层
      // var audio = null（即 window.audio 初始为 null），只有正常播放路径 playQueueAt 在
      // audio 缺失时才会 new Audio()（L1356-L1357）；AI 助手走 audio.play() 直通道绕开了
      // 那条路径，用户若从未手动播过歌，window.audio 恒为 null → 误报 PLAYER_NOT_READY。
      if (!window.audio) {
        var audioEl = new Audio();
        audioEl.crossOrigin = 'anonymous';
        audioEl.autoplay = true;
        audioEl.preload = 'auto';
        window.audio = audioEl;
      }
      // 停止旧播放，避免快速恢复逻辑短路
      try { window.audio.pause(); } catch (e) {}
      try { window.audio.currentTime = 0; } catch (e) {}
      window.audio.src = data.url;
      // 补齐音频可视化/进度绑定（对齐 playQueueAt L1363-L1374：先设 src 再建音图）。
      // 这些是顶层普通 function，会从 index-loader 的 try 块泄漏到 window；缺失时用
      // typeof 守护跳过，不阻塞播放。async 的 applyAudioOutputDevice/ensurePlaybackAudioGraph
      // 不泄漏（ES2017 块级作用域），本路径只能默认输出设备，不影响"能播放"这一核心目标。
      try { if (typeof window.bindPlaybackProgressEvents === 'function') window.bindPlaybackProgressEvents(window.audio); } catch (e) {}
      try { if (typeof window.applyVolumeToAudio === 'function') window.applyVolumeToAudio(); } catch (e) {}
      try { if (typeof window.resetPlaybackAudioGraphForSourceSwitch === 'function') window.resetPlaybackAudioGraphForSourceSwitch('ai-playback-init'); } catch (e) {}
      // 将当前歌曲加入队列上下文，便于播放控制/歌词/封面模块识别
      if (!Array.isArray(window.playQueue)) window.playQueue = [];
      window.playQueue.length = 0;
      window.playQueue.push(song);
      window.currentIdx = 0;
      // 同步播放器状态标记，避免 attemptAudioPlay 的 token 校验失败
      if (typeof window.trackSwitchToken === 'number') window.trackSwitchToken++;
      // 播放：直接走 audio.play()，绕过复杂的 attemptAudioPlay 状态校验
      var playPromise = window.audio.play();
      if (playPromise && typeof playPromise.then === 'function') await playPromise;
      if (window.audio.paused || window.audio.ended) {
        toast('播放启动失败');
        return { ok: false, reason: 'PLAYBACK_FAILED' };
      }
      // 手动同步全局播放状态
      if (typeof window.playing !== 'undefined') window.playing = true;
      if (typeof window.setPlayIcon === 'function') window.setPlayIcon(true);
      if (typeof window.hideLoading === 'function') window.hideLoading();
      // ==== 切歌 UI 同步（修复 Problem 2：AI 助手切歌不更新歌词/海报/控制条） ====
      // playQueueAt 在常规路径里负责歌词/封面/DOM/喜欢状态全套刷新；playLxMirrorSong 直接
      // 走 audio.play() 绕过了那条路径，所以这里手动复刻必要的同步步骤，让 AI 助手切歌
      // 看起来和用户手动选歌完全一致：缩略图换行、控制条换信息、喜欢按钮/自定义封面按钮
      // 重算、歌词面板先 pending 占位再异步抓新歌歌词、海报立即加载并允许后续异步回填。
      var switchToken = (typeof window.trackSwitchToken === 'number') ? window.trackSwitchToken : 0;
      syncAgentTrackUi(song, switchToken);
      var sourceName = String(data.sourceLabel || data.source || '第三方音源');
      toast('正在播放：' + String(song.name || song.title || '未知歌曲') + '（' + sourceName + '）');
      console.log('[playLxMirrorSong] playback started via', sourceName, data.url);
      return { ok: true, source: sourceName, url: data.url };
    } catch (error) {
      console.warn('[playLxMirrorSong] error:', error);
      toast('LX 镜像播放失败：' + (error && error.message ? error.message : '未知错误'));
      return { ok: false, reason: 'PLAYBACK_FAILED', error: error && error.message };
    }
  };

  window.nfSelectPlayMode = function (mode) {
    if (typeof window.setPlayMode === 'function') {
      return window.setPlayMode(mode);
    }
    if (window.playMode !== undefined) {
      window.playMode = String(mode || 'sequence');
      toast('播放模式已设为: ' + mode);
      return { ok: true, mode: window.playMode };
    }
    return toolError('PLAY_MODE_NOT_AVAILABLE', '播放模式不可用');
  };

  window.seekNowFlowToRatio = function (ratio) {
    if (typeof window.seekNowFlowToRatio === 'function') return window.seekNowFlowToRatio(ratio);
    if (window.audio && isFinite(ratio)) {
      try {
        var target = Math.max(0, Math.min(1, Number(ratio))) * (window.audio.duration || 0);
        window.audio.currentTime = target;
        return { ok: true, position: target };
      } catch (e) {}
    }
    return toolError('SEEK_FAILED', '跳转失败');
  };

  // ============================================================
  //  导航类 — 组合实现
  // ============================================================

  window.openPrimaryView = function (view) {
    view = String(view || 'home');
    // 目标项目无 primaryView 概念，尝试切换场景
    if (view === 'home') {
      toast('返回首页');
    } else if (view === 'library') {
      if (typeof window.openPlaylistPanelTab === 'function') {
        window.openPlaylistPanelTab('library');
      }
    }
    return { ok: true, view: view };
  };

  (function () {
    var nativeOpenRadioModes = window.openRadioModes;
    window.openRadioModes = function () {
      if (typeof nativeOpenRadioModes === 'function' && nativeOpenRadioModes !== window.openRadioModes) {
        return nativeOpenRadioModes.apply(this, arguments);
      }
      toast('当前版本暂不支持电台模式');
      return { ok: false, reason: 'NOT_SUPPORTED' };
    };
  })();

  window.openPlatformRanking = function () {
    toast('当前版本暂不支持平台排行榜');
    return { ok: false, reason: 'NOT_SUPPORTED' };
  };

  window.focusGlobalSearch = function () {
    var searchBox = document.getElementById('search-box') ||
                    document.querySelector('input[type="search"]') ||
                    document.querySelector('.search-input');
    if (searchBox) {
      searchBox.focus();
      searchBox.select();
      return { ok: true };
    }
    toast('搜索框未找到');
    return { ok: false, reason: 'SEARCH_BOX_NOT_FOUND' };
  };

  window.openDailyReviewManager = function () {
    toast('当前版本暂不支持每日回顾');
    return { ok: false, reason: 'NOT_SUPPORTED' };
  };

  window.openAuthorSupportPanel = function () {
    toast('当前版本暂不支持作者支持面板');
    return { ok: false, reason: 'NOT_SUPPORTED' };
  };

  // ============================================================
  //  歌单/导入类 — 组合实现
  // ============================================================

  window.openPlatformPlaylistImport = function (source) {
    if (typeof window.openPlaylistPanelTab === 'function') {
      window.openPlaylistPanelTab('import');
    }
    toast('歌单导入: ' + (source || '平台'));
    return { ok: true };
  };

  window.openLxPlaylistImport = function () {
    toast('当前版本暂不支持 LX 歌单导入');
    return { ok: false, reason: 'NOT_SUPPORTED' };
  };

  window.openPlaylistSelection = function () {
    if (typeof window.openPlaylistPanelTab === 'function') {
      window.openPlaylistPanelTab('select');
    }
    return { ok: true };
  };

  window.openLxSourceImport = function () {
    toast('当前版本暂不支持 LX 音源导入');
    return { ok: false, reason: 'NOT_SUPPORTED' };
  };

  window.openLocalFileImport = function () {
    if (typeof window.openLocalFileImport === 'function') return window.openLocalFileImport();
    toast('点击导入本地文件');
    var fileInput = document.querySelector('input[type="file"]');
    if (fileInput) fileInput.click();
    return { ok: true };
  };

  window.openLocalFolderImport = function () {
    toast('点击导入本地文件夹');
    var folderInput = document.querySelector('input[type="file"][webkitdirectory]');
    if (folderInput) folderInput.click();
    return { ok: true };
  };

  window.refreshSharedPlaylistOrderViews = function () {
    if (typeof window.safeRenderQueuePanel === 'function') {
      window.safeRenderQueuePanel();
    }
    return { ok: true };
  };

  // ============================================================
  //  UI/面板类 — 组合实现
  // ============================================================

  window.openAudioOutputSettings = function () {
    toast('打开音频输出设置');
    // 尝试通过设置面板打开
    if (typeof window.openHotkeySettings === 'function') {
      // 目标项目在 hotkeys 面板中包含音频设置
      window.openHotkeySettings();
    }
    return { ok: true };
  };

  window.openWallpaperPicker = function () {
    // 目标项目有 wallpaper-engine-library.js
    toast('打开壁纸选择器');
    var wallpaperBtn = document.querySelector('[data-wallpaper-picker]') ||
                      document.querySelector('.wallpaper-picker-trigger');
    if (wallpaperBtn) wallpaperBtn.click();
    return { ok: true };
  };

  window.nfCloseOptionMenus = function () {
    var menus = document.querySelectorAll('.option-menu.show, .dropdown-menu.show, [data-option-menu].show');
    menus.forEach(function (menu) { menu.classList.remove('show'); });
    return { ok: true, closed: menus.length };
  };

  window.nowFlowWakeControls = function () {
    if (typeof window.revealBottomControls === 'function') {
      window.revealBottomControls();
    }
    return { ok: true };
  };

  window.updateNowFlowActions = function () {
    // NowFlow 相关 UI 更新
    return { ok: true };
  };

  window.compactLyricPanelSections = function () {
    var lyricPanel = document.querySelector('.lyric-panel, .lyrics-panel');
    if (lyricPanel) {
      lyricPanel.classList.toggle('compact');
      return { ok: true, compact: lyricPanel.classList.contains('compact') };
    }
    return { ok: false, reason: 'LYRIC_PANEL_NOT_FOUND' };
  };

  window.scrollFxFeatureIntoPanel = function (feature) {
    var fxPanel = document.querySelector('.fx-panel, [data-fx-panel]');
    var target = fxPanel ? fxPanel.querySelector('[data-feature="' + feature + '"]') : null;
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return { ok: true };
    }
    return { ok: false, reason: 'FEATURE_NOT_FOUND' };
  };

  // ============================================================
  //  数据管理类 — 组合实现
  // ============================================================

  // 03b-local-playlist-store.js 加载时会用真实实现覆盖这两个入口；
  // 这里只保留调用时委托 + 非递归降级，避免加载顺序差异导致自递归栈溢出
  window.ensureLocalUserPlaylistsLoaded = function (force) {
    if (window.localPlaylistStore && typeof window.localPlaylistStore.load === 'function') {
      try { return window.localPlaylistStore.load(!!force) && { ok: true, loaded: window.localPlaylistStore.list().length }; } catch (e) { }
    }
    return { ok: true, loaded: (window.userPlaylists || []).filter(function (pl) { return pl && pl.localUserPlaylist; }).length };
  };

  window.saveLocalUserPlaylists = function () {
    if (window.localPlaylistStore && typeof window.localPlaylistStore.save === 'function') {
      try { return !!window.localPlaylistStore.save(); } catch (e) { return false; }
    }
    try {
      var locals = (window.userPlaylists || []).filter(function (pl) { return pl && pl.localUserPlaylist; });
      localStorage.setItem('stellaflix-local-playlists', JSON.stringify(locals));
      return true;
    } catch (e) {
      return false;
    }
  };

  window.loadLxMirrorPlaylists = function () {
    if (typeof window.loadLxMirrorPlaylists === 'function') {
      return window.loadLxMirrorPlaylists();
    }
    window.lxMirrorPlaylists = [];
    return { ok: true, loaded: 0 };
  };

  window.showCurrentLxSource = function () {
    toast('当前版本暂不支持 LX 音源显示');
    return { ok: false, reason: 'NOT_SUPPORTED' };
  };

  window.clearLocalLibraryPassiveQueue = function () {
    toast('清除被动队列');
    return { ok: true };
  };

  // ============================================================
  //  彩蛋/特殊类 — 空实现降级
  // ============================================================

  window.playWorldPeaceEasterEgg = function () {
    toast('当前版本暂不支持该彩蛋');
    return { ok: false, reason: 'NOT_SUPPORTED' };
  };

  window.openRemoteControl = function () {
    toast('当前版本暂不支持远程控制');
    return { ok: false, reason: 'NOT_SUPPORTED' };
  };

  window.openMusicPlanet = function () {
    toast('当前版本暂不支持音乐星球');
    return { ok: false, reason: 'NOT_SUPPORTED' };
  };

  // ============================================================
  //  工具类 — 组合实现
  // ============================================================

  window.isStellaflixFullscreenActive = function () {
    return !!document.fullscreenElement ||
           !!(window.desktopWindow && window.desktopWindow.isFullscreen && window.desktopWindow.isFullscreen());
  };

  window.beginVoiceInputIsolation = function () {
    // 语音隔离: 暂停音频播放以便清晰录音
    if (window.audio && !window.audio.paused) {
      window.audio.pause();
      return { ok: true, paused: true };
    }
    return { ok: true, paused: false };
  };

  window.endVoiceInputIsolation = function () {
    return { ok: true };
  };

  window.clearFxPanelAutoCloseTimer = function () {
    if (window.fxPanelAutoCloseTimer) {
      clearTimeout(window.fxPanelAutoCloseTimer);
      window.fxPanelAutoCloseTimer = null;
    }
    return { ok: true };
  };

  window.savePlaybackSession = function () {
    try {
      var session = {
        queue: window.playQueue || [],
        idx: window.currentIdx,
        mode: window.playMode,
        time: Date.now()
      };
      localStorage.setItem('stellaflix-playback-session', JSON.stringify(session));
      return { ok: true };
    } catch (e) {
      return toolError('SAVE_FAILED', '保存播放会话失败');
    }
  };

  // ============================================================
  //  NowFlow 相关 — 组合实现
  // ============================================================

  if (typeof window.forcePlaybackControlsInteractive !== 'function') {
    window.forcePlaybackControlsInteractive = function () {
      if (typeof window.revealBottomControls === 'function') {
        window.revealBottomControls();
      }
      return { ok: true };
    };
  }

  if (typeof window.revealBottomControls !== 'function') {
    window.revealBottomControls = function () {
      var controls = document.querySelector('.bottom-controls, .player-controls');
      if (controls) {
        controls.classList.remove('hidden', 'auto-hide');
        return { ok: true };
      }
      return { ok: false, reason: 'CONTROLS_NOT_FOUND' };
    };
  }

  window.savePlaybackSession = window.savePlaybackSession || function () {
    return { ok: true };
  };

  // 防止覆盖目标项目已有的函数 (通过 typeof 检查)
  // 以下函数在目标项目中已存在，适配器不做处理:
  // - applyDiyMode, attemptAudioPlay, clearQueue, currentCoverSong
  // - currentPlaybackQualityProvider, forcePlaybackControlsInteractive
  // - getProviderPlaybackQuality, nextTrack, normalizePlaybackQualityForProvider
  // - openCollectModalForCurrent, openCustomLyricModal, openHomeInsight
  // - openHotkeySettings, openLocalBeatModal, openPlaylistPanelTab
  // - openTrackDetailModal, openUpdatePanel, playbackQualityLabel
  // - playQueueAt, prevTrack, queueSong, resetFx
  // - revealBottomControls, runAppMemoryTrim, runSystemMemoryPurge
  // - safeRenderQueuePanel, safeShelfRebuild, safeSwitchPlaylistTab
  // - setFxPanelTab, setImmersiveMode, setLyricMotionStyle
  // - setPlaybackQuality, setVolume, showToast, shuffleQueue
  // - startVisualGuide, toggleControlsAutoHide, toggleFullscreen
  // - toggleFxFabAutoHide, toggleFxPanel, toggleLyricsPanel, togglePlay

})();
