/*
 * Stellaflix 影视模块 — 页面背景 DIY（追片 / 片单 / 历史）
 *
 * 行为：
 *   - 三页统一挂载 .sfv-page-bg-layer 玻璃背景层，保留 --saved-panel-glass-* 毛玻璃/内发光质感。
 *   - 追片/历史：支持「玻璃容器底色」切换（浅色半透明 tint），同时同步 .sfv-browse 实底与
 *     html 背景以填满 clip-path 圆角裁切区，避免四角透出黑色/异色。
 *   - 追片/片单：支持自定义图片上传并铺满背景。
 *   - 存储按页隔离：stellaflix-page-bg-diy:<pageId>。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var S = SFV.onlineShared;
  if (!S) { console.warn('[page-bg-diy] onlineShared 未加载，跳过背景 DIY'); return; }

  var FAB = null, MODAL = null;
  var _modalPageId = null;
  var _overlayObserver = null;
  var _syncing = false;

  // 按页隔离存储键（track / history / collections 各自独立）
  function storageKey(pageId) { return 'stellaflix-page-bg-diy:' + (pageId || 'default'); }
  // 预设背景色（浅色系，保证 #1a1a1a 文字对比度；深色需反转文字，本次不纳入）
  var COLOR_PRESETS = [
    { value: '#faf8f5', label: '乳白' },
    { value: '#e9e5de', label: '暖灰' },
    { value: '#f3ece1', label: '米杏' },
    { value: '#e7f2f0', label: '浅青' },
    { value: '#e8edf3', label: '浅蓝灰' },
    { value: '#f0e8ef', label: '浅藕' }
  ];

  // ---------------------------------------------------------------- 持久化（按页隔离）
  function load(pageId) {
    try {
      var raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(storageKey(pageId)) : null;
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function save(pref, pageId) {
    try {
      var key = storageKey(pageId);
      if (pref && pref.type) localStorage.setItem(key, JSON.stringify(pref));
      else localStorage.removeItem(key);
    } catch (e) {}
  }

  // ---------------------------------------------------------------- 页面判定
  // 返回当前四页之一的 id（'track' / 'history' / 'collections' / 'search'），否则 null。
  function getDiyPageId() {
    if (typeof document !== 'undefined' && document.body &&
        !document.body.classList.contains('video-space-active')) return null;
    // 搜索页：独立全屏页，z-index 高于 sfv-overlay，优先判定
    var searchPage = (S.getSearchPage && S.getSearchPage());
    if (searchPage && searchPage.classList.contains('sfv-search-open')) return 'search';
    if (!S.overlay || !S.overlay.classList.contains('sfv-show')) return null;
    // Router 页（movie/anime/world/huilians/collections/history）由 activePageId 识别；
    // 除 collections / history 外，其它 router 页一律不挂 DIY 玻璃背景。category 页 activePageId 为 null。
    if (S.activePageId && S.activePageId !== 'collections' && S.activePageId !== 'history') return null;
    var cur = S.current || null;
    if (cur && cur.mode === 'category') {
      if (cur.field === 'track') return 'track';
      return null; // 其他分类页（电影筛选/心动等）不挂玻璃背景
    }
    if (cur && cur.mode === 'collection-items') return 'collections';
    if (S.activePageId === 'collections') return 'collections';
    if (S.activePageId === 'history') return 'history';
    if (S.bodyEl && S.bodyEl.querySelector('.sfv-track-tabs')) return 'track';
    // 禁用 titleEl.textContent 判断：进入电影/动漫/世界/汇联等 router 页时 titleEl 不会被重置，
    // 若上一页是历史页则会残留 "历史" 文本，导致这些页面错误被套上玻璃背景。
    return null;
  }

  // ---------------------------------------------------------------- 颜色工具
  function hexToRgb(hex) {
    var s = (hex || '').replace('#', '');
    if (s.length === 3) s = s.split('').map(function (c) { return c + c; }).join('');
    var n = parseInt(s, 16);
    if (s.length !== 6 || isNaN(n)) return null;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function rgba(hex, alpha) {
    var c = hexToRgb(hex); if (!c) return hex;
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + alpha + ')';
  }
  function setPageBgColor(color, host) {
    // 同步 host 实底（.sfv-browse 或 #sfv-search-page）、html 兜底背景（填满 clip-path 圆角裁切区）
    if (host) host.style.setProperty('--sfv-cat-bg', color);
    if (S.overlay) S.overlay.style.setProperty('--sfv-cat-bg', color);
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.style.setProperty('background', color, 'important');
    }
  }
  function clearPageBgColor(host) {
    if (host) host.style.removeProperty('--sfv-cat-bg');
    if (S.overlay) S.overlay.style.removeProperty('--sfv-cat-bg');
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.style.removeProperty('background');
    }
  }

  // ---------------------------------------------------------------- 背景层
  function ensureLayer(host) {
    if (!host) return null;
    var layer = host.querySelector(':scope > .sfv-page-bg-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'sfv-page-bg-layer';
      host.insertBefore(layer, host.firstChild);
    }
    return layer;
  }
  function clearLayer(layer) {
    if (!layer) return;
    while (layer.firstChild) layer.removeChild(layer.firstChild);
  }

  function observeOverlay() {
    if (!_overlayObserver && typeof MutationObserver !== 'undefined') {
      _overlayObserver = new MutationObserver(function () { sync(); });
    }
    if (_overlayObserver && S.overlay) {
      try { _overlayObserver.observe(S.overlay, { attributes: true, attributeFilter: ['class'] }); } catch (e) {}
    }
  }
  function disconnectOverlay() {
    if (_overlayObserver) { try { _overlayObserver.disconnect(); } catch (e) {} }
  }

  function apply() {
    disconnectOverlay();              // 先断开观察，避免修改 class 时自触发
    var pageId = getDiyPageId();
    var isSearch = pageId === 'search';
    var host = isSearch ? (S.getSearchPage && S.getSearchPage()) : S.overlay;
    if (!pageId || !host) {
      // 清理 overlay 上的背景层
      if (S.overlay) {
        S.overlay.classList.remove('sfv-page-bg-diy');
        var olayer = S.overlay.querySelector(':scope > .sfv-page-bg-layer');
        if (olayer) { try { olayer.parentNode.removeChild(olayer); } catch (e) {} }
      }
      // 清理搜索页上的背景层
      var sp = (S.getSearchPage && S.getSearchPage());
      if (sp) {
        sp.classList.remove('sfv-page-bg-diy');
        var slayer = sp.querySelector(':scope > .sfv-page-bg-layer');
        if (slayer) { try { slayer.parentNode.removeChild(slayer); } catch (e) {} }
      }
      clearPageBgColor();
      observeOverlay();
      return;
    }
    var pref = load(pageId);
    var isHistory = pageId === 'history';
    // 片单/追片/搜索/历史统一乳白兜底四角（对齐片单页浅色实底语境）。
    var catBg = '#faf8f5';

    // 搜索页背景一体化：仅自定义「图片」时挂载玻璃层（需承载图片）；
    // 纯「颜色」偏好（或无偏好）时不挂玻璃层——宿主 --sfv-cat-bg 已实色铺满即可，
    // 避免 clip-path(#sfv-search-page) 下玻璃层 backdrop-filter/box-shadow 采样异常
    // 渲染出水平暗带 / 多层玻璃重叠（画面割裂，PIL 实测暗带位于距视口底 ~205px，亮度 237→218）。
    // 追片/片单/历史页保留既有默认玻璃层行为。
    var needsLayer = true;
    if (isSearch) needsLayer = !!(pref && pref.type === 'image');
    // 搜索页纯「颜色」偏好：不挂玻璃层，但颜色仍须写到宿主实底（否则自定义底色不生效）
    if (isSearch && pref && pref.type === 'color' && pref.value) catBg = pref.value;

    if (needsLayer) {
      host.classList.add('sfv-page-bg-diy');
      var layer = ensureLayer(host);
      clearLayer(layer);
      layer.classList.remove('sfv-page-bg--tint');
      layer.style.removeProperty('--sfv-glass-tint');
      if (pref && pref.type === 'image' && pref.value) {
        // 自定义图片：铺满覆盖整块背景（cover），玻璃质感由 .sfv-page-bg-layer 的 filter 保留
        var img = document.createElement('img');
        img.src = pref.value; img.alt = ''; img.draggable = false;
        layer.appendChild(img);
      } else if (pref && pref.type === 'color' && pref.value) {
        // 玻璃底色切换：保留毛玻璃滤镜与阴影，仅改变玻璃容器底色
        layer.classList.add('sfv-page-bg--tint');
        layer.style.setProperty('--sfv-glass-tint', rgba(pref.value, 0.78));
        catBg = pref.value;
      } else if (isHistory) {
        // 历史页无自定义偏好时：默认浅色玻璃底色，对齐片单页浅色语境 + 深字可读性
        layer.classList.add('sfv-page-bg--tint');
        layer.style.setProperty('--sfv-glass-tint', 'rgba(250, 248, 245, 0.7)');
      }
    } else {
      host.classList.remove('sfv-page-bg-diy');
      var layer = host.querySelector(':scope > .sfv-page-bg-layer');
      if (layer) { try { layer.parentNode.removeChild(layer); } catch (e) {} }
    }
    // 四角/兜底背景与玻璃层同色，避免 clip-path 圆角裁切区露异色
    setPageBgColor(catBg, host);
    observeOverlay();
  }

  function sync() {
    if (_syncing) return;             // 防止 MutationObserver 微任务重入形成风暴
    _syncing = true;
    try { apply(); } finally { _syncing = false; }
    var pid = getDiyPageId();
    // T143：搜索页的背景入口已并入筛选面板，不再显示右下角 FAB
    if (pid && pid !== 'search') showFab(); else hideFab();
  }

  // ---------------------------------------------------------------- FAB
  function buildFab() {
    if (FAB) return FAB;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'sfv-bg-diy-fab';
    b.setAttribute('aria-label', '背景');
    b.title = '背景';
    b.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">' +
      '<path d="M9.15 7.49C8.59 7.49 8.15 7.94 8.15 8.49s.45 1 1 1 1-.45 1-1-.45-1-1-1z"/>' +
      '<path d="M21.46 5.04C20.62 3.09 18.77 2 16.19 2H7.81C4.6 2 2 4.6 2 7.81V16.19C2 18.77 3.09 20.62 5.04 21.46c.19.08.41.03.55-.11L21.35 5.59c.15-.15.2-.37.11-.55zM10.53 12.24c-.39.38-.9.56-1.41.56s-1.02-.19-1.41-.56C6.69 11.28 5.57 9.75 6 7.93 6.38 6.28 7.84 5.54 9.12 5.54s2.74.74 3.12 2.4c.42 1.81-.7 3.34-1.71 4.3z"/>' +
      '<path d="M19.47 20.53c.22.22.19.58-.08.73-.88.49-1.95.74-3.2.74H7.81c-.3 0-.42-.34-.22-.54l6.04-6.04c.2-.2.51-.2.71 0l5.13 5.11z"/>' +
      '<path d="M22 7.81v8.38c0 1.25-.25 2.33-.74 3.2-.15.27-.51.29-.73.08L15.41 14.35c-.2-.2-.2-.51 0-.71l6.04-6.04c.2-.2.54-.08.55.21z"/>' +
      '</svg>';
    b.addEventListener('click', function () { openModal(); });
    document.body.appendChild(b);
    FAB = b;
    return b;
  }
  function showFab() { buildFab(); FAB.style.display = 'flex'; }
  function hideFab() { if (FAB) FAB.style.display = 'none'; }

  // ---------------------------------------------------------------- 模态（追片/历史/片单 三页统一）
  var DIALOG_HTML =
    '<div class="sfv-bg-diy-dialog" role="dialog" aria-modal="true">' +
      '<div class="sfv-bg-diy-head"><span class="sfv-bg-diy-title">追片背景</span>' +
        '<button type="button" class="sfv-bg-diy-close" aria-label="关闭">×</button></div>' +
      '<div class="sfv-bg-diy-body">' +
        '<section class="sfv-bg-diy-sec sfv-bg-diy-colors" style="display:none">' +
          '<h4>预设背景色</h4>' +
          '<div class="sfv-bg-diy-swatches"></div>' +
        '</section>' +
        '<section class="sfv-bg-diy-sec">' +
          '<h4>自定义图片</h4>' +
          '<input type="file" accept="image/*" class="sfv-bg-diy-file">' +
          '<div class="sfv-bg-diy-actions">' +
            '<button type="button" class="sfv-bg-diy-btn" data-act="reset">恢复默认</button>' +
          '</div>' +
          '<div class="sfv-bg-diy-status"></div>' +
        '</section>' +
      '</div>' +
    '</div>';

  function buildModal() {
    if (MODAL) return MODAL;
    var mask = document.createElement('div');
    mask.className = 'sfv-bg-diy-mask';
    mask.innerHTML = DIALOG_HTML;
    document.body.appendChild(mask);
    MODAL = mask;

    mask.addEventListener('click', function (e) { if (e.target === mask) closeModal(); });
    var closeBtn = mask.querySelector('.sfv-bg-diy-close');
    if (closeBtn) closeBtn.addEventListener('click', closeModal);

    mask.querySelector('[data-act="reset"]').addEventListener('click', function () {
      var pid = _modalPageId || getDiyPageId();
      save(null, pid); apply(); refreshStatus(); paintSwatches();
    });

    var fileInput = mask.querySelector('.sfv-bg-diy-file');
    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0]; if (!f) return;
      var pid = _modalPageId || getDiyPageId();
      var reader = new FileReader();
      reader.onload = function () {
        save({ type: 'image', value: reader.result }, pid);
        apply(); refreshStatus(); paintSwatches();
      };
      reader.readAsDataURL(f);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && MODAL.classList.contains('show')) closeModal();
    });
    return MODAL;
  }
  function openModal() {
    var pid = getDiyPageId();
    if (!pid) return;
    buildModal();
    _modalPageId = pid;
    var titleEl = MODAL.querySelector('.sfv-bg-diy-title');
    if (titleEl) {
      titleEl.textContent = (pid === 'collections' ? '片单背景' :
        (pid === 'track' ? '追片背景' : (pid === 'search' ? '搜索背景' : '历史背景')));
    }
    // 四页统一开放预设色板（追片/历史/片单/搜索）
    var colorSec = MODAL.querySelector('.sfv-bg-diy-colors');
    if (colorSec) colorSec.style.display = '';
    paintSwatches();
    MODAL.classList.add('show');
    refreshStatus();
  }
  function closeModal() { if (MODAL) MODAL.classList.remove('show'); }
  function isModalOpen() { return !!MODAL && MODAL.classList.contains('show'); }

  // 预设色板渲染（根据当前页 pref 高亮选中项）
  function paintSwatches() {
    if (!MODAL) return;
    var wrap = MODAL.querySelector('.sfv-bg-diy-swatches');
    if (!wrap) return;
    var pid = _modalPageId || getDiyPageId();
    var pref = load(pid);
    var cur = (pref && pref.type === 'color') ? pref.value : null;
    wrap.innerHTML = '';
    COLOR_PRESETS.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'sfv-bg-diy-swatch' + (cur === c.value ? ' on' : '');
      b.style.background = c.value;
      b.title = c.label;
      b.setAttribute('aria-label', c.label);
      b.addEventListener('click', function () {
        var p = _modalPageId || getDiyPageId();
        save({ type: 'color', value: c.value }, p);
        apply(); paintSwatches(); refreshStatus();
      });
      wrap.appendChild(b);
    });
  }

  function refreshStatus() {
    if (!MODAL) return;
    var pid = _modalPageId || getDiyPageId();
    var pref = load(pid);
    var status = MODAL.querySelector('.sfv-bg-diy-status');
    if (!status) return;
    var active = !!(pref && (pref.type === 'color' || pref.type === 'image'));
    status.classList.toggle('active', active);
    status.textContent = (pref && pref.type === 'image') ? '当前：自定义图片'
      : (pref && pref.type === 'color') ? '当前：自定义背景色'
      : '当前：默认玻璃背景';
  }

  // ---------------------------------------------------------------- 搜索筛选面板内嵌背景控制
  function renderSearchPanelSection(container) {
    if (!container) return;
    var pid = 'search';
    var old = container.querySelector('.sfv-bg-diy-inline-section');
    if (old) old.parentNode.removeChild(old);

    var wrap = document.createElement('div');
    wrap.className = 'sfv-bg-diy-inline-section';

    var pref = load(pid);
    var curColor = (pref && pref.type === 'color') ? pref.value : null;

    // 预设色板
    var swatches = document.createElement('div');
    swatches.className = 'sfv-bg-diy-inline-swatches';
    COLOR_PRESETS.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'sfv-bg-diy-inline-swatch' + (c.value === curColor ? ' is-active' : '');
      b.style.background = c.value;
      b.title = c.label;
      b.setAttribute('aria-label', c.label);
      b.addEventListener('click', function () {
        save({ type: 'color', value: c.value }, pid);
        apply();
        renderSearchPanelSection(container);
      });
      swatches.appendChild(b);
    });

    // 自定义图片上传
    var fileWrap = document.createElement('div');
    fileWrap.className = 'sfv-bg-diy-inline-file';
    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.className = 'sfv-bg-diy-inline-file-input';
    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0]; if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        save({ type: 'image', value: reader.result }, pid);
        apply();
        renderSearchPanelSection(container);
      };
      reader.readAsDataURL(f);
    });
    fileWrap.appendChild(fileInput);

    // 操作行：恢复默认
    var actions = document.createElement('div');
    actions.className = 'sfv-bg-diy-inline-actions';
    var reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'sfv-bg-diy-inline-btn';
    reset.textContent = '恢复默认';
    reset.addEventListener('click', function () {
      save(null, pid);
      apply();
      renderSearchPanelSection(container);
    });
    actions.appendChild(reset);

    // 状态文案
    var status = document.createElement('div');
    status.className = 'sfv-bg-diy-inline-status';
    var statusText = '当前：默认玻璃背景';
    if (pref && pref.type === 'image') statusText = '当前：自定义图片';
    else if (pref && pref.type === 'color') {
      var found = COLOR_PRESETS.filter(function (c) { return c.value === pref.value; })[0];
      statusText = '当前：' + (found ? found.label : '自定义背景色');
    }
    status.textContent = statusText;

    wrap.appendChild(swatches);
    wrap.appendChild(fileWrap);
    wrap.appendChild(actions);
    wrap.appendChild(status);
    container.appendChild(wrap);
  }

  // ---------------------------------------------------------------- 空间切换兜底
  if (typeof document !== 'undefined' && document.body && typeof MutationObserver !== 'undefined') {
    var _lastVideo = document.body.classList.contains('video-space-active');
    var _mo = new MutationObserver(function () {
      var now = document.body.classList.contains('video-space-active');
      if (now !== _lastVideo) { _lastVideo = now; sync(); }
    });
    try { _mo.observe(document.body, { attributes: true, attributeFilter: ['class'] }); } catch (e) {}
  }

  // ---------------------------------------------------------------- 对外
  SFV.pageBgDiy = {
    sync: sync,
    apply: apply,
    getDiyPageId: getDiyPageId,
    openModal: openModal,
    closeModal: closeModal,
    isModalOpen: isModalOpen,
    renderSearchPanelSection: renderSearchPanelSection
  };
  // 初次进入影视态后补一次同步
  if (typeof document !== 'undefined') {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      setTimeout(sync, 0);
    } else {
      document.addEventListener('DOMContentLoaded', function () { setTimeout(sync, 0); });
    }
  }
})(typeof window !== 'undefined' ? window : this);
