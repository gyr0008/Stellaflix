/**
 * Stellaflix — Bangumi 周表 Widget (Wave 1)
 *
 * 嵌入「片单」页「每周新番」标签。7 列日视图（周一..周日），每列当日放送番网格卡片。
 * 卡片交互：追番 6 态（复用 SFV.model 持久化层，key = bangumi:<id>）+ 加入片单
 * （复用 SFV.collections.addUserItem）。排序（时间/评分/热度）与过滤（隐藏已抛弃/
 * 已看过/只看在看）对齐 Kazumi timeline_page 的能力。
 *
 * 约定：kazumi/ 内部不改；本文件为目录外新增，复用 KazumiHttpClient 与 SFV.model。
 * @license GPL-3.0
 */
(function (global) {
  'use strict';
  if (!global.StellaflixVideo) global.StellaflixVideo = {};
  var SFV = global.StellaflixVideo;
  var doc = global.document;

  var WEEK = ['一', '二', '三', '四', '五', '六', '日'];
  var SORTS = [
    { k: 1, label: '时间' },
    { k: 2, label: '评分' },
    { k: 3, label: '热度' }
  ];
  // 追番 6 态（未追=null 由 UI 呈现；其余 5 态直接复用 SFV.model.TRACK_STATES 顺序）
  var trackToast = global.toast || function (m) { console.log('[bgm]', m); };

  function trackKey(item) { return 'bangumi:' + item.id; }

  var _state = {
    sortMode: 3,
    filters: { hideAbandoned: false, hideWatched: false, onlyWatching: false },
    data: null,      // Array<Array<item>> 索引 0..6 = 周一..周日
    error: null
  };

  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---- 过滤：用 SFV.model 的追番主键集合 ----
  function buildFilterSets() {
    var m = SFV.model;
    if (!m || !m.getKeysByTrack) return { abandoned: {}, watched: {}, watching: {} };
    function toSet(arr) { var s = {}; (arr || []).forEach(function (k) { s[k] = 1; }); return s; }
    return {
      abandoned: toSet(m.getKeysByTrack('abandoned')),
      watched: toSet(m.getKeysByTrack('watched')),
      watching: toSet(m.getKeysByTrack('watching'))
    };
  }

  function passFilter(item, sets) {
    var key = trackKey(item);
    var f = _state.filters;
    if (f.hideAbandoned && sets.abandoned[key]) return false;
    if (f.hideWatched && sets.watched[key]) return false;
    if (f.onlyWatching && !sets.watching[key]) return false;
    return true;
  }

  function sortItems(list) {
    var mode = _state.sortMode;
    var arr = list.slice();
    if (mode === 2) {
      arr.sort(function (a, b) { return (b.ratingScore || 0) - (a.ratingScore || 0); });
    } else if (mode === 3) {
      arr.sort(function (a, b) {
        var ra = a.rank || 99999, rb = b.rank || 99999;
        return ra - rb;
      });
    } else {
      arr.sort(function (a, b) { return (a.airDate || '').localeCompare(b.airDate || ''); });
    }
    return arr;
  }

  // ---- 渲染 ----
  function mount(host) {
    if (!SFV.bangumi) { host.innerHTML = '<div class="sfv-placeholder">Bangumi 模块未加载</div>'; return; }
    host.innerHTML = '';

    var wrap = el('div', 'sfv-bgm');
    host.appendChild(wrap);

    // 工具条：排序 + 过滤 + 刷新
    var bar = el('div', 'sfv-bgm-bar');
    var sortWrap = el('div', 'sfv-bgm-sorts');
    SORTS.forEach(function (s) {
      var b = el('button', 'sfv-bgm-chip' + (_state.sortMode === s.k ? ' active' : ''), s.label);
      b.type = 'button';
      b.addEventListener('click', function () {
        _state.sortMode = s.k;
        refreshView(wrap);
      });
      sortWrap.appendChild(b);
    });
    bar.appendChild(sortWrap);

    var filtWrap = el('div', 'sfv-bgm-filters');
    var filtDefs = [
      { key: 'hideAbandoned', label: '隐藏已抛弃' },
      { key: 'hideWatched', label: '隐藏已看过' },
      { key: 'onlyWatching', label: '只看在看' }
    ];
    filtDefs.forEach(function (fd) {
      var b = el('button', 'sfv-bgm-chip' + (_state.filters[fd.key] ? ' active' : ''), fd.label);
      b.type = 'button';
      b.addEventListener('click', function () {
        _state.filters[fd.key] = !_state.filters[fd.key];
        b.classList.toggle('active', _state.filters[fd.key]);
        refreshView(wrap);
      });
      filtWrap.appendChild(b);
    });
    bar.appendChild(filtWrap);

    var refresh = el('button', 'sfv-bgm-chip sfv-bgm-refresh', '刷新');
    refresh.type = 'button';
    refresh.addEventListener('click', function () { load(wrap); });
    bar.appendChild(refresh);

    wrap.appendChild(bar);

    var grid = el('div', 'sfv-bgm-grid');
    grid.id = 'sfv-bgm-grid';
    wrap.appendChild(grid);

    load(wrap);
  }

  function load(wrap) {
    var grid = doc.getElementById('sfv-bgm-grid');
    if (grid) grid.innerHTML = '<div class="sfv-placeholder">加载每周新番…</div>';
    SFV.bangumi.getCalendar().then(function (res) {
      _state.data = res.calendar || [];
      _state.error = res.error || null;
      refreshView(wrap);
    });
  }

  function refreshView(wrap) {
    var grid = doc.getElementById('sfv-bgm-grid');
    if (!grid) return;
    grid.innerHTML = '';

    if (_state.error && (!_state.data || !_state.data.length)) {
      var err = el('div', 'sfv-placeholder', ' Bangumi 日历加载失败：' + esc(_state.error) + '（可能需要代理可达 api.bgm.tv）');
      grid.appendChild(err);
      return;
    }
    if (!_state.data || !_state.data.length) {
      grid.appendChild(el('div', 'sfv-placeholder', '暂无放送数据'));
      return;
    }

    var sets = buildFilterSets();
    var todayIdx = (new Date().getDay() + 6) % 7; // 周一=0

    for (var d = 0; d < 7; d++) {
      var col = el('div', 'sfv-bgm-day' + (d === todayIdx ? ' is-today' : ''));
      var head = el('div', 'sfv-bgm-day-head', '周' + WEEK[d]);
      col.appendChild(head);

      var items = (_state.data[d] || []).filter(function (it) { return passFilter(it, sets); });
      items = sortItems(items);

      if (!items.length) {
        col.appendChild(el('div', 'sfv-bgm-day-empty', '—'));
      } else {
        var list = el('div', 'sfv-bgm-day-list');
        items.forEach(function (it) { list.appendChild(buildCard(it)); });
        col.appendChild(list);
      }
      grid.appendChild(col);
    }
  }

  function buildCard(item) {
    var card = el('div', 'sfv-bgm-card');
    card.setAttribute('data-bgm-id', item.id);

    var img = doc.createElement('img');
    img.className = 'sfv-bgm-poster';
    img.loading = 'lazy';
    img.alt = '';
    img.src = item.poster || '';
    img.addEventListener('error', function () { img.style.visibility = 'hidden'; });
    card.appendChild(img);

    var info = el('div', 'sfv-bgm-info');
    info.appendChild(el('div', 'sfv-bgm-title', item.title || item.name));
    var meta = el('div', 'sfv-bgm-meta');
    meta.appendChild(el('span', 'sfv-bgm-rate', '★ ' + (item.ratingScore ? item.ratingScore.toFixed(1) : '—')));
    info.appendChild(meta);
    card.appendChild(info);

    // 追番状态角标
    var status = (SFV.model && SFV.model.getTrackStatus) ? SFV.model.getTrackStatus(trackKey(item)) : null;
    var badge = el('div', 'sfv-bgm-badge' + (status ? ' on' : '') + (status ? ' st-' + status : ''));
    badge.innerHTML = (status && SFV.model.STATE_ICONS ? SFV.model.STATE_ICONS[status] : '') +
      (status && SFV.model.TRACK_LABELS ? SFV.model.TRACK_LABELS[status] : '追');
    card.appendChild(badge);

    card.addEventListener('click', function (e) {
      e.stopPropagation();
      openPopover(card, item);
    });
    return card;
  }

  // ---- 追番 / 加入片单 弹层 ----
  var _pop = null;
  function closePop() {
    if (_pop && _pop.parentNode) _pop.parentNode.removeChild(_pop);
    _pop = null;
    doc.removeEventListener('click', onDocClick, true);
  }
  function onDocClick(e) { if (_pop && !_pop.contains(e.target)) closePop(); }

  function openPopover(anchor, item) {
    closePop();
    var pop = el('div', 'sfv-bgm-pop');
    _pop = pop;

    var title = el('div', 'sfv-bgm-pop-title', item.title || item.name);
    pop.appendChild(title);

    // 追番 6 态
    var trackWrap = el('div', 'sfv-bgm-pop-track');
    var states = [{ key: null, label: '未追' }].concat(
      (SFV.model && SFV.model.TRACK_STATUSES || [])
        .map(function (k) { return { key: k, label: (SFV.model.TRACK_LABELS && SFV.model.TRACK_LABELS[k]) || k }; })
    );
    var cur = (SFV.model && SFV.model.getTrackStatus) ? SFV.model.getTrackStatus(trackKey(item)) : null;
    states.forEach(function (st) {
      var b = el('button', 'sfv-bgm-pop-state' + (st.key === cur ? ' active' : '') + (st.key ? ' st-' + st.key : ''));
      b.type = 'button';
      var icon = (SFV.model && SFV.model.STATE_ICONS) ? SFV.model.STATE_ICONS[st.key || 'none'] : '';
      b.innerHTML = icon + '<span class="lbl">' + esc(st.label) + '</span>';
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (SFV.model && SFV.model.setTrackStatus) SFV.model.setTrackStatus(trackKey(item), st.key);
        trackToast(st.key ? ('已标记为「' + st.label + '」') : '已清除追番状态');
        closePop();
        // 刷新角标 + 过滤
        var grid = doc.getElementById('sfv-bgm-grid');
        if (grid && grid.parentNode) {
          var wrap = grid.parentNode;
          refreshView(wrap);
        }
      });
      trackWrap.appendChild(b);
    });
    pop.appendChild(trackWrap);

    // 加入片单
    var addBtn = el('button', 'sfv-bgm-pop-add', '+ 加入片单');
    addBtn.type = 'button';
    addBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      showFolderPicker(pop, item);
    });
    pop.appendChild(addBtn);

    // 定位
    var r = anchor.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.left = Math.min(r.left, global.innerWidth - 280) + 'px';
    pop.style.top = Math.min(r.bottom + 6, global.innerHeight - 240) + 'px';
    (doc.body || doc.documentElement).appendChild(pop);
    setTimeout(function () { doc.addEventListener('click', onDocClick, true); }, 0);
  }

  function showFolderPicker(pop, item) {
    pop.innerHTML = '';
    var head = el('div', 'sfv-bgm-pop-title', '加入片单');
    pop.appendChild(head);

    var cols = SFV.collections;
    var folders = (cols && cols.listUserFolders) ? cols.listUserFolders() : [];

    function doAdd(folderId, folderName) {
      var norm = {
        id: 'bangumi:' + item.id, mediaType: 'tv',
        title: item.title || item.name,
        year: (item.airDate || '').slice(0, 4),
        poster: item.poster, rating: item.ratingScore, overview: item.summary
      };
      if (cols && cols.addUserItem) cols.addUserItem(folderId, norm);
      trackToast('已加入「' + folderName + '」');
      closePop();
    }

    if (!folders.length) {
      var hint = el('div', 'sfv-bgm-pop-hint', '暂无片单夹，新建一个：');
      pop.appendChild(hint);
      var newBtn = el('button', 'sfv-bgm-pop-folder', '+ 新建「追番」片单夹');
      newBtn.type = 'button';
      newBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var fid = (cols && cols.createUserFolder) ? cols.createUserFolder('追番') : null;
        if (fid) doAdd(fid, '追番');
      });
      pop.appendChild(newBtn);
      return;
    }

    folders.forEach(function (f) {
      var b = el('button', 'sfv-bgm-pop-folder', f.name + ' (' + (f.items ? f.items.length : 0) + ')');
      b.type = 'button';
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        doAdd(f.id, f.name);
      });
      pop.appendChild(b);
    });
    var createBtn = el('button', 'sfv-bgm-pop-folder sfv-bgm-pop-create', '+ 新建片单夹');
    createBtn.type = 'button';
    createBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var name = (global.prompt ? global.prompt('片单夹名称', '追番') : '') || '';
      name = name.trim();
      if (!name) return;
      var fid = (cols && cols.createUserFolder) ? cols.createUserFolder(name) : null;
      if (fid) doAdd(fid, name);
    });
    pop.appendChild(createBtn);
  }

  SFV.bangumiCalendar = { mount: mount, refresh: load, _state: _state };
})(typeof window !== 'undefined' ? window : this);
