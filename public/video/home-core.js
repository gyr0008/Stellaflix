/*
 * Stellaflix 影视模块 — home 纯工具核心 (T-#6-序4)
 *
 * 零 DOM / 零 IO / 零外部状态依赖；可被 Node 沙箱直接加载做单测。
 *   - fmtTime  : 秒数 → 中文时长（"X小时Y分" / "Y分钟" / "Z秒"）
 *   - escHtml  : HTML 转义（防 XSS 注入）
 *   - escAttr  : 属性值转义（等同 escHtml）
 *
 * 注：home.js 的 cardDefs 在调用时读取 SFV.model 计数、闭包引用 SFV.hall/online/state，
 *     不属于「零依赖纯层」，按纪律保留在 home.js 内（t112 静态断言亦依赖其在 home.js）。
 */
(function (global) {
  'use strict';
  if (!global.StellaflixVideo) global.StellaflixVideo = {};
  var SFV = global.StellaflixVideo;
  if (SFV.homeCore) return; // 幂等守卫

  function fmtTime(sec) {
    sec = Math.max(0, sec | 0);
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    if (h) return h + '小时' + (m ? m + '分' : '');
    return m ? m + '分钟' : (sec + '秒');
  }

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escAttr(s) { return escHtml(s); }

  SFV.homeCore = {
    fmtTime: fmtTime,
    escHtml: escHtml,
    escAttr: escAttr,
  };
})(typeof window !== 'undefined' ? window : this);
