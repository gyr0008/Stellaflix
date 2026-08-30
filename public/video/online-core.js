/*
 * Stellaflix 影视模块 — online.js 零依赖纯过滤谓词层 (#6-序7)
 *
 * 从 online.js 抽出的零依赖纯层：8 个纯过滤谓词 + esc/trackLabel/fmtAgo/TRACK_META（纯工具，零依赖）。
 * 特点：仅依赖入参、不触碰 SFV.* / window / document / DOM，可在 vm 沙箱无桩运行。
 * 保留在 online.js 的 _itemEpisodeExcluded 因依赖 SFV.sources.countEpisodes，不在此层。
 *
 * 契约：本文件须在 online.js 之前加载；online.js 顶部经 SFV.onlineCore 别名绑定复用，
 * 调用点零改动。幂等守卫保证重复加载跳过。
 */
(function (global) {
  'use strict';
  if (!global.StellaflixVideo) global.StellaflixVideo = {};
  var SFV = global.StellaflixVideo;
  if (SFV.onlineCore) return; // 幂等守卫

  // 双向包含：a 含 b 或 b 含 a 任一为真
  function _containsEither(a, b) {
    return (a && a.indexOf(b) >= 0) || (b && b.indexOf(a) >= 0);
  }

  // 类型匹配：动漫/纪录片/综艺等直接包含；动作片/喜剧片（纪录片单列）；国产剧/日韩剧/电视剧
  function _typeMatches(excl, t) {
    if (!t) return false;
    if (t.indexOf(excl) >= 0) return true;                       // 动漫 / 纪录片 / 综艺 等直接包含
    if (excl === '电影' && /片$/.test(t) && t !== '纪录片') return true; // 动作片/喜剧片…（纪录片单列）
    if (excl === '剧集' && /剧$/.test(t)) return true;            // 国产剧/日韩剧/电视剧…
    return false;
  }

  function _itemTypeExcluded(it, arr) {
    var t = it.typeName || it.vodType || '';
    for (var i = 0; i < arr.length; i++) { if (_typeMatches(arr[i], t)) return true; }
    return false;
  }

  function _itemRegionExcluded(it, arr) {
    var a = it.area || '';
    for (var i = 0; i < arr.length; i++) { if (_containsEither(a, arr[i])) return true; }
    return false;
  }

  function _itemYearExcluded(it, year) {
    var y = parseInt(it.year, 10);
    if (isNaN(y)) return false; // 无年份不剔除
    return y < year;
  }

  function _itemScoreExcluded(it, min) {
    var s = parseFloat(it.score != null ? it.score : (it.vodScore != null ? it.vodScore : ''));
    if (isNaN(s)) return false;
    return s < min;
  }

  // 简介 + 标题 + 备注 任一含关键词子串即隐藏（大小写不敏感）
  function _itemKeywordExcluded(it, arr) {
    var hay = ((it.content || '') + ' ' + (it.title || '') + ' ' + (it.remarks || '')).toLowerCase();
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && hay.indexOf(String(arr[i]).toLowerCase()) >= 0) return true;
    }
    return false;
  }

  // TMDB 评分补全内存缓存键（title|year 小写）
  function _scoreKey(it) { return (it.title || '').toLowerCase() + '|' + (it.year || ''); }

  // ---- 纯工具函数层（#6-序7 续：esc / trackLabel / fmtAgo / TRACK_META）----
  // HTML 转义：& < > " ' 五字符，防止注入到 innerHTML 拼接串
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 追片 5 状态分区（与 Kazumi 一致，互斥单值）。none=未收藏，由缺键表示。
  var TRACK_META = [
    { status: 'watching', label: '在看' },
    { status: 'planToWatch', label: '想看' },
    { status: 'onHold', label: '搁置' },
    { status: 'watched', label: '看过' },
    { status: 'abandoned', label: '抛弃' },
  ];

  // 追片状态 → 中文标签（TRACK_META 查表，缺省空串）
  function trackLabel(s) {
    for (var i = 0; i < TRACK_META.length; i++) if (TRACK_META[i].status === s) return TRACK_META[i].label;
    return '';
  }

  // 相对时间格式化（ts 毫秒时间戳 → 刚刚/x 分钟前/x 小时前/x 天前；非法返回空串）
  function fmtAgo(ts) {
    if (!ts) return '';
    var s = (Date.now() - ts) / 1000;
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  }

  SFV.onlineCore = {
    _containsEither: _containsEither,
    _typeMatches: _typeMatches,
    _itemTypeExcluded: _itemTypeExcluded,
    _itemRegionExcluded: _itemRegionExcluded,
    _itemYearExcluded: _itemYearExcluded,
    _itemScoreExcluded: _itemScoreExcluded,
    _itemKeywordExcluded: _itemKeywordExcluded,
    _scoreKey: _scoreKey,
    // 纯工具层
    esc: esc,
    TRACK_META: TRACK_META,
    trackLabel: trackLabel,
    fmtAgo: fmtAgo
  };
})(typeof window !== 'undefined' ? window : this);
