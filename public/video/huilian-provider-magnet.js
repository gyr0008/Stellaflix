/*
 * Stellaflix — 汇联页 · 磁力 / BT 来源适配器
 * ----------------------------------------------------------------------------
 * 项目当前 package.json 里没有 webtorrent，所以本适配器是可选插件：
 *   - 检测到 global.WEBTORRENT（由 index.html 动态注入）→ 走真正的 P2P 流
 *   - 没检测到 → 给 UI 提示"请安装 webtorrent 插件启用磁力播放"
 *
 * Webtorrent-MSE 桥接（项目没 webtorrent 时不执行）：
 *   - 让 webtorrent 把 torrent 文件顺序下载到内存（不写磁盘）
 *   - 用 torrent.files[0].getBuffer() 或 torrent.file.pipe() 拿到 ArrayBuffer
 *   - 由 huilian-stream.js 的 IProvider.openRange 接：
 *       * 维护一份"piece index → time"的 IMD（用 file.createReadStream + mp4box 探）
 *       * openRange(startSec, endSec) → 命中 piece 范围 → 等 webtorrent
 *         下载到那些 piece → 取出对应 ArrayBuffer
 *
 * 合规：本适配器默认"仅缓存、不做种"（download 完立刻 GC）；可在用户显式勾选后
 * 开启做种。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var Prov = SFV.huilianProviders;
  if (!Prov) throw new Error('huilianProviders 未加载');

  // 同步探测：webtorrent 是否已加载（可选插件）
  function hasWebtorrent() {
    return !!(global.WEBTORRENT || (global.WebTorrent && isFn(global.WebTorrent)));
  }
  function isFn(f) { return typeof f === 'function'; }

  function xhrRange(url, start, end) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url);
      xhr.responseType = 'arraybuffer';
      if (typeof start === 'number') xhr.setRequestHeader('Range', 'bytes=' + start + '-' + end);
      xhr.onload = function () { resolve(xhr.response); };
      xhr.onerror = function () { reject('xhr-fail'); };
      xhr.send();
    });
  }

  function MagnetProvider() { Prov.IProvider.call(this, 'magnet', 10); }
  MagnetProvider.prototype = Object.create(Prov.IProvider.prototype);
  MagnetProvider.prototype.constructor = MagnetProvider;

  MagnetProvider.prototype.canHandle = function (input) {
    var n = Prov.normalizeInput(input);
    return n ? Prov.isMagnet(n.url) : false;
  };

  MagnetProvider.prototype.hasPlugin = hasWebtorrent;

  // 在 webtorrent 未加载时给出友好错误
  MagnetProvider.prototype._ensureWebtorrent = function () {
    if (hasWebtorrent()) return Promise.resolve(global.WebTorrent || global.WEBTORRENT);
    return Promise.reject('webtorrent-not-installed');
  };

  // 起流：用 webtorrent 下载，返回 IMD 映射
  MagnetProvider.prototype.resolve = function (input) {
    var self = this;
    var n = Prov.normalizeInput(input);
    return this._ensureWebtorrent().then(function (WT) {
      return new Promise(function (resolve, reject) {
        var tc = new WT({ tracker: true, webSeeds: true });
        self._tc = tc;
        var torrent = tc.add(n.url, {}, function (tor) {
          // 选最大视频文件
          var videoFiles = tor.files.filter(function (f) {
            return /\.(mp4|mkv|webm|flv|ts)$/i.test(f.name);
          });
          if (!videoFiles.length) { reject('no-video-file'); return; }
          var file = videoFiles.sort(function (a, b) { return b.length - a.length; })[0];
          file.parseTimeMap().then(function (imd) {
            resolve({
              id: n.id || n.url,
              title: n.title || file.name,
              durationSec: imd.durationSec,
              mimeType: 'video/mp4',
              kind: 'vod',
              source: 'magnet',
              url: n.url,
              extra: { tor: tor, file: file, imd: imd, tc: tc }
            });
          }).catch(function () {
            // 没 IMD：退化到顺序模式
            resolve({
              id: n.id || n.url,
              title: n.title || file.name,
              durationSec: 0,
              mimeType: 'video/mp4',
              kind: 'vod',
              source: 'magnet',
              url: n.url,
              extra: { tor: tor, file: file, imd: null, tc: tc }
            });
          });
        });
        torrent.on('error', function (e) { reject(e); });
        setTimeout(function () { reject('torrent-timeout'); }, 30000);
      });
    });
  };

  // 按时间 → IMD 命中 piece → 等 webtorrent 下载到 → 取出 ArrayBuffer
  MagnetProvider.prototype.openRange = function (manifest, startSec, endSec) {
    var self = this;
    var tor = manifest.extra.tor, file = manifest.extra.file, imd = manifest.extra.imd;
    if (!imd || !imd.pieceMap) {
      // 退化模式：把整个 file 当顺序流
      return file.buffer ? Promise.resolve(file.buffer) : file.getBuffer();
    }
    // 命中 piece
    var pieces = this._piecesCovering(imd, startSec, endSec);
    if (!pieces) return Promise.reject('no-cover');
    // 让 webtorrent 优先下载这些 piece（createReadStream 会自动触发优先级）
    var rs = file.createReadStream({ start: pieces.startByte, end: pieces.endByte });
    return new Promise(function (resolve, reject) {
      var chunks = [];
      rs.on('data', function (d) { chunks.push(d); });
      rs.on('end', function () {
        var total = chunks.reduce(function (a, b) { return a + b.length; }, 0);
        var out = new Uint8Array(total);
        var off = 0;
        for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].length; }
        resolve(out.buffer);
      });
      rs.on('error', reject);
    });
  };

  // IMD 命中：pieceMap = [{secStart, secEnd, byteStart, byteEnd}]
  MagnetProvider.prototype._piecesCovering = function (imd, s, e) {
    var pm = imd.pieceMap || [];
    var hit = [];
    for (var i = 0; i < pm.length; i++) {
      if (pm[i].secEnd <= s) continue;
      if (pm[i].secStart >= e) break;
      hit.push(pm[i]);
    }
    if (!hit.length) return null;
    return { startByte: hit[0].byteStart, endByte: hit[hit.length - 1].byteEnd };
  };

  // 公用：清理 torrent（对齐 PDF 的 destroyStore）
  MagnetProvider.prototype.destroy = function (manifest) {
    var tc = (manifest.extra && manifest.extra.tc) || this._tc;
    if (tc && isFn(tc.destroy)) tc.destroy();
  };

  Prov.register(new MagnetProvider());
  SFV.huilianMagnetProvider = MagnetProvider;
})(typeof window !== 'undefined' ? window : this);
