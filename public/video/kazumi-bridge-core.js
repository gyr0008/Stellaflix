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
    // 策略 4: iframe src（常见于聚合播放器）
    { name: 'iframe-src', test: function (html) {
      var m = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
      return m ? m[1] : null;
    }},
    // 策略 5: JS 变量中的 URL（var url/var player/video_url 等）
    { name: 'js-variable', test: function (html) {
      var patterns = [
        /(?:var|let|const)\s+(?:url|videoUrl|playUrl|source|player.*?url)\s*=\s*["']([^"']+)["']/i,
        /["'](https?:\/\/[^"']*\.(?:m3u8|mp4|flv)[^"']*?)["']/i,
        /\burl\s*[:=]\s*["']([^"']+)["']/i
      ];
      for (var i = 0; i < patterns.length; i++) {
        var m = html.match(patterns[i]);
        if (m) return m[1];
      }
      return null;
    }}
  ];

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
    PLAY_URL_PATTERNS: PLAY_URL_PATTERNS,
    PARSER_URL_PATTERNS: PARSER_URL_PATTERNS,
    isParserUrl: isParserUrl
  };
})(typeof window !== 'undefined' ? window : this);
