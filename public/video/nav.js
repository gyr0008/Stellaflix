/*
 * Stellaflix 影视模块 — 共享顶部导航栏组件 (T134 → T134c)
 *
 * 设计要点：
 *  - 3 tab 单一数据源 NAV_ITEMS（key 对齐 router id；home 走 goHome，不进 router）。
 *  - **直接挂到 document.body**（与 #search-area/#search-box 完全解耦），自带原生玻璃样式
 *    （与音乐态 #search-box 一致：var(--glass-bg) / var(--glass-border) / var(--glass-shadow)）。
 *  - **静态常驻**：T134c 起删除图钉按钮与自动隐藏/固定两态——顶栏始终可见；
 *    顶栏与页面内容之间的视觉间隙由 .sfv-browse--page .sfv-browse-body 的 padding-top 承担。
 *  - paintActive(key)：切 .active（DOM 是文字/显隐单一数据源，JS 不写 textContent）。
 *  - bindClick(handler)：document 捕获阶段 delegation。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  if (SFV.nav) return; // 幂等：避免重复加载

  var NAV_ITEMS = [
    { key: 'world',    label: '世界' },
    { key: 'home',     label: '首页' },
    { key: 'discover', label: '汇联' }
  ];

  var mounted = null;        // <nav id="sfv-nav">
  var clickBound = false;
  var DEFAULT_KEY = 'home';

  var NAV_AUTO_HIDE_STORE_KEY = 'stellaflix-sfv-nav-auto-hide-v1';
  var sfvNavAutoHide = readNavAutoHidePreference();

  function readNavAutoHidePreference() {
    try {
      var raw = localStorage.getItem(NAV_AUTO_HIDE_STORE_KEY);
      return raw === '1';
    } catch (e) {
      return false;
    }
  }
  function saveNavAutoHidePreference(on) {
    try { localStorage.setItem(NAV_AUTO_HIDE_STORE_KEY, on ? '1' : '0'); } catch (e) {}
  }

  function buildNav() {
    var nav = document.createElement('nav');
    nav.id = 'sfv-nav';
    nav.setAttribute('role', 'navigation');
    nav.setAttribute('aria-label', '影视导航');
    for (var i = 0; i < NAV_ITEMS.length; i++) {
      var it = NAV_ITEMS[i];
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'sfv-nav-item';
      b.setAttribute('data-sfv-nav', it.key);
      b.textContent = it.label;
      nav.appendChild(b);
    }
    // T136：导航栏右侧内部的小箭头按钮，与导航栏作为一个整体组件联动
    //        影视态搜索入口已统一收敛至右上角账号胶囊（#top-right > #sfv-capsule-search-btn），
    //        顶部导航栏 #sfv-nav 内不再承载搜索图标/功能，确保仅有单一搜索入口连线。
    var hideBtn = document.createElement('button');
    hideBtn.type = 'button';
    hideBtn.id = 'sfv-nav-hide-btn';
    hideBtn.className = 'sfv-nav-hide-btn';
    hideBtn.title = '自动隐藏影视导航';
    hideBtn.setAttribute('aria-label', '自动隐藏影视导航');
    hideBtn.textContent = '‹';
    hideBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggleSfvNavAutoHide();
    });
    nav.appendChild(hideBtn);
    return nav;
  }

  // mount(parent)：挂到 body（默认）或指定父容器。幂等：旧节点先移除。
  function mount(parent) {
    parent = parent || document.body;
    if (!parent) return null;
    if (mounted && mounted.parentNode) {
      try { mounted.parentNode.removeChild(mounted); } catch (_) {}
    }
    var nav = buildNav();
    parent.appendChild(nav);
    mounted = nav;
    paintActive(DEFAULT_KEY);
    applySfvNavAutoHideState();
    return nav;
  }

  // 维护当前激活 tab 高亮（仅切 .active；不写 textContent）
  function paintActive(key) {
    if (!mounted) return;
    var btns = mounted.querySelectorAll('.sfv-nav-item');
    for (var i = 0; i < btns.length; i++) {
      var k = btns[i].getAttribute('data-sfv-nav');
      btns[i].classList.toggle('active', k === key);
    }
  }

  // document 捕获阶段 click delegation
  function bindClick(handler) {
    if (clickBound) return;
    document.addEventListener('click', function (ev) {
      var item = ev.target && ev.target.closest ? ev.target.closest('.sfv-nav-item') : null;
      if (!item) return;
      ev.preventDefault();
      ev.stopPropagation();
      var key = item.getAttribute('data-sfv-nav');
      if (key && typeof handler === 'function') handler(key);
    }, true);
    clickBound = true;
  }

  function applySfvNavAutoHideState() {
    document.body.classList.toggle('sfv-nav-auto-hide', !!sfvNavAutoHide);
    var btn = mounted ? mounted.querySelector('.sfv-nav-hide-btn') : document.getElementById('sfv-nav-hide-btn');
    if (btn) {
      btn.classList.toggle('on', !!sfvNavAutoHide);
      btn.textContent = sfvNavAutoHide ? '›' : '‹';
      btn.title = sfvNavAutoHide ? '取消自动隐藏影视导航' : '自动隐藏影视导航';
    }
  }
  function toggleSfvNavAutoHide() {
    sfvNavAutoHide = !sfvNavAutoHide;
    saveNavAutoHidePreference(sfvNavAutoHide);
    applySfvNavAutoHideState();
    if (typeof showToast === 'function') {
      showToast(sfvNavAutoHide ? '影视导航已自动隐藏' : '影视导航已固定显示');
    }
  }
  function updateSfvNavAutoHideFromPointer(e) {
    if (!sfvNavAutoHide) {
      document.body.classList.remove('sfv-nav-peek');
      return;
    }
    if (typeof immersiveMode !== 'undefined' && immersiveMode) {
      document.body.classList.remove('sfv-nav-peek');
      return;
    }
    var x = e.clientX, y = e.clientY;
    var W = window.innerWidth;
    var nav = document.getElementById('sfv-nav');
    var btn = document.getElementById('sfv-nav-hide-btn');
    function inRect(r, padX, padY) {
      return x >= r.left - padX && x <= r.right + padX &&
             y >= r.top - padY && y <= r.bottom + padY;
    }
    var inHit = false;
    if (nav) inHit = inHit || inRect(nav.getBoundingClientRect(), 24, 20);
    if (btn) inHit = inHit || inRect(btn.getBoundingClientRect(), 18, 18);
    var navWidth = Math.min(520, W * 0.58);
    var nearTopCenter = y < 120 && Math.abs(x - W / 2) < (navWidth / 2 + 40);
    document.body.classList.toggle('sfv-nav-peek', inHit || nearTopCenter);
  }

  function autoMount() {
    // 始终挂到 body（与 #search-area / #search-box 完全解耦）
    mount(document.body);
  }
  window.addEventListener('mousemove', updateSfvNavAutoHideFromPointer);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoMount);
  } else {
    autoMount();
  }

  SFV.nav = {
    NAV_ITEMS: NAV_ITEMS,
    mount: mount,
    paintActive: paintActive,
    bindClick: bindClick,
    get mounted() { return mounted; }
  };
})(typeof window !== 'undefined' ? window : this);