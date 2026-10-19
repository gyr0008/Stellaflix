/*
 * Stellaflix 影视模块 — drpy(T4) 源桥接层（批 2 · 新文件）
 *
 * 职责：
 *   1. 探测本机 drpy-lite sidecar（server.js 的 /api/drpy/status）
 *   2. 列出 sidecar 上可用的规则模块（/config 的 sites）
 *   3. 把模块导入为 SFV.sources 里的 drpy 类型源（出厂不导入，用户手动触发）
 *   4. 播放地址二次解析（T4 ?play=&flag= —— CMS10 直链没有这一步）
 *
 * 【合规红线 · 不可协商】
 *   运行时中立：本文件不含任何站点规则；规则由用户在自己的 sidecar 上自行放置。
 *   导入列表永远来自用户自己启动的 sidecar，Stellaflix 不预置、不推荐任何源。
 *
 * 【协议】T4（TVBox）与 CMS10 同形：
 *   列表/搜索 {api}?ac=videolist&wd=&pg=&t= → {list:[{vod_id,vod_name,...}]}
 *   详情 {api}?ac=detail&ids=               → {list:[{vod_play_from,vod_play_url,...}]}
 *   播放 {api}?play=<集url>&flag=<from>      → {url, parse, jx, header}
 *   因此搜索/详情直接复用 sources.js 的 CMS10 通道，仅播放需二次解析。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  if (SFV.drpy) return; // 幂等守卫

  function fetchJson(url, timeout) {
    var ctl = (global.AbortController) ? new global.AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, timeout || 10000) : null;
    return global.fetch(url, ctl ? {signal: ctl.signal} : {}).then(function (res) {
      if (timer) clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP_' + res.status);
      return res.json();
    }).catch(function (e) {
      if (timer) clearTimeout(timer);
      throw e;
    });
  }

  // ---------------------------------------------------- sidecar 探测

  var _statusCache = { ts: 0, data: null };
  function getStatus(force) {
    if (!force && _statusCache.data && (Date.now() - _statusCache.ts) < 15000) {
      return Promise.resolve(_statusCache.data);
    }
    return fetchJson('/api/drpy/status', 5000).then(function (d) {
      // 归一化：running 布尔 + baseUrl
      d = d && typeof d === 'object' ? d : {};
      d.running = d.state === 'running' && !!d.baseUrl;
      d.baseUrl = d.baseUrl || null;
      _statusCache = { ts: Date.now(), data: d };
      return d;
    });
  }

  /**
   * 列出 sidecar 上的规则模块。
   * @returns {Promise<Array<{name:string, module:string, api:string}>>}
   *   name 为展示名（含 (DS) 后缀），module 为 T4 模块名（去后缀），api 为 T4 端点。
   */
  function listModules() {
    return getStatus().then(function (st) {
      if (!st || !st.running || !st.baseUrl) return [];
      return fetchJson(st.baseUrl + '/config?healthy=1', 10000).then(function (cfg) {
        var sites = (cfg && cfg.sites) || [];
        return sites.map(function (s) {
          var api = String(s.api == null ? '' : s.api);
          var name = String(s.name == null ? '' : s.name);
          // (DS)/(PY)/(PHP) 等引擎后缀 → 模块名
          var module = name.replace(/\([^)]*\)\s*$/, '');
          return { name: name, module: module, api: api };
        });
      });
    });
  }

  /**
   * 把 sidecar 全部模块导入为禁用状态的 drpy 源（用户在片源 UI 里手动启用）。
   * @returns {Promise<{added:number, skipped:number, sources:Array}>}
   */
  function importModules() {
    return listModules().then(function (mods) {
      var S = SFV.sources;
      var added = 0, skipped = 0, sources = [];
      var base = null;
      return getStatus().then(function (st) {
        base = st && st.baseUrl ? st.baseUrl : null;
        mods.forEach(function (m) {
          var r = S.addSource({ name: m.name, api: m.api, enabled: false, type: 'drpy', sidecarBase: base });
          if (r && r.ok) { added += 1; sources.push(r.source); }
          else skipped += 1;
        });
        return { added: added, skipped: skipped, sources: sources };
      });
    });
  }

  // ---------------------------------------------------- 播放地址二次解析

  var _playCache = {}; // key: api + '|' + flag + '|' + id → {url, ts}
  var PLAY_CACHE_TTL = 10 * 60 * 1000;

  /**
   * T4 播放解析：把详情里的集地址换成可播直链。
   * @param {string} api  T4 端点（source.api）
   * @param {string} flag 播放源名（vod_play_from 的一段）
   * @param {string} id   集地址（详情返回的原始 url 片段）
   * @returns {Promise<{url:string, parse:number}>}
   */
  function resolvePlay(api, flag, id, timeout) {
    var key = api + '|' + (flag || '') + '|' + id;
    var hit = _playCache[key];
    if (hit && (Date.now() - hit.ts) < PLAY_CACHE_TTL) {
      return Promise.resolve({ url: hit.url, parse: hit.parse });
    }
    var qs = '?play=' + encodeURIComponent(id) + '&flag=' + encodeURIComponent(flag || '');
    return fetchJson(api + qs, timeout || 15000).then(function (d) {
      var url = d && d.url ? String(d.url) : '';
      var parse = d && d.parse != null ? Number(d.parse) : 0;
      if (!url) throw new Error('play-empty-url');
      _playCache[key] = { url: url, parse: parse, ts: Date.now() };
      return { url: url, parse: parse };
    });
  }

  /**
   * 判断某源是否 drpy 类型。
   */
  function isDrpySource(source) {
    return !!(source && source.type === 'drpy');
  }

  SFV.drpy = {
    __bridge: true,
    getStatus: getStatus,
    listModules: listModules,
    importModules: importModules,
    resolvePlay: resolvePlay,
    isDrpySource: isDrpySource,
  };
})(typeof window !== 'undefined' ? window : this);
