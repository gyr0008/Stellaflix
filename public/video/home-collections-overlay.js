/*
 * Stellaflix 影视模块 — 首页「精选片单」浮层 = 片单中心（影视态 DISCOVER 卡入口）
 *
 * 结构（参照移动端精选片单页设计，落地于弹窗而非页面）：
 *   - 顶部 tab 条：推荐 / 系列 / 榜单 / 类型（只读内置 CATALOG，SFV.collections.getByTab）
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
  // tmdb-list 分页修复标记：09-27 之前 tmdb.getList 误读 TMDB 根本不返回的 pages 字段，
  // 社区榜恒停在第 1 页 = 「共20部」。那期间写入的快照 type 相同又未过期，
  // 光修分页会让错的 count 继续挂最长 24h → 用标记一次性作废（用户端自愈，无需清库）。
  var LIST_FULL_MARK = 'v2';
  var SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
  var OVERLAY_TABS = [
    { id: 'featured', label: '推荐' },
    { id: 'series', label: '系列' },
    { id: 'lists', label: '榜单' },
    { id: 'genres', label: '类型' }
  ];
  function overlayTabs() { return OVERLAY_TABS.map(function (t) { return { id: t.id, label: t.label }; }); }

  // tabScroll：4 个 tab 共用一个滚动容器（#home-video-collections-list），
  // 切 tab 走 innerHTML 整体替换 —— 浏览器不会重置 scrollTop，位置会被当成「容器状态」而非「tab 状态」，
  // 于是「系列」滚到第 3 屏切「榜单」仍停在同一位置 = 滚轮相互泄露。
  // 记录口径：切走前把当前容器 scrollTop 存进 tabScroll[旧 tab]，渲染后回填 tabScroll[新 tab]。
  var state = { open: false, parked: false, previousFocus: null, activeTab: 'featured', defs: [], collection: null, tabScroll: Object.create(null) };
  var controlsBound = false;

  function overlayTabIds() { return OVERLAY_TABS.map(function (t) { return t.id; }); }

  // 切走 / 进二级页前调用：把当前容器的滚动位置记到当前 tab 名下
  function rememberTabScroll() {
    var list = document.getElementById('home-video-collections-list');
    if (!list) return;
    state.tabScroll[state.activeTab] = list.scrollTop || 0;
  }

  // 渲染后调用：把当前 tab 自己的滚动位置回填。
  // 记录值不回写浏览器 clamp 结果 —— 切到内容更短的 tab 被钳到 0 属预期，
  // 保留原值才能让切回长内容 tab 时位置不丢（这才是「独立记录」相对共用 scrollTop 的意义）。
  function restoreTabScroll() {
    var list = document.getElementById('home-video-collections-list');
    if (!list) return;
    list.scrollTop = state.tabScroll[state.activeTab] || 0;
  }

  // 整窗重开按原语义回顶：清空全部 tab 记录（不做跨次持久化）
  function resetTabScroll() {
    state.tabScroll = Object.create(null);
    overlayTabIds().forEach(function (id) { state.tabScroll[id] = 0; });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function safeUrl(u) {
    return String(u || '').replace(/["'\\()]/g, '').slice(0, 500);
  }

  // 计数语义：tmdb-collection / static-list / tmdb-list（getListAll 逐页拉全）是片单全量，可写「共N部」；
  // trending/popular/upcoming/discover 仅取 TMDB 第 1 页（20 条），写作「精选N部」
  var COMPLETE_TYPES = { 'tmdb-collection': true, 'static-list': true, 'tmdb-list': true };
  function countLabel(def, n) {
    var num = Number(n);
    if (!num || num < 0) return '';
    return (COMPLETE_TYPES[def && def.type] ? '共' : '精选') + num + '部';
  }

  // 快照里的 color 来自外部数据链路，只认 #rrggbb 才允许进样式（防篡改注入）
  function isHexColor(c) {
    return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
  }

  // 环境色（页面底）明度上限：底色提浓到 70% 后，亮色海报（高饱和粉/黄）会把白字压到不可读。
  // 实测参考图底色 #684828（白字 8.3:1）/ #286060（7.2:1），对应相对亮度 0.077~0.097；
  // 取 0.13 作上限 → 最差对比度 1.05/(0.13+0.05) ≈ 5.8:1，留足余量（AA 要求 4.5:1）。
  var AMBIENT_MAX_LUM = 0.13;
  function srgbLuminance(r, g, b) {
    function f(v) {
      var s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  // 主色压到明度上限：等比缩放保色相，只变明暗。已经够暗则原样返回（不动色相）
  function ambientFrom(hex) {
    if (!isHexColor(hex)) return '';
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    if (srgbLuminance(r, g, b) <= AMBIENT_MAX_LUM) return hex;
    var lo = 0, hi = 1;
    for (var i = 0; i < 12; i++) {
      var m = (lo + hi) / 2;
      if (srgbLuminance(r * m, g * m, b * m) > AMBIENT_MAX_LUM) hi = m; else lo = m;
    }
    return '#' + [r, g, b].map(function (v) {
      var n = Math.round(v * lo);
      if (n < 0) n = 0;
      if (n > 255) n = 255;
      return ('0' + n.toString(16)).slice(-2);
    }).join('');
  }

  function readSnapshots() {
    if (!LS) return {};
    try {
      var raw = LS.getItem(SNAPSHOT_KEY);
      var p = raw ? JSON.parse(raw) : null;
      return p && typeof p === 'object' ? p : {};
    } catch (e) { return {}; }
  }
  // 快照记 def.type：CATALOG 换数据源（如 discover→static-list）后 id 不变，
  // 不带来源标识会让卡片沿用旧 count 最长 24h，而二级页现拉现算 → 两处不一致（09-26「共17部」实机反馈）
  function writeSnapshot(def, posters, count, color) {
    var id = def && def.id;
    if (!LS || !id) return;
    try {
      var s = readSnapshots();
      s[id] = { posters: posters.slice(0, 3), count: count, ts: Date.now(), type: def.type };
      if (def.type === 'tmdb-list') s[id].fullMark = LIST_FULL_MARK;
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
      restoreTabScroll();
      return;
    }
    var snaps = readSnapshots();
    list.innerHTML = '<div class="home-video-collections-grid">' +
      defs.map(function (d) { return cardHtml(d, snaps[d.id]); }).join('') + '</div>';
    fillCovers(defs, snaps);
    // 渲染后回填当前 tab 自己的滚动位置（唯一还原点，覆盖 打开/切 tab/二级页返回 全部渲染路径）。
    // 卡片高度由 CSS 固定（封面 150px + 文案区），不依赖图片加载 → 同步回填不会被钳制
    restoreTabScroll();
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
      writeSnapshot(def, snap.posters, snap.count, color);
      updateCardDom(def, snap.posters, snap.count, color);
    }).catch(function () { /* 取色失败：保持 CATALOG warm 兜底 */ });
  }

  function fillOneCover(def, collections) {
    var got;
    try { got = collections.getItems(def); } catch (e) { return Promise.resolve(); }
    if (!got || typeof got.then !== 'function') return Promise.resolve();
    return got.then(function (items) {
      var list = items && items.length ? items : [];
      var posters = [];
      for (var i = 0; i < list.length && posters.length < 3; i++) {
        var it = list[i];
        var img = it && (it.poster || it.pic);
        if (img) posters.push(img);
      }
      if (!list.length) return;
      writeSnapshot(def, posters, list.length);
      updateCardDom(def, posters, list.length);
      // 色温跟随首张海报：按刷新后的首条目海报取色，异步回填
      if (!posters[0] || typeof collections.getPosterColor !== 'function') return;
      var first = list[0].poster || posters[0];
      return collections.getPosterColor(first).then(function (color) {
        if (!isHexColor(color)) return;
        writeSnapshot(def, posters, list.length, color);
        updateCardDom(def, posters, list.length, color);
      }).catch(function () { /* 无 Key / 网络失败：保持 CATALOG warm 兜底 */ });
    }).catch(function () { /* 无 Key / 网络失败：保留 warm 渐变兜底 */ });
  }

  // 单卡「列表 + 取色」是一条链；lists tab 40 卡（2026-09-26 年度动画卡批）若同步全发
  // = 80 个上游请求，会撞 TMDB 限流反而更慢 → 全局小并发排队，切 tab 时过期任务直接丢弃。
  var COVER_CONCURRENCY = 4;
  var coverQueue = [];
  var coverActive = 0;
  var coverGen = 0;
  function pumpCoverQueue() {
    while (coverActive < COVER_CONCURRENCY && coverQueue.length) {
      var task = coverQueue.shift();
      if (task.gen !== coverGen) continue; // 渲染已换代（切 tab / 重开浮层），不再为其发请求
      coverActive += 1;
      Promise.resolve().then(task.run).then(coverDone).catch(coverDone);
    }
  }
  function coverDone() {
    coverActive -= 1;
    pumpCoverQueue();
  }

  function fillCovers(defs, snaps) {
    var collections = SFV.collections;
    if (!collections || typeof collections.getItems !== 'function') return;
    var now = Date.now();
    coverGen += 1;
    var gen = coverGen;
    defs.forEach(function (def) {
      if (!def || def.type === 'placeholder') return;
      var snap = snaps && snaps[def.id];
      // 快照 24h 内新鲜且来源未变：cardHtml 已按快照回填海报/计数，跳过补请求（冷启动零请求）
      // 无 type 的历史快照一律视为陈旧 → 现拉一次并写回带 type 的新快照（用户端自愈，无需清库）
      // tmdb-list 还须带分页修复标记，否则是「共20部」时期的截断计数
      if (snap && Number(snap.count) > 0 && snap.type === def.type &&
        (def.type !== 'tmdb-list' || snap.fullMark === LIST_FULL_MARK) &&
        now - (snap.ts || 0) < SNAPSHOT_TTL_MS) {
        // 旧格式快照没有 color：只补一次取色，不重拉列表
        if (!isHexColor(snap.color)) coverQueue.push({ gen: gen, run: function () { return fillColorOnly(def, snap, collections); } });
        return;
      }
      coverQueue.push({ gen: gen, run: function () { return fillOneCover(def, collections); } });
    });
    pumpCoverQueue();
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

  // V1：二级页快照无 color 时按首条目海报异步补色（modal+hero），并写回快照
  function fillDetailColor(def, items, heroPoster) {
    var collections = SFV.collections;
    if (!collections || typeof collections.getPosterColor !== 'function') return;
    collections.getPosterColor(heroPoster).then(function (color) {
      if (!isHexColor(color)) return;
      if (!state.collection || state.collection.def !== def) return; // 已返回/已切片单
      var modal = document.querySelector('.home-video-collections-modal');
      if (modal) modal.style.setProperty('--wc-warm', color);
      if (modal) modal.style.setProperty('--wc-ambient', ambientFrom(color)); // 异步取色到位后同步页面底
      var hero = document.querySelector('.home-video-collections-hero');
      if (hero) hero.style.setProperty('--wc-warm', color);
      var posters = [];
      for (var i = 0; i < items.length && posters.length < 3; i++) {
        var img = items[i] && (items[i].poster || items[i].pic);
        if (img) posters.push(img);
      }
      writeSnapshot(def, posters, items.length, color);
    }).catch(function () { /* 取色失败：保持 CATALOG warm 兜底 */ });
  }

  function renderItemsPage() {
    var list = document.getElementById('home-video-collections-list');
    var modal = document.querySelector('.home-video-collections-modal');
    if (!list) return;
    if (modal) modal.classList.add('home-video-collections--detail');
    var col = state.collection;
    if (!col) return;
    var def = col.def;
    // V1 二级页色源与封面卡一致：快照海报取色 > CATALOG warm > 兜底紫
    var snaps = readSnapshots();
    var snap = def && snaps[def.id];
    var posterColor = snap && isHexColor(snap.color) ? snap.color : '';
    var warm = posterColor || def.warm || '#534AB7';
    if (modal) modal.style.setProperty('--wc-warm', warm); // D2：面板环境色取片单主色
    // 页面底 = 主色压到明度上限后的值（覆盖 CSS 里 color-mix 的兜底），保证白字可读
    if (modal) modal.style.setProperty('--wc-ambient', ambientFrom(warm));
    var items = col.items || [];
    var heroPoster = items[0] && items[0].poster;
    if (!posterColor && heroPoster && !col.error && !col.placeholder) {
      fillDetailColor(def, items, heroPoster);
    }
    // 标题居中大字（2026-10-01 对齐参考图）：正常态只显示标题，不再带「共N部」计数行。
    // 错误 / 占位 / 加载中仍须保留状态小字 —— 否则用户看不出加载状态（错误详情在下方空态里）
    var notice = col.error ? '加载失败'
      : col.placeholder ? '即将上线'
      : (items.length ? '' : '加载中…');
    var html = '<div class="home-video-collections-hero" style="--wc-warm:' + esc(warm) + '">' +
      '<span class="home-video-collections-hero-bg" aria-hidden="true"' +
      (heroPoster ? ' style="background-image:url(' + esc(safeUrl(heroPoster)) + ')"' : '') + '></span>' +
      // 返回图标：弯钩+箭头（2026-10-01 用户指定图形，替换原文本「←」）。
      // aria-hidden：按钮已有 aria-label，图标是装饰，避免读屏重复播报；尺寸由 CSS 类统一定义
      '<button class="home-video-collections-back" type="button" data-wc-back aria-label="返回片单列表">' +
      '<svg class="home-video-collections-back-icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">' +
      '<path opacity="0.4" d="M7.13 18.3096H15.13C17.89 18.3096 20.13 16.0696 20.13 13.3096C20.13 10.5496 17.89 8.30957 15.13 8.30957H4.13" stroke="#ffffff" stroke-width="1.5" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M6.43 10.8104L3.87 8.25043L6.43 5.69043" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg></button>' +
      '<span class="home-video-collections-hero-copy"><strong>' + esc(def.title) + '</strong>' +
      (notice ? '<small>' + esc(notice) + '</small>' : '') + '</span></div>';
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
    // 二级页与一级列表共用同一个滚动容器（#home-video-collections-list）：
    // innerHTML 替换不会重置 scrollTop，异步再渲染也可能带入旧位置 → 详情页强制回顶
    list.scrollTop = 0;
  }

  function openCollectionDetail(def) {
    // 进二级页前把一级列表滚动位置记到「当前 tab」名下，返回时由 renderList 按 tab 还原
    rememberTabScroll();
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
      modal.style.removeProperty('--wc-ambient');
    }
    renderTabs();
    renderList();
    // 返回一级列表：renderList 末尾已按「当前 tab 的记录」还原（scrollTop 保留值会因内容变矮
    // 被浏览器钳制，表现为「退出内容层后弹窗莫名下滑」→ 由 restoreTabScroll 显式回填兜住）。
    // 此处再显式调一次：切 tab 与二级页返回走同一条还原口径，不残留旧单值语义
    restoreTabScroll();
  }

  function openItemDetail(idStr) {
    var col = state.collection;
    if (!col || !col.items) return;
    var it = null;
    for (var i = 0; i < col.items.length; i++) {
      if (col.items[i] && String(col.items[i].id) === idStr) { it = col.items[i]; break; }
    }
    if (!it || !SFV.online || typeof SFV.online.openDetailFromMeta !== 'function') return;
    // 不整关弹窗而是「暂存」：详情页退出时经 online-nav.restoreCollectionsPage →
    // resumeFromDetail 原样恢复本片单二级页（对齐搜索页 restoreSearchPage 范式）
    if (typeof SFV.online.setDetailOrigin === 'function') SFV.online.setDetailOrigin('collections');
    parkForDetail();
    SFV.online.openDetailFromMeta(it);
  }

  // 暂存：只收起 mask，保留 state.open / state.collection / 二级页 DOM 与滚动
  function parkForDetail() {
    var mask = document.getElementById('home-video-collections-mask');
    if (!mask) return;
    mask.classList.remove('show');
    mask.setAttribute('aria-hidden', 'true');
    state.parked = true;
  }

  // 详情页 ←/Esc 返回：仅复原可见性，不重建、不清空（未 park 时为空操作）
  function resumeFromDetail() {
    if (!state.parked) return;
    var mask = document.getElementById('home-video-collections-mask');
    state.parked = false;
    if (!mask) return;
    mask.classList.add('show');
    mask.setAttribute('aria-hidden', 'false');
  }

  // 浏览层整退（✕/回首页）：丢弃暂存态，防「隐藏但 state.open」僵尸残留
  function discardParked() {
    if (!state.parked) return;
    closeHomeVideoCollectionsOverlay();
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
    state.parked = false;
    // 整窗关闭即回一级：下次打开不残留二级页
    state.collection = null;
    var modal = document.querySelector('.home-video-collections-modal');
    if (modal) {
      modal.classList.remove('home-video-collections--detail');
      modal.style.removeProperty('--wc-warm');
      modal.style.removeProperty('--wc-ambient');
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
      rememberTabScroll(); // 先把当前位置记到旧 tab 名下，再切
      state.activeTab = id;
      renderTabs();
      renderList(); // 末尾按新 tab 的记录回填（无记录即回顶）
    });
    if (close) close.addEventListener('click', closeHomeVideoCollectionsOverlay);
    if (mask) mask.addEventListener('click', function (event) {
      if (event.target === mask) closeHomeVideoCollectionsOverlay();
    });
    document.addEventListener('keydown', function (event) {
      if (!state.open) return;
      // 暂存态=详情页在上层：Esc/Tab 归浏览层处置，弹窗不得劫持
      if (state.parked) return;
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
    // 上次若停在二级页（含 park 残留被整退的路径），重开一律回一级列表。
    // 整窗重开按原语义回顶：清空全部 tab 的滚动记录（不跨次持久化），
    // 再让 closeCollectionDetail → renderList 落到当前 tab 的 0
    resetTabScroll();
    if (state.collection) closeCollectionDetail();
    state.parked = false;
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
    resumeFromDetail: resumeFromDetail,
    discardParked: discardParked,
    OVERLAY_TABS: overlayTabs()
  };
  SFV.homeCollectionsOverlay.overlayTabs = overlayTabs;
})(typeof window !== 'undefined' ? window : this);
