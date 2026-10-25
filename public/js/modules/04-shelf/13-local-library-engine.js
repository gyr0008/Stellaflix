// ============================================================================
// 04-shelf/13-local-library-engine.js
// 批4-A：本地曲库引擎内核（新写胶水，非 1:1 移植）。
// 职责：把主进程 SQLite 曲库（经 20-local-library-db-bridge 的 callLocalLibraryDb）
//   水合成渲染层 track 对象（block2 makeLocalSongFromFile），维护内存库态，
//   向上（批4-B seam）提供 getLocalLibraryTracks / getLocalLibraryStats。
// 依赖（模块拼接后同全局作用域，函数声明提升，无需 import）：
//   - callLocalLibraryDb（05-playback/20-local-library-db-bridge.js，SQLite 桥通用派发）
//   - makeLocalSongFromFile / isLocalAudioFile（04-shelf/11-local-track-map.js）
//   - hydrateCustomCover（05-playback/01-cover-custom-map.js，生产拼接在场）
//   - playQueue / currentIdx（渲染层既有播放队列全局）
// 只定义函数 + 一个内存态对象；不被调用前无副作用（seam 接线在批4-B）。
// ============================================================================

// 内存库态：folderPath → { songs: track[], savedAt }。重启后由各根重新水合重建。
var localLibraryEngineRoots = Object.create(null);
// 库态代次：每次结构性变化（增删根/刷新）自增，供订阅方判断是否要重取。
var localLibraryEngineRevision = 0;

/**
 * 水合一个曲库根：从 SQLite 读回文件列表，过虑出音频，逐个组装成 track 对象。
 * 只读不改；SQLite 不可用/根不存在时返回 {ok:false}，不影响其它根。
 * @param {string} folderPath 曲库根绝对路径。
 * @returns {Promise<{ok:boolean, folderPath:string, count:number, error?:string}>} 水合结果。
 */
async function hydrateLocalLibraryRoot(folderPath) {
  var root = String(folderPath || '');
  if (!root) return { ok: false, folderPath: '', count: 0, error: 'LOCAL_LIBRARY_PATH_EMPTY' };
  var loaded = null;
  try {
    loaded = await callLocalLibraryDb('loadLocalLibraryDbRoot', root, {});
  } catch (e) {
    return { ok: false, folderPath: root, count: 0, error: (e && e.message) || 'LOCAL_LIBRARY_DB_LOAD_FAILED' };
  }
  if (!loaded || !loaded.ok || !Array.isArray(loaded.files)) {
    return { ok: false, folderPath: root, count: 0, error: (loaded && loaded.error) || 'LOCAL_LIBRARY_DB_UNAVAILABLE' };
  }
  // 批4 修复：用 createLocalSongsFromFiles 做旁挂封面/歌词配对（同目录 cover.jpg / .lrc）。
  // 原手工 makeLocalSongFromFile(file,null,null,[]) 把旁挂全丢，是真机「无海报无歌词」的根因。
  var songs = [];
  try { songs = createLocalSongsFromFiles(loaded.files) || []; } catch (_e0) { songs = []; }
  var indexRecords = (loaded.index && loaded.index.records) || {};
  for (var i = 0; i < songs.length; i += 1) {
    var song = songs[i];
    if (!song) continue;
    try {
      // 播放层认 song.localUrl；桥接 /api/local-file 代理地址。
      if (!song.localUrl && song.localFileUrl) song.localUrl = song.localFileUrl;
      // 旁挂封面：直接用封面文件的代理 URL 作 display 地址（封面文件已在扫描结果里，无需读字节）。
      if (song.localCoverFile && !song.localCoverDataUrl) {
        var sideCoverUrl = localFileUrlFromEntry(song.localCoverFile);
        if (sideCoverUrl) song.localCoverDataUrl = sideCoverUrl;
      }
      // 应用持久化索引里的真实标签。
      var idx = indexRecords[song.localKey];
      if (idx) {
        if (idx.name) song.name = idx.name;
        if (idx.artist) song.artist = idx.artist;
        if (idx.album) song.album = idx.album;
        if (idx.albumArtist) song.albumArtist = idx.albumArtist;
        if (idx.genre) song.genre = idx.genre;
        if (idx.year) song.year = idx.year;
        if (idx.trackNumber) song.trackNumber = idx.trackNumber;
        if (Number(idx.duration) > 0 && !(song.duration > 0)) song.duration = Number(idx.duration);
        if (idx.localFormat) song.localFormat = idx.localFormat;
      }
    } catch (_e) { /* 单条失败跳过，不阻断整根 */ }
  }
  // 批4-C1b：合并持久化的封面/歌词（重启后不重解析也能显示）。
  var mergeKeys = [];
  for (var ki = 0; ki < songs.length; ki += 1) { if (songs[ki].localKey) mergeKeys.push(songs[ki].localKey); }
  if (mergeKeys.length) {
    try {
      var assets = await callLocalLibraryDb('readLocalLibraryDbAssets', mergeKeys);
      var lyrics = await callLocalLibraryDb('readLocalLibraryDbLyrics', mergeKeys);
      var assetMap = (assets && assets.ok && assets.records) || {};
      var lyricMap = (lyrics && lyrics.ok && lyrics.records) || {};
      for (var mi = 0; mi < songs.length; mi += 1) {
        var mk = songs[mi].localKey;
        var asset = assetMap[mk];
        if (asset && asset.localCoverThumbDataUrl && !songs[mi].localCoverDataUrl) songs[mi].localCoverDataUrl = asset.localCoverThumbDataUrl;
        var lyricRec = lyricMap[mk];
        if (lyricRec && lyricRec.localLyricText && !songs[mi].localLyricText) songs[mi].localLyricText = lyricRec.localLyricText;
      }
    } catch (_e2) { /* 缓存读失败不影响曲目本身 */ }
  }
  localLibraryEngineRoots[normalizeLocalLibraryPathKey(root)] = {
    folderPath: root,
    songs: songs,
    savedAt: Number(loaded.savedAt) || 0,
  };
  localLibraryEngineRevision += 1;
  return { ok: true, folderPath: root, count: songs.length };
}

/**
 * 新增一个曲库根：先触发主进程扫描落库，再水合进内存态。
 * @param {string} folderPath 曲库根绝对路径。
 * @returns {Promise<object>} 水合结果（含扫描摘要）。
 */
async function addLocalLibraryRoot(folderPath) {
  var root = String(folderPath || '');
  if (!root) return { ok: false, error: 'LOCAL_LIBRARY_PATH_EMPTY' };
  var scan = null;
  try {
    scan = await callLocalLibraryDb('scanLocalMusicFolder', root, {});
  } catch (_e) { /* 扫描失败仍尝试读旧库 */ }
  var hydrated = await hydrateLocalLibraryRoot(root);
  return { ok: hydrated.ok, folderPath: root, count: hydrated.count, scan: scan || null };
}

/**
 * 移除一个曲库根（仅从内存态摘除；SQLite 行由调用方决定是否 clear）。
 * @param {string} folderPath 曲库根绝对路径。
 * @returns {{ok:boolean, removed:boolean}} 移除结果。
 */
function removeLocalLibraryRoot(folderPath) {
  var key = normalizeLocalLibraryPathKey(folderPath);
  var had = Object.prototype.hasOwnProperty.call(localLibraryEngineRoots, key);
  if (had) {
    delete localLibraryEngineRoots[key];
    localLibraryEngineRevision += 1;
  }
  return { ok: true, removed: had };
}

/**
 * 取全部本地曲目（跨所有已水合根，按根内原序拼接）。
 * @returns {Array<object>} track 对象数组。
 */
function getLocalLibraryTracks() {
  var all = [];
  for (var key in localLibraryEngineRoots) {
    if (!Object.prototype.hasOwnProperty.call(localLibraryEngineRoots, key)) continue;
    var songs = localLibraryEngineRoots[key].songs;
    for (var i = 0; i < songs.length; i += 1) all.push(songs[i]);
  }
  return all;
}

/**
 * 曲库统计（seam getLibraryStats 的数据源之一）。
 * @returns {{ready:boolean, revision:number, rootCount:number, trackCount:number}} 统计。
 */
function getLocalLibraryStats() {
  var tracks = getLocalLibraryTracks();
  var rootCount = 0;
  for (var key in localLibraryEngineRoots) {
    if (Object.prototype.hasOwnProperty.call(localLibraryEngineRoots, key)) rootCount += 1;
  }
  return {
    ready: true,
    revision: localLibraryEngineRevision,
    rootCount: rootCount,
    trackCount: tracks.length,
  };
}

/**
 * 派生「当前本地曲目」：播放队列当前项且为 local 时返回它，否则 null。
 * 供 block3 collectProtectedLocalAssetCacheKeys 等按当前曲目保护缓存的逻辑使用；
 * 与播放层既有 currentLocalSong 引用保持同源（playQueue/currentIdx 是既有全局）。
 * @returns {object|null} 当前本地曲目或 null。
 */
function localLibraryCurrentSong() {
  try {
    if (typeof playQueue !== 'undefined' && Array.isArray(playQueue)
      && typeof currentIdx !== 'undefined' && currentIdx >= 0 && currentIdx < playQueue.length) {
      var song = playQueue[currentIdx];
      if (song && (song.type === 'local' || song.source === 'local' || song.localUrl)) return song;
    }
  } catch (_e) { /* 引擎态未就绪时静默返回 null */ }
  return null;
}

/**
 * 解析单曲标签/封面/歌词（C1 标签管线核心）。
 * 经 block1 自研解析器从文件字节读出标签 + 内嵌封面 + 内嵌歌词，应用到歌曲对象：
 *   - 标签：extractLocalMetadataTags → applyLocalMetadataTags（title/artist/album/genre/year/duration…）
 *   - 封面：extractEmbeddedCoverSource（Blob）→ URL.createObjectURL → song.localCoverDataUrl
 *   - 歌词：extractEmbeddedLyricsText → song.localLyricText
 * 纯内存应用，不写 SQLite（落库另由批4 缓存桥负责）；任一段失败不阻断其余。
 * @param {object} song 引擎曲目对象（须带 localFile 文件描述）。
 * @returns {Promise<{ok:boolean, changed:boolean, hasCover:boolean, hasLyric:boolean}>} 解析结果。
 */
async function parseLocalTrackMetadata(song, folderPath) {
  if (!song || !song.localFile) return { ok: false, changed: false, hasCover: false, hasLyric: false };
  var changed = false;
  var hasCover = false;
  var hasLyric = false;
  try {
    var tags = await extractLocalMetadataTags(song.localFile, {});
    if (tags) changed = applyLocalMetadataTags(song, tags) || changed;
  } catch (_e) { /* 标签解析失败不阻断封面/歌词 */ }
  try {
    var coverSource = await extractEmbeddedCoverSource(song.localFile, {});
    if (coverSource) {
      var coverUrl = await coverSourceToDataUrl(coverSource);
      if (coverUrl) { song.localCoverDataUrl = coverUrl; hasCover = true; }
    }
  } catch (_e2) { /* 封面失败不阻断 */ }
  try {
    var lyric = await extractEmbeddedLyricsText(song.localFile, {});
    if (lyric) {
      song.localLyricText = lyric;
      // 批4-C2-B：同时置 hasLyric/lyric/lyricSource，让歌词面板可直接用（新轨无 localFileId 走不了旧 readLocalMusicLyric）。
      song.lyric = lyric;
      song.hasLyric = true;
      song.lyricSource = song.lyricSource || 'embedded';
      hasLyric = true;
    }
  } catch (_e3) { /* 歌词失败不阻断 */ }
  // 旁挂歌词：同目录歌词文件走 readLocalLyricText（= 参照库 L33833 的旁挂入口，
  // 内部按内容特征分 KRC/QRC 加密与明文，改后缀名也能认出来）。
  if (!hasLyric && song.localLyricFile) {
    try {
      var sideText = await readLocalLyricText(song.localLyricFile);
      if (sideText) {
        song.localLyricText = sideText;
        song.lyric = sideText;
        song.hasLyric = true;
        song.lyricSource = song.lyricSource || 'sidecar';
        hasLyric = true;
      }
    } catch (_e3b) { /* 旁挂歌词读失败不阻断 */ }
  }
  try { await persistLocalTrackMetadata(folderPath, song); } catch (_e4) { /* 落库失败不阻断 */ }
  return { ok: true, changed: changed, hasCover: hasCover, hasLyric: hasLyric };
}

/**
 * 把内嵌封面 Blob 转「data:」URL（既可显示、也可持久化；blob: 重启即失效）。批4-C1b。
 * 浏览器走 FileReader；无 FileReader 环境（vm 测试/Node）走 arrayBuffer + btoa。
 * @param {Blob} blob 封面 Blob。
 * @returns {Promise<string>} data URL；失败返回空串。
 */
async function coverSourceToDataUrl(blob) {
  if (!blob) return '';
  try {
    if (typeof FileReader !== 'undefined') {
      return await new Promise(function (resolve) {
        try {
          var reader = new FileReader();
          reader.onload = function () { resolve(String(reader.result || '')); };
          reader.onerror = function () { resolve(''); };
          reader.readAsDataURL(blob);
        } catch (_e) { resolve(''); }
      });
    }
    var buf = new Uint8Array(await blob.arrayBuffer());
    var bin = '';
    for (var i = 0; i < buf.length; i += 1) bin += String.fromCharCode(buf[i]);
    return 'data:' + (blob.type || 'image/jpeg') + ';base64,' + btoa(bin);
  } catch (_e) { return ''; }
}

/**
 * 单曲解析结果落库（批4-C1b）：标签经 saveIndexRecords 回写 files 索引行；封面/歌词经 assets/lyrics 表。
 * @param {string} folderPath 曲库根。
 * @param {object} song 曲目。
 * @returns {Promise<void>}
 */
async function persistLocalTrackMetadata(folderPath, song) {
  if (!folderPath || !song || !song.localKey) return;
  var record = {
    key: song.localKey,
    pathKey: song.localLibraryPathKey,
    fullPath: song.localFilePathAbsolute,
    fileSignature: song.localLibraryFileSignature,
    size: song.localFileSize,
    mtime: song.localFileLastModified,
    name: song.name,
    artist: song.artist,
    album: song.album,
    albumArtist: song.albumArtist,
    genre: song.genre,
    year: song.year,
    trackNumber: song.trackNumber,
    duration: song.duration,
    localFormat: song.localFormat,
    localBitrateKbps: song.localBitrateKbps,
    localMetadataLoaded: 1,
    localMetadataTagSchema: 1,
    coverStatus: song.localCoverDataUrl ? 'loaded' : '',
    coverSource: song.localCoverDataUrl ? 'embedded' : '',
    lyricStatus: song.localLyricText ? 'loaded' : '',
    lyricSource: song.localLyricText ? 'embedded' : '',
    updatedAt: Date.now(),
  };
  try { await callLocalLibraryDb('saveLocalLibraryDbIndexRecords', folderPath, [record]); } catch (_e) { /* 索引回写失败不阻断 */ }
  if (song.localCoverDataUrl && song.localCoverDataUrl.indexOf('data:') === 0) {
    try {
      await callLocalLibraryDb('writeLocalLibraryDbAssets', [{
        id: song.localKey, name: song.name, artist: song.artist, album: song.album,
        localCoverThumbDataUrl: song.localCoverDataUrl, localCoverLoaded: 1, localCoverSource: 'embedded',
      }]);
    } catch (_e2) { /* 封面落库失败不阻断 */ }
  }
  if (song.localLyricText) {
    try {
      await callLocalLibraryDb('writeLocalLibraryDbLyrics', [{
        id: song.localKey, localLyricText: song.localLyricText, localLyricLoaded: 1, localLyricSource: 'embedded',
      }]);
    } catch (_e3) { /* 歌词落库失败不阻断 */ }
  }
}

/**
 * 解析一个曲库根下全部已水合曲目的标签/封面/歌词（批量包装）。
 * @param {string} folderPath 曲库根绝对路径。
 * @returns {Promise<{ok:boolean, total:number, parsed:number, covers:number, lyrics:number}>} 批量结果。
 */
async function parseLocalLibraryRootMetadata(folderPath, opts) {
  opts = opts || {};
  var key = normalizeLocalLibraryPathKey(folderPath);
  var entry = localLibraryEngineRoots[key];
  if (!entry || !Array.isArray(entry.songs)) return { ok: false, total: 0, parsed: 0, covers: 0, lyrics: 0 };
  var parsed = 0; var covers = 0; var lyrics = 0;
  for (var i = 0; i < entry.songs.length; i += 1) {
    // skipComplete：已有封面+歌词的曲目跳过，避免每次启动重解析。
    if (opts.skipComplete && entry.songs[i].localCoverDataUrl && entry.songs[i].localLyricText) continue;
    var res = await parseLocalTrackMetadata(entry.songs[i], entry.folderPath || folderPath);
    if (res.ok) parsed += 1;
    if (res.hasCover) covers += 1;
    if (res.hasLyric) lyrics += 1;
  }
  localLibraryEngineRevision += 1;
  return { ok: true, total: entry.songs.length, parsed: parsed, covers: covers, lyrics: lyrics };
}

/**
 * 启动水合：枚举已落库的全部根，逐个水合进内存态（重启后 mlib 自动恢复）。批4-C1b。
 * @returns {Promise<{ok:boolean, roots:number, tracks:number}>} 汇总。
 */
async function hydrateAllLocalLibraryRoots() {
  var listed = null;
  try { listed = await callLocalLibraryDb('listLocalLibraryDbRoots'); } catch (_e) { return { ok: false, roots: 0, tracks: 0 }; }
  if (!listed || !listed.ok || !Array.isArray(listed.roots)) return { ok: false, roots: 0, tracks: 0 };
  var total = 0;
  for (var i = 0; i < listed.roots.length; i += 1) {
    var res = await hydrateLocalLibraryRoot(listed.roots[i]);
    if (res && res.ok) {
      total += res.count;
      // 批4 修复：启动时补齐缺失的封面/歌词（旁挂 .lrc 文本 + 内嵌），已完整的不重解析。
      try { await parseLocalLibraryRootMetadata(listed.roots[i], { skipComplete: true }); } catch (_e2) { /* 解析失败不阻断 */ }
    }
  }
  return { ok: true, roots: listed.roots.length, tracks: total };
}

/**
 * 按 songKey 移除曲目：从内存态摘除 + 删 SQLite 行（files/assets/lyrics），供「移除单曲」。批4-D 前置。
 * @param {Array<string>} songKeys 要移除的 songKey 列表。
 * @returns {Promise<{ok:boolean, removed:number}>} 移除数量。
 */
async function removeLocalLibraryTracks(songKeys) {
  var keys = (Array.isArray(songKeys) ? songKeys : [songKeys]).filter(function (k) { return typeof k === 'string' && k; });
  if (!keys.length) return { ok: true, removed: 0 };
  var removed = 0;
  for (var rk in localLibraryEngineRoots) {
    if (!Object.prototype.hasOwnProperty.call(localLibraryEngineRoots, rk)) continue;
    var entry = localLibraryEngineRoots[rk];
    var keep = [];
    var hit = [];
    var hitRecords = [];
    for (var i = 0; i < entry.songs.length; i += 1) {
      var s = entry.songs[i];
      if (keys.indexOf(s.localKey) >= 0) {
        hit.push(s.localKey);
        // 传给 store 的完整记录：按 song_key 或指纹（pathKey+size+mtime）定位，规避归一化差异。
        hitRecords.push({ key: s.localKey, pathKey: s.localLibraryPathKey, fileSignature: s.localLibraryFileSignature, size: s.localFileSize, mtime: s.localFileLastModified });
      } else {
        keep.push(s);
      }
    }
    if (hit.length) {
      entry.songs = keep;
      removed += hit.length;
      try { await callLocalLibraryDb('deleteLocalLibraryDbFiles', entry.folderPath, hitRecords); } catch (_e) { /* 删库失败不回滚内存态 */ }
    }
  }
  if (removed) localLibraryEngineRevision += 1;
  return { ok: true, removed: removed };
}
