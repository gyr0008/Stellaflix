/*
 * Stellaflix 影视模块 — page-browse-3d 的卡片绘制子系统（#6-b 抽取）
 * drawCardDirect / drawShell；只读共享状态 gridGlass / canvasW 经 SFV.browse3dBridge getter 获取。
 * 经 SFV.browse3dDraw 暴露，page-browse-3d.js 原位置改委托别名，调用点零改动。
 */
(function (global) {
  'use strict';
  if (!global.StellaflixVideo) global.StellaflixVideo = {};
  var SFV = global.StellaflixVideo;
  if (SFV.browse3dDraw) return; // 幂等守卫
  var BC = SFV.browse3dCore;
  if (!BC) throw new Error('[SFV browse3d-draw] browse3dCore 未加载，请检查加载顺序');
  var normalizeHexColor = BC.normalizeHexColor, hexToRgba = BC.hexToRgba, roundRect = BC.roundRect;
  var B = SFV.browse3dBridge;
  var WALL_CANVAS_W = 1280; // 大画布逻辑宽（= 网格最大宽度 1280，封顶）

  function drawCardDirect(ctx, item, img, x, y, w, h, hovered) {
    var gridGlass = B.gridGlass; var canvasW = B.canvasW;
    var sScale = canvasW / WALL_CANVAS_W;          // 以 1280 设计宽归一化（2px/1px 等按设计宽）
    var cardPad = w * 0.018;
    var radius = w * 0.05;
    var accent = (gridGlass && gridGlass.accent) || '#f4d28a';

    // 静态阴影（0 2px 8px，固定不增强）
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 8 * sScale;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 2 * sScale;
    roundRect(ctx, x + cardPad, y + cardPad, w - cardPad * 2, h - cardPad * 2, radius);
    // 底色可配置 shelfBgOpacity（默认暗玻璃）+ 线性渐变高光
    var bgGrad = ctx.createLinearGradient(0, y, 0, y + h);
    bgGrad.addColorStop(0, 'rgba(34, 38, 46, ' + gridGlass.bgOpacity + ')');
    bgGrad.addColorStop(1, 'rgba(14, 18, 24, ' + gridGlass.bgOpacity + ')');
    ctx.fillStyle = bgGrad;
    ctx.fill();
    ctx.restore();

    // 卡片边框：1.1px solid rgba(255,255,255,0.14)（深色，静态）
    // 选中(hover)时改强调色 + 发光（呼应歌单架选中态，不放大仅发光，保持网格面板铁律）
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = Math.max(1.1, 1.1 * sScale);
    roundRect(ctx, x + cardPad, y + cardPad, w - cardPad * 2, h - cardPad * 2, radius);
    ctx.stroke();
    if (hovered) {
      ctx.save();
      ctx.shadowColor = accent;
      ctx.shadowBlur = 18 * sScale;
      ctx.strokeStyle = accent;
      ctx.lineWidth = Math.max(1.4, 1.4 * sScale);
      roundRect(ctx, x + cardPad, y + cardPad, w - cardPad * 2, h - cardPad * 2, radius);
      ctx.stroke();
      ctx.restore();
    }

    // 海报区（按比例留出标题块，避免标题溢出）
    var posterPad = cardPad + w * 0.012;
    var titleBlock = h * 0.15;
    var availH = (h - cardPad * 2) - titleBlock;
    var posterW = Math.min(w - posterPad * 2, availH / 1.5);
    var posterH = posterW * 1.5;
    var posterX = x + (w - posterW) / 2;
    var posterY = y + cardPad + 4;
    var posterRadius = w * 0.04;

    ctx.save();
    roundRect(ctx, posterX, posterY, posterW, posterH, posterRadius);
    ctx.clip();
    if (img && img.naturalWidth) {
      var iw = img.naturalWidth, ih = img.naturalHeight;
      var sR = iw / ih, dR = posterW / posterH;
      var dw, dh, dx, dy;
      if (sR > dR) { dh = posterH; dw = dh * sR; dx = posterX - (dw - posterW) / 2; dy = posterY; }
      else         { dw = posterW; dh = dw / sR; dx = posterX; dy = posterY - (dh - posterH) / 2; }
      // 无 hover 放大：原尺寸绘制
      ctx.drawImage(img, dx, dy, dw, dh);
    } else {
      ctx.fillStyle = 'rgba(40, 44, 52, 1)';
      ctx.fillRect(posterX, posterY, posterW, posterH);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
      ctx.font = Math.round(w * 0.18) + 'px "Segoe UI Emoji", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🎬', posterX + posterW / 2, posterY + posterH / 2);
    }
    ctx.restore();

    // 海报细边框
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 0.5;
    roundRect(ctx, posterX, posterY, posterW, posterH, posterRadius);
    ctx.stroke();

    // 评分徽章（右上角，参考歌单架渐变胶囊）
    if (item.rating) {
      var badgeW = w * 0.16, badgeH = h * 0.038;
      var badgeX = posterX + posterW - badgeW - w * 0.018;
      var badgeY = posterY + h * 0.012;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.78)';
      roundRect(ctx, badgeX, badgeY, badgeW, badgeH, badgeH * 0.34);
      ctx.fill();
      ctx.strokeStyle = hexToRgba(accent, 0.55);
      ctx.lineWidth = Math.max(0.6, 0.8 * sScale);
      ctx.stroke();
      ctx.font = '700 ' + Math.round(h * 0.026) + 'px Inter, "Microsoft YaHei", sans-serif';
      ctx.fillStyle = 'rgba(255, 220, 120, 1)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('★ ' + item.rating.toFixed(1), badgeX + badgeW / 2, badgeY + badgeH / 2 + 1);
    }

    // 标题（标题块内左对齐）
    var titleFont = Math.max(11, Math.round(w * 0.058));
    var titleY = y + h - cardPad - titleBlock * 0.34;
    ctx.font = '700 ' + titleFont + 'px Inter, "Microsoft YaHei", Arial';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    var title = item.title || '';
    var maxChars = Math.max(4, Math.floor((w - posterPad * 2) / (titleFont * 0.62)));
    if (title.length > maxChars) title = title.substring(0, maxChars - 1) + '…';
    ctx.fillText(title, x + posterPad, titleY);

    // 副标题（年份）
    if (item.year) {
      ctx.font = '400 ' + Math.round(titleFont * 0.74) + 'px Inter, "Microsoft YaHei", Arial';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.52)';
      ctx.fillText(String(item.year), x + posterPad, titleY + titleFont * 0.92);
    }

    // 底部柔和暗角
    var vg = ctx.createLinearGradient(0, y + h - h * 0.12, 0, y + h);
    vg.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vg.addColorStop(1, 'rgba(0, 0, 0, 0.22)');
    ctx.fillStyle = vg;
    roundRect(ctx, x + cardPad, y + cardPad, w - cardPad * 2, h - cardPad * 2, radius);
    ctx.fill();
  }

  function drawShell(ctx, w, h) {
    var gridGlass = B.gridGlass;
    var pad = Math.max(8, w * 0.012);
    var radius = Math.max(12, w * 0.02);
    var accent = (gridGlass && gridGlass.accent) || '#f4d28a';
    ctx.save();
    // 阴影（与歌单架卡片同款轻微投影，浮于星空之上）
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 24;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 10;
    roundRect(ctx, pad, pad, w - pad * 2, h - pad * 2, radius);
    // 底色可配置 shelfBgOpacity（默认暗玻璃）+ 线性渐变高光
    var bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, 'rgba(34, 38, 46, ' + gridGlass.bgOpacity + ')');
    bg.addColorStop(1, 'rgba(14, 18, 24, ' + gridGlass.bgOpacity + ')');
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.restore();

    // 顶部微高光（歌单架卡片同款光泽）
    ctx.save();
    roundRect(ctx, pad, pad, w - pad * 2, h - pad * 2, radius);
    ctx.clip();
    var hl = ctx.createLinearGradient(0, pad, 0, h * 0.45);
    hl.addColorStop(0, 'rgba(255,255,255,0.06)');
    hl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hl;
    ctx.fillRect(pad, pad, w - pad * 2, h * 0.45);
    ctx.restore();

    // 强调色内描边微光（呼应歌单架 accent，可配置 shelfAccentColor）
    ctx.save();
    roundRect(ctx, pad + 2, pad + 2, w - pad * 2 - 4, h - pad * 2 - 4, radius * 0.9);
    ctx.strokeStyle = hexToRgba(accent, 0.18);
    ctx.lineWidth = Math.max(1, w * 0.0012);
    ctx.stroke();
    ctx.restore();

    // 1.1px 边框
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = Math.max(1.1, w * 0.0012 * 1.1);
    roundRect(ctx, pad, pad, w - pad * 2, h - pad * 2, radius);
    ctx.stroke();
  }

  SFV.browse3dDraw = { drawCardDirect: drawCardDirect, drawShell: drawShell };
})(typeof window !== 'undefined' ? window : this);
