/*
 * Stellaflix 影视模块 — 灯塔模式 · 安全身份 (Phase 2)
 *
 * 对应文档 §7.2 安全模型（替代 Firebase Anonymous Auth + App Check）。
 *  - 本地匿名 deviceId（不关联账号 / 硬件，localStorage 持久）；
 *  - HMAC-SHA256 签名 deviceId+nonce（secret 经运行时配置注入，不硬编码）；
 *  - Turnstile 令牌获取（创建信标 / 房间等"写"操作前）。
 *
 * 纯逻辑 + Web Crypto；vm 可直接加载（注入 window / document / crypto 桩）。
 *
 * 设计层级（诚实说明）：
 *  - 真正防刷屏的主力是 Cloudflare Turnstile（用户无感的人机验证）；
 *  - HMAC 仅作为"无 Turnstile 裸请求"的辅助校验，防止第三方脚本伪造 deviceId；
 *  - secret 在客户端明文是固有局限（逆向可得），故 secret 缺失时跳过签名、
 *    由 Turnstile + 限流兜底——这与 §7.4「secret 经运行时配置注入」一致。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var LH = (SFV.lighthouse = SFV.lighthouse || {});

  // 运行时配置占位（部署时由 Electron main / Worker 握手注入真实值，不硬编码）
  LH.config = LH.config || {};
  var CFG = LH.config;
  if (typeof CFG.online !== 'boolean') CFG.online = false;
  CFG.edgeEndpoint = CFG.edgeEndpoint || '';
  CFG.turnstileSitekey = CFG.turnstileSitekey || '';
  CFG.securitySecret = CFG.securitySecret || '';
  if (CFG.mapTilerKey == null) CFG.mapTilerKey = '';
  CFG.geoFallback = CFG.geoFallback || 'https://ipapi.co/json/';

  var DEVICE_ID_KEY = 'stellaflix-lighthouse-deviceid';

  function getCrypto() {
    // 浏览器：globalThis.crypto（含 subtle + randomUUID）；Node：require('crypto')
    if (typeof crypto !== 'undefined' && crypto.subtle) return crypto;
    try { return require('crypto'); } catch (e) { return null; }
  }

  function ensureDeviceId() {
    try {
      var existing = global.localStorage && global.localStorage.getItem(DEVICE_ID_KEY);
      if (existing) return existing;
    } catch (e) { /* localStorage 不可用时退化 */ }
    var c = getCrypto();
    var id;
    if (c && c.randomUUID) id = c.randomUUID();
    else id = 'd-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { if (global.localStorage) global.localStorage.setItem(DEVICE_ID_KEY, id); } catch (e) {}
    return id;
  }

  function generateNonce() {
    var c = getCrypto();
    if (c && c.getRandomValues) {
      var a = new Uint8Array(16);
      c.getRandomValues(a);
      var s = '';
      for (var i = 0; i < a.length; i++) s += a[i].toString(16).padStart(2, '0');
      return s;
    }
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  // HMAC-SHA256 hex（async，Web Crypto）
  function sign(message, secret) {
    var c = getCrypto();
    if (!c || !c.subtle || !c.subtle.importKey) return Promise.reject(new Error('no-subtle'));
    var enc = new TextEncoder();
    return c.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      .then(function (key) { return c.subtle.sign('HMAC', key, enc.encode(message)); })
      .then(function (buf) {
        var u = new Uint8Array(buf), s = '';
        for (var i = 0; i < u.length; i++) s += u[i].toString(16).padStart(2, '0');
        return s;
      });
  }

  // Turnstile 令牌（无 sitekey / 未启用时返回空串，Worker 端跳过校验）
  function getTurnstileToken() {
    return new Promise(function (resolve) {
      var sitekey = CFG.turnstileSitekey;
      var t = global.turnstile;
      if (!sitekey || !t || !t.render || !global.document) { resolve(''); return; }
      try {
        var div = global.document.createElement('div');
        t.render(div, {
          sitekey: sitekey,
          callback: function (tok) { resolve(tok || ''); },
          'error-callback': function () { resolve(''); },
          'expired-callback': function () { resolve(''); }
        });
      } catch (e) { resolve(''); }
    });
  }

  // 生成一次完整签名包（供 edge.js 复用）
  function makeAuthPayload() {
    var deviceId = ensureDeviceId();
    var nonce = generateNonce();
    if (!CFG.securitySecret) return Promise.resolve({ deviceId: deviceId, nonce: nonce, sig: '' });
    return sign(deviceId + ':' + nonce, CFG.securitySecret)
      .then(function (sig) { return { deviceId: deviceId, nonce: nonce, sig: sig }; });
  }

  LH.security = {
    config: CFG,
    ensureDeviceId: ensureDeviceId,
    getDeviceId: ensureDeviceId,
    generateNonce: generateNonce,
    sign: sign,
    getTurnstileToken: getTurnstileToken,
    makeAuthPayload: makeAuthPayload
  };
})(typeof window !== 'undefined' ? window : this);
