/*!
 * 世界页海报提色（轮㉔，主人 2026-10-03 裁决）—— 灯塔色 = 当前播放影片海报色
 *
 * 色源偏差声明（已批）：Apple Music artwork 调色板 API 不可得 → 本地像素量化替代
 * （降采样 RGBA 像素 → 4bit/通道均匀量化 → 众数桶=bg、其余高频桶=候选）。
 * 选取规则逐字 hearthere main.pretty.js：
 *   getLuminance :2059-2061（.299R+.587G+.114B）
 *   getLighthouseColors :2061-2094（text=候选中最亮；lum(bg)>=lum(text)
 *     → colorTop=bg/colorBottom=text，反之互换；bg 或候选缺位 → null）
 * 失败/无 DOM → null 安全降级（数据层散列色兜底，绝不抛给调用方）。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  function getLuminance(rgb) {
    return .299 * rgb[0] + .587 * rgb[1] + .114 * rgb[2];
  }

  function applyHearthereRule(bg, candidates) {
    if (!bg || !candidates || !candidates.length) return null;
    var text = candidates[0];
    var tl = getLuminance(text);
    for (var i = 1; i < candidates.length; i++) {
      var l = getLuminance(candidates[i]);
      if (l > tl) { text = candidates[i]; tl = l; }
    }
    var bl = getLuminance(bg);
    if (bl >= tl) {
      return { colorTop: bg.slice(), colorBottom: text.slice() };
    }
    return { colorTop: text.slice(), colorBottom: bg.slice() };
  }

  // 4bit/通道均匀量化（16^3 桶）：bg=众数桶均值，candidates=其余按频次降序前 4
  function extractFromPixels(pixels) {
    var buckets = {};
    var order = [];
    for (var i = 0; i + 3 < pixels.length; i += 4) {
      if (pixels[i + 3] < 128) continue;
      var r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      var key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      var u = buckets[key];
      if (!u) { u = buckets[key] = { n: 0, r: 0, g: 0, b: 0 }; order.push(key); }
      u.n++; u.r += r; u.g += g; u.b += b;
    }
    if (!order.length) return null;
    order.sort(function (a, c) { return buckets[c].n - buckets[a].n; });
    function avg(key) {
      var u = buckets[key];
      return [Math.round(u.r / u.n), Math.round(u.g / u.n), Math.round(u.b / u.n)];
    }
    return { bg: avg(order[0]), candidates: order.slice(1, 5).map(avg) };
  }

  var results = {};   // url → {colorTop,colorBottom} | null（终态缓存，失败也缓存防重试风暴）
  var inflight = {};  // url → Promise
  var loader = null;  // 测试/特殊环境注入口

  // CDN 缓存毒化对策（probe4/probe5 实测）：无 Origin 请求先到时边缘节点缓存的
  // 副本不带 ACAO，同 URL 的 CORS 模式加载在 Chromium 恒 ERR_FAILED；查询参数绕开。
  function corsBuster(url) {
    if (url.indexOf('sfvpc=') >= 0) return url;
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'sfvpc=1';
  }

  function defaultLoader(url) {
    return new Promise(function (resolve, reject) {
      if (typeof Image !== 'function' || typeof document === 'undefined') {
        reject(new Error('no-dom'));
        return;
      }
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        try {
          var canvas = document.createElement('canvas');
          canvas.width = 48;
          canvas.height = 48;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, 48, 48);
          resolve(ctx.getImageData(0, 0, 48, 48).data);
        } catch (e) { reject(e); }
      };
      img.onerror = function () { reject(new Error('poster-load-failed')); };
      img.src = corsBuster(url);
    });
  }

  function posterColors(url) {
    if (!url || typeof url !== 'string') return Promise.resolve(null);
    if (Object.prototype.hasOwnProperty.call(results, url)) return Promise.resolve(results[url]);
    if (inflight[url]) return inflight[url];
    inflight[url] = (loader || defaultLoader)(url).then(function (pixels) {
      delete inflight[url];
      var ex = pixels ? extractFromPixels(pixels) : null;
      results[url] = ex ? applyHearthereRule(ex.bg, ex.candidates) : null;
      return results[url];
    }, function () {
      delete inflight[url];
      results[url] = null;
      return null;
    });
    return inflight[url];
  }

  // 同步读（渲染装配面用）：就绪→色值；未就绪→触发后台提取（内部去重）并返 null
  function peekColors(url) {
    if (!url) return null;
    if (Object.prototype.hasOwnProperty.call(results, url)) return results[url];
    posterColors(url);
    return null;
  }

  SFV.worldPosterColor = {
    getLuminance: getLuminance,
    applyHearthereRule: applyHearthereRule,
    extractFromPixels: extractFromPixels,
    posterColors: posterColors,
    peekColors: peekColors,
    corsBuster: corsBuster,
    __setPosterLoader: function (fn) { loader = fn; results = {}; inflight = {}; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
