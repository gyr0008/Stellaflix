/*
 * Stellaflix — Kazumi 验证码(captcha)闭环 glue 层（影视模块 B1）
 *
 * 仅负责把「Kazumi 规则搜索撞验证码」这件事在 Stellaflix 侧闭环，严格对齐
 * Kazumi SourceSheet 的验证码流程（source_sheet.dart:314-328 + _handleSearchError）。
 *
 * 本文件刻意放在 kazumi/ 目录之外，零改动 kazumi/ 内部（红线：kazumi/ 内部严禁改）。
 * 它通过 kazumi-bridge.js 的 SFV.kazumi 暴露的桥接 API 工作：
 *   - 识别 CaptchaRequiredException（xpath-engine 抛出的纯对象 {name,pluginName}）
 *   - 提供 cookie-aware HTTP 客户端，把用户在 webview 里解出的验证码 cookie 注入重查请求
 *   - 经 preload IPC 从 webview 专用分区(persist:stellaflix-captcha)读回 cookie
 *
 * 闭环链路（与 Kazumi 1:1 对齐的 Stellaflix 形态）：
 *   search 撞 captcha → setStatus('captcha') 蓝点 → 打开 webview 加载 rule.searchURL
 *   → 用户在 webview 解出验证码(cookie 落在 persist:stellaflix-captcha 分区)
 *   → 点「重试」→ 经 IPC 读回该分区 cookie → 注入重查请求的 Cookie 头
 *   → server.js /api/proxy 白名单透传 cookie → 上游识别已验证 → 返回结果
 *
 * 注意：webview 渲染 / 真实验证码解出 / cookie 读取 / 端到端闭环 在 Electron 真机才可见，
 * 沙箱无法验证（见 docs/KAZUMI_ALIGNMENT_DESIGN.md 四-B）。本文件只保证结构 1:1 与
 * 可 headless 验证的状态机/逻辑。
 */
(function (global) {
  'use strict';
  if (!global.StellaflixVideo) global.StellaflixVideo = {};
  var SFV = global.StellaflixVideo;
  if (SFV.kazumiBridgeCaptcha) return; // 幂等守卫

  // ruleName -> cookie 字符串（"k=v; k2=v2"）。由 verifyCaptcha 流程写入。
  var cookieStore = {};

  /**
   * 把 search 抛出的异常分类为 captcha / 非 captcha。
   * 对齐 PluginSearchService._handleSearchError 的 CaptchaRequiredException 分支。
   * @param {*} e 异常（Kazumi 抛的是纯对象 {name:'CaptchaRequiredException',pluginName}）
   * @param {Object} rule 规则对象（用于取 antiCrawlerConfig / searchURL）
   * @returns {{isCaptcha:boolean, antiConfig:*, searchURL:string, pluginName:string}}
   */
  function classifySearchError(e, rule) {
    if (e && e.name === 'CaptchaRequiredException') {
      return {
        isCaptcha: true,
        antiConfig: (rule && rule.antiCrawlerConfig) || null,
        searchURL: (rule && rule.searchURL) || null,
        pluginName: e.pluginName || (rule && rule.name) || ''
      };
    }
    return { isCaptcha: false, antiConfig: null, searchURL: null, pluginName: '' };
  }

  /**
   * 包裹 KazumiHttpClient，为重查注入 captcha cookie。
   * 关键：KazumiHttpClient.get/post 自建请求头且忽略外部 Cookie（http-client.js:67-117），
   * 故本包装器自行经 /api/proxy 发请求并带 Cookie 头，不委托原 get/post。
   * @param {Object} base 全局 KazumiHttpClient
   * @param {Object} store ruleName -> cookie 字符串
   * @returns {{get:Function, post:Function, PROXY_BASE:string, toProxyUrl:Function, buildHeaders:Function}}
   */
  function makeCookieAwareHttpClient(base, store) {
    function proxyHeaders(rule, targetUrl, cookie) {
      var h = base.buildHeaders(rule, targetUrl);
      if (cookie) h['Cookie'] = cookie;
      return h;
    }
    async function get(url, options) {
      options = options || {};
      var targetUrl = options.useProxy !== false ? base.toProxyUrl(url) : url;
      var rule = options.rule || null;
      var cookie = (rule && rule.name && store[rule.name]) || null;
      var headers = proxyHeaders(rule, url, cookie);
      var resp = await fetch(targetUrl, { method: 'GET', headers: headers, signal: options.signal || null });
      if (!resp.ok) throw new Error('HTTP ' + resp.status + ' (' + resp.statusText + ') for ' + String(url).slice(0, 100));
      return resp.text();
    }
    async function post(url, body, options) {
      options = options || {};
      var targetUrl = options.useProxy !== false ? base.toProxyUrl(url) : url;
      var rule = options.rule || null;
      var cookie = (rule && rule.name && store[rule.name]) || null;
      var headers = proxyHeaders(rule, url, cookie);
      if (body && typeof body === 'object' && !(body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(body);
      }
      var resp = await fetch(targetUrl, { method: 'POST', headers: headers, body: body, signal: options.signal || null });
      if (!resp.ok) throw new Error('HTTP ' + resp.status + ' for POST ' + String(url).slice(0, 100));
      return resp.text();
    }
    return {
      PROXY_BASE: base.PROXY_BASE, toProxyUrl: base.toProxyUrl, buildHeaders: base.buildHeaders,
      get: get, post: post
    };
  }

  /** 写入某规则的 captcha cookie（verifyCaptcha 流程调用）。 */
  function setCaptchaCookies(ruleName, cookieStr) {
    if (!ruleName) return;
    if (cookieStr) cookieStore[ruleName] = cookieStr;
    else delete cookieStore[ruleName];
  }

  /** 读取某规则的 captcha cookie（调试/重查前回看）。 */
  function getCaptchaCookiesLocal(ruleName) {
    return cookieStore[ruleName] || null;
  }

  /**
   * 经 preload IPC 从 webview 专用分区读回 captcha cookie，拼成 "k=v; ..." 串。
   * 对齐 Kazumi：webview 解出验证码后 cookie 落在 persist:stellaflix-captcha 分区，
   * 重查须复用同一批 cookie。无 IPC（非 Electron / 沙箱）时返回 null（best-effort）。
   * @param {string} searchURL 规则搜索 URL（用于按 origin 过滤 cookies）
   * @returns {Promise<string|null>}
   */
  async function getCaptchaCookiesViaIPC(searchURL) {
    try {
      if (typeof window === 'undefined' || !window.desktopWindow ||
          typeof window.desktopWindow.getCaptchaCookies !== 'function') return null;
      var res = await window.desktopWindow.getCaptchaCookies(searchURL);
      if (!res || !res.ok || !res.cookies || !res.cookies.length) return null;
      return res.cookies.map(function (c) { return c.name + '=' + c.value; }).join('; ');
    } catch (e) {
      console.warn('[kazumi-bridge-captcha] 读 captcha cookie 失败:', e && e.message);
      return null;
    }
  }

  SFV.kazumiBridgeCaptcha = {
    classifySearchError: classifySearchError,
    makeCookieAwareHttpClient: makeCookieAwareHttpClient,
    setCaptchaCookies: setCaptchaCookies,
    getCaptchaCookiesLocal: getCaptchaCookiesLocal,
    getCaptchaCookiesViaIPC: getCaptchaCookiesViaIPC,
    _store: cookieStore
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = SFV.kazumiBridgeCaptcha;
  }
})(typeof window !== 'undefined' ? window : this);
