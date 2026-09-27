/*
 * Stellaflix 影视模块 — 世界页行为（M3）
 *
 * 对齐 hearthere 的交互清单：
 *   Esc        关卡片 / 取消选中
 *   空格       切换地球自转
 *   R          重置视角（回到全球取景）
 *   F          收藏当前选中信标（收藏成功放烟花）
 *   定位       geolocation → 飞到最近的信标
 *   收藏       localStorage 持久化
 *   烟花       Canvas 2D 粒子，加色混合，3~5 秒消散
 *
 * 只在世界页挂载期间生效，不抢全局快捷键（输入框内不拦）。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  var FAV_KEY = 'stellaflix-world-favorites';
  var AUTO_ROTATE_KEY = 'stellaflix-world-auto-rotate';

  var viewer = null;
  var lh = null;
  var ui = null;
  var bound = false;
  var autoRotate = true;
  var rafId = 0;
  var rafRotate = 0;
  var lastTick = 0;
  var lastRotate = 0;
  var rotateWarned = false;
  var rotateRateDeg = 4; // 对齐 config 的 autoRotate=4 度/秒

  // ============================================================
  //  收藏
  // ============================================================
  function loadFavs() {
    try {
      var raw = global.localStorage && global.localStorage.getItem(FAV_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function saveFavs(list) {
    try {
      global.localStorage && global.localStorage.setItem(FAV_KEY, JSON.stringify(list));
    } catch (e) {}
  }

  function isFavorite(id) {
    return loadFavs().indexOf(id) >= 0;
  }

  function toggleFavorite(st) {
    if (!st) return false;
    var list = loadFavs();
    var i = list.indexOf(st.id);
    var now;
    if (i >= 0) { list.splice(i, 1); now = false; }
    else { list.push(st.id); now = true; }
    saveFavs(list);
    if (now) {
      celebrate();
      if (ui) ui.toast('已收藏「' + st.name + '」');
    } else if (ui) {
      ui.toast('已取消收藏「' + st.name + '」');
    }
    return now;
  }

  // ============================================================
  //  烟花（Canvas 2D 粒子，对齐 hearthere fireworks.js）
  // ============================================================
  var bursts = [];

  function celebrate(x, y) {
    if (!ui) return;
    var canvas = ui.fireworksCanvas();
    if (!canvas) return;
    var w = canvas.clientWidth || 800, h = canvas.clientHeight || 600;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    var cx = x != null ? x : w / 2;
    var cy = y != null ? y : h * 0.42;

    var colors = [
      [255, 110, 130], [120, 210, 255], [255, 210, 120],
      [170, 240, 190], [220, 150, 255], [255, 255, 255]
    ];
    var n = 3;
    for (var b = 0; b < n; b++) {
      var col = colors[Math.floor(Math.random() * colors.length)];
      var ox = cx + (Math.random() - 0.5) * w * 0.34;
      var oy = cy + (Math.random() - 0.5) * h * 0.28;
      var particles = [];
      var count = 60 + Math.floor(Math.random() * 40); // 60~100，对齐 hearthere
      for (var i = 0; i < count; i++) {
        var theta = Math.random() * Math.PI * 2;
        var phi = Math.acos(2 * Math.random() - 1);     // 球面均匀分布
        var speed = 2.2 + Math.random() * 3.4;
        particles.push({
          x: ox, y: oy,
          vx: Math.sin(phi) * Math.cos(theta) * speed,
          vy: Math.sin(phi) * Math.sin(theta) * speed * 0.85 - 1.1,
          life: 1,
          decay: 0.012 + Math.random() * 0.012
        });
      }
      bursts.push({ particles: particles, color: col, t: 0, flash: 1 });
    }
    if (!rafId) startLoop();
  }

  function startLoop() {
    lastTick = Date.now();
    var step = function () {
      var now = Date.now();
      var dt = Math.min(50, now - lastTick) / 16.67;
      lastTick = now;
      rafId = requestAnimationFrame(step);
      if (!ui) { rafId = 0; return; }
      var canvas = ui.fireworksCanvas();
      if (!canvas) return;
      var g = canvas.getContext('2d');
      if (!g) return;
      var w = canvas.width, h = canvas.height;
      g.globalCompositeOperation = 'source-over';
      g.clearRect(0, 0, w, h);
      g.globalCompositeOperation = 'lighter';

      for (var b = bursts.length - 1; b >= 0; b--) {
        var burst = bursts[b];
        burst.t += dt;
        var c = burst.color;

        // 开场闪光
        if (burst.flash > 0) {
          burst.flash = Math.max(0, burst.flash - 0.06 * dt);
          var fr = 26 + (1 - burst.flash) * 70;
          var grd = g.createRadialGradient(
            burst.particles[0].x, burst.particles[0].y, 0,
            burst.particles[0].x, burst.particles[0].y, fr
          );
          grd.addColorStop(0, 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (burst.flash * 0.8) + ')');
          grd.addColorStop(1, 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',0)');
          g.fillStyle = grd;
          g.beginPath();
          g.arc(burst.particles[0].x, burst.particles[0].y, fr, 0, Math.PI * 2);
          g.fill();
        }

        var alive = 0;
        for (var i = 0; i < burst.particles.length; i++) {
          var p = burst.particles[i];
          if (p.life <= 0) continue;
          alive++;
          p.vy += 0.045 * dt;       // 重力
          p.vx *= 0.985;            // 摩擦
          p.vy *= 0.985;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.life -= p.decay * dt;
          if (p.life <= 0) continue;
          var a = Math.max(0, p.life) * 0.9;
          g.fillStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
          g.fillRect(p.x - 1.1, p.y - 1.1, 2.2, 2.2);
        }
        if (!alive && burst.flash <= 0) bursts.splice(b, 1);
      }
      if (!bursts.length) {
        g.clearRect(0, 0, w, h);
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
    };
    rafId = requestAnimationFrame(step);
  }

  // ============================================================
  //  自转（相机绕地轴慢转，对齐 hearthere 的 autoRotate=4°/s）
  // ============================================================
  function setAutoRotate(on) {
    autoRotate = !!on;
    try {
      global.localStorage && global.localStorage.setItem(AUTO_ROTATE_KEY, autoRotate ? '1' : '0');
    } catch (e) {}
    if (autoRotate) startRotateLoop();
    else stopRotateLoop();
  }

  function startRotateLoop() {
    if (rafRotate) return;
    lastRotate = Date.now();
    var step = function () {
      rafRotate = requestAnimationFrame(step);
      if (!autoRotate || !viewer || !viewer.camera || !global.Cesium) return;
      var now = Date.now();
      var dt = Math.min(100, now - lastRotate) / 1000;
      lastRotate = now;
      try {
        // 绕世界 Z 轴公转相机 = 地球自转观感。
        // 注意 camera.rotate() 只改变相机朝向（原地转头），不会绕地心公转，
        // 所以这里显式重算位置 + 同步 heading。
        var C = global.Cesium;
        var cam = viewer.camera;
        var angle = (rotateRateDeg * Math.PI / 180) * dt;
        var rot = C.Matrix3.fromRotationZ(-angle);
        var newPos = C.Matrix3.multiplyByVector(rot, cam.positionWC, new C.Cartesian3());
        cam.setView({
          destination: newPos,
          orientation: {
            heading: cam.heading - angle,
            pitch: cam.pitch,
            roll: cam.roll
          }
        });
      } catch (e) {
        if (!rotateWarned) {
          rotateWarned = true;
          console.warn('[world-actions] 自转失败', e);
        }
      }
    };
    rafRotate = requestAnimationFrame(step);
  }

  function stopRotateLoop() {
    if (rafRotate) { cancelAnimationFrame(rafRotate); rafRotate = 0; }
  }

  // ============================================================
  //  重置视角
  // ============================================================
  function resetView() {
    if (!viewer || !global.Cesium) return;
    var C = global.Cesium;
    var r = 6378137;
    try {
      // 不调 lookAtTransform(IDENTITY)：世界页从不走 camera.lookAt 锁定，
      // 那一句反而会干扰 screenSpaceCameraController 的输入状态。
      // 显式把相机输入打开，防止上一次交互把 enableInputs 关掉。
      setAutoRotate(false);
      if (viewer.scene && viewer.scene.screenSpaceCameraController) {
        viewer.scene.screenSpaceCameraController.enableInputs = true;
      }
      // 注意：不要用 lookAt / lookAtTransform —— 自转循环的 setView 会与 transform 打架
      viewer.camera.setView({
        destination: C.Cartesian3.fromDegrees(10, 20, r * 2.8),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 }
      });
      if (lh && typeof lh.applyTier === 'function') lh.applyTier();
      if (ui) ui.toast('视角已重置');
    } catch (e) {
      console.warn('[world-actions] resetView 失败', e);
    }
  }

  // ============================================================
  //  定位我的位置
  // ============================================================
  function locateNearest() {
    if (!lh || !ui) return;
    if (!global.navigator || !global.navigator.geolocation) {
      ui.toast('当前环境不支持定位');
      return;
    }
    ui.toast('正在定位…', 1500);
    global.navigator.geolocation.getCurrentPosition(function (pos) {
      var lat = pos.coords.latitude, lon = pos.coords.longitude;
      var best = null, bestD = Infinity;
      var stations = lh.stations || [];
      for (var i = 0; i < stations.length; i++) {
        var s = stations[i].def;
        var dLat = (s.lat - lat) * Math.PI / 180;
        var dLon = (s.lon - lon) * Math.PI / 180;
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(lat * Math.PI / 180) * Math.cos(s.lat * Math.PI / 180) *
          Math.sin(dLon / 2) * Math.sin(dLon / 2);
        var d = 2 * Math.asin(Math.sqrt(a));
        if (d < bestD) { bestD = d; best = s; }
      }
      if (!best) { ui.toast('附近没有信标'); return; }
      ui.toast('离你最近的是「' + best.name + '」');
      flyTo(best);
    }, function () {
      ui.toast('定位失败（可能未授权）');
    }, { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 });
  }

  function flyTo(st) {
    if (!viewer || !st || !global.Cesium) return;
    var C = global.Cesium;
    try {
      // 用户主动导航 → 立刻停自转。否则自转循环的 setView 会和 flyTo 抢相机。
      setAutoRotate(false);
      if (viewer.scene && viewer.scene.screenSpaceCameraController) {
        viewer.scene.screenSpaceCameraController.enableInputs = true;
      }
      viewer.camera.flyTo({
        destination: C.Cartesian3.fromDegrees(st.lon, st.lat, 260000),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        duration: 1.4
      });
    } catch (e) {
      console.warn('[world-actions] flyTo 失败', e);
    }
  }

  // ============================================================
  //  快捷键
  // ============================================================
  function isTyping(e) {
    var t = e && e.target;
    if (!t) return false;
    var tag = (t.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
  }

  // 吃掉事件，避免触发 App 的全局热键：
  //   Space → player-controller.js 的播放/暂停
  //   R     → 06-keyboard-camera-events.js 的自由相机开关（会 cursor:none 隐藏鼠标）
  //   Esc   → online-nav.js 关闭整个浏览覆盖层
  function consume(e) {
    if (!e) return;
    if (e.preventDefault) e.preventDefault();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    else if (e.stopPropagation) e.stopPropagation();
  }

  function onKeydown(e) {
    if (!bound || isTyping(e)) return;
    var k = e.key;

    if (k === 'Escape') {
      // 只有卡片开着才吃掉 Esc；否则放行给 App（关闭浏览层）
      if (ui && ui.cardEl) { ui.hideCard(); consume(e); }
      return;
    }
    if (k === 'r' || k === 'R' || e.code === 'KeyR') {
      resetView();
      consume(e);
      return;
    }
    if (k === 'a' || k === 'A' || e.code === 'KeyA') {
      setAutoRotate(!autoRotate);
      if (ui) {
        ui.toast(autoRotate ? '地球自转已开启' : '地球自转已关闭');
        if (ui.setRotateState) ui.setRotateState(autoRotate);
      }
      consume(e);
      return;
    }
    if (k === 'f' || k === 'F' || e.code === 'KeyF') {
      var cur = lh && lh.selectedId ? findStation(lh.selectedId) : null;
      if (!cur) {
        var card = ui && ui.cardEl;
        var id = card && card.getAttribute && card.getAttribute('data-station-id');
        cur = id ? findStation(id) : null;
      }
      if (cur) toggleFavorite(cur);
      else if (ui) ui.toast('先点一座信标，再按 F 收藏');
      consume(e);
    }
    // 空格不劫持：留给 App 的播放/暂停。自转用 A 切换。
  }

  function findStation(id) {
    if (!lh || !lh.stations) return null;
    for (var i = 0; i < lh.stations.length; i++) {
      if (lh.stations[i].def && lh.stations[i].def.id === id) return lh.stations[i].def;
    }
    return null;
  }

  // ============================================================
  //  挂载 / 卸载
  // ============================================================
  function mount(viewerRef, lhRef, uiRef) {
    unmount();
    viewer = viewerRef;
    lh = lhRef;
    ui = uiRef;
    bound = true;
    try {
      var saved = global.localStorage && global.localStorage.getItem(AUTO_ROTATE_KEY);
      autoRotate = saved !== '0';
    } catch (e) { autoRotate = true; }
    global.addEventListener('keydown', onKeydown, true);
    if (autoRotate) startRotateLoop();
  }

  function unmount() {
    bound = false;
    global.removeEventListener('keydown', onKeydown, true);
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    stopRotateLoop();
    bursts = [];
    viewer = null; lh = null; ui = null;
  }

  SFV.worldActions = {
    mount: mount,
    unmount: unmount,
    isFavorite: isFavorite,
    toggleFavorite: toggleFavorite,
    celebrate: celebrate,
    locateNearest: locateNearest,
    resetView: resetView,
    flyTo: flyTo,
    setAutoRotate: setAutoRotate,
    get autoRotate() { return autoRotate; },
    FAV_KEY: FAV_KEY
  };
})(typeof window !== 'undefined' ? window : this);
