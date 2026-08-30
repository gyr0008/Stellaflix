/*
 * Stellaflix 影视模块 — 多弹幕数据源框架 (sources.js)
 *
 * 统一接口 DanmakuSource（每个弹幕源实现它即可被自动纳入 UI 与合并流程）：
 *   id: string                 唯一标识（'dandanplay' / 'bilibili' / 'gamer' ...）
 *   label: string              面板展示名
 *   requiresCredentials: bool  是否需要用户凭证
 *   applyCredentials(creds)    可选：把凭证写入该源底层客户端
 *   fetchForEpisode(params, ctx) -> Promise<{ entries, origin } | DanmakuEntry[]>
 *       params: { animeTitle, episode }
 *       ctx:    { onProgress(msg) }
 *
 * SourceManager 负责：注册多个源、按需启用/停用、并行拉取、合并去重。
 * mergeEntries 按 (time[归一到 0.1s] | type | message) 去重，跨源的同一弹幕只留一条。
 *
 * 合规与诚实边界：
 *   · 当前唯一「已实现的真实源」是 DanDanPlay（client.js 已忠实重写其 API/签名）；
 *   · B站 / Gamer 等属于各站自有接口，需另行调研实现并通过 registerSource 接入；
 *     本框架保证「任意已注册源」自动出现在 UI 列表与合并流程中，无需改动其余代码；
 *   · 未实现或未注册为真实源的，绝不以 stub 冒充可用源。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var danmaku = (SFV.danmaku = SFV.danmaku || {});

  var KEY_PREFIX = 'stellaflix-danmaku-source-';

  function loadJSON(key, fb) {
    try {
      var raw = global.localStorage && global.localStorage.getItem(key);
      if (!raw) return fb;
      return Object.assign({}, fb, JSON.parse(raw));
    } catch (e) { return fb; }
  }
  function saveJSON(key, obj) {
    try { if (global.localStorage) global.localStorage.setItem(key, JSON.stringify(obj)); } catch (e) {}
  }

  // 跨源去重键：时间归一到 0.1s + 类型 + 文本（同弹幕不同源只留一条）
  function mergeKey(entry) {
    var t = Math.round((entry.time || 0) * 10) / 10;
    return t + '|' + (entry.type || 0) + '|' + (entry.message || '');
  }

  // 合并多个源的弹幕数组：去重 + 按时间排序。
  // keepAll=true 时保留重复（仅用于单测对照），默认去重。
  function mergeEntries(arrays, keepAll) {
    var seen = Object.create(null);
    var out = [];
    for (var s = 0; s < arrays.length; s++) {
      var list = arrays[s] || [];
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (!e) continue;
        var k = mergeKey(e);
        if (seen[k]) { if (keepAll) out.push(e); continue; }
        seen[k] = true;
        out.push(e);
      }
    }
    out.sort(function (a, b) { return (a.time || 0) - (b.time || 0); });
    return out;
  }

  function SourceManager() {
    this.sources = [];                 // 注册顺序
    this.byId = Object.create(null);
    this.enabled = Object.create(null);
  }

  SourceManager.prototype.registerSource = function (src) {
    if (!src || !src.id) throw new Error('SOURCE_NEEDS_ID');
    if (this.byId[src.id]) return false; // 不重复注册
    this.sources.push(src);
    this.byId[src.id] = src;
    // 读取持久化的启用状态（默认启用）
    var saved = loadJSON(KEY_PREFIX + src.id, { enabled: true });
    this.enabled[src.id] = saved.enabled !== false;
    if (saved.creds && src.applyCredentials) {
      try { src.applyCredentials(saved.creds); } catch (e) {}
    }
    return true;
  };

  SourceManager.prototype.getSource = function (id) { return this.byId[id] || null; };

  SourceManager.prototype.listSources = function () {
    var self = this;
    return this.sources.map(function (s) {
      return {
        id: s.id,
        label: s.label,
        requiresCredentials: !!s.requiresCredentials,
        enabled: !!self.enabled[s.id]
      };
    });
  };

  SourceManager.prototype.setEnabled = function (id, on) {
    if (!this.byId[id]) return false;
    this.enabled[id] = !!on;
    var saved = loadJSON(KEY_PREFIX + id, { enabled: true });
    saved.enabled = !!on;
    saveJSON(KEY_PREFIX + id, saved);
    return true;
  };

  SourceManager.prototype.isEnabled = function (id) { return !!this.enabled[id]; };

  SourceManager.prototype.setCredentials = function (id, creds) {
    var src = this.byId[id];
    if (!src) return false;
    if (src.applyCredentials) { try { src.applyCredentials(creds || {}); } catch (e) {} }
    var saved = loadJSON(KEY_PREFIX + id, { enabled: true });
    saved.creds = creds || {};
    saveJSON(KEY_PREFIX + id, saved);
    return true;
  };

  // 并行拉取所有启用源，合并去重。
  // 返回 Promise<DanmakuEntry[]>，附带非枚举属性 _sourcesSucceeded / _sourceErrors 供 UI 提示。
  SourceManager.prototype.fetchAll = function (params, ctx) {
    var self = this;
    var active = this.sources.filter(function (s) { return self.enabled[s.id]; });
    if (!active.length) return Promise.reject(new Error('DANMAKU_NO_SOURCE_ENABLED'));
    var onProgress = ctx && ctx.onProgress;
    var tasks = active.map(function (s) {
      return Promise.resolve(s.fetchForEpisode(params, ctx)).then(function (res) {
        var entries = (res && res.entries) || (Array.isArray(res) ? res : []);
        for (var i = 0; i < entries.length; i++) {
          if (entries[i] && !entries[i].origin) entries[i].origin = s.id;
        }
        if (onProgress) onProgress('[' + s.label + '] 已获取 ' + entries.length + ' 条');
        return entries;
      });
    });
    return Promise.allSettled(tasks).then(function (results) {
      var arrays = [];
      var errors = [];
      results.forEach(function (r) {
        if (r.status === 'fulfilled') arrays.push(r.value);
        else errors.push(r.reason);
      });
      var merged = mergeEntries(arrays);
      Object.defineProperty(merged, '_sourcesSucceeded', { value: arrays.length, enumerable: false });
      Object.defineProperty(merged, '_sourceErrors', { value: errors, enumerable: false });
      return merged;
    });
  };

  // ---------------- 已实现的真实源 ----------------

  // DanDanPlay（复用 client.js 的 API/签名实现，不重复造轮子）
  function DanDanPlaySource() {
    return {
      id: 'dandanplay',
      label: '弹弹play (DanDanPlay)',
      requiresCredentials: true,
      applyCredentials: function (creds) {
        if (SFV.danmaku && SFV.danmaku.client) {
          SFV.danmaku.client.setCredentials(creds.appId || '', creds.appSecret || '');
        }
      },
      fetchForEpisode: function (params, ctx) {
        if (!SFV.danmaku || !SFV.danmaku.client) {
          return Promise.reject(new Error('DANMAKU_CLIENT_MISSING'));
        }
        var onProgress = ctx && ctx.onProgress;
        return SFV.danmaku.client
          .fetchForEpisode(params.animeTitle, params.episode, onProgress)
          .then(function (entries) { return { entries: entries, origin: 'dandanplay' }; });
      }
    };
  }

  // ---------------- 管理器实例 ----------------

  var manager = new SourceManager();

  function registerDefaults() {
    if (!manager.getSource('dandanplay')) manager.registerSource(DanDanPlaySource());
  }

  danmaku.sources = {
    manager: manager,
    registerSource: function (s) { return manager.registerSource(s); },
    getSource: function (id) { return manager.getSource(id); },
    registerDefaults: registerDefaults,
    fetchAll: function (params, ctx) { return manager.fetchAll(params, ctx); },
    listSources: function () { return manager.listSources(); },
    isEnabled: function (id) { return manager.isEnabled(id); },
    setEnabled: function (id, on) { return manager.setEnabled(id, on); },
    setCredentials: function (id, c) { return manager.setCredentials(id, c); },
    mergeEntries: mergeEntries,
    configKey: function (id) { return KEY_PREFIX + id; }
  };

  // 自动注册默认源（无需调用方手动，保证 SFV.danmaku.sources 立即可用）
  registerDefaults();
})(typeof window !== 'undefined' ? window : this);
