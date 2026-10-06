/*!
 * 世界页国旗数据集（轮⑲）—— hearthere Yl/Gf/Qf 等价位（main.pretty.js :7245-7262）
 *
 * hearthere 的 Yl 是全量内联国旗库；本地只服务十座演示灯塔，
 * 收录 AU/BR/CN/FR/GB/IN/JP/RU/US/ZA 十国 3:2 扁平简化画法（米字旗/南十字等
 * 复杂纹章按几何近似，hearthere 自家旗库同为扁平 svg）。
 * Gf（flat data-uri）与 Qf（128×128 装框 + Map memoise，内层
 * replace('<svg ', '<svg x="10" y="28" width="108" height="72" ')）逐字移植。
 * 未知码：flagSvgFor 空串、flagDataUrl 空串、flagFramedUrl null →
 * 面板 :7357 三元自然回落 avatar 支路（不凭空造旗）。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  var OPEN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 40">';
  function svg(body) { return OPEN + body + '</svg>'; }

  // Yl 等价位：十国，viewBox 3:2，纯 rect/circle/polygon/line 几何
  var FLAGS = {
    AU: svg(
      '<rect width="60" height="40" fill="#012169"/>' +
      '<rect width="30" height="20" fill="#012169"/>' +
      '<line x1="0" y1="0" x2="30" y2="20" stroke="#FFFFFF" stroke-width="4"/>' +
      '<line x1="30" y1="0" x2="0" y2="20" stroke="#FFFFFF" stroke-width="4"/>' +
      '<line x1="0" y1="0" x2="30" y2="20" stroke="#C8102E" stroke-width="1.5"/>' +
      '<line x1="30" y1="0" x2="0" y2="20" stroke="#C8102E" stroke-width="1.5"/>' +
      '<rect x="12" width="6" height="20" fill="#FFFFFF"/>' +
      '<rect y="7" width="30" height="6" fill="#FFFFFF"/>' +
      '<rect x="13.5" width="3" height="20" fill="#C8102E"/>' +
      '<rect y="8.5" width="30" height="3" fill="#C8102E"/>' +
      '<circle cx="15" cy="30" r="3" fill="#FFFFFF"/>' +
      '<circle cx="45" cy="12" r="2" fill="#FFFFFF"/>' +
      '<circle cx="52" cy="18" r="2" fill="#FFFFFF"/>' +
      '<circle cx="45" cy="30" r="2" fill="#FFFFFF"/>' +
      '<circle cx="39" cy="18" r="2" fill="#FFFFFF"/>' +
      '<circle cx="48" cy="22" r="1.3" fill="#FFFFFF"/>'),
    BR: svg(
      '<rect width="60" height="40" fill="#009C3B"/>' +
      '<polygon points="30,3 57,20 30,37 3,20" fill="#FFDF00"/>' +
      '<circle cx="30" cy="20" r="8.5" fill="#002776"/>' +
      '<path d="M22.5 19q7.5 4.5 15 0" stroke="#FFFFFF" stroke-width="1.6" fill="none"/>'),
    CA: svg(
      '<rect width="15" height="40" fill="#FF0000"/>' +
      '<rect x="15" width="30" height="40" fill="#FFFFFF"/>' +
      '<rect x="45" width="15" height="40" fill="#FF0000"/>' +
      '<polygon points="30,8 31.8,13.3 34.3,12.1 33.5,16.5 37.7,16.1 35.9,19.9 39.9,22.2 34.6,23.7 37,28 32.7,26.9 33.3,31.5 30,29 26.7,31.5 27.3,26.9 23,28 25.4,23.7 20.1,22.2 24.1,19.9 22.3,16.1 26.5,16.5 25.7,12.1 28.2,13.3" fill="#FF0000"/>' +
      '<rect x="29.2" y="27.5" width="1.6" height="4.5" fill="#FF0000"/>'),
    CN: svg(
      '<rect width="60" height="40" fill="#DE2910"/>' +
      '<polygon points="10,3 12.5,9 19,9.5 14,13.6 15.5,20 10,16.5 4.5,20 6,13.6 1,9.5 7.5,9" fill="#FFDE00"/>' +
      '<circle cx="23" cy="8" r="2" fill="#FFDE00"/>' +
      '<circle cx="27" cy="12" r="2" fill="#FFDE00"/>' +
      '<circle cx="27" cy="18" r="2" fill="#FFDE00"/>' +
      '<circle cx="23" cy="22" r="2" fill="#FFDE00"/>'),
    DE: svg(
      '<rect width="60" height="13.4" fill="#000000"/>' +
      '<rect y="13.3" width="60" height="13.4" fill="#DD0000"/>' +
      '<rect y="26.7" width="60" height="13.4" fill="#FFCE00"/>'),
    ES: svg(
      '<rect width="60" height="10" fill="#AA151B"/>' +
      '<rect y="10" width="60" height="20" fill="#F1BF00"/>' +
      '<rect y="30" width="60" height="10" fill="#AA151B"/>' +
      '<rect x="8" y="14" width="7" height="11" rx="1.5" fill="#AA151B" stroke="#6D1A17" stroke-width="0.6"/>' +
      '<circle cx="11.5" cy="12.5" r="1.8" fill="#FFED09"/>'),
    FR: svg(
      '<rect width="20" height="40" fill="#0055A4"/>' +
      '<rect x="20" width="20" height="40" fill="#FFFFFF"/>' +
      '<rect x="40" width="20" height="40" fill="#EF4135"/>'),
    GB: svg(
      '<rect width="60" height="40" fill="#012169"/>' +
      '<line x1="0" y1="0" x2="60" y2="40" stroke="#FFFFFF" stroke-width="8"/>' +
      '<line x1="60" y1="0" x2="0" y2="40" stroke="#FFFFFF" stroke-width="8"/>' +
      '<line x1="0" y1="0" x2="60" y2="40" stroke="#C8102E" stroke-width="3"/>' +
      '<line x1="60" y1="0" x2="0" y2="40" stroke="#C8102E" stroke-width="3"/>' +
      '<rect x="21" width="18" height="40" fill="#FFFFFF"/>' +
      '<rect y="11" width="60" height="18" fill="#FFFFFF"/>' +
      '<rect x="25" width="10" height="40" fill="#C8102E"/>' +
      '<rect y="15" width="60" height="10" fill="#C8102E"/>'),
    IT: svg(
      '<rect width="20" height="40" fill="#009246"/>' +
      '<rect x="20" width="20" height="40" fill="#FFFFFF"/>' +
      '<rect x="40" width="20" height="40" fill="#CE2B37"/>'),
    IN: svg(
      '<rect width="60" height="13.4" fill="#FF9933"/>' +
      '<rect y="13.3" width="60" height="13.4" fill="#FFFFFF"/>' +
      '<rect y="26.7" width="60" height="13.4" fill="#138808"/>' +
      '<circle cx="30" cy="20" r="4.5" fill="none" stroke="#000080" stroke-width="1.2"/>'),
    JP: svg(
      '<rect width="60" height="40" fill="#FFFFFF"/>' +
      '<circle cx="30" cy="20" r="10" fill="#BC002D"/>'),
    KR: svg(
      '<rect width="60" height="40" fill="#FFFFFF"/>' +
      '<circle cx="30" cy="20" r="8" fill="#CD2E3A"/>' +
      '<path d="M30 12a8 8 0 0 1 0 16 4 4 0 0 1 0-8 4 4 0 0 0 0-8z" fill="#0047A0"/>' +
      '<g stroke="#000000" stroke-width="2">' +
      '<g transform="rotate(-30 11 9)"><line x1="5" y1="6" x2="17" y2="6"/><line x1="5" y1="9" x2="17" y2="9"/><line x1="5" y1="12" x2="17" y2="12"/></g>' +
      '<g transform="rotate(30 49 31)"><line x1="43" y1="28" x2="46.5" y2="28"/><line x1="51.5" y1="28" x2="55" y2="28"/><line x1="43" y1="31" x2="46.5" y2="31"/><line x1="51.5" y1="31" x2="55" y2="31"/><line x1="43" y1="34" x2="46.5" y2="34"/><line x1="51.5" y1="34" x2="55" y2="34"/></g>' +
      '<g transform="rotate(30 49 9)"><line x1="43" y1="6" x2="55" y2="6"/><line x1="43" y1="9" x2="46.5" y2="9"/><line x1="51.5" y1="9" x2="55" y2="9"/><line x1="43" y1="12" x2="55" y2="12"/></g>' +
      '<g transform="rotate(-30 11 31)"><line x1="5" y1="28" x2="17" y2="28"/><line x1="5" y1="31" x2="8.5" y2="31"/><line x1="13.5" y1="31" x2="17" y2="31"/><line x1="5" y1="34" x2="17" y2="34"/></g>' +
      '</g>'),
    MX: svg(
      '<rect width="20" height="40" fill="#006847"/>' +
      '<rect x="20" width="20" height="40" fill="#FFFFFF"/>' +
      '<rect x="40" width="20" height="40" fill="#CE1126"/>' +
      '<circle cx="30" cy="20" r="5" fill="#8B5A2B"/>' +
      '<path d="M27 20q3-4 6 0" stroke="#006847" stroke-width="1.4" fill="none"/>'),
    NL: svg(
      '<rect width="60" height="13.4" fill="#AE1C28"/>' +
      '<rect y="13.3" width="60" height="13.4" fill="#FFFFFF"/>' +
      '<rect y="26.7" width="60" height="13.4" fill="#21468B"/>'),
    RU: svg(
      '<rect width="60" height="13.4" fill="#FFFFFF"/>' +
      '<rect y="13.3" width="60" height="13.4" fill="#0039A6"/>' +
      '<rect y="26.7" width="60" height="13.4" fill="#D52B1E"/>'),
    TR: svg(
      '<rect width="60" height="40" fill="#E30A17"/>' +
      '<circle cx="23" cy="20" r="8.5" fill="#FFFFFF"/>' +
      '<circle cx="26" cy="20" r="7" fill="#E30A17"/>' +
      '<polygon points="36,15.6 37.3,19 40.8,19 38,21.2 39.1,24.6 36,22.4 32.9,24.6 34,21.2 31.2,19 34.7,19" fill="#FFFFFF"/>'),
    US: svg(
      '<rect width="60" height="40" fill="#B22234"/>' +
      '<rect y="3.1" width="60" height="3.1" fill="#FFFFFF"/>' +
      '<rect y="9.2" width="60" height="3.1" fill="#FFFFFF"/>' +
      '<rect y="15.4" width="60" height="3.1" fill="#FFFFFF"/>' +
      '<rect y="21.5" width="60" height="3.1" fill="#FFFFFF"/>' +
      '<rect y="27.7" width="60" height="3.1" fill="#FFFFFF"/>' +
      '<rect y="33.8" width="60" height="3.1" fill="#FFFFFF"/>' +
      '<rect width="26" height="21.5" fill="#3C3B6E"/>' +
      '<circle cx="5" cy="5" r="1.2" fill="#FFFFFF"/>' +
      '<circle cx="13" cy="5" r="1.2" fill="#FFFFFF"/>' +
      '<circle cx="21" cy="5" r="1.2" fill="#FFFFFF"/>' +
      '<circle cx="9" cy="11.5" r="1.2" fill="#FFFFFF"/>' +
      '<circle cx="17" cy="11.5" r="1.2" fill="#FFFFFF"/>' +
      '<circle cx="5" cy="18" r="1.2" fill="#FFFFFF"/>' +
      '<circle cx="13" cy="18" r="1.2" fill="#FFFFFF"/>' +
      '<circle cx="21" cy="18" r="1.2" fill="#FFFFFF"/>'),
    ZA: svg(
      '<rect width="60" height="14" fill="#DE3831"/>' +
      '<rect y="26" width="60" height="14" fill="#00237D"/>' +
      '<rect y="14" width="60" height="12" fill="#007A4D"/>' +
      '<polygon points="0,0 28,20 0,40" fill="#FFFFFF"/>' +
      '<polygon points="0,5 22,20 0,35" fill="#000000"/>')
  };

  // Yl(code)
  function flagSvgFor(code) { return FLAGS[code] || ''; }

  // Gf :7245-7250 逐字
  function flagDataUrl(code) {
    var e = flagSvgFor(code);
    return e ? 'data:image/svg+xml,' + encodeURIComponent(e) : '';
  }

  // Qf :7251-7262 逐字；未命中 hearthere 回落 cs 首字母，此处返回 null 由
  // 面板 :7357 三元自然走 avatar 支路（结果等价，不凭空造旗）
  var cache = new Map();
  function flagFramedUrl(code) {
    var key = 'flag:' + code;
    var hit = cache.get(key);
    if (hit) return hit;
    var o = flagSvgFor(code);
    if (!o) return null;
    var i = '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">' +
      o.replace('<svg ', '<svg x="10" y="28" width="108" height="72" ') +
      '</svg>';
    var l = 'data:image/svg+xml,' + encodeURIComponent(i);
    cache.set(key, l);
    return l;
  }

  SFV.worldFlags = {
    FLAG_CODES: Object.keys(FLAGS).sort(),
    flagSvgFor: flagSvgFor,
    flagDataUrl: flagDataUrl,
    flagFramedUrl: flagFramedUrl
  };
})(typeof window !== 'undefined' ? window : globalThis);
