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
      // 归一化：running 布尔 + baseUrl + 接口口令
      d = d && typeof d === 'object' ? d : {};
      d.running = d.state === 'running' && !!d.baseUrl;
      d.baseUrl = d.baseUrl || null;
      d.pwd = typeof d.pwd === 'string' ? d.pwd : '';
      _statusCache = { ts: Date.now(), data: d };
      return d;
    });
  }

  // lite 的接口口令（validatePwd）：配置后每个 /api、/config 请求都要带 ?pwd=，否则 403。
  // 端点由 resolveApi 现拼，故口令也在这里现拼，不进持久化源里的 api 字段。
  function withPwd(url, st) {
    var p = st && st.pwd;
    if (!p) return url;
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'pwd=' + encodeURIComponent(p);
  }

  /**
   * 列出 sidecar 上的规则模块。
   * @returns {Promise<Array<{name:string, module:string, api:string}>>}
   *   name 为展示名（含 (DS) 后缀），module 为 T4 模块名（去后缀），api 为 T4 端点。
   */
  function listModules() {
    return getStatus().then(function (st) {
      if (!st || !st.running || !st.baseUrl) return [];
      return fetchJson(withPwd(st.baseUrl + '/config?healthy=1', st), 10000).then(function (cfg) {
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
   * 按模块名现拼 T4 端点。
   * sidecar 用随机端口，持久化源里的 api 端口在下次启动必然失效，
   * 所以运行时的端点只认这里 = 当前 baseUrl + 模块名。
   * @returns {Promise<string>} 形如 http://127.0.0.1:<port>/api/<module>[?pwd=…]
   */
  function resolveApi(moduleName) {
    var mod = String(moduleName == null ? '' : moduleName).trim();
    if (!mod) return Promise.reject(new Error('empty-module'));
    return getStatus().then(function (st) {
      if (!st || !st.running || !st.baseUrl) throw new Error('sidecar-unavailable');
      return withPwd(st.baseUrl + '/api/' + encodeURIComponent(mod), st);
    });
  }

  /**
   * 把 sidecar 上的模块导入为禁用状态的 drpy 源（用户在片源 UI 里手动启用）。
   * @param {string[]} [onlyModules] 只导入这些模块名（外置规则仓库页面里单行「添加」用）；
   *                                 省略或空数组 = 全部模块。
   * @returns {Promise<{added:number, skipped:number, sources:Array}>}
   */
  function importModules(onlyModules) {
    var want = Array.isArray(onlyModules) && onlyModules.length
      ? onlyModules.map(function (m) { return String(m); }) : null;
    return listModules().then(function (mods) {
      var S = SFV.sources;
      var added = 0, skipped = 0, sources = [];
      mods.forEach(function (m) {
        if (want && want.indexOf(String(m.module)) < 0) return;
        var r = S.addSource({ name: m.name, api: m.api, enabled: false, type: 'drpy', drpyModule: m.module });
        if (r && r.ok) { added += 1; sources.push(r.source); }
        else skipped += 1;
      });
      return { added: added, skipped: skipped, sources: sources };
    });
  }

  // ---------------------------------------------------- 播放地址二次解析

  var _playCache = {}; // key: api + '|' + flag + '|' + id → {r, ts}
  var PLAY_CACHE_TTL = 10 * 60 * 1000;

  /**
   * T4 播放解析：把详情里的集地址换成可播直链。
   *
   * 【字段语义 · 按 drpyS 实源取证，与 TVBox Java 老口径相反】
   *   libs_drpy/drpyCustom.js:44 SPECIAL_URL = /^(ftp|magnet|thunder|ws):/
   *   libs/drpysParser.js:684 playParseAfter → parse = SPECIAL|push ? 0 : 1
   *   即 parse:1 = 普通 http（规则已给可播地址）；parse:0 = 磁力/ftp 等特殊协议。
   *   jx = tellIsJx(url)：1 表示给的是「需要外部嗅探/解析的正版播放页」，不是直链。
   *   header = 规则声明的防盗链头（moduleObject.headers），原样带到集对象上；
   *   起播时由 play-orchestrator 交 SFV.source.setMediaHeaders，经 /api/proxy 的
   *   sfvReferer/sfvUA 参数套用（Referer/UA 有效，Cookie 不通行）。
   *
   * @param {string} api  T4 端点（source.api，须是 resolveApi 现拼出来的当前端点）
   * @param {string} flag 播放源名（vod_play_from 的一段）
   * @param {string} id   集地址（详情返回的原始 url 片段）
   * @returns {Promise<{url:string, parse:number, jx:number, header:Object|null}>}
   */
  function resolvePlay(api, flag, id, timeout) {
    var key = api + '|' + (flag || '') + '|' + id;
    var hit = _playCache[key];
    if (hit && (Date.now() - hit.ts) < PLAY_CACHE_TTL) return Promise.resolve(hit.r);
    // api 可能自带 ?pwd=，此时追加参数走 &（否则第二个 ? 会被当成片段）
    var qs = (api.indexOf('?') >= 0 ? '&' : '?') + 'play=' + encodeURIComponent(id) + '&flag=' + encodeURIComponent(flag || '');
    return fetchJson(api + qs, timeout || 15000).then(function (d) {
      var url = d && d.url ? String(d.url) : '';
      if (!url) throw new Error('play-empty-url');
      var r = {
        url: url,
        parse: d.parse != null ? Number(d.parse) : 1,
        jx: d.jx != null ? Number(d.jx) : 0,
        header: d.header && typeof d.header === 'object' ? d.header : null,
      };
      _playCache[key] = { r: r, ts: Date.now() };
      return r;
    });
  }

  /**
   * 判断某源是否 drpy 类型。
   */
  function isDrpySource(source) {
    return !!(source && source.type === 'drpy');
  }

  /**
   * 外挂规则仓库同步（批 3）：POST /api/drpy/rules/sync。
   * 出厂不内置任何仓库地址；repoUrl 由用户自建/自选（合规红线）。
   * @returns {Promise<{ok:boolean, version?:string, added:number, updated:number, removed:number, reason?:string}>}
   */
  function syncRules(repoUrl) {
    return global.fetch('/api/drpy/rules/sync', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({repoUrl: String(repoUrl || '')}),
    }).then(function (res) { return res.json(); });
  }

  /**
   * 只读预览外挂规则仓库（批 6）：POST /api/drpy/rules/preview。
   * 用户在点「下载规则」之前先在页面上看清仓库里有哪些规则、每条的文案（文案在仓库 manifest 里）。
   * 服务端只拉 manifest，不拉规则正文、不写盘。
   * @returns {Promise<{ok:boolean, version?:string, description?:string, rules?:Array, reason?:string}>}
   */
  function previewRepo(repoUrl) {
    return global.fetch('/api/drpy/rules/preview', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({repoUrl: String(repoUrl || '')}),
    }).then(function (res) { return res.json(); });
  }

  SFV.drpy = {
    __bridge: true,
    getStatus: getStatus,
    listModules: listModules,
    importModules: importModules,
    resolveApi: resolveApi,
    resolvePlay: resolvePlay,
    isDrpySource: isDrpySource,
    syncRules: syncRules,
    previewRepo: previewRepo,
  };
})(typeof window !== 'undefined' ? window : this);
