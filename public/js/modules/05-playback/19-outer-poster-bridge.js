/*
 * T-双态独立海报：音乐态 / 影视态 外层海报 Video 级独立存储 Bridge
 *
 * 目标：让外层海报（#home-poster-media 的大背景图 / 视频）也能在音乐态和影视态独立设置，
 *       并且两种态都支持图片 OR 视频作为背景。
 *
 * 存储结构（与 public/video/home.js 共用同一 IndexedDB 数据库，保证两种态读写同一份键空间）：
 *   DB:      'stellaflix-outer-poster-media-v1'
 *   Store:   'media'  (with keyPath = 'id')
 *   Keys:    'outer-music'  → 音乐态外层海报的大媒体 (image blob 或 video mp4 blob)
 *            'outer-video'  → 影视态外层海报的大媒体 (image blob 或 video mp4 blob)
 *            影视态的大媒体还由 home.js 并行管理，本文件对 'outer-video' 只读不写
 *
 * META（LS，因为都是小字段）：
 *   音乐态: 'mineradio.outer.poster.meta.music'  → { kind, blobKey, name, size, ts }
 *   影视态: 'mineradio.outer.poster.meta.video'  → 仅做只读镜像，写权威在 home.js posterStore
 *
 * 说明：
 *   音乐态原有的图片存储（'stellaflix-home-personal-poster-v1' LS key）由打包的 vendor 代码
 *   管理，本桥不改写它，而是做增量扩展：
 *     - 如果用户设置了音乐态的视频海报 → 写入本桥的 IndexedDB + meta LS
 *     - 切回音乐态并检测到 meta.kind === 'video' → 注入 VIDEO 元素覆盖原图片
 *     - 若用户重置音乐态海报 → vendor 会清空自己的 LS；本桥也需监听信号清空自己的 meta+blob
 *
 * UI：
 *   - 在音乐态 home-poster-actions chips 旁注入一个「+视频」浮动 chip（首次进入空 home 后），
 *     点击则调 desktopWindow.pickMedia('video') → saveMediaMeta + blobPut。
 *   - 影视态：使用 home-poster-render.js 的「换视频」chip（本桥不重复）。
 */
(function () {
  'use strict';

  var global = (typeof window !== 'undefined') ? window : this;
  var OUTER_MEDIA_DB = 'stellaflix-outer-poster-media-v1';
  var OUTER_MEDIA_STORE = 'media';
  var OUTER_KEY_MUSIC = 'outer-music';
  var OUTER_KEY_VIDEO = 'outer-video';
  var MUSIC_META_KEY = 'mineradio.outer.poster.meta.music';
  var VIDEO_META_KEY = 'mineradio.outer.poster.meta.video'; // 只读同步，不做主写入
  var MUSIC_OBJECT_URL = ''; // 音乐态下当前激活的 VIDEO/IMG blob URL，释放用

  // ── 工具 ──
  function _d() { return global.document; }
  function _mode() {
    try {
      var SFV = global.StellaflixVideo;
      if (SFV && SFV.state && typeof SFV.state.isVideo === 'function') {
        return SFV.state.isVideo() ? 'video' : 'music';
      }
      var body = global.document && global.document.body;
      if (body && body.classList && body.classList.contains('video-space-active')) return 'video';
    } catch (_e) { /* ignore */ }
    return 'music';
  }
  function _isMusicMode() { return _mode() === 'music'; }
  function _toast(msg) {
    if (typeof global.showToast === 'function') { try { global.showToast(msg); return; } catch (_e) { /* ignore */ } }
    try {
      var doc = _d();
      if (!doc) return;
      var t = doc.createElement('div');
      t.className = 'sfv-toast';
      t.textContent = msg;
      (doc.body || doc.documentElement).appendChild(t);
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2600);
    } catch (_e2) { /* ignore */ }
  }
  function _revokeMusicObjectUrl() {
    if (MUSIC_OBJECT_URL) {
      try { (global.URL || global.webkitURL).revokeObjectURL(MUSIC_OBJECT_URL); } catch (_e) { /* ignore */ }
    }
    MUSIC_OBJECT_URL = '';
  }

  // ── IndexedDB ──
  var _dbPromise = null;
  function _openDb() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(function (resolve, reject) {
      try {
        var DB = global.indexedDB || global.webkitIndexedDB || global.mozIndexedDB || global.msIndexedDB;
        if (!DB) return reject(new Error('INDEXEDDB_NOT_AVAILABLE'));
        var req = DB.open(OUTER_MEDIA_DB, 1);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(OUTER_MEDIA_STORE)) {
            db.createObjectStore(OUTER_MEDIA_STORE, { keyPath: 'id' });
          }
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error || new Error('OUTER_MEDIA_DB_OPEN_FAILED')); };
        req.onblocked = function () { reject(new Error('OUTER_MEDIA_DB_BLOCKED')); };
      } catch (e) { reject(e); }
    });
    return _dbPromise;
  }
  function _blobPut(key, blob, meta) {
    return _openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(OUTER_MEDIA_STORE, 'readwrite');
        tx.objectStore(OUTER_MEDIA_STORE).put({ id: String(key || ''), blob: blob, meta: meta || {} });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error || new Error('BLOB_PUT_FAILED')); };
        tx.onabort = function () { reject(tx.error || new Error('BLOB_PUT_ABORTED')); };
      });
    });
  }
  function _blobGet(key) {
    return _openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(OUTER_MEDIA_STORE, 'readonly');
        var req = tx.objectStore(OUTER_MEDIA_STORE).get(String(key || ''));
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error || new Error('BLOB_GET_FAILED')); };
      });
    });
  }
  function _blobDelete(key) {
    return _openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(OUTER_MEDIA_STORE, 'readwrite');
        tx.objectStore(OUTER_MEDIA_STORE).delete(String(key || ''));
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error || new Error('BLOB_DELETE_FAILED')); };
        tx.onabort = function () { reject(tx.error || new Error('BLOB_DELETE_ABORTED')); };
      });
    });
  }

  // ── META 读写 ──
  function _readMusicMeta() {
    try {
      var raw = global.localStorage && global.localStorage.getItem(MUSIC_META_KEY);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (!obj || !obj.kind) return null;
      return obj;
    } catch (_e) { return null; }
  }
  function _writeMusicMeta(obj) {
    try {
      global.localStorage.setItem(MUSIC_META_KEY, JSON.stringify(obj));
      return true;
    } catch (_e) { return false; }
  }
  function _clearMusicMeta() {
    try { global.localStorage.removeItem(MUSIC_META_KEY); } catch (_e) { /* ignore */ }
  }

  // 清理音乐态注入的媒体元素（VIDEO/IMG child + CSS overlay），调用方负责切态保护
  function _cleanMusicMediaFromDom() {
    try {
      _revokeMusicObjectUrl();
      var doc = _d();
      var media = doc && doc.getElementById ? doc.getElementById('home-poster-media') : null;
      if (!media) return;
      var nodes = media.querySelectorAll('video.sfv-poster-music-video-bg, img.sfv-poster-music-image-bg');
      for (var i = 0; i < nodes.length; i++) {
        try {
          if (nodes[i].tagName === 'VIDEO') {
            nodes[i].pause();
            nodes[i].removeAttribute('src');
            if (nodes[i].load) nodes[i].load();
          } else {
            nodes[i].removeAttribute('src');
          }
        } catch (_ex) { /* ignore */ }
        if (nodes[i].parentNode) nodes[i].parentNode.removeChild(nodes[i]);
      }
      media.classList.remove('sfv-outer-poster-has-music-video');
    } catch (_e) { /* ignore */ }
  }

  // 根据 music meta（或空 meta）渲染音乐态外层海报的内嵌媒体元素
  function _applyMusicPosterMediaFromMetaNow() {
    if (!_isMusicMode()) return;
    var doc = _d();
    if (!doc) return;
    var media = doc.getElementById('home-poster-media');
    if (!media) return;
    _cleanMusicMediaFromDom();

    var meta = _readMusicMeta();
    if (!meta) return;
    var kind = meta.kind === 'video' ? 'video' : (meta.kind === 'image' ? 'image' : null);
    if (!kind || !meta.blobKey) return;
    var key = meta.blobKey === OUTER_KEY_MUSIC ? OUTER_KEY_MUSIC : null;
    if (!key) return;

    _blobGet(key).then(function (entry) {
      if (!entry || !entry.blob) return;
      if (!_isMusicMode()) return; // 切态保护
      var liveMedia = doc.getElementById('home-poster-media');
      if (!liveMedia) return;
      try {
        var blobUrl = (global.URL || global.webkitURL).createObjectURL(entry.blob);
        MUSIC_OBJECT_URL = blobUrl;
        if (kind === 'video') {
          var video = doc.createElement('video');
          video.className = 'sfv-poster-music-video-bg';
          video.setAttribute('aria-hidden', 'true');
          video.muted = true; video.loop = true; video.playsInline = true;
          video.setAttribute('playsinline', ''); video.setAttribute('webkit-playsinline', '');
          video.autoplay = true; video.setAttribute('autoplay', '');
          video.preload = 'auto';
          video.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center;pointer-events:none;display:block;z-index:0;background:#000;';
          video.src = blobUrl;
          liveMedia.insertBefore(video, liveMedia.firstChild);
          liveMedia.classList.add('sfv-outer-poster-has-music-video');
          try {
            var p = video.play && video.play();
            if (p && typeof p.catch === 'function') p.catch(function () { /* autoplay rejected */ });
          } catch (_ep) { /* ignore */ }
        } else {
          var img = doc.createElement('img');
          img.className = 'sfv-poster-music-image-bg';
          img.setAttribute('aria-hidden', 'true');
          img.alt = '';
          img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center;pointer-events:none;display:block;z-index:0;';
          img.src = blobUrl;
          liveMedia.insertBefore(img, liveMedia.firstChild);
        }
      } catch (_e2) { /* ignore */ }
    }).catch(function () { /* blob 读取失败静默 */ });
  }

  // ── 用户：设置音乐态外层海报视频 ──
  function _pickMusicOuterPosterVideo() {
    if (!(global.desktopWindow && typeof global.desktopWindow.pickMedia === 'function')) {
      _toast('视频选择功能不可用');
      return;
    }
    global.desktopWindow.pickMedia('video').then(function (res) {
      if (!res || !res.ok) {
        if (res && !res.canceled) {
          var err = (res && res.error) || '未知错误';
          if (err === 'VIDEO_TOO_LARGE') err = '视频太大（上限 300MB）';
          _toast('视频选择失败: ' + err);
        }
        return;
      }
      if (res.canceled) return;
      if (!res.isVideo || !res.filePath) {
        _toast('视频数据无效');
        return;
      }
      if (!(global.desktopWindow && typeof global.desktopWindow.fileToBlob === 'function')) {
        _toast('视频文件读取不可用');
        return;
      }
      global.desktopWindow.fileToBlob(res.filePath).then(function (br) {
        if (!br || !br.ok || !br.buffer) {
          _toast('视频读取失败');
          return;
        }
        var buf = br.buffer;
        var ab = buf.buffer ? buf.buffer.slice(buf.byteOffset || 0, (buf.byteOffset || 0) + (buf.byteLength || 0)) : buf;
        var blob = new global.Blob([ab], { type: res.mimeType || 'video/mp4' });
        var name = res.fileName || br.fileName || '';
        var size = Number(res.fileSize || br.size || 0);
        _blobPut(OUTER_KEY_MUSIC, blob, { name: name, size: size, ts: Date.now() }).then(function () {
          var savedOk = _writeMusicMeta({ kind: 'video', blobKey: OUTER_KEY_MUSIC, name: name, size: size, ts: Date.now() });
          if (!savedOk) { try { _blobDelete(OUTER_KEY_MUSIC); } catch (_e) { /* ignore */ } _toast('音乐海报元数据保存失败'); return; }
          _applyMusicPosterMediaFromMetaNow();
          _toast('音乐态外层海报已设置为视频');
        }).catch(function () { _toast('视频写入失败'); });
      }).catch(function () { _toast('文件读取 IPC 失败'); });
    }).catch(function () { _toast('视频选择失败'); });
  }

  // 清理音乐态外层海报视频（独立 vendor 的图片清理；不碰 vendor 原有图片存储）
  function _clearMusicOuterPosterVideo() {
    try {
      var meta = _readMusicMeta();
      var key = meta && meta.blobKey === OUTER_KEY_MUSIC ? OUTER_KEY_MUSIC : null;
      _clearMusicMeta();
      _cleanMusicMediaFromDom();
      if (key) _blobDelete(key).catch(function () { /* ignore */ });
    } catch (_e) { /* ignore */ }
  }

  // ── UI 注入：「+视频」chip（仅音乐态下 home-poster-actions 存在时注入） ──
  function _ensureMusicVideoChip() {
    if (!_isMusicMode()) return;
    var doc = _d();
    if (!doc || !doc.querySelector) return;
    var actions = doc.querySelector('#home-poster .home-poster-actions') || doc.querySelector('.home-poster-actions');
    if (!actions) return;
    if (actions.querySelector('.home-poster-chip[data-sfv-chip="music-add-video"]')) return; // 已注入

    var ref = actions.querySelector('.home-poster-chip');
    var chip = doc.createElement('button');
    chip.type = 'button';
    chip.className = ref ? ref.className : 'home-poster-chip';
    chip.setAttribute('data-sfv-chip', 'music-add-video');
    chip.textContent = '+视频';
    chip.title = '为音乐态外层海报设置独立的动态视频背景';
    chip.style.setProperty('margin-left', '6px', 'important');
    chip.style.setProperty('background', 'rgba(90,170,255,0.16)', 'important');
    chip.style.setProperty('color', '#bcd9ff', 'important');
    chip.onclick = function () { _pickMusicOuterPosterVideo(); };
    actions.appendChild(chip);

    // 顺便注入一个极小的「清视频」chip（隐藏在 +视频 后面，双击显示；或通过工具箱调用）
    // 不单独占用视觉位：把「重置」chip 扩展为同时清理音乐态视频
    var chips = actions.querySelectorAll('.home-poster-chip');
    for (var i = 0; i < chips.length; i++) {
      var txt = (chips[i].textContent || '').trim();
      if (txt === '重置' && !chips[i].hasAttribute('data-sfv-reset-bound')) {
        chips[i].setAttribute('data-sfv-reset-bound', '1');
        var origReset = chips[i].onclick;
        chips[i].onclick = function (prev) {
          return function () {
            _clearMusicOuterPosterVideo(); // 先清我们的音乐视频，不影响 vendor 图片重置
            if (typeof prev === 'function') { try { prev.call(this); } catch (_e) { /* ignore */ } }
          };
        }(origReset);
      }
    }
  }

  // 周期性检查：home 激活后确保 chip 存在 & 媒体生效（音乐态 vendor 代码可能异步重写了 DOM）
  var _chipCheckTimer = null;
  function _scheduleChipCheck() {
    if (_chipCheckTimer) return;
    _chipCheckTimer = setInterval(function () {
      try {
        if (typeof emptyHomeActive !== 'undefined' && emptyHomeActive === false) return;
        if (!_isMusicMode()) return;
        _ensureMusicVideoChip();
      } catch (_e) { /* ignore */ }
    }, 1500);
    try {
      global.addEventListener && global.addEventListener('pagehide', function () {
        if (_chipCheckTimer) { clearInterval(_chipCheckTimer); _chipCheckTimer = null; }
      });
    } catch (_e) { /* ignore */ }
  }

  // ── 切态：空间切换时清理 / 还原 ──
  function _onSpaceChange() {
    try {
      if (_isMusicMode()) {
        // 进入音乐态：
        //   1) 清理影视态遗留的 sfv-poster-video-bg（video mode 的那个）— 由 restoreMusic() 处理，
        //      我们只在此处保险清一次
        try {
          var doc = _d();
          var media = doc && doc.getElementById ? doc.getElementById('home-poster-media') : null;
          if (media) {
            var film = media.querySelectorAll('video.sfv-poster-video-bg, img.sfv-poster-image-bg-blob');
            for (var i = 0; i < film.length; i++) {
              try {
                if (film[i].tagName === 'VIDEO') { film[i].pause(); film[i].removeAttribute('src'); }
                else film[i].removeAttribute('src');
              } catch (_ex1) { /* ignore */ }
              if (film[i].parentNode) film[i].parentNode.removeChild(film[i]);
            }
          }
        } catch (_eClean) { /* ignore */ }
        //   2) 激活音乐态自己的外层视频
        _applyMusicPosterMediaFromMetaNow();
        //   3) 注入 +视频 chip
        _ensureMusicVideoChip();
      } else {
        // 进入影视态：清理音乐态 bridge 创建的 +视频 chip 与 内嵌媒体
        _cleanMusicMediaFromDom();
        try {
          var doc2 = _d();
          if (doc2 && doc2.querySelectorAll) {
            var stray = doc2.querySelectorAll('.home-poster-chip[data-sfv-chip="music-add-video"]');
            for (var j = 0; j < stray.length; j++) {
              if (stray[j].parentNode) stray[j].parentNode.removeChild(stray[j]);
            }
          }
        } catch (_eR) { /* ignore */ }
      }
    } catch (_e) { console.warn('[OuterPosterBridge:spacechange]', _e && _e.message || _e); }
  }
  function _bindSpaceEvents() {
    if (global.__outerPosterBridgeSpaceBound) return;
    global.__outerPosterBridgeSpaceBound = true;
    var evName = (global.StellaflixVideo && global.StellaflixVideo.state && global.StellaflixVideo.state.EVENT)
      ? global.StellaflixVideo.state.EVENT
      : 'spacechange';
    global.addEventListener(evName, function () { setTimeout(_onSpaceChange, 10); });
    // 启动时若已在音乐态（或 music 默认态），补一次 chip + 渲染
    setTimeout(function () {
      try {
        if (_isMusicMode()) {
          _ensureMusicVideoChip();
          _applyMusicPosterMediaFromMetaNow();
        } else {
          _onSpaceChange();
        }
      } catch (_e) { /* ignore */ }
    }, 600);
    // DOMContentLoaded 兜底补一次
    try {
      var doc = _d();
      if (doc && doc.addEventListener) {
        if (doc.readyState === 'loading') {
          doc.addEventListener('DOMContentLoaded', function () {
            setTimeout(function () { if (_isMusicMode()) _ensureMusicVideoChip(); }, 300);
          });
        } else {
          setTimeout(function () { if (_isMusicMode()) _ensureMusicVideoChip(); }, 300);
        }
      }
    } catch (_e2) { /* ignore */ }
  }

  // 暴露全局 API（方便调试/工具箱手动调用）
  global.MineradioOuterPosterBridge = {
    DB: OUTER_MEDIA_DB, STORE: OUTER_MEDIA_STORE,
    MUSIC_KEY: OUTER_KEY_MUSIC, VIDEO_KEY: OUTER_KEY_VIDEO,
    pickMusicVideo: _pickMusicOuterPosterVideo,
    clearMusicVideo: _clearMusicOuterPosterVideo,
    applyMusicNow: _applyMusicPosterMediaFromMetaNow,
    cleanMusicDom: _cleanMusicMediaFromDom,
    readMusicMeta: _readMusicMeta,
  };

  _bindSpaceEvents();
  _scheduleChipCheck();
})();
