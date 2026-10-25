// ============================================================
// 「特别喜欢」本地收藏清单（10-25 移植自参照库 app.js:23821-23966，并按主人裁定 Q1=B 改造成双池）。
// 参照库只允许本地歌进这张清单（原文「特别喜欢歌单只支持本地音乐」），我们是「本地 + 自定义音源」双池产品，
// 所以这里放宽：本地歌按 local-key/local-path/local-meta 三级兜底认人，导入歌单里的在线歌按
// online:平台:歌曲 id 认人（键直接复用 songAccountStateKey，不另发明身份）。
// 存储口径照搬参照库：localStorage 引用表是唯一权威，SQLite 的 favorite 只是会随库复活的持久镜像，
// 绝不能反过来把 SQLite 当权威——否则清过 localStorage 会出现「界面没收藏、库里还有 favorite」的鬼影。
// ============================================================
var SPECIAL_LIKED_PLAYLIST_STORE_KEY = 'stellaflix-special-liked-playlist-v1';
var specialLikedSongRefs = null;

function specialLikedSongPath(song) {
  if (!song) return '';
  return String(song.localFilePathAbsolute || song.localPath || (song.localFile && song.localFile.name) || '')
    .replace(/\\/g, '/').toLowerCase();
}
/**
 * 判断曲目是不是本地文件。本地歌走文件路径认人，其余全按在线曲目身份认人。
 * @param {object} song 曲目对象。
 * @returns {boolean} 是否本地曲目。
 */
function specialLikedIsLocalSong(song) {
  if (!song) return false;
  if (song.type === 'local' || song.source === 'local' || song.provider === 'local') return true;
  return !!(song.localKey || song.localFilePathAbsolute);
}
/**
 * 生成收藏引用键。本地歌沿用参照库三级兜底；在线歌复用平台身份函数（双池增量）。
 * @param {object} song 曲目对象。
 * @returns {string} 引用键；拿不出身份时返回空串。
 */
function specialLikedSongKey(song) {
  if (!song) return '';
  if (specialLikedIsLocalSong(song)) {
    if (song.localKey) return 'local-key:' + String(song.localKey);
    var path = specialLikedSongPath(song);
    if (path) return 'local-path:' + path;
    return 'local-meta:' + String(song.name || song.title || '') + '|' + String(song.artist || song.albumArtist || '');
  }
  var online = (typeof songAccountStateKey === 'function') ? songAccountStateKey(song) : '';
  return online ? 'online:' + online : '';
}
function specialLikedSongRef(song) {
  return {
    key: specialLikedSongKey(song),
    path: specialLikedIsLocalSong(song) ? specialLikedSongPath(song) : '',
    name: String(song && (song.name || song.title) || ''),
    artist: String(song && (song.artist || song.albumArtist) || '')
  };
}
function compactSpecialLikedSongRefs(source) {
  var refs = [];
  var seen = Object.create(null);
  source = Array.isArray(source) ? source : [];
  for (var i = 0; i < source.length; i++) {
    var item = source[i];
    var ref = typeof item === 'string' ? { key: item } : item;
    if (!ref || typeof ref !== 'object') continue;
    var key = String(ref.key || '').trim();
    if (!key || seen[key]) continue;
    seen[key] = true;
    refs.push({
      key: key,
      path: String(ref.path || '').replace(/\\/g, '/').toLowerCase(),
      name: String(ref.name || ''),
      artist: String(ref.artist || '')
    });
  }
  return refs;
}
function readSpecialLikedSongRefs() {
  if (specialLikedSongRefs) return specialLikedSongRefs;
  try {
    specialLikedSongRefs = compactSpecialLikedSongRefs(JSON.parse(localStorage.getItem(SPECIAL_LIKED_PLAYLIST_STORE_KEY) || '[]'));
  } catch (e) {
    specialLikedSongRefs = [];
  }
  return specialLikedSongRefs;
}
function writeSpecialLikedSongRefs(refs) {
  specialLikedSongRefs = compactSpecialLikedSongRefs(refs);
  setPersistentLocalStorageItem(SPECIAL_LIKED_PLAYLIST_STORE_KEY, JSON.stringify(specialLikedSongRefs));
}
function specialLikedRefMatchesSong(ref, song) {
  if (!ref || !song) return false;
  if (String(ref.key || '') === specialLikedSongKey(song)) return true;
  var path = specialLikedIsLocalSong(song) ? specialLikedSongPath(song) : '';
  return !!(path && ref.path && path === ref.path);
}
function specialLikedSongRefIndex(song) {
  var refs = readSpecialLikedSongRefs();
  for (var i = 0; i < refs.length; i++) {
    if (specialLikedRefMatchesSong(refs[i], song)) return i;
  }
  return -1;
}
// 喜欢查询的 Set 索引。队列 / 曲库整表渲染时每行都要判断是否已喜欢，逐行线性扫描 refs
// 会让整表渲染退化成 O(行数 × 喜欢数)。这里按 refs 数组引用缓存 key / path 两个集合：
// refs 每次变更都由 compactSpecialLikedSongRefs 产出新数组，引用一变缓存即失效并重建。
var specialLikedLookupCache = { refs: null, keys: null, paths: null };
function specialLikedLookupSets() {
  var refs = readSpecialLikedSongRefs();
  if (specialLikedLookupCache.refs !== refs) {
    var keys = new Set();
    var paths = new Set();
    for (var i = 0; i < refs.length; i++) {
      var ref = refs[i];
      if (!ref) continue;
      if (ref.key) keys.add(String(ref.key));
      if (ref.path) paths.add(ref.path);
    }
    specialLikedLookupCache.refs = refs;
    specialLikedLookupCache.keys = keys;
    specialLikedLookupCache.paths = paths;
  }
  return specialLikedLookupCache;
}
function isSpecialLikedSong(song) {
  if (!song) return false;
  var sets = specialLikedLookupSets();
  if (sets.keys.has(specialLikedSongKey(song))) return true;
  var path = specialLikedIsLocalSong(song) ? specialLikedSongPath(song) : '';
  return !!(path && sets.paths.has(path));
}
function getSpecialLikedSongs() {
  var refs = readSpecialLikedSongRefs();
  var source = localLibrarySongs && localLibrarySongs.length ? localLibrarySongs : (playQueue || []);
  // 双池增量：导入歌单里的在线歌不在 localLibrarySongs 也不在队列里，由宿主注入曲池一并聚合。
  if (typeof localImportedSongPool === 'function') source = source.concat(localImportedSongPool() || []);
  var canCleanStaleRefs = !!(typeof localLibraryReady !== 'undefined' && localLibraryReady);
  var lookup = Object.create(null);
  var pathLookup = Object.create(null);
  var matched = Object.create(null);
  var songs = [];
  var validRefs = canCleanStaleRefs ? [] : null;
  for (var i = 0; i < source.length; i++) {
    var song = source[i];
    if (!song) continue;
    var songKey = specialLikedSongKey(song);
    if (!songKey) continue;
    lookup[songKey] = song;
    if (specialLikedIsLocalSong(song)) {
      var songPath = specialLikedSongPath(song);
      if (songPath) pathLookup[songPath] = song;
    }
  }
  for (var refIndex = 0; refIndex < refs.length; refIndex++) {
    var ref = refs[refIndex];
    var match = lookup[ref.key] || (ref.path ? pathLookup[ref.path] : null);
    if (!match) continue;
    if (validRefs) validRefs.push(ref);
    var matchKey = specialLikedSongKey(match);
    if (matched[matchKey]) continue;
    matched[matchKey] = true;
    songs.push(match);
  }
  if (validRefs && validRefs.length !== refs.length) writeSpecialLikedSongRefs(validRefs);
  return songs;
}
function toggleSpecialLikedSong(song) {
  if (!song) return false;
  var refs = readSpecialLikedSongRefs();
  var index = specialLikedSongRefIndex(song);
  if (index >= 0) {
    refs.splice(index, 1);
    writeSpecialLikedSongRefs(refs);
    // 在线歌没有本地文件，不能往 SQLite 本地统计写 favorite，否则会留下没人对得上的孤儿行。
    if (specialLikedIsLocalSong(song)) syncLocalLibraryDbFavorite(song, false);
    showToast('已移出特别喜欢');
    return false;
  }
  refs.push(specialLikedSongRef(song));
  writeSpecialLikedSongRefs(refs);
  if (specialLikedIsLocalSong(song)) syncLocalLibraryDbFavorite(song, true);
  showToast('已加入特别喜欢');
  return true;
}
/**
 * 平台红心写回成功后同步一条本地引用。重复调用同向不占位，反向调用撤掉引用。
 * 在线歌以平台红心态为准，这里只是为了让未登录或写回失败时点过的心不丢。
 * @param {object} song 曲目对象。
 * @param {boolean} liked 是否收藏。
 * @returns {boolean} 引用表是否发生变化。
 */
function syncSpecialLikedOnlineRef(song, liked) {
  if (!song || typeof songAccountStateKey === 'function' && !songAccountStateKey(song)) return false;
  if (specialLikedIsLocalSong(song)) return false;
  var refs = readSpecialLikedSongRefs();
  var index = specialLikedSongRefIndex(song);
  if (liked) {
    if (index >= 0) return false;
    refs.push(specialLikedSongRef(song));
    writeSpecialLikedSongRefs(refs);
    return true;
  }
  if (index < 0) return false;
  refs.splice(index, 1);
  writeSpecialLikedSongRefs(refs);
  return true;
}
/* ---- 切片终点（tests/local-special-liked.test.js 的 marker，勿删） ---- */

/**
 * 把本地歌的收藏状态写进 SQLite 的 favorite 镜像。localStorage 引用表仍是唯一权威，
 * 这里只让「清了 localStorage / 换了数据桶」之后还能把权益捞回来。
 * @param {object} song 本地曲目对象。
 * @param {boolean} favorite 是否收藏。
 * @returns {void}
 */
function syncLocalLibraryDbFavorite(song, favorite) {
  if (!song || !specialLikedIsLocalSong(song)) return;
  var songKey = String(song.localKey || '');
  if (!songKey) return;
  callLocalLibraryDb('setLocalLibraryDbFavorite', {
    key: songKey,
    pathKey: typeof localLibraryPathKeyFromSong === 'function' ? localLibraryPathKeyFromSong(song) : '',
    favorite: favorite ? 1 : 0,
    name: song.name || '',
    artist: song.artist || '',
  });
}
