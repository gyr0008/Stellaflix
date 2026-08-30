/*
 * 影视 SR — WebGL2 运行时核心（渲染器模块，无业务语义）。
 * 职责：GL context、program 缓存、纹理/FBO 池（按尺寸复用，双缓冲避读写同纹理）、
 *       全屏三角绘制、视频帧上传。单 GL 上下文，独立于 Three.js。
 */
(function (global) {
  'use strict';
  var SFV = global.StellaflixVideo = global.StellaflixVideo || {};
  if (SFV.srCore) return;

  var VERT_SRC = [
    '#version 300 es',
    'precision highp float;',
    'out vec2 v_uv;',
    'void main() {',
    '  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));',
    '  v_uv = p;',
    '  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  function createCore(canvas) {
    var gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false,
      powerPreference: 'high-performance', desynchronized: false
    });
    if (!gl) return null;
    var floatOK = !!gl.getExtension('EXT_color_buffer_float');
    var maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
    var nanWarned = false;

    var vertShader = null;
    var programs = {};   // fsSrc hash → program
    var targets = [];    // { tex, fbo, w, h, inUse }
    var sourceTex = null, sourceW = 0, sourceH = 0;

    function compileShader(type, src) {
      var sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        var log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error('shader compile: ' + log);
      }
      return sh;
    }
    function getVert() {
      if (!vertShader) vertShader = compileShader(gl.VERTEX_SHADER, VERT_SRC);
      return vertShader;
    }
    function getProgram(fsSrc) {
      var prog = programs[fsSrc];
      if (prog) return prog;
      var fs = compileShader(gl.FRAGMENT_SHADER, fsSrc);
      var p = gl.createProgram();
      gl.attachShader(p, getVert());
      gl.attachShader(p, fs);
      gl.linkProgram(p);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        var log = gl.getProgramInfoLog(p);
        gl.deleteProgram(p);
        throw new Error('program link: ' + log);
      }
      programs[fsSrc] = p;
      return p;
    }

    function allocTex(w, h, useFloat) {
      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, useFloat ? gl.RGBA16F : gl.RGBA8, w, h, 0, gl.RGBA, useFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
      return tex;
    }
    function makeTarget(w, h) {
      var nt = { tex: null, fbo: gl.createFramebuffer(), w: w, h: h, inUse: true };
      // 先按探测结果选格式；FBO 不完整（部分驱动 RGBA16F 不可渲染）则降级 RGBA8 重建
      var useFloat = floatOK;
      for (var attempt = 0; attempt < 2; attempt++) {
        nt.tex = allocTex(w, h, useFloat);
        gl.bindFramebuffer(gl.FRAMEBUFFER, nt.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, nt.tex, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) break;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteTexture(nt.tex);
        if (!useFloat) break; // RGBA8 都不完整，交由上层 gl.getError 兜底
        useFloat = false;
        floatOK = false; // 后续所有目标直接走 RGBA8
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      targets.push(nt);
      return nt;
    }
    // 获取一个 w×h 渲染目标；exclude 中的纹理对象不可复用（避免同 pass 读写）
    function acquireTarget(w, h, exclude) {
      for (var i = 0; i < targets.length; i++) {
        var t = targets[i];
        if (!t.inUse && t.w === w && t.h === h && !(exclude && exclude.indexOf(t.tex) >= 0)) {
          t.inUse = true;
          return t;
        }
      }
      return makeTarget(w, h);
    }
    function releaseTarget(t) { if (t) t.inUse = false; }
    function resetTargets() { targets.forEach(function (t) { t.inUse = false; }); }

    function ensureSource(w, h) {
      if (sourceTex && sourceW === w && sourceH === h) return sourceTex;
      if (sourceTex) gl.deleteTexture(sourceTex);
      sourceTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, sourceTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      sourceW = w; sourceH = h;
      return sourceTex;
    }
    function uploadVideoFrame(video, w, h) {
      var tex = ensureSource(w, h);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      // DOM 源（video）首行在纹理 v=0，而 framebuffer v=0 在底部——不翻转会导致画面上下倒置
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, video);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      return tex;
    }

    // 绘制一个 pass：target 为 null 表示渲染到 canvas（默认 framebuffer）；
    // vp 可选 [x,y,w,h]，仅对 null target 有效（letterbox 视口）
    // samplers: { name: texObj }；vec2s: { name: [x, y] }
    function drawPass(prog, samplers, vec2s, target, vp) {
      var w = target ? target.w : (vp ? vp[2] : gl.drawingBufferWidth);
      var h = target ? target.h : (vp ? vp[3] : gl.drawingBufferHeight);
      var x = target ? 0 : (vp ? vp[0] : 0);
      var y = target ? 0 : (vp ? vp[1] : 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
      gl.viewport(x, y, w, h);
      gl.useProgram(prog);
      var unit = 0;
      var names = Object.keys(samplers || {});
      for (var i = 0; i < names.length; i++) {
        var loc = gl.getUniformLocation(prog, names[i]);
        if (loc == null) continue;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, samplers[names[i]]);
        gl.uniform1i(loc, unit);
        unit++;
      }
      var v2 = Object.keys(vec2s || {});
      for (var j = 0; j < v2.length; j++) {
        var loc2 = gl.getUniformLocation(prog, v2[j]);
        if (loc2 == null) continue;
        var val = vec2s[v2[j]];
        // 防护：NaN/Infinity 进 uniform 会触发驱动定义行为（真机 D3D11 上表现为条纹/偏色）
        if (!isFinite(val[0]) || !isFinite(val[1])) {
          if (!nanWarned) { nanWarned = true; try { console.warn('[sr] uniform 含非有限值，已归零：' + v2[j]); } catch (e) {} }
          gl.uniform2f(loc2, 0, 0);
          continue;
        }
        gl.uniform2f(loc2, val[0], val[1]);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function dispose() {
      resetTargets();
      targets.forEach(function (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); });
      targets = [];
      if (sourceTex) { gl.deleteTexture(sourceTex); sourceTex = null; sourceW = sourceH = 0; }
      Object.keys(programs).forEach(function (k) { gl.deleteProgram(programs[k]); });
      programs = {};
    }

    return {
      gl: gl,
      floatOK: floatOK,
      maxTex: maxTex,
      getProgram: getProgram,
      acquireTarget: acquireTarget,
      releaseTarget: releaseTarget,
      resetTargets: resetTargets,
      uploadVideoFrame: uploadVideoFrame,
      drawPass: drawPass,
      dispose: dispose
    };
  }

  SFV.srCore = { createCore: createCore, VERT_UV: 'v_uv' };
})(typeof window !== 'undefined' ? window : globalThis);
