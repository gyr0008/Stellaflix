/*
 * Stellaflix 影视模块 — 片单数据引擎 (Step 5 片单功能)
 *
 * 数据策略（用户确认 2026-08-03）：
 *   - B 主干：TMDB 动态查询（discover / collection / trending / upcoming）
 *   - A 补充：硬编码编辑精选（static-list，TMDB 无法用查询表达的策展片单）
 *   - C 玩法：用户自建片单夹（localStorage，支持自定义命名 / 多夹 / 增删影片）
 *
 * 对外 API（SFV.collections）：
 *   getTabs()                         → 6 个平行 tab 定义
 *   getByTab(tabId)                  → 该 tab 下的片单列表（含封面/计数占位）
 *   getItems(collDef)                → 该片单的影片列表（normalizeList 格式，喂 renderGrid）
 *   getPosters(collDef, n)           → 前 n 张海报 URL（叠加效果用）
 *   listUserFolders()                → 用户自建片单夹列表
 *   createUserFolder(name)           → 新建片单夹，返回 folderId
 *   renameUserFolder(folderId, name) → 重命名
 *   deleteUserFolder(folderId)       → 删除（含内部影片）
 *   addUserItem(folderId, item)      → 加入影片
 *   removeUserItem(folderId, itemId) → 移除影片
 *   getUserFolderItems(folderId)     → 某夹内影片列表
 *
 * 合规：本文件零硬编码视频源；仅元数据（海报/简介）来自 TMDB，符合 §0.3。
 * 双态隔离：本模块不感知音乐态，仅由影视态页面调用。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  // ---------------------------------------------------------------- Tab 定义（6 个平行）
  var TABS = [
    { id: 'featured', label: '推荐' },
    { id: 'theme', label: '主题' },
    { id: 'classic', label: '经典' },
    { id: 'highscore', label: '高分' },
    { id: 'awards', label: '获奖' },
    { id: 'mine', label: '我的片单' }
  ];

  // ---------------------------------------------------------------- 预置片单目录（B 主干 + A 补充）
  // type:
  //   'tmdb-trending'   → trending(mediaType, timeWindow)
  //   'tmdb-popular'    → popular(mediaType)
  //   'tmdb-upcoming'   → upcoming()
  //   'tmdb-collection' → getCollection(collectionId)
  //   'tmdb-discover'   → discover(query)
  //   'static-list'     → A 补充：tmdbIds 数组，逐条 getDetails 补全
  //   'placeholder'     → 即将上线占位
  var CATALOG = [
    // ===== 推荐 (featured) =====
    { id: 'trending-week', title: '本周热门', sub: '全球观众正在看',
      type: 'tmdb-trending', mediaType: 'movie', timeWindow: 'week', tab: 'featured', warm: '#e74c3c' },
    { id: 'trending-tv-week', title: '本周热播剧', sub: '追剧不踩雷',
      type: 'tmdb-trending', mediaType: 'tv', timeWindow: 'week', tab: 'featured', warm: '#3498db' },
    { id: 'popular-movies', title: '当下流行电影', sub: '院线 / 热映',
      type: 'tmdb-popular', mediaType: 'movie', tab: 'featured', warm: '#9b59b6' },
    { id: 'upcoming', title: '即将上映', sub: '值得期待的新片',
      type: 'tmdb-upcoming', tab: 'featured', warm: '#1abc9c' },

    // ===== 主题 (theme) =====
    { id: 'coll-mcu', title: '漫威电影宇宙', sub: '从钢铁侠到终局之战',
      type: 'tmdb-collection', collectionId: 86311, tab: 'theme', warm: '#c0392b' },
    { id: 'coll-dc', title: 'DC 扩展宇宙', sub: '蝙蝠侠 / 超人 / 神奇女侠',
      type: 'tmdb-collection', collectionId: 209, tab: 'theme', warm: '#2980b9' },
    { id: 'coll-starwars', title: '星球大战系列', sub: '天行者传奇',
      type: 'tmdb-collection', collectionId: 10, tab: 'theme', warm: '#f39c12' },
    { id: 'coll-harrypotter', title: '哈利·波特全集', sub: '霍格沃茨魔法世界',
      type: 'tmdb-collection', collectionId: 1241, tab: 'theme', warm: '#1abc9c' },
    { id: 'coll-jurassic', title: '侏罗纪公园系列', sub: '恐龙复活冒险',
      type: 'tmdb-collection', collectionId: 328, tab: 'theme', warm: '#27ae60' },
    { id: 'coll-fastfurious', title: '速度与激情系列', sub: '家庭与速度',
      type: 'tmdb-collection', collectionId: 9485, tab: 'theme', warm: '#e67e22' },
    { id: 'genre-scifi', title: '星际旅行 & 太空冒险', sub: '浩瀚宇宙',
      type: 'tmdb-discover', query: { with_genres: '878', sort_by: 'popularity.desc' }, tab: 'theme', warm: '#2c3e50' },
    { id: 'genre-animation', title: '动画电影精选', sub: '不止给孩子看',
      type: 'tmdb-discover', query: { with_genres: '16', sort_by: 'vote_average.desc', 'vote_count.gte': '200' }, tab: 'theme', warm: '#e91e63' },
    { id: 'genre-crime', title: '烧脑犯罪 & 悬疑', sub: '反转不断',
      type: 'tmdb-discover', query: { with_genres: '80', sort_by: 'vote_average.desc', 'vote_count.gte': '300' }, tab: 'theme', warm: '#34495e' },
    // A 补充：硬编码策展（TMDB 无对应 discover 表达）
    { id: 'nolan-works', title: '诺兰导演作品集', sub: '烧脑神作',
      type: 'static-list', tmdbIds: [27205, 157336, 106648, 455207, 468569, 872585, 603, 76341], tab: 'theme', warm: '#8e44ad' },

    // ===== 经典 (classic) =====
    { id: 'classic-90s', title: '90 年代经典', sub: '不可错过的黄金十年',
      type: 'tmdb-discover', query: { 'primary_release_date.gte': '1990-01-01', 'primary_release_date.lte': '1999-12-31', 'sort_by': 'vote_average.desc', 'vote_average.gte': '7.5', 'vote_count.gte': '500' }, tab: 'classic', warm: '#8e44ad' },
    { id: 'classic-80s', title: '80 年代经典', sub: '好莱坞黄金时代',
      type: 'tmdb-discover', query: { 'primary_release_date.gte': '1980-01-01', 'primary_release_date.lte': '1989-12-31', 'sort_by': 'vote_average.desc', 'vote_average.gte': '7.5', 'vote_count.gte': '500' }, tab: 'classic', warm: '#d35400' },
    { id: 'classic-alltime', title: '影史百大', sub: '永远的经典',
      type: 'tmdb-discover', query: { 'sort_by': 'vote_average.desc', 'vote_average.gte': '8.0', 'vote_count.gte': '3000' }, tab: 'classic', warm: '#f1c40f' },

    // ===== 高分 (highscore) =====
    { id: 'top-2024', title: '2024 年评分最高', sub: '年度佳片',
      type: 'tmdb-discover', query: { 'primary_release_year': '2024', 'sort_by': 'vote_average.desc', 'vote_count.gte': '200' }, tab: 'highscore', warm: '#1abc9c' },
    { id: 'top-2023', title: '2023 年评分最高', sub: '年度佳片',
      type: 'tmdb-discover', query: { 'primary_release_year': '2023', 'sort_by': 'vote_average.desc', 'vote_count.gte': '200' }, tab: 'highscore', warm: '#3498db' },
    { id: 'top-2020s', title: '2020 年代十佳', sub: '近五年最佳',
      type: 'tmdb-discover', query: { 'primary_release_date.gte': '2020-01-01', 'sort_by': 'vote_average.desc', 'vote_average.gte': '7.8', 'vote_count.gte': '500' }, tab: 'highscore', warm: '#9b59b6' },
    { id: 'korean-top', title: '韩国电影十佳', sub: '不容错过',
      type: 'tmdb-discover', query: { with_original_language: 'ko', 'sort_by': 'vote_average.desc', 'vote_average.gte': '7.5', 'vote_count.gte': '200' }, tab: 'highscore', warm: '#e74c3c' },

    // ===== 获奖 (awards) —— Phase 1: A 补充硬编码奥斯卡类，中国奖项 Phase 2 =====
    { id: 'oscar-best-picture', title: '奥斯卡最佳影片', sub: '历届最高荣誉',
      type: 'static-list', tmdbIds: [19404, 424, 11216, 70160, 524, 278, 238, 389, 13, 105], tab: 'awards', warm: '#f1c40f' },
    { id: 'awards-cn-placeholder', title: '金鹰 / 白玉兰 / 华表', sub: '中国奖项片单，即将上线',
      type: 'placeholder', tab: 'awards', warm: '#c0392b' },
    { id: 'calendar', title: '每周新番', sub: 'Bangumi 放送表', type: 'bangumi-calendar', tab: 'calendar', warm: '#16a085' }
  ];

  // ---------------------------------------------------------------- 用户自建片单夹（C 玩法）
  var USER_KEY = 'stellaflix-user-collections';
  // 观看标记（看过 / 弃）：独立键，不与片单夹耦合，便于搜索结果前端过滤
  var MARKS_KEY = 'stellaflix-view-marks';
  var LS = global.localStorage;

  function loadUser() {
    if (!LS) return { folders: [] };
    try {
      var raw = LS.getItem(USER_KEY);
      if (!raw) return { folders: [] };
      var p = JSON.parse(raw);
      return p && p.folders ? p : { folders: [] };
    } catch (e) { return { folders: [] }; }
  }
  function saveUser(data) {
    if (!LS) return false;
    try { LS.setItem(USER_KEY, JSON.stringify(data)); return true; }
    catch (e) { return false; }
  }
  function genId() {
    return 'uf_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  // ---------------------------------------------------------------- 对外方法
  function getTabs() { return TABS.slice(); }

  function getByTab(tabId) {
    if (tabId === 'mine') {
      // 我的片单：返回用户片单夹列表（动态）
      return listUserFolders().map(function (f) {
        return {
          id: f.id, title: f.name, sub: (f.items ? f.items.length : 0) + ' 部',
          type: 'user-folder', warm: '#534AB7', folderId: f.id
        };
      });
    }
    return CATALOG.filter(function (c) { return c.tab === tabId; }).map(function (c) {
      return {
        id: c.id, title: c.title, sub: c.sub || '',
        type: c.type, warm: c.warm || '#333',
        // 占位计数（真实数量在 getItems 后刷新）
        count: (c.type === 'placeholder') ? 0 : null,
        collectionId: c.collectionId, query: c.query,
        tmdbIds: c.tmdbIds, mediaType: c.mediaType, timeWindow: c.timeWindow,
        tab: c.tab
      };
    });
  }

  // 取单个片单的影片列表（统一 normalizeList 格式）
  function getItems(def) {
    if (!def) return Promise.reject(new Error('NO_DEF'));
    var tmdb = SFV.tmdb;
    if (!tmdb || !tmdb.hasKey || !tmdb.hasKey()) return Promise.reject(new Error('TMDB_KEY_REQUIRED'));

    switch (def.type) {
      case 'tmdb-trending':
        return tmdb.trending(def.mediaType || 'movie', def.timeWindow || 'week');
      case 'tmdb-popular':
        return tmdb.popular(def.mediaType || 'movie');
      case 'tmdb-upcoming':
        return tmdb.upcoming();
      case 'tmdb-collection':
        return tmdb.getCollection(def.collectionId).then(function (c) {
          // 用 parts 作为影片列表（已含 poster/title/year/rating）
          return (c.parts || []).map(function (p) {
            return {
              id: p.id, mediaType: p.mediaType || 'movie',
              title: p.title, year: p.year, poster: p.poster,
              rating: p.rating, overview: p.overview, backdrop: p.backdrop
            };
          });
        });
      case 'tmdb-discover':
        return tmdb.discover(def.query || {});
      case 'static-list':
        // A 补充：逐条 getDetails 补全（数量少，串行可控）
        return resolveStatic(def.tmdbIds || []);
      case 'user-folder':
        return Promise.resolve(getUserFolderItems(def.folderId));
      default:
        return Promise.reject(new Error('UNKNOWN_TYPE_' + def.type));
    }
  }

  // static-list：用 getDetails 补全每部影片元数据
  function resolveStatic(ids) {
    var tmdb = SFV.tmdb;
    var out = [];
    var chain = Promise.resolve();
    ids.forEach(function (id) {
      chain = chain.then(function () {
        return tmdb.getDetails(id, 'movie').then(function (d) {
          out.push({
            id: d.id, mediaType: 'movie', title: d.title, year: d.year,
            poster: d.poster, rating: d.rating, overview: d.overview, backdrop: d.backdrop
          });
        }).catch(function () { /* skip failed */ });
      });
    });
    return chain.then(function () { return out; });
  }

  // 取片单封面用的前 n 张海报（叠加效果）
  function getPosters(def, n) {
    n = n || 3;
    return getItems(def).then(function (items) {
      var posters = [];
      for (var i = 0; i < items.length && posters.length < n; i++) {
        if (items[i].poster) posters.push(items[i].poster);
      }
      return posters;
    }).catch(function () { return []; });
  }

  // ---------------------------------------------------------------- 用户片单夹 CRUD
  function listUserFolders() {
    var d = loadUser();
    return (d.folders || []).map(function (f) {
      return { id: f.id, name: f.name, items: f.items || [] };
    });
  }
  function createUserFolder(name) {
    var d = loadUser();
    if (!d.folders) d.folders = [];
    var folder = { id: genId(), name: (name || '我的片单').trim() || '我的片单', items: [] };
    d.folders.push(folder);
    saveUser(d);
    return folder.id;
  }
  function renameUserFolder(folderId, name) {
    var d = loadUser();
    var f = (d.folders || []).filter(function (x) { return x.id === folderId; })[0];
    if (!f) return false;
    f.name = (name || '').trim() || f.name;
    return saveUser(d);
  }
  function deleteUserFolder(folderId) {
    var d = loadUser();
    d.folders = (d.folders || []).filter(function (x) { return x.id !== folderId; });
    return saveUser(d);
  }
  function addUserItem(folderId, item) {
    var d = loadUser();
    var f = (d.folders || []).filter(function (x) { return x.id === folderId; })[0];
    if (!f) return false;
    if (!f.items) f.items = [];
    // 去重：同 id 不重复加
    for (var i = 0; i < f.items.length; i++) if (f.items[i].id === item.id) return true;
    f.items.push({
      id: item.id, mediaType: item.mediaType || 'movie',
      title: item.title || '', year: item.year || '', poster: item.poster || '',
      rating: item.rating || 0, overview: item.overview || '',
      addedAt: Date.now() // 供首页片单卡展示"最新加入"海报
    });
    var saved = saveUser(d);
    // 加入片单即把海报本地缓存（与追片/历史一致的离线可见机制），取消移除时由 removeUserItem 删除
    if (saved && item.poster && SFV.posterCache && typeof SFV.posterCache.cache === 'function' && item.poster.indexOf('data:') !== 0) {
      SFV.posterCache.cache(item.id, item.poster);
    }
    return saved;
  }
  function removeUserItem(folderId, itemId) {
    var d = loadUser();
    var f = (d.folders || []).filter(function (x) { return x.id === folderId; })[0];
    if (!f || !f.items) return false;
    f.items = f.items.filter(function (x) { return x.id !== itemId; });
    var saved = saveUser(d);
    // 从片单移除：同步删除本地海报缓存，避免本地存储无限膨胀
    if (saved && SFV.posterCache && typeof SFV.posterCache.remove === 'function') SFV.posterCache.remove(itemId);
    return saved;
  }
  function getUserFolderItems(folderId) {
    var d = loadUser();
    var f = (d.folders || []).filter(function (x) { return x.id === folderId; })[0];
    return f ? (f.items || []) : [];
  }

  // ---------------------------------------------------------------- 看过 / 弃 标记（Kazumi 隐藏已看/已弃）
  // 主键策略：搜索结果去重后无单一 id，以其身份键（小写 title|year）为主；
  // TMDB 条目（含 mediaType/id）回退 mediaType:id；源 variant 直接用其复合 key。
  function loadMarks() {
    if (!LS) return { watched: {}, abandoned: {} };
    try {
      var raw = LS.getItem(MARKS_KEY);
      if (!raw) return { watched: {}, abandoned: {} };
      var p = JSON.parse(raw);
      return { watched: p.watched || {}, abandoned: p.abandoned || {} };
    } catch (e) { return { watched: {}, abandoned: {} }; }
  }
  function saveMarks(data) {
    if (!LS) return false;
    try { LS.setItem(MARKS_KEY, JSON.stringify(data)); return true; }
    catch (e) { return false; }
  }
  function markKey(item) {
    if (!item) return null;
    if (item.key) return String(item.key);
    if (item.title) return String(item.title).toLowerCase() + '|' + (item.year || '');
    if (item.id != null) return (item.mediaType || 'movie') + ':' + item.id;
    return null;
  }
  function setMark(item, type, on) {
    var k = markKey(item);
    if (!k) return false;
    type = (type === 'abandoned') ? 'abandoned' : 'watched';
    var d = loadMarks();
    if (on) d[type][k] = Date.now();
    else delete d[type][k];
    return saveMarks(d);
  }
  function isMarked(item, type) {
    var k = markKey(item);
    if (!k) return false;
    type = (type === 'abandoned') ? 'abandoned' : 'watched';
    return !!loadMarks()[type][k];
  }
  function markWatched(item) { return setMark(item, 'watched', true); }
  function unmarkWatched(item) { return setMark(item, 'watched', false); }
  function isWatched(item) { return isMarked(item, 'watched'); }
  function markAbandoned(item) { return setMark(item, 'abandoned', true); }
  function unmarkAbandoned(item) { return setMark(item, 'abandoned', false); }
  function isAbandoned(item) { return isMarked(item, 'abandoned'); }
  function toggleMark(item, type) {
    if (isMarked(item, type)) { setMark(item, type, false); return false; }
    setMark(item, type, true); return true;
  }
  // 批量判定辅助：返回某类型下的主键集合（供搜索结果前端隐藏过滤）
  function getMarkedKeys(type) {
    type = (type === 'abandoned') ? 'abandoned' : 'watched';
    var d = loadMarks();
    return Object.keys(d[type] || {});
  }

  // ---------------------------------------------------------------- 导出
  SFV.collections = {
    getTabs: getTabs,
    getByTab: getByTab,
    getItems: getItems,
    getPosters: getPosters,
    listUserFolders: listUserFolders,
    createUserFolder: createUserFolder,
    renameUserFolder: renameUserFolder,
    deleteUserFolder: deleteUserFolder,
    addUserItem: addUserItem,
    removeUserItem: removeUserItem,
    getUserFolderItems: getUserFolderItems,
    // 看过 / 弃 标记
    markWatched: markWatched,
    unmarkWatched: unmarkWatched,
    isWatched: isWatched,
    markAbandoned: markAbandoned,
    unmarkAbandoned: unmarkAbandoned,
    isAbandoned: isAbandoned,
    toggleMark: toggleMark,
    getMarkedKeys: getMarkedKeys
  };
})(typeof window !== 'undefined' ? window : this);
