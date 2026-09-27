/*
 * Stellaflix 影视模块 — 灯塔模式 · 地理归属 (Phase 2)
 *
 * 对应文档 §7.3（解决 C4）。
 *  - 优先消费 edge 返回的 request.cf 注入字段（随信标/心跳响应下发）；
 *  - fallback：fetch('https://ipapi.co/json/')（HTTPS 免费档）。
 *
 * 纯逻辑 + fetch；vm 可直接加载（注入 fetch 桩）。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var LH = (SFV.lighthouse = SFV.lighthouse || {});

  var _cachedCf = null; // 最近一次 edge 注入的 request.cf 地理

  // 由 edge.js 在收到含 geo 的响应时调用（缓存，避免重复外网请求）
  function setCfGeo(geo) { if (geo && geo.country) _cachedCf = geo; }

  function emptyGeo() {
    return { country: '', region: '', city: '', lat: 0, lng: 0, source: 'none' };
  }

  // 归一化 ipapi.co 响应字段（字段名不统一）
  function fromIpapi(d) {
    if (!d) return emptyGeo();
    return {
      country: d.country_code || d.country || '',
      region: d.region || d.region_code || '',
      city: d.city || '',
      lat: typeof d.latitude === 'number' ? d.latitude : (typeof d.lat === 'number' ? d.lat : 0),
      lng: typeof d.longitude === 'number' ? d.longitude : (typeof d.lon === 'number' ? d.lon : 0),
      source: 'fallback'
    };
  }

  // 解析本端地理。优先缓存的 request.cf，否则 fetch fallback；失败返回空（不阻塞上线）。
  function resolveGeo() {
    if (_cachedCf) return Promise.resolve(Object.assign({ source: 'cf' }, _cachedCf));
    var url = (LH.config && LH.config.geoFallback) || 'https://ipapi.co/json/';
    if (typeof fetch !== 'function') return Promise.resolve(emptyGeo());
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('geo-http-' + r.status);
      return r.json();
    }).then(fromIpapi).catch(function () { return emptyGeo(); });
  }

  LH.geo = { setCfGeo: setCfGeo, resolveGeo: resolveGeo, emptyGeo: emptyGeo, fromIpapi: fromIpapi };
})(typeof window !== 'undefined' ? window : this);
