/**
 * Kazumi XPath Engine — 严格对齐 Predidit/Kazumi (GPL-3.0) 的 XPathRuleStrategy
 *
 * 使用浏览器原生 document.evaluate() 执行 XPath 1.0 查询，
 * 完整复刻 xpath_rule_strategy.dart 的搜索/章节解析逻辑。
 *
 * 核心流程（与 Kazumi 一致）：
 *   1. prepareSearchRequest(rule, keyword) → 构造搜索 URL
 *   2. HTTP GET → HTML 文本
 *   3. parseSearch(html, rule) → DOMParser 解析 → XPath 提取 → SearchItem[]
 *   4. prepareChapterRequest(rule, source) → 构造详情页 URL
 *   5. HTTP GET → HTML 文本
 *   6. parseChapters(html, rule) → DOMParser 解析 → XPath 提取 → Road[]
 *
 * @see https://github.com/Predidit/Kazumi/blob/main/lib/services/plugin/xpath_rule_strategy.dart
 * @license GPL-3.0
 */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(global);
  } else {
    global.KazumiXPathEngine = factory(global);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (global) {

  'use strict';

  // ---- 常量：XPath 字段标签（对齐 XPathRuleField 枚举）----
  var FIELD = Object.freeze({
    SEARCH_LIST: 'searchList',
    SEARCH_NAME: 'searchName',
    SEARCH_RESULT: 'searchResult',
    CHAPTER_ROADS: 'chapterRoads',
    CHAPTER_RESULT: 'chapterResult',
    CAPTCHA_DETECT: 'captchaDetectValue',
    CAPTCHA_IMAGE: 'captchaImage',
    CAPTCHA_BUTTON: 'captchaButton'
  });

  var FIELD_LABEL = {};
  FIELD_LABEL[FIELD.SEARCH_LIST] = '\u641c\u7d22\u7ed3\u679c\u5217\u8868';
  FIELD_LABEL[FIELD.SEARCH_NAME] = '\u6761\u76ee\u540d\u79f0';
  FIELD_LABEL[FIELD.SEARCH_RESULT] = '\u6761\u76ee\u94fe\u63a5';
  FIELD_LABEL[FIELD.CHAPTER_ROADS] = '\u64ad\u653e\u8def\u7ebf\u5217\u8868';
  FIELD_LABEL[FIELD.CHAPTER_RESULT] = '\u5267\u96c6\u5217\u8868';
  FIELD_LABEL[FIELD.CAPTCHA_DETECT] = '\u9a8c\u8bc1\u9875\u68c0\u6d4b';
  FIELD_LABEL[FIELD.CAPTCHA_IMAGE] = '\u9a8c\u8bc1\u7801\u56fe\u7247';
  FIELD_LABEL[FIELD.CAPTCHA_BUTTON] = '\u9a8c\u8bc1\u6309\u94ae';

  /**
   * 将 HTML 字符串解析为 Document 对象
   * 对应 Dart 端的 html.parse(raw).documentElement
   *
   * @param {string} raw - HTML 文本
   * @returns {Document} 解析后的 Document
   * @throws {Error} 如果 HTML 无效
   */
  function parseHtml(raw) {
    if (!raw || !raw.trim()) {
      throw new Error('HTML \u54cd\u5e94\u6ca1\u6709\u6839\u8282\u70b9');
    }
    var parser = new global.DOMParser();
    var doc = parser.parseFromString(raw, 'text/html');
    if (!doc.documentElement) {
      throw new Error('HTML \u54cd\u5e94\u89e3\u6790\u5931\u8d25');
    }
    return doc;
  }

  /**
   * 在节点上执行 XPath 查询，返回第一个匹配节点
   * 对应 Dart 端的 node.queryXPath(expr).node
   *
   * @param {Node} context - 上下文节点
   * @param {string} expr - XPath 表达式
   * @returns {Node|null}
   */
  function queryXPathFirst(context, expr) {
    var result = _evaluate(context, expr, XPathResult.FIRST_ORDERED_NODE_TYPE);
    return result ? result.singleNodeValue : null;
  }

  /**
   * 在节点上执行 XPath 查询，返回所有匹配节点
   * 对应 Dart 端的 node.queryXPath(expr).nodes
   *
   * @param {Node} context - 上下文节点
   * @param {string} expr - XPath 表达式
   * @returns {Node[]}
   */
  function queryXPathAll(context, expr) {
    var result = _evaluate(context, expr, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE);
    if (!result) return [];
    var nodes = [];
    for (var i = 0; i < result.snapshotLength; i++) {
      nodes.push(result.snapshotItem(i));
    }
    return nodes;
  }

  /** 内部：执行 XPath evaluate */
  function _evaluate(context, expr, type) {
    try {
      var doc = context.ownerDocument || context;
      return doc.evaluate(expr, context, null, type, null);
    } catch (e) {
      // XPath 无效时返回 null，由调用方处理
      return null;
    }
  }

  /**
   * 将 XPath 表达式改写为「相对上下文节点」语义。
   *
   * 【为什么必须有这一步】
   * Dart 端 Kazumi 用的是 node.queryXPath(expr)，其中 expr 始终相对当前节点求值，
   * 所以上游规则大量写成 "//a"、"//div[2]/text()"（见 7sefun.json）。
   * 而浏览器的 document.evaluate(expr, contextNode, ...) 里，以 "/" 开头的表达式
   * 锚定的是「文档根」而不是 contextNode —— 同样的 "//a"，在每个搜索条目上求值
   * 都会返回文档里的第一个 <a>，导致所有条目拿到同一个链接。
   *
   * 该差异已在真机端到端测试中实测复现：
   *   searchResult="//a" → 两条结果的 src 均为 "/detail/1"
   *   （scripts/kazumi_e2e_electron.js，探针 F）
   *
   * 因此在「以元素为上下文」求值前，把前导斜杠改写为显式相对写法：
   *   "//a"            → ".//a"
   *   "/div/a"         → "./div/a"
   *   ".//a" / "a/b"   → 原样保留（本就是相对写法）
   *   "//a|//img"      → ".//a|.//img"（联合表达式逐段处理）
   *
   * 注意：仅用于元素上下文（searchName / searchResult / chapterResult）。
   * searchList / chapterRoads 以 Document 为上下文，"//" 本就等价于 ".//"，不改写。
   *
   * @param {string} expr - 原始 XPath 表达式
   * @returns {string} 相对化后的表达式
   */
  function toNodeRelative(expr) {
    if (expr === null || expr === undefined) return expr;
    var s = String(expr);
    if (s.indexOf('/') === -1) return s;
    return s.split('|').map(function (part) {
      var t = part.trim();
      if (!t) return part;
      if (t.charAt(0) !== '/') return part; // 已是相对写法
      return '.' + t;
    }).join('|');
  }

  /**
   * 安全运行选择器 — 对齐 _runSelector() 的错误包装逻辑
   *
   * @param {string} field - 字段标识
   * @param {string} expression - XPath 表达式
   * @param {Function} queryFn - 查询函数
   * @returns {*} 查询结果
   * @throws {Error} 如果表达式为空或查询失败
   */
  function runSelector(field, expression, queryFn) {
    var label = FIELD_LABEL[field] || field;
    if (!expression || !expression.trim()) {
      throw new Error(label + ' XPath \u4e0d\u80fd\u4e3a\u7a7a');
    }
    try {
      return queryFn();
    } catch (e) {
      throw new Error(label + ' XPath \u65e0\u6548: ' + expression + ' (' + e.message + ')');
    }
  }

  /**
   * 检测验证码/反爬挑战页 — 对齐 detectsCaptchaChallenge()
   *
   * @param {string} raw - HTML 原始文本
   * @param {Object} antiConfig - antiCrawlerConfig
   * @param {Document} [doc] - 已解析的文档（可选）
   * @returns {boolean} 是否检测到验证码挑战
   */
  function detectCaptcha(raw, antiConfig, doc) {
    if (!antiConfig || !antiConfig.enabled) return false;
    var detectValue = (antiConfig.captchaDetectValue || '').trim();
    if (detectValue) {
      switch (antiConfig.captchaDetectType) {
        case 'text':
          return raw.indexOf(detectValue) !== -1;
        case 'regex':
          try {
            return new RegExp(detectValue, 'is').test(raw);
          } catch (e) { return false; }
        case 'xpath':
        default:
          var root = doc || parseHtml(raw);
          return queryXPathFirst(root, detectValue) !== null;
      }
    }
    // 回退：检查验证码图片和按钮选择器
    root = doc || parseHtml(raw);
    if (antiConfig.captchaImage && queryXPathFirst(root, antiConfig.captchaImage)) return true;
    if (antiConfig.captchaButton && queryXPathFirst(root, antiConfig.captchaButton)) return true;
    return false;
  }

  /**
   * 解析搜索结果 — 对齐 XPathRuleStrategy.parseSearch()
   *
   * 流程：
   *   1. 解析 HTML 为 DOM
   *   2. 检测验证码（如有则抛出 CaptchaRequiredException）
   *   3. 用 searchList XPath 定位结果列表容器
   *   4. 对每个结果节点用 searchName/searchResult 提取名称和链接
   *
   * @param {string} raw - 搜索页 HTML
   * @param {Object} rule - 规则对象
   * @param {Function} normalizeUrl - normalizeEpisodeUrl 函数引用
   * @returns {{ items: Array, diagnostics: string[] }}
   * @throws {Error} 验证码检测到时
   */
  function parseSearch(raw, rule, normalizeUrl) {
    normalizeUrl = normalizeUrl || function (b, u) { return u; };
    var root = parseHtml(raw);

    // 验证码检测
    if (detectCaptcha(raw, rule.antiCrawlerConfig, root)) {
      throw { name: 'CaptchaRequiredException', pluginName: rule.name };
    }

    var items = [];
    var diagnostics = [];

    // 用 searchList 定位结果容器（上下文是 Document，"//" 语义正确，不改写）
    var listNodes = runSelector(FIELD.SEARCH_LIST, rule.searchList, function () {
      return queryXPathAll(root, rule.searchList);
    });

    // 以下两个选择器以「结果条目元素」为上下文求值，必须相对化，
    // 否则上游规则里的 "//a" 会锚定文档根，使每条结果都取到同一个链接。
    var nameExpr = toNodeRelative(rule.searchName);
    var linkExpr = toNodeRelative(rule.searchResult);

    for (var i = 0; i < listNodes.length; i++) {
      var node = listNodes[i];
      try {
        // 提取标题文本
        var nameEl = runSelector(FIELD.SEARCH_NAME, rule.searchName, function () {
          return queryXPathFirst(node, nameExpr);
        });
        var name = nameEl ? (_getTextContent(nameEl)).trim() : '';

        // 提取链接 href
        var linkEl = runSelector(FIELD.SEARCH_RESULT, rule.searchResult, function () {
          return queryXPathFirst(node, linkExpr);
        });
        var source = linkEl && linkEl.getAttribute ? (linkEl.getAttribute('href') || '').trim() : '';

        if (!name || !source) {
          diagnostics.push('\u641c\u7d22\u8282\u70b9 ' + i + ' \u7f3a\u5c11\u540d\u79f0\u6216\u6765\u6e90\uff0c\u5df2\u8df3\u8fc7');
          continue;
        }

        items.push({ name: name, src: source });
      } catch (e) {
        diagnostics.push('\u641c\u7d22\u8282\u70b9 ' + i + ' \u89e3\u6790\u5931\u8d25: ' + e.message);
      }
    }

    return { items: items, diagnostics: diagnostics };
  }

  /**
   * 解析章节/剧集列表 — 对齐 XPathRuleStrategy.parseChapters()
   *
   * 流程：
   *   1. 解析 HTML 为 DOM
   *   2. 用 chapterRoads XPath 定位播放线路组
   *   3. 对每个线路用 chapterResult 提取剧集链接和名称
   *   4. 返回 Road[] 结构
   *
   * @param {string} raw - 详情页 HTML
   * @param {Object} rule - 规则对象
   * @param {Function} normalizeUrl - normalizeEpisodeUrl 函数引用
   * @returns {{ roads: Array<{name:string,data:string[],identifier:string[]}>, diagnostics: string[] }}
   */
  function parseChapters(raw, rule, normalizeUrl) {
    normalizeUrl = normalizeUrl || function (b, u) { return u; };
    var root = parseHtml(raw);
    var roads = [];
    var diagnostics = [];

    // 用 chapterRoads 定位播放线路容器（上下文是 Document，"//" 语义正确，不改写）
    var roadNodes = runSelector(FIELD.CHAPTER_ROADS, rule.chapterRoads, function () {
      return queryXPathAll(root, rule.chapterRoads);
    });

    // 剧集选择器以「线路元素」为上下文求值，必须相对化，
    // 否则上游规则里的 "//a" 会把所有线路都解析成整页的全部链接。
    var epExpr = toNodeRelative(rule.chapterResult);

    for (var ri = 0; ri < roadNodes.length; ri++) {
      var roadNode = roadNodes[ri];
      try {
        var urls = [];
        var names = [];

        // 用 chapterResult 定位该线路下的剧集链接
        var episodeNodes = runSelector(FIELD.CHAPTER_RESULT, rule.chapterResult, function () {
          return queryXPathAll(roadNode, epExpr);
        });

        for (var ei = 0; ei < episodeNodes.length; ei++) {
          try {
            var ep = episodeNodes[ei];
            var href = ep.getAttribute ? (ep.getAttribute('href') || '').trim() : '';
            if (!href) {
              diagnostics.push('\u8def\u7ebf ' + ri + ' \u7684\u5267\u96c6\u8282\u70b9 ' + ei + ' \u7f3a\u5c11 URL\uff0c\u5df2\u8df3\u8fc7');
              continue;
            }
            var text = _getTextContent(ep).replace(/\s+/g, '');
            urls.push(normalizeUrl(rule.baseUrl, href));
            names.push(text || '\u7b2c' + (ei + 1) + '\u96c6');
          } catch (e) {
            diagnostics.push('\u8def\u7ebf ' + ri + ' \u7684\u5267\u96c6\u8282\u70b9 ' + ei + ' \u89e3\u6790\u5931\u8d25: ' + e.message);
          }
        }

        if (urls.length === 0) {
          diagnostics.push('\u8def\u7ebf\u8282\u70b9 ' + ri + ' \u6ca1\u6709\u6548\u5267\u96c6\uff0c\u5df2\u8df3\u8fc7');
          continue;
        }

        roads.push({
          name: '\u64ad\u653e\u8def\u7ebf' + (roads.length + 1),
          data: urls,
          identifier: names
        });
      } catch (e) {
        diagnostics.push('\u8def\u7ebf\u8282\u70b9 ' + ri + ' \u89e3\u6790\u5931\u8d25: ' + e.message);
      }
    }

    return { roads: roads, diagnostics: diagnostics };
  }

  /** 获取节点的文本内容（兼容 Element 和 Text 节点） */
  function _getTextContent(node) {
    if (!node) return '';
    if (typeof node.textContent === 'string') return node.textContent;
    if (typeof node.text === 'string') return node.text;
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
    return node.innerText || node.innerHTML || '';
  }

  return {
    FIELD: FIELD,
    parseHtml: parseHtml,
    queryXPathFirst: queryXPathFirst,
    queryXPathAll: queryXPathAll,
    toNodeRelative: toNodeRelative,
    runSelector: runSelector,
    detectCaptcha: detectCaptcha,
    parseSearch: parseSearch,
    parseChapters: parseChapters
  };

});
