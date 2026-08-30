/**
 * Kazumi URL Utils — 严格对齐 Predidit/Kazumi (GPL-3.0) 的 URL 归一化逻辑
 *
 * 核心函数 normalizeEpisodeUrl() 完整移植自：
 *   lib/utils/episode_url.dart → normalizeEpisodeUrl()
 *
 * 归一化规则（与 Kazumi 完全一致）：
 *   1. 去除首尾空白；空输入返回空串
 *   2. 相对路径基于 baseUrl 补全为绝对 URL
 *   3. 同站 URL 协议统一到 baseUrl 声明的协议
 *   4. 去除 path 多余尾斜杠（根路径 / 保留）
 *   5. 去除空 query
 *   6. 幂等：normalize(normalize(x)) === normalize(x)
 *
 * @see https://github.com/Predidit/Kazumi/blob/main/lib/utils/episode_url.dart
 * @license GPL-3.0
 */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(global);
  } else {
    global.KazumiUrlUtils = factory(global);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (global) {

  'use strict';

  /**
   * 判断字符串是否是「绝对 URL」（含 protocol + host）。
   * 使用 try/catch 包裹，因为 Node 的 new URL('/page') 对相对路径会抛错，
   * 而 Kazumi（Dart Uri.parse）不会。这里需与 Dart 行为对齐。
   */
  function _isAbsoluteUrl(s) {
    try {
      var u = new URL(s);
      return !!(u.protocol && u.host);
    } catch (e) {
      return false;
    }
  }

  /**
   * 集数源站 URL 归一化 — 完整移植自 Kazumi normalizeEpisodeUrl()
   *
   * @param {string} baseUrl - 规则声明的站点基础 URL
   * @param {string} raw - 从页面抓取的原始 href（可能为相对路径）
   * @returns {string} 归一化后的绝对 URL；空输入返回空串
   */
  function normalizeEpisodeUrl(baseUrl, raw) {
    var trimmed = (raw || '').trim();
    if (!trimmed) return '';

    try {
      var baseUri = baseUrl ? new URL(baseUrl) : null;
      var hasValidBase = !!(baseUri && baseUri.protocol && baseUri.host);

      var resolved;
      if (_isAbsoluteUrl(trimmed)) {
        // 已是绝对 URL
        resolved = new URL(trimmed);
      } else if (hasValidBase) {
        // 相对路径 → 基于 baseUrl 解析（Dart Uri.parse 不会因相对路径抛错）
        resolved = new URL(trimmed, baseUri);
      } else {
        // 无法解析，原样返回
        return trimmed;
      }

      // 同站 URL 协议统一到 baseUrl 声明的协议
      if (hasValidBase && _isHttpScheme(baseUri.protocol) && _isHttpScheme(resolved.protocol)) {
        if (resolved.protocol !== baseUri.protocol &&
            resolved.host === baseUri.host &&
            resolved.port === baseUri.port) {
          resolved.protocol = baseUri.protocol;
        }
      }

      // 去除 path 尾斜杠（根路径除外）
      var path = resolved.pathname;
      while (path.length > 1 && path.endsWith('/')) {
        path = path.slice(0, -1);
      }

      // 重建 URL（去除空 query/fragment）
      // 注意：JS 的 URL.host 已经是 "hostname:port" 形式，与 Dart Uri.host
      // （仅主机名，端口在 Uri.port 单独存放）语义不同。此处必须直接用 host，
      // 不可再追加 resolved.port，否则非默认端口会被重复拼接，
      // 例如 https://example.com:8443/ + /ep/2 → https://example.com:8443:8443/ep/2。
      var result = resolved.protocol + '//' + resolved.host;
      result += path;
      if (resolved.search && resolved.search !== '?') result += resolved.search;
      if (resolved.hash && resolved.hash !== '#') result += resolved.hash;

      return result;
    } catch (e) {
      // URL 解析失败，返回去空白后的原始值
      return trimmed;
    }
  }

  /** 检查是否是 HTTP 协议 */
  function _isHttpScheme(scheme) {
    return scheme === 'http:' || scheme === 'https:';
  }

  /**
   * 渲染 URL 模板 — 将 @keyword 等占位符替换为实际值
   * 对齐 Kazumi ApiRuleStrategy._renderTemplate()
   *
   * @param {string} template - 含 @变量 占位符的模板
   * @param {Object} variables - 变量映射 { keyword: 'xxx' }
   * @param {boolean} encode - 是否 URI 编码替换值
   * @returns {string} 渲染后的字符串
   */
  function renderTemplate(template, variables, encode) {
    if (!template) return '';
    variables = variables || {};
    return template.replace(/(?<![A-Za-z0-9_])@([A-Za-z_][A-Za-z0-9]*)/g, function (match, name) {
      if (!(name in variables)) {
        throw new Error('缺少模板变量 @' + name);
      }
      var value = String(variables[name] ?? '');
      return encode ? encodeURIComponent(value) : value;
    });
  }

  /**
   * 构建完整搜索 URL — 对齐 XPathRuleStrategy.prepareSearchRequest()
   *
   * @param {Object} rule - 规则对象
   * @param {string} keyword - 搜索关键词
   * @returns {{ method: string, url: string }}
   */
  function buildSearchUrl(rule, keyword) {
    var queryUrl = rule.searchURL.replace(
      /@keyword/g,
      encodeURIComponent(keyword)
    );
    if (rule.usePost) {
      // POST 模式：URL 不含 query 参数，参数放 body
      var uri = new URL(queryUrl);
      return { method: 'POST', url: uri.origin + uri.pathname };
    }
    return { method: 'GET', url: queryUrl };
  }

  /**
   * 构建章节请求 URL — 对齐 XPathRuleStrategy.prepareChapterRequest()
   *
   * @param {Object} rule - 规则对象
   * @param {string} source - 搜索结果中的详情页链接
   * @returns {string} 绝对 URL
   */
  function buildChapterUrl(rule, source) {
    return normalizeEpisodeUrl(rule.baseUrl, source);
  }

  return {
    normalizeEpisodeUrl: normalizeEpisodeUrl,
    renderTemplate: renderTemplate,
    buildSearchUrl: buildSearchUrl,
    buildChapterUrl: buildChapterUrl
  };

});
