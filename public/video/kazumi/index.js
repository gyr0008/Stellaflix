/**
 * Kazumi Rule Engine — 公共入口
 *
 * 严格对齐 Predidit/Kazumi (GPL-3.0) 的规则引擎架构，
 * 提供 XPath/JSON 双模式搜索和章节解析能力。
 *
 * 使用方式：
 *   var engine = KazumiRuleEngine.create();
 *   var results = await engine.search(rule, '你的名字');
 *   var chapters = await engine.queryChapters(rule, results.items[0].src);
 *
 * 依赖加载顺序（必须按此顺序引入 <script>）：
 *   1. rule-schema.js     — 规则数据模型
 *   2. url-utils.js       — URL 工具（归一化、模板渲染）
 *   3. http-client.js     — HTTP 客户端（代理中转）
 *   4. xpath-engine.js    — XPath 解析引擎
 *   5. rule-engine.js     — 主调度器
 *   6. index.js (本文件)  — 公共 API + 规则管理器
 *
 * @license GPL-3.0 (与上游一致)
 */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(global);
  } else {
    global.Kazumi = factory(global);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (global) {

  'use strict';

  // ---- 引用子模块 ----
  var Schema = global.KazumiRuleSchema;
  var UrlUtils = global.KazumiUrlUtils;
  var HttpClient = global.KazumiHttpClient;
  var XPathEngine = global.KazumiXPathEngine;
  var RuleEngineModule = global.KazumiRuleEngine;

  /**
   * 规则管理器 — 对齐 PluginsController 的核心功能
   *
   * 负责：规则加载/存储/启用/禁用/搜索执行/章节查询
   * 存储使用 localStorage（key: kazumi-rules）
   */
  function createRuleManager() {
    var STORAGE_KEY = 'kazumi-rules';
    var engine = RuleEngineModule.create({
      httpClient: HttpClient,
      xpathEngine: XPathEngine,
      normalizeUrl: UrlUtils.normalizeEpisodeUrl
    });

    /** 已加载的规则列表（Plugin[] 镜像） */
    var rules = [];

    /** 从 localStorage 加载规则 */
    function load() {
      try {
        var raw = global.localStorage.getItem(STORAGE_KEY);
        if (raw) {
          var arr = JSON.parse(raw);
          rules = arr.map(function (r) { return Schema.fromJson(r); });
        }
      } catch (e) {
        console.warn('[Kazumi] \u52a0\u8f7d\u89c4\u5219\u5931\u8d25:', e.message);
        rules = [];
      }
      return rules;
    }

    /** 持久化到 localStorage */
    function save() {
      try {
        var json = rules.map(function (r) { return Schema.toJson(r); });
        global.localStorage.setItem(STORAGE_KEY, JSON.stringify(json));
      } catch (e) {
        console.error('[Kazumi] \u4fdd\u5b58\u89c4\u5219\u5931\u8d25:', e.message);
      }
    }

    /** 添加/更新规则
     * 对齐 Kazumi PluginsController.addPlugin：信任规则来源，无条件存入，
     * 仅在无效时打印告警（不抛错）。无效规则会被 getEnabledXpathRules() 在
     * 搜索前过滤掉。validate() 是独立、可选的显式校验入口。
     */
    function addOrUpdate(rule) {
      var r = typeof rule === 'string' ? Schema.fromJson(rule) : Schema.create(rule);
      var validation = Schema.validate(r);
      if (!validation.valid) {
        console.warn('[Kazumi] \u89c4\u5219[' + r.name + '] \u9a8c\u8bc1\u4e0d\u901a\u8fc7\uff0c\u5c06\u4ecd\u7136\u5b58\u5165\u4f46\u4e0d\u53c2\u4e0e\u641c\u7d22: ' + validation.errors.join('; '));
      }

      // 替换同名规则或追加
      var found = false;
      for (var i = 0; i < rules.length; i++) {
        if (rules[i].name.toLowerCase() === r.name.toLowerCase()) {
          rules[i] = r;
          found = true;
          break;
        }
      }
      if (!found) rules.push(r);
      save();
      return r;
    }

    /** 按名称移除规则 */
    function remove(name) {
      var key = name.toLowerCase();
      rules = rules.filter(function (r) { return r.name.toLowerCase() !== key; });
      save();
    }

    /** 获取所有规则 */
    function list() {
      return rules.slice(); // 返回副本
    }

    /** 按名称获取规则 */
    function get(name) {
      var key = name.toLowerCase();
      for (var i = 0; i < rules.length; i++) {
        if (rules[i].name.toLowerCase() === key) return rules[i];
      }
      return null;
    }

    /** 获取启用的 XPath 规则（用于搜索）*/
    function getEnabledXpathRules() {
      return rules.filter(function (r) {
        return r.searchMode === Schema.RULE_MODE.XPATH &&
               Schema.validate(r).valid;
      });
    }

    /**
     * 用所有启用的 XPath 规则并行搜索
     *
     * @param {string} keyword - 关键词
     * @returns {Promise<Array<{ruleName:string,items:Array}>>}
     */
    async function searchAll(keyword) {
      var enabledRules = getEnabledXpathRules();
      if (enabledRules.length === 0) return [];

      var results = await Promise.allSettled(
        enabledRules.map(function (rule) {
          return engine.search(rule, keyword).then(function (trace) {
            return {
              ruleName: rule.name,
              items: trace.items,
              diagnostics: trace.diagnostics
            };
          });
        })
      );

      return results
        .filter(function (r) { return r.status === 'fulfilled'; })
        .map(function (r) { return r.value; })
        .filter(function (r) { return r.items && r.items.length > 0; });
    }

    /**
     * 查询单个规则的章节列表
     *
     * @param {Object|string} rule - 规则对象或名称
     * @param {string} sourceUrl - 详情页链接
     * @returns {Promise<{roads:Array}>}
     */
    async function getChapters(rule, sourceUrl) {
      var r = typeof rule === 'string' ? get(rule) : rule;
      if (!r) throw new Error('\u89c4\u5219\u4e0d5b58\u5728: ' + rule);
      return engine.queryChapters(r, sourceUrl);
    }

    /** 导入规则 JSON（支持批量：单条对象/字符串、数组、多规则数组） */
    function importRules(jsonOrArray) {
      var arr;
      if (typeof jsonOrArray === 'string') {
        try { arr = JSON.parse(jsonOrArray); }
        catch (e) {
          console.warn('[Kazumi] 规则 JSON 解析失败:', e.message);
          return [];
        }
      } else if (Array.isArray(jsonOrArray)) {
        arr = jsonOrArray;
      } else {
        arr = [jsonOrArray];
      }

      // 关键修复：单条规则 JSON 经 JSON.parse 后为对象（无 .length），
      // 必须统一包成数组，否则下方 for 循环因 i < undefined 直接不执行，
      // 导致「粘贴/从文件导入单条规则」被静默丢弃（此前 UI 与测试脚本均踩中）。
      if (!Array.isArray(arr)) arr = [arr];

      var added = [];
      for (var i = 0; i < arr.length; i++) {
        try {
          var r = addOrUpdate(arr[i]);
          added.push(r.name);
        } catch (e) {
          console.warn('[Kazumi] \u8df3\u5165\u89c4\u5219[' + i + '] \u5931\u8d25:', e.message);
        }
      }
      return added;
    }

    return {
      // 规则 CRUD
      load: load,
      save: save,
      addOrUpdate: addOrUpdate,
      remove: remove,
      list: list,
      get: get,
      getEnabledXpathRules: getEnabledXpathRules,
      importRules: importRules,

      // 核心功能
      searchAll: searchAll,
      getChapters: getChapters,
      search: function (rule, keyword) { return engine.search(rule, keyword); },
      queryChapters: function (rule, src) { return engine.queryChapters(rule, src); },

      // 子模块引用（供高级用法）
      engine: engine,
      schema: Schema,
      urlUtils: UrlUtils,
      httpClient: HttpClient,
      xpathEngine: XPathEngine
    };
  }

  return {
    createRuleManager: createRuleManager
  };

});
