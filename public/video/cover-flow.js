/*
 * Stellaflix 影视模块 — 浏览厅 Cover Flow 引擎
 *
 * 移植自 https://github.com/opc8838-hub/cover-flow-showcase （MIT）。
 * 纯 CSS 3D transform + 原生 JS 数学，**不依赖 Three.js / WebGL**，
 * 与音乐态 3D 歌单架及电影/动漫页 browse3d 海报墙零耦合。
 *
 * 视觉参数完全沿用参考项目（已验证）：
 *   - 卡片 350×525（标准海报 2:3 比例），容器 perspective 1800
 *   - 间距：abs<1 ? abs*306 : 306+(abs-1)*136
 *   - 侧旋：side * -62° * pow(progress, 1.65)
 *   - 缩放：0.835 + breathe*0.255 - max(0,abs-1)*0.026
 *   - 吸附：position += (target-position)*0.145
 *   - wheel delta/230，拖拽 delta/165，鼠标视差近18远20
 *   - 滑动触发边界：指针 Y 须落于卡片自身高度范围（.sfv-cf-cards 矩形），带外不响应
 *   - 倒影：scaleY(-1) 渐变遮罩（复用真实海报图）
 *   - 连续循环 wrap（modulo）
 *   - 48h 去重：localStorage 持久化已见 TMDB id，同片 48h 内不重复出现
 *   - 无限抓取：TMDB 耗尽(done 触发)后自动归零页码重新开始；按规则②抓取完成即重置去重窗口(清空 seenMap)
 *
 * 液态玻璃质感（Liquid Glass）：
 *   - SVG filter #cf-card-glass-filter（index.html 内联）：边缘折射位移，中心清晰不失真
 *   - 多层高光带（.sfv-cf-shine）：135°主高光 + 178°次高光 + 左侧漏光 + 底暗角
 *   - 内阴影收边（inset shadow）：模拟玻璃盖厚度/凹陷立体感
 *   - 外层投影（outset shadow）：多层悬浮感
 *   - 边缘光晕（.sfv-cf-glass-edge）：独立 overlay 层模拟侧面折射散射
 *   - GSAP 动效：聚焦卡片时高光强度过渡、拖动时光泽跟随
 *   - 参数暴露：GLASS_CONFIG 可调常量对象
 *
 * 导出 SFV.coverFlow：mount / destroy / next / prev / goTo / getActive / setActiveChange
 * 单文件 ≤ 500 行。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  if (SFV.coverFlow) return; // 防御性重复注册

  var clamp = function (v, min, max) { return Math.max(min, Math.min(max, v)); };
  var raf = (global.requestAnimationFrame)
    ? global.requestAnimationFrame.bind(global)
    : function (f) { return setTimeout(f, 16); };
  var caf = (global.cancelAnimationFrame)
    ? global.cancelAnimationFrame.bind(global)
    : function (id) { clearTimeout(id); };

  // ---- 模块级单实例（浏览厅唯一使用者）----
  var stage = null;       // .sfv-cf-stage（perspective 容器，接收事件）
  var cardsWrap = null;   // .sfv-cf-cards（绝对居中原点）
  var cards = [];         // [{ el, img, reflImg, shineEl, glassEdgeEl, item, index }]
  var items = [];         // 已加载的全部条目
  var page = 0, loading = false, done = false;
  var position = 0, target = 0, activeIndex = 0;
  var pointer = { x: 0, y: 0 };
  var lastPointerX = null;
  var animId = null, settleId = null;
  var loadItems = null, onSelect = null, onActiveChange = null;
  var bound = {};
  // 离屏卡片图源回收：仅远离视野（abs > ACTIVE_BAND）的完全透明卡片才 removeAttribute('src')，
  // 释放解码位图，使显存随已加载条目数增长保持恒定（≈ ±12 × 2(img+倒影) ≈ 50 张解码图）。
  // 关键：ACTIVE_BAND 必须远大于封面透明度归零阈值（opacity 在 abs>5 即归零），否则 opacity>0
  // 的半可见边缘卡片会被卸载 src，叠加网络图片加载延迟 → 边缘黑块闪烁。原值 6 偏小，已提至 12。
  var ACTIVE_BAND = 12;

  // ---- 液态玻璃可调参数（GLASS_CONFIG）----
  var GLASS_CONFIG = {
    /** SVG 折射强度（filter 内 feDisplacementMap scale 的视觉等效值） */
    refractionScale: 4,
    /** 高光层基础 opacity（0~1） */
    shineBaseOpacity: 0.92,
    /** 聚焦卡片高光 opacity 提升量 */
    shineFocusBoost: 0.08,
    /** GSAP 高光过渡时长（ms） */
    shineTransitionMs: 220,
    /** GSAP 卡片聚焦缩放（1 = 原尺寸） */
    focusScale: 1.02,
    /** 内阴影颜色（rgba 格式字符串） */
    insetShadowColor: 'rgba(255,255,255,0.14)',
    /** 外投影深度系数（乘以默认值） */
    shadowDepthMultiplier: 1.0
  };
  // 暴露配置供外部微调
  SFV.coverFlowGlassConfig = GLASS_CONFIG;

  // ---- 48h 去重（localStorage 持久化，跨会话/分类全局）----
  var SEEN_KEY = 'stellaflix:hall:seen';
  var SEEN_TTL = 48 * 60 * 60 * 1000; // 48 小时（ms）
  var seenMap = null; // 延迟加载
  // 连续全量去重计数器：防止 seenMap 膨胀后所有页面都被过滤导致永久黑屏
  var consecutiveEmptyPages = 0;
  var MAX_CONSECUTIVE_EMPTY = 6; // 连续 6 页全被去重 → 清空 seenMap 放行

  function getSeenMap() {
    if (!seenMap) {
      try { seenMap = JSON.parse(global.localStorage.getItem(SEEN_KEY)) || {}; }
      catch (e) { seenMap = {}; }
    }
    return seenMap;
  }
  function saveSeenMap() {
    if (!seenMap) return;
    try {
      var now = Date.now();
      var prune = false;
      Object.keys(seenMap).forEach(function (id) {
        if (now - seenMap[id] > SEEN_TTL) { delete seenMap[id]; prune = true; }
      });
      global.localStorage.setItem(SEEN_KEY, JSON.stringify(seenMap));
    } catch (e) {}
  }
  function markSeen(id) {
    if (!id) return;
    getSeenMap()[id] = Date.now();
    saveSeenMap();
  }
  function isRecent(id) {
    if (!id) return false;
    var ts = getSeenMap()[id];
    if (!ts) return false;
    if (Date.now() - ts > SEEN_TTL) { delete getSeenMap()[id]; saveSeenMap(); return false; }
    return true;
  }
  function dedupItems(arr) {
    if (!arr || !arr.length) return [];
    return arr.filter(function (it) { return !isRecent(it.id); });
  }

  function wrapIndex(i) {
    var total = items.length || 1;
    return ((i % total) + total) % total;
  }
  function wrapPosition(p) {
    var total = items.length || 1;
    return ((p % total) + total) % total;
  }

  // ============================================================
  //  卡片 DOM
  // ============================================================
  function makeCard(item, index) {
    var doc = global.document;
    var btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'sfv-cf-card';
    btn.setAttribute('data-index', String(index));
    btn.setAttribute('data-near-center', '0');

    var inner = doc.createElement('div');
    inner.className = 'sfv-cf-inner';

    // 倒影（真实海报翻转 + 渐变遮罩）
    var refl = doc.createElement('div');
    refl.className = 'sfv-cf-reflection';
    var reflImg = doc.createElement('img');
    reflImg.className = 'sfv-cf-refl-img';
    reflImg.alt = '';
    refl.appendChild(reflImg);

    // 正面（玻璃质感容器）
    var face = doc.createElement('div');
    face.className = 'sfv-cf-face';
    var img = doc.createElement('img');
    img.className = 'sfv-cf-img';
    img.alt = item.title || '';
    img.addEventListener('error', function () { img.style.display = 'none'; });
    reflImg.addEventListener('error', function () { reflImg.style.display = 'none'; });

    // 液态玻璃高光层
    var shine = doc.createElement('div');
    shine.className = 'sfv-cf-shine';
    shine.style.opacity = String(GLASS_CONFIG.shineBaseOpacity);

    // 玻璃边缘光晕层（独立 overlay，模拟侧面折射散射）
    var glassEdge = doc.createElement('div');
    glassEdge.className = 'sfv-cf-glass-edge';

    face.appendChild(img);
    face.appendChild(shine);
    inner.appendChild(glassEdge);  // z-index:3，覆盖在 face 边缘
    inner.appendChild(refl);
    inner.appendChild(face);
    btn.appendChild(inner);

    if (!item.poster) {
      img.style.display = 'none';
    }
    // 不在此处直接注入图源：交给 styleCards 的离屏回收逻辑，仅 ±ACTIVE_BAND 张活跃卡持有 src，
    // 既避免一次性全量抓取/解码，也让显存随条目数增长恒定。

    btn.addEventListener('click', function () {
      if (index === activeIndex) { if (onSelect) onSelect(items[index], index); }
      else goTo(index);
    });

    var rec = { el: btn, img: img, reflImg: reflImg, shineEl: shine, glassEdgeEl: glassEdge, item: item, index: index, _srcActive: false };
    cardsWrap.appendChild(btn);
    cards.push(rec);
    return rec;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ============================================================
  //  定位（移植自参考 styleCards）
  // ============================================================
  function styleCards(nextPosition, ptr) {
    ptr = ptr || pointer;
    var total = items.length || 1;
    var gsap = (global.gsap || null);
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var raw = i - nextPosition;
      var offset = ((((raw + total / 2) % total) + total) % total) - total / 2;
      var side = offset < 0 ? -1 : 1;
      var abs = Math.abs(offset);
      // ---- 离屏卡片图源回收（显存恒定）：仅 abs > ACTIVE_BAND 的完全透明卡片卸载 src ----
      // 可见卡片（opacity>0，即 abs<=5）永远在带内，绝不卸载 → 消除边缘黑块闪烁。
      // 进入带内时刷新 display 并（首次）挂载 src，随后 decode() 预解码，避免「先暗背景后突然跳亮」。
      var poster = card.item.poster;
      var inBand = abs <= ACTIVE_BAND;
      if (poster) {
        if (inBand) {
          if (!card._srcActive) {
            card.img.style.display = '';
            card.reflImg.style.display = '';
            card.img.src = poster;
            card.reflImg.src = poster;
            if (card.img.decode) {
              card.img.decode().catch(function () { /* 解码失败保持占位背景，不阻塞 */ });
            }
            card._srcActive = true;
          }
        } else if (card._srcActive) {
          // 仅当卡片已完全透明（opacity=0，abs>ACTIVE_BAND≫5）后才卸载，避免可见黑块
          card.img.removeAttribute('src');
          card.reflImg.removeAttribute('src');
          card._srcActive = false;
        }
      }
      var nearCenter = abs < 0.5;
      var sideProgress = Math.min(abs, 1);
      var centerEase = 1 - sideProgress;
      var breathe = centerEase * centerEase * (3 - 2 * centerEase);
      var rotateProgress = Math.pow(sideProgress, 1.65);
      var xBase = abs < 1 ? abs * 306 : 306 + (abs - 1) * 136;
      var x = side * xBase + ptr.x * (nearCenter ? 18 : 20);
      var y = abs * 6 + ptr.y * (nearCenter ? 8 : 9);
      var rotate = side * -62 * rotateProgress + ptr.x * (nearCenter ? -2 : -1.5);
      var scale = 0.835 + breathe * 0.255 - Math.max(0, abs - 1) * 0.026;
      var opacity = abs > 5 ? 0 : Math.max(0.26, 1 - abs * 0.085);
      var blur = abs > 4 ? 'blur(5px)' : (abs > 3 ? 'blur(2px)' : 'none');
      card.el.style.transform =
        'translate3d(' + x + 'px,' + y + 'px,' + (190 - abs * 54) + 'px) rotateY(' + rotate + 'deg) scale(' + scale + ')';
      card.el.style.zIndex = String(60 - Math.round(abs));
      card.el.style.filter = blur;
      card.el.style.opacity = String(opacity);

      // ---- 液态玻璃：GSAP 高光动效 ----
      // 标记近中心状态（CSS 选择器 + JS 动效共用）
      card.el.setAttribute('data-near-center', nearCenter ? '1' : '0');
      if (card.shineEl && gsap) {
        var targetOpacity = nearCenter
          ? GLASS_CONFIG.shineBaseOpacity + GLASS_CONFIG.shineFocusBoost
          : GLASS_CONFIG.shineBaseOpacity * 0.75; // 远处卡片高光衰减
        gsap.killTweensOf(card.shineEl, 'opacity');
        gsap.to(card.shineEl, {
          opacity: targetOpacity,
          duration: GLASS_CONFIG.shineTransitionMs / 1000,
          ease: 'power2.out',
          overwrite: 'auto'
        });
      }
    }
  }

  function updateActiveIndex(nextPosition) {
    var next = wrapIndex(Math.round(nextPosition));
    if (next === activeIndex) return;
    activeIndex = next;
    if (onActiveChange) onActiveChange(items[activeIndex], activeIndex);
    maybeLoadMore();
  }

  function syncPosition(nextPosition, commit) {
    var wrapped = wrapPosition(nextPosition);
    position = wrapped;
    target = wrapped;
    styleCards(wrapped);
    updateActiveIndex(wrapped);
    if (commit) { /* 占位：React setState，此处无需 */ }
  }

  function animateToTarget() {
    if (animId !== null) return;
    var tick = function () {
      var total = items.length || 1;
      var delta = target - position;
      if (delta > total / 2) delta -= total;
      if (delta < -total / 2) delta += total;
      if (Math.abs(delta) < 0.002) {
        syncPosition(target);
        animId = null;
        return;
      }
      var next = wrapPosition(position + delta * 0.145);
      position = next;
      styleCards(next);
      animId = raf(tick);
    };
    animId = raf(tick);
  }

  function settle() {
    target = wrapPosition(Math.round(position));
    animateToTarget();
  }
  function scheduleSettle(delay) {
    delay = delay || 130;
    if (settleId !== null) global.clearTimeout(settleId);
    settleId = global.setTimeout(function () { settleId = null; settle(); }, delay);
  }
  function push(delta) {
    if (animId !== null) { caf(animId); animId = null; }
    if (settleId !== null) { global.clearTimeout(settleId); settleId = null; }
    syncPosition(position + delta, false);
  }

  // ============================================================
  //  加载（TMDB 分页；接近末端追加）
  // ============================================================
  function maybeLoadMore() {
    if (loading) return;
    // 不再拦截 done 状态：loadMore() 自身有 page=0;done=false 归零重启逻辑，
    // 此处放行才能让 TMDB 耗尽后的无限循环抓取生效。
    // 同时：items.length===0 时也必须放行（首批可能被 48h 去重全量过滤）。
    if (!items.length || activeIndex >= items.length - 4) loadMore();
  }
  function loadMore() {
    if (loading || !loadItems) return;
    // 无限循环：TMDB 耗尽后自动归零页码重新抓取
    if (done) { page = 0; done = false; }
    loading = true;
    var p = page + 1;
    Promise.resolve(loadItems(p)).then(function (arr) {
      page = p; loading = false;
      if (!arr || !arr.length) {
        // 本分类 TMDB 已到末页（抓取完成）
        // 规则②：去重计时窗口整体重置（清空 seenMap），下一轮从第 1 页重新开始时可重复展示
        done = true; // 标记耗尽，下次 maybeLoadMore 触发时归零重启
        try { seenMap = {}; global.localStorage.removeItem(SEEN_KEY); } catch (e) {}
        consecutiveEmptyPages = 0;
        return;
      }
      var firstBatch = (items.length === 0);
      // 48h 去重：仅保留未在 48h 内出现过的条目
      var fresh = dedupItems(arr);
      if (fresh.length === 0) {
        // 本页全被去重 → 累加连续空页计数
        consecutiveEmptyPages++;
        if (consecutiveEmptyPages >= MAX_CONSECUTIVE_EMPTY) {
          // 连续多页全量去重 → seenMap 可能已膨胀到阻塞级别（用户高频浏览后）
          // 防御性清空：宁可短暂重复也强于永久黑屏
          try { seenMap = {}; global.localStorage.removeItem(SEEN_KEY); } catch (e) {}
          consecutiveEmptyPages = 0;
          // 清空后用原始数据重新过滤（此时全部 fresh）
          fresh = arr;
        }
      } else {
        consecutiveEmptyPages = 0; // 有新鲜数据 → 重置计数器
      }
      fresh.forEach(function (it) {
        markSeen(it.id); // 标记已见（含首次加载的当前屏）
        makeCard(it, items.length);
        items.push(it);
      });
      styleCards(position);
      if (firstBatch && onActiveChange && items.length) onActiveChange(items[0], 0);
      // 本页全部被去重且 TMDB 未耗尽 → 自动翻下一页
      if (fresh.length === 0 && !done) { maybeLoadMore(); }
    }).catch(function () { loading = false; });
  }

  // ============================================================
  //  事件（挂在 stage 上）
  // ============================================================
  // 卡片高度边界：仅当指针 Y 落在卡片自身垂直高度范围内才响应滑动
  function isInCardBand(clientY) {
    if (!cardsWrap) return false;
    var r = cardsWrap.getBoundingClientRect();
    return clientY >= r.top && clientY <= r.bottom;
  }
  function onWheel(e) {
    if (!e) return;
    if (!isInCardBand(e.clientY)) return; // 卡片高度范围外不响应滑动
    e.preventDefault();
    var wd = (Math.abs(e.deltaX) > Math.abs(e.deltaY)) ? e.deltaX : e.deltaY;
    push(clamp(wd, -240, 240) / 230);
    scheduleSettle(170);
  }
  function onPointerMove(e) {
    // 仅当指针 Y 处于卡片高度范围内才允许滑动；移出范围则停止滑动并复位视差
    if (!isInCardBand(e.clientY)) {
      if (lastPointerX !== null) {
        lastPointerX = null;
        pointer.x = 0; pointer.y = 0;
        styleCards(position, pointer);
        scheduleSettle(60);
      }
      return;
    }
    var rect = stage.getBoundingClientRect();
    pointer.x = clamp(((e.clientX - rect.left) / rect.width - 0.5) * 2, -1, 1);
    pointer.y = clamp(((e.clientY - rect.top) / rect.height - 0.5) * 2, -1, 1);
    styleCards(position, pointer);
    if (lastPointerX === null) { lastPointerX = e.clientX; return; }
    var d = e.clientX - lastPointerX;
    lastPointerX = e.clientX;
    if (Math.abs(d) > 0.4) { push(-d / 165); scheduleSettle(130); }
  }
  function onPointerLeave() {
    lastPointerX = null;
    pointer.x = 0; pointer.y = 0;
    styleCards(position, pointer);
    scheduleSettle(60);
  }
  function onKeyDown(e) {
    if (!e) return;
    if (e.key === 'ArrowRight') syncPosition(position + 1);
    else if (e.key === 'ArrowLeft') syncPosition(position - 1);
    else if (e.key === 'Enter' && items[activeIndex] && onSelect) onSelect(items[activeIndex], activeIndex);
  }

  // ============================================================
  //  公开 API
  // ============================================================
  function mount(stageEl, opts) {
    opts = opts || {};
    stage = stageEl;
    loadItems = opts.loadItems || function () { return Promise.resolve([]); };
    onSelect = opts.onSelect || null;
    onActiveChange = opts.onActiveChange || null;

    var doc = global.document;
    cardsWrap = doc.createElement('div');
    cardsWrap.className = 'sfv-cf-cards';
    stage.appendChild(cardsWrap);

    bound.wheel = onWheel;
    bound.move = onPointerMove;
    bound.leave = onPointerLeave;
    bound.key = onKeyDown;
    stage.addEventListener('wheel', bound.wheel, { passive: false });
    stage.addEventListener('pointermove', bound.move);
    stage.addEventListener('pointerleave', bound.leave);
    stage.addEventListener('keydown', bound.key);

    activeIndex = 0; position = 0; target = 0; page = 0; loading = false; done = false;
    consecutiveEmptyPages = 0;
    items = []; cards = [];
    loadMore();
    return api;
  }

  function destroy() {
    if (animId !== null) { caf(animId); animId = null; }
    if (settleId !== null) { global.clearTimeout(settleId); settleId = null; }
    if (stage) {
      stage.removeEventListener('wheel', bound.wheel);
      stage.removeEventListener('pointermove', bound.move);
      stage.removeEventListener('pointerleave', bound.leave);
      stage.removeEventListener('keydown', bound.key);
      if (cardsWrap && cardsWrap.parentNode) cardsWrap.parentNode.removeChild(cardsWrap);
    }
    stage = null; cardsWrap = null; cards = []; items = [];
    loadItems = onSelect = onActiveChange = null;
  }

  function next() { syncPosition(position + 1); }
  function prev() { syncPosition(position - 1); }
  function goTo(i) {
    if (!items.length) return;
    syncPosition(i);
  }
  function getActive() { return items[activeIndex] || null; }
  function setActiveChange(cb) { onActiveChange = cb; }

  var api = {
    mount: mount,
    destroy: destroy,
    next: next,
    prev: prev,
    goTo: goTo,
    getActive: getActive,
    setActiveChange: setActiveChange
  };
  SFV.coverFlow = api;
})(typeof window !== 'undefined' ? window : this);
