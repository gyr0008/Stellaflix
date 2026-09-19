/*
 * Stellaflix 影视模块 — 观看历史页 (router page id = 'history')
 *
 * 职责：
 *   - 独立 localStorage 存储 stellaflix-watch-history-v2（聚合模型：一部番一条），schema：
 *       { seriesKey, key, episodeIndex, episodeName, title, sub, img, progress(0~1),
 *         cur, total, ts, finished, sourceId, vodId, pic,
 *         watchedSec, watchedDay, daySec, epSec,
 *         lastSourceId, lastVodId, lastSourceName, lastPlayFromIndex, lastPlayEpisodeIndex }
 *     seriesKey 为聚合主键（'<sourceId>:<vodId>'，一部番恒一条记录）；
 *     key = 最近观看那一集的集级键 '<sourceId>:<vodId>:<epIdx>'（播放器回写方提供，
 *       亦为 add/update/remove 的入参；remove 亦可传裸 seriesKey 删整片），
 *       episodeIndex = 该集号（0 起，不可推导则 null）；
 *     daySec/epSec 为「今日观看秒」记账：daySec 今日累计（仅跨天清零）、
 *       epSec 本会话已计秒基线（重开/换集一律清零）；sourceId/vodId/pic 供卡片点击重开详情（activate）。
 *   - v1 流水键 stellaflix-watch-history-v1 与 model 键 stellaflix-video-history 的一次性
 *     聚合迁移：幂等，仅当 v2 键为空时触发；旧键一律保留以供回滚。
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
  var KEY = 'stellaflix-watch-history-v2';   // 聚合模型：一部番一条
  var KEY_V1 = 'stellaflix-watch-history-v1'; // 旧流水键：只读，保留回滚
  var CAP = 500; // 语义：最多 500 部

  // ---------------------------------------------------------------- 工具
  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // 集级 key（'<sourceId>:<vodId>:<epIdx>'）→ 片级 seriesKey：剥掉最后一个 ':' 之后的尾段；
  // sourceId 可含 ':'（kazumi:），故只能剥尾段。无冒号 → 返回 ''（非法，由调用方拒绝）。
  function seriesKeyOf(key) {
    if (!key || typeof key !== 'string') return '';
    var i = key.lastIndexOf(':');
    return i > 0 ? key.slice(0, i) : '';
  }
  // 集号推导（normalize 与迁移共用，唯一口径）：仅当 key 形如 '<seriesKey>:<数字>' 才取尾段数字，
  // 否则 null —— model 粗粒度两段 vodKey（'s1:1048'，见 model.js:191）key === seriesKey，不得当集号。
  function deriveEpisodeIndex(key, seriesKey) {
    if (!key || typeof key !== 'string' || !seriesKey) return null;
    if (key.indexOf(seriesKey + ':') !== 0) return null;
    var n = parseInt(key.slice(seriesKey.length + 1), 10);
    return isNaN(n) ? null : n;
  }
  function dayKey(ts) {
    var d = new Date(ts == null ? Date.now() : ts);
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  // ---------------------------------------------------------------- 存储层
  // model.js 历史键（粗粒度，按片聚合，不含进度）；v1 流水键不存在时的迁移兜底来源。
  var MODEL_KEY = 'stellaflix-video-history';

  // 迁移专用：优先用显式 sourceId+vodId 组片级键（model 粗粒度记录是两段 vodKey，
  // 不能按尾段剥集号）；缺字段、或 key 与该 vodKey 不同源（显式字段与 key 前缀对不上）时：
  //   - KEY_V1 分支：真实 v1 key 恒为 sourceId:vodId:epIdx（play-orchestrator.js:85），剥尾段
  //     安全，继续 seriesKeyOf —— 这是聚合的本意，不能退化成粗粒度。
  //   - model 分支：两段 key 已是完整 vodKey，seriesKeyOf 会把它塌成裸 sourceId（'s1:1048' → 's1'，
  //     于是集号被误标 1048、remove 会误清 s1 下所有片的进度），故整键保留为粗粒度 seriesKey
  //     （seriesKey === key；deriveEpisodeIndex 对这种形态返回 null，卡片走无集号文案）。
  function migrateSeriesKey(r, fromModel) {
    if (typeof r.key === 'string' && r.sourceId != null && r.sourceId !== '' && r.vodId != null && r.vodId !== '') {
      var vk = r.sourceId + ':' + r.vodId;
      if (r.key === vk || r.key.indexOf(vk + ':') === 0) return vk;
    }
    if (fromModel) return typeof r.key === 'string' ? r.key : '';
    return seriesKeyOf(r.key);
  }

  // v2 键为空时的一次性聚合迁移：优先 v1 流水键，其次 model 粗粒度键。
  // 旧键都不删除（回滚用）；产出按 ts 降序的 v2 数组。
  function migrateToV2IfEmpty() {
    try {
      if (LS.getItem(KEY)) return;
      var src = [];
      var fromModel = false; // src 来源分支：v1 流水键 or model 粗粒度键（迁移键拆分口径不同）
      var raw1 = LS.getItem(KEY_V1);
      if (raw1) { var p1 = JSON.parse(raw1); if (Array.isArray(p1)) src = p1; }
      if (!src.length) {
        var rawM = LS.getItem(MODEL_KEY);
        if (rawM) {
          var pm = JSON.parse(rawM);
          if (Array.isArray(pm)) {
            fromModel = true;
            for (var i = 0; i < pm.length; i++) {
              var m = pm[i];
              if (!m || !m.key) continue;
              src.push({
                key: m.key, title: m.title || '', sub: (m.year ? (m.year + ' 年') : ''),
                img: m.pic || '', pic: m.pic || '', progress: 0, cur: '00:00', total: '',
                ts: m.ts || Date.now(), finished: false, watchedSec: 0,
                sourceId: m.sourceId || '', vodId: m.vodId,
              });
            }
          }
        }
      }
      if (!src.length) return;
      var best = {};
      src.forEach(function (r) {
        if (!r || !r.key) return;
        var s = migrateSeriesKey(r, fromModel);
        if (!s) return;
        if (!best[s] || (Number(r.ts) || 0) > (Number(best[s].ts) || 0)) best[s] = r;
      });
      var today = dayKey(Date.now());
      var arr = Object.keys(best).map(function (s) {
        var r = best[s];
        var isToday = dayKey(Number(r.ts) || 0) === today;
        return normalize(Object.assign({}, r, {
          seriesKey: s,
          episodeIndex: deriveEpisodeIndex(r.key, s),
          watchedDay: isToday ? today : '',
          daySec: isToday ? (Number(r.watchedSec) || 0) : 0,
          epSec: isToday ? (Number(r.watchedSec) || 0) : 0,
        }));
      });
      arr.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
      if (arr.length > CAP) arr = arr.slice(0, CAP);
      writeAll(arr);
      if (typeof console !== 'undefined' && console.info) {
        console.info('[SFV watch-history] 聚合迁移 →v2：' + src.length + ' 条流水 → ' + arr.length + ' 部');
      }
    } catch (e) { /* 迁移失败不阻断读取 */ }
  }

  function readAll() {
    try {
      migrateToV2IfEmpty();  // 先尝试一次性迁移（自身键为空才迁）
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
    var key = rec.key || '';
    var sKey = rec.seriesKey || seriesKeyOf(key);
    return {
      key: key,
      seriesKey: sKey,
      episodeIndex: (typeof rec.episodeIndex === 'number') ? rec.episodeIndex : deriveEpisodeIndex(key, sKey),
      episodeName: rec.episodeName || rec.sub || '',
      title: rec.title || '',
      sub: rec.sub || '',
      img: rec.img || '',
      progress: prog,
      cur: rec.cur || '',
      total: rec.total || '',
      ts: rec.ts || Date.now(),
      finished: !!rec.finished,
      sourceId: rec.sourceId || '',
      vodId: rec.vodId != null ? rec.vodId : '',
      pic: rec.pic || '',
      watchedSec: Math.max(0, Number(rec.watchedSec) || 0),
      watchedDay: rec.watchedDay || '',
      daySec: Math.max(0, Number(rec.daySec) || 0),
      epSec: Math.max(0, Number(rec.epSec) || 0),
      // 最近一次播放使用的片源（供 smartResumePlay 直用）
      lastSourceId: rec.lastSourceId || '',
      lastVodId: rec.lastVodId != null ? rec.lastVodId : '',
      lastSourceName: rec.lastSourceName || '',
      lastPlayFromIndex: (typeof rec.lastPlayFromIndex === 'number') ? rec.lastPlayFromIndex : 0,
      lastPlayEpisodeIndex: (typeof rec.lastPlayEpisodeIndex === 'number') ? rec.lastPlayEpisodeIndex : 0,
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
  // remove 连带清进度的守卫：只有「结构上证明只覆盖一部番」的 seriesKey 才拿去当前缀 ——
  // 完整片级键（sourceId+vodId 且 seriesKey 正是两者拼成）或粗粒度一致（seriesKey === key）。
  // 修复前的迁移把 model 两段键塌成过裸 sourceId（'s1'），这类前缀会跨片误删，必须跳过。
  function isSeriesScoped(r) {
    if (!r || !r.seriesKey) return false;
    if (r.seriesKey === r.key) return true;
    return !!(r.sourceId && r.vodId !== undefined && r.vodId !== null && r.vodId !== '' &&
      r.seriesKey === r.sourceId + ':' + r.vodId);
  }
  function remove(key, ts) {
    // 聚合模型：一部番一条，ts 兼容位忽略。传集级 key 或 seriesKey 均可删整片。
    var a = readAll();
    var sKey = seriesKeyOf(key || '') || key;
    var seen = {};
    var prefixes = [];
    a = a.filter(function (r) {
      var drop = !!key && (r.seriesKey === sKey || r.seriesKey === key || r.key === key);
      if (drop && isSeriesScoped(r)) {
        var p = r.seriesKey + ':';
        if (!seen[p]) { seen[p] = 1; prefixes.push(p); } // 一次删除可能命中多条不同片：逐片各清一次
      }
      return !drop;
    });
    // 删历史 = 删进度：清掉该剧所有集的 position，避免详情页幽灵进度
    if (prefixes.length && SFV.model && typeof SFV.model.clearProgressByPrefix === 'function') {
      for (var i = 0; i < prefixes.length; i++) {
        try { SFV.model.clearProgressByPrefix(prefixes[i]); } catch (e) { /* 非致命 */ }
      }
    }
    writeAll(a); return a;
  }
  function clear() { writeAll([]); return []; }
  function _dayStart(ts) {
    var d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
  // 聚合写入：一部番恒一条。换集 → 进度字段重置、移到头部；
  // 同集重开 → 只刷新元信息与 ts（进度保留）；epSec（本会话已计秒基线）一律清零。
  function add(rec) {
    if (!rec || !rec.key) return readAll();
    var sKey = seriesKeyOf(rec.key);
    if (!sKey) return readAll();
    var a = readAll();
    var now = Date.now();
    var today = dayKey(now);
    var idx = -1;
    for (var i = 0; i < a.length; i++) { if (a[i].seriesKey === sKey) { idx = i; break; } }
    var next;
    if (idx >= 0) {
      var old = a[idx];
      if (old.key === rec.key) {
        next = normalize(Object.assign({}, old, {
          title: rec.title || old.title,
          img: rec.img || old.img,
          pic: rec.pic || old.pic,
          sub: rec.sub != null ? rec.sub : old.sub,
          ts: now,
          watchedDay: today,
          daySec: old.watchedDay === today ? (old.daySec || 0) : 0,
          epSec: 0,
        }));
      } else {
        next = normalize(Object.assign({}, rec, {
          seriesKey: sKey, ts: now,
          progress: 0, cur: '00:00', total: '', finished: false, watchedSec: 0,
          watchedDay: today,
          daySec: old.watchedDay === today ? (old.daySec || 0) : 0,
          epSec: 0,
        }));
      }
      a.splice(idx, 1);
    } else {
      next = normalize(Object.assign({}, rec, { seriesKey: sKey, watchedDay: today, daySec: 0, epSec: 0 }));
    }
    a.unshift(next);
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

  // 播放器/续播回写：入参仍是集级 key。先折成 seriesKey 定位聚合记录；
  // 若记录已被更新的一集接管（rec.key !== key）则忽略本次回写（stale 防串写）。
  // watchedSec 按「本会话单调递增」语义做增量记账：daySec += incoming - epSec 基线。
  function update(key, patch) {
    if (!key) return null;
    var sKey = seriesKeyOf(key);
    var a = readAll();
    var idx = -1;
    // 兜底精确匹配：model 迁移产物是 coarse 两段键（rec.key === rec.seriesKey，如 's1:1048'），
    // 折片级会得 's1' 命中不了，必须再按 key 精确比对；sKey 为空（无冒号）时只跳折叠、仍扫精确键。
    for (var i = 0; i < a.length; i++) {
      if ((sKey && a[i].seriesKey === sKey) || a[i].key === key) { idx = i; break; }
    }
    if (idx < 0) return null;
    var rec = a[idx];
    if (rec.key !== key) return rec; // 旧集会播/已被新集接管：不改记录
    if (patch) {
      var today = dayKey(Date.now());
      if (rec.watchedDay !== today) { rec.watchedDay = today; rec.daySec = 0; rec.epSec = 0; }
      if (typeof patch.watchedSec === 'number') {
        var incoming = Math.max(0, Number(patch.watchedSec) || 0);
        var base = Math.max(0, Number(rec.epSec) || 0);
        rec.daySec = (Math.max(0, Number(rec.daySec) || 0)) + Math.max(0, incoming - base);
        rec.epSec = Math.max(base, incoming);
        rec.watchedSec = incoming;
      }
      if (typeof patch.progress === 'number') rec.progress = Math.max(0, Math.min(1, patch.progress));
      if (patch.cur != null) rec.cur = patch.cur;
      if (patch.total != null) rec.total = patch.total;
      if (typeof patch.finished === 'boolean') rec.finished = patch.finished;
      if (patch.ts) rec.ts = patch.ts;
      if (patch.lastSourceId != null) rec.lastSourceId = patch.lastSourceId;
      if (patch.lastVodId != null) rec.lastVodId = patch.lastVodId;
      if (patch.lastSourceName != null) rec.lastSourceName = patch.lastSourceName;
      if (typeof patch.lastPlayFromIndex === 'number') rec.lastPlayFromIndex = patch.lastPlayFromIndex;
      if (typeof patch.lastPlayEpisodeIndex === 'number') rec.lastPlayEpisodeIndex = patch.lastPlayEpisodeIndex;
    }
    var arr2 = a.slice();
    arr2.splice(idx, 1);
    arr2.unshift(rec); // 最近观看移到头部
    writeAll(arr2); return rec;
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
      var epPrefix = (typeof rec.episodeIndex === 'number') ? ('第 ' + (rec.episodeIndex + 1) + ' 话 · ') : '';
      status.appendChild(el('span', 'sfv-wh-card__status-text',
        epPrefix + '看到 ' + (rec.cur || '00:00') + ' / 总时长 · ' + (rec.total || '00:00')));
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
      if (SFV.detailSource && typeof SFV.detailSource.smartResumePlay === 'function') {
        // 直接起播：跳过详情页，按「上次片源 → 跨源画质优先」策略恢复播放
        // _origin:'history' 透传给播放返回栈：退出播放器回历史页，而非重建详情页
        SFV.detailSource.smartResumePlay(Object.assign({}, rec, { _origin: 'history' }));
      } else if (SFV.online && SFV.online.openDetailFromMeta && rec.sourceId && rec.vodId) {
        // 兜底：detail-source 未就绪时退回到旧行为（打开详情页）
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
      var sec = Number(r.daySec) || 0;
      if (sec <= 0) sec = Number(r.watchedSec) || 0;
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
