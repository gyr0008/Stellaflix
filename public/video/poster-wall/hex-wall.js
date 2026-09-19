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
    anim: null,         // { targetX, targetY, velX, velY }
    drag: null,
    commitTimer: null,
    loadToken: 0,
    lastOpen: { id: null, at: 0 }
  };

  function pickMetrics(viewW) {
    var cardW = viewW < 700 ? 104 : (viewW < 1100 ? 118 : 132);
    var cardH = Math.round(cardW * 1.5);
    return {
      cardW: cardW,
      cardH: cardH,
      spacingX: Math.round(cardW * 1.16),
      spacingY: Math.round(cardH * 1.1),
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
      maxDistance: Math.max(halfDiag, 1),
      lodStart: Math.min(vp.w, vp.h) * 0.28,
      lodEnd: Math.min(vp.w, vp.h) * 0.55,
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

    var art = doc.createElement('div');
    art.className = 'sfv-hex-art';
    if (item.poster) {
      art.style.backgroundImage = 'url("' + String(item.poster).replace(/"/g, '\\"') + '")';
    }
    card.appendChild(art);

    var shade = doc.createElement('div');
    shade.className = 'sfv-hex-shade';
    card.appendChild(shade);

    var copy = doc.createElement('div');
    copy.className = 'sfv-hex-copy';
    var strong = doc.createElement('strong');
    strong.textContent = item.title || '';
    copy.appendChild(strong);
    card.appendChild(copy);

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
    card.appendChild(chrome);

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
    } else {
      stepAnimation();
      applyFrames();
    }
  }

  // 临界阻尼弹簧（对齐 Folia stiffness 220 / damping 28）
  function stepAnimation() {
    var anim = state.anim;
    if (!anim) return;
    var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    var dt = anim.last ? Math.min((now - anim.last) / 1000, 0.033) : 0.016;
    anim.last = now;
    var stiffness = 220;
    var damping = 28;
    var ax = (anim.targetX - state.offset.dx) * stiffness - anim.velX * damping;
    var ay = (anim.targetY - state.offset.dy) * stiffness - anim.velY * damping;
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

  // ---------- 输入 ----------

  function attachInput() {
    var field = state.field;
    field.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var factor = ev.deltaMode === 1 ? 33 : (ev.deltaMode === 2 ? viewportSize().h : 1);
      state.anim = null;
      state.offset.dx -= (ev.deltaX || 0) * factor;
      state.offset.dy -= (ev.deltaY || 0) * factor;
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
        if (global.requestAnimationFrame) {
          state.anim = {
            targetX: state.offset.dx + vx * 0.18,
            targetY: state.offset.dy + vy * 0.18,
            velX: 0, velY: 0, last: 0
          };
          requestFrame();
        }
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
    clearHost(host);
    host.innerHTML = '<div class="sfv-hex-loading">正在从 TMDB 拉取多品类海报…</div>';
    host.setAttribute('data-sfv-library-wall', 'loading');

    return A.collectWallItemsAsync().then(function (res) {
      if (token !== state.loadToken || state.host !== host) return false;
      if (res.keyMissing && (!res.items || !res.items.length)) {
        state.items = [];
        clearHost(host);
        renderEmpty(host, 'key');
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

  function unmount() {
    state.loadToken += 1;
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
