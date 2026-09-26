/**
 * 影视态 FOR YOU「为你挑选」条带：当下最热 / 高分电影 / 每周新番 三张代表作品卡。
 * 纯选卡函数 + 日级 localStorage 缓存；取数复用 SFV.tmdb 与 SFV.bangumi。
 */
(function (global) {
  'use strict';

  var CACHE_KEY = 'stellaflix-home-video-discovery-v1';
  var WEEK = ['一', '二', '三', '四', '五', '六', '日'];
  var POOL_LIMIT = 12;

  function dayKey(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function usableTmdb(item) {
    return !!(item && !item.adult
      && String(item.title || '').trim()
      && String(item.poster || '').trim());
  }

  function tmdbCard(slot, item, reason) {
    var meta = {
      id: item.id,
      mediaType: item.mediaType || 'movie',
      title: String(item.title).trim(),
      poster: item.poster,
      year: item.year || '',
      rating: item.rating || 0
    };
    return { slot: slot, title: meta.title, cover: item.poster, reason: reason, meta: meta };
  }

  function pickRotated(list, offset) {
    if (!list.length) return null;
    return list[((offset % list.length) + list.length) % list.length];
  }

  // calendar: Array<7> 索引 0=周一..6=周日；从今天起顺延（回绕）展平为 [{item, dayIdx}]
  function flattenCalendar(calendar, now) {
    var days = Array.isArray(calendar) ? calendar : [];
    if (days.length !== 7) return [];
    var todayIdx = (new Date(now).getDay() + 6) % 7;
    var pool = [];
    for (var i = 0; i < 7; i++) {
      var dayIdx = (todayIdx + i) % 7;
      var list = Array.isArray(days[dayIdx]) ? days[dayIdx] : [];
      for (var j = 0; j < list.length; j++) {
        var item = list[j];
        if (item && String(item.title || item.name || '').trim()) {
          pool.push({ item: item, dayIdx: dayIdx });
        }
      }
    }
    return pool;
  }

  function pickVideoDiscoveryCards(ctx) {
    if (!ctx) return [];
    var offset = Number(ctx.offset) || 0;
    var now = ctx.now || Date.now();
    var cards = [];

    var trending = (Array.isArray(ctx.trending) ? ctx.trending : []).filter(usableTmdb);
    var hot = pickRotated(trending, offset);
    if (hot) cards.push(tmdbCard('hot', hot, '当下最热 · TMDB 本周趋势'));

    var highscore = (Array.isArray(ctx.highscore) ? ctx.highscore : []).filter(usableTmdb);
    var high = pickRotated(highscore, offset);
    if (high) {
      var score = Number(high.rating) || 0;
      cards.push(tmdbCard('high', high, '高分 ★ ' + score.toFixed(1) + ' · 口碑之选'));
    }

    var bgmPool = flattenCalendar(ctx.calendar, now);
    var bgm = pickRotated(bgmPool, offset);
    if (bgm) {
      var item = bgm.item;
      var pic = item.poster || '';
      var title = String(item.title || item.name || '').trim();
      cards.push({
        slot: 'bangumi',
        title: title,
        cover: pic,
        reason: 'Bangumi 周' + WEEK[bgm.dayIdx] + '放送 · 每周更新',
        meta: {
          key: 'bangumi:' + item.id,
          title: title,
          pic: pic,
          year: String(item.airDate || '').slice(0, 4),
          mediaType: 'tv'
        }
      });
    }

    return cards;
  }

  function readDayCache(ls, now) {
    try {
      if (!ls) return null;
      var raw = ls.getItem(CACHE_KEY);
      if (!raw) return null;
      var hit = JSON.parse(raw);
      if (!hit || hit.date !== dayKey(now || Date.now())) return null;
      if (!hit.pools) return null;
      return hit;
    } catch (e) { return null; }
  }

  function writeDayCache(ls, pools, now) {
    try {
      if (!ls) return;
      ls.setItem(CACHE_KEY, JSON.stringify({ date: dayKey(now || Date.now()), pools: pools }));
    } catch (e) {}
  }

  // ---------------------------------------------------------------- 运行期（浏览器）
  var _offset = 0;
  var _loading = false;

  function hasAnyPool(pools) {
    return !!(pools && (
      (pools.trending && pools.trending.length) ||
      (pools.highscore && pools.highscore.length) ||
      (pools.calendar && pools.calendar.length)
    ));
  }

  function ensureLoaded(onReady) {
    if (_loading) return;
    var SFV = global.StellaflixVideo;
    var tmdb = SFV && SFV.tmdb;
    var bangumi = SFV && SFV.bangumi;
    if (!bangumi && (!tmdb || typeof tmdb.hasKey !== 'function' || !tmdb.hasKey())) return;
    _loading = true;
    var settled = function (p) { return Promise.resolve(p).catch(function () { return null; }); };
    var tmdbReady = tmdb && typeof tmdb.hasKey === 'function' && tmdb.hasKey();
    var pTrending = (tmdbReady && typeof tmdb.trending === 'function')
      ? settled(tmdb.trending('movie', 'week')) : Promise.resolve(null);
    var pHigh = (tmdbReady && typeof tmdb.discover === 'function')
      ? settled(tmdb.discover({ 'vote_average.gte': '8', 'vote_count.gte': '500', sort_by: 'vote_average.desc' })) : Promise.resolve(null);
    var pCalendar = (bangumi && typeof bangumi.getCalendar === 'function')
      ? settled(bangumi.getCalendar()) : Promise.resolve(null);
    Promise.all([pTrending, pHigh, pCalendar]).then(function (res) {
      var pools = {
        trending: (Array.isArray(res[0]) ? res[0] : []).slice(0, POOL_LIMIT),
        highscore: (Array.isArray(res[1]) ? res[1] : []).slice(0, POOL_LIMIT),
        calendar: (res[2] && Array.isArray(res[2].calendar)) ? res[2].calendar : []
      };
      if (hasAnyPool(pools)) {
        writeDayCache(global.localStorage, pools, Date.now());
        if (typeof onReady === 'function') onReady();
      }
    }).catch(function () { }).then(function () {
      _loading = false;
    });
  }

  function getCards() {
    var now = Date.now();
    var hit = readDayCache(global.localStorage, now);
    if (!hit) {
      ensureLoaded(function () {
        if (typeof global.renderHomeDashboardDiscovery === 'function') global.renderHomeDashboardDiscovery();
      });
      return null;
    }
    return pickVideoDiscoveryCards({
      trending: hit.pools.trending,
      highscore: hit.pools.highscore,
      calendar: hit.pools.calendar,
      now: now,
      offset: _offset
    });
  }

  function rotate() {
    _offset += 1;
    return getCards();
  }

  global.StellaflixHomeVideoDiscovery = {
    pickVideoDiscoveryCards: pickVideoDiscoveryCards,
    readDayCache: readDayCache,
    writeDayCache: writeDayCache,
    getCards: getCards,
    rotate: rotate
  };
})(typeof window !== 'undefined' ? window : this);
