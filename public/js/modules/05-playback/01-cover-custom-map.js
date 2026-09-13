function isTypingTarget(target) {
  if (!target) return false;
  var tag = String(target.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!(target.isContentEditable || (target.closest && target.closest('[contenteditable="true"]')));
}

/* ──────────────────────────────────────────────────────────
   Custom Cover — 存储架构（v2）
   
   三层存储：
   1. IndexedDB (stellaflix-custom-covers-blob)  → Blob 二进制原图
   2. localStorage (stellaflix-custom-covers)    → 轻量索引 {__ref,ts} 或旧格式 dataURL
   3. 内存 _coverDataUrlCache                    → key→dataUrl 热缓存（同步读取）
   
   读写路径：
   - 写入：IDB(异步) + localStorage索引(同步) + 内存缓存(同步)
   - 读取（同步）：song.customCover → _coverDataUrlCache → customCoverMap[]
   - 删除：IDB(异步) + localStorage(同步) + 内存缓存(同步) + playlistCoverCache
   - 启动：读 localStorage 索引 → 异步预热 _coverDataUrlCache（从 IDB 还原）
   - 迁移：首次启动检测旧格式(dataURL)，批量转存 IDB 后替换为引用
   ────────────────────────────────────────────────────────── */

// ===== localStorage 索引层 =====

function readCustomCoverMap() {
  try {
    var raw = localStorage.getItem(CUSTOM_COVER_STORE_KEY);
    var parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}
function saveCustomCoverMap() {
  try {
    localStorage.setItem(CUSTOM_COVER_STORE_KEY, JSON.stringify(customCoverMap || {}));
    return true;
  } catch (e) {
    console.warn('custom cover save failed:', e);
    return false;
  }
}

// ===== IndexedDB Blob 存储层 =====

var CUSTOM_COVER_IDB_NAME = 'stellaflix-custom-covers-blob';
var CUSTOM_COVER_IDB_STORE = 'covers';
var CUSTOM_COVER_IDB_VERSION = 1;

// 全局自定义封面 key：所有歌曲共用同一张用户上传的图
var GLOBAL_CUSTOM_COVER_KEY = '__global__';

var _coverIdbPromise = null;
function _openCoverIdb() {
  if (_coverIdbPromise) return _coverIdbPromise;
  _coverIdbPromise = new Promise(function (resolve, reject) {
    try {
      var DB = window.indexedDB || window.webkitIndexedDB || window.mozIndexedDB || window.msIndexedDB;
      if (!DB) { _coverIdbPromise = null; reject(new Error('INDEXEDDB_NOT_AVAILABLE')); return; }
      var req = DB.open(CUSTOM_COVER_IDB_NAME, CUSTOM_COVER_IDB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(CUSTOM_COVER_IDB_STORE)) {
          db.createObjectStore(CUSTOM_COVER_IDB_STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { _coverIdbPromise = null; reject(req.error || new Error('COVER_IDB_OPEN_FAILED')); };
      req.onblocked = function () { _coverIdbPromise = null; reject(new Error('COVER_IDB_BLOCKED')); };
    } catch (e) { _coverIdbPromise = null; reject(e); }
  });
  // 当 open 失败时允许重试
  _coverIdbPromise.catch(function () { _coverIdbPromise = null; });
  return _coverIdbPromise;
}

function coverIdbPut(key, blob) {
  if (!key) return Promise.reject(new Error('coverIdbPut: empty key'));
  return _openCoverIdb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(CUSTOM_COVER_IDB_STORE, 'readwrite');
      tx.objectStore(CUSTOM_COVER_IDB_STORE).put({ key: String(key), blob: blob, ts: Date.now() });
      tx.oncomplete = function () { resolve(true); };
      tx.onerror = function () { reject(tx.error || new Error('COVER_IDB_PUT_FAILED')); };
      tx.onabort = function () { reject(tx.error || new Error('COVER_IDB_PUT_ABORTED')); };
    });
  });
}
function coverIdbGet(key) {
  if (!key) return Promise.resolve(null);
  return _openCoverIdb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(CUSTOM_COVER_IDB_STORE, 'readonly');
      var req = tx.objectStore(CUSTOM_COVER_IDB_STORE).get(String(key));
      req.onsuccess = function () { resolve(req.result || null); };
      req.onerror = function () { reject(tx.error || new Error('COVER_IDB_GET_FAILED')); };
    });
  }).catch(function (err) {
    console.warn('[CustomCover] IDB get error:', err);
    return null;
  });
}
function coverIdbDelete(key) {
  if (!key) return Promise.resolve();
  return _openCoverIdb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(CUSTOM_COVER_IDB_STORE, 'readwrite');
      tx.objectStore(CUSTOM_COVER_IDB_STORE).delete(String(key));
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error || new Error('COVER_IDB_DELETE_FAILED')); };
      tx.onabort = function () { reject(tx.error || new Error('COVER_IDB_DELETE_ABORTED')); };
    });
  }).catch(function (err) {
    console.warn('[CustomCover] IDB delete error:', err);
  });
}

// ===== dataURL ↔ Blob 转换 =====

function _isDataUrl(value) {
  return typeof value === 'string' && /^data:image\//i.test(value);
}
function _isCoverRef(value) {
  return value && typeof value === 'object' && value.__ref === true;
}
function dataUrlToBlob(dataUrl) {
  try {
    var parts = dataUrl.split(',');
    var mimeMatch = parts[0].match(/:(.*?);/);
    if (!mimeMatch) return null;
    var mime = mimeMatch[1];
    var bstr = atob(parts[1]);
    var n = bstr.length;
    var u8arr = new Uint8Array(n);
    while (n--) u8arr[n] = bstr.charCodeAt(n);
    return new Blob([u8arr], { type: mime });
  } catch (e) {
    return null;
  }
}
function blobToDataUrl(blob) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () { resolve(reader.result); };
    reader.onerror = function () { reject(reader.error); };
    reader.readAsDataURL(blob);
  });
}

// ===== 内存热缓存（同步读取用） =====

var _coverDataUrlCache = {};

// ===== 核心 API =====

function isInlineCoverSrc(src) {
  return typeof src === 'string' && (
    /^data:image\//i.test(src) ||
    /^blob:/i.test(src) ||
    /^stellaflix-local:\/\/cover\//i.test(src)
  );
}
function isProxyableCoverUrl(url) {
  return /^https?:\/\//i.test(String(url || ''));
}
function coverProxySrc(url, cacheBust) {
  if (!url) return '';
  if (isInlineCoverSrc(url)) return url;
  if (!isProxyableCoverUrl(url)) return '';
  return '/api/cover?url=' + encodeURIComponent(url) + (cacheBust ? '&v=' + Date.now() : '');
}
function coverUrlWithSize(url, size) {
  if (!url || isInlineCoverSrc(url) || !/^https?:\/\//i.test(url)) return url || '';
  if (!size) return url;
  var param = 'param=' + size + 'y' + size;
  if (/[?&]param=\d+y\d+/i.test(url)) return url.replace(/([?&])param=\d+y\d+/i, '$1' + param);
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + param + '';
}
function songCustomCoverKey(song) {
  if (!song) return '';
  if (song.customCoverKey) return String(song.customCoverKey);
  if (song.provider === 'qq' || song.source === 'qq' || song.type === 'qq') return 'qq:' + (song.mid || song.songmid || song.id || (song.name + '|' + song.artist));
  if (song.provider === 'qishui' || song.source === 'qishui' || song.type === 'qishui') return 'qishui:' + (song.id || song.providerSongId || (song.name + '|' + song.artist));
  if (song.provider === 'kugou' || song.source === 'kugou' || song.type === 'kugou' || song.hash || song.audioHash) return 'kugou:' + (song.hash || song.fileHash || song.audioHash || song.id || (song.name + '|' + song.artist));
  if (song.localKey) return 'local:' + song.localKey;
  if (song.type === 'podcast' && song.programId) return 'podcast:' + song.programId;
  if (song.id != null && song.id !== '') return 'id:' + song.id;
  var title = String(song.name || song.title || '').trim();
  var artist = String(song.artist || '').trim();
  return (title || artist) ? ('meta:' + (title + '|' + artist).slice(0, 220)) : '';
}

/**
 * 同步获取全局自定义封面 dataURL（所有歌曲共用）。
 * 优先级：_coverDataUrlCache[全局key] → customCoverMap[全局key]（旧格式 dataURL）
 * @returns {string} dataURL 或空字符串
 */
function getGlobalCustomCover() {
  if (_coverDataUrlCache[GLOBAL_CUSTOM_COVER_KEY]) return _coverDataUrlCache[GLOBAL_CUSTOM_COVER_KEY];
  var entry = customCoverMap[GLOBAL_CUSTOM_COVER_KEY];
  if (entry && _isDataUrl(entry)) return entry;
  return '';
}

/**
 * 同步获取歌曲的自定义封面 dataURL。
 * 优先级（高→低）：
 *   1. song.customCover（内存，按歌曲）
 *   2. _coverDataUrlCache[按歌曲key]（热缓存）
 *   3. customCoverMap[按歌曲key]（索引：旧 dataURL / IDB 引用）
 *   4. 全局自定义封面（用户上传的一张图，所有歌曲共用）
 *   5. 音乐自身封面（song.cover，由 songCoverSrc 兜底）
 *
 * 注意：若封面已迁移至 IDB 格式但缓存尚未预热，本次返回空字符串；
 *       调用方（如播放器）应结合异步回填逻辑重新求值。
 */
function getCustomCoverForSong(song) {
  if (!song) return getGlobalCustomCover();
  // 1. 歌曲对象上已挂载的内存值（最高优先，按歌曲级由 set/hydrate 写入）
  if (song.customCover && _isDataUrl(song.customCover)) return song.customCover;
  var key = songCustomCoverKey(song);
  if (key) {
    // 2. 内存热缓存（按歌曲 key）
    if (_coverDataUrlCache[key]) return _coverDataUrlCache[key];
    // 3. localStorage 索引
    var entry = customCoverMap[key];
    if (entry && _isDataUrl(entry)) return entry;
    // 3b. IDB 引用格式且缓存未命中 → 跳过，继续查全局
  }
  // 4. 全局自定义封面（所有歌曲共用同一张图）
  return getGlobalCustomCover();
}
function hydrateCustomCover(song) {
  if (!song) return song;
  var custom = getCustomCoverForSong(song);
  if (custom) song.customCover = custom;
  return song;
}
function songCoverSrc(song, size) {
  var custom = getCustomCoverForSong(song);
  if (custom) return custom;
  return song && song.cover ? coverUrlWithSize(song.cover, size) : '';
}

/**
 * 将自定义封面持久化写入（IDB + localStorage 索引 + 内存缓存）。
 * @param {string} key - songCustomCoverKey 的返回值
 * @param {string} dataUrl - base64 dataURL
 * @returns {Promise<boolean>} 是否成功写入 IDB（localStorage/内存始终同步写入）
 */
function saveCustomCoverBlob(key, dataUrl) {
  if (!key || !dataUrl) return Promise.resolve(false);

  // 1. 同步：立即更新内存缓存和歌曲对象（确保后续同步读取命中）
  _coverDataUrlCache[key] = dataUrl;

  // 2. 同步：更新 localStorage 索引为引用格式
  var blob = dataUrlToBlob(dataUrl);
  if (blob) {
    customCoverMap[key] = { __ref: true, ts: Date.now(), size: blob.size };
  } else {
    // Blob 创建失败时回退到旧格式（兼容模式）
    customCoverMap[key] = dataUrl;
  }
  saveCustomCoverMap();

  // 3. 异步：写入 IDB Blob 存储
  if (blob) {
    return coverIdbPut(key, blob).then(function () {
      return true;
    }).catch(function (err) {
      console.warn('[CustomCover] IDB write failed, keeping localStorage fallback:', err);
      // IDB 写入失败时回退：将 dataURL 直接存入 localStorage
      customCoverMap[key] = dataUrl;
      saveCustomCoverMap();
      return false; // IDB 层失败但 localStorage 兜底成功
    });
  }
  return Promise.resolve(false);
}

/**
 * 设置全局自定义封面（所有歌曲共用同一张用户上传的图）。
 * 存储结构与按歌曲封面一致：IDB Blob + localStorage 索引 + 内存热缓存。
 * @param {string} dataUrl - base64 dataURL
 * @returns {Promise<boolean>}
 */
function saveGlobalCustomCover(dataUrl) {
  if (!dataUrl) return Promise.resolve(false);

  // 1. 同步：立即更新内存热缓存（全局 key）
  _coverDataUrlCache[GLOBAL_CUSTOM_COVER_KEY] = dataUrl;

  // 2. 同步：更新 localStorage 索引为引用格式
  var blob = dataUrlToBlob(dataUrl);
  if (blob) {
    customCoverMap[GLOBAL_CUSTOM_COVER_KEY] = { __ref: true, ts: Date.now(), size: blob.size };
  } else {
    customCoverMap[GLOBAL_CUSTOM_COVER_KEY] = dataUrl; // Blob 创建失败回退旧格式
  }
  saveCustomCoverMap();

  // 3. 异步：写入 IDB Blob 存储
  if (blob) {
    return coverIdbPut(GLOBAL_CUSTOM_COVER_KEY, blob).then(function () {
      return true;
    }).catch(function (err) {
      console.warn('[CustomCover] IDB global write failed, keeping localStorage fallback:', err);
      customCoverMap[GLOBAL_CUSTOM_COVER_KEY] = dataUrl;
      saveCustomCoverMap();
      return false;
    });
  }
  return Promise.resolve(false);
}

/**
 * 完全删除一首歌的自定义封面（IDB + localStorage + 内存缓存）。
 * @param {string} key - songCustomCoverKey 的返回值
 * @returns {Promise<void>}
 */
function deleteCustomCoverFully(key) {
  if (!key) return Promise.resolve();

  // 1. 同步：清内存缓存
  delete _coverDataUrlCache[key];

  // 2. 同步：清 localStorage 索引
  if (customCoverMap[key]) {
    delete customCoverMap[key];
    saveCustomCoverMap();
  }

  // 3. 异步：清 IDB Blob
  return coverIdbDelete(key);
}

/**
 * 清除全局自定义封面（所有歌曲恢复音乐自身封面）。
 * @returns {Promise<void>}
 */
function deleteGlobalCustomCover() {
  // 1. 同步：清内存热缓存
  delete _coverDataUrlCache[GLOBAL_CUSTOM_COVER_KEY];

  // 2. 同步：清 localStorage 索引
  if (customCoverMap[GLOBAL_CUSTOM_COVER_KEY]) {
    delete customCoverMap[GLOBAL_CUSTOM_COVER_KEY];
    saveCustomCoverMap();
  }

  // 3. 异步：清 IDB Blob
  return coverIdbDelete(GLOBAL_CUSTOM_COVER_KEY);
}

/**
 * 启动时调用：将 localStorage 中的旧格式 dataURL 批量迁移到 IDB，
 * 并预热 _coverDataUrlCache 以保证同步读取可用。
 * @returns {Promise<number>} 迁移成功的条数
 */
function warmCustomCoverCache() {
  // ==== Fix: 初始化前置守卫（即使 warmCustomCoverCache 被过早调用也不炸启动）。
  // 本模块与 00-core-stores.js 不在同一个加载位置，若 JS function 提升导致
  // 本函数在 cover-custom-map.js 文本初始化前被调用，以下变量仍为 undefined：
  //   CUSTOM_COVER_STORE_KEY / GLOBAL_CUSTOM_COVER_KEY /
  //   _coverDataUrlCache / customCoverMap / coverIdbGet / _isDataUrl。
  // 直接 return 0 不报错，外层 setTimeout(0) 会在下一轮事件循环重新调用到时这些
  // 值都已经初始化完成，即可正常跑。
  var _ready = true;
  try {
    if (typeof CUSTOM_COVER_STORE_KEY === 'undefined' || !CUSTOM_COVER_STORE_KEY) _ready = false;
    if (typeof GLOBAL_CUSTOM_COVER_KEY === 'undefined') _ready = false;
    if (typeof _coverDataUrlCache === 'undefined' || _coverDataUrlCache == null) _ready = false;
    if (typeof customCoverMap === 'undefined' || !customCoverMap || typeof customCoverMap !== 'object') _ready = false;
    if (typeof coverIdbGet !== 'function') _ready = false;
    if (typeof _isDataUrl !== 'function') _ready = false;
    if (typeof _isCoverRef !== 'function') _ready = false;
  } catch (_e) { _ready = false; }
  if (!_ready) {
    try { console.warn('[CustomCover] warmCustomCoverCache called before deps ready; skipped (will retry on next tick if scheduled)'); } catch (e) {}
    return Promise.resolve(0);
  }
  var keys = Object.keys(customCoverMap);
  var legacyKeys = [];
  for (var i = 0; i < keys.length; i++) {
    if (_isDataUrl(customCoverMap[keys[i]])) {
      legacyKeys.push(keys[i]);
    }
  }
  if (!legacyKeys.length) {
    // 无旧数据需要迁移，直接从 IDB 预热新格式引用
    return _warmCacheFromIdb(keys);
  }

  // 逐条迁移旧 dataURL → IDB
  console.log('[CustomCover] Migrating ' + legacyKeys.length + ' legacy covers to IDB...');
  return legacyKeys.reduce(function (promise, key) {
    return promise.then(function (count) {
      var dataUrl = customCoverMap[key];
      var blob = dataUrlToBlob(dataUrl);
      if (!blob) {
        console.warn('[CustomCover] Cannot convert to blob, skipping:', key);
        return count;
      }
      return coverIdbPut(key, blob).then(function () {
        // 替换为引用格式
        customCoverMap[key] = { __ref: true, ts: Date.now(), size: blob.size };
        // 预热缓存
        _coverDataUrlCache[key] = dataUrl;
        return count + 1;
      }).catch(function (err) {
        console.warn('[CustomCover] Migration failed for', key, err);
        // 保留原 dataURL 在 localStorage 中（下次再试）
        return count;
      });
    });
  }, Promise.resolve(0)).then(function (migrated) {
    if (migrated > 0) {
      saveCustomCoverMap(); // 持久化更新后的索引
      console.log('[CustomCover] Migration complete: ' + migrated + '/' + legacyKeys.length + ' covers moved to IDB');
    }
    // 对所有 key（含已迁移的和本来就是引用的）确保缓存温暖
    return _warmCacheFromIdb(Object.keys(customCoverMap)).then(function (warmed) {
      return migrated;
    });
  });
}

/**
 * 内部：从 IDB 读取 blob 并填充 _coverDataUrlCache。
 */
function _warmCacheFromIdb(keys) {
  var refKeys = [];
  for (var i = 0; i < keys.length; i++) {
    if (_isCoverRef(customCoverMap[keys[i]]) && !_coverDataUrlCache[keys[i]]) {
      refKeys.push(keys[i]);
    }
  }
  if (!refKeys.length) return Promise.resolve(0);

  return refKeys.reduce(function (promise, key) {
    return promise.then(function (count) {
      return coverIdbGet(key).then(function (entry) {
        if (entry && entry.blob) {
          return blobToDataUrl(entry.blob).then(function (dataUrl) {
            _coverDataUrlCache[key] = dataUrl;
            return count + 1;
          });
        }
        return count;
      });
    });
  }, Promise.resolve(0));
}

/**
 * 获取自定义封面存储的统计信息（用于调试 / 缓存设置面板）。
 * @returns {{ count: number, totalSize: number, idbCount: number, legacyCount: number }}
 */
function getCustomCoverStats() {
  var keys = Object.keys(customCoverMap);
  var legacyCount = 0;
  var refCount = 0;
  var totalSize = 0;
  for (var i = 0; i < keys.length; i++) {
    var v = customCoverMap[keys[i]];
    if (_isDataUrl(v)) { legacyCount++; totalSize += v.length; }
    else if (_isCoverRef(v)) { refCount++; totalSize += v.size || 0; }
  }
  return { count: keys.length, totalSize: totalSize, idbCount: refCount, legacyCount: legacyCount };
}

/**
 * 清除所有自定义封面数据（IDB + localStorage + 内存）。用于"清理缓存"操作。
 * @returns {Promise<void>}
 */
function clearAllCustomCovers() {
  // 同步清内存
  _coverDataUrlCache = {};
  var keys = Object.keys(customCoverMap);
  for (var i = 0; i < keys.length; i++) {
    delete customCoverMap[keys[i]];
  }
  saveCustomCoverMap();

  // 异步清 IDB（逐条删除）
  return keys.reduce(function (promise, key) {
    return promise.then(function () { return coverIdbDelete(key); });
  }, Promise.resolve()).then(function () {
    console.log('[CustomCover] All ' + keys.length + ' covers cleared.');
  });
}

function cssImageUrl(url) {
  return String(url || '').replace(/\\/g, '\\\\').replace(/"/g, '%22');
}
function setHomeArt(id, url, size) {
  var el = document.getElementById(id);
  if (!el) return;
  var src = url ? coverUrlWithSize(url, size || 260) : '';
  el.style.backgroundImage = src ? 'url("' + cssImageUrl(src) + '")' : '';
  el.classList.toggle('has-cover', !!src);
  el.classList.toggle('home-skeleton', !src && homeDiscoverState.loading);
}
function compactHomeCount(n) {
  n = Number(n) || 0;
  if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
  if (n >= 10000) return Math.round(n / 10000) + '万';
  return n ? String(n) : '';
}
