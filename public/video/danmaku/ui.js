/*
 * Stellaflix 影视模块 — 弹幕设置面板 (ui.js)
 *
 * 纯网页 UI（非移植自 Kazumi：Kazumi 弹幕面板是 Flutter widget）。
 * 功能对齐 Kazumi「弹幕设置」面板（截图 212034/212038）：
 *   弹幕开关 / 不透明度 / 字号 / 速度 / 显示区域 / 海量模式 / 去重 / 描边 / 描边粗细 / 颜色 / 关键词屏蔽
 *   + 数据源配置（弹弹play AppId/AppSecret，用户自申请、本地持久化、绝不出厂预置）
 *   + 载入弹幕（番名 + 集数，运行时经 /api/proxy 拉取）
 *
 * 设置持久化到 localStorage（stellaflix-* 键），符合合规红线。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var danmaku = (SFV.danmaku = SFV.danmaku || {});

  var OPT_KEY = 'stellaflix-danmaku-options';
  var CRED_KEY = 'stellaflix-danmaku-credentials';
  var SRC_KEY = 'stellaflix-danmaku-sources-enabled';  // 三源开关持久化

  // 外部点击（点空白处收回）监听器引用；打开时挂上、收起/关闭时移除，避免泄漏
  var closeHandler = null;

  function loadJSON(key, fallback) {
    try {
      var raw = global.localStorage && global.localStorage.getItem(key);
      if (!raw) return fallback;
      return Object.assign({}, fallback, JSON.parse(raw));
    } catch (e) { return fallback; }
  }
  function saveJSON(key, obj) {
    try { if (global.localStorage) global.localStorage.setItem(key, JSON.stringify(obj)); } catch (e) {}
  }

  // 凭证回填：真相来源 = sources 框架（migrateLegacyCreds 已把旧 CRED_KEY 迁移并删除）。
  // 优先级：① 运行期生效的 client.getCredentials()（已由 init→migrateLegacyCreds→sources.applyCredentials 喂入）
  //         ② sources 持久化键（stellaflix-danmaku-source-dandanplay）中的 creds
  //         ③ 回退 CRED_KEY（仅兼容尚未迁移的极端场景）
  function readActiveCreds() {
    var empty = { appId: '', appSecret: '' };
    try {
      var c = (SFV.danmaku && SFV.danmaku.client && SFV.danmaku.client.getCredentials)
        ? SFV.danmaku.client.getCredentials() : null;
      if (c && (c.appId || c.appSecret)) return { appId: c.appId || '', appSecret: c.appSecret || '' };
    } catch (e) {}
    try {
      if (SFV.danmaku && SFV.danmaku.sources && SFV.danmaku.sources.configKey) {
        var saved = loadJSON(SFV.danmaku.sources.configKey('dandanplay'), {});
        if (saved && saved.creds && (saved.creds.appId || saved.creds.appSecret)) {
          return { appId: saved.creds.appId || '', appSecret: saved.creds.appSecret || '' };
        }
      }
    } catch (e) {}
    return loadJSON(CRED_KEY, empty);
  }

  function defaults() {
    return {
      enabled: false,
      opacity: 1.0, fontSize: 25, scrollSpeed: 150, area: 1.0,
      massiveMode: false, dedup: false, stroke: true, strokeWidth: 1.5, color: true,
      showScroll: true, showTop: true, showBottom: false, blockedWords: '',
      enabledSources: { bilibili: true, gamer: true, dandanplay: true },
      autoLoad: true
    };
  }

  function toast(msg) {
    if (SFV.online && SFV.online.toast) SFV.online.toast(msg);
    else if (global.console) console.log('[SFV danmaku] ' + msg);
  }

  function el(tag, cls, txt) {
    var d = global.document;
    var e = d.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  function mkRow(labelText) {
    var row = el('div', 'sfv-dm-row');
    var lab = el('label', 'sfv-dm-label', labelText);
    row.appendChild(lab);
    return row;
  }

  function mkSlider(labelText, min, max, step, value, fmt, onInput) {
    var row = mkRow(labelText);
    var val = el('span', 'sfv-dm-val', fmt(value));
    var input = el('input', 'sfv-dm-slider');
    input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = value;
    input.addEventListener('input', function () {
      var v = parseFloat(input.value);
      val.textContent = fmt(v);
      onInput(v);
    });
    row.appendChild(input); row.appendChild(val);
    return { row: row, input: input, val: val };
  }

  function mkToggle(labelText, value, onChange) {
    var row = mkRow(labelText);
    var btn = el('button', 'sfv-dm-toggle', value ? '开' : '关');
    btn.type = 'button';
    if (value) btn.classList.add('on');
    btn.addEventListener('click', function () {
      value = !value;
      btn.textContent = value ? '开' : '关';
      btn.classList.toggle('on', value);
      onChange(value);
    });
    row.appendChild(btn);
    return { row: row, btn: btn, get: function () { return value; }, set: function (v) { value = v; btn.textContent = v ? '开' : '关'; btn.classList.toggle('on', v); } };
  }

  function mkText(labelText, value, placeholder, onInput) {
    var row = mkRow(labelText);
    var input = el('input', 'sfv-dm-text');
    input.type = 'text'; input.value = value || ''; input.placeholder = placeholder || '';
    input.addEventListener('input', function () { onInput(input.value); });
    row.appendChild(input);
    return { row: row, input: input };
  }

  var current = defaults();

  function buildPanel() {
    var d = global.document;
    var panel = el('div', 'sfv-danmaku-panel');
    var opts = loadJSON(OPT_KEY, defaults());
    current = opts;

    var head = el('div', 'sfv-dm-head');
    head.appendChild(el('span', 'sfv-dm-title', '弹幕设置'));
    var close = el('button', 'sfv-dm-close', '×');
    close.type = 'button';
    close.addEventListener('click', function () { removePanel(panel); });
    head.appendChild(close);
    panel.appendChild(head);

    // 总开关
    var master = mkToggle('弹幕开关', !!opts.enabled, function (v) {
      current.enabled = v;
      if (SFV.player && SFV.player.danmaku) SFV.player.danmaku.setVisible(v);
      saveJSON(OPT_KEY, current);
    });
    panel.appendChild(master.row);

    // 不透明度
    panel.appendChild(mkSlider('不透明度', 0, 1, 0.05, opts.opacity, function (v) { return Math.round(v * 100) + '%'; }, function (v) {
      current.opacity = v; applyAndSave();
    }).row);

    // 字号
    panel.appendChild(mkSlider('字号', 12, 48, 1, opts.fontSize, function (v) { return v + 'px'; }, function (v) {
      current.fontSize = v; applyAndSave();
    }).row);

    // 速度
    panel.appendChild(mkSlider('速度', 60, 400, 10, opts.scrollSpeed, function (v) { return v + ' px/s'; }, function (v) {
      current.scrollSpeed = v; applyAndSave();
    }).row);

    // 显示区域
    panel.appendChild(mkSlider('显示区域', 0.2, 1, 0.05, opts.area, function (v) { return Math.round(v * 100) + '%'; }, function (v) {
      current.area = v; applyAndSave();
    }).row);

    // 描边
    var strokeT = mkToggle('描边', !!opts.stroke, function (v) { current.stroke = v; applyAndSave(); });
    panel.appendChild(strokeT.row);
    // 描边粗细
    panel.appendChild(mkSlider('描边粗细', 0.5, 4, 0.5, opts.strokeWidth, function (v) { return String(v); }, function (v) {
      current.strokeWidth = v; applyAndSave();
    }).row);
    // 颜色（彩色弹幕）
    var colorT = mkToggle('颜色', opts.color !== false, function (v) { current.color = v; applyAndSave(); });
    panel.appendChild(colorT.row);

    // 海量模式
    panel.appendChild(mkToggle('海量模式', !!opts.massiveMode, function (v) { current.massiveMode = v; applyAndSave(); }).row);
    // 去重
    panel.appendChild(mkToggle('弹幕去重', !!opts.dedup, function (v) { current.dedup = v; applyAndSave(); }).row);
    // 顶部 / 底部 / 滚动
    panel.appendChild(mkToggle('顶部弹幕', !!opts.showTop, function (v) { current.showTop = v; applyAndSave(); }).row);
    panel.appendChild(mkToggle('底部弹幕', !!opts.showBottom, function (v) { current.showBottom = v; applyAndSave(); }).row);
    panel.appendChild(mkToggle('滚动弹幕', !!opts.showScroll, function (v) { current.showScroll = v; applyAndSave(); }).row);

    // 关键词屏蔽
    panel.appendChild(mkText('关键词屏蔽（空格分隔）', opts.blockedWords || '', '如：广告 引战', function (v) {
      current.blockedWords = v; applyAndSave();
    }).row);

    // 分隔：弹幕来源（对齐 Kazumi 三源开关）
    panel.appendChild(el('div', 'sfv-dm-sep', '弹幕来源'));
    var srcOpts = opts.enabledSources || { bilibili: true, gamer: true, dandanplay: true };
    // BiliBili 源
    var srcBili = mkToggle('BiliBili', !!srcOpts.bilibili, function (v) {
      current.enabledSources = current.enabledSources || {};
      current.enabledSources.bilibili = v;
      applyAndSave();
    });
    panel.appendChild(srcBili.row);
    // Gamer 源
    var srcGamer = mkToggle('Gamer', !!srcOpts.gamer, function (v) {
      current.enabledSources = current.enabledSources || {};
      current.enabledSources.gamer = v;
      applyAndSave();
    });
    panel.appendChild(srcGamer.row);
    // 弹弹play 源
    var srcDandan = mkToggle('弹弹play', !!srcOpts.dandanplay, function (v) {
      current.enabledSources = current.enabledSources || {};
      current.enabledSources.dandanplay = v;
      applyAndSave();
    });
    panel.appendChild(srcDandan.row);

    // 自动加载开关
    var autoT = mkToggle('自动加载弹幕', opts.autoLoad !== false, function (v) {
      current.autoLoad = v;
      if (SFV.player && SFV.player.danmaku && SFV.player.danmaku.setAutoLoad) {
        SFV.player.danmaku.setAutoLoad(v);
      }
      applyAndSave();
      // 切换自动加载时刷新手动区的显示状态
      updateManualSectionVisibility();
    });
    panel.appendChild(autoT.row);

    // ====== 凭证区 + 手动载入区（智能显隐）======
    var credsSection = el('div', 'sfv-dm-section');
    var manualSection = el('div', 'sfv-dm-section');

    // 凭证输入
    var credsSep = el('div', 'sfv-dm-sep', '弹弹play 凭证');
    credsSection.appendChild(credsSep);
    var creds = readActiveCreds();
    var appIdInput = mkText('AppId', creds.appId, '弹弹play AppId', function (v) {
      creds.appId = v; applyCreds(creds);
      updateManualSectionVisibility();
    });
    credsSection.appendChild(appIdInput.row);
    var appSecretInput = mkText('AppSecret', creds.appSecret, '弹弹play AppSecret', function (v) {
      creds.appSecret = v; applyCreds(creds);
      updateManualSectionVisibility();
    });
    credsSection.appendChild(appSecretInput.row);

    // 手动载入
    var manualSep = el('div', 'sfv-dm-sep', '手动载入弹幕（自动关闭时可使用）');
    manualSection.appendChild(manualSep);
    var titleInput = mkText('番剧名称', '', '如：进击的巨人', function () {});
    manualSection.appendChild(titleInput.row);
    var epInput = mkText('集数', '', '如：1', function () {});
    manualSection.appendChild(epInput.row);
    var loadBtn = el('button', 'sfv-dm-load', '载入');
    loadBtn.type = 'button';
    manualSection.appendChild(loadBtn);

    // 状态提示（面板级，不属于任何子区）
    var status = el('div', 'sfv-dm-status', '');

    loadBtn.addEventListener('click', function () {
      var title = titleInput.input.value.trim();
      var ep = epInput.input.value.trim();
      if (!title) { status.textContent = '请填写番剧名称'; return; }
      if (!SFV.player || !SFV.player.danmaku) { status.textContent = '播放器未就绪'; return; }
      status.textContent = '加载中…';
      SFV.player.danmaku.loadFromClient(title, ep).then(function (list) {
        var n = list ? list.length : 0;
        var note = '';
        if (list && Array.isArray(list._sourceErrors) && list._sourceErrors.length) {
          note = '（' + list._sourceErrors.length + ' 个源失败）';
        }
        status.textContent = '已载入 ' + n + ' 条弹幕' + note;
        current.enabled = true;
        if (master && master.set) master.set(true);
        if (SFV.player.danmaku.setVisible) SFV.player.danmaku.setVisible(true);
        saveJSON(OPT_KEY, current);
      }).catch(function (e) {
        var m = e && e.message ? e.message : String(e);
        if (m.indexOf('DANMAKU_AUTH') > -1) status.textContent = '认证失败：请在上方配置 AppId/AppSecret';
        else status.textContent = '加载失败：' + m;
      });
    });

    // 把凭证区、手动载入区和状态提示加入面板
    panel.appendChild(credsSection);
    panel.appendChild(manualSection);
    panel.appendChild(status);

    // 智能显隐：根据凭证状态和自动加载开关决定显示哪些区域
    function updateManualSectionVisibility() {
      var hasCreds = (SFV.danmaku && SFV.danmaku.client && SFV.danmaku.client.hasCredentials)
        ? SFV.danmaku.client.hasCredentials()
        : !!(creds.appId && creds.appSecret);
      var autoOn = autoT.get();
      // 有凭证 + 自动加载开 → 隐藏凭证输入和手动载入（全自动模式）
      if (hasCreds && autoOn) {
        credsSection.style.display = 'none';
        manualSection.style.display = 'none';
        status.textContent = '✅ 自动加载已开启，播片时自动获取弹幕';
        status.style.display = '';
      } else if (hasCreds && !autoOn) {
        // 有凭证但手动模式 → 隐藏凭证输入，显示手动载入
        credsSection.style.display = 'none';
        manualSection.style.display = '';
        status.textContent = '';
      } else if (!hasCreds) {
        // 无凭证 → 全显示，引导用户配置
        credsSection.style.display = '';
        manualSection.style.display = '';
        status.textContent = '⚠️ 需配置凭证才能使用弹幕（去 dev.dandanplay.com 申请）';
      }
    }

    // 初始状态
    updateManualSectionVisibility();

    // 应用当前已保存选项
    applyOptions(current);

    return panel;
  }

  function applyOptions(o) {
    if (SFV.player && SFV.player.danmaku) {
      SFV.player.danmaku.setOptions({
        opacity: o.opacity, fontSize: o.fontSize, scrollSpeed: o.scrollSpeed, area: o.area,
        massiveMode: o.massiveMode, dedup: o.dedup, dedupWindow: 5, stroke: o.stroke,
        strokeWidth: o.strokeWidth, color: o.color, showScroll: o.showScroll,
        showTop: o.showTop, showBottom: o.showBottom,
        blockedWords: (o.blockedWords || '').split(/\s+/).filter(Boolean),
        enabledSources: o.enabledSources || { bilibili: true, gamer: true, dandanplay: true }
      });
      if (SFV.player.danmaku.setVisible) SFV.player.danmaku.setVisible(!!o.enabled);
      if (SFV.player.danmaku.setAutoLoad) SFV.player.danmaku.setAutoLoad(o.autoLoad !== false);
    }
  }

  function applyAndSave() {
    saveJSON(OPT_KEY, current);
    applyOptions(current);
  }

  function applyCreds(c) {
    if (SFV.danmaku && SFV.danmaku.client) SFV.danmaku.client.setCredentials(c.appId || '', c.appSecret || '');
    // 统一凭证真相来源到 sources 框架：registerSource 加载时会 applyCredentials 喂给 client，
    // 不再依赖 CRED_KEY 迁移的副作用，消除双存储不一致 / 改密不更新等隐患。
    try {
      if (SFV.danmaku && SFV.danmaku.sources) {
        SFV.danmaku.sources.setCredentials('dandanplay', { appId: c.appId || '', appSecret: c.appSecret || '' });
      }
    } catch (e) {}
  }

  // 启动时把已保存凭证注入客户端
  function init() {
    migrateLegacyCreds();
    var o = loadJSON(OPT_KEY, defaults());
    // 不自动显示，仅注入选项；是否可见由 enabled 决定
    if (SFV.player && SFV.player.danmaku) {
      applyOptions(o);
    }
  }

  // 旧版单源凭证迁移到多源框架（一次性）
  function migrateLegacyCreds() {
    try {
      if (!global.localStorage || !SFV.danmaku || !SFV.danmaku.sources) return;
      var legacy = global.localStorage.getItem(CRED_KEY);
      if (!legacy) return;
      var c = JSON.parse(legacy);
      if (c && c.appId) {
        // 总是以 CRED_KEY（用户最新输入）为准覆盖，避免改密后旧值残留导致弹幕用旧凭证
        SFV.danmaku.sources.setCredentials('dandanplay', { appId: c.appId, appSecret: c.appSecret || '' });
      }
      global.localStorage.removeItem(CRED_KEY); // 迁移完成，删除旧键
    } catch (e) {}
  }

  function removePanel(targetPanel) {
    var exist = targetPanel || document.querySelector('.sfv-danmaku-panel');
    if (exist && exist.parentNode) exist.parentNode.removeChild(exist);
    if (closeHandler) {
      document.removeEventListener('pointerdown', closeHandler, true);
      closeHandler = null;
    }
  }

  function onDocDown(e) {
    var panel = document.querySelector('.sfv-danmaku-panel');
    if (!panel) return;
    // 排除「弹幕」按钮：其自身点击走 openPanel 的 toggle 逻辑，避免捕获阶段被空白判定提前关闭（与画质/收藏/选集面板一致）
    var anchor = document.getElementById('sfv-ctrl-dan');
    if (anchor && (e.target === anchor || (anchor.contains && anchor.contains(e.target)))) return;
    if (!panel.contains(e.target)) removePanel(panel);
  }

  function openPanel() {
    if (typeof document === 'undefined') return;
    // 避免重复打开：再次点击「弹幕」按钮 → 收起（与画质/收藏/选集面板一致的 toggle）
    var exist = document.querySelector('.sfv-danmaku-panel');
    if (exist && exist.parentNode) { removePanel(exist); return; }
    var panel = buildPanel();
    var host = (SFV.player && SFV.player.isOpen && SFV.player.isOpen() && document.querySelector('#sfv-overlay')) || document.body;
    host.appendChild(panel);
    // 点击面板外空白区域 → 收起（捕获阶段，排除「弹幕」按钮）
    closeHandler = onDocDown;
    document.addEventListener('pointerdown', closeHandler, true);
  }

  danmaku.ui = { openPanel: openPanel, init: init, _defaults: defaults };
})(typeof window !== 'undefined' ? window : this);
