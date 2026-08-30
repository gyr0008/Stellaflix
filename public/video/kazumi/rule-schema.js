/**
 * Kazumi Rule Schema — 严格对齐 Predidit/Kazumi (GPL-3.0) 的 Plugin 数据模型
 *
 * 字段名、默认值、语义完全保留 Kazumi 原始定义，不做任何删减或重命名。
 * 仅将 Dart 风格（camelCase）转为 JS 风格（camelCase 已一致，无需转换）。
 *
 * 规则 JSON 示例（来自 KazumiRules 仓库的 7sefun.json）：
 * {
 *   "api": "4",
 *   "type": "anime",
 *   "name": "7sefun",
 *   "version": "1.2",
 *   "baseURL": "https://www.7sefun.top/",
 *   "searchURL": "/search?wd=@keyword",
 *   "searchList": "//div[2]/div[2]/div/div[2]/div",
 *   "searchName": "//div[2]/text()",
 *   "searchResult": "//a",
 *   "chapterRoads": "//div[@class='content-list'][1]/div",
 *   "chapterResult": "//a"
 * }
 *
 * @see https://github.com/Predidit/Kazumi/blob/main/lib/plugins/plugins.dart
 * @license GPL-3.0 (与上游一致)
 */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(global);
  } else {
    global.KazumiRuleSchema = factory(global);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (global) {

  'use strict';

  /** RuleMode 常量 — 对齐 Kazumi RuleMode 类
   *  normalize 语义：仅 'api' 保留为 API 模式；其余任何值（含 undefined/空串/旧值）
   *  一律回落到 'xpath'。这与 Kazumi Plugin.fromJson 的默认 searchMode='xpath' 一致。
   */
  var RULE_MODE = Object.freeze({
    XPATH: 'xpath',
    API: 'api',
    normalize: function (v) { return v === RULE_MODE.API ? RULE_MODE.API : RULE_MODE.XPATH; }
  });

  /** ApiBodyType 常量 */
  var API_BODY_TYPE = Object.freeze({
    NONE: 'none',
    JSON: 'json',
    FORM: 'form',
    normalize: function (v) {
      if (v === API_BODY_TYPE.JSON) return v;
      if (v === API_BODY_TYPE.FORM) return v;
      return API_BODY_TYPE.NONE;
    }
  });

  /** ApiChapterFormat 常量 */
  var API_CHAPTER_FORMAT = Object.freeze({
    NESTED: 'nested',
    DELIMITED: 'delimited',
    normalize: function (v) {
      return v === API_CHAPTER_FORMAT.DELIMITED ? API_CHAPTER_FORMAT.DELIMITED : API_CHAPTER_FORMAT.NESTED;
    }
  });

  /**
   * 构造一个规则对象（Plugin 的 JS 镜像）
   * 所有字段与 Kazumi Plugin 类一一对应，顺序和默认值保持一致。
   *
   * @param {Object} raw - 来自 JSON 文件的原始数据
   * @returns {Object} 规则对象
   */
  function create(raw) {
    raw = raw || {};
    return {
      // ---- 基础字段（Kazumi Plugin 必填）----
      api: String(raw.api || '1'),
      type: String(raw.type || 'anime'),
      name: String(raw.name || ''),
      version: String(raw.version || ''),

      // ---- 功能开关（Kazumi Plugin 字段）----
      muliSources: raw.muliSources !== false,           // 默认 true
      useWebview: raw.useWebview !== false,             // 默认 true（遗留字段，保留兼容）
      useNativePlayer: raw.useNativePlayer !== false,    // 默认 true（遗留字段，保留兼容）
      usePost: Boolean(raw.usePost),                    // 默认 false
      useLegacyParser: Boolean(raw.useLegacyParser),     // 默认 false
      adBlocker: Boolean(raw.adBlocker),                // 默认 false

      // ---- HTTP 配置 ----
      userAgent: String(raw.userAgent || ''),
      baseUrl: String(raw.baseURL || raw.baseUrl || ''),  // 兼容 baseURL 和 baseUrl
      referer: String(raw.referer || ''),

      // ---- XPath 搜索配置（经典模式核心）----
      searchURL: String(raw.searchURL || ''),
      searchList: String(raw.searchList || ''),
      searchName: String(raw.searchName || ''),
      searchResult: String(raw.searchResult || ''),

      // ---- XPath 章节配置（经典模式核心）----
      chapterRoads: String(raw.chapterRoads || ''),
      chapterResult: String(raw.chapterResult || ''),

      // ---- 模式选择（xpath 或 api）----
      searchMode: RULE_MODE.normalize(raw.searchMode),
      chapterMode: RULE_MODE.normalize(raw.chapterMode),

      // ---- API 模式搜索配置（新增，可选）----
      searchApiConfig: _parseApiSearchConfig(raw.searchApiConfig),

      // ---- API 模式章节配置（新增，可选）----
      chapterApiConfig: _parseApiChapterConfig(raw.chapterApiConfig),

      // ---- 反爬配置（可选）----
      antiCrawlerConfig: _parseAntiCrawlerConfig(raw.antiCrawlerConfig)
    };
  }

  /** 从 JSON 解析 ApiSearchConfig */
  function _parseApiSearchConfig(raw) {
    if (!raw || typeof raw !== 'object') return _defaultApiSearchConfig();
    return {
      request: _parseApiRequestConfig(raw.request),
      listPath: String(raw.listPath || '$.data[*]'),
      namePath: String(raw.namePath || '$.name'),
      sourcePath: String(raw.sourcePath || '$.url')
    };
  }

  function _defaultApiSearchConfig() {
    return {
      request: _defaultApiRequestConfig(),
      listPath: '$.data[*]',
      namePath: '$.name',
      sourcePath: '$.url'
    };
  }

  /** 从 JSON 解析 ApiChapterConfig */
  function _parseApiChapterConfig(raw) {
    if (!raw || typeof raw !== 'object') return _defaultApiChapterConfig();
    var variables = {};
    if (raw.variables && typeof raw.variables === 'object') {
      for (var k in raw.variables) {
        variables[k] = String(raw.variables[k]);
      }
    }
    return {
      request: _parseApiRequestConfig(raw.request),
      format: API_CHAPTER_FORMAT.normalize(raw.format),
      // Nested 格式路径
      roadsPath: String(raw.roadsPath || '$.data.roads[*]'),
      roadNamePath: String(raw.roadNamePath || '$.name'),
      episodesPath: String(raw.episodesPath || '$.episodes[*]'),
      episodeNamePath: String(raw.episodeNamePath || '$.name'),
      episodeUrlPath: String(raw.episodeUrlPath || '$.url'),
      // Delimited 格式路径
      roadNamesPath: String(raw.roadNamesPath || ''),
      roadEpisodesPath: String(raw.roadEpisodesPath || ''),
      roadSeparator: String(raw.roadSeparator || '$$$'),
      episodeSeparator: String(raw.episodeSeparator || '#'),
      fieldSeparator: String(raw.fieldSeparator || '$'),
      // 模板变量
      variables: variables,
      // 可选播放页模板
      episodePage: raw.episodePage && typeof raw.episodePage === 'object'
        ? { url: String(raw.episodePage.url || ''), query: raw.episodePage.query || {} }
        : null
    };
  }

  function _defaultApiChapterConfig() {
    return {
      request: _defaultApiRequestConfig(),
      format: API_CHAPTER_FORMAT.NESTED,
      roadsPath: '$.data.roads[*]',
      roadNamePath: '$.name',
      episodesPath: '$.episodes[*]',
      episodeNamePath: '$.name',
      episodeUrlPath: '$.url',
      roadNamesPath: '',
      roadEpisodesPath: '',
      roadSeparator: '$$$',
      episodeSeparator: '#',
      fieldSeparator: '$',
      variables: {},
      episodePage: null
    };
  }

  /** 从 JSON 解析 ApiRequestConfig */
  function _parseApiRequestConfig(raw) {
    if (!raw || typeof raw !== 'object') return _defaultApiRequestConfig();
    var headers = {};
    if (raw.headers && typeof raw.headers === 'object') {
      for (var k in raw.headers) { headers[k] = String(raw.headers[k]); }
    }
    var query = {};
    if (raw.query && typeof raw.query === 'object') {
      for (var k in raw.query) { query[k] = raw.query[k]; }
    }
    return {
      method: String(raw.method || 'GET').toUpperCase(),
      url: String(raw.url || ''),
      headers: headers,
      query: query,
      bodyType: API_BODY_TYPE.normalize(raw.bodyType),
      body: raw.body !== undefined ? raw.body : null
    };
  }

  function _defaultApiRequestConfig() {
    return { method: 'GET', url: '', headers: {}, query: {}, bodyType: API_BODY_TYPE.NONE, body: null };
  }

  /** 从 JSON 解析 AntiCrawlerConfig */
  function _parseAntiCrawlerConfig(raw) {
    if (!raw || typeof raw !== 'object') return { enabled: false };
    return {
      enabled: Boolean(raw.enabled),
      captchaDetectValue: String(raw.captchaDetectValue || ''),
      captchaDetectType: String(raw.captchaDetectType || 'text'), // text | regex | xpath
      captchaImage: String(raw.captchaImage || ''),
      captchaButton: String(raw.captchaButton || '')
    };
  }

  /**
   * 从 JSON 字符串或对象创建规则（工厂方法，对齐 Plugin.fromJson）
   * @param {string|Object} json - JSON 字符串或已解析对象
   * @returns {Object} 规则对象
   */
  function fromJson(json) {
    if (typeof json === 'string') {
      try { json = JSON.parse(json); } catch (e) {
        throw new Error('KazumiRuleSchema: 无效的 JSON: ' + e.message);
      }
    }
    return create(json);
  }

  /**
   * 序列化为 JSON（对齐 Plugin.toJson）
   * @param {Object} rule - 规则对象
   * @returns {Object} 纯对象（可 JSON.stringify）
   */
  function toJson(rule) {
    var obj = {
      api: rule.api,
      type: rule.type,
      name: rule.name,
      version: rule.version,
      muliSources: rule.muliSources,
      useWebview: rule.useWebview,
      useNativePlayer: rule.useNativePlayer,
      usePost: rule.usePost,
      useLegacyParser: rule.useLegacyParser,
      adBlocker: rule.adBlocker,
      userAgent: rule.userAgent,
      baseURL: rule.baseUrl,
      searchURL: rule.searchURL,
      searchList: rule.searchList,
      searchName: rule.searchName,
      searchResult: rule.searchResult,
      chapterRoads: rule.chapterRoads,
      chapterResult: rule.chapterResult,
      referer: rule.referer,
      searchMode: rule.searchMode,
      chapterMode: rule.chapterMode
    };
    // 只有序列化非默认值的 API 配置（对齐 Kazumi 行为）
    if (rule.searchMode === RULE_MODE.API || (rule.searchApiConfig && rule.searchApiConfig.request.url)) {
      obj.searchApiConfig = rule.searchApiConfig;
    }
    if (rule.chapterMode === RULE_MODE.API || (rule.chapterApiConfig && rule.chapterApiConfig.request.url)) {
      obj.chapterApiConfig = rule.chapterApiConfig;
    }
    if (rule.antiCrawlerConfig && rule.antiCrawlerConfig.enabled) {
      obj.antiCrawlerConfig = rule.antiCrawlerConfig;
    }
    return obj;
  }

  /**
   * 验证规则是否具有有效的 XPath 搜索配置
   * @param {Object} rule
   * @returns {{ valid: boolean, errors: string[] }}
   */
  function validate(rule) {
    var errors = [];
    if (!rule.name) errors.push('name 不能为空');
    if (!rule.baseUrl) errors.push('baseURL 不能为空');

    if (rule.searchMode === RULE_MODE.XPATH) {
      if (!rule.searchURL) errors.push('XPath 模式需要 searchURL');
      if (!rule.searchList) errors.push('XPath 模式需要 searchList');
      if (!rule.searchName) errors.push('XPath 模式需要 searchName');
      if (!rule.searchResult) errors.push('XPath 模式需要 searchResult');
    }

    if (rule.chapterMode === RULE_MODE.XPATH) {
      if (!rule.chapterRoads) errors.push('XPath 章节模式需要 chapterRoads');
      if (!rule.chapterResult) errors.push('XPath 章节模式需要 chapterResult');
    }

    return { valid: errors.length === 0, errors: errors };
  }

  return {
    RULE_MODE: RULE_MODE,
    API_BODY_TYPE: API_BODY_TYPE,
    API_CHAPTER_FORMAT: API_CHAPTER_FORMAT,
    create: create,
    fromJson: fromJson,
    toJson: toJson,
    validate: validate
  };

});
