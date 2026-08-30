/*
 * 影视 SR — 画质菜单 UI：档位选择、持久化、统计行、自动降档提示。
 * 挂接点：底部栏 #sfv-ctrl-quality（player-controller.js 注入，此处只接管点击）。
 * 持久化：localStorage 'stellaflix-video-sr' { preset, autoDegrade }。
 */
(function (global) {
  'use strict';
  var SFV = global.StellaflixVideo = global.StellaflixVideo || {};
  if (SFV.srUi) return;
  var DOC = global.document;
  var KEY = 'stellaflix-video-sr';

  var saved = readSaved();
  var current = saved.preset;
  var menuEl = null, statsEl = null, toastEl = null, toastTimer = 0;
  var lastStats = null, degradeHinted = false;
  var anchorEl = null; // 当前画质按钮锚点，用于点击空白处收回时排除按钮自身

  function readSaved() {
    try {
      var r = JSON.parse(global.localStorage.getItem(KEY));
      return { preset: (r && r.preset) || 'off', autoDegrade: r ? r.autoDegrade !== false : true };
    } catch (e) { return { preset: 'off', autoDegrade: true }; }
  }
  function persist() {
    try { global.localStorage.setItem(KEY, JSON.stringify({ preset: saved.preset, autoDegrade: saved.autoDegrade })); } catch (e) {}
  }

  function toast(msg, ms) {
    if (!toastEl || !toastEl.parentNode) {
      toastEl = DOC.createElement('div');
      toastEl.id = 'sfv-sr-toast';
      toastEl.className = 'sfv-sr-toast';
      DOC.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    if (toastTimer) global.clearTimeout(toastTimer);
    toastTimer = global.setTimeout(function () { toastEl.classList.remove('show'); }, ms || 2400);
  }

  function apply(id, opts) {
    opts = opts || {};
    saved.preset = id; persist();
    current = id;
    degradeHinted = false;
    if (id === 'off') {
      SFV.srEngine.setPreset(null);
      refreshBtn();
      if (!opts.silent) toast('画质增强已关闭');
      return;
    }
    SFV.srPresets.load(id).then(function (def) {
      SFV.srEngine.setPreset(def);
      refreshBtn();
      if (!opts.silent) toast('画质增强 · ' + def.label);
    })['catch'](function (e) {
      toast('画质档位加载失败：' + (e && e.message ? e.message : e));
    });
  }

  function refreshBtn() {
    var b = DOC.getElementById('sfv-ctrl-quality');
    if (!b) return;
    b.classList.toggle('active', current !== 'off');
    var def = SFV.srPresets.byId(current);
    b.title = current !== 'off' && def ? ('画质增强 · ' + def.label) : '画质增强';
  }

  // ---- 弹出菜单 ----
  function toggleMenu(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (e && e.stopPropagation) e.stopPropagation();
    if (menuEl && menuEl.parentNode) { closeMenu(); return; }
    openMenu();
  }
  function closeMenu() {
    if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
    menuEl = null; statsEl = null; anchorEl = null;
    DOC.removeEventListener('pointerdown', onDocDown, true);
  }
  function onDocDown(e) {
    if (!menuEl) return;
    // 再次点击画质按钮本身不收起，交给 toggleMenu 处理开关，避免 pointerdown 先关、click 又开
    if (anchorEl && (e.target === anchorEl || anchorEl.contains(e.target))) return;
    if (!menuEl.contains(e.target)) closeMenu();
  }
  function openMenu() {
    var anchor = DOC.getElementById('sfv-ctrl-quality') || DOC.getElementById('sfv-btn-quality');
    if (!anchor) return;
    anchorEl = anchor;
    var supported = SFV.srEngine.isSupported();
    var st = SFV.srEngine.getStatus();
    var el = DOC.createElement('div');
    el.id = 'sfv-sr-popover';
    el.className = 'sfv-sr-popover';
    el.addEventListener('pointerdown', function (e) { e.stopPropagation(); });

    SFV.srPresets.LIST.forEach(function (def) {
      var row = DOC.createElement('button');
      row.type = 'button';
      row.className = 'sfv-sr-item' + (current === def.id ? ' active' : '');
      var name = DOC.createElement('span'); name.className = 'sfv-sr-item-name'; name.textContent = def.label;
      var desc = DOC.createElement('span'); desc.className = 'sfv-sr-item-desc'; desc.textContent = def.desc;
      row.appendChild(name); row.appendChild(desc);
      if (def.id !== 'off' && !supported) {
        row.disabled = true;
        row.title = '当前环境不支持（需要 WebGL2）';
      } else {
        row.addEventListener('click', function () { apply(def.id); closeMenu(); });
      }
      el.appendChild(row);
    });

    var auto = DOC.createElement('button');
    auto.type = 'button';
    auto.className = 'sfv-sr-item sfv-sr-toggle';
    var autoName = DOC.createElement('span'); autoName.className = 'sfv-sr-item-name'; autoName.textContent = '性能不足自动降档';
    var autoChk = DOC.createElement('span'); autoChk.className = 'sfv-sr-check'; autoChk.textContent = saved.autoDegrade ? '开' : '关';
    auto.appendChild(autoName); auto.appendChild(autoChk);
    auto.addEventListener('click', function () {
      saved.autoDegrade = !saved.autoDegrade; persist();
      autoChk.textContent = saved.autoDegrade ? '开' : '关';
    });
    el.appendChild(auto);

    statsEl = DOC.createElement('div');
    statsEl.className = 'sfv-sr-stats';
    el.appendChild(statsEl);

    var REASONS = {
      embed: '嵌入解析器播放中（XPath/网页类规则），取不到视频画面，无法增强；换 API/CMS10 类规则源即可',
      taint: '该视频源不允许本地画面处理，画质增强已停用',
      unsupported: '当前环境不支持 WebGL2，无法启用画质增强'
    };
    if (REASONS[st.status]) {
      var r = DOC.createElement('div');
      r.className = 'sfv-sr-reason';
      r.textContent = REASONS[st.status];
      el.appendChild(r);
    }

    DOC.body.appendChild(el);
    var rect = anchor.getBoundingClientRect();
    var w = el.offsetWidth || 260;
    el.style.left = Math.max(10, Math.min(rect.left + rect.width / 2 - w / 2, global.innerWidth - w - 10)) + 'px';
    el.style.bottom = (global.innerHeight - rect.top + 12) + 'px';
    global.requestAnimationFrame(function () { el.classList.add('show'); });
    menuEl = el;
    global.setTimeout(function () { DOC.addEventListener('pointerdown', onDocDown, true); }, 0);
    updateStats(lastStats);
  }

  function updateStats(s) {
    if (!statsEl || !statsEl.parentNode) return;
    if (!s || s.preset === 'off' || s.status === 'off') {
      statsEl.textContent = supportedNote();
      return;
    }
    var t = s.src[0] + '×' + s.src[1] + ' → ' + s.out[0] + '×' + s.out[1];
    t += ' · ' + s.fps + ' fps · 渲染 ' + s.renderMs + ' ms';
    statsEl.textContent = t;
  }
  function supportedNote() {
    var def = SFV.srPresets.byId(current);
    return def && current !== 'off' ? def.label + ' · 等待画面…' : '选择档位后即时生效，播放中实时增强';
  }

  // ---- 引擎回调 ----
  if (SFV.srEngine) {
    SFV.srEngine.onStats(function (s) {
      lastStats = s;
      if (s && s.preset !== 'off') updateStats(s);
      else updateStats(null);
    });
    SFV.srEngine.onDegrade(function (avgMs, presetId) {
      if (saved.autoDegrade) {
        var next = SFV.srPresets.degrade(presetId);
        if (next) {
          var fromDef = SFV.srPresets.byId(presetId);
          var toDef = SFV.srPresets.byId(next);
          apply(next, { silent: true });
          toast('性能不足（渲染约 ' + Math.round(avgMs) + ' ms/帧），已从「' + (fromDef ? fromDef.label : presetId) +
            '」降至「' + (toDef ? toDef.label : '关闭') + '」');
          return;
        }
      }
      if (!degradeHinted) {
        degradeHinted = true;
        toast('渲染性能不足（约 ' + Math.round(avgMs) + ' ms/帧），建议降低画质档位');
      }
    });
  }

  // 播放开启：恢复已存档位（引擎自身的 open 监听先跑但当时可能未装载 preset，这里补触发）
  global.addEventListener('sfv:player-open', function (e) {
    refreshBtn();
    if (current !== 'off') {
      SFV.srPresets.load(current).then(function (def) {
        SFV.srEngine.setPreset(def);
        SFV.srEngine.notifyPlayerOpen(e && e.detail);
      })['catch'](function (err) {
        toast('画质档位恢复失败：' + (err && err.message ? err.message : err));
      });
    }
  });
  global.addEventListener('sfv:player-close', function () { closeMenu(); });

  SFV.srUi = {
    toggleMenu: toggleMenu,
    apply: apply,
    getPreset: function () { return current; },
    getAutoDegrade: function () { return saved.autoDegrade; },
    toast: toast
  };

  // overlay 自带控制条的画质键（player.js 内为空占位，这里事件委托接管，保持 player.js 零改动）
  DOC.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.id === 'sfv-btn-quality' && SFV.srUi) {
      e.preventDefault();
      SFV.srUi.toggleMenu(e);
    }
  }, false);
})(typeof window !== 'undefined' ? window : globalThis);
