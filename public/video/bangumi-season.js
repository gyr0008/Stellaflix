/**
 * Stellaflix — Bangumi 季度计算（移植自 Kazumi lib/utils/anime_season.dart）
 *
 * 对齐点（逐条对应 Kazumi 源码）：
 *   - AnimeSeason._getYearAndSeason -> getYearAndSeason()
 *   - AnimeSeason.toString         -> seasonString()
 *   - AnimeSeason.toSeasonStartAndEnd -> toSeasonStartAndEnd()
 *   - getSeasonStringByMonth()     -> getSeasonStringByMonth()
 *   - isSameSeason()               -> isSameSeason()
 *   - timeline_page 的季节矩阵生成 -> listPastSeasons() / generateDateTime()
 *
 * 重要（Kazumi 设计意图，非 bug）：季节窗口整体比自然季提前一个月。
 * 例如「2026 年春季新番」的检索窗口是 2026-03-01 ~ 2026-06-01，
 * 而非 04-01 ~ 07-01。原因是 Bangumi 条目的 air_date 是番剧**开播日**，
 * 通常比季度首日早若干天（见 Kazumi anime_season.dart 的注释）。
 * 本移植严格保留该语义，未做「修正」。
 *
 * 注意 Dart DateTime 月份为 1..12，JS Date 月份为 0..11，转换处已标注。
 *
 * @license GPL-3.0（与 Kazumi 上游一致）
 */
(function (global) {
  'use strict';
  if (!global.StellaflixVideo) global.StellaflixVideo = {};
  var SFV = global.StellaflixVideo;

  var SEASONS = ['冬季', '春季', '夏季', '秋季'];
  // 时间机器里季节的选择顺序（与 timeline_page.dart 的 `seasons` 一致）
  var PICK_ORDER = ['秋', '夏', '春', '冬'];

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** 'YYYY-MM-DD'（Bangumi air_date 使用的格式） */
  function fmtDate(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function getYearAndSeason(dt) {
    var year = dt.getFullYear();
    var month = dt.getMonth() + 1; // 转 1..12
    var season;
    if (month <= 3) season = 0;
    else if (month <= 6) season = 1;
    else if (month <= 9) season = 2;
    else season = 3;
    return { year: year, season: season };
  }

  /** '2026年夏季新番' */
  function seasonString(dt) {
    var ys = getYearAndSeason(dt);
    return ys.year + '年' + SEASONS[ys.season] + '新番';
  }

  /**
   * 季度检索窗口 [start, end)，均为 'YYYY-MM-DD'。
   * 与 Kazumi 一致：窗口整体比自然季提前一个月。
   *   冬季 -> 上一年 12-01 ~ 当年 03-01
   *   春季 -> 当年 03-01 ~ 当年 06-01
   *   夏季 -> 当年 06-01 ~ 当年 09-01
   *   秋季 -> 当年 09-01 ~ 当年 12-01
   */
  function toSeasonStartAndEnd(dt) {
    var ys = getYearAndSeason(dt);
    var year = ys.year;
    var season = ys.season;

    // Dart: DateTime(year, (season + 1) * 3, 1) —— 月份 1..12
    // JS  : 月份 0..11，故 -1
    var end = new Date(year, (season + 1) * 3 - 1, 1);

    // Dart: startMonth = season * 3; if (startMonth == 0) { startMonth = 12; year--; }
    var startMonth = season * 3;
    var startYear = year;
    if (startMonth === 0) { startMonth = 12; startYear = year - 1; }
    var start = new Date(startYear, startMonth - 1, 1);

    return [fmtDate(start), fmtDate(end)];
  }

  /** 月 -> 季名单字：1-3 冬 / 4-6 春 / 7-9 夏 / 10-12 秋 */
  function getSeasonStringByMonth(month) {
    if (month <= 3) return '冬';
    if (month <= 6) return '春';
    if (month <= 9) return '夏';
    return '秋';
  }

  /** 同年且月份差 <= 2 —— 与 Kazumi isSameSeason 完全一致 */
  function isSameSeason(d1, d2) {
    return d1.getFullYear() === d2.getFullYear() &&
      Math.abs((d1.getMonth() + 1) - (d2.getMonth() + 1)) <= 2;
  }

  /** 季名单字 -> 该季首日的 Date */
  function generateDateTime(year, season) {
    switch (season) {
      case '冬': return new Date(year, 0, 1);
      case '春': return new Date(year, 3, 1);
      case '夏': return new Date(year, 6, 1);
      case '秋': return new Date(year, 9, 1);
      default: return new Date();
    }
  }

  /**
   * 时间机器可用季度矩阵：近 count 年（默认 20），每年按 秋/夏/春/冬 过滤掉未来季度。
   * @returns {Array<{year:number, dates:Date[]}>}
   */
  function listPastSeasons(count) {
    var curr = new Date();
    var n = count || 20;
    var out = [];
    for (var i = 0; i < n; i++) {
      var year = curr.getFullYear() - i;
      var available = [];
      PICK_ORDER.forEach(function (s) {
        var d = generateDateTime(year, s);
        if (curr.getTime() > d.getTime()) available.push(d);
      });
      if (available.length) out.push({ year: year, dates: available });
    }
    return out;
  }

  SFV.bangumiSeason = {
    SEASONS: SEASONS,
    PICK_ORDER: PICK_ORDER,
    fmtDate: fmtDate,
    getYearAndSeason: getYearAndSeason,
    seasonString: seasonString,
    toSeasonStartAndEnd: toSeasonStartAndEnd,
    getSeasonStringByMonth: getSeasonStringByMonth,
    isSameSeason: isSameSeason,
    generateDateTime: generateDateTime,
    listPastSeasons: listPastSeasons
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = SFV.bangumiSeason;
  }
})(typeof window !== 'undefined' ? window : this);
