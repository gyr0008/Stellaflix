/*
 * Stellaflix 影视模块 — 片源管理与 CMS10 协议层（阶段 1 · IO 层）
 *
 * 本文件在 sources-core.js 建立的 SFV.sources facade 之上叠加「网络 IO 层」
 * （testSource / testUrl / search / detail 等）。纯函数、存储、缓存层见 sources-core.js。
 *
 * 【合规红线 · 不可协商】
 *   出厂 sources 列表为空数组，全部由用户在「视觉控制台 → 片源」分页手动导入。
 *   Stellaflix 不存储、不提供任何视频资源，仅充当用户自备资源的播放器。
 *
 * 【CMS10（苹果 CMS V10）接口约定】见 sources-core.js 头部说明。
 *
 * 【分层】
 *   - 纯函数/存储/缓存层：sources-core.js（不碰 DOM、不发请求，可在 vm 沙箱验证）。
 *   - IO 层（本文件）：经 /api/proxy 走服务端，规避渲染进程 CORS 与混合内容限制；
 *     超时用 AbortController 熔断，单站失败降级不阻断整体。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  // 核心层（存储 + 纯函数 + 缓存）已由 sources-core.js 建立；本文件仅叠加 IO 层。
  var S = SFV.sources;
  if (!S || !S.__core) {
    throw new Error('[sources.js] sources-core.js 必须先于本文件加载（SFV.sources 核心层缺失）');
  }

  var DEFAULT_TIMEOUT = 12000;

  // ---------------------------------------------------------------- IO

  function proxied(url) {
    if (SFV.source && typeof SFV.source.toProxyUrl === 'function') return SFV.source.toProxyUrl(url);
    return '/api/proxy?url=' + encodeURIComponent(url);
  }

  function fetchJson(url, timeout) {
    var ms = timeout || DEFAULT_TIMEOUT;
    if (typeof global.fetch !== 'function') {
      return Promise.reject(new Error('fetch-unavailable'));
    }
    var ctrl = null, timer = null;
    var opts = {};
    if (typeof global.AbortController === 'function') {
      ctrl = new global.AbortController();
      opts.signal = ctrl.signal;
    }
    var p = global.fetch(proxied(url), opts).then(function (res) {
      if (!res || !res.ok) throw new Error('http-' + (res ? res.status : 'null'));
      return res.text();
    }).then(function (text) {
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new Error('invalid-json');
      }
    });
    if (ctrl) {
      timer = global.setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, ms);
      p = p.then(function (v) { global.clearTimeout(timer); return v; },
                 function (e) { global.clearTimeout(timer); throw e; });
    }
    return p;
  }

  /**
   * 依次尝试多个 URL，返回首个成功的 JSON。
   */
  function fetchFirstJson(urls, timeout) {
    return new Promise(function (resolve, reject) {
      var i = 0;
      var lastErr = null;
      function tryNext() {
        if (i >= urls.length) {
          reject(lastErr || new Error('all-urls-failed'));
          return;
        }
        fetchJson(urls[i++], timeout).then(resolve).catch(function (e) {
          lastErr = e;
          tryNext();
        });
      }
      tryNext();
    });
  }

  /**
   * 对单个媒体/episode URL 做轻量 HEAD 探测。
   * 部分 CDN 对 HEAD 返回 405，仍视为「可响应」；超时/网络错误视为失效。
   * @returns {Promise<{ok:boolean, status:number, reason:string|null}>}
   */
  function testUrl(url, timeout) {
    var ms = timeout || 5000;
    if (typeof global.fetch !== 'function') return Promise.resolve({ ok: false, status: 0, reason: 'fetch-unavailable' });
    var ctrl = null, timer = null;
    var opts = { method: 'HEAD' };
    if (typeof global.AbortController === 'function') {
      ctrl = new global.AbortController();
      opts.signal = ctrl.signal;
    }
    var p = global.fetch(proxied(url), opts).then(function (res) {
      // 405 Method Not Allowed 说明服务器在线但不支持 HEAD，仍算可达
      return { ok: res.ok || res.status === 405, status: res.status, reason: null };
    }).catch(function (e) {
      return { ok: false, status: 0, reason: (e && e.message) ? e.message : 'error' };
    });
    if (ctrl) {
      timer = global.setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, ms);
      p = p.then(function (v) { global.clearTimeout(timer); return v; }, function (e) { global.clearTimeout(timer); throw e; });
    }
    return p;
  }

  /**
   * 连通性测试：请求一页列表，能解析出数组即视为可用。
   * @returns {Promise<{ok:boolean, count:number, reason:string|null, ms:number}>}
   */
  function testSource(source, timeout) {
    var t0 = Date.now();
    var n = S.normalizeSource(source);
    if (!n.ok) return Promise.resolve({ ok: false, count: 0, reason: n.reason, ms: 0 });
    return fetchJson(S.buildListUrl(n.source, { ac: 'videolist', pg: 1 }), timeout).then(function (json) {
      var list = S.extractList(json);
      return { ok: list.length > 0, count: list.length,
               reason: list.length ? null : 'empty-list', ms: Date.now() - t0 };
    }).catch(function (e) {
      return { ok: false, count: 0, reason: (e && e.message) || 'error', ms: Date.now() - t0 };
    });
  }

  /**
   * 聚合搜索：并发请求所有启用源，单站失败/超时降级为空，不阻断整体。
   * @returns {Promise<{items:Array, errors:Array<{sourceId,name,reason}>}>}
   */
  function search(keyword, opts) {
    opts = opts || {};
    var kw = String(keyword == null ? '' : keyword).trim();
    if (!kw) return Promise.resolve({ items: [], errors: [] });
    var list = opts.sources || S.getEnabledSources();
    console.log('[SFV-DEBUG] sources.search: enabled sources=' + list.length);
    if (!list.length) return Promise.resolve({ items: [], errors: [], noSource: true });

    // 纯排除模型：排除维度在 online.js 层客户端过滤，此处不再接收年份服务端过滤。
    // 保留 filters 透传位（未来若片源支持分类/地区服务端排除可在此启用），当前仅作占位。
    var filters = opts.filters || {};
    var errors = [];
    var jobs = list.map(function (src) {
      var url = S.buildListUrl(src, {
        ac: 'videolist', wd: kw, pg: opts.pg || 1,
        h: filters.year != null ? filters.year : null
      });
      console.log('[SFV-DEBUG] sources.search fetching: ' + src.name + ' -> ' + url);
      return fetchJson(url, opts.timeout)
        .then(function (json) {
          var extracted = S.extractList(json);
          console.log('[SFV-DEBUG] sources.search response: ' + src.name + ' count=' + extracted.length);
          return extracted.map(function (raw) { return S.normalizeVod(raw, src); })
            .filter(Boolean);
        })
        .catch(function (e) {
          console.log('[SFV-DEBUG] sources.search error: ' + src.name + ' reason=' + ((e && e.message) || 'error'));
          errors.push({ sourceId: src.id, name: src.name, reason: (e && e.message) || 'error' });
          return [];
        });
    });

    return Promise.all(jobs).then(function (chunks) {
      var flat = [];
      for (var i = 0; i < chunks.length; i++) flat = flat.concat(chunks[i]);
      console.log('[SFV-DEBUG] sources.search total normalized=' + flat.length + ', deduped=' + S.dedupe(flat).length + ', errors=' + errors.length);
      return { items: S.dedupe(flat), errors: errors, raw: flat };
    });
  }

  /**
   * 取详情（含播放地址）。搜索结果已带 playUrl 时可跳过。
   * 支持镜像回退与缓存快照：主 API 与镜像均失败时，返回未过期的缓存 plays。
   * @returns {Promise<{ok:boolean, vod:Object|null, plays:Array, reason:string|null, fromCache?:boolean}>}
   */
  function detail(source, vodId, timeout) {
    // 兼容调用方传入 sourceId 字符串的场景（detail.js/hall.js 搜索结果只携带 id，不含 api）
    if (typeof source === 'string') {
      var found = null;
      var all = S.getSources();
      for (var i = 0; i < all.length; i++) {
        if (all[i] && all[i].id === source) { found = all[i]; break; }
      }
      if (!found) return Promise.resolve({ ok: false, vod: null, plays: [], reason: 'source-not-found' });
      source = found;
    }
    var n = S.normalizeSource(source);
    if (!n.ok) return Promise.resolve({ ok: false, vod: null, plays: [], reason: n.reason });
    var cacheKey = n.source.id + ':' + vodId;
    var cache = S.readDetailCache(cacheKey);

    var urls = [S.buildDetailUrl(n.source, vodId)];
    (n.source.mirrors || []).forEach(function (m) { urls.push(S.buildDetailUrlWithApi(m, vodId)); });

    return fetchFirstJson(urls, timeout).then(function (json) {
      var list = S.extractList(json);
      if (!list.length) return { ok: false, vod: null, plays: [], reason: 'not-found' };
      var vod = S.normalizeVod(list[0], n.source);
      if (!vod) return { ok: false, vod: null, plays: [], reason: 'invalid-record' };
      var plays = S.parsePlayUrl(vod.playFrom, vod.playUrl);
      S.writeDetailCache(cacheKey, { plays: plays, sourceId: n.source.id, vodId: vodId, ts: Date.now() });
      return { ok: true, vod: vod, plays: plays, reason: null };
    }).catch(function (e) {
      if (cache && S.cacheValid(cache.ts)) {
        return { ok: true, vod: null, plays: cache.plays || [], reason: null, fromCache: true };
      }
      return { ok: false, vod: null, plays: [], reason: (e && e.message) || 'error' };
    });
  }

  // ---------------------------------------------------------------- 叠加 IO 层到 facade
  Object.assign(SFV.sources, {
    testSource: testSource,
    testUrl: testUrl,
    search: search,
    detail: detail,
  });
})(typeof window !== 'undefined' ? window : this);
