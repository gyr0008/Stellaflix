/*
 * Stellaflix — 多源面板「验证码」webview 弹窗（B1，对齐 Kazumi source_sheet.dart:314-328）
 *
 * 本模块只负责验证码这一态的 webview 弹窗；none/error 两态的错误部件与别名/手动检索
 * 弹窗已内聚在 source-picker.js（B2），此处不重复。
 *
 * 行为（对齐 Kazumi 验证码流程）：
 *   setStatus('captcha') 蓝点 → 用户点「进行验证」→ 打开 <webview> 加载 rule.searchURL
 *   （@keyword 替换为影片名）→ 用户在真实浏览器上下文解出验证码（cookie 落在
 *   persist:stellaflix-captcha 分区）→ 点「已验证，重试」→ detail-source.retrySource
 *   经 IPC 读回该分区 cookie 注入重查请求。
 *
 * ⚠️ <webview> 仅在 Electron 真机可见可交互（主窗口 webviewTag:true）；无头环境该元素
 * 不渲染但 DOM 结构与按钮接线可被 headless 测试覆盖。端到端闭环需 npm start 真机验证。
 *
 * 铁律：零业务逻辑进 index.html；单文件 ≤500 行。
 *
 * 状态说明（2026-08-18）：source-picker.js 的「进行验证」按钮实际调用已加载的
 * SFV.sourcePickerCaptcha.showCaptchaDialog（见 source-picker-captcha.js），本模块
 * 当前未接入活动链路，保留为历史对照参考（不删除）。活动验证码闭环见 source-picker-captcha.js。
 */
(function (global) {
  'use strict';
  if (!global.StellaflixVideo) global.StellaflixVideo = {};
  var SFV = global.StellaflixVideo;
  if (SFV.sourcePickerError) return; // 幂等守卫

  function d() { return global.document; }

  /**
   * 打开验证码 webview 弹窗。
   * 由 source-picker.js 的「进行验证」按钮调用，签名对齐其调用点 (sourceKey, ruleName, name)。
   * 实际的 searchURL/antiConfig/keyword 从 detail-source 的 captchaCtx 取。
   */
  function openCaptchaDialog(sourceKey, ruleName, name) {
    var ctx = (SFV.detailSource && SFV.detailSource.getCaptchaCtx)
      ? SFV.detailSource.getCaptchaCtx(sourceKey) : null;
    if (!ctx) { console.warn('[source-picker-error] 无 captcha 上下文：' + sourceKey); return; }

    var doc = d();
    if (!doc || !doc.body) return;
    var searchURL = (ctx.searchURL || '').replace(/@keyword/g, encodeURIComponent(ctx.keyword || ''));

    var backdrop = doc.createElement('div');
    backdrop.className = 'sfv-picker-dialog-backdrop';
    var panel = doc.createElement('div');
    panel.className = 'sfv-picker-dialog sfv-picker-captcha';

    var h = doc.createElement('div');
    h.className = 'sfv-picker-dialog-title';
    h.textContent = '验证「' + (name || ctx.sourceName || sourceKey) + '」';
    panel.appendChild(h);

    var hint = doc.createElement('div');
    hint.className = 'sfv-picker-dialog-hint';
    hint.textContent = '在下方页面完成验证码，然后点「已验证，重试」。';
    panel.appendChild(hint);

    // Electron 真机：<webview> 真实加载搜索页（主窗口 webviewTag:true）。
    // 无头/沙箱环境该元素不渲染但不抛错，DOM 结构仍可被测试断言。
    var wv = doc.createElement('webview');
    wv.setAttribute('partition', 'persist:stellaflix-captcha');
    wv.setAttribute('src', searchURL);
    wv.className = 'sfv-picker-captcha-webview';
    wv.setAttribute('useragent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36');
    panel.appendChild(wv);

    panel.appendChild(makeBtn('已验证，重试', 'sfv-picker-dialog-confirm', function () {
      closeDialog(backdrop, panel);
      if (SFV.detailSource && SFV.detailSource.retrySource) SFV.detailSource.retrySource(sourceKey);
    }));
    panel.appendChild(makeBtn('关闭', 'sfv-picker-dialog-close', function () { closeDialog(backdrop, panel); }));

    backdrop.appendChild(panel);
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) closeDialog(backdrop, panel); });
    (doc.body || doc.documentElement).appendChild(backdrop);
    (doc.body || doc.documentElement).appendChild(panel);
    requestAnimationFrame(function () { if (panel) panel.classList.add('sfv-picker-dialog-in'); });
  }

  function makeBtn(label, cls, onClick) {
    var b = d().createElement('button');
    b.type = 'button';
    b.className = 'sfv-picker-err-btn ' + (cls || '');
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }
  function closeDialog(backdrop, panel) {
    if (backdrop && backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
  }

  SFV.sourcePickerError = { openCaptchaDialog: openCaptchaDialog };
  if (typeof module === 'object' && module.exports) {
    module.exports = SFV.sourcePickerError;
  }
})(typeof window !== 'undefined' ? window : this);
