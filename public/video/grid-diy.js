/* grid-diy.js — 网格外观 DIY（挂载于 fx 控制台 lyrics tab，与歌词内容共存）
 * 设计风格：100% 复用项目原代码 .fx-fold / .fx-section-label / .fx-seg /
 *          .lyric-color-grid / .lyric-color-row / .fx-slider / .fx-mini-btn
 * 作用域：影视态浏览网格（.sfv-browse-body 内的 .sfv-grid/.sfv-card）
 * 依赖：SFV.online.applyGridDiyToBody()（public/video/online.js）
 * 持久化：localStorage('stellaflix-grid-diy-prefs')
 */
(function () {
  'use strict';

  var KEY = 'stellaflix-grid-diy-prefs';

  // 18 色真实来源：index.html 的 lyricColorPresets（对象数组 {name,color}）
  // 注：电影/动漫分页背景已改为复用歌词 tab「视觉主色/封面取色」控件（见 online.js applyVideoPageBg），
  //     故本面板不再内置「页面背景」子 tab / 色板。

  var KVIDEO = {
    shell: {
      theme: 'kvideo',
      bg: 'rgba(255,255,255,0.95)',
      border: 'rgba(0,0,0,0.06)',
      radius: 24,
      shadowColor: 'rgba(0,0,0,0.05)',
      hoverBorder: 'rgba(0,86,179,0.5)',
      padding: 24,
      title: '#1c1c22',
      sub: 'rgba(28,28,34,0.62)'
    },
    grid: { gap: 24 }
  };
  var STELLAFLIX = {
    shell: {
      theme: 'stellaflix',
      bg: 'rgba(255,255,255,0.04)',
      border: 'rgba(255,255,255,0.09)',
      radius: 14,
      shadowColor: 'rgba(0,0,0,0.30)',
      hoverBorder: 'rgba(0,245,212,0.5)',
      padding: 0,
      title: 'rgba(255,255,255,0.92)',
      sub: 'rgba(255,255,255,0.5)'
    }
  };

  function defaults() {
    return {
      version: 1,
      shell: Object.assign({}, KVIDEO.shell),
      grid: Object.assign({}, KVIDEO.grid)
    };
  }

  function clamp(n, lo, hi) { n = Number(n); if (isNaN(n)) n = lo; return Math.max(lo, Math.min(hi, n)); }

  function hexToRgb(hex) {
    hex = (hex || '').replace('#', '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    var n = parseInt(hex, 16);
    if (isNaN(n)) n = 0;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function rgbToHex(r, g, b) {
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }
  function parseColor(str) {
    if (!str) return { hex: '#000000', a: 1 };
    str = String(str).trim();
    if (str.charAt(0) === '#') {
      var h = str.slice(1);
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      if (h.length === 6) return { hex: '#' + h, a: 1 };
      return { hex: '#000000', a: 1 };
    }
    var m = str.match(/rgba?\(([^)]+)\)/);
    if (m) {
      var p = m[1].split(',').map(function (x) { return parseFloat(x); });
      var r = Math.round(p[0] || 0), g = Math.round(p[1] || 0), b = Math.round(p[2] || 0);
      var a = (p[3] != null) ? p[3] : 1;
      return { hex: rgbToHex(r, g, b), a: a };
    }
    return { hex: '#000000', a: 1 };
  }

  function loadPrefs() {
    var p = defaults();
    try {
      var raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(KEY) : null;
      if (!raw) return p;
      var s = JSON.parse(raw);
      if (s && s.shell) p.shell = Object.assign(p.shell, s.shell);
      if (s && s.grid) p.grid = Object.assign(p.grid, s.grid);
    } catch (e) {}
    return p;
  }
  function savePrefs(p) {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(p)); } catch (e) {}
  }
  function apply(p) {
    savePrefs(p);
    if (window.SFV && window.SFV.online && window.SFV.online.applyGridDiyToBody) {
      try { window.SFV.online.applyGridDiyToBody(); } catch (e) {}
    }
  }

  function $(id) { return document.getElementById(id); }

  function colorRow(id, label, hasReset) {
    var resetBtn = hasReset
      ? '<button class="fx-mini-btn ghost" type="button" data-reset-color="' + id + '">重置</button>'
      : '';
    return ''
      + '<div class="lyric-color-row">'
      +   '<input type="color" class="lyric-color-picker" id="' + id + '" value="#ffffff">'
      +   '<div class="fx-color-row-label">' + label + '<small id="' + id + '-val"></small></div>'
      +   resetBtn
      + '</div>';
  }

  function sliderRow(id, label, min, max, step) {
    return ''
      + '<div class="fx-slider">'
      +   '<label>' + label + '</label>'
      +   '<input type="range" id="' + id + '" min="' + min + '" max="' + max + '" step="' + (step || 1) + '">'
      +   '<output id="' + id + '-out"></output>'
      +   '<button class="fx-reset-one" type="button" data-reset-slider="' + id + '">↺</button>'
      + '</div>';
  }

  function panelHTML() {
    return ''
      + '<div class="fx-fold open" id="sfv-grid-diy-fold">'
      +   '<div class="fx-fold-head" id="sfv-grid-diy-head">'
      +     '<span class="fx-fold-title"><strong>网格外观 DIY</strong><small>电影 / 动漫分页样式</small></span>'
      +     '<span class="arrow">▶</span>'
      +   '</div>'
      +   '<div class="fx-fold-body">'
      +     '<div class="fx-seg" id="sfv-grid-diy-seg">'
      +       '<button type="button" data-pane="shell" class="active">卡片外壳</button>'
      +       '<button type="button" data-pane="grid">网格布局</button>'
      +     '</div>'

      +     '<div class="sfv-diy-pane active" data-pane="shell">'
      +       '<div class="fx-section-label">一键主题</div>'
      +       '<div class="fx-seg" id="sfv-theme-seg">'
      +         '<button type="button" data-theme="kvideo" class="active">KVideo 玻璃</button>'
      +         '<button type="button" data-theme="stellaflix">Stellaflix 玻璃</button>'
      +       '</div>'
      +       '<div class="fx-section-label">外壳颜色</div>'
      +       colorRow('sfv-shell-bg', '容器背景', true)
      +       colorRow('sfv-shell-border', '容器边框', true)
      +       colorRow('sfv-shell-hover', 'Hover 边框', true)
      +       colorRow('sfv-shell-shadow', '阴影色', true)
      +       colorRow('sfv-shell-title', '标题文字', true)
      +       colorRow('sfv-shell-sub', '副标题', true)
      +       '<div class="fx-section-label">外壳几何</div>'
      +       sliderRow('sfv-shell-radius', '圆角', 0, 32, 1)
      +       sliderRow('sfv-shell-padding', '海报内边距', 0, 32, 1)
      +       '<div class="fx-actions" style="display:flex;gap:8px;margin-top:12px">'
      +         '<button class="fx-mini-btn" type="button" data-reset="shell" style="flex:1">重置卡片外壳</button>'
      +       '</div>'
      +     '</div>'

      +     '<div class="sfv-diy-pane" data-pane="grid">'
      +       '<div class="sfv-grid-diy-note">网格已固定为画布 1216×1158：5 列 × 3 排（共 15 张），超高内容在网格内滚动，列数/间距不可调节。</div>'
      +     '</div>'
      +     '</div>'

      +   '</div>'
      + '</div>';
  }

  // ---- 注入：rAF 轮询定位 lyrics tab（organizeFxPanel 动态创建） ----
  var injected = false;
  var injectTries = 0;
  function inject() {
    if (injected) return;
    var page = document.querySelector('.fx-tab-page[data-fx-page="lyrics"]');
    if (!page) {
      injectTries++;
      if (injectTries < 600) requestAnimationFrame(inject);
      return;
    }
    if (page.querySelector('#sfv-grid-diy-fold')) { injected = true; return; }
    var wrap = document.createElement('div');
    wrap.innerHTML = panelHTML();
    page.appendChild(wrap.firstChild);
    injected = true;
    bind();
  }

  // ---- 控件同步 ----
  function sync(p) {
    // 子 tab 按钮高亮
    var activeTab = document.querySelector('#sfv-grid-diy-seg button.active');
    var activePane = activeTab ? activeTab.getAttribute('data-pane') : 'shell';

    // 外壳主题
    document.querySelectorAll('#sfv-theme-seg button').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-theme') === p.shell.theme);
    });

    // 外壳颜色
    syncColor('sfv-shell-bg', p.shell.bg);
    syncColor('sfv-shell-border', p.shell.border);
    syncColor('sfv-shell-hover', p.shell.hoverBorder);
    syncColor('sfv-shell-shadow', p.shell.shadowColor);
    syncColor('sfv-shell-title', p.shell.title);
    syncColor('sfv-shell-sub', p.shell.sub);

    // 外壳几何
    setSlider('sfv-shell-radius', p.shell.radius, 'px');
    setSlider('sfv-shell-padding', p.shell.padding, 'px');

    // 恢复 active pane 标记（如果 sync 时子 tab 被重渲染，但此处 pane 不变）
    document.querySelectorAll('.sfv-diy-pane').forEach(function (pane) {
      pane.classList.toggle('active', pane.getAttribute('data-pane') === activePane);
    });
  }

  function syncColor(id, val) {
    if (val == null) return;
    var c = parseColor(val);
    var picker = $(id); if (picker) picker.value = c.hex;
    var lab = $(id + '-val'); if (lab) lab.textContent = val.toUpperCase();
  }
  function setSlider(id, v, unit) {
    if (v == null) return;
    var input = $(id); if (input) input.value = v;
    var out = $(id + '-out'); if (out) out.textContent = v + (unit || '');
  }

  // ---- 事件绑定 ----
  function bind() {
    var p = loadPrefs();

    // 折叠开关
    $('sfv-grid-diy-head').addEventListener('click', function () {
      $('sfv-grid-diy-fold').classList.toggle('open');
    });

    // 子 Tab 切换
    $('sfv-grid-diy-seg').addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      var pane = btn.getAttribute('data-pane');
      document.querySelectorAll('#sfv-grid-diy-seg button').forEach(function (b) { b.classList.toggle('active', b === btn); });
      document.querySelectorAll('.sfv-diy-pane').forEach(function (p) {
        p.classList.toggle('active', p.getAttribute('data-pane') === pane);
      });
    });

    // 一键主题
    $('sfv-theme-seg').addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      var theme = btn.getAttribute('data-theme');
      var p2 = loadPrefs();
      var preset = (theme === 'stellaflix') ? STELLAFLIX.shell : KVIDEO.shell;
      p2.shell = Object.assign({}, preset, { theme: theme });
      apply(p2); sync(p2);
    });

    // 外壳颜色
    bindColorInput('sfv-shell-bg', 'bg');
    bindColorInput('sfv-shell-border', 'border');
    bindColorInput('sfv-shell-hover', 'hoverBorder');
    bindColorInput('sfv-shell-shadow', 'shadowColor');
    bindColorInput('sfv-shell-title', 'title');
    bindColorInput('sfv-shell-sub', 'sub');

    // 外壳几何 / 网格滑块
    bindSlider('sfv-shell-radius', 'shell', 'radius', 'px');
    bindSlider('sfv-shell-padding', 'shell', 'padding', 'px');

    // 各类重置
    document.querySelectorAll('#sfv-grid-diy-fold [data-reset], #sfv-grid-diy-fold [data-reset-color], #sfv-grid-diy-fold [data-reset-slider], #sfv-grid-diy-fold [data-reset="shell"], #sfv-grid-diy-fold [data-reset="grid"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var p2 = loadPrefs();
        var which = btn.getAttribute('data-reset') || btn.getAttribute('data-reset-color') || btn.getAttribute('data-reset-slider');
        if (!which) return;

        if (which === 'shell') {
          p2.shell = Object.assign({}, KVIDEO.shell);
        } else if (which.indexOf('sfv-shell-') === 0) {
          // 单个颜色重置
          var keyMap = {
            'sfv-shell-bg': 'bg', 'sfv-shell-border': 'border', 'sfv-shell-hover': 'hoverBorder',
            'sfv-shell-shadow': 'shadowColor', 'sfv-shell-title': 'title', 'sfv-shell-sub': 'sub'
          };
          var k = keyMap[which];
          if (k) p2.shell[k] = KVIDEO.shell[k];
        } else if (which.indexOf('sfv-') === 0) {
          // 单个滑块重置
          var sliderMap = {
            'sfv-shell-radius': ['shell', 'radius', KVIDEO.shell.radius],
            'sfv-shell-padding': ['shell', 'padding', KVIDEO.shell.padding]
          };
          var m = sliderMap[which];
          if (m) p2[m[0]][m[1]] = m[2];
        }
        apply(p2); sync(p2);
      });
    });

    sync(p);
  }

  function bindColorInput(id, key) {
    $(id).addEventListener('input', function () {
      var p = loadPrefs();
      p.shell[key] = this.value;
      p.shell.theme = 'custom';
      apply(p); sync(p);
    });
  }
  function bindSlider(id, section, key, unit) {
    var input = $(id);
    input.addEventListener('input', function () {
      var p = loadPrefs();
      p[section][key] = Number(this.value);
      if (section === 'shell') p.shell.theme = 'custom';
      apply(p); sync(p);
    });
  }

  // ---- 初始化 ----
  function init() {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject);
    else inject();
  }
  if (typeof window !== 'undefined') {
    if (window.SFV && window.SFV.online) {
      init();
    } else {
      var tries = 0;
      var t = setInterval(function () {
        tries++;
        if (window.SFV && window.SFV.online) { clearInterval(t); init(); }
        else if (tries > 60) clearInterval(t);
      }, 100);
    }
  }
})();
