/*
 * Stellaflix 影视模块 — 片单浏览页 (Step 5)
 *
 * 注册为 router page：id = 'collections'
 * 职责：
 *   - 渲染 6 个平行子 Tab（推荐/主题/经典/高分/获奖/我的片单）
 *   - 每个 Tab 下按「分类/系列」渲染多个横向 rail 区块
 *   - 每个区块：左上角分类名称 + 下方「类似影片」式横向滚动电影卡片
 *   - 点击电影卡片 → 进入该影片详情页
 *   - 鼠标 hover 卡片 → 加载并显示该影片 TMDB title logo
 *   - 「我的片单」Tab：单独一个区块，展示所有用户片单夹中的影片
 *
 * 双态隔离：本页面仅存在于影视态 #sfv-browse 内部；mount 时 fully owns host。
 * 合规：零硬编码视频源；仅 TMDB 元数据。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  var doc = global.document;
  var activeTab = 'featured';
  var itemsOpen = false; // 是否在具体片单（二级视图）内
  var mineManageOpen = false; // 「我的片单」是否处于管理视图
  var currentHost = null; // 当前片单页渲染宿主（= .sfv-browse-body），供弹窗挂载到当前页面之上
  var folderDialogMask = null; // T156c：当前打开的「新建/重命名片单夹」弹窗遮罩，供 Esc 优先关闭

  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  // 液体下划线定位（与追片页 positionTrackIndicator 同构）
  function positionCollectionIndicator(indicator, tabId) {
    if (!indicator) return;
    var tabs = indicator.parentElement;
    if (!tabs) return;
    var tab = tabs.querySelector('.sfv-track-tab[data-sfv-ctab="' + tabId + '"]') || tabs.querySelector('.sfv-track-tab--active');
    var label = tab && tab.querySelector('.sfv-track-label');
    if (!label) { indicator.style.display = 'none'; return; }
    indicator.style.display = '';
    var tRect = tabs.getBoundingClientRect();
    var lRect = label.getBoundingClientRect();
    indicator.style.left = (lRect.left - tRect.left) + 'px';
    indicator.style.width = lRect.width + 'px';
  }

  // ---- 渲染入口：router.go('collections') 时调用 ----
  function mount(host, ctx) {
    currentHost = host; // 记录当前页宿主，供 showFolderDialog 挂载到当前页面之上
    if (!SFV.collections) { host.innerHTML = '<div class="sfv-placeholder">片单模块未加载</div>'; return; }
    itemsOpen = false; // 进入列表视图：复位二级视图状态
    host.innerHTML = '';

    var tabDefs = SFV.collections.getTabs();

    // 复用追片页的均匀 tab 设计 + 液体下划线，顶部背景与页面一体（透明）
    var tabs = el('div', 'sfv-track-tabs');
    tabDefs.forEach(function (t) {
      var b = el('button', 'sfv-track-tab' + (t.id === activeTab ? ' sfv-track-tab--active' : ''));
      b.type = 'button';
      b.setAttribute('data-sfv-ctab', t.id);
      var label = el('span', 'sfv-track-label', t.label);
      b.appendChild(label);
      b.addEventListener('click', function () {
        if (t.id === activeTab) return;
        var oldTabs = host.querySelector('.sfv-track-tabs');
        var srcLabel = oldTabs && oldTabs.querySelector('.sfv-track-tab--active .sfv-track-label');
        var srcRect = srcLabel ? srcLabel.getBoundingClientRect() : null;
        var oldTabsRect = oldTabs ? oldTabs.getBoundingClientRect() : null;
        activeTab = t.id;
        var all = oldTabs.querySelectorAll('.sfv-track-tab');
        for (var i = 0; i < all.length; i++) all[i].classList.remove('sfv-track-tab--active');
        b.classList.add('sfv-track-tab--active');
        renderTab(host, t.id);
        var newTabs = host.querySelector('.sfv-track-tabs');
        var indicator = newTabs && newTabs.querySelector('.sfv-track-indicator');
        var destLabel = b.querySelector('.sfv-track-label');
        if (srcRect && oldTabsRect && indicator && destLabel) {
          var destRect = destLabel.getBoundingClientRect();
          var newTabsRect = newTabs.getBoundingClientRect();
          var sL = srcRect.left - oldTabsRect.left;
          var sW = srcRect.width;
          var dL = destRect.left - newTabsRect.left;
          var dW = destRect.width;
          var sC = sL + sW / 2;
          var dC = dL + dW / 2;
          var midC = (sC + dC) / 2;
          var dist = Math.abs(dC - sC);
          indicator.style.left = sL + 'px';
          indicator.style.width = sW + 'px';
          indicator.style.transition = 'none';
          indicator.getBoundingClientRect();
          indicator.animate([
            { left: sL + 'px', width: sW + 'px', easing: 'cubic-bezier(.25,.1,.25,1)' },
            { left: (midC - dist / 2) + 'px', width: dist + 'px', easing: 'cubic-bezier(.25,.1,.25,1)' },
            { left: dL + 'px', width: dW + 'px' }
          ], { duration: 300, fill: 'forwards' });
        } else if (indicator) {
          positionCollectionIndicator(indicator, activeTab);
        }
      });
      tabs.appendChild(b);
    });
    var indicator = el('div', 'sfv-track-indicator');
    tabs.appendChild(indicator);
    positionCollectionIndicator(indicator, activeTab);
    host.appendChild(tabs);

    // 内容视图容器（容纳多个横向 rail 区块）
    var view = el('div', 'sfv-collections-view');
    view.id = 'sfv-collections-view';
    host.appendChild(view);

    renderTab(host, activeTab);
  }

  // ---- 渲染某 Tab 下的所有分类区块 ----
  function renderTab(host, tabId) {
    var view = doc.getElementById('sfv-collections-view');
    if (!view) return;
    view.innerHTML = '';

    if (tabId === 'calendar') {
      // 时间表已迁移至 bangumi-timeline.js（Kazumi 形态：单日大卡片 + 七日 TabBar + 季度切换）
      var tl = SFV.bangumiTimeline;
      if (tl && typeof tl.mount === 'function') tl.mount(view);
      else if (SFV.bangumiCalendar) SFV.bangumiCalendar.mount(view);
      else view.innerHTML = '<div class="sfv-bgm-tl-ph">Bangumi 模块未加载</div>';
      return;
    }

    if (tabId === 'mine') {
      renderMineSection(host, view);
      return;
    }

    var defs = SFV.collections.getByTab(tabId);
    if (!defs.length) {
      view.innerHTML = '<div class="sfv-placeholder">暂无片单</div>';
      return;
    }

    defs.forEach(function (def) {
      renderSection(host, view, def);
    });
  }

  // ---- 单个分类区块：标题 + 横向 rail ----
  function renderSection(host, view, def) {
    var section = el('div', 'sfv-collection-section');
    section.setAttribute('data-sfv-coll', def.id);

    var head = el('div', 'sfv-collection-section__head');
    head.appendChild(el('h3', 'sfv-collection-section__title', def.title));
    section.appendChild(head);

    var loader = el('div', 'sfv-collection-section__loading', '加载中…');
    section.appendChild(loader);
    view.appendChild(section);

    SFV.collections.getItems(def).then(function (items) {
      if (!section.parentNode) return;
      section.removeChild(loader);
      if (!items || !items.length) {
        section.appendChild(el('div', 'sfv-collection-section__empty', '暂无影片'));
        return;
      }
      section.appendChild(buildRail(items));
    }).catch(function (err) {
      if (!section.parentNode) return;
      section.removeChild(loader);
      section.appendChild(el('div', 'sfv-collection-section__empty', '加载失败：' + (err && err.message ? err.message : err)));
    });
  }

  // ---- 「我的片单」单独区块（每个片单夹独立 section + 标题 + rail + 行内操作按钮）----
  function renderMineSection(host, view) {
    if (mineManageOpen) { renderMineManage(host, view); return; }

    var folders = SFV.collections.listUserFolders();

    if (!folders.length) {
      var empty = el('div', 'sfv-collection-section__empty');
      empty.appendChild(el('div', null, '还没有影片'));
      view.appendChild(empty);
    } else {
      // 每个片单夹独立渲染为一个 section，标题行右侧带重命名/删除按钮
      folders.forEach(function (f) {
        var items = f.items || [];
        var section = el('div', 'sfv-collection-section');

        var head = el('div', 'sfv-collection-section__head');
        head.appendChild(el('h3', 'sfv-collection-section__title', f.name));

        // 右侧行内操作按钮：重命名 / 删除
        var acts = el('div', 'sfv-mine-folder-acts-inline');
        var ren = el('button', 'sfv-mine-folder-btn', '重命名');
        ren.type = 'button';
        ren.addEventListener('click', function () { showFolderDialog(f.id); });
        var del = el('button', 'sfv-mine-folder-btn sfv-mine-folder-btn--danger', '删除');
        del.type = 'button';
        del.addEventListener('click', function () {
          if (global.confirm && !global.confirm('确认删除片单夹「' + f.name + '」？')) return;
          SFV.collections.deleteUserFolder(f.id);
          renderTab(host, 'mine');
        });
        acts.appendChild(ren);
        acts.appendChild(del);
        head.appendChild(acts);

        section.appendChild(head);

        if (!items.length) {
          section.appendChild(el('div', 'sfv-collection-section__empty', '暂无影片'));
        } else {
          section.appendChild(buildRail(items, f.id));
        }
        view.appendChild(section);
      });
    }

    // 底部居中「新建片单」按钮（150×40px，玻璃质感）
    var footer = el('div', 'sfv-collections-footer');
    var addBtn = el('button', 'sfv-collections-footer__add', '新建片单');
    addBtn.type = 'button';
    addBtn.addEventListener('click', function () { showFolderDialog(null); });
    footer.appendChild(addBtn);
    view.appendChild(footer);
  }

  // ---- 「我的片单」管理视图：列出片单夹 + 重命名 / 删除 ----
  function renderMineManage(host, view) {
    view.innerHTML = ''; // 先清空旧内容，避免删除/重命名后新旧叠加
    var section = el('div', 'sfv-collection-section');

    var head = el('div', 'sfv-collection-section__head');
    head.appendChild(el('h3', 'sfv-collection-section__title', '我的片单 · 管理'));
    var backBtn = el('button', 'sfv-collection-section__action', '← 返回');
    backBtn.type = 'button';
    backBtn.addEventListener('click', function () { mineManageOpen = false; renderTab(host, 'mine'); });
    head.appendChild(backBtn);
    section.appendChild(head);

    var folders = SFV.collections.listUserFolders();
    if (!folders.length) {
      var empty = el('div', 'sfv-collection-section__empty');
      empty.appendChild(el('div', null, '还没有片单夹'));
      var hint = el('button', 'sfv-collection-section__hint-btn', '新建片单夹');
      hint.type = 'button';
      hint.addEventListener('click', function () { showFolderDialog(null); });
      empty.appendChild(hint);
      section.appendChild(empty);
      view.appendChild(section);
      return;
    }

    var list = el('div', 'sfv-mine-manage-list');
    folders.forEach(function (f) {
      var row = el('div', 'sfv-mine-folder-row');
      row.appendChild(el('div', 'sfv-mine-folder-name', f.name));
      row.appendChild(el('div', 'sfv-mine-folder-count', (f.items ? f.items.length : 0) + ' 部'));

      var acts = el('div', 'sfv-mine-folder-acts');
      var ren = el('button', 'sfv-mine-folder-btn', '重命名');
      ren.type = 'button';
      ren.addEventListener('click', function () { showFolderDialog(f.id); });
      var del = el('button', 'sfv-mine-folder-btn sfv-mine-folder-btn--danger', '删除');
      del.type = 'button';
      del.addEventListener('click', function () {
        if (global.confirm && !global.confirm('确认删除片单夹「' + f.name + '」？')) return;
        SFV.collections.deleteUserFolder(f.id);
        renderMineManage(host, view);
      });
      acts.appendChild(ren);
      acts.appendChild(del);
      row.appendChild(acts);
      list.appendChild(row);
    });
    section.appendChild(list);

    var newBtn = el('button', 'sfv-collection-section__hint-btn', '＋ 新建片单夹');
    newBtn.type = 'button';
    newBtn.addEventListener('click', function () { showFolderDialog(null); });
    section.appendChild(newBtn);

    view.appendChild(section);
  }

  // ---- 构建横向滚动 rail（复用详情页 .sfv-plex-rail 结构）----
  // folderId：仅「我的片单」传入，用于卡片 hover 删除
  function buildRail(items, folderId) {
    var wrap = el('div', 'sfv-plex-rail-wrap sfv-collections-rail-wrap');
    var leftBtn = el('button', 'sfv-plex-rail__arrow sfv-plex-rail__arrow--left');
    leftBtn.type = 'button';
    leftBtn.setAttribute('aria-label', '向左滚动');
    leftBtn.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" aria-hidden="true"><path d="M16 5 L8 12 L16 19" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var rightBtn = el('button', 'sfv-plex-rail__arrow sfv-plex-rail__arrow--right');
    rightBtn.type = 'button';
    rightBtn.setAttribute('aria-label', '向右滚动');
    rightBtn.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" aria-hidden="true"><path d="M8 5 L16 12 L8 19" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var rail = el('div', 'sfv-plex-rail');

    items.forEach(function (it) {
      rail.appendChild(buildMovieCard(it, folderId));
    });

    wrap.appendChild(leftBtn);
    wrap.appendChild(rail);
    wrap.appendChild(rightBtn);

    function scrollByCard(dir) {
      var card = rail.querySelector('.sfv-plex-card');
      var gap = parseFloat(global.getComputedStyle(rail).gap) || 19;
      // 一次只移动一张卡片（卡片宽 + gap），不再整页翻 5 张
      var step = card ? Math.round(card.offsetWidth + gap) : 299;
      rail.scrollBy({ left: dir * step, behavior: 'smooth' });
    }
    function updateArrows() {
      var maxScroll = rail.scrollWidth - rail.clientWidth;
      leftBtn.classList.toggle('is-hidden', rail.scrollLeft <= 1);
      rightBtn.classList.toggle('is-hidden', rail.scrollLeft >= maxScroll - 1);
    }
    leftBtn.addEventListener('click', function (e) { e.stopPropagation(); scrollByCard(-1); });
    rightBtn.addEventListener('click', function (e) { e.stopPropagation(); scrollByCard(1); });
    rail.addEventListener('scroll', updateArrows, { passive: true });
    rail.addEventListener('load', updateArrows, true);
    global.addEventListener('resize', updateArrows);
    updateArrows();

    return wrap;
  }

  // ---- 单张电影卡片：复用详情页「类似影片」16:9 横版卡片 + hover title logo ----
  // folderId：仅「我的片单」传入，hover 时显示删除按钮
  function buildMovieCard(it, folderId) {
    var card = el('button', 'sfv-plex-card');
    card.type = 'button';
    var cover = it.backdrop || it.poster;
    if (cover) {
      var img = el('img', 'sfv-plex-card-img');
      img.src = cover;
      img.alt = it.title || '';
      img.loading = 'lazy';
      img.addEventListener('error', function () { img.style.display = 'none'; });
      card.appendChild(img);
    } else {
      // 无封面（如旧数据只存了标题没存海报）：用占位图避免纯黑卡片
      var ph = el('div', 'sfv-plex-card-img sfv-plex-card-img--placeholder');
      ph.textContent = '🎬';
      card.appendChild(ph);
    }

    var cap = el('div', 'sfv-plex-card__cap');
    cap.textContent = it.title || '';
    card.appendChild(cap);
    loadMovieLogo(it, cap);

    card.addEventListener('click', function () {
      if (SFV.online && SFV.online.openDetailFromMeta) {
        SFV.online.openDetailFromMeta(it);
      }
    });

    // 「我的片单」卡片：hover 右上角显示删除按钮
    if (folderId) {
      var delBtn = el('button', 'sfv-plex-card__del');
      delBtn.type = 'button';
      delBtn.setAttribute('aria-label', '从片单删除');
      delBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true"><path d="M6 6 L18 18 M18 6 L6 18" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>';
      delBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        e.preventDefault();
        if (global.confirm && !global.confirm('确认从片单移除「' + (it.title || '该片') + '」？')) return;
        if (SFV.collections && SFV.collections.removeUserItem) {
          SFV.collections.removeUserItem(folderId, it.id);
          if (currentHost) renderTab(currentHost, 'mine');
        }
      });
      card.appendChild(delBtn);
    }

    return card;
  }

  // ---- 卡片 hover logo：优先 TMDB title logo，缺失/失败回退 originalTitle / title 文字 ----
  function loadMovieLogo(it, cap) {
    if (!SFV.tmdb || typeof SFV.tmdb.getMovieLogos !== 'function' || !it.id) return;
    SFV.tmdb.getMovieLogos(it.id, it.mediaType || 'movie').then(function (logos) {
      if (!cap.parentNode) return;
      var pickBestLogo = SFV.detail && SFV.detail.pickBestLogo;
      var best = pickBestLogo ? pickBestLogo(logos) : null;
      if (best && SFV.tmdb.logoUrl) {
        cap.className = 'sfv-plex-card__cap sfv-plex-card__cap--logo';
        cap.innerHTML = '';
        var limg = el('img', 'sfv-plex-card__logo');
        limg.src = SFV.tmdb.logoUrl(best.file_path, 'original');
        limg.alt = it.title || '';
        limg.loading = 'lazy';
        limg.addEventListener('error', function () {
          if (cap.parentNode) {
            cap.className = 'sfv-plex-card__cap';
            cap.textContent = it.originalTitle || it.title || '';
          }
        });
        cap.appendChild(limg);
      } else if (it.originalTitle || it.title) {
        cap.textContent = it.originalTitle || it.title;
      }
    }).catch(function () {
      if (cap.parentNode && (it.originalTitle || it.title)) cap.textContent = it.originalTitle || it.title;
    });
  }

  // ---- 新建/重命名片单夹弹窗 ----
  function showFolderDialog(folderId) {
    // T156c：若已有弹窗未关，先移除，避免重复叠加导致 isFolderDialogOpen 误判
    if (folderDialogMask && folderDialogMask.parentNode) {
      try { folderDialogMask.parentNode.removeChild(folderDialogMask); } catch (e) {}
    }
    var mask = el('div', 'sfv-folder-dialog-mask');
    folderDialogMask = mask; // T156c：记录当前弹窗，供 Esc 关闭
    var dialog = el('div', 'sfv-folder-dialog');
    var title = folderId ? '重命名片单夹' : '新建片单夹';
    dialog.appendChild(el('h3', null, title));
    var input = doc.createElement('input');
    input.type = 'text';
    input.placeholder = '输入片单夹名称';
    if (folderId) {
      var existing = SFV.collections.listUserFolders().filter(function (x) { return x.id === folderId; })[0];
      if (existing) input.value = existing.name;
    }
    dialog.appendChild(input);

    var btns = el('div', 'sfv-folder-dialog-btns');
    var cancel = el('button', 'sfv-folder-btn-cancel', '取消');
    cancel.type = 'button';
    var ok = el('button', 'sfv-folder-btn-ok', folderId ? '保存' : '创建');
    ok.type = 'button';

    var close = function () {
      if (mask.parentNode) mask.parentNode.removeChild(mask);
      folderDialogMask = null; // T156c：关闭后清空引用
    };
    cancel.addEventListener('click', close);
    mask.addEventListener('click', function (ev) { if (ev.target === mask) close(); });
    var submit = function () {
      var name = (input.value || '').trim();
      if (!name) { input.focus(); return; }
      if (folderId) SFV.collections.renameUserFolder(folderId, name);
      else SFV.collections.createUserFolder(name);
      close();
      // 刷新我的片单 tab
      if (currentHost && activeTab === 'mine') renderTab(currentHost, activeTab);
    };
    ok.addEventListener('click', submit);
    input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.keyCode === 13) submit(); });
    btns.appendChild(cancel);
    btns.appendChild(ok);
    dialog.appendChild(btns);

    mask.appendChild(dialog);
    // 挂载到当前片单页宿主（.sfv-browse-body），使弹窗浮现在当前页面之上；
    // 若仍挂到 document.body，会因全屏覆盖层 z-index:2147482000 而沉到首页背景层之下。
    var mountTarget = currentHost
      || (SFV.onlineShared && SFV.onlineShared.bodyEl)
      || (doc.body || doc.documentElement);
    mountTarget.appendChild(mask);
    if (input.focus) input.focus();
  }

  // 供 online.js 在进入具体片单时通知页内二级视图状态
  function setItemsOpen(v) { itemsOpen = !!v; }

  // 供外部直接打开指定 Tab（如首页 Bangumi 周放送表入口）
  function setActiveTab(tabId) {
    activeTab = tabId || 'featured';
    if (currentHost) renderTab(currentHost, activeTab);
  }

  // T156c：对话框打开态查询 / 关闭（供 online-nav Esc 拦截优先关闭弹窗而非退出片单页）
  function isFolderDialogOpen() { return !!(folderDialogMask && folderDialogMask.parentNode); }
  function closeFolderDialog() {
    if (folderDialogMask && folderDialogMask.parentNode) {
      try { folderDialogMask.parentNode.removeChild(folderDialogMask); } catch (e) {}
    }
    folderDialogMask = null;
  }

  // ---- 注册到 router ----
  if (SFV.router) {
    SFV.router.register({
      id: 'collections',
      title: '片单',
      mount: mount,
      back: function () {
        // 页内二级视图（具体片单）消费返回：回到片单列表，返回 true；
        // 管理视图消费返回：回到「我的片单」概览，返回 true；
        // 顶层片单列表：返回 false，交由外壳关闭全屏覆盖层回到首页。
        if (itemsOpen) {
          itemsOpen = false;
          if (SFV.online && typeof SFV.online.reopenCollections === 'function') {
            SFV.online.reopenCollections();
          }
          return true;
        }
        // T156c：「我的片单 · 管理」视图下，Esc/返回应回到片单概览而非退出片单页
        if (mineManageOpen) {
          mineManageOpen = false;
          if (currentHost) renderTab(currentHost, 'mine'); // 重新渲染「我的片单」概览（管理/新建按钮 + 片单夹区块）
          return true;
        }
        return false;
      }
    });
  }

  SFV.pageCollections = { mount: mount, renderGrid: renderTab, showFolderDialog: showFolderDialog, setItemsOpen: setItemsOpen, setActiveTab: setActiveTab, isFolderDialogOpen: isFolderDialogOpen, closeFolderDialog: closeFolderDialog };
})(typeof window !== 'undefined' ? window : this);
