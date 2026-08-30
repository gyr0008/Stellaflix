/*
 * Stellaflix 影视模块 — 三源统一适配层 · 播放诊断浮层 (拆债 #6)
 *
 * 从 source-adapter.js 抽出的 showDiagnosticOverlay（播放失败时在 video 元素上方
 * 显示 URL 类型/错误诊断面板）。纯 DOM，叶子模块，无反向依赖。
 * （VIDEO_MODULE_PLAN §六.6 单文件 <=500 行约束）
 *
 * 契约：本文件须在 source-adapter-core.js 之后、source-adapter.js 之前加载；
 * source-adapter.js 经 SFV.sourceAdapterDiag 委托。幂等守卫。
 */
(function (global) {
  'use strict';
  if (!global.StellaflixVideo) global.StellaflixVideo = {};
  var SFV = global.StellaflixVideo;
  if (SFV.sourceAdapterDiag) return; // 幂等守卫

  function showDiagnosticOverlay(videoEl, rawUrl, errorMsg) {
    if (!global.document) return;
    try {
      // 移除已有的诊断浮层（避免重复）
      var old = global.document.getElementById('sfv-diag-overlay');
      if (old && old.parentNode) old.parentNode.removeChild(old);

      // ---- 关键修复：挂载到 document.body + position:fixed ----
      // #sfv-overlay 设了 overflow:hidden，子元素绝对定位会被裁剪。
      // 用 fixed + body 可以覆盖整个视口，不受任何父容器限制。
      var body = global.document.body;
      if (!body) return;

      // ---- URL 类型检测 ----
      var lower = (rawUrl || '').toLowerCase();
      var urlType = 'unknown';
      var typeHint = '';
      var typeColor = '#ff6b6b'; // red = unsupported

      // 常见的"解析线路"特征：返回的是播放器页面而非视频文件
      if (/player|play\.php|play\.asp|embed|jx|jiexi|parse|api.*\?url=/i.test(lower) ||
          /\?url=https?/.test(lower) || /\?v=.+&/.test(lower)) {
        urlType = 'iframe-wrapper';
        typeHint = '\u89e3\u6790\u5668\u5305\u88c5\u9875\uff08\u975e\u76f4\u63a5\u89c6\u9891\uff09';
        typeColor = '#ffa94d'; // orange = needs special handling
      } else if (/\.flv(\?|#|$)/i.test(rawUrl)) {
        urlType = 'flv';
        typeHint = 'FLV \u683c\u5f0f\uff08flv.js \u64ad\u653e\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u6e90\u662f\u5426\u53ef\u8fbe\uff09';
        typeColor = '#ffa94d';
      } else if (/\.mp4(\?|#|$)/i.test(rawUrl)) {
        urlType = 'mp4';
        typeHint = 'MP4 \u683c\u5f0f\uff08\u5e94\u80fd\u64ad\uff09';
        typeColor = '#69db7c'; // green = should work
      } else if (/\.m3u8(\?|#|$)/i.test(rawUrl)) {
        urlType = 'm3u8';
        typeHint = 'M3U8/HLS \u683c\u5f0f\uff08hls.js \u5931\u8d25\uff09';
        typeColor = '#ffa94d';
      } else if (/^https?:\/\//.test(rawUrl)) {
        // 有协议但无法识别格式
        urlType = 'unrecognized';
        typeHint = '\u65e0\u6cd5\u8bc6\u522b\u7684\u683c\u5f0f';
        typeColor = '#ff6b6b';
      } else {
        urlType = 'invalid';
        typeHint = '\u65e0\u6548 URL';
        typeColor = '#ff6b6b';
      }

      // ---- 构建 DOM ----
      var overlay = global.document.createElement('div');
      overlay.id = 'sfv-diag-overlay';
      overlay.setAttribute('data-sfv-diag', 'true');
      // 样式：半透明深色背景 + 白字 + 居中 + 可滚动长 URL
      overlay.style.cssText =
        'position:fixed;top:0;left:0;right:0;bottom:0;' +
        'background:rgba(0,0,0,0.93);color:#e0e0e0;font-family:monospace,' +
        '"Courier New",Consolas,"Segoe UI",sans-serif;font-size:12px;' +
        'z-index:2147483647;display:flex;flex-direction:column;align-items:center;' +
        'justify-content:center;padding:20px;box-sizing:border-box;overflow:auto;';

      // 内容器（限制最大宽度）
      var inner = global.document.createElement('div');
      inner.style.cssText =
        'max-width:600px;width:100%;background:#1a1a2e;border-radius:8px;' +
        'padding:16px;box-shadow:0 4px 24px rgba(0,0,0,0.5);';

      // 标题行
      var title = global.document.createElement('div');
      title.style.cssText =
        'font-size:14px;font-weight:bold;color:#fff;margin-bottom:12px;' +
        'text-align:center;display:flex;align-items:center;justify-content:center;gap:8px;';
      title.textContent = '\u26a0 \u64ad\u653e\u8bca\u65ad';

      // 类型标签
      var badge = global.document.createElement('span');
      badge.style.cssText =
        'font-size:10px;padding:2px 8px;border-radius:10px;background:' + typeColor + ';color:#fff;';
      badge.textContent = urlType.toUpperCase();
      title.appendChild(badge);
      inner.appendChild(title);

      // 类型提示
      var hint = global.document.createElement('div');
      hint.style.cssText =
        'text-align:center;color:' + typeColor + ';font-size:13px;margin-bottom:12px;font-weight:bold;';
      hint.textContent = typeHint;
      inner.appendChild(hint);

      // 错误信息
      if (errorMsg) {
        var errDiv = global.document.createElement('div');
        errDiv.style.cssText =
          'color:#ff6b6b;font-size:11px;margin-bottom:12px;padding:8px;' +
          'background:rgba(255,107,107,0.15);border-radius:4px;word-break:break-all;';
        errDiv.textContent = '\u9519\u8bef: ' + errorMsg;
        inner.appendChild(errDiv);
      }

      // URL 显示区
      var urlLabel = global.document.createElement('div');
      urlLabel.style.cssText = 'color:#888;font-size:10px;margin-bottom:4px;text-transform:uppercase;';
      urlLabel.textContent = 'Raw URL (click to copy):';
      inner.appendChild(urlLabel);

      var urlBox = global.document.createElement('div');
      urlBox.style.cssText =
        'background:#0d1117;border:1px solid #30363d;border-radius:4px;' +
        'padding:10px;word-break:break-all;max-height:120px;overflow-y:auto;' +
        'cursor:pointer;position:relative;transition:background 0.2s;';
      urlBox.textContent = rawUrl || '(empty)';
      // 点击复制
      urlBox.addEventListener('click', function () {
        if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
          global.navigator.clipboard.writeText(rawUrl || '').then(function () {
            urlBox.style.background = '#1a472a';
            urlBox.setAttribute('data-copied', '1');
            setTimeout(function () {
              urlBox.style.background = '#0d1117';
              urlBox.removeAttribute('data-copied');
            }, 1500);
          }).catch(function () { /* clipboard API failed */ });
        }
      });
      // hover 效果
      urlBox.addEventListener('mouseenter', function () {
        if (!urlBox.getAttribute('data-copied')) urlBox.style.background = '#161b22';
      });
      urlBox.addEventListener('mouseleave', function () {
        if (!urlBox.getAttribute('data-copied')) urlBox.style.background = '#0d1117';
      });
      inner.appendChild(urlBox);

      // 复制提示
      var copyHint = global.document.createElement('div');
      copyHint.style.cssText = 'text-align:center;color:#555;font-size:10px;margin-top:4px;';
      copyHint.textContent = '\u70b9\u51fb\u4e0a\u65b9 URL \u590d\u5236';
      inner.appendChild(copyHint);

      // 操作按钮行
      var btnRow = global.document.createElement('div');
      btnRow.style.cssText =
        'display:flex;gap:8px;justify-content:center;margin-top:14px;flex-wrap:wrap;';

      // 关闭按钮
      var closeBtn = global.document.createElement('button');
      closeBtn.textContent = '\u5173\u95ed';
      closeBtn.style.cssText =
        'padding:6px 16px;border:none;border-radius:4px;background:#333;color:#ccc;' +
        'cursor:pointer;font-size:12px;font-family:inherit;';
      closeBtn.addEventListener('click', function () {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      });
      btnRow.appendChild(closeBtn);

      // 如果是 iframe-wrapper 类型，提供"在浏览器中打开"按钮
      if (urlType === 'iframe-wrapper') {
        var openBtn = global.document.createElement('button');
        openBtn.textContent = '\u5728\u6d4f\u89c8\u5668\u4e2d\u6253\u5f00';
        openBtn.style.cssText =
          'padding:6px 16px;border:none;border-radius:4px;background:#0969da;color:#fff;' +
          'cursor:pointer;font-size:12px;font-family:inherit;';
        openBtn.addEventListener('click', function () {
          if (global.window && global.window.open) {
            global.window.open(rawUrl, '_blank', 'noopener,noreferrer');
          }
        });
        btnRow.appendChild(openBtn);
      }

      inner.appendChild(btnRow);

      // 底部提示
      var footer = global.document.createElement('div');
      footer.style.cssText =
        'text-align:center;color:#444;font-size:9px;margin-top:12px;';
      footer.textContent = 'Stellaflix Diagnostics v1.0 | \u5c06\u6b64\u4fe1\u606f\u5206\u4eab\u7ed9\u5f00\u53d1\u8005\u53ef\u52a9\u6392\u67e5\u95ee\u9898';
      inner.appendChild(footer);

      overlay.appendChild(inner);
      // fixed 定位不需要父元素设 relative
      body.appendChild(overlay);

      // 控制台也打一份完整 URL（方便开发者）
      if (global.console) {
        global.console.error('[SFV DIAG] ===== PLAYBACK FAILURE DIAGNOSTICS =====');
        global.console.error('[SFV DIAG] URL Type:', urlType, '-', typeHint);
        global.console.error('[SFV DIAG] Raw URL:', rawUrl);
        global.console.error('[SFV DIAG] Error:', errorMsg);
        global.console.error('[SFV DIAG] ==========================================');
      }
    } catch (e) {
      // 浮层创建失败不阻塞主流程
      if (global.console) global.console.warn('[SFV] Diagnostic overlay failed:', e && e.message);
    }
  }

  SFV.sourceAdapterDiag = { showDiagnosticOverlay: showDiagnosticOverlay };
})(typeof window !== 'undefined' ? window : this);
