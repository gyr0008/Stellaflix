/**
 * Stellaflix — Bangumi 时间表页面（移植自 Kazumi lib/pages/timeline/）
 *
 * 对齐 Kazumi 2.2.6 的 Timeline：
 *   - 一级页面（router page 'bangumi-timeline'），对应 Kazumi 底部导航第 2 项「时间表」
 *   - 页头显示季度字符串，点击打开「时间机器」（20 年 × 4 季，过滤未来季度）
 *   - 七日 TabBar（一~日），初始定位今天（Kazumi: initialIndex = weekday - 1）
 *   - 单日网格：横向大卡片（海报 + 标题 + 3 行简介 + 评分/排名/热度）
 *   - 排序：1 = 时间(id) / 2 = 评分(ratingScore) / 3 = 热度(votes)，默认 3
 *     —— 注意：热度按 votes 降序，与 Kazumi changeSortType case 3 一致；
 *        旧的 bangumi-calendar.js 按 rank 升序，属标签与实现不符，此处已修正。
 *   - 过滤器：隐藏已抛弃 / 隐藏已看过 / 只看在看，持久化到 localStorage
 *
 * 数据：SFV.bangumi（当季 getCalendar，往季 getSeasonCalendar）
 * 季度：SFV.bangumiSeason（移植自 Kazumi AnimeSeason）
 * 追番：SFV.model 六态（key = bangumi:<id>）；加入片单功能已删除
 *
 * 约定：kazumi/ 内部不改；本文件为目录外新增。
 * @license GPL-3.0
 */
(function (global) {
  'use strict';
  if (!global.StellaflixVideo) global.StellaflixVideo = {};
  var SFV = global.StellaflixVideo;
  var doc = global.document;

  var WEEK = ['一', '二', '三', '四', '五', '六', '日'];
  var SORTS = [
    { k: 1, label: '时间' },
    { k: 2, label: '评分' },
    { k: 3, label: '热度' }
  ];
  var PREFS_KEY = 'stellaflix-bgm-timeline-prefs';
  var PAGE_ID = 'bangumi-timeline';

  var trackToast = global.toast || function (m) { console.log('[bgm-tl]', m); };

  function trackKey(item) { return 'bangumi:' + item.id; }

  var _state = {
    sortMode: 3,
    filters: { hideAbandoned: false, hideWatched: false, onlyWatching: false },
    data: null,          // Array<Array<item>> 索引 0..6 = 周一..周日
    error: null,
    loading: false,
    selectedDate: new Date(),   // 季度锚点
    seasonString: '',
    isCurrentSeason: true,
    activeDay: (new Date().getDay() + 6) % 7   // 周一 = 0
  };

  var _host = null;        // 当前挂载宿主
  var _seasonSheet = null; // 时间机器面板

  // ---------------------------------------------------------------- 工具
  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---------------------------------------------------------------- 偏好持久化
  function loadPrefs() {
    try {
      var raw = global.localStorage ? global.localStorage.getItem(PREFS_KEY) : null;
      if (!raw) return;
      var p = JSON.parse(raw);
      if (p && typeof p.sortMode === 'number') _state.sortMode = p.sortMode;
      if (p && p.filters) {
        ['hideAbandoned', 'hideWatched', 'onlyWatching'].forEach(function (k) {
          if (typeof p.filters[k] === 'boolean') _state.filters[k] = p.filters[k];
        });
      }
    } catch (e) {}
  }
  function savePrefs() {
    try {
      if (!global.localStorage) return;
      global.localStorage.setItem(PREFS_KEY, JSON.stringify({
        sortMode: _state.sortMode,
        filters: _state.filters
      }));
    } catch (e) {}
  }

  // ---------------------------------------------------------------- 过滤 / 排序
  function buildFilterSets() {
    var m = SFV.model;
    if (!m || !m.getKeysByTrack) return { abandoned: {}, watched: {}, watching: {} };
    function toSet(arr) { var s = {}; (arr || []).forEach(function (k) { s[k] = 1; }); return s; }
    return {
      abandoned: toSet(m.getKeysByTrack('abandoned')),
      watched: toSet(m.getKeysByTrack('watched')),
      watching: toSet(m.getKeysByTrack('watching'))
    };
  }

  function passFilter(item, sets) {
    var key = trackKey(item);
    var f = _state.filters;
    if (f.hideAbandoned && sets.abandoned[key]) return false;
    if (f.hideWatched && sets.watched[key]) return false;
    if (f.onlyWatching && !sets.watching[key]) return false;
    return true;
  }

  function sortItems(list) {
    var mode = _state.sortMode;
    var arr = list.slice();
    if (mode === 2) {
      arr.sort(function (a, b) { return (b.ratingScore || 0) - (a.ratingScore || 0); });
    } else if (mode === 3) {
      // Kazumi: dayList.sort((a, b) => (b.votes).compareTo(a.votes))
      arr.sort(function (a, b) { return (b.votes || 0) - (a.votes || 0); });
    } else {
      // Kazumi: dayList.sort((a, b) => a.id.compareTo(b.id))
      arr.sort(function (a, b) { return (a.id || 0) - (b.id || 0); });
    }
    return arr;
  }

  // ---------------------------------------------------------------- 数据加载
  function load(cb) {
    if (!SFV.bangumi) {
      _state.error = 'Bangumi 模块未加载';
      if (cb) cb();
      return;
    }
    _state.loading = true;
    _state.error = null;
    var p = _state.isCurrentSeason
      ? SFV.bangumi.getCalendar()
      : SFV.bangumi.getSeasonCalendar(SFV.bangumiSeason.toSeasonStartAndEnd(_state.selectedDate));
    p.then(function (res) {
      _state.data = res.calendar || [];
      _state.error = res.error || null;
      _state.loading = false;
      if (cb) cb();
    }).catch(function (e) {
      _state.error = (e && e.message) || String(e);
      _state.loading = false;
      if (cb) cb();
    });
  }

  // ---------------------------------------------------------------- 渲染
  function mount(host) {
    _host = host;
    if (!host) return;
    host.innerHTML = '';
    loadPrefs();

    var wrap = el('div', 'sfv-bgm-tl');
    host.appendChild(wrap);

    render(wrap);

    if (!_state.data || !_state.data.length) load(function () { render(wrap); });
  }

  function render(wrap) {
    if (!wrap) return;
    wrap.innerHTML = '';
    wrap.appendChild(buildHead(wrap));
    wrap.appendChild(buildTabs(wrap));
    wrap.appendChild(buildBody(wrap));
  }

  /** 页头：季度字符串（点击打开时间机器）+ 工具条（排序/过滤） */
  function buildHead(wrap) {
    var head = el('div', 'sfv-bgm-tl-head');

    var seasonBtn = el('button', 'sfv-bgm-tl-season');
    seasonBtn.type = 'button';
    seasonBtn.appendChild(el('span', 'sfv-bgm-tl-season-text', _state.seasonString || '—'));
    seasonBtn.appendChild(el('span', 'sfv-bgm-tl-season-caret', '▾'));
    seasonBtn.addEventListener('click', function () { openSeasonSheet(wrap); });
    head.appendChild(seasonBtn);

    // 排序
    var sorts = el('div', 'sfv-bgm-tl-sorts');
    SORTS.forEach(function (s) {
      var b = el('button', 'sfv-bgm-chip' + (_state.sortMode === s.k ? ' active' : ''), s.label);
      b.type = 'button';
      b.addEventListener('click', function () {
        _state.sortMode = s.k;
        savePrefs();
        render(wrap);
      });
      sorts.appendChild(b);
    });
    head.appendChild(sorts);

    // 过滤
    var filtDefs = [
      { key: 'hideAbandoned', label: '隐藏已抛弃' },
      { key: 'hideWatched', label: '隐藏已看过' },
      { key: 'onlyWatching', label: '只看在看' }
    ];
    var filts = el('div', 'sfv-bgm-tl-filters');
    filtDefs.forEach(function (fd) {
      var b = el('button', 'sfv-bgm-chip' + (_state.filters[fd.key] ? ' active' : ''), fd.label);
      b.type = 'button';
      b.addEventListener('click', function () {
        _state.filters[fd.key] = !_state.filters[fd.key];
        savePrefs();
        render(wrap);
      });
      filts.appendChild(b);
    });
    head.appendChild(filts);

    var refresh = el('button', 'sfv-bgm-chip sfv-bgm-tl-refresh', '刷新');
    refresh.type = 'button';
    refresh.addEventListener('click', function () { render(wrap); load(function () { render(wrap); }); });
    head.appendChild(refresh);

    return head;
  }

  /** 七日 TabBar */
  function buildTabs(wrap) {
    var tabs = el('div', 'sfv-bgm-tl-tabs');
    WEEK.forEach(function (w, i) {
      var b = el('button', 'sfv-bgm-tl-tab' + (i === _state.activeDay ? ' active' : ''), '周' + w);
      b.type = 'button';
      b.addEventListener('click', function () {
        _state.activeDay = i;
        render(wrap);
      });
      tabs.appendChild(b);
    });
    return tabs;
  }

  /** 单日网格 */
  function buildBody(wrap) {
    var body = el('div', 'sfv-bgm-tl-body');

    if (_state.loading && (!_state.data || !_state.data.length)) {
      body.appendChild(el('div', 'sfv-bgm-tl-ph', '加载中…'));
      return body;
    }
    if (_state.error && (!_state.data || !_state.data.length)) {
      body.appendChild(el('div', 'sfv-bgm-tl-ph', 'Bangumi 日历加载失败：' + esc(_state.error)));
      return body;
    }
    if (!_state.data || !_state.data.length) {
      body.appendChild(el('div', 'sfv-bgm-tl-ph', '暂无放送数据'));
      return body;
    }

    var sets = buildFilterSets();
    var items = (_state.data[_state.activeDay] || []).filter(function (it) { return passFilter(it, sets); });
    items = sortItems(items);

    if (!items.length) {
      body.appendChild(el('div', 'sfv-bgm-tl-ph', '本日无符合条件的番剧'));
      return body;
    }

    var grid = el('div', 'sfv-bgm-tl-grid');
    items.forEach(function (it) { grid.appendChild(buildCard(it)); });
    body.appendChild(grid);
    return body;
  }

  /** 横向大卡片：海报 + 标题 + 3 行简介 + 评分/排名/热度 */
  function buildCard(item) {
    var card = el('div', 'sfv-bgm-tl-card');
    card.setAttribute('data-bgm-id', item.id);

    var img = doc.createElement('img');
    img.className = 'sfv-bgm-tl-poster';
    img.loading = 'lazy';
    img.alt = '';
    img.src = item.poster || '';
    img.addEventListener('error', function () { img.style.visibility = 'hidden'; });
    card.appendChild(img);

    var info = el('div', 'sfv-bgm-tl-info');
    info.appendChild(el('div', 'sfv-bgm-tl-title', item.title || item.name));

    var sub = (item.info && String(item.info).trim()) || item.summary || '';
    if (sub) {
      var sum = el('div', 'sfv-bgm-tl-summary', sub);
      info.appendChild(sum);
    }

    var metrics = el('div', 'sfv-bgm-tl-metrics');
    if (item.ratingScore) {
      metrics.appendChild(metric('★', item.ratingScore.toFixed(1), 'rate'));
    }
    if (item.rank) {
      metrics.appendChild(metric('#', String(item.rank), 'rank'));
    }
    if (item.votes) {
      metrics.appendChild(metric('▣', String(item.votes), 'votes'));
    }
    info.appendChild(metrics);
    card.appendChild(info);

    // 追番状态角标
    var status = (SFV.model && SFV.model.getTrackStatus) ? SFV.model.getTrackStatus(trackKey(item)) : null;
    var badge = el('div', 'sfv-bgm-tl-badge' + (status ? ' on st-' + status : ''));
    badge.innerHTML = (status && SFV.model.STATE_ICONS ? SFV.model.STATE_ICONS[status] : '') +
      (status && SFV.model.TRACK_LABELS ? SFV.model.TRACK_LABELS[status] : '追');
    card.appendChild(badge);

    card.addEventListener('click', function (e) {
      e.stopPropagation();
      // 弹窗模式下遮罩盖在详情页之上，须先关闭再跳转，否则视觉上「点了没反应」
      if (_modalOverlay) closePopup();
      // 走项目通用 Plex 风详情页（同「类似影片」入口）；追片身份 key = bangumi:<id> 与本页共用
      var S = SFV.onlineShared;
      if (S && typeof S.openDetailFromMeta === 'function') {
        S.openDetailFromMeta({
          key: trackKey(item),
          title: item.title || item.name || '',
          pic: item.poster || '',
          year: (item.airDate || '').slice(0, 4),
          mediaType: 'tv'
        });
        return;
      }
      if (SFV.bangumiInfo && typeof SFV.bangumiInfo.open === 'function') {
        SFV.bangumiInfo.open(item);
        return;
      }
      // 通用详情页未就绪时降级为追番弹层
      openPopover(card, item);
    });
    return card;
  }

  function metric(icon, text, cls) {
    var m = el('span', 'sfv-bgm-tl-metric' + (cls ? ' ' + cls : ''));
    m.appendChild(el('i', 'sfv-bgm-tl-metric-icon', icon));
    m.appendChild(el('span', null, text));
    return m;
  }

  // ---------------------------------------------------------------- 时间机器
  function openSeasonSheet(wrap) {
    closeSeasonSheet();
    if (!SFV.bangumiSeason) return;

    var mask = el('div', 'sfv-bgm-tl-sheet-mask');
    _seasonSheet = mask;

    var sheet = el('div', 'sfv-bgm-tl-sheet');

    var head = el('div', 'sfv-bgm-tl-sheet-head');
    head.appendChild(el('div', 'sfv-bgm-tl-sheet-title', '时间机器'));
    head.appendChild(el('div', 'sfv-bgm-tl-sheet-sub', '按季度回到任意放送季'));
    var closeBtn = el('button', 'sfv-bgm-tl-sheet-close', '×');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', closeSeasonSheet);
    head.appendChild(closeBtn);
    sheet.appendChild(head);

    var list = el('div', 'sfv-bgm-tl-sheet-list');
    var groups = SFV.bangumiSeason.listPastSeasons(20);
    groups.forEach(function (g) {
      var sec = el('div', 'sfv-bgm-tl-sheet-year');
      sec.appendChild(el('div', 'sfv-bgm-tl-sheet-year-label', g.year + '年'));
      var chips = el('div', 'sfv-bgm-tl-sheet-chips');
      g.dates.forEach(function (d) {
        var label = SFV.bangumiSeason.getSeasonStringByMonth(d.getMonth() + 1);
        var selected = SFV.bangumiSeason.isSameSeason(_state.selectedDate, d);
        var b = el('button', 'sfv-bgm-tl-sheet-chip' + (selected ? ' active' : ''), label);
        b.type = 'button';
        b.addEventListener('click', function () {
          closeSeasonSheet();
          onSeasonSelected(wrap, d);
        });
        chips.appendChild(b);
      });
      sec.appendChild(chips);
      list.appendChild(sec);
    });
    sheet.appendChild(list);

    mask.appendChild(sheet);
    mask.addEventListener('click', function (e) { if (e.target === mask) closeSeasonSheet(); });
    (doc.body || doc.documentElement).appendChild(mask);
  }

  function closeSeasonSheet() {
    if (_seasonSheet && _seasonSheet.parentNode) {
      try { _seasonSheet.parentNode.removeChild(_seasonSheet); } catch (e) {}
    }
    _seasonSheet = null;
  }

  function onSeasonSelected(wrap, date) {
    var now = new Date();
    _state.selectedDate = date;
    _state.seasonString = '加载中…';
    // Kazumi: 与当前同季 -> getSchedules()，否则 getSchedulesBySeason()
    _state.isCurrentSeason = SFV.bangumiSeason.isSameSeason(date, now);
    render(wrap);
    load(function () {
      _state.seasonString = SFV.bangumiSeason.seasonString(_state.selectedDate);
      render(wrap);
    });
  }

  // ---------------------------------------------------------------- 追番弹层
  var _pop = null;
  function closePop() {
    if (_pop && _pop.parentNode) _pop.parentNode.removeChild(_pop);
    _pop = null;
    doc.removeEventListener('click', onDocClick, true);
  }
  function onDocClick(e) { if (_pop && !_pop.contains(e.target)) closePop(); }

  function openPopover(anchor, item) {
    closePop();
    var pop = el('div', 'sfv-bgm-pop');
    _pop = pop;
    pop.appendChild(el('div', 'sfv-bgm-pop-title', item.title || item.name));

    var trackWrap = el('div', 'sfv-bgm-pop-track');
    var states = [{ key: null, label: '未追' }].concat(
      (SFV.model && SFV.model.TRACK_STATUSES || []).map(function (k) {
        return { key: k, label: (SFV.model.TRACK_LABELS && SFV.model.TRACK_LABELS[k]) || k };
      })
    );
    var cur = (SFV.model && SFV.model.getTrackStatus) ? SFV.model.getTrackStatus(trackKey(item)) : null;
    states.forEach(function (st) {
      var b = el('button', 'sfv-bgm-pop-state' + (st.key === cur ? ' active' : '') + (st.key ? ' st-' + st.key : ''));
      b.type = 'button';
      b.innerHTML = ((SFV.model && SFV.model.STATE_ICONS) ? SFV.model.STATE_ICONS[st.key || 'none'] : '') +
        '<span class="lbl">' + esc(st.label) + '</span>';
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (SFV.model && SFV.model.setTrackStatus) SFV.model.setTrackStatus(trackKey(item), st.key);
        trackToast(st.key ? ('已标记为「' + st.label + '」') : '已清除追番状态');
        closePop();
        if (_host) render(_host.firstChild);
      });
      trackWrap.appendChild(b);
    });
    pop.appendChild(trackWrap);

    var r = anchor.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.left = Math.min(r.left, global.innerWidth - 280) + 'px';
    pop.style.top = Math.min(r.bottom + 6, global.innerHeight - 240) + 'px';
    (doc.body || doc.documentElement).appendChild(pop);
    setTimeout(function () { doc.addEventListener('click', onDocClick, true); }, 0);
  }

  // ---------------------------------------------------------------- 弹窗模式
  // 与路由页共用同一套渲染逻辑：把时间表塞进居中玻璃弹窗。
  // 当前首页入口走 openPage()（整页，见计划阶段 4）；本弹窗保留供随时切换。
  var _modalOverlay = null;
  var _modalEsc = null;

  function closePopup() {
    if (!_modalOverlay) return;
    try {
      if (_modalOverlay.parentNode) _modalOverlay.parentNode.removeChild(_modalOverlay);
    } catch (e) {}
    _modalOverlay = null;
    if (_modalEsc && doc.removeEventListener) {
      try { doc.removeEventListener('keydown', _modalEsc, true); } catch (e) {}
      _modalEsc = null;
    }
    _host = null;
  }

  function openPopup() {
    if (_modalOverlay) return;
    if (!SFV.bangumiSeason) { console.warn('[bangumiTimeline] 季度模块未加载'); return; }

    var overlay = el('div', 'sfv-bgm-modal-overlay');
    _modalOverlay = overlay;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Bangumi 时间表');

    var modal = el('div', 'sfv-bgm-modal');
    var host = el('div');
    modal.appendChild(host);
    overlay.appendChild(modal);

    // 关闭方式仅两种：点击遮罩空白区域 / Esc（按用户要求已移除 × 按钮）
    overlay.addEventListener('click', function (ev) {
      if (ev.target === overlay) closePopup();
    });
    (doc.body || doc.documentElement).appendChild(overlay);

    _modalEsc = function (ev) {
      if (ev.key === 'Escape' || ev.keyCode === 27) closePopup();
    };
    doc.addEventListener('keydown', _modalEsc, true);

    _state.selectedDate = new Date();
    _state.isCurrentSeason = true;
    _state.seasonString = SFV.bangumiSeason.seasonString(_state.selectedDate);
    _state.activeDay = (new Date().getDay() + 6) % 7;
    mount(host);
  }

  // ---------------------------------------------------------------- 路由注册
  function openPage() {
    var S = SFV.onlineShared;
    if (S && typeof S.openPage === 'function') {
      S.openPage(PAGE_ID, '时间表');
      return;
    }
    if (SFV.router) SFV.router.go(PAGE_ID);
  }

  if (SFV.router) {
    SFV.router.register({
      id: PAGE_ID,
      title: '时间表',
      mount: function (host) {
        if (!SFV.bangumiSeason) {
          host.innerHTML = '<div class="sfv-bgm-tl-ph">季度模块未加载</div>';
          return;
        }
        // 首次进入初始化季度文案
        _state.selectedDate = new Date();
        _state.isCurrentSeason = true;
        _state.seasonString = SFV.bangumiSeason.seasonString(_state.selectedDate);
        _state.activeDay = (new Date().getDay() + 6) % 7;
        mount(host);
      },
      back: function () {
        // 时间机器面板打开时，返回键优先关闭面板
        if (_seasonSheet) { closeSeasonSheet(); return true; }
        if (_pop) { closePop(); return true; }
        return false;
      },
      unmount: function () {
        closeSeasonSheet();
        closePop();
        _host = null;
      }
    });
  }

  SFV.bangumiTimeline = {
    mount: mount,
    refresh: function () { if (_host) render(_host.firstChild); },
    openPage: openPage,
    openPopup: openPopup,
    closePopup: closePopup,
    openSeasonSheet: openSeasonSheet,
    _state: _state
  };
})(typeof window !== 'undefined' ? window : this);
