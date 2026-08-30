/*
 * Stellaflix 影视模块 — 三源统一适配层 · HLS 播放子系统 (拆债 #6)
 *
 * 从 source-adapter.js 抽出的 HLS(.m3u8) 播放驱动：库加载(loadHlsLib)、
 * 代理 loader(makeProxyLoader)、attachHls 编排，以及 HLS 实例状态(activeHls/hlsLibPromise)。
 * （VIDEO_MODULE_PLAN §六.6 单文件 <=500 行约束）
 *
 * 依赖：SFV.sourceAdapterCore（SAC，纯工具）；运行期 SFV.source.tryNativeFallback
 * （回退，留在 source-adapter.js）与 SFV.sourceAdapterDiag.showDiagnosticOverlay。
 *
 * 契约：本文件须在 source-adapter.js 之后加载（SFV.source 已就绪）；
 * source-adapter.js 经 SFV.sourceAdapterHls 委托 attachHls 与 destroy 清理。幂等守卫。
 */
(function (global) {
  'use strict';
  if (!global.StellaflixVideo) global.StellaflixVideo = {};
  var SFV = global.StellaflixVideo;
  if (SFV.sourceAdapterHls) return; // 幂等守卫

  var SAC = SFV.sourceAdapterCore;
  var urlSummary = SAC.urlSummary;
  var looksLikeRealM3u8 = SAC.looksLikeRealM3u8;
  var sanitizeHlsUrl = SAC.sanitizeHlsUrl;
  var _extractDomain = SAC._extractDomain;
  var toProxyUrl = SAC.toProxyUrl;

  // 运行期委托（source-adapter.js 已先于本文件加载，SFV.source 已就绪）
  var tryNativeFallback = (SFV.source && SFV.source.tryNativeFallback) || function () { return Promise.resolve(false); };
  var showDiagnosticOverlay = (SFV.sourceAdapterDiag && SFV.sourceAdapterDiag.showDiagnosticOverlay) || function () {};

  var HLS_LIB_URL = '/vendor/hls.min.js';
  var hlsLibPromise = null;   // 加载中的 Promise，保证只注入一次
  var activeHls = null;       // 当前存活的 Hls 实例，close 时销毁

  function loadHlsLib() {
    if (global.Hls) return Promise.resolve(global.Hls);
    if (hlsLibPromise) return hlsLibPromise;
    hlsLibPromise = new Promise(function (resolve, reject) {
      var d = global.document;
      if (!d || !d.createElement) { reject(new Error('no-document')); return; }
      var s = d.createElement('script');
      s.src = HLS_LIB_URL;
      s.async = true;
      s.onload = function () { resolve(global.Hls); };
      s.onerror = function () { hlsLibPromise = null; reject(new Error('hls-lib-load-failed')); };
      (d.head || d.documentElement || d.body).appendChild(s);
    });
    return hlsLibPromise;
  }

  // makeProxyLoader 保留供特殊场景使用（如服务端需审计/记录媒体流量的部署），
  // 但默认播放路径不再使用——浏览器 <video> 元素对媒体请求 CORS 豁免，
  // hls.js 可直接向 CDN 拉取 m3u8 清单与分片，无需经 /api/proxy 中转。
  // 参考：KVideo (KuekHaoYang/KVideo, MIT) 的 useHlsPlayer.ts 采用同样的直连策略。
  function makeProxyLoader(Hls) {
    var Base = (Hls.DefaultConfig && Hls.DefaultConfig.loader) || global.XMLHttpRequest;
    function ProxyLoader(config) {
      Base.call(this, config);
      this._sfvBase = Base;
    }
    if (Base.prototype) {
      ProxyLoader.prototype = Object.create(Base.prototype);
      ProxyLoader.prototype.constructor = ProxyLoader;
    }
    ProxyLoader.prototype.load = function (context, config, callbacks) {
      if (context && typeof context.url === 'string') {
        context.url = toProxyUrl(context.url);
      }
      this._sfvBase.prototype.load.call(this, context, config, callbacks);
    };
    return ProxyLoader;
  }
  /**
   * 用 hls.js 把一个 .m3u8 原始地址挂载到 video 元素。
   *
   * Sprint A 增强（4 项修复）：
   *   1) URL 诊断日志 — loadSource 前打印完整 URL 和结构分析
   *   2) URL 预清洗 — sanitizeHlsUrl() 修复协议相对/非 ASCII/HTML 实体等
   *   3) 错误 UX 改进 — fatal 时 toast 显示具体类型 + URL 摘要
   *   4) 回退策略 — hls.js 失败且 URL 不像 m3u8 时尝试原生 <video>
   *
   * 策略：hls.js 直连 CDN（不走代理），与 KVideo 成熟方案一致。
   * 浏览器对 <video> 媒体请求 CORS 豁免，无需中转。
   * @param {HTMLVideoElement} videoEl
   * @param {string} rawUrl 原始 m3u8 地址（未代理）
   * @param {object} opts { id, title, onError, onFallback }
   * @returns {Promise<boolean>}
   */
  function attachHls(videoEl, rawUrl, opts) {
    opts = opts || {};
    // 起播会话序号：用于在途异步挂载在"用户退出/换片"后失效，避免退出后仍在后台起播
    var seq = (SFV.player && SFV.player.getPlaybackSeq) ? SFV.player.getPlaybackSeq() : 0;
    if (!videoEl) { if (opts.onError) opts.onError('no-video-el'); return Promise.resolve(false); }

    // ---- Sprint A Fix #1: URL 诊断日志 ----
    if (global.console) {
      global.console.log('[SFV HLS] === attachHls called ===');
      global.console.log('[SFV HLS] rawUrl:', rawUrl);
      global.console.log('[SFV HLS] urlSummary:', urlSummary(rawUrl));
      global.console.log('[SFV HLS] looksLikeRealM3u8:', looksLikeRealM3u8(rawUrl));
    }

    // ---- Sprint A Fix #2: URL 预清洗 ----
    var sanitized = sanitizeHlsUrl(rawUrl);
    var playUrl = sanitized.url;

    if (sanitized.cleaned && global.console) {
      global.console.info('[SFV HLS] URL cleaned (' + sanitized.reason + '):');
      global.console.info('[SFV HLS]   before:', urlSummary(rawUrl));
      global.console.info('[SFV HLS]  after :', urlSummary(playUrl));
    }

    // 如果清洗后 URL 为空或明显无效，提前失败
    if (!playUrl || playUrl.length < 5) {
      var emptyErr = 'URL 预清洗后为空（原始: ' + urlSummary(rawUrl) + '）';
      if (global.console) global.console.error('[SFV HLS]', emptyErr);
      if (opts.onError) opts.onError(emptyErr);

      // ---- Sprint A Fix #4: 回退到原生播放 ----
      return tryNativeFallback(videoEl, rawUrl, Object.assign({}, opts, { seq: seq }));
    }

    return loadHlsLib().then(function (Hls) {
      // 退出/换片竞态：若本次挂载在异步加载 hls.js / 拉取清单期间已失效（player 已关闭或换片），
      // 立即放弃本次挂载，不再 attachMedia / play，避免退出后视频仍在后台起播（有声音无画面）。
      if (SFV.player && SFV.player.isStaleSeq && SFV.player.isStaleSeq(seq)) {
        if (global.console) global.console.log('[SFV HLS] attachHls 已中止：播放会话已失效(seq=' + seq + ')');
        return false;
      }
      if (!Hls || !Hls.isSupported || !Hls.isSupported()) {
        if (global.console) global.console.warn('[SFV HLS] hls.js not supported, trying native fallback');
        if (opts.onError) opts.onError('hls-unsupported');
        // 回退：浏览器可能原生支持 HLS（Safari）
        return tryNativeFallback(videoEl, playUrl, opts);
      }
      if (activeHls) { try { activeHls.destroy(); } catch (e) {} activeHls = null; }

      // 对标 KVideo useHlsPlayer.ts 的成熟配置（缓冲/重试/超时/ABR）
      var hls = new Hls({
        capLevelToPlayerSize: true,
        enableWorker: true,
        maxBufferLength: 120,
        maxMaxBufferLength: 240,
        maxBufferSize: 120 * 1000 * 1000,
        startFragPrefetch: true,
        abrEwmaDefaultEstimate: 500000,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 1000,
        fragLoadingMaxRetryTimeout: 64000,
        manifestLoadingMaxRetry: 4,
        manifestLoadingRetryDelay: 1000,
        manifestLoadingMaxRetryTimeout: 64000,
        levelLoadingMaxRetry: 4,
        levelLoadingRetryDelay: 1000,
        levelLoadingMaxRetryTimeout: 64000,
        fragLoadingTimeOut: 20000,
        manifestLoadingTimeOut: 10000,
        levelLoadingTimeOut: 10000,
        backBufferLength: 90,
      });
      activeHls = hls;

      var networkErrorRetries = 0;
      var mediaErrorRetries = 0;
      var MAX_RETRIES = 3;
      var hlsFailed = false;   // 标记 hls 是否已彻底失败（触发回退）

      hls.on(Hls.Events.MEDIA_ATTACHED, function () {
        // ---- Sprint A Fix #1+: loadSource 时也打日志 ----
        if (global.console) {
          global.console.log('[SFV HLS] loadSource() called with:', urlSummary(playUrl));
        }
        try {
          hls.loadSource(playUrl);
        } catch (e) {
          // 这就是 xlyun 触发的 "Failed to construct 'URL': Invalid URL"
          if (global.console) {
            global.console.error('[SFV HLS] !!! loadSource THREW !!!');
            global.console.error('[SFV HLS] error:', e && (e.message || e.constructor && e.constructor.name) || e);
            global.console.error('[SFV HLS] url was:', playUrl);
            // 超显眼输出：用分隔线包围完整 URL，方便在控制台快速定位
            global.console.error('========== SFV FAILED URL START ==========');
            global.console.error(rawUrl);  // 原始 URL（未清洗）
            global.console.error('playUrl (sanitized):', playUrl);  // 清洗后
            global.console.error('=========== SFV FAILED URL END ===========');
          }
          // 终极兜底：写入全局变量，DevTools Console 输入 __sfv_failed_url 即可查看
          try { global.__sfv_failed_url = rawUrl; global.__sfv_failed_playUrl = playUrl; } catch (ex) {}

          hlsFailed = true;

          // ---- Sprint A Fix #3: 具体化错误信息 ----
          var loadErr = 'HLS URL 无效: ' + (e && e.message ? e.message : 'Unknown error') +
                        ' (URL: ' + urlSummary(playUrl) + ')';
          if (opts.onError) opts.onError(loadErr);

          // ---- Sprint A Fix #5: 立即显示诊断浮层（不等 native fallback）----
          showDiagnosticOverlay(videoEl, rawUrl, loadErr);

          // ---- Sprint A Fix #4: 立即回退原生播放 ----
          tryNativeFallback(videoEl, rawUrl, Object.assign({}, opts, { seq: seq }));
        }
      });

      // 首片加载后尝试 play（更可靠的 autoplay 触发点，对标 KVideo FRAG_LOADED）
      hls.on(Hls.Events.FRAG_LOADED, function (ev, data) {
        // 已失效（退出/换片）则不再起播，避免后台有声无画
        if (SFV.player && SFV.player.isStaleSeq && SFV.player.isStaleSeq(seq)) return;
        if (videoEl && data && data.frag && data.frag.start === 0 && videoEl.paused) {
          var p = videoEl.play();
          if (p && p.catch) p.catch(function () {});
        }
      });

      hls.on(Hls.Events.MANIFEST_PARSED, function () {
        // 已失效（退出/换片）则不再起播，避免后台有声无画
        if (SFV.player && SFV.player.isStaleSeq && SFV.player.isStaleSeq(seq)) return;
        // HEVC 兼容性处理：优先 H.264 level（对标 KVideo）
        if (hls && hls.levels && hls.levels.length > 0) {
          var h264Indices = [];
          var hasHEVC = false;
          for (var i = 0; i < hls.levels.length; i++) {
            var codec = (hls.levels[i].videoCodec || '').toLowerCase();
            if (codec.indexOf('hev') >= 0 || codec.indexOf('h265') >= 0 || codec.indexOf('hvc') >= 0) {
              hasHEVC = true;
            } else {
              h264Indices.push(i);
            }
          }
          if (hasHEVC && h264Indices.length > 0) {
            if (global.console) global.console.info('[SFV source] HEVC detected, locking to H.264 level for compatibility');
            hls.currentLevel = h264Indices[0];
          }
        }
        var p = videoEl.play();
        if (p && p.catch) p.catch(function () {});
      });

      // ---- Sprint A Fix #3: 改进错误 UX ----
      hls.on(Hls.Events.ERROR, function (ev, data) {
        // 记录所有错误（含非致命），便于诊断黑屏/卡顿等播放问题
        if (global.console) {
          var msg = '[SFV source] HLS ' + (data && data.fatal ? 'FATAL' : 'soft') + ': ';
          if (data) msg += (data.type || '?') + '/' + (data.details || '?');
          else msg += 'unknown';
          if (data && data.response) msg += ' status=' + (data.response.code || '?');
          if (data && data.error) msg += ' err=' + (data.error.message || data.error.code || data.error || '');
          if (data.fatal) global.console.error(msg); else global.console.warn(msg);
        }
        if (!data || !data.fatal) return;  // ���致命错误仅记录，不中断

        hlsFailed = true;

        // 构建用户可见的错误消息（具体化，不再笼统）
        var userMsg = '';
        var shouldFallback = false;

        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            networkErrorRetries++;
            if (networkErrorRetries <= MAX_RETRIES) {
              if (global.console) global.console.info('[SFV HLS] Retrying load (' + networkErrorRetries + '/' + MAX_RETRIES + ')...');
              hls.startLoad();
              return; // 重试中，暂不报错给用户
            }
            userMsg = '\u7f51\u7edc\u9519\u8bef\uff1a\u65e0\u6cd5\u52a0\u8f7d\u89c6\u9891\u6d41' +
                      '\uff08\u5df2\u91cd\u8bd5' + MAX_RETRIES + '\u6b21\uff09' +
                      '\n\u7ad9\u70b9\uff1a' + _extractDomain(playUrl) +
                      '\n\u8be6\u60c5\uff1a' + (data.details || 'NETWORK_ERROR');
            shouldFallback = true;
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            mediaErrorRetries++;
            if (mediaErrorRetries <= MAX_RETRIES) {
              if (global.console) global.console.info('[SFV HLS] Recovering media error (' + mediaErrorRetries + '/' + MAX_RETRIES + ')...');
              hls.recoverMediaError();
              return; // 恢复中
            }
            userMsg = '\u5a92\u4f53\u9519\u8bef\uff1a\u89c6\u9891\u683c\u5f0f\u4e0d\u652f\u6301\u6216\u5df2\u635f\u574f' +
                      '\uff08\u5df2\u91cd\u8bd5' + MAX_RETRIES + '\u6b21\uff09' +
                      '\n\u8be6\u60c5\uff1a' + (data.details || 'MEDIA_ERROR');
            shouldFallback = !looksLikeRealM3u8(playUrl); // 非 m3u8 格式才值得回退
            break;
          default:
            // 其他 fatal 错误（包括 URL 构造失败等）
            var detailStr = data.details || (data.error && data.error.message) || String(data);
            userMsg = 'HLS \u64ad\u653e\u5931\u8d25: ' + detailStr +
                      '\nURL: ' + urlSummary(playUrl);
            shouldFallback = true;
            break;
        }

        // 清理 hls 实例
        try { hls.destroy(); } catch (e) {}
        activeHls = null;

        // 通知调用方
        if (opts.onError) opts.onError(userMsg);

        // ---- Sprint A Fix #4: 条件性回退原生播放 ----
        if (shouldFallback) {
          if (global.console) global.console.info('[SFV HLS] Attempting native fallback for:', urlSummary(rawUrl));
          tryNativeFallback(videoEl, rawUrl, Object.assign({}, opts, { seq: seq }));
        } else if (SFV.online && SFV.online.toast) {
          // 不回退但给用户明确提示
          SFV.online.toast(userMsg);
        }
      });

      hls.attachMedia(videoEl);
      if (opts.onReady) opts.onReady();
      return true;
    }).catch(function (err) {
      // hls.js 加载本身失败（库未下载/执行错误）
      if (global.console) {
        global.console.error('[SFV HLS] hls.js library load failed:', err && err.message ? err.message : err);
      }
      if (opts.onError) opts.onError('hls-lib-load-failed');

      // 库加载失败也尝试原生（Safari 可能原生支持 HLS）
      return tryNativeFallback(videoEl, rawUrl, Object.assign({}, opts, { seq: seq }));
    });
  }

  SFV.sourceAdapterHls = {
    attachHls: attachHls,
    loadHlsLib: loadHlsLib,
    makeProxyLoader: makeProxyLoader,
    HLS_LIB_URL: HLS_LIB_URL,
    // [#11] 暴露当前存活的 HLS 实例，供影视态「视频详情」面板读取画质/编码/档位
    getActiveHls: function () { return activeHls; },
    destroy: function () {
      if (activeHls) {
        try { if (activeHls.detachMedia) activeHls.detachMedia(); } catch (e) {}
        try { activeHls.destroy(); } catch (e) {}
        activeHls = null;
      }
    }
  };
})(typeof window !== 'undefined' ? window : this);
