/**
 * Stellaflix — Kazumi 桥接层·纯算法内核（kazumi-bridge-core.js）
 *
 * 从 kazumi-bridge.js 抽出的**零依赖纯函数**集合。本文件刻意不触碰
 * localStorage / Kazumi 引擎 / fetch / DOM —— 仅做算法与字符串/URL 变换，
 * 因此可在 Node / vm 沙箱中独立测试，也为 kazumi-bridge.js 的 IO 层提供可复用基元。
 *
 * 暴露：SFV.kazumiCore（含幂等守卫，重复加载安全跳过）。
 * 加载顺序：必须在 kazumi-bridge.js 之前（index.html）。
 *
 * @license GPL-3.0（与 Kazumi 上游一致）
 */
(function (global) {
  'use strict';
  if (!global.StellaflixVideo) global.StellaflixVideo = {};
  var SFV = global.StellaflixVideo;
  if (SFV.kazumiCore) return; // 幂等守卫：重复加载安全跳过

  // ---- 工具：确定性哈希（规则名/源去重用）----
  function hash(s) {
    var h = 5381, i = 0;
    s = String(s || '');
    for (; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return ('k' + (h >>> 0).toString(36));
  }

  // ---- 极简 JSONPath（对齐 kazumi/rule-engine.js 子集：$/key/arr[*]/arr[0]/['key']）----
  // 仅用于在桥接层重新解析 API 原始响应（引擎 _parseApiSearch 会丢弃海报/ID 字段）。
  function cmsJsonPathRead(doc, expr) {
    expr = expr || '';
    if (!expr.startsWith('$')) return [];
    try {
      var r = cmsEvalJsonPath(doc, expr);
      return Array.isArray(r) ? r : (r != null ? [r] : []);
    } catch (e) { return []; }
  }
  function cmsJsonPathFirst(doc, expr) {
    var v = cmsJsonPathRead(doc, expr);
    return v.length ? v[0] : undefined;
  }
  function cmsEvalJsonPath(root, expr) {
    var parts = cmsTokenizeJsonPath(expr);
    var cur = root;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (cur == null) return [];
      if (p.type === 'dot') cur = cur[p.key];
      else if (p.type === 'index') {
        if (p.key === '*') cur = Array.isArray(cur) ? cur.slice() : [];
        else { var idx = parseInt(p.key, 10); cur = Array.isArray(cur) ? cur[idx] : undefined; }
      }
    }
    return cur;
  }
  function cmsTokenizeJsonPath(expr) {
    var parts = [], i = 1;
    while (i < expr.length) {
      var c = expr[i];
      if (c === '.') {
        i++;
        var s = i;
        while (i < expr.length && /[A-Za-z0-9_$]/.test(expr[i])) i++;
        parts.push({ type: 'dot', key: expr.slice(s, i) });
      } else if (c === '[') {
        var e = expr.indexOf(']', i);
        if (e < 0) break;
        var inner = expr.slice(i + 1, e).trim();
        if ((inner[0] === '"' || inner[0] === "'") && inner[inner.length - 1] === inner[0]) {
          parts.push({ type: 'index', key: inner.slice(1, -1) });
        } else {
          parts.push({ type: 'index', key: inner });
        }
        i = e + 1;
      } else { break; }
    }
    return parts;
  }

  /**
   * CMS10 / API 模式搜索结果富化。
   * 引擎 _parseApiSearch 仅返回 {name, src}（详情页链接/ID），海报(vod_pic)与真实 ID(vod_id)
   * 在传输中被丢弃。本函数复用原始 JSON 响应，按规则的 listPath/namePath/sourcePath 重新遍历，
   * 并补取 CMS10 已知字段（schema 未保留 picPath/idPath，故在此硬编码 vod_pic/vod_id，
   * 同时兜底通用 pic/id）。
   */
  function parseApiSearchRaw(raw, config) {
    config = config || {};
    var doc;
    try { doc = JSON.parse(raw); } catch (e) { return []; }
    var listPath = config.listPath || '$.list[*]';
    var namePath = config.namePath || '$.vod_name';
    var srcPath = config.sourcePath || '$.vod_id';
    var nodes = cmsJsonPathRead(doc, listPath);
    var items = [];
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var name = String(cmsJsonPathFirst(node, namePath) || '').trim();
      var src = String(cmsJsonPathFirst(node, srcPath) || '').trim();
      if (!name || !src) continue;
      var pic = String(cmsJsonPathFirst(node, '$.vod_pic') || cmsJsonPathFirst(node, '$.pic') || '').trim();
      var vodId = String(cmsJsonPathFirst(node, '$.vod_id') || cmsJsonPathFirst(node, '$.id') || '').trim();
      items.push({ name: name, src: src, pic: pic, vodId: vodId });
    }
    return items;
  }

  /** 极简模板渲染：替换 @keyword / @source 等占位符（缺失变量保留原样，不抛错） */
  function cmsRenderTpl(tpl, vars) {
    if (!tpl) return '';
    return String(tpl).replace(/(?<![A-Za-z0-9_])@([A-Za-z_][A-Za-z0-9]*)/g, function (m, name) {
      return (name in vars) ? String(vars[name] ?? '') : m;
    });
  }

  /** URL 归一化（对齐 KazumiUrlUtils.normalizeEpisodeUrl）：绝对原样，相对按 baseUrl 拼接 */
  function normalizeUrlLocal(baseUrl, url) {
    if (!url) return '';
    if (/^https?:\/\//i.test(url)) return url;
    if (!baseUrl) return url;
    try { return new URL(url, baseUrl).href; } catch (e) { return url; }
  }

  /** CMS10 分隔符章节解析（对齐 rule-engine._parseDelimitedChapters） */
  function parseDelimitedChaptersLocal(doc, cfg, baseUrl) {
    var namesValue = String(cmsJsonPathFirst(doc, cfg.roadNamesPath || '') || '');
    var epsValue = String(cmsJsonPathFirst(doc, cfg.roadEpisodesPath || '') || '');
    var roadSep = cfg.roadSeparator || '$$$';
    var epSep = cfg.episodeSeparator || '#';
    var fieldSep = cfg.fieldSeparator || '$';
    if (!epsValue) return [];
    // 注意：vod_play_from 的线路名以 fieldSeparator($) 分隔；仅 URL 分组用 roadSeparator($$$)
    var roadNames = namesValue.split(fieldSep);
    var roadGroups = epsValue.split(roadSep);
    var roads = [];
    for (var ri = 0; ri < roadGroups.length; ri++) {
      var entries = roadGroups[ri].split(epSep);
      var urls = [], names = [];
      for (var ei = 0; ei < entries.length; ei++) {
        var entry = entries[ei].trim();
        if (!entry) continue;
        var idx = entry.indexOf(fieldSep);
        var name, u;
        if (idx >= 0) {
          name = entry.substring(0, idx).trim();
          u = entry.substring(idx + fieldSep.length).trim();
        } else if (/^https?:\/\//i.test(entry)) {
          // 容错：缺 name$ 前缀时整段即 URL（部分 CMS 源仅给直链）
          name = '';
          u = entry;
        } else {
          continue;
        }
        urls.push(normalizeUrlLocal(baseUrl, u));
        names.push(name || ('第' + (ei + 1) + '集'));
      }
      if (urls.length > 0) {
        roads.push({
          name: (ri < roadNames.length ? roadNames[ri] : '').trim() || ('播放线路' + (roads.length + 1)),
          data: urls,
          identifier: names
        });
      }
    }
    return roads;
  }

  // ---- 播放页嗅探正则（从剧集入口 HTML 页面提取真实视频流地址）----
  /** 嗅探策略：按优先级依次尝试，第一个命中的即为结果 */
  var PLAY_URL_PATTERNS = [
    // 策略 1: <video src="..."> 或 <source src="...">
    { name: 'video-src', test: function (html) {
      var m = html.match(/<video[^>]+src=["']([^"']+)["']/i);
      if (m) return m[1];
      m = html.match(/<source[^>]+src=["']([^"']+)["']/i);
      return m ? m[1] : null;
    }},
    // 策略 2: .m3u8 URL（最常见）
    { name: 'm3u8-url', test: function (html) {
      var m = html.match(/https?:\/\/[^\s"']+\.(m3u8)(\?[^"'\s]*)?/i);
      return m ? m[0] : null;
    }},
    // 策略 3: .mp4/.flv 直接视频 URL
    { name: 'direct-video', test: function (html) {
      var m = html.match(/https?:\/\/[^\s"']+\.(mp4|flv|webm|mkv)(\?[^"'\s]*)?/i);
      return m ? m[0] : null;
    }},
    // 策略 4: 苹果 CMS（maccms）系**明文**播放数据块。
    // 与策略 5（maccms-play-b64）同源，区别只在于这系的 url 字段是明文而非 base64，
    // 且页面常把 JSON 里的斜杠转义成 \/ -> "url":"https:\/\/host\/a\/index.m3u8"。
    // 于是只认字面 https:// 的策略 2（m3u8-url）会落空，播放页最终被后面的
    // iframe-src 命中、返回播放器壳（/static/player/...）而不是真实流 —— 实测缺陷。
    // 形态：{"url":"https://...m3u8","url_next":"...","from":"线路","server":"no",...}
    // 必须排在 iframe-src 之前（也是这类"真实流藏在数据块里"的通用位置）。
    { name: 'maccms-play-plain', test: function (html) {
      var m = html.match(/"url"\s*:\s*"((?:https?:)?\\?\/\\?\/[^"]+?)"/i);
      if (!m) return null;
      var u = String(m[1]).replace(/\\\//g, '/');
      // 还原 JS/JSON 的 \uXXXX 转义。实测（2026-10-01 端到端 12 部抽样）：
      // 该系某集 url 存的是 "https://v.fengbao8.com/video/taifengshangshe/\u7b2c08\u96c6/index.m3u8"，
      // 转义不还原时请求返回 nginx 404；还原成「第08集」后同一个地址 200 + 47KB m3u8。
      // 只动 \uXXXX 形转义，普通 URL 里不会出现字面 \u，不会误伤。
      u = u.replace(/\\u([0-9a-fA-F]{4})/g, function (_s, hex) {
        try { return String.fromCharCode(parseInt(hex, 16)); } catch (e) { return _s; }
      });
      // 只认绝对 http(s)：页面里 maccms 配置形如 {"url":"www.example.net"} 会被上面的
      // 正则前缀 (?:https?:)? 放过，这里统一挡掉，避免把站点配置当播放地址。
      return /^https?:\/\//i.test(u) ? u : null;
    }},
    // 策略 5: iframe src（常见于聚合播放器）
    { name: 'iframe-src', test: function (html) {
      var m = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
      return m ? m[1] : null;
    }},
    // 策略 6: 苹果 CMS（maccms）系播放数据块（base64 编码）—— 真实流藏在 base64 里，明文正则抓不到。
    // 形态：{"url":"<base64>","from":"<线路>","server":"","note":"","id":"","sid":1,"nid":1}
    // 编码可能是 base64(url) 或 base64(urlencode(url))，故两种都试；
    // 多集/多清晰度时原始串用不可打印字节分隔，需按可打印 ASCII 切分后取首个 http(s)。
    // 必须排在 js-variable 之前：后者正则过宽，会把页面里的提示文案当 URL 命中。
    { name: 'maccms-play-b64', test: function (html) {
      var m = html.match(/"url"\s*:\s*"([A-Za-z0-9+\/=_\-]{20,})"/);
      if (!m) return null;
      return decodeMaccmsPlayUrl(m[1]);
    }},
    // 策略 7: JS 变量中的 URL（var url/var player/video_url 等）
    { name: 'js-variable', test: function (html) {
      // 修正两处过宽，都必须只收「看起来像 URL」的取值：
      //  (1) player.*?url 里的 .*? 会越过 {"flag":"play",...,"link":"..."} 跨段匹配，
      //      实测 netflixgc.org 的播放页因此命中报错按钮的
      //      data-url="编号【xxx】名称【xxx】不能观看请检查修复，页面地址"，
      //      把提示文案当播放地址返回——比不解析更糟。变量别名收紧为合法标识符。
      //  (2) 末条 /*([^"']+)/* 同样会吃掉任意“url=”属性（如 data-url="编号...报错文案"）。
      var patterns = [
        /(?:var|let|const)\s+(?:url|videoUrl|playUrl|source|play[a-zA-Z0-9_]*|player[a-zA-Z0-9_]*)\s*=\s*["']([^"']+)["']/i,
        /["'](https?:\/\/[^"']*\.(?:m3u8|mp4|flv)[^"']*?)["']/i,
        /\burl\s*[:=]\s*["']((?:https?:)?\/\/[^"'\s]+|https?:\/\/[^"'\s]+)["']/i
      ];
      for (var i = 0; i < patterns.length; i++) {
        var m = html.match(patterns[i]);
        if (m) return m[1];
      }
      return null;
    }}
  ];

  /** 纯 JS 版 base64 解码兜底（环境无 atob 时，如部分 Node 测试沙箱） */
  function manualAtob(b64) {
    var T = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var buf = [], out = 0, phase = 0, acc = 0;
    for (var i = 0; i < b64.length; i++) {
      var c = b64.charAt(i);
      var v = T.indexOf(c);
      if (v === -1) {
        if (c === '-') v = 62; else if (c === '_') v = 63; else if (c === '=') break;
        else return null;                       // 不是合法 base64
      }
      acc = (acc << 6) | v;
      if (++phase === 4) { buf[out++] = (acc >> 16) & 0xff; buf[out++] = (acc >> 8) & 0xff; buf[out++] = acc & 0xff; phase = 0; acc = 0; }
    }
    if (phase === 2) buf[out++] = (acc >> 8) & 0xff;
    else if (phase === 3) { buf[out++] = (acc >> 16) & 0xff; buf[out++] = (acc >> 8) & 0xff; }
    return String.fromCharCode.apply(null, buf.slice(0, out));
  }

  function toBase64Bytes(b64) {
    if (typeof atob === 'function') {
      try { return atob(b64); } catch (e) { /* 落到手写实现 */ }
    }
    return manualAtob(b64);
  }

  /**
   * 解出苹果 CMS 播放数据块里的真实流地址。
   * 兼容两种编码：base64(明文 url)、base64(urlencode(url))。
   * @param {string} b64 base64 密文
   * @returns {string|null} 首个 http(s) 流地址
   */
  function decodeMaccmsPlayUrl(b64) {
    if (!b64 || !/^[A-Za-z0-9+\/=_\-]+$/.test(b64)) return null;
    var raw = toBase64Bytes(b64);
    if (!raw) return null;
    var candidates = [raw];
    try { candidates.push(decodeURIComponent(raw)); } catch (e) { /* 非 %xx 编码，忽略 */ }
    for (var i = 0; i < candidates.length; i++) {
      // 原始串里多集之间用不可打印字节分隔，只保留可打印 ASCII
      var parts = String(candidates[i]).split(/[^\x20-\x7e]+/);
      for (var j = 0; j < parts.length; j++) {
        if (/^https?:\/\//i.test(parts[j])) return parts[j];
      }
    }
    return null;
  }

  /**
   * 第三方视频解析器 URL 识别。
   * 关键事实（已对 agedm.io 实测验证）：agedm.io 的播放页内的 iframe 指向云播放器，
   * 页面本身不暴露真实 m3u8/mp4——真实流由页面内 JS/wasm 解密后自渲染。故只能把解析器
   * 页面嵌入 iframe，交由它自己的播放器解密播放（同上一级对解析器 URL 的处理）。
   */
  var PARSER_URL_PATTERNS = [
    /[?&]url=age_/i,                  // agedm 等编码参数（age_ + Base64 密文）
    /\/vip\/\?url=/i,                 // 通用 /vip/?url= 解析入口
    /\bjx\.[a-z0-9-]+\.[a-z]{2,}/i,   // jx.xxx.com 类解析域名（解析 = jiexi）
    /\/jx\//i,                         // /jx/ 路径解析器
    /player\.php\?url=/i,             // 通用 player.php?url=
    /m3u8\.php\?url=/i,
    /api\.php\?url=/i
  ];
  function isParserUrl(u) {
    if (!u) return false;
    for (var i = 0; i < PARSER_URL_PATTERNS.length; i++) {
      if (PARSER_URL_PATTERNS[i].test(u)) return true;
    }
    return false;
  }

  SFV.kazumiCore = {
    hash: hash,
    cmsJsonPathRead: cmsJsonPathRead,
    cmsJsonPathFirst: cmsJsonPathFirst,
    cmsEvalJsonPath: cmsEvalJsonPath,
    cmsTokenizeJsonPath: cmsTokenizeJsonPath,
    parseApiSearchRaw: parseApiSearchRaw,
    cmsRenderTpl: cmsRenderTpl,
    normalizeUrlLocal: normalizeUrlLocal,
    parseDelimitedChaptersLocal: parseDelimitedChaptersLocal,
    decodeMaccmsPlayUrl: decodeMaccmsPlayUrl,
    PLAY_URL_PATTERNS: PLAY_URL_PATTERNS,
    PARSER_URL_PATTERNS: PARSER_URL_PATTERNS,
    isParserUrl: isParserUrl
  };
})(typeof window !== 'undefined' ? window : this);
