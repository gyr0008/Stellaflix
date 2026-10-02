/*
 * 影视 SR — 档位（preset）定义与 shader 资产懒加载。
 * 档位链均取自上游官方推荐链（Anime4K v4.0.1 input.conf 模板 / FSRCNNX 单文件）。
 * 例外一：`AiUpscale_Fast_2x_Photo.glsl` 取自 Alexkral/AviSynthAiUpscale（GPL-3.0，
 *   与本项目许可一致）。它是唯一按真人（Photo）训练的模型，替代原 FSRCNNX16 作为
 *   真人档超分核心：同为 2× luma doubler，但训练域对口且更轻（18 pass / 134KB
 *   vs 26 pass / 247KB）。FSRCNNX 仍保留在 tier1「通用」档。
 * 例外二：`RCAS_Luma.glsl` 为自研移植件——取自 AMD FidelityFX FSR v1.0.2 的 RCAS pass
 * （原文件 MIT，原始副本留档于 _scratch/ref_AMD_FSR_v1.0.2_orig.glsl），剥除其 EASU
 * 上采样 pass（本引擎由 FSRCNNX 负责），并把绑定从 EASUTEX 改为 HOOKED。
 * 其 live 档原先依赖引擎内建 refine（unsharp mask），已由 RCAS 取代：RCAS 为对比度
 * 自适应锐化且带噪点抑制，更适合真人纹理；两者叠加会过锐。
 * 例外三：`Deblock_Luma.glsl` 为自研件（无上游来源，算法思路借鉴 H.264 in-loop
 *   deblocking filter 的边界强度判据）。它是链上唯一不带 //!WHEN 的组件，
 *   因此 1080p 源投 1080p 屏（缩放比 1.0x，所有 doubler 均不触发）时仍有增强生效。
 *   必须排在超分之前：此时 LUMA 仍是源分辨率，8x8 网格与编码块对齐。
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

  // tier5（动漫·双倍）专用链：Anime4K VL（超大杯）替代 M，成本约翻倍但质量更高。
  // 红线：绝不直接改 A4K_MODE_A_FAST（tier4 仍在引用），只新增本数组，保持降档梯度连续。
  var A4K_MODE_A_HQ = [
    'Anime4K_Clamp_Highlights.glsl',
    'Anime4K_Restore_CNN_VL.glsl',
    'Anime4K_Upscale_CNN_x2_VL.glsl'
  ];

  var LIST = [
    { id: 'off', label: '关闭', desc: '原生直出，零额外开销', files: [], mode: 'rgb', tier: 0 },
    { id: 'fsrcnnx', label: '通用 · FSRCNNX', desc: '通用内容 AI 超分（亮度链 2×）', files: ['FSRCNNX_x2_8-0-4-1.glsl'], mode: 'luma', tier: 1 },
    { id: 'live', label: '真人 · 锐化', desc: '去块 + 去色带 + AiUpscale 真人模型超分 + AMD RCAS 对比度自适应锐化（噪点区自动减锐）', files: ['Deblock_Luma.glsl', 'Deband.glsl', 'AiUpscale_Fast_2x_Photo.glsl', 'RCAS_Luma.glsl'], mode: 'luma', tier: 2 },
    { id: 'anime-fast', label: '动漫 · 流畅', desc: 'Anime4K 去噪放大（S 级链）', files: ['Anime4K_Clamp_Highlights.glsl', 'Anime4K_Upscale_Denoise_CNN_x2_S.glsl'], mode: 'rgb', tier: 3 },
    { id: 'anime-hq', label: '动漫 · 质量', desc: 'Anime4K 修复 + 放大（M 级链）', files: A4K_MODE_A_FAST.slice(), mode: 'rgb', tier: 4 },
    { id: 'anime-4k', label: '动漫 · 双倍', desc: 'Anime4K 双级放大（低清源 → 4K）', files: A4K_MODE_A_HQ.concat(['Anime4K_AutoDownscalePre_x2.glsl', 'Anime4K_AutoDownscalePre_x4.glsl', 'Anime4K_Upscale_CNN_x2_S.glsl']), mode: 'rgb', tier: 5 }
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
