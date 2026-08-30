/*
 * 影视 SR — mpv user-shader 方言解析与 WebGL2 GLSL 适配层（纯函数，无 DOM/GL 依赖）。
 *
 * 支持的 mpv 指令子集（覆盖 vendor 的 Anime4K / FSRCNNX 全部 9 个文件）：
 *   //!DESC / //!HOOK / //!BIND / //!SAVE / //!WIDTH / //!HEIGHT / //!WHEN / //!COMPONENTS / //!OFFSET
 * 钩子点语义映射（顺序执行模型，与 mpv 中这批 shader 的实际行为等价）：
 *   MAIN / PREKERNEL → 当前主纹理；LUMA → 亮度平面（引擎虚拟）；OUTPUT → 输出目标（仅表达式引用）。
 * WIDTH/HEIGHT/WHEN 为 mpv RPN 表达式（如 "OUTPUT.w NATIVE.w / 2.0 <"）。
 * 生成的 fragment shader 注入 mpv 宏子集：NAME_tex/_texOff/_pos/_size/_pt/_raw/_mul。
 */
(function (global) {
  'use strict';
  var SFV = global.StellaflixVideo = global.StellaflixVideo || {};
  if (SFV.srHook) return;

  var DIRECTIVES = { HOOK: 1, BIND: 1, SAVE: 1, WIDTH: 1, HEIGHT: 1, WHEN: 1, COMPONENTS: 1, OFFSET: 1 };

  // ---- 解析：shader 文本 → pass 列表 ----
  // pass = { desc, hook, binds[], save, width, height, when, components, offset:[x,y], body:[] }
  function parseShader(text) {
    var passes = [];
    var lines = String(text || '').split(/\r?\n/);
    var cur = null, curDesc = [];
    function flush() {
      if (!cur) { curDesc = []; return; }
      var p = cur;
      cur = null;
      p.desc = curDesc.join(' ').trim();
      curDesc = [];
      if (p.body.join('').trim() === '') return; // 空 body 的块丢弃
      passes.push(p);
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var m = /^\/\/!\s*(\w+)\s*(.*)$/.exec(line);
      if (m) {
        var key = m[1].toUpperCase(), val = m[2].trim();
        if (key === 'DESC') {
          // DESC 既可能出现在 HOOK 之前（Anime4K 风格）也可能之后（FSRCNNX 风格）
          if (cur && cur.body.length > 0) flush();
          curDesc.push(val);
        } else if (DIRECTIVES[key]) {
          if (key === 'HOOK') {
            flush();
            cur = { hook: val, binds: [], save: '', width: '', height: '', when: '', components: 4, offset: [0, 0], body: [] };
          } else if (!cur) {
            continue; // HOOK 之前的指令（不合式）忽略
          } else if (key === 'BIND') {
            var name = val.split(/\s+/)[0];
            if (name) cur.binds.push(name);
          } else if (key === 'OFFSET') {
            var parts = val.split(/[\s,]+/).filter(Boolean);
            cur.offset = [parseFloat(parts[0]) || 0, parseFloat(parts[1]) || 0];
          } else if (key === 'COMPONENTS') {
            cur.components = parseInt(val, 10) || 4;
          } else {
            cur[key.toLowerCase()] = val;
          }
        }
        continue;
      }
      if (cur) cur.body.push(line);
    }
    flush();
    return passes;
  }

  // ---- RPN 表达式求值（mpv 语义）----
  // sizeOf(name) → { w, h }；返回 null 表示求值失败（引用了未知纹理）。
  var BIN_OPS = {
    '+': function (a, b) { return a + b; },
    '-': function (a, b) { return a - b; },
    '*': function (a, b) { return a * b; },
    '/': function (a, b) { return b === 0 ? 0 : a / b; },
    'min': function (a, b) { return Math.min(a, b); },
    'max': function (a, b) { return Math.max(a, b); },
    '<': function (a, b) { return a < b ? 1 : 0; },
    '>': function (a, b) { return a > b ? 1 : 0; },
    '<=': function (a, b) { return a <= b ? 1 : 0; },
    '>=': function (a, b) { return a >= b ? 1 : 0; },
    '==': function (a, b) { return a === b ? 1 : 0; },
    '!=': function (a, b) { return a !== b ? 1 : 0; }
  };
  function evalRPN(expr, sizeOf) {
    var toks = String(expr || '').trim().split(/\s+/).filter(Boolean);
    if (!toks.length) return null;
    var st = [];
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (t === '!') { // 逻辑非（一元）
        var v = st.pop();
        if (v === undefined) return null;
        st.push(v === 0 ? 1 : 0);
        continue;
      }
      var dm = /^([A-Za-z_]\w*)\.([wh])$/.exec(t);
      if (dm) {
        var s = sizeOf ? sizeOf(dm[1]) : null;
        if (!s) return null;
        st.push(dm[2] === 'w' ? s.w : s.h);
        continue;
      }
      if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) { st.push(parseFloat(t)); continue; }
      var op = BIN_OPS[t];
      if (op) {
        var b = st.pop(), a = st.pop();
        if (a === undefined || b === undefined) return null;
        st.push(op(a, b));
        continue;
      }
      return null; // 未知 token
    }
    return st.length === 1 ? st[0] : null;
  }

  // ---- fragment shader 生成 ----
  // realNames: 可作为采样纹理的名字列表（引擎纹理表中已存在的实体名）。
  // aliases: { HOOKED: 'MAIN' } 之类的别名映射（值必须是 realNames 中的实体名）。
  function buildFragment(pass, realNames, aliases) {
    aliases = aliases || {};
    var seen = {}, ordered = [];
    (pass.binds || []).concat(realNames || []).forEach(function (n) {
      if (n && !seen[n] && !aliases[n]) { seen[n] = 1; ordered.push(n); }
    });
    var L = [];
    L.push('#version 300 es');
    L.push('precision highp float;');
    L.push('precision highp int;');
    L.push('in vec2 v_uv;');
    L.push('layout(location = 0) out vec4 fragColor;');
    ordered.forEach(function (n) {
      L.push('uniform sampler2D ' + n + ';');
      L.push('uniform vec2 ' + n + '_size;');
      L.push('uniform vec2 ' + n + '_pt;');
    });
    function emitSampler(n, real) {
      L.push('#define ' + n + '_raw ' + real);
      L.push('#define ' + n + '_mul vec2(1.0)');
      L.push('#define ' + n + '_pos v_uv');
      L.push('#define ' + n + '_tex(pos) texture(' + real + ', (pos))');
      L.push('#define ' + n + '_texOff(off) texture(' + real + ', v_uv + ' + real + '_pt * vec2(off))');
    }
    ordered.forEach(function (n) { emitSampler(n, n); });
    Object.keys(aliases).forEach(function (al) { emitSampler(al, aliases[al]); });
    L.push.apply(L, pass.body || []);
    L.push('void main() { fragColor = hook(); }');
    return L.join('\n');
  }

  // ---- 静态校验：pass 链在某尺寸假设下引用完整性 ----
  // hooksAllowed: 引擎可接受的钩子点集合；返回错误字符串数组（空 = 通过）。
  function validatePasses(passes, hooksAllowed) {
    var errs = [];
    // LUMA 为引擎虚拟亮度平面（FSRCNNX 链使用），始终视为可定义
    var defined = { MAIN: 1, NATIVE: 1, OUTPUT: 1, HOOKED: 1, LUMA: 1 };
    for (var i = 0; i < passes.length; i++) {
      var p = passes[i];
      if (!p.hook) { errs.push('pass[' + i + '] 缺 HOOK'); continue; }
      if (hooksAllowed && hooksAllowed.indexOf(p.hook) < 0) errs.push('pass[' + i + '](' + p.desc + ') 钩子点 ' + p.hook + ' 不受支持');
      var hookTex = (p.hook === 'HOOKED' || p.hook === 'PREKERNEL') ? 'MAIN' : p.hook;
      if (!defined[hookTex]) errs.push('pass[' + i + '](' + p.desc + ') 钩子纹理 ' + hookTex + ' 未定义');
      for (var j = 0; j < p.binds.length; j++) {
        if (!defined[p.binds[j]] && p.binds[j] !== 'HOOKED' && p.binds[j] !== 'OUTPUT') {
          errs.push('pass[' + i + '](' + p.desc + ') BIND ' + p.binds[j] + ' 未定义');
        }
      }
      if (p.save) defined[p.save] = 1;
    }
    return errs;
  }

  SFV.srHook = {
    parseShader: parseShader,
    evalRPN: evalRPN,
    buildFragment: buildFragment,
    validatePasses: validatePasses
  };
})(typeof window !== 'undefined' ? window : globalThis);
