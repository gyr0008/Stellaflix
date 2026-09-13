/**
 * Stellaflix — Bangumi 日历数据层 (Wave 1 + 季度扩展)
 *
 * 严格对齐 Predidit/Kazumi 的 Bangumi 取数架构（GPL-3.0），但：
 *   - 仅做「公开日历」+「本地追番」，不接 Bangumi OAuth（无需 token/登录）；
 *   - 复用现有 KazumiHttpClient（走 Stellaflix /api/proxy 代理 + 浏览器头），
 *     不新建请求封装（与 kazumi-bridge.js 约定一致：kazumi/ 内部不改，新代码在目录外）；
 *   - 图片域名 lain.bgm.tv / api.bgm.tv 经 wsrv.nl 重写，破国内图床墙
 *     （逻辑移植自 Kazumi bangumi_image_url_rewriter.dart）。
 *
 * 数据源（对齐 Kazumi ApiEndpoints）：
 *   - 当季主路径：https://next.bgm.tv/p1/calendar   （bangumiAPINextDomain + bangumiCalendar）
 *   - 当季兜底  ：https://api.bgm.tv/calendar       （v0 旧路径）
 *   - 往季回退  ：POST /api/bangumi/search -> api.bgm.tv/v0/search/subjects
 *                 （对应 Kazumi BangumiApi.getCalendarBySearch；本项目的 /api/proxy 是
 *                   GET-only，故往季 POST 走新增的专用路由 server.js:/api/bangumi/search）
 *
 * 对外：
 *   SFV.bangumi.getCalendar()         -> Promise<{ calendar, error }>  索引 0..6 = 周一..周日
 *   SFV.bangumi.getCalendarBySearch() -> Promise<{ calendar, error }>  指定季度窗口
 *
 * @license GPL-3.0（与 Kazumi 上游一致）
 */
(function (global) {
  'use strict';
  if (!global.StellaflixVideo) global.StellaflixVideo = {};
  var SFV = global.StellaflixVideo;

  var BANGUMI_CALENDAR_NEXT = 'https://next.bgm.tv/p1/calendar';
  var BANGUMI_CALENDAR_V0 = 'https://api.bgm.tv/calendar';
  // Kazumi 镜像（api.kazumi.fyi 缓存/代理 Bangumi 元数据，国内可直连，作为 GFW 回退）。
  // 路径结构与官方一致：next -> /p1/calendar，v0 -> /calendar。
  var BANGUMI_MIRROR = 'https://api.kazumi.fyi';
  var BANGUMI_CALENDAR_MIRROR_NEXT = BANGUMI_MIRROR + '/p1/calendar';
  var BANGUMI_CALENDAR_MIRROR_V0 = BANGUMI_MIRROR + '/calendar';

  // ---- 图片重写（移植自 Kazumi bangumi_image_url_rewriter.dart）----
  function _isApiImage(u) {
    if (u.host !== 'api.bgm.tv') return false;
    var seg = u.pathname.split('/').filter(Boolean);
    if (seg.length !== 4 || seg[0] !== 'v0' || seg[3] !== 'image') return false;
    var id = parseInt(seg[2], 10);
    return ['subjects', 'characters', 'persons'].indexOf(seg[1]) >= 0 && id > 0;
  }
  function rewriteImage(url) {
    if (!url) return '';
    try {
      var u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return url;
      var mirrorable = (u.host === 'lain.bgm.tv') || _isApiImage(u);
      if (!mirrorable) return url;
      var source = u.host + u.pathname + (u.search || '');
      return 'https://wsrv.nl/?url=' + encodeURIComponent(source) +
        (u.pathname.toLowerCase().endsWith('.gif') ? '&n=-1' : '');
    } catch (e) { return url; }
  }

  // ---- 日期工具（移植自 Kazumi utils/date_time.dart : dateStringToWeekday）----
  function dateStringToWeekday(dateString) {
    try {
      // 只取日期部分，避免 'YYYY-MM-DD HH:mm:ss' 被解析为 UTC 造成跨时区偏移
      var d = new Date(String(dateString).slice(0, 10) + 'T00:00:00');
      var w = d.getDay();
      return isNaN(w) ? 1 : w; // JS: 0=周日..6=周六
    } catch (e) { return 1; }
  }
  /** JS getDay（0=周日）->  Kazumi/Dart weekday（1=周一..7=周日） */
  function jsDayToDartWeekday(jsDay) { return jsDay === 0 ? 7 : jsDay; }
  /** Kazumi/Dart weekday（1=周一..7=周日）-> 本模块日历索引（0=周一..6=周日） */
  function weekdayToIndex(wd) { return (wd - 1 + 7) % 7; }

  // ---- 字段归一化（对齐 Kazumi BangumiItem.fromJson，含 v0 / next 双形态）----
  function _parseAliases(json) {
    // Kazumi: infobox 里 key='别名'；api.bgm.tv 用 value，next.bgm.tv 用 values
    try {
      if (json && json.infobox && json.infobox.length) {
        for (var i = 0; i < json.infobox.length; i++) {
          var item = json.infobox[i];
          if (item && item.key === '别名') {
            var raw = (item['values'] != null) ? item['values'] : item['value'];
            if (raw == null) return [];
            if (Object.prototype.toString.call(raw) === '[object Array]') {
              return raw.map(function (e) {
                return (e && typeof e === 'object' && e.v != null) ? String(e.v) : String(e).trim();
              }).filter(function (s) { return s.length > 0; });
            }
            var t = String(raw).trim();
            return t ? [t] : [];
          }
        }
      }
    } catch (e) {}
    return [];
  }

  function _parseVoteCount(rating) {
    // Kazumi: api.bgm.tv 用 Map{1..10}，next.bgm.tv 用 List
    try {
      var c = rating && rating.count;
      if (c == null) return [];
      if (Object.prototype.toString.call(c) === '[object Array]') {
        return c.map(function (n) { return parseInt(n, 10) || 0; });
      }
      if (typeof c === 'object') {
        var out = [];
        for (var i = 1; i <= 10; i++) out.push(parseInt(c[String(i)], 10) || 0);
        return out;
      }
    } catch (e) {}
    return [];
  }

  function _resolveAirDate(j) {
    // Kazumi: 顶层 date（api.bgm.tv）优先，其次 airtime.date（next.bgm.tv）
    function nonEmpty(v) {
      if (v == null) return null;
      var s = String(v).trim();
      return s ? s : null;
    }
    var top = nonEmpty(j['date']);
    if (top != null) return top;
    var at = j['airtime'];
    if (at && typeof at === 'object') {
      var fromAir = nonEmpty(at['date']);
      if (fromAir != null) return fromAir;
    }
    return '';
  }

  function normSubject(s) {
    if (!s || typeof s !== 'object') return null;
    var rating = s.rating || {};
    var images = s.images || {};
    var nameCn = s.name_cn || s.nameCN || '';
    if (!nameCn) nameCn = s.name || '';
    var poster = rewriteImage(images.common || images.large || images.medium || images.grid || images.small || '');
    var airDate = _resolveAirDate(s) || s.air_date || '';
    if (airDate.indexOf('T') >= 0) airDate = airDate.slice(0, 10);
    var tags = (s.tags || []).map(function (t) {
      return { name: (t && (t.name || t['name'])) || '', count: (t && t.count) || 0 };
    });
    return {
      id: s.id,
      type: s.type != null ? s.type : 2,
      name: s.name || '',
      nameCn: nameCn,
      title: nameCn || s.name || '',
      summary: s.summary || '',
      airDate: airDate,
      // Kazumi: airWeekday 由 airDate 推导，而非读取 API 字段
      airWeekday: dateStringToWeekday(airDate),          // JS: 0=周日..6=周六
      airWeekdayDart: jsDayToDartWeekday(dateStringToWeekday(airDate)), // 1=周一..7=周日
      rank: rating.rank || 0,
      images: images,
      poster: poster,
      ratingScore: typeof rating.score === 'number' ? rating.score : (parseFloat(rating.score) || 0),
      votes: rating.total || 0,
      votesCount: _parseVoteCount(rating),
      tags: tags,
      alias: _parseAliases(s),
      info: s.info || '',
      url: s.url || ''
    };
  }

  // ---- 取数：GET 经 KazumiHttpClient(/api/proxy) ----
  async function fetchCalendarJSON(url, timeoutMs) {
    var http = global.KazumiHttpClient;
    var text;
    if (http && typeof http.get === 'function') {
      // 镜像 api.kazumi.fyi 国内可直连；官方域(next/api.bgm.tv)在国内常被墙，
      // 超时用于快速失败并回退，避免 UI 一直“加载中…”。
      text = await http.get(url, { useProxy: true, timeoutMs: timeoutMs || 15000 });
    } else {
      var resp = await fetch('/api/proxy?url=' + encodeURIComponent(url), {
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      text = await resp.text();
    }
    if (!text) throw new Error('空响应');
    return JSON.parse(text);
  }

  /** 解析 Kazumi 形态的日历 JSON：json['1']..json['7']，每项取 subject */
  function parseCalendarJSON(json) {
    var out = [];
    for (var i = 1; i <= 7; i++) {
      var dayArr = json[String(i)] || [];
      var list = [];
      for (var j = 0; j < dayArr.length; j++) {
        var subj = dayArr[j] && dayArr[j].subject ? dayArr[j].subject : dayArr[j];
        var item = normSubject(subj);
        if (item) list.push(item);
      }
      out.push(list);
    }
    return out;
  }

  /**
   * 取当季（本周）放送表：优先 Kazumi 镜像 api.kazumi.fyi（国内可直连、无需代理），
   * 失败再回退官方 next.bgm.tv / api.bgm.tv（需代理，仅作最后兜底）。
   * @returns {Promise<{calendar:Array<Array>, error:?string, source:?string}>}
   */
  async function getCalendar() {
    var lastErr = null;
    // 镜像优先（国内可直连，12s 足够）；官方域需代理，置于最后并缩短超时，避免无代理时长时间空等。
    var sources = [
      { url: BANGUMI_CALENDAR_MIRROR_NEXT, name: 'mirror-next', timeout: 12000 },
      { url: BANGUMI_CALENDAR_MIRROR_V0, name: 'mirror-v0', timeout: 12000 },
      { url: BANGUMI_CALENDAR_NEXT, name: 'next', timeout: 8000 },
      { url: BANGUMI_CALENDAR_V0, name: 'v0', timeout: 8000 }
    ];
    for (var i = 0; i < sources.length; i++) {
      try {
        var json = await fetchCalendarJSON(sources[i].url, sources[i].timeout);
        var cal = parseCalendarJSON(json);
        if (cal.length === 7) {
          return { calendar: cal, error: null, source: sources[i].name };
        }
        lastErr = '解析结果不是 7 天';
      } catch (e) {
        lastErr = (e && e.message) || String(e);
        console.warn('[Bangumi] ' + sources[i].name + ' 取数失败:', lastErr);
      }
    }
    return { calendar: [], error: lastErr || 'calendar-fetch-failed', source: null };
  }

  // ---- 取数：往季（POST /api/bangumi/search）----
  /**
   * 取指定季度窗口的放送表（对齐 Kazumi BangumiApi.getCalendarBySearch）。
   * @param {Array<string>} range ['YYYY-MM-DD','YYYY-MM-DD'] 来自 bangumiSeason.toSeasonStartAndEnd()
   * @param {number} limit  单次条数（server 侧上限 20）
   * @param {number} offset 偏移量（server 侧上限 200）
   */
  async function getCalendarBySearch(range, limit, offset) {
    try {
      var payload = {
        keyword: '',
        sort: 'rank',
        filter: {
          type: [2],
          tag: ['日本'],
          air_date: ['>=' + range[0], '<' + range[1]],
          rank: ['>0', '<=99999'],
          nsfw: true
        },
        limit: limit || 20,
        offset: offset || 0
      };
      var resp = await fetch('/api/bangumi/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var json = JSON.parse(await resp.text());
      var list = [];
      (json.data || []).forEach(function (j) {
        var item = normSubject(j);
        if (item) list.push(item);
      });
      // 按 airWeekday 分 7 桶（与 Kazumi 一致）
      var out = [];
      for (var wd = 1; wd <= 7; wd++) {
        out.push(list.filter(function (it) { return it.airWeekdayDart === wd; }));
      }
      return { calendar: out, error: null, source: 'search' };
    } catch (e) {
      console.warn('[Bangumi] getCalendarBySearch 失败:', e && e.message);
      return { calendar: [], error: (e && e.message) || 'season-search-failed', source: null };
    }
  }

  /**
   * 季度切换统一入口（对齐 Kazumi TimelineController.getSchedulesBySeason 的非镜像分支）：
   * 循环 4 次 × limit 20 累积，逐桶 addAll。
   * @param {Array<string>} range
   */
  async function getSeasonCalendar(range) {
    var maxTime = 4;
    var limit = 20;
    var acc = [[], [], [], [], [], [], []];
    var err = null;
    for (var t = 0; t < maxTime; t++) {
      var res = await getCalendarBySearch(range, limit, t * limit);
      if (res.error) { err = res.error; break; }
      for (var i = 0; i < 7; i++) acc[i] = acc[i].concat(res.calendar[i] || []);
      // 已不足一页，无需继续翻页
      var got = (res.calendar || []).reduce(function (n, a) { return n + a.length; }, 0);
      if (got < limit) break;
    }
    var total = acc.reduce(function (n, a) { return n + a.length; }, 0);
    if (!total && err) return { calendar: acc, error: err, source: null };
    return { calendar: acc, error: null, source: 'search' };
  }

  SFV.bangumi = {
    BANGUMI_CALENDAR: BANGUMI_CALENDAR_V0,      // 兼容旧引用
    BANGUMI_CALENDAR_NEXT: BANGUMI_CALENDAR_NEXT,
    BANGUMI_CALENDAR_V0: BANGUMI_CALENDAR_V0,
    BANGUMI_MIRROR: BANGUMI_MIRROR,
    BANGUMI_CALENDAR_MIRROR_NEXT: BANGUMI_CALENDAR_MIRROR_NEXT,
    BANGUMI_CALENDAR_MIRROR_V0: BANGUMI_CALENDAR_MIRROR_V0,
    rewriteImage: rewriteImage,
    normSubject: normSubject,
    dateStringToWeekday: dateStringToWeekday,
    jsDayToDartWeekday: jsDayToDartWeekday,
    weekdayToIndex: weekdayToIndex,
    parseCalendarJSON: parseCalendarJSON,
    getCalendar: getCalendar,
    getCalendarBySearch: getCalendarBySearch,
    getSeasonCalendar: getSeasonCalendar
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = SFV.bangumi;
  }
})(typeof window !== 'undefined' ? window : this);
