/*
 * Stellaflix 影视模块 — online 协调器 · 集群 A：浏览层生命周期 / 导航 / 外壳 Chrome
 *
 * 从 online.js 拆出（#6-b 可维护性债拆分）。本文件持有浏览覆盖层的构建、开关、导航调度、
 * 视图栈与外壳文案/背景渲染。所有跨集群调用统一经共享状态 S（SFV.onlineShared）路由，
 * 与 online.js 原有 S 注册表一致；online.js 保留 `var ensure = S.ensure` 等薄别名委托，
 * 调用点零改动。
 *
 * 合规红线：不内置任何站点地址；api_site 由用户手动导入。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var S = SFV.onlineShared;
  if (!S) { throw new Error('[SFV online-nav] onlineShared 未加载，请检查 index.html 加载顺序'); }
  var OC = SFV.onlineCore;
  if (!OC) { throw new Error('[SFV online-nav] onlineCore 未加载，请检查 index.html 加载顺序'); }

  // 重建 online.js 中的局部别名（均来自 S / OC，运行时已就绪）
  function d() { return S.d(); }
  var isVideoSpace = S.isVideoSpace, hasSources = S.hasSources, sourceById = S.sourceById,
      el = S.el, toast = S.toast;
  var doc = S.d();

  // ---------------------------------------------------------------- 构建
  function ensure() {
    if (S.overlay) return;
    S.overlay = el('div', 'sfv-browse');
    S.overlay.id = 'sfv-browse';

    S.headEl = el('div', 'sfv-browse-head');
    S.backBtn = el('button', 'sfv-browse-back', '←');
    S.backBtn.type = 'button';
    S.backBtn.addEventListener('click', goBack);
    S.titleEl = el('div', 'sfv-browse-title', '在线影视');
    S.actsEl = el('div', 'sfv-browse-acts');
    var bLocal = mkAct('本地', S.openLocal);
    var bUrl = mkAct('地址', S.openUrlPrompt);
    var bSrc = mkAct('片源', S.openSources);
    S.actsEl.appendChild(bLocal); S.actsEl.appendChild(bUrl); S.actsEl.appendChild(bSrc);
    S.closeBtn = el('button', 'sfv-browse-close');
    S.closeBtn.type = 'button';
    S.closeBtn.setAttribute('aria-label', '关闭');
    S.closeBtn.innerHTML = '<svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    // T158（最终裁定·用户 2026-08-19）：片单/追片页内 X 直接关闭整个 Electron 窗口——
    // 与详情胶囊 × 行为一致，用户要求三页页内 X 也退窗口。仅当 desktopWindow 桥可用时调用，
    // 缺失则回退 close() 防按钮卡死（非 Electron 环境不应发生）。
    S.closeBtn.addEventListener('click', function () {
      if (global.desktopWindow && global.desktopWindow.close) global.desktopWindow.close();
      else close();
    });
    S.headEl.appendChild(S.backBtn); S.headEl.appendChild(S.titleEl); S.headEl.appendChild(S.actsEl); S.headEl.appendChild(S.closeBtn);

    // [清理] legacy 覆盖层 inline 搜索栏已移除：搜索统一走 #sfv-search-page（openSearchPage）。

    S.noteEl = el('div', 'sfv-browse-note');
    S.bodyEl = el('div', 'sfv-browse-body');

    S.overlay.appendChild(S.headEl);
    S.overlay.appendChild(S.noteEl);
    S.overlay.appendChild(S.bodyEl);
    (doc.body || doc.documentElement).appendChild(S.overlay);

    // 注入页面路由渲染宿主（T127）：五个导航独立页面渲染进 bodyEl
    if (SFV.router && typeof SFV.router.setHost === 'function') SFV.router.setHost(S.bodyEl);

    // T135：回到顶部悬浮按钮（仅电影 / 动漫分页），绑定 .sfv-browse-body 滚动
    if (SFV.backToTop && typeof SFV.backToTop.init === 'function') {
      try { SFV.backToTop.init(S.bodyEl); } catch (_) {}
    }

    // Escape 键关闭浏览层（栈底=关闭整个浏览页，非栈底=返回上一级）
    if (global.addEventListener) {
      global.addEventListener('keydown', function (ev) {
        if (!isOpen()) return;
        if (ev && (ev.key === 'Escape' || ev.keyCode === 27)) {
          if (SFV.SearchFilter && SFV.SearchFilter.isOpen && SFV.SearchFilter.isOpen()) return;
          // T152：背景 DIY 面板打开时，Esc 优先关闭面板，再按一次才退出页面
          if (SFV.pageBgDiy && SFV.pageBgDiy.isModalOpen && SFV.pageBgDiy.isModalOpen()) {
            ev.preventDefault();
            ev.stopPropagation();
            SFV.pageBgDiy.closeModal();
            return;
          }
          // T156c：片单页「新建/重命名片单夹」对话框打开时，Esc 优先关闭对话框而非退出整个片单页
          if (SFV.pageCollections && SFV.pageCollections.isFolderDialogOpen && SFV.pageCollections.isFolderDialogOpen()) {
            ev.preventDefault();
            ev.stopPropagation();
            if (SFV.pageCollections.closeFolderDialog) SFV.pageCollections.closeFolderDialog();
            return;
          }
          ev.preventDefault();
          ev.stopPropagation();
          goBack();
        }
      }, true); // 捕获阶段优先
    }

    // 视口尺寸变化时，若处于平级 tab 页，保持 flush 铺满（top:0）。
    if (global.addEventListener) {
      global.addEventListener('resize', function () {
        if (isOpen() && S.uiMode === 'page' && S.overlay) {
          S.overlay.style.top = '0';
        }
      });
    }

  } // <-- ensure()

  // ==== T109f 关键修复：spacechange 监听器必须在 ensure() 外部（加载期注册）====
  {
    if (global.addEventListener) {
      global.addEventListener(SFV.state && SFV.state.EVENT ? SFV.state.EVENT : 'spacechange', function (ev) {
        var mode = ev && ev.detail ? ev.detail.spaceMode : (isVideoSpace() ? 'video' : 'music');
        if (mode !== 'video' && isOpen()) close();
        if (typeof global.scheduleShelfRebuild === 'function') {
          try { global.scheduleShelfRebuild('video-space-change', true); } catch (e) {}
        }
        try {
          if (global.shelfManager && typeof global.shelfManager.setMode === 'function') {
            if (mode === 'video') {
              var currentMode = global.shelfManager.getMode && global.shelfManager.getMode();
              if (currentMode === 'off') {
                var targetMode = (global.fx && /^(side|stage)$/.test(String(global.fx.shelf || ''))) ? global.fx.shelf : 'side';
                global.shelfManager.setMode(targetMode);
              }
            } else {
              var _prevShelf = (global.fx && /^(off|side|stage)$/.test(String(global.fx.shelf || ''))) ? global.fx.shelf : 'side';
              global.shelfManager.setMode(_prevShelf);
            }
          }
        } catch (e) { console.warn('[SFV] 歌单架空间切换处理失败', e); }
        try {
          var vt = doc.getElementById('home-video-title');
          var vs = doc.getElementById('home-video-sub');
          if (vt) vt.textContent = mode === 'video' ? '音乐空间' : '影视空间';
          if (vs) vs.textContent = mode === 'video' ? '返回音乐空间' : '搜索 / 播放影片';
          console.log('[SFV-Search] 第5卡文案已更新: title=' + (vt ? vt.textContent : 'NULL') + ' sub=' + (vs ? vs.textContent : 'NULL'));
        } catch (_) { console.warn('[SFV-Search] 第5卡文案更新失败', _); }
        try { applyVideoPageBg(); } catch (e) {}
      });
      console.log('[SFV-DIAG] spacechange 监听器已在 IIFE 顶层注册（ensure 外部）');
    }
  }

  // ---------------------------------------------------------------- 导航栏（T132-P2 重构：委托 SFV.nav 共享组件）
  function onNavItemClick(key) {
    S.currentNav = key;
    if (SFV.nav && typeof SFV.nav.paintActive === 'function') SFV.nav.paintActive(key);
    handleNavAction(key);
  }

  function setActiveNav(key) {
    S.currentNav = key;
    if (SFV.nav && typeof SFV.nav.paintActive === 'function') SFV.nav.paintActive(key);
  }

  function handleNavAction(key) {
    switch (key) {
      case 'discover':
        goToNav('discover');
        break;
      case 'world':
        goToNav('world');
        break;
      case 'home':
        goHome();
        break;
      default:
        break;
    }
  }

  // ---- body 滚动锁定（全屏覆盖层模式）----
  var _savedBodyOverflow = '';
  var _savedBodyPos = '';
  function lockBodyScroll() {
    var b = document.body;
    if (!b) return;
    _savedBodyOverflow = b.style.overflow || '';
    _savedBodyPos = b.style.position || '';
    b.style.overflow = 'hidden';
    b.style.position = 'fixed';
    b.style.top = '-' + (window.scrollY || window.pageYOffset || 0) + 'px';
    b.style.left = '0';
    b.style.right = '0';
    b.style.width = '100%';
  }
  function unlockBodyScroll() {
    var b = document.body;
    if (!b) return;
    // 幂等守卫：body 不处于锁定态时直接返回，避免误触 scrollTo(0,0) 重置底层滚动
    if (b.style.position !== 'fixed' || !b.style.top) {
      _savedBodyOverflow = '';
      _savedBodyPos = '';
      return;
    }
    b.style.overflow = _savedBodyOverflow;
    b.style.position = _savedBodyPos;
    var sy = parseInt(b.style.top || '0', 10) || 0;
    b.style.top = ''; b.style.left = ''; b.style.right = ''; b.style.width = '';
    window.scrollTo(0, -sy);
    _savedBodyOverflow = '';
    _savedBodyPos = '';
  }

  function goToNav(key) {
    ensure();
    // T156：进入任意导航分页前，先关闭搜索页（含隐藏筛选 FAB），使搜索页与浏览覆盖层互斥，
    // 避免片单页等页面右下角残留搜索页筛选按钮、且返回时误回到搜索页。
    if (S.closeSearchPage) S.closeSearchPage();
    // T158：进入任意导航分页前，强制回收 body 上残留的跨页浮层（如搜索页筛选 FAB），
    // 防止上一页因卡顿/竞态未清理时泄漏到当前页。
    if (S.cleanupOrphanFloaters) S.cleanupOrphanFloaters();
    destroyDetail();        // 切换导航 tab 时若详情仍打开，必须先销毁（清 sfv-plex-immersive）
    S.uiMode = 'page';

    if (SFV.nav && typeof SFV.nav.paintActive === 'function') SFV.nav.paintActive(key);

    if (key === 'collections') {
      S.overlay.classList.add('sfv-show');
      S.overlay.classList.remove('sfv-browse--page');
      S.overlay.classList.add('sfv-browse--fullscreen');
      S.overlay.classList.remove('sfv-browse--category');
      S.overlay.style.top = '';
      S.overlay.style.left = '';
      S.titleEl.textContent = '片单';
      // 与追片页 category 模式统一：返回按钮使用 SVG 箭头图标，而非文字 ←
      S.backBtn.innerHTML = '<svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>';
      S.backBtn.setAttribute('aria-label', '返回');
      S.closeBtn.style.display = 'flex';
      lockBodyScroll();
      // T156b→T157→重审：任意影视浏览分页（含片单 fullscreen）激活时，标记 body.sfv-browse-active
      // 供 CSS 锁定状态。搜索入口统一收敛至 #top-right 胶囊（#sfv-capsule-search-btn），
      // 不再隐藏全局胶囊；其 z-index 高于浏览覆盖层，可正常发起搜索/Home/登录交互。
      if (doc.body) doc.body.classList.add('sfv-browse-active');
    } else {
      S.overlay.classList.add('sfv-show');
      S.overlay.classList.add('sfv-browse--page');
      S.overlay.classList.remove('sfv-browse--fullscreen');
      S.overlay.classList.remove('sfv-browse--collections');
      S.overlay.style.top = '0';
      // T157→重审：page 模式（历史/汇联/世界）下同样通过 body.sfv-browse-active 标记浏览分页态；
      // 搜索入口保留在 #top-right 胶囊内，不再隐藏全局胶囊。
      if (doc.body) doc.body.classList.add('sfv-browse-active');
    }

    if (SFV.router) SFV.router.go(key);
    S.activePageId = key;
    S.overlay.classList.remove('sfv-history-page');
    applyVideoPageBg();
    if (SFV.pageBgDiy) SFV.pageBgDiy.sync();
  }

  // 打开任意已注册 router 页面（非 nav tab 的自定义页，如观看历史）。
  // 复用 goToNav 的 page 模式铺满逻辑，但不调用 SFV.nav.paintActive（history 非 nav 项），
  // 页面标题由页面自身 sticky 页头承载（page 模式下 .sfv-browse-head 隐藏）。
  function openPage(id, title) {
    ensure();
    // T156：打开独立 router 页（如历史页）前，先关闭搜索页（含隐藏筛选 FAB）
    if (S.closeSearchPage) S.closeSearchPage();
    // T158：进入独立 router 页前，强制回收 body 上残留的跨页浮层（同 goToNav）
    if (S.cleanupOrphanFloaters) S.cleanupOrphanFloaters();
    // T157→重审：进入独立 router 页（如历史/片单）即影视浏览分页，通过 body.sfv-browse-active
    // 标记浏览态；搜索入口保留在 #top-right 胶囊内（与 goToNav 一致），不再隐藏全局胶囊。
    if (doc.body) doc.body.classList.add('sfv-browse-active');
    destroyDetail();
    S.uiMode = 'page';
    S.overlay.classList.add('sfv-show');
    S.overlay.classList.add('sfv-browse--page');
    S.overlay.classList.remove('sfv-browse--fullscreen');
    S.overlay.classList.remove('sfv-browse--collections');
    S.overlay.style.top = '0';
    S.titleEl.textContent = title || '';
    if (SFV.router) SFV.router.go(id);
    S.activePageId = id;
    S.overlay.classList.toggle('sfv-history-page', id === 'history');
    applyVideoPageBg();
    if (SFV.pageBgDiy) SFV.pageBgDiy.sync();
  }

  // 首页 = 影视空间既有首页（home.js 渲染的主 DOM），不是 #sfv-browse 覆盖层里的独立分页。
  function goHome() {
    ensure();
    if (SFV.browse3d && SFV.browse3d.isActive && SFV.browse3d.isActive()) {
      try { SFV.browse3d.deactivate(); } catch (e) { }
    }
    close();                 // 关闭浏览覆盖层，露出下方 home.js 渲染的影视首页
    S.activePageId = 'home';
    if (SFV.nav && typeof SFV.nav.paintActive === 'function') SFV.nav.paintActive('home');
    applyVideoPageBg();
    if (SFV.pageBgDiy) SFV.pageBgDiy.sync();
    if (SFV.home && typeof SFV.home.render === 'function') {
      try { SFV.home.render(); } catch (e) { console.warn('[SFV-Online] goHome render failed', e); }
    }
  }

  function mkAct(label, fn) {
    var b = el('button', 'sfv-browse-act', label);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }

  // ---------------------------------------------------------------- 公开控制
  function open(opts) {
    opts = opts || {};
    ensure();
    // T158：进入 category 浏览（汇联/世界）前，强制回收 body 上残留的跨页浮层
    if (S.cleanupOrphanFloaters) S.cleanupOrphanFloaters();
    S.uiMode = 'view';
    S.activePageId = null;
    S._returnPageId = null;   // D5 防御：legacy 浏览入口清空页面返回标记
    S.overlay.classList.remove('sfv-browse--page');
    S.overlay.style.top = '';
    if (!isVideoSpace() && SFV.state && SFV.state.setSpace) SFV.state.setSpace('video');
    S.stack = [];
    if (opts.mode === 'category' && opts.field) {
      pushView({ mode: 'category', field: opts.field });
    } else {
      console.warn('[SFV] open() 仅支持 category 模式（搜索通道已移除）');
    }
    S.overlay.classList.add('sfv-show');
    // T157→重审：category 浏览（汇联/世界）也是影视浏览分页，激活期间通过 body.sfv-browse-active
    // 标记浏览态；搜索入口统一收敛至 #top-right 胶囊，不再隐藏全局胶囊。
    if (doc.body) doc.body.classList.add('sfv-browse-active');
    if (S.searchInput && S.searchInput.focus) { try { S.searchInput.focus(); } catch (e) {} }
  }
  // 统一覆盖层退出动画：向下滑出（与进入上滑入镜像）。
  function closeOverlayAnimated() {
    if (!S.overlay) return;
    if (!S.overlay.classList.contains('sfv-show')) {
      S.overlay.classList.remove('sfv-browse--closing', 'sfv-browse--page', 'sfv-browse--fullscreen', 'sfv-browse--collections', 'sfv-browse--category', 'sfv-history-page');
      S.overlay.style.top = '';
      try { if (doc && doc.body) { doc.body.classList.remove('sfv-plex-immersive'); doc.body.classList.remove('sfv-browse-active'); } } catch (e) {}
      // T158：覆盖层未激活即退出时，仍强制回收残留跨页浮层
      if (S.cleanupOrphanFloaters) S.cleanupOrphanFloaters();
      return;
    }
    S.overlay.classList.remove('sfv-show');
    S.overlay.classList.add('sfv-browse--closing');
    var done = function () {
      S.overlay.removeEventListener('animationend', done);
      S.overlay.classList.remove('sfv-browse--closing', 'sfv-browse--page', 'sfv-browse--fullscreen', 'sfv-browse--collections', 'sfv-browse--category', 'sfv-history-page');
      S.overlay.style.top = '';
      try { if (doc && doc.body) { doc.body.classList.remove('sfv-plex-immersive'); doc.body.classList.remove('sfv-browse-active'); } } catch (e) {}
      // T158：覆盖层退出动画完成时，强制回收残留跨页浮层
      if (S.cleanupOrphanFloaters) S.cleanupOrphanFloaters();
    };
    S.overlay.addEventListener('animationend', done);
    setTimeout(function () { if (S.overlay.classList.contains('sfv-browse--closing')) done(); }, 420);
  }

  // 集中化详情销毁
  function destroyDetail() {
    if (S._detailInstance && typeof S._detailInstance.destroy === 'function') {
      try { S._detailInstance.destroy(); } catch (e) {}
    }
    S._detailInstance = null;
    try { if (doc && doc.body) doc.body.classList.remove('sfv-plex-immersive'); } catch (e) {}
  }

  function close() {
    if (!S.overlay) return;
    // T157→重审：退出浏览层（含所有分页）时清除 body.sfv-browse-active，
    // 解除浏览态标记；#top-right 胶囊因 T157 重审后已不再依赖该 class 切换显示，
    // 清理该标记主要用于状态同步与后续样式命中。
    if (doc.body) doc.body.classList.remove('sfv-browse-active');
    // T158：退出浏览层时强制回收 body 上残留的跨页浮层（如搜索页筛选 FAB），杜绝泄漏到首页
    if (S.cleanupOrphanFloaters) S.cleanupOrphanFloaters();
    destroyDetail();
    closeOverlayAnimated();
    unlockBodyScroll();
    S.stack.length = 0; S.current = null;
    S.uiMode = 'view'; S.activePageId = null;
    S._detailOrigin = null;   // D9 防御：退出覆盖层时强制清来源标记，杜绝跨会话/跨来源残留
    S._returnPageId = null;   // D5 防御：退出覆盖层时清空页面返回标记，避免残留误触发
    if (SFV.pageBgDiy) SFV.pageBgDiy.sync();
  }

  // ---- 影视态播放器「X/ESC 返回上一页」支持 ----
  // 进入播放器前由 play-orchestrator 通过 captureReturn(view) 记录返回目标；
  // 关闭播放器时由 player.js 调 returnFromPlayer() 重建进入前的页面（详情页/历史页）。
  var playerReturn = null;
  function capturePlayerReturn(view) {
    if (!view) { playerReturn = null; return; }
    // 详情 view 含 _origin==='history'（历史卡片点击时标记） → 返回历史分类页；否则返回详情页
    playerReturn = { view: view, fromHistory: (view._origin === 'history') };
  }
  function returnFromPlayer() {
    if (!playerReturn) return; // 无记录 → 维持默认（home）
    var ctx = playerReturn;
    playerReturn = null;
    try {
      if (ctx.fromHistory) {
        openPage('history', '观看历史');       // 返回观看历史页
      } else if (ctx.view) {
        S.openDetailFromMeta(ctx.view);  // 返回详情页（重建）
      }
    } catch (e) {
      console.warn('[SFV-Online] returnFromPlayer 失败:', e && e.message);
    }
  }
  function isOpen() { return !!(S.overlay && S.overlay.classList.contains('sfv-show')); }

  function openCategory(field) { open({ mode: 'category', field: field }); }

  // ---------------------------------------------------------------- 视图栈
  function pushView(v) { S.stack.push(v); render(S.stack[S.stack.length - 1]); }

  // T145 修复（P0）：确保浏览层已创建且可见。
  function ensureOverlayShown() {
    ensure();
    if (!S.overlay) return;
    if (!isVideoSpace() && SFV.state && SFV.state.setSpace) {
      try { SFV.state.setSpace('video'); } catch (e) {}
    }
    var _prevUiMode = S.uiMode;
    if (!S.overlay.classList.contains('sfv-show')) S.overlay.classList.add('sfv-show');
    S.uiMode = 'view';
    S.overlay.classList.remove('sfv-browse--page', 'sfv-browse--category', 'sfv-browse--fullscreen', 'sfv-browse--collections');
    // D5 修复：进入详情前若处于页面 tab 模式（uiMode==='page'），记录发起页 id，
    // 供 goBack 经 goToNav 返回该页面而非整层关闭回首页；非 page 模式（legacy/搜索）清空，防残留误触发。
    if (_prevUiMode === 'page' && SFV.router && typeof SFV.router.currentId === 'function') {
      S._returnPageId = SFV.router.currentId();
    } else {
      S._returnPageId = null;
    }
    try { if (typeof unlockBodyScroll === 'function') unlockBodyScroll(); } catch (e) {}
  }

  function goBack() {
    // D5 修复：若当前详情由页面 tab 发起（记录了返回页 _returnPageId），优先经 goToNav 返回发起页，
    // 而非 close() 回首页。此前「页面→详情→返回」会被踢回首页、丢失发起分页。
    // 历史页是独立 router 页（非 nav tab），goToNav 会错误地移除 .sfv-history-page 导致背景透明，
    // 因此对 history 改用 openPage 重新挂载，保留 sfv-history-page 实底类。
    if (S._returnPageId) {
      var _rp = S._returnPageId;
      S._returnPageId = null;
      S.stack.length = 0; S.current = null;
      if (SFV.router && typeof SFV.router.go === 'function') {
        if (_rp === 'history') { openPage('history', '观看历史'); }
        else { goToNav(_rp); }
      }
      else { close(); }
      return;
    }
    if (S.overlay && S.overlay.classList.contains('sfv-browse--fullscreen')) {
      var p = SFV.router ? SFV.router.current() : null;
      if (p && typeof p.back === 'function' && p.back() === true) return;
      close();
      S.activePageId = 'home';
      applyVideoPageBg();
      if (SFV.home && typeof SFV.home.render === 'function') {
        try { SFV.home.render(); } catch (e) { console.warn('[SFV-Online] goHome render failed', e); }
      }
      return;
    }
    if (S.uiMode === 'page') {
      var p = SFV.router ? SFV.router.current() : null;
      if (p && typeof p.back === 'function' && p.back() === true) return;
      // D1 修复：page 模式无内部子视图可消费返回时，← 应关闭覆盖层回到首页（此前为 no-op，
      // 用户点 ← 无任何反应，只能靠 ✕ 或切 tab）。先 unmount 当前 page（如电影页回收 3D 海报墙）再 close。
      if (p && typeof p.unmount === 'function') { try { p.unmount(); } catch (e) {} }
      close();
      return;
    }
    if (S.stack.length <= 1) {
      var bottom = S.stack[0];
      // D9 修复：返回目标以详情 view 自身的 from 标记判定，不再依赖易残留的全局 _detailOrigin。
      // 仅当栈底为详情且 from==='search' 时才逐级回到搜索页；其余（分类/片单/独立详情）一律关闭回首页。
      if (bottom && bottom.mode === 'detail' && bottom.from === 'search') {
        S.restoreSearchPage();
        return;
      }
      close(); return;
    }
    S.stack.pop();
    render(S.stack[S.stack.length - 1]);
  }

  function render(v) {
    // D3 修复：渲染新视图前，先把"即将离开"的当前视图滚动位置存回其对象，
    // 避免从详情返回分类时 render() 的 innerHTML='' + 强制 scrollTop=0 把滚动位置清掉。
    if (S.current && S.current !== v) {
      try { S.current._scroll = S.bodyEl.scrollTop; } catch (e) {}
    }
    S.current = v;
    applyGridDiyToBody();
    S.backBtn.style.visibility = 'visible';
    if (v.mode === 'category') {
      S.backBtn.innerHTML = '<svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>';
      S.backBtn.setAttribute('aria-label', '返回');
    } else {
      S.backBtn.textContent = S.stack.length > 1 ? '←' : '✕';
      S.backBtn.setAttribute('aria-label', S.stack.length > 1 ? '返回' : '关闭');
    }
    S.overlay.classList.toggle('sfv-browse--category', v.mode === 'category');
    S.bodyEl.innerHTML = '';
    setNote('');
    if (v.mode === 'category') { setBrowseChrome(true); S.renderCategory(v); }
    else if (v.mode === 'detail') { setBrowseChrome(true); S.renderDetail(v); }
    else if (v.mode === 'rules') { setBrowseChrome(true); S.renderRules(v); }
    else if (v.mode === 'collection-items') { setBrowseChrome(true); S.renderCollectionItems(v); }
    applyVideoPageBg();
    if (SFV.pageBgDiy) SFV.pageBgDiy.sync();
    // D3 修复：重建后恢复该视图自身记录的滚动位置；首次进入（无记录）保持原生顶部 0。
    try { S.bodyEl.scrollTop = (v._scroll != null) ? v._scroll : 0; } catch (e) {}
  }

  // ===== 网格 DIY =====
  function applyGridDiyToBody() {
    if (!S.bodyEl) return;
    var prefs = null;
    try {
      var raw = (typeof localStorage !== 'undefined') ? localStorage.getItem('stellaflix-grid-diy-prefs') : null;
      prefs = raw ? JSON.parse(raw) : null;
    } catch (e) { prefs = null; }
    if (!prefs) return;
    var s = prefs.shell || {};
    var g = prefs.grid || {};
    if (s.bg != null) S.bodyEl.style.setProperty('--sfv-card-bg', s.bg);
    if (s.border != null) S.bodyEl.style.setProperty('--sfv-card-border', s.border);
    if (s.radius != null) S.bodyEl.style.setProperty('--sfv-card-radius', s.radius + 'px');
    if (s.shadowColor != null) S.bodyEl.style.setProperty('--sfv-card-shadow-color', s.shadowColor);
    if (s.hoverBorder != null) S.bodyEl.style.setProperty('--sfv-card-hover-border', s.hoverBorder);
    if (s.padding != null) S.bodyEl.style.setProperty('--sfv-card-padding', s.padding + 'px');
    if (s.title != null) S.bodyEl.style.setProperty('--sfv-card-title', s.title);
    if (s.sub != null) S.bodyEl.style.setProperty('--sfv-card-sub', s.sub);
    if (g.gap != null) S.bodyEl.style.setProperty('--sfv-gap', g.gap + 'px');
    S.bodyEl.style.setProperty('--sfv-poster-ratio', '2 / 3');
  }

  // ===== 影视分页背景：复用歌词 tab「视觉主色 / 封面取色」控件（T119）=====
  function applyVideoPageBg() {
    if (!S.bodyEl) return;
    var inVideo = document.body && document.body.classList.contains('video-space-active');
    if (!inVideo) { S.bodyEl.style.removeProperty('--sfv-page-bg'); return; }
    var isMovieAnime = (S.activePageId === 'movie' || S.activePageId === 'anime');
    var fx = (typeof window !== 'undefined') ? window.fx : null;
    var custom = !!(fx && fx.visualTintMode === 'custom' && typeof fx.visualTintColor === 'string'
                    && /^#[0-9a-fA-F]{6}$/.test(fx.visualTintColor));
    if (isMovieAnime && custom) {
      S.bodyEl.style.setProperty('--sfv-page-bg', fx.visualTintColor);
      if (S.overlay) S.overlay.style.setProperty('--sfv-page-bg', fx.visualTintColor);
    } else {
      S.bodyEl.style.removeProperty('--sfv-page-bg');
      if (S.overlay) S.overlay.style.removeProperty('--sfv-page-bg');
    }
  }

  function bindVideoPageBgFromTint() {
    if (typeof document === 'undefined') return;
    var docEl = document.documentElement;
    var lastKey = '__init__';
    function check() {
      var fx = (typeof window !== 'undefined') ? window.fx : null;
      var key = fx ? (fx.visualTintMode + '|' + (fx.visualTintColor || '')) : '';
      if (key === lastKey) return;
      lastKey = key;
      applyVideoPageBg();
    }
    if (typeof MutationObserver !== 'undefined') {
      try {
        var mo = new MutationObserver(check);
        mo.observe(docEl, { attributes: true, attributeFilter: ['style'] });
      } catch (e) {}
    }
    check();
  }

  function setNote(msg, type) {
    S.noteEl.className = 'sfv-browse-note';
    if (!msg) { S.noteEl.style.display = 'none'; S.noteEl.textContent = ''; return; }
    S.noteEl.style.display = 'block';
    S.noteEl.textContent = msg;
    if (type) S.noteEl.classList.add('sfv-browse-note--' + type);
  }

  function setBrowseChrome(on) {
    if (S.overlay) S.overlay.classList.toggle('sfv-browse--browse', !!on);
  }

  function renderLoading(text) {
    S.bodyEl.innerHTML = '';
    var box = el('div', 'sfv-loading');
    box.appendChild(el('div', 'sfv-spinner'));
    box.appendChild(el('div', 'sfv-loading-text', text || '加载中…'));
    S.bodyEl.appendChild(box);
  }

  // ---------------------------------------------------------------- 注册到共享状态 S + 命名空间（与 online.js 别名委托一致）
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
  S.onNavItemClick = onNavItemClick;
  S.setActiveNav = setActiveNav;
  S.handleNavAction = handleNavAction;
  S.goToNav = goToNav;
  S.goHome = goHome;
  S.unlockBodyScroll = unlockBodyScroll;
  S.lockBodyScroll = lockBodyScroll;
  S.capturePlayerReturn = capturePlayerReturn;
  S.returnFromPlayer = returnFromPlayer;
  S.openPage = openPage;

  SFV.onlineNav = {
    ensure: ensure, open: open, close: close, goBack: goBack, isOpen: isOpen,
    openCategory: openCategory, pushView: pushView, ensureOverlayShown: ensureOverlayShown,
    closeOverlayAnimated: closeOverlayAnimated, destroyDetail: destroyDetail, render: render,
    applyGridDiyToBody: applyGridDiyToBody, applyVideoPageBg: applyVideoPageBg,
    bindVideoPageBgFromTint: bindVideoPageBgFromTint, setNote: setNote, setBrowseChrome: setBrowseChrome,
    renderLoading: renderLoading, onNavItemClick: onNavItemClick, setActiveNav: setActiveNav,
    handleNavAction: handleNavAction, goToNav: goToNav, goHome: goHome, openPage: openPage,
    unlockBodyScroll: unlockBodyScroll, lockBodyScroll: lockBodyScroll,
    capturePlayerReturn: capturePlayerReturn, returnFromPlayer: returnFromPlayer,
  };

  console.log('[SFV-DIAG] online-nav.js 集群已加载（生命周期/导航/外壳）');
})(typeof window !== 'undefined' ? window : this);
