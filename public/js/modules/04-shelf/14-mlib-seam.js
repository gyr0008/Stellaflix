// ============================================================================
// 04-shelf/14-mlib-seam.js
// 批4-B：window.stellaMlibSeam 生产 provider（新写胶水，非 1:1 移植）。
// 把批4-A 引擎（13-local-library-engine.js）的本地曲库态包装成 mlib 读层
//   （04-shelf/07-mlib-readlayer.js）+ 页面（08-mlib-page.js）已约定的 seam 契约。
// 硬契约（08 page 注释）：**页面绝不合成 localUrl**——播放地址只可能来自缝给的 song.localUrl，
//   故 seamTrackFromSong 必须把引擎的 localUrl（= /api/local-file 代理地址）透传下去。
// 依赖（模块拼接后同全局作用域）：getLocalLibraryTracks / getLocalLibraryStats /
//   addLocalLibraryRoot / removeLocalLibraryRoot（引擎 13）+ normalizeLocalLibraryPathKey（block2）。
// ============================================================================

// 订阅者列表：引擎结构性变化（增删根/水合）时通知，读层据此失效重取（不轮询）。
var mlibSeamSubscribers = [];

/**
 * 把引擎 track 对象映射成 seam track（读层专辑/艺人轴 + 页面播放都认这个形状）。
 * @param {object} song 引擎曲目对象（makeLocalSongFromFile 产出）。
 * @returns {object} seam track。
 */
function seamTrackFromSong(song) {
  if (!song) return null;
  var album = String(song.album || '');
  var artist = String(song.artist || song.name || '');
  var key = String(song.localKey || song.localLibraryPathKey || song.name || '');
  var url = String(song.localUrl || song.localFileUrl || '');
  return {
    id: key,
    localKey: song.localKey || '',
    title: String(song.name || ''),
    name: String(song.name || ''),
    artist: artist,
    album: album,
    // 本地曲目按专辑名/艺名归一出稳定轴 id；无标签时归到各自 localKey 保证不丢轴。
    albumId: album ? ('local-album:' + normalizeLocalLibraryPathKey(album)) : ('local-album:' + key),
    artistId: artist ? ('local-artist:' + normalizeLocalLibraryPathKey(artist)) : ('local-artist:' + key),
    cover: String(song.localCoverDataUrl || ''),
    matched: !!url,          // 有可播地址即视为可匹配/可播
    playable: !!url,
    releaseYear: 0,
    sortKeyPinyin: '',
    localUrl: url,
    url: url,
    duration: Number(song.duration) || 0,
    type: 'local',
    // 批4-C2-B：把已解析/已持久化的内嵌歌词带到 seam track；播放时 applyLocalTrackLyricOnDemand
    //   见到 song.lyric 直接应用，不再走旧 readLocalMusicLyric（新轨无 localFileId）。
    lyric: String(song.lyric || song.localLyricText || ''),
    hasLyric: !!(song.lyric || song.localLyricText),
    lyricSource: String(song.lyricSource || ''),
  };
}

function seamTracks() {
  return getLocalLibraryTracks().map(seamTrackFromSong).filter(Boolean);
}

window.stellaMlibSeam = {
  // ---- 读层契约（07-mlib-readlayer.js 消费）----
  getLibraryStats: async function () {
    var stats = getLocalLibraryStats();
    return { ready: true, rev: stats.revision, rootCount: stats.rootCount, trackCount: stats.trackCount };
  },
  getTracks: async function () {
    return { tracks: seamTracks(), rev: getLocalLibraryStats().revision };
  },
  getPlaylists: async function () {
    // 批4-B：本地自建歌单尚未接入（03b-local-playlist-store 另接），先返回空。
    return { playlists: [], rev: getLocalLibraryStats().revision };
  },
  getAlbumDetail: async function (albumId) {
    var id = String(albumId || '');
    var tracks = seamTracks().filter(function (t) { return t.albumId === id; });
    var first = tracks[0] || {};
    return { id: id, title: first.album || '', artist: first.artist || '', cover: first.cover || '', tracks: tracks, rev: getLocalLibraryStats().revision };
  },
  getArtistDetail: async function (artistId) {
    var id = String(artistId || '');
    var tracks = seamTracks().filter(function (t) { return t.artistId === id; });
    var first = tracks[0] || {};
    return { id: id, title: first.artist || '', cover: first.cover || '', tracks: tracks, rev: getLocalLibraryStats().revision };
  },
  getPlaylistDetail: async function (playlistId) {
    return { id: String(playlistId || ''), title: '', tracks: [], rev: getLocalLibraryStats().revision };
  },
  subscribe: function (handler) {
    if (typeof handler !== 'function') return function () {};
    mlibSeamSubscribers.push(handler);
    var subscribed = true;
    return function () {
      if (!subscribed) return;
      subscribed = false;
      var idx = mlibSeamSubscribers.indexOf(handler);
      if (idx >= 0) mlibSeamSubscribers.splice(idx, 1);
    };
  },

  // ---- 变更入口（导入/移除 UI 在批4-C 调用；变更后通知读层失效重取）----
  notifyChange: function () {
    var snapshot = mlibSeamSubscribers.slice();
    for (var i = 0; i < snapshot.length; i += 1) {
      try { snapshot[i](); } catch (_e) { /* 单个订阅者抛错不影响其它 */ }
    }
  },
  addLocalMusicFolder: async function (folderPath) {
    var res = await addLocalLibraryRoot(folderPath);
    if (res && res.ok) {
      // C1：水合后解析标签/封面/歌词，让 mlib 显示完整（不再只有文件名）。
      try { await parseLocalLibraryRootMetadata(folderPath); } catch (_e) { /* 解析失败不阻断导入 */ }
    }
    this.notifyChange();
    return res;
  },
  // 已扫描落库的根：只水合 + 解析，不重复扫描（chooseLocalMusicFolder 已扫过时用这条）。
  hydrateFolder: async function (folderPath) {
    var res = await hydrateLocalLibraryRoot(folderPath);
    if (res && res.ok) {
      try { await parseLocalLibraryRootMetadata(folderPath); } catch (_e) { /* 解析失败不阻断 */ }
    }
    this.notifyChange();
    return res;
  },
  // 启动水合：枚举已落库全部根并水合（重启后 mlib 自动恢复）。批4-C1b。
  hydrateAll: async function () {
    var res = await hydrateAllLocalLibraryRoots();
    this.notifyChange();
    return res;
  },
  // 按曲移除（内存态 + SQLite 行）。批4-D 前置。
  removeLocalTracks: async function (songKeys) {
    var res = await removeLocalLibraryTracks(songKeys);
    this.notifyChange();
    return res;
  },
  removeLocalMusicFolder: function (folderPath) {
    var res = removeLocalLibraryRoot(folderPath);
    this.notifyChange();
    return res;
  },
};
