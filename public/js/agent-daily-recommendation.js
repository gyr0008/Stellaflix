(function (global) {
  'use strict';
  var DAY_MS = 86400000;
  var RELISTEN_MIN_DAYS = 7;
  var RELISTEN_MAX_DAYS = 30;

  function songTitle(song) {
    return String((song && (song.name || song.title)) || '').trim();
  }
  function songArtist(song) {
    return String((song && song.artist) || '').trim();
  }
  function commandFor(title, artist) {
    return artist ? '播放' + artist + '的' + title : '播放' + title;
  }

  function mergedSongStat(key, stat, songStats, matchStore) {
    var merged = { key: key, name: stat.name, artist: stat.artist, plays: Number(stat.plays) || 0, lastPlayedAt: Number(stat.lastPlayedAt) || 0 };
    if (!matchStore || typeof matchStore.get !== 'function' || String(key).indexOf('local:') !== 0) return merged;
    var entry = null;
    try {
      entry = matchStore.get(String(key).slice(6));
    } catch (e) {
      return merged;
    }
    var twin = entry && entry.key ? songStats[entry.key] : null;
    if (twin) {
      merged.plays += Number(twin.plays) || 0;
      merged.lastPlayedAt = Math.max(merged.lastPlayedAt, Number(twin.lastPlayedAt) || 0);
    }
    return merged;
  }

  function relistenCandidate(ctx) {
    var stats = (ctx && ctx.stats) || {};
    var songStats = stats.songs || {};
    var now = Number(ctx && ctx.now) || 0;
    var list = [];
    Object.keys(songStats).forEach(function (key) {
      var stat = songStats[key];
      if (!stat || !songTitle(stat)) return;
      var effective = mergedSongStat(key, stat, songStats, ctx && ctx.matchStore);
      var ageDays = (now - effective.lastPlayedAt) / DAY_MS;
      if (ageDays < RELISTEN_MIN_DAYS || ageDays > RELISTEN_MAX_DAYS) return;
      list.push(effective);
    });
    list.sort(function (a, b) {
      return (b.plays - a.plays) || (b.lastPlayedAt - a.lastPlayedAt) || String(a.key).localeCompare(String(b.key));
    });
    var top = list[0];
    if (!top) return null;
    var title = songTitle(top);
    var artist = songArtist(top);
    return { kind: 'relisten', title: title, artist: artist, command: commandFor(title, artist), reason: '有些日子没听了' };
  }

  // 与 09-queue-snapshot-autoplay.js 的 queueItemKey 保持一致的键规则（独立脚本无法共享模块作用域）
  function keyOf(song) {
    if (!song) return '';
    if (song.provider === 'spotify' || song.source === 'spotify' || song.type === 'spotify' || song.spotifyId || song.spotifyUri) return 'spotify:' + (song.spotifyId || song.id || song.spotifyUri || song.uri || (song.name + '|' + song.artist));
    if (song.provider === 'qq' || song.source === 'qq' || song.type === 'qq') return 'qq:' + (song.mid || song.songmid || song.id || (song.name + '|' + song.artist));
    if (song.provider === 'kugou' || song.source === 'kugou' || song.type === 'kugou' || song.hash || song.audioHash) return 'kugou:' + (song.hash || song.fileHash || song.audioHash || song.id || (song.name + '|' + song.artist));
    if (song.type === 'podcast' && song.programId) return 'podcast:' + song.programId;
    if (song.localKey) return 'local:' + song.localKey;
    if (song.id != null && song.id !== '') return 'song:' + song.id;
    return String(song.name || '') + '|' + String(song.artist || '');
  }

  function discoveryPool(ctx) {
    var songStats = ((ctx && ctx.stats) || {}).songs || {};
    var pool = [];
    function push(song, playlistName) {
      if (!song || !songTitle(song)) return;
      if (songStats[keyOf(song)]) return;
      pool.push({ song: song, title: songTitle(song), artist: songArtist(song), playlistName: playlistName || '' });
    }
    var playlists = (ctx && ctx.playlists) || [];
    playlists.forEach(function (pl) {
      var songs = pl && Array.isArray(pl.songs) ? pl.songs : [];
      songs.forEach(function (song) { push(song, songTitle(pl) || (pl && pl.name) || ''); });
    });
    ((ctx && ctx.localTracks) || []).forEach(function (track) { push(track, ''); });
    pool.sort(function (a, b) {
      return a.title.localeCompare(b.title) || a.artist.localeCompare(b.artist);
    });
    return pool;
  }

  function topArtistName(ctx) {
    var artists = ((ctx && ctx.stats) || {}).artists || {};
    var list = Object.keys(artists).map(function (k) { return artists[k]; }).filter(Boolean);
    list.sort(function (a, b) {
      return ((Number(b.plays) || 0) - (Number(a.plays) || 0)) || String(a.name).localeCompare(String(b.name));
    });
    var top = list[0];
    var name = top ? String(top.name || '').trim() : '';
    return name || null;
  }

  function artistCandidate(ctx) {
    var artistName = topArtistName(ctx);
    if (!artistName) return null;
    var needle = artistName.toLowerCase();
    var matches = discoveryPool(ctx).filter(function (item) {
      return item.artist.toLowerCase().indexOf(needle) >= 0;
    });
    var top = matches[0];
    if (!top) return null;
    return {
      kind: 'artist', title: top.title, artist: top.artist,
      command: commandFor(top.title, top.artist),
      reason: '你常听的 ' + artistName + '，这首还没听过',
    };
  }

  function dayNumber(now) {
    var d = new Date(now);
    return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
  }

  function discoverCandidate(ctx) {
    var pool = discoveryPool(ctx);
    if (!pool.length) return null;
    var item = pool[dayNumber(Number(ctx && ctx.now) || 0) % pool.length];
    return {
      kind: 'discover', title: item.title, artist: item.artist,
      command: commandFor(item.title, item.artist),
      reason: item.playlistName ? '来自你的歌单「' + item.playlistName + '」' : '你的本地曲库里还没听过',
    };
  }

  function resumeCandidate(ctx) {
    var history = (((ctx && ctx.stats) || {}).history) || [];
    for (var i = 0; i < history.length; i += 1) {
      var record = history[i];
      if (!record || record.completed) continue;
      var title = songTitle(record);
      if (!title) continue;
      var artist = songArtist(record);
      return { kind: 'resume', title: title, artist: artist, command: commandFor(title, artist), reason: '上次没听完' };
    }
    return null;
  }

  var CARDS = [relistenCandidate, artistCandidate, discoverCandidate, resumeCandidate];

  function pickDailyRecommendation(ctx) {
    var start = dayNumber(Number((ctx && ctx.now) || 0)) % CARDS.length;
    for (var offset = 0; offset < CARDS.length; offset += 1) {
      var result = CARDS[(start + offset) % CARDS.length](ctx);
      if (result) return result;
    }
    return null;
  }

  function normalizeTitle(value) {
    return String(value || '').trim();
  }

  function movieCommandFor(title) {
    // parseVideoCommand 的书名号分支是唯一对任意片名（含英文、非动词开头）都可靠的入口，
    // 裸 '影视播放X' 会因提取不到片名落到「需要 AI 对话」兜底。
    return '影视播放《' + title + '》';
  }

  function pickDailyMovie(trendingList, historyRecords, now) {
    var watched = Object.create(null);
    (Array.isArray(historyRecords) ? historyRecords : []).forEach(function (rec) {
      var title = normalizeTitle(rec && rec.title);
      if (title) watched[title.toLowerCase()] = true;
    });
    var pool = (Array.isArray(trendingList) ? trendingList : [])
      .map(function (item) { return normalizeTitle(item && item.title); })
      .filter(function (title) { return title && !watched[title.toLowerCase()]; });
    if (!pool.length) return null;
    var title = pool[dayNumber(Number(now) || 0) % pool.length];
    return { kind: 'tmdb', title: title, command: movieCommandFor(title), reason: 'TMDB 本周热榜 · 你还没看过' };
  }

  function pickLibraryMovie(historyRecords, trackRecords) {
    var history = Array.isArray(historyRecords) ? historyRecords : [];
    for (var i = 0; i < history.length; i += 1) {
      var rec = history[i];
      var recTitle = normalizeTitle(rec && rec.title);
      if (recTitle && !rec.finished) {
        return { kind: 'video-resume', title: recTitle, command: movieCommandFor(recTitle), reason: '上次没看完' };
      }
    }
    var tracks = Array.isArray(trackRecords) ? trackRecords : [];
    for (var j = 0; j < tracks.length; j += 1) {
      var trackTitle = normalizeTitle(tracks[j] && tracks[j].title);
      if (trackTitle) {
        return { kind: 'video-track', title: trackTitle, command: movieCommandFor(trackTitle), reason: '你正在追的' };
      }
    }
    return null;
  }

  global.StellaflixAgentDailyRecommendation = {
    pickDailyRecommendation: pickDailyRecommendation,
    pickDailyMovie: pickDailyMovie,
    pickLibraryMovie: pickLibraryMovie,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
