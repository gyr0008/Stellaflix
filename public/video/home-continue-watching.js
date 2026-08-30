/*
 * Stellaflix 影视模块 — 影视态首页「接着看」与恢复播放子系统 (Step 3)
 *
 * 从 home.js 抽出（home.js 影视态首页拆债，目标 ≤500 行）。
 *   集群：bindGridCapture / bindRailCapture（影视态捕获阶段拦截内联 onclick）/
 *         resumeFromHistory / resumeById / resumeItem（从观看历史/片库恢复播放）/
 *         scrollToRail（滚动到影视轨）/ renderContinueWatching（渲染最近 5 条接着看卡片）。
 *
 * 依赖（运行期引用，本文件仅定义、不调用）：
 *   - homeCore（escAttr/escHtml/fmtTime），须先于本文件加载；
 *   - SFV.homeCards.cardDefs()（bindGridCapture 取卡定义）；
 *   - SFV.home.toast()（resume* 提示，toast 仍属 home.js，与 toggleUrlBar 共享）；
 *   - SFV.model / SFV.online / SFV.source / SFV.player / SFV.state。
 * 状态归属：gridBound/railBound 迁至本模块（原 home.js 闭包变量，仅供本集群使用）。
 * 加载顺序：须晚于 home-core.js / home-cards.js / home-snapshot.js，早于 home.js
 *          （home.js 经 SFV.homeContinueWatching 委托调用 bindGridCapture/bindRailCapture/renderContinueWatching）。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var HC = SFV.homeCore;
  if (!HC) { throw new Error('[SFV home-continue-watching] homeCore 未加载，请检查 index.html 加载顺序'); }
  var fmtTime = HC.fmtTime, escHtml = HC.escHtml, escAttr = HC.escAttr;

  // 本集群专用闭包状态（原 home.js var gridBound/railBound）
  var gridBound = false, railBound = false;

  function d() { return global.document; }
  function $(sel) { var doc = d(); return doc && doc.querySelector ? doc.querySelector(sel) : null; }
  function $all(sel) {
    var doc = d();
    if (!doc || !doc.querySelectorAll) return [];
    return Array.prototype.slice.call(doc.querySelectorAll(sel));
  }
  // isVideoSpace / cardDefs / toast 仍属 home.js 闭包，经门面或同名包装在运行期路由
  function isVideoSpace() { return !!(SFV.state && SFV.state.isVideo()); }
  function cardDefs() { return (SFV.homeCards && typeof SFV.homeCards.cardDefs === 'function') ? SFV.homeCards.cardDefs() : []; }
  function toast(msg) {
    if (SFV.home && typeof SFV.home.toast === 'function') { SFV.home.toast(msg); return; }
    if (typeof global.showToast === 'function') { global.showToast(msg); }
  }

  function bindGridCapture() {
    if (gridBound) return;
    var grid = $('#empty-home .home-grid');
    if (!grid || !grid.addEventListener) return;
    grid.addEventListener('click', function (ev) {
      if (!isVideoSpace()) return; // 音乐态完全不干预
      if (ev.stopPropagation) ev.stopPropagation();
      if (ev.preventDefault) ev.preventDefault();
      var cards = $all('#empty-home .home-grid .home-card');
      var node = ev.target, hit = -1;
      while (node && node !== grid) {
        var idx = cards.indexOf(node);
        if (idx >= 0) { hit = idx; break; }
        node = node.parentNode;
      }
      if (hit < 0) return;
      var defs = cardDefs();
      if (defs[hit] && defs[hit].action) defs[hit].action();
    }, true); // capture
    gridBound = true;
  }

  function bindRailCapture() {
    if (railBound) return;
    var row = d() && d().getElementById ? d().getElementById('home-tile-row') : null;
    if (!row || !row.addEventListener) return;
    row.addEventListener('click', function (ev) {
      if (!isVideoSpace()) return;
      if (ev.stopPropagation) ev.stopPropagation();
      if (ev.preventDefault) ev.preventDefault();
      var node = ev.target;
      while (node && node !== row) {
        // 接着看卡片：data-sfv-key → 从 history 取条目 → openDetailFromMeta 恢复播放
        var key = node.getAttribute && node.getAttribute('data-sfv-key');
        if (key) {
          resumeFromHistory(key);
          return;
        }
        // 兼容旧 data-sfv-id（片库条目）
        var id = node.getAttribute && node.getAttribute('data-sfv-id');
        if (id) {
          resumeById(id);
          return;
        }
        node = node.parentNode;
      }
    }, true);
    railBound = true;
  }

  // 从观看历史恢复播放（接着看卡片点击）
  function resumeFromHistory(key) {
    if (!key || !SFV.model) return;
    var history = SFV.model.getHistory() || [];
    var entry = null;
    for (var i = 0; i < history.length; i++) {
      if (history[i].key === key) { entry = history[i]; break; }
    }
    if (!entry) { toast('该记录已不存在'); return; }
    // 用 meta 信息打开详情/播放（openDetailFromMeta 支持 CMS/Kazumi/本地/URL 全类型）
    if (SFV.online && SFV.online.openDetailFromMeta) {
      SFV.online.openDetailFromMeta(entry);
    } else {
      toast('浏览模块未就绪');
    }
  }

  function resumeById(id) {
    var lib = (SFV.model && SFV.model.getLibrary()) || [];
    for (var i = 0; i < lib.length; i++) if (lib[i].id === id) return resumeItem(lib[i]);
    toast('该条目已不在片库中');
  }

  // 本地文件的 blob URL 会失效，无法静默续播 —— 如实提示重新选择，不假装能播。
  function resumeItem(item) {
    if (!item) return;
    if (item.source === 'url' && item.id.indexOf('url:') === 0) {
      var raw = item.id.slice(4);
      if (SFV.source) SFV.source.open(raw);
      else if (SFV.player) SFV.player.openUrl(raw);
      return;
    }
    toast('本地文件需重新选择：' + (item.title || ''));
    if (SFV.player) SFV.player.openFilePicker();
  }

  function scrollToRail() {
    var rail = $('#empty-home .home-rail');
    if (rail && rail.scrollIntoView) {
      try { rail.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) { rail.scrollIntoView(); }
    }
  }

  // ---- 接着看：从观看历史取最近 5 条（按 ts 降序，天然去重），渲染为 5 卡横排 ----
  //   对齐音乐态 renderHomeTiles() 的 #home-tile-row 布局（grid-template-columns: repeat(5, ...)）。
  //   点击卡片 → 通过 SFV.online.openDetailFromMeta() 恢复播放。
  function renderContinueWatching() {
    var doc = d();
    var row = doc && doc.getElementById ? doc.getElementById('home-tile-row') : null;
    var title = doc && doc.getElementById ? doc.getElementById('home-rail-title') : null;
    var note = doc && doc.getElementById ? doc.getElementById('home-rail-note') : null;
    if (title) title.textContent = '接着看';
    if (!row) return;

    var history = (SFV.model && SFV.model.getHistory) ? SFV.model.getHistory() : [];
    var items = history.slice(0, 5); // 最近 5 条，天然去重（history 本身按 key 去重）

    if (note) {
      note.textContent = items.length
        ? (items.length + ' 个记录 · 点击继续播放')
        : '';
    }

    if (!items.length) {
      row.innerHTML = '';
      return;
    }

    var html = '';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var p = SFV.model.getProgress(it.key);
      var pct = (p && p.duration) ? Math.min(100, Math.round((p.position / p.duration) * 100)) : 0;
      var sub = p ? ('看到 ' + fmtTime(p.position) + (pct ? ' · ' + pct + '%' : '')) : (it.year || '');
      var renderPic = it.pic;
      if (renderPic && renderPic.indexOf('https://image.tmdb.org/') === 0) {
        renderPic = '/api/proxy?url=' + encodeURIComponent(renderPic);
      }
      var coverParts = ['height:92px', 'border-radius:15px'];
      var coverStyle = coverParts.join(';');
      var coverClass = 'sfv-tile-cover' + (it.pic ? ' has-cover' : '');
      var coverImg = it.pic
        ? '<img class="sfv-tile-img" src="' + escAttr(renderPic) + '" alt="" loading="lazy" ' +
          'onerror="this.style.display=\'none\'">'
        : '';

      html += '<button class="home-tile sfv-continue-tile" type="button" data-sfv-key="' + escAttr(it.key) + '">' +
        '<div class="' + coverClass + '" style="' + coverStyle + '">' +
        coverImg +
        '<i class="sfv-tile-bar" style="width:' + pct + '%"></i></div>' +
        '<div class="home-tile-title">' + escHtml(it.title || '未命名') + '</div>' +
        '<div class="home-tile-sub">' + escHtml(sub) + '</div>' +
        '</button>';
    }
    row.innerHTML = html;

    // 后向补图：历史 pic 为空 → 渲染后异步尝试 TMDB 补图
    if (SFV.online && typeof SFV.online.tryPicBackfill === 'function') {
      for (var k = 0; k < items.length; k++) {
        try { SFV.online.tryPicBackfill(items[k], doc); } catch (e) {}
      }
    }

    // 缺位补空：保持 5 列网格对齐
    if (items.length < 5) {
      for (var j = items.length; j < 5; j++) {
        var empty = doc.createElement('div');
        empty.className = 'home-tile sfv-continue-empty';
        empty.setAttribute('aria-hidden', 'true');
        row.appendChild(empty);
      }
    }
  }

  SFV.homeContinueWatching = {
    bindGridCapture: bindGridCapture,
    bindRailCapture: bindRailCapture,
    renderContinueWatching: renderContinueWatching,
    resumeFromHistory: resumeFromHistory,
    resumeById: resumeById,
    resumeItem: resumeItem,
    scrollToRail: scrollToRail,
  };
})(typeof window !== 'undefined' ? window : this);
