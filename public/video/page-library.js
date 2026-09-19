/*
 * Stellaflix 影视模块 — 片库页（占位 + 蜂窝卡片墙挂载）
 *
 * 首页「片库」卡入口（原「片单」卡改名）。
 * #sfv-library-wall-host 由 SFV.posterWall 接管；模块未就绪时保留占位文案。
 * 蜂窝几何思路参考 Folia GridView，实现为本仓库 vanilla 模块（poster-wall/hex-wall.js
 * + js/modules/02-visual/16/17 地基）。
 *
 * 双态隔离：仅影视态浏览层 router 页；不触碰音乐态 DOM / shelf。
 * 既有「片单」浏览仍在 router id = 'collections'，页内提供跳转。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  function mount(host) {
    if (SFV.ui && typeof SFV.ui.setTitle === 'function') SFV.ui.setTitle('片库');
    if (SFV.ui && typeof SFV.ui.setBrowseChrome === 'function') SFV.ui.setBrowseChrome(true);
    if (global.document && global.document.body) global.document.body.classList.add('sfv-library-page');

    host.innerHTML = '';
    host.classList.add('sfv-library-host');

    var page = global.document.createElement('div');
    page.className = 'sfv-library-page-inner';

    var hostBox = global.document.createElement('div');
    hostBox.id = 'sfv-library-wall-host';
    hostBox.className = 'sfv-library-wall-host';
    hostBox.setAttribute('data-sfv-library-wall', 'placeholder');
    hostBox.innerHTML =
      '<div class="sfv-library-wall-placeholder">' +
      '<div class="sfv-library-wall-icon" aria-hidden="true">▦</div>' +
      '<div class="sfv-library-wall-title">片库海报墙加载中…</div>' +
      '<div class="sfv-library-wall-hint">挂载点 #sfv-library-wall-host</div>' +
      '</div>';

    var foot = global.document.createElement('div');
    foot.className = 'sfv-library-foot';
    var refreshBtn = global.document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'sfv-library-link';
    refreshBtn.textContent = '刷新片库墙';
    refreshBtn.addEventListener('click', function () {
      if (SFV.posterWall && typeof SFV.posterWall.refresh === 'function') SFV.posterWall.refresh();
    });
    foot.appendChild(refreshBtn);

    page.appendChild(hostBox);
    page.appendChild(foot);
    host.appendChild(page);

    if (SFV.posterWall && typeof SFV.posterWall.mount === 'function') {
      try {
        SFV.posterWall.mount(hostBox);
      } catch (e) {
        if (global.console) console.warn('[page-library] posterWall.mount failed', e);
        hostBox.setAttribute('data-sfv-library-wall', 'error');
      }
    }
  }

  function unmount() {
    if (SFV.posterWall && typeof SFV.posterWall.unmount === 'function') {
      try { SFV.posterWall.unmount(); } catch (e) { /* ignore */ }
    }
    if (global.document && global.document.body) global.document.body.classList.remove('sfv-library-page');
    if (SFV.onlineShared && SFV.onlineShared.overlay && SFV.onlineShared.overlay.classList) {
      SFV.onlineShared.overlay.classList.remove('sfv-library-chrome');
    }
  }

  function back() {
    unmount();
    return false;
  }

  if (SFV.router && typeof SFV.router.register === 'function') {
    SFV.router.register({ id: 'library', title: '片库', mount: mount, unmount: unmount, back: back });
  }

  SFV.pageLibrary = {
    id: 'library',
    title: '片库',
    mount: mount,
    unmount: unmount,
    back: back,
    getWallHost: function () {
      return (typeof document !== 'undefined') ? document.getElementById('sfv-library-wall-host') : null;
    }
  };
})(typeof window !== 'undefined' ? window : this);
