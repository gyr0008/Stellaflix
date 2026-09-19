/*
 * Stellaflix 影视模块 — 首页「精选片单」浮层 = 片单中心（影视态 DISCOVER 卡入口）
 *
 * 结构（参照移动端精选片单页设计，落地于弹窗而非页面）：
 *   - 顶部 tab 条：推荐 / 主题 / 经典 / 高分 / 获奖（只读内置 CATALOG，SFV.collections.getByTab）
 *   - 两列封面卡网格：模糊海报底（CSS filter blur，禁 canvas —— 7c84045 跨源污染事故）
 *     + 叠卡海报 + 标题 + 「共N部」计数
 *   - 封面快照：localStorage（stellaflix-collection-cover-snapshot-v1），打开即回填，
 *     随后逐卡 collections.getItems 异步补海报/计数并写回快照
 * 点击卡片 → 弹窗内二级页（openCollectionDetail）：hero 头图 + 四列海报网格（年份/地区/类型胶囊）。
 * 二级页点条目 → SFV.online.openDetailFromMeta(it) 进详情页。
 * 双态隔离：仅影视态首页调用；音乐态「平台热歌与个人偏好」路径不经过本文件。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var LS = global.localStorage;

  var SNAPSHOT_KEY = 'stellaflix-collection-cover-snapshot-v1';
  var OVERLAY_TABS = [
    { id: 'featured', label: '推荐' },
    { id: 'theme', label: '主题' },
    { id: 'classic', label: '经典' },
    { id: 'highscore', label: '高分' },
    { id: 'awards', label: '获奖' }
  ];
  function overlayTabs() { return OVERLAY_TABS.map(function (t) { return { id: t.id, label: t.label }; }); }

  var state = { open: false, previousFocus: null, activeTab: 'featured', defs: [], collection: null };
  var controlsBound = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function safeUrl(u) {
    return String(u || '').replace(/["'\\()]/g, '').slice(0, 500);
  }

  function readSnapshots() {
    if (!LS) return {};
    try {
      var raw = LS.getItem(SNAPSHOT_KEY);
      var p = raw ? JSON.parse(raw) : null;
      return p && typeof p === 'object' ? p : {};
    } catch (e) { return {}; }
  }
  function writeSnapshot(id, posters, count) {
    if (!LS || !id) return;
    try {
      var s = readSnapshots();
      s[id] = { posters: posters.slice(0, 3), count: count, ts: Date.now() };
      LS.setItem(SNAPSHOT_KEY, JSON.stringify(s));
    } catch (e) {}
  }

  function defsForTab(tabId) {
    var collections = SFV.collections;
    if (!collections || typeof collections.getByTab !== 'function') return [];
    return collections.getByTab(tabId) || [];
  }

  function stackHtml(posters, def) {
    var urls = (posters || []).filter(Boolean).slice(0, 3);
    if (urls.length) {
      return '<span class="home-video-collections-stack" aria-hidden="true">' +
        urls.map(function (u) {
          return '<img src="' + esc(safeUrl(u)) + '" alt="" loading="lazy" referrerpolicy="no-referrer">';
        }).join('') + '</span>';
    }
    return '<span class="home-video-collections-stack" aria-hidden="true"><i></i><i></i><i></i></span>';
  }

  function cardHtml(def, snap) {
    var bg = snap && snap.posters && snap.posters[0];
    var bgStyle = bg ? ' style="background-image:url(' + esc(safeUrl(bg)) + ')"' : '';
    var countText = snap && snap.count ? '共' + snap.count + '部' : esc(def.sub || '');
    return '<button class="home-video-collections-card" type="button" data-wc-id="' + esc(def.id) + '"' +
      ' style="--wc-warm:' + esc(def.warm || '#534AB7') + '">' +
      '<span class="home-video-collections-card-bg" aria-hidden="true"' + bgStyle + '></span>' +
      stackHtml(snap && snap.posters, def) +
      '<span class="home-video-collections-copy">' +
      '<strong>' + esc(def.title) + '</strong>' +
      '<small data-wc-count' + (snap && snap.count ? '' : ' class="home-video-collections-count-sub"') + '>' +
      countText + '</small></span></button>';
  }

  function renderTabs() {
    var bar = document.getElementById('home-video-collections-tabs');
    if (!bar) return;
    bar.innerHTML = OVERLAY_TABS.map(function (t) {
      return '<button type="button" class="home-video-collections-tab' +
        (t.id === state.activeTab ? ' active' : '') + '" data-wc-tab="' + t.id + '"' +
        (t.id === state.activeTab ? ' aria-current="true"' : '') + '>' + esc(t.label) + '</button>';
    }).join('');
  }

  function renderList() {
    var list = document.getElementById('home-video-collections-list');
    if (!list) return;
    var defs = defsForTab(state.activeTab);
    state.defs = defs;
    if (!defs.length) {
      list.innerHTML = '<div class="home-video-collections-empty">片单模块未就绪</div>';
      return;
    }
    var snaps = readSnapshots();
    list.innerHTML = '<div class="home-video-collections-grid">' +
      defs.map(function (d) { return cardHtml(d, snaps[d.id]); }).join('') + '</div>';
    fillCovers(defs);
  }

  function updateCardDom(id, posters, count) {
    var list = document.getElementById('home-video-collections-list');
    if (!list) return;
    var card = list.querySelector('[data-wc-id="' + (global.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    if (!card) return;
    var bg = card.querySelector('.home-video-collections-card-bg');
    if (bg && posters[0]) bg.style.backgroundImage = 'url(' + safeUrl(posters[0]) + ')';
    var stack = card.querySelector('.home-video-collections-stack');
    if (stack && posters.length) {
      stack.innerHTML = posters.slice(0, 3).map(function (u) {
        return '<img src="' + esc(safeUrl(u)) + '" alt="" loading="lazy" referrerpolicy="no-referrer">';
      }).join('');
    }
    var countEl = card.querySelector('[data-wc-count]');
    if (countEl && count) {
      countEl.textContent = '共' + count + '部';
      countEl.classList.remove('home-video-collections-count-sub');
    }
  }

  function fillCovers(defs) {
    var collections = SFV.collections;
    if (!collections || typeof collections.getItems !== 'function') return;
    defs.forEach(function (def) {
      if (!def || def.type === 'placeholder') return;
      var got;
      try { got = collections.getItems(def); } catch (e) { return; }
      if (!got || typeof got.then !== 'function') return;
      got.then(function (items) {
        var list = items && items.length ? items : [];
        var posters = [];
        for (var i = 0; i < list.length && posters.length < 3; i++) {
          var it = list[i];
          var img = it && (it.poster || it.pic);
          if (img) posters.push(img);
        }
        if (!list.length) return;
        writeSnapshot(def.id, posters, list.length);
        updateCardDom(def.id, posters, list.length);
      }).catch(function () { /* 无 Key / 网络失败：保留 warm 渐变兜底 */ });
    });
  }

  // ---------------------------------------------------------------- 二级页（片单明细）
  function itemCardHtml(it) {
    var tmdb = SFV.tmdb;
    var genres = (it.genres && it.genres.length)
      ? it.genres.join('、')
      : (tmdb && tmdb.genreNames ? tmdb.genreNames(it.genreIds) : '');
    var region = (tmdb && tmdb.regionLabel) ? tmdb.regionLabel(it.originalLanguage) : '';
    // 缺字段即整段省略胶囊（参照 App 会把缺失年份渲染成「0」，不照抄）
    return '<button class="home-video-collections-item" type="button" data-wc-item="' + esc(it.id) + '">' +
      '<span class="home-video-collections-item-poster" style="background-image:url(' + esc(safeUrl(it.poster)) + ')">' +
      (it.year ? '<span class="home-video-collections-item-year">' + esc(it.year) + '</span>' : '') +
      (region ? '<span class="home-video-collections-item-region">' + esc(region) + '</span>' : '') +
      (genres ? '<span class="home-video-collections-item-genres">' + esc(genres) + '</span>' : '') +
      '</span>' +
      '<span class="home-video-collections-item-title">' + esc(it.title || '') + '</span>' +
      '</button>';
  }

  function renderItemsPage() {
    var list = document.getElementById('home-video-collections-list');
    var modal = document.querySelector('.home-video-collections-modal');
    if (!list) return;
    if (modal) modal.classList.add('home-video-collections--detail');
    var col = state.collection;
    if (!col) return;
    var def = col.def;
    var items = col.items || [];
    var heroPoster = items[0] && items[0].poster;
    var countText = col.error ? '加载失败' : (items.length ? '共' + items.length + '部' : '加载中…');
    var html = '<div class="home-video-collections-hero" style="--wc-warm:' + esc(def.warm || '#534AB7') + '">' +
      '<span class="home-video-collections-hero-bg" aria-hidden="true"' +
      (heroPoster ? ' style="background-image:url(' + esc(safeUrl(heroPoster)) + ')"' : '') + '></span>' +
      '<button class="home-video-collections-back" type="button" data-wc-back aria-label="返回片单列表">←</button>' +
      '<span class="home-video-collections-hero-copy"><strong>' + esc(def.title) + '</strong>' +
      '<small>' + esc(countText) + '</small></span></div>';
    if (col.error) {
      html += '<div class="home-video-collections-items-empty">' +
        (col.error === 'TMDB_KEY_REQUIRED' ? '打开片单内容需要先在设置配置 TMDB Key' : '片单加载失败：' + esc(col.error)) +
        '</div>';
    } else if (items.length) {
      html += '<div class="home-video-collections-items-grid">' +
        items.map(itemCardHtml).join('') + '</div>';
    } else {
      html += '<div class="home-video-collections-items-loading">加载中…</div>';
    }
    list.innerHTML = html;
  }

  function openCollectionDetail(def) {
    state.collection = { def: def, items: null, error: '' };
    renderItemsPage();
    var collections = SFV.collections;
    if (!collections || typeof collections.getItems !== 'function') {
      state.collection.error = '片单模块未加载';
      renderItemsPage();
      return;
    }
    collections.getItems(def).then(function (items) {
      if (!state.collection || state.collection.def !== def) return; // 已返回/已切片单
      state.collection.items = items || [];
      renderItemsPage();
    }).catch(function (e) {
      if (!state.collection || state.collection.def !== def) return;
      state.collection.error = (e && e.message) || String(e || '加载失败');
      renderItemsPage();
    });
  }

  function closeCollectionDetail() {
    state.collection = null;
    var modal = document.querySelector('.home-video-collections-modal');
    if (modal) modal.classList.remove('home-video-collections--detail');
    renderTabs();
    renderList();
  }

  function openItemDetail(idStr) {
    var col = state.collection;
    if (!col || !col.items) return;
    var it = null;
    for (var i = 0; i < col.items.length; i++) {
      if (col.items[i] && String(col.items[i].id) === idStr) { it = col.items[i]; break; }
    }
    if (!it || !SFV.online || typeof SFV.online.openDetailFromMeta !== 'function') return;
    closeHomeVideoCollectionsOverlay();
    SFV.online.openDetailFromMeta(it);
  }

  function openCollectionById(id) {
    var def = null;
    state.defs.forEach(function (d) { if (d && d.id === id) def = d; });
    if (def) openCollectionDetail(def);
  }

  function closeHomeVideoCollectionsOverlay() {
    var mask = document.getElementById('home-video-collections-mask');
    if (!mask) return;
    mask.classList.remove('show');
    mask.setAttribute('aria-hidden', 'true');
    state.open = false;
    // 整窗关闭即回一级：下次打开不残留二级页
    state.collection = null;
    var modal = document.querySelector('.home-video-collections-modal');
    if (modal) modal.classList.remove('home-video-collections--detail');
    var focusTarget = state.previousFocus;
    state.previousFocus = null;
    if (focusTarget && typeof focusTarget.focus === 'function') {
      setTimeout(function () { focusTarget.focus(); }, 0);
    }
  }

  function bindHomeVideoCollectionsControls() {
    if (controlsBound) return;
    controlsBound = true;
    var mask = document.getElementById('home-video-collections-mask');
    var list = document.getElementById('home-video-collections-list');
    var tabsBar = document.getElementById('home-video-collections-tabs');
    var close = document.getElementById('home-video-collections-close');
    if (list) list.addEventListener('click', function (event) {
      if (event.target.closest('[data-wc-back]')) { closeCollectionDetail(); return; }
      var itemEl = event.target.closest('[data-wc-item]');
      if (itemEl && list.contains(itemEl)) { openItemDetail(itemEl.getAttribute('data-wc-item')); return; }
      var card = event.target.closest('[data-wc-id]');
      if (!card || !list.contains(card)) return;
      openCollectionById(card.getAttribute('data-wc-id'));
    });
    if (tabsBar) tabsBar.addEventListener('click', function (event) {
      var tab = event.target.closest('[data-wc-tab]');
      if (!tab || !tabsBar.contains(tab)) return;
      var id = tab.getAttribute('data-wc-tab');
      if (id === state.activeTab) return;
      state.activeTab = id;
      renderTabs();
      renderList();
    });
    if (close) close.addEventListener('click', closeHomeVideoCollectionsOverlay);
    if (mask) mask.addEventListener('click', function (event) {
      if (event.target === mask) closeHomeVideoCollectionsOverlay();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape' || !state.open) return;
      // 二级页在场时 Esc 先回一级，再按一次才关整个弹窗
      if (state.collection) closeCollectionDetail();
      else closeHomeVideoCollectionsOverlay();
    });
  }

  function openHomeVideoCollectionsOverlay() {
    bindHomeVideoCollectionsControls();
    var mask = document.getElementById('home-video-collections-mask');
    if (!mask) return;
    state.previousFocus = document.activeElement;
    state.open = true;
    renderTabs();
    renderList();
    mask.classList.add('show');
    mask.setAttribute('aria-hidden', 'false');
    setTimeout(function () {
      var first = mask.querySelector('.home-video-collections-card');
      if (first) first.focus();
    }, 0);
  }

  SFV.homeCollectionsOverlay = {
    open: openHomeVideoCollectionsOverlay,
    close: closeHomeVideoCollectionsOverlay,
    OVERLAY_TABS: overlayTabs()
  };
  SFV.homeCollectionsOverlay.overlayTabs = overlayTabs;
})(typeof window !== 'undefined' ? window : this);
