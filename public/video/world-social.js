/*
 * Stellaflix 影视模块 — 世界页社交层（Task 8）
 *
 * 语义移植自 HearThere（main.pretty.js :238-240「收听奖励」）：
 *   · 轮⑱（2026-10-02 用户裁决）改「无限点火」：库存/看完整片记账链整体退役，
 *     light() 恒发布；「选中灯塔」门槛在 UI 侧（world-ui）判定
 *   · 全站频道 /api/room/fireworks、/api/room/likes：轮询信箱模式（对齐 Task 7，无 SSE/WS）
 *
 * 烟花粒子引擎移植自 public/video/world-actions.js:77-177（旧 Cesium 时代死模块，
 *   新 page-world 不再调其 celebrate；此处最小移植，参数不动：60~100 粒/发、
 *   球面分布、重力 vy+=0.045、摩擦 vx*=0.985、globalCompositeOperation='lighter'）。
 *
 * 竞态防护：轮询 start/stop 可重入（start 先清旧 interval）；since 增量拉取。
 * 依赖注入：configure({now, fetch, localStorage, setInterval, clearInterval,
 *   requestAnimationFrame, cancelAnimationFrame}) —— 全部可桩，测试不依赖真实时钟。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  // ---- 注入面（测试桩入口；默认取浏览器全局） ----
  var deps = {};
  function configure(o) {
    if (!o) return;
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) deps[k] = o[k];
  }
  function dnow() {
    return typeof deps.now === 'function' ? deps.now() : Date.now();
  }
  function dfetch() {
    var f = deps.fetch !== undefined ? deps.fetch : global.fetch;
    return typeof f === 'function' ? f : null;
  }
  function dsetInterval(fn, ms) {
    var f = deps.setInterval || global.setInterval;
    return f ? f(fn, ms) : 0;
  }
  function dclearInterval(id) {
    var f = deps.clearInterval || global.clearInterval;
    if (f && id) f(id);
  }
  function draf(fn) {
    var f = deps.requestAnimationFrame || global.requestAnimationFrame;
    return f ? f(fn) : 0;
  }
  function dcaf(id) {
    var f = deps.cancelAnimationFrame || global.cancelAnimationFrame;
    if (f && id) f(id);
  }

  // ============================================================
  //  发布面（fire-and-forget；静默失败绝不 throw）
  // ============================================================
  function deviceIdForPublish() {
    var s = SFV.worldRoom && SFV.worldRoom.session;
    if (s && s.deviceId) return String(s.deviceId);
    try {
      var sec = SFV.lighthouse && SFV.lighthouse.security;
      if (sec && typeof sec.getDeviceId === 'function') return String(sec.getDeviceId());
    } catch (e) {}
    return 'anon';
  }

  // baseUrl 规则与 world-sync.js 一致：同源优先，兜底本机 3000
  function channelUrl(channel, query) {
    var base = 'http://127.0.0.1:3000/api';
    if (typeof global.location !== 'undefined' && global.location && global.location.origin) {
      base = global.location.origin + '/api';
    }
    return base + '/room/' + channel + (query || '');
  }

  function publish(channel, stationId) {
    var f = dfetch();
    if (!f) return;
    try {
      Promise.resolve(f(channelUrl(channel), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceId: deviceIdForPublish(),
          payload: { stationId: String(stationId || '').slice(0, 32) }
        })
      })).catch(function () {});
    } catch (e) {}
  }

  /** 轮⑱ 点火：无限化 —— 恒 POST 广播并返回 true（库存门槛退役；「选中灯塔」判定在 UI 侧）。 */
  function light(stationId) {
    publish('fireworks', stationId);
    return true;
  }
  // 轮⑯（2026-10-02 用户裁决）：like() 发布面退役——轮⑫ 删除点赞按钮后零调用方；
  // likes 频道的接收面（onLike toast）与轮询保留。

  // ============================================================
  //  订阅轮询信箱：GET ?since=N 增量 → onFirework(payload) / onLike(payload)
  //  默认 5000ms —— 控制方裁决：HearThere 的 20s 事件延迟对烟花无意义，
  //  5s 是「信箱不空转、点击感知不拖沓」的折中。
  // ============================================================
  var DEFAULT_POLL_MS = 5000;
  var pollCtl = 0;
  var since = { fireworks: 0, likes: 0 };
  var fwSubs = [];
  var lkSubs = [];

  function subscribe(list, fn) {
    if (typeof fn !== 'function') return function () {};
    list.push(fn);
    return function () {
      var i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }
  function onFirework(fn) { return subscribe(fwSubs, fn); }
  function onLike(fn) { return subscribe(lkSubs, fn); }

  function emitTo(list, payload) {
    for (var i = 0; i < list.length; i++) {
      try { list[i](payload); } catch (e) {}
    }
  }

  function pollChannel(f, channel) {
    var p;
    try {
      p = Promise.resolve(f(channelUrl(channel, '?since=' + since[channel]), { method: 'GET' }));
    } catch (e) { return Promise.resolve(0); }   // fetch 同步抛错也静默
    return p.then(function (r) {
      if (!r || !r.ok) return 0;
      return r.json().then(function (data) {
        if (!data || !data.ok) return 0;
        var items = Array.isArray(data.items) ? data.items : [];
        var delivered = 0;
        for (var i = 0; i < items.length; i++) {
          var m = items[i];
          if (!m || !(m.seq > since[channel])) continue;
          emitTo(channel === 'fireworks' ? fwSubs : lkSubs, (m && m.payload) || {});
          delivered++;
        }
        if (typeof data.seq === 'number' && data.seq > since[channel]) since[channel] = data.seq;
        return delivered;
      });
    }, function () { return 0; })
      .catch(function () { return 0; });   // r.json() 失败/回调内异常同样静默，绝不打断轮询
  }

  /** 手动拉一轮（start 的循环体也走它）；返回本轮投递条数。 */
  function pollOnce() {
    var f = dfetch();
    if (!f) return Promise.resolve(0);
    return Promise.all([pollChannel(f, 'fireworks'), pollChannel(f, 'likes')])
      .then(function (rs) { return (rs[0] || 0) + (rs[1] || 0); });
  }

  /** 可重入：重复 start 先清旧 interval，任何时刻至多一枚定时器。 */
  function start(pollMs) {
    stop();
    var ms = Number(pollMs) > 0 ? Number(pollMs) : DEFAULT_POLL_MS;
    pollCtl = dsetInterval(function () { pollOnce(); }, ms);
  }
  function stop() {
    if (pollCtl) { dclearInterval(pollCtl); pollCtl = 0; }
  }
  function running() { return !!pollCtl; }

  // ============================================================
  //  烟花粒子引擎（Canvas 2D）
  //  移植自 public/video/world-actions.js:77-177（celebrate/startLoop），
  //  粒子参数原样保留：60~100 粒/发、球面分布、重力、摩擦、加色混合。
  //  canvas 由调用方传入（world-ui 的 fireworksCanvas()），不再绑死 ui 模块。
  // ============================================================
  var bursts = [];
  var rafId = 0;
  var engineCanvas = null;
  var lastTick = 0;

  function celebrate(canvas, x, y) {
    if (!canvas) return;
    engineCanvas = canvas;
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
    lastTick = dnow();
    var step = function () {
      var now = dnow();
      var dt = Math.min(50, now - lastTick) / 16.67;
      lastTick = now;
      rafId = draf(step);
      if (!engineCanvas) { rafId = 0; return; }
      var canvas = engineCanvas;
      var g = canvas.getContext ? canvas.getContext('2d') : null;
      if (!g) { stopLoop(); return; }
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
        stopLoop();
      }
    };
    rafId = draf(step);
  }
  function stopLoop() {
    if (rafId) { dcaf(rafId); rafId = 0; }
  }

  SFV.worldSocial = {
    configure: configure,
    light: light,
    pollOnce: pollOnce,
    start: start,
    stop: stop,
    running: running,
    onFirework: onFirework,
    onLike: onLike,
    celebrate: celebrate,
    stopLoop: stopLoop,
    DEFAULT_POLL_MS: DEFAULT_POLL_MS
  };
})(typeof window !== 'undefined' ? window : this);
