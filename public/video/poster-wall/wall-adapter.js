/*
 * Stellaflix 影视片库 — 海报墙数据适配
 *
 * P0 主数据源：TMDB 多品类海报（热门/趋势/剧集/即将上映/各电影类型）。
 * 历史/片单夹/心动仅作补充叠加，不再作为主展示内容。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  if (SFV.posterWallAdapter) return;

  var CATEGORY_JOBS = [
    { label: '本周热门电影', run: function (t) { return t.popular('movie'); } },
    { label: '本周趋势电影', run: function (t) { return t.trending('movie', 'week'); } },
    { label: '本周热播剧集', run: function (t) { return t.trending('tv', 'week'); } },
    { label: '即将上映', run: function (t) { return t.upcoming(); } },
    { label: '动作', run: function (t) { return t.discover({ with_genres: '28', sort_by: 'popularity.desc' }); } },
    { label: '科幻', run: function (t) { return t.discover({ with_genres: '878', sort_by: 'popularity.desc' }); } },
    { label: '动画', run: function (t) { return t.discover({ with_genres: '16', sort_by: 'popularity.desc' }); } },
    { label: '喜剧', run: function (t) { return t.discover({ with_genres: '35', sort_by: 'popularity.desc' }); } },
    { label: '悬疑惊悚', run: function (t) { return t.discover({ with_genres: '9648', sort_by: 'popularity.desc' }); } },
    { label: '高分剧情', run: function (t) { return t.discover({ with_genres: '18', 'vote_average.gte': '7.5', 'vote_count.gte': '200', sort_by: 'vote_average.desc' }); } }
  ];

  function posterOf(it) {
    return it && (it.poster || it.pic || it.img || it.cover || '') || '';
  }

  function toast(msg) {
    if (SFV.online && SFV.online.toast) { try { SFV.online.toast(msg); return; } catch (e) {} }
    if (SFV.ui && SFV.ui.toast) { try { SFV.ui.toast(msg); return; } catch (e) {} }
    if (global.console) console.warn('[posterWallAdapter]', msg);
  }

  function normalizeTmdb(raw, label, mediaType) {
    if (!raw || raw.id == null) return null;
    var mt = raw.mediaType || mediaType || 'movie';
    return {
      id: 'tmdb:' + mt + ':' + raw.id,
      title: raw.title || raw.name || '未命名',
      year: raw.year || '',
      rating: raw.rating || raw.voteAverage || 0,
      poster: posterOf(raw),
      section: 'catalog',
      sectionLabel: label,
      category: label,
      mediaType: mt,
      tmdbId: raw.id,
      source: 'tmdb',
      progress: 0,
      key: '',
      meta: {
        id: raw.id,
        mediaType: mt,
        title: raw.title || raw.name,
        year: raw.year || '',
        poster: posterOf(raw),
        rating: raw.rating || 0,
        overview: raw.overview || ''
      }
    };
  }

  /** TMDB 多品类并行拉取；单类失败不拖垮整墙。 */
  function collectTmdbWallItems() {
    var t = SFV.tmdb;
    if (!t) return Promise.resolve({ items: [], keyMissing: true, errors: ['tmdb module missing'] });

    if (!t.hasKey || !t.hasKey()) {
      return Promise.resolve({ items: [], keyMissing: true, errors: [] });
    }

    var seen = {};
    var items = [];
    var errors = [];

    function mergeBatch(list, label, mediaType) {
      (list || []).forEach(function (raw) {
        var item = normalizeTmdb(raw, label, mediaType);
        if (!item) return;
        if (seen[item.id]) return;
        // 优先保留有海报的条目
        if (!item.poster) return;
        seen[item.id] = true;
        items.push(item);
      });
    }

    var jobs = CATEGORY_JOBS.map(function (job) {
      return Promise.resolve()
        .then(function () { return job.run(t); })
        .then(function (list) {
          var mt = job.label.indexOf('剧') >= 0 ? 'tv' : 'movie';
          mergeBatch(list, job.label, mt);
        })
        .catch(function (err) {
          errors.push(job.label + ': ' + (err && err.message ? err.message : String(err)));
        });
    });

    return Promise.all(jobs).then(function () {
      // 品类顺序：保持 CATEGORY_JOBS 定义顺序
      var order = CATEGORY_JOBS.map(function (c) { return c.label; });
      items.sort(function (a, b) {
        var ia = order.indexOf(a.sectionLabel);
        var ib = order.indexOf(b.sectionLabel);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
      return { items: items, keyMissing: false, errors: errors };
    });
  }

  /** 可选：叠加用户已有历史（TMDB 成功时仍展示，但排在品类墙之后）。 */
  function collectLocalExtras() {
    var list = [];
    var seen = {};
    function push(item) {
      if (!item || !item.id || seen[item.id]) return;
      seen[item.id] = true;
      list.push(item);
    }
    try {
      var hist = (SFV.watchHistory && SFV.watchHistory.getAll) ? SFV.watchHistory.getAll() : [];
      hist.forEach(function (h) {
        if (!h || !h.title) return;
        push({
          id: h.key || ('hist:' + h.title),
          title: h.title,
          year: h.year || '',
          rating: 0,
          poster: posterOf(h) || h.pic || '',
          section: (h.progress > 0 && h.progress < 1) ? 'continue' : 'other',
          sectionLabel: '接着看',
          category: '接着看',
          source: 'history',
          progress: h.progress || 0,
          key: h.key || '',
          mediaType: 'movie',
          meta: {
            key: h.key,
            title: h.title,
            pic: posterOf(h) || h.pic || '',
            year: h.year || '',
            sourceId: h.sourceId || h.lastSourceId || '',
            vodId: h.vodId != null ? h.vodId : (h.lastVodId != null ? h.lastVodId : '')
          }
        });
      });
    } catch (e) { /* ignore */ }
    return list;
  }

  function collectWallItems() {
    // 同步兜底：仅本地补充（无 TMDB key 时展示空态提示由 DOM 层处理）
    return collectLocalExtras();
  }

  function collectWallItemsAsync() {
    return collectTmdbWallItems().then(function (res) {
      if (res.items && res.items.length) {
        var extras = collectLocalExtras().filter(function (e) {
          return !res.items.some(function (i) { return i.id === e.id; });
        });
        // 本地补充放在最后，品类墙优先
        return { items: res.items.concat(extras), keyMissing: false, errors: res.errors };
      }
      return {
        items: collectLocalExtras(),
        keyMissing: res.keyMissing,
        errors: res.errors
      };
    });
  }

  function formatMetaLine(item) {
    var bits = [];
    if (item.category || item.sectionLabel) bits.push(item.category || item.sectionLabel);
    if (item.year) bits.push(String(item.year));
    if (item.rating) bits.push('★ ' + (Math.round(Number(item.rating) * 10) / 10));
    if (item.section === 'continue' && item.progress) {
      bits.push('继续看 ' + Math.round(item.progress * 100) + '%');
    }
    return bits.join(' · ');
  }

  function openDetail(item) {
    if (!item) return false;
    var meta = item.meta || {
      id: item.tmdbId || item.id,
      mediaType: item.mediaType || 'movie',
      title: item.title,
      poster: item.poster,
      year: item.year,
      rating: item.rating
    };
    if (SFV.online && typeof SFV.online.openDetailFromMeta === 'function') {
      try {
        SFV.online.openDetailFromMeta(meta);
        return true;
      } catch (e) {
        toast('详情打开失败');
        return false;
      }
    }
    // 兜底：用 TMDB 搜索进浏览
    if (SFV.online && typeof SFV.online.openSearchPage === 'function') {
      try {
        SFV.online.openSearchPage();
        if (SFV.online.doInlineSearch) SFV.online.doInlineSearch(item.title);
        return true;
      } catch (e2) { /* fallthrough */ }
    }
    toast('浏览模块未就绪');
    return false;
  }

  function playOrResume(item) {
    if (!item) return false;
    var HC = SFV.homeContinueWatching;
    if (item.section === 'continue' && item.key && HC && typeof HC.resumeFromHistory === 'function') {
      HC.resumeFromHistory(item.key);
      return true;
    }
    // TMDB 目录条目：先进详情（片源选择在详情页完成）
    return openDetail(item);
  }

  function openTmdbKeySettings() {
    if (SFV.tmdb && typeof SFV.tmdb.openKeySettings === 'function') {
      SFV.tmdb.openKeySettings();
      return true;
    }
    toast('请在设置中填写 TMDB API Key');
    return false;
  }

  SFV.posterWallAdapter = {
    CATEGORY_JOBS: CATEGORY_JOBS,
    collectWallItems: collectWallItems,
    collectWallItemsAsync: collectWallItemsAsync,
    formatMetaLine: formatMetaLine,
    openDetail: openDetail,
    playOrResume: playOrResume,
    openTmdbKeySettings: openTmdbKeySettings
  };
})(typeof window !== 'undefined' ? window : this);
