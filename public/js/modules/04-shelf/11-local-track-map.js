// ============================================================================
// 04-shelf/11-local-track-map.js
// 批3-A：扫描记录→曲目对象/文件映射/歌词封面配对（block2）——1:1 移植自参照库
//   Mineradio-2.5.1 public/app.js L32915-33375。仅门牌号/品牌口径，零功能裁剪。
// 补段：L33382-33389（countTextGarbageChars，decodeLocalTextBuffer 的评分依赖）与
//   L23286-23327（同名多歌词选择记录）。后者在参照库紧挨 saveCustomLyricPrefs，本仓按
//   「与唯一调用方 applyStoredLocalLyricPick 同文件」落在此处；参照库的 save/set 两个写入
//   函数暂无调用方（歌词版本选择 UI 未接），未带入。
// 含 block2 依赖的顶层常量（LOCAL_*_RE / LOCAL_LIBRARY_NAME_COMPARE）与全部映射函数。
// 提供 block1（10-local-tag-parser.js）运行时依赖 localFullPath / desktopLocalMusicApi，
// localSongKeyFromFile（= 绝对路径:大小:修改时间，与批2-B-2 扫描 songKey 同构）、
// makeLocalSongFromFile / createLocalSongsFromFiles、歌词/封面 sidecar 配对等。
// 播放 URL 取 file.url（批2-B-2 扫描已填 /api/local-file 代理地址）。
// 与 05-playback/20-local-library-db-bridge.js 并存：本文件管「文件→曲目」，那件管「曲目↔SQLite」。
// ============================================================================
var LOCAL_AUDIO_FILE_RE = /\.(mp3|mp2|flac|wav|ogg|oga|m4a|m4b|aac|opus|webm|weba|aif|aiff|aifc|ape|dsf)$/i;
var LOCAL_FOLDER_AUDIO_FILE_RE = /\.(mp3|mp2|flac|wav|ogg|oga|m4a|m4b|aac|opus|webm|weba|aif|aiff|aifc|ape|dsf)$/i;
var LOCAL_LYRIC_FILE_RE = /\.(lrc|txt|srt|vtt|ass|ssa|yrc|krc|qrc|ttml)$/i;
// 同一首歌撞上多个歌词文件时的取舍：逐字时间轴信息最全，字幕格式只有整行，纯文本连时间轴都没有。
var LOCAL_LYRIC_FORMAT_RANK = { qrc: 0, krc: 0, ttml: 0, yrc: 0, lrc: 1, ass: 2, ssa: 2, srt: 2, vtt: 2, txt: 3 };
var LOCAL_COVER_FILE_RE = /\.(jpg|jpeg|jpe|jfif|png|webp|avif|gif|bmp|svg)$/i;
var LOCAL_COVER_NAME_RE = /^(cover|folder|front|album|artwork|封面|专辑封面)$/i;
var LOCAL_LIBRARY_NAME_COMPARE = (typeof Intl !== 'undefined' && Intl.Collator)
  ? new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' }).compare
  : function(a, b){ return String(a || '').localeCompare(String(b || '')); };
function compareLocalFilePath(a, b) {
  return LOCAL_LIBRARY_NAME_COMPARE(localFilePath(a), localFilePath(b));
}
/**
 * 将 FileList 或类数组转换为紧凑数组。大文件夹导入会反复调用，单次循环避免 slice/filter 中间数组。
 * @param {FileList|Array<object>} files 文件集合。
 * @returns {Array<object>} 已去除空项的文件数组。
 */
function fileListToArray(files) {
  if (!files) return [];
  var length = Number(files.length) || 0;
  var list = [];
  for (var i = 0; i < length; i++) {
    if (files[i]) list.push(files[i]);
  }
  return list;
}
function desktopLocalMusicApi() {
  return window.desktopWindow && window.desktopWindow.isDesktop ? window.desktopWindow : null;
}
function localFullPath(file) {
  return String((file && (file.fullPath || file.filePath || file.path || file.localFilePathAbsolute)) || '');
}
function localFileUrlFromEntry(file) {
  return String((file && (file.url || file.fileUrl || file.localFileUrl)) || '');
}
function localFileSize(file) {
  return Number(file && file.size || 0) || 0;
}
function localFileLastModified(file) {
  return Number(file && file.lastModified || 0) || 0;
}
function localFilePath(file) {
  return String((file && (file.webkitRelativePath || file.relativePath || file.name || localFullPath(file))) || '').replace(/\\/g, '/');
}
function normalizeLocalLibraryPathKey(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .trim()
    .toLowerCase();
}
function localLibraryPathKeyFromFile(file) {
  return normalizeLocalLibraryPathKey(localFullPath(file) || localFilePath(file) || (file && file.name) || '');
}
function localLibraryPathKeyFromSong(song) {
  if (!song) return '';
  return normalizeLocalLibraryPathKey(song.localFilePathAbsolute || song.localPath || song.name || '');
}
function localLibraryFileSignatureFromFile(file) {
  return localLibraryPathKeyFromFile(file) + '|' + localFileSize(file) + '|' + localFileLastModified(file);
}
function localLibraryFileSignatureFromSong(song) {
  if (!song) return '';
  return localLibraryPathKeyFromSong(song) + '|' +
    (Number(song.localFileSize || (song.localFile && localFileSize(song.localFile)) || 0) || 0) + '|' +
    (Number(song.localFileLastModified || (song.localFile && localFileLastModified(song.localFile)) || 0) || 0);
}
function localPathDir(file) {
  var p = localFilePath(file);
  var idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(0, idx + 1) : '';
}
function localFileBaseName(file) {
  var p = localFilePath(file);
  var idx = p.lastIndexOf('/');
  var name = (idx >= 0 ? p.slice(idx + 1) : p) || (file && file.name) || '';
  var dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(0, dot) : name;
}
function localPathStem(file) {
  return (localPathDir(file) + localFileBaseName(file)).toLowerCase();
}
function localBaseStem(file) {
  return localFileBaseName(file).toLowerCase();
}
function normalizeLocalAssetName(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\[\(（【].*?[\]\)）】]/g, '')
    .replace(/[\s._\-–—~·・、，,。!！?？:：;；'"“”‘’/\\|]+/g, '');
}
function isLocalAudioFile(file, folderOnly) {
  var name = file && file.name || '';
  return !!(file && ((file.type && file.type.indexOf('audio/') === 0) || (folderOnly ? LOCAL_FOLDER_AUDIO_FILE_RE : LOCAL_AUDIO_FILE_RE).test(name)));
}
function isLocalLyricFile(file) {
  return !!(file && LOCAL_LYRIC_FILE_RE.test(file.name || ''));
}
function isLocalCoverFile(file) {
  return !!(file && ((file.type && file.type.indexOf('image/') === 0) || LOCAL_COVER_FILE_RE.test(file.name || '')));
}
/**
 * 构建本地歌词文件索引。大文件夹导入时使用显式循环，避免 forEach 回调在每个文件上分配闭包上下文。
 * 同名撞车的歌词会全部留在候选列表里，按格式优先级排好序，供自动选择和手动切换共用。
 * @param {FileList|Array<object>} files 导入文件集合。
 * @returns {{byPath: object, byBase: object, byLoose: object}} 歌词匹配索引，每个键对应一组候选。
 */
function buildLocalLyricMaps(files) {
  var maps = { byPath: {}, byBase: {}, byLoose: {} };
  var length = Number(files && files.length) || 0;
  for (var i = 0; i < length; i++) {
    var file = files[i];
    if (!isLocalLyricFile(file)) continue;
    pushLocalLyricCandidate(maps.byPath, localPathStem(file), file);
    pushLocalLyricCandidate(maps.byBase, localBaseStem(file), file);
    pushLocalLyricCandidate(maps.byLoose, normalizeLocalAssetName(localFileBaseName(file)), file);
  }
  sortLocalLyricCandidateBuckets(maps.byPath);
  sortLocalLyricCandidateBuckets(maps.byBase);
  sortLocalLyricCandidateBuckets(maps.byLoose);
  return maps;
}
/**
 * 把歌词文件塞进对应的候选桶。歌词文件名来自用户磁盘，`__proto__` 这类键要挡掉，
 * 否则赋值会被原型 setter 吞掉、后续 push 反而写到 Object.prototype 上。
 * @param {object} bucketMap 候选桶集合。
 * @param {string} key 匹配键。
 * @param {object} file 歌词文件。
 * @returns {void}
 */
function pushLocalLyricCandidate(bucketMap, key, file) {
  if (!key || key === '__proto__') return;
  if (Object.prototype.hasOwnProperty.call(bucketMap, key)) bucketMap[key].push(file);
  else bucketMap[key] = [file];
}
/**
 * 给每个候选桶排序，最优先的歌词排在最前。
 * @param {object} bucketMap 候选桶集合。
 * @returns {void}
 */
function sortLocalLyricCandidateBuckets(bucketMap) {
  var keys = Object.keys(bucketMap);
  for (var i = 0; i < keys.length; i++) {
    var list = bucketMap[keys[i]];
    if (list.length > 1) list.sort(compareLocalLyricCandidates);
  }
}
/**
 * 取歌词文件的小写后缀。
 * @param {object} file 歌词文件。
 * @returns {string} 不带点的后缀名。
 */
function localLyricFileExt(file) {
  var name = String((file && file.name) || '');
  var dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}
/**
 * 取歌词格式优先级，数字越小越优先：逐字时间轴 > 逐行 LRC > 字幕 > 纯文本 > 未知后缀。
 * @param {object} file 歌词文件。
 * @returns {number} 优先级序号。
 */
function localLyricFormatRank(file) {
  var rank = LOCAL_LYRIC_FORMAT_RANK[localLyricFileExt(file)];
  return typeof rank === 'number' ? rank : 4;
}
/**
 * 比较两个同名歌词候选：先看格式优先级，再按路径排，保证同一批文件每次导入都得到同样的结果。
 * @param {object} a 候选歌词文件。
 * @param {object} b 候选歌词文件。
 * @returns {number} 排序结果。
 */
function compareLocalLyricCandidates(a, b) {
  return (localLyricFormatRank(a) - localLyricFormatRank(b)) || compareLocalFilePath(a, b);
}
/**
 * 取候选桶。键来自用户磁盘上的文件名，`constructor` 这类原型键必须靠自有属性判断挡掉，
 * 否则 `{}['constructor']` 会把 Object 当成候选数组，凭 `Object.length === 1` 混进一个 undefined 候选。
 * @param {object} bucketMap 候选桶集合。
 * @param {string} key 匹配键。
 * @returns {Array<object>|null} 候选列表；没有该键时返回 null。
 */
function localLyricCandidateBucket(bucketMap, key) {
  if (!bucketMap || !key || !Object.prototype.hasOwnProperty.call(bucketMap, key)) return null;
  return bucketMap[key];
}
/**
 * 找出与音频对应的全部歌词候选。先精确路径，再同目录同名，最后模糊名，同一层内按格式优先级排序。
 * @param {object} audioFile 音频文件。
 * @param {{byPath: object, byBase: object, byLoose: object}} maps 歌词匹配索引。
 * @returns {Array<object>} 候选歌词文件列表，最优先的排在最前。
 */
function findLocalLyricCandidates(audioFile, maps) {
  maps = maps || {};
  var buckets = [
    localLyricCandidateBucket(maps.byPath, localPathStem(audioFile)),
    localLyricCandidateBucket(maps.byBase, localBaseStem(audioFile)),
    localLyricCandidateBucket(maps.byLoose, normalizeLocalAssetName(localFileBaseName(audioFile)))
  ];
  var out = [];
  for (var i = 0; i < buckets.length; i++) {
    var list = buckets[i];
    if (!list || !list.length) continue;
    for (var j = 0; j < list.length; j++) {
      if (out.indexOf(list[j]) < 0) out.push(list[j]);
    }
  }
  return out;
}
function findLocalLyricFile(audioFile, maps) {
  var candidates = findLocalLyricCandidates(audioFile, maps);
  return candidates.length ? candidates[0] : null;
}
/**
 * 构建本地封面文件索引。大文件夹导入时避免 filter/forEach 链式中间数组，降低导入前主线程分配。
 * @param {FileList|Array<object>} files 导入文件集合。
 * @returns {{byPath: object, byBase: object, byLoose: object, byDirNamed: object}} 封面匹配索引。
 */
function buildLocalCoverMaps(files) {
  var maps = { byPath: {}, byBase: {}, byLoose: {}, byDirNamed: {} };
  var length = Number(files && files.length) || 0;
  var coverFiles = [];
  for (var i = 0; i < length; i++) {
    var candidate = files[i];
    if (isLocalCoverFile(candidate)) coverFiles.push(candidate);
  }
  coverFiles.sort(compareLocalFilePath);
  for (var j = 0; j < coverFiles.length; j++) {
    var file = coverFiles[j];
    var pathKey = localPathStem(file);
    var baseKey = localBaseStem(file);
    var looseKey = normalizeLocalAssetName(localFileBaseName(file));
    var dirKey = localPathDir(file).toLowerCase();
    if (pathKey && !maps.byPath[pathKey]) maps.byPath[pathKey] = file;
    if (baseKey && !maps.byBase[baseKey]) maps.byBase[baseKey] = file;
    if (looseKey && !maps.byLoose[looseKey]) maps.byLoose[looseKey] = file;
    if (LOCAL_COVER_NAME_RE.test(localFileBaseName(file)) && !maps.byDirNamed[dirKey]) maps.byDirNamed[dirKey] = file;
  }
  return maps;
}
function findLocalCoverFile(audioFile, maps) {
  maps = maps || {};
  var pathKey = localPathStem(audioFile);
  var baseKey = localBaseStem(audioFile);
  var looseKey = normalizeLocalAssetName(localFileBaseName(audioFile));
  var dirKey = localPathDir(audioFile).toLowerCase();
  return (maps.byPath && maps.byPath[pathKey]) ||
    (maps.byBase && maps.byBase[baseKey]) ||
    (maps.byLoose && maps.byLoose[looseKey]) ||
    (maps.byDirNamed && maps.byDirNamed[dirKey]) ||
    null;
}
function localTrackInfoFromFile(file) {
  var title = localFileBaseName(file) || '本地音乐';
  var artist = '';
  var match = title.match(/^\s*(.+?)\s+-\s+(.+?)\s*$/);
  if (match) {
    artist = match[1].trim() || artist;
    title = match[2].trim() || title;
  }
  return { title: title, artist: artist };
}
function localSongKeyFromFile(file) {
  return (localFullPath(file) || localFilePath(file) || (file && file.name) || 'local') + ':' +
    (file && file.size || 0) + ':' +
    (file && file.lastModified || 0);
}
function makeLocalSongFromFile(file, lyricFile, coverFile, lyricCandidates) {
  var info = localTrackInfoFromFile(file);
  var candidates = Array.isArray(lyricCandidates) ? lyricCandidates : [];
  var song = hydrateCustomCover({
    type: 'local',
    name: info.title,
    artist: info.artist,
    localKey: localSongKeyFromFile(file),
    localPath: localFilePath(file),
    localFilePathAbsolute: localFullPath(file),
    localFileSize: localFileSize(file),
    localFileLastModified: localFileLastModified(file),
    localLibraryPathKey: localLibraryPathKeyFromFile(file),
    localLibraryFileSignature: localLibraryFileSignatureFromFile(file),
    localFormat: localAudioFormatLabel({ type:'local', localFile:file, localPath:localFilePath(file), name:info.title }),
    localFileUrl: localFileUrlFromEntry(file),
    localFile: file,
    localUrl: '',
    localLyricFile: lyricFile || null,
    localLyricFileName: lyricFile ? (lyricFile.name || '') : '',
    localLyricCandidates: candidates.length > 1 ? candidates.slice() : [],
    localLyricTagName: '',
    localLyricText: '',
    localLyricLoaded: false,
    localLyricLightScanned: false,
    localCoverFile: coverFile || null,
    localCoverFileName: coverFile ? (coverFile.name || '') : '',
    localCoverDataUrl: '',
    localCoverLoaded: false,
    localCoverLightScanned: false,
    localMetadataLoaded: false,
    duration: 0
  });
  return applyStoredLocalLyricPick(song);
}
/**
 * 读取同名多歌词的手动选择记录。
 * @returns {object} 歌曲键到歌词文件标识的映射。
 */
function readLocalLyricPicks() {
  try { return JSON.parse(localStorage.getItem(LOCAL_LYRIC_PICK_STORE_KEY) || '{}') || {}; }
  catch (e) { return {}; }
}
/**
 * 惰性载入同名多歌词选择记录。
 * @returns {object} 选择记录映射。
 */
function ensureLocalLyricPicks() {
  if (!localLyricPicksHydrated) {
    localLyricPicks = readLocalLyricPicks();
    localLyricPicksHydrated = true;
  }
  return localLyricPicks;
}
/**
 * 生成歌词候选的稳定标识。用相对路径而不是对象引用，重新导入同一文件夹后记录依然对得上。
 * @param {object} file 歌词文件。
 * @returns {string} 歌词候选标识。
 */
function localLyricPickId(file) {
  return file ? localFilePath(file).toLowerCase() : '';
}
/**
 * 读取某首歌记住的歌词候选标识。
 * @param {object} song 本地歌曲。
 * @returns {string} 歌词候选标识；没有记录时返回空串。
 */
function localLyricPickForSong(song) {
  var key = songCustomLyricKey(song);
  if (!key) return '';
  var picks = ensureLocalLyricPicks();
  return String(picks[key] || '');
}
/**
 * 按用户此前的同名歌词选择改写歌曲要读的歌词文件。没有记录或记录已失效时保留自动匹配结果。
 * @param {object} song 本地歌曲。
 * @returns {object} 同一首歌曲对象。
 */
function applyStoredLocalLyricPick(song) {
  var candidates = song && song.localLyricCandidates;
  if (!candidates || candidates.length < 2) return song;
  var picked = localLyricPickForSong(song);
  if (!picked) return song;
  for (var i = 0; i < candidates.length; i++) {
    if (localLyricPickId(candidates[i]) !== picked) continue;
    song.localLyricFile = candidates[i];
    song.localLyricFileName = candidates[i].name || '';
    return song;
  }
  return song;
}
/**
 * 将导入文件转换为本地歌曲列表。筛选、排序和构造拆成显式循环，减少大曲库导入时的临时数组。
 * @param {FileList|Array<object>} files 导入文件集合。
 * @param {{folderOnly?: boolean}} opts 导入选项。
 * @returns {Array<object>} 本地歌曲对象列表。
 */
function createLocalSongsFromFiles(files, opts) {
  opts = opts || {};
  var list = fileListToArray(files);
  var lyricMaps = buildLocalLyricMaps(list);
  var coverMaps = buildLocalCoverMaps(list);
  var folderOnly = !!opts.folderOnly;
  var audioFiles = [];
  for (var i = 0; i < list.length; i++) {
    if (isLocalAudioFile(list[i], folderOnly)) audioFiles.push(list[i]);
  }
  audioFiles.sort(compareLocalFilePath);
  var songs = new Array(audioFiles.length);
  for (var j = 0; j < audioFiles.length; j++) {
    var file = audioFiles[j];
    var lyricCandidates = findLocalLyricCandidates(file, lyricMaps);
    songs[j] = makeLocalSongFromFile(file, lyricCandidates[0] || null, findLocalCoverFile(file, coverMaps), lyricCandidates);
  }
  return songs;
}
/**
 * 统计解码替换字符数量。文本解码回退判断只需要计数，不需要正则 match 生成数组。
 * @param {string} text 已解码文本。
 * @returns {number} U+FFFD 替换字符数量。
 */
function countTextReplacementChars(text) {
  text = String(text || '');
  var count = 0;
  for (var i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0xfffd) count++;
  }
  return count;
}
/**
 * 解码本地歌词或文本文件。先认 BOM，再嗅无 BOM 的 UTF-16，然后严格校验 UTF-8；
 * 只有确认不是合法 UTF-8 才去试各家单双字节编码，并复用 TextDecoder 缓存。
 * @param {ArrayBuffer|Uint8Array} buffer 本地文本字节。
 * @returns {string} 解码后的文本。
 */
function decodeLocalTextBuffer(buffer) {
  var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || []);
  var bom = localTextBomEncoding(bytes);
  var utf16 = bom ? '' : sniffBomlessUtf16Encoding(bytes);
  var decoder = localTextDecoder(bom || utf16 || 'utf-8');
  var text = decoder.decode(bytes).replace(/^\uFEFF/, '');
  // BOM 或 UTF-16 已经定论，严格校验通过的 UTF-8 也不用再猜。以前只要冒出一个替换字符
  // 就整篇改判 gb18030，一个坏字节足以把整首 UTF-8 歌词译成乱码。
  if (bom || utf16 || isStrictUtf8Bytes(bytes) || !window.TextDecoder) return text;
  var best = text;
  var bestScore = countTextReplacementChars(text) + countTextGarbageChars(text);
  // gb18030 排最前：它几乎不报错，所以同分时按简体中文优先，这也是本地歌词最常见的落盘编码。
  var candidates = ['gb18030', 'big5', 'shift_jis', 'euc-kr', 'windows-1252'];
  for (var i = 0; i < candidates.length && bestScore; i++) {
    try {
      var candidate = stripTextBom(localTextDecoder(candidates[i]).decode(bytes));
      var score = countTextReplacementChars(candidate) + countTextGarbageChars(candidate);
      if (score < bestScore) {
        best = candidate;
        bestScore = score;
      }
    } catch (e) {}
  }
  return best;
}
/**
 * 去掉解码结果开头的 BOM 字符。
 * @param {string} text 已解码文本。
 * @returns {string} 去掉 BOM 的文本。
 */
function stripTextBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
/**
 * 按 BOM 判定编码。
 * @param {Uint8Array} bytes 文本字节。
 * @returns {string} 编码名；没有 BOM 时返回空串。
 */
function localTextBomEncoding(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  return '';
}
/**
 * 嗅探没有 BOM 的 UTF-16。歌词里时间标签是 ASCII，UTF-16 下每个 ASCII 字符都带一个 0 字节，
 * 而且固定落在同一侧；单双字节编码的文本几乎不含 0 字节，两者靠这一点就能分开。
 * @param {Uint8Array} bytes 文本字节。
 * @returns {string} 'utf-16le'、'utf-16be' 或空串。
 */
function sniffBomlessUtf16Encoding(bytes) {
  var limit = bytes.length < 1024 ? bytes.length : 1024;
  if (limit < 8) return '';
  var evenZero = 0;
  var oddZero = 0;
  var pairs = 0;
  for (var i = 0; i + 1 < limit; i += 2) {
    pairs++;
    if (bytes[i] === 0) evenZero++;
    if (bytes[i + 1] === 0) oddZero++;
  }
  if (!pairs) return '';
  if (oddZero > evenZero * 8 && oddZero * 10 >= pairs * 3) return 'utf-16le';
  if (evenZero > oddZero * 8 && evenZero * 10 >= pairs * 3) return 'utf-16be';
  return '';
}
/**
 * 严格校验字节序列是否为合法 UTF-8：拒收过长编码、代理区码位与越界码位。
 * 末尾被截断的多字节序列不算错，前面全合法就仍按 UTF-8 处理。
 * @param {Uint8Array} bytes 文本字节。
 * @returns {boolean} 是否合法 UTF-8。
 */
function isStrictUtf8Bytes(bytes) {
  var len = bytes.length;
  var i = 0;
  while (i < len) {
    var lead = bytes[i];
    if (lead < 0x80) { i++; continue; }
    var need;
    var cp;
    if (lead >= 0xc2 && lead <= 0xdf) { need = 1; cp = lead & 0x1f; }
    else if (lead >= 0xe0 && lead <= 0xef) { need = 2; cp = lead & 0x0f; }
    else if (lead >= 0xf0 && lead <= 0xf4) { need = 3; cp = lead & 0x07; }
    else return false;
    if (i + need >= len) return true;
    for (var k = 1; k <= need; k++) {
      var next = bytes[i + k];
      if (next < 0x80 || next > 0xbf) return false;
      cp = (cp << 6) | (next & 0x3f);
    }
    if (need === 2 && (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff))) return false;
    if (need === 3 && (cp < 0x10000 || cp > 0x10ffff)) return false;
    i += need + 1;
  }
  return true;
}
/**
 * 统计明显是乱码的字符：C1 控制字符与私用区码位。歌词正文里这两类一个都不该出现，
 * 用来在替换字符数打平时区分几种候选编码。
 * @param {string} text 已解码文本。
 * @returns {number} 可疑字符数量。
 */
function countTextGarbageChars(text) {
  var count = 0;
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i);
    if ((code >= 0x80 && code <= 0x9f) || (code >= 0xe000 && code <= 0xf8ff)) count++;
  }
  return count;
}

// ── 传递依赖补入：localAudioFormatLabel ─────────────────────────────────────
// makeLocalSongFromFile 需要它，但参照库把它定义在远处（app.js L22800），不在 block2 切片内。
// 自洽（仅依赖本文件 localFilePath），1:1 照搬，避免 block2 缺一个哑依赖在拼接运行时才炸。
function localAudioFormatLabel(song) {
  if (!song || song.type !== 'local') return '';
  var file = song.localFile || null;
  var path = String(song.localPath || song.localFilePathAbsolute || localFilePath(file) || song.name || '');
  var m = path.match(/\.([a-z0-9]+)(?:$|[?#])/i);
  var ext = m ? m[1].toLowerCase() : '';
  if (ext === 'flac') return 'FLAC';
  if (ext === 'mp3') return 'MP3';
  if (ext === 'wav') return 'WAV';
  if (ext === 'm4a') return 'M4A';
  if (ext === 'ogg' || ext === 'oga') return 'OGG';
  return ext ? ext.toUpperCase() : 'LOCAL';
}

// ── 格式能力判定（传递依赖补入：参照 app.js L28558-28594）────────────────────
// makeLocalSongFromFile 的编排 + companion 测试 local-format-tag-parsing 需要；
// 5 个均自洽（仅依赖 localSongFormatName + 正则），1:1 照搬。
function localSongFormatName(song) {
  if (!song || !song.localFile) return '';
  return String(song.localFile.name || song.localPath || song.localFilePathAbsolute || '');
}
function canReadEmbeddedLyrics(song) {
  return /\.(mp3|flac|ogg|oga|opus|wav|ape|dsf)$/i.test(localSongFormatName(song));
}
function canReadTruncatableEmbeddedLyrics(song) {
  // MP3 歌词按完整 ID3v2 长度读取，不受轻量上限影响，失败即为真的没有歌词。
  return /\.(flac|ogg|oga|opus|wav|ape|dsf)$/i.test(localSongFormatName(song));
}
function canReadEmbeddedCover(song) {
  return /\.(mp3|flac|m4a|ogg|oga|opus|wav|ape|dsf)$/i.test(localSongFormatName(song));
}
function canReadTruncatableEmbeddedCover(song) {
  return /\.(flac|m4a|ogg|oga|opus|wav|ape|dsf)$/i.test(localSongFormatName(song));
}

// ── 音频质量/标签应用（传递依赖补入：applyLocalMetadataTags + 其 helper 簇）──────────
// C1 标签管线需要：参照 playbackMillisecondsToSeconds@32226 / localAudio*@22813-22843 / applyLocalMetadataTags@36453。
function playbackMillisecondsToSeconds(value) {
  var raw = Number(value);
  return isFinite(raw) && raw > 0 ? raw / 1000 : 0;
}

function localAudioFileBytes(song) {
  if (!song) return 0;
  return Number(song.localFileSize || song.size || (song.localFile && localFileSize(song.localFile)) || 0) || 0;
}

function localAudioDurationSeconds(song) {
  if (!song) return 0;
  var sec = Number(song.duration) || 0;
  if (!isFinite(sec) || sec <= 0) sec = 0;
  if (!sec) sec = playbackMillisecondsToSeconds(song.durationMs || song.dt || 0);
  return sec;
}

function estimateLocalAudioBitrateKbps(song) {
  if (!song || song.type !== 'local') return 0;
  var cached = Number(song.localBitrateKbps) || 0;
  if (cached > 0) return cached;
  var bytes = localAudioFileBytes(song);
  var duration = localAudioDurationSeconds(song);
  if (!bytes || !duration) return 0;
  return Math.max(1, Math.round(bytes * 8 / duration / 1000));
}

function updateLocalAudioQualityInfo(song) {
  if (!song || song.type !== 'local') return;
  song.localFormat = localAudioFormatLabel(song);
  song.localFileSize = localAudioFileBytes(song);
  var kbps = estimateLocalAudioBitrateKbps(song);
  if (kbps) song.localBitrateKbps = kbps;
}

function applyLocalMetadataTags(song, tags) {
  if (!song || !tags) return false;
  var changed = false;
  if (tags.title && !isLocalSourcePlaceholderMetadata(tags.title) && song.name !== tags.title) { song.name = tags.title; changed = true; }
  if (tags.artist && !isLocalSourcePlaceholderMetadata(tags.artist) && song.artist !== tags.artist) { song.artist = tags.artist; changed = true; }
  if (tags.album && !isLocalSourcePlaceholderMetadata(tags.album) && song.album !== tags.album) { song.album = tags.album; changed = true; }
  if (tags.albumArtist && !isLocalSourcePlaceholderMetadata(tags.albumArtist) && song.albumArtist !== tags.albumArtist) { song.albumArtist = tags.albumArtist; changed = true; }
  if (tags.track && song.trackNumber !== tags.track) { song.trackNumber = tags.track; changed = true; }
  if (tags.genre && !isLocalSourcePlaceholderMetadata(tags.genre) && song.genre !== tags.genre) { song.genre = tags.genre; changed = true; }
  if (tags.year && song.year !== tags.year) { song.year = tags.year; changed = true; }
  // 头部推导出的时长只在缺省时补齐：真实播放测得的时长更可信。
  if (tags.duration > 0 && !(song.duration > 0)) { song.duration = tags.duration; changed = true; }
  // ReplayGain 不参与展示，不计入 changed，避免为音量数据触发列表重绘。
  if (tags.replayGain && typeof tags.replayGain === 'object' && !song.localReplayGain) song.localReplayGain = tags.replayGain;
  updateLocalAudioQualityInfo(song);
  return changed;
}

