/*
 * Stellaflix 影视模块 — 全页搜索结果渲染（拆债 #1 / 搜索页）
 *
 * 从 online-search.js 抽出的「结果区海报卡片网格渲染」纯 DOM 子模块
 * （VIDEO_MODULE_PLAN §六.6 单文件 ≤500 行约束）。编排/事件绑定仍留在 online-search.js，
 * 本文件只负责把聚合后的条目渲染成 .sfv-grid 卡片。
 *
 * 通过 SFV.onlineShared(S) 访问共享状态：S.resultArea / S.esc / S.enrichTmdb /
 * S.closeSearchPage / S.ensure / S.overlay / S.openDetail / S.openKazumiDetail 等，
 * 均为运行时经 S 或全局 SFV 访问，加载顺序只需在本文件之前加载 online-shared.js。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var S = SFV.onlineShared;
  if (!S) { throw new Error('[SFV online-search-render] onlineShared 未加载，请检查 index.html 加载顺序'); }
  var doc = S.d();

  // 在全页搜索结果区渲染海报卡片网格
  function renderInlineResults(items, query) {
    if (!S.resultArea) return;
    S.resultArea.innerHTML = '';

    var grid = doc.createElement('div');
    grid.className = 'sfv-grid';

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var card = doc.createElement('button');
      card.type = 'button';
      card.className = 'sfv-card';

      var cover = doc.createElement('div');
      cover.className = 'sfv-card-cover';
      if (it.pic) {
        var img = doc.createElement('img');
        img.src = it.pic;
        img.alt = S.esc(it.title || '');
        img.loading = 'lazy';
        img.addEventListener('load', function () { img.classList.add('loaded'); });
        cover.appendChild(img);
      } else {
        cover.textContent = '🎬';
      }
      /* T166b：电影评分徽章（海报右上角常驻）—— 替代原 hover 浮层 sub 内的
         `★ 8.5` 文字。enrichTmdb 异步补全时仍可能往 sub prepend .sfv-tmdb-vote
         （共享 helper 不为搜索页局部逻辑变动），由 CSS 视觉隐藏，避免重复显示。 */
      if (it.tmdbRating != null) {
        var voteBadge = doc.createElement('span');
        voteBadge.className = 'sfv-card-vote';
        voteBadge.textContent = '★ ' + Number(it.tmdbRating).toFixed(1);
        cover.appendChild(voteBadge);
      }

      var name = doc.createElement('div');
      name.className = 'sfv-card-name';
      name.textContent = it.title || '未命名';

      var sub = doc.createElement('div');
      sub.className = 'sfv-card-sub';
      /* T166b：原 sub 内的 `★ 8.5` 已挪到右上角徽章（见 cover 块），此处仅保留年份/来源 */
      var st = '';
      if (it.year) st += it.year;
      if (it.variants && it.variants.length > 1) {
        if (st) st += ' · ';
        st += it.variants.length + ' 个来源';
      }
      if (!st) st = '点击查看';
      sub.appendChild(doc.createTextNode(st));

      /* T166：横卡 hover 浮层容器 —— 对齐追片页 .sfv-plex-card__cap（渐变 scrim +
         底部滑入）。name/sub 类名保留，enrichTmdb 的 querySelector('.sfv-card-sub')
         与 .sfv-card--kazumi .sfv-card-sub::after 不受影响。 */
      var cap = doc.createElement('div');
      cap.className = 'sfv-card__cap';
      cap.appendChild(name);
      cap.appendChild(sub);

      card.appendChild(cover);
      card.appendChild(cap);
      if (it.isKazumi) card.classList.add('sfv-card--kazumi');

      (function (cap) {
        card.addEventListener('click', function () {
          S._detailOrigin = 'search'; // 标记来源层级：搜索结果 → 详情，返回须逐级回到搜索结果页
          S.closeSearchPage();
          S.ensure();
          S.overlay.classList.remove('sfv-browse--page');
          S.overlay.style.top = '';
          S.uiMode = 'view';
          S.activePageId = null;
          S.stack.length = 0;
          if (cap.isKazumi) S.openKazumiDetail(cap);
          else S.openDetail(cap);
        });
      })(it);

      grid.appendChild(card);

      if (typeof S.enrichTmdb === 'function') {
        try { S.enrichTmdb(card, it); } catch (e) {}
      }
    }

    S.resultArea.appendChild(grid);
  }

  S.renderInlineResults = renderInlineResults;
})(typeof window !== 'undefined' ? window : this);
