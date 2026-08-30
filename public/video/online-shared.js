/*
 * Stellaflix 影视模块 — online 共享状态与基础设施 (拆债 #1)
 *
 * 本文件承载 online.js / online-search.js / online-collections.js / online-track.js
 * 四个模块共享的【可变状态(S)】与【纯/半纯基础设施函数】。四个文件都是经典 <script>，
 * 通过全局 SFV.onlineShared(S) 共享同一份闭包状态，避免 God Module 单文件膨胀。
 *
 * 加载顺序(index.html)：online-core.js → online-shared.js → online-search.js
 *   → online-collections.js → online-track.js → online.js
 *
 * 铁律（对齐 #6 经典 <script> 范式）：
 *   - 本文件零业务逻辑，只定义状态 + 共享 helper；
 *   - 所有跨文件调用经 SFV.onlineShared(S) 上的函数槽，禁止相互直接引用对方 IIFE 内部变量；
 *   - online.js 在定义完协调器函数后，统一把协调器函数挂到 S 上（S.openDetail=... 等），
 *     子模块运行时经 S 调用，加载顺序保证运行时 S 已就绪。
 *
 * 合规红线（与全模块一致）：不预置、不内置任何站点；本文件零硬编码站点地址。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  // T-#6-序7：零依赖纯过滤谓词层 + 纯工具层（已抽到 online-core.js，须先于本文件加载）
  var OC = SFV.onlineCore;
  if (!OC) { throw new Error('[SFV online-shared] onlineCore 未加载，请检查 index.html 加载顺序'); }

  // 共享状态对象：四个模块读写同一份可变状态
  var S = SFV.onlineShared = {
    // ---- 浏览层 DOM 与视图栈 ----
    overlay: null, headEl: null, backBtn: null, titleEl: null, actsEl: null,
    closeBtn: null, bodyEl: null, noteEl: null,
    stack: [], current: null,
    uiMode: 'view', activePageId: null,
    _detailOrigin: null, _detailInstance: null, busy: false,
    trackMetaInflight: {}, repairTried: {},
    doc: null,
    currentNav: 'home',

    // ---- 搜索页状态 ----
    pageEl: null, searchInput: null, historyDrop: null, historyListEl: null, resultArea: null,
    _searchBound: false, _currentSearchView: null,
    _filterState: null, _hideWatched: false, _hideAbandoned: false, _filterFab: null, _chipsBar: null,
    _searchBarIconEl: null, _scoreCache: {},

    // ---- 滚动锁 ----
    _savedBodyOverflow: '', _savedBodyPos: '',

    // ---- 追片 ----
    trackActiveStatus: 'watching',

    // ---- 全局去抖 / 绑定标记 ----
    _lastGlobalToggle: 0, _navBound: false,

    // ---- 后向补图去重 ----
    _picBackfillTried: {},

    // ---- 常量 ----
    SEARCH_HISTORY_KEY: 'stellaflix-video-search-history',
    MAX_SEARCH_HISTORY: 12,
    VIDEO_PAGE_BG_DEFAULT: '#f2f4f7',

    // 纯工具别名（来自 online-core.js）
    _containsEither: OC._containsEither, _typeMatches: OC._typeMatches,
    _itemTypeExcluded: OC._itemTypeExcluded, _itemRegionExcluded: OC._itemRegionExcluded,
    _itemYearExcluded: OC._itemYearExcluded, _itemScoreExcluded: OC._itemScoreExcluded,
    _itemKeywordExcluded: OC._itemKeywordExcluded, _scoreKey: OC._scoreKey,
    esc: OC.esc, trackLabel: OC.trackLabel, fmtAgo: OC.fmtAgo, TRACK_META: OC.TRACK_META,
    CATEGORY_META: {
      liked: { label: '心动', field: 'liked', empty: '还没有心动的影片，在详情页点亮 ♥ 即可收藏到这里。' },
      inList: { label: '片单', field: 'inList', empty: '片单还是空的，在详情页点击「加入片单」即可。' },
      history: { label: '历史', field: 'history', empty: '还没有观看记录，播放任意影片后会自动出现在这里。' }
    }

    // 协调器函数槽（online.js 加载后填充：S.ensure / S.open / S.close / S.openDetail ...
    // 子模块运行时经 S 调用，此处不预声明以避免与实际赋值冲突）
  };

  // ---- 基础工具 ----
  function d() { return global.document; }
  S.doc = d();
  S.d = d;

  function isVideoSpace() { return !!(SFV.state && SFV.state.isVideo()); }
  function hasSources() {
    return !!(SFV.sources && SFV.sources.getEnabledSources && SFV.sources.getEnabledSources().length);
  }
  function sourceById(id) {
    if (!SFV.sources || !SFV.sources.getSources) return null;
    var all = SFV.sources.getSources();
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }
  function el(tag, cls, text) {
    var n = d().createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function toast(msg) {
    if (SFV.home && SFV.home.toast) { SFV.home.toast(msg); return; }
    var t = el('div', 'sfv-toast', msg);
    (d().body || d().documentElement).appendChild(t);
    global.setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2600);
  }
  S.isVideoSpace = isVideoSpace;
  S.hasSources = hasSources;
  S.sourceById = sourceById;
  S.el = el;
  S.toast = toast;

  // ---- 搜索页 DOM 引用 ----
  function getSearchPage() {
    if (!S.pageEl) {
      S.pageEl = d().getElementById('sfv-search-page');
      S.searchInput = d().getElementById('sfv-search-input');
      S.historyDrop = d().getElementById('sfv-history-drop');
      S.historyListEl = d().getElementById('sfv-history-drop-list');
      S.resultArea = d().getElementById('sfv-search-result-area');
    }
    return S.pageEl;
  }
  function isSearchPageOpen() {
    var elp = getSearchPage();
    return !!(elp && elp.classList.contains('sfv-search-open'));
  }
  function _getSearchInput() { return d().getElementById ? d().getElementById('sfv-search-input') : null; }
  function _getHistoryDrop() { return d().getElementById ? d().getElementById('sfv-history-drop') : null; }
  S.getSearchPage = getSearchPage;
  S.isSearchPageOpen = isSearchPageOpen;
  S._getSearchInput = _getSearchInput;
  S._getHistoryDrop = _getHistoryDrop;

  // ---- 搜索筛选状态 ----
  function getFilterState() {
    if (!S._filterState) {
      var seeded = (SFV.SearchFilterCore && SFV.SearchFilterCore.buildJunkDefaults)
        ? SFV.SearchFilterCore.buildJunkDefaults() : null;
      S._filterState = (SFV.SearchFilterCore && SFV.SearchFilterCore.SearchFilterState)
        ? new SFV.SearchFilterCore.SearchFilterState(seeded || {}) : null;
    }
    return S._filterState;
  }
  S.getFilterState = getFilterState;

  function _itemEpisodeExcluded(it, n) {
    if (n == null || !it || !it.playUrl) return false;
    var cnt = (SFV.sources && typeof SFV.sources.countEpisodes === 'function')
      ? SFV.sources.countEpisodes(it.playUrl) : 0;
    if (!cnt) return false;
    return cnt > n;
  }
  S._itemEpisodeExcluded = _itemEpisodeExcluded;

  // 懒加载 TMDB 评分补全：仅当设置了 minScore 才调用。
  function enrichScores(items) {
    if (!items || !items.length) return Promise.resolve(items);
    var tmdb = SFV.tmdb;
    if (!tmdb || !tmdb.search) return Promise.resolve(items);
    var pending = items.filter(function (it) {
      if (it.tmdbRating != null) { it.score = it.tmdbRating; return false; }
      return S._scoreCache[S._scoreKey(it)] === undefined;
    });
    if (!pending.length) {
      items.forEach(function (it) { var s = S._scoreCache[S._scoreKey(it)]; if (s != null) it.score = s; });
      return Promise.resolve(items);
    }
    var CONC = 4, idx = 0;
    function worker() {
      if (idx >= pending.length) return Promise.resolve();
      var it = pending[idx++];
      var key = S._scoreKey(it);
      if (S._scoreCache[key] !== undefined) return worker();
      S._scoreCache[key] = null;
      return Promise.resolve(tmdb.search(it.title)).then(function (res) {
        var top = (res && res.length) ? res[0] : null;
        var rating = top && typeof top.rating === 'number' ? top.rating : null;
        S._scoreCache[key] = rating;
        if (rating != null) it.score = rating;
      }).catch(function () { S._scoreCache[key] = null; }).then(worker);
    }
    var workers = [];
    for (var w = 0; w < Math.min(CONC, pending.length); w++) workers.push(worker());
    return Promise.all(workers).then(function () {
      items.forEach(function (it) { var s = S._scoreCache[S._scoreKey(it)]; if (s != null) it.score = s; });
      return items;
    });
  }
  S.enrichScores = enrichScores;

  // 应用「排除筛选 + 隐藏已看/已弃」前端过滤
  function applyResultFilters(items) {
    var fs = getFilterState();
    if (!fs || !items) return items;
    var exclTypes = fs.excludeTypes || [];
    var exclRegions = fs.excludeRegions || [];
    var exclKeywords = fs.excludeKeywords || [];
    var exclYear = fs.excludeBeforeYear != null ? fs.excludeBeforeYear : null;
    var minScore = fs.minScore != null ? fs.minScore : null;
    var exclEpi = fs.excludeEpisodeAbove != null ? fs.excludeEpisodeAbove : null;
    var hasExcl = exclTypes.length || exclRegions.length || exclKeywords.length ||
      exclYear != null || minScore != null || exclEpi != null;
    if (!hasExcl && !S._hideWatched && !S._hideAbandoned) return items;
    return items.filter(function (it) {
      if (S._hideWatched && SFV.collections && SFV.collections.isWatched(it)) return false;
      if (S._hideAbandoned && SFV.collections && SFV.collections.isAbandoned(it)) return false;
      if (exclTypes.length && S._itemTypeExcluded(it, exclTypes)) return false;
      if (exclRegions.length && S._itemRegionExcluded(it, exclRegions)) return false;
      if (exclYear != null && S._itemYearExcluded(it, exclYear)) return false;
      if (exclKeywords.length && S._itemKeywordExcluded(it, exclKeywords)) return false;
      if (minScore != null && S._itemScoreExcluded(it, minScore)) return false;
      if (exclEpi != null && _itemEpisodeExcluded(it, exclEpi)) return false;
      return true;
    });
  }
  S.applyResultFilters = applyResultFilters;

  // T158：全局兜底清理——移除 body 上所有已知的跨页浮层（搜索页筛选按钮等），
  // 防止页面切换（含卡顿/异常路径）后浮层残留在下一页。
  // 白名单仅登记「搜索页明确泄漏到 body 的浮层」；页面内模态（片单弹窗/背景DIY FAB）
  // 由各自模块自管，不在此强制移除，避免引用悬空。
  var ORPHAN_FLOATER_SELECTOR = '.sf-filter-fab';
  function cleanupOrphanFloaters() {
    var b = (typeof document !== 'undefined') ? document.body : null;
    if (!b || !b.querySelectorAll) return;
    var nodes = b.querySelectorAll(ORPHAN_FLOATER_SELECTOR);
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i] && nodes[i].parentNode) nodes[i].parentNode.removeChild(nodes[i]);
    }
    S._filterFab = null;
  }

  // T158 补强：监听空间切换事件，切到音乐态时强制清理残留筛选 FAB
  // （FAB 被 append 到 body 绕过 #sfv-search-page 容器，CSS display:none 兜底可能被 !important 覆盖）
  (function () {
    try {
      if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('spacechange', function (e) {
          var detail = e && e.detail || {};
          if (detail.spaceMode === 'video') return; // 切到影视态不清理
          cleanupOrphanFloaters();
        });
      }
    } catch (_) {}
  })();

  // T158 再加一层保险：MutationObserver 监控 body 子元素，音乐态下任何新加入的 .sf-filter-fab 立即移除
  (function () {
    try {
      if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
      var mo = new MutationObserver(function (mutations) {
        try {
          if (typeof SFV !== 'undefined' && SFV.state && SFV.state.isMusic()) {
            var b = document.body;
            if (b && b.querySelectorAll) {
              var nodes = b.querySelectorAll(ORPHAN_FLOATER_SELECTOR);
              for (var i = 0; i < nodes.length; i++) {
                if (nodes[i] && nodes[i].parentNode) nodes[i].parentNode.removeChild(nodes[i]);
              }
              if (nodes.length && S) S._filterFab = null;
            }
          }
        } catch (_) {}
      });
      if (document.body) {
        mo.observe(document.body, { childList: true, subtree: true });
      } else if (document.addEventListener) {
        document.addEventListener('DOMContentLoaded', function () {
          mo.observe(document.body, { childList: true, subtree: true });
        });
      }
    } catch (_) {}
  })();

  // 确保筛选 FAB 与 chips 容器存在并可见
  function ensureFilterUi() {
    // T158 加固：音乐态下绝不创建筛选 FAB，避免跨态泄漏
    if (typeof SFV !== 'undefined' && SFV.state && SFV.state.isMusic()) return;
    var page = getSearchPage();
    if (!page) return;
    // T158：重建前先清掉 body 上所有残留的筛选 FAB，避免多实例（旧引用丢失时）
    if (typeof document !== 'undefined' && document.body) {
      var stale = document.body.querySelectorAll(ORPHAN_FLOATER_SELECTOR);
      for (var s = 0; s < stale.length; s++) {
        if (stale[s] && stale[s].parentNode) stale[s].parentNode.removeChild(stale[s]);
      }
      S._filterFab = null;
    }
    if (!SFV.SearchFilter || !SFV.SearchFilter.createFab) return;
    if (!S._chipsBar) S._chipsBar = d().getElementById('sfv-search-filter-chips');
    if (!S._filterFab) {
      S._filterFab = SFV.SearchFilter.createFab('筛选', function () { openFilterPanel(); });
      // T143：append 到 body 而非搜索页容器，避免 #sfv-search-page 的 transform/clip-path
      // 创建包含块导致 fixed 定位失效、按钮被拉伸。
      (typeof document !== 'undefined' ? document.body : page).appendChild(S._filterFab);
    }
    if (S._filterFab) S._filterFab.style.display = '';
    renderFilterChips();
  }
  function renderFilterChips() {
    if (!S._chipsBar || !SFV.SearchFilter || !SFV.SearchFilter.renderChips) return;
    var fs = getFilterState();
    var hasAny = (fs && fs.hasAdvancedFilters && fs.hasAdvancedFilters()) || S._hideWatched || S._hideAbandoned;
    S._chipsBar.style.display = hasAny ? '' : 'none';
    SFV.SearchFilter.renderChips(S._chipsBar, fs || {}, { notShowWatched: S._hideWatched, notShowAbandoned: S._hideAbandoned }, {
      onRemoveType: function (t) { var fs2 = getFilterState(); var i = fs2.excludeTypes.indexOf(t); if (i >= 0) { fs2.excludeTypes.splice(i, 1); reSearch(); } },
      onRemoveRegion: function (r) { var fs2 = getFilterState(); var i = fs2.excludeRegions.indexOf(r); if (i >= 0) { fs2.excludeRegions.splice(i, 1); reSearch(); } },
      onRemoveKeyword: function (t) { var fs2 = getFilterState(); var i = fs2.excludeKeywords.indexOf(t); if (i >= 0) { fs2.excludeKeywords.splice(i, 1); reSearch(); } },
      onRemoveYear: function () { getFilterState().excludeBeforeYear = null; reSearch(); },
      onRemoveScore: function () { getFilterState().minScore = null; reSearch(); },
      onRemoveEpisode: function () { getFilterState().excludeEpisodeAbove = null; reSearch(); },
      onRemoveSort: function () { getFilterState().sort = 'heat'; reSearch(); },
      onToggleWatched: function () { S._hideWatched = false; reSearch(); },
      onToggleAbandoned: function () { S._hideAbandoned = false; reSearch(); }
    });
  }
  function reSearch() {
    renderFilterChips();
    var kw = (S.searchInput && S.searchInput.value) ? S.searchInput.value.trim() : '';
    if (kw) S.doInlineSearch(kw);
  }
  function openFilterPanel() {
    if (!SFV.SearchFilter || !SFV.SearchFilter.open) {
      console.warn('[SFV-Search] 筛选模块未加载');
      return;
    }
    var fs = getFilterState();
    SFV.SearchFilter.open({
      initialFilterState: fs ? fs.copyWith() : null,
      initialNotShowWatched: S._hideWatched,
      initialNotShowAbandoned: S._hideAbandoned,
      onApply: function (res) {
        if (res.filterState) S._filterState = res.filterState.copyWith();
        S._hideWatched = !!res.notShowWatched;
        S._hideAbandoned = !!res.notShowAbandoned;
        var kw = (S.searchInput && S.searchInput.value) ? S.searchInput.value.trim() : '';
        if (kw) S.doInlineSearch(kw);
        else renderFilterChips();
      }
    });
  }
  S.ensureFilterUi = ensureFilterUi;
  S.cleanupOrphanFloaters = cleanupOrphanFloaters;
  S.renderFilterChips = renderFilterChips;
  S.reSearch = reSearch;
  S.openFilterPanel = openFilterPanel;

  // ---- 历史下拉 ----
  function _getSearchBarIcon() {
    if (!S._searchBarIconEl) S._searchBarIconEl = (d().querySelector ? d().querySelector('.sfv-search-bar-icon') : null);
    return S._searchBarIconEl;
  }
  function showHistoryDrop() {
    if (!S.historyDrop) return;
    if (S.historyDrop.classList.contains('sfv-history-visible')) return;
    S.historyDrop.classList.add('sfv-history-visible');
    var bar = d().querySelector ? d().querySelector('.sfv-search-bar') : null;
    if (bar) bar.classList.add('sfv-search-bar-focus');
    var icon = _getSearchBarIcon();
    if (icon) { icon.setAttribute('data-sfv-mode', 'back'); icon.innerHTML = '<path d="M15 18l-6-6 6-6"/>'; }
  }
  function hideHistoryDrop() {
    if (S.historyDrop) S.historyDrop.classList.remove('sfv-history-visible');
    var bar = d().querySelector ? d().querySelector('.sfv-search-bar') : null;
    if (bar) bar.classList.remove('sfv-search-bar-focus');
    var icon = _getSearchBarIcon();
    if (icon) { icon.setAttribute('data-sfv-mode', 'search'); icon.innerHTML = '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>'; }
  }
  S._getSearchBarIcon = _getSearchBarIcon;
  S.showHistoryDrop = showHistoryDrop;
  S.hideHistoryDrop = hideHistoryDrop;

  // ---- 历史管理（localStorage） ----
  function getSearchHistory() {
    try {
      var raw = localStorage.getItem(S.SEARCH_HISTORY_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.items)) return parsed.items;
      return [];
    } catch (e) { return []; }
  }
  function saveSearchHistory(kw) {
    if (!kw) return;
    try {
      var list = getSearchHistory();
      list = list.filter(function (i) { return i !== kw; });
      list.unshift(kw);
      if (list.length > S.MAX_SEARCH_HISTORY) list.length = S.MAX_SEARCH_HISTORY;
      localStorage.setItem(S.SEARCH_HISTORY_KEY, JSON.stringify(list));
    } catch (e) {}
  }
  function removeSearchHistoryItem(kw) {
    try {
      localStorage.setItem(S.SEARCH_HISTORY_KEY,
        JSON.stringify(getSearchHistory().filter(function (i) { return i !== kw; })));
    } catch (e) {}
  }
  function clearSearchHistory() {
    try { localStorage.removeItem(S.SEARCH_HISTORY_KEY); } catch (e) {}
    renderHistoryDrop();
  }
  function renderHistoryDrop(filterText) {
    if (!S.historyListEl) return;
    var list = getSearchHistory();
    if (filterText) {
      var ft = filterText.toLowerCase();
      list = list.filter(function (i) { return i.toLowerCase().indexOf(ft) !== -1; });
    }
    if (!list.length) {
      if (filterText) S.historyListEl.innerHTML = '<div class="sfv-search-empty-hint">暂无匹配记录，按回车检索</div>';
      else S.historyListEl.innerHTML = '<div class="sfv-search-empty-hint">暂无搜索记录</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < list.length; i++) {
      html += '<button class="sfv-history-item" type="button" data-sfv-kw="' + S.esc(list[i]) + '">';
      html += '<span>' + S.esc(list[i]) + '</span>';
      html += '<span class="sfv-history-item-del" data-sfv-kw="' + S.esc(list[i]) + '" title="\u5220\u9664">\u00D7</span></button>';
    }
    S.historyListEl.innerHTML = html;
  }
  S.getSearchHistory = getSearchHistory;
  S.saveSearchHistory = saveSearchHistory;
  S.removeSearchHistoryItem = removeSearchHistoryItem;
  S.clearSearchHistory = clearSearchHistory;
  S.renderHistoryDrop = renderHistoryDrop;

  if (typeof global.console !== 'undefined' && global.console.log) {
    console.log('[SFV-DIAG] online-shared.js 已加载，共享状态 S 就绪');
  }
})(typeof window !== 'undefined' ? window : this);
