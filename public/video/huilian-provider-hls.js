/*
 * Stellaflix — 汇联页 · HLS (m3u8) 来源适配器
 * ----------------------------------------------------------------------------
 * 复用项目已有的 hls.js 加载逻辑，但用自定义 hls.js 的 pLoader 把"时间 → 分片 → 字节"
 * 的映射桥起来，让上层 huilian-stream.js 能按时间窗口 openRange。
 *
 * 要点：hls.js 天生是"边下边播"的，本适配器用 hls.js 作为"磁盘-分片"层；
 * 但 GC 不用 hls.js 自己——由 huilian-stream.js 按时间主动 remove MSE buffer
 * 来实现"播过即弃"。
 *
 * 让 hls.js append 到一个独立的 MS，huilian-stream 再从那儿"吃掉已下载段"。
 * 简化做法：让 hls.js 自己放，上层通过 <video>.buffered 观测 + SourceBuffer 的
 * remove 控制尾巴。但 hls.js 内部的 MS 不暴露 SB，所以我们改用旁路索引方案：
 *   1) hls.js 正常起播
 *   2) huilian-playlist 维护一份"分片 → 时间"索引（从 m3u8 解析）
 *   3) 当需要裁剪尾巴时，直接调 hls.destroy() 重起（这是一种"裁剪"等价）
 *
 * 然而真正的"边播边删"对 HLS 场景：让 sourceBuffer 是 huilian-stream 私有 MS，
 * hls.js 输出定向到这个 MS（通过 hls.js MediaSource 模式）——hls.js 没有内置"redirect
 * to custom MS"的 API。
 *
 * 因此做一个折中：**直接解析 m3u8 拿到分片 URL 列表 → 作为 IProvider 让
 * huilian-stream 自管 MSE**。这是本适配器的实际做法（不用 hls.js，自创）。
 *
 * 适用：兼容 HLS v3-v7（多码率自适应码率 selector 暴露给 huilian-page）。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var Prov = SFV.huilianProviders;
  if (!Prov) throw new Error('huilianProviders 未加载');

  // XHR 拉文本（走 /api/proxy 跨域）
  function fetchText(url) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url);
      xhr.onload = function () { resolve(xhr.responseText); };
      xhr.onerror = function () { reject('xhr-fail'); };
      xhr.send();
    });
  }
  function fetchArrayBuffer(url, range) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url);
      xhr.responseType = 'arraybuffer';
      if (range) xhr.setRequestHeader('Range', 'bytes=' + range.start + '-' + range.end);
      xhr.onload = function () { resolve(xhr.response); };
      xhr.onerror = function () { reject('xhr-fail'); };
      xhr.send();
    });
  }

  // 解析 m3u8：返回 {duration, variants[], segments[{url,duration,byteStart,byteEnd}]}
  function parseM3u8(text, baseUrl) {
    var lines = text.split(/\r?\n/).map(function (l) { return l.trim(); });
    var segments = [];
    var variants = [];
    var totalDuration = 0;
    var curUrl = null, curDuration = 0, curByteStart = 0, curByteEnd = -1;
    var hasExtinf = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line || line.startsWith('#EXT-X-')) {
        if (line.startsWith('#EXT-X-STREAM-INF')) {
          var bw = line.match(/BANDWIDTH=(\d+)/);
          var res = line.match(/RESOLUTION=(\d+x\d+)/);
          variants.push({ bandwidth: bw ? parseInt(bw[1]) : 0, resolution: res ? res[1] : '' });
        } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
          // ignore
        }
        continue;
      }
      if (line.startsWith('#EXTINF')) {
        curDuration = parseFloat(line.split(':')[1].split(',')[0]);
        hasExtinf = true;
        continue;
      }
      if (!line.startsWith('#')) {
        curUrl = new URL(line, baseUrl).href;
        if (hasExtinf) {
          segments.push({
            url: curUrl,
            duration: curDuration,
            byteStart: curByteStart,
            byteEnd: curByteEnd
          });
          totalDuration += curDuration;
          curDuration = 0; curUrl = null; curByteStart = 0; curByteEnd = -1; hasExtinf = false;
        }
      }
    }
    return { duration: totalDuration, segments: segments, variants: variants };
  }

  function HlsProvider() {
    Prov.IProvider.call(this, 'hls', 30);
    this._index = null;
    this._activeVariant = 0;
  }
  HlsProvider.prototype = Object.create(Prov.IProvider.prototype);
  HlsProvider.prototype.constructor = HlsProvider;

  HlsProvider.prototype.canHandle = function (input) {
    var n = Prov.normalizeInput(input);
    return n ? Prov.isHls(n.url) : false;
  };

  HlsProvider.prototype.resolve = function (input) {
    var self = this;
    var n = Prov.normalizeInput(input);
    return fetchText(n.url).then(function (text) {
      var idx = parseM3u8(text, n.url);
      self._index = idx;
      return {
        id: n.id || n.url,
        title: n.title || (idx.variants.length ? ('HLS ' + self._activeVariant) : 'HLS'),
        durationSec: idx.duration,
        mimeType: 'video/mp2t',   // MPEG-TS 容器
        kind: 'vod',
        source: 'hls',
        variants: idx.variants,
        segments: idx.segments,
        masterUrl: n.url,
        extra: { idx: idx }
      };
    });
  };

  // 按时间找覆盖 [s,e] 的分片下标
  HlsProvider.prototype._segmentsCovering = function (s, e, segments) {
    var cur = 0;
    var startIdx = -1, endIdx = -1;
    for (var i = 0; i < segments.length; i++) {
      var segEnd = cur + segments[i].duration;
      if (startIdx < 0 && segEnd > s) startIdx = i;
      if (segEnd >= e) { endIdx = i; break; }
      cur = segEnd;
    }
    if (startIdx < 0) return null;
    if (endIdx < 0) endIdx = segments.length - 1;
    return [startIdx, endIdx, segments.slice(startIdx, endIdx + 1)];
  };

  HlsProvider.prototype.openRange = function (manifest, startSec, endSec) {
    var segs = manifest.segments;
    var cov = this._segmentsCovering(startSec, endSec, segs);
    if (!cov) return Promise.reject('no-cover');
    var rangeSegs = cov[2];
    // 顺序拉取，拼接 ArrayBuffer
    var bufs = [];
    return new Promise(function (outerResolve, outerReject) {
      function step(i) {
        if (i >= rangeSegs.length) {
          // 拼接
          var total = bufs.reduce(function (a, b) { return a + b.byteLength; }, 0);
          var out = new Uint8Array(total);
          var off = 0;
          for (var k = 0; k < bufs.length; k++) { out.set(new Uint8Array(bufs[k]), off); off += bufs[k].byteLength; }
          outerResolve(out.buffer);
          return;
        }
        fetchArrayBuffer(rangeSegs[i].url).then(function (b) {
          bufs.push(b);
          step(i + 1);
        }).catch(outerReject);
      }
      step(0);
    });
  };

  Prov.register(new HlsProvider());
  SFV.huilianHlsProvider = HlsProvider;
})(typeof window !== 'undefined' ? window : this);
