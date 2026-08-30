/*
 * Stellaflix 影视模块 — 在线 CMS10 源闭环 UI (Step 4) · 协调器（拆债 #1 瘦身版）
 *
 * 本文件是 online 模块群的【协调器】：拥有浏览层生命周期（ensure/open/close/render）、
 * TMDB 元数据层、详情/失效修复、四类列表与入口动作、导航调度。
 *
 * 共享可变状态与跨页函数统一经 SFV.onlineShared(S) 访问（搜索/片单/追片逻辑已拆到
 * online-search.js / online-collections.js / online-track.js）。本文件加载末尾把协调器
 * 函数挂到 S（S.openDetail=... 等），子模块运行时经 S 调用。
 *
 * 合规红线（与全模块一致）：不预置、不内置任何站点；所有 api_site 由用户手动导入；
 *   本文件零硬编码站点地址；产品内任何位置均声明「不提供、不存储」。
 *
 * 双态同构：本覆盖层为影视态专属子面板，仅显式 open() 后显示；切回音乐态时自动隐藏，
 *   绝不污染音乐模块 DOM 或逻辑。
 */
(function (global) {
  'use strict';
  console.log('[SFV-DIAG] online.js IIFE 开始执行, global=', !!global, ' document=', !!global.document);
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  // T-#6-序7：零依赖纯过滤谓词层 + 纯工具层（已抽到 online-core.js，须先于本文件加载）
  var OC = SFV.onlineCore;
  if (!OC) { throw new Error('[SFV online] onlineCore 未加载，请检查 index.html 加载顺序'); }
  var _containsEither = OC._containsEither, _typeMatches = OC._typeMatches,
      _itemTypeExcluded = OC._itemTypeExcluded, _itemRegionExcluded = OC._itemRegionExcluded,
      _itemYearExcluded = OC._itemYearExcluded, _itemScoreExcluded = OC._itemScoreExcluded,
      _itemKeywordExcluded = OC._itemKeywordExcluded, _scoreKey = OC._scoreKey;
  // T-#6-序7（续）：纯工具层 esc / trackLabel / fmtAgo / TRACK_META 已抽到 online-core.js
  var esc = OC.esc, trackLabel = OC.trackLabel, fmtAgo = OC.fmtAgo, TRACK_META = OC.TRACK_META;

  // 共享状态对象（online-shared.js 创建；四个模块读写同一份）
  var S = SFV.onlineShared;
  if (!S) { throw new Error('[SFV online] onlineShared 未加载，请检查 index.html 加载顺序'); }

  // 基础工具别名（online-shared.js 已定义到 S）
  function d() { return S.d(); }
  var isVideoSpace = S.isVideoSpace, hasSources = S.hasSources, sourceById = S.sourceById,
      el = S.el, toast = S.toast;
  var doc = S.d();

  // T-#6-b：集群 A（生命周期/导航/外壳 Chrome）已抽到 online-nav.js；此处仅留薄别名委托（调用点零改动）
  var ensure = S.ensure, onNavItemClick = S.onNavItemClick, setActiveNav = S.setActiveNav,
      handleNavAction = S.handleNavAction, lockBodyScroll = S.lockBodyScroll, unlockBodyScroll = S.unlockBodyScroll,
      goToNav = S.goToNav, goHome = S.goHome, mkAct = S.mkAct, open = S.open,
      closeOverlayAnimated = S.closeOverlayAnimated, destroyDetail = S.destroyDetail, close = S.close,
      capturePlayerReturn = S.capturePlayerReturn, returnFromPlayer = S.returnFromPlayer, isOpen = S.isOpen,
      openCategory = S.openCategory, openPage = S.openPage, pushView = S.pushView, ensureOverlayShown = S.ensureOverlayShown,
      goBack = S.goBack, render = S.render, applyGridDiyToBody = S.applyGridDiyToBody,
      applyVideoPageBg = S.applyVideoPageBg, bindVideoPageBgFromTint = S.bindVideoPageBgFromTint,
      setNote = S.setNote, setBrowseChrome = S.setBrowseChrome, renderLoading = S.renderLoading;


  // T-#6-b：集群 B（TMDB 元数据/详情/失效修复）已抽到 online-detail.js，此处仅留薄别名委托（调用点零改动）
  var resolvePic = S.resolvePic, showTitleOf = S.showTitleOf, tryPicBackfill = S.tryPicBackfill,
      enrichTmdb = S.enrichTmdb, enrichIdentity = S.enrichIdentity, renderGrid = S.renderGrid,
      openDetail = S.openDetail, openKazumiDetail = S.openKazumiDetail, openDetailFromMeta = S.openDetailFromMeta,
      repairKeyOf = S.repairKeyOf, pickRepairCandidate = S.pickRepairCandidate, repairFromSearch = S.repairFromSearch,
      expiredReasonText = S.expiredReasonText, renderExpiredPanel = S.renderExpiredPanel,
      loadDetail = S.loadDetail, renderDetail = S.renderDetail;


  // ---------------------------------------------------------------- 四类列表
  // T-#6-b：集群 C（分类列表/入口动作/规则面板）已抽到 online-actions.js，此处仅留薄别名委托（调用点零改动）
  var renderCategory = S.renderCategory, recordMeta = S.recordMeta, recordHistory = S.recordHistory,
      openLocal = S.openLocal, openUrlPrompt = S.openUrlPrompt, openSources = S.openSources,
      openRules = S.openRules, renderRules = S.renderRules,
      registerNextEpisode = S.registerNextEpisode, playEpisode = S.playEpisode;

  // 暴露给页面模块（page-*.js）复用的共享辅助
  SFV.ui = {
    el: el,
    toast: toast,
    setNote: setNote,
    CATEGORY_META: S.CATEGORY_META,
    setBrowseChrome: setBrowseChrome,
    setTitle: function (t) { if (S.titleEl) S.titleEl.textContent = t; }
  };

  SFV.online = {
    open: open,
    close: close,
    goBack: goBack,
    isOpen: isOpen,
    goHome: goHome,
    openCategory: openCategory,
    openPage: openPage,
    openSearchPage: S.openSearchPage,
    toggleSearchPage: S.toggleSearchPage,
    doInlineSearch: S.doInlineSearch,
    openRules: openRules,
    openLocal: openLocal,
    openUrlPrompt: openUrlPrompt,
    openSources: openSources,
    openBrowse: openCategory,
    playEpisode: playEpisode,
    openDetailFromMeta: openDetailFromMeta,
    applyGridDiyToBody: applyGridDiyToBody,
    openCollections: S.openCollections,
    reopenCollections: S.reopenCollections,
    openCollectionItems: S.openCollectionItems,
    tryPicBackfill: tryPicBackfill,
    showPickFolderDialog: S.showPickFolderDialog,
    renderDetail: renderDetail,
    capturePlayerReturn: capturePlayerReturn,
    returnFromPlayer: returnFromPlayer
  };

  // T141: 04b-shelf-3d.js 直接调用 window.StellaflixVideo.openBrowse(flag)，
  // 保持顶层别名避免 "openBrowse is not a function"。
  SFV.openBrowse = openCategory;

  // P4：把 online.js 内部闭包注入播放编排器
  if (SFV.playOrchestrator && SFV.playOrchestrator.init) {
    SFV.playOrchestrator.init({
      toast: toast,
      recordMeta: recordMeta,
      recordHistory: recordHistory,
      resolvePic: resolvePic,
      close: close,
      captureReturn: capturePlayerReturn
    });
  }

  // 全局搜索切换入口：供 HTML inline onclick、捕获监听器、pointer 兜底统一调用，带 350ms 去抖
  var _lastGlobalToggle = 0;
  global._sfvTryToggleSearch = function _sfvTryToggleSearch() {
    var now = Date.now();
    if (now - _lastGlobalToggle < 350) {
      console.log('[SFV-Search] 全局切换去抖：跳过重复触发');
      return;
    }
    _lastGlobalToggle = now;
    console.log('[SFV-Search] 全局切换入口触发');
    S.toggleSearchPage();
  };

  // ---------------------------------------------------------------- T102修复：初始化时立即绑定（不依赖 ensure()）
  var _navBound = false;
  function initEarlyBindings() {
    if (_navBound) return;
    _navBound = true;
    console.log('[SFV-DIAG] initEarlyBindings() called, doc=' + !!doc + ', d()=' + typeof d);
    try { if (SFV.nav && typeof SFV.nav.bindClick === 'function') { SFV.nav.bindClick(onNavItemClick); console.log('[SFV-DIAG] SFV.nav.bindClick() OK'); } else { console.warn('[SFV-DIAG] SFV.nav 未就绪，导航 click 未绑定'); } } catch (e) { console.error('[SFV-Online] SFV.nav.bindClick 失败:', e); }
    try { S.bindCapsuleSearchBtn(); console.log('[SFV-DIAG] bindCapsuleSearchBtn() OK'); } catch (e) { console.error('[SFV-Online] bindCapsuleSearchBtn 失败:', e); }
    try { bindVideoPageBgFromTint(); console.log('[SFV-DIAG] bindVideoPageBgFromTint() OK'); } catch (e) { console.error('[SFV-Online] bindVideoPageBgFromTint 失败:', e); }
  }
  if (d && d.readyState === 'loading' && d.addEventListener) {
    d.addEventListener('DOMContentLoaded', initEarlyBindings);
  } else {
    initEarlyBindings();
  }

  // ---------------------------------------------------------------- 动态加载 grid-diy.js
  (function loadGridDiy() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('sfv-grid-diy-script')) return;
    var s = document.createElement('script');
    s.id = 'sfv-grid-diy-script';
    s.src = 'video/grid-diy.js';
    s.async = true;
    (document.head || document.documentElement).appendChild(s);
  })();

  // ---------------------------------------------------------------- 把协调器函数挂到共享状态 S，供子模块运行时调用
  S.ensure = ensure;
  S.open = open;
  S.close = close;
  S.goBack = goBack;
  S.isOpen = isOpen;
  S.openCategory = openCategory;
  S.pushView = pushView;
  S.ensureOverlayShown = ensureOverlayShown;
  S.closeOverlayAnimated = closeOverlayAnimated;
  S.destroyDetail = destroyDetail;
  S.render = render;
  S.applyGridDiyToBody = applyGridDiyToBody;
  S.applyVideoPageBg = applyVideoPageBg;
  S.bindVideoPageBgFromTint = bindVideoPageBgFromTint;
  S.setNote = setNote;
  S.setBrowseChrome = setBrowseChrome;
  S.renderLoading = renderLoading;
  S.resolvePic = resolvePic;
  S.showTitleOf = showTitleOf;
  S.tryPicBackfill = tryPicBackfill;
  S.enrichTmdb = enrichTmdb;
  S.enrichIdentity = enrichIdentity;
  S.renderGrid = renderGrid;
  S.openDetail = openDetail;
  S.openKazumiDetail = openKazumiDetail;
  S.openDetailFromMeta = openDetailFromMeta;
  S.repairKeyOf = repairKeyOf;
  S.pickRepairCandidate = pickRepairCandidate;
  S.repairFromSearch = repairFromSearch;
  S.expiredReasonText = expiredReasonText;
  S.renderExpiredPanel = renderExpiredPanel;
  S.loadDetail = loadDetail;
  S.renderDetail = renderDetail;
  S.recordMeta = recordMeta;
  S.recordHistory = recordHistory;
  S.openLocal = openLocal;
  S.openUrlPrompt = openUrlPrompt;
  S.openSources = openSources;
  S.openRules = openRules;
  S.renderRules = renderRules;
  S.registerNextEpisode = registerNextEpisode;
  S.playEpisode = playEpisode;
  S.setActiveNav = setActiveNav;
  S.handleNavAction = handleNavAction;
  S.onNavItemClick = onNavItemClick;
  S.goToNav = goToNav;
  S.goHome = goHome;
  S.unlockBodyScroll = unlockBodyScroll;
  S.lockBodyScroll = lockBodyScroll;
  S.renderCategory = renderCategory;
  // 注：S.openSearchPage / S.toggleSearchPage / S.doInlineSearch / S.closeSearchPage /
  //     S.restoreSearchPage / S.clearResultArea / S.showSearchStatus / S.renderInlineResults /
  //     S.bindCapsuleSearchBtn 由 online-search.js 注册；
  //     S.openCollections / S.openCollectionItems / S.reopenCollections /
  //     S.renderCollectionItems / S.showPickFolderDialog 由 online-collections.js 注册；
  //     S.renderTrackPage / S.paintTrackStatus / S.openTrackMenu 等由 online-track.js 注册。

  console.log('[SFV-DIAG] online.js 协调器已加载，SFV.online 门面装配完成');

  // D8 修复：渲染进程浏览器后退守卫。应用为单页应用、无内部历史路由，Electron 中
  // Alt+← / 鼠标后退键 / 触控板左滑 / history.back() 会触发导航离开应用 URL → about:blank 白屏。
  // 启动时 pushState 固化当前 URL，popstate 一律回填，使地址恒定、不退航。
  (function installNavGuard() {
    try {
      if (typeof history !== 'undefined' && typeof history.pushState === 'function' && typeof location !== 'undefined') {
        history.pushState(null, '', location.href);
      }
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('popstate', function () {
          try {
            if (typeof history !== 'undefined' && typeof history.pushState === 'function' && typeof location !== 'undefined') {
              history.pushState(null, '', location.href);
            }
          } catch (_) {}
        });
      }
    } catch (_) {}
  })();
})(typeof window !== 'undefined' ? window : this);
