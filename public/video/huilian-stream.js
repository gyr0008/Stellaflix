/*
 * Stellaflix 影视模块 — 汇联页 · MSE 流式缓冲管理器 (huilian-stream.js)
 * ----------------------------------------------------------------------------
 * 目标：浏览器内真正做到「边下边播 + 边播边删 + 随意跳转」。
 *
 * 为什么需要自己造：
 *   - <video> 原生：只暴露 .buffered（时间维度），没有"删已下载段"API；
 *     浏览器磁盘缓存 GC 不可观测。
 *   - hls.js / flv.js：用 MSE 封装，但没给"播过即删"开关。
 *   - 唯一可行路径：自己拿 MediaSource + SourceBuffer，自己按播放头位置主动
 *     SourceBuffer.remove(0, cutoff)。
 *
 * 本文件只做一件事：把「IProvider」（来源抽象，见 huilian-providers.js）接进
 * MSE，并给 GC scheduler 提供"按播放头滚动尾巴回收"的能力。
 *
 * 关键概念：
 *   - TAIL_SECONDS（默认 45s）：磁盘/内存永远只比播放头多出 TAIL_SECONDS 段缓冲。
 *     播过这段 → 立刻 remove，不手软。
 *   - fetch 优先级：热区 (播放头前 HOT_SECONDS) > 预取区 (WARM_SECONDS) > 其他。
 *   - seek：abort 全部在-flight + remove 残留 + 从 seek 点重新填满窗口。
 *
 * 加载依赖：SFV.huilianProviders（IProvider 契约）。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  var DEFAULTS = {
    TAIL_SECONDS: 45,
    HOT_SECONDS: 15,
    WARM_SECONDS: 90,
    GC_INTERVAL_MS: 250,
    MAX_IN_FLIGHT: 3,
    BACK_SECONDS: 8,     // 播放头后保留（seek 回退缓冲）
  };

  function StreamController(opts) {
    opts = opts || {};
    this.cfg = Object.assign({}, DEFAULTS, opts.cfg || {});
    this.provider = null;
    this.manifest = null;
    this.videoEl = null;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.durationSec = 0;

    this._inFlight = [];
    this._gcTimer = null;
    this._destroyed = false;
    this._onError = opts.onError || function () {};
    this._onReady = opts.onReady || function () {};
    this._onBytes = opts.onBytes || function () {};
    this._onTick = opts.onTick || function () {}; // (cur, bufEnd, gcCutoff)
    this._bytesDownloaded = 0;
    this._appendQueue = [];   // 串行化 append
    this._appending = false;
  }

  // ---------- 公开 API ----------
  StreamController.prototype.attach = function (videoEl, provider, manifest, mime) {
    if (this._destroyed) return Promise.reject('stream-destroyed');
    this.videoEl = videoEl;
    this.provider = provider;
    this.manifest = manifest;
    this.mimeType = mime;
    this.durationSec = manifest.durationSec || 0;
    var self = this;

    return new Promise(function (resolve, reject) {
      if (!global.MediaSource) { reject('no-mse'); return; }
      if (!MediaSource.isTypeSupported(mime)) { reject('unsupported-mime: ' + mime); return; }
      var ms = new global.MediaSource();
      self.mediaSource = ms;
      ms.addEventListener('sourceopen', function onceOpen() {
        ms.removeEventListener('sourceopen', onceOpen);
        try {
          self.sourceBuffer = ms.addSourceBuffer(mime);
          self.sourceBuffer.mode = 'segments';       // 随意跳转
          self.sourceBuffer.addEventListener('updateend', function () { self._drainAppendQueue(); });
          self._startGcLoop();
          self._onReady();
          resolve(true);
        } catch (e) { reject(e && e.message ? e.message : String(e)); }
      });
      ms.addEventListener('error', function () { self._onError('media-source-error'); });
      videoEl.src = global.URL.createObjectURL(ms);
    });
  };

  StreamController.prototype.seekTo = function (sec) {
    this._abortAll();
    var self = this;
    // remove 残留
    var sb = this.sourceBuffer;
    if (sb) {
      if (sb.updating) {
        // 等 updating 完了再清
        sb.addEventListener('updateend', function once() {
          sb.removeEventListener('updateend', once);
          self._removeAndRefill(sec);
        });
        return;
      }
    }
    self._removeAndRefill(sec);
  };

  StreamController.prototype._removeAndRefill = function (sec) {
    var sb = this.sourceBuffer;
    if (sb && !sb.updating) {
      try {
        var end = sb.buffered.length ? sb.buffered.end(sb.buffered.length - 1) : 0;
        if (end > 0) sb.remove(0, end + 1);
      } catch (e) {}
    }
    var self = this;
    setTimeout(function () { self._fillWindow(sec); }, 0);
  };

  StreamController.prototype.reset = function () {
    this._abortAll();
    this._appendQueue = [];
    this._appending = false;
    if (this._gcTimer) { clearInterval(this._gcTimer); this._gcTimer = null; }
    if (this.sourceBuffer) {
      try {
        if (this.sourceBuffer.buffered.length) this.sourceBuffer.remove(0, this.durationSec || Infinity);
        this.mediaSource.removeSourceBuffer(this.sourceBuffer);
      } catch (e) {}
    }
    if (this.videoEl) this.videoEl.src = '';
    if (this.mediaSource && this.mediaSource.readyState === 'open') {
      try { this.mediaSource.endOfStream(); } catch (e) {}
    }
    this.mediaSource = null;
    this.sourceBuffer = null;
    this._bytesDownloaded = 0;
  };

  // ---------- 窗口填充（时间维度）----------
  StreamController.prototype._fillWindow = function (aroundSec) {
    if (this._destroyed || !this.sourceBuffer) return;
    var cfg = this.cfg;
    var dur = this.durationSec;
    var hotStart = Math.max(0, aroundSec - cfg.BACK_SECONDS);
    var hotEnd = dur ? Math.min(dur, aroundSec + cfg.HOT_SECONDS) : aroundSec + cfg.HOT_SECONDS;
    var warmEnd = dur ? Math.min(dur, aroundSec + cfg.WARM_SECONDS) : aroundSec + cfg.WARM_SECONDS;

    var self = this;
    this._ensureTimeRange(hotStart, hotEnd, 3, function (miss) { self._fetchRanges(miss, 3); });
    this._ensureTimeRange(hotEnd, warmEnd, 2, function (miss) {
      if (self._inFlight.length < 2) self._fetchRanges(miss, 2);
    });
  };

  // 计算 [s,e] 还缺哪些时间子区间（相对于已缓冲 / 在途）
  StreamController.prototype._ensureTimeRange = function (s, e, pri, missCb) {
    if (s >= e) return;
    var buffered = this._bufferedRanges();
    var pending = this._inFlight.map(function (r) { return [r.startSec, r.endSec]; });
    var merged = buffered.concat(pending);
    var range = [[s, e]];
    var misses = _subtract(range, merged);
    if (misses.length) missCb(misses);
  };

  StreamController.prototype._bufferedRanges = function () {
    var sb = this.sourceBuffer;
    if (!sb || !sb.buffered) return [];
    var out = [];
    try {
      for (var i = 0; i < sb.buffered.length; i++) out.push([sb.buffered.start(i), sb.buffered.end(i)]);
    } catch (e) {}
    return out;
  };

  // ---------- fetch 队列 ----------
  StreamController.prototype._fetchRanges = function (misses, pri) {
    var self = this;
    for (var i = 0; i < misses.length; i++) {
      if (this._inFlight.length >= this.cfg.MAX_IN_FLIGHT) break;
      if (pri <= 1 && this._inFlight.length >= 1) continue;
      var m = misses[i];
      var p = this.provider.openRange(this.manifest, m[0], m[1], { pri: pri });
      if (!p) continue;
      var entry = { startSec: m[0], endSec: m[1], abort: false };
      this._inFlight.push(entry);
      (function (ent) {
        p.then(function (buf) {
          if (ent.abort || self._destroyed) return;
          var idx = self._inFlight.indexOf(ent);
          if (idx >= 0) self._inFlight.splice(idx, 1);
          self._enqueueAppend(buf, ent.startSec);
          self._bytesDownloaded += buf.byteLength;
          self._onBytes(buf.byteLength, self._bytesDownloaded);
        }).catch(function () {
          var idx = self._inFlight.indexOf(ent);
          if (idx >= 0) self._inFlight.splice(idx, 1);
        });
      })(entry);
    }
  };

  StreamController.prototype._abortAll = function () {
    for (var i = 0; i < this._inFlight.length; i++) this._inFlight[i].abort = true;
    this._inFlight = [];
  };

  // ---------- SourceBuffer 串行化 append ----------
  StreamController.prototype._enqueueAppend = function (buf, startSec) {
    this._appendQueue.push({ buf: buf, startSec: startSec });
    this._drainAppendQueue();
  };

  StreamController.prototype._drainAppendQueue = function () {
    if (this._appending || !this._appendQueue.length) return;
    var sb = this.sourceBuffer;
    if (!sb || sb.updating) return;
    var next = this._appendQueue.shift();
    this._appending = true;
    var self = this;
    try {
      sb.appendBuffer(next.buf);
    } catch (e) {
      self._appending = false;
      if (e && e.name === 'QuotaExceededError') {
        try {
          var tend = sb.buffered.length ? sb.buffered.start(0) + 30 : 30;
          sb.remove(0, tend);
        } catch (_e) {}
      }
      // 重试一次
      self._appendQueue.unshift(next);
      setTimeout(function () { self._drainAppendQueue(); }, 50);
      return;
    }
    // 等 updateend
    sb.addEventListener('updateend', function once() {
      sb.removeEventListener('updateend', once);
      self._appending = false;
      self._drainAppendQueue();
    });
  };

  // ---------- GC 循环（边播边删）----------
  StreamController.prototype._startGcLoop = function () {
    var self = this;
    if (this._gcTimer) clearInterval(this._gcTimer);
    this._gcTimer = setInterval(function () { self._gcTick(); }, this.cfg.GC_INTERVAL_MS);
  };

  StreamController.prototype._gcTick = function () {
    if (this._destroyed || !this.sourceBuffer || !this.videoEl) return;
    var cur = this.videoEl.currentTime || 0;
    var cutoff = cur - this.cfg.BACK_SECONDS;
    var bufEnd = 0;
    try {
      var sb = this.sourceBuffer;
      if (sb.buffered.length) bufEnd = sb.buffered.end(sb.buffered.length - 1);
      if (cutoff > 0 && !sb.updating) sb.remove(0, cutoff);
    } catch (e) {}
    this._onTick(cur, bufEnd, cutoff);
    this._fillWindow(cur);
  };

  // ---------- 区间减法 ----------
  function _subtract(ranges, covered) {
    var result = ranges.map(function (r) { return [r[0], r[1]]; });
    for (var i = 0; i < covered.length; i++) {
      var c = covered[i];
      var next = [];
      for (var j = 0; j < result.length; j++) {
        var r = result[j];
        if (c[1] <= r[0] || c[0] >= r[1]) { next.push(r); continue; }
        if (c[0] > r[0]) next.push([r[0], c[0]]);
        if (c[1] < r[1]) next.push([c[1], r[1]]);
      }
      result = next;
    }
    return result;
  }

  SFV.huilianStream = {
    StreamController: StreamController,
    DEFAULTS: DEFAULTS,
  };
})(typeof window !== 'undefined' ? window : this);
