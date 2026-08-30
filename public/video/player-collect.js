/*
 * Stellaflix 影视模块 — 播放态底部控制栏「收藏到片单」弹窗
 *
 * 需求：
 *   1. 影视态点击底部控制栏「+ 收藏」按钮时，弹出专属片单弹窗；
 *   2. 弹窗内列出用户自建片单夹，支持多选；
 *   3. 提供输入框，可新建片单并同时把当前影片加入该片单；
 *   4. 关闭/确认逻辑、数据渲染、选择状态管理、新建后列表更新；
 *   5. 移动端适配。
 *
 * 实现要点：
 *   - 不改造音乐态的 #collect-modal，而是新建 #sfv-collect-modal，避免污染 700KB music.js；
 *   - 在 DOMContentLoaded 后拦截全局 `openCollectModalForCurrent`：影视态走本弹窗，音乐态仍走原函数；
 *   - 弹窗通过全局 openGsapModal/closeGsapModal 显示/隐藏，modal-video-reparent.js 会自动把它提到 body；
 *   - 数据走 SFV.collections（用户自建片单夹 CRUD 已存在）。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  if (SFV.playerCollect) return;

  var d = global.document;
  var MODAL_ID = 'sfv-collect-modal';
  var selectedIds = {};
  var overrideItem = null; // 外部传入的当前影片（如心动页 hall 调用）
  var opened = false;      // 面板当前是否处于打开态（供外部 ESC 优先级判断）

  function inVideo() {
    var b = d && d.body;
    return !!b && (b.classList.contains('video-player-active') || b.classList.contains('video-space-active'));
  }

  function escHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 稳定 id：优先用 TMDB/业务 id，否则用 title|year|src 哈希
  function hash(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) {
      h = (h << 5) - h + str.charCodeAt(i);
      h |= 0;
    }
    return 'v_' + Math.abs(h).toString(36);
  }

  function currentItem() {
    if (overrideItem) return overrideItem;
    var meta = (SFV.player && SFV.player.getCurrentMeta) ? SFV.player.getCurrentMeta() : null;
    var v = (SFV.player && SFV.player.getVideoEl) ? SFV.player.getVideoEl() : null;
    var title = (meta && (meta.title || meta.name)) || '当前视频';
    var src = (v && v.currentSrc) || (meta && (meta.src || meta.url)) || '';
    var poster = (meta && (meta.cover || meta.pic || meta.poster)) || '';
    var year = (meta && meta.year) || '';
    var rating = (meta && meta.rating) || 0;
    var overview = (meta && meta.overview) || '';
    var id = (meta && (meta.tmdbId || meta.id || meta.seriesKey)) || hash(title + '|' + year + '|' + src);
    return {
      id: id,
      mediaType: (meta && meta.mediaType) || 'movie',
      title: title,
      year: year,
      poster: poster,
      rating: rating,
      overview: overview
    };
  }

  function ensureModal() {
    var m = d.getElementById(MODAL_ID);
    if (m) return m;
    var shell = d.getElementById('desktop-window-shell') || d.body;
    var div = d.createElement('div');
    div.id = MODAL_ID;
    div.className = 'modal-mask sfv-collect-modal-mask';
    div.innerHTML =
      '<div class="modal sfv-collect-modal">' +
        '<h2>收藏到片单</h2>' +
        '<div class="sfv-collect-current">' +
          '<div class="sfv-collect-cover"></div>' +
          '<div class="sfv-collect-meta">' +
            '<div class="sfv-collect-title">当前视频</div>' +
            '<div class="sfv-collect-sub">将加入选中的片单</div>' +
          '</div>' +
        '</div>' +
        '<div class="sfv-collect-new">' +
          '<input type="text" class="sfv-collect-new-input" placeholder="新建片单名称" autocomplete="off" maxlength="40">' +
          '<button class="modal-btn primary sfv-collect-create-btn" type="button">创建并加入</button>' +
        '</div>' +
        '<div class="sfv-collect-list"></div>' +
        '<div class="btn-row">' +
          '<button class="modal-btn sfv-collect-close-btn" type="button">关闭</button>' +
          '<button class="modal-btn primary sfv-collect-confirm-btn" type="button">确认加入</button>' +
        '</div>' +
      '</div>';
    shell.appendChild(div);
    bindModal(div);
    return div;
  }

  function renderCurrent(item) {
    var modal = ensureModal();
    var cover = modal.querySelector('.sfv-collect-cover');
    var title = modal.querySelector('.sfv-collect-title');
    var sub = modal.querySelector('.sfv-collect-sub');
    if (cover) {
      cover.style.backgroundImage = item.poster ? 'url(' + escHtml(item.poster) + ')' : 'none';
      cover.style.backgroundColor = item.poster ? 'transparent' : 'rgba(255,255,255,.08)';
    }
    if (title) title.textContent = item.title;
    if (sub) sub.textContent = item.year ? (item.year + ' · 将加入选中的片单') : '将加入选中的片单';
  }

  function renderList() {
    var modal = ensureModal();
    var list = modal.querySelector('.sfv-collect-list');
    selectedIds = {};
    if (!list) return;
    if (!SFV.collections || !SFV.collections.listUserFolders) {
      list.innerHTML = '<div class="sfv-collect-empty">片单数据未就绪</div>';
      return;
    }
    var folders = SFV.collections.listUserFolders();
    if (!folders.length) {
      list.innerHTML = '<div class="sfv-collect-empty">暂无片单，请在上方新建一个</div>';
      return;
    }
    list.innerHTML = folders.map(function (f) {
      var count = (f.items || []).length;
      return '<label class="sfv-collect-item" data-id="' + escHtml(f.id) + '">' +
        '<input type="checkbox" class="sfv-collect-checkbox" value="' + escHtml(f.id) + '">' +
        '<span class="sfv-collect-item-name">' + escHtml(f.name) + '</span>' +
        '<span class="sfv-collect-item-count">' + count + ' 部</span>' +
      '</label>';
    }).join('');
  }

  function bindModal(modal) {
    modal.addEventListener('click', function (e) {
      if (e.target === modal) close();
    });
    var createBtn = modal.querySelector('.sfv-collect-create-btn');
    if (createBtn) createBtn.addEventListener('click', onCreate);
    var closeBtn = modal.querySelector('.sfv-collect-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', close);
    var confirmBtn = modal.querySelector('.sfv-collect-confirm-btn');
    if (confirmBtn) confirmBtn.addEventListener('click', onConfirm);
    var list = modal.querySelector('.sfv-collect-list');
    if (list) {
      list.addEventListener('change', function (e) {
        if (e.target && e.target.classList.contains('sfv-collect-checkbox')) {
          selectedIds[e.target.value] = !!e.target.checked;
        }
      });
    }
    var input = modal.querySelector('.sfv-collect-new-input');
    if (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') onCreate();
      });
    }
  }

  function onCreate() {
    var modal = ensureModal();
    var input = modal.querySelector('.sfv-collect-new-input');
    var name = input && input.value.trim();
    if (!name) { showToast('请输入片单名称'); return; }
    if (!SFV.collections || !SFV.collections.createUserFolder || !SFV.collections.addUserItem) {
      showToast('片单引擎未就绪'); return;
    }
    var item = currentItem();
    var folderId = SFV.collections.createUserFolder(name);
    SFV.collections.addUserItem(folderId, item);
    if (input) input.value = '';
    renderList();
    var cb = modal.querySelector('.sfv-collect-checkbox[value="' + folderId + '"]');
    if (cb) {
      cb.checked = true;
      selectedIds[folderId] = true;
    }
    showToast('已创建并加入 "' + name + '"');
  }

  function onConfirm() {
    var item = currentItem();
    var ids = Object.keys(selectedIds).filter(function (id) { return selectedIds[id]; });
    if (!ids.length) { showToast('请至少选择一个片单'); return; }
    if (!SFV.collections || !SFV.collections.addUserItem) {
      showToast('片单引擎未就绪'); return;
    }
    var added = 0;
    ids.forEach(function (id) {
      if (SFV.collections.addUserItem(id, item)) added++;
    });
    showToast('已加入 ' + added + ' 个片单');
    close();
  }

  function open(item) {
    if (!inVideo()) return false;
    overrideItem = item || null;
    var item = currentItem();
    renderCurrent(item);
    renderList();
    var modal = ensureModal();
    // 默认挂在 #desktop-window-shell；modal-video-reparent.js 会在 openGsapModal 时提到 body
    var shell = d.getElementById('desktop-window-shell') || d.body;
    if (modal.parentNode !== shell && modal.parentNode !== d.body) shell.appendChild(modal);
    if (typeof global.openGsapModal === 'function') global.openGsapModal(modal);
    else modal.classList.add('show');
    var input = modal.querySelector('.sfv-collect-new-input');
    if (input && typeof input.focus === 'function') input.focus();
    opened = true;
    return true;
  }

  function close() {
    var modal = d.getElementById(MODAL_ID);
    if (!modal) { opened = false; return; }
    if (typeof global.closeGsapModal === 'function') global.closeGsapModal(modal);
    else modal.classList.remove('show');
    opened = false;
  }

  function isOpen() {
    // 标志 + DOM 挂载双重校验：GSAP 显隐走 transform/opacity，不依赖 show 类
    return opened && !!(d.getElementById(MODAL_ID) && d.getElementById(MODAL_ID).isConnected);
  }

  function showToast(msg) {
    if (global.showToast) global.showToast(msg);
    else if (global.console && global.console.log) global.console.log('[sfv-collect]', msg);
  }

  // 必须在 music.js 定义完 openCollectModalForCurrent 后再拦截，否则会被 music.js 覆盖。
  function install() {
    var orig = global.openCollectModalForCurrent;
    global.openCollectModalForCurrent = function () {
      if (inVideo()) { open(); return; }
      if (typeof orig === 'function') return orig.apply(this, arguments);
    };
  }

  if (d && d.readyState !== 'loading') install();
  else if (global.addEventListener) global.addEventListener('DOMContentLoaded', install);

  SFV.playerCollect = { open: open, close: close, isOpen: isOpen, currentItem: currentItem };
})(typeof window !== 'undefined' ? window : this);
