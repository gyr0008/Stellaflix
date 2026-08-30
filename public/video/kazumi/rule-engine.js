/**
 * Kazumi Rule Engine — 严格对齐 Predidit/Kazumi (GPL-3.0) 的 RuleEngine
 *
 * 这是核心调度器，完整复刻 rule_engine.dart 的执行流程：
 *
 *   search(rule, keyword)
 *     → 判断 searchMode（xpath/api）
 *     → 构造请求（XPath: URL模板替换; API: JSONPath变量渲染）
 *     → HTTP GET/POST
 *     → 解析响应（XPath: DOM+XPath; API: JSON+JSONPath）
 *     → 返回 SearchItem[]
 *
 *   queryChapters(rule, sourceUrl)
 *     → 判断 chapterMode
 *     → 构造详情页请求
 *     → HTTP GET
 *     → 解析响应
 *     → 返回 Road[{name, data[], identifier[]}]
 *
 * @see https://github.com/Predidit/Kazumi/blob/main/lib/services/plugin/rule_engine.dart
 * @license GPL-3.0
 */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(global);
  } else {
    global.KazumiRuleEngine = factory(global);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (global) {

  'use strict';

  // ---- 异常类型（对齐 rule_engine_models.dart）----
  function CaptchaRequiredException(pluginName) {
    var e = new Error(pluginName + ' requires captcha verification');
    e.name = 'CaptchaRequiredException';
    e.pluginName = pluginName;
    return e;
  }

  function NoResultException(pluginName) {
    var e = new Error(pluginName + ' returned no search results');
    e.name = 'NoResultException';
    e.pluginName = pluginName;
    return e;
  }

  function SearchErrorException(pluginName, cause) {
    var e = new Error(pluginName + ' search failed' + (cause ? (' (' + cause.message + ')') : ''));
    e.name = 'SearchErrorException';
    e.pluginName = pluginName;
    e.cause = cause;
    return e;
  }

  function ChapterErrorException(pluginName, cause) {
    var e = new Error(pluginName + ' chapter query failed' + (cause ? (' (' + cause.message + ')') : ''));
    e.name = 'ChapterErrorException';
    e.pluginName = pluginName;
    e.cause = cause;
    return e;
  }

  /**
   * 创建规则引擎实例
   *
   * @param {Object} deps - 依赖注入
   * @param {Object} deps.httpClient - HTTP 客户端（需有 get/post 方法）
   * @param {Object} deps.xpathEngine - XPath 引擎（需有 parseSearch/parseChapters 方法）
   * @param {Function} deps.normalizeUrl - URL 归一化函数
   */
  function create(deps) {
    deps = deps || {};
    var http = deps.httpClient || global.KazumiHttpClient;
    var xpath = deps.xpathEngine || global.KazumiXPathEngine;
    var normalizeUrl = deps.normalizeUrl ||
      (global.KazumiUrlUtils && global.KazumiUrlUtils.normalizeEpisodeUrl) ||
      function (b, u) { return u; };
    var renderTpl = (global.KazumiUrlUtils && global.KazumiUrlUtils.renderTemplate) ||
      function (t, v) { return t; };

    /**
     * 执行搜索 — 对齐 RuleEngine.search()
     *
     * @param {Object} rule - 规则对象
     * @param {string} keyword - 搜索关键词
     * @param {Object} [options] - 可选配置
     * @returns {Promise<{items:Array,diagnostics:string[],rawResponse:string}>}
     * @throws {CaptchaRequiredException} 需要验证码时
     * @throws {NoResultException} 无结果时
     * @throws {SearchErrorException} 其他错误
     */
    async function search(rule, keyword, options) {
      options = options || {};
      var urlObj;

      try {
        // 根据模式构造请求
        if (rule.searchMode === 'api') {
          urlObj = _prepareApiRequest(rule.searchApiConfig, { keyword: keyword });
        } else {
          // XPath 模式：URL 模板替换 @keyword
          var searchUrl = rule.searchURL.replace(/@keyword/g, encodeURIComponent(keyword));
          urlObj = { method: rule.usePost ? 'POST' : 'GET', url: searchUrl };
          if (rule.usePost) {
            // POST 模式：query 参数移到 body
            var uri;
            try { uri = new URL(searchUrl); } catch (e) {
              throw SearchErrorException(rule.name, e);
            }
            urlObj.url = uri.origin + uri.pathname;
            urlObj.body = Object.fromEntries(uri.searchParams);
          }
        }
      } catch (e) {
        throw SearchErrorException(rule.name, e);
      }

      // 发送 HTTP 请求
      var raw;
      try {
        if (urlObj.method === 'POST') {
          raw = await http.post(urlObj.url, urlObj.body || null, { rule: rule });
        } else {
          raw = await http.get(urlObj.url, { rule: rule });
        }
      } catch (e) {
        throw SearchErrorException(rule.name, e);
      }

      // 解析响应
      try {
        var parsed;
        if (rule.searchMode === 'api') {
          parsed = _parseApiSearch(raw, rule.searchApiConfig);
        } else {
          parsed = xpath.parseSearch(raw, rule, normalizeUrl);
        }

        if (!parsed.items || parsed.items.length === 0) {
          throw NoResultException(rule.name);
        }

        return {
          rawResponse: raw,
          items: parsed.items,
          diagnostics: parsed.diagnostics || []
        };
      } catch (e) {
        if (e.name === 'CaptchaRequiredException') throw e;
        if (e.name === 'NoResultException') throw e;
        throw SearchErrorException(rule.name, e);
      }
    }

    /**
     * 查询章节列表 — 对齐 RuleEngine.queryChapters()
     *
     * @param {Object} rule - 规则对象
     * @param {string} source - 搜索结果的详情页链接
     * @param {Object} [options] - 可选配置
     * @returns {Promise<{roads:Array<{name,data,identifier}>,diagnostics:string[],rawResponse:string}>}
     */
    async function queryChapters(rule, source, options) {
      options = options || {};
      var urlObj;

      try {
        if (rule.chapterMode === 'api') {
          urlObj = _prepareApiRequest(rule.chapterApiConfig, { source: source });
        } else {
          // XPath 模式：归一化详情页 URL
          var detailUrl = normalizeUrl(rule.baseUrl, source);
          urlObj = { method: 'GET', url: detailUrl };
        }
      } catch (e) {
        throw ChapterErrorException(rule.name, e);
      }

      // 发送请求
      var raw;
      try {
        raw = await http.get(urlObj.url, { rule: rule });
      } catch (e) {
        throw ChapterErrorException(rule.name, e);
      }

      // 解析响应
      try {
        var parsed;
        if (rule.chapterMode === 'api') {
          parsed = _parseApiChapters(raw, rule.chapterApiConfig, source, rule.baseUrl);
        } else {
          parsed = xpath.parseChapters(raw, rule, normalizeUrl);
        }

        if (!parsed.roads || parsed.roads.length === 0) {
          throw ChapterErrorException(rule.name);
        }

        return {
          rawResponse: raw,
          roads: parsed.roads,
          diagnostics: parsed.diagnostics || []
        };
      } catch (e) {
        if (e.name === 'ChapterErrorException') throw e;
        throw ChapterErrorException(rule.name, e);
      }
    }

    /** 构造 API 模式请求（对齐 ApiRuleStrategy.prepareRequest） */
    function _prepareApiRequest(config, variables) {
      config = config || {};
      var method = (config.method || 'GET').toUpperCase();
      var url = renderTpl(config.url || '', variables, true);

      // 验证 URL
      var uri;
      try { uri = new URL(url); } catch (e) {
        throw new Error('API \u8bf7\u6c42 URL \u65e0\u6548: ' + url);
      }

      var headers = _renderMap(config.headers || {}, variables);
      var query = _renderMap(config.query || {}, variables);

      var body = null;
      if (method === 'POST' && config.bodyType && config.bodyType !== 'none') {
        body = _renderValue(config.body, variables);
      }

      return { method: method, url: url, headers: headers, query: query, body: body };
    }

    /** 解析 API 模式搜索结果（简化版 JSONPath，支持基础 $ 路径） */
    function _parseApiSearch(raw, config) {
      config = config || {};
      var doc;
      try { doc = JSON.parse(raw); } catch (e) {
        throw new Error('API \u54cd\u5e94\u4e0d\u662f\u6709\u6548 JSON: ' + e.message);
      }

      var listPath = config.listPath || '$.data[*]';
      var namePath = config.namePath || '$.name';
      var sourcePath = config.sourcePath || '$.url';

      var nodes = _jsonPathRead(doc, listPath);
      var items = [];
      var diagnostics = [];

      for (var i = 0; i < nodes.length; i++) {
        try {
          var name = String(_jsonPathFirst(nodes[i], namePath) || '');
          var src = String(_jsonPathFirst(nodes[i], sourcePath) || '');
          if (!name || !src) {
            diagnostics.push('\u641c\u7d22\u8282\u70b9 ' + i + ' \u7f3a\u5c11\u540d\u79f0\u6217\u6765\u6e90');
            continue;
          }
          items.push({ name: name.trim(), src: src.trim() });
        } catch (e) {
          diagnostics.push('\u641c\u7d22\u8282\u70b9 ' + i + ' \u89e3\u6790\u5931\u8d25: ' + e.message);
        }
      }

      return { items: items, diagnostics: diagnostics };
    }

    /** 解析 API 模式章节结果 */
    function _parseApiChapters(raw, config, source, baseUrl) {
      config = config || {};
      var doc;
      try { doc = JSON.parse(raw); } catch (e) {
        throw new Error('API \u7ae0\u8282\u54cd\u5e94\u4e0d\u662f\u6709\u6548 JSON: ' + e.message);
      }

      var format = config.format || 'nested';
      var roads;

      if (format === 'delimited') {
        roads = _parseDelimitedChapters(doc, config, baseUrl);
      } else {
        roads = _parseNestedChapters(doc, config, baseUrl);
      }

      return { roads: roads, diagnostics: [] };
    }

    /** 嵌套格式章节解析 */
    function _parseNestedChapters(doc, config, baseUrl) {
      var roadsPath = config.roadsPath || '$.data.roads[*]';
      var roadNamePath = config.roadNamePath || '$.name';
      var episodesPath = config.episodesPath || '$.episodes[*]';
      var episodeNamePath = config.episodeNamePath || '$.name';
      var episodeUrlPath = config.episodeUrlPath || '$.url';

      var roadNodes = _jsonPathRead(doc, roadsPath);
      // 如果 roadsPath 没匹配到，用整个文档作为唯一线路
      if (!roadNodes.length) roadNodes = [doc];

      var roads = [];
      for (var ri = 0; ri < roadNodes.length; ri++) {
        var rNode = roadNodes[ri];
        var roadName = String(_jsonPathFirst(rNode, roadNamePath) || '');
        var epNodes = _jsonPathRead(rNode, episodesPath);
        var urls = [], names = [];

        for (var ei = 0; ei < epNodes.length; ei++) {
          var enode = epNodes[ei];
          var epName = String(_jsonPathFirst(enode, episodeNamePath) || '');
          var epUrl = episodeUrlPath ? String(_jsonPathFirst(enode, episodeUrlPath) || '') : '';
          if (!epUrl) continue;
          urls.push(normalizeUrl(baseUrl, epUrl));
          names.push(epName || ('\u7b2c' + (ei + 1) + '\u96c6'));
        }

        if (urls.length > 0) {
          roads.push({
            name: roadName || ('\u64ad\u653e\u8def\u7ebf' + (roads.length + 1)),
            data: urls,
            identifier: names
          });
        }
      }
      return roads;
    }

    /** 分隔符格式章节解析 */
    function _parseDelimitedChapters(doc, config, baseUrl) {
      var namesValue = String(_jsonPathFirst(doc, config.roadNamesPath || '') || '');
      var epsValue = String(_jsonPathFirst(doc, config.roadEpisodesPath || '') || '');
      var roadSep = config.roadSeparator || '$$$';
      var epSep = config.episodeSeparator || '#';
      var fieldSep = config.fieldSeparator || '$';

      if (!epsValue) return [];

      var roadNames = namesValue.split(roadSep);
      var roadGroups = epsValue.split(roadSep);
      var roads = [];

      for (var ri = 0; ri < roadGroups.length; ri++) {
        var entries = roadGroups[ri].split(epSep);
        var urls = [], names = [];

        for (var ei = 0; ei < entries.length; ei++) {
          var entry = entries[ei].trim();
          if (!entry) continue;
          var idx = entry.indexOf(fieldSep);
          if (idx < 0) continue;
          var name = entry.substring(0, idx).trim();
          var url = entry.substring(idx + fieldSep.length).trim();
          urls.push(normalizeUrl(baseUrl, url));
          names.push(name || ('\u7b2c' + (ei + 1) + '\u96c6'));
        }

        if (urls.length > 0) {
          roads.push({
            name: (ri < roadNames.length ? roadNames[ri] : '').trim() || ('\u64ad\u653e\u8def\u7ebf' + (roads.length + 1)),
            data: urls,
            identifier: names
          });
        }
      }
      return roads;
    }

    // ---- 简易 JSONPath 实现（仅支持 Kazumi 用到的子集）----

    /** 读取所有匹配节点 */
    function _jsonPathRead(doc, expr) {
      expr = expr || '';
      if (!expr.startsWith('$')) return [];
      try {
        var result = _evalJsonPath(doc, expr);
        return Array.isArray(result) ? result : (result != null ? [result] : []);
      } catch (e) {
        return [];
      }
    }

    /** 读取第一个匹配值 */
    function _jsonPathFirst(doc, expr) {
      var vals = _jsonPathRead(doc, expr);
      return vals.length > 0 ? vals[0] : undefined;
    }

    /** 简易 JSONPath 求值器（支持 $.key, $.array[*], $.array[0], $['key']） */
    function _evalJsonPath(root, expr) {
      var parts = _tokenizeJsonPath(expr);
      var current = root;
      for (var i = 0; i < parts.length; i++) {
        var part = parts[i];
        if (current == null) return [];
        if (part.type === 'dot') {
          current = current[part.key];
        } else if (part.type === 'index') {
          if (part.key === '*') {
            if (Array.isArray(current)) current = current.slice();
            else current = [];
          } else {
            var idx = parseInt(part.key, 10);
            current = Array.isArray(current) ? current[idx] : undefined;
          }
        }
      }
      return current;
    }

    /** 将 JSONPath 表达式拆分为 token 数组 */
    function _tokenizeJsonPath(expr) {
      var parts = [];
      var i = 1; // 跳过 $
      while (i < expr.length) {
        var c = expr[i];
        if (c === '.') {
          i++;
          var start = i;
          while (i < expr.length && /[A-Za-z0-9_$]/.test(expr[i])) i++;
          parts.push({ type: 'dot', key: expr.slice(start, i) });
        } else if (c === '[') {
          var end = expr.indexOf(']', i);
          if (end < 0) break;
          var inner = expr.slice(i + 1, end).trim();
          if ((inner[0] === '"' || inner[0] === "'") && inner[inner.length - 1] === inner[0]) {
            parts.push({ type: 'index', key: inner.slice(1, -1) });
          } else {
            parts.push({ type: 'index', key: inner });
          }
          i = end + 1;
        } else {
          break;
        }
      }
      return parts;
    }

    /** 渲染 Map 值中的模板变量 */
    function _renderMap(input, vars) {
      var result = {};
      for (var k in input) {
        result[_renderTemplate(k, vars)] = _renderValue(input[k], vars);
      }
      return result;
    }

    /** 渲染单个值中的模板变量 */
    function _renderValue(value, vars) {
      if (typeof value === 'string') {
        var exact = /^@([A-Za-z_][A-Za-z0-9]*)$/.exec(value);
        if (exact) {
          var n = exact[1];
          if (!(n in vars)) throw new Error('\u7f3a\u5c11\u6a21\u677f\u53d8@' + n);
          return vars[n];
        }
        return _renderTemplate(value, vars);
      }
      if (Array.isArray(value)) return value.map(function (v) { return _renderValue(v, vars); });
      if (value && typeof value === 'object') {
        var obj = {};
        for (var k in value) obj[k] = _renderValue(value[k], vars);
        return obj;
      }
      return value;
    }

    /** 渲染模板字符串中的 @variable 占位符 */
    function _renderTemplate(template, vars) {
      if (!template) return '';
      return template.replace(/(?<![A-Za-z0-9_])@([A-Za-z_][A-Za-z0-9]*)/g, function (m, name) {
        if (!(name in vars)) throw new Error('\u7f3a\u5c11\u6a21\u677f@' + name);
        return String(vars[name] ?? '');
      });
    }

    return {
      search: search,
      queryChapters: queryChapters,
      CaptchaRequiredException: CaptchaRequiredException,
      NoResultException: NoResultException,
      SearchErrorException: SearchErrorException,
      ChapterErrorException: ChapterErrorException
    };
  }

  return { create: create };

});
