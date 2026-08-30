/*
 * Stellaflix 影视模块 — 搜索筛选面板（纯排除模型）
 *
 * 设计演变：
 *   初始 1:1 移植自 Kazumi 2.2.6 _SearchWorkbenchSheet（正向「想看」筛选）。
 *   2026-08-06 起改为「纯排除」模型：面板只收集「不想看」的排除项，
 *   结果 = 搜索全量 − 排除项。排序作为中性重排保留。
 *
 * 依赖：SFV.SearchFilterCore（search-filter-core.js）
 * 样式：search-filter.css
 * 配套：search-filter-chips.js（已应用筛选条 + 筛选 FAB）
 *
 * 对外 API（SFV.SearchFilter）：
 *   open(opts)        打开筛选面板
 *   ensureStyle()     幂等注入 CSS
 *   svg(name)         Material 图标（供 chips 文件复用）
 */
(function (global) {
  'use strict';

  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var Core = SFV.SearchFilterCore;
  if (!Core) {
    console.error('[SearchFilter] 需要先加载 search-filter-core.js');
    return;
  }
  SFV.SearchFilter = SFV.SearchFilter || {};
  if (SFV.SearchFilter.open) return; // 面板已定义则跳过

  // 面板是否处于打开状态（供外部 ESC 处理器判断）
  var _panelOpen = false;

  /* ------------------------------------------------------------------
   * 样式注入（幂等）
   * ------------------------------------------------------------------ */
  function ensureStyle() {
    if (document.getElementById('sf-filter-css')) return;
    var link = document.createElement('link');
    link.id = 'sf-filter-css';
    link.rel = 'stylesheet';
    link.href = 'video/search-filter.css';
    document.head.appendChild(link);
  }

  /* ------------------------------------------------------------------
   * Material 图标（内联 SVG path）
   * ------------------------------------------------------------------ */
  var ICONS = {
    tune: 'M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-8v2h8v2h-8zM14 9V7h-4v2h4zm0 8v-6h-4v6h4zm6-8v-2h-2v2h2zm0 8v-6h-2v6h2z',
    close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    check: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
    restart: 'M12 5V2L7 7l5 5V8c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z',
    sort: 'M3 18h6v-2H3v2zM3 6v2h12V6H3zm0 7h9v-2H3v2z',
    sell: 'M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.41l9 9c.36.36.86.59 1.41.59.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z',
    calendar: 'M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10z',
    today: 'M19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11zM7 10h5v5H7z',
    filter: 'M4.25 5.61C6.27 8.2 10 13 10 13v6c0 .55.45 1 1 1h2c.55 0 1-.45 1-1v-6s3.73-4.8 5.75-7.39c.41-.62-.32-1.41-.98-1.21C14.49 4.74 12 6.74 12 6.74S9.51 4.74 5.23 4.4c-.66-.2-1.39.59-.98 1.21z',
    block: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM4 12c0-4.42 3.58-8 8-8 1.85 0 3.55.63 4.9 1.69L5.69 16.9C4.63 15.55 4 13.85 4 12zm8 8c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1C19.37 8.45 20 10.15 20 12c0 4.42-3.58 8-8 8z',
    image: 'M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z'
  };
  function svg(name) {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="' +
      (ICONS[name] || '') + '"/></svg>';
  }

  /* ------------------------------------------------------------------
   * 单拇指滑块（评分阈值用；对齐 Kazumi RangeSlider 简化版）
   * ------------------------------------------------------------------ */
  function buildSingleSlider(min, max, step, value, onInput) {
    var wrap = document.createElement('div');
    wrap.className = 'sf-filter-range sf-filter-range--single';

    var track = document.createElement('div');
    track.className = 'sf-filter-range__track';
    var fill = document.createElement('div');
    fill.className = 'sf-filter-range__fill';

    var inp = document.createElement('input');
    inp.type = 'range';
    inp.min = String(min);
    inp.max = String(max);
    inp.step = String(step);
    inp.value = String(value);
    inp.className = 'sf-filter-range__input';

    function pct(v) { return (v - min) / (max - min) * 100; }
    function update() {
      var v = parseFloat(inp.value);
      fill.style.left = '0%';
      fill.style.width = pct(v) + '%';
    }
    inp.addEventListener('input', function () { update(); onInput(parseFloat(inp.value)); });

    wrap.appendChild(track);
    wrap.appendChild(fill);
    wrap.appendChild(inp);
    update();
    return wrap;
  }

  // 年份下拉选项（当前年 → 2005，供「隐藏早于所选年份」）
  function yearOptions() {
    var now = new Date().getFullYear();
    var values = [];
    for (var y = now; y >= 2005; y--) values.push(y);
    return values;
  }

  /* ------------------------------------------------------------------
   * 面板主体（paint：按 draft 全量重建）
   * ------------------------------------------------------------------ */
  function buildSheet(ctx) {
    var draft = ctx.draft;
    var flags = ctx.flags;

    // ---- 排序（中性重排）----
    var sortSeg = '<div class="sf-filter-segmented">';
    [['heat', '热度'], ['match', '匹配']].forEach(function (s) {
      sortSeg += '<button data-sort="' + s[0] + '" class="' + (draft.sort === s[0] ? 'is-selected' : '') + '">' + s[1] + '</button>';
    });
    sortSeg += '</div>';

    // ---- 隐藏类型（多选）----
    var typeChips = '';
    Core.DEFAULT_TYPES.forEach(function (t) {
      var sel = draft.excludeTypes.indexOf(t) >= 0 ? ' is-selected' : '';
      typeChips += '<button class="sf-filter-chip' + sel + '" data-type="' + t + '">' + t + '</button>';
    });
    // 智能屏蔽类型（默认勾选，可关）
    (Core.DEFAULT_JUNK_TYPES || []).forEach(function (t) {
      var sel = draft.excludeTypes.indexOf(t) >= 0 ? ' is-selected' : '';
      typeChips += '<button class="sf-filter-chip is-shield' + sel + '" data-type="' + t + '" title="智能屏蔽（可关闭）">' + t + '</button>';
    });

    // ---- 隐藏地区（多选）----
    var regionChips = '';
    Core.DEFAULT_REGIONS.forEach(function (r) {
      var sel = draft.excludeRegions.indexOf(r) >= 0 ? ' is-selected' : '';
      regionChips += '<button class="sf-filter-chip' + sel + '" data-region="' + r + '">' + r + '</button>';
    });

    // ---- 隐藏关键词（简介，多选 + 自定义）----
    var kwDefault = '';
    Core.DEFAULT_KEYWORDS.forEach(function (t) {
      var sel = draft.excludeKeywords.indexOf(t) >= 0 ? ' is-selected' : '';
      kwDefault += '<button class="sf-filter-chip' + sel + '" data-kw="' + t + '">' + t + '</button>';
    });
    // 智能屏蔽关键词（默认勾选，可关；不进入下方「已选」行，避免重复）
    (Core.DEFAULT_JUNK_KEYWORDS || []).forEach(function (t) {
      var sel = draft.excludeKeywords.indexOf(t) >= 0 ? ' is-selected' : '';
      kwDefault += '<button class="sf-filter-chip is-shield' + sel + '" data-kw="' + t + '" title="智能屏蔽（可关闭）">' + t + '</button>';
    });
    var kwSelected = '';
    draft.excludeKeywords.forEach(function (t) {
      if (Core.DEFAULT_JUNK_KEYWORDS && Core.DEFAULT_JUNK_KEYWORDS.indexOf(t) >= 0) return; // 垃圾词已在默认行展示
      kwSelected += '<span class="sf-filter-chip is-selected" data-kw-selected="' + t + '">' + t +
        '<button class="sf-filter-chip__delete" data-kw-del="' + t + '" aria-label="删除">×</button></span>';
    });

    // ---- 年份：隐藏早于所选年份 ----
    var yearOn = draft.excludeBeforeYear != null;
    var yearOpts = '<option value="">不限</option>';
    yearOptions().forEach(function (y) {
      yearOpts += '<option value="' + y + '"' + (draft.excludeBeforeYear === y ? ' selected' : '') + '>' + y + ' 年及以后</option>';
    });

    // ---- 评分：隐藏低于阈值 ----
    var scoreOn = draft.minScore != null;
    var scoreVal = scoreOn ? draft.minScore : 7;

    // ---- 结构识别：隐藏集数过多的剧集（竖屏短剧识别）----
    var epiOn = draft.excludeEpisodeAbove != null;
    var epiVal = epiOn ? draft.excludeEpisodeAbove : 80;

    var html =
      section('sort', '排序', '对结果列表做中性重排，不影响被排除的内容。', '<div>' + sortSeg + '</div>') +
      section('block', '隐藏类型', '勾选后要隐藏的视频类型，结果中将不再出现这些类型。带「智能屏蔽」角标的为自动防护项，可关闭。',
        '<div class="sf-filter-wrap">' + typeChips + '</div>') +
      section('filter', '隐藏地区', '勾选后要隐藏的发行地区。',
        '<div class="sf-filter-wrap">' + regionChips + '</div>') +
      section('sell', '隐藏关键词（简介）', '勾选或输入要隐藏的关键词，作品简介中包含任一关键词即被隐藏（多个为「任一匹配即隐藏」）。带「智能屏蔽」角标的为自动防护项，可关闭。',
        '<div class="sf-filter-wrap">' + kwDefault + '</div>' +
        '<div class="sf-filter-tagrow">' +
          '<input class="sf-filter-input" data-kw-input type="text" placeholder="自定义关键词（如：续集、真人化）" />' +
          '<button class="sf-filter-iconbtn" data-kw-add aria-label="添加">+</button>' +
        '</div>' +
        (kwSelected ? '<div class="sf-filter-wrap" data-kw-selected-wrap>' + kwSelected + '</div>' : '') +
        (draft.excludeKeywords.length ? '<button class="sf-filter-textbtn" data-kw-clear>清空关键词</button>' : '')) +
      section('calendar', '年份', '开启后隐藏早于所选年份的内容（仅保留该年及以后）。',
        switchRow('隐藏早于所选年份', 'year', yearOn) +
        '<select class="sf-filter-select" data-year' + (yearOn ? '' : ' disabled') + '>' + yearOpts + '</select>') +
      section('tune', '评分', '开启后隐藏评分低于阈值的作品（评分由 TMDB 补全，仅在使用本排除时联网获取）。',
        switchRow('隐藏低于评分', 'score', scoreOn) +
        '<div data-score-holder' + (scoreOn ? '' : ' style="display:none"') + '></div>') +
      section('filter', '结构识别（竖屏短剧）', '开启后隐藏集数超过阈值的剧集，多为竖屏短剧 / AI 漫剧。注意：CMS 不提供单集时长，仅以集数识别，百集动画等正常长番也可能被误伤，请按需调整阈值。',
        switchRow('隐藏集数过多的剧集', 'episode', epiOn) +
        '<div data-epi-holder' + (epiOn ? '' : ' style="display:none"') + '></div>') +
      section('filter', '过滤', '控制是否隐藏已经看过或放弃的内容。',
        switchRow('隐藏已看', 'watch', flags.notShowWatched) +
        switchRow('隐藏已弃', 'abandon', flags.notShowAbandoned)) +
      // T143：搜索页背景 DIY 入口并入筛选面板
      section('image', '搜索页背景', '切换搜索页背景色或上传自定义图片。',
        '<div class="sfv-bg-diy-inline-host"></div>');

    ctx.body.innerHTML = html;

    // 评分滑块
    if (scoreOn) {
      var sHolder = ctx.body.querySelector('[data-score-holder]');
      if (sHolder) {
        var label = document.createElement('div');
        label.className = 'sf-filter-range__labels';
        label.innerHTML = '<span>0</span><span data-score-val>' + scoreVal + '</span><span>10</span>';
        sHolder.appendChild(buildSingleSlider(0, 10, 0.5, scoreVal, function (v) {
          draft.minScore = v;
          var vEl = ctx.body.querySelector('[data-score-val]');
          if (vEl) vEl.textContent = v;
        }));
        sHolder.appendChild(label);
      }
    }
    // 结构识别：集数阈值输入
    if (epiOn) {
      var eHolder = ctx.body.querySelector('[data-epi-holder]');
      if (eHolder) {
        var epiInput = document.createElement('input');
        epiInput.type = 'number';
        epiInput.min = '10';
        epiInput.step = '10';
        epiInput.value = String(epiVal);
        epiInput.className = 'sf-filter-input sf-filter-input--num';
        epiInput.addEventListener('input', function () {
          var v = parseInt(epiInput.value, 10);
          draft.excludeEpisodeAbove = isNaN(v) ? null : v;
        });
        eHolder.appendChild(epiInput);
        var epiHint = document.createElement('div');
        epiHint.className = 'sf-filter-section__desc';
        epiHint.textContent = '集数大于此值的剧集将被隐藏（建议 80）。';
        eHolder.appendChild(epiHint);
      }
    }
    // T143：在筛选面板内渲染搜索页背景控制（色板 + 图片上传 + 恢复默认）
    var diyHost = ctx.body.querySelector('.sfv-bg-diy-inline-host');
    if (diyHost && SFV.pageBgDiy && SFV.pageBgDiy.renderSearchPanelSection) {
      SFV.pageBgDiy.renderSearchPanelSection(diyHost);
    }
    bindSheet(ctx);
  }

  function section(icon, title, desc, child) {
    return '<div class="sf-filter-section">' +
      '<div class="sf-filter-section__head">' +
        '<span class="sf-filter-section__icon">' + svg(icon) + '</span>' +
        '<div class="sf-filter-section__titles">' +
          '<div class="sf-filter-section__title">' + title + '</div>' +
          '<div class="sf-filter-section__desc">' + desc + '</div>' +
        '</div>' +
      '</div>' + child + '</div>';
  }

  function switchRow(label, key, checked) {
    return '<div class="sf-filter-switchrow">' +
      '<span class="sf-filter-switchrow__label">' + label + '</span>' +
      '<label class="sf-filter-switch">' +
        '<input type="checkbox" data-switch="' + key + '"' + (checked ? ' checked' : '') + '>' +
        '<span class="sf-filter-switch__track"><span class="sf-filter-switch__thumb"></span></span>' +
      '</label>' +
    '</div>';
  }

  function toggleInArray(arr, val) {
    var i = arr.indexOf(val);
    if (i >= 0) arr.splice(i, 1);
    else arr.push(val);
  }

  /* ------------------------------------------------------------------
   * 事件绑定
   * ------------------------------------------------------------------ */
  function bindSheet(ctx) {
    var draft = ctx.draft;
    var flags = ctx.flags;
    var body = ctx.body;

    body.querySelectorAll('[data-sort]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        draft.sort = btn.getAttribute('data-sort');
        buildSheet(ctx);
      });
    });

    body.querySelectorAll('[data-type]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        toggleInArray(draft.excludeTypes, btn.getAttribute('data-type'));
        buildSheet(ctx);
      });
    });

    body.querySelectorAll('[data-region]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        toggleInArray(draft.excludeRegions, btn.getAttribute('data-region'));
        buildSheet(ctx);
      });
    });

    body.querySelectorAll('[data-kw]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        toggleInArray(draft.excludeKeywords, btn.getAttribute('data-kw'));
        buildSheet(ctx);
      });
    });

    body.querySelectorAll('[data-kw-del]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var t = btn.getAttribute('data-kw-del');
        var i = draft.excludeKeywords.indexOf(t);
        if (i >= 0) draft.excludeKeywords.splice(i, 1);
        buildSheet(ctx);
      });
    });

    var addBtn = body.querySelector('[data-kw-add]');
    if (addBtn) addBtn.addEventListener('click', function () {
      var inp = body.querySelector('[data-kw-input]');
      var v = (inp && inp.value || '').trim();
      if (!v || draft.excludeKeywords.indexOf(v) >= 0) return;
      draft.excludeKeywords.push(v);
      buildSheet(ctx);
    });
    var tagInput = body.querySelector('[data-kw-input]');
    if (tagInput) tagInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addBtn && addBtn.click(); }
    });

    var clearBtn = body.querySelector('[data-kw-clear]');
    if (clearBtn) clearBtn.addEventListener('click', function () {
      // 仅清空用户自定义关键词，保留「智能屏蔽」默认词
      draft.excludeKeywords = draft.excludeKeywords.filter(function (t) {
        return !(Core.DEFAULT_JUNK_KEYWORDS && Core.DEFAULT_JUNK_KEYWORDS.indexOf(t) >= 0);
      });
      buildSheet(ctx);
    });

    var yearSel = body.querySelector('[data-year]');
    if (yearSel) yearSel.addEventListener('change', function () {
      var v = yearSel.value ? parseInt(yearSel.value, 10) : null;
      draft.excludeBeforeYear = v;
      buildSheet(ctx);
    });

    body.querySelectorAll('[data-switch]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var key = cb.getAttribute('data-switch');
        var on = cb.checked;
        if (key === 'year') {
          draft.excludeBeforeYear = on ? (draft.excludeBeforeYear != null ? draft.excludeBeforeYear : new Date().getFullYear() - 5) : null;
        } else if (key === 'score') {
          draft.minScore = on ? 7 : null;
        } else if (key === 'episode') {
          draft.excludeEpisodeAbove = on ? 80 : null;
        } else if (key === 'watch') {
          flags.notShowWatched = on;
        } else if (key === 'abandon') {
          flags.notShowAbandoned = on;
        }
        buildSheet(ctx);
      });
    });
  }

  /* ------------------------------------------------------------------
   * open：打开筛选面板
   * ------------------------------------------------------------------ */
  function open(opts) {
    opts = opts || {};
    ensureStyle();

    var draft = (opts.initialFilterState || new Core.SearchFilterState()).copyWith();
    var flags = {
      notShowWatched: !!opts.initialNotShowWatched,
      notShowAbandoned: !!opts.initialNotShowAbandoned
    };

    var layer = document.createElement('div');
    layer.className = 'sf-filter-layer';
    layer.innerHTML =
      '<div class="sf-filter-scrim" data-close></div>' +
      '<div class="sf-filter-sheet" role="dialog" aria-label="排除筛选">' +
        '<div class="sf-filter-sheet__header">' +
          '<div class="sf-filter-header__text">' +
            '<h2>排除筛选</h2>' +
            '<p>勾选你不想看的内容（类型 / 地区 / 关键词 / 年份 / 评分等），搜索结果会自动过滤掉它们。</p>' +
          '</div>' +
        '</div>' +
        '<div class="sf-filter-sheet__body"></div>' +
        '<div class="sf-filter-actions">' +
          '<button class="sf-filter-btn sf-filter-btn--text" data-reset>' + svg('restart') + '重置</button>' +
          '<span class="sf-filter-spacer"></span>' +
          '<button class="sf-filter-btn sf-filter-btn--filled" data-apply>' + svg('check') + '应用</button>' +
        '</div>' +
      '</div>';

    var ctx = { draft: draft, flags: flags, body: layer.querySelector('.sf-filter-sheet__body') };
    buildSheet(ctx);

    function close() {
      _panelOpen = false;
      document.removeEventListener('keydown', onKeyDown, true);
      layer.classList.remove('is-open');
      setTimeout(function () { if (layer.parentNode) layer.parentNode.removeChild(layer); }, 300);
    }

    function onKeyDown(ev) {
      if (!_panelOpen || !layer.parentNode) return;
      if (ev.key === 'Escape' || ev.keyCode === 27) {
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        close();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);

    layer.querySelector('[data-close]').addEventListener('click', close);
    layer.querySelector('[data-reset]').addEventListener('click', function () {
      var blank = new Core.SearchFilterState();
      draft.id = blank.id; draft.keyword = blank.keyword; draft.sort = blank.sort;
      draft.excludeKeywords = blank.excludeKeywords.slice();
      draft.excludeRegions = blank.excludeRegions.slice();
      draft.excludeTypes = blank.excludeTypes.slice();
      draft.excludeBeforeYear = blank.excludeBeforeYear;
      draft.minScore = blank.minScore;
      draft.excludeEpisodeAbove = blank.excludeEpisodeAbove;
      flags.notShowWatched = false;
      flags.notShowAbandoned = false;
      // 重置后重新植入「智能屏蔽」默认项（自动防护不应被重置清除）
      var jd = (Core.buildJunkDefaults && Core.buildJunkDefaults()) || null;
      if (jd) {
        draft.excludeTypes = jd.excludeTypes;
        draft.excludeKeywords = jd.excludeKeywords;
      }
      buildSheet(ctx);
    });
    layer.querySelector('[data-apply]').addEventListener('click', function () {
      if (typeof opts.onApply === 'function') {
        opts.onApply({
          filterState: draft,
          notShowWatched: flags.notShowWatched,
          notShowAbandoned: flags.notShowAbandoned,
          shouldSearch: true
        });
      }
      close();
    });

    document.body.appendChild(layer);
    _panelOpen = true;
    requestAnimationFrame(function () { layer.classList.add('is-open'); });

    return { close: close };
  }

  /* ------------------------------------------------------------------
   * 导出
   * ------------------------------------------------------------------ */
  SFV.SearchFilter.open = open;
  SFV.SearchFilter.ensureStyle = ensureStyle;
  SFV.SearchFilter.Core = Core;
  SFV.SearchFilter.svg = svg;
  SFV.SearchFilter.isOpen = function () { return _panelOpen; };

})(window);
