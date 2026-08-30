/*
 * Stellaflix 影视模块 — 验证码 webview 自动验证弹窗（对齐 Kazumi showCaptchaDialog / submitCaptcha）
 *
 * 触发：多源面板某源搜索抛出 CaptchaRequiredException（桥接层透传为 captcha 态）
 *   → source-picker 错误部件「进行验证」按钮 → 本模块。
 *
 * 行为（1:1 对齐 Kazumi）：
 *   - 用规则的 searchURL（@keyword 替换为编码标题）在 <webview> 中加载搜索页；
 *   - 按 antiCrawlerConfig（captchaImage / captchaButton XPath）轮询检测验证码是否消失，
 *     消失即视为验证通过 → 重新检索该源（对齐 onVerified → querySource）；
 *   - 8 秒安全超时（对齐 Kazumi _captchaVerifyTimer）未验证则关闭；
 *   - 用户也可手动点「验证完成 / 提交」立即重查。
 *
 * 铁律：零业务逻辑进 index.html；须先于本文件加载 source-picker.js（取标题/重试）。
 * 单文件 ≤ 500 行。
 *
 * 验证边界：真实 webview 加载 + 验证码自动检测依赖 Electron 真机（webviewTag:true，
 * 见 desktop/main.js:3144），沙箱不可验证；本模块导出 _test.buildSearchUrl 与
 * showCaptchaDialog 返回的 {verify}，供自动化测试验证 URL 构造与「验证→重查」接线。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  if (SFV.sourcePickerCaptcha) return; // 幂等守卫

  function d() { return global.document; }

  // 纯函数：按规则 searchURL 构造搜索页 URL（@keyword 占位替换为编码标题）。
  function buildSearchUrl(rule, title) {
    var base = (rule && rule.searchURL) || '';
    if (!base) return '';
    return base.replace(/@keyword/g, encodeURIComponent(title || ''));
  }

  // 取规则对象（含 searchURL / antiCrawlerConfig）；缺模块安全降级为 null。
  function getRule(ruleName) {
    try {
      var mgr = SFV.kazumi && SFV.kazumi.getManager && SFV.kazumi.getManager();
      return (mgr && mgr.get) ? mgr.get(ruleName) : null;
    } catch (e) { return null; }
  }

  // 仅 enabled 的 antiCrawlerConfig 才有效。
  function getAntiConfig(ruleName) {
    var rule = getRule(ruleName);
    var ac = rule && rule.antiCrawlerConfig;
    if (ac && ac.enabled) return ac;
    return null;
  }

  // 在 webview 上下文执行的轮询脚本：验证码图片/按钮元素消失即返回 true（已验证）。
  function buildPollJs(antiConfig) {
    var img = (antiConfig && antiConfig.captchaImage) || '';
    var btn = (antiConfig && antiConfig.captchaButton) || '';
    var parts = [];
    if (img) parts.push('if(document.evaluate(' + JSON.stringify(img) + ',document,null,9,null).singleNodeValue)gone=false;');
    if (btn) parts.push('if(document.evaluate(' + JSON.stringify(btn) + ',document,null,9,null).singleNodeValue)gone=false;');
    return '(function(){var gone=true;' + parts.join('') + 'return gone;})()';
  }

  /**
   * 打开验证码验证弹窗（对齐 Kazumi showCaptchaDialog / 自动验证）。
   * @param {string} sourceKey 源隔离键（用于重试回调）
   * @param {string} ruleName  Kazumi 规则名（取 searchURL / antiCrawlerConfig）
   * @param {string} sourceName 展示名
   * @returns {{close:Function, verify:Function}|null}
   */
  function showCaptchaDialog(sourceKey, ruleName, sourceName) {
    var doc = d();
    if (!doc || !doc.body) return null;

    var title = (SFV.sourcePicker && SFV.sourcePicker._test && SFV.sourcePicker._test.getTitle)
      ? SFV.sourcePicker._test.getTitle() : '';
    var rule = getRule(ruleName) || { searchURL: '' };
    var searchUrl = buildSearchUrl(rule, title);
    var anti = getAntiConfig(ruleName);

    var backdrop = doc.createElement('div');
    backdrop.className = 'sfv-picker-captcha-backdrop';
    var card = doc.createElement('div');
    card.className = 'sfv-picker-captcha';

    var head = doc.createElement('div');
    head.className = 'sfv-picker-captcha-head';
    var ht = doc.createElement('span');
    ht.textContent = (sourceName || ruleName) + ' · 验证码验证';
    head.appendChild(ht);
    card.appendChild(head);

    // 真实 webview 加载搜索页（webviewTag:true，见 desktop/main.js:3144）。
    // B1 关键：必须落到专用分区 persist:stellaflix-captcha —— 验证码解出后的 cookie
    // 才会被 desktop/preload.js 的 getCaptchaCookies → stellaflix-get-captcha-cookies
    // 读回并注入重查请求；否则 cookie 落在默认分区，闭环断链（见 kazumi-bridge-captcha.js）。
    var web = doc.createElement('webview');
    web.className = 'sfv-picker-captcha-web';
    if (searchUrl) web.src = searchUrl;
    web.setAttribute('partition', 'persist:stellaflix-captcha');
    web.setAttribute('useragent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36');
    web.setAttribute('nodeintegration', 'false');
    web.setAttribute('contextisolation', 'true');
    web.setAttribute('allowpopups', 'true');
    card.appendChild(web);

    var bar = doc.createElement('div');
    bar.className = 'sfv-picker-captcha-bar';
    function mkBtn(label, primary, fn) {
      var b = doc.createElement('button');
      b.type = 'button';
      b.className = 'sfv-picker-ebtn ' + (primary ? 'sfv-picker-ebtn--primary' : '');
      b.textContent = label;
      b.addEventListener('click', fn);
      return b;
    }
    bar.appendChild(mkBtn('取消', false, function () { close(); }));
    bar.appendChild(mkBtn('验证完成 / 提交', true, function () { onVerified(); }));
    card.appendChild(bar);
    backdrop.appendChild(card);
    doc.body.appendChild(backdrop);
    requestAnimationFrame(function () { if (backdrop) backdrop.classList.add('is-in'); });

    var verified = false, timer = null, pollTimer = null;
    function cleanup() {
      if (timer && global.clearTimeout) { clearTimeout(timer); timer = null; }
      if (pollTimer && global.clearInterval) { clearInterval(pollTimer); pollTimer = null; }
    }
    function onVerified() {
      if (verified) return;
      verified = true;
      cleanup();
      // 对齐 Kazumi onVerified → querySource：重新检索该源（detail-source.retrySource）。
      if (SFV.detailSource && SFV.detailSource.retrySource) {
        SFV.detailSource.retrySource(sourceKey);
      }
      close();
    }
    function close() {
      cleanup();
      if (backdrop && backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    }

    // 自动检测：webview 加载完成后轮询验证码是否消失（对齐 Kazumi submitCaptcha 8s 超时）。
    function startAutoDetect() {
      if (global.setTimeout) {
        timer = global.setTimeout(function () { if (!verified) close(); }, 8000);
      }
      if (global.setInterval && typeof web.executeJavaScript === 'function' && anti) {
        pollTimer = global.setInterval(function () {
          try {
            Promise.resolve(web.executeJavaScript(buildPollJs(anti))).then(function (gone) {
              if (gone) onVerified();
            }).catch(function () {});
          } catch (e) { /* 轮询异常忽略，等下次 */ }
        }, 1000);
      }
    }
    if (typeof web.addEventListener === 'function') {
      web.addEventListener('did-finish-load', startAutoDetect);
      web.addEventListener('dom-ready', startAutoDetect);
    }

    return { close: close, verify: onVerified };
  }

  SFV.sourcePickerCaptcha = {
    showCaptchaDialog: showCaptchaDialog,
    _test: { buildSearchUrl: buildSearchUrl, getAntiConfig: getAntiConfig }
  };
})(typeof window !== 'undefined' ? window : this);
