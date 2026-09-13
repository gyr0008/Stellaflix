/**
 * Kazumi — 规则仓库远程客户端（RulesRepoClient）
 *
 * 移植自 Predidit/Kazumi 的 rules_repo_client.dart：
 * 默认走 GitCode 镜像（raw.gitcode.com），可回退 GitHub 直连。
 *
 * 上游对应：lib/request/clients/rules_repo_client.dart
 *
 * 公开 API（挂载到 global.KazumiRulesRepo）：
 *   - configure({ useMirror })     切换直连(false=GitHub) / 镜像(true=GitCode，默认)
 *   - getPluginList()              获取 index.json 目录 (PluginHTTPItem[])
 *   - getPlugin(name)              获取单条规则对象 (Plugin JSON)
 *   - getRuleText(name)            获取单条规则原始文本
 *
 * 加载顺序：必须在 http-client.js 之后（复用 KazumiHttpClient 或 fetch 直连）。
 *
 * @license GPL-3.0 (与上游一致)
 */
(function (global) {
  'use strict';

  // ---- 仓库端点配置（对齐 Kazumi ApiEndpoints） ----
  var ENDPOINTS = {
    github: 'https://raw.githubusercontent.com/Predidit/KazumiRules/main/',
    mirror: 'https://raw.gitcode.com/gh_mirrors/ka/KazumiRules/raw/main/'
  };

  var _baseUrl = ENDPOINTS.mirror;
  var _ns = 'kazumi-rules-repo';

  function d() { return global.document; }
  function isElectron() {
    return typeof process !== 'undefined' && process.versions && !!process.versions.electron;
  }

  // ---- URL 解析 ----
  function resolveUrl(path) {
    return _baseUrl + (path || '').replace(/^\/+/, '');
  }

  // ---- 网络请求（优先 http-client.js 的 KazumiHttpClient，降级 fetch） ----
  async function getText(url) {
    // Electron 环境：经 /api/proxy 绕 CORS；浏览器直连则 fetch
    var proxied = '/api/proxy?url=' + encodeURIComponent(url);

    // 若 KazumiHttpClient 可用则优先（带统一 UA / 代理设置）
    if (global.KazumiHttpClient && typeof global.KazumiHttpClient.get === 'function') {
      try {
        return await global.KazumiHttpClient.get(url, { useProxy: true });
      } catch (e) {
        // 降级到 fetch 经 /api/proxy
      }
    }

    // 经 /api/proxy 中转（Stellaflix 标准跨域代理）
    if (typeof fetch === 'function') {
      var resp;
      try {
        resp = await fetch(proxied);
      } catch (e) {
        // fetch 失败，可能是 file:// 协议下受限，尝试直连
        try { resp = await fetch(url); }
        catch (e2) { throw new Error('[KazumiRulesRepo] 网络请求失败: ' + url + ' (' + e2.message + ')'); }
      }
      if (!resp.ok) throw new Error('[KazumiRulesRepo] HTTP ' + resp.status + ': ' + url);
      return await resp.text();
    }

    throw new Error('[KazumiRulesRepo] 当前环境不支持网络请求');
  }

  // ---- 公开 API ----

  /**
   * 切换数据源（github 直连 / GitCode 镜像）
   * @param {{useMirror?:boolean}} opts
   */
  function configure(opts) {
    opts = opts || {};
    _baseUrl = opts.useMirror ? ENDPOINTS.mirror : ENDPOINTS.github;
  }

  /**
   * 获取当前使用的 base URL（调试用）
   */
  function getBaseUrl() {
    return _baseUrl;
  }

  /**
   * 解析规则目录 JSON（对齐 PluginCatalogApi.parsePluginList）
   * @returns {Promise<{items:Array, skipped:number}>}
   */
  function parsePluginList(raw) {
    var jsonData;
    try { jsonData = JSON.parse(raw); }
    catch (e) { throw new Error('规则目录 JSON 解析失败: ' + e.message); }

    if (!Array.isArray(jsonData)) {
      throw new Error('规则目录根须为 JSON 数组');
    }

    var items = [];
    var skipped = 0;
    for (var i = 0; i < jsonData.length; i++) {
      try {
        var it = jsonData[i];
        if (!it || typeof it !== 'object') throw new Error('条目须为对象');
        items.push({
          name: String(it.name || ''),
          version: String(it.version || ''),
          useNativePlayer: it.useNativePlayer !== false,
          author: String(it.author || ''),
          lastUpdate: parseInt(it.lastUpdate, 10) || 0,
          antiCrawlerEnabled: !!(it.antiCrawlerConfig && it.antiCrawlerConfig.enabled)
        });
      } catch (e) {
        skipped++;
      }
    }
    return { items: items, skipped: skipped };
  }

  /**
   * 获取规则目录
   * @returns {Promise<Array<{name,version,useNativePlayer,author,lastUpdate,antiCrawlerEnabled}>>}
   */
  async function getPluginList() {
    var raw = await getText(resolveUrl('index.json'));
    var result = parsePluginList(raw);
    if (result.skipped > 0) {
      console.warn('[' + _ns + '] 跳过 ' + result.skipped + ' 条无效规则目录条目');
    }
    if (!result.items.length) {
      throw new Error('规则目录为空');
    }
    return result.items;
  }

  /**
   * 获取单条规则（JSON 对象）
   * @param {string} name - 规则名（不含 .json 后缀）
   * @returns {Promise<Object>}
   */
  async function getPlugin(name) {
    if (!name) throw new Error('规则名不能为空');
    var raw = await getText(resolveUrl(name + '.json'));
    var jsonData;
    try { jsonData = JSON.parse(raw); }
    catch (e) { throw new Error('规则 [' + name + '] JSON 解析失败: ' + e.message); }
    if (!jsonData || typeof jsonData !== 'object') {
      throw new Error('规则 [' + name + '] 须为 JSON 对象');
    }
    return jsonData;
  }

  /**
   * 获取单条规则原始文本
   * @param {string} name
   * @returns {Promise<string>}
   */
  async function getRuleText(name) {
    if (!name) throw new Error('规则名不能为空');
    return await getText(resolveUrl(name + '.json'));
  }

  // ---- 暴露 ----
  global.KazumiRulesRepo = {
    _ns: _ns,
    ENDPOINTS: ENDPOINTS,
    configure: configure,
    getBaseUrl: getBaseUrl,
    getText: getText,
    resolveUrl: resolveUrl,
    parsePluginList: parsePluginList,
    getPluginList: getPluginList,
    getPlugin: getPlugin,
    getRuleText: getRuleText
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = global.KazumiRulesRepo;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
