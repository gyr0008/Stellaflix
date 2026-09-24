/*
 * Stellaflix 影视模块 — 片单数据引擎 (Step 5 片单功能)
 *
 * 数据策略（2026-09-19 收敛：删除 C 玩法用户片单夹）：
 *   - B 主干：TMDB 动态查询（discover / collection / trending / upcoming）
 *   - A 补充：硬编码编辑精选（static-list，TMDB 无法用查询表达的策展片单）
 *
 * 对外 API（SFV.collections）：
 *   getByTab(tabId)                  → 该 tab 下的片单列表（含封面/计数占位）
 *   getItems(collDef)                → 该片单的影片列表（normalizeList 格式，喂 renderGrid）
 *
 * 合规：本文件零硬编码视频源；仅元数据（海报/简介）来自 TMDB，符合 §0.3。
 * 双态隔离：本模块不感知音乐态，仅由影视态页面调用。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  // ---------------------------------------------------------------- 预置片单目录（B 主干 + A 补充）
  // tab 归属即浮层 OVERLAY_TABS 的 5 类；每周新番走 BANGUMI 卡（online.openCalendar），不在本目录
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
      type: 'placeholder', tab: 'awards', warm: '#c0392b' }
  ];

  // ---------------------------------------------------------------- 观看标记（看过 / 弃）
  // 独立键，不与（已删除的）用户片单夹耦合，便于搜索结果前端过滤
  var MARKS_KEY = 'stellaflix-view-marks';
  var LS = global.localStorage;

  // ---------------------------------------------------------------- 对外方法
  function getByTab(tabId) {
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
  // 内存缓存：封面回填与二级页共用在途/已完成结果；static-list 逐条 getDetails，
  // 不缓存则每次开浮层/切 tab 都是请求风暴。失败不进缓存（下次重试）。
  var ITEMS_TTL_MS = 10 * 60 * 1000;
  var itemsCache = {}; // def.id -> { ts, promise }
  function getItems(def) {
    if (!def || !def.id) return fetchItems(def);
    var hit = itemsCache[def.id];
    if (hit && Date.now() - hit.ts < ITEMS_TTL_MS) return hit.promise;
    var entry = { ts: Date.now(), promise: null };
    entry.promise = fetchItems(def).catch(function (e) {
      if (itemsCache[def.id] === entry) delete itemsCache[def.id];
      throw e;
    });
    itemsCache[def.id] = entry;
    return entry.promise;
  }

  function fetchItems(def) {
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
    getByTab: getByTab,
    getItems: getItems,
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
