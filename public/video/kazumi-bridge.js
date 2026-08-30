/**
 * Stellaflix — Kazumi 引擎桥接层（Phase 2 接入层）
 *
 * 职责：把已移植的 Kazumi 规则引擎（public/video/kazumi/，严格对齐 Predidit/Kazumi）
 * 接入 Stellaflix 影视态产品。本文件是「胶水层」，刻意放在 kazumi/ 目录之外，
 * **不修改 kazumi/ 内部任何一行**（用户要求：Kazumi 技术成熟，禁止删减/乱改）。
 *
 * 它负责：
 *   1. 懒加载并缓存 Kazumi.createRuleManager()（规则存 localStorage: kazumi-rules）
 *   2. 规则管理：列表 / 导入 / 移除 / 启用禁用
 *      —— 启用状态用独立的 enabledMap 持久化（key: stellaflix-video-kazumi-enabled），
 *         不污染 Kazumi 的 Plugin 序列化结构（schema 的 toJson 不认识 enabled 字段，
 *         直接塞进 rule 对象会在序列化时丢失，故单独存）。
 *   3. 搜索归一化：Kazumi 返回的 {name, src} 转成 Stellaflix 网格 item 形状
 *   4. 章节归一化：Kazumi 的 roads[{name,data:[urls],identifier:[names]}]
 *      转成 Stellaflix 详情页的 plays[{from, episodes:[{name,url,index}]}]
 *   5. 播放页解析：从剧集入口页面（chapterResult 提取的 href）提取真实视频流地址
 *      （m3u8/mp4），对齐 Kazumi 原版的「播放页解析」层。
 *
 * 合规红线：本文件不预置/不内置任何规则。规则 100% 由用户在「规则」面板手动导入。
 *
 * @license GPL-3.0（与 Kazumi 上游一致；本胶水层同样 GPL-3.0）
 */
(function (global) {
  'use strict';
  if (!global.StellaflixVideo) global.StellaflixVideo = {};
  var SFV = global.StellaflixVideo;

  var ENABLED_KEY = 'stellaflix-video-kazumi-enabled';
  var NS = 'kazumi-bridge';
  var _manager = null;

  // ---- 纯算法层（hash / JSONPath / 嗅探正则 / 归一化 / 分隔符解析）已迁入 kazumi-bridge-core.js ----
  // kazumi-bridge-core.js 在 index.html 中先于本文件加载；此处仅做别名绑定，函数体零改动。
  var KC = SFV.kazumiCore;
  var hash = KC.hash,
      cmsJsonPathRead = KC.cmsJsonPathRead,
      cmsJsonPathFirst = KC.cmsJsonPathFirst,
      parseApiSearchRaw = KC.parseApiSearchRaw,
      cmsRenderTpl = KC.cmsRenderTpl,
      normalizeUrlLocal = KC.normalizeUrlLocal,
      parseDelimitedChaptersLocal = KC.parseDelimitedChaptersLocal,
      PLAY_URL_PATTERNS = KC.PLAY_URL_PATTERNS,
      PARSER_URL_PATTERNS = KC.PARSER_URL_PATTERNS,
      isParserUrl = KC.isParserUrl;

  // ---- 工具 ----
  function readJSON(key, fallback) {
    try { var raw = global.localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
    catch (e) { return fallback; }
  }
  function writeJSON(key, val) {
    try { global.localStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { return false; }
  }

  // ---- CMS10 / API 模式直接解析（桥接层实现，绕过 engine 的 api 请求配置层级 bug，严格对齐 Kazumi 苹果CMS v10，零改动 kazumi/ 内部）----

  /** 经 KazumiHttpClient（/api/proxy）发起 API 请求，返回原始文本 */
  async function fetchApi(url, req) {
    req = req || {};
    var mgr = getManager();
    var httpClient = mgr.httpClient || global.KazumiHttpClient;
    var opts = { useProxy: true };
    if (req.headers) opts.headers = req.headers;
    if (req.method && req.method.toUpperCase() === 'POST') {
      if (httpClient && typeof httpClient.post === 'function') return httpClient.post(url, req.body || null, opts);
      var r = await fetch('/api/proxy?url=' + encodeURIComponent(url));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }
    if (httpClient && typeof httpClient.get === 'function') return httpClient.get(url, opts);
    var resp = await fetch('/api/proxy?url=' + encodeURIComponent(url));
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return resp.text();
  }

  /** CMS10 搜索：构造 videolist 请求 → 解析 list（含海报/ID） */
  async function resolveCms10Search(rule, kw) {
    var cfg = rule.searchApiConfig || {};
    var req = cfg.request || {};
    var url = cmsRenderTpl(req.url || '', { keyword: encodeURIComponent(kw || '') });
    if (!url) return { items: [], raw: '' };
    var raw = await fetchApi(url, req);
    var items = parseApiSearchRaw(raw, cfg);
    return { items: items, raw: raw };
  }

  /** CMS10 章节：构造 detail 请求(ids=@source) → 分隔符解析为 roads */
  async function resolveCms10Chapters(rule, src) {
    var cfg = rule.chapterApiConfig || {};
    var req = cfg.request || {};
    var url = cmsRenderTpl(req.url || '', { source: encodeURIComponent(src || '') });
    if (!url) throw new Error('CMS10 章节请求 URL 缺失');
    var raw = await fetchApi(url, req);
    var doc;
    try { doc = JSON.parse(raw); } catch (e) { throw new Error('CMS10 章节响应非有效 JSON: ' + e.message); }
    var roads = parseDelimitedChaptersLocal(doc, cfg, rule.baseUrl);
    if (!roads.length) throw new Error('CMS10 章节解析为空');
    return { roads: roads };
  }

  // ---- 启用状态（独立持久化，不碰 Kazumi 序列化）----
  function readEnabled() { return readJSON(ENABLED_KEY, {}) || {}; }
  function writeEnabled(map) { writeJSON(ENABLED_KEY, map); }
  function isEnabled(ruleName) {
    var map = readEnabled();
    // 默认启用；仅当显式置 false 才禁用
    return map[ruleName] !== false;
  }
  function setEnabled(ruleName, on) {
    var map = readEnabled();
    if (on) delete map[ruleName]; else map[ruleName] = false;
    writeEnabled(map);
  }

  // ---- 管理器（懒加载）----
  function getManager() {
    if (_manager) return _manager;
    if (!global.Kazumi || !global.Kazumi.createRuleManager) {
      throw new Error('[KazumiBridge] Kazumi 引擎未加载（请确认 index.html 已引入 video/kazumi/*.js）');
    }
    _manager = global.Kazumi.createRuleManager();
    // B1：覆写为 cookie-aware 包装器（glue 层，不改 kazumi/ 内部），使验证码重查带上分区 cookie。
    if (SFV.kazumiBridgeCaptcha && global.KazumiHttpClient) {
      _manager.httpClient = SFV.kazumiBridgeCaptcha.makeCookieAwareHttpClient(
        global.KazumiHttpClient, SFV.kazumiBridgeCaptcha._store);
    }
    _manager.load();
    return _manager;
  }

  // ---- 规则管理 API ----
  function listRules() {
    var mgr = getManager();
    return mgr.list().map(function (r) {
      return {
        name: r.name,
        type: r.type,
        baseUrl: r.baseUrl,
        searchMode: r.searchMode,
        chapterMode: r.chapterMode,
        enabled: isEnabled(r.name),
        valid: !!global.KazumiRuleSchema && global.KazumiRuleSchema.validate(r).valid
      };
    });
  }

  function hasRules() {
    try { return getManager().list().length > 0; } catch (e) { return false; }
  }

  function importRule(input) {
    var mgr = getManager();
    var added = mgr.importRules(input); // 支持单条对象/字符串、数组
    return added;
  }

  function removeRule(name) {
    var mgr = getManager();
    mgr.remove(name);
    // 同步清理启用状态
    var map = readEnabled();
    if (name in map) { delete map[name]; writeEnabled(map); }
  }

  // 返回当前参与搜索的规则（有效 + 已启用）：同时包含 XPath 与 API(CMS10) 模式
  function getEnabledSearchRules() {
    var mgr = getManager();
    var xpathRules = mgr.getEnabledXpathRules().filter(function (r) { return isEnabled(r.name); });
    // API(CMS10) 模式：searchMode==='api' 且搜索配置可用，作为可选聚合源
    var apiRules = mgr.list().filter(function (r) {
      if (r.searchMode !== 'api') return false;
      if (!isEnabled(r.name)) return false;
      var cfg = r.searchApiConfig || {};
      return !!(cfg.request && cfg.request.url) &&
        !!global.KazumiRuleSchema && global.KazumiRuleSchema.validate(r).valid;
    });
    return xpathRules.concat(apiRules);
  }

  // 返回规则解析模式：'api'(CMS10 直出媒体) | 'xpath'(解析器页 → iframe 内嵌) | null(未找到/引擎未加载)。
  // 供候选级 isEmbed 分类使用（detail.js buildCandidates / classifyCandidateEmbed）。
  function getRuleMode(ruleName) {
    try {
      var rule = getManager().get(ruleName);
      if (!rule) return null;
      return rule.chapterMode || rule.searchMode || 'xpath';
    } catch (e) { return null; }
  }

  // 单规则搜索 + 归一化为 Stellaflix item 形状（供 search / searchRule 复用）。
  // 返回 { ruleName, items, error?, code?, captcha?, antiConfig?, searchURL? }。
  async function searchOneRule(rule, kw) {
    var mgr = getManager();
    var grp;
    try {
      if (rule.searchMode === 'api') {
        // CMS10：桥接层直接解析（绕过 engine 的 api 请求配置层级 bug）
        var rc = await resolveCms10Search(rule, kw);
        grp = { ruleName: rule.name, items: rc.items, raw: rc.raw, config: rule.searchApiConfig, mode: 'api' };
      } else {
        var trace = await mgr.search(rule, kw);
        grp = { ruleName: rule.name, items: trace.items || [], raw: trace.rawResponse,
                 config: rule.searchApiConfig, mode: rule.searchMode };
      }
    } catch (e) {
      // B1 保真传播验证码信号（对齐 Kazumi _handleSearchError 的 CaptchaRequiredException 分支）。
      var ename = (e && e.name) || '';
      var isCaptcha = (ename === 'CaptchaRequiredException');
      return {
        ruleName: rule.name, items: [], error: (e && e.message) || 'search-failed',
        code: ename || undefined,
        captcha: isCaptcha || undefined,
        antiConfig: isCaptcha ? ((rule && rule.antiCrawlerConfig) || null) : undefined,
        searchURL: isCaptcha ? ((rule && rule.searchURL) || null) : undefined
      };
    }
    var srcItems = grp.items || [];
    if (grp.mode === 'api') srcItems = parseApiSearchRaw(grp.raw, grp.config);
    var out = [];
    srcItems.forEach(function (it) {
      var name = it.name || '';
      var src = it.src || '';
      if (!name || !src) return;
      var key = 'kazumi:' + grp.ruleName + ':' + hash(grp.ruleName + '|' + name + '|' + src);
      var pic = it.pic || '';
      var vodId = it.vodId || src;
      out.push({
        isKazumi: true,
        key: key,
        title: name,
        pic: pic,          // CMS10: vod_pic 海报；XPath 模式留空走占位图
        vodId: vodId,      // CMS10: vod_id（API 模式下即详情/章节查询键）
        year: '',
        sourceName: grp.ruleName,
        ruleName: grp.ruleName,
        src: src,           // API 模式=详情/ID；XPath 模式=详情页链接（章节解析用）
        variants: [{
          key: key,
          sourceId: 'kazumi:' + grp.ruleName,
          vodId: vodId,
          isKazumi: true,
          ruleName: grp.ruleName,
          src: src
        }]
      });
    });
    return { ruleName: grp.ruleName, items: out };
  }

  /**
   * 单规则搜索（按 ruleName）——供多源面板逐源（逐 Tab）流式填充，对齐 Kazumi 逐源并发。
   * @returns {Promise<{items:Array, errors:Array}>}
   */
  async function searchRule(ruleName, keyword, opts) {
    opts = opts || {};
    var kw = String(keyword == null ? '' : keyword).trim();
    if (opts.filters && SFV.SearchFilterCore) {
      var dsl = SFV.SearchFilterCore.SearchParser.fromFilterState(opts.filters);
      if (dsl) kw = (kw ? (kw + ' ') : '') + dsl;
    }
    if (!kw) return { items: [], errors: [] };
    if (!SFV.kazumiCore) return { items: [], errors: [{ ruleName: ruleName, reason: 'bridge-core-missing' }] };
    var mgr = getManager();
    var rule = mgr.get(ruleName);
    if (!rule) return { items: [], errors: [{ ruleName: ruleName, reason: 'rule-not-found' }] };
    var res = await searchOneRule(rule, kw);
    if (res.error) return {
      items: [],
      errors: [{ ruleName: ruleName, reason: res.error, code: res.code, captcha: res.captcha }],
      captcha: res.captcha, antiConfig: res.antiConfig, searchURL: res.searchURL
    };
    return { items: res.items || [], errors: [] };
  }

  async function search(keyword, opts) {
    opts = opts || {};
    var kw = String(keyword == null ? '' : keyword).trim();
    // 透传 Kazumi 查询 DSL（tag/season/score/rank/weekday）：
    // 规则引擎支持的生效，不支持则整串作为关键词搜索（best-effort，符合分层生效方案）。
    if (opts.filters && SFV.SearchFilterCore) {
      var dsl = SFV.SearchFilterCore.SearchParser.fromFilterState(opts.filters);
      if (dsl) kw = (kw ? (kw + ' ') : '') + dsl;
    }
    if (!kw) return { items: [], errors: [] };
    var rules = getEnabledSearchRules();
    if (!rules.length) return { items: [], errors: [] };

    var settled = await Promise.allSettled(rules.map(function (rule) {
      return searchOneRule(rule, kw);
    }));

    var items = [];
    var errors = [];
    settled.forEach(function (r) {
      if (r.status === 'rejected') {
        // 单规则失败不影响整体（与 CMS 源失败降级一致）
        errors.push({ ruleName: (r.reason && r.reason.pluginName) || 'unknown', reason: (r.reason && r.reason.message) || 'search-failed' });
        return;
      }
      var grp = r.value;
      if (grp.error) {
        errors.push({ ruleName: grp.ruleName, reason: grp.error, code: grp.code, captcha: grp.captcha });
        return;
      }
      (grp.items || []).forEach(function (it) { items.push(it); });
    });
    return { items: items, errors: errors };
  }

  /**
   * 取某规则的章节列表，归一化为 Stellaflix 详情页 plays 形状。
   * @returns {Promise<{plays:Array<{from:string, episodes:Array<{name,url,index}>}>}>}
   */
  async function getChapters(ruleName, src) {
    var mgr = getManager();
    var rule = mgr.get(ruleName);
    // CMS10：桥接层直接解析（绕过 engine 的 api 请求配置层级 bug）
    if (rule && rule.chapterMode === 'api') {
      var trace = await resolveCms10Chapters(rule, src); // { roads:[{name,data,identifier}] }
      var roads = trace.roads || [];
      var plays = roads.map(function (road) {
        var urls = road.data || [];
        var names = road.identifier || [];
        var episodes = urls.map(function (url, i) {
          return { name: (names[i] && names[i].trim()) || ('第' + (i + 1) + '集'), url: url, index: i };
        });
        return { from: road.name || '播放线路', episodes: episodes };
      });
      return { plays: plays };
    }
    // XPath：经引擎（正常可用）
    var trace2 = await mgr.getChapters(ruleName, src); // { roads:[{name,data:[urls],identifier:[names]}], ... }
    var roads2 = trace2.roads || [];
    var plays2 = roads2.map(function (road) {
      var urls = road.data || [];
      var names = road.identifier || [];
      var episodes = urls.map(function (url, i) {
        return {
          name: (names[i] && names[i].trim()) || ('第' + (i + 1) + '集'),
          url: url,
          index: i
        };
      });
      return { from: road.name || '播放线路', episodes: episodes };
    });
    return { plays: plays2 };
  }

  // ---- 播放页解析器（从剧集入口 HTML 提取真实视频流地址，多种策略嗅探）----

  /**
   * 从剧集入口页面提取真实视频流地址（统一入口）。
   *
   * 解析策略（按优先级）：
   *   1. 入口 URL 本身已是直链(m3u8/m3u/mp4/flv/webm) → 直接返回，跳过解析
   *      （CMS10 vod_play_url 多为直链，HTML 嗅探反而无效）。
   *   2. Stage B — Electron <webview> 真实浏览器上下文加载页面，拦截 network 层
   *      首个真实媒体资源(.m3u8/.mp4/...)。能跑站点 JS / wasm 解密，覆盖纯 HTML
   *      嗅探无法处理的站点。要求主窗口 webviewTag:true。
   *   3. 降级 — 原 HTML 嗅探（经 /api/proxy 抓页面正则嗅探），兼容解析器 iframe 嵌入。
   *
   * @returns {Promise<{url:string, method:string, embed:boolean}|null>}
   */
  async function resolvePlayUrl(episodePageUrl, ruleName) {
    ruleName = ruleName || 'unknown';
    if (!episodePageUrl) return null;

    // 策略1：入口已是直链，直接返回
    if (/\.(m3u8|m3u|mp4|flv|webm)(\?|$)/i.test(episodePageUrl)) {
      console.log('[KazumiBridge] resolvePlayUrl [' + ruleName + '] 入口即直链，直接返回');
      return { url: episodePageUrl, method: 'direct-media', embed: false };
    }

    // 策略2：Stage B webview 直链拦截（优先）
    try {
      var viaWv = await resolvePlayUrlWebview(episodePageUrl, ruleName, 15000);
      if (viaWv && viaWv.url) {
        console.log('[KazumiBridge] resolvePlayUrl [' + ruleName + '] webview 命中: ' + viaWv.url.slice(0, 120));
        return viaWv;
      }
    } catch (e) {
      console.warn('[KazumiBridge] webview 解析异常，降级 HTML 嗅探:', e.message);
    }

    // 策略3：降级 HTML 嗅探
    return resolvePlayUrlHtml(episodePageUrl, ruleName);
  }

  /**
   * Stage B — 基于主进程隔离隐藏 BrowserWindow 的真实浏览器上下文解析。
   * 加载剧集/解析器页面（站点 JS 真实执行），从主进程 session.webRequest 拦截 network
   * 层真实媒体响应并返回评分最高的直链。用于规避 Electron v24 + contextIsolation 下
   * 渲染进程 <webview>.getWebContents() 返回 null 导致无法注册 webRequest 的问题。
   * @returns {Promise<{url:string, method:string, embed:boolean}|null>}
   */
  async function resolvePlayUrlWebview(episodePageUrl, ruleName, timeoutMs) {
    console.log('[KazumiBridge] 隐藏窗口嗅探策略启动:', (episodePageUrl || '').slice(0, 120));

    // 优先使用主进程隔离隐藏窗口嗅探（Electron v24 + contextIsolation 下渲染进程
    // <webview>.getWebContents() 返回 null，无法注册 webRequest，故改为可靠的主进程路径）。
    if (typeof window !== 'undefined' && window.desktopWindow && typeof window.desktopWindow.resolveMediaSniff === 'function') {
      try {
        var sniffRes = await window.desktopWindow.resolveMediaSniff(episodePageUrl, { timeoutMs: timeoutMs || 12000 });
        if (sniffRes && sniffRes.ok && sniffRes.best && sniffRes.best.url) {
          var rawUrl = sniffRes.best.url;
          var playUrl = rawUrl;
          if (/^https?:\/\//i.test(rawUrl)) {
            try { playUrl = '/api/proxy?url=' + encodeURIComponent(rawUrl); } catch (e) {}
          }
          console.log('[KazumiBridge] 隐藏窗口嗅探命中(score=' + sniffRes.best.score + '): ' + rawUrl.slice(0, 120));
          return { url: playUrl, method: 'media-sniff', embed: false };
        }
        console.log('[KazumiBridge] 隐藏窗口嗅探未命中');
      } catch (e) {
        console.warn('[KazumiBridge] 隐藏窗口嗅探异常:', (e && e.message) || e);
      }
      return null;
    }

    console.log('[KazumiBridge] 隐藏窗口嗅探不可用（无 preload API），降级 HTML 嗅探');
    return null;
  }

  // 降级解析器：经 /api/proxy 抓剧集页 HTML 正则嗅探。
  async function resolvePlayUrlHtml(episodePageUrl, ruleName) {
    ruleName = ruleName || 'unknown';
    if (!episodePageUrl) return null;
    try {
      // 经 /api/proxy 获取剧集页面 HTML（绕开 CORS + 带 KVideo 式浏览器头）
      var mgr = getManager();
      var httpClient = mgr.httpClient || global.KazumiHttpClient;
      var rawHtml;
      if (httpClient && typeof httpClient.get === 'function') {
        rawHtml = await httpClient.get(episodePageUrl, { useProxy: true });
      } else {
        var resp = await fetch('/api/proxy?url=' + encodeURIComponent(episodePageUrl));
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        rawHtml = await resp.text();
      }

      if (!rawHtml || !rawHtml.trim()) return null;

      // 逐策略嗅探
      for (var pi = 0; pi < PLAY_URL_PATTERNS.length; pi++) {
        var strategy = PLAY_URL_PATTERNS[pi];
        var found = strategy.test(rawHtml);
        if (found) {
          // 若为 iframe 且指向第三方视频解析器，则标记为「嵌入播放」而非直链——
          // 解析器页面用 wasm/JS 客户端解密真实流，无法提取直链，只能整体嵌入。
          var embed = (strategy.name === 'iframe-src') && isParserUrl(found);
          console.log('[KazumiBridge] resolvePlayUrlHtml [' + ruleName + '] 策略' + strategy.name +
            '命中: ' + found.slice(0, 120) + (embed ? ' → 解析器iframe(嵌入播放)' : ''));
          return { url: found, method: strategy.name, embed: embed };
        }
      }

      // 兜底：扫描页面所有 iframe，识别第三方解析器（防止策略4未命中但页面仍含解析器iframe）
      var iframeMatches = rawHtml.match(/<iframe[^>]+src=["']([^"']+)["']/gi) || [];
      for (var fi = 0; fi < iframeMatches.length; fi++) {
        var im = iframeMatches[fi].match(/src=["']([^"']+)["']/i);
        if (im && im[1] && isParserUrl(im[1])) {
          console.log('[KazumiBridge] resolvePlayUrlHtml [' + ruleName + '] 兜底命中解析器iframe: ' + im[1].slice(0, 120));
          return { url: im[1], method: 'iframe-src', embed: true };
        }
      }

      console.log('[KazumiBridge] resolvePlayUrlHtml [' + ruleName + '] 所有策略均未命中（页面长度: ' + rawHtml.length + '）');
      return null;
    } catch (e) {
      console.warn('[KazumiBridge] resolvePlayUrlHtml [' + ruleName + '] 异常:', e.message);
      return null;
    }
  }

  SFV.kazumi = {
    NS: NS,
    getManager: getManager,
    listRules: listRules,
    hasRules: hasRules,
    importRule: importRule,
    removeRule: removeRule,
    setEnabled: setEnabled,
    isEnabled: isEnabled,
    getEnabledSearchRules: getEnabledSearchRules,
    getRuleMode: getRuleMode,
    search: search,
    searchRule: searchRule,
    getChapters: getChapters,
    resolvePlayUrl: resolvePlayUrl,
    resolvePlayUrlWebview: resolvePlayUrlWebview,
    resolvePlayUrlHtml: resolvePlayUrlHtml
  };

  // 兼容直接调用
  if (typeof module === 'object' && module.exports) {
    module.exports = SFV.kazumi;
  }
})(typeof window !== 'undefined' ? window : this);
