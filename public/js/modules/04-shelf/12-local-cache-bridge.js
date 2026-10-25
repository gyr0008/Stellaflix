// ============================================================================
// 04-shelf/12-local-cache-bridge.js
// 批3-A：本地曲库「资产/歌词缓存」纯原语（block3 可独立落地部分）——1:1 移植自参照库
//   Mineradio-2.5.1 public/app.js。仅门牌号/品牌口径，零功能裁剪。
// ⚠️ 范围：参照 block3（L8326-9730）是引擎胶水——IDB 回落层不搬（用 SQLite）；
//   SQLite 桥已在我方 05-playback/20-local-library-db-bridge.js；缓存编排/封面缩略图/持久内存水合
//   缠未接线引擎态 + 浏览器 DOM，推迟到批4。本文件只落地自洽可单测的纯原语（计算地基）。
// 来源行：localAssetCacheKey@8376 / TextDigest@8864 / IndexDigest@8878 / resetDigests@8895 /
//   CoverThumbCacheKey@9032 / estimateDataUrlBytes@9041 / estimateTextBytes@9047 /
//   estimateLocalAssetRecordBytes@9052 / estimateLocalLyricRecordBytes@9066 / 状态@1865-1866。
// ============================================================================
// 索引行摘要表 + 代次（resetLocalLibraryDbIndexDigests 用；参照 L1865-1866）。
var localLibraryDbIndexDigests = {};
var localLibraryDbIndexDigestGeneration = 0;

function localAssetCacheKey(song) {
  return song && song.localKey ? String(song.localKey) : '';
}

function localLibraryDbTextDigest(text) {
  var str = String(text || '');
  var hash = 0x811c9dc5;
  for (var i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash.toString(16);
}

function localLibraryDbIndexDigest(record) {
  if (!record) return '';
  return localLibraryDbTextDigest([
    record.fileSignature || '', record.pathKey || '', record.size || 0, record.mtime || 0,
    record.name || '', record.artist || '', record.album || '', record.albumArtist || '',
    record.genre || '', record.year || '', record.trackNumber || '', record.duration || 0,
    record.localFormat || '', record.localBitrateKbps || 0,
    record.localMetadataLoaded ? 1 : 0, record.localMetadataTagSchema || 0,
    record.lyricStatus || '', record.lyricSource || '', record.lyricFileName || '', record.lyricTagName || '', record.lyricFileSignature || '',
    record.coverStatus || '', record.coverSource || '', record.coverFileName || '', record.coverFileSignature || '',
  ].join(''));
}

function resetLocalLibraryDbIndexDigests(generation) {
  if (localLibraryDbIndexDigestGeneration === generation) return;
  localLibraryDbIndexDigestGeneration = generation;
  localLibraryDbIndexDigests = {};
}

function localCoverThumbCacheKey(dataUrl) {
  dataUrl = String(dataUrl || '');
  var hash = 2166136261;
  for (var i = 0; i < dataUrl.length; i++) {
    hash ^= dataUrl.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36) + ':' + dataUrl.length + ':' + dataUrl.slice(5, 30);
}

function estimateDataUrlBytes(dataUrl) {
  dataUrl = String(dataUrl || '');
  var comma = dataUrl.indexOf(',');
  var bodyLength = comma >= 0 ? dataUrl.length - comma - 1 : dataUrl.length;
  return Math.max(0, Math.round(bodyLength * 0.75));
}

function estimateTextBytes(text) {
  text = String(text || '');
  if (!text) return 0;
  return text.length * 2;
}

function estimateLocalAssetRecordBytes(record) {
  if (!record) return 0;
  return 256
    + estimateTextBytes(record.name)
    + estimateTextBytes(record.artist)
    + estimateTextBytes(record.album)
    + estimateDataUrlBytes(record.localCoverThumbDataUrl)
    + estimateDataUrlBytes(record.localCoverDataUrl);
}

function estimateLocalLyricRecordBytes(record) {
  if (!record) return 0;
  return 128
    + estimateTextBytes(record.localLyricText)
    + estimateTextBytes(record.localLyricFileName)
    + estimateTextBytes(record.localLyricTagName)
    + estimateTextBytes(record.localLyricFileSignature)
    + estimateTextBytes(record.localLyricSource);
}
