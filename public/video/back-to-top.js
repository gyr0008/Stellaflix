/*
 * Stellaflix 影视模块 — 回到顶部悬浮按钮 (T135)
 *
 * 仅作用于「电影(movie)」「动漫(anime)」两个影视分页：
 *   - 进入电影/动漫分页即固定显示在内容区右下角（不依赖滚动阈值），点击平滑滚动回顶部；
 *   - 离开这两个分页（切其它 tab / 关闭层 / 切回音乐态）即隐藏。
 *
 * 设计要点：
 *   - 单一共享按钮挂 document.body（不被 host.innerHTML 清空），电影/动漫
 *     两页位置 / 样式 / 交互完全一致（同一模块、同一 DOM、同一逻辑）。
 *   - 显示判定 = 影视态 + 浏览层打开 + 当前 router 页为 movie/anime；
 *     满足即固定常驻显示，任一不满足即隐藏（含切到其它 tab、关闭层、切回音乐态）。
 *   - 双态隔离：非 video-space-active 由 CSS display:none 兜底，绝不污染音乐态。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  if (SFV.backToTop) return; // 幂等：脚本重复加载不重复初始化

  // 固定常驻显示：进入 movie/anime 分页即显示在右下角，不再依赖滚动阈值。
  var btn = null;
  var scrollEl = null;
  var ticking = false;

  function doc() { return global.document; }

  function isVideoSpace() {
    var b = doc() && doc().body;
    return !!(b && b.classList.contains('video-space-active'));
  }

  function isOverlayOpen() {
    var ov = doc() && doc().querySelector('.sfv-browse.sfv-show');
    return !!ov;
  }

  // 当前页是否为「电影」或「动漫」——按钮唯一出现的两个分页
  function isMediaPage() {
    if (!isVideoSpace() || !isOverlayOpen()) return false;
    var id = SFV.router && typeof SFV.router.currentId === 'function' ? SFV.router.currentId() : null;
    return id === 'movie' || id === 'anime';
  }

  function show() { if (btn) btn.classList.add('is-visible'); }
  function hide() { if (btn) btn.classList.remove('is-visible'); }

  function update() {
    if (!btn || !scrollEl) return;
    if (isMediaPage()) show();
    else hide();
  }

  function onScroll() {
    if (ticking) return;
    ticking = true;
    if (global.requestAnimationFrame) {
      global.requestAnimationFrame(function () { ticking = false; update(); });
    } else {
      ticking = false; update();
    }
  }

  function scrollToTop() {
    if (!scrollEl) return;
    if (typeof scrollEl.scrollTo === 'function') {
      try { scrollEl.scrollTo({ top: 0, behavior: 'smooth' }); return; } catch (_) {}
    }
    scrollEl.scrollTop = 0; // 优雅降级
  }

  // 清晰视觉标识：青色描边上箭头（箭头 + 短横线底座），无文字依赖
  function buildButton() {
    var b = doc().createElement('button');
    b.type = 'button';
    b.className = 'sfv-backtotop';
    b.setAttribute('aria-label', '回到顶部');
    b.setAttribute('title', '回到顶部');
    b.innerHTML =
      '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">' +
        '<path d="M12 5 L5 13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>' +
        '<path d="M12 5 L19 13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>' +
        '<path d="M5 19 L19 19" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>' +
      '</svg>';
    b.addEventListener('click', function (e) {
      e.preventDefault();
      scrollToTop();
      // 兜底：部分引擎平滑滚动不派发中间 scroll 事件，点击后补一次显隐重算
      if (global.setTimeout) global.setTimeout(update, 450);
    });
    return b;
  }

  // 路由 go 包装：每次分页切换后重算显隐（切到非 media 页立即隐藏）
  function wrapGo() {
    if (!SFV.router || typeof SFV.router.go !== 'function') return;
    if (SFV.router.__bttWrapped) return;
    var orig = SFV.router.go;
    SFV.router.__bttWrapped = true;
    SFV.router.go = function () {
      var r = orig.apply(SFV.router, arguments);
      update();
      return r;
    };
  }

  function bindObservers() {
    if (scrollEl) {
      scrollEl.addEventListener('scroll', onScroll, { passive: true });
    }
    // 浏览层打开/关闭：class 变化即重算（关闭时立即隐藏）
    var ov = doc() && doc().querySelector('.sfv-browse');
    if (ov && global.MutationObserver) {
      var mo = new MutationObserver(function () { update(); });
      mo.observe(ov, { attributes: true, attributeFilter: ['class'] });
    }
    // 空间切换：离开影视态立即隐藏（双态隔离）
    if (global.addEventListener) {
      global.addEventListener(
        (SFV.state && SFV.state.EVENT) ? SFV.state.EVENT : 'spacechange',
        function () { update(); }, false
      );
    }
  }

  // 由 online.js ensure() 在覆盖层创建后调用，传入滚动容器 bodyEl
  function init(el) {
    if (!el) return;
    scrollEl = el;
    if (btn) return; // 已初始化，仅刷新滚动容器引用
    btn = buildButton();
    (doc().body || doc().documentElement).appendChild(btn);
    wrapGo();
    bindObservers();
    update();
  }

  SFV.backToTop = {
    init: init,
    update: update
  };
})(typeof window !== 'undefined' ? window : this);
