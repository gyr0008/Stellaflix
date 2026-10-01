/*
 * Stellaflix — 汇联页 · WebDAV / 网络挂载 来源适配器
 * ----------------------------------------------------------------------------
 * WebDAV = HTTP + PROPFIND/Range。核心能力：
 *   - HEAD 响应 Content-Length → 文件字节总长
 *   - GET Range 请求任意字节区间
 *
 * 为了让 huilian-stream 能"随意跳转"，需要字节到时间的映射。对一个 MP4/MKV：
 *   1) 拉一段"头部"（含 moov atom，通常在前 4MB 内）：
 *      new Uint8Array(buffer) → 用 mp4box.js 抽 moov -> trak -> minf -> stbl
 *        → stts(采样时间)/stsz(采样大小)/stsc(chunk->sample)/stco(chunk offset)
 *   2) 建立 [timeSec] => [chunkRange] 映射（秒级 IMD）
 *   3) 按 [startSec,endSec] → 命中一组 chunk → 合并成 1..N 个 Range 请求
 *
 * MKV：走 EBML + Cues 索引（若黏端（moov 在文件尾），需要先 Range 拉文件尾）。
 *
 * 本文件只用 MP4（MKV 对齐思路但暂不实现）。
 *
 * 加载依赖：/vendor/mp4box.all.min.js（项目已存在则先用，没有就跳过，降级到
 * 整片顺序播放模式）。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var Prov = SFV.huilianProviders;
  if (!Prov) throw new Error('huilianProviders 未加载');

  var MP4BoxLib = (global.MP4BoxLib) || null;
  function loadMp4Box() {
    if (MP4BoxLib || !global.document) return Promise.resolve(null);
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = '/vendor/mp4box.all.min.js';
      s.onload = function () { MP4BoxLib = global.mp4box ? global.mp4box : (global.MP4Box || null); resolve(MP4BoxLib); };
      s.onerror = function () { resolve(null); };
      (document.head || document.documentElement).appendChild(s);
    });
  }

  function head(url) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('HEAD', url);
      xhr.onload = function () {
        var len = parseInt(xhr.getResponseHeader('Content-Length') || '0', 10);
        var accept = xhr.getResponseHeader('Accept-Ranges') || '';
        var ct = xhr.getResponseHeader('Content-Type') || '';
        resolve({ contentLength: len, acceptRanges: accept, contentType: ct });
      };
      xhr.onerror = function () { reject('head-fail'); };
      xhr.send();
    });
  }

  function getRange(url, start, end) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url);
      xhr.responseType = 'arraybuffer';
      xhr.setRequestHeader('Range', 'bytes=' + start + '-' + end);
      xhr.onload = function () { resolve(xhr.response); };
      xhr.onerror = function () { reject('range-fail'); };
      xhr.send();
    });
  }

  // 极简 MP4 探针：抽 moov atom → 抽 stts/stsz/stsc/stco → 返回 IMD 映射
  // 这只是一个完整实现的骨架——真实项目应直接用 mp4box.js。
  function probeMp4(url, headInfo) {
    // 启发：先拉前 4MB（含 moov 大概率够）
    return getRange(url, 0, Math.min(headInfo.contentLength - 1, 4 * 1024 * 1024 - 1))
      .then(function (buf) {
        if (MP4BoxLib) return probeWithMp4BoxLib(buf, url, headInfo);
        return probeFallback(buf, url, headInfo);
      });
  }

  function probeWithMp4BoxLib(buf, url, headInfo) {
    // mp4box.js 用法（省略详细 box 解析，改用 fileStart 回调）
    // 真实上线需要把 ArrayBuffer 交给 mp4box.parseBuffer
    return {
      durationSec: 0,   // 由 mp4box 填
      timeMap: [],      // [{sec, byteStart, byteEnd}]
      mimeType: 'video/mp4',
      probed: true,
    };
  }

  function probeFallback(buf, url, headInfo) {
    // 极简启发：从 ftyp 往后搜 moov；找不到就退化为"顺序模式"
    // 真实项目请勿依赖此启发：用 mp4box.js
    var dv = new DataView(buf);
    var foundMoov = -1;
    for (var i = 0; i < dv.byteLength - 8; i++) {
      var size = dv.getUint32(i);
      var type = String.fromCharCode(dv.getUint8(i+4), dv.getUint8(i+5), dv.getUint8(i+6), dv.getUint8(i+7));
      if (type === 'moov') { foundMoov = i; break; }
    }
    return {
      durationSec: 0,
      timeMap: [],
      mimeType: 'video/mp4',
      probed: foundMoov >= 0,
      _buf: buf,
    };
  }

  function WebDavProvider() {
    Prov.IProvider.call(this, 'webdav', 20);
  }
  WebDavProvider.prototype = Object.create(Prov.IProvider.prototype);
  WebDavProvider.prototype.constructor = WebDavProvider;

  WebDavProvider.prototype.canHandle = function (input) {
    var n = Prov.normalizeInput(input);
    if (!n) return false;
    return Prov.isWebDav(n.url) || /\/dav|\/remote\.php\/disk/i.test(n.url);
  };

  WebDavProvider.prototype.resolve = function (input) {
    var self = this;
    var n = Prov.normalizeInput(input);
    return head(n.url).then(function (hi) {
      return probeMp4(n.url, hi).then(function (probe) {
        return {
          id: n.id || n.url,
          title: n.title || n.url.split('/').pop() || 'webdav',
          durationSec: probe.durationSec,
          mimeType: probe.mimeType,
          kind: 'vod',
          source: 'webdav',
          url: n.url,
          contentLength: hi.contentLength,
          probed: probe.probed,
          timeMap: probe.timeMap,
          extra: { head: hi, probe: probe }
        };
      });
    });
  };

  WebDavProvider.prototype.openRange = function (manifest, startSec, endSec) {
    // IMD 映射求字节区间
    var map = manifest.timeMap || [];
    if (!map.length || !manifest.probed) {
      // 退化为顺序模式：拿总长 × (sec/duration) 粗估
      var ratioStart = startSec / Math.max(1, manifest.durationSec || 1);
      var ratioEnd = endSec / Math.max(1, manifest.durationSec || 1);
      var total = manifest.contentLength || 0;
      var bs = Math.floor(total * ratioStart);
      var be = Math.floor(total * ratioEnd);
      return getRange(manifest.url, bs, Math.min(be, total - 1));
    }
    // 命中 map 中的区间（合并为 1 个 Range）
    var hit = [];
    for (var i = 0; i < map.length; i++) {
      if (map[i].sec + map[i].dur <= startSec) continue;
      if (map[i].sec >= endSec) break;
      hit.push(map[i]);
    }
    if (!hit.length) return Promise.reject('no-imd-hit');
    var bs = hit[0].byteStart;
    var be = hit[hit.length - 1].byteEnd;
    return getRange(manifest.url, bs, be);
  };

  Prov.register(new WebDavProvider());
  SFV.huilianWebDavProvider = WebDavProvider;
})(typeof window !== 'undefined' ? window : this);
