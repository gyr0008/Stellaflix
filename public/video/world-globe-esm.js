/*
 * 世界页 hearthere parity 步骤① — ESM 桥接（唯一模块脚本）
 *
 * 加载自包含 bundle（@maptiler/sdk 3.9.0 + maplibre-gl 5.6.2，与 hearthere.live
 * 线上一致，构建留痕见 public/vendor/maptiler/LICENSES.md），挂到
 * window.StellaflixVideo.maptilerGlobe；两份 CSS 以 import.meta.url 解析、
 * 幂等注入，文档路径解耦。步骤②的地球底座在 await ready 后取 Map/config。
 */
(function (global) {
  'use strict';
  var SFV = global.StellaflixVideo = global.StellaflixVideo || {};

  function injectCss(rel) {
    var href = new URL(rel, import.meta.url).href;
    if (global.document.querySelector('link[data-globe-sdk-css="' + href + '"]')) return;
    var l = global.document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    l.setAttribute('data-globe-sdk-css', href);
    global.document.head.appendChild(l);
  }

  var api = {
    Map: null,
    config: null,
    sdk: null,
    ready: null
  };

  api.ready = import('../vendor/maptiler/maptiler-sdk-3.9.0.bundle.mjs').then(function (sdk) {
    injectCss('../vendor/maptiler/maplibre-gl-5.6.2.css');
    injectCss('../vendor/maptiler/maptiler-sdk-3.9.0.css');
    api.sdk = sdk;
    api.Map = sdk.Map;
    api.config = sdk.config;
    return sdk;
  });

  SFV.maptilerGlobe = api;
})(typeof window !== 'undefined' ? window : globalThis);
