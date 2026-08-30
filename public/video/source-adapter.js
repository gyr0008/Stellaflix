/*
 * Stellaflix 影视模块 — 三源统一适配层 (Step 3)
 *
 * 职责：把「本地文件 / 直链 URL / HLS(m3u8)」三类来源，归一化成播放器可消费的描述对象。
 *   resolve() 是纯函数（不碰 DOM、不发请求），便于沙箱测试；open() 才真正驱动 player。
 *
 * 合规红线：本文件不预置、不内置任何在线片源（api_site）。所有 URL 均由用户显式提供。
 *   Stellaflix 不存储、不分发任何视频资源。
 *
 * 跨域策略：跨源直链交给 Step1 已实现的 /api/proxy?url=<encoded>（含 SSRF 私网拦截、
 *   Range 透传）。同源与 blob:/file: 一律直连，不绕代理。
 *
 * HLS(.m3u8)：Chromium 系浏览器不原生支持，需 hls.js。本文件负责：
 *   1) 动态加载 hls.js（仅首次，HLS_LIB_URL 为 JS 库 CDN，非片源，不触碰合规红线）；
 *   2) 用自定义 proxy loader 把 playlist 与每个分片请求统一走 /api/proxy（否则分片相对
 *      地址会解析到错误基址）；
 *   3) Safari 等原生支持环境也统一走 hls.js，避免原生播放器无法 hook 代理 loader 导致
 *      跨域分片断流。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  // ---- 纯层委托 ----------------------------------------------------------
  // 所有零依赖归一化 / URL 工具函数已抽到 source-adapter-core.js
  // (SFV.sourceAdapterCore)。本文件仅保留 IO/DOM 播放驱动 + open() 编排。
  // 加载顺序由 index.html 保证：source-adapter-core.js 先于本文件。
  var SAC = SFV.sourceAdapterCore;
  if (!SAC) {
    throw new Error('[SFV source] sourceAdapterCore 未加载，请检查 index.html 加载顺序');
  }
  var PROXY_PATH = SAC.PROXY_PATH;
  var HLS_EXT = SAC.HLS_EXT;
  var FLV_EXT = SAC.FLV_EXT;
  var KNOWN_VIDEO_EXT = SAC.KNOWN_VIDEO_EXT;
  var isFileLike = SAC.isFileLike;
  var parseUrl = SAC.parseUrl;
  var sameOrigin = SAC.sameOrigin;
  var toProxyUrl = SAC.toProxyUrl;
  var basename = SAC.basename;
  var nativeHlsSupported = SAC.nativeHlsSupported;
  var urlSummary = SAC.urlSummary;
  var sanitizeHlsUrl = SAC.sanitizeHlsUrl;
  var looksLikeRealM3u8 = SAC.looksLikeRealM3u8;
  var isHlsUrl = SAC.isHlsUrl;
  var isFlvUrl = SAC.isFlvUrl;
  var _extractDomain = SAC._extractDomain;
  var resolve = SAC.resolve;


  // ------------------------------------------------------------------
  // Sprint A: URL 预清洗 + 诊断 + 错误改进 + 回退策略
  // 目标：解决 xlyun 等"非标准 m3u8 URL"导致 hls.js 构造 URL 失败的黑屏问题。
  // 根因：hls.min.js 内部 new URL() 对某些 CMS 返回的 URL 格式抛 Invalid URL。
  // （相关纯函数 urlSummary / sanitizeHlsUrl / looksLikeRealM3u8 已迁至 source-adapter-core.js）
  // ------------------------------------------------------------------

  // ---------------------------------------------------------------- HLS (hls.js)

  // hls.js 已本地化 vendor 到 public/vendor/hls.min.js（同源静态服务，规避 jsdelivr 国内不可达）。
  // 这是 JS 库而非片源，不触碰合规红线；许可证为 MIT，可自由内置分发。
  // 拆债 #6：HLS 子系统（attachHls/loadHlsLib/makeProxyLoader + 状态）已抽到
  // source-adapter-hls.js；诊断浮层 showDiagnosticOverlay 已抽到 source-adapter-diagnostic.js。
  // 运行期经 SFV.sourceAdapterHls / SFV.sourceAdapterDiag 委托（见底部 facade 与下方别名）。
  var attachHls = function (videoEl, rawUrl, opts) {
    var f = SFV.sourceAdapterHls && SFV.sourceAdapterHls.attachHls;
    return f ? f(videoEl, rawUrl, opts) : (typeof Promise !== 'undefined' ? Promise.resolve(false) : false);
  };
  var showDiagnosticOverlay = function (videoEl, rawUrl, errorMsg) {
    var f = SFV.sourceAdapterDiag && SFV.sourceAdapterDiag.showDiagnosticOverlay;
    if (f) f(videoEl, rawUrl, errorMsg);
  };

  // FLV(.flv)：flv.js 本地化 vendor 到 public/vendor/flv.min.js（同源静态服务）。
  // 许可证 Apache-2.0（与 GPL-3.0 兼容，可自由内置分发；区别于 GSAP 专有许可冲突）。
  var FLV_LIB_URL = '/vendor/flv.min.js';
  var flvLibPromise = null;   // 加载中的 Promise，保证只注入一次
  var activeFlv = null;       // 当前存活的 flv.js 播放器实例，close 时销毁

  // 原生回退挂在 videoEl 上的一次性 error/loadeddata 监听（见 tryNativeFallback）。
  // 退出播放器时若这些监听尚未触发，会残留在复用的 videoEl 上，可能在下次播放时误报诊断，
  // 故在 onPlayerClose 与每次进入回退前清理。
  var _nativeFbListeners = null;
  function clearNativeFbListeners(videoEl) {
    if (_nativeFbListeners && videoEl) {
      try { videoEl.removeEventListener('error', _nativeFbListeners.error); } catch (e) {}
      try { videoEl.removeEventListener('loadeddata', _nativeFbListeners.loaded); } catch (e) {}
    }
    _nativeFbListeners = null;
  }


  // ---------------------------------------------------------------- FLV (flv.js)
  // flv.js 通过 MSE 把 FLV 容器解封装后喂给 <video>。与 hls.js 不同，flv.js 的 IO 走
  // XHR/fetch（受 CORS 约束），因此跨域 FLV 必须经由 /api/proxy 同源中转（resolve()
  // 已对跨域 URL 预置 playUrl=代理地址，此处直接消费 r.playUrl）。
  function loadFlvLib() {
    if (global.flvjs) return Promise.resolve(global.flvjs);
    if (flvLibPromise) return flvLibPromise;
    flvLibPromise = new Promise(function (resolve, reject) {
      var d = global.document;
      if (!d || !d.createElement) { reject(new Error('no-document')); return; }
      var s = d.createElement('script');
      s.src = FLV_LIB_URL;
      s.async = true;
      s.onload = function () { resolve(global.flvjs); };
      s.onerror = function () { flvLibPromise = null; reject(new Error('flv-lib-load-failed')); };
      (d.head || d.documentElement || d.body).appendChild(s);
    });
    return flvLibPromise;
  }

  /**
   * 用 flv.js 把一个 .flv 地址挂载到 video 元素。
   *
   * @param {HTMLVideoElement} videoEl
   * @param {string} flvUrl 已根据跨域/同源确定好的地址（跨域时为 /api/proxy?url=...）
   * @param {object} opts { id, title, onError, onReady }
   * @returns {Promise<boolean>}
   */
  function attachFlv(videoEl, flvUrl, opts) {
    opts = opts || {};
    // 起播会话序号：用于在途异步挂载在"用户退出/换片"后失效，避免退出后仍在后台起播
    var seq = (SFV.player && SFV.player.getPlaybackSeq) ? SFV.player.getPlaybackSeq() : 0;
    if (!videoEl) { if (opts.onError) opts.onError('no-video-el'); return Promise.resolve(false); }
    if (global.console) {
      global.console.log('[SFV FLV] === attachFlv called ===');
      global.console.log('[SFV FLV] url:', urlSummary(flvUrl));
    }
    return loadFlvLib().then(function (flvjs) {
      // 退出/换片竞态：若本次挂载在异步加载 flv.js 期间已失效，立即放弃
      if (SFV.player && SFV.player.isStaleSeq && SFV.player.isStaleSeq(seq)) {
        if (global.console) global.console.log('[SFV FLV] attachFlv 已中止：播放会话已失效(seq=' + seq + ')');
        return false;
      }
      if (!flvjs || !flvjs.isSupported || !flvjs.isSupported()) {
        if (global.console) global.console.warn('[SFV FLV] flv.js not supported, trying native fallback');
        if (opts.onError) opts.onError('flv-unsupported');
        return tryNativeFallback(videoEl, flvUrl, Object.assign({}, opts, { seq: seq }));
      }
      if (activeFlv) { try { activeFlv.destroy(); } catch (e) {} activeFlv = null; }

      var player = flvjs.createPlayer({
        type: 'flv',
        url: flvUrl,
        isLive: false,
        cors: true,
        withCredentials: false
      }, {
        enableStashBuffer: true,
        stashInitialSize: 128,
        // 关闭 Worker：避免打包 Electron 中 worker 脚本路径/同源策略导致硬失败；
        // 主线程解码对常规影视 FLV 足够，且我们此处无法对 Worker 路径做真实验证。
        enableWorker: false,
        lazyLoad: true,
        lazyLoadMaxDuration: 60 * 3,
        lazyLoadRecoverDuration: 30,
        seekType: 'range',
        deferLoadAfterSourceOpen: true
      });
      activeFlv = player;

      player.on(flvjs.Events.ERROR, function (e) {
        if (global.console) global.console.error('[SFV FLV] player error:', e && (e.msg || e.type || e.code) ? (e.msg || e.type || e.code) : e);
        if (opts.onError) opts.onError('FLV 播放失败: ' + (e && (e.msg || e.type) ? (e.msg || e.type) : 'unknown'));
      });

      // 元数据到达即尝试播放（autoplay 触发点）
      player.on(flvjs.Events.METADATA_ARRIVED, function () {
        if (SFV.player && SFV.player.isStaleSeq && SFV.player.isStaleSeq(seq)) return; // 已失效，不再起播
        var p = videoEl.play();
        if (p && p.catch) p.catch(function () {});
      });

      player.attachMediaElement(videoEl);
      player.load();
      var pp = videoEl.play();
      if (pp && pp.catch) pp.catch(function () {});

      if (opts.onReady) opts.onReady();
      return true;
    }).catch(function (err) {
      if (global.console) global.console.error('[SFV FLV] flv.js library load failed:', err && err.message ? err.message : err);
      if (opts.onError) opts.onError('flv-lib-load-failed');
      return tryNativeFallback(videoEl, flvUrl, Object.assign({}, opts, { seq: seq }));
    });
  }

  /**
   * Sprint A Fix #4: HLS 失败后的原生 <video> 回退。
   *
   * 当 hls.js 无法播放某个 URL（非标准 m3u8、flv、mp4 伪装成 m3u8 等），
   * 尝试用 <video>.src= 直接播放。Chromium 原生支持 mp4/webm/ogg，
   * Safari 还额外支持 HLS。这不是万能的，但比纯黑屏好得多。
   *
   * @param {HTMLVideoElement} videoEl
   * @param {string} url 原始 URL（用原始值而非清洗后的，避免过度修改）
   * @param {object} opts { id, title, onError, onFallback }
   * @returns {Promise<boolean>}
   */
  function tryNativeFallback(videoEl, url, opts) {
    opts = opts || {};
    if (!videoEl) return Promise.resolve(false);

    // 退出/换片竞态：本次挂载已失效（用户在异步加载期间退出或切换），直接放弃，不再起播
    if (typeof opts.seq === 'number' && SFV.player && SFV.player.isStaleSeq && SFV.player.isStaleSeq(opts.seq)) {
      return Promise.resolve(false);
    }
    // 清理可能残留的上一次原生回退监听，避免复用的 videoEl 上误报诊断
    clearNativeFbListeners(videoEl);

    if (global.console) {
      global.console.log('[SFV HLS] === Native Fallback ===');
      global.console.log('[SFV HLS] fallback URL:', urlSummary(url));
    }

    try {
      // 先确保没有残留的 hls 实例占用 video 元素（状态已迁至 source-adapter-hls.js）
      if (SFV.sourceAdapterHls && SFV.sourceAdapterHls.destroy) SFV.sourceAdapterHls.destroy();

      // 用原始 URL 直接赋值（不经过代理——浏览器对 media CORS 豁免）
      // 但如果是跨域 URL 且看起来需要代理，则走代理
      var parsed = parseUrl(url);
      var finalUrl = url;
      if (parsed && !sameOrigin(parsed)) {
        finalUrl = toProxyUrl(url);
      }

      videoEl.src = finalUrl;
      videoEl.load();

      // ---- 关键修复：监听异步 video error ----
      // videoEl.src = badUrl 不会同步抛错，浏览器是异步触发 'error' 事件的。
      // 如果不监听这个事件，showDiagnosticOverlay 永远不会被调用。
      var fallbackTriggered = false;
      function onNativeError() {
        if (fallbackTriggered) return;
        fallbackTriggered = true;
        // 移除监听器（一次性）
        try { videoEl.removeEventListener('error', onNativeError); } catch (e) {}
        if (global.console) {
          global.console.error('[SFV HLS] === NATIVE FALLBACK ASYNC ERROR ===');
          global.console.error('[SFV HLS] URL that failed:', url);
        }
        showDiagnosticOverlay(videoEl, url, 'Native <video> async error: URL cannot be played');
        if (SFV.online && SFV.online.toast) {
          SFV.online.toast('\u64ad\u653e\u5931\u8d25\uff1a\u6b64\u683c\u5f0f\u6682\u4e0d\u652f\u6301\nURL: ' + urlSummary(url));
        }
      }
      videoEl.addEventListener('error', onNativeError);

      // 同时也监听 loadeddata 作为"成功"信号（用于清理 listener）
      function onNativeLoaded() {
        if (fallbackTriggered) return;
        try { videoEl.removeEventListener('error', onNativeError); } catch (e) {}
        try { videoEl.removeEventListener('loadeddata', onNativeLoaded); } catch (e) {}
      }
      videoEl.addEventListener('loadeddata', onNativeLoaded);
      // 记录本次回退监听，供退出/换片时清理，避免复用的 videoEl 上误报诊断
      _nativeFbListeners = { error: onNativeError, loaded: onNativeLoaded };

      // 通知调用方已回退
      if (opts.onFallback) {
        opts.onFallback({ method: 'native', url: finalUrl, originalUrl: url });
      }

      // 尝试自动播放
      var playPromise = videoEl.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(function (e) {
          // Autoplay 被阻止是正常的（浏览器策略），不视为失败
          if (global.console) {
            global.console.warn('[SFV HLS] Native fallback autoplay blocked (normal):', e && e.message);
          }
        });
      }

      if (global.console) {
        global.console.info('[SFV HLS] Native fallback applied, src set to:', urlSummary(finalUrl));
      }

      return true;
    } catch (e) {
      if (global.console) {
        global.console.error('[SFV HLS] Native fallback also failed:', e && e.message ? e.message : e);
      }
      // Sprint A Fix #5: 显示诊断浮层（包含完整 URL + 一键复制）
      var natErrMsg = e && e.message ? e.message : (typeof e === 'string' ? e : 'Unknown error');
      showDiagnosticOverlay(videoEl, url, 'Native <video> failed: ' + natErrMsg);
      // toast 作为辅助提示
      if (SFV.online && SFV.online.toast) {
        SFV.online.toast('\u64ad\u653e\u5931\u8d25\uff1a\u6b64\u683c\u5f0f\u6682\u4e0d\u652f\u6301\nURL: ' + urlSummary(url));
      }
      return false;
    }
  }

  /**
   * Sprint A Fix #5: 播放器内诊断浮层。
   *
   * 当所有播放方式（hls.js + 原生 <video>）都失败时，
   * 在 video 元素上方显示一个诊断面板，包含：
   *   - 完整原始 URL（可一键复制）
   *   - URL 类型检测（iframe 包装页 / 非 m3u8 / 可能的格式）
   *   - 错误摘要
   *   - 关闭按钮
   *
   * 用户无需打开 DevTools 就能看到并分享诊断信息。
   *
   * @param {HTMLVideoElement} videoEl
   * @param {string} rawUrl 失败的 URL
   * @param {string} errorMsg 错误描述
   */
  function onPlayerClose() {
    // HLS 实例状态已迁至 source-adapter-hls.js
    if (SFV.sourceAdapterHls && SFV.sourceAdapterHls.destroy) SFV.sourceAdapterHls.destroy();
    if (activeFlv) {
      try { activeFlv.destroy(); } catch (e) {}
      activeFlv = null;
    }
    // 清理可能残留的原生回退监听，避免复用的 videoEl 在下次播放时误报诊断
    if (SFV.player && typeof SFV.player.getVideoEl === 'function') {
      try { clearNativeFbListeners(SFV.player.getVideoEl()); } catch (e) {}
    }
  }

  /**
   * 解析并驱动播放器打开。真正的播放/进度等仍由 player.js 负责。
   * HLS(.m3u8)：统一走 hls.js 动态加载 + 自定义代理 loader 挂载。
   * @returns {boolean|Promise<boolean>} 本地/直链同步返回布尔；HLS 返回 Promise。
   */
  function open(input) {
    var r = resolve(input);
    if (!r.ok) {
      if (global.console) global.console.warn('[SFV source] 无法解析来源:', r.reason, input);
      return false;
    }
    if (!SFV.player) {
      if (global.console) global.console.warn('[SFV source] player 未就绪');
      return false;
    }
    if (r.kind === 'local' && r.file) {
      return SFV.player.openFile(r.file);
    }
    var pid = r.id || ('url:' + r.rawUrl);
    if (r.kind === 'hls') {
      // 用 hls.js 接管（无论浏览器是否原生支持，统一代理 loader 处理跨域分片）
      var videoEl = SFV.player.getVideoEl();
      if (SFV.player.setCurrentUrl) SFV.player.setCurrentUrl(r.rawUrl);
      SFV.player.prepareForPlay(pid, r.title);
      return attachHls(videoEl, r.rawUrl, {
        id: pid, title: r.title,
        onError: function (e) {
          var errMsg = e && e.message ? e.message : (typeof e === 'string' ? e : 'HLS load failed');
          if (global.console) global.console.warn('[SFV source] HLS play error:', errMsg, r.rawUrl);
          // Sprint A Fix #3: toast 只在未回退时显示（attachHls 内部已处理回退场景的 toast）
          // 这里仅作为安全网——如果 attachHls 没触发回退但调了 onError
          if (SFV.online && SFV.online.toast) {
            var displayMsg = errMsg;
            if (displayMsg.length > 200) displayMsg = displayMsg.substring(0, 200) + '...';
            SFV.online.toast('HLS: ' + displayMsg);
          }
        },
        // Sprint A Fix #4: 回退回调 —— 记录回退事件用于统计/诊断
        onFallback: function (info) {
          if (global.console) {
            global.console.info('[SFV source] Used native fallback:', info.method, urlSummary(info.originalUrl));
          }
          // 可选：给用户一个轻量提示（不阻塞播放）
          if (SFV.online && SFV.online.toast) {
            SFV.online.toast('\u5df2\u5207\u6362\u5230\u539f\u751f\u64ad\u653e\u6a21\u5f0f');
          }
        },
      });
    }
    if (r.kind === 'flv') {
      // 跨域 FLV 必须走 /api/proxy（flv.js IO 受 CORS 约束）；resolve() 已把 r.playUrl
      // 对跨域预置为代理地址，同源则等于原始地址，故直接消费 r.playUrl。
      var flvVideoEl = SFV.player.getVideoEl();
      if (SFV.player.setCurrentUrl) SFV.player.setCurrentUrl(r.rawUrl);
      SFV.player.prepareForPlay(pid, r.title);
      return attachFlv(flvVideoEl, r.playUrl, {
        id: pid, title: r.title,
        onError: function (e) {
          var errMsg = e && e.message ? e.message : (typeof e === 'string' ? e : 'FLV load failed');
          if (global.console) global.console.warn('[SFV source] FLV play error:', errMsg, r.rawUrl);
          if (SFV.online && SFV.online.toast) {
            var displayMsg = errMsg;
            if (displayMsg.length > 200) displayMsg = displayMsg.substring(0, 200) + '...';
            SFV.online.toast('FLV: ' + displayMsg);
          }
        }
      });
    }
    // 直链（含原生可播 HLS）：直接交给 player
    return SFV.player.openUrl(r.playUrl, { id: pid, title: r.title });
  }

  SFV.source = {
    resolve: resolve,
    open: open,
    toProxyUrl: toProxyUrl,
    isHlsUrl: isHlsUrl,
    attachHls: attachHls,
    attachFlv: attachFlv,
    loadFlvLib: loadFlvLib,
    makeProxyLoader: function () { var f = SFV.sourceAdapterHls && SFV.sourceAdapterHls.makeProxyLoader; return f ? f.apply(null, arguments) : null; },
    onPlayerClose: onPlayerClose,
    nativeHlsSupported: nativeHlsSupported,
    isFlvUrl: isFlvUrl,
    PROXY_PATH: PROXY_PATH,
    HLS_LIB_URL: (SFV.sourceAdapterHls && SFV.sourceAdapterHls.HLS_LIB_URL) || '/vendor/hls.min.js',
    FLV_LIB_URL: FLV_LIB_URL,
    // Sprint A 工具函数（供诊断和测试使用）
    sanitizeHlsUrl: sanitizeHlsUrl,
    looksLikeRealM3u8: looksLikeRealM3u8,
    urlSummary: urlSummary,
    tryNativeFallback: tryNativeFallback,
    showDiagnosticOverlay: showDiagnosticOverlay,
  };
})(typeof window !== 'undefined' ? window : this);
