/*
 * Stellaflix 影视模块 — 汇联页 · 来源适配器契约层 (huilian-providers.js)
 * ----------------------------------------------------------------------------
 * 汇联页要"无论影片在哪里，点击即播"。影片可能来自：
 *   - m3u8 / mp4 / flv 直链（HTTP Range）
 *   - WebDAV / SMB / FTP 网络挂载
 *   - Emby / Plex / Jellyfin 媒体服务器（各自公开 REST API）
 *   - 阿里云盘 / 115 网盘 / Alist 聚合（各自公开 API）
 *   - 磁力 / BT（WebTorrent 或 aria2 RPC）
 *
 * 本文件定义一个统一的「IProvider」契约，让上层 huilian-stream.js /
 * huilian-page.js 完全不关心影片到底在哪儿。
 *
 * 契约（每个适配器必须实现）：
 *   1) canHandle(input) → boolean          : 能不能处理这个输入
 *   2) resolve(input) → Promise<manifest>   : 把输入解析成播放清单
 *   3) openRange(manifest, startSec, endSec, opts) → Promise<ArrayBuffer>
 *                                            : 拉取 [startSec, endSec] 这段媒体数据
 *   4) priority → number                    : 多适配器都能处理时的优先级（大者优先）
 *
 * manifest 结构（统一）：
 *   {
 *     id: string,             // 唯一标识
 *     title: string,          // 显示名
 *     durationSec: number,    // 总时长（未知为 0）
 *     mimeType: string,       // 容器 MIME（如 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"'）
 *     kind: 'vod' | 'live',   // 点播 / 直播
 *     source: 'hls'|'webdav'|'emby'|'aliyun'|'magnet'|'direct',
 *     tracks?: [{kind:'video'|'audio', lang?, name?}], // 多轨
 *     extra?: any,            // 适配器私有扩展
 *   }
 *
 * 加载顺序：本文件先于各适配器文件；各适配器文件在 index.html 里挂在本文件之后。
 * 单文件 ≤ 350 行。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  // -------- 契约基类（可选继承）--------
  function IProvider(name, priority) {
    this.name = name;
    this.priority = priority || 0;
  }
  IProvider.prototype.canHandle = function () { return false; };
  IProvider.prototype.resolve = function () { return Promise.reject('not-implemented'); };
  IProvider.prototype.openRange = function () { return Promise.reject('not-implemented'); };

  // -------- 注册表 --------
  var registry = [];

  function register(provider) {
    if (!provider || typeof provider.canHandle !== 'function') return;
    registry.push(provider);
    registry.sort(function (a, b) { return (b.priority || 0) - (a.priority || 0); });
  }

  // 给定输入，挑一个能处理的 provider
  function pick(input) {
    for (var i = 0; i < registry.length; i++) {
      if (registry[i].canHandle(input)) return registry[i];
    }
    return null;
  }

  // 统一入口：把任意输入解析成 manifest
  function resolve(input) {
    var p = pick(input);
    if (!p) return Promise.reject('no-provider-for-input');
    return p.resolve(input).then(function (m) {
      m = m || {};
      m.source = m.source || p.name;
      return m;
    });
  }

  // -------- 工具：把任意输入归一化（URL / 对象 / 磁力）--------
  function normalizeInput(input) {
    if (!input) return null;
    if (typeof input === 'string') {
      return { url: input, title: input, id: input };
    }
    if (typeof input === 'object') {
      return {
        url: input.url || input.link || input.magnet || input.file || '',
        title: input.title || input.name || '',
        id: input.id || input.url || input.link || '',
        extra: input,
      };
    }
    return null;
  }

  // 判断是不是磁力
  function isMagnet(s) {
    return /^magnet:\?/i.test(String(s || ''));
  }
  // 判断是不是 m3u8
  function isHls(s) {
    return /\.m3u8(\?|#|$)/i.test(String(s || ''));
  }
  // 判断是不是常见视频直链
  function isDirectVideo(s) {
    return /\.(mp4|m4v|webm|ogv|mkv|mov|avi|ts|flv)(\?|#|$)/i.test(String(s || ''));
  }
  // 判断是不是 WebDAV
  function isWebDav(s) {
    return /^https?:\/\/[^/]+\/dav/i.test(String(s || '')) ||
           /webdav/i.test(String(s || ''));
  }
  // 判断是不是 Emby / Jellyfin / Plex
  function isMediaServer(s) {
    var u = String(s || '');
    return /\/emby\//i.test(u) || /\/jellyfin\//i.test(u) || /\/plex\//i.test(u) ||
           /emby|jellyfin|plex/i.test(u);
  }
  // 判断是不是阿里云盘分享
  function isAliyun(s) {
    return /aliyundrive\.com\/s\//i.test(String(s || '')) ||
           /aliyundrive\.com\/t\//i.test(String(s || ''));
  }

  // -------- 暴露 --------
  SFV.huilianProviders = {
    IProvider: IProvider,
    register: register,
    pick: pick,
    resolve: resolve,
    normalizeInput: normalizeInput,
    isMagnet: isMagnet,
    isHls: isHls,
    isDirectVideo: isDirectVideo,
    isWebDav: isWebDav,
    isMediaServer: isMediaServer,
    isAliyun: isAliyun,
    _registry: registry,
  };
})(typeof window !== 'undefined' ? window : this);
