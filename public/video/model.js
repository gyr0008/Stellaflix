/*
 * Stellaflix 影视模块 — 数据模型 (Step 2)
 * 影视数据模型 + stellaflix-video-* localStorage 命名空间。
 * 注意：计划文档原写 stellaflix-video-*，但 C-2 改名后前缀已统一为 stellaflix-*，以本文件为准。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  var NS = 'stellaflix-video-';
  var KEY_PROGRESS = NS + 'progress'; // { [videoId]: { position, duration, updatedAt } }
  var KEY_LIBRARY = NS + 'library'; // [ { id, title, ... } ]
  var KEY_FAILURE_LOG = NS + 'failure-log'; // [ { title, key, sourceId, vodId, reason, action, ts } ]
  var FAILURE_LOG_CAP = 200;

  // ---- 数据迁移 schema ----
  // 版本标记键；migrate() 每次脚本加载时执行，保证应用升级不破坏用户影视数据。
  var KEY_SCHEMA_VERSION = NS + 'schema-version';
  var SCHEMA_VERSION = 1;
  // 历史遗留命名空间（Stellaflix 时期文档曾写 stellaflix-video-*）；
  // 若升级用户本地仍有旧键，v1 迁移会防御性并入当前命名空间（无则 no-op）。
  var OLD_NS = 'stellaflix-video-';

  // ---- 在线闭环新增：用户数据模型 ----
  // 历史：用户播放过的每一个 vod（在线/本地统一），按 key 去重，最新在前的数组。
  var KEY_HISTORY = NS + 'history'; // [ { key, title, pic, year, sourceId, vodId, ts } ]
  // 标记：心动(liked)/片单(inList) 两类布尔旗，按 vod key 索引。
  var KEY_FLAG = NS + 'flag'; // { [vodKey]: { liked, inList } }
  // 元信息缓存：vod key → 基本元数据，保证即便源被删/离线，各类列表仍能渲染标题封面。
  var KEY_META = NS + 'meta'; // { [vodKey]: { key, title, pic, year, sourceId, vodId } }
  // 追片（Kazumi 等价）：互斥单值观看状态，按 vod key 索引。
  // 值 ∈ TRACK_STATUSES；键不存在 = 未收藏(none)；清除 = 删除键。
  var KEY_TRACK = NS + 'track'; // { [vodKey]: 'watching'|'planToWatch'|'onHold'|'watched'|'abandoned' }

  var FLAG_FIELDS = ['liked', 'inList'];
  // 追片 5 状态（与 Kazumi CollectType 一致，none 表示未收藏=键不存在）
  var TRACK_STATUSES = ['watching', 'planToWatch', 'onHold', 'watched', 'abandoned'];
  var TRACK_LABELS = {
    watching: '在看', planToWatch: '想看', onHold: '搁置', watched: '看过', abandoned: '抛弃',
  };
  // 追片状态图标 —— 1:1 对齐 Kazumi CollectButton.getIconByInt()（Kazumi 2.2.6
  // lib/bean/widget/collect_button.dart）：未追 favorite_border / 在看 favorite /
  // 想看 star_rounded / 搁置 pending_actions / 看过 done / 抛弃 heart_broken。
  // path 取自 Material Icons 官方 SVG（@material-icons/svg@1.0.33，fill 风格），
  // 非手绘估算；fill="currentColor" 以继承父级颜色（选中态 accent / hover 等）。
  // none 映射到 favorite_border（与 Kazumi 默认分支一致）。
  function _mi(p) {
    return '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="' + p + '"/></svg>';
  }
  var STATE_ICONS = {
    none:          _mi('M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3C4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5C22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1l-.1-.1C7.14 14.24 4 11.39 4 8.5C4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5c0 2.89-3.14 5.74-7.9 10.05z'),
    watching:      _mi('M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5C2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3C19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z'),
    planToWatch:   _mi('M12 17.27l4.15 2.51c.76.46 1.69-.22 1.49-1.08l-1.1-4.72l3.67-3.18c.67-.58.31-1.68-.57-1.75l-4.83-.41l-1.89-4.46c-.34-.81-1.5-.81-1.84 0L9.19 8.63l-4.83.41c-.88.07-1.24 1.17-.57 1.75l3.67 3.18l-1.1 4.72c-.2.86.73 1.54 1.49 1.08l4.15-2.5z'),
    onHold:        _mi('M17 12c-2.76 0-5 2.24-5 5s2.24 5 5 5s5-2.24 5-5s-2.24-5-5-5zm1.65 7.35L16.5 17.2V14h1v2.79l1.85 1.85l-.7.71zM18 3h-3.18C14.4 1.84 13.3 1 12 1s-2.4.84-2.82 2H6c-1.1 0-2 .9-2 2v15c0 1.1.9 2 2 2h6.11a6.743 6.743 0 0 1-1.42-2H6V5h2v3h8V5h2v5.08c.71.1 1.38.31 2 .6V5c0-1.1-.9-2-2-2zm-6 2c-.55 0-1-.45-1-1s.45-1 1-1s1 .45 1 1s-.45 1-1 1z'),
    watched:       _mi('M9 16.2L4.8 12l-1.4 1.4L9 19L21 7l-1.4-1.4L9 16.2z'),
    abandoned:     _mi('M16.5 3c-.96 0-1.9.25-2.73.69L12 9h3l-3 10l1-9h-3l1.54-5.39C10.47 3.61 9.01 3 7.5 3C4.42 3 2 5.42 2 8.5c0 4.13 4.16 7.18 10 12.5c5.47-4.94 10-8.26 10-12.5C22 5.42 19.58 3 16.5 3z'),
  };
  var HISTORY_CAP = 300;

  function readJSON(key, fallback) {
    try {
      var raw = global.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function writeJSON(key, val) {
    try {
      global.localStorage.setItem(key, JSON.stringify(val));
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---- 数据迁移 ----
  // 旧命名空间 → 当前命名空间的键映射（仅用于 v1 防御性导入）。
  var LEGACY_IMPORT_MAP = {
    'progress': KEY_PROGRESS,
    'library': KEY_LIBRARY,
    'history': KEY_HISTORY,
    'flag': KEY_FLAG,
    'meta': KEY_META,
    'track': KEY_TRACK,
    'failure-log': KEY_FAILURE_LOG
  };

  // 迁移注册表：键为「目标版本」，up() 把数据从 v-1 演进到 v。
  // 每一步必须幂等、可重复执行；失败不应阻断应用启动。
  var MIGRATIONS = {
    // v1：防御性导入旧 stellaflix-video-* 命名空间数据（仅当新键为空时）。
    1: {
      up: function () {
        Object.keys(LEGACY_IMPORT_MAP).forEach(function (suffix) {
          var oldKey = OLD_NS + suffix;
          var newKey = LEGACY_IMPORT_MAP[suffix];
          var raw = global.localStorage.getItem(oldKey);
          if (raw != null && global.localStorage.getItem(newKey) == null) {
            global.localStorage.setItem(newKey, raw);
          }
        });
      }
    }
  };

  // 执行所有未完成的数据迁移，并将版本标记写到当前 SCHEMA_VERSION。
  // 若某步抛错，不推进版本号（下次启动重试该步），且整体不抛给调用方。
  function migrate() {
    var cur = parseInt(global.localStorage.getItem(KEY_SCHEMA_VERSION), 10);
    if (isNaN(cur) || cur < 0) cur = 0;
    for (var v = cur + 1; v <= SCHEMA_VERSION; v++) {
      var step = MIGRATIONS[v];
      if (step && typeof step.up === 'function') {
        try {
          step.up();
        } catch (e) {
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[SFV.model] 迁移步骤 v' + v + ' 失败，将在下次启动重试：', e);
          }
          return; // 不推进版本号，下次重试
        }
      }
    }
    try {
      global.localStorage.setItem(KEY_SCHEMA_VERSION, String(SCHEMA_VERSION));
    } catch (e) { /* 写入标记失败不致命 */ }
  }

  // ---- 观看进度 ----
  function getProgress(videoId) {
    var all = readJSON(KEY_PROGRESS, {});
    return all[videoId] || null;
  }

  function setProgress(videoId, position, duration) {
    if (!videoId) return null;
    var all = readJSON(KEY_PROGRESS, {});
    all[videoId] = {
      position: position | 0,
      duration: duration | 0,
      updatedAt: Date.now(),
    };
    writeJSON(KEY_PROGRESS, all);
    return all[videoId];
  }

  function clearProgress(videoId) {
    var all = readJSON(KEY_PROGRESS, {});
    delete all[videoId];
    writeJSON(KEY_PROGRESS, all);
  }

  // 按前缀清除进度（观看历史聚合卡删除时连带清整部番各集进度）；返回删除条数。
  function clearProgressByPrefix(prefix) {
    if (!prefix) return 0;
    var all = readJSON(KEY_PROGRESS, {});
    var n = 0;
    Object.keys(all).forEach(function (k) {
      if (k.indexOf(prefix) === 0) { delete all[k]; n++; }
    });
    if (n) writeJSON(KEY_PROGRESS, all);
    return n;
  }

  // ---- 片库 ----
  function getLibrary() {
    return readJSON(KEY_LIBRARY, []);
  }

  function addToLibrary(item) {
    if (!item || !item.id) return getLibrary();
    var lib = readJSON(KEY_LIBRARY, []);
    if (!lib.some(function (x) { return x.id === item.id; })) {
      lib.push(item);
      writeJSON(KEY_LIBRARY, lib);
    }
    return lib;
  }

  function removeFromLibrary(id) {
    var lib = readJSON(KEY_LIBRARY, []);
    var next = lib.filter(function (x) { return x.id !== id; });
    writeJSON(KEY_LIBRARY, next);
    return next;
  }

  // ---- 在线闭环：四类数据模型 ----

  // vodKey 由 public/video/sources.js 的 normalizeVod 生成（sourceId:vodId），
  // 也用于本地条目（file:xxx / url:xxx）。此处不依赖 sources.js 是否已加载。
  function getHistory() {
    var arr = readJSON(KEY_HISTORY, []);
    return Array.isArray(arr) ? arr : [];
  }

  function addHistory(rec) {
    if (!rec || !rec.key) return getHistory();
    var arr = getHistory();
    arr = arr.filter(function (x) { return x.key !== rec.key; });
    arr.unshift({
      key: rec.key,
      title: rec.title || rec.key,
      pic: rec.pic || '',
      year: rec.year || '',
      sourceId: rec.sourceId || '',
      vodId: rec.vodId || '',
      ts: Date.now(),
    });
    if (arr.length > HISTORY_CAP) arr = arr.slice(0, HISTORY_CAP);
    writeJSON(KEY_HISTORY, arr);
    return arr;
  }

  function clearHistory() { writeJSON(KEY_HISTORY, []); return []; }

  // 把历史条目（进度键匹配）的海报替换为本地 data URL。
  // 用途：观看达阈值后把 TMDB 远程海报缓存到本地，再回写 history.pic，
  // 使「接着看」等读取 history.pic 时直接加载本地图，不再请求 TMDB。
  // T147：同步支持空 pic → 远程 URL（home.js 后向补图场景）。
  // 仅当 pic 已是 data: 时跳过，避免覆盖已缓存的本地图。
  function updateHistoryPic(key, dataUrl) {
    if (!key || !dataUrl) return false;
    var arr = getHistory();
    var changed = false;
    for (var i = 0; i < arr.length; i++) {
      var x = arr[i];
      // pic 为空字符串/undefined（搜索时 CMS10/规则源没返图）→ 允许更新；
      // pic 已是 data: 本地图 → 跳过，避免覆盖缓存。
      if (x.key === key && (typeof x.pic !== 'string' || x.pic.indexOf('data:') !== 0)) {
        x.pic = dataUrl;
        changed = true;
      }
    }
    if (changed) writeJSON(KEY_HISTORY, arr);
    return changed;
  }

  function getFlag(key) {
    var all = readJSON(KEY_FLAG, {});
    var f = all[key] || {};
    return { liked: !!f.liked, inList: !!f.inList };
  }

  function setFlag(key, field, on) {
    if (!key || FLAG_FIELDS.indexOf(field) < 0) return getFlag(key);
    var all = readJSON(KEY_FLAG, {});
    if (!all[key]) all[key] = {};
    all[key][field] = !!on;
    // 两类旗全为假时直接删键，避免脏数据膨胀
    var f = all[key];
    if (!f.liked && !f.inList) delete all[key];
    writeJSON(KEY_FLAG, all);
    return getFlag(key);
  }

  function toggleFlag(key, field) {
    var f = getFlag(key);
    return setFlag(key, field, !f[field]);
  }

  // ---- 追片（Kazumi 等价：互斥单值观看状态）----
  function getTrackStatus(key) {
    var all = readJSON(KEY_TRACK, {});
    var s = all[key];
    return (s && TRACK_STATUSES.indexOf(s) >= 0) ? s : null;
  }

  // status 为空 / 'none' -> 清除（删除键）；
  // 有效状态 -> 直接覆盖（天然互斥）；
  // 其它无效非空值 -> 忽略，保留原状态（防御性，避免误清空）。
  function setTrackStatus(key, status) {
    if (!key) return null;
    var all = readJSON(KEY_TRACK, {});
    if (!status || status === 'none') {
      if (all[key]) {
        delete all[key]; writeJSON(KEY_TRACK, all);
        // 取消追片：同步清理本地元数据 + 海报缓存，避免本地存储无限膨胀
        var metaAll = readJSON(KEY_META, {});
        if (metaAll[key]) { delete metaAll[key]; writeJSON(KEY_META, metaAll); }
        if (SFV.posterCache && typeof SFV.posterCache.remove === 'function') SFV.posterCache.remove(key);
      }
      return null;
    }
    if (TRACK_STATUSES.indexOf(status) < 0) return getTrackStatus(key); // 无效状态忽略
    all[key] = status;
    writeJSON(KEY_TRACK, all);
    return status;
  }

  // 返回某追片状态下所有 vod key（数组）
  function getKeysByTrack(status) {
    if (TRACK_STATUSES.indexOf(status) < 0) return [];
    var all = readJSON(KEY_TRACK, {});
    var out = [];
    Object.keys(all).forEach(function (k) { if (all[k] === status) out.push(k); });
    return out;
  }

  // 已追片（任意非 none 状态）总数
  function getTrackCount() {
    var all = readJSON(KEY_TRACK, {});
    return Object.keys(all).length;
  }

  // 所有已追片 key（任意状态），供首页封面聚合等使用
  function getTrackKeys() {
    var all = readJSON(KEY_TRACK, {});
    return Object.keys(all);
  }

  // 清除某片追片状态（= 设为 none）
  function clearTrack(key) { return setTrackStatus(key, null); }

  // 返回某标记类下所有 vod key（数组）
  function getKeysByFlag(field) {
    if (FLAG_FIELDS.indexOf(field) < 0) return [];
    var all = readJSON(KEY_FLAG, {});
    var out = [];
    Object.keys(all).forEach(function (k) {
      if (all[k] && all[k][field]) out.push(k);
    });
    return out;
  }

  function getMeta(key) {
    var all = readJSON(KEY_META, {});
    return all[key] || null;
  }

  function setMeta(rec) {
    if (!rec || !rec.key) return;
    var all = readJSON(KEY_META, {});
    var prev = all[rec.key] || {};
    var nextPic = rec.pic || prev.pic || '';
    all[rec.key] = {
      key: rec.key,
      title: rec.title || prev.title || rec.key,
      pic: nextPic,
      year: rec.year || prev.year || '',
      sourceId: rec.sourceId || '',
      vodId: rec.vodId || '',
    };
    writeJSON(KEY_META, all);

    // 异步抓取并缓存海报到本地；成功后把 meta pic 替换为本地 data URL，
    // 下次 resolveList / renderTrackPage 即可直接加载本地图，不再请求 TMDB。
    if (nextPic && SFV.posterCache && typeof SFV.posterCache.cache === 'function' && nextPic.indexOf('data:') !== 0) {
      SFV.posterCache.cache(rec.key, nextPic).then(function (dataUrl) {
        if (dataUrl && dataUrl !== nextPic) {
          setMeta({ key: rec.key, pic: dataUrl, title: all[rec.key].title, year: all[rec.key].year, sourceId: all[rec.key].sourceId, vodId: all[rec.key].vodId });
        }
      });
    }
  }

  // 供 online.js 一次性取「某分类」的完整列表：以 meta 为主、缺失时用 history 兜底
  function resolveList(keys) {
    var out = [];
    (keys || []).forEach(function (k) {
      var m = getMeta(k);
      if (!m) {
        var h = getHistory().filter(function (x) { return x.key === k; })[0];
        if (h) m = { key: k, title: h.title, pic: h.pic, year: h.year, sourceId: h.sourceId, vodId: h.vodId };
      }
      if (m) {
        // 优先使用本地海报缓存（内存命中立即替换，未命中则后台触发缓存并保留原 URL）
        if (SFV.posterCache && typeof SFV.posterCache.resolvePic === 'function' && m.pic && m.pic.indexOf('data:') !== 0) {
          m = Object.assign({}, m, { pic: SFV.posterCache.resolvePic(m.key, m.pic) });
        }
        out.push(m);
      }
    });
    return out;
  }

  // ---- 来源失效日志（用于后续跟进与诊断）----
  function logFailure(entry) {
    if (!entry || !entry.title) return false;
    var arr = readJSON(KEY_FAILURE_LOG, []);
    if (!Array.isArray(arr)) arr = [];
    arr.unshift({
      title: entry.title,
      key: entry.key || '',
      sourceId: entry.sourceId || '',
      vodId: entry.vodId || '',
      reason: entry.reason || '',
      action: entry.action || 'open',
      ts: Date.now(),
    });
    if (arr.length > FAILURE_LOG_CAP) arr = arr.slice(0, FAILURE_LOG_CAP);
    return writeJSON(KEY_FAILURE_LOG, arr);
  }
  function getFailureLog() { return readJSON(KEY_FAILURE_LOG, []); }
  function clearFailureLog() { return writeJSON(KEY_FAILURE_LOG, []); }

  SFV.model = {
    NS: NS,
    getProgress: getProgress,
    setProgress: setProgress,
    clearProgress: clearProgress,
    clearProgressByPrefix: clearProgressByPrefix,
    getLibrary: getLibrary,
    addToLibrary: addToLibrary,
    removeFromLibrary: removeFromLibrary,
    // 在线闭环新增
    getHistory: getHistory,
    addHistory: addHistory,
    clearHistory: clearHistory,
    updateHistoryPic: updateHistoryPic,
    getFlag: getFlag,
    setFlag: setFlag,
    toggleFlag: toggleFlag,
    getKeysByFlag: getKeysByFlag,
    getMeta: getMeta,
    setMeta: setMeta,
    resolveList: resolveList,
    FLAG_FIELDS: FLAG_FIELDS,
    // 追片（Kazumi 等价）
    getTrackStatus: getTrackStatus,
    setTrackStatus: setTrackStatus,
    getKeysByTrack: getKeysByTrack,
    getTrackCount: getTrackCount,
    getTrackKeys: getTrackKeys,
    clearTrack: clearTrack,
    TRACK_STATUSES: TRACK_STATUSES,
    TRACK_LABELS: TRACK_LABELS,
    STATE_ICONS: STATE_ICONS,
    // 来源失效日志
    logFailure: logFailure,
    getFailureLog: getFailureLog,
    clearFailureLog: clearFailureLog,
    // 数据迁移 schema
    SCHEMA_VERSION: SCHEMA_VERSION,
    migrate: migrate,
  };

  // 每次脚本加载即执行迁移（升级不破坏用户影视数据）；步骤失败不阻断启动。
  migrate();
})(typeof window !== 'undefined' ? window : this);
