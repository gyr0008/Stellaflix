/*
 * Stellaflix 影视模块 — 片单数据引擎 (Step 5 片单功能)
 *
 * 数据策略（2026-09-19 收敛：删除 C 玩法用户片单夹）：
 *   - B 主干：TMDB 动态查询（discover / collection / list / trending / upcoming）
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

  // ---------------------------------------------------------------- 预置片单目录（2026-09-26 官方映射批：全量替换）
  // tab 归属即浮层 OVERLAY_TABS 的 4 类；每周新番走 BANGUMI 卡（online.openCalendar），不在本目录
  // 所有 collectionId / listId 均经 themoviedb.org 站内检索与 /list/{id} 页面逐一核实（禁臆测 ID）
  // type:
  //   'tmdb-trending'   → trending(mediaType, timeWindow)
  //   'tmdb-popular'    → popular(mediaType)   —— CATALOG 暂无条目，能力保留（海报墙 adapter 直调 tmdb.popular）
  //   'tmdb-upcoming'   → upcoming()
  //   'tmdb-collection' → getCollection(collectionId)          —— TMDB 官方合集
  //   'tmdb-list'       → getListAll(listId)                   —— 社区名榜（TMDB 无官方榜单体系，副标题标创建者）
  //   'tmdb-discover'   → discover(query)
  //   'static-list'     → A 补充：tmdbIds 数组，逐条 getDetails 补全
  //   'placeholder'     → 即将上线占位
  var CATALOG = [
    // ===== 推荐 (featured) =====
    { id: 'trending-week', title: '本周热门', sub: '全球观众正在看',
      type: 'tmdb-trending', mediaType: 'movie', timeWindow: 'week', tab: 'featured', warm: '#e74c3c' },
    { id: 'trending-tv-week', title: '本周热播剧', sub: '追剧不踩雷',
      type: 'tmdb-trending', mediaType: 'tv', timeWindow: 'week', tab: 'featured', warm: '#3498db' },
    { id: 'upcoming', title: '即将上映', sub: '值得期待的新片',
      type: 'tmdb-upcoming', tab: 'featured', warm: '#1abc9c' },

    // ===== 系列 (series) —— 25 个已核实 TMDB 官方合集（DC 209=站内 404 不存在，移入榜单社区榜 8005） =====
    { id: 'coll-mcu', title: '漫威电影宇宙', sub: '从钢铁侠到终局之战',
      type: 'tmdb-collection', collectionId: 86311, tab: 'series', warm: '#c0392b' },
    { id: 'coll-starwars', title: '星球大战系列', sub: '天行者传奇',
      type: 'tmdb-collection', collectionId: 10, tab: 'series', warm: '#f39c12' },
    { id: 'coll-harrypotter', title: '哈利·波特全集', sub: '霍格沃茨魔法世界',
      type: 'tmdb-collection', collectionId: 1241, tab: 'series', warm: '#1abc9c' },
    { id: 'coll-jurassic', title: '侏罗纪公园系列', sub: '恐龙复活冒险',
      type: 'tmdb-collection', collectionId: 328, tab: 'series', warm: '#27ae60' },
    { id: 'coll-fastfurious', title: '速度与激情系列', sub: '家庭与速度',
      type: 'tmdb-collection', collectionId: 9485, tab: 'series', warm: '#e67e22' },
    { id: 'coll-lotr', title: '指环王系列', sub: '中洲史诗',
      type: 'tmdb-collection', collectionId: 119, tab: 'series', warm: '#8e44ad' },
    { id: 'coll-hobbit', title: '霍比特人系列', sub: '史矛革与至尊魔戒前传',
      type: 'tmdb-collection', collectionId: 121938, tab: 'series', warm: '#9b59b6' },
    { id: 'coll-bond', title: '007 詹姆斯·邦德系列', sub: '银幕最伟大特工',
      type: 'tmdb-collection', collectionId: 645, tab: 'series', warm: '#2c3e50' },
    { id: 'coll-backtofuture', title: '回到未来系列', sub: '时间旅行经典',
      type: 'tmdb-collection', collectionId: 264, tab: 'series', warm: '#d35400' },
    { id: 'coll-toystory', title: '玩具总动员系列', sub: '玩具们的冒险',
      type: 'tmdb-collection', collectionId: 10194, tab: 'series', warm: '#f1c40f' },
    { id: 'coll-godfather', title: '教父系列', sub: '影史史诗黑帮传奇',
      type: 'tmdb-collection', collectionId: 230, tab: 'series', warm: '#7f8c8d' },
    { id: 'coll-pirates', title: '加勒比海盗系列', sub: '杰克船长的传奇',
      type: 'tmdb-collection', collectionId: 295, tab: 'series', warm: '#16a085' },
    { id: 'coll-matrix', title: '黑客帝国系列', sub: '超越现实的科幻觉醒',
      type: 'tmdb-collection', collectionId: 2344, tab: 'series', warm: '#00b894' },
    { id: 'coll-mission', title: '碟中谍系列', sub: '伊森·亨特特工宇宙',
      type: 'tmdb-collection', collectionId: 87359, tab: 'series', warm: '#e74c3c' },
    { id: 'coll-darkknight', title: '黑暗骑士三部曲', sub: '诺兰蝙蝠侠传奇',
      type: 'tmdb-collection', collectionId: 263, tab: 'series', warm: '#34495e' },
    { id: 'coll-batman', title: '蝙蝠侠系列电影', sub: '哥谭暗夜骑士',
      type: 'tmdb-collection', collectionId: 120794, tab: 'series', warm: '#2980b9' },
    { id: 'coll-kungfupanda', title: '功夫熊猫系列', sub: '阿宝的武侠世界',
      type: 'tmdb-collection', collectionId: 77816, tab: 'series', warm: '#27ae60' },
    { id: 'coll-despicable', title: '神偷奶爸系列', sub: '格鲁与女孩们',
      type: 'tmdb-collection', collectionId: 86066, tab: 'series', warm: '#9b59b6' },
    { id: 'coll-minions', title: '小黄人大眼萌系列', sub: '香蕉味欢乐',
      type: 'tmdb-collection', collectionId: 544669, tab: 'series', warm: '#f1c40f' },
    { id: 'coll-iceage', title: '冰川时代系列', sub: '史前动物爆笑冒险',
      type: 'tmdb-collection', collectionId: 8354, tab: 'series', warm: '#3498db' },
    { id: 'coll-transformers', title: '变形金刚系列', sub: '汽车人 vs 霸天虎',
      type: 'tmdb-collection', collectionId: 8650, tab: 'series', warm: '#c0392b' },
    { id: 'coll-fantasticbeasts', title: '神奇动物系列', sub: '魔法世界动物图鉴',
      type: 'tmdb-collection', collectionId: 435259, tab: 'series', warm: '#16a085' },
    { id: 'coll-spiderman', title: '蜘蛛侠系列（山姆·雷米）', sub: '能力越大责任越大',
      type: 'tmdb-collection', collectionId: 556, tab: 'series', warm: '#e74c3c' },
    { id: 'coll-asm', title: '超凡蜘蛛侠系列', sub: '加菲尔德版蛛侠',
      type: 'tmdb-collection', collectionId: 125574, tab: 'series', warm: '#2980b9' },
    { id: 'coll-spiderverse', title: '蜘蛛侠：平行宇宙系列', sub: '多元宇宙动画神作',
      type: 'tmdb-collection', collectionId: 573436, tab: 'series', warm: '#e91e63' },

    // ===== 榜单 (lists) —— 社区名榜（TMDB 无官方榜单，来源与创建者明示）；中国奖项占位卡已删（2026-09-26 用户裁定）=====
    { id: 'list-imdb250', title: 'IMDb Top 250', sub: '社区榜 · Fernando K',
      type: 'tmdb-list', listId: 634, tab: 'lists', warm: '#f5c518' },
    { id: 'list-oscars', title: '历届奥斯卡最佳影片', sub: '社区榜 · travisbell',
      type: 'tmdb-list', listId: 28, tab: 'lists', warm: '#f1c40f' },
    { id: 'list-afi-thriller', title: 'AFI 百大惊悚片', sub: '社区榜 · endtheme',
      type: 'tmdb-list', listId: 43, tab: 'lists', warm: '#34495e' },
    { id: 'list-afi-comedy', title: 'AFI 百大喜剧片', sub: '社区榜 · Filmsomniac',
      type: 'tmdb-list', listId: 3682, tab: 'lists', warm: '#e67e22' },
    { id: 'list-dceu', title: 'DC 扩展宇宙', sub: '社区榜 · Harish-P',
      type: 'tmdb-list', listId: 8005, tab: 'lists', warm: '#2980b9' },
    { id: 'top-rated', title: 'TMDB 高分榜', sub: '全球用户口碑最佳',
      type: 'tmdb-discover', query: { sort_by: 'vote_average.desc', 'vote_count.gte': '5000' }, tab: 'lists', warm: '#1abc9c' },
    // ===== 榜单恢复卡（2026-09-26 用户点名）：影史百大 + 年度高分×5 + 奥斯卡 static 10 部 =====
    { id: 'classic-alltime', title: '影史百大', sub: '永远的经典',
      type: 'tmdb-discover', query: { 'sort_by': 'vote_average.desc', 'vote_average.gte': '8.0', 'vote_count.gte': '3000' }, tab: 'lists', warm: '#f1c40f' },
    { id: 'top-2024', title: '2024 年评分最高', sub: '年度佳片',
      type: 'tmdb-discover', query: { 'primary_release_year': '2024', 'sort_by': 'vote_average.desc', 'vote_count.gte': '200' }, tab: 'lists', warm: '#1abc9c' },
    { id: 'top-2023', title: '2023 年评分最高', sub: '年度佳片',
      type: 'tmdb-discover', query: { 'primary_release_year': '2023', 'sort_by': 'vote_average.desc', 'vote_count.gte': '200' }, tab: 'lists', warm: '#3498db' },
    { id: 'top-2022', title: '2022 年评分最高', sub: '年度佳片',
      type: 'tmdb-discover', query: { 'primary_release_year': '2022', 'sort_by': 'vote_average.desc', 'vote_count.gte': '200' }, tab: 'lists', warm: '#e67e22' },
    { id: 'top-2021', title: '2021 年评分最高', sub: '年度佳片',
      type: 'tmdb-discover', query: { 'primary_release_year': '2021', 'sort_by': 'vote_average.desc', 'vote_count.gte': '200' }, tab: 'lists', warm: '#9b59b6' },
    { id: 'top-2020s', title: '2020 至今高分', sub: '近五年口碑佳片',
      type: 'tmdb-discover', query: { 'primary_release_date.gte': '2020-01-01', 'sort_by': 'vote_average.desc', 'vote_average.gte': '7.8', 'vote_count.gte': '500' }, tab: 'lists', warm: '#2ecc71' },
    { id: 'oscar-best-picture', title: '奥斯卡最佳影片', sub: '历届最高荣誉',
      type: 'static-list', tmdbIds: [19404, 424, 11216, 70160, 524, 278, 238, 389, 13, 105], tab: 'lists', warm: '#f1c40f' },

    // ===== 类型 (genres) —— 类型导航体系 =====
    { id: 'genre-action', title: '火爆动作', sub: '拳拳到肉',
      type: 'tmdb-discover', query: { with_genres: '28', sort_by: 'vote_average.desc', 'vote_count.gte': '500' }, tab: 'genres', warm: '#e74c3c' },
    { id: 'genre-comedy', title: '欢乐喜剧', sub: '解压必备',
      type: 'tmdb-discover', query: { with_genres: '35', sort_by: 'vote_average.desc', 'vote_count.gte': '500' }, tab: 'genres', warm: '#f39c12' },
    { id: 'genre-animation', title: '动画电影精选', sub: '不止给孩子看',
      type: 'tmdb-discover', query: { with_genres: '16', sort_by: 'vote_average.desc', 'vote_count.gte': '200' }, tab: 'genres', warm: '#e91e63' },
    { id: 'genre-drama', title: '剧情佳作', sub: '人性深度',
      type: 'tmdb-discover', query: { with_genres: '18', sort_by: 'vote_average.desc', 'vote_count.gte': '500' }, tab: 'genres', warm: '#9b59b6' },
    { id: 'genre-romance', title: '浪漫爱情', sub: '心动瞬间',
      type: 'tmdb-discover', query: { with_genres: '10749', sort_by: 'vote_average.desc', 'vote_count.gte': '500' }, tab: 'genres', warm: '#ff6b81' },
    { id: 'genre-scifi', title: '科幻 & 太空冒险', sub: '浩瀚宇宙',
      type: 'tmdb-discover', query: { with_genres: '878', sort_by: 'vote_average.desc', 'vote_count.gte': '500' }, tab: 'genres', warm: '#2c3e50' },
    { id: 'genre-horror', title: '恐怖惊悚', sub: '胆大慎入',
      type: 'tmdb-discover', query: { with_genres: '27', sort_by: 'vote_average.desc', 'vote_count.gte': '500' }, tab: 'genres', warm: '#2d3436' },
    { id: 'genre-mystery', title: '悬疑烧脑', sub: '反转不断',
      type: 'tmdb-discover', query: { with_genres: '9648', sort_by: 'vote_average.desc', 'vote_count.gte': '500' }, tab: 'genres', warm: '#34495e' },
    { id: 'genre-crime', title: '烧脑犯罪 & 悬疑', sub: '反转不断',
      type: 'tmdb-discover', query: { with_genres: '80', sort_by: 'vote_average.desc', 'vote_count.gte': '300' }, tab: 'genres', warm: '#2c3e50' },
    { id: 'genre-family', title: '合家欢', sub: '全家一起看',
      type: 'tmdb-discover', query: { with_genres: '10751', sort_by: 'vote_average.desc', 'vote_count.gte': '500' }, tab: 'genres', warm: '#1abc9c' },
    { id: 'genre-war', title: '战争史诗', sub: '烽火岁月',
      type: 'tmdb-discover', query: { with_genres: '10752', sort_by: 'vote_average.desc', 'vote_count.gte': '500' }, tab: 'genres', warm: '#c0392b' }
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
        listId: c.listId,
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
      case 'tmdb-list':
        if (!def.listId) return Promise.reject(new Error('TMDB_NO_ID'));
        if (typeof tmdb.getListAll !== 'function') return Promise.reject(new Error('TMDB_LIST_UNSUPPORTED'));
        return tmdb.getListAll(def.listId).then(function (r) { return (r && r.items) || []; });
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

  // 海报平均色：同 URL 复用在途/已完成 promise，失败不进缓存（与 getItems 同策略）。
  // 入参可为条目对象或其 poster URL；实际请求经 SFV.tmdb.getPosterColor → /api/image-color。
  var colorCache = {}; // poster -> promise
  function getPosterColor(posterOrItem) {
    var poster = posterOrItem && typeof posterOrItem === 'object' ? posterOrItem.poster : posterOrItem;
    if (!poster) return Promise.reject(new Error('COLOR_NO_POSTER'));
    if (colorCache[poster]) return colorCache[poster];
    var tmdb = SFV.tmdb;
    if (!tmdb || typeof tmdb.getPosterColor !== 'function') return Promise.reject(new Error('COLOR_UNAVAILABLE'));
    var p = tmdb.getPosterColor(poster).catch(function (e) {
      if (colorCache[poster] === p) delete colorCache[poster];
      throw e;
    });
    colorCache[poster] = p;
    return p;
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
    getPosterColor: getPosterColor,
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
