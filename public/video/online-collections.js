/*
 * Stellaflix 影视模块 — 片单浏览（collections）(拆债 #1)
 *
 * 本文件从 online.js 抽出的「片单」全部逻辑：打开片单页、进入具体片单影片列表、
 * 退出片单重渲染、渲染片单影片网格、加入我的片单弹窗。
 *
 * 共享状态与协调器函数统一经 SFV.onlineShared(S) 访问：
 *   - 共享状态：S.overlay / S.titleEl / S.bodyEl 等；
 *   - 协调器函数（online.js 加载后填充）：S.goToNav / S.pushView / S.setBrowseChrome /
 *     S.enrichTmdb / S.openDetailFromMeta / S.toast / S.el 等。
 *
 * 加载顺序：须位于 online-shared.js 之后、online.js 之前。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var S = SFV.onlineShared;
  if (!S) { throw new Error('[SFV online-collections] onlineShared 未加载，请检查 index.html 加载顺序'); }

  // ===== 片单浏览：打开 collections 页（router page）=====
  function openCollections() {
    S.goToNav('collections');
  }
  // 打开某片单的影片列表（collection-items 视图）
  function openCollectionItems(def) {
    S.pushView({ mode: 'collection-items', collId: def.id, collTitle: def.title, collDef: def });
    // 通知片单页：已进入二级视图（具体片单），供其 back() 消费返回
    if (SFV.pageCollections && typeof SFV.pageCollections.setItemsOpen === 'function') {
      SFV.pageCollections.setItemsOpen(true);
    }
  }

  // 退出具体片单后，重渲染片单列表（router page），复位页内二级视图状态。
  // 由 page-collections.js 的 back() 在消费返回时调用。
  function reopenCollections() {
    if (SFV.router) SFV.router.go('collections');
  }

  // 渲染 collection-items：横向滚动 rail + hover 电影 logo，对齐详情页「类似影片」
  function renderCollectionItems(v) {
    S.setBrowseChrome(true);
    S.overlay.classList.add('sfv-browse--category');
    S.titleEl.textContent = v.collTitle || '片单';
    S.bodyEl.innerHTML = '';
    if (!SFV.collections) { S.toast('片单模块未加载'); return; }

    var loader = S.el('div', 'sfv-loading');
    loader.textContent = '加载中…';
    S.bodyEl.appendChild(loader);

    SFV.collections.getItems(v.collDef).then(function (items) {
      S.bodyEl.innerHTML = '';
      if (!items || !items.length) {
        var ph = S.el('div', 'sfv-placeholder');
        ph.appendChild(S.el('div', 'sfv-placeholder-icon', '🎬'));
        ph.appendChild(S.el('div', 'sfv-placeholder-title', '暂无影片'));
        ph.appendChild(S.el('div', 'sfv-placeholder-sub', '该合集暂无可用内容'));
        S.bodyEl.appendChild(ph);
        return;
      }
      S.setNote(items.length + ' 部影片');

      var viewWrap = S.el('div', 'sfv-collection-items-view');
      viewWrap.appendChild(S.el('div', 'sfv-collection-items-head', v.collTitle || '片单'));

      var wrap = S.el('div', 'sfv-plex-rail-wrap');
      var leftBtn = S.el('button', 'sfv-plex-rail__arrow sfv-plex-rail__arrow--left');
      leftBtn.type = 'button'; leftBtn.setAttribute('aria-label', '向左滚动');
      leftBtn.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" aria-hidden="true"><path d="M16 5 L8 12 L16 19" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      var rightBtn = S.el('button', 'sfv-plex-rail__arrow sfv-plex-rail__arrow--right');
      rightBtn.type = 'button'; rightBtn.setAttribute('aria-label', '向右滚动');
      rightBtn.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" aria-hidden="true"><path d="M8 5 L16 12 L8 19" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      var rail = S.el('div', 'sfv-plex-rail');

      items.forEach(function (it) {
        var card = S.el('button', 'sfv-plex-card sfv-plex-card--poster');
        card.type = 'button';
        if (it.poster) {
          var img = S.el('img', 'sfv-plex-card-img');
          img.src = it.poster; img.alt = it.title || ''; img.loading = 'lazy';
          img.addEventListener('error', function () { img.style.display = 'none'; });
          card.appendChild(img);
        } else {
          var ph = S.el('div', 'sfv-plex-card-img sfv-plex-card-img--placeholder');
          ph.textContent = '🎬';
          card.appendChild(ph);
        }

        var cap = S.el('div', 'sfv-plex-card__cap');
        cap.textContent = it.title || '';
        card.appendChild(cap);
        loadCollectionItemLogo(it, cap);

        card.addEventListener('click', function () { S.openDetailFromMeta(it); });
        rail.appendChild(card);
      });

      wrap.appendChild(leftBtn);
      wrap.appendChild(rail);
      wrap.appendChild(rightBtn);
      viewWrap.appendChild(wrap);
      S.bodyEl.appendChild(viewWrap);

      function scrollByCard(dir) {
        var card = rail.querySelector('.sfv-plex-card');
        var gap = parseFloat(global.getComputedStyle(rail).gap) || 19;
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
    }).catch(function (err) {
      S.bodyEl.innerHTML = '';
      S.toast('加载失败：' + (err && err.message ? err.message : err));
    });
  }

  // 片单影片卡片 hover logo：优先 TMDB title logo，缺失/失败回退 originalTitle / title 文字
  function loadCollectionItemLogo(it, cap) {
    if (!SFV.tmdb || typeof SFV.tmdb.getMovieLogos !== 'function' || !it.id) return;
    SFV.tmdb.getMovieLogos(it.id, it.mediaType || 'movie').then(function (logos) {
      if (!cap.parentNode) return;
      var pickBestLogo = SFV.detail && SFV.detail.pickBestLogo;
      var best = pickBestLogo ? pickBestLogo(logos) : null;
      if (best && SFV.tmdb.logoUrl) {
        cap.className = 'sfv-plex-card__cap sfv-plex-card__cap--logo';
        cap.innerHTML = '';
        var limg = S.el('img', 'sfv-plex-card__logo');
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

  // 加入我的片单：选择片单夹弹窗
  function showPickFolderDialog(view) {
    if (!SFV.collections) return;
    var doc = S.d();
    var mask = S.el('div', 'sfv-pick-dialog-mask');
    var dialog = S.el('div', 'sfv-pick-dialog');
    dialog.appendChild(S.el('h3', null, '加入我的片单'));
    var folders = SFV.collections.listUserFolders();

    if (!folders.length) {
      dialog.appendChild(S.el('div', 'sfv-pick-item-count', '还没有片单夹，先新建一个吧'));
    }
    folders.forEach(function (f) {
      var item = S.el('div', 'sfv-pick-item');
      item.appendChild(S.el('div', 'sfv-pick-item-name', f.name));
      item.appendChild(S.el('div', 'sfv-pick-item-count', (f.items ? f.items.length : 0) + ' 部'));
      item.addEventListener('click', function () {
        SFV.collections.addUserItem(f.id, {
          id: view.id || view.key, mediaType: view.mediaType || 'movie',
          title: view.title, year: view.year, poster: view.pic || view.poster,
          rating: view.rating || 0, overview: view.overview || ''
        });
        closePick();
        S.toast('已加入「' + f.name + '」');
      });
      dialog.appendChild(item);
    });

    var addNew = S.el('div', 'sfv-pick-item add-new', '＋ 新建片单夹');
    addNew.addEventListener('click', function () {
      closePick();
      if (SFV.pageCollections && SFV.pageCollections.showFolderDialog) {
        SFV.pageCollections.showFolderDialog(null);
        global.setTimeout(function () {
          var fs = SFV.collections.listUserFolders();
          if (fs.length) {
            var last = fs[fs.length - 1];
            SFV.collections.addUserItem(last.id, {
              id: view.id || view.key, mediaType: view.mediaType || 'movie',
              title: view.title, year: view.year, poster: view.pic || view.poster,
              rating: view.rating || 0, overview: view.overview || ''
            });
            S.toast('已新建并加入「' + last.name + '」');
          }
        }, 350);
      }
    });
    dialog.appendChild(addNew);

    var closePick = function () { if (mask.parentNode) mask.parentNode.removeChild(mask); };
    mask.addEventListener('click', function (ev) { if (ev.target === mask) closePick(); });
    mask.appendChild(dialog);
    // 挂载到当前浏览覆盖层宿主（.sfv-browse-body），使弹窗浮于当前页（具体片单视图）之上，
    // 而非沉到 document.body（首页背景层）。S.bodyEl 即 collections 列表页与二级视图共用的渲染宿主。
    (S.bodyEl || doc.body || doc.documentElement).appendChild(mask);
  }

  // 注册到共享状态，供 online.js 协调器与门面调用
  S.openCollections = openCollections;
  S.openCollectionItems = openCollectionItems;
  S.reopenCollections = reopenCollections;
  S.renderCollectionItems = renderCollectionItems;
  S.showPickFolderDialog = showPickFolderDialog;
})(typeof window !== 'undefined' ? window : this);
