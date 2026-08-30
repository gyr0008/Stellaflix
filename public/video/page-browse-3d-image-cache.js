/*
 * Stellaflix 影视模块 — page-browse-3d 的海报图 LRU 子系统（#6-b 抽取）
 *
 * 自拥 imageCache / imageOrder / TEXTURE_MAX / now；零跨模块共享状态（0 桥）。
 * 经 SFV.browse3dImageCache 暴露，page-browse-3d.js 原位置改委托别名，调用点零改动。
 */
(function (global) {
  'use strict';
  if (!global.StellaflixVideo) global.StellaflixVideo = {};
  var SFV = global.StellaflixVideo;
  if (SFV.browse3dImageCache) return; // 幂等守卫

  var TEXTURE_MAX = 80; // 海报图 LRU 上限（每张图独立 Image 对象）

  var imageCache = {};   // url -> { img, at, disposed }
  var imageOrder = [];

  function now() {
    return (global.performance && global.performance.now) ? global.performance.now() : Date.now();
  }

  function evictImages() {
    while (imageOrder.length > TEXTURE_MAX) {
      var url = imageOrder.shift();
      var rec = imageCache[url];
      if (rec) rec.disposed = true;
      delete imageCache[url];
    }
  }
  function getPosterImage(url, onReady) {
    if (!url) { if (onReady) onReady(null); return null; }
    var rec = imageCache[url];
    if (rec && !rec.disposed && rec.img && rec.img.complete && rec.img.naturalWidth) {
      var idx = imageOrder.indexOf(url);
      if (idx !== -1) imageOrder.splice(idx, 1);
      imageOrder.push(url);
      rec.at = now();
      if (onReady) onReady(rec.img);
      return rec.img;
    }
    var img = new Image();
    if ('crossOrigin' in img) { try { img.crossOrigin = 'anonymous'; } catch (e) {} }
    img.onload = function () {
      var r2 = imageCache[url] || (imageCache[url] = { img: null, at: now(), disposed: false });
      r2.img = img; r2.at = now(); r2.disposed = false;
      if (imageOrder.indexOf(url) === -1) imageOrder.push(url);
      evictImages();
      if (onReady) onReady(img);
    };
    img.onerror = function () { if (onReady) onReady(null); };
    img.src = url;
    return null;
  }
  function clearImageCache() {
    imageOrder.forEach(function (url) { var r = imageCache[url]; if (r) r.disposed = true; });
    imageCache = {}; imageOrder = [];
  }

  SFV.browse3dImageCache = {
    getPosterImage: getPosterImage,
    evictImages: evictImages,
    clearImageCache: clearImageCache
  };
})(typeof window !== 'undefined' ? window : this);
