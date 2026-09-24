/*
 * Stellaflix 影视模块 — 首页「精选片单」浮层 = 片单中心（影视态 DISCOVER 卡入口）
 *
 * 结构（参照移动端精选片单页设计，落地于弹窗而非页面）：
 *   - 顶部 tab 条：推荐 / 主题 / 经典 / 高分 / 获奖（只读内置 CATALOG，SFV.collections.getByTab）
 *   - 两列封面卡网格：warm 纯色场域封面区（def.warm 同色系 linear-gradient）+ 左置扇形叠卡
 *     + 封面下方独立文案区（v2 的海报 blur 底与 ::after 渐晕已移除，2026-09-25 参照截图；
 *     canvas 红线不变 —— 7c84045 跨源污染事故）
 *     计数：分页型片单=「精选N部」，全量型=「共N部」
 *   - 封面快照：localStorage（stellaflix-collection-cover-snapshot-v1），打开即回填，
 *     24h 内新鲜即跳过补请求；过期才逐卡 collections.getItems 异步补海报/计数并写回
 * 点击卡片 → 弹窗内二级页（openCollectionDetail）：清晰海报 hero + 三列海报网格（年份/地区/类型胶囊）+ 环境色面板底。
 * 二级页点条目 → SFV.online.openDetailFromMeta(it) 进详情页。
 * 双态隔离：仅影视态首页调用；音乐态「平台热歌与个人偏好」路径不经过本文件。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var LS = global.localStorage;

  var SNAPSHOT_KEY = 'stellaflix-collection-cover-snapshot-v1';
  var SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
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

  // 计数语义：只有 tmdb-collection / static-list 是片单全量，可写「共N部」；
  // trending/popular/upcoming/discover 仅取 TMDB 第 1 页（20 条），写作「精选N部」
  var COMPLETE_TYPES = { 'tmdb-collection': true, 'static-list': true };
  function countLabel(def, n) {
    var num = Number(n);
    if (!num || num < 0) return '';
    return (COMPLETE_TYPES[def && def.type] ? '共' : '精选') + num + '部';
  }

  // 快照里的 color 来自外部数据链路，只认 #rrggbb 才允许进样式（防篡改注入）
  function isHexColor(c) {
    return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
  }

  function readSnapshots() {
    if (!LS) return {};
    try {
      var raw = LS.getItem(SNAPSHOT_KEY);
      var p = raw ? JSON.parse(raw) : null;
      return p && typeof p === 'object' ? p : {};
    } catch (e) { return {}; }
  }
  function writeSnapshot(id, posters, count, color) {
    if (!LS || !id) return;
    try {
      var s = readSnapshots();
      s[id] = { posters: posters.slice(0, 3), count: count, ts: Date.now() };
      if (isHexColor(color)) s[id].color = color;
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
    var countText = countLabel(def, snap && snap.count) || esc(def.sub || '');
    // 色温跟随首张海报：快照 color 优先，CATALOG warm 兜底
    var warm = (snap && isHexColor(snap.color) && snap.color) || def.warm || '#534AB7';
    return '<button class="home-video-collections-card" type="button" data-wc-id="' + esc(def.id) + '"' +
      ' style="--wc-warm:' + esc(warm) + '">' +
      '<span class="home-video-collections-cover" aria-hidden="true">' +
      stackHtml(snap && snap.posters, def) +
      '</span>' +
      '<span class="home-video-collections-copy">' +
      '<strong>' + esc(def.title) + '</strong>' +
      '<small data-wc-count' + (snap && snap.count ? '' : ' class="home-video-collections-count-sub"') + '>' +
      countText + '</small></span></button>';
  }

  function renderTabs() {
    var bar = document.getElementById('home-video-collections-tabs');
    if (!bar) return;
    bar.innerHTML = OVERLAY_TABS.map(function (t) {
      var active = t.id === state.activeTab;
      return '<button type="button" class="home-video-collections-tab' +
        (active ? ' active' : '') + '" data-wc-tab="' + t.id + '"' +
        ' id="home-video-collections-tab-' + t.id + '" role="tab"' +
        ' aria-selected="' + (active ? 'true' : 'false') + '"' +
        ' aria-controls="home-video-collections-list">' + esc(t.label) + '</button>';
    }).join('');
    var panel = document.getElementById('home-video-collections-list');
    if (panel) panel.setAttribute('aria-labelledby', 'home-video-collections-tab-' + state.activeTab);
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
    fillCovers(defs, snaps);
  }

  function updateCardDom(def, posters, count, color) {
    var list = document.getElementById('home-video-collections-list');
    if (!list) return;
    var id = def && def.id;
    var card = list.querySelector('[data-wc-id="' + (global.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    if (!card) return;
    var stack = card.querySelector('.home-video-collections-stack');
    if (stack && posters.length) {
      stack.innerHTML = posters.slice(0, 3).map(function (u) {
        return '<img src="' + esc(safeUrl(u)) + '" alt="" loading="lazy" referrerpolicy="no-referrer">';
      }).join('');
    }
    if (isHexColor(color)) card.style.setProperty('--wc-warm', color);
    var countEl = card.querySelector('[data-wc-count]');
    var label = countLabel(def, count);
    if (countEl && label) {
      countEl.textContent = label;
      countEl.classList.remove('home-video-collections-count-sub');
    }
  }

  function fillColorOnly(def, snap, collections) {
    if (typeof collections.getPosterColor !== 'function') return;
    var first = snap.posters && snap.posters[0];
    if (!first) return;
    collections.getPosterColor(first).then(function (color) {
      if (!isHexColor(color)) return;
      writeSnapshot(def.id, snap.posters, snap.count, color);
      updateCardDom(def, snap.posters, snap.count, color);
    }).catch(function () { /* 取色失败：保持 CATALOG warm 兜底 */ });
  }

  function fillCovers(defs, snaps) {
    var collections = SFV.collections;
    if (!collections || typeof collections.getItems !== 'function') return;
    var now = Date.now();
    defs.forEach(function (def) {
      if (!def || def.type === 'placeholder') return;
      var snap = snaps && snaps[def.id];
      // 快照 24h 内新鲜：cardHtml 已按快照回填海报/计数，跳过补请求（冷启动零请求）
      if (snap && Number(snap.count) > 0 && now - (snap.ts || 0) < SNAPSHOT_TTL_MS) {
        // 旧格式快照没有 color：只补一次取色，不重拉列表
        if (!isHexColor(snap.color)) fillColorOnly(def, snap, collections);
        return;
      }
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
        updateCardDom(def, posters, list.length);
        // 色温跟随首张海报：按刷新后的首条目海报取色，异步回填
        if (posters[0]) {
          var first = list[0].poster || posters[0];
          collections.getPosterColor(first).then(function (color) {
            if (!isHexColor(color)) return;
            writeSnapshot(def.id, posters, list.length, color);
            updateCardDom(def, posters, list.length, color);
          }).catch(function () { /* 无 Key / 网络失败：保持 CATALOG warm 兜底 */ });
        }
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
    if (modal) modal.style.setProperty('--wc-warm', def.warm || '#534AB7'); // D2：面板环境色取片单主色
    var items = col.items || [];
    var heroPoster = items[0] && items[0].poster;
    var countText = col.error ? '加载失败'
      : col.placeholder ? '即将上线'
      : (items.length ? countLabel(def, items.length) : '加载中…');
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
    } else if (col.placeholder) {
      html += '<div class="home-video-collections-items-empty">该片单即将上线，敬请期待</div>';
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
    if (def.type === 'placeholder') {
      // 占位片单无数据源：直接渲染「即将上线」，不进 getItems（否则暴露 UNKNOWN_TYPE 错误码）
      state.collection.placeholder = true;
      renderItemsPage();
      return;
    }
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
    if (modal) {
      modal.classList.remove('home-video-collections--detail');
      modal.style.removeProperty('--wc-warm'); // 防环境色残留到一级 tab 态
    }
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
    if (modal) {
      modal.classList.remove('home-video-collections--detail');
      modal.style.removeProperty('--wc-warm');
    }
    var focusTarget = state.previousFocus;
    state.previousFocus = null;
    if (focusTarget && typeof focusTarget.focus === 'function') {
      setTimeout(function () { focusTarget.focus(); }, 0);
    }
  }

  var FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
  // aria-modal="true" 的兑现：Tab/Shift+Tab 在浮层内循环，焦点不得走到背后 Home
  function trapTabFocus(event) {
    var mask = document.getElementById('home-video-collections-mask');
    if (!mask) return;
    var els = [].slice.call(mask.querySelectorAll(FOCUSABLE_SELECTOR)).filter(function (el) {
      if (el.disabled) return false;
      // 二级页在场时 tab 条被 CSS 隐藏，浏览器原生 Tab 会跳过，陷阱同样排除
      if (state.collection && el.closest('.home-video-collections-tabs')) return false;
      return true;
    });
    if (!els.length) return;
    var first = els[0];
    var last = els[els.length - 1];
    var active = document.activeElement;
    if (event.shiftKey && (active === first || !mask.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !mask.contains(active))) {
      event.preventDefault();
      first.focus();
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
      if (!state.open) return;
      if (event.key === 'Tab') { trapTabFocus(event); return; }
      if (event.key !== 'Escape') return;
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
