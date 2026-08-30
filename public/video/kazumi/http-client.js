/* Kazumi HTTP Client - aligns with Kazumi request execution layer */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(global);
  } else {
    global.KazumiHttpClient = factory(global);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (global) {

  'use strict';

  /** 代理基础地址 — 与 Stellaflix server.js 的 /api/proxy 对应 */
  var PROXY_BASE = '/api/proxy?url=';

  /**
   * 将目标 URL 编码为代理 URL
   * @param {string} targetUrl - 目标 URL
   * @returns {string} 代理 URL
   */
  function toProxyUrl(targetUrl) {
    return PROXY_BASE + encodeURIComponent(targetUrl);
  }

  /**
   * 构造浏览器特征请求头 — 对齐 KVideo fetch-with-retry.ts
   *
   * @param {Object} rule - 规则对象（用于提取 referer/userAgent）
   * @param {string} targetUrl - 目标 URL（用于提取 Origin）
   * @returns {Object} 请求头字典
   */
  function buildHeaders(rule, targetUrl) {
    var origin;
    try { origin = new URL(targetUrl).origin; } catch (e) {}

    var headers = {
      // ---- KVideo 成熟方案的核心头 ----
      'Origin': origin || '',
      'Referer': (rule && rule.referer) || (origin ? origin + '/' : ''),
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept': '*/*',
      'Accept-Encoding': 'gzip, deflate, br'
    };

    // 规则自定义 UA 覆盖默认值
    if (rule && rule.userAgent) {
      headers['User-Agent'] = rule.userAgent;
    } else {
      headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
    }

    return headers;
  }

  /**
   * 执行 GET 请求（经代理中转）
   *
   * @param {string} url - 目标 URL（可以是绝对 URL 或已编码的代理 URL）
   * @param {Object} [options] - 可选配置
   * @param {Object} [options.rule] - 规则对象（用于构造头）
   * @param {boolean} [options.useProxy=true] - 是否走代理
   * @param {AbortSignal} [options.signal] - 取消信号
   * @returns {Promise<string>} 响应文本
   */
  async function get(url, options) {
    options = options || {};
    var useProxy = options.useProxy !== false;
    var targetUrl = useProxy ? toProxyUrl(url) : url;
    var headers = buildHeaders(options.rule, url);

    var resp = await fetch(targetUrl, {
      method: 'GET',
      headers: headers,
      signal: options.signal || null
    });

    if (!resp.ok) {
      throw new Error('HTTP ' + resp.status + ' (' + resp.statusText + ') for ' + url.slice(0, 100));
    }

    return resp.text();
  }

  /**
   * 执行 POST 请求（经代理中转）
   *
   * @param {string} url - 目标 URL
   * @param {Object|FormData|string} body - 请求体
   * @param {Object} [options] - 可选配置
   * @returns {Promise<string>} 响应文本
   */
  async function post(url, body, options) {
    options = options || {};
    var useProxy = options.useProxy !== false;
    var targetUrl = useProxy ? toProxyUrl(url) : url;
    var headers = buildHeaders(options.rule, url);

    if (body && typeof body === 'object' && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }

    var resp = await fetch(targetUrl, {
      method: 'POST',
      headers: headers,
      body: body,
      signal: options.signal || null
    });

    if (!resp.ok) {
      throw new Error('HTTP ' + resp.status + ' for POST ' + url.slice(0, 100));
    }

    return resp.text();
  }

  return {
    PROXY_BASE: PROXY_BASE,
    toProxyUrl: toProxyUrl,
    buildHeaders: buildHeaders,
    get: get,
    post: post
  };

});
