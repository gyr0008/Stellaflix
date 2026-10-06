/*
 * Stellaflix 影视模块 — 世界页灯塔实时热映源（轮㉖b，用户批准 2026-10-04）
 *
 * 每座灯塔 = 该国自己的热门电影。主链 TMDB /discover/movie
 * （with_origin_country=本国 + sort_by=popularity.desc + 近3年窗）；
 * 无未占用结果 → 宽窗 discover（去日期参）→ 仍无 → /movie/popular?region=XX 兜底。
 * 根因备忘：/movie/popular?region 只按"该国上映过"过滤、排序仍是全球流行度
 * （TMDB 论坛版主确认），直接当分国榜会让 16 塔全显同一部全球爆款。
 * 跨国去重：按 COUNTRIES 序串行装配，claimed 集合存电影 id，撞车取下一部。
 * 单国全链失败保留旧条目；全败且无缓存 → stations() 空数组，
 * 由 world-data 回落 DEMO_ROOMS（铁律不删）。
 * 缓存：localStorage world-movies-v2 = {ts, stations}，冷启动秒出 + 6h TTL 重拉；
 * v2 换键使旧 v1「全蜘蛛侠」快照在 TTL 内自动作废。
 * 已知代价（验收报告点名）：TMDB key 在用户 localStorage，无 key 恒走演示回落；
 * coverUrl 用 image.tmdb.org w780 直链（posterUrl 的代理链会丢提色 CORS 判别）。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  var LS_KEY = 'world-movies-v2';
  var TTL_MS = 6 * 3600 * 1000;
  var WINDOW_DAYS = 1095; // 近 3 年

  // 16 国（TMDB 有地区热门数据的较大国家集；无 CN——已按裁决换成更大集）
  var COUNTRIES = [
    { cc: 'US', city: '纽约', country: '美国', lon: -74.01, lat: 40.71 },
    { cc: 'GB', city: '伦敦', country: '英国', lon: -0.13, lat: 51.51 },
    { cc: 'FR', city: '巴黎', country: '法国', lon: 2.35, lat: 48.86 },
    { cc: 'DE', city: '柏林', country: '德国', lon: 13.40, lat: 52.52 },
    { cc: 'IT', city: '罗马', country: '意大利', lon: 12.50, lat: 41.90 },
    { cc: 'ES', city: '马德里', country: '西班牙', lon: -3.70, lat: 40.42 },
    { cc: 'JP', city: '东京', country: '日本', lon: 139.69, lat: 35.69 },
    { cc: 'KR', city: '首尔', country: '韩国', lon: 126.98, lat: 37.57 },
    { cc: 'IN', city: '孟买', country: '印度', lon: 72.88, lat: 19.08 },
    { cc: 'BR', city: '里约', country: '巴西', lon: -43.17, lat: -22.91 },
    { cc: 'MX', city: '墨西哥城', country: '墨西哥', lon: -99.13, lat: 19.43 },
    { cc: 'AU', city: '悉尼', country: '澳大利亚', lon: 151.21, lat: -33.87 },
    { cc: 'CA', city: '多伦多', country: '加拿大', lon: -79.38, lat: 43.65 },
    { cc: 'RU', city: '莫斯科', country: '俄罗斯', lon: 37.62, lat: 55.76 },
    { cc: 'TR', city: '伊斯坦布尔', country: '土耳其', lon: 28.98, lat: 41.01 },
    { cc: 'NL', city: '阿姆斯特丹', country: '荷兰', lon: 4.90, lat: 52.37 }
  ];

  var stations = [];
  var ts = 0;

  function ls() {
    try { return global.localStorage || null; } catch (e) { return null; }
  }

  function readSnapshot() {
    var store = ls();
    if (!store) return;
    try {
      var raw = store.getItem(LS_KEY);
      if (!raw) return;
      var snap = JSON.parse(raw);
      if (snap && Array.isArray(snap.stations)) {
        stations = snap.stations;
        ts = Number(snap.ts) || 0;
      }
    } catch (e) { /* 坏快照静默忽略，等重拉覆盖 */ }
  }

  function writeSnapshot() {
    var store = ls();
    if (!store) return;
    try { store.setItem(LS_KEY, JSON.stringify({ ts: ts, stations: stations })); } catch (e) {}
  }

  // hearthere 收听数语义的本地等价：popularity 对数折算，1..9 收敛
  function peopleFor(popularity) {
    return Math.min(9, Math.max(1, Math.round(Math.log10((Number(popularity) || 0) + 1))));
  }

  function pickMovie(list, claimed) {
    if (!Array.isArray(list)) return null;
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (m && !m.adult && m.posterPath && m.title && !claimed[m.id]) return m;
    }
    return null;
  }

  function stationFor(c, movie) {
    return {
      cc: c.cc,
      id: 'r-' + c.cc,
      roomId: 'room-' + c.cc.toLowerCase(),
      name: c.city,
      lon: c.lon,
      lat: c.lat,
      status: 'playing',
      title: '《' + movie.title + '》',
      people: peopleFor(movie.popularity),
      alwaysExpanded: true,
      ownerType: 'system',
      countryCode: c.cc,
      city: c.city,
      country: c.country,
      coverUrl: 'https://image.tmdb.org/t/p/w780' + movie.posterPath,
      descriptionZh: movie.overview || ''
    };
  }

  // 三级链：近3年窗 discover → 宽窗 discover → popular(region) 兜底。
  // 每级失败/无未占用片进下一级；全链落空 → 保留旧条目。命中即占 claimed。
  function takeOne(c, tmdb, gte, claimed) {
    function use(list) {
      var m = pickMovie(list, claimed);
      if (!m) return null;
      claimed[m.id] = true;
      return stationFor(c, m);
    }
    function swallow(list) { return use(list); }
    return tmdb.discover({
      with_origin_country: c.cc,
      sort_by: 'popularity.desc',
      'primary_release_date.gte': gte
    }).then(swallow, function () { return null; })
      .then(function (st) {
        if (st) return st;
        return tmdb.discover({
          with_origin_country: c.cc,
          sort_by: 'popularity.desc'
        }).then(swallow, function () { return null; });
      })
      .then(function (st) {
        if (st) return st;
        if (!tmdb.popular) return null;
        return tmdb.popular('movie', 1, { region: c.cc }).then(swallow, function () { return null; });
      });
  }

  function refresh() {
    if (ts && Date.now() - ts < TTL_MS) return Promise.resolve(false);
    var tmdb = SFV.tmdb;
    if (!tmdb || !tmdb.discover) return Promise.resolve(false);
    var old = {};
    stations.forEach(function (s) { if (s && s.cc) old[s.cc] = s; });
    var claimed = {};
    var gte = new Date(Date.now() - WINDOW_DAYS * 864e5).toISOString().slice(0, 10);
    var next = [];
    var chain = Promise.resolve();
    // 串行装配：跨国去重需要前国先占片（COUNTRIES 序即占位序）
    COUNTRIES.forEach(function (c) {
      chain = chain.then(function () {
        return takeOne(c, tmdb, gte, claimed).then(function (st) {
          if (st) next.push(st);
          else if (old[c.cc]) next.push(old[c.cc]);
        });
      });
    });
    return chain.then(function () {
      var changed = JSON.stringify(next) !== JSON.stringify(stations);
      if (changed) {
        stations = next;
        ts = Date.now();
        writeSnapshot();
      }
      return changed;
    });
  }

  readSnapshot();

  SFV.worldMovies = {
    COUNTRIES: COUNTRIES,
    stations: function () { return stations.slice(); },
    refresh: refresh
  };
})(typeof window !== 'undefined' ? window : globalThis);
