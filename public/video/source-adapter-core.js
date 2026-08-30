/*
 * Stellaflix 影视模块 — 三源统一适配层 · 纯算法核心 (Step 3 · Core)
 *
 * 零依赖纯函数集合：URL 归一化、代理地址构造、扩展名判定、HLS 预清洗诊断。
 * 不碰 DOM、不发请求，可在 Node 沙箱中完整单测。
 *
 * 由 source-adapter.js 在加载期注入别名绑定后调用；本文件通过 SFV.sourceAdapterCore
 * 暴露 facade，并带幂等守卫（重复加载安全跳过），与主支其它 *-core 模块同构。
 *
 * 合规红线：本文件不预置、不内置任何在线片源（api_site）。所有 URL 均由用户显式提供。
 */
(function (global) {
  'use strict';
  if (!global.StellaflixVideo) global.StellaflixVideo = {};
  var SFV = global.StellaflixVideo;
  if (SFV.sourceAdapterCore) return; // 幂等守卫：重复加载安全跳过

  var PROXY_PATH = '/api/proxy';
  var HLS_EXT = /\.m3u8(\?|#|$)/i;
  var FLV_EXT = /\.flv(\?|#|$)/i;

  // 常见容器扩展名 → 仅用于友好提示，不作为播放前置门槛（真正能力以浏览器解码为准）
  var KNOWN_VIDEO_EXT = /\.(mp4|m4v|webm|ogv|mkv|mov|avi|ts|flv)(\?|#|$)/i;

  function isFileLike(x) {
    if (!x || typeof x !== 'object') return false;
    if (typeof global.File !== 'undefined' && x instanceof global.File) return true;
    if (typeof global.Blob !== 'undefined' && x instanceof global.Blob) return true;
    // Electron 拖拽/选择的对象可能只带 path+name
    return typeof x.name === 'string' && (typeof x.path === 'string' || typeof x.size === 'number');
  }

  function parseUrl(str) {
    try {
      var base = (global.location && global.location.href) ? global.location.href : undefined;
      return base ? new global.URL(str, base) : new global.URL(str);
    } catch (e) {
      return null;
    }
  }

  function sameOrigin(u) {
    if (!global.location || !u) return false;
    return u.origin === global.location.origin;
  }

  function toProxyUrl(rawUrl) {
    return PROXY_PATH + '?url=' + encodeURIComponent(rawUrl);
  }

  function basename(pathname) {
    if (!pathname) return '';
    var parts = String(pathname).split('/');
    var last = parts[parts.length - 1] || '';
    try { return decodeURIComponent(last); } catch (e) { return last; }
  }

  /**
   * 浏览器是否原生支持 HLS（Safari/部分 WebView 支持；Chromium 通常不支持）。
   * 用于决定「直接喂给 <video>」还是「提示需要 hls.js」。
   * 无 document 环境（如 Node 沙箱）安全返回 false。
   */
  function nativeHlsSupported() {
    try {
      if (!global.document || !global.document.createElement) return false;
      var v = global.document.createElement('video');
      if (!v || !v.canPlayType) return false;
      return !!(v.canPlayType('application/vnd.apple.mpegurl') ||
                v.canPlayType('application/x-mpegURL'));
    } catch (e) {
      return false;
    }
  }

  /**
   * 归一化任意来源。
   * @param {File|Blob|string|{url:string,title?:string,id?:string}} input
   * @returns {{ok:boolean, kind:string, playUrl:string|null, rawUrl:string|null,
   *            needsProxy:boolean, title:string, file:File|null, id:string|null,
   *            requiresHlsLib:boolean, reason:string|null}}
   */
  function resolve(input) {
    var out = {
      ok: false,
      kind: 'unsupported', // 'local' | 'direct' | 'hls' | 'unsupported'
      playUrl: null,
      rawUrl: null,
      needsProxy: false,
      title: '',
      file: null,
      id: null,
      requiresHlsLib: false,
      reason: null,
    };

    if (!input) {
      out.reason = 'empty-input';
      return out;
    }

    // ---- 1) 本地文件对象 ----
    if (isFileLike(input)) {
      out.ok = true;
      out.kind = 'local';
      out.file = input;
      out.title = input.name || 'local-video';
      out.rawUrl = input.path || null;
      out.id = input.id || null;
      return out;
    }

    // ---- 2) 对象形式 { url, title, id } ----
    var title = '';
    var explicitId = null;
    if (typeof input === 'object') {
      title = input.title || '';
      explicitId = input.id || null;
      input = input.url;
      if (!input) {
        out.reason = 'empty-url';
        return out;
      }
    }

    if (typeof input !== 'string') {
      out.reason = 'unsupported-input-type';
      return out;
    }

    var s = input.trim();
    if (!s) {
      out.reason = 'empty-url';
      return out;
    }

    // ---- 3) blob: / file: 直连，不走代理 ----
    if (/^blob:/i.test(s) || /^file:/i.test(s)) {
      out.ok = true;
      out.kind = 'local';
      out.rawUrl = s;
      out.playUrl = s;
      out.title = title || basename(s.replace(/^blob:/i, '')) || s;
      return out;
    }

    var u = parseUrl(s);
    if (!u) {
      out.reason = 'invalid-url';
      return out;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      out.reason = 'unsupported-scheme:' + u.protocol;
      return out;
    }

    out.rawUrl = u.href;
    out.needsProxy = !sameOrigin(u);
    out.playUrl = out.needsProxy ? toProxyUrl(u.href) : u.href;
    out.title = title || basename(u.pathname) || u.hostname;
    // 在线剧集用显式 id 锚定进度（站点:vod:集数），避免签名 URL 变动导致进度键漂移；
    // 缺省回落 url: 原始地址。
    out.id = explicitId || ('url:' + u.href);

    // ---- 4) HLS 识别 ----
    if (HLS_EXT.test(u.pathname) || HLS_EXT.test(u.href)) {
      out.ok = true;
      out.kind = 'hls';
      out.requiresHlsLib = !nativeHlsSupported();
      if (out.requiresHlsLib) {
        // 仍返回 ok:true —— 是否降级由调用方决定，避免适配层擅自否决用户输入
        out.reason = 'hls-needs-lib';
      }
      return out;
    }

    // ---- 4.5) FLV 识别 ----
    if (FLV_EXT.test(u.pathname) || FLV_EXT.test(u.href)) {
      out.ok = true;
      out.kind = 'flv';
      out.reason = null;
      return out;
    }

    // ---- 5) 普通直链 ----
    out.ok = true;
    out.kind = 'direct';
    if (!KNOWN_VIDEO_EXT.test(u.pathname)) {
      // 不阻断：很多直链无扩展名（网盘/签名 URL），交给浏览器按 Content-Type 判定
      out.reason = 'unknown-extension';
    }
    return out;
  }

  /**
   * 分析并截断 URL 用于日志/展示（隐藏敏感参数但保留结构信息）。
   * @param {string} url
   * @returns {string} 可安全打印的 URL 摘要
   */
  function urlSummary(url) {
    if (!url || typeof url !== 'string') return '(empty)';
    try {
      var u = parseUrl(url);
      if (!u) return url.substring(0, 120);
      var summary = u.protocol + '//' + u.hostname;
      if (u.port) summary += ':' + u.port;
      var path = u.pathname;
      if (path.length > 60) path = path.substring(0, 57) + '...';
      summary += path;
      if (u.search) summary += '?...';
      return summary;
    } catch (e) {
      return url.substring(0, 120);
    }
  }

  /**
   * URL 预清洗 — 在传入 hls.loadSource() 前修复常见问题格式。
   *
   * 修复清单（按 xlyun 等 CMS 线路实际返回的坏 URL 统计）：
   *   1. 协议相对路径  //cdn.example.com/...  →  https://cdn.example.com/...
   *   2. 缺 host 的伪绝对路径  https:///path  →  原样返回（让 hls.js 自己报错，便于诊断）
   *   3. pathname 含未编码的非 ASCII 字符（中文等）→ encodeURIComponent 逐段编码
   *   4. HTML 实体 &amp; / &#xXX;  →  解码还原（需 document，无则跳过）
   *   5. 首尾空白 / 控制字符 → 去除
   *
   * @param {string} raw - 原始 URL
   * @returns {{url: string, cleaned: boolean, reason: string|null}}
   */
  function sanitizeHlsUrl(raw) {
    if (!raw || typeof raw !== 'string') return { url: raw || '', cleaned: false, reason: 'empty' };

    var url = raw;
    var cleaned = false;
    var reasons = [];

    // 5) 去除首尾空白和控制字符
    var trimmed = url.replace(/^[\s\x00-\x1f]+|[\s\x00-\x1f]+$/g, '');
    if (trimmed !== url) { url = trimmed; cleaned = true; reasons.push('whitespace'); }

    // 4) 解码 HTML 实体（部分 CMS 会返回 &amp; 代替 &）
    if (/&amp;|&lt;|&gt;|&#x?[0-9a-fA-F]+;/i.test(url)) {
      try {
        var div = global.document ? global.document.createElement('div') : null;
        if (div) {
          div.innerHTML = url;
          var decoded = div.textContent || div.innerText || url;
          if (decoded && decoded !== url) { url = decoded; cleaned = true; reasons.push('html-entity'); }
        }
      } catch (e) { /* 解码失败则保留原值 */ }
    }

    // 1) 协议相对路径 → 补全 https:
    if (/^\/\/[^\/]/.test(url)) {
      url = 'https:' + url;
      cleaned = true;
      reasons.push('protocol-relative');
    }

    // 2/3) 结构校验 + pathname 编码
    try {
      var parsed = parseUrl(url);
      if (parsed) {
        // 2) 缺 host 检测
        if (!parsed.hostname || parsed.hostname.length === 0) {
          // 无法自动修复，返回原值让 hls.js 报明确错误
          return { url: url, cleaned: cleaned, reason: reasons.length > 0 ? reasons.join(',') : 'no-host' };
        }

        // 3) pathname 含非 ASCII → 逐段编码（保留 / 分隔符）
        if (/[^\x20-\x7E]/.test(parsed.pathname)) {
          var segments = parsed.pathname.split('/');
          var encodedSegments = [];
          for (var i = 0; i < segments.length; i++) {
            if (segments[i] && /[^\x20-\x7E]/.test(segments[i])) {
              encodedSegments.push(encodeURIComponent(segments[i]));
            } else {
              encodedSegments.push(segments[i]);
            }
          }
          var newPathname = encodedSegments.join('/');
          // 用 URL 构造器重建以保持正确格式
          url = parsed.protocol + '//' + parsed.hostname;
          if (parsed.port) url += ':' + parsed.port;
          url += newPathname;
          if (parsed.search) url += parsed.search;
          if (parsed.hash) url += parsed.hash;
          cleaned = true;
          reasons.push('non-ascii-encoded');
        }
      }
    } catch (e) {
      // parseUrl 失败说明 URL 本身有结构性问题，返回原值让调用方处理
      return { url: url, cleaned: cleaned, reason: 'parse-error:' + (e.message || '?') };
    }

    return {
      url: url,
      cleaned: cleaned,
      reason: reasons.length > 0 ? reasons.join(',') : null
    };
  }

  /**
   * 判断一个 URL 是否"看起来像"标准 m3u8/HLS 地址。
   * 用于决定 hls.js 失败后是否值得回退到原生 <video>。
   * @param {string} url
   * @returns {boolean}
   */
  function looksLikeRealM3u8(url) {
    if (!url || typeof url !== 'string') return false;
    var lower = url.toLowerCase();
    // 标准 m3u8 扩展名或明确的 m3u8 路径特征
    if (/\.m3u8(\?|#|$)/i.test(url)) return true;
    // HLS 分片 URL (.ts)
    if (/\.ts(\?|#|$)/i.test(lower) && !lower.includes('.flv')) return true;
    // 明确的 playlist 关键字
    if (/playlist/i.test(url) || /manifest/i.test(url) || /m3u8/i.test(url)) return true;
    // 包含典型 CDN m3u8 路径模式
    if (/(\/video\/|\/stream\/|\/live\/|\/hls\/)/i.test(url)) return true;
    return false;
  }

  /**
   * 从 URL 提取域名用于展示（不含敏感路径和参数）。
   */
  function _extractDomain(url) {
    try {
      var u = parseUrl(url);
      return u ? u.hostname : '(invalid)';
    } catch (e) {
      return '(unknown)';
    }
  }

  function isHlsUrl(url) {
    if (typeof url !== 'string') return false;
    return HLS_EXT.test(url);
  }

  function isFlvUrl(url) {
    if (typeof url !== 'string') return false;
    return FLV_EXT.test(url);
  }

  SFV.sourceAdapterCore = {
    PROXY_PATH: PROXY_PATH,
    HLS_EXT: HLS_EXT,
    FLV_EXT: FLV_EXT,
    KNOWN_VIDEO_EXT: KNOWN_VIDEO_EXT,
    isFileLike: isFileLike,
    parseUrl: parseUrl,
    sameOrigin: sameOrigin,
    toProxyUrl: toProxyUrl,
    basename: basename,
    nativeHlsSupported: nativeHlsSupported,
    resolve: resolve,
    urlSummary: urlSummary,
    sanitizeHlsUrl: sanitizeHlsUrl,
    looksLikeRealM3u8: looksLikeRealM3u8,
    _extractDomain: _extractDomain,
    isHlsUrl: isHlsUrl,
    isFlvUrl: isFlvUrl,
  };
})(typeof window !== 'undefined' ? window : this);
