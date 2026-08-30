/*
 * Stellaflix 影视模块 — 观看历史页 (router page id = 'history')
 *
 * 职责：
 *   - 独立 localStorage 存储 stellaflix-watch-history-v1，schema 对齐接入约定：
 *       { key, title, sub, img, progress(0~1), cur, total, ts, finished,
 *         sourceId, vodId, pic }   // sourceId/vodId/pic 供卡片点击重开详情（activate）
 *     key 作为去重 / 移除主键（播放器回写时由调用方提供稳定 key）。
 *   - 渲染：无顶部标题条，仅保留纯净竖向历史足迹
 *     → 按天分组（今天 / 昨天 / 本周内星期几 / 更早 M月D日），每组日期标题 + 当天条数
 *     → 同日横向 rail（flex row + 隐藏滚动条 + hover 左右箭头）
 *     → 卡片（16:9 缩略图 + 3px slate 进度条[仅未看完] + hover 移除；标题/子信息/状态行
 *        默认隐藏，hover 时以渐变 scrim 浮层形式从海报内部底部滑入，对齐片单页
 *        .sfv-plex-card__cap 的 hover 触发方式）
 *     → 空状态居中。
 *   - GSAP（window.gsap 垫片）做卡片 stagger 入场。
 *
 * 双态隔离：仅影视态 #sfv-browse-body 内渲染（page 模式），不写音乐态 DOM。
 * 合规：零硬编码视频源；本页只读本地历史存储。
 *
 * 真实播放接入：SFV.watchHistory.add(rec) 供播放器在进度变更/结束时回写；
 *   卡片点击经 activate() 钩子（rec 含 sourceId+vodId 时调 SFV.online.openDetailFromMeta
 *   并打 _origin:'history'，供 player 返回本页），缺字段则静默。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var doc = global.document;
  var LS = global.localStorage;
  var KEY = 'stellaflix-watch-history-v1';
  var CAP = 500;

  // ---------------------------------------------------------------- 工具
  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // ---------------------------------------------------------------- 存储层
  function readAll() {
    try {
      var raw = LS.getItem(KEY);
      if (!raw) return [];
      var p = JSON.parse(raw);
      if (!Array.isArray(p)) return [];
      // 每次读取统一 normalize：补齐旧版本缺失字段（如 watchedSec），避免上层分支判空
      for (var i = 0; i < p.length; i++) { if (p[i]) p[i] = normalize(p[i]); }
      return p;
    } catch (e) { return []; }
  }
  function writeAll(arr) {
    try { LS.setItem(KEY, JSON.stringify(arr)); return true; } catch (e) { return false; }
  }
  function normalize(rec) {
    var prog = (typeof rec.progress === 'number') ? rec.progress : (rec.finished ? 1 : 0);
    if (prog < 0) prog = 0; if (prog > 1) prog = 1;
    return {
      key: rec.key,
      title: rec.title || '',
      sub: rec.sub || '',
      img: rec.img || '',
      progress: prog,
      cur: rec.cur || '',
      total: rec.total || '',
      ts: rec.ts || Date.now(),
      finished: !!rec.finished,
      sourceId: rec.sourceId || '',
      vodId: rec.vodId || '',
      pic: rec.pic || '',
      watchedSec: Math.max(0, Number(rec.watchedSec) || 0)
    };
  }

  // 把 "HH:MM:SS" / "MM:SS" 格式化时长字符串解析为秒数，用于旧记录兜底估算
  function parseDuration(str) {
    if (!str || typeof str !== 'string') return 0;
    var parts = str.split(':').map(function (p) { return parseInt(p, 10); });
    if (parts.some(function (n) { return isNaN(n); })) return 0;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 1) return parts[0];
    return 0;
  }

  function getAll() { return readAll(); }
  function getCount() { return readAll().length; }
  function getUnfinishedCount() {
    var a = readAll(), n = 0;
    for (var i = 0; i < a.length; i++) if (!a[i].finished) n++;
    return n;
  }
  function remove(key, ts) {
    // 支持两种调用：remove(key) 全局删除（兼容旧 API），remove(key, ts) 精确删除跨天重复记录
    var a;
    if (ts != null) {
      a = readAll().filter(function (r) { return !(r.key === key && r.ts === ts); });
    } else {
      a = readAll().filter(function (r) { return r.key !== key; });
    }
    writeAll(a); return a;
  }
  function clear() { writeAll([]); return []; }
  function _dayStart(ts) {
    var d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
  function add(rec) {
    if (!rec || !rec.key) return readAll();
    var a = readAll();
    var todayStart = _dayStart(Date.now());
    // 只过滤「同一天 + 同 key」的旧记录；跨天的保留，形成独立历史条目
    a = a.filter(function (r) {
      return !(r.key === rec.key && _dayStart(r.ts || 0) === todayStart);
    });
    a.unshift(normalize(rec));
    if (a.length > CAP) a = a.slice(0, CAP);
    writeAll(a); return a;
  }

  // 把秒数格式化为 "HH:MM:SS" 或 "MM:SS"，供 cur/total 显示
  function formatDuration(sec) {
    var s = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(s / 3600);
    s %= 3600;
    var m = Math.floor(s / 60);
    s %= 60;
    var parts = [];
    if (h > 0) {
      parts.push(h < 10 ? '0' + h : String(h));
    }
    parts.push(m < 10 ? '0' + m : String(m));
    parts.push(s < 10 ? '0' + s : String(s));
    return parts.join(':');
  }

  // 增量更新指定 key 的进度/时长/完成态，不移动该条在历史列表中的位置，
  // 供播放器 timeupdate/pause/ended 时回写真实观影数据。
  // 优先匹配「当天 + 同 key」的记录，确保跨天重复观看时不会误更新到旧记录。
  function update(key, patch) {
    if (!key) return null;
    var a = readAll();
    var todayStart = _dayStart(Date.now());
    var idx = -1;
    // 优先找「同一天 + 同 key」的记录
    for (var i = 0; i < a.length; i++) {
      if (a[i].key === key && _dayStart(a[i].ts || 0) === todayStart) {
        idx = i; break;
      }
    }
    // 回退：当天没有则全局按 key 匹配（兼容首次 add 前的极端时序）
    if (idx < 0) {
      for (var j = 0; j < a.length; j++) {
        if (a[j].key === key) { idx = j; break; }
      }
    }
    if (idx < 0) return null;
    var rec = a[idx];
    if (patch) {
      if (typeof patch.progress === 'number') rec.progress = patch.progress;
      if (patch.cur != null) rec.cur = patch.cur;
      if (patch.total != null) rec.total = patch.total;
      if (typeof patch.finished === 'boolean') rec.finished = patch.finished;
      if (patch.ts) rec.ts = patch.ts;
      if (typeof patch.watchedSec === 'number') {
        // 取较大值：确保会话内累计不会倒退（pause 重复调用 / timeupdate 时序抖动）
        var incoming = Math.max(0, Number(patch.watchedSec) || 0);
        rec.watchedSec = Math.max(Number(rec.watchedSec) || 0, incoming);
      }
    }
    writeAll(a); return rec;
  }

  // ---------------------------------------------------------------- 日期分组
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  // 周一为一周起点
  function startOfWeek(d) {
    var s = startOfDay(d);
    var day = s.getDay(); // 0=Sun..6=Sat
    var diff = (day === 0) ? -6 : (1 - day);
    s.setDate(s.getDate() + diff);
    return s;
  }
  var WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function dayMeta(ts) {
    var d = new Date(ts);
    var today = startOfDay(new Date());
    var yest = new Date(today); yest.setDate(today.getDate() - 1);
    var wk = startOfWeek(new Date());
    var sd = startOfDay(d);
    var t = sd.getTime();
    if (t === today.getTime()) return { bucket: 'today', label: '今天', wd: -1, dayStart: t };
    if (t === yest.getTime()) return { bucket: 'yesterday', label: '昨天', wd: -1, dayStart: t };
    if (t >= wk.getTime()) return { bucket: 'week-' + sd.getDay(), label: WEEKDAY[sd.getDay()], wd: sd.getDay(), dayStart: t };
    return { bucket: 'early-' + t, label: (sd.getMonth() + 1) + '月' + sd.getDate() + '日', wd: -1, dayStart: t };
  }

  function primaryRank(bucket) {
    if (bucket === 'today') return 0;
    if (bucket === 'yesterday') return 1;
    if (bucket.indexOf('week-') === 0) return 2;
    return 3; // early
  }

  function groupByDay(arr) {
    var sorted = arr.slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    var order = [], map = {};
    sorted.forEach(function (r) {
      var m = dayMeta(r.ts);
      if (!map[m.bucket]) {
        map[m.bucket] = { key: m.bucket, label: m.label, wd: m.wd, dayStart: m.dayStart, items: [] };
        order.push(m.bucket);
      }
      map[m.bucket].items.push(r);
    });
    var groups = order.map(function (k) { return map[k]; });
    groups.sort(function (a, b) {
      var pa = primaryRank(a.key), pb = primaryRank(b.key);
      if (pa !== pb) return pa - pb;
      if (a.key.indexOf('week-') === 0 && b.key.indexOf('week-') === 0) return a.wd - b.wd; // 本周内按星期升序
      return b.dayStart - a.dayStart; // 更早按日期倒序
    });
    groups.forEach(function (g) { g.count = g.items.length; });
    return groups;
  }

  // ---------------------------------------------------------------- 渲染状态
  var filter = 'all';
  var currentHost = null;
  var currentData = null;
  // 收集本页注册的全部 resize 监听，render 重建前与 unmount 时统一移除，避免泄漏累积。
  var resizeListeners = [];
  function detachResize() {
    for (var i = 0; i < resizeListeners.length; i++) {
      try { global.removeEventListener('resize', resizeListeners[i]); } catch (e) { /* 非致命 */ }
    }
    resizeListeners.length = 0;
  }

  function render(host, data) {
    currentHost = host || currentHost;
    if (!currentHost) return;
    var all = (data != null) ? data : (currentData || readAll());
    currentData = all;
    detachResize(); // render 重建前先解绑旧监听，防止 resize 监听泄漏累积

    currentHost.innerHTML = '';
    var page = el('div', 'sfv-wh-page');
    currentHost.appendChild(page);

    if (!all.length) { page.appendChild(buildEmpty(false)); return; }

    var filtered = (filter === 'unfinished') ? all.filter(function (r) { return !r.finished; }) : all;

    if (!filtered.length) { page.appendChild(buildEmpty(true)); return; }

    var groups = groupByDay(filtered);
    var wrap = el('div', 'sfv-wh-groups');
    groups.forEach(function (g) { wrap.appendChild(buildDay(g)); });
    page.appendChild(wrap);

    // GSAP stagger 入场（垫片存在时）
    if (global.gsap) {
      var cards = page.querySelectorAll('.sfv-wh-card');
      if (cards.length) {
        try {
          global.gsap.from(cards, { opacity: 0, y: 14, duration: 0.4, stagger: 0.03, ease: 'power2.out', clearProps: 'opacity,transform' });
        } catch (e) { /* 非致命 */ }
      }
    }
  }

  function buildDay(g) {
    var day = el('div', 'sfv-wh-day');
    var dh = el('div', 'sfv-wh-day__head');
    dh.appendChild(el('div', 'sfv-wh-day__label', g.label));
    dh.appendChild(el('div', 'sfv-wh-day__count', g.count + ' 条'));
    day.appendChild(dh);

    var railWrap = el('div', 'sfv-wh-rail-wrap');
    var left = el('button', 'sfv-wh-rail__arrow sfv-wh-rail__arrow--left');
    left.type = 'button';
    left.setAttribute('aria-label', '向左滚动');
    left.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" aria-hidden="true"><path d="M16 5 L8 12 L16 19" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var right = el('button', 'sfv-wh-rail__arrow sfv-wh-rail__arrow--right');
    right.type = 'button';
    right.setAttribute('aria-label', '向右滚动');
    right.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" aria-hidden="true"><path d="M8 5 L16 12 L8 19" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var rail = el('div', 'sfv-wh-rail');

    g.items.forEach(function (rec) { rail.appendChild(buildCard(rec)); });
    railWrap.appendChild(left); railWrap.appendChild(rail); railWrap.appendChild(right);

    function step() {
      var card = rail.querySelector('.sfv-wh-card');
      var gap = parseFloat(global.getComputedStyle(rail).gap) || 18;
      return card ? Math.round(card.offsetWidth + gap) : 378;
    }
    function updateArrows() {
      var max = rail.scrollWidth - rail.clientWidth;
      left.classList.toggle('is-hidden', rail.scrollLeft <= 1);
      right.classList.toggle('is-hidden', rail.scrollLeft >= max - 1);
    }
    left.addEventListener('click', function (e) { e.stopPropagation(); rail.scrollBy({ left: -step(), behavior: 'smooth' }); });
    right.addEventListener('click', function (e) { e.stopPropagation(); rail.scrollBy({ left: step(), behavior: 'smooth' }); });
    rail.addEventListener('scroll', updateArrows, { passive: true });
    global.addEventListener('resize', updateArrows);
    resizeListeners.push(updateArrows);
    updateArrows();

    day.appendChild(railWrap);
    return day;
  }

  function buildCard(rec) {
    var card = el('div', 'sfv-wh-card');
    card.setAttribute('data-sfv-key', rec.key || '');

    var thumb = el('div', 'sfv-wh-card__thumb');
    if (rec.img) {
      var img = el('img', 'sfv-wh-card__img');
      img.src = rec.img; img.alt = rec.title || ''; img.loading = 'lazy';
      img.addEventListener('error', function () { img.style.display = 'none'; });
      thumb.appendChild(img);
    }
    // 进度条（仅未看完且 progress>0）
    if (!rec.finished && rec.progress > 0) {
      var prog = el('div', 'sfv-wh-card__progress');
      var fill = el('div', 'sfv-wh-card__progress-fill');
      fill.style.width = Math.max(0, Math.min(100, rec.progress * 100)) + '%';
      prog.appendChild(fill);
      thumb.appendChild(prog);
    }
    // hover 移除按钮
    var rm = el('button', 'sfv-wh-card__remove', '移除');
    rm.type = 'button';
    rm.addEventListener('click', function (e) { e.stopPropagation(); onRemove(rec); });
    thumb.appendChild(rm);
    card.appendChild(thumb);

    var info = el('div', 'sfv-wh-card__info');
    info.appendChild(el('div', 'sfv-wh-card__title', rec.title || '未命名'));
    if (rec.sub) info.appendChild(el('div', 'sfv-wh-card__sub', rec.sub));
    var status = el('div', 'sfv-wh-card__status' + (rec.finished ? ' sfv-wh-card__status--done' : ''));
    if (rec.finished) {
      status.appendChild(el('span', 'sfv-wh-card__dot'));
      status.appendChild(el('span', 'sfv-wh-card__status-text', '观看完成'));
    } else {
      status.appendChild(el('span', 'sfv-wh-card__status-text', '看到 ' + (rec.cur || '00:00') + ' / 总时长 · ' + (rec.total || '00:00')));
    }
    info.appendChild(status);
    thumb.appendChild(info);

    card.addEventListener('click', function () { activate(rec); });
    return card;
  }

  function buildEmpty(filteredEmpty) {
    var box = el('div', 'sfv-wh-empty');
    box.appendChild(el('div', 'sfv-wh-empty__icon', '🕑'));
    if (filteredEmpty) {
      box.appendChild(el('div', 'sfv-wh-empty__title', '这里没有未看完的内容'));
      box.appendChild(el('div', 'sfv-wh-empty__sub', '切换到「全部」即可查看完整观看记录。'));
    } else {
      box.appendChild(el('div', 'sfv-wh-empty__title', '这里还没有记录'));
      box.appendChild(el('div', 'sfv-wh-empty__sub', '你看过或正在观看的影片会出现在这里，方便随时接着看。'));
    }
    return box;
  }

  // ---------------------------------------------------------------- 交互
  function setFilter(f) { filter = f; render(currentHost); }
  function onRemove(rec) {
    if (!rec || !rec.key) return;
    currentData = remove(rec.key, rec.ts);
    render(currentHost);
  }
  function onClear() {
    if (global.confirm && !global.confirm('确认清空全部观看历史？此操作不可撤销。')) return;
    currentData = clear();
    render(currentHost);
  }
  function activate(rec) {
    try {
      if (SFV.online && SFV.online.openDetailFromMeta && rec.sourceId && rec.vodId) {
        SFV.online.openDetailFromMeta(Object.assign({}, rec, { _origin: 'history', pic: rec.img || rec.pic }));
      }
    } catch (e) { /* 历史记录缺回放开局字段时静默 */ }
  }

  // ---------------------------------------------------------------- 挂载入口
  function mount(host) {
    currentHost = host;
    filter = 'all';
    currentData = readAll();
    render(host, currentData);
  }
  // ---------------------------------------------------------------- 首页 Insight 聚合
  // 影视态「今日观看」卡片三指标数据源；watchedSec=0 时兜底用 progress*total 估算，
  // 保证升级前旧记录也能显示出合理数据。
  function getTodayInsight() {
    var now = Date.now();
    var today = new Date(now);
    today.setHours(0, 0, 0, 0);
    var todayStart = today.getTime();

    var all = getAll();
    var todayRecords = all.filter(function (r) {
      return r && Number(r.ts || 0) >= todayStart;
    });

    // —— 按「部」聚合（vodId 为稳定去重键；缺失时退化为 title）——
    var unitMap = Object.create(null);  // unitKey -> { title, watchedSec, vodId }
    var watchedTotalSec = 0;
    todayRecords.forEach(function (r) {
      var sec = Number(r.watchedSec) || 0;
      if (sec <= 0) {
        // 旧记录兜底：progress × 总时长解析秒（>=0，不会虚增负数）
        sec = Math.max(0, Math.floor((Number(r.progress) || 0) * parseDuration(r.total)));
      }
      watchedTotalSec += sec;
      var unitKey = r.vodId ? ('v:' + r.vodId) : ('t:' + (r.title || ''));
      if (!unitKey || unitKey === 't:') return;
      if (!unitMap[unitKey]) unitMap[unitKey] = { title: r.title || '', watchedSec: 0, vodId: r.vodId || '' };
      unitMap[unitKey].watchedSec += sec;
      if (!unitMap[unitKey].title && r.title) unitMap[unitKey].title = r.title;
    });

    var unitKeys = Object.keys(unitMap);
    var watchCount = unitKeys.length;

    // —— 今日观看时长最长的影片名（Q3=C）——
    var longestTitle = '';
    var longestSec = 0;
    for (var k = 0; k < unitKeys.length; k++) {
      var u = unitMap[unitKeys[k]];
      if (u.watchedSec > longestSec) {
        longestSec = u.watchedSec;
        longestTitle = u.title;
      }
    }

    // —— 连续观看天数 streak（同音乐态逻辑：若今日空则从昨天回溯）——
    var dayMap = Object.create(null);
    all.forEach(function (r) { if (r && r.ts) dayMap[_dayStart(r.ts)] = true; });
    if (todayRecords.length) dayMap[todayStart] = true;
    var streak = 0;
    var cursor = new Date(todayStart);
    if (!dayMap[_dayStart(cursor.getTime())]) cursor.setDate(cursor.getDate() - 1);
    while (dayMap[_dayStart(cursor.getTime())]) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }

    return {
      watchMs: watchedTotalSec * 1000,
      watchCount: watchCount,
      longestTitle: longestTitle,
      longestSec: longestSec,
      streak: streak,
      todayRecordsN: todayRecords.length
    };
  }

  function unmount() {
    detachResize(); // 离开历史页时解绑全部 resize 监听，防止泄漏
    currentHost = null;
    currentData = null;
  }

  // ---------------------------------------------------------------- 注册 router 页面
  if (SFV.router) {
    SFV.router.register({ id: 'history', title: '观看历史', mount: mount, unmount: unmount });
  }

  SFV.watchHistory = {
    getAll: getAll, getCount: getCount, getUnfinishedCount: getUnfinishedCount,
    remove: remove, clear: clear, add: add, update: update,
    formatDuration: formatDuration, parseDuration: parseDuration,
    getTodayInsight: getTodayInsight,
    render: render, mount: mount
  };
})(typeof window !== 'undefined' ? window : this);
