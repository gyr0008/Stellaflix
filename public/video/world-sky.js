/*!
 * 世界页天空三段链（轮㉕，主人 2026-10-03 裁决移植）—— 逐字 hearthere main.pretty.js
 *   ① StarColor 星野随播变色 :19368-19386（setSpace preset:stars）
 *   ② DynamicSky 昼夜天空 :10491-10610（SunCalc 高度角 → rh 11 档色表 → setSky；60s + move 500ms 节流）
 *   ③ halo 换轨补间 :10406-10479（1500ms rAF 线性，gradient.scale=1.2 + 3 档 stops 直写）
 * 驱动源偏差（已裁决）：hearthre 用 playbackState（收听面），我们无收听面 → 以「选中灯塔」驱动。
 * SunCalc 摘录保留 hearthere 打包 literal siderealTime 280.16（非社区标准 280.46061837）——逐字保真。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  // ---------- SunCalc getPosition 链（vendor-BFcK9zOb.js a8 摘录，公式逐字） ----------
  var PI = Math.PI, sin = Math.sin, cos = Math.cos, tan = Math.tan,
    asin = Math.asin, atan2 = Math.atan2,
    rad = PI / 180, dayMs = 1e3 * 60 * 60 * 24, J1970 = 2440588, J2000 = 2451545;
  var obliquity = rad * 23.4397;
  function toDays(date) { return date.valueOf() / dayMs - .5 + J1970 - J2000; }
  function rightAscension(l) { return atan2(sin(l) * cos(obliquity), cos(l)); }
  function declination(l) { return asin(sin(obliquity) * sin(l)); }
  function azimuthOf(H, phi, dec) { return atan2(sin(H), cos(H) * sin(phi) - tan(dec) * cos(phi)); }
  function altitudeOf(H, phi, dec) { return asin(sin(phi) * sin(dec) + cos(phi) * cos(dec) * cos(H)); }
  function siderealTime(d, lw) { return rad * (280.16 + 360.9856235 * d) - lw; }
  function solarMeanAnomaly(d) { return rad * (357.5291 + .98560028 * d); }
  function eclipticLongitude(M) {
    var C = rad * (1.9148 * sin(M) + .02 * sin(2 * M) + 3e-4 * sin(3 * M)),
      P = rad * 102.9372;
    return M + C + P + PI;
  }
  function sunCoords(d) {
    var M = solarMeanAnomaly(d), L = eclipticLongitude(M);
    return { dec: declination(L), ra: rightAscension(L) };
  }
  function sunPosition(date, lat, lng) {
    var lw = rad * -lng, phi = rad * lat, d = toDays(date), c = sunCoords(d),
      H = siderealTime(d, lw) - c.ra;
    return { azimuth: azimuthOf(H, phi, c.dec), altitude: altitudeOf(H, phi, c.dec) };
  }

  // ---------- DynamicSky：高度角→天空色（ih/ah/kn/gi/rh 逐字 :10491-10563） ----------
  var SKY_STOPS = [
    [-18, [10, 14, 26], [13, 17, 23]],
    [-12, [15, 27, 45], [20, 30, 48]],
    [-6, [30, 39, 68], [45, 45, 92]],
    [-3, [44, 63, 100], [142, 69, 133]],
    [0, [74, 122, 181], [255, 107, 53]],
    [3, [92, 148, 197], [255, 160, 64]],
    [8, [107, 163, 208], [255, 204, 112]],
    [15, [123, 181, 220], [232, 220, 200]],
    [30, [90, 159, 212], [197, 220, 232]],
    [50, [74, 144, 217], [176, 207, 224]],
    [70, [65, 135, 210], [176, 207, 224]]
  ];
  function lerpColor(t, e, n) {
    var o = Math.max(0, Math.min(1, n));
    return [Math.round(t[0] + (e[0] - t[0]) * o), Math.round(t[1] + (e[1] - t[1]) * o), Math.round(t[2] + (e[2] - t[2]) * o)];
  }
  function rgb(t) { return `rgb(${t[0]},${t[1]},${t[2]})`; }
  function skyColorsForAltitude(deg) {
    var e = SKY_STOPS;
    if (deg <= e[0][0]) return { skyColor: rgb(e[0][1]), horizonColor: rgb(e[0][2]) };
    if (deg >= e[e.length - 1][0]) return { skyColor: rgb(e[e.length - 1][1]), horizonColor: rgb(e[e.length - 1][2]) };
    for (var n = 0; n < e.length - 1; n++) {
      var a0 = e[n], b0 = e[n + 1];
      if (deg >= a0[0] && deg <= b0[0]) {
        var o = (deg - a0[0]) / (b0[0] - a0[0]);
        return { skyColor: rgb(lerpColor(a0[1], b0[1], o)), horizonColor: rgb(lerpColor(a0[2], b0[2], o)) };
      }
    }
    return { skyColor: '#88C6FC', horizonColor: '#ffffff' };
  }
  function toDeg(r) { return r * (180 / Math.PI); }

  var nowFn = null; // 测试/特殊环境时钟注入口
  function getNow() { return nowFn ? nowFn() : new Date(); }

  // uh 逐字 :10565-10583：playing 只写 sky-color，horizon 让位给曲目色
  function updateSky(map, isPlaying) {
    if (!map) return;
    try {
      var c = map.getCenter(),
        alt = toDeg(sunPosition(getNow(), c.lat, c.lng).altitude),
        col = skyColorsForAltitude(alt);
      if (isPlaying) {
        map.setSky({ 'sky-color': col.skyColor });
      } else {
        map.setSky({ 'sky-color': col.skyColor, 'horizon-color': col.horizonColor });
      }
    } catch (e) {
      console.warn('[DynamicSky] updateSkyColor 失败:', e);
    }
  }

  // ---------- StarColor 逐字 :19371-19384 ----------
  function applySpace(map, colorTop, isPlaying) {
    if (!map) return false;
    try {
      if (isPlaying && colorTop) {
        map.setSpace({ color: `rgb(${colorTop[0]},${colorTop[1]},${colorTop[2]})`, preset: 'stars' });
      } else {
        map.setSpace({ color: '#ffffff', preset: 'stars' });
      }
      return true;
    } catch (e) {
      console.warn('[StarColor] setSpace 调用失败:', e);
      return false;
    }
  }

  // ---------- :19390-19396 播放态地平色接管 ----------
  function applyHorizonColor(map, colorTop) {
    if (!map || !colorTop) return false;
    try {
      map.setSky({ 'horizon-color': `rgb(${colorTop[0]},${colorTop[1]},${colorTop[2]})` });
      return true;
    } catch (e) {
      console.warn('[SkyColor] setSky horizon 调用失败:', e);
      return false;
    }
  }

  // ---------- halo 补间 逐字 hi/th/sh/oh :10406-10479 ----------
  var HALO_DEFAULT = [255, 255, 255],      // Dt
    HALO_DURATION = 1500,                   // mi
    HALO_SCALE = 1.2;                       // nh
  function haloStops(top, bottom) {
    var n = top[0], o = top[1], r0 = top[2], i0 = bottom[0], l0 = bottom[1], c0 = bottom[2];
    return [
      [0, `rgba(${n}, ${o}, ${r0}, 0.35)`],
      [.4, `rgba(${i0}, ${l0}, ${c0}, 0.18)`],
      [.8, `rgba(${i0}, ${l0}, ${c0}, 0)`]
    ];
  }
  function applyStops(gradient, stops) {
    try {
      if (!gradient) return;
      gradient.scale = HALO_SCALE;
      gradient.stops = stops;
    } catch (e) {
      console.warn('[HaloTransition] applyStopsDirectly 失败:', e);
    }
  }
  function HaloTween() {
    this.fromTop = HALO_DEFAULT.slice(); this.fromBottom = HALO_DEFAULT.slice();
    this.toTop = HALO_DEFAULT.slice(); this.toBottom = HALO_DEFAULT.slice();
    this.startTime = 0; this.duration = HALO_DURATION;
    this.active = false; this.finished = false;
    this.currentTop = HALO_DEFAULT.slice(); this.currentBottom = HALO_DEFAULT.slice();
  }
  HaloTween.prototype.startTransition = function (fromT, fromB, toT, toB, start, dur) {
    if (this.active && !this.finished) {
      this.fromTop = this.currentTop.slice(); this.fromBottom = this.currentBottom.slice();
    } else { this.fromTop = fromT; this.fromBottom = fromB; }
    this.toTop = toT; this.toBottom = toB;
    this.startTime = start; this.duration = dur || HALO_DURATION;
    this.active = true; this.finished = false;
  };
  HaloTween.prototype.tick = function (now) {
    if (!this.active || this.finished) return null;
    var o = Math.min((now - this.startTime) / this.duration, 1);
    this.currentTop = lerpColor(this.fromTop, this.toTop, o);
    this.currentBottom = lerpColor(this.fromBottom, this.toBottom, o);
    var stops = haloStops(this.currentTop, this.currentBottom);
    if (o >= 1) this.finished = true;
    return stops;
  };

  var tween = new HaloTween();
  var current = { top: HALO_DEFAULT.slice(), bottom: HALO_DEFAULT.slice() }; // oh 的 l ref
  var haloRafId = 0;

  function transitionHalo(map, toTop, toBottom) {
    if (!map || !toTop || !toBottom) return false;
    var h = current;
    if (toTop[0] === h.top[0] && toTop[1] === h.top[1] && toTop[2] === h.top[2] &&
      toBottom[0] === h.bottom[0] && toBottom[1] === h.bottom[1] && toBottom[2] === h.bottom[2]) return false;
    var gradient;
    try { gradient = map.getHalo(); } catch (e) { gradient = null; }
    if (!gradient) {
      console.warn('[HaloTransition] halo layer 未初始化');
      return false;
    }
    tween.startTransition(h.top, h.bottom, toTop, toBottom, global.performance ? performance.now() : Date.now());
    current = { top: toTop.slice(), bottom: toBottom.slice() };
    if (haloRafId) cancelAnimationFrame(haloRafId);
    var step = function () {
      var y = tween.tick(global.performance ? performance.now() : Date.now());
      if (y) {
        applyStops(gradient, y);
        map.triggerRepaint();
        haloRafId = requestAnimationFrame(step);
      } else {
        haloRafId = 0;
      }
    };
    haloRafId = requestAnimationFrame(step);
    return true;
  }

  // ---------- 生命周期与编排（dh :10585-10610 调度 + 已裁决「选中灯塔」驱动） ----------
  var MOVE_THROTTLE_MS = 500,  // lh
    SKY_INTERVAL_MS = 6e4;     // ch
  var _map = null, _isPlaying = false, _intervalId = 0, _moveFn = null, _lastBeat = 0;

  function applyStation(st) {
    var playing = !!(st && st.status === 'playing' && st.colorTop && st.colorTop.length === 3);
    _isPlaying = playing;
    if (!_map) return;
    applySpace(_map, playing ? st.colorTop : null, playing);
    if (playing) {
      applyHorizonColor(_map, st.colorTop);
      transitionHalo(_map, st.colorTop.slice(), (st.colorBottom || st.colorTop).slice());
    } else {
      transitionHalo(_map, HALO_DEFAULT.slice(), HALO_DEFAULT.slice());
    }
    updateSky(_map, playing); // dh effect deps 变更即重拍
  }

  function mount(map) {
    if (!map) return;
    _map = map;
    _lastBeat = 0;
    updateSky(map, _isPlaying); // 初始一拍（dh 首 effect :10596-10598）
    _intervalId = setInterval(function () { updateSky(_map, _isPlaying); }, SKY_INTERVAL_MS);
    _moveFn = function () {
      var c = Date.now();
      if (c - _lastBeat < MOVE_THROTTLE_MS) return; // uh 节流支路逐字
      _lastBeat = c;
      updateSky(_map, _isPlaying);
    };
    map.on('move', _moveFn);
  }

  function unmount() {
    if (_intervalId) { clearInterval(_intervalId); _intervalId = 0; }
    if (_map && _moveFn) { _map.off('move', _moveFn); }
    _moveFn = null; _map = null;
    if (haloRafId) { cancelAnimationFrame(haloRafId); haloRafId = 0; }
    tween = new HaloTween();
    current = { top: HALO_DEFAULT.slice(), bottom: HALO_DEFAULT.slice() };
    _isPlaying = false;
  }

  SFV.worldSky = {
    sunPosition: sunPosition,
    skyColorsForAltitude: skyColorsForAltitude,
    updateSky: updateSky,
    applySpace: applySpace,
    applyHorizonColor: applyHorizonColor,
    lerpColor: lerpColor,
    haloStops: haloStops,
    transitionHalo: transitionHalo,
    mount: mount,
    unmount: unmount,
    applyStation: applyStation,
    peekState: function () { return { isPlaying: _isPlaying, top: current.top, bottom: current.bottom }; },
    __setNow: function (fn) { nowFn = fn; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
