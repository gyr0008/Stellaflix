// ============================================================
// 音量均衡（ReplayGain）—— 参照 Mineradio-2.5.1 app.js 移植。
// 读文件里的整轨/整专辑增益标签，叠加 Preamp 后写进独立的 replayGainNode，
// 节点挂在 analyser 之后：可视化仍取原始电平，音量与淡入淡出继续由 gainNode 独占。
// 与参照库的有意偏差（本仓没有对应设施，勿当成漏搬）：
//   · 解析出的增益不回写缓存（参照库 scheduleLocalAssetCacheWrite）：同一首重启后按需重解析一次。
//   · 落盘走本仓 localStorage 惯例；全仓不存在 setPersistentLocalStorageItem，引用它只会得到运行期 ReferenceError。
//   · 「仍在播同一首」用 queueItemKey 判定（参照库 isCurrentLocalQueueSong 未随迁）。
//   · 提示文案去掉参照库的英文分支（本仓没有 uiLanguage 体系）。
// ============================================================
var REPLAY_GAIN_PREAMP_MIN = -12;
var REPLAY_GAIN_PREAMP_MAX = 12;
var REPLAY_GAIN_MIN_LINEAR = 0.05;
var REPLAY_GAIN_MAX_LINEAR = 4;
var REPLAY_GAIN_RAMP_SECONDS = 0.08;
var REPLAY_GAIN_STORE_KEY = 'stellaflix-replay-gain-v1';
var replayGainSettings = { enabled: false, mode: 'track', preampDb: 0, clipGuard: true };
var replayGainActive = { linear: 1, source: 'off', gainDb: 0, appliedDb: 0, clipped: false, peak: 0 };

/**
 * 归一化音量均衡设置，容错旧值与越界输入。
 * @param {object} raw 原始设置对象。
 * @returns {{enabled:boolean,mode:string,preampDb:number,clipGuard:boolean}} 归一化设置。
 */
function normalizeReplayGainSettings(raw) {
  var input = raw && typeof raw === 'object' ? raw : {};
  var preamp = Number(input.preampDb);
  if (!isFinite(preamp)) preamp = 0;
  return {
    enabled: !!input.enabled,
    mode: input.mode === 'album' ? 'album' : 'track',
    preampDb: Math.round(clampRange(preamp, REPLAY_GAIN_PREAMP_MIN, REPLAY_GAIN_PREAMP_MAX) * 10) / 10,
    clipGuard: input.clipGuard !== false,
  };
}

/**
 * 读取已保存的音量均衡设置。
 * @returns {{enabled:boolean,mode:string,preampDb:number,clipGuard:boolean}} 归一化设置。
 */
function readSavedReplayGainSettings() {
  try {
    var text = localStorage.getItem(REPLAY_GAIN_STORE_KEY);
    return normalizeReplayGainSettings(text ? JSON.parse(text) : null);
  } catch (_e) {
    return normalizeReplayGainSettings(null);
  }
}

/**
 * 落盘音量均衡设置。
 * @returns {void}
 */
function writeReplayGainSettings() {
  try {
    localStorage.setItem(REPLAY_GAIN_STORE_KEY, JSON.stringify(replayGainSettings));
  } catch (_e) { }
}

/**
 * 计算某首歌应当施加的均衡增益。没有可用标签时保持原始电平，不做任何猜测性放大。
 * @param {object} info 歌曲上的 ReplayGain 信息。
 * @param {object} settings 音量均衡设置。
 * @returns {{linear:number,source:string,gainDb:number,appliedDb:number,clipped:boolean,peak:number}} 增益解析结果。
 */
function resolveReplayGain(info, settings) {
  var conf = normalizeReplayGainSettings(settings);
  var idle = { linear: 1, source: 'off', gainDb: 0, appliedDb: 0, clipped: false, peak: 0 };
  if (!conf.enabled) return idle;
  var data = info && typeof info === 'object' ? info : null;
  if (!data) { idle.source = 'none'; return idle; }
  var trackGain = typeof data.trackGainDb === 'number' && isFinite(data.trackGainDb) ? data.trackGainDb : null;
  var albumGain = typeof data.albumGainDb === 'number' && isFinite(data.albumGainDb) ? data.albumGainDb : null;
  // 专辑模式缺少整专辑增益时回退到整轨增益，反之同理；两者都没有就当作无标签。
  var useAlbum = conf.mode === 'album' ? albumGain != null : (trackGain == null && albumGain != null);
  var gainDb = useAlbum ? albumGain : trackGain;
  if (gainDb == null) { idle.source = 'none'; return idle; }
  var peakRaw = useAlbum
    ? (typeof data.albumPeak === 'number' ? data.albumPeak : data.trackPeak)
    : (typeof data.trackPeak === 'number' ? data.trackPeak : data.albumPeak);
  var peak = typeof peakRaw === 'number' && isFinite(peakRaw) && peakRaw > 0 ? peakRaw : 0;
  var linear = Math.pow(10, (gainDb + conf.preampDb) / 20);
  var clipped = false;
  // 防削波按峰值封顶：峰值标签缺失时无从判断，与 foobar2000 一致不做额外衰减。
  if (conf.clipGuard && peak > 0) {
    var maxLinear = 1 / peak;
    if (linear > maxLinear) {
      linear = maxLinear;
      clipped = true;
    }
  }
  linear = clampRange(linear, REPLAY_GAIN_MIN_LINEAR, REPLAY_GAIN_MAX_LINEAR);
  return {
    linear: linear,
    source: useAlbum ? 'album' : 'track',
    gainDb: gainDb,
    appliedDb: Math.round(Math.log(linear) / Math.LN10 * 200) / 10,
    clipped: clipped,
    peak: peak,
  };
}

/**
 * 把解析出的线性增益写入均衡节点，默认用短斜坡避免切换设置时爆音。
 * @param {number} linear 线性增益。
 * @param {boolean=} immediate 是否立即生效。
 * @returns {void}
 */
function setReplayGainNodeGain(linear, immediate) {
  var value = clampRange(Number(linear) || 1, REPLAY_GAIN_MIN_LINEAR, REPLAY_GAIN_MAX_LINEAR);
  if (!replayGainNode || !replayGainNode.gain) return;
  if (!audioCtx || immediate) {
    replayGainNode.gain.value = value;
    return;
  }
  var now = audioCtx.currentTime || 0;
  replayGainNode.gain.cancelScheduledValues(now);
  replayGainNode.gain.setValueAtTime(replayGainNode.gain.value, now);
  replayGainNode.gain.linearRampToValueAtTime(value, now + REPLAY_GAIN_RAMP_SECONDS);
}

/**
 * 按当前设置为指定歌曲应用均衡增益。
 * @param {object} song 歌曲（在线曲或空值会回到原始电平）。
 * @param {{immediate?:boolean}=} opts 是否立即生效。
 * @returns {object} 增益解析结果。
 */
function applyReplayGainForCurrentSong(song, opts) {
  var resolved = resolveReplayGain(song && song.localReplayGain, replayGainSettings);
  replayGainActive = resolved;
  setReplayGainNodeGain(resolved.linear, !!(opts && opts.immediate));
  return resolved;
}

/**
 * 为播放中的歌曲惰性补齐 ReplayGain 标签：老缓存记录没有该字段时只在开关打开后解析一次。
 * @param {object} song 本地歌曲。
 * @returns {Promise<object|null>} ReplayGain 信息；无标签时为 null。
 */
async function ensureLocalReplayGainForSong(song) {
  if (!song || song.type !== 'local' || !song.localFile) return null;
  if (song.localReplayGain) return song.localReplayGain;
  if (song.localReplayGainResolved) return null;
  if (song.localReplayGainPromise) return song.localReplayGainPromise;
  song.localReplayGainPromise = (async function () {
    try {
      // 已有元数据解析在跑就复用它的结果，避免同一文件被读两遍。
      if (song.localMetadataPromise) await song.localMetadataPromise;
      if (song.localReplayGain) return song.localReplayGain;
      var tags = await extractLocalMetadataTags(song.localFile, {});
      if (tags && tags.replayGain) {
        song.localReplayGain = tags.replayGain;
        // 解析一次就落库，下次重启直接用水合回来的值，不再重读文件（参照库 scheduleLocalAssetCacheWrite 的落点）。
        persistLocalReplayGainAsset(song);
        return song.localReplayGain;
      }
      song.localReplayGainResolved = true;
      return null;
    } catch (e) {
      console.warn('[ReplayGain]', song && song.name, e);
      return null;
    } finally {
      song.localReplayGainPromise = null;
    }
  })();
  return song.localReplayGainPromise;
}

/**
 * 切歌时准备均衡增益：先用已知标签立即生效，再在需要时补齐标签并重新应用。
 * @param {object} song 本地歌曲。
 * @param {number} token 切歌令牌，用于丢弃过期结果。
 * @returns {void}
 */
function prepareReplayGainForSong(song, token) {
  applyReplayGainForCurrentSong(song, { immediate: true });
  if (!replayGainSettings.enabled || !song || song.localReplayGain) return;
  /**
   * 标签补齐后重新应用增益，仅在仍播放同一首时生效。
   * @returns {void}
   */
  function reapplyResolvedReplayGain() {
    if (token !== trackSwitchToken) return;
    if (!currentLocalSong || queueItemKey(currentLocalSong) !== queueItemKey(song)) return;
    applyReplayGainForCurrentSong(song);
    updateReplayGainControls();
  }
  ensureLocalReplayGainForSong(song).then(reapplyResolvedReplayGain, reapplyResolvedReplayGain);
}

/**
 * 生成音量均衡说明文案，顺带回报当前歌曲的实际增益结果。
 * @returns {string} 说明文案。
 */
function replayGainHintText() {
  if (!replayGainSettings.enabled) return '关闭时按文件原始电平播放，不做任何增益修正。';
  var modeText = replayGainSettings.mode === 'album' ? '整专辑增益（Album）' : '整轨增益（Track）';
  if (replayGainActive.source === 'none') return modeText + '：当前歌曲没有 ReplayGain 标签，保持原始电平。';
  if (replayGainActive.source === 'off') return modeText + '：等待歌曲标签解析。';
  var suffix = replayGainActive.clipped ? '，已按峰值防削波封顶' : '';
  return modeText + '：当前实际增益 ' + (replayGainActive.appliedDb > 0 ? '+' : '') + replayGainActive.appliedDb.toFixed(1) + ' dB' + suffix + '。';
}

/**
 * 同步音量均衡设置区的开关、模式分段按钮、Preamp 滑杆与说明文案。
 * @returns {void}
 */
function updateReplayGainControls() {
  var master = document.getElementById('t-replayGain');
  if (master) master.classList.toggle('on', replayGainSettings.enabled);
  var clipGuard = document.getElementById('t-replayGainClipGuard');
  if (clipGuard) clipGuard.classList.toggle('on', replayGainSettings.clipGuard);
  var buttons = document.querySelectorAll('#replaygain-mode-seg [data-replaygain-mode]');
  for (var i = 0; i < buttons.length; i++) {
    var button = buttons[i];
    var active = button.getAttribute('data-replaygain-mode') === replayGainSettings.mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  var slider = document.getElementById('rg-preamp');
  if (slider) {
    if (Number(slider.value) !== replayGainSettings.preampDb) slider.value = String(replayGainSettings.preampDb);
    var out = slider.parentNode ? slider.parentNode.querySelector('output') : null;
    if (out) out.textContent = (replayGainSettings.preampDb > 0 ? '+' : '') + replayGainSettings.preampDb.toFixed(1) + ' dB';
  }
  var hint = document.getElementById('replaygain-hint');
  if (hint) hint.textContent = replayGainHintText();
}

/**
 * 落盘音量均衡设置并按新设置立即重算当前歌曲增益。
 * @returns {void}
 */
function commitReplayGainSettings() {
  replayGainSettings = normalizeReplayGainSettings(replayGainSettings);
  writeReplayGainSettings();
  var song = currentLocalSong;
  if (replayGainSettings.enabled && song && !song.localReplayGain) prepareReplayGainForSong(song, trackSwitchToken);
  else applyReplayGainForCurrentSong(song);
  updateReplayGainControls();
}

/**
 * 切换音量均衡开关或防削波开关。
 * @param {string} key 设置名：`enabled` 或 `clipGuard`。
 * @returns {void}
 */
function toggleReplayGainSetting(key) {
  if (key !== 'enabled' && key !== 'clipGuard') return;
  replayGainSettings[key] = !replayGainSettings[key];
  commitReplayGainSettings();
  if (key === 'enabled') showToast(replayGainSettings.enabled ? '音量均衡: 开启' : '音量均衡: 关闭');
  else showToast(replayGainSettings.clipGuard ? '防削波: 开启' : '防削波: 关闭');
}

/**
 * 切换整轨 / 整专辑均衡模式。
 * @param {string} mode 目标模式。
 * @returns {void}
 */
function setReplayGainMode(mode) {
  var next = mode === 'album' ? 'album' : 'track';
  if (next === replayGainSettings.mode) return;
  replayGainSettings.mode = next;
  commitReplayGainSettings();
  showToast(next === 'album' ? '音量均衡: 整专辑' : '音量均衡: 整轨');
}

/**
 * 设置 Preamp 预增益。
 * @param {*} value 目标 dB 值。
 * @returns {void}
 */
function setReplayGainPreamp(value) {
  var next = Number(value);
  if (!isFinite(next)) return;
  replayGainSettings.preampDb = next;
  commitReplayGainSettings();
}

/**
 * 绑定音量均衡控件并同步初始状态。
 * @returns {void}
 */
function initReplayGainControls() {
  replayGainSettings = readSavedReplayGainSettings();
  var seg = document.getElementById('replaygain-mode-seg');
  if (seg) {
    seg.addEventListener('click', function (e) {
      var button = e.target && e.target.closest ? e.target.closest('[data-replaygain-mode]') : null;
      if (!button) return;
      e.preventDefault();
      setReplayGainMode(button.getAttribute('data-replaygain-mode'));
    });
  }
  var slider = document.getElementById('rg-preamp');
  if (slider) {
    slider.addEventListener('input', function () { setReplayGainPreamp(slider.value); });
  }
  applyReplayGainForCurrentSong(currentLocalSong, { immediate: true });
  updateReplayGainControls();
}
