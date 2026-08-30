/*
 * Stellaflix 影视模块 — 追片页（track）(拆债 #1)
 *
 * 本文件从 online.js 抽出的「追片」全部逻辑：5 状态互斥分区页、卡片状态按钮
 * （对齐视频播放器底部控制栏 heart-btn：图标 + 循环切换）、缺失 TMDB 元数据后向补全。
 *
 * 共享状态与协调器函数统一经 SFV.onlineShared(S) 访问：
 *   - 共享状态：S.bodyEl / S.titleEl / S.trackActiveStatus / S.trackMetaInflight / S.TRACK_META /
 *     S.trackLabel 等；
 *   - 协调器函数（online.js 加载后填充）：S.setNote / S.openDetailFromMeta / S.el / S.toast /
 *     S.renderTrackPage / S.paintTrackCardBtn / S.positionTrackIndicator 等。
 *
 * 加载顺序：须位于 online-shared.js 之后、online.js 之前。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var S = SFV.onlineShared;
  if (!S) { throw new Error('[SFV online-track] onlineShared 未加载，请检查 index.html 加载顺序'); }

  // 追片页：5 状态互斥分区（与 Kazumi 一致，none=未收藏）
  function positionTrackIndicator(indicator, status) {
    if (!indicator) return;
    var tabs = indicator.parentElement;
    if (!tabs) return;
    var tab = tabs.querySelector('.sfv-track-tab[data-status="' + status + '"]') || tabs.querySelector('.sfv-track-tab--active');
    var label = tab && tab.querySelector('.sfv-track-label');
    if (!label) { indicator.style.display = 'none'; return; }
    indicator.style.display = '';
    var tRect = tabs.getBoundingClientRect();
    var lRect = label.getBoundingClientRect();
    indicator.style.left = (lRect.left - tRect.left) + 'px';
    indicator.style.width = lRect.width + 'px';
  }

  function renderTrackPage() {
    S.titleEl.textContent = '追片';
    S.bodyEl.innerHTML = '';
    S.setNote('');
    var renderId = Date.now();
    S.bodyEl._sfvTrackRenderId = renderId;

    // 顶部 tab 栏：5 状态 + 各分区计数
    var tabs = S.el('div', 'sfv-track-tabs');
    S.TRACK_META.forEach(function (t) {
      var n = SFV.model ? SFV.model.getKeysByTrack(t.status).length : 0;
      var tab = S.el('button', 'sfv-track-tab');
      tab.type = 'button';
      tab.setAttribute('data-status', t.status);
      var label = S.el('span', 'sfv-track-label', t.label);
      tab.appendChild(label);
      if (t.status === S.trackActiveStatus) tab.classList.add('sfv-track-tab--active');
      if (n) tab.appendChild(S.el('span', 'sfv-track-count', String(n)));
      tab.addEventListener('click', function () {
        if (t.status === S.trackActiveStatus) return;
        var oldTabs = S.bodyEl.querySelector('.sfv-track-tabs');
        var srcLabel = oldTabs && oldTabs.querySelector('.sfv-track-tab--active .sfv-track-label');
        var srcRect = srcLabel ? srcLabel.getBoundingClientRect() : null;
        var oldTabsRect = oldTabs ? oldTabs.getBoundingClientRect() : null;
        S.trackActiveStatus = t.status;
        renderTrackPage();
        var newTabs = S.bodyEl.querySelector('.sfv-track-tabs');
        var indicator = newTabs && newTabs.querySelector('.sfv-track-indicator');
        var destLabel = newTabs && newTabs.querySelector('.sfv-track-tab[data-status="' + t.status + '"] .sfv-track-label');
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
          positionTrackIndicator(indicator, t.status);
        }
      });
      tabs.appendChild(tab);
    });
    S.bodyEl.appendChild(tabs);
    var indicator = S.el('div', 'sfv-track-indicator');
    tabs.appendChild(indicator);
    positionTrackIndicator(indicator, S.trackActiveStatus);

    // 追片页背景层激活兜底：tabs 就绪后同步 page-bg-diy（修复深色玻璃层未生效时序）
    if (SFV.pageBgDiy && SFV.pageBgDiy.sync) SFV.pageBgDiy.sync();

    // 当前分区网格
    var keys = SFV.model ? SFV.model.getKeysByTrack(S.trackActiveStatus) : [];
    var list = SFV.model ? SFV.model.resolveList(keys) : [];

    var present = {};
    list.forEach(function (it) { if (it && it.key) present[it.key] = true; });
    var missing = keys.filter(function (k) {
      return !present[k] && /^tmdb:/.test(k) && !S.trackMetaInflight[k];
    });
    var canFetch = !!(SFV.tmdb && SFV.tmdb.getDetails);

    if (!list.length && (!missing.length || !canFetch)) {
      return;
    }

    // 响应式居中网格：卡片固定 360px×202.5px（16:9），不随窗口缩放；相邻间距 19px。
    // 每行最大完整卡片数 n = floor((W + 19) / (360 + 19))，由 CSS flex-wrap 自动计算。
    // 当一行卡片不足 n 张或容器放不下第 n+1 张时，该行以 19px 间距整体居中，
    // 剩余空间均分为左右自适应边距；≥6 张时自动换行到下一排左起（并再次居中）。
    var view = S.el('div', 'sfv-track-view');
    S.bodyEl.appendChild(view);
    var grid = S.el('div', 'sfv-track-grid');
    view.appendChild(grid);

    function appendTrackCard(it) {
      var card = S.el('button', 'sfv-track-card sfv-plex-card');
      card.type = 'button';
      var cover = S.el('div', 'sfv-track-card-cover');
      if (it.pic) {
        var img = S.el('img', 'sfv-track-card-img sfv-plex-card-img'); img.src = it.pic; img.alt = it.title || ''; img.loading = 'lazy';
        img.addEventListener('load', function () { img.classList.add('loaded'); });
        img.addEventListener('error', function () {
          if (it.key && it.pic && it.pic.indexOf('data:') !== 0 && SFV.posterCache && typeof SFV.posterCache.cache === 'function') {
            SFV.posterCache.cache(it.key, it.pic).then(function (dataUrl) {
              if (dataUrl && img.parentNode) {
                img.src = dataUrl;
                img.style.display = '';
                cover.classList.remove('sfv-cover--broken');
              } else {
                img.style.display = 'none';
                cover.classList.add('sfv-cover--broken');
              }
            });
          } else {
            img.style.display = 'none';
            cover.classList.add('sfv-cover--broken');
          }
        });
        cover.appendChild(img);
      } else cover.textContent = '🎬';

      // hover 浮层：底部片名（默认隐藏，hover 滑入）
      var overlay = S.el('div', 'sfv-plex-card__cap');
      overlay.textContent = it.title || '未命名';
      cover.appendChild(overlay);

      // 状态切换按钮（对齐视频播放器底部控制栏 heart-btn：图标 + 循环切换，不再弹菜单）
      var fav = S.el('button', 'sfv-track-card-fav sfv-track-icon-btn');
      fav.type = 'button';
      fav.setAttribute('data-key', it.key);
      paintTrackCardBtn(fav, it.key);
      fav.addEventListener('click', function (ev) {
        ev.stopPropagation();
        onTrackBtnClick(it, fav);
      });
      cover.appendChild(fav);

      card.appendChild(cover);

      card.addEventListener('click', function () { S.openDetailFromMeta(it); });
      grid.appendChild(card);
    }

    list.forEach(appendTrackCard);

    if (missing.length && canFetch) {
      var status = S.el('div', 'sfv-browse-status', '补全 ' + missing.length + ' 条元数据…');
      S.bodyEl.appendChild(status);
      var pending = missing.length;
      function tryRemoveStatus() {
        pending--;
        if (pending <= 0 && status.parentNode) status.parentNode.removeChild(status);
      }
      missing.forEach(function (k) {
        var parts = k.split(':');
        var mediaType = parts[1] === 'anime' ? 'tv' : (parts[1] || 'movie');
        var id = parts[2];
        if (!id) { tryRemoveStatus(); return; }
        S.trackMetaInflight[k] = true;
        SFV.tmdb.getDetails(id, mediaType).then(function (d) {
          delete S.trackMetaInflight[k];
          if (!d || S.bodyEl._sfvTrackRenderId !== renderId) { tryRemoveStatus(); return; }
          SFV.model.setMeta({ key: k, title: d.title, pic: d.poster, year: d.year, sourceId: '', vodId: '' });
          appendTrackCard({ key: k, title: d.title, pic: d.poster, year: d.year, sourceId: '', vodId: '' });
          tryRemoveStatus();
        }).catch(function () {
          delete S.trackMetaInflight[k];
          tryRemoveStatus();
        });
      });
    }
  }

  // 状态切换按钮：对齐视频播放器底部控制栏 heart-btn（hall.js）。
  // 图标取自 SFV.model.STATE_ICONS（Kazumi 等价 5 状态 Material 图标），
  // 点击循环切换 null→watching→planToWatch→onHold→watched→abandoned→null，
  // 非空状态高亮 on，附 toast 提示（移除原弹菜单逻辑）。
  var HEART_STATES = [null, 'watching', 'planToWatch', 'onHold', 'watched', 'abandoned'];
  function stateIcons() { return (SFV.model && SFV.model.STATE_ICONS) || {}; }
  function stateLabels() { return (SFV.model && SFV.model.TRACK_LABELS) || {}; }

  function paintTrackCardBtn(btn, key) {
    var s = SFV.model ? SFV.model.getTrackStatus(key) : null;
    var ic = stateIcons();
    var lbl = stateLabels();
    btn.innerHTML = '<span class="sfv-track-icon">' + (ic[s || 'none'] || '') + '</span>';
    btn.title = '追片：' + (lbl[s] || '未追');
    btn.setAttribute('aria-label', '追片：' + (lbl[s] || '未追'));
    btn.classList.toggle('on', !!s);
    btn.setAttribute('data-status', s || '');
  }

  function onTrackBtnClick(it, btn) {
    var key = it.key;
    if (!key || !SFV.model || typeof SFV.model.getTrackStatus !== 'function' || typeof SFV.model.setTrackStatus !== 'function') return;
    var status = SFV.model.getTrackStatus(key);
    var idx = HEART_STATES.indexOf(status);
    var next = HEART_STATES[(idx + 1) % HEART_STATES.length];
    SFV.model.setTrackStatus(key, next);
    if (next && SFV.model.setMeta && it) {
      SFV.model.setMeta({ key: key, title: it.title, pic: it.pic, year: it.year });
    }
    paintTrackCardBtn(btn, key);
    var lbl = stateLabels();
    if (SFV.onlineShared && SFV.onlineShared.toast) SFV.onlineShared.toast('已设为：' + (lbl[next] || '未追'));
  }

  // 卡片状态小菜单（与 Kazumi 一致：在列表内直接改状态）
  function openTrackMenu(anchor, key) {
    S.closeTrackMenu();
    var menu = S.el('div', 'sfv-track-menu');
    menu.setAttribute('data-menu-for', key);
    S.TRACK_META.forEach(function (t) {
      var opt = S.el('button', 'sfv-track-menu-opt', t.label);
      opt.type = 'button';
      opt.setAttribute('data-status', t.status);
      var cur = SFV.model ? SFV.model.getTrackStatus(key) : null;
      if (cur === t.status) opt.classList.add('on');
      opt.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (SFV.model) SFV.model.setTrackStatus(key, t.status);
        S.closeTrackMenu();
        renderTrackPage();
      });
      menu.appendChild(opt);
    });
    var clear = S.el('button', 'sfv-track-menu-opt sfv-track-menu-clear', '清除');
    clear.type = 'button';
    clear.setAttribute('data-status', 'none');
    clear.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (SFV.model) SFV.model.clearTrack(key);
      S.closeTrackMenu();
      renderTrackPage();
    });
    menu.appendChild(clear);
    global.document.body.appendChild(menu);
    menu.classList.add('show');
    var reposition = function () {
      var r = anchor.getBoundingClientRect();
      var mw = menu.offsetWidth, mh = menu.offsetHeight;
      var vw = global.innerWidth, vh = global.innerHeight;
      var left = r.right - mw;
      if (left < 8) left = 8;
      if (left + mw > vw - 8) left = Math.max(8, vw - 8 - mw);
      var top = r.bottom + 6;
      if (top + mh > vh - 8) {
        var above = r.top - mh - 6;
        top = above < 8 ? 8 : above;
      }
      menu.style.left = left + 'px';
      menu.style.top = top + 'px';
    };
    reposition();
    menu._reposition = reposition;
    var scroller = (anchor.closest && anchor.closest('.sfv-browse-body')) || S.bodyEl || null;
    if (scroller && scroller.addEventListener) scroller.addEventListener('scroll', reposition, true);
    if (global.addEventListener) global.addEventListener('resize', reposition);
    menu._scroller = scroller;
    setTimeout(function () {
      var docHandler = function (e) {
        if (menu && menu.parentNode && !menu.contains(e.target) && e.target !== anchor) S.closeTrackMenu();
      };
      if (global.addEventListener) global.addEventListener('click', docHandler, true);
      menu._docHandler = docHandler;
    }, 0);
  }

  function closeTrackMenu() {
    var existing = global.document.body ? global.document.body.querySelector('.sfv-track-menu') : null;
    if (existing) {
      if (existing._docHandler && global.removeEventListener) global.removeEventListener('click', existing._docHandler, true);
      if (existing._scroller && existing._scroller.removeEventListener) existing._scroller.removeEventListener('scroll', existing._reposition, true);
      if (global.removeEventListener) global.removeEventListener('resize', existing._reposition);
      if (existing.parentNode) existing.parentNode.removeChild(existing);
    }
  }

  // 注册到共享状态，供 online.js 协调器与门面调用
  S.renderTrackPage = renderTrackPage;
  S.positionTrackIndicator = positionTrackIndicator;
  S.paintTrackCardBtn = paintTrackCardBtn;
  S.openTrackMenu = openTrackMenu;
  S.closeTrackMenu = closeTrackMenu;
})(typeof window !== 'undefined' ? window : this);
