// 迷你播放器渲染端：主窗口 → 主进程 pill 的状态增量推送、收起过渡、命令路由与设置接线。
// 移植自参照源码 app.js :32350-32709（push/visual/pulse）与 :45899-46159（collapse 过渡 + 命令 + 注册），
// 按 R4/R5 裁定改造：desktopShellSettings.miniPlayer/miniPlayerMode 持久化改挂 fx；payload 不再携带 uiLanguage。
// 桌面壳专属：window.desktopWindow 不存在时全部入口自带守卫，Web 模式下零副作用。

var MINI_PLAYER_EFFECT_STRENGTH_MAX = 3;
var miniPlayerSyncState = null;
var miniPlayerPulseLastAt = 0;
var miniPlayerPulseTimer = 0;
var miniPlayerPulseSample = 0;
var miniPlayerPulseBaseline = 0;

function miniPlayerVisualPayload() {
  return {
    pulseEnabled: fx.miniPlayerPulseEnabled !== false,
    pulseStrength: clampRange(fx.miniPlayerPulseStrength == null ? fxDefaults.miniPlayerPulseStrength : Number(fx.miniPlayerPulseStrength), 0, MINI_PLAYER_EFFECT_STRENGTH_MAX),
    glowEnabled: fx.miniPlayerGlowEnabled !== false,
    glowStrength: clampRange(fx.miniPlayerGlowStrength == null ? fxDefaults.miniPlayerGlowStrength : Number(fx.miniPlayerGlowStrength), 0, MINI_PLAYER_EFFECT_STRENGTH_MAX),
    hoverExpand: fx.miniPlayerHoverExpand !== false,
    radius: clampRange(fx.miniPlayerRadius == null ? fxDefaults.miniPlayerRadius : Number(fx.miniPlayerRadius), 4, 22),
  };
}

/**
 * 判断当前是否还有迷你播放器律动消费者。
 * 极简外壳不显示封面，且两种效果都关闭或强度为零时，后台不应继续做频谱采样。
 * @returns {boolean} 标准外壳至少有一种有效效果时返回 true。
 */
function miniPlayerPulsePipelineActive() {
  if (fx.miniPlayerMode === 'compact') return false;
  var pulseEnabled = true;
  var pulseStrength = 1;
  var glowEnabled = true;
  var glowStrength = 1;
  if (typeof fx !== 'undefined' && fx) {
    pulseEnabled = fx.miniPlayerPulseEnabled !== false;
    glowEnabled = fx.miniPlayerGlowEnabled !== false;
    var rawPulseStrength = Number(fx.miniPlayerPulseStrength);
    var rawGlowStrength = Number(fx.miniPlayerGlowStrength);
    if (isFinite(rawPulseStrength)) pulseStrength = rawPulseStrength;
    if (isFinite(rawGlowStrength)) glowStrength = rawGlowStrength;
  }
  return (pulseEnabled && pulseStrength > 0) || (glowEnabled && glowStrength > 0);
}

function miniPlayerPulseValue() {
  if (typeof miniPlayerPulsePipelineActive === 'function' && !miniPlayerPulsePipelineActive()) return 0;
  if (!playing || !audio || audio.paused || audio.ended) return 0;
  var documentHidden = typeof document !== 'undefined' && document.hidden === true;
  var runtimeHidden = documentHidden || (typeof desktopRuntimeState !== 'undefined' && desktopRuntimeState
    && (desktopRuntimeState.minimized || desktopRuntimeState.visible === false));
  if (runtimeHidden) return clampRange(miniPlayerPulseSample, 0, 1);
  return clampRange(Math.max(miniPlayerPulseSample, beatPulse * 1.05, smoothBass * 0.58 + smoothEnergy * 0.24), 0, 1);
}

function stopMiniPlayerPulseTimer() {
  if (miniPlayerPulseTimer) clearTimeout(miniPlayerPulseTimer);
  miniPlayerPulseTimer = 0;
}

function miniPlayerPulseTimerActive() {
  var documentHidden = typeof document !== 'undefined' && document.hidden === true;
  var runtimeHidden = documentHidden || (typeof desktopRuntimeState !== 'undefined' && desktopRuntimeState
    && (desktopRuntimeState.minimized || desktopRuntimeState.visible === false));
  var pipelineActive = typeof miniPlayerPulsePipelineActive !== 'function' || miniPlayerPulsePipelineActive();
  return !!(pipelineActive && window.desktopWindow && window.desktopWindow.isDesktop && runtimeHidden &&
    fx.miniPlayerEnabled !== false &&
    audio && audio.src && !audio.paused && !audio.ended);
}

/**
 * 在主窗口隐藏时独立采样音频频谱，向标准迷你播放器提供有峰谷的封面律动。
 * 挂起的 AudioContext 必须先恢复；频谱值使用低频峰值、低频均值和整体能量的短期对比，避免压缩音乐长期饱和为固定满值。
 * @returns {void}
 */
function runMiniPlayerPulseTimer() {
  miniPlayerPulseTimer = 0;
  var pipelineActive = typeof miniPlayerPulsePipelineActive !== 'function' || miniPlayerPulsePipelineActive();
  if (!pipelineActive) {
    miniPlayerPulseSample = 0;
    miniPlayerPulseBaseline = 0;
    return;
  }
  if (!miniPlayerPulseTimerActive()) {
    miniPlayerPulseSample *= 0.72;
    miniPlayerPulseBaseline *= 0.82;
    return;
  }
  var target = 0;
  try {
    if (audioCtx && audioCtx.state === 'suspended' && typeof resumeAudioAnalysis === 'function') resumeAudioAnalysis();
    var pulseAnalyser = analyser;
    var pulseData = frequencyData;
    if (beatAnalyser && typeof beatFrequencyData !== 'undefined' && beatFrequencyData && beatFrequencyData.length) {
      try {
        beatAnalyser.getByteFrequencyData(beatFrequencyData);
        var beatHasSignal = false;
        // 只把实际参与律动计算的低频窗口作为有效性判断，避免悬空或失步的分析器把主链路覆盖为零。
        var beatSignalEnd = Math.min(96, beatFrequencyData.length);
        for (var beatIndex = 0; beatIndex < beatSignalEnd; beatIndex++) {
          if (beatFrequencyData[beatIndex] > 0) {
            beatHasSignal = true;
            break;
          }
        }
        if (beatHasSignal) {
          pulseAnalyser = beatAnalyser;
          pulseData = beatFrequencyData;
        }
      } catch (e) {}
    }
    if (pulseAnalyser && pulseData && pulseData.length) {
      if (pulseAnalyser === analyser) analyser.getByteFrequencyData(frequencyData);
      var low = 0;
      var lowPeak = 0;
      var energy = 0;
      var lowEnd = Math.min(10, pulseData.length);
      var energyEnd = Math.min(96, pulseData.length);
      for (var i = 0; i < lowEnd; i++) {
        var lowValue = pulseData[i] / 255;
        low += lowValue;
        if (lowValue > lowPeak) lowPeak = lowValue;
      }
      for (var j = 0; j < energyEnd; j++) energy += pulseData[j] / 255;
      var lowMean = low / Math.max(1, lowEnd);
      var energyMean = energy / Math.max(1, energyEnd);
      var rawTarget = lowMean * 0.62 + lowPeak * 0.18 + energyMean * 0.20;
      miniPlayerPulseBaseline += (rawTarget - miniPlayerPulseBaseline) * (rawTarget > miniPlayerPulseBaseline ? 0.10 : 0.024);
      var contrast = Math.max(0, rawTarget - miniPlayerPulseBaseline);
      var transient = clampRange(contrast / Math.max(0.08, miniPlayerPulseBaseline * 0.36), 0, 1);
      target = clampRange(rawTarget * 0.22 + transient * 0.78, 0, 1);
    }
  } catch (e) {}
  miniPlayerPulseSample += (target - miniPlayerPulseSample) * (target > miniPlayerPulseSample ? 0.42 : 0.20);
  pushMiniPlayerState(false, true);
  miniPlayerPulseTimer = setTimeout(runMiniPlayerPulseTimer, 80);
}

/**
 * 根据隐藏窗口和播放状态启停迷你播放器频谱定时器，并衰减短期律动基线。
 * @returns {void}
 */
function syncMiniPlayerPulseTimer() {
  if (!miniPlayerPulseTimerActive()) {
    stopMiniPlayerPulseTimer();
    miniPlayerPulseSample *= 0.82;
    miniPlayerPulseBaseline *= 0.82;
    return;
  }
  if (!miniPlayerPulseTimer) miniPlayerPulseTimer = setTimeout(runMiniPlayerPulseTimer, 0);
}

/**
 * 按失败补丁字段失效迷你播放器同步缓存。旧请求失败也必须保留下一次重发机会。
 * @param {object} patch 未被主进程确认的状态补丁。
 * @returns {void}
 */
function invalidateMiniPlayerSyncPatch(patch) {
  var state = miniPlayerSyncState;
  if (!state || !patch) return;
  if (Object.prototype.hasOwnProperty.call(patch, 'metaSignature') ||
      Object.prototype.hasOwnProperty.call(patch, 'title') ||
      Object.prototype.hasOwnProperty.call(patch, 'artist') ||
      Object.prototype.hasOwnProperty.call(patch, 'cover')) {
    state.song = null;
    state.metaSignature = '';
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'playing')) state.playing = null;
  if (Object.prototype.hasOwnProperty.call(patch, 'hasTrack')) state.hasTrack = null;
  if (Object.prototype.hasOwnProperty.call(patch, 'pulse')) state.pulse = null;
  if (Object.prototype.hasOwnProperty.call(patch, 'visual')) state.visualSignature = '';
  if (Object.prototype.hasOwnProperty.call(patch, 'themeVars')) state.themeSignature = null;
  if (Object.prototype.hasOwnProperty.call(patch, 'miniPlayerMode')) state.miniPlayerMode = null;
}

/**
 * 取要转发给迷你播放器的主题变量：只挑 --th-* 那一族。
 * 迷你窗口用不到主窗口专用变量，少发一点也少一份可猜的攻击面。
 * @returns {{vars: Object<string,string>, signature: string}} 变量表与稳定签名。
 */
function miniPlayerThemePayload() {
  var vars = {};
  var api = window.StellaflixPlugins;
  var source = api && typeof api.themeVars === 'function' ? api.themeVars() : null;
  var keys = source ? Object.keys(source) : [];
  keys.sort();
  var signature = '';
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].indexOf('--th-') !== 0) continue;
    vars[keys[i]] = source[keys[i]];
    signature += keys[i] + ':' + source[keys[i]] + '|';
  }
  return { vars: vars, signature: signature };
}

/**
 * 生成极简外壳所需的歌曲元数据，不读取或复制完整封面。
 * 极简窗口没有封面消费者，标题/歌手变化仍需同步，但不应为了它触碰大封面 data URL。
 * @param {object|null} song 当前歌曲对象。
 * @returns {{title:string, artist:string, cover:string, _signature:string}} 不含封面的元数据。
 */
function miniPlayerSongMetaWithoutCover(song) {
  var title = song && (song.name || song.title) || 'Stellaflix';
  var artist = song && (song.artist || song.ar || song.author) || '';
  return {
    title: String(title),
    artist: String(artist),
    cover: '',
    _signature: String(title) + '|' + String(artist)
  };
}

function normalizeDesktopMiniPlayerMode(value) {
  return value === 'compact' ? 'compact' : 'standard';
}

/**
 * 将迷你播放器状态按字段增量同步到主进程。歌曲或播放状态未变化时不产生 IPC。
 * @param {boolean=} force 是否强制发送完整状态。
 * @param {boolean=} playbackOnly 是否只检查播放状态；首次同步或歌曲对象变化时仍自动补齐元数据。
 * @returns {void}
 */
function pushMiniPlayerState(force, playbackOnly) {
  var api = typeof getDesktopWindowApi === 'function' ? getDesktopWindowApi() : window.desktopWindow;
  if (!api || typeof api.updateMiniPlayer !== 'function') return;
  if (typeof currentDesktopSongMeta !== 'function') return;
  var song = typeof playQueue !== 'undefined' && playQueue && currentIdx >= 0 ? playQueue[currentIdx] : null;
  var hasTrack = !!song;
  var isPlaying = !!(hasTrack && audio && audio.src && !audio.paused && !audio.ended);
  var miniPlayerMode = fx.miniPlayerMode === 'compact' ? 'compact' : 'standard';
  var includeMiniPlayerCover = miniPlayerMode === 'standard';
  var state = miniPlayerSyncState || (miniPlayerSyncState = {
    song: null,
    metaSignature: '',
    playing: null,
    hasTrack: null,
    desktopLyrics: null,
    pulse: null,
    visualSignature: '',
    themeSignature: null,
    miniPlayerMode: null
  });
  var modeChanged = state.miniPlayerMode !== miniPlayerMode;
  state.miniPlayerMode = miniPlayerMode;
  var resolveMetadata = !!(hasTrack && (force || !playbackOnly || state.song !== song || !state.metaSignature || (modeChanged && includeMiniPlayerCover)));
  var meta = resolveMetadata
    ? (includeMiniPlayerCover ? currentDesktopSongMeta() : miniPlayerSongMetaWithoutCover(song))
    : null;
  var metaSignature = hasTrack
    ? (resolveMetadata
      ? String(meta && (meta._signature || ((meta.title || '') + '|' + (meta.artist || '') + '|' + (meta.cover || ''))) || '')
      : state.metaSignature)
    : '';
  if (resolveMetadata || !hasTrack) state.song = song;
  var patch = {};
  var changed = false;
  if (force || state.metaSignature !== metaSignature || (modeChanged && includeMiniPlayerCover)) {
    state.metaSignature = metaSignature;
    patch.metaSignature = metaSignature;
    patch.title = hasTrack && meta && meta.title || 'Stellaflix';
    patch.artist = hasTrack && meta && meta.artist || '';
    if (includeMiniPlayerCover) patch.cover = hasTrack && meta && meta.cover || '';
    changed = true;
  }
  if (force || modeChanged) {
    patch.miniPlayerMode = miniPlayerMode;
    changed = true;
  }
  if (force || state.playing !== isPlaying) {
    state.playing = isPlaying;
    patch.playing = isPlaying;
    changed = true;
  }
  if (force || state.hasTrack !== hasTrack) {
    state.hasTrack = hasTrack;
    patch.hasTrack = hasTrack;
    changed = true;
  }
  var desktopLyricsEnabled = !!fx.desktopLyrics && !isDevelopmentLockedFx('desktopLyrics');
  if (force || state.desktopLyrics !== desktopLyricsEnabled) {
    state.desktopLyrics = desktopLyricsEnabled;
    patch.desktopLyrics = desktopLyricsEnabled;
    changed = true;
  }
  // R4：uiLanguage 字段整段删除 —— pill 页面已不再读取，payload 不再发送。
  // 主题只在非纯播放推送时对账：播放进度那条路径每 74ms 就来一次，没必要每次重算变量签名。
  if (force || !playbackOnly) {
    var theme = miniPlayerThemePayload();
    if (force || state.themeSignature !== theme.signature) {
      state.themeSignature = theme.signature;
      patch.themeVars = theme.vars;
      changed = true;
    }
  }
  var visual = miniPlayerVisualPayload();
  var visualSignature = JSON.stringify(visual);
  var now = performance.now();
  var pulsePipelineActive = typeof miniPlayerPulsePipelineActive !== 'function' || miniPlayerPulsePipelineActive();
  if (!pulsePipelineActive) {
    stopMiniPlayerPulseTimer();
    miniPlayerPulseSample = 0;
    miniPlayerPulseBaseline = 0;
  }
  var pulse = pulsePipelineActive ? miniPlayerPulseValue() : 0;
  var pulseChanged = state.pulse == null || Math.abs(state.pulse - pulse) >= 0.012;
  if (pulsePipelineActive && (force || (now - miniPlayerPulseLastAt >= 74 && pulseChanged))) {
    state.pulse = pulse;
    miniPlayerPulseLastAt = now;
    patch.pulse = pulse;
    changed = true;
  }
  if (force || state.visualSignature !== visualSignature) {
    state.visualSignature = visualSignature;
    patch.visual = visual;
    changed = true;
  }
  if (!changed) return;
  api.updateMiniPlayer(patch).then(function (result) {
    if (!result || result.ok !== true) invalidateMiniPlayerSyncPatch(patch);
  }, function () {
    invalidateMiniPlayerSyncPatch(patch);
  });
}

function applyMiniPlayerVisualControls() {
  var pulse = document.getElementById('fx-miniplayerpulse');
  var glow = document.getElementById('fx-miniplayerglow');
  var radius = document.getElementById('fx-miniplayerradius');
  if (pulse) pulse.value = clampRange(fx.miniPlayerPulseStrength == null ? fxDefaults.miniPlayerPulseStrength : Number(fx.miniPlayerPulseStrength), 0, MINI_PLAYER_EFFECT_STRENGTH_MAX);
  if (glow) glow.value = clampRange(fx.miniPlayerGlowStrength == null ? fxDefaults.miniPlayerGlowStrength : Number(fx.miniPlayerGlowStrength), 0, MINI_PLAYER_EFFECT_STRENGTH_MAX);
  if (radius) radius.value = clampRange(fx.miniPlayerRadius == null ? fxDefaults.miniPlayerRadius : Number(fx.miniPlayerRadius), 4, 22);
  var pulseOut = pulse && pulse.parentElement && pulse.parentElement.querySelector('output');
  var glowOut = glow && glow.parentElement && glow.parentElement.querySelector('output');
  var radiusOut = radius && radius.parentElement && radius.parentElement.querySelector('output');
  if (pulseOut) pulseOut.textContent = Number(pulse.value).toFixed(2);
  if (glowOut) glowOut.textContent = Number(glow.value).toFixed(2);
  if (radiusOut) radiusOut.textContent = Math.round(Number(radius.value)) + 'px';
  var toggleMap = [
    ['t-miniPlayer', fx.miniPlayerEnabled !== false],
    ['t-miniPlayerPulse', fx.miniPlayerPulseEnabled !== false],
    ['t-miniPlayerGlow', fx.miniPlayerGlowEnabled !== false],
    ['t-miniPlayerHover', fx.miniPlayerHoverExpand !== false]
  ];
  toggleMap.forEach(function (item) {
    var button = document.getElementById(item[0]);
    if (button) button.classList.toggle('on', item[1]);
  });
  var activeMode = fx.miniPlayerMode === 'compact' ? 'compact' : 'standard';
  document.querySelectorAll('#mini-player-mode-seg [data-mini-player-mode]').forEach(function (button) {
    button.classList.toggle('active', button.getAttribute('data-mini-player-mode') === activeMode);
  });
  var hoverExpandEnabled = fx.miniPlayerHoverExpand !== false;
  var hoverButton = document.getElementById('t-miniPlayerHover');
  var hoverState = document.getElementById('mini-player-collapse-state');
  if (hoverButton) {
    hoverButton.setAttribute('aria-pressed', hoverExpandEnabled ? 'true' : 'false');
    hoverButton.title = hoverExpandEnabled
      ? '自动收回已开启：离开完整面板后回到封面；点击可保持完整迷你播放器'
      : '自动收回已关闭：迷你播放器保持完整面板；点击可恢复封面自动收回';
  }
  if (hoverState) hoverState.textContent = hoverExpandEnabled ? '开启' : '关闭';
  syncMiniPlayerPulseTimer();
}

function toggleMiniPlayerVisual(key) {
  if (!Object.prototype.hasOwnProperty.call({ pulseEnabled: 1, glowEnabled: 1, hoverExpand: 1 }, key)) return;
  fx['miniPlayer' + key.charAt(0).toUpperCase() + key.slice(1)] = !fx['miniPlayer' + key.charAt(0).toUpperCase() + key.slice(1)];
  applyMiniPlayerVisualControls();
  saveLyricLayout({ user: true, reason: 'miniPlayer' + key.charAt(0).toUpperCase() + key.slice(1) });
  pushMiniPlayerState(true);
}

/**
 * R5：开关持久化从 desktopShellSettings.miniPlayer 改挂 fx.miniPlayerEnabled，
 * 主进程仍负责 pill 窗口生命周期；回包与期望不符时像 coverWallpaper 一样回滚 UI。
 * @param {string} key 目前只接受 'miniPlayer'。
 * @returns {void}
 */
function toggleMiniPlayerSetting(key) {
  if (key !== 'miniPlayer') return;
  var api = window.desktopWindow;
  if (!api || !api.isDesktop || typeof api.setMiniPlayerEnabled !== 'function') return;
  var miniPlayerNext = fx.miniPlayerEnabled === false;
  api.setMiniPlayerEnabled(miniPlayerNext).then(function (result) {
    var enabled = !!(result && result.ok === true && result.miniPlayerEnabled);
    if (enabled !== miniPlayerNext) {
      applyMiniPlayerVisualControls();
      showToast('迷你播放器设置失败');
      return;
    }
    fx.miniPlayerEnabled = enabled;
    applyMiniPlayerVisualControls();
    saveLyricLayout({ user: true, reason: 'miniPlayerEnabled' });
    // 主进程禁用时会释放状态缓存，重新启用必须绕过判重补齐完整状态。
    pushMiniPlayerState(true);
    showToast(enabled ? '最小化迷你播放器已开启' : '最小化迷你播放器已关闭');
  }).catch(function () {
    applyMiniPlayerVisualControls();
    showToast('迷你播放器设置失败');
  });
}

/**
 * R5：样式切换从 desktopShellSettings.miniPlayerMode 改挂 fx.miniPlayerMode；
 * 主进程确认成功后才落 fx 并持久化，失败回滚分段按钮态。
 * @param {string} mode 'standard' | 'compact'。
 * @returns {void}
 */
function setDesktopMiniPlayerMode(mode) {
  var api = window.desktopWindow;
  var nextMode = normalizeDesktopMiniPlayerMode(mode);
  if (!api || !api.isDesktop || typeof api.setMiniPlayerMode !== 'function') return;
  if (nextMode === normalizeDesktopMiniPlayerMode(fx.miniPlayerMode)) return;
  var previousMode = normalizeDesktopMiniPlayerMode(fx.miniPlayerMode);
  api.setMiniPlayerMode(nextMode).then(function (result) {
    if (!result || result.ok !== true) throw new Error('MINI_PLAYER_MODE_REJECTED');
    fx.miniPlayerMode = normalizeDesktopMiniPlayerMode(result.miniPlayerMode);
    applyMiniPlayerVisualControls();
    saveLyricLayout({ user: true, reason: 'miniPlayerMode' });
    pushMiniPlayerState(true);
    showToast(fx.miniPlayerMode === 'compact' ? '已切换到极简迷你播放器' : '已切换到标准迷你播放器');
  }).catch(function () {
    fx.miniPlayerMode = previousMode;
    applyMiniPlayerVisualControls();
    showToast('迷你播放器样式切换失败');
  });
}

// —— 主界面收缩到迷你播放器的过渡（源 :45889-46061）——
// 动画只作用于 #desktop-window-shell 的变换与不透明度，布局、CSS 变量和交互入口一律不动；
// 动画结束必须无过渡地复位，避免下次恢复出现回弹。
// 收缩必须先跑完再交给系统最小化：外壳淡到全透明后系统那段最小化动画就没有可见内容可动，
// 两段动作才接得上；若在外壳还看得见时就最小化，用户看到的仍然是熟悉的原生最小化。
var miniCollapseState = {
  active: false, token: 0, actionTimer: 0, resetTimer: 0,
  prewarmTimer: 0, prewarmAt: 0, originApplied: false, pendingOrigin: null,
};
var MINI_COLLAPSE_ACTION_DELAY = 240;
var MINI_COLLAPSE_RESET_DELAY = 300;
var MINI_COLLAPSE_PREWARM_DWELL = 90;
var MINI_COLLAPSE_PREWARM_THROTTLE = 900;

/** @returns {boolean} 系统要求降低动效时返回 true。 */
function prefersReducedMiniCollapseMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/**
 * 判断当前是否该走收缩过渡。迷你播放器关闭、非桌面壳或全屏状态下一律保持原生最小化。
 * @returns {boolean} 允许收缩过渡时返回 true。
 */
function miniCollapseAvailable() {
  var api = window.desktopWindow;
  if (!api || typeof api.minimize !== 'function') return false;
  if (!document.body.classList.contains('desktop-shell')) return false;
  if (fx.miniPlayerEnabled === false) return false;
  // 源用 fullscreenTransitionState/isFullscreenUiActive；Stellaflix 无该状态机，改查桌面/文档全屏两处现存标记。
  if ((typeof desktopFullscreenActive !== 'undefined' && desktopFullscreenActive) ||
      (typeof documentFullscreenActive !== 'undefined' && documentFullscreenActive) ||
      (typeof document !== 'undefined' && !!document.fullscreenElement)) return false;
  return true;
}

/**
 * 把主进程回传的归一化迷你窗口中心写成收缩动画原点，让主界面朝迷你播放器实际角落收拢。
 * transform-origin 不参与过渡，收缩进行中改原点会让外壳当帧掉头，所以过渡期间只缓存，收尾时再落地。
 * @param {{x?: number, y?: number}=} origin 归一化原点，取值范围 -0.6 ~ 1.6。
 * @returns {void}
 */
function applyMiniCollapseOrigin(origin) {
  if (!origin) return;
  var x = Number(origin.x);
  var y = Number(origin.y);
  if (!isFinite(x) || !isFinite(y)) return;
  x = Math.max(-0.6, Math.min(1.6, x));
  y = Math.max(-0.6, Math.min(1.6, y));
  if (miniCollapseState.active) {
    miniCollapseState.pendingOrigin = { x: x, y: y };
    return;
  }
  miniCollapseState.pendingOrigin = null;
  miniCollapseState.originApplied = true;
  document.documentElement.style.setProperty('--mini-collapse-x', (x * 100).toFixed(2) + '%');
  document.documentElement.style.setProperty('--mini-collapse-y', (y * 100).toFixed(2) + '%');
}

/**
 * 清除收缩过渡的指定定时器。
 * @param {'actionTimer'|'resetTimer'|'prewarmTimer'} name 定时器字段名。
 * @returns {void}
 */
function clearMiniCollapseTimer(name) {
  var timer = miniCollapseState[name];
  if (timer) clearTimeout(timer);
  miniCollapseState[name] = 0;
}

/**
 * 请求主进程预热迷你窗口并记下收缩动画原点。
 * 迷你 renderer 的启动比收缩动画长，越早预热留下的空白越短。
 * @param {boolean=} immediate 点击最小化时传 true，跳过节流确保这一次一定预热。
 * @returns {void}
 */
function requestMiniCollapsePrewarm(immediate) {
  var api = window.desktopWindow;
  if (!api || typeof api.prepareMiniPlayerTransition !== 'function') return;
  var now = Date.now();
  if (!immediate && miniCollapseState.prewarmAt && now - miniCollapseState.prewarmAt < MINI_COLLAPSE_PREWARM_THROTTLE) return;
  miniCollapseState.prewarmAt = now;
  var pending;
  try {
    pending = api.prepareMiniPlayerTransition();
  } catch (_e) {
    return;
  }
  if (!pending || typeof pending.then !== 'function') return;
  // 原点只取决于两个窗口的位置，悬停时算出来和点击时算出来一致；点击那次的回包必然迟于起画，
  // 由 applyMiniCollapseOrigin 缓存到收尾时落地，下一次收缩就有准确原点。
  pending.then(function (result) {
    if (result && result.origin) applyMiniCollapseOrigin(result.origin);
  }).catch(function () {});
}

/**
 * 悬停或聚焦最小化按钮时排一次预热。短暂划过按钮不触发，避免无谓建窗口。
 * @returns {void}
 */
function armMiniCollapsePrewarm() {
  if (miniCollapseState.active || miniCollapseState.prewarmTimer) return;
  if (!miniCollapseAvailable()) return;
  miniCollapseState.prewarmTimer = setTimeout(function () {
    miniCollapseState.prewarmTimer = 0;
    if (miniCollapseState.active || !miniCollapseAvailable()) return;
    requestMiniCollapsePrewarm(false);
  }, MINI_COLLAPSE_PREWARM_DWELL);
}

/**
 * 指针离开或失焦时撤掉还没落地的预热排期。已经建好的预热窗口由主进程 TTL 回收。
 * @returns {void}
 */
function cancelMiniCollapsePrewarm() {
  clearMiniCollapseTimer('prewarmTimer');
}

/**
 * 结束收缩过渡并无过渡复位外壳。最小化已经落地时窗口不可见，复位不会被用户看到。
 * @param {number} token 本轮过渡令牌。
 * @returns {void}
 */
function finishMiniCollapse(token) {
  if (token !== miniCollapseState.token) return;
  clearMiniCollapseTimer('actionTimer');
  clearMiniCollapseTimer('resetTimer');
  miniCollapseState.active = false;
  document.body.classList.add('mini-collapse-reset');
  document.body.classList.remove('mini-collapsing', 'mini-collapse-run');
  void document.body.offsetWidth;
  document.body.classList.remove('mini-collapse-reset');
  // 过渡期间缓存下来的原点在这里落地：此刻外壳已经复位且窗口不可见，改原点看不出来。
  if (miniCollapseState.pendingOrigin) applyMiniCollapseOrigin(miniCollapseState.pendingOrigin);
}

/**
 * 最小化到迷你播放器。先预热迷你窗口消除冷启动空白（悬停已经预热过时这里只做补漏），
 * 再让主界面朝迷你角落收拢，收缩到位后才交给系统最小化，两段动作接成一次连续过渡。
 * 迷你播放器关闭、非桌面壳或全屏状态下返回 false，由调用方回退原生最小化动画，不做任何视觉改动。
 * @returns {boolean} 本轮收缩是否由迷你播放器过渡接管。
 */
function collapseToMiniPlayer() {
  var api = window.desktopWindow;
  if (!api || typeof api.minimize !== 'function') return false;
  if (miniCollapseState.active) return true;
  cancelMiniCollapsePrewarm();
  if (!miniCollapseAvailable()) return false;
  var token = ++miniCollapseState.token;
  miniCollapseState.active = true;
  requestMiniCollapsePrewarm(true);
  var reduced = prefersReducedMiniCollapseMotion();
  document.body.classList.remove('mini-collapse-reset', 'mini-collapse-run');
  document.body.classList.add('mini-collapsing');
  void document.body.offsetWidth;
  document.body.classList.add('mini-collapse-run');
  miniCollapseState.actionTimer = setTimeout(function () {
    miniCollapseState.actionTimer = 0;
    var result;
    try {
      result = api.minimize();
    } catch (_e) {
      finishMiniCollapse(token);
      return;
    }
    if (result && typeof result.catch === 'function') {
      result.catch(function () { finishMiniCollapse(token); });
    }
    clearMiniCollapseTimer('resetTimer');
    miniCollapseState.resetTimer = setTimeout(function () {
      finishMiniCollapse(token);
    }, reduced ? 60 : MINI_COLLAPSE_RESET_DELAY);
  }, reduced ? 20 : MINI_COLLAPSE_ACTION_DELAY);
  return true;
}

/**
 * 处理主进程发给主 renderer 的迷你播放器控制或状态重同步命令。
 * @param {{action?: string}=} payload 命令载荷。
 * @returns {void}
 */
function handleDesktopMiniPlayerCommand(payload) {
  var action = payload && payload.action;
  // 主进程禁用时会释放状态缓存，重新启用必须绕过 renderer 判重补齐完整状态。
  if (action === 'sync-state') pushMiniPlayerState(true);
  else if (action === 'toggle-play') togglePlay();
  else if (action === 'previous') prevTrack();
  else if (action === 'next') nextTrack();
  else if (action === 'toggle-desktop-lyrics') toggleFx('desktopLyrics');
  else if (action === 'exit-wallpaper') {
    // pill 右键「关闭壁纸模式」：主进程已唤回主窗，这里只负责关掉壁纸层并落盘。
    fx.coverWallpaper = false;
    updateFxInputs();
    saveLyricLayout({ user: true, reason: 'miniPlayerExitWallpaper' });
    Promise.resolve(applyCoverWallpaperState(true)).catch(function () {});
  }
}

// —— 桌面壳注册块（源 initDesktopWindowShell :46089-46096, 46128-46144, 46157-46159）——
(function initMiniPlayerRendererShell() {
  var api = window.desktopWindow;
  if (!api || !api.isDesktop) return;
  pushMiniPlayerState(true);
  syncMiniPlayerPulseTimer();
  if (typeof api.onMiniPlayerCommand === 'function') {
    api.onMiniPlayerCommand(handleDesktopMiniPlayerCommand);
  }
  document.querySelectorAll('#mini-player-mode-seg [data-mini-player-mode]').forEach(function (button) {
    button.addEventListener('click', function () {
      setDesktopMiniPlayerMode(button.getAttribute('data-mini-player-mode'));
    });
  });
  document.querySelectorAll('[data-window-action]').forEach(function (btn) {
    // 悬停最小化按钮就开始预热迷你窗口。迷你 renderer 的启动比收缩动画长，
    // 只在点击时预热仍会留下空白，悬停这段时间正好用来跑完启动。
    if (btn.getAttribute('data-window-action') !== 'minimize') return;
    btn.addEventListener('pointerenter', armMiniCollapsePrewarm);
    btn.addEventListener('pointerleave', cancelMiniCollapsePrewarm);
    btn.addEventListener('focus', armMiniCollapsePrewarm);
    btn.addEventListener('blur', cancelMiniCollapsePrewarm);
  });
})();
