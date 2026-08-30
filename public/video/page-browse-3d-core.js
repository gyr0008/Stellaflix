/*
 * Stellaflix 影视模块 — page-browse-3d 的零依赖纯层核心（#6-序5）
 *
 * 抽出 page-browse-3d.js 中真正无副作用、无 SFV.* / DOM / localStorage / fetch 耦合的纯函数：
 *   - normalizeHexColor / hexToRgba：颜色解析工具（hex → 规范化 / rgba 字符串）
 *   - metricsForWidth：响应式网格列数映射（纯宽度→规格，无全局状态）
 *   - roundRect：Canvas 2D 圆角矩形路径（ctx 作参，无模块状态）
 *
 * 挂于 window.StellaflixVideo.browse3dCore，含幂等守卫；
 * 由 page-browse-3d.js 顶部别名绑定复用，SFV.browse3d 公共 API 形状不变。
 */
(function (global) {
  'use strict';
  if (!global.StellaflixVideo) global.StellaflixVideo = {};
  var SFV = global.StellaflixVideo;
  if (SFV.browse3dCore) return; // 幂等守卫：避免重复注册（HMR/重复加载）

  function normalizeHexColor(c, fb) {
    if (typeof c !== 'string') return fb;
    c = c.trim();
    if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c)) return c;
    return fb;
  }
  function hexToRgba(hex, a) {
    var h = normalizeHexColor(hex, '#f4d28a');
    var n = h.length === 4
      ? [parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16), parseInt(h[3] + h[3], 16)]
      : [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    return 'rgba(' + n[0] + ',' + n[1] + ',' + n[2] + ',' + a + ')';
  }
  function metricsForWidth(w) {
    var cols = w < 640 ? 2 : (w < 768 ? 3 : (w < 1024 ? 4 : 5));
    var pad = w >= 1024 ? 32 : (w >= 640 ? 24 : 16); // 容器内边距/间隙：默认16 / ≥640→24 / ≥1024→32
    return { cols: cols, pad: pad, gap: pad };
  }
  function roundRect(ctx, x, y, w, h, r) {
    if (w < 2 * r) r = w / 2;
    if (h < 2 * r) r = h / 2;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  SFV.browse3dCore = {
    normalizeHexColor: normalizeHexColor,
    hexToRgba: hexToRgba,
    metricsForWidth: metricsForWidth,
    roundRect: roundRect
  };
})(typeof window !== 'undefined' ? window : this);
