/*
 * 影视 SR — 引擎主体：把 <video> 帧经 vendor 滤镜链渲染到 overlay 内的 canvas。
 * 订阅 sfv:player-open/meta/close 自管理生命周期，player.js 零改动。
 * 语义要点（与 mpv 等价的顺序执行模型）：
 *   - PREKERNEL 钩子 ≈ 当前 MAIN；无 SAVE 默认写回钩子纹理；HOOKED 为别名。
 *   - LUMA 链（FSRCNNX）：亮度抽取 → 链式超分 → 亮度增量重建 RGB。
 *   - OUTPUT = canvas 上视频 contain 矩形（像素），NATIVE = 源分辨率。
 */
(function (global) {
  'use strict';
  var SFV = global.StellaflixVideo = global.StellaflixVideo || {};
  if (SFV.srEngine) return;
  var DOC = global.document;

  // ---- 引擎内建 shader ----
  var LUMA_FS = [
    '#version 300 es', 'precision highp float;', 'in vec2 v_uv;',
    'layout(location = 0) out vec4 fragColor;', 'uniform sampler2D MAIN;',
    'void main() {',
    '  float y = dot(texture(MAIN, v_uv).rgb, vec3(0.2126, 0.7152, 0.0722));',
    '  fragColor = vec4(y, y, y, 1.0);',
    '}'
  ].join('\n');
  var RECOMBINE_FS = [
    '#version 300 es', 'precision highp float;', 'in vec2 v_uv;',
    'layout(location = 0) out vec4 fragColor;',
    'uniform sampler2D MAIN;', 'uniform sampler2D LUMA;',
    'void main() {',
    '  vec3 up = texture(MAIN, v_uv).rgb;',
    '  float y0 = dot(up, vec3(0.2126, 0.7152, 0.0722));',
    '  float y1 = texture(LUMA, v_uv).x;',
    '  fragColor = vec4(clamp(up + (y1 - y0), 0.0, 1.0), 1.0);',
    '}'
  ].join('\n');
  var REFINE_FS = [
    '#version 300 es', 'precision highp float;', 'in vec2 v_uv;',
    'layout(location = 0) out vec4 fragColor;',
    'uniform sampler2D MAIN;', 'uniform vec2 MAIN_pt;',
    'void main() {',
    '  vec3 c = texture(MAIN, v_uv).rgb;',
    '  vec3 b = texture(MAIN, v_uv + vec2(-1.0, -1.0) * MAIN_pt).rgb',
    '         + texture(MAIN, v_uv + vec2( 0.0, -1.0) * MAIN_pt).rgb * 2.0',
    '         + texture(MAIN, v_uv + vec2( 1.0, -1.0) * MAIN_pt).rgb',
    '         + texture(MAIN, v_uv + vec2(-1.0,  0.0) * MAIN_pt).rgb * 2.0',
    '         + c * 4.0',
    '         + texture(MAIN, v_uv + vec2( 1.0,  0.0) * MAIN_pt).rgb * 2.0',
    '         + texture(MAIN, v_uv + vec2(-1.0,  1.0) * MAIN_pt).rgb',
    '         + texture(MAIN, v_uv + vec2( 0.0,  1.0) * MAIN_pt).rgb * 2.0',
    '         + texture(MAIN, v_uv + vec2( 1.0,  1.0) * MAIN_pt).rgb;',
    '  b /= 16.0;',
    '  vec3 d = clamp(c - b, vec3(-0.16), vec3(0.16));',
    '  float edge = clamp(length(d) * 6.0, 0.0, 1.0);',
    '  fragColor = vec4(clamp(c + d * 0.55 * edge, 0.0, 1.0), 1.0);',
    '}'
  ].join('\n');
  var BLIT_FS = [
    '#version 300 es', 'precision highp float;', 'in vec2 v_uv;',
    'layout(location = 0) out vec4 fragColor;', 'uniform sampler2D MAIN;',
    'void main() { fragColor = vec4(texture(MAIN, v_uv).rgb, 1.0); }'
  ].join('\n');

  // contain 矩形（object-fit:contain 的像素几何，导出供单测）
  function containRect(cw, ch, vw, vh) {
    if (!cw || !ch || !vw || !vh) return { x: 0, y: 0, w: cw || 0, h: ch || 0 };
    var scale = Math.min(cw / vw, ch / vh);
    var w = Math.round(vw * scale), h = Math.round(vh * scale);
    return { x: Math.floor((cw - w) / 2), y: Math.floor((ch - h) / 2), w: w, h: h };
  }

  var state = {
    core: null, canvas: null, videoEl: null,
    presetId: 'off', preset: null,      // preset: {id, mode:'rgb'|'luma', files:[], refine:bool}
    parsed: null, programs: null,       // 链描述
    running: false, rVFC: -1, rafId: 0, embed: false, proxiedRetry: false,
    sig: '',                            // srcW×srcH×outW×outH 链签名
    activePlan: null,                   // 本次尺寸下要执行的 pass 序列
    status: 'idle', reason: '',
    statsCb: null, degradeCb: null,
    frameTimes: [], lastDegradeTs: 0,
    fps: 0, frames: 0, fpsTs: 0,
    // ===== 黑屏看门狗 + 首帧延迟隐藏（Fix: 防止 SR 渲染失败导致永久黑屏）=====
    paintedFrames: 0,                   // 本次会话成功绘制的 canvas 帧数
    videoHidden: false,                 // 是否已对 video 加 sfv-sr-source-hidden
    watchdogTimer: 0,                   // 看门狗 setTimeout id（0 = 未启动）
    rafFallbackId: 0,                   // rVFC 并行 RAF 兜底调度 id（防止 MSE 下 rVFC 不回调）
    rVFCSeen: false                     // 本会话是否已收到过 rVFC 回调（用于判断 RAF 兜底是否可停）
  };

  function overlay() { return DOC.getElementById('sfv-overlay'); }
  function getVideoEl() {
    if (SFV.player && SFV.player.getVideoEl) return SFV.player.getVideoEl();
    return null;
  }

  function ensureCanvas() {
    if (state.canvas) return state.canvas;
    var host = overlay();
    if (!host) return null;
    var c = DOC.createElement('canvas');
    c.id = 'sfv-sr-canvas';
    c.className = 'sfv-sr-canvas';
    host.insertBefore(c, host.firstChild);
    state.canvas = c;
    return c;
  }
  function ensureCore() {
    if (state.core) return state.core;
    var c = ensureCanvas();
    if (!c) return null;
    var core = SFV.srCore.createCore(c);
    if (!core) { state.status = 'unsupported'; state.reason = 'WebGL2 不可用'; return null; }
    state.core = core;
    return core;
  }

  function resizeCanvas() {
    var c = state.canvas, v = state.videoEl;
    if (!c || !v) return;
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    var cw = Math.max(2, Math.round(c.clientWidth * dpr));
    var ch = Math.max(2, Math.round(c.clientHeight * dpr));
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
  }

  function sizeOfFactory(table, out) {
    return function (name) {
      if (name === 'OUTPUT') return out;
      var t = table[name];
      return t ? { w: t.w, h: t.h } : null;
    };
  }

  // ---- 链编译（preset 变化时）==== Fix: 硬 5s 编译超时 + 逐文件/逐 pass deadline 检查 ====
  // 在 Windows Intel/AMD 老驱动上，每个 shader 编译/link 可能同步阻塞 200ms~1.5s，
  // 10+ 个 pass 累加起来会导致窗口 5-15s 无响应（Chromium hang detector 反复报 unresponsive）。
  // 这里加入 5 秒硬时限，超过就抛出 SR_COMPILE_TIMEOUT，调用方 catch 后自动降级为 off。
  var SR_COMPILE_DEADLINE_MS = 5000;
  function compileChain() {
    var p = state.preset;
    if (!p || !state.core) { state.parsed = null; return; }
    var deadline = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + SR_COMPILE_DEADLINE_MS;
    var passes = [];
    var files = p.files || [];
    for (var fi = 0; fi < files.length; fi++) {
      // 每解析一个 shader 文件后检查 deadline（parseShader 本身是 CPU 正则/字符串密集操作）
      var arr = SFV.srHook.parseShader(files[fi].text);
      passes = passes.concat(arr);
      if ((typeof performance !== 'undefined' ? performance.now() : Date.now()) >= deadline) {
        // 超时：直接中断，让外层 try/catch 捕获降级
        state.parsed = null;
        var err = new Error('SR shader 编译超时（> ' + SR_COMPILE_DEADLINE_MS + 'ms），已自动跳过画质增强以避免窗口卡死。当前 preset=' + p.id + '，已解析 ' + passes.length + ' passes。请点击画质按钮手动选择关闭档/其他档位。');
        err.code = 'SR_COMPILE_TIMEOUT';
        throw err;
      }
    }
    var progs = new Array(passes.length);
    for (var pi = 0; pi < passes.length; pi++) {
      var ps = passes[pi];
      var hookReal = (ps.hook === 'PREKERNEL' || ps.hook === 'MAIN') ? 'MAIN' : ps.hook;
      progs[pi] = state.core.getProgram(SFV.srHook.buildFragment(
        ps,
        ['MAIN', 'NATIVE'].concat(p.mode === 'luma' ? ['LUMA'] : []),
        { HOOKED: hookReal }
      ));
      if ((typeof performance !== 'undefined' ? performance.now() : Date.now()) >= deadline) {
        state.parsed = null;
        var err2 = new Error('SR shader 编译超时（> ' + SR_COMPILE_DEADLINE_MS + 'ms），在第 ' + (pi + 1) + '/' + passes.length + ' 个 pass 达到时限，已自动降级。请选择关闭档或其他更轻量的画质档位。');
        err2.code = 'SR_COMPILE_TIMEOUT';
        throw err2;
      }
    }
    state.parsed = { passes: passes, progs: progs };
    state.sig = '';
  }

  // ---- 帧执行 ----
  function renderFrame() {
    var core = state.core, v = state.videoEl, p = state.preset;
    if (!core || !v || !p || !state.parsed) return;
    var vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return;
    resizeCanvas();
    var gl = core.gl;
    var cw = state.canvas.width, ch = state.canvas.height;
    var rect = containRect(cw, ch, vw, vh);
    var out = {
      w: Math.min(Math.max(rect.w, vw), core.maxTex),
      h: Math.min(Math.max(rect.h, vh), core.maxTex)
    };

    var srcTex;
    try {
      srcTex = core.uploadVideoFrame(v, vw, vh);
    } catch (e) {
      onTaint();
      return;
    }

    var table = {
      MAIN: { tex: srcTex, w: vw, h: vh },
      NATIVE: { tex: srcTex, w: vw, h: vh }
    };
    if (p.mode === 'luma') {
      var lt = core.acquireTarget(vw, vh, [srcTex]);
      core.drawPass(core.getProgram(LUMA_FS), { MAIN: srcTex }, {}, lt);
      table.LUMA = { tex: lt.tex, w: vw, h: vh };
    }

    var sizeOf = sizeOfFactory(table, out);
    var sig = vw + 'x' + vh + '@' + out.w + 'x' + out.h + '#' + p.id;
    if (sig !== state.sig) {
      state.sig = sig;
      state.activePlan = planPasses(state.parsed.passes, sizeOf, table, out, core.maxTex);
    }
    var plan = state.activePlan;

    var t0 = performance.now();
    try {
      for (var i = 0; i < plan.length; i++) {
        var step = plan[i];
        var samplers = {}, vec2s = {};
        Object.keys(table).forEach(function (n) {
          samplers[n] = table[n].tex;
          vec2s[n + '_size'] = [table[n].w, table[n].h];
          vec2s[n + '_pt'] = [1 / table[n].w, 1 / table[n].h];
        });
        if (step.hookAlias) {
          samplers['HOOKED'] = table[step.hookAlias].tex;
          vec2s['HOOKED_size'] = [table[step.hookAlias].w, table[step.hookAlias].h];
          vec2s['HOOKED_pt'] = [1 / table[step.hookAlias].w, 1 / table[step.hookAlias].h];
        }
        var exclude = [];
        Object.keys(table).forEach(function (n) { if (exclude.indexOf(table[n].tex) < 0) exclude.push(table[n].tex); });
        var tgt = core.acquireTarget(step.w, step.h, exclude);
        core.drawPass(step.prog, samplers, vec2s, tgt);
        table[step.save] = { tex: tgt.tex, w: step.w, h: step.h };
      }
      if (p.refine) {
        // luma 链：锐化 2× 亮度平面；rgb 链：锐化链输出 MAIN
        var rName = p.mode === 'luma' ? 'LUMA' : 'MAIN';
        var rtgt = table[rName];
        if (rtgt && rtgt.tex && rtgt.w > 2 && rtgt.h > 2) {
          var rt = core.acquireTarget(rtgt.w, rtgt.h, [rtgt.tex]);
          core.drawPass(core.getProgram(REFINE_FS), { MAIN: rtgt.tex }, { MAIN_pt: [1 / rtgt.w, 1 / rtgt.h] }, rt);
          table[rName] = { tex: rt.tex, w: rtgt.w, h: rtgt.h };
        }
      }
      // 最终上屏：黑边清屏 + contain 视口（GL 视口原点在左下，containRect 的 y 是顶部起算，需翻转）
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, cw, ch);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      var vp = [rect.x, ch - rect.y - rect.h, rect.w, rect.h];
      if (p.mode === 'luma') {
        core.drawPass(core.getProgram(RECOMBINE_FS), { MAIN: srcTex, LUMA: table.LUMA.tex }, {}, null, vp);
      } else {
        core.drawPass(core.getProgram(BLIT_FS), { MAIN: table.MAIN.tex }, {}, null, vp);
      }
    } finally {
      core.resetTargets();
    }
    trackPerf(t0, performance.now());
    // ==== Fix: 抵达此处 = gl.clear() + 最终 blit 上屏均已执行（canvas 画面真实更新）。
    // ==== 计数首帧：成功后才隐藏原生 video。挂死检测由 startWatchdog 内的 2s 轮询负责，
    // ==== 不在此每帧 reset 定时器，避免 60fps 下高频 clear+setTimeout 对事件循环的压力。
    state.paintedFrames++;
    if (state.paintedFrames === 1) {
      hideVideoSafely();
    }
  }

  // 预规划：WHEN 过滤 + 尺寸求值（尺寸签名变化时才重算）
  function planPasses(passes, sizeOf, table, out, maxTex) {
    var plan = [];
    var local = {};
    Object.keys(table).forEach(function (n) { local[n] = true; });
    for (var i = 0; i < passes.length; i++) {
      var ps = passes[i];
      var hookName = ps.hook === 'PREKERNEL' || ps.hook === 'MAIN' ? 'MAIN' : ps.hook;
      if (!local[hookName]) continue;
      if (ps.when) {
        var wv = SFV.srHook.evalRPN(ps.when, sizeOf);
        if (wv === null || wv === 0) continue;
      }
      var outW = ps.width ? SFV.srHook.evalRPN(ps.width, sizeOf) : null;
      var outH = ps.height ? SFV.srHook.evalRPN(ps.height, sizeOf) : null;
      var ref = table[hookName];
      var w = Math.max(2, Math.min(Math.round(outW || ref.w), maxTex));
      var h = Math.max(2, Math.min(Math.round(outH || ref.h), maxTex));
      var save = ps.save || hookName;
      plan.push({ prog: state.parsed.progs[i], w: w, h: h, save: save, hookAlias: (ps.binds.indexOf('HOOKED') >= 0) ? hookName : null });
      local[save] = true;
      // 更新 sizeOf 作用域（后续 pass 的 WHEN/WIDTH 可引用新尺寸）
      table[save] = table[save] || { tex: null, w: w, h: h };
      table[save].w = w; table[save].h = h;
    }
    return plan;
  }

  // ---- 性能统计与自动降档 ----
  function trackPerf(t0, t1) {
    state.frames++;
    var now = performance.now();
    if (now - state.fpsTs >= 1000) {
      state.fps = Math.round(state.frames * 1000 / (now - state.fpsTs));
      state.frames = 0; state.fpsTs = now;
      emitStats();
    }
    state.frameTimes.push(t1 - t0);
    if (state.frameTimes.length > 90) state.frameTimes.shift();
    if (state.frameTimes.length >= 60 && now - state.lastDegradeTs > 5000) {
      var sum = 0;
      for (var i = 0; i < state.frameTimes.length; i++) sum += state.frameTimes[i];
      var avg = sum / state.frameTimes.length;
      if (avg > 42) { // 持续渲染耗时 > ~42ms（跟不动 24fps）
        state.lastDegradeTs = now;
        state.frameTimes = [];
        if (state.degradeCb) state.degradeCb(avg, state.presetId);
      }
    }
  }
  function emitStats() {
    if (!state.statsCb) return;
    var v = state.videoEl;
    var dropped = 0, total = 0;
    try {
      if (v && v.getVideoPlaybackQuality) {
        var q = v.getVideoPlaybackQuality();
        dropped = q.droppedVideoFrames || 0; total = q.totalVideoFrames || 0;
      }
    } catch (e) {}
    state.statsCb({
      preset: state.presetId, fps: state.fps,
      src: v ? [v.videoWidth, v.videoHeight] : [0, 0],
      out: state.canvas ? [state.canvas.width, state.canvas.height] : [0, 0],
      renderMs: state.frameTimes.length ? Math.round(state.frameTimes[state.frameTimes.length - 1] * 10) / 10 : 0,
      dropped: dropped, total: total, status: state.status
    });
  }

  // ===== Fix: 安全隐藏/显示原生 video + 渲染看门狗 =====
  // 核心策略：① 只在 canvas 首帧成功绘制后才隐藏 video；② 任何渲染异常/看门狗超时都恢复 video 可见；
  //           ③ 谨慎使用定时器，避免双路并行调度 / 嵌套 setTimeout 造成 GPU/事件循环崩溃。
  function _gSetTimeout(fn, ms) {
    try {
      if (global && typeof global.setTimeout === 'function') return global.setTimeout(fn, ms);
    } catch (e) {}
    try { return window.setTimeout(fn, ms); } catch (e) { return 0; }
  }
  function _gClearTimeout(id) {
    if (!id) return;
    try { if (global && typeof global.clearTimeout === 'function') global.clearTimeout(id); } catch (e) {}
    try { window.clearTimeout(id); } catch (e) {}
  }
  function hideVideoSafely() {
    if (state.videoHidden || !state.videoEl) return;
    try { state.videoEl.classList.add('sfv-sr-source-hidden'); } catch (e) {}
    state.videoHidden = true;
  }
  function showVideoSafely() {
    if (!state.videoHidden || !state.videoEl) return;
    try { state.videoEl.classList.remove('sfv-sr-source-hidden'); } catch (e) {}
    state.videoHidden = false;
  }
  function clearWatchdog() {
    if (state.watchdogTimer) { _gClearTimeout(state.watchdogTimer); state.watchdogTimer = 0; }
    // 兼容旧 state：清掉可能残留的 rVFC/RAF 兜底 id（虽新版本不再使用）
    if (state.rafFallbackId) { try { global.cancelAnimationFrame(state.rafFallbackId); } catch (e) {} state.rafFallbackId = 0; }
  }
  function startWatchdog() {
    clearWatchdog();
    // 3 秒内 canvas 仍未成功绘制首帧 → 判定渲染失败，自动降级关闭 SR 恢复原生 video
    state.watchdogTimer = _gSetTimeout(function () {
      state.watchdogTimer = 0;
      if (!state.running) return;
      if (state.paintedFrames <= 0) {
        try { console.warn('[SFV SR] 渲染看门狗超时：3s 内未出首帧，自动降级关闭画质增强恢复画面'); } catch (e) {}
        try { if (SFV.srUi && SFV.srUi.toast) SFV.srUi.toast('画质增强初始化失败，已回退原生播放'); } catch (e) {}
        try { if (state.degradeCb) state.degradeCb(9999, state.presetId); } catch (e) {}
        stop('watchdog-no-render');
        return;
      }
      // 已有首帧：启动"续跑模式"看门狗 —— 每 2s 检查一次 paintedFrames 是否增长，若卡死则降级
      var lastCount = state.paintedFrames;
      state.watchdogTimer = _gSetTimeout(function _srStallCheck() {
        state.watchdogTimer = 0;
        if (!state.running) return;
        if (state.paintedFrames <= lastCount) {
          try { console.warn('[SFV SR] 渲染挂死（2s 内无新帧），自动降级'); } catch (e) {}
          try { if (SFV.srUi && SFV.srUi.toast) SFV.srUi.toast('画质增强渲染挂死，已回退原生播放'); } catch (e) {}
          stop('watchdog-stall');
          return;
        }
        lastCount = state.paintedFrames;
        state.watchdogTimer = _gSetTimeout(_srStallCheck, 2000);
      }, 2000);
    }, 3000);
  }

  // ---- 跨域直链 taint：自动换 /api/proxy 同源代理重载（保留进度），一次为限 ----
  function onTaint() {
    var v = state.videoEl;
    var src = (v && (v.currentSrc || v.src)) || '';
    var crossOriginHttp = false;
    try {
      var u = new URL(src, global.location.href);
      crossOriginHttp = (u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== global.location.origin;
    } catch (e) {}
    if (!v || state.proxiedRetry || !crossOriginHttp) { stop('taint'); return; }
    state.proxiedRetry = true;
    var t = v.currentTime || 0;
    var wasPaused = v.paused;
    var onMeta = function () {
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('error', onErr);
      try { if (t > 1) v.currentTime = t; } catch (e) {}
      if (!wasPaused) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
    };
    var onErr = function () {
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('error', onErr);
      stop('taint');
    };
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('error', onErr);
    try {
      v.src = '/api/proxy?url=' + encodeURIComponent(src);
      v.load();
      if (SFV.srUi && SFV.srUi.toast) SFV.srUi.toast('跨域直链：已走本地代理重载以启用画质增强');
    } catch (e) { stop('taint'); }
  }

  // ---- 循环 ----
  function tick(now, meta) {
    if (!state.running) return;
    renderFrame();
    schedule();
  }
  function schedule() {
    var v = state.videoEl;
    if (v && v.requestVideoFrameCallback) {
      state.rVFC = v.requestVideoFrameCallback(tick);
    } else {
      state.rafId = global.requestAnimationFrame(function (t) { tick(t, null); });
    }
  }

  // 封装 compileChain：捕获 SR_COMPILE_TIMEOUT 并自动降级为 off，避免窗口卡死 10s+
  function _tryCompileChain() {
    try {
      compileChain();
      return true;
    } catch (e) {
      if (e && e.code === 'SR_COMPILE_TIMEOUT') {
        try { console.warn('[SFV SR]', e.message); } catch (_) {}
        try { if (SFV.srUi && SFV.srUi.toast) SFV.srUi.toast('画质增强编译超时，已自动关闭以避免卡死（您可稍后手动切换关闭档或其他更轻量档位）'); } catch (_) {}
        // 安全降级：复位 SR 预设状态 + 停止渲染
        state.preset = null; state.presetId = 'off';
        state.parsed = null; state.sig = ''; state.activePlan = null; state.frameTimes = [];
        // 通过 setTimeout 异步停止，避免在 start/setPreset 调用栈中途修改 running 状态导致问题
        try { _gSetTimeout(function () { if (state.running) stop('compile-timeout'); }, 0); } catch (_) {}
        if (state.degradeCb) { try { state.degradeCb(SR_COMPILE_DEADLINE_MS, state.presetId); } catch (_) {} }
        emitStats();
        return false;
      }
      // 非超时错误：原样抛出，让上层处理
      throw e;
    }
  }

  // ---- 生命周期 ----
  function start() {
    var v = getVideoEl();
    if (!v) return;
    if (!ensureCore()) return;
    state.videoEl = v;
    state.paintedFrames = 0;   // 重置帧计数：首帧成功后才隐藏原生 video
    state._watchdogMetaBound = false;
    resizeCanvas();
    if (!_tryCompileChain()) return;   // ==== Fix: 编译超时就直接 return，不再继续后面的启动/渲染流程
    state.canvas.style.display = 'block';
    // ==== Fix: 不再立即隐藏 video。改为在 renderFrame 首帧成功后才 hideVideoSafely()。
    if (!state.running) {
      state.running = true;
      state.fpsTs = performance.now();
      schedule();
    }
    // ==== Fix: 不立即启动看门狗。等待 video 解码元数据（videoWidth>0）后再开始计时，
    // ==== 避免"正在获取播放地址…"阶段 videoWidth=0 的空白期误触发或做无意义渲染。
    function tryStartWatchdog() {
      if (!state.running) return;
      var el = state.videoEl;
      if (el && el.videoWidth > 0 && el.videoHeight > 0) {
        startWatchdog();
        return;
      }
      if (state._watchdogMetaBound) return;
      state._watchdogMetaBound = true;
      var onLoaded = function () {
        try { v.removeEventListener('loadedmetadata', onLoaded); } catch (e) {}
        try { v.removeEventListener('playing', onLoaded); } catch (e) {}
        state._watchdogMetaBound = false;
        if (state.running) startWatchdog();
      };
      try { v.addEventListener('loadedmetadata', onLoaded, { once: true }); } catch (e) {}
      try { v.addEventListener('playing', onLoaded, { once: true }); } catch (e) {}
      // 兜底：10 秒后仍未 loadedmetadata（例如直播纯音频），直接启动看门狗以保证失败可降级
      _gSetTimeout(function () { if (state.running && !state.watchdogTimer) startWatchdog(); }, 10000);
    }
    tryStartWatchdog();
    renderOnceIfPaused();
    state.status = 'active'; state.reason = '';
    emitStats();
  }
  function renderOnceIfPaused() {
    var v = state.videoEl;
    if (v && v.paused) {
      // rVFC 暂停期不回调，补绘一帧保证画面即时呈现
      global.requestAnimationFrame(function () { if (state.running && v.paused) renderFrame(); });
    }
  }
  function stop(reason) {
    state.running = false;
    clearWatchdog();        // Fix: 关闭时清掉所有定时器
    if (state.rVFC >= 0 && state.videoEl && state.videoEl.cancelVideoFrameCallback) {
      try { state.videoEl.cancelVideoFrameCallback(state.rVFC); } catch (e) {}
    }
    if (state.rafId) { global.cancelAnimationFrame(state.rafId); state.rafId = 0; }
    state.rVFC = -1;
    showVideoSafely();      // Fix: 用安全切换（含状态标记），保证画面一定恢复
    if (state.canvas) state.canvas.style.display = 'none';
    if (state.core) state.core.resetTargets();
    state.status = reason || 'idle';
    state.sig = '';
    emitStats();
  }
  function hardTeardown() {
    stop('closed');
    if (state.core) { state.core.dispose(); state.core = null; }
    if (state.canvas && state.canvas.parentNode) state.canvas.parentNode.removeChild(state.canvas);
    state.canvas = null; state.videoEl = null; state.activePlan = null; state.frameTimes = [];
    state.paintedFrames = 0; state.videoHidden = false;
  }

  // ---- 对外 API ----
  var api = {
    containRect: containRect,
    isSupported: function () {
      var c = DOC.createElement('canvas');
      return !!c.getContext('webgl2');
    },
    setPreset: function (preset) {
      state.preset = preset || null;
      state.presetId = preset ? preset.id : 'off';
      state.sig = ''; state.activePlan = null; state.frameTimes = [];
      if (state.preset && state.preset.id !== 'off') {
        if (!state.core) ensureCore();
        if (state.core) {
          if (!_tryCompileChain()) {   // ==== Fix: 编译超时已自动降级为 off，停止进一步启动
            emitStats();
            return;
          }
          if (state.embed) { state.status = 'embed'; }
          else { start(); if (!state.running) state.status = 'ready'; }
        }
      } else {
        stop('off');
      }
      emitStats();
    },
    getStatus: function () {
      return { status: state.status, reason: state.reason, preset: state.presetId };
    },
    onStats: function (cb) { state.statsCb = cb; },
    onDegrade: function (cb) { state.degradeCb = cb; },
    notifyPlayerOpen: function (meta) {
      if (state.preset && state.preset.id !== 'off') {
        if (meta && meta.embed) { stop('embed'); return; }
        start();
      }
    },
    notifyPlayerClose: function () { hardTeardown(); if (state.preset && state.preset.id !== 'off') { state.status = 'ready'; } },
    notifyResized: function () {
      if (state.running) { state.sig = ''; renderOnceIfPaused(); }
    },
    renderOnce: renderOnceIfPaused,
    renderFrame: renderFrame,   // 测试缝：无头 Electron 渲染实测使用（scripts/sr_render_e2e_electron.js）
    compileChain: compileChain, // 测试缝：同上
    _state: state,
    LUMA_FS: LUMA_FS, RECOMBINE_FS: RECOMBINE_FS, REFINE_FS: REFINE_FS, BLIT_FS: BLIT_FS
  };

  // 事件自订阅：sfv:player-open / meta / close
  global.addEventListener('sfv:player-open', function (e) {
    var m = e && e.detail;
    state.embed = !!(m && m.embed);
    state.proxiedRetry = false;   // 新片/新集：跨域代理重载机会重置
    api.notifyPlayerOpen(m);
  });
  global.addEventListener('sfv:player-meta', function (e) {
    var m = e && e.detail;
    if (m && typeof m.embed === 'boolean') state.embed = m.embed;
    if (m && m.embed && state.running) stop('embed');
    else if (m && !m.embed && state.preset && state.preset.id !== 'off' && !state.running) start();
  });
  global.addEventListener('sfv:player-close', function () { api.notifyPlayerClose(); });
  global.addEventListener('resize', function () { api.notifyResized(); });
  DOC.addEventListener('fullscreenchange', function () { global.setTimeout(api.notifyResized, 60); });

  SFV.srEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
