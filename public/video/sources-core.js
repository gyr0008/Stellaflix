/*
 * Stellaflix 影视模块 — 片源纯函数 + 存储 + 缓存层（T-#6-A 从 sources.js 抽出内核）
 *
 * 不碰 DOM、不发请求，可在 vm 沙箱 / node 直接验证。
 * 本文件建立 SFV.sources 的基础 facade（存储 + 缓存 + URL 构造 + 解析纯函数），
 * 由 sources.js 在其上叠加 IO 层（testSource / search / detail 等）。
 *
 * 【合规红线 · 不可协商】
 *   出厂 sources 列表为空数组，本文件不预置、不内置、不硬编码任何站点地址。
 *   Stellaflix 仅充当用户自备资源的播放器。
 *
 * 【CMS10（苹果 CMS V10）接口约定】
 *   列表/搜索：{api}?ac=videolist&wd=<关键词>&pg=<页码>[&t=<分类id>]
 *   详情：    {api}?ac=detail&ids=<vod_id>
 *   播放地址：vod_play_from 用 $$$ 分隔播放源名；vod_play_url 同样用 $$$ 分隔各源，
 *            源内用 # 分隔集，集内用第一个 $ 分隔「集名」与「地址」。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  // 幂等：核心层已由本文件建立则跳过（避免重复加载覆盖 IO 层叠加的方法）。
  if (SFV.sources && SFV.sources.__core) return;

  var NS = 'stellaflix-video-';
  var KEY_SOURCES = NS + 'sources';
  var KEY_DETAIL_CACHE = NS + 'detail-cache';
  var CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 缓存快照 7 天

  // ---------------------------------------------------------------- 存储

  function readJSON(key, fallback) {
    try {
      var raw = global.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function writeJSON(key, val) {
    try {
      global.localStorage.setItem(key, JSON.stringify(val));
      return true;
    } catch (e) {
      return false;
    }
  }

  function genId() {
    return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /**
   * 归一化用户输入的源。返回 {ok, source, reason}。
   * 只接受 http/https；不接受空名或空 api。
   */
  function normalizeSource(input) {
    var out = { ok: false, source: null, reason: null };
    if (!input || typeof input !== 'object') {
      out.reason = 'empty-input';
      return out;
    }
    var name = String(input.name == null ? '' : input.name).trim();
    var api = String(input.api == null ? '' : input.api).trim();
    if (!api) {
      out.reason = 'empty-api';
      return out;
    }
    var u;
    try {
      u = new global.URL(api);
    } catch (e) {
      out.reason = 'invalid-api-url';
      return out;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      out.reason = 'unsupported-scheme:' + u.protocol;
      return out;
    }
    out.ok = true;
    var mirrors = [];
    if (Array.isArray(input.mirrors)) {
      input.mirrors.forEach(function (m) {
        var mapi = String(m == null ? '' : m).trim();
        if (!mapi) return;
        try {
          var mu = new global.URL(mapi);
          if (mu.protocol === 'http:' || mu.protocol === 'https:') mirrors.push(mu.href);
        } catch (e) { /* 忽略非法镜像 */ }
      });
    }
    out.source = {
      id: input.id || genId(),
      name: name || u.hostname,
      api: u.href,
      enabled: input.enabled === false ? false : true,
      addedAt: input.addedAt || Date.now(),
      mirrors: mirrors,
    };
    return out;
  }

  function getSources() {
    var list = readJSON(KEY_SOURCES, []);
    return Array.isArray(list) ? list : [];
  }

  function getEnabledSources() {
    return getSources().filter(function (s) { return s && s.enabled; });
  }

  function addSource(input) {
    var n = normalizeSource(input);
    if (!n.ok) return n;
    var list = getSources();
    // 同 api 视为同源，避免重复导入
    for (var i = 0; i < list.length; i++) {
      if (list[i].api === n.source.api) {
        return { ok: false, source: list[i], reason: 'duplicate-api' };
      }
    }
    list.push(n.source);
    writeJSON(KEY_SOURCES, list);
    return { ok: true, source: n.source, reason: null };
  }

  function updateSource(id, patch) {
    var list = getSources();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) {
        var merged = {};
        for (var k in list[i]) if (Object.prototype.hasOwnProperty.call(list[i], k)) merged[k] = list[i][k];
        for (var k2 in patch) if (Object.prototype.hasOwnProperty.call(patch, k2)) merged[k2] = patch[k2];
        var n = normalizeSource(merged);
        if (!n.ok) return n;
        n.source.id = id;
        list[i] = n.source;
        writeJSON(KEY_SOURCES, list);
        return { ok: true, source: n.source, reason: null };
      }
    }
    return { ok: false, source: null, reason: 'not-found' };
  }

  function removeSource(id) {
    var list = getSources();
    var next = list.filter(function (s) { return s.id !== id; });
    writeJSON(KEY_SOURCES, next);
    return next;
  }

  function setEnabled(id, enabled) {
    return updateSource(id, { enabled: !!enabled });
  }

  // ---------------------------------------------------------------- 详情缓存快照
  function readDetailCache(key) {
    var all = readJSON(KEY_DETAIL_CACHE, {});
    return all[key] || null;
  }
  function writeDetailCache(key, data) {
    var all = readJSON(KEY_DETAIL_CACHE, {});
    all[key] = data;
    writeJSON(KEY_DETAIL_CACHE, all);
  }
  function cacheValid(ts) {
    return !!ts && (Date.now() - ts) < CACHE_TTL;
  }

  // ---------------------------------------------------------------- URL 构造

  function appendQuery(api, params) {
    var qs = [];
    for (var k in params) {
      if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
      var v = params[k];
      if (v === undefined || v === null || v === '') continue;
      qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    }
    if (!qs.length) return api;
    return api + (api.indexOf('?') >= 0 ? '&' : '?') + qs.join('&');
  }

  function buildListUrl(source, opts) {
    opts = opts || {};
    return appendQuery(source.api, {
      ac: opts.ac || 'videolist',
      wd: opts.wd,
      pg: opts.pg,
      t: opts.t,
      h: opts.h,
    });
  }

  function buildDetailUrl(source, ids) {
    return buildDetailUrlWithApi(source.api, ids);
  }

  function buildDetailUrlWithApi(api, ids) {
    return appendQuery(api, { ac: 'detail', ids: ids });
  }

  // ---------------------------------------------------------------- 解析

  /**
   * 解析 CMS10 的 vod_play_from / vod_play_url。
   * @returns {Array<{from:string, episodes:Array<{name:string,url:string,index:number}>}>}
   */
  function parsePlayUrl(playFrom, playUrl) {
    if (!playUrl) return [];
    var froms = String(playFrom == null ? '' : playFrom).split('$$$');
    var groups = String(playUrl).split('$$$');
    var result = [];
    for (var g = 0; g < groups.length; g++) {
      var raw = groups[g];
      if (!raw) continue;
      var eps = [];
      var parts = raw.split('#');
      for (var i = 0; i < parts.length; i++) {
        var seg = parts[i];
        if (!seg) continue;
        var at = seg.indexOf('$');
        var name, url;
        if (at < 0) {
          // 没有集名，整段视为地址
          name = '第' + (eps.length + 1) + '集';
          url = seg;
        } else {
          name = seg.slice(0, at);
          url = seg.slice(at + 1);
        }
        url = String(url).trim();
        if (!url) continue;
        if (!/^https?:/i.test(url)) continue; // 丢弃非 http(s)，防 javascript: 等注入
        eps.push({ name: (name || '').trim() || ('第' + (eps.length + 1) + '集'), url: url, index: eps.length });
      }
      if (eps.length) {
        result.push({ from: (froms[g] || ('源' + (g + 1))).trim(), episodes: eps });
      }
    }
    return result;
  }

  /**
   * 统计 playUrl 的最大分源集数（与 parsePlayUrl 同一切分逻辑，但只计数不解析）。
   * 用于「结构识别」过滤：竖屏短剧通常 60–100+ 集，普通剧集 20–50，电影 1。
   * 注意：CMS10 不提供单集时长，故只能用集数近似识别。
   * @param {string} playUrl - vod_play_url（$$$ 分源，# 分集）
   * @returns {number} 最大分源的有效集数（无播放地址返回 0）
   */
  function countEpisodes(playUrl) {
    if (!playUrl) return 0;
    var groups = String(playUrl).split('$$$');
    var max = 0;
    for (var g = 0; g < groups.length; g++) {
      var raw = groups[g];
      if (!raw) continue;
      var parts = raw.split('#');
      var cnt = 0;
      for (var i = 0; i < parts.length; i++) {
        var seg = parts[i];
        if (!seg) continue;
        var at = seg.indexOf('$');
        var url = at < 0 ? seg : seg.slice(at + 1);
        url = String(url).trim();
        if (!url) continue;
        if (!/^https?:/i.test(url)) continue; // 与 parsePlayUrl 一致：丢弃非 http(s)
        cnt++;
      }
      if (cnt > max) max = cnt;
    }
    return max;
  }

  /**
   * 把 CMS10 的一条 vod 记录归一化为内部结构。
   */
  function normalizeVod(raw, source) {
    if (!raw) return null;
    var id = raw.vod_id != null ? String(raw.vod_id) : '';
    if (!id) return null;
    return {
      key: (source && source.id ? source.id : '?') + ':' + id,
      vodId: id,
      sourceId: source ? source.id : '',
      sourceName: source ? source.name : '',
      title: String(raw.vod_name == null ? '' : raw.vod_name).trim(),
      pic: String(raw.vod_pic == null ? '' : raw.vod_pic).trim(),
      remarks: String(raw.vod_remarks == null ? '' : raw.vod_remarks).trim(),
      year: String(raw.vod_year == null ? '' : raw.vod_year).trim(),
      area: String(raw.vod_area == null ? '' : raw.vod_area).trim(),
      typeName: String(raw.type_name == null ? '' : raw.type_name).trim(),
      content: String(raw.vod_content == null ? '' : raw.vod_content).trim(),
      playFrom: String(raw.vod_play_from == null ? '' : raw.vod_play_from),
      playUrl: String(raw.vod_play_url == null ? '' : raw.vod_play_url),
    };
  }

  /**
   * 从 CMS10 响应体中取出 list 数组（兼容不同站点的包装差异）。
   */
  function extractList(json) {
    if (!json || typeof json !== 'object') return [];
    if (Array.isArray(json.list)) return json.list;
    if (json.data && Array.isArray(json.data)) return json.data;
    if (json.data && Array.isArray(json.data.list)) return json.data.list;
    return [];
  }

  /**
   * 跨源结果归并：同「片名 + 年份」视为同一影片，保留多个来源供切换。
   */
  function dedupe(items) {
    var map = {};
    var order = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || !it.title) continue;
      var k = it.title.toLowerCase() + '|' + (it.year || '');
      if (!map[k]) {
        map[k] = { title: it.title, year: it.year, pic: it.pic, remarks: it.remarks,
                   typeName: it.typeName, content: it.content, variants: [] };
        order.push(k);
      }
      if (!map[k].pic && it.pic) map[k].pic = it.pic;
      if (!map[k].content && it.content) map[k].content = it.content;
      map[k].variants.push(it);
    }
    return order.map(function (k) { return map[k]; });
  }

  // ---------------------------------------------------------------- 建立 facade
  SFV.sources = {
    __core: true,
    KEY: KEY_SOURCES,
    CACHE_KEY: KEY_DETAIL_CACHE,
    // 存储
    getSources: getSources,
    getEnabledSources: getEnabledSources,
    addSource: addSource,
    updateSource: updateSource,
    removeSource: removeSource,
    setEnabled: setEnabled,
    normalizeSource: normalizeSource,
    // 缓存
    readDetailCache: readDetailCache,
    writeDetailCache: writeDetailCache,
    cacheValid: cacheValid,
    // URL 构造
    buildListUrl: buildListUrl,
    buildDetailUrl: buildDetailUrl,
    buildDetailUrlWithApi: buildDetailUrlWithApi,
    // 解析
    parsePlayUrl: parsePlayUrl,
    countEpisodes: countEpisodes,
    normalizeVod: normalizeVod,
    extractList: extractList,
    dedupe: dedupe,
  };
})(typeof window !== 'undefined' ? window : this);
