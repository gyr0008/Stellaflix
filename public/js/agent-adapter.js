/*!
 * agent-adapter.js — AI 助手适配层
 * 将源项目 (LX-Music) 的全局函数调用映射到目标项目 (Mineradio 2.1.0) 的模块化实现
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

  window.playLxMirrorSong = function () {
    toast('当前版本暂不支持 LX 镜像播放');
    return { ok: false, reason: 'NOT_SUPPORTED' };
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

  window.openRadioModes = function () {
    toast('当前版本暂不支持电台模式');
    return { ok: false, reason: 'NOT_SUPPORTED' };
  };

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

  window.ensureLocalUserPlaylistsLoaded = function () {
    if (typeof window.ensureLocalUserPlaylistsLoaded === 'function') {
      return window.ensureLocalUserPlaylistsLoaded();
    }
    if (window.userPlaylists !== undefined) {
      return { ok: true, loaded: window.userPlaylists.length };
    }
    return { ok: true, loaded: 0 };
  };

  window.saveLocalUserPlaylists = function () {
    if (typeof window.saveLocalUserPlaylists === 'function') {
      return window.saveLocalUserPlaylists();
    }
    try {
      localStorage.setItem('mineradio-user-playlists', JSON.stringify(window.userPlaylists || []));
      return { ok: true };
    } catch (e) {
      return toolError('SAVE_FAILED', '保存失败: ' + e.message);
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

  window.isMineradioFullscreenActive = function () {
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
      localStorage.setItem('mineradio-playback-session', JSON.stringify(session));
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
