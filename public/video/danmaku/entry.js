/*
 * Stellaflix 影视模块 — 弹幕数据层 (DanmakuEntry)
 *
 * 移植自 Kazumi lib/modules/danmaku/danmaku_module.dart（GPL-3.0, Predidit/Kazumi）。
 * 遵循用户硬性约束：Kazumi 的 .dart 源文件一行不改；此处为对等的 JS 忠实重写，
 * 数据格式严格对齐 DanDanPlay（弹弹play）协议，保证互操作。
 *
 * DanDanPlay 单条弹幕线格式： p = "time,type,color,source"  +  m = "message"
 *   time  : 出现时间（秒，浮点）
 *   type  : 1=滚动(普通)  4=底部固定  5=顶部固定
 *   color : 24 位 RGB 整数 (0xRRGGBB)
 *   source: 来源标识，如 "[BiliBili]" / "[Gamer]"
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var danmaku = (SFV.danmaku = SFV.danmaku || {});

  // 24 位 RGB 整数 → {r,g,b}（0-255）。对应 Kazumi: generateDanmakuColor(int)
  function generateDanmakuColor(intColor) {
    intColor = intColor >>> 0;
    return {
      r: (intColor >> 16) & 0xff,
      g: (intColor >> 8) & 0xff,
      b: intColor & 0xff
    };
  }

  // {r,g,b}(0-255) → 24 位 RGB 整数。对应 Kazumi toJson 里的序列化。
  // （注：Kazumi 源写为 (color.r*255)，其 Flutter Color.r 本身即 0-255 分量，此处直接用 0-255 等价正确。）
  function danmakuColorToInt(c) {
    c = c || { r: 255, g: 255, b: 255 };
    var r = (c.r & 0xff), g = (c.g & 0xff), b = (c.b & 0xff);
    return (r << 16) | (g << 8) | b;
  }

  // 弹幕类型常量（与 DanDanPlay / Kazumi 一致）
  var DANMAKU_TYPE = { SCROLL: 1, BOTTOM: 4, TOP: 5 };

  function DanmakuEntry(opts) {
    opts = opts || {};
    this.message = opts.message != null ? String(opts.message) : '';
    this.time = Number(opts.time) || 0;
    this.type = opts.type != null ? opts.type : DANMAKU_TYPE.SCROLL;
    this.color = opts.color || { r: 255, g: 255, b: 255 };
    this.source = opts.source != null ? String(opts.source) : '';
  }

  // 由 DanDanPlay 线格式解析：{ m, p:"time,type,color,source" }
  DanmakuEntry.fromJson = function (json) {
    if (!json) return null;
    var message = json.m != null ? String(json.m) : '';
    var parts = String(json.p == null ? '' : json.p).split(',');
    var time = parseFloat(parts[0]);
    if (isNaN(time)) time = 0;
    var type = parseInt(parts[1], 10);
    if (isNaN(type)) type = DANMAKU_TYPE.SCROLL;
    var color = generateDanmakuColor(parseInt(parts[2], 10) || 0xffffff);
    var source = parts[3] != null ? String(parts[3]) : '';
    return new DanmakuEntry({ message: message, time: time, type: type, color: color, source: source });
  };

  // 序列化为 DanDanPlay 线格式（toJson 与 fromJson 格式一致）
  DanmakuEntry.prototype.toJson = function () {
    var colorValue = danmakuColorToInt(this.color);
    return {
      m: this.message,
      p: [this.time, this.type, colorValue, this.source].join(',')
    };
  };

  DanmakuEntry.prototype.isFixed = function () {
    return this.type === DANMAKU_TYPE.TOP || this.type === DANMAKU_TYPE.BOTTOM;
  };

  // 来源分类（弹弹play withRelated 聚合标记 → 标准化源名）
  // DanDanPlay 的 p[3] 含 [BiliBili]xxx / [Gamer]xxx / 纯数字(原生)
  function resolveSourceType(sourceStr) {
    var s = (sourceStr || '');
    if (s.indexOf('[BiliBili]') > -1) return 'bilibili';
    if (s.indexOf('[Gamer]') > -1) return 'gamer';
    return 'dandanplay';
  }

  DanmakuEntry.prototype.sourceType = function () {
    return resolveSourceType(this.source);
  };

  // 源类型常量（对齐 Kazumi 三源 UI）
  var SOURCE_TYPE = { BILIBILI: 'bilibili', GAMER: 'gamer', DANDANPLAY: 'dandanplay' };

  danmaku.DANMAKU_TYPE = DANMAKU_TYPE;
  danmaku.SOURCE_TYPE = SOURCE_TYPE;
  danmaku.resolveSourceType = resolveSourceType;
  danmaku.generateDanmakuColor = generateDanmakuColor;
  danmaku.danmakuColorToInt = danmakuColorToInt;
  danmaku.DanmakuEntry = DanmakuEntry;
})(typeof window !== 'undefined' ? window : this);
