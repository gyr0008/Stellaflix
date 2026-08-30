/*
 * Stellaflix 影视模块 — 搜索筛选「已应用排除条」与「筛选 FAB」
 *
 * 纯排除模型：Chip 条展示当前「隐藏」的内容（类型 / 地区 / 关键词 / 年份 /
 * 评分 / 已看 / 已弃）。
 *
 * 依赖：SFV.SearchFilter（search-filter.js，提供 svg）、SFV.SearchFilterCore
 * 样式：search-filter.css
 *
 * 对外 API（SFV.SearchFilter）：
 *   renderChips(container, state, flags, handlers) 渲染已应用排除条
 *   createFab(label, onClick)                    生成筛选 FAB
 */
(function (global) {
  'use strict';

  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  SFV.SearchFilter = SFV.SearchFilter || {};
  if (SFV.SearchFilter.renderChips) return; // 幂等
  var Core = SFV.SearchFilterCore;

  function ensureStyle() {
    if (document.getElementById('sf-filter-css')) return;
    var link = document.createElement('link');
    link.id = 'sf-filter-css';
    link.rel = 'stylesheet';
    link.href = 'video/search-filter.css';
    document.head.appendChild(link);
  }

  /* ------------------------------------------------------------------
   * Applied Chip（带删除按钮）
   * ------------------------------------------------------------------ */
  function appliedChip(label, onDelete) {
    var span = document.createElement('span');
    span.className = 'sf-filter-chip is-selected';
    span.appendChild(document.createTextNode(label));
    var del = document.createElement('button');
    del.className = 'sf-filter-chip__delete';
    del.setAttribute('aria-label', '删除');
    del.textContent = '×';
    del.addEventListener('click', function (e) {
      e.stopPropagation();
      onDelete();
    });
    span.appendChild(del);
    return span;
  }

  /* ------------------------------------------------------------------
   * renderChips：已应用排除条
   * ------------------------------------------------------------------ */
  function renderChips(container, state, flags, handlers) {
    if (!container) return;
    handlers = handlers || {};
    state = state || {};
    container.innerHTML = '';
    var items = [];

    // 隐藏类型 / 隐藏关键词：不在外部 chips 栏显示（预置与用户选择均不显示），
    // 统一在筛选面板内管理（onRemoveType / onRemoveKeyword 仍由面板调用）。
    (state.excludeRegions || []).forEach(function (r) {
      items.push(appliedChip('隐藏地区: ' + r, function () { if (handlers.onRemoveRegion) handlers.onRemoveRegion(r); }));
    });
    if (state.excludeBeforeYear != null) {
      items.push(appliedChip('不早于: ' + state.excludeBeforeYear, function () { if (handlers.onRemoveYear) handlers.onRemoveYear(); }));
    }
    if (state.minScore != null) {
      items.push(appliedChip('隐藏低于: ' + state.minScore, function () { if (handlers.onRemoveScore) handlers.onRemoveScore(); }));
    }
    if (state.excludeEpisodeAbove != null) {
      items.push(appliedChip('隐藏集数>' + state.excludeEpisodeAbove, function () { if (handlers.onRemoveEpisode) handlers.onRemoveEpisode(); }));
    }
    if (state.sort && state.sort !== 'heat') {
      items.push(appliedChip('排序: ' + Core.sortLabel(state.sort), function () { if (handlers.onRemoveSort) handlers.onRemoveSort(); }));
    }
    if (flags && flags.notShowWatched) {
      items.push(appliedChip('隐藏已看', function () { if (handlers.onToggleWatched) handlers.onToggleWatched(); }));
    }
    if (flags && flags.notShowAbandoned) {
      items.push(appliedChip('隐藏已弃', function () { if (handlers.onToggleAbandoned) handlers.onToggleAbandoned(); }));
    }

    items.forEach(function (c) { container.appendChild(c); });
  }

  /* ------------------------------------------------------------------
   * createFab：筛选 FAB
   * ------------------------------------------------------------------ */
  function createFab(label, onClick) {
    ensureStyle();
    var btn = document.createElement('button');
    btn.className = 'sf-filter-fab';
    btn.type = 'button';
    var icon = (SFV.SearchFilter && SFV.SearchFilter.svg) ? SFV.SearchFilter.svg('tune') : '';
    btn.innerHTML = '<span class="sf-filter-fab__icon">' + icon + '</span>' +
      '<span>' + (label || '筛选') + '</span>';
    if (typeof onClick === 'function') {
      btn.addEventListener('click', onClick);
    }
    return btn;
  }

  /* ------------------------------------------------------------------
   * 导出
   * ------------------------------------------------------------------ */
  SFV.SearchFilter.renderChips = renderChips;
  SFV.SearchFilter.createFab = createFab;

})(window);
