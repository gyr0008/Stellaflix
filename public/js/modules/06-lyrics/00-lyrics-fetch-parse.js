function hasUsableLyricLines(lines) {
  return (Array.isArray(lines) ? lines : []).some(function (line) {
    return line && !line.fallback && !isNoLyricText(line.text);
  });
}
var lyricQueuePrefetchTimer = 0;
var lyricQueuePrefetchToken = 0;
var lyricQueuePrefetchBusy = false;
var lyricQueuePrefetchKeys = {};
function lyricTranslationTextFromAliases(source) {
  source = source || {};
  return source.tlyric || source.trans || source.translatedLyric || source.translation || source.translated_lyric || '';
}
// 批 T15.5b：歌词统一走 lx 音源——POST /api/lx-source/lyric {source, musicInfo}
// → server.js:8118 → lxSourceHost.getLyric（上游 index.html:32107 同款消费形态）。
// 官方五路歌词路由（网易云裸 id 路由 + qq/kugou/qishui/spotify 四路分派）的消费方在此
// 整体退役，路由本体删除归 T16。
// 无 lx 源映射（汽水/Spotify/本地/播客/lx 自定义源）不发网络，直接落「暂无歌词」标题兜底；
// 上游 platform-lyric 裸 HTTP 兜底链（index.html:32058-32135）按 YAGNI 未移植——无源即无线上歌词。
var LX_LYRIC_SOURCES = { tx: 1, wy: 1, kw: 1, kg: 1, mg: 1 };
var LX_LYRIC_PROVIDER_ALIAS = { qq: 'tx', netease: 'wy', kuwo: 'kw', kugou: 'kg', migu: 'mg' };

function lxLyricSourceForSong(songOrId) {
  var song = (songOrId && typeof songOrId === 'object') ? songOrId : null;
  // 裸 id 调用沿用旧网易云数字 id 语义。
  if (!song) return 'wy';
  if (song.type === 'local' || song.type === 'podcast' ||
    song.source === 'local' || song.localUrl || song.localKey) return '';
  var provider = typeof songProviderKey === 'function' ? songProviderKey(song) : String(song.source || song.provider || 'netease');
  var raw = String(song.source || song.provider || provider || '').toLowerCase();
  if (LX_LYRIC_SOURCES[raw]) return raw;
  var alias = LX_LYRIC_PROVIDER_ALIAS[raw] || LX_LYRIC_PROVIDER_ALIAS[provider];
  return alias && LX_LYRIC_SOURCES[alias] ? alias : '';
}

// musicInfo 即 lx 沙箱脚本 getLyric 的入参：逐源只带该源解析器真正需要的标识字段
// （tx→mid、kw→songmid、kg→hash、wy/mg→数字 id），其余字段仅作匹配辅助。
function lxLyricMusicInfo(songOrId) {
  var song = (songOrId && typeof songOrId === 'object') ? songOrId : { id: songOrId };
  var sourceName = lxLyricSourceForSong(songOrId);
  var rawId = song.id != null && song.id !== '' ? String(song.id) : '';
  var info = {
    type: 'music',
    source: sourceName,
    name: song.name || song.title || '',
    singer: song.singer || song.artist || song.author || ''
  };
  if (sourceName === 'tx') {
    info.mid = song.mid || song.songmid || rawId;
    if (/^\d+$/.test(rawId)) info.id = rawId;
  } else if (sourceName === 'kw') {
    info.songmid = song.songmid || song.mid || rawId;
    if (rawId) info.id = rawId;
  } else if (sourceName === 'kg') {
    info.hash = song.hash || song.fileHash || song.audioHash || rawId;
    info.albumId = song.albumId || song.album_audio_id || '';
  } else {
    info.id = rawId || song.copyrightId || song.sid || '';
    if (sourceName === 'mg') info.copyrightId = song.copyrightId || rawId || '';
  }
  info.albumName = song.albumName || song.album || '';
  info.interval = song.interval || song.duration || '';
  info.img = song.picUrl || song.img || song.cover || song.coverUrl || '';
  return info;
}

function fetchLxLyricPayload(songOrId, options) {
  options = options || {};
  var sourceName = lxLyricSourceForSong(songOrId);
  if (!sourceName) return Promise.resolve(null);
  return apiJson('/api/lx-source/lyric', Object.assign({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: sourceName, musicInfo: lxLyricMusicInfo(songOrId) }),
    timeoutMs: 22000
  }, options));
}

function persistentLyricCacheKey(song) {
  song = song || {};
  var provider = typeof songProviderKey === 'function' ? songProviderKey(song) : (song.source || song.provider || 'netease');
  var id = song.id || song.mid || song.songmid || song.hash || '';
  var artist = song.artist || song.singer || song.artists || '';
  return ['lyrics-v1', provider, id, song.name || song.title || '', artist].join('|');
}

function readPersistentLyricCache(song) {
  if (!window.desktopWindow || typeof window.desktopWindow.readLyricCache !== 'function') return Promise.resolve(null);
  return window.desktopWindow.readLyricCache(persistentLyricCacheKey(song)).then(function (result) {
    return result && result.ok && result.hit && result.payload ? result.payload : null;
  }).catch(function () { return null; });
}

function writePersistentLyricCache(song, payload) {
  if (!window.desktopWindow || typeof window.desktopWindow.writeLyricCache !== 'function' || !payload || typeof payload !== 'object') return;
  window.desktopWindow.writeLyricCache(persistentLyricCacheKey(song), payload).catch(function () {});
}

function lyricQueuePrefetchCandidate(song) {
  if (!song || song.type === 'podcast' || song.type === 'local' || song.source === 'local' || song.localUrl) return false;
  return !!(song.id || song.mid || song.songmid || song.hash || song.name || song.title);
}

function nextQueueLyricPrefetchSong(fromIndex) {
  if (!Array.isArray(playQueue) || playQueue.length < 2) return null;
  var total = playQueue.length;
  var from = isFinite(Number(fromIndex)) ? Math.round(Number(fromIndex)) : currentIdx;
  for (var step = 1; step < total; step++) {
    var index = (from + step + total) % total;
    if (index === currentIdx) continue;
    var song = playQueue[index];
    if (!lyricQueuePrefetchCandidate(song)) continue;
    var key = persistentLyricCacheKey(song);
    if (!key || lyricQueuePrefetchKeys[key]) continue;
    return { song: song, key: key };
  }
  return null;
}

function scheduleQueueLyricPrefetch(fromIndex, delay) {
  if (lyricQueuePrefetchTimer) clearTimeout(lyricQueuePrefetchTimer);
  lyricQueuePrefetchTimer = 0;
  if (lyricQueuePrefetchBusy || !Array.isArray(playQueue) || playQueue.length < 2) return false;
  var token = ++lyricQueuePrefetchToken;
  var wait = Math.max(1200, Number(delay) || 2400);
  lyricQueuePrefetchTimer = setTimeout(function () {
    lyricQueuePrefetchTimer = 0;
    runQueueLyricPrefetch(fromIndex, token);
  }, wait);
  return true;
}

async function runQueueLyricPrefetch(fromIndex, token) {
  if (token !== lyricQueuePrefetchToken || lyricQueuePrefetchBusy) return false;
  if (audio && audio.paused) return false;
  var candidate = nextQueueLyricPrefetchSong(fromIndex);
  if (!candidate) return false;
  lyricQueuePrefetchKeys[candidate.key] = true;
  lyricQueuePrefetchBusy = true;
  try {
    var cached = await readPersistentLyricCache(candidate.song);
    if (token !== lyricQueuePrefetchToken) return false;
    if (cached) return true;
    var response = await fetchLxLyricPayload(candidate.song);
    if (token !== lyricQueuePrefetchToken) return false;
    if (!response) return false;
    var merged = mergeInlineLyricResponseForSong(candidate.song, response || {});
    var state = parseLyricResponseToOriginalState(candidate.song, merged);
    if (!state || !state.usableLyric) return false;
    writePersistentLyricCache(candidate.song, merged);
    return true;
  } catch (_) {
    return false;
  } finally {
    lyricQueuePrefetchBusy = false;
  }
}

function applyFetchedLyricResponse(song, token, response, options) {
  options = options || {};
  if (token !== trackSwitchToken) return null;
  var mergedResponse = mergeInlineLyricResponseForSong(song, response || {});
  cancelPendingTrackFallbackLyrics();
  var state = parseLyricResponseToOriginalState(song, mergedResponse);
  setOriginalLyricsState(state.lines, state.hasNativeKaraoke, state.timingSource, state.translationLines, state.translationSource);
  applyPreferredLyricsForCurrent(true);
  if (state.usableLyric && options.persist !== false) writePersistentLyricCache(song, mergedResponse);
  return state;
}

function refreshPersistentLyricCache(song) {
  fetchLxLyricPayload(song).then(function (response) {
    if (!response) return;
    var mergedResponse = mergeInlineLyricResponseForSong(song, response || {});
    var state = parseLyricResponseToOriginalState(song, mergedResponse);
    if (state && state.usableLyric) writePersistentLyricCache(song, mergedResponse);
  }).catch(function () {});
}
function mergeInlineLyricResponseForSong(song, response) {
  response = Object.assign({}, response || {});
  if (!response.tlyric) response.tlyric = lyricTranslationTextFromAliases(response);
  if (!song || typeof song !== 'object') return response;
  if (!response.lyric && song.lyric) response.lyric = song.lyric;
  if (!response.tlyric) response.tlyric = lyricTranslationTextFromAliases(song);
  if (!response.yrc && (song.yrc || song.qrc)) response.yrc = song.yrc || song.qrc;
  if (!response.ytlrc && song.ytlrc) response.ytlrc = song.ytlrc;
  return response;
}
function lyricFallbackTextForSong(song) {
  song = song || {};
  var title = String(song.name || song.title || '').trim();
  var artist = String(song.artist || '').trim();
  if (!title && document) title = String(document.getElementById('thumb-title') && document.getElementById('thumb-title').textContent || '').trim();
  if (!artist && document) artist = String(document.getElementById('thumb-artist') && document.getElementById('thumb-artist').textContent || '').trim();
  if (!title) return '';
  return artist ? title + ' - ' + artist : title;
}
function withLyricFallbackForSong(song, lines) {
  lines = Array.isArray(lines) ? lines.filter(function (line) { return line && String(line.text || '').trim(); }) : [];
  if (lines.length && !lines.every(function (line) { return isNoLyricText(line.text); })) return lines;
  var text = lyricFallbackTextForSong(song);
  return text ? [{ t: 0, text: text, duration: 9999, charCount: Math.max(1, text.length), fallback: true }] : [];
}
function parseLyricResponseToOriginalState(song, response) {
  response = response || {};
  var nativeLines = parseYrcText(response.yrc || '');
  var wordSource = 'yrc';
  if (!nativeLines.some(function (line) { return line.words && line.words.length; })) {
    // lx 逐字歌词（lx-source/lyric 的 lxlyric 字段）在无 yrc 原生逐字时顶上，
    // 形态同上游 index.html:32115 parseLxWordLyricText → timingSource='lx-word'。
    var lxWordLines = parseLxWordLyricText(response.lxlyric || '');
    if (lxWordLines.some(function (line) { return line.words && line.words.length; })) {
      nativeLines = lxWordLines;
      wordSource = 'lx';
    }
  }
  var lrcLines = parseLyricText(response.lyric || '');
  var translationPayload = buildLyricTranslationPayload(response);
  var translationLines = translationPayload.lines;
  var hasNativeKaraoke = nativeLines.some(function (line) { return line.words && line.words.length; });
  var timingSource = hasNativeKaraoke ? (wordSource === 'lx' ? 'lx-word' : 'yrc-word') :
    (nativeLines.length ? (wordSource === 'lx' ? 'lx-line' : 'yrc-line') : (lrcLines.length ? 'lrc-line' : 'fallback'));
  var primaryLines = nativeLines.length ? nativeLines : lrcLines;
  var lines = withLyricFallbackForSong(song, attachLyricTranslations(primaryLines, translationLines));
  if (lines.length && lines[0].fallback) timingSource = 'fallback';
  return {
    lines: cloneLyricLines(lines),
    hasNativeKaraoke: hasNativeKaraoke,
    timingSource: timingSource,
    translationLines: cloneLyricLines(translationLines),
    translationSource: translationPayload.source,
    usableLyric: hasUsableLyricLines(lines),
    cachedAt: Date.now()
  };
}
function shouldRetryStartupLyricFetch(song, token, attempt) {
  if (!song || token !== trackSwitchToken || (attempt || 0) >= 3) return false;
  if (song.type === 'local' || song.source === 'local' || song.localKey || song.type === 'podcast') return false;
  return !!(startupAutoplayPreference || restoredLastPlaybackSnapshot || pendingPlaybackResumeAt > 0);
}
function scheduleStartupLyricFetchRetry(song, token, attempt) {
  var delays = [700, 1600, 3200];
  var delay = delays[Math.max(0, Math.min(delays.length - 1, attempt || 0))];
  setTimeout(function () {
    if (token === trackSwitchToken) fetchLyric(song, token, (attempt || 0) + 1);
  }, delay);
}
var pendingTrackFallbackLyricTimer = 0;
function cancelPendingTrackFallbackLyrics() {
  if (pendingTrackFallbackLyricTimer) {
    clearTimeout(pendingTrackFallbackLyricTimer);
    pendingTrackFallbackLyricTimer = 0;
  }
}
function resetLyricsForTrackSwitch() {
  cancelPendingTrackFallbackLyrics();
  setOriginalLyricsState([], false, 'pending', [], 'none');
  lyricsHasNativeKaraoke = false;
  lyricsTimingSource = 'pending';
  lyricsTranslationLines = [];
  lyricsTranslationSource = 'none';
  lyricsLines = [];
  if (typeof invalidateStageLyricPayloadForNewLyrics === 'function') invalidateStageLyricPayloadForNewLyrics('track-switch-pending');
  else if (typeof clearStageLyrics === 'function') clearStageLyrics();
  updateCustomLyricControls();
}
function scheduleTrackSwitchFallbackLyrics(song, token, delay) {
  cancelPendingTrackFallbackLyrics();
  var multiLineDelay = (typeof stageLyricMultiLineWarmupLoad === 'function' && stageLyricMultiLineWarmupLoad()) ? 1850 : 180;
  pendingTrackFallbackLyricTimer = setTimeout(function () {
    pendingTrackFallbackLyricTimer = 0;
    if (token != null && token !== trackSwitchToken) return;
    if (hasUsableLyricLines(originalLyricsState && originalLyricsState.lines)) return;
    setOriginalLyricsState(withLyricFallbackForSong(song || currentLyricSong(), []), false, 'fallback', [], 'none');
    applyPreferredLyricsForCurrent(true);
  }, Math.max(multiLineDelay, Number(delay) || 720));
}
async function fetchLyric(songOrId, token, attempt) {
  attempt = Math.max(0, Number(attempt) || 0);
  var song;
  try {
    song = (songOrId && typeof songOrId === 'object') ? songOrId : null;
    var cachedResponse = song ? await readPersistentLyricCache(song) : null;
    if (cachedResponse) {
      var cachedState = applyFetchedLyricResponse(song, token, cachedResponse, { persist: false });
      if (cachedState && cachedState.usableLyric) {
        refreshPersistentLyricCache(song);
        return;
      }
    }
    // 无 lx 源映射（汽水/Spotify/本地/播客/lx 自定义源）：不发网络，直接落「暂无歌词」标题兜底。
    var lxSourceName = lxLyricSourceForSong(song || songOrId);
    if (!lxSourceName) {
      if (token !== trackSwitchToken) return;
      cancelPendingTrackFallbackLyrics();
      setOriginalLyricsState(withLyricFallbackForSong(song || currentLyricSong(), []), false, 'fallback', [], 'none');
      applyPreferredLyricsForCurrent(true);
      return;
    }
    var r = await fetchLxLyricPayload(song || songOrId);
    if (!r) return;
    var state = applyFetchedLyricResponse(song, token, r);
    if (!state) return;
    if (!state.usableLyric && shouldRetryStartupLyricFetch(song, token, attempt)) scheduleStartupLyricFetchRetry(song, token, attempt);
  } catch (e) {
    if (token !== trackSwitchToken) return;
    cancelPendingTrackFallbackLyrics();
    var fallbackLines = withLyricFallbackForSong(song || currentLyricSong(), []);
    setOriginalLyricsState(fallbackLines, false, 'fallback', [], 'none');
    applyPreferredLyricsForCurrent(true);
    if (shouldRetryStartupLyricFetch(song, token, attempt)) scheduleStartupLyricFetchRetry(song, token, attempt);
  }
}
// ==== 显式挂到 window：fetchLyric 是 async function，按 ES2017 块级绑定规则不会从 index-loader
// 的 try { ... } catch 块自动泄漏到全局。agent-adapter.js 作为独立 <script> 在该块外执行，
// 无法通过词法作用域访问；不挂则 AI 助手切歌时歌词抓取会静默失效。
if (typeof window !== 'undefined' && !window.fetchLyric) {
  try { window.fetchLyric = fetchLyric; } catch (e) { /* best-effort */ }
}
function currentLyricFallbackText() {
  return lyricFallbackTextForSong(currentLyricSong() || {});
}
function isNoLyricText(text) {
  var compact = String(text || '').replace(/\s+/g, '').replace(/[，,。.!！?？、~～]/g, '');
  return !compact ||
    compact === '纯音乐请欣赏' ||
    compact === '暂无歌词' ||
    compact === '暂无歌词敬请期待' ||
    compact === '此歌曲为没有填词的纯音乐请您欣赏';
}
function withLyricFallback(lines) {
  return withLyricFallbackForSong(currentLyricSong(), lines);
}
function lyricsAreFallbackTitleOnly(lines) {
  lines = Array.isArray(lines) ? lines.filter(function (line) { return line && String(line.text || '').trim(); }) : [];
  return lines.length === 1 && !!lines[0].fallback;
}
function lyricTagTimeToSeconds(min, sec, frac) {
  var t = (parseInt(min, 10) || 0) * 60 + (parseInt(sec, 10) || 0);
  if (frac) t += (parseInt(frac, 10) || 0) / Math.pow(10, Math.min(3, frac.length));
  return t;
}
function finalizeLyricLineDurations(lines) {
  lines.sort(function (a, b) { return a.t - b.t; });
  for (var i = 0; i < lines.length; i++) {
    var next = lines[i + 1];
    var inferred = next && next.t > lines[i].t ? next.t - lines[i].t : 4.8;
    if (!isFinite(lines[i].duration) || lines[i].duration <= 0) lines[i].duration = inferred;
    lines[i].duration = Math.max(0.45, Math.min(12, lines[i].duration));
    lines[i].charCount = Math.max(1, lines[i].charCount || String(lines[i].text || '').length);
  }
  return lines;
}
function parseLyricText(text) {
  var lines = [], reg = /\[(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\]/g;
  text.split(/\r?\n/).forEach(function (line) {
    var tags = [], times = [], m;
    reg.lastIndex = 0;
    while ((m = reg.exec(line))) {
      var t = lyricTagTimeToSeconds(m[1], m[2], m[3]);
      times.push(t);
      tags.push({ t: t, index: m.index, end: reg.lastIndex });
    }
    if (!times.length) return;
    var hasInterleavedText = false;
    for (var i = 0; i < tags.length - 1; i++) {
      if (line.slice(tags[i].end, tags[i + 1].index).trim()) {
        hasInterleavedText = true;
        break;
      }
    }
    if (hasInterleavedText) {
      for (var si = 0; si < tags.length; si++) {
        var segment = line.slice(tags[si].end, si + 1 < tags.length ? tags[si + 1].index : line.length).trim();
        if (segment) lines.push({ t: tags[si].t, text: segment, source: 'lrc' });
      }
      return;
    }
    var txt = line.replace(reg, '').trim();
    if (!txt) return;
    times.forEach(function (t) { lines.push({ t: t, text: txt, source: 'lrc' }); });
  });
  return finalizeLyricLineDurations(lines);
}
function normalizeLyricTranslationText(text) {
  text = normalizeStageLyricText(text);
  if (!text || isNoLyricText(text)) return '';
  return text;
}
function usableLyricTranslationLines(lines) {
  return (Array.isArray(lines) ? lines : []).filter(function (line) {
    return line && normalizeLyricTranslationText(line.text);
  });
}
function isLyricCreditLineText(text) {
  var raw = normalizeStageLyricText(text);
  if (!raw || raw.length > 96) return false;
  if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(raw)) return false;
  var cleaned = raw
    .replace(/^[\s"'([{]+|[\s"'\])}]+$/g, '')
    .replace(/[.:：;；]+$/g, '')
    .trim();
  if (!cleaned) return false;
  var hasCreditPunctuation = /[:：]\s*$/.test(raw);
  var split = cleaned.split(/\s*(?:\/|,|&|\+|;|\band\b|\bfeat\.?\b|\bft\.?\b|\bwith\b)\s*/i);
  var tokens = [];
  split.forEach(function (part) {
    String(part || '').split(/\s+/).forEach(function (token) {
      token = token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9.'-]+$/g, '');
      if (token) tokens.push(token);
    });
  });
  if (!tokens.length || tokens.length > 10) return false;
  var lyricWords = /\b(?:i|me|my|mine|you|your|yours|we|us|our|ours|he|him|his|she|her|they|them|it|love|die|want|need|know|gotta|gonna|wanna|would|could|should|can|cant|can't|dont|don't|ain't|is|are|am|be|been|being|was|were|do|does|did|go|come|make|take|throw|lock|away|world|force|key|place|baby|girl|boy|night|heart|life)\b/i;
  if (!hasCreditPunctuation && tokens.length > 1 && lyricWords.test(cleaned)) return false;
  var nameLike = 0;
  tokens.forEach(function (token) {
    if (/^(?:the|and|feat|ft|with)$/i.test(token)) {
      nameLike++;
    } else if (/^[A-Z0-9][A-Z0-9.'-]*$/.test(token) || /^[A-Z][A-Za-z0-9.'-]*$/.test(token)) {
      nameLike++;
    }
  });
  if (hasCreditPunctuation) return nameLike >= Math.max(1, tokens.length - 1);
  if (tokens.length <= 2 && /^[A-Z0-9 .,'-]+[.:]?$/.test(raw)) return true;
  return tokens.length >= 2 && nameLike >= tokens.length - 1 && /(?:\/|,|&|\+|\band\b|\bfeat\.?\b|\bft\.?\b|\bwith\b)/i.test(cleaned);
}
function markLyricLineSource(lines, source) {
  return usableLyricTranslationLines(lines || []).map(function (line) {
    var copy = Object.assign({}, line);
    if (Array.isArray(line.words)) copy.words = line.words.map(function (w) { return Object.assign({}, w); });
    copy.source = source || copy.source || 'translation';
    return copy;
  });
}
function mergeLyricTranslationLineSources() {
  var out = [];
  function hasSameLine(candidate) {
    var candidateText = normalizeLyricTranslationText(candidate && candidate.text);
    var candidateTime = Number(candidate && candidate.t) || 0;
    for (var i = 0; i < out.length; i++) {
      var item = out[i];
      if (Math.abs((Number(item.t) || 0) - candidateTime) <= 0.12 &&
        normalizeLyricTranslationText(item.text) === candidateText) return true;
    }
    return false;
  }
  for (var s = 0; s < arguments.length; s++) {
    var lines = usableLyricTranslationLines(arguments[s] || []);
    for (var i = 0; i < lines.length; i++) {
      if (!hasSameLine(lines[i])) out.push(lines[i]);
    }
  }
  return finalizeLyricLineDurations(out);
}
function buildLyricTranslationPayload(response) {
  response = response || {};
  var lrcTranslations = markLyricLineSource(parseLyricText(lyricTranslationTextFromAliases(response)), 'tlyric');
  var yrcTranslations = markLyricLineSource(parseYrcText(response.ytlrc || ''), 'ytlrc');
  var lines = mergeLyricTranslationLineSources(lrcTranslations, yrcTranslations);
  var sources = [];
  if (lrcTranslations.length) sources.push('tlyric');
  if (yrcTranslations.length) sources.push('ytlrc');
  return { lines: lines, source: sources.length ? sources.join('+') : 'none' };
}
function attachLyricTranslations(primaryLines, translationLines) {
  var primary = cloneLyricLines(primaryLines || []);
  var translations = usableLyricTranslationLines(translationLines || []);
  if (!primary.length || !translations.length) return primary;
  var assignments = {};
  var usedTranslations = {};
  function translationToleranceForLine(line) {
    var lineDuration = Math.max(0.9, Math.min(5.5, Number(line && line.duration) || 3.2));
    return Math.max(0.55, Math.min(2.4, lineDuration * 0.62 + 0.18));
  }
  function canUseTranslation(line, tr) {
    var translated = normalizeLyricTranslationText(tr && tr.text);
    return !!(line && tr && translated &&
      !isLyricCreditLineText(line.text) &&
      !isLyricCreditLineText(translated) &&
      translated !== normalizeStageLyricText(line.text));
  }
  function assignTranslation(lineIndex, trIndex, delta, phase) {
    var line = primary[lineIndex];
    var tr = translations[trIndex];
    if (!canUseTranslation(line, tr) || usedTranslations[trIndex]) return false;
    assignments[lineIndex] = { line: tr, delta: delta, index: trIndex, phase: phase || 'time' };
    usedTranslations[trIndex] = true;
    return true;
  }
  primary.forEach(function (line, lineIndex) {
    if (!line || line.fallback) return;
    var bestIndex = -1;
    var bestDelta = Infinity;
    for (var trIndex = 0; trIndex < translations.length; trIndex++) {
      if (usedTranslations[trIndex]) continue;
      var tr = translations[trIndex];
      if (!canUseTranslation(line, tr)) continue;
      var delta = Math.abs((Number(tr.t) || 0) - (Number(line.t) || 0));
      if (delta > translationToleranceForLine(line)) continue;
      if (delta < bestDelta) {
        bestIndex = trIndex;
        bestDelta = delta;
      }
    }
    if (bestIndex >= 0) assignTranslation(lineIndex, bestIndex, bestDelta, 'time');
  });
  if (translations.length >= Math.max(2, primary.length * 0.58)) {
    var orderedPrimaryIndexes = [];
    primary.forEach(function (line, lineIndex) {
      if (line && !line.fallback && !isLyricCreditLineText(line.text)) orderedPrimaryIndexes.push(lineIndex);
    });
    var primaryDen = Math.max(1, orderedPrimaryIndexes.length - 1);
    var translationDen = Math.max(1, translations.length - 1);
    orderedPrimaryIndexes.forEach(function (lineIndex, orderPos) {
      var line = primary[lineIndex];
      if (!line || line.fallback || assignments[lineIndex]) return;
      var expected = Math.round((orderPos / primaryDen) * translationDen);
      var bestIndex = -1;
      var bestScore = Infinity;
      var bestDelta = Infinity;
      for (var trIndex = 0; trIndex < translations.length; trIndex++) {
        if (usedTranslations[trIndex]) continue;
        var tr = translations[trIndex];
        if (!canUseTranslation(line, tr)) continue;
        var orderGap = Math.abs(trIndex - expected);
        if (orderGap > 5 && translations.length <= primary.length * 1.25) continue;
        var delta = Math.abs((Number(tr.t) || 0) - (Number(line.t) || 0));
        var fallbackTolerance = Math.max(translationToleranceForLine(line) * 1.35, 2.8);
        if (delta > fallbackTolerance && orderGap > 2) continue;
        var score = orderGap * 0.72 + Math.min(delta, 8) * 0.22;
        if (score < bestScore) {
          bestIndex = trIndex;
          bestScore = score;
          bestDelta = delta;
        }
      }
      if (bestIndex >= 0) assignTranslation(lineIndex, bestIndex, bestDelta, 'order');
    });
  }
  Object.keys(assignments).forEach(function (key) {
    var lineIndex = Number(key);
    var line = primary[lineIndex];
    var best = assignments[key] && assignments[key].line;
    if (line && best) {
      var translated = normalizeLyricTranslationText(best.text);
      if (translated && translated !== normalizeStageLyricText(line.text)) {
        line.translation = translated;
        line.translationTime = best.t;
        line.translationSource = best.source || 'tlyric';
        line.translationMatch = assignments[key].phase || 'time';
      }
    }
  });
  return primary;
}
// 上游 index.html:35946 parseLxWordLyricText 移植：LX 逐字歌词
// `[MM:SS.mm]<词起始ms,词时长ms>文本` 行式协议。与上游的差异：lx 会在词间重复插入
// `[MM:SS.mm]` 行内时间戳，它属于时间标记而非歌词文本，必须剥掉后再拼接，
// 否则 fullText 会被污染（'He[00:02.60]llo' 而非 'Hello'）。
function parseLxWordLyricText(text) {
  var lines = [];
  String(text || '').split(/\r?\n/).forEach(function (row) {
    var head = row.match(/^\[(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\](.*)$/);
    if (!head) return;
    var lineTime = lyricTagTimeToSeconds(head[1], head[2], head[3]);
    var body = head[4] || '';
    var words = [], fullText = '', reg = /<(\d+),(\d+)>([^<]*)/g, match;
    while ((match = reg.exec(body))) {
      var wordText = String(match[3] || '').replace(/\[[^\]]*\]/g, '');
      if (!wordText) continue;
      var c0 = fullText.length;
      fullText += wordText;
      words.push({
        text: wordText,
        t: lineTime + (parseInt(match[1], 10) || 0) / 1000,
        d: Math.max(0.04, (parseInt(match[2], 10) || 0) / 1000),
        c0: c0,
        c1: fullText.length,
        source: 'lx-karaoke'
      });
    }
    if (!words.length) return;
    fullText = fullText.trim();
    if (!fullText) return;
    var lastWord = words[words.length - 1];
    lines.push({
      t: lineTime,
      text: fullText,
      words: words,
      duration: Math.max(0.45, lastWord.t + lastWord.d - lineTime),
      charCount: Math.max(1, fullText.length),
      source: 'lx-karaoke'
    });
  });
  return finalizeLyricLineDurations(lines);
}
function parseYrcText(text) {
  var lines = [];
  String(text || '').split(/\r?\n/).forEach(function (line) {
    var m = line.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!m) return;
    var lineStartMs = parseInt(m[1], 10) || 0;
    var lineDurMs = parseInt(m[2], 10) || 0;
    var body = m[3] || '';
    var words = [], fullText = '';
    var reg = /\((\d+),(\d+),\d+\)([^()]*)/g, wm;
    while ((wm = reg.exec(body))) {
      var txt = (wm[3] || '').replace(/\s+/g, ' ');
      if (!txt) continue;
      var rawStart = parseInt(wm[1], 10) || 0;
      var rawDur = parseInt(wm[2], 10) || 0;
      var absStartMs = rawStart >= lineStartMs - 500 ? rawStart : lineStartMs + rawStart;
      var c0 = fullText.length;
      fullText += txt;
      words.push({ text: txt, t: absStartMs / 1000, d: Math.max(0.06, rawDur / 1000), c0: c0, c1: fullText.length });
    }
    if (!fullText) fullText = body.replace(/\(\d+,\d+,\d+\)/g, '').replace(/\s+/g, ' ');
    var leading = (fullText.match(/^\s+/) || [''])[0].length;
    fullText = fullText.replace(/\s+/g, ' ').trim();
    if (!fullText) return;
    if (words.length) {
      words.forEach(function (w) {
        w.c0 = Math.max(0, Math.min(fullText.length, w.c0 - leading));
        w.c1 = Math.max(w.c0, Math.min(fullText.length, w.c1 - leading));
      });
      words = words.filter(function (w) { return w.c1 > w.c0; });
    }
    lines.push({ t: lineStartMs / 1000, duration: lineDurMs / 1000, text: fullText, words: words, charCount: Math.max(1, fullText.length), source: words.length ? 'yrc-word' : 'yrc-line' });
  });
  return finalizeLyricLineDurations(lines);
}
function renderLyrics(options) {
  options = options || {};
  var renderSignature = typeof stageLyricRenderSignatureForCurrentState === 'function' ? stageLyricRenderSignatureForCurrentState() : '';
  if (options.preserveSame && typeof stageLyricCanPreserveSameRender === 'function' && stageLyricCanPreserveSameRender(renderSignature)) {
    if (typeof markStageLyricsPlaybackResume === 'function') markStageLyricsPlaybackResume(options.reason || 'preserve-same-lyrics');
    return;
  }
  var fallbackTitleOnly = lyricsAreFallbackTitleOnly(lyricsLines);
  var warmupReason = fallbackTitleOnly ? 'renderLyrics-title' : 'renderLyrics';
  var restoreWarmup = typeof stageLyricRestoreWarmupSeconds === 'function' && stageLyricRestoreWarmupSeconds() != null;
  var prewarmReason = restoreWarmup ? 'startup-restore-lyrics' : warmupReason;
  if (typeof invalidateStageLyricPayloadForNewLyrics === 'function') invalidateStageLyricPayloadForNewLyrics('renderLyrics');
  else clearStageLyrics();
  if (typeof stageLyrics !== 'undefined' && stageLyrics && renderSignature) stageLyrics.renderSignature = renderSignature;
  if (typeof requestStageLyricWarmup === 'function') requestStageLyricWarmup(prewarmReason, fallbackTitleOnly ? 120 : 900);
  if (restoreWarmup && typeof scheduleStageLyricRestorePrewarm === 'function') {
    scheduleStageLyricRestorePrewarm(prewarmReason, fallbackTitleOnly ? 40 : 16);
  } else if (typeof scheduleStageLyricPrewarm === 'function') {
    scheduleStageLyricPrewarm(warmupReason, fallbackTitleOnly ? 56 : 32);
  }
  if (!fallbackTitleOnly && typeof scheduleStageLyricSingleLineBootstrapPrewarm === 'function') {
    scheduleStageLyricSingleLineBootstrapPrewarm(prewarmReason, restoreWarmup ? 24 : 44);
  }
  if (!fallbackTitleOnly && typeof scheduleStageLyricFullTrackWarmup === 'function') {
    scheduleStageLyricFullTrackWarmup(restoreWarmup ? 'track-ready-fast' : 'lyrics-ready-preload', restoreWarmup ? 120 : 24);
  }
  // v8: 歌词渲染由 stageLyrics 在每帧 tickLyricsParticles 里推动
}
function toggleLyricsPanel(force) {
  if (force === false) fx.particleLyrics = false;
  else if (force === true) fx.particleLyrics = true;
  else fx.particleLyrics = !fx.particleLyrics;
  if (fx.particleLyrics) {
    createLyricsParticles();
    if (typeof requestStageLyricWarmup === 'function') requestStageLyricWarmup('toggleLyricsPanel', 150);
    if (typeof scheduleStageLyricPrewarm === 'function') scheduleStageLyricPrewarm('toggleLyricsPanel', 48);
    if (typeof scheduleStageLyricFullTrackWarmup === 'function') scheduleStageLyricFullTrackWarmup('track-ready', 220);
    showToast('歌词已开启');
  } else {
    clearStageLyrics();
    showToast('歌词已关闭');
  }
  lyricsVisible = fx.particleLyrics;
}
function updateLyricsHighlight() { /* v8: 由 tickLyricsParticles 接管 */ }

// ============================================================
//  播放列表面板
