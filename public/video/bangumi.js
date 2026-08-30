/**
 * Stellaflix — Bangumi 日历数据层 (Wave 1)
 *
 * 严格对齐 Predidit/Kazumi 的 Bangumi 取数架构（GPL-3.0），但：
 *   - 仅做「公开日历」+「本地追番」，不接 Bangumi OAuth（无需 token/登录）；
 *   - 复用现有 KazumiHttpClient（走 Stellaflix /api/proxy 代理 + 浏览器头），
 *     不新建请求封装（与 kazumi-bridge.js 约定一致：kazumi/ 内部不改，新代码在目录外）；
 *   - 图片域名 lain.bgm.tv / api.bgm.tv 经 wsrv.nl 重写，破国内图床墙
 *     （逻辑移植自 Kazumi bangumi_image_url_rewriter.dart）。
 *
 * 对外：SFV.bangumi.getCalendar() -> Promise<{ calendar: Array<Array<item>>, error:? }>
 *   calendar 索引 0..6 = 周一到周日；item = 归一化后的番剧条目。
 *
 * @license GPL-3.0（与 Kazumi 上游一致）
 */
(function (global) {
  'use strict';
  if (!global.StellaflixVideo) global.StellaflixVideo = {};
  var SFV = global.StellaflixVideo;

  var BANGUMI_CALENDAR = 'https://api.bgm.tv/calendar';

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

  // ---- 字段归一化（对齐 Kazumi BangumiItem.fromJson）----
  function normSubject(s) {
    if (!s || typeof s !== 'object') return null;
    var rating = s.rating || {};
    var images = s.images || {};
    var nameCn = s.name_cn || s.nameCN || '';
    if (!nameCn) nameCn = s.name || '';
    var poster = rewriteImage(images.common || images.large || images.medium || images.grid || images.small || '');
    return {
      id: s.id,
      type: s.type != null ? s.type : 2,
      name: s.name || '',
      nameCn: nameCn,
      title: nameCn || s.name || '',
      summary: s.summary || '',
      airDate: s.air_date || s.date || s.airtime || '',   // 日历 subject 多为 air_date
      airWeekday: s.air_weekday || 0,
      rank: rating.rank || 0,
      images: images,
      poster: poster,
      ratingScore: typeof rating.score === 'number' ? rating.score : (parseFloat(rating.score) || 0),
      votes: rating.total || 0,
      url: s.url || ''
    };
  }

  // ---- 取数 ----
  async function fetchCalendarJSON() {
    var http = global.KazumiHttpClient;
    var text;
    if (http && typeof http.get === 'function') {
      text = await http.get(BANGUMI_CALENDAR, { useProxy: true });
    } else {
      // 兜底：直接走代理
      var resp = await fetch('/api/proxy?url=' + encodeURIComponent(BANGUMI_CALENDAR), {
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      text = await resp.text();
    }
    if (!text) throw new Error('空响应');
    return JSON.parse(text);
  }

  /**
   * 取每周放送表。
   * @returns {Promise<{calendar:Array<Array>, error:?string}>}
   *   calendar[i] (i=0..6) = 周一到周日的番剧数组；失败返回 {calendar:[],error}
   */
  async function getCalendar() {
    try {
      var json = await fetchCalendarJSON();
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
      return { calendar: out, error: null };
    } catch (e) {
      console.warn('[Bangumi] getCalendar 失败:', e && e.message);
      return { calendar: [], error: (e && e.message) || 'calendar-fetch-failed' };
    }
  }

  SFV.bangumi = {
    BANGUMI_CALENDAR: BANGUMI_CALENDAR,
    rewriteImage: rewriteImage,
    normSubject: normSubject,
    getCalendar: getCalendar
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = SFV.bangumi;
  }
})(typeof window !== 'undefined' ? window : this);
