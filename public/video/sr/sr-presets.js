/*
 * 影视 SR — 档位（preset）定义与 shader 资产懒加载。
 * 档位链均取自上游官方推荐链（Anime4K v4.0.1 input.conf 模板 / FSRCNNX 单文件）。
 * tier 为自动降档的成本序：数值越高越重，降档方向 tier 递减直至 off。
 */
(function (global) {
  'use strict';
  var SFV = global.StellaflixVideo = global.StellaflixVideo || {};
  if (SFV.srPresets) return;

  var FILE_BASE = 'vendor/sr/glsl/';
  var A4K_MODE_A_FAST = [
    'Anime4K_Clamp_Highlights.glsl',
    'Anime4K_Restore_CNN_M.glsl',
    'Anime4K_Upscale_CNN_x2_M.glsl'
  ];

  var LIST = [
    { id: 'off', label: '关闭', desc: '原生直出，零额外开销', files: [], mode: 'rgb', tier: 0 },
    { id: 'fsrcnnx', label: '通用 · FSRCNNX', desc: '通用内容 AI 超分（亮度链 2×）', files: ['FSRCNNX_x2_8-0-4-1.glsl'], mode: 'luma', tier: 1 },
    { id: 'live', label: '真人 · 锐化', desc: 'FSRCNNX + 边缘细节锐化', files: ['FSRCNNX_x2_8-0-4-1.glsl'], mode: 'luma', refine: true, tier: 2 },
    { id: 'anime-fast', label: '动漫 · 流畅', desc: 'Anime4K 去噪放大（S 级链）', files: ['Anime4K_Clamp_Highlights.glsl', 'Anime4K_Upscale_Denoise_CNN_x2_S.glsl'], mode: 'rgb', tier: 3 },
    { id: 'anime-hq', label: '动漫 · 质量', desc: 'Anime4K 修复 + 放大（M 级链）', files: A4K_MODE_A_FAST.slice(), mode: 'rgb', tier: 4 },
    { id: 'anime-4k', label: '动漫 · 双倍', desc: 'Anime4K 双级放大（低清源 → 4K）', files: A4K_MODE_A_FAST.concat(['Anime4K_AutoDownscalePre_x2.glsl', 'Anime4K_AutoDownscalePre_x4.glsl', 'Anime4K_Upscale_CNN_x2_S.glsl']), mode: 'rgb', tier: 5 }
  ];

  var textCache = {};   // 文件名 → shader 文本
  var defCache = {};    // preset id → Promise<def>

  function fetchText(name) {
    if (textCache[name]) return global.Promise.resolve(textCache[name]);
    return global.fetch(FILE_BASE + name).then(function (r) {
      if (!r.ok) throw new Error('加载 ' + name + ' 失败：HTTP ' + r.status);
      return r.text();
    }).then(function (t) {
      if (!/\/\/!\s*HOOK/.test(t)) throw new Error(name + ' 不是有效的 mpv hook shader');
      textCache[name] = t;
      return t;
    });
  }

  function load(id) {
    if (defCache[id]) return defCache[id];
    var def = null;
    for (var i = 0; i < LIST.length; i++) if (LIST[i].id === id) def = LIST[i];
    if (!def) return global.Promise.reject(new Error('未知画质档位：' + id));
    defCache[id] = global.Promise.all(def.files.map(fetchText)).then(function (texts) {
      var files = def.files.map(function (n, i) { return { name: n, text: texts[i] }; });
      var errs = [];
      files.forEach(function (f) {
        errs = errs.concat(SFV.srHook.validatePasses(SFV.srHook.parseShader(f.text), ['MAIN', 'PREKERNEL', 'LUMA']));
      });
      if (errs.length) throw new Error('shader 校验失败：' + errs[0]);
      return { id: def.id, label: def.label, desc: def.desc, mode: def.mode, refine: !!def.refine, tier: def.tier, files: files };
    });
    defCache[id] = defCache[id]['catch'](function (e) { defCache[id] = null; throw e; });
    return defCache[id];
  }

  function byId(id) { for (var i = 0; i < LIST.length; i++) if (LIST[i].id === id) return LIST[i]; return null; }

  // 自动降档：返回比当前 tier 低一档的 preset id；已是最低成本档（tier 1）则 'off'
  function degrade(id) {
    var cur = byId(id);
    if (!cur || cur.tier === 0) return null;
    var next = null;
    for (var i = 0; i < LIST.length; i++) {
      var d = LIST[i];
      if (d.tier === cur.tier - 1) next = d.id;
    }
    return next === null ? 'off' : next;
  }

  SFV.srPresets = { LIST: LIST, FILE_BASE: FILE_BASE, load: load, byId: byId, degrade: degrade, _textCache: textCache };
})(typeof window !== 'undefined' ? window : globalThis);
