function albumGaplessSongKey(song) {
  if (!song) return '';
  if (song.__albumGaplessKey) return String(song.__albumGaplessKey);
  var provider = normalizePlaybackProvider(songProviderKey(song));
  if (provider === 'qq') {
    var albumMid = song.albumMid || song.albummid || song.album_mid || '';
    return albumMid ? 'qq:' + albumMid : '';
  }
  if (provider === 'spotify') {
    var spotifyAlbumId = song.albumId || song.spotifyAlbumId || '';
    return spotifyAlbumId ? 'spotify:' + spotifyAlbumId : '';
  }
  if (provider === 'netease') {
    var albumId = song.albumId || song.album_id || '';
    return albumId ? 'netease:' + albumId : '';
  }
  if (provider === 'kugou') {
    var kugouAlbumId = song.albumId || song.album_id || '';
    return kugouAlbumId ? 'kugou:' + kugouAlbumId : '';
  }
  return '';
}

function albumGaplessCoverKey(song) {
  if (!song) return '';
  return String(song.customCover || song.cover || song.picUrl || song.albumCover || song.coverUrl || '').trim();
}

function albumGaplessSameAlbumCover(prevSong, nextSong) {
  var prevAlbum = albumGaplessSongKey(prevSong);
  var nextAlbum = albumGaplessSongKey(nextSong);
  if (!prevAlbum || prevAlbum !== nextAlbum) return false;
  var prevCover = albumGaplessCoverKey(prevSong);
  var nextCover = albumGaplessCoverKey(nextSong);
  return !!(prevCover && nextCover && prevCover === nextCover);
}

var ALBUM_GAPLESS_PREROLL_SECONDS = 8.5;
var ALBUM_GAPLESS_MIX_SECONDS = 0.72;
var ALBUM_GAPLESS_NEXT_ENTRY_FLOOR = 0.90;
var ALBUM_GAPLESS_NEXT_ATTACK_MS = 56;
var ALBUM_GAPLESS_ADOPT_SLEW_MS = 180;
var ALBUM_GAPLESS_GAIN_STEP_MS = 8;
var ALBUM_GAPLESS_BOUNDARY_RELEASE_SECONDS = ALBUM_GAPLESS_MIX_SECONDS;
var ALBUM_GAPLESS_MUTED_PREROLL_SECONDS = 1.05;
var ALBUM_GAPLESS_MIN_MIX_MS = 360;
var ALBUM_GAPLESS_BIND_AFTER_MIX_MS = 40;
var ALBUM_GAPLESS_SILENCE_HOLD_MS = 180;
var ALBUM_GAPLESS_FAST_SILENCE_HOLD_MS = 48;
var ALBUM_GAPLESS_LONG_SILENCE_SECONDS = 1.05;
var ALBUM_GAPLESS_SILENCE_LEVEL = 0.018;
var ALBUM_GAPLESS_DIRECT_SILENCE_RMS = 0.0065;
var ALBUM_GAPLESS_DEEP_SILENCE_RMS = 0.0032;
var ALBUM_GAPLESS_DIRECT_SILENCE_PEAK = 0.030;
var ALBUM_GAPLESS_DEEP_SILENCE_PEAK = 0.017;
var ALBUM_GAPLESS_RESIDUAL_FREQ_AVG = 0.010;
var ALBUM_GAPLESS_RESIDUAL_FREQ_PEAK = 0.075;
var ALBUM_GAPLESS_DIRECT_SILENCE_HOLD_MS = 112;
var ALBUM_GAPLESS_DEEP_SILENCE_HOLD_MS = 56;
var albumGaplessTailTimeData = null;
var albumGaplessTailFreqData = null;

function disposeAlbumGaplessPreload(preload) {
  if (!preload) return;
  if (preload) {
    if (preload.handoffTimer) clearTimeout(preload.handoffTimer);
    if (preload.cleanupTimer) clearTimeout(preload.cleanupTimer);
    if (preload.fadeFrame) cancelAnimationFrame(preload.fadeFrame);
    if (preload.fadeWatchdogTimer) clearInterval(preload.fadeWatchdogTimer);
    preload.fadeFrame = 0;
    preload.fadeWatchdogTimer = 0;
    preload.mixPending = false;
    preload.mixStarted = false;
    if (preload.fadeResolve) {
      var resolveFade = preload.fadeResolve;
      preload.fadeResolve = null;
      resolveFade(false);
    }
  }
  if (preload.previousAudio && preload.previousAudio === audio && preload.previousAudioOnEnded) {
    preload.previousAudio.onended = preload.previousAudioOnEnded;
  }
  if (preload && preload.media) {
    try {
      preload.media.pause();
      preload.media.removeAttribute('src');
      preload.media.load();
    } catch (e) { }
  }
}

function clearAlbumGaplessPreload(reason) {
  if (!albumGaplessState) return;
  albumGaplessState.serial++;
  if (albumGaplessState.monitorTimer) {
    clearInterval(albumGaplessState.monitorTimer);
    albumGaplessState.monitorTimer = 0;
  }
  var preload = albumGaplessState.preload;
  albumGaplessState.preload = null;
  disposeAlbumGaplessPreload(preload);
}

function restoreAlbumGaplessOutgoingIfCurrent(preload, durationMs) {
  if (
    !preload
    || preload.transitionToken !== trackSwitchToken
    || preload.transitionIndex !== currentIdx
    || !preload.previousAudio
    || preload.previousAudio !== audio
    || preload.previousAudio.paused
    || preload.previousAudio.ended
  ) return false;
  if (typeof rampAudioOutputGain === 'function') rampAudioOutputGain(targetVolume, Math.max(80, Number(durationMs) || 120));
  return true;
}

function albumGaplessDefaultEnabledForContext(context) {
  var albumKey = context && context.albumKey ? String(context.albumKey) : '';
  if (albumGaplessState && albumGaplessState.enabled && albumKey && albumGaplessState.albumKey === albumKey) return true;
  if (albumGaplessState && albumKey && albumGaplessState.disabledAlbumKey === albumKey) return false;
  return !albumGaplessState || albumGaplessState.defaultEnabled !== false;
}

function albumGaplessTailLevel() {
  return Math.max(
    Math.abs(Number(audioEnergy) || 0),
    Math.abs(Number(smoothEnergy) || 0),
    Math.abs(Number(bass) || 0) * 0.55,
    Math.abs(Number(mid) || 0) * 0.42,
    Math.abs(Number(treble) || 0) * 0.32
  );
}

function albumGaplessDirectTailSample() {
  if (!analyser || !audio || audio.paused) return null;
  try {
    var size = Math.max(32, Number(analyser.fftSize) || FFT_SIZE || 2048);
    if (!albumGaplessTailTimeData || albumGaplessTailTimeData.length !== size) {
      albumGaplessTailTimeData = new Uint8Array(size);
    }
    var freqSize = Math.max(16, Number(analyser.frequencyBinCount) || Math.floor(size / 2));
    if (!albumGaplessTailFreqData || albumGaplessTailFreqData.length !== freqSize) {
      albumGaplessTailFreqData = new Uint8Array(freqSize);
    }
    analyser.getByteTimeDomainData(albumGaplessTailTimeData);
    analyser.getByteFrequencyData(albumGaplessTailFreqData);
    var stride = Math.max(1, Math.floor(albumGaplessTailTimeData.length / 384));
    var sum = 0;
    var peak = 0;
    var count = 0;
    for (var i = 0; i < albumGaplessTailTimeData.length; i += stride) {
      var v = Math.abs((albumGaplessTailTimeData[i] - 128) / 128);
      sum += v * v;
      if (v > peak) peak = v;
      count++;
    }
    var freqStride = Math.max(1, Math.floor(albumGaplessTailFreqData.length / 256));
    var freqSum = 0;
    var freqPeak = 0;
    var freqCount = 0;
    for (var j = 0; j < albumGaplessTailFreqData.length; j += freqStride) {
      var f = albumGaplessTailFreqData[j] / 255;
      freqSum += f;
      if (f > freqPeak) freqPeak = f;
      freqCount++;
    }
    return {
      rms: Math.sqrt(sum / Math.max(1, count)),
      peak: peak,
      freqAvg: freqSum / Math.max(1, freqCount),
      freqPeak: freqPeak
    };
  } catch (e) {
    return null;
  }
}

function albumGaplessTailSilenceProbe(remaining) {
  if (!isFinite(remaining) || remaining > ALBUM_GAPLESS_PREROLL_SECONDS) {
    return { quiet: false, smoothedQuiet: false, directQuiet: false, deepQuiet: false, level: 1, rms: 1, peak: 1 };
  }
  var level = albumGaplessTailLevel();
  var sample = albumGaplessDirectTailSample();
  var rms = sample ? sample.rms : 1;
  var peak = sample ? sample.peak : 1;
  var freqAvg = sample ? sample.freqAvg : 1;
  var freqPeak = sample ? sample.freqPeak : 1;
  var deepQuiet = !!(sample && rms <= ALBUM_GAPLESS_DEEP_SILENCE_RMS && peak <= ALBUM_GAPLESS_DEEP_SILENCE_PEAK);
  var residualTail = !!(sample && !deepQuiet && (freqAvg > ALBUM_GAPLESS_RESIDUAL_FREQ_AVG || freqPeak > ALBUM_GAPLESS_RESIDUAL_FREQ_PEAK));
  var directQuiet = !!(sample && !residualTail && rms <= ALBUM_GAPLESS_DIRECT_SILENCE_RMS && peak <= ALBUM_GAPLESS_DIRECT_SILENCE_PEAK);
  var smoothedQuiet = level <= ALBUM_GAPLESS_SILENCE_LEVEL;
  return {
    quiet: smoothedQuiet || directQuiet,
    smoothedQuiet: smoothedQuiet,
    directQuiet: directQuiet,
    deepQuiet: deepQuiet,
    residualTail: residualTail,
    level: level,
    rms: rms,
    peak: peak,
    freqAvg: freqAvg,
    freqPeak: freqPeak
  };
}

function albumGaplessCurrentTailQuiet(remaining) {
  return albumGaplessTailSilenceProbe(remaining).quiet;
}

function startAlbumGaplessPreroll(preload) {
  if (!preload || !preload.media || preload.prerollStarted || preload.prerollPending || preload.prerollFailed) return false;
  preload.prerollPending = true;
  preload.prerollStarted = true;
  preload.prerollStartedAt = performance.now();
  preload.prerollStartTime = isFinite(preload.media.currentTime) ? preload.media.currentTime : 0;
  try {
    preload.media.muted = true;
    preload.media.volume = 0;
    preload.media.play().then(function () {
      preload.prerollPending = false;
      preload.prerollPlaying = true;
      preload.prerollLiveAt = performance.now();
    }).catch(function (err) {
      preload.prerollPending = false;
      preload.prerollFailed = true;
      console.warn('[AlbumGapless] preroll play failed:', err);
    });
    return true;
  } catch (err) {
    preload.prerollPending = false;
    preload.prerollFailed = true;
    console.warn('[AlbumGapless] preroll start failed:', err);
    return false;
  }
}

function albumGaplessDirectVolumeTarget() {
  return clampRange(Number(targetVolume) || 0, 0, 1);
}

function albumGaplessEqualPowerGains(progress, outgoingStart, incomingTarget) {
  var t = clampRange(Number(progress) || 0, 0, 1);
  var theta = t * Math.PI * 0.5;
  return {
    outgoing: clampRange((Number(outgoingStart) || 0) * Math.cos(theta), 0, 1),
    incoming: clampRange((Number(incomingTarget) || 0) * Math.sin(theta), 0, 1)
  };
}

function albumGaplessEqualPowerEntryProgress(elapsedMs, durationMs) {
  durationMs = Math.max(1, Number(durationMs) || 1);
  elapsedMs = clampRange(Number(elapsedMs) || 0, 0, durationMs);
  var whole = clampRange(elapsedMs / durationMs, 0, 1);
  if (whole >= 1) return 1;
  var attackMs = Math.min(ALBUM_GAPLESS_NEXT_ATTACK_MS, Math.max(1, durationMs - 1));
  var floorAngleProgress = Math.asin(ALBUM_GAPLESS_NEXT_ENTRY_FLOOR) / (Math.PI * 0.5);
  if (elapsedMs <= attackMs) {
    var attackT = clampRange(elapsedMs / attackMs, 0, 1);
    var attackEased = attackT * attackT * (3 - 2 * attackT);
    return floorAngleProgress * attackEased;
  }
  var releaseT = clampRange((elapsedMs - attackMs) / Math.max(1, durationMs - attackMs), 0, 1);
  var releaseEased = releaseT * releaseT * (3 - 2 * releaseT);
  return floorAngleProgress + (1 - floorAngleProgress) * releaseEased;
}

function runAlbumGaplessBalancedCrossfade(preload, durationMs) {
  if (!preload || !preload.media) return Promise.resolve(false);
  if (preload.fadeFrame) cancelAnimationFrame(preload.fadeFrame);
  var media = preload.media;
  var serial = ++audioFadeSerial;
  clearAudioFadeTimers();
  var startCurrent = currentAudioOutputGain();
  var initialTarget = Math.max(0.0001, albumGaplessDirectVolumeTarget());
  var outgoingRatio = clampRange(startCurrent / initialTarget, 0, 1);
  try {
    media.muted = false;
    media.volume = 0;
  } catch (e0) { }
  var started = performance.now();
  durationMs = Math.max(1, Number(durationMs) || 1);
  preload.fadeCompleted = false;
  return new Promise(function (resolve) {
    var settled = false;
    preload.fadeResolve = resolve;
    function finish(ok) {
      if (settled) return;
      settled = true;
      if (preload.fadeResolve === resolve) preload.fadeResolve = null;
      if (preload.fadeFrame) cancelAnimationFrame(preload.fadeFrame);
      if (preload.fadeWatchdogTimer) clearInterval(preload.fadeWatchdogTimer);
      preload.fadeFrame = 0;
      preload.fadeWatchdogTimer = 0;
      preload.fadeCompleted = !!ok;
      resolve(!!ok);
    }
    function applyStep(nowMs) {
      if (settled) return;
      if (serial !== audioFadeSerial || !preload.mixStarted || albumGaplessState.preload !== preload) {
        finish(false);
        return;
      }
      var elapsedMs = clampRange(nowMs - started, 0, durationMs);
      var t = clampRange(elapsedMs / durationMs, 0, 1);
      var curveProgress = albumGaplessEqualPowerEntryProgress(elapsedMs, durationMs);
      var liveTarget = albumGaplessDirectVolumeTarget();
      var gains = albumGaplessEqualPowerGains(curveProgress, liveTarget * outgoingRatio, liveTarget);
      writeAudioOutputGain(gains.outgoing);
      try {
        media.muted = false;
        media.volume = gains.incoming;
      } catch (e) { }
      if (t >= 1) {
        writeAudioOutputGain(0);
        try { media.volume = liveTarget; } catch (e2) { }
        finish(true);
      }
    }
    function tick(nowMs) {
      applyStep(nowMs);
      if (!settled) preload.fadeFrame = requestAnimationFrame(tick);
    }
    preload.fadeWatchdogTimer = setInterval(function () {
      applyStep(performance.now());
    }, ALBUM_GAPLESS_GAIN_STEP_MS);
    preload.fadeFrame = requestAnimationFrame(tick);
  });
}

function startAlbumGaplessMix(preload, reason, remaining) {
  if (!preload || !preload.media || preload.mixStarted || preload.mixPending || albumGaplessState.handoff) return false;
  if (!albumGaplessQueueCanAdvance(currentIdx)) return false;
  if (typeof cuefieldAutoMixExecuting !== 'undefined' && cuefieldAutoMixExecuting) return false;
  var outgoingMedia = audio;
  var outgoingToken = trackSwitchToken;
  var outgoingIndex = currentIdx;
  preload.mixPending = true;
  preload.releaseReason = reason || 'crossmix';
  if ((reason === 'boundary-crossmix-reset' || reason === 'tail-silence-fast-crossmix' || reason === 'tail-direct-silence-crossmix') && preload.prerollStarted) {
    try {
      preload.media.pause();
      preload.media.currentTime = 0;
    } catch (e) { }
    preload.prerollPlaying = false;
  }
  try {
    preload.media.muted = false;
    preload.media.volume = 0;
    var playResult = preload.media.play();
  } catch (err) {
    preload.mixPending = false;
    preload.prerollFailed = true;
    console.warn('[AlbumGapless] crossmix start failed:', err);
    return false;
  }
  Promise.resolve(playResult).then(function () {
    var stillCurrent = albumGaplessState.preload === preload
      && outgoingToken === trackSwitchToken
      && outgoingIndex === currentIdx
      && outgoingMedia === audio
      && albumGaplessQueueCanAdvance(currentIdx)
      && queueItemKey(playQueue[preload.index]) === preload.key;
    if (!stillCurrent) {
      if (albumGaplessState.preload === preload) clearAlbumGaplessPreload('album-gapless-mix-stale');
      else disposeAlbumGaplessPreload(preload);
      return false;
    }
    preload.mixPending = false;
    preload.mixStarted = true;
    preload.mixStartedAt = performance.now();
    preload.transitionToken = outgoingToken;
    preload.transitionIndex = outgoingIndex;
    preload.previousAudio = outgoingMedia || null;
    preload.previousAudioOnEnded = preload.previousAudio ? preload.previousAudio.onended : null;
    if (preload.previousAudio) preload.previousAudio.onended = null;
    var mixMs = Math.round(ALBUM_GAPLESS_MIX_SECONDS * 1000);
    if (isFinite(remaining) && remaining > 0) {
      mixMs = Math.min(mixMs, Math.max(ALBUM_GAPLESS_MIN_MIX_MS, Math.round(remaining * 1000 + 80)));
    }
    preload.mixDurationMs = mixMs;
    return runAlbumGaplessBalancedCrossfade(preload, mixMs);
  }).then(function (completed) {
    if (!completed) {
      if (albumGaplessState.preload === preload) restoreAlbumGaplessOutgoingIfCurrent(preload, 120);
      if (albumGaplessState.preload === preload) clearAlbumGaplessPreload('album-gapless-mix-cancelled');
      else disposeAlbumGaplessPreload(preload);
      return;
    }
    if (albumGaplessState.preload !== preload || !preload.fadeCompleted) return;
    preload.handoffTimer = setTimeout(function () {
      preload.handoffTimer = 0;
      if (albumGaplessState.preload === preload && preload.fadeCompleted) {
        startAlbumGaplessHandoff(preload, preload.releaseReason || reason || 'crossmix');
      }
    }, Math.max(24, ALBUM_GAPLESS_BIND_AFTER_MIX_MS));
  }).catch(function (err) {
    preload.mixPending = false;
    preload.mixStarted = false;
    preload.prerollFailed = true;
    console.warn('[AlbumGapless] crossmix play failed:', err);
    if (albumGaplessState.preload === preload) restoreAlbumGaplessOutgoingIfCurrent(preload, 120);
    if (albumGaplessState.preload === preload) clearAlbumGaplessPreload('album-gapless-mix-play-failed');
    else disposeAlbumGaplessPreload(preload);
  });
  return true;
}

function setAlbumGaplessPlaybackContext(enabled, context, opts) {
  opts = opts || {};
  var albumKey = context ? String(context.albumKey || '') : '';
  if (opts.userToggle && albumKey) {
    albumGaplessState.disabledAlbumKey = enabled ? '' : albumKey;
  }
  albumGaplessState.enabled = !!enabled;
  albumGaplessState.context = context || null;
  albumGaplessState.albumKey = enabled && context ? albumKey : '';
  if (!albumGaplessState.enabled || !albumGaplessState.albumKey) {
    albumGaplessState.enabled = false;
    if (albumGaplessState.preload && albumGaplessState.preload.mixStarted) {
      restoreAlbumGaplessOutgoingIfCurrent(albumGaplessState.preload, 120);
    }
    clearAlbumGaplessPreload('album-gapless-disabled');
    return false;
  }
  scheduleAlbumGaplessPreloadForCurrent(trackSwitchToken, 'context-enabled');
  return true;
}

function albumGaplessQueueCanAdvance(idx) {
  if (!albumGaplessState || !albumGaplessState.enabled || !albumGaplessState.albumKey) return false;
  if (playMode === 'single') return false;
  if (idx < 0 || idx + 1 >= playQueue.length) return false;
  var currentKey = albumGaplessSongKey(playQueue[idx]);
  var nextKey = albumGaplessSongKey(playQueue[idx + 1]);
  return currentKey === albumGaplessState.albumKey && nextKey === albumGaplessState.albumKey;
}

function qqPlaybackEvidenceQuery(song) {
  song = song || {};
  var vipRequired = !!(song.vipRequired || song.needVip || song.need_vip || song.onlyVipPlayable || song.only_vip_playable);
  if (!vipRequired && typeof songRequiresVip === 'function') {
    try { vipRequired = songRequiresVip(song); } catch (e) { vipRequired = false; }
  }
  return '&vipRequired=' + encodeURIComponent(vipRequired ? '1' : '') +
    '&needVip=' + encodeURIComponent(song.needVip || song.need_vip ? '1' : '') +
    '&onlyVipPlayable=' + encodeURIComponent(song.onlyVipPlayable || song.only_vip_playable ? '1' : '') +
    '&privilege=' + encodeURIComponent(song.privilege || song.Privilege || song.mediaPrivilege || song.media_privilege || '') +
    '&fee=' + encodeURIComponent(song.fee || song.Fee || '');
}

function neteasePlaybackMatchQuery(song, opts) {
  song = song || {};
  opts = opts || {};
  var excludeIds = Array.isArray(opts.excludeIds)
    ? opts.excludeIds.join(',')
    : String(opts.excludeIds || '');
  var artistId = song.artistId || song.artist_id || '';
  if (!artistId && Array.isArray(song.artists) && song.artists[0]) artistId = song.artists[0].id || '';
  if (!artistId && Array.isArray(song.ar) && song.ar[0]) artistId = song.ar[0].id || '';
  var artistRecords = Array.isArray(song.artists) && song.artists.length ? song.artists : (Array.isArray(song.ar) ? song.ar : []);
  var artistIds = artistRecords.map(function (artist) { return artist && artist.id || ''; }).filter(Boolean);
  var artistNames = artistRecords.map(function (artist) { return artist && artist.name || ''; }).filter(Boolean);
  if (!artistIds.length && artistId) artistIds = [artistId];
  if (!artistNames.length && (song.artist || song.artistName)) artistNames = [song.artist || song.artistName];
  var albumName = song.album || song.albumName || '';
  if (albumName && typeof albumName === 'object') albumName = albumName.name || '';
  return '&name=' + encodeURIComponent(song.name || song.title || '') +
    '&artist=' + encodeURIComponent(song.artist || song.artistName || '') +
    '&artistId=' + encodeURIComponent(artistId) +
    '&artistIds=' + encodeURIComponent(artistIds.join(',')) +
    '&artistNames=' + encodeURIComponent(artistNames.join('\u001f')) +
    '&album=' + encodeURIComponent(albumName) +
    '&duration=' + encodeURIComponent(song.durationMs || song.dt || song.duration || 0) +
    '&excludeIds=' + encodeURIComponent(excludeIds) +
    '&skipDirect=' + (opts.skipDirect ? '1' : '');
}

function clearNeteaseSourceMatchMetadata(song) {
  if (!song) return song;
  song.neteaseSourceMatched = false;
  song.resolvedNeteaseId = '';
  song.neteaseSourceMatchKind = '';
  song.neteaseSourceMatchScore = 0;
  song.neteaseSourceMatchAlbum = '';
  song.neteaseSourceMatchNotified = false;
  return song;
}

function applyNeteaseSourceMatchMetadata(song, data) {
  if (!song || !data || !data.sourceMatch) return song;
  song.neteaseSourceMatched = true;
  song.resolvedNeteaseId = data.resolvedNeteaseId || data.resolvedSongId || song.resolvedNeteaseId || '';
  song.neteaseSourceMatchKind = data.matchKind || 'netease_same_track_metadata';
  song.neteaseSourceMatchScore = Number(data.matchScore || 0) || 0;
  song.neteaseSourceMatchAlbum = data.matchedSong && data.matchedSong.album || '';
  song.playbackSource = data.source || 'netease-same-track';
  return song;
}

function neteaseSourceMatchTriedIds(data) {
  var tried = Array.isArray(data && data.sourceMatchTriedIds) ? data.sourceMatchTriedIds.slice() : [];
  var resolved = data && (data.resolvedNeteaseId || data.resolvedSongId);
  if (resolved && tried.map(String).indexOf(String(resolved)) < 0) tried.push(String(resolved));
  return tried.filter(Boolean).slice(0, 4);
}

async function retryNeteaseSourceMatchPlayback(song, data, idx, token, opts, requestedQuality) {
  if (!song || !data || !data.sourceMatch) return null;
  opts = opts || {};
  var sourceRecovery = typeof sourceFallbackRecoveryFromOptions === 'function'
    ? sourceFallbackRecoveryFromOptions(opts)
    : null;
  if (sourceRecovery && !sourceFallbackRecoveryCanContinue(sourceRecovery)) return null;
  var retryDepth = Math.max(0, Number(opts.neteaseSourceMatchRetryDepth) || 0);
  var triedIds = neteaseSourceMatchTriedIds(data);
  if (retryDepth >= 3 || triedIds.length >= 4) return null;
  var nextData = null;
  try {
    var nextDataPromise = apiJson(
      '/api/song/url?id=' + encodeURIComponent(song.id || '') +
      neteasePlaybackMatchQuery(song, { excludeIds: triedIds, skipDirect: true }) +
      '&quality=' + encodeURIComponent(requestedQuality),
      { timeoutMs: 10000 }
    );
    nextData = sourceRecovery
      ? await awaitSourceFallbackBudget(nextDataPromise, sourceRecovery)
      : await nextDataPromise;
  } catch (err) {
    console.warn('[NeteaseSourceMatch] next candidate lookup failed:', err);
    return token === trackSwitchToken ? null : false;
  }
  if (token !== trackSwitchToken) return false;
  if (sourceRecovery && (nextData === sourceFallbackBudgetTimeoutResult || !sourceFallbackRecoveryCanContinue(sourceRecovery))) return null;
  if (!nextData || !nextData.url || !nextData.sourceMatch) return null;
  var retryOpts = Object.assign({}, opts, {
    albumGaplessHandoff: false,
    albumGaplessMixed: false,
    preloadedAudio: null,
    preloadedData: null,
    preloadedProxyAudioUrl: '',
    preResolvedPlaybackData: nextData,
    neteaseSourceMatchRetryDepth: retryDepth + 1,
    qualityOverride: requestedQuality,
    suppressPlayFailureNotice: true,
  });
  var retryPromise = playQueueAt(idx, retryOpts);
  var retryToken = trackSwitchToken;
  var retryStarted = await retryPromise;
  if (retryToken !== trackSwitchToken) return false;
  return retryStarted === true;
}

async function resolveAlbumGaplessPlaybackData(song) {
  if (!song || song.type === 'local' || song.source === 'local' || song.localUrl) return null;
  if (song.type === 'podcast' || song.source === 'podcast') return null;
  var playbackProvider = normalizePlaybackProvider(songProviderKey(song));
  var requestedQuality = normalizePlaybackQualityForProvider(getProviderPlaybackQuality(playbackProvider), playbackProvider);
  // T12：jymaster×SVIP cookie 降级行退役——VIP 曲目由音源降级链 + probeWarning 兜底。
  var runtimeQualityCap = playbackQualityCapValue(song, playbackProvider);
  if (playbackQualityAboveCap(requestedQuality, playbackProvider, runtimeQualityCap)) requestedQuality = runtimeQualityCap;
  // T9 阶段2切换：gapless 预载统一走 /api/lx-source/resolve（静默、不跨平台换源、限时预算）。
  // T10：allowCacheLayer:false 绕开 90s 客户端镜像缓存——混流交接的地址必须当场新鲜
  //（T4 教训：源切换后陈旧 URL 喂进交接链会直接播死）。
  try {
    var resolved = await resolveLxPlaybackSong(song, {
      quality: requestedQuality,
      allowCrossPlatformFallback: false,
      allowCacheLayer: false,
      silent: true,
      timeoutMs: 15000,
      maxResolvers: 3
    });
    if (!resolved || !(resolved.url || resolved.proxyUrl)) return null;
    return {
      url: resolved.url || resolved.proxyUrl,
      proxyUrl: resolved.proxyUrl,
      level: lxPlaybackLevelFromLxQuality(resolved.actual),
      source: resolved.source,
      resolver: resolved.resolver,
      lxSource: true
    };
  } catch (err) {
    console.warn('[AlbumGapless] lx-source preload resolve failed:', (song && (song.name || song.id)) || '', err && err.message || err);
    return null;
  }
}

function consumeAlbumGaplessPreload(preload) {
  if (albumGaplessState.monitorTimer) {
    clearInterval(albumGaplessState.monitorTimer);
    albumGaplessState.monitorTimer = 0;
  }
  if (albumGaplessState.preload === preload) albumGaplessState.preload = null;
}

function startAlbumGaplessHandoff(preload, reason) {
  if (!preload || albumGaplessState.handoff) return false;
  if (
    !albumGaplessQueueCanAdvance(currentIdx)
    || preload.index !== currentIdx + 1
    || preload.token !== trackSwitchToken
    || queueItemKey(playQueue[preload.index]) !== preload.key
  ) {
    if (albumGaplessState.preload === preload) {
      restoreAlbumGaplessOutgoingIfCurrent(preload, 120);
      clearAlbumGaplessPreload('album-gapless-handoff-invalid');
    } else {
      disposeAlbumGaplessPreload(preload);
    }
    return false;
  }
  preload.releaseReason = reason || 'boundary';
  albumGaplessState.handoff = true;
  consumeAlbumGaplessPreload(preload);
  var handoffSourceToken = trackSwitchToken;
  var handoffPreviousAudio = preload.previousAudio || audio;
  function scheduleAlbumGaplessNormalFallback() {
    var expectedFailedToken = handoffSourceToken + 1;
    if (
      trackSwitchToken !== expectedFailedToken
      || currentIdx !== preload.index
      || (audio !== preload.media && audio !== handoffPreviousAudio)
    ) return false;
    var fallbackOwnerMedia = audio;
    if (fallbackOwnerMedia === preload.media) {
      try {
        preload.media.pause();
        preload.media.removeAttribute('src');
        preload.media.load();
      } catch (e) { }
      if (handoffPreviousAudio && handoffPreviousAudio !== fallbackOwnerMedia) {
        try {
          handoffPreviousAudio.pause();
          handoffPreviousAudio.removeAttribute('src');
          handoffPreviousAudio.load();
        } catch (e2) { }
      }
    } else {
      disposeAlbumGaplessPreload(preload);
    }
    setTimeout(function () {
      if (
        trackSwitchToken === expectedFailedToken
        && currentIdx === preload.index
        && audio === fallbackOwnerMedia
      ) {
        playQueueAt(preload.index, { skipShuffleOrder: true, suppressPlayFailureNotice: true, preserveHomeState: true });
      }
    }, 0);
    return true;
  }
  if (preload.song) {
    preload.song.__albumGaplessKey = albumGaplessState.albumKey;
    playQueue[preload.index] = hydrateCustomCover(preload.song);
  }
  Promise.resolve(playQueueAt(preload.index, {
    skipShuffleOrder: true,
    suppressPlayFailureNotice: true,
    preserveHomeState: true,
    albumGaplessHandoff: true,
    albumGaplessMixed: !!preload.mixStarted,
    albumGaplessReleaseReason: preload.releaseReason || reason || '',
    preloadedAudio: preload.media,
    preloadedData: preload.data,
    preloadedProxyAudioUrl: preload.proxyAudioUrl,
  })).then(function (success) {
    var adopted = success === true
      && audio === preload.media
      && currentIdx === preload.index
      && preload.media.src
      && !preload.media.paused
      && !preload.media.ended;
    if (adopted) return true;
    if (!scheduleAlbumGaplessNormalFallback() && audio !== preload.media) disposeAlbumGaplessPreload(preload);
    return false;
  }).catch(function (err) {
    console.warn('[AlbumGapless] handoff failed:', err);
    if (!scheduleAlbumGaplessNormalFallback() && audio !== preload.media) disposeAlbumGaplessPreload(preload);
  }).finally(function () {
    albumGaplessState.handoff = false;
  });
  return true;
}

function armAlbumGaplessMonitor(token) {
  if (albumGaplessState.monitorTimer) clearInterval(albumGaplessState.monitorTimer);
  albumGaplessState.monitorTimer = setInterval(function () {
    var preload = albumGaplessState.preload;
    if (
      !preload
      || token !== trackSwitchToken
      || preload.token !== token
      || preload.index !== currentIdx + 1
      || queueItemKey(playQueue[preload.index]) !== preload.key
      || !albumGaplessQueueCanAdvance(currentIdx)
    ) {
      restoreAlbumGaplessOutgoingIfCurrent(preload, 120);
      clearAlbumGaplessPreload('album-gapless-monitor-invalid');
      return;
    }
    if (!audio || !isFinite(audio.duration) || audio.duration <= 0 || !isFinite(audio.currentTime)) return;
    var remaining = audio.duration - audio.currentTime;
    if (remaining <= ALBUM_GAPLESS_MUTED_PREROLL_SECONDS) startAlbumGaplessPreroll(preload);
    if (!preload.media || preload.media.readyState < 2) return;
    var nowMs = performance.now();
    var tailProbe = albumGaplessTailSilenceProbe(remaining);
    var longTailSilence = remaining > ALBUM_GAPLESS_LONG_SILENCE_SECONDS;
    if (tailProbe.smoothedQuiet && (!longTailSilence || !tailProbe.residualTail)) {
      if (!preload.quietSince) preload.quietSince = nowMs;
    } else {
      preload.quietSince = 0;
    }
    if (tailProbe.directQuiet) {
      if (!preload.directQuietSince) preload.directQuietSince = nowMs;
    } else {
      preload.directQuietSince = 0;
    }
    var silenceHoldMs = longTailSilence ? ALBUM_GAPLESS_FAST_SILENCE_HOLD_MS : ALBUM_GAPLESS_SILENCE_HOLD_MS;
    var smoothedSilenceReady = !!(preload.quietSince && nowMs - preload.quietSince >= silenceHoldMs);
    var directHoldMs = tailProbe.deepQuiet ? ALBUM_GAPLESS_DEEP_SILENCE_HOLD_MS : ALBUM_GAPLESS_DIRECT_SILENCE_HOLD_MS;
    var directSilenceReady = !!(longTailSilence && preload.directQuietSince && nowMs - preload.directQuietSince >= directHoldMs);
    var silenceReady = smoothedSilenceReady || directSilenceReady;
    var boundaryReady = remaining <= ALBUM_GAPLESS_BOUNDARY_RELEASE_SECONDS;
    if (!silenceReady && !boundaryReady) return;
    startAlbumGaplessMix(preload, silenceReady ? (directSilenceReady ? 'tail-direct-silence-crossmix' : (longTailSilence ? 'tail-silence-fast-crossmix' : 'tail-silence-preroll-mix')) : 'boundary-crossmix-reset', remaining);
  }, 70);
}

async function scheduleAlbumGaplessPreloadForCurrent(token, reason) {
  if (!albumGaplessQueueCanAdvance(currentIdx) || token !== trackSwitchToken) {
    if (!albumGaplessState.handoff) clearAlbumGaplessPreload(reason || 'album-gapless-not-eligible');
    return false;
  }
  var sourceIdx = currentIdx;
  var nextIdx = sourceIdx + 1;
  var nextSong = playQueue[nextIdx];
  var nextKey = queueItemKey(nextSong);
  if (albumGaplessState.preload && albumGaplessState.preload.index === nextIdx && albumGaplessState.preload.key === nextKey) return true;
  clearAlbumGaplessPreload(reason || 'album-gapless-new-preload');
  var serial = ++albumGaplessState.serial;
  try {
    var resolvedSong = nextSong;
    var data = await resolveAlbumGaplessPlaybackData(nextSong);
    if ((!data || !data.url) && typeof searchAlternatePlatformSong === 'function') {
      var alternate = await searchAlternatePlatformSong(nextSong);
      if (alternate) {
        alternate.__albumGaplessKey = albumGaplessState.albumKey;
        alternate.__albumTrackIndex = nextSong && nextSong.__albumTrackIndex;
        var alternateData = await resolveAlbumGaplessPlaybackData(alternate);
        if (alternateData && alternateData.url) {
          resolvedSong = alternate;
          data = alternateData;
        }
      }
    }
    if (
      serial !== albumGaplessState.serial
      || token !== trackSwitchToken
      || sourceIdx !== currentIdx
      || queueItemKey(playQueue[nextIdx]) !== nextKey
      || !albumGaplessQueueCanAdvance(currentIdx)
    ) return false;
    if (!data || !data.url) return false;
    var proxyAudioUrl = data.proxyUrl ? String(data.proxyUrl) : '/api/audio?url=' + encodeURIComponent(data.url);
    var media = new Audio();
    media.crossOrigin = 'anonymous';
    media.preload = 'auto';
    media.volume = 0;
    media.src = proxyAudioUrl;
    await applyAudioOutputDevice(media);
    if (
      serial !== albumGaplessState.serial
      || token !== trackSwitchToken
      || sourceIdx !== currentIdx
      || queueItemKey(playQueue[nextIdx]) !== nextKey
      || !albumGaplessQueueCanAdvance(currentIdx)
    ) {
      disposeAlbumGaplessPreload({ media: media });
      return false;
    }
    media.load();
    albumGaplessState.preload = {
      index: nextIdx,
      key: nextKey,
      token: token,
      serial: serial,
      media: media,
      data: data,
      song: resolvedSong,
      proxyAudioUrl: proxyAudioUrl,
    };
    armAlbumGaplessMonitor(token);
    return true;
  } catch (err) {
    if (typeof media !== 'undefined' && media && (!albumGaplessState.preload || albumGaplessState.preload.media !== media)) {
      disposeAlbumGaplessPreload({ media: media });
    }
    if (serial === albumGaplessState.serial) console.warn('[AlbumGapless] preload failed:', err);
    return false;
  }
}

function playAlbumGaplessNextOnEnded(token) {
  if (!albumGaplessQueueCanAdvance(currentIdx)) return false;
  var nextIdx = currentIdx + 1;
  setTimeout(function () {
    if (token !== trackSwitchToken) return;
    playQueueAt(nextIdx, { skipShuffleOrder: true, suppressPlayFailureNotice: true, preserveHomeState: true });
  }, 0);
  return true;
}

function applyLocalTrackLyricOnDemand(song, token) {
  if (typeof cancelPendingTrackFallbackLyrics === 'function') cancelPendingTrackFallbackLyrics();
  if (song && song.lyric) {
    applyFetchedLyricResponse(song, token, { lyric: song.lyric }, { persist: false });
    return;
  }
  setOriginalLyricsState(withLyricFallback([]), false, 'fallback');
  applyPreferredLyricsForCurrent(true);
  if (
    !song
    || !song.hasLyric
    || !song.localFileId
    || !window.desktopWindow
    || typeof window.desktopWindow.readLocalMusicLyric !== 'function'
  ) return;
  window.desktopWindow.readLocalMusicLyric(song.localFileId).then(function (result) {
    if (
      token !== trackSwitchToken
      || !currentLocalSong
      || queueItemKey(currentLocalSong) !== queueItemKey(song)
      || !result
      || result.ok !== true
      || !result.lyric
    ) return;
    song.lyric = result.lyric;
    song.lyricSource = result.lyricSource || song.lyricSource || '';
    applyFetchedLyricResponse(song, token, { lyric: result.lyric }, { persist: false });
  }).catch(function () { });
}

async function playLocalQueueSong(song, idx, token, firstVisualPlay, opts, resumeAt) {
  opts = opts || {};
  if (!song || !song.localUrl) {
    showToast('本地文件已失效，请重新导入后继续');
    forcePlaybackControlsInteractive();
    return false;
  }
  currentLocalSong = song;
  playQueue[idx] = song;
  updateCustomCoverButton();
  document.getElementById('trial-banner').classList.remove('show');
  if (!audio) { audio = new Audio(); audio.crossOrigin = 'anonymous'; }
  else {
    audioFadeSerial++;
    clearAudioFadeTimers();
    audio.pause();
  }
  resetPlaybackAudioGraphForSourceSwitch('local-track-switch');
  audio.autoplay = true;
  audio.preload = 'auto';
  bindPlaybackProgressEvents(audio);
  applyVolumeToAudio();
  await applyAudioOutputDevice(audio);
  audio.src = song.localUrl;
  audio.__stellaflixQueueItemKey = queueItemKey(song);
  audio.__stellaflixTrackSwitchToken = token;
  updatePlaybackProgressUi();
  lyricSunEnergy = 0; lyricSunTarget = 0; lyricSunHold = 0; lyricSunAvg = 0; lyricSunPeak = 0.55;
  audio.onended = function () {
    if (token !== trackSwitchToken) return;
    if (this && this.__stellaflixCuefieldEndedRecoveryToken === token) return;
    if (typeof cuefieldAutoMixExecuting !== 'undefined' && cuefieldAutoMixExecuting) {
      if (typeof noteCuefieldAutoMixOutgoingEnded === 'function') noteCuefieldAutoMixOutgoingEnded(this, token, currentIdx);
      return;
    }
    finalizeListenSession(true);
    if (playAlbumGaplessNextOnEnded(token)) return;
    if (playMode === 'single') setTimeout(function () { playQueueAt(currentIdx, { autoRepeat: true, suppressPlayFailureNotice: true }); }, 0);
    else setTimeout(nextTrack, 0);
  };
  audio.onloadedmetadata = function () {
    if (token !== trackSwitchToken || !currentLocalSong || currentLocalSong.localKey !== song.localKey) return;
    var duration = audio && isFinite(audio.duration) ? audio.duration : 0;
    currentLocalSong.duration = duration;
    if (playQueue[idx]) playQueue[idx].duration = duration;
    if (lyricSourceMode === 'custom') applyCustomLyricState(currentLocalSong, true);
    safeRenderQueuePanel('local-metadata', { scrollCurrent: miniQueueOpen });
  };
  scheduleAudioResumePosition(audio, opts.resumeAt != null ? opts.resumeAt : resumeAt, token);
  if (resumeAt > 0) pendingPlaybackResumeAt = 0;
  audio.load();
  currentBeatMap = null;
  beatMapNextIdx = 0;
  resetAudioVisualState();
  resetBeatCameraSync(0);
  cancelBeatAnalysisTimer();
  cancelDjBeatAnalysisTimer();
  beatMapToken++;
  djBeatMapToken++;
  resetDjBeatMapState();
  setDjModeActive(false);
  var playbackStarted = await playAudio({ manual: !!opts.manual, silent: !!opts.startupAutoplay || !opts.manual, startupAutoplay: !!opts.startupAutoplay, trackSwitch: true, resumeRecovery: !!opts.resumeRecovery });
  if (!playbackStarted) {
    forcePlaybackControlsInteractive();
    if (opts.startupAutoplay) {
      return false;
    }
    if (!opts.suppressPlayFailureNotice) {
      if (opts.manual) showToast('播放启动失败，请重新选择本地音乐');
      else showSourceFallbackNotice('本地音乐已载入', '点击播放器中间的播放按钮继续播放。');
    }
    return false;
  }
  forcePlaybackControlsInteractive();
  beginListenSession(song, null);
  applyLocalTrackLyricOnDemand(song, token);
  safeRenderQueuePanel('play-local-queue', { scrollCurrent: miniQueueOpen });
  scheduleShelfRebuild('play-local-queue', true);
  scheduleAlbumGaplessPreloadForCurrent(token, 'local-started');
  setTimeout(function () {
    if (token === trackSwitchToken && currentLocalSong && currentLocalSong.localKey === song.localKey) {
      prepareLocalBeatAnalysis(currentLocalSong, song.localUrl);
    }
  }, firstVisualPlay ? 680 : 520);
  return true;
}

// ============================================================
// —— T9 播放链统一：音源解析三级失败链（起）——
// 移植批（阶段2切换）：上游 Mineradio index.html :31693-31745(lxSongPlayPayload) /
// :31861-31939(applyCrossPlatformSongMatch→11-provider-fallback.js /
// resolveCrossPlatformAudioFallback) / :31941-32013(resolveImportedLxAudio 骨架) /
// :32325-32355(resolver 级重试+死URL去重) / :32358-32372(跨平台换源) /
// :32380-32396(onerror 断点重解析封顶3)。逻辑移植，命名/DOM/路径全部 Stellaflix 化；
// 播放解析统一指 /api/lx-source/resolve，不再走任何官方平台五分支。
// 移植批 T10 追加：:31826-31857(lxResolvedAudioCache 90s 客户端镜像+在途去重+按曲失效) /
// :32026-32043+挂撤点 :32249/:32374(播放成功 700ms 后下曲静默预取)；
// 裁决2：运行时链+起播失败链合并进 opts.lxChainDepth 一份共享深度、合计封顶 3。
// 三级失败链状态机：
//   一级 resolver 级：同曲多次 /resolve（服务端轮换 resolver；失败/死URL 把
//        song._lxResolver 记忆排入 excludeResolvers——裁决2，绕开服务端 90s 缓存）；
//   二级 跨平台重匹配：/api/lx-source/search 找同名异平台版本再 resolve，
//        命中后 applyCrossPlatformSongMatch 改写歌曲身份；
//   三级 终态引导：按机器 code（LX_NO_SOURCES / LX_SOURCE_NOT_CONFIGURED /
//        LX_SOURCE_RESOLVE_ALL_FAILED / LX_SOURCE_NO_RESOLVER）分支文案——裁决3。
// proxyUrl 一律作不透明字符串消费，绝不重编码/字符串改写——裁决4。

var LX_SOURCE_RESOLVABLE = /^(?:tx|wy|kw|kg|mg)$/;
var LX_SOURCE_QUALITY_WORDS = { master: 1, atmos_plus: 1, flac24bit: 1, hires: 1, flac: 1, '320k': 1, '128k': 1 };

function lxNormalizeSourceName(value) {
  var sourceName = String(value || '').toLowerCase();
  return ({ qq: 'tx', netease: 'wy', kuwo: 'kw', kugou: 'kg', migu: 'mg', qishui: 'qs', spotify: 'sp' })[sourceName] || sourceName;
}

var LX_SOURCE_PLATFORM_LABELS = { tx: 'QQ 音乐', wy: '网易云', kw: '酷我音乐', kg: '酷狗音乐', mg: '咪咕音乐', qs: '汽水音乐', sp: 'Spotify' };
function lxSourcePlatformLabel(sourceName) {
  var key = lxNormalizeSourceName(sourceName);
  return LX_SOURCE_PLATFORM_LABELS[key] || String(sourceName || '').toUpperCase() || '未知平台';
}

// Stellaflix 音质词汇 → LX 音质词。T12 词汇统一后内部键即 LX 协议词（恒等直传），
// 旧词行仅为未升级入口/陈旧偏好兜底（normalizePlaybackQuality 词汇表同样覆盖）。
var LX_PLAYBACK_QUALITY_TO_SOURCE = { master: 'master', jymaster: 'master', flac24bit: 'flac24bit', hires: 'hires', flac: 'flac', lossless: 'flac', '320k': '320k', exhigh: '320k', '128k': '128k', standard: '128k' };
function lxRequestQualityForPlaybackQuality(value) {
  var raw = String(value || '').trim().toLowerCase();
  if (LX_SOURCE_QUALITY_WORDS[raw]) return raw;
  var word = typeof normalizePlaybackQuality === 'function' ? normalizePlaybackQuality(raw) : raw;
  return LX_PLAYBACK_QUALITY_TO_SOURCE[word] || '128k';
}

// LX 实际音质词 → Stellaflix level 词。T12：内部词汇即 LX 五档；
// 协议侧独立的 hires/atmos_plus 折叠进相邻档（hires→flac24bit、atmos_plus→master），
// 降级提示与运行时上限继续沿用既有 playbackQualityRank 链路。
function lxPlaybackLevelFromLxQuality(value) {
  var word = String(value || '').trim().toLowerCase();
  if (word === 'master' || word === 'atmos_plus') return 'master';
  if (word === 'flac24bit' || word === 'hires') return 'flac24bit';
  if (word === 'flac' || word === 'lossless') return 'flac';
  if (word === '320k') return '320k';
  return '128k';
}

// 终态引导文案——裁决3：全项目共享的 code→文案映射，按机器 code 分支不按散文猜。
function lxSourceGuidanceText(code) {
  code = String(code || '').trim().toUpperCase();
  if (code === 'LX_NO_SOURCES' || code === 'LX_SOURCE_NOT_CONFIGURED') {
    return '还没有可用音源，请在「音源管理」导入或启用音源后重试。';
  }
  if (code === 'LX_SOURCE_RESOLVE_ALL_FAILED' || code === 'LX_SOURCE_NO_RESOLVER') {
    return '当前音源及备用音源均解析失败，跨平台自动换源也没有匹配到可播版本，请在「音源管理」切换音源或稍后重试。';
  }
  if (code === 'LX_SOURCE_UNSUPPORTED') {
    return '当前音源不支持这首歌的解析，请切换音源后重试。';
  }
  return '音源解析失败，请稍后重试或切换音源。';
}

function lxCodeFromMessage(message) {
  var match = /LX_[A-Z0-9_]+/.exec(String(message || ''));
  return match ? match[0] : '';
}

// 上游 :31693-31745 lxSongPlayPayload 移植（含 fallbackId 合成 id 清零与 meta 构造）。
// 裁决1：kg 依赖 hash/FileHash、mg 依赖 copyrightId——lx-search 爬虫形状扩展后这两个
// 字段随歌曲对象进来，这里透传进 payload 与 meta，供沙箱脚本解析。
function lxPlaybackSongPayload(song) {
  song = song || {};
  var sourceName = lxNormalizeSourceName(song.source || song.provider || song.type);
  var fallbackIdPattern = /^(?:tx|wy|kw|kg|mg|song|row)_[0-9a-f]{12,}$/i;
  var hasFallbackId = song.importFallbackId === true ||
    fallbackIdPattern.test(String(song.songmid || '')) ||
    fallbackIdPattern.test(String(song.id || ''));
  var primaryId = hasFallbackId ? '' : (song.songmid != null && song.songmid !== '' ? song.songmid
    : (song.id != null && song.id !== '' ? song.id
    : (song.hash || song.FileHash || song.copyrightId || song.rid || song.mid || '')));
  var payload = {
    name: song.name || song.title || '',
    singer: song.singer || song.artist || '',
    source: sourceName,
    id: hasFallbackId ? '' : (song.id != null && song.id !== '' ? song.id : primaryId),
    songmid: hasFallbackId ? '' : (song.songmid != null && song.songmid !== '' ? song.songmid : primaryId),
    mid: hasFallbackId ? '' : (song.mid || song.songmid || primaryId),
    songId: hasFallbackId ? '' : (song.songId || song.id || primaryId),
    rid: hasFallbackId ? '' : (song.rid || song.songmid || song.id || primaryId),
    img: song.picUrl || song.img || song.cover || song.coverUrl || '',
    picUrl: song.picUrl || song.img || song.cover || song.coverUrl || '',
    albumId: song.albumId || '',
    interval: song.interval || song.duration || '',
    albumName: song.albumName || song.album || '',
    types: Array.isArray(song.types) ? song.types : [],
    meta: Object.assign({}, song.meta || {})
  };
  ['hash', 'FileHash', 'fileHash', 'strMediaMid', 'albumMid', 'copyrightId', 'copyrightid', 'lrcUrl', 'trcUrl', 'mrcUrl'].forEach(function (key) {
    if (hasFallbackId && !/Url$/i.test(key)) return;
    if (song[key] != null && song[key] !== '') payload[key] = song[key];
  });
  if (sourceName === 'tx') {
    payload.meta.qq = Object.assign({}, payload.meta.qq || {}, {
      mid: hasFallbackId ? '' : (song.songmid || song.mid || primaryId),
      songmid: hasFallbackId ? '' : (song.songmid || song.mid || primaryId),
      songid: hasFallbackId ? '' : (song.id || song.songId || '')
    });
  } else if (sourceName === 'wy') {
    payload.meta.wy = Object.assign({}, payload.meta.wy || {}, { id: hasFallbackId ? '' : (song.id || song.songmid || primaryId) });
  } else if (sourceName === 'kw') {
    payload.meta.kw = Object.assign({}, payload.meta.kw || {}, { rid: hasFallbackId ? '' : (song.rid || song.songmid || song.id || primaryId) });
  } else if (sourceName === 'kg') {
    var kgHash = hasFallbackId ? '' : (song.hash || song.FileHash || song.fileHash || song.songmid || primaryId);
    payload.hash = payload.hash || kgHash;
    payload.FileHash = payload.FileHash || kgHash;
    payload.meta.kg = Object.assign({}, payload.meta.kg || {}, { hash: kgHash, FileHash: kgHash });
  } else if (sourceName === 'mg') {
    var mgId = hasFallbackId ? '' : (song.copyrightId || song.copyrightid || song.songmid || song.id || primaryId);
    payload.copyrightId = payload.copyrightId || mgId;
    payload.meta.mg = Object.assign({}, payload.meta.mg || {}, { copyrightId: mgId });
  }
  return payload;
}

function lxUsableResolveResult(result) {
  return !!(result && result.ok && (/^https?:\/\//i.test(String(result.url || '')) || /^\/api\/audio\?/i.test(String(result.proxyUrl || ''))));
}

// 服务端 /resolve 的 actual 是 Range 探测对象（{codec,lossless,...}），音质词在 quality
// （实际命中的降级档）。仅当 actual 已是字符串（未来契约）才直取，否则取 quality——
// 防 String(probe) 变成 '[object Object]' 把一切命中误判为 standard。
function lxActualQualityWord(result) {
  if (!result) return '';
  if (typeof result.actual === 'string' && result.actual) return result.actual;
  return String(result.quality || '');
}

// 二级：跨平台重匹配（上游 :31893-31939 resolveCrossPlatformAudioFallback 移植）。
// 搜索走 /api/lx-source/search（剔除失败源），候选逐个 resolve，命中后交
// 11-provider-fallback.js 的 applyCrossPlatformSongMatch 改写歌曲身份。
async function resolveCrossPlatformPlaybackFallback(song, failedSource, excludedResolvers, options) {
  song = song || {};
  options = options || {};
  var referenceSinger = String(song.singer || song.artist || '').trim();
  if (referenceSinger === '未知歌手' || /^(?:https?:\/\/|www\.)/i.test(referenceSinger)) referenceSinger = '';
  var query = [song.name || song.title, referenceSinger].filter(Boolean).join(' ').trim();
  if (!query) return null;
  var excluded = Array.isArray(excludedResolvers) ? excludedResolvers.slice(0, 8) : [];
  var attemptedUrls = Array.isArray(options.attemptedUrls) ? options.attemptedUrls.map(String) : [];
  var sourceNames = ['wy', 'kw', 'kg', 'mg', 'tx'].filter(function (source) { return source !== failedSource; });
  var referenceName = typeof normalizeMatchText === 'function' ? normalizeMatchText(song.name || song.title || '') : String(song.name || '').toLowerCase();
  try {
    var alternatives = await apiJson('/api/lx-source/search?q=' + encodeURIComponent(query) +
      '&limit=16&sources=' + encodeURIComponent(sourceNames.join(',')), { timeoutMs: 22000 });
    var candidates = alternatives && Array.isArray(alternatives.songs) ? alternatives.songs.filter(function (candidate) {
      if (!candidate || String(candidate.source || '') === failedSource) return false;
      if (!referenceName || typeof normalizeMatchText !== 'function') return true;
      var candidateName = normalizeMatchText(candidate.name || '');
      return candidateName === referenceName || candidateName.indexOf(referenceName) >= 0 || referenceName.indexOf(candidateName) >= 0;
    }).slice(0, 10) : [];
    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      var candidateSource = lxNormalizeSourceName(candidate.source);
      if (!LX_SOURCE_RESOLVABLE.test(candidateSource)) continue;
      try {
        var resolved = await apiJson('/api/lx-source/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: candidateSource,
            quality: String(options.quality || '128k'),
            musicInfo: lxPlaybackSongPayload(candidate),
            excludeResolvers: excluded.slice(),
            maxResolvers: Math.max(3, Math.min(8, Number(options.maxResolvers) || 6))
          }),
          timeoutMs: Math.max(8000, Number(options.timeoutMs) || 30000)
        });
        if (lxUsableResolveResult(resolved)) {
          // 上游 :32359 死URL去重同样覆盖跨平台命中：换源结果若就是刚播失败的地址，
          // 排除该 resolver 继续下一候选，不再原样重播死链。
          var crossFinalUrl = String(resolved.proxyUrl || resolved.url);
          if (attemptedUrls.indexOf(crossFinalUrl) >= 0) {
            var deadCrossResolver = String(resolved.resolver || '').trim().toLowerCase();
            if (deadCrossResolver && excluded.indexOf(deadCrossResolver) < 0) excluded.push(deadCrossResolver);
            continue;
          }
          if (typeof applyCrossPlatformSongMatch === 'function') applyCrossPlatformSongMatch(song, candidate, candidateSource);
          song._lxResolver = String(resolved.resolver || '');
          if (!options.silent) {
            showSourceFallbackNotice('已自动换源', (lxSourcePlatformLabel(failedSource) || failedSource || '原平台') + ' 版本不可播放，已切换到 ' + (lxSourcePlatformLabel(candidateSource) || candidateSource) + '。');
          }
          return {
            ok: true,
            url: String(resolved.url || ''),
            proxyUrl: crossFinalUrl,
            actual: lxActualQualityWord(resolved),
            probeWarning: !!(resolved && resolved.probeWarning),
            resolver: song._lxResolver,
            source: candidateSource,
            quality: String(options.quality || ''),
            crossMatched: true
          };
        }
      } catch (_candidateError) { }
    }
  } catch (_searchError) { }
  return null;
}

// 统一解析入口（brief Interfaces：resolveLxPlaybackSong(song, {quality, excludeResolvers})
//   → {url(proxyUrl), actual, probeWarning, resolver}）。
// async 声明不随 Annex B 泄漏——文件尾显式挂 window（同 00-api-quality-output.js 约定）。
// T10：入口先查 lxResolvedAudioCache（90s 镜像缓存，上游 :31956-31960），并发同曲共享
// lxResolveInflight 单条 Promise（上游 :31961-31967/:32007-32012）；prefetch 强制静默、
// allowCacheLayer:false 供 gapless 预载绕缓存（T4 预裁：交接地址必须新鲜，不喂陈旧 URL）。
async function resolveLxPlaybackSong(song, options) {
  song = song || {};
  options = options || {};
  var sourceName = lxNormalizeSourceName(song.source || song.provider || song.type);
  var excluded = Array.isArray(options.excludeResolvers) ? options.excludeResolvers.slice(0, 8) : [];
  var attempted = Array.isArray(options.attemptedUrls) ? options.attemptedUrls.map(String) : [];
  var silent = !!(options.silent || options.prefetch);
  var allowCross = options.allowCrossPlatformFallback !== false;
  var attempts = Math.max(1, Number(options.attempts) || 3);
  var maxResolvers = Math.max(3, Math.min(8, Number(options.maxResolvers) || 6));
  var lxQuality = lxRequestQualityForPlaybackQuality(options.quality || 'hires');
  song._lxRequestedQuality = lxQuality;
  var lastCode = '';
  var lastMessage = '';

  function excludeResolver(id) {
    id = String(id || '').trim().toLowerCase();
    if (id && excluded.indexOf(id) < 0) excluded.push(id);
  }

  // needsCrossPlatformMatch / sp·qs·am 等非可解析平台：跳过一级，直接二级（上游 :31945-31949 语义）。
  var resolvable = LX_SOURCE_RESOLVABLE.test(sourceName);
  var songKey = lxResolvedAudioCacheKey(song, lxQuality);
  var useCacheLayer = resolvable && song.needsCrossPlatformMatch !== true && options.allowCacheLayer !== false;
  if (useCacheLayer) {
    var cached = cachedLxResolvedAudio(song, lxQuality, excluded);
    if (cached) {
      song._lxResolver = String(cached.resolver || '');
      return {
        ok: true,
        url: String(cached.url || ''),
        proxyUrl: String(cached.proxyUrl || cached.url || ''),
        actual: String(cached.actual || ''),
        probeWarning: !!cached.probeWarning,
        resolver: song._lxResolver,
        source: String(cached.source || sourceName),
        quality: lxQuality,
        fromCache: true
      };
    }
    if (!excluded.length && lxResolveInflight[songKey]) {
      var pendingResult = await lxResolveInflight[songKey];
      var pendingRecord = lxResolvedAudioCache[songKey];
      song._lxResolver = String((pendingRecord && pendingRecord.resolver) || (pendingResult && pendingResult.resolver) || '');
      return Object.assign({}, pendingResult, { fromCache: true });
    }
  }

  var chainPromise = (async function runLxResolveChain() {
  if (resolvable && song.needsCrossPlatformMatch !== true) {
    var payload = lxPlaybackSongPayload(song);
    for (var attempt = 0; attempt < attempts; attempt++) {
      var result = null;
      try {
        result = await apiJson('/api/lx-source/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: sourceName,
            quality: lxQuality,
            musicInfo: payload,
            excludeResolvers: excluded.slice(),
            maxResolvers: maxResolvers
          }),
          timeoutMs: Math.max(8000, Number(options.timeoutMs) || 45000)
        });
      } catch (resolveError) {
        // 上游 :31984-31985：超时独立成文案；其它异常并入 resolver 级失败。
        var aborted = resolveError && resolveError.name === 'AbortError';
        lastCode = 'LX_SOURCE_RESOLVE_ALL_FAILED';
        lastMessage = aborted ? '音源解析超时，请换音源或稍后重试' : String((resolveError && resolveError.message) || resolveError);
        excludeResolver(song._lxResolver);
        invalidateLxResolvedAudioCache(song);
        if (!silent && attempt < attempts - 1) showSourceFallbackNotice('当前音源不可用', '正在重试并切换备用音源…');
        continue;
      }
      if (lxUsableResolveResult(result)) {
        var finalUrl = String(result.proxyUrl || result.url);
        if (attempted.indexOf(finalUrl) >= 0) {
          // 死URL去重（上游 :32339）：备用音源返回已试过的失效地址 → resolver 级失败。
          lastCode = 'LX_SOURCE_RESOLVE_ALL_FAILED';
          lastMessage = '备用音源返回了相同的失效地址';
          excludeResolver(result.resolver);
          invalidateLxResolvedAudioCache(song);
          continue;
        }
        if (!silent && attempt > 0) {
          showSourceFallbackNotice('已自动切换音源', '原音源无法播放，已改用：' + (result.resolver || '备用音源') + '。');
        }
        song._lxResolver = String(result.resolver || '');
        var successResult = {
          ok: true,
          url: String(result.url || ''),
          proxyUrl: finalUrl,
          actual: lxActualQualityWord(result),
          probeWarning: !!(result && result.probeWarning),
          resolver: song._lxResolver,
          source: String(result.source || sourceName),
          quality: lxQuality
        };
        // 上游 :31996-32002：成功解析写 90s 客户端镜像缓存（超 80 条先删最早键，镜像上限 80 窄于服务端 LRU-120）。
        // 记录整份结果对象（我方消费方还需 actual/probeWarning/source，上游仅存 url——我方适配，键与 TTL 同上游）。
        lxResolvedAudioCache[songKey] = Object.assign({}, successResult, { expiresAt: Date.now() + LX_RESOLVED_AUDIO_CACHE_TTL_MS });
        var cacheKeys = Object.keys(lxResolvedAudioCache);
        if (cacheKeys.length > 80) delete lxResolvedAudioCache[cacheKeys[0]];
        return successResult;
      }
      var code = String((result && (result.code || lxCodeFromMessage(result.error || result.message))) || 'LX_SOURCE_RESOLVE_ALL_FAILED');
      lastCode = code;
      lastMessage = String((result && (result.error || result.message)) || '音源解析失败');
      if (code === 'LX_NO_SOURCES' || code === 'LX_SOURCE_NOT_CONFIGURED') {
        // 裁决3：没有启用音源/未配置时，重匹配候选同样无解析器可用——不空转，直接终态。
        allowCross = false;
        break;
      }
      excludeResolver(song._lxResolver);
      invalidateLxResolvedAudioCache(song);
      if (!silent && attempt < attempts - 1) showSourceFallbackNotice('当前音源不可用', '正在重试并切换备用音源…');
    }
  }

  if (allowCross) {
    if (!silent) showSourceFallbackNotice('正在跨平台换源', '当前平台的音源均不可用，正在匹配其他平台版本…');
    var cross = await resolveCrossPlatformPlaybackFallback(song, sourceName, excluded, {
      quality: lxQuality,
      timeoutMs: options.timeoutMs,
      maxResolvers: maxResolvers,
      attemptedUrls: attempted,
      silent: silent
    });
    if (cross) return cross;
  }

  var terminalCode = lastCode || (resolvable ? 'LX_SOURCE_RESOLVE_ALL_FAILED' : 'LX_SOURCE_NO_RESOLVER');
  var guidance = lxSourceGuidanceText(terminalCode);
  if (!silent) {
    showSourceFallbackNotice('音源解析失败', guidance);
    // 批 T13（spec §5，裁决3 的最小接线）：一脚本未装的终态附「打开音源管理」引导按钮，
    // 由源管理面板（15-lxSourceManager）挂上；不重构本链，只加钩子。
    if ((terminalCode === 'LX_NO_SOURCES' || terminalCode === 'LX_SOURCE_NOT_CONFIGURED') &&
        typeof window !== 'undefined' && window.lxSourceManager) {
      window.lxSourceManager.attachNoticeOpenAction();
    }
  }
  var terminalError = new Error(guidance);
  terminalError.code = terminalCode;
  terminalError.lxTerminal = true;
  throw terminalError;
  })();

  if (useCacheLayer && !excluded.length) lxResolveInflight[songKey] = chainPromise;
  try {
    return await chainPromise;
  } finally {
    if (useCacheLayer && lxResolveInflight[songKey] === chainPromise) delete lxResolveInflight[songKey];
  }
}

// —— T10 下曲预取（上游 :32014-32043 scheduleImportedLxAudioPrefetch 移植；
// 挂/撤点同上游 :32249 切曲即清 / :32374 播放成功后调度）——
// 成功起播 700ms 后对队列下一首做一次静默解析写入 lxResolvedAudioCache，切到该曲时 0 等待。
// 裁决3 平价：上游 {prefetch:true, allowCrossPlatformFallback:false, maxResolvers:3, timeoutMs:18000}
// 中 timeoutMs/prefetch 是客户端概念（apiJson 限时 + 全静默），maxResolvers 服务端已有对应，
// 跨平台抑制由 allowCrossPlatformFallback:false 客户端闸门完成；attempts:1 保证预取单发出网
// （上游预取走的是单次 resolveImportedLxAudio，不是整条重试循环）。失败仅 console.debug（:32040），
// 不弹卡片、不 toast、不触发任何重入链。裁决4 计时器卫生：唯一句柄 lxAudioPrefetchTimer，
// schedule 先撤旧、playQueueAt 头部 clearLxAudioPrefetchTimer()、回调自清零。
function clearLxAudioPrefetchTimer() {
  if (lxAudioPrefetchTimer) {
    clearTimeout(lxAudioPrefetchTimer);
    lxAudioPrefetchTimer = 0;
  }
}
function nextLxAudioPrefetchSong(songIndex) {
  if (Array.isArray(playQueue) && playQueue.length > 1 && Number.isFinite(Number(songIndex)) && Number(songIndex) >= 0) {
    return playQueue[(Number(songIndex) + 1) % playQueue.length] || null;
  }
  return null;
}
function scheduleLxAudioPrefetch(token, songIndex, quality) {
  clearLxAudioPrefetchTimer();
  lxAudioPrefetchTimer = setTimeout(function () {
    lxAudioPrefetchTimer = 0;
    if (token !== trackSwitchToken || playMode === 'single') return;
    var nextSong = nextLxAudioPrefetchSong(songIndex);
    var nextSource = lxNormalizeSourceName(nextSong && (nextSong.source || nextSong.provider || nextSong.type));
    if (!nextSong || !LX_SOURCE_RESOLVABLE.test(nextSource)) return;
    resolveLxPlaybackSong(nextSong, {
      quality: quality,
      prefetch: true,
      allowCrossPlatformFallback: false,
      attempts: 1,
      maxResolvers: 3,
      timeoutMs: 18000
    }).catch(function (error) {
      console.debug('[LXAudioPrefetch]', nextSong && nextSong.name, error && (error.message || error));
    });
  }, 700);
}

// 运行时断点重解析挂钩（上游 :32376-32396 audio.onerror 移植）。
// async playQueueAt 不泄漏 → 经 window.playQueueAt（12-expose-inline-globals.js 已挂）。
//
// 单链闸（T9 修复轮1）：运行时 onerror 链（opts.lxRuntimeRetry 计数）与起播失败链
// （opts.lxStartRetryDepth 计数）挂在同一个共享 audio 载体上、两个深度计数器互不可见，
// 一次失败若两条链都放行，首歌可长出 3×3 条并发重入链。不变量：一个 token
// （= 一次 playQueueAt 载入）只允许一次自动重入，先占坑的机制说话，后到的直接放弃。
// token 单调递增，只保留最近若干个占坑记录，防长期播放列表下无界增长。
var lxReenteredTokens = [];
function claimLxPlaybackReentry(token) {
  var t = Number(token);
  if (!isFinite(t)) return true;
  for (var i = lxReenteredTokens.length - 1; i >= 0; i--) {
    if (lxReenteredTokens[i] < t - 8) lxReenteredTokens.splice(i, 1);
  }
  if (lxReenteredTokens.indexOf(t) >= 0) return false;
  lxReenteredTokens.push(t);
  return true;
}

// —— T10 客户端缓存 + 在途去重（上游 :31826-31857 移植）——
// 服务端 lx-source-host.js 已有 90s LRU-120 musicUrl 缓存；lxResolvedAudioCache 是其客户端镜像：
// 90s 内同曲同音质二次播放 0 网络。缓存键沿用上游构成（归一源名 | songmid/id/hash/FileHash/
// copyrightId | 曲名 | 歌手 | LX 音质词），T9 修正案的冻结形状 hash/copyrightId 直接进身份位。
// 在途去重 lxResolveInflight：同一首歌并发解析共享同一条 Promise（只发一次请求）；带排除集的
// 失败链重进不参与去重（上游 :31961/:32007 语义——排除状态不同的两次解析不是同一请求）。
// 失效三条路：resolver 级失败/异常/死URL（上游 :32349 循环内语义）、起播失败重进、音质切换（裁决5）。
var lxResolvedAudioCache = Object.create(null);
var lxResolveInflight = Object.create(null);
var lxAudioPrefetchTimer = 0;
var LX_RESOLVED_AUDIO_CACHE_TTL_MS = 90 * 1000;
function lxResolvedAudioCacheKey(song, quality) {
  song = song || {};
  var sourceName = lxNormalizeSourceName(song.source || song.provider || song.type);
  return [
    sourceName,
    song.songmid || song.id || song.hash || song.FileHash || song.copyrightId || '',
    song.name || song.title || '',
    song.singer || song.artist || '',
    quality || ''
  ].join('|');
}
function invalidateLxResolvedAudioCache(song) {
  var prefix = lxResolvedAudioCacheKey(song, '').replace(/\|$/, '');
  // 空参/nullish/无身份字段（前缀退化成纯分隔符，如 '{}' → '|||'）= 整库失效。
  // 源集合变更（启用/停用/删除/切换/导入后，T13 源管理经 window 钩子传空参调用）时，真实键
  // （'tx|123|…'）不会命中退化前缀 → 必须整库重置（上游 analog：全缓存 reset），否则陈旧地址全存活。
  if (!prefix.replace(/\|/g, '')) {
    Object.keys(lxResolvedAudioCache).forEach(function (key) { delete lxResolvedAudioCache[key]; });
    // 在途去重表一并清：变更前的并发解析不得在变更后被 fromCache 复用（残留单曲在途回写于下次解析自愈，
    // finally 处 `lxResolveInflight[songKey] === chainPromise` 判空安全）。
    Object.keys(lxResolveInflight).forEach(function (key) { delete lxResolveInflight[key]; });
    return;
  }
  Object.keys(lxResolvedAudioCache).forEach(function (key) {
    if (key.indexOf(prefix) === 0) delete lxResolvedAudioCache[key];
  });
}
function cachedLxResolvedAudio(song, quality, excludedResolvers) {
  var key = lxResolvedAudioCacheKey(song, quality);
  var record = lxResolvedAudioCache[key];
  if (!record || record.expiresAt <= Date.now()) {
    if (record) delete lxResolvedAudioCache[key];
    return null;
  }
  var excluded = (excludedResolvers || []).map(function (value) { return String(value || '').trim().toLowerCase(); });
  if (record.resolver && excluded.indexOf(String(record.resolver).trim().toLowerCase()) >= 0) return null;
  return record;
}

function armLxRuntimeErrorFallback(ctx) {
  ctx = ctx || {};
  var retryDepth = Math.max(0, Number(ctx.retryDepth) || 0);
  // 裁决2（T10）：运行时链与起播失败链不再各自封顶 3（合计可长出 6 次重入），合并进随 opts
  // 流转的共享深度 ctx.chainDepth（opts.lxChainDepth），一份闸门封顶 3；retryDepth 保留仅作诊断。
  var chainDepth = Math.max(0, Number(ctx.chainDepth) || 0);
  if (!ctx.media || Math.max(retryDepth, chainDepth) >= 3) return false;
  ctx.media.onerror = function () {
    if (ctx.token !== trackSwitchToken) return;
    if (!claimLxPlaybackReentry(ctx.token)) {
      // 本 token 已由起播失败链重入过，摘钩退出，不再叠加第二条链。
      ctx.media.onerror = null;
      return;
    }
    // T10：正在播放的地址刚被证明失效，先作废该曲客户端缓存（同上游 :32349 失败即 invalidate），
    // 重入解析不许被 90s 镜像缓存拖回死地址。
    invalidateLxResolvedAudioCache(ctx.song);
    var resumeSeconds = Math.max(0, Number(ctx.media.currentTime) || 0);
    var nextExcluded = Array.isArray(ctx.excluded) ? ctx.excluded.slice() : [];
    var playingResolver = String(ctx.resolver || (ctx.song && ctx.song._lxResolver) || '').trim().toLowerCase();
    if (playingResolver && nextExcluded.indexOf(playingResolver) < 0) nextExcluded.push(playingResolver);
    var nextAttempted = Array.isArray(ctx.attempted) ? ctx.attempted.slice() : [];
    if (ctx.proxyAudioUrl && nextAttempted.indexOf(String(ctx.proxyAudioUrl)) < 0) nextAttempted.push(String(ctx.proxyAudioUrl));
    ctx.media.onerror = null;
    showSourceFallbackNotice('播放中断，正在自动换源', '当前音源连接失败，正在从断点附近重新匹配备用音源…');
    var retryOpts = Object.assign({}, ctx.opts || {}, {
      lxRuntimeRetry: retryDepth + 1,
      lxChainDepth: chainDepth + 1,
      resumeAt: resumeSeconds,
      lxExcludeResolvers: nextExcluded,
      lxAttemptedUrls: nextAttempted,
      albumGaplessHandoff: false,
      albumGaplessMixed: false,
      preloadedAudio: null,
      preloadedData: null,
      preloadedProxyAudioUrl: '',
      suppressPlayFailureNotice: true
    });
    delete retryOpts.preResolvedPlaybackData;
    if (typeof window !== 'undefined' && typeof window.playQueueAt === 'function') {
      Promise.resolve(window.playQueueAt(ctx.idx, retryOpts)).catch(function (fallbackError) {
        console.warn('[LxRuntimeFallback]', fallbackError);
        showSourceFallbackNotice('自动换源失败', '已尝试可用备用音源，请稍后重试或切换歌曲。');
      });
    }
  };
  return true;
}

if (typeof window !== 'undefined') {
  window.resolveLxPlaybackSong = resolveLxPlaybackSong;
  // T10：源管理 UI（T13）在音源启用/停用/删除等响应回来后要清客户端镜像缓存，
  // 防服务端 90s 陈旧缓存（T4 发现）被客户端再叠加一层 90s。
  window.invalidateLxResolvedAudioCache = invalidateLxResolvedAudioCache;
  window.clearLxAudioPrefetchTimer = clearLxAudioPrefetchTimer;
}
// —— T9 播放链统一：音源解析三级失败链（止）——
// ============================================================

async function playQueueAt(idx, opts) {
  opts = opts || {};
  if (typeof beginSourceFallbackPlaybackInvocation === 'function' && !beginSourceFallbackPlaybackInvocation(opts)) return false;
  if (idx < 0 || idx >= playQueue.length) return false;
  if (typeof ensurePlaylistQueueHydratedAhead === 'function') ensurePlaylistQueueHydratedAhead(idx);
  var albumGaplessHandoff = !!(opts.albumGaplessHandoff && opts.preloadedAudio && opts.preloadedData);
  var albumGaplessMixed = !!(albumGaplessHandoff && opts.albumGaplessMixed);
  var albumGaplessPreviousAudio = albumGaplessHandoff ? audio : null;
  var albumGaplessAdoptedGain = 0;
  var playbackMedia = null;
  var previousSongForTransition = currentIdx >= 0 && currentIdx < playQueue.length ? playQueue[currentIdx] : null;
  if (
    playMode === 'shuffle'
    && !opts.skipShuffleOrder
    && !opts.autoRepeat
    && !opts.qualitySwitch
    && !opts.resumeRecovery
    && !opts.fallbackDepth
    && typeof reorderQueueForShufflePlaybackOrder === 'function'
  ) {
    idx = reorderQueueForShufflePlaybackOrder(idx, { reason: 'shuffle-play-queue-at', renderPanel: false, rebuildShelf: false, persistSnapshot: false });
  }
  var qualitySwitch = !!opts.qualitySwitch;
  startupRestoreHomePending = false;
  markRenderInteraction(qualitySwitch ? 'quality-switch' : 'track-switch', qualitySwitch ? 520 : 1500);
  var playPhase = 'start';
  function markPlayPhase(name) { playPhase = name; }
  try {
    markPlayPhase('session-finalize');
    safePlaybackStep('session-finalize', function () { finalizeListenSession(false); });
    homeForcedOpen = false;
    if (!opts.preserveHomeState) homeSuppressed = false;
    currentIdx = idx;
    trackSwitchToken++;
    markPlayPhase('cancel-previous-track');
    cancelBeatAnalysisTimer();
    cancelBeatPrefetchTimer();
    // T10（裁决4 计时器卫生）：换曲即撤销上一曲排队的下曲预取（上游 :32249 同位语义）。
    clearLxAudioPrefetchTimer();
    if (typeof resetCuefieldAutoMix === 'function') {
      resetCuefieldAutoMix(opts.cuefieldAutoMix ? 'cuefield-handoff' : 'track-switch', {
        preservePreparedAudio: !!opts.cuefieldAutoMix,
        preserveExecution: !!opts.cuefieldAutoMix
      });
    }
    if (!albumGaplessHandoff) clearAlbumGaplessPreload('track-switch');
    if (localBeatAnalysis.active) cancelLocalBeatAnalysis();
    closeGsapModal(document.getElementById('local-beat-modal'));
    beatMapToken++;
    var token = trackSwitchToken;
    function playbackInvocationStillCurrent(media) {
      return !!(media && token === trackSwitchToken && currentIdx === idx && audio === media);
    }
    function disposeStalePlaybackInvocationMedia(media) {
      if (!media || media === audio) return;
      try {
        media.pause();
        media.removeAttribute('src');
        media.load();
      } catch (e) { }
    }
    var firstVisualPlay = !firstPlayDone;
    markPlayPhase('track-setup');
    var song = safePlaybackStep('hydrate-song', function () { return hydrateCustomCover(playQueue[idx]); }) || playQueue[idx];
    playQueue[idx] = song;
    var sameAlbumCoverSwitch = albumGaplessSameAlbumCover(previousSongForTransition, song);
    var earlyLyricFetchStarted = false;
    function startTrackLyricFetch() {
      if (earlyLyricFetchStarted) return false;
      if (!song || song.type === 'podcast' || song.type === 'local' || song.source === 'local' || song.localUrl) return false;
      if (typeof fetchLyric !== 'function') return false;
      earlyLyricFetchStarted = true;
      setTimeout(function () {
        if (token === trackSwitchToken) fetchLyric(song, token);
      }, 0);
      return true;
    }
    var restoreResumeAt = 0;
    if (
      opts.resumeAt == null
      && pendingPlaybackResumeAt > 0
      && restoredLastPlaybackSnapshot
      && restoredLastPlaybackSnapshot.current
      && queueItemKey(song) === queueItemKey(restoredLastPlaybackSnapshot.current)
      && !opts.autoRepeat
      && !opts.qualitySwitch
    ) {
      restoreResumeAt = pendingPlaybackResumeAt;
    }
    if (restoreResumeAt > 0 && typeof requestStageLyricRestoreWarmup === 'function') {
      requestStageLyricRestoreWarmup(restoreResumeAt, token, 'startup-restore');
    }
    var playbackContext = opts.context || (song && song.radioContext) || null;
    activeRadioContext = playbackContext || null;
    safeRenderQueuePanel('play-queue-at-switch', { scrollCurrent: miniQueueOpen });
    safePlaybackStep('shelf-preview-suppress', suppressShelfPreviewForPlaybackSwitch);
    if (!albumGaplessHandoff) pauseCurrentAudioForTrackSwitch();
    else {
      playToggleBusy = false;
      forcePlaybackControlsInteractive();
    }
    var bmKey = safePlaybackStep('beatmap-key', function () { return beatMapSongKey(song); }) || '';
    var podcastDjMode = !!safePlaybackStep('podcast-mode', function () { return isPodcastSong(song); });
    safePlaybackStep('dj-mode', function () { setDjModeActive(podcastDjMode, song); });
    safePlaybackStep('visual-switch', switchPlaybackVisualToEmily);
    currentLocalSong = null;
    safePlaybackStep('cover-button', updateCustomCoverButton);
    safePlaybackStep('like-buttons', function () { updateLikeButtons(song); });
    safePlaybackStep('like-status', function () { syncLikeStatusForSong(song); });
    safePlaybackStep('cinema-track-profile', function () { if (!qualitySwitch) resetCinemaTrackProfile(song); });
    safePlaybackStep('empty-home', function () { if (!opts.preserveHomeState) updateEmptyHomeVisibility(); });
    safePlaybackStep('track-ui', function () {
      document.getElementById('hint').classList.add('hidden');
      document.getElementById('thumb-title').textContent = song.name;
      document.getElementById('thumb-artist').textContent = song.artist;
      updateControlTrackInfo(song);
      document.getElementById('thumb-wrap').classList.add('visible');
    });
    markPlayPhase('lyric-prep');
    safePlaybackStep('lyric-prep', function () {
      if (qualitySwitch) {
        if (typeof cancelPendingTrackFallbackLyrics === 'function') cancelPendingTrackFallbackLyrics();
        if (typeof markStageLyricsPlaybackResume === 'function') markStageLyricsPlaybackResume('quality-switch-preserve-lyrics');
        applyPreferredLyricsForCurrent(true);
      } else {
        if (typeof resetLyricsForTrackSwitch === 'function') resetLyricsForTrackSwitch(song, token);
        else {
          var initialLyricLines = withLyricFallback([]);
          setOriginalLyricsState(initialLyricLines, false, 'fallback');
          applyPreferredLyricsForCurrent(true);
        }
        startTrackLyricFetch();
        if (typeof scheduleTrackSwitchFallbackLyrics === 'function') scheduleTrackSwitchFallbackLyrics(song, token, 1500);
      }
    });

    markPlayPhase('cover-load');
    safePlaybackStep('cover-load', function () {
      if (qualitySwitch) return;
      // 先 hydrate 确保歌曲对象上挂载自定义封面（从热缓存/旧格式索引同步读取）
      hydrateCustomCover(song);
      var customCover = getCustomCoverForSong(song);
      var coverOpts = {
        trackToken: token,
        deferHeavy: true,
        delay: firstVisualPlay ? 320 : (sameAlbumCoverSwitch ? 80 : 520),
        timeout: firstVisualPlay ? 1300 : 1700,
        seamlessTrackSwitch: !firstVisualPlay,
        noCoverTransition: sameAlbumCoverSwitch,
        colorMixDuration: sameAlbumCoverSwitch ? 1 : undefined
      };
      if (customCover) {
        applyCoverDataUrl(customCover, coverOpts);
      } else {
        // 同步未命中 → 先显示音乐自身封面（避免白屏）
        loadCoverFromUrl(song.cover ? coverUrlWithSize(song.cover, 400) : '', coverOpts);
        // 收集需要异步回填的 key：按歌曲 key（如有 IDB 引用）或全局 key（如有 IDB 引用）
        var pendingKeys = [];
        var songKey = songCustomCoverKey(song);
        if (songKey && customCoverMap[songKey] && typeof customCoverMap[songKey] === 'object' && customCoverMap[songKey].__ref) {
          pendingKeys.push(songKey);
        }
        if (customCoverMap[GLOBAL_CUSTOM_COVER_KEY] && typeof customCoverMap[GLOBAL_CUSTOM_COVER_KEY] === 'object' && customCoverMap[GLOBAL_CUSTOM_COVER_KEY].__ref) {
          pendingKeys.push(GLOBAL_CUSTOM_COVER_KEY);
        }
        if (pendingKeys.length && typeof coverIdbGet === 'function') {
          // 优先取全局（用户上传的一张图覆盖所有歌曲）；若无全局则取按歌曲 key
          var primaryKey = pendingKeys.indexOf(GLOBAL_CUSTOM_COVER_KEY) >= 0 ? GLOBAL_CUSTOM_COVER_KEY : pendingKeys[0];
          coverIdbGet(primaryKey).then(function (entry) {
            if (!entry || !entry.blob) return;
            var toDataUrl = typeof blobToDataUrl === 'function' ? blobToDataUrl(entry.blob) : Promise.resolve(null);
            if (toDataUrl && toDataUrl.then) {
              toDataUrl.then(function (dataUrl) {
                if (!dataUrl) return;
                // 写入热缓存供后续同步读取
                if (typeof _coverDataUrlCache !== 'undefined') _coverDataUrlCache[primaryKey] = dataUrl;
                // 仅当当前仍在播放同一首歌时才刷新（防止竞态闪烁）
                var cur = currentIdx >= 0 && playQueue[currentIdx] ? playQueue[currentIdx] : currentLocalSong;
                if (cur && songCustomCoverKey(cur) === songKey) {
                  cur.customCover = dataUrl;
                  applyCoverDataUrl(dataUrl, { deferHeavy: true, delay: 0, timeout: 800 });
                  safeRenderQueuePanel('custom-cover-async-fill');
                  safeShelfRebuild('custom-cover-async-fill');
                }
              }).catch(function () { /* best-effort */ });
            }
          }).catch(function () { /* best-effort */ });
        }
      }
    });
    safePlaybackStep('trial-banner-reset', function () { document.getElementById('trial-banner').classList.remove('show'); });
    if (song.type === 'local' || song.source === 'local' || song.localUrl) {
      markPlayPhase('local-audio');
      var localStarted = await playLocalQueueSong(song, idx, token, firstVisualPlay, opts, restoreResumeAt);
      if (localStarted === true && typeof completeSourceFallbackRecovery === 'function') {
        completeSourceFallbackRecovery(sourceFallbackRecoveryFromOptions(opts));
      }
      return localStarted === true;
    }
    safePlaybackStep('show-loading', function () { showLoading({ trackSwitch: true, seamlessCover: true }); });
    if (!qualitySwitch) lyricSunEnergy = 0; lyricSunTarget = 0; lyricSunHold = 0; lyricSunAvg = 0; lyricSunPeak = 0.55;

    // 首次播放: 粒子从暗处浮出 (Apple 风格)
    if (firstVisualPlay) {
      safePlaybackStep('first-visual-alpha', function () {
        firstPlayDone = true;
        tweenParticleAlpha(uniforms.uAlpha.value || 0, 1.0, 220);
      });
    }

    try {
      markPlayPhase('source-url');
      var playbackProvider = normalizePlaybackProvider(songProviderKey(song));
      var isQQPlayback = playbackProvider === 'qq';
      var isKugouPlayback = playbackProvider === 'kugou';
      var isQishuiPlayback = playbackProvider === 'qishui';
      var isSpotifyPlayback = playbackProvider === 'spotify';
      var requestedQuality = normalizePlaybackQualityForProvider(opts.qualityOverride || getProviderPlaybackQuality(playbackProvider), playbackProvider);
      // T12：jymaster×SVIP cookie 降级行退役——母带档恒可请求，实际能力由音源降级链
      // 决定并以 probeWarning 提示（见 song.lxProbeWarning → 音质 pill tooltip）。
      var runtimeQualityCap = playbackQualityCapValue(song, playbackProvider);
      if (playbackQualityAboveCap(requestedQuality, playbackProvider, runtimeQualityCap)) {
        requestedQuality = runtimeQualityCap;
      }
      var qualityParam = '&quality=' + encodeURIComponent(requestedQuality);
      // T9 阶段2切换：播放解析统一走 /api/lx-source/resolve 三级失败链；预解析直通，播客豁免暂时保留旧网易路由（T16 退役）。
      var lxExcludedResolvers = Array.isArray(opts.lxExcludeResolvers) ? opts.lxExcludeResolvers.slice() : [];
      var lxAttemptedUrls = Array.isArray(opts.lxAttemptedUrls) ? opts.lxAttemptedUrls.slice() : [];
      var data;
      if (albumGaplessHandoff) {
        data = opts.preloadedData;
      } else if (opts.preResolvedPlaybackData && opts.preResolvedPlaybackData.url) {
        data = opts.preResolvedPlaybackData;
      } else if (song.type === 'podcast' || song.source === 'podcast') {
        // 播客豁免：仍走旧网易 song/url 路由（唯一残留官方播放解析调用，T15/T16 处理）。
        data = await apiJson('/api/song/url?id=' + encodeURIComponent(song.id || '') + neteasePlaybackMatchQuery(song) + qualityParam, { timeoutMs: 14000 });
      } else {
        var lxResolved = await resolveLxPlaybackSong(song, {
          quality: requestedQuality,
          excludeResolvers: lxExcludedResolvers,
          attemptedUrls: lxAttemptedUrls,
          // T10（裁决5）：音质切换重载必须绕过缓存取新音质地址——缓存键含音质词，
          // 同键命中意味着新旧同音质，显式绕缓存只为防御与语义直白。
          allowCacheLayer: !qualitySwitch
        });
        data = {
          url: lxResolved.url || lxResolved.proxyUrl,
          proxyUrl: lxResolved.proxyUrl,
          level: lxPlaybackLevelFromLxQuality(lxResolved.actual),
          source: lxResolved.source,
          resolver: lxResolved.resolver,
          lxSource: true,
          lxActualQuality: lxResolved.actual,
          lxProbeWarning: !!lxResolved.probeWarning
        };
        if (lxResolved.crossMatched && typeof lxSourcePlatformLabel === 'function') {
          song.sourceLabel = lxSourcePlatformLabel(lxResolved.source);
          song.resolvedSourceLabel = lxSourcePlatformLabel(lxResolved.source) + '（跨平台自动换源）';
          song.resolvedPlaybackProvider = 'lx-custom-source';
        }
      }
      if (token !== trackSwitchToken) return;
      if (
        typeof sourceFallbackRecoveryFromOptions === 'function'
        && sourceFallbackRecoveryFromOptions(opts)
        && !sourceFallbackRecoveryCanContinue(sourceFallbackRecoveryFromOptions(opts))
      ) {
        return settleExpiredSourceFallbackPlayback(idx, token, opts);
      }
      if (data) {
        // 如果第三方已设定 provider（lx-custom-source），不要被官方 provider 覆盖
        if (song.resolvedPlaybackProvider !== 'lx-custom-source') {
          song.resolvedPlaybackProvider = playbackProvider;
        }
        song.playbackLevel = data.level || song.playbackLevel || '';
        if (!data.sourceMatch) song.playbackSource = data.source || data.provider || song.playbackSource || '';
        if (playbackProvider === 'netease' && !data.sourceMatch) clearNeteaseSourceMatchMetadata(song);
        song.trial = !!(song.trial || data.trial);
        song.vipRequired = !!(
          song.vipRequired ||
          data.trial ||
          data.needVip ||
          data.need_vip ||
          data.vipRequired ||
          data.onlyVipPlayable ||
          data.only_vip_playable ||
          (data.restriction && /vip_required|paid_required|trial_only|need_vip|only_vip/i.test(String(data.restriction.category || data.restriction.reason || data.restriction.message || ''))) ||
          /vip_required|paid_required|trial_only|need_vip|only_vip/i.test(String(data.category || data.reason || data.error || data.message || '')) ||
          (typeof songRequiresVip === 'function' && songRequiresVip(Object.assign({}, song, data)))
        );
        if (typeof updateControlTrackInfo === 'function') updateControlTrackInfo(song);
        if (isKugouPlayback && typeof applyKugouPlaybackStatusEvidence === 'function') applyKugouPlaybackStatusEvidence(data);
        if (isQQPlayback && typeof applyQQPlaybackStatusEvidence === 'function') applyQQPlaybackStatusEvidence(data, song);
      }
      var retryPlaybackOpts = Object.assign({}, opts, { resumeAt: opts.resumeAt != null ? opts.resumeAt : restoreResumeAt });
      if (!data || !data.url) {
        var fallbackResult = await tryAutoPlaybackFallback(song, data, idx, token, retryPlaybackOpts);
        if (fallbackResult !== null) return fallbackResult === true;
        if (opts.startupAutoplay) {
          markQueueItemPlaybackFailed(idx);
          return false;
        }
        handlePlaybackUnavailable(song, data);
        return false;
      }
      var resolvedQualityText = playbackResolvedQualityText(data, playbackProvider);
      var qualityDowngraded = !!(data && data.level && playbackQualityWasDowngraded(requestedQuality, data.level, playbackProvider));
      if (qualityDowngraded && !(data && data.lxSource)) markPlaybackQualityRuntimeCap(song, playbackProvider, data.level, 'resolved-lower');
      // T12：resolve 的 probeWarning 落到 song——驱动音质 pill tooltip
      // 「在线音源按平台能力自动降级」（上游 index.html:23228），替代旧 cookie/VIP 门槛；
      // 每次成功解析都覆写，防旧降级态跨曲残留。
      var lxProbeFlag = !!(data && data.lxSource && data.lxProbeWarning);
      if (song.lxProbeWarning !== lxProbeFlag) {
        song.lxProbeWarning = lxProbeFlag;
        if (typeof updatePlaybackQualityUi === 'function') updatePlaybackQualityUi();
      }
      if (!opts.startupAutoplay && !isQQPlayback && qualityDowngraded) {
        showSourceFallbackNotice(data && data.lxSource ? '音源音质自动降级' : ((isKugouPlayback ? '酷狗' : (isQishuiPlayback ? '汽水' : '网易云')) + '音质自动降级'), '请求 ' + playbackQualityLabel(requestedQuality, playbackProvider) + '，实际播放 ' + resolvedQualityText + '。');
      } else if (!opts.startupAutoplay && opts.qualitySwitch) {
        showSourceFallbackNotice('音质已切换', '实际播放: ' + resolvedQualityText + '。');
      }
      if (data.trial) {
        var txt;
        if (data.loggedIn && data.vipLevel === 'svip') txt = '此歌曲需要单曲、专辑购买或更高权限';
        else if (data.loggedIn && data.vipLevel === 'vip') txt = '此歌曲需要 SVIP 或购买 · 当前仅播放试听片段';
        else if (data.loggedIn) txt = '此歌曲需 VIP · 当前仅播放试听片段';
        else txt = '当前未登录 · 仅播放试听片段';
        document.getElementById('trial-text').textContent = txt;
        document.getElementById('trial-banner').classList.add('show');
      }
      markPlayPhase('audio-element');
      var proxyAudioUrl = opts.preloadedProxyAudioUrl || (data && data.proxyUrl ? String(data.proxyUrl) : '/api/audio?url=' + encodeURIComponent(data.url));
      if (albumGaplessHandoff) {
        audioFadeSerial++;
        clearAudioFadeTimers();
        if (albumGaplessPreviousAudio) albumGaplessPreviousAudio.onended = null;
        audio = opts.preloadedAudio;
        if (opts.cuefieldAutoMix && typeof claimCuefieldPreparedAudioForPlayback === 'function') {
          claimCuefieldPreparedAudioForPlayback(audio);
        }
        var preparedGraphGain = opts.cuefieldAutoMix && audio.__stellaflixPreparedAudioGraph && audio.__stellaflixPreparedAudioGraph.gainNode
          ? Number(audio.__stellaflixPreparedAudioGraph.gainNode.gain.value)
          : NaN;
        albumGaplessAdoptedGain = albumGaplessMixed
          ? clampRange(isFinite(preparedGraphGain) ? preparedGraphGain : (Number(audio.volume) || 0), 0, 1)
          : audioSilentFloor();
        audio.crossOrigin = 'anonymous';
        audio.autoplay = true;
        audio.preload = 'auto';
        if (!audio.src) audio.src = proxyAudioUrl;
        if (!albumGaplessMixed) audio.volume = 0;
        else audio.muted = false;
      } else if (!audio) {
        audio = new Audio();
        audio.crossOrigin = 'anonymous';
      } else {
        audioFadeSerial++;
        clearAudioFadeTimers();
        audio.pause();
      }
      resetPlaybackAudioGraphForSourceSwitch(albumGaplessHandoff ? 'album-gapless-handoff' : 'track-switch');
      audio.autoplay = true;
      audio.preload = 'auto';
      // resetPlaybackAudioGraphForSourceSwitch may deliberately replace a
      // capture-backed element before a new src is assigned. Capture the
      // expected media only after that lifetime reset so playAudio never holds
      // a stale, already-paused element reference.
      playbackMedia = audio;
      bindPlaybackProgressEvents(audio);
      if (albumGaplessHandoff) setAudioOutputGainImmediate(albumGaplessMixed ? albumGaplessAdoptedGain : audioSilentFloor());
      else applyVolumeToAudio();
      await applyAudioOutputDevice(playbackMedia);
      if (!playbackInvocationStillCurrent(playbackMedia)) {
        disposeStalePlaybackInvocationMedia(playbackMedia);
        return false;
      }
      if (
        typeof sourceFallbackRecoveryFromOptions === 'function'
        && sourceFallbackRecoveryFromOptions(opts)
        && !sourceFallbackRecoveryCanContinue(sourceFallbackRecoveryFromOptions(opts))
      ) {
        return settleExpiredSourceFallbackPlayback(idx, token, opts);
      }
      if (!albumGaplessHandoff) audio.src = proxyAudioUrl;
      audio.__stellaflixQueueItemKey = queueItemKey(song);
      audio.__stellaflixTrackSwitchToken = token;
      updatePlaybackProgressUi();
      audio.onended = function () {
        if (token !== trackSwitchToken) return;
        if (this && this.__stellaflixCuefieldEndedRecoveryToken === token) return;
        if (typeof cuefieldAutoMixExecuting !== 'undefined' && cuefieldAutoMixExecuting) {
          if (typeof noteCuefieldAutoMixOutgoingEnded === 'function') noteCuefieldAutoMixOutgoingEnded(this, token, currentIdx);
          return;
        }
        finalizeListenSession(true);
        if (playAlbumGaplessNextOnEnded(token)) return;
        if (playMode === 'single') setTimeout(function () { playQueueAt(currentIdx, { autoRepeat: true, suppressPlayFailureNotice: true }); }, 0);
        else setTimeout(nextTrack, 0);
      };
      // T9 第三级前置：运行时播放错误（onerror）→ 携带排除状态的整曲重解析（递归上限 3）。
      if (data && data.lxSource && typeof armLxRuntimeErrorFallback === 'function') {
        armLxRuntimeErrorFallback({
          media: playbackMedia,
          token: token,
          idx: idx,
          song: song,
          opts: retryPlaybackOpts,
          resolver: String(data.resolver || song._lxResolver || ''),
          excluded: lxExcludedResolvers,
          attempted: lxAttemptedUrls,
          proxyAudioUrl: String(proxyAudioUrl),
          retryDepth: Number(opts.lxRuntimeRetry) || 0,
          // 裁决2（T10）：与起播失败链共享一份深度闸门（opts.lxChainDepth），合计封顶 3。
          chainDepth: Number(opts.lxChainDepth) || 0,
          quality: requestedQuality
        });
      }
      scheduleAudioResumePosition(audio, opts.resumeAt != null ? opts.resumeAt : restoreResumeAt, token);
      if (restoreResumeAt > 0) pendingPlaybackResumeAt = 0;
      if (!albumGaplessHandoff) audio.load();
      markPlayPhase(qualitySwitch ? 'visual-prep-skip' : 'visual-prep');
      if (qualitySwitch) {
        if (typeof markStageLyricsPlaybackResume === 'function') markStageLyricsPlaybackResume('quality-switch-audio-ready');
      } else try {
        // 重置 beatmap 状态
        currentBeatMap = null;
        beatMapNextIdx = 0;
        resetAudioVisualState({ preserveEnvelope: albumGaplessMixed });
        resetBeatCameraSync(audio && isFinite(audio.currentTime) ? audio.currentTime : 0, { preserveMomentum: albumGaplessMixed });
        cancelBeatAnalysisTimer();
        beatMapToken++;
        var bmTok = beatMapToken;
        if (podcastDjMode) {
          // 播客走独立 DJ 离线锁拍系统, 不写入普通歌曲 beatMap.
          djBeatMapToken++;
          cancelDjBeatAnalysisTimer();
          resetDjBeatMapState();
          currentBeatMap = null;
          beatMapNextIdx = 0;
          var djTok = djBeatMapToken;
          var djKey = djSongKey(song);
          if (djBeatMapCache[djKey]) {
            currentDjBeatMap = djBeatMapCache[djKey];
            applyPodcastDjProfileFromMap(currentDjBeatMap);
            syncPodcastDjMapCursor(audio ? audio.currentTime : 0, true);
            hideBeatChip();
            notifyDesktopLyricsBeatMapReady();
            console.log('podcast DJ beatmap 缓存命中:', currentDjBeatMap.cameraBeats.length, '个主拍');
          } else {
            showBeatChip('DJ 离线锁拍准备中…');
            var djDurationSec = Math.max(0, Number(song.duration) || 0);
            if (djDurationSec > 10000) djDurationSec /= 1000;
            schedulePodcastDjAnalysis(djKey, data.url, djTok, djDurationSec);
          }
          maybeAnnounceDjMode();
        } else if (bmKey && beatMapCache[bmKey]) {
          // 如果缓存有, 直接用
          currentBeatMap = beatMapCache[bmKey];
          applyCinemaProfileFromBeatMap(currentBeatMap);
          syncBeatMapPlaybackCursor(audio ? audio.currentTime : 0, albumGaplessMixed);
          notifyDesktopLyricsBeatMapReady();
          console.log('beatmap 缓存命中:', currentBeatMap.kicks.length, '个鼓点');
          scheduleQueueBeatPrefetch(idx, 2600);
        } else {
          var diskBeatMap = bmKey ? await readBeatDiskCache(bmKey) : null;
          if (!playbackInvocationStillCurrent(playbackMedia)) {
            disposeStalePlaybackInvocationMedia(playbackMedia);
            return false;
          }
          if (diskBeatMap) {
            currentBeatMap = diskBeatMap;
            applyCinemaProfileFromBeatMap(currentBeatMap);
            syncBeatMapPlaybackCursor(audio ? audio.currentTime : 0, albumGaplessMixed);
            notifyDesktopLyricsBeatMapReady();
            console.log('beatmap D盘缓存命中:', currentBeatMap.kicks.length, '个鼓点');
            scheduleQueueBeatPrefetch(idx, 2600);
          } else {
            // 后台延迟分析, 避免新歌刚开始播放时抢占解码和渲染资源
            scheduleBeatAnalysis(bmKey || song.id, proxyAudioUrl, bmTok, song);
          }
        }
      } catch (visualErr) {
        console.warn('[PlaybackVisualPrep]', song && song.name, visualErr);
        currentBeatMap = null;
        beatMapNextIdx = 0;
        safePlaybackStep('visual-prep-hide-chip', hideBeatChip);
      }
      markPlayPhase('audio-start');
      if (!playbackInvocationStillCurrent(playbackMedia)) return false;
      var playbackStarted = await playAudio({ manual: !!opts.manual, silent: isQQPlayback || !!opts.startupAutoplay || !opts.manual, startupAutoplay: !!opts.startupAutoplay, trackSwitch: true, resumeRecovery: !!opts.resumeRecovery, fade: albumGaplessHandoff ? false : opts.fade, preserveGain: albumGaplessMixed, expectedMedia: playbackMedia, expectedToken: token });
      if (!playbackInvocationStillCurrent(playbackMedia)) return false;
      if (
        typeof sourceFallbackRecoveryFromOptions === 'function'
        && sourceFallbackRecoveryFromOptions(opts)
        && !sourceFallbackRecoveryCanContinue(sourceFallbackRecoveryFromOptions(opts))
      ) {
        return settleExpiredSourceFallbackPlayback(idx, token, opts);
      }
      if (!playbackStarted) {
        // T9 修复轮1：起播失败即摘掉运行时钩——本分支与 armLxRuntimeErrorFallback 共用
        // 同一个共享 audio 载体，钩不摘则两条链可能同 token 并发重入（3×3）。
        if (playbackMedia) playbackMedia.onerror = null;
        // T9 第一级（播放启动失败重进）：lx 解析成功但媒体起播失败 → 排除当前 resolver 后重走三级链。
        // 裁决2（T10）：闸门改读共享深度 opts.lxChainDepth（运行时链+起播失败链合计封顶 3，不再是各自 3）；
        // lxStartRetryDepth 保留仅作诊断。
        if (data && data.lxSource && (Number(opts.lxChainDepth) || 0) < 3) {
          // 单链闸：本 token 若已被运行时 onerror 链占坑，则那条链正在重解析，这里既不再
          // 发第二条，也不落到下面的官方回退/跳过队列项分支（否则同曲多重失败提示+多重链）。
          if (!claimLxPlaybackReentry(token)) return false;
          // T10：起播失败说明刚解析出的地址不可用，作废该曲客户端缓存（上游 :32349 同位），
          // 重入必须重新解析而不是 90s 内复用死地址。
          invalidateLxResolvedAudioCache(song);
          var lxStartExclude = lxExcludedResolvers.slice();
          var lxStartAttempted = lxAttemptedUrls.slice();
          if (data.resolver) lxStartExclude.push(String(data.resolver));
          if (song._lxResolver) lxStartExclude.push(String(song._lxResolver));
          if (proxyAudioUrl) lxStartAttempted.push(String(proxyAudioUrl));
          if (!opts.suppressPlayFailureNotice) showSourceFallbackNotice('当前音源不可用', '正在自动切换其他音源重新解析。');
          var lxStartRetry = await playQueueAt(idx, Object.assign({}, retryPlaybackOpts, {
            albumGaplessHandoff: false,
            albumGaplessMixed: false,
            preloadedAudio: null,
            preloadedData: null,
            preloadedProxyAudioUrl: '',
            lxExcludeResolvers: lxStartExclude,
            lxAttemptedUrls: lxStartAttempted,
            lxStartRetryDepth: (Number(opts.lxStartRetryDepth) || 0) + 1,
            lxChainDepth: (Number(opts.lxChainDepth) || 0) + 1,
            suppressPlayFailureNotice: true
          }));
          if (token !== trackSwitchToken) return lxStartRetry === true;
          return lxStartRetry === true;
        }
        if (playbackProvider === 'netease' && data && data.sourceMatch) {
          var sameSourceRetry = await retryNeteaseSourceMatchPlayback(song, data, idx, token, retryPlaybackOpts, requestedQuality);
          if (sameSourceRetry !== null) return sameSourceRetry === true;
          var matchedPlaybackFallback = await tryAutoPlaybackFallback(song, Object.assign({}, data, { url: null, reason: 'media_start_failed' }), idx, token, retryPlaybackOpts);
          if (matchedPlaybackFallback !== null) return matchedPlaybackFallback === true;
        }
        if (isQQPlayback) {
          var qqRetryStarted = await retryQQPlaybackWithCompatibleQuality(song, idx, token, retryPlaybackOpts, data, requestedQuality);
          if (token !== trackSwitchToken) return qqRetryStarted === true;
          if (qqRetryStarted) return true;
        }
        var mediaFailureRecovery = typeof sourceFallbackRecoveryFromOptions === 'function'
          ? sourceFallbackRecoveryFromOptions(retryPlaybackOpts)
          : null;
        if (!opts.manual && (!opts.startupAutoplay || mediaFailureRecovery)) {
          var mediaFailureFallback = await tryAutoPlaybackFallback(
            song,
            Object.assign({}, data || {}, { url: null, reason: 'media_start_failed' }),
            idx,
            token,
            retryPlaybackOpts
          );
          if (mediaFailureFallback !== null) return mediaFailureFallback === true;
          if (mediaFailureRecovery) {
            return await skipFailedQueueItem(
              idx,
              token,
              '当前歌曲无法启动播放，正在尝试队列里的下一首。',
              sourceFallbackRecoveryFailureOptions(retryPlaybackOpts)
            );
          }
        }
        forcePlaybackControlsInteractive();
        if (opts.startupAutoplay && !mediaFailureRecovery) {
          return false;
        }
        if (!opts.suppressPlayFailureNotice) {
          if (opts.manual) {
            showToast('播放启动失败，请重新选择歌曲');
          } else {
            showSourceFallbackNotice('歌曲已载入', '点击播放器中间的播放按钮继续播放。');
          }
        }
        return false;
      }
      forcePlaybackControlsInteractive();
      if (playbackProvider === 'netease' && data && data.sourceMatch) {
        applyNeteaseSourceMatchMetadata(song, data);
        if (typeof updateControlTrackInfo === 'function') updateControlTrackInfo(song);
      }
      if (!opts.startupAutoplay && !opts.qualitySwitch && data && data.sourceMatch && !song.neteaseSourceMatchNotified && typeof showSourceFallbackNotice === 'function') {
        song.neteaseSourceMatchNotified = true;
        showSourceFallbackNotice('网易云已匹配可播音源', '已在网易云内切换到同一首歌的可播版本；歌词、封面、专辑和队列仍保持原曲。');
      }
      if (albumGaplessHandoff && albumGaplessMixed && typeof rampAudioOutputGain === 'function') {
        rampAudioOutputGain(targetVolume, ALBUM_GAPLESS_ADOPT_SLEW_MS);
      }
      if (albumGaplessHandoff && albumGaplessPreviousAudio && albumGaplessPreviousAudio !== audio) {
        setTimeout(function () {
          try {
            albumGaplessPreviousAudio.pause();
            albumGaplessPreviousAudio.removeAttribute('src');
            albumGaplessPreviousAudio.load();
          } catch (e) { }
        }, 220);
      }
      markPlayPhase('session-begin');
      safePlaybackStep('listen-session-begin', function () { beginListenSession(song, playbackContext); });
      markPlayPhase('lyrics-fetch');
      if (song.type === 'podcast') {
        if (typeof cancelPendingTrackFallbackLyrics === 'function') cancelPendingTrackFallbackLyrics();
        safePlaybackStep('podcast-lyrics', function () {
          var podcastLyricLines = withLyricFallback([]);
          setOriginalLyricsState(podcastLyricLines, false, 'fallback');
          applyPreferredLyricsForCurrent(true);
        });
      } else if (!qualitySwitch) {
        if (!earlyLyricFetchStarted) fetchLyric(song, token);
      } else {
        if (typeof cancelPendingTrackFallbackLyrics === 'function') cancelPendingTrackFallbackLyrics();
        if (typeof markStageLyricsPlaybackResume === 'function') markStageLyricsPlaybackResume('quality-switch-lyrics-kept');
      }
      if (!qualitySwitch) {
        safeRenderQueuePanel('play-queue-at');
        scheduleShelfRebuild('play-queue-at', true);
        if (typeof scheduleQueueLyricPrefetch === 'function') scheduleQueueLyricPrefetch(idx, 2400);
      }
      if (!qualitySwitch && typeof scheduleCuefieldAutoMixPrepare === 'function') {
        var cuefieldPrepareDelay = typeof cuefieldAutoMixPostSwitchDelay === 'function'
          ? cuefieldAutoMixPostSwitchDelay(!!opts.cuefieldAutoMix)
          : 4200;
        scheduleCuefieldAutoMixPrepare(token, idx, cuefieldPrepareDelay);
      }
      scheduleAlbumGaplessPreloadForCurrent(token, albumGaplessHandoff ? 'album-gapless-handoff-started' : 'track-started');
      // T10：lx 起播成功后 700ms 预取队列下一首（上游 :32374 同位）；播客豁免路由不预取。
      if (data && data.lxSource) scheduleLxAudioPrefetch(token, idx, requestedQuality);
      safePlaybackStep('shelf-preview-suppress-end', suppressShelfPreviewForPlaybackSwitch);
      if (typeof completeSourceFallbackRecovery === 'function') {
        completeSourceFallbackRecovery(sourceFallbackRecoveryFromOptions(opts));
      }
      return true;
    } catch (err) {
      console.error('Play failed:', { phase: playPhase, error: err }, err);
      hideLoading();
      forcePlaybackControlsInteractive();
      var catchRecovery = typeof sourceFallbackRecoveryFromOptions === 'function'
        ? sourceFallbackRecoveryFromOptions(opts)
        : null;
      if (opts.startupAutoplay && !catchRecovery) {
        return false;
      }
      if (catchRecovery && opts.fallbackDepth > 0) return false;
      if (!isPlaybackRecursionError(err) && token === trackSwitchToken && !opts.manual && (catchRecovery || playQueue.length > 1)) {
        return await skipFailedQueueItem(
          idx,
          token,
          '当前歌曲加载失败，正在尝试队列里的下一首。',
          catchRecovery ? sourceFallbackRecoveryFailureOptions(opts) : { playbackOpts: opts }
        );
      }
      if (opts.suppressPlayFailureNotice) return false;
      var failText = playbackFailureToastText(err);
      showToast(failText);
      if (typeof showSourceFallbackNotice === 'function') showSourceFallbackNotice('播放失败', failText);
      return false;
    }
  } catch (setupErr) {
    console.error('Play setup failed:', { phase: playPhase, error: setupErr }, setupErr);
    hideLoading();
    forcePlaybackControlsInteractive();
    var setupRecovery = typeof sourceFallbackRecoveryFromOptions === 'function'
      ? sourceFallbackRecoveryFromOptions(opts)
      : null;
    if (opts.startupAutoplay && !setupRecovery) {
      return false;
    }
    if (setupRecovery && opts.fallbackDepth > 0) return false;
      if (!isPlaybackRecursionError(setupErr) && typeof token !== 'undefined' && token === trackSwitchToken && !opts.manual && (setupRecovery || playQueue.length > 1)) {
        return await skipFailedQueueItem(
          idx,
          token,
          '当前歌曲切换失败，正在尝试队列里的下一首。',
          setupRecovery ? sourceFallbackRecoveryFailureOptions(opts) : { playbackOpts: opts }
        );
    }
    if (opts.suppressPlayFailureNotice) return false;
    var setupFailText = playbackFailureToastText(setupErr);
    showToast(setupFailText);
    if (typeof showSourceFallbackNotice === 'function') showSourceFallbackNotice('播放失败', setupFailText);
    return false;
  }
}
