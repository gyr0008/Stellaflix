/*
 * Stellaflix 影视模块 — 弹幕渲染引擎 (engine.js)
 *
 * 纯 JS 实现（非移植自 Kazumi：Kazumi 弹幕渲染是 Flutter widget，无法在网页运行）。
 * 功能对齐 Kazumi 弹幕设置面板（截图 212034/212038）：
 *   顶部/底部/滚动三态、描边、字号、字重、不透明度、速度、海量模式、去重、关键词屏蔽、显示区域。
 *
 * 设计：纯调度逻辑（轨道分配 / 去重 / 屏蔽 / 类型过滤 / 穿越时长）与 DOM 渲染分离，
 *      纯逻辑可在 vm 沙箱单测（无需 document），DOM 渲染由 Electron 真机冒烟验证。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var danmaku = (SFV.danmaku = SFV.danmaku || {});

  // ---------- 默认配置（对齐 Kazumi 截图默认值）----------
  function defaultOptions() {
    return {
      area: 1.0,            // 弹幕显示区域占画面高度比例 (0-1)
      scrollSpeed: 150,     // 滚动弹幕速度 px/s
      fixedDuration: 8,     // 顶/底固定弹幕停留秒数
      lineHeight: 1.6,      // 行高倍率
      fontSize: 25,         // 字号 px
      fontWeight: 4,        // 1-9 滑块（→ 100-900）
      opacity: 1.0,         // 不透明度 0-1
      stroke: true,         // 描边
      strokeWidth: 1.5,
      color: true,          // 彩色弹幕（关→强制白色）     // 描边粗细
      showScroll: true,     // 滚动弹幕
      showTop: true,        // 顶部弹幕
      showBottom: false,    // 底部弹幕
      massiveMode: false,   // 海量模式（允许重叠）
      dedup: false,         // 去重
      dedupWindow: 5,       // 去重时间窗（秒）
      blockedWords: [],      // 关键词屏蔽
      enabledSources: { bilibili: true, gamer: true, dandanplay: true }  // 三源开关（对齐 Kazumi）
    };
  }

  // ---------- 纯逻辑函数（可单测）----------

  // 字重：Kazumi 滑块 1-9 → CSS 100-900
  function resolveFontWeight(w) {
    w = Math.max(1, Math.min(9, w | 0));
    return w * 100;
  }

  // 颜色对象 → rgb()
  function colorToCss(c) {
    if (!c) return 'rgb(255,255,255)';
    return 'rgb(' + (c.r & 0xff) + ',' + (c.g & 0xff) + ',' + (c.b & 0xff) + ')';
  }

  // 描边阴影（多方向描边模拟加粗描边）
  function strokeShadow(width) {
    var w = Math.max(1, width);
    return [
      '0 -' + w + 'px 0 #000',
      '0 ' + w + 'px 0 #000',
      '-' + w + 'px 0 0 #000',
      w + 'px 0 0 #000'
    ].join(',');
  }

  // 文本估计宽度（无 DOM 时按字符数估算）
  function estimateWidth(text, fontSize) {
    var n = (text || '').length;
    return Math.max(fontSize * 2, n * fontSize * 0.6);
  }

  // 滚动弹幕穿越时长 = (容器宽 + 文本宽) / 速度
  function traverseTime(entry, opts, containerWidth) {
    var w = estimateWidth(entry.message, opts.fontSize);
    var dist = (containerWidth || 1280) + w;
    var speed = opts.scrollSpeed > 0 ? opts.scrollSpeed : 150;
    return dist / speed;
  }

  // 类型过滤 + 来源过滤
  function shouldShow(entry, opts) {
    if (!entry) return false;
    if (entry.type === danmaku.DANMAKU_TYPE.TOP) return !!opts.showTop;
    if (entry.type === danmaku.DANMAKU_TYPE.BOTTOM) return !!opts.showBottom;
    if (!opts.showScroll) return false; // 滚动（含其它未知类型）
    // 来源过滤：按 enabledSources 白名单检查
    var es = opts.enabledSources;
    if (es && typeof es === 'object' && danmaku.resolveSourceType) {
      var st = danmaku.resolveSourceType(entry.source);
      return !!(es[st]);
    }
    return true;
  }

  // 关键词屏蔽
  function isBlocked(text, blockedWords) {
    if (!blockedWords || !blockedWords.length) return false;
    var t = text || '';
    for (var i = 0; i < blockedWords.length; i++) {
      var w = (blockedWords[i] || '').trim();
      if (w && t.indexOf(w) > -1) return true;
    }
    return false;
  }

  // 去重键：同文本同类型视为重复
  function dedupKey(entry) {
    return (entry.type || 0) + ':' + (entry.message || '');
  }

  /*
   * 滚动轨道分配（纯逻辑）
   * trackFreeAt: number[]，每个轨道的“空闲时间”（<= now 表示空闲）
   * 返回轨道索引；若无空闲且非海量模式返回 -1（丢弃）
   */
  function pickScrollTrack(trackFreeAt, entry, now, opts, containerWidth, trackCount) {
    var t = traverseTime(entry, opts, containerWidth);
    var chosen = -1;
    for (var i = 0; i < trackCount; i++) {
      if ((trackFreeAt[i] || 0) <= now) { chosen = i; break; }
    }
    if (chosen === -1) {
      if (!opts.massiveMode) return -1; // 丢弃
      // 海量模式：选最早空闲的轨道
      chosen = 0;
      for (var j = 1; j < trackCount; j++) if ((trackFreeAt[j] || 0) < (trackFreeAt[chosen] || 0)) chosen = j;
    }
    trackFreeAt[chosen] = now + t;
    return chosen;
  }

  /*
   * 顶/底固定弹幕堆叠分配
   * stackFreeAt: number[]，每行的空闲时间
   */
  function pickFixedSlot(stackFreeAt, now, duration, opts, slotCount) {
    var chosen = -1;
    for (var i = 0; i < slotCount; i++) {
      if ((stackFreeAt[i] || 0) <= now) { chosen = i; break; }
    }
    if (chosen === -1) {
      if (!opts.massiveMode) return -1;
      chosen = 0;
      for (var j = 1; j < slotCount; j++) if ((stackFreeAt[j] || 0) < (stackFreeAt[chosen] || 0)) chosen = j;
    }
    stackFreeAt[chosen] = now + duration;
    return chosen;
  }

  // ---------- 引擎 ----------
  function DanmakuEngine(opts) {
    this.opts = Object.assign(defaultOptions(), opts || {});
    this.entries = [];
    this.pointer = 0;          // 已消费到的 entries 下标（按时间排序）
    this.lastTime = 0;
    this.container = null;
    this.trackFreeAt = [];     // 滚动轨道
    this.topFreeAt = [];       // 顶部堆叠
    this.bottomFreeAt = [];    // 底部堆叠
    this.dedupSeen = Object.create(null);
    this.activeEls = [];
  }

  DanmakuEngine.prototype.setOptions = function (o) {
    this.opts = Object.assign(this.opts, o || {});
  };

  DanmakuEngine.prototype.configure = function (o) { this.setOptions(o); };

  DanmakuEngine.prototype.load = function (entries) {
    this.entries = (entries || []).slice().sort(function (a, b) { return a.time - b.time; });
    this.reset();
  };

  DanmakuEngine.prototype.reset = function () {
    this.pointer = 0;
    this.lastTime = 0;
    this.dedupSeen = Object.create(null);
    this.clear();
  };

  DanmakuEngine.prototype.clear = function () {
    if (this.container) {
      var nodes = this.container.querySelectorAll('.sfv-danmaku');
      for (var i = 0; i < nodes.length; i++) nodes[i].parentNode && nodes[i].parentNode.removeChild(nodes[i]);
    }
    this.activeEls = [];
    this.trackFreeAt = [];
    this.topFreeAt = [];
    this.bottomFreeAt = [];
  };

  // 计算轨道/堆叠数量（基于容器高度与选项）
  DanmakuEngine.prototype._trackCount = function () {
    var h = (this.container && this.container.clientHeight) || 720;
    var usable = h * (this.opts.area > 0 ? this.opts.area : 1);
    var linePx = this.opts.fontSize * this.opts.lineHeight;
    return Math.max(1, Math.floor(usable / linePx));
  };

  // 播放头推进：spawn 落在 (lastTime, time] 的弹幕
  DanmakuEngine.prototype.update = function (time) {
    if (time < this.lastTime) { this.reset(); this.lastTime = time; }
    var from = this.lastTime, to = time;
    var now = time;
    var trackCount = this._trackCount();
    var containerWidth = (this.container && this.container.clientWidth) || 1280;

    for (var i = this.pointer; i < this.entries.length; i++) {
      var e = this.entries[i];
      if (e.time > to) { this.pointer = i; break; }
      this.pointer = i + 1;
      if (e.time <= from) continue; // 已过的（seek 后边界）
      if (!shouldShow(e, this.opts)) continue;
      if (isBlocked(e.message, this.opts.blockedWords)) continue;
      if (this.opts.dedup) {
        var k = dedupKey(e);
        if (this.dedupSeen[k] != null && now - this.dedupSeen[k] < this.opts.dedupWindow) continue;
        this.dedupSeen[k] = now;
      }
      this._spawn(e, now, trackCount, containerWidth);
    }
    this.lastTime = to;
  };

  // 实际生成一条弹幕 DOM（仅在浏览器环境）
  DanmakuEngine.prototype._spawn = function (entry, now, trackCount, containerWidth) {
    if (typeof document === 'undefined' || !this.container) return; // vm 沙箱下不执行
    var opts = this.opts;
    var el = document.createElement('div');
    el.className = 'sfv-danmaku';
    el.textContent = entry.message;
    var style = el.style;
    style.position = 'absolute';
    style.whiteSpace = 'nowrap';
    style.willChange = 'transform';
    style.pointerEvents = 'none';
    style.color = (opts.color === false) ? '#ffffff' : colorToCss(entry.color);
    style.fontSize = opts.fontSize + 'px';
    style.fontWeight = String(resolveFontWeight(opts.fontWeight));
    style.opacity = String(opts.opacity);
    if (opts.stroke) style.textShadow = strokeShadow(opts.strokeWidth);

    var linePx = opts.fontSize * opts.lineHeight;
    var kind = entry.type === danmaku.DANMAKU_TYPE.TOP ? 'top'
      : entry.type === danmaku.DANMAKU_TYPE.BOTTOM ? 'bottom' : 'scroll';

    if (kind === 'scroll') {
      var track = pickScrollTrack(this.trackFreeAt, entry, now, opts, containerWidth, trackCount);
      if (track === -1) return;
      style.top = (track * linePx) + 'px';
      style.left = '0px';
      var t = traverseTime(entry, opts, containerWidth);
      var w = estimateWidth(entry.message, opts.fontSize);
      style.transform = 'translateX(' + containerWidth + 'px)';
      this.container.appendChild(el);
      // 下一帧启动过渡
      var self = this;
      requestAnimationFrame(function () {
        style.transition = 'transform ' + t + 's linear';
        style.transform = 'translateX(' + (-w) + 'px)';
      });
      this._autoRemove(el, t);
    } else if (kind === 'top') {
      var slot = pickFixedSlot(this.topFreeAt, now, opts.fixedDuration, opts, trackCount);
      if (slot === -1) return;
      style.top = (slot * linePx) + 'px';
      style.left = '50%';
      style.transform = 'translateX(-50%)';
      this.container.appendChild(el);
      this._autoRemove(el, opts.fixedDuration);
    } else { // bottom
      var bslot = pickFixedSlot(this.bottomFreeAt, now, opts.fixedDuration, opts, trackCount);
      if (bslot === -1) return;
      style.bottom = (bslot * linePx) + 'px';
      style.left = '50%';
      style.transform = 'translateX(-50%)';
      this.container.appendChild(el);
      this._autoRemove(el, opts.fixedDuration);
    }
  };

  DanmakuEngine.prototype._autoRemove = function (el, seconds) {
    var self = this;
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, seconds * 1000 + 200);
  };

  DanmakuEngine.prototype.mount = function (container) { this.container = container; };
  DanmakuEngine.prototype.play = function () {};
  DanmakuEngine.prototype.pause = function () { this.clear(); };

  // 暴露纯函数供单测
  danmaku.engine = {
    DanmakuEngine: DanmakuEngine,
    defaultOptions: defaultOptions,
    resolveFontWeight: resolveFontWeight,
    colorToCss: colorToCss,
    strokeShadow: strokeShadow,
    estimateWidth: estimateWidth,
    traverseTime: traverseTime,
    shouldShow: shouldShow,
    isBlocked: isBlocked,
    dedupKey: dedupKey,
    pickScrollTrack: pickScrollTrack,
    pickFixedSlot: pickFixedSlot
  };
})(typeof window !== 'undefined' ? window : this);
