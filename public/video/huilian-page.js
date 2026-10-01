/*
 * Stellaflix 影视模块 — 汇联页（BT 磁力播放·最小闭环入口壳）
 * 依赖：window.stellaflixVideo（desktop/preload-video.js 桥）；无桥时整体降级。
 * 生命周期红线：unmount 必须销毁 mpv overlay（Task 7 接入后强制）。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  function bridge() {
    var b = global.stellaflixVideo;
    return (b && b.download && b.player) ? b : null;
  }

  function el(tag, opts) {
    var n = document.createElement(tag);
    if (opts && opts.id) n.setAttribute('id', opts.id);
    if (opts && opts.cls) n.setAttribute('class', opts.cls);
    return n;
  }

  function mount(host) {
    if (SFV.ui && SFV.ui.setTitle) SFV.ui.setTitle('汇联');
    if (SFV.ui && SFV.ui.setBrowseChrome) SFV.ui.setBrowseChrome(true);
    host.innerHTML = '';
    var wrap = el('div', { cls: 'huilian-wrap' });
    var row = el('div', { cls: 'huilian-input-row' });
    var input = el('input', { id: 'huilian-input', cls: 'huilian-input' });
    input.setAttribute('placeholder', '粘贴磁力链接 magnet:...');
    var btn = el('button', { id: 'huilian-add', cls: 'huilian-btn' });
    btn.textContent = '加入下载';
    var list = el('div', { id: 'huilian-tasks', cls: 'huilian-tasks' });
    if (!bridge()) {
      input.disabled = true; btn.disabled = true;
      var hint = el('div', { cls: 'huilian-desk-only' });
      hint.textContent = 'BT 播放需在 Stellaflix 桌面版中使用';
      wrap.appendChild(hint);
    }
    row.appendChild(input); row.appendChild(btn);
    wrap.appendChild(row); wrap.appendChild(list);
    host.appendChild(wrap);
  }

  var page = {
    mount: mount,
    unmount: function () {},          // Task 7 填 overlay 销毁
    back: function () { page.unmount(); return false; },
  };
  if (SFV.router && SFV.router.register) SFV.router.register({ id: 'discover', title: '汇联', mount: mount, unmount: page.unmount, back: page.back });
  else SFV.huilianPage = page;
})(typeof window !== 'undefined' ? window : this);
