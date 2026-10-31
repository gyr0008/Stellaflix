// ============================================================
// 本地歌 ↔ 在线音源匹配缓存。
// 本地曲库歌曲默认播放本地文件；联网时可按"歌名+歌手"在在线平台匹配一次，
// 匹配结果缓存到 localStorage，供音质切换栏提供在线档位与合并播放计数使用。
// 依赖运行时全局（拼接作用域）：apiJson / controlSourceSearchUrl / accountProviderOrder /
// isSameTitleArtist / queueItemKey / playbackRestoreSongSnapshot。
var LOCAL_ONLINE_MATCH_STORE_KEY = 'stellaflix-local-online-match-v1';
var LOCAL_ONLINE_MATCH_SEARCH_TIMEOUT_MS = 6500;
var localOnlineMatchPending = Object.create(null);

function normalizeLocalMatchKey(value) {
  value = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{24}$/.test(value) ? value : '';
}

function readLocalOnlineMatchCache() {
  try {
    var raw = localStorage.getItem(LOCAL_ONLINE_MATCH_STORE_KEY);
    if (!raw) return {};
    var data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    var out = {};
    Object.keys(data).forEach(function (key) {
      var entry = data[key];
      if (!normalizeLocalMatchKey(key) || !entry || typeof entry !== 'object') return;
      if (typeof entry.provider !== 'string' || !entry.provider) return;
      if (!entry.snapshot || typeof entry.snapshot !== 'object') return;
      out[key] = {
        provider: entry.provider,
        key: String(entry.key || ''),
        snapshot: entry.snapshot,
        matchedAt: Number(entry.matchedAt) || 0,
      };
    });
    return out;
  } catch (e) {
    return {};
  }
}

function writeLocalOnlineMatchCache(cache) {
  try {
    localStorage.setItem(LOCAL_ONLINE_MATCH_STORE_KEY, JSON.stringify(cache || {}));
  } catch (e) { }
}

function buildLocalOnlineMatchSong(localKey, entry) {
  if (!entry || !entry.snapshot) return null;
  var song = Object.assign({}, entry.snapshot);
  song.localOriginKey = localKey;
  song.localOriginName = song.name || '';
  return song;
}

function localOnlineMatchSongKey(provider, song) {
  if (song && !song.provider && !song.source && !song.type) song = Object.assign({}, song, { provider: provider });
  var key = '';
  try {
    key = typeof queueItemKey === 'function' ? queueItemKey(song) : '';
  } catch (e) { }
  return key || (provider + ':' + String((song && (song.id || song.mid || song.hash)) || ''));
}

function localOnlineMatchCandidateProviders() {
  var ordered = [];
  try {
    if (typeof accountProviderOrder === 'function') ordered = accountProviderOrder().slice();
  } catch (e) { }
  ['netease', 'qq', 'kugou'].forEach(function (provider) {
    if (ordered.indexOf(provider) < 0) ordered.push(provider);
  });
  return ordered;
}

async function searchLocalOnlineMatchOneProvider(localSong, provider) {
  var query = [localSong.name || localSong.title || '', localSong.artist || ''].filter(Boolean).join(' ').trim();
  if (!query) return null;
  // 批 T15.5b：匹配查询统一走 lx 聚合搜索；controlSourceSearchUrl 不可用时的兜底
  // 也必须是 lx 形态（旧官方 /api/search 兜底随路由一并退役）。
  var url = typeof controlSourceSearchUrl === 'function'
    ? controlSourceSearchUrl(provider, query)
    : '/api/lx-source/search?q=' + encodeURIComponent(query) + '&limit=12&sources=tx,wy,kw,kg,mg';
  var data = await apiJson(url, { timeoutMs: LOCAL_ONLINE_MATCH_SEARCH_TIMEOUT_MS });
  var list = (data && (data.songs || data.result)) || [];
  for (var i = 0; i < list.length; i++) {
    var candidate = list[i];
    if (!candidate) continue;
    // 修复轮1（评审 Critical-2）：lx 路由返回冻结形状（歌手字段 singer，见 lx-search.js:33-37），
    // 而 isSameTitleArtist → artistNameParts（11-provider-fallback.js:285-296）只读 .artist/.artists，
    // singer-only 候选恒判不匹配 → 本地歌在线匹配恒失败。参照 11-provider-fallback.js:496/512
    // 既有边界归一约定，桥接 singer→artist 后再比对；命中回标 provider 用归一后的视图（artist 齐备）。
    var view = Object.assign({}, candidate, { artist: candidate.artist || candidate.singer || '' });
    if (typeof isSameTitleArtist === 'function' && !isSameTitleArtist(localSong, view)) continue;
    if (typeof isSameTitleArtist !== 'function') break;
    var stamped = Object.assign({}, view);
    if (!stamped.provider) stamped.provider = provider;
    return stamped;
  }
  return null;
}

var localOnlineMatchStore = {
  STORE_KEY: LOCAL_ONLINE_MATCH_STORE_KEY,
  load: readLocalOnlineMatchCache,
  get: function (localKey) {
    localKey = normalizeLocalMatchKey(localKey);
    if (!localKey) return null;
    return readLocalOnlineMatchCache()[localKey] || null;
  },
  put: function (localKey, provider, song) {
    localKey = normalizeLocalMatchKey(localKey);
    provider = String(provider || '').trim();
    if (!localKey || !provider || !song) return null;
    var snapshot = typeof playbackRestoreSongSnapshot === 'function' ? playbackRestoreSongSnapshot(song) : Object.assign({}, song);
    var entry = {
      provider: provider,
      key: localOnlineMatchSongKey(provider, song),
      snapshot: snapshot,
      matchedAt: Date.now(),
    };
    var cache = readLocalOnlineMatchCache();
    cache[localKey] = entry;
    writeLocalOnlineMatchCache(cache);
    return entry;
  },
  remove: function (localKey) {
    localKey = normalizeLocalMatchKey(localKey);
    if (!localKey) return false;
    var cache = readLocalOnlineMatchCache();
    if (!cache[localKey]) return false;
    delete cache[localKey];
    writeLocalOnlineMatchCache(cache);
    return true;
  },
  onlineSongForLocalSong: function (localSong) {
    if (!localSong) return null;
    var localKey = normalizeLocalMatchKey(localSong.localKey || localSong.localFileId);
    if (!localKey) return null;
    return buildLocalOnlineMatchSong(localKey, this.get(localKey));
  },
  matchLocalSong: async function (localSong, opts) {
    opts = opts || {};
    if (!localSong) return null;
    var localKey = normalizeLocalMatchKey(localSong.localKey || localSong.localFileId);
    if (!localKey) return null;
    var cached = this.get(localKey);
    if (cached) return buildLocalOnlineMatchSong(localKey, cached);
    if (localOnlineMatchPending[localKey]) return localOnlineMatchPending[localKey];
    var self = this;
    var task = (async function () {
      var providers = opts.provider ? [String(opts.provider)] : localOnlineMatchCandidateProviders();
      for (var p = 0; p < providers.length; p++) {
        var provider = providers[p];
        try {
          var matched = await searchLocalOnlineMatchOneProvider(localSong, provider);
          if (!matched) continue;
          self.put(localKey, provider, matched);
          return buildLocalOnlineMatchSong(localKey, self.get(localKey));
        } catch (e) {
          console.warn('[LocalOnlineMatch]', provider, e && e.message || e);
        }
      }
      return null;
    })();
    localOnlineMatchPending[localKey] = task;
    try {
      return await task;
    } finally {
      delete localOnlineMatchPending[localKey];
    }
  },
};

window.localOnlineMatchStore = localOnlineMatchStore;
