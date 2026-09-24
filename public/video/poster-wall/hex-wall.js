/*
 * Stellaflix 影视片库 — 蜂窝卡片墙（拖拽平移 + 中心聚焦）
 *
 * 几何与衰减消费 StellaflixHexGrid / StellaflixHexCard（移植自 Folia GridView）。
 * 数据层沿用 SFV.posterWallAdapter（TMDB 多品类 + 观看历史叠加）。
 * 对外接口与旧 wall-dom 兼容：SFV.posterWall.mount / unmount / refresh。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  if (SFV.posterWall) return;

  function d() { return global.document; }

  function toast(msg) {
    if (SFV.online && SFV.online.toast) { try { SFV.online.toast(msg); return; } catch (e) {} }
    if (SFV.ui && SFV.ui.toast) { try { SFV.ui.toast(msg); return; } catch (e) {} }
  }

  var state = {
    host: null,
    field: null,
    world: null,
    items: [],
    coords: [],
    coordByKey: null,
    nodes: {},          // index -> { el, cache }
    mounted: {},        // index -> true（当前在挂载池内）
    focusIndex: 0,
    offset: { dx: 0, dy: 0 },
    metrics: null,
    rafId: null,
    anim: null,         // { targetX, targetY, velX, velY, stiffness?, damping?, mass? }
    drag: null,
    wheelTarget: null,  // 滚轮钳制目标（对齐 Folia wheelTargetRef）
    enteredKeys: {},    // 已播过入场动画的条目 id（对齐 Folia useProgressiveItemEntrance 一次性语义）
    draining: false,    // 无 rAF 环境下同步排空动画，防递归爆栈
    commitTimer: null,
    loadToken: 0,
    progressiveMounted: false,
    lastOpen: { id: null, at: 0 }
  };

  function pickMetrics(viewW) {
    var cardW = viewW < 700 ? 104 : (viewW < 1100 ? 118 : 132);
    var cardH = Math.round(cardW * 1.5);
    return {
      cardW: cardW,
      cardH: cardH,
      spacingX: Math.round(cardW * 1.16),
      spacingY: Math.round(cardH * 0.96),
      gap: 18
    };
  }

  function viewportSize() {
    var host = state.host;
    return {
      w: (host && host.clientWidth) || 1280,
      h: (host && host.clientHeight) || 720
    };
  }

  function frameOptions() {
    var vp = viewportSize();
    var m = state.metrics;
    var halfDiag = Math.sqrt(vp.w * vp.w + vp.h * vp.h) / 2;
    var clipRadius = halfDiag + Math.max(m.cardW, m.cardH);
    return {
      clipRadius: clipRadius,
      // 衰减半径按 Folia 断点表比例（maxDistance≈2.32×卡宽、lod≈1.57/1.78×卡宽，
      // GridView.tsx resolveGridViewCardBox），随卡宽缩放而非视口对角线
      maxDistance: Math.round(m.cardW * 2.32),
      lodStart: Math.round(m.cardW * 1.57),
      lodEnd: Math.round(m.cardW * 1.78),
      viewportWidth: vp.w,
      viewportHeight: vp.h,
      cardWidth: m.cardW,
      cardHeight: m.cardH,
      visibilityBuffer: m.gap
    };
  }

  // ---------- 卡片 DOM ----------

  function buildCard(item) {
    var doc = d();
    var A = SFV.posterWallAdapter;
    var card = doc.createElement('article');
    card.className = 'sfv-hex-card';
    card.setAttribute('data-hex-id', item.id);
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', item.title || '');

    // 内容包进翻转层：rotateY 在卡片自身坐标系内翻转（帧 transform 含座位 translate3d，
    // 若把 rotate 叠在外层会与位移复合成绕世界原点公转）。透视由 .sfv-hex-card 提供。
    var flip = doc.createElement('div');
    flip.className = 'sfv-hex-flip';

    var art = doc.createElement('div');
    art.className = 'sfv-hex-art';
    if (item.poster) {
      art.style.backgroundImage = 'url("' + String(item.poster).replace(/"/g, '\\"') + '")';
    }
    flip.appendChild(art);

    var shade = doc.createElement('div');
    shade.className = 'sfv-hex-shade';
    flip.appendChild(shade);

    var copy = doc.createElement('div');
    copy.className = 'sfv-hex-copy';
    var strong = doc.createElement('strong');
    strong.textContent = item.title || '';
    copy.appendChild(strong);
    flip.appendChild(copy);

    var chrome = doc.createElement('div');
    chrome.className = 'sfv-hex-chrome';
    var meta = doc.createElement('div');
    meta.className = 'sfv-hex-meta';
    meta.textContent = A && A.formatMetaLine ? A.formatMetaLine(item) : '';
    chrome.appendChild(meta);

    var actions = doc.createElement('div');
    actions.className = 'sfv-hex-actions';
    var detailBtn = doc.createElement('button');
    detailBtn.type = 'button';
    detailBtn.className = 'sfv-hex-btn sfv-hex-btn--primary';
    detailBtn.textContent = '看详情';
    detailBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      openItem(item);
    });
    actions.appendChild(detailBtn);
    if (item.section === 'continue' && A && A.playOrResume) {
      var resumeBtn = doc.createElement('button');
      resumeBtn.type = 'button';
      resumeBtn.className = 'sfv-hex-btn';
      resumeBtn.textContent = '续播';
      resumeBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (!A.playOrResume(item)) toast('暂时无法续播');
      });
      actions.appendChild(resumeBtn);
    }
    chrome.appendChild(actions);
    flip.appendChild(chrome);
    card.appendChild(flip);

    var m = state.metrics;
    card.style.width = m.cardW + 'px';
    card.style.height = m.cardH + 'px';
    card.style.marginLeft = (-m.cardW / 2) + 'px';
    card.style.marginTop = (-m.cardH / 2) + 'px';
    return card;
  }

  function openItem(item) {
    var A = SFV.posterWallAdapter;
    if (!A) return;
    var now = Date.now();
    if (state.lastOpen.id === item.id && now - state.lastOpen.at < 500) return;
    state.lastOpen = { id: item.id, at: now };
    if (!A.openDetail(item)) toast('详情模块未就绪');
  }

  function ensureNode(index) {
    if (state.mounted[index]) return state.nodes[index];
    var item = state.items[index];
    if (!item) return null;
    var el = buildCard(item);
    el.addEventListener('click', function () { onCardActivate(index); });
    el.addEventListener('dblclick', function () { openItem(item); });
    state.world.appendChild(el);
    state.nodes[index] = { el: el, cache: {} };
    state.mounted[index] = true;
    var seenKey = item.id != null ? String(item.id) : ('idx:' + index);
    if (!state.enteredKeys[seenKey]) {
      state.enteredKeys[seenKey] = true;
      el.classList.add('sfv-hex-card--enter');
    }
    if (index === state.focusIndex) el.classList.add('is-focused');
    return state.nodes[index];
  }

  function releaseNode(index) {
    var entry = state.nodes[index];
    if (entry) {
      try { state.world.removeChild(entry.el); } catch (e) {}
      delete state.nodes[index];
    }
    delete state.mounted[index];
  }

  // ---------- 帧循环 ----------

  function applyFrames() {
    var HexGrid = global.StellaflixHexGrid;
    var HexCard = global.StellaflixHexCard;
    if (!state.world || !HexGrid || !HexCard || !state.coords.length) return;

    var dx = state.offset.dx;
    var dy = state.offset.dy;
    state.world.style.transform = 'translate3d(' + dx + 'px, ' + dy + 'px, 0)';

    var m = state.metrics;
    var options = frameOptions();
    var worldX = -dx;
    var worldY = -dy;
    var center = HexGrid.pixelToCubeCenter(worldX, worldY, m.spacingX, m.spacingY);
    var ringRadius = Math.ceil(options.clipRadius / Math.min(m.spacingX, m.spacingY)) + 1;
    var visible = HexGrid.resolveVisibleHexIndexes(
      center, ringRadius, state.coordByKey, state.coords, worldX, worldY, options.clipRadius
    );

    var keep = {};
    for (var i = 0; i < visible.length; i++) {
      var index = visible[i];
      keep[index] = true;
      var entry = ensureNode(index);
      if (!entry) continue;
      var frame = HexCard.computeHexCardFrame(state.coords[index], dx, dy, options);
      HexCard.applyHexCardFrameStyles(entry.el, frame, entry.cache);
    }
    var mountedKeys = Object.keys(state.mounted);
    for (var k = 0; k < mountedKeys.length; k++) {
      var idx = Number(mountedKeys[k]);
      if (!keep[idx]) releaseNode(idx);
    }
  }

  function requestFrame() {
    if (state.rafId != null) return;
    if (global.requestAnimationFrame) {
      state.rafId = global.requestAnimationFrame(function () {
        state.rafId = null;
        stepAnimation();
        applyFrames();
      });
    } else if (!state.draining) {
      // 无 rAF（测试沙箱）：同步排空弹簧，避免 stepAnimation→requestFrame 递归
      state.draining = true;
      try {
        var maxFrames = 600;
        while (state.anim && maxFrames-- > 0) stepAnimation();
      } finally {
        state.draining = false;
      }
      applyFrames();
    }
  }

  // 临界阻尼弹簧（对齐 Folia stiffness 220 / damping 28）
  function stepAnimation() {
    var anim = state.anim;
    if (!anim) return;
    var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    var dt = anim.last ? Math.min(Math.max((now - anim.last) / 1000, 0.001), 0.033) : 0.016;
    anim.last = now;
    var stiffness = anim.stiffness || 220;
    var damping = anim.damping || 28;
    var mass = anim.mass || 1;
    var ax = ((anim.targetX - state.offset.dx) * stiffness - anim.velX * damping) / mass;
    var ay = ((anim.targetY - state.offset.dy) * stiffness - anim.velY * damping) / mass;
    anim.velX += ax * dt;
    anim.velY += ay * dt;
    state.offset.dx += anim.velX * dt;
    state.offset.dy += anim.velY * dt;
    var settled = Math.abs(anim.targetX - state.offset.dx) < 0.5
      && Math.abs(anim.targetY - state.offset.dy) < 0.5
      && Math.abs(anim.velX) < 1 && Math.abs(anim.velY) < 1;
    if (settled) {
      state.offset.dx = anim.targetX;
      state.offset.dy = anim.targetY;
      state.anim = null;
      commitFocusSoon(0);
    } else {
      requestFrame();
    }
  }

  // ---------- 焦点 ----------

  // 连线：聚焦提交时把选中卡海报/片名写入 localStorage，供首页片库卡展示
  function publishFocusedPoster() {
    var item = state.items[state.focusIndex];
    if (!item || !item.poster || !global.localStorage) return;
    try {
      global.localStorage.setItem('stellaflix:library:lastPoster', JSON.stringify({
        poster: item.poster,
        title: item.title || '',
        ts: (typeof Date !== 'undefined' ? Date.now() : 0)
      }));
    } catch (e) { /* ignore */ }
  }

  function commitFocus() {
    var prev = state.nodes[state._committedIndex];
    if (prev) prev.el.classList.remove('is-focused');
    var entry = state.nodes[state.focusIndex];
    if (entry) entry.el.classList.add('is-focused');
    state._committedIndex = state.focusIndex;
    publishFocusedPoster();
  }

  function commitFocusSoon(delay) {
    if (!global.setTimeout) { commitFocus(); return; }
    if (state.commitTimer) clearTimeout(state.commitTimer);
    state.commitTimer = setTimeout(function () {
      state.commitTimer = null;
      commitFocus();
    }, delay === undefined ? 160 : delay);
  }

  function centerOnIndex(index, options) {
    var coord = state.coords[index];
    if (!coord) return false;
    state.focusIndex = index;
    var targetX = -coord.baseX;
    var targetY = -coord.baseY;
    var immediate = options && options.immediate;
    state.wheelTarget = null;
    if (immediate || !global.requestAnimationFrame) {
      state.anim = null;
      state.offset.dx = targetX;
      state.offset.dy = targetY;
      applyFrames();
      commitFocus();
    } else {
      state.anim = { targetX: targetX, targetY: targetY, velX: 0, velY: 0, last: 0 };
      requestFrame();
      commitFocusSoon(180);
    }
    return true;
  }

  var ARROW_DIRS = {
    ArrowRight: { x: 1, y: -1, z: 0 },
    ArrowLeft: { x: -1, y: 1, z: 0 },
    ArrowDown: { x: 0, y: -1, z: 1 },
    ArrowUp: { x: 0, y: 1, z: -1 }
  };

  function moveFocusByArrow(key) {
    var dir = ARROW_DIRS[key];
    if (!dir || !state.coords.length) return false;
    var cube = state.coords[state.focusIndex].cube;
    var next = state.coordByKey.get(
      global.StellaflixHexGrid.toCubeKey({ x: cube.x + dir.x, y: cube.y + dir.y, z: cube.z + dir.z })
    );
    if (next === undefined) return false;
    centerOnIndex(next);
    return true;
  }

  // ---------- 边界（对齐 Folia GridView dragBounds：内容包围盒 + 视口余量缓冲） ----------

  var BOUND_SPRING = { stiffness: 560, damping: 48, mass: 0.65 };

  function dragBounds() {
    var m = state.metrics;
    var vp = viewportSize();
    var minX = 0, maxX = 0, minY = 0, maxY = 0;
    for (var i = 0; i < state.coords.length; i++) {
      var c = state.coords[i];
      if (c.baseX < minX) minX = c.baseX;
      if (c.baseX > maxX) maxX = c.baseX;
      if (c.baseY < minY) minY = c.baseY;
      if (c.baseY > maxY) maxY = c.baseY;
    }
    var bufferX = Math.max(0, vp.w / 2 - 2 * m.spacingX);
    var bufferY = Math.max(0, vp.h / 2 - 2 * m.spacingY);
    return {
      left: -maxX - bufferX,
      right: -minX + bufferX,
      top: -maxY - bufferY,
      bottom: -minY + bufferY
    };
  }

  function clampTarget(tx, ty) {
    var b = dragBounds();
    return {
      x: Math.max(b.left, Math.min(b.right, tx)),
      y: Math.max(b.top, Math.min(b.bottom, ty))
    };
  }

  // ---------- 输入 ----------

  function attachInput() {
    var field = state.field;
    field.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var factor = ev.deltaMode === 1 ? 33 : (ev.deltaMode === 2 ? viewportSize().h : 1);
      var base = state.wheelTarget || { x: state.offset.dx, y: state.offset.dy };
      var t = clampTarget(base.x - (ev.deltaX || 0) * factor, base.y - (ev.deltaY || 0) * factor);
      state.wheelTarget = t;
      state.anim = {
        targetX: t.x, targetY: t.y, velX: 0, velY: 0, last: 0,
        stiffness: BOUND_SPRING.stiffness, damping: BOUND_SPRING.damping, mass: BOUND_SPRING.mass
      };
      requestFrame();
    });

    field.addEventListener('keydown', function (ev) {
      if (ARROW_DIRS[ev.key]) {
        ev.preventDefault();
        moveFocusByArrow(ev.key);
      } else if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        var item = state.items[state.focusIndex];
        if (item) openItem(item);
      } else if (ev.key === 'Escape') {
        if (SFV.online && SFV.online.goBack) SFV.online.goBack();
      }
    });

    field.addEventListener('pointerdown', function (ev) {
      if (ev.button !== undefined && ev.button !== 0) return;
      var startX = ev.clientX;
      var startY = ev.clientY;
      var baseX = state.offset.dx;
      var baseY = state.offset.dy;
      var moved = 0;
      var lastX = startX;
      var lastY = startY;
      var lastT = Date.now();
      var vx = 0;
      var vy = 0;
      state.anim = null;
      state.wheelTarget = null;
      state.drag = true;

      function onMove(moveEv) {
        moved += Math.abs(moveEv.clientX - lastX) + Math.abs(moveEv.clientY - lastY);
        var now = Date.now();
        var dt = Math.max(now - lastT, 1);
        vx = (moveEv.clientX - lastX) / dt * 1000;
        vy = (moveEv.clientY - lastY) / dt * 1000;
        lastX = moveEv.clientX;
        lastY = moveEv.clientY;
        lastT = now;
        state.offset.dx = baseX + (moveEv.clientX - startX);
        state.offset.dy = baseY + (moveEv.clientY - startY);
        requestFrame();
      }
      function onUp() {
        field.removeEventListener('pointermove', onMove);
        field.removeEventListener('pointerup', onUp);
        field.removeEventListener('pointercancel', onUp);
        state.drag = false;
        if (moved < 6) return; // 视作点击，交给 click 处理
        // 惯性甩动目标钳制到边界，越界时以边界弹簧回弹（Folia dragConstraints 语义）
        var t = clampTarget(state.offset.dx + vx * 0.18, state.offset.dy + vy * 0.18);
        state.anim = {
          targetX: t.x, targetY: t.y, velX: 0, velY: 0, last: 0,
          stiffness: BOUND_SPRING.stiffness, damping: BOUND_SPRING.damping, mass: BOUND_SPRING.mass
        };
        requestFrame();
      }
      field.addEventListener('pointermove', onMove);
      field.addEventListener('pointerup', onUp);
      field.addEventListener('pointercancel', onUp);
    });
  }

  function onCardActivate(index) {
    if (index === state.focusIndex) {
      var item = state.items[index];
      if (item) openItem(item);
    } else {
      centerOnIndex(index);
    }
  }

  // ---------- 挂载 ----------

  function rebuildCoords() {
    var HexGrid = global.StellaflixHexGrid;
    var m = state.metrics;
    state.coords = HexGrid.buildHexGridCoords(state.items.length, m.spacingX, m.spacingY);
    state.coordByKey = new Map();
    state.coords.forEach(function (coord) {
      state.coordByKey.set(HexGrid.toCubeKey(coord.cube), coord.index);
    });
  }

  function clearPool() {
    Object.keys(state.mounted).forEach(function (index) { releaseNode(Number(index)); });
    state.mounted = {};
    state.nodes = {};
    state._committedIndex = null;
  }

  function mountSync(host, items) {
    var doc = d();
    clearHost(host);
    state.host = host;
    state.items = items || [];
    state.focusIndex = 0;
    state.offset = { dx: 0, dy: 0 };
    state.metrics = pickMetrics(viewportSize().w);
    rebuildCoords();

    var field = doc.createElement('div');
    field.className = 'sfv-hex-field';
    field.tabIndex = 0;
    var world = doc.createElement('div');
    world.className = 'sfv-hex-world';
    field.appendChild(world);
    host.appendChild(field);
    state.field = field;
    state.world = world;

    attachInput();

    applyFrames();
    commitFocus();
    host.setAttribute('data-sfv-library-wall', 'ready');
    host.setAttribute('data-hex-count', String(state.items.length));
    return true;
  }

  function clearHost(host) {
    host.innerHTML = '';
    clearPool();
  }

  function renderEmpty(host, kind) {
    if (kind === 'key') {
      var doc = d();
      var box = doc.createElement('div');
      box.className = 'sfv-hex-empty';
      var title = doc.createElement('div');
      title.className = 'sfv-hex-empty-title';
      title.textContent = '需要 TMDB API Key';
      var sub = doc.createElement('div');
      sub.className = 'sfv-hex-empty-sub';
      sub.textContent = '片库海报墙从 TMDB 拉取多品类电影/剧集海报。请先在设置中填写 TMDB Key，再回到片库。';
      var btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'sfv-library-link';
      btn.setAttribute('id', 'sfv-hex-set-key');
      btn.textContent = '去设置 TMDB Key';
      btn.addEventListener('click', function () {
        var A = SFV.posterWallAdapter;
        if (A && A.openTmdbKeySettings) A.openTmdbKeySettings();
      });
      box.appendChild(title);
      box.appendChild(sub);
      box.appendChild(btn);
      host.appendChild(box);
      host.setAttribute('data-sfv-library-wall', 'need-tmdb-key');
      return;
    }
    host.innerHTML =
      '<div class="sfv-hex-empty">' +
      '<div class="sfv-hex-empty-title">暂时没有海报</div>' +
      '<div class="sfv-hex-empty-sub">TMDB 未返回可用海报，请检查网络或 API Key 后点击刷新。</div>' +
      '</div>';
    host.setAttribute('data-sfv-library-wall', 'empty');
  }

  function mount(host, options) {
    options = options || {};
    if (!host) return Promise.resolve(false);
    var A = SFV.posterWallAdapter;
    if (!A) {
      host.innerHTML = '<div class="sfv-hex-empty">海报墙模块未加载</div>';
      return Promise.resolve(false);
    }
    if (options.items) {
      return Promise.resolve(mountSync(host, options.items));
    }

    state.loadToken += 1;
    var token = state.loadToken;
    state.host = host;
    state.progressiveMounted = false;
    clearHost(host);
    host.innerHTML = '<div class="sfv-hex-loading">正在从 TMDB 拉取多品类海报…</div>';
    host.setAttribute('data-sfv-library-wall', 'loading');

    return A.collectWallItemsAsync({
      onBatch: function (items) {
        if (token !== state.loadToken || state.host !== host) return;
        if (!items || !items.length) return;
        if (!state.progressiveMounted) {
          mountSync(host, items);
          state.progressiveMounted = true;
        } else {
          applyItemsIncrementally(items);
        }
      }
    }).then(function (res) {
      if (token !== state.loadToken || state.host !== host) return false;
      if (res.keyMissing && (!res.items || !res.items.length)) {
        state.items = [];
        clearHost(host);
        renderEmpty(host, 'key');
        return true;
      }
      if (state.progressiveMounted) {
        applyItemsIncrementally(res.items || []);
        return true;
      }
      return mountSync(host, res.items || []);
    })['catch'](function (err) {
      if (token !== state.loadToken) return false;
      if (global.console) console.warn('[hexWall] load failed', err);
      clearHost(host);
      renderEmpty(host, 'empty');
      return false;
    });
  }

  // 增量并入前缀扩展批次：adapter 保证新快照以旧快照为前缀，
  // 因此只需重建坐标表并重绘，索引不漂移，焦点/平移偏移原样保留。
  function applyItemsIncrementally(items) {
    state.items = items || [];
    rebuildCoords();
    if (state.focusIndex >= state.items.length) state.focusIndex = Math.max(0, state.items.length - 1);
    applyFrames();
    if (state.host) state.host.setAttribute('data-hex-count', String(state.items.length));
  }

  function unmount() {
    state.loadToken += 1;
    state.enteredKeys = {};
    if (state.rafId != null && global.cancelAnimationFrame) cancelAnimationFrame(state.rafId);
    state.rafId = null;
    if (state.commitTimer) clearTimeout(state.commitTimer);
    state.commitTimer = null;
    if (state.host) clearHost(state.host);
    state.host = null;
    state.field = null;
    state.world = null;
    state.items = [];
    state.coords = [];
    state.coordByKey = new Map();
    state.focusIndex = 0;
    state.offset = { dx: 0, dy: 0 };
    state.anim = null;
    state.drag = null;
    state.wheelTarget = null;
  }

  function refresh() {
    if (!state.host) return Promise.resolve(false);
    return mount(state.host);
  }

  SFV.posterWall = {
    mount: mount,
    unmount: unmount,
    refresh: refresh,
    centerOnIndex: centerOnIndex,
    getNode: function (index) {
      var entry = state.nodes[index];
      return entry ? entry.el : null;
    },
    coordOf: function (index) {
      return state.coords[index] || null;
    },
    getState: function () {
      return {
        count: state.items.length,
        focusIndex: state.focusIndex,
        mountedCount: Object.keys(state.mounted).length,
        offset: { dx: state.offset.dx, dy: state.offset.dy },
        dom: { field: state.field, world: state.world }
      };
    }
  };
})(typeof window !== 'undefined' ? window : this);
