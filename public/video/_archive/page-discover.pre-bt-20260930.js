/*
 * Stellaflix 影视模块 — 汇联页（占位页）
 *
 * 占位页：完整功能暂时下线，仅展示占位内容。
 * 原实现（huilian-page.js / huilian-provider-* / huilian-stream.js）仍保留在
 * public/video/ 目录，待恢复时重新挂回 index.html 加载列表。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  function mount(host, ctx) {
    if (SFV.ui && typeof SFV.ui.setTitle === 'function') SFV.ui.setTitle('汇联');
    if (SFV.ui && typeof SFV.ui.setBrowseChrome === 'function') SFV.ui.setBrowseChrome(true);

    host.innerHTML = '';

    var placeholder = document.createElement('div');
    placeholder.className = 'discover-placeholder';
    placeholder.style.cssText = [
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'justify-content:center',
      'height:100%',
      'min-height:400px',
      'color:rgba(255,255,255,0.7)',
      "font-family:'Inter','Noto Sans SC',sans-serif",
      'text-align:center',
      'padding:40px',
      'box-sizing:border-box',
      'pointer-events:none',
      'user-select:none'
    ].join(';');

    var icon = document.createElement('div');
    icon.textContent = '🔗';
    icon.style.cssText = 'font-size:64px;margin-bottom:24px;opacity:0.6;filter:grayscale(0.3);';

    var title = document.createElement('div');
    title.textContent = '汇联';
    title.style.cssText = 'font-size:24px;font-weight:300;letter-spacing:4px;margin-bottom:12px;color:rgba(255,255,255,0.85);';

    var subtitle = document.createElement('div');
    subtitle.textContent = '功能维护中，敬请期待';
    subtitle.style.cssText = 'font-size:14px;opacity:0.5;letter-spacing:2px;';

    placeholder.appendChild(icon);
    placeholder.appendChild(title);
    placeholder.appendChild(subtitle);
    host.appendChild(placeholder);
  }

  function unmount() {}

  function back() {
    unmount();
    return false;
  }

  if (SFV.router && typeof SFV.router.register === 'function') {
    SFV.router.register({ id: 'discover', title: '汇联', mount: mount, unmount: unmount, back: back });
  } else {
    SFV.huilianPage = { mount: mount, unmount: unmount, back: back };
  }
})(typeof window !== 'undefined' ? window : this);
