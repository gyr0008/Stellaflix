/*
 * Stellaflix 影视模块 — 底部控制器桥接 (影视态 #bottom-bar → 视频播放器唯一控制器)
 *
 * 职责（单文件，逻辑全在此，不写进 index.html）：
 *  - 监听 player.js 派发的 sfv:player-open / sfv:player-close，切换 body.video-player-active；
 *    影视态非播放场景 #bottom-bar 由 CSS 隐藏，仅播放态显示并浮于视频之上。
 *  - 激活时：捕获并替换 play/prev/next/mode/fullscreen 的 onclick 为视频处理函数；
 *    动态注入 倍速/选集/弹幕/画质/关闭 五个视频键；绑定 videoEl 事件更新进度/时间/图标/音量/标题。
 *  - 退出时：恢复原始 onclick、移除注入键、解绑事件。
 *  - 嵌入态（meta.embed）不激活：iframe 自带播放器，无跨域控制先例，沿用其自带 UI。
 *  - 监听 spacechange：切到音乐空间且视频在播时强制 SFV.player.close()（铁律：仅空间按钮能切换空间）。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var doc = global.document;

  var origHandlers = {};   // 按钮 id -> 原始 onclick（用于恢复）
  var injectedBtns = [];   // 动态注入的视频键 DOM
  var videoEl = null;
  var active = false;
  var volInputHandler = null;   // 影视态音量 slider input 监听（用于解绑）
  var volChangeHandler = null;  // 影视态音量 slider change 监听（覆盖 audio engine 的 toast）
  var volumePref = 1.0;     // 用户意图音量（持久化到 SFV.player settings.volume），默认 1.0 = 100%
  var userMuted = false;    // 用户显式静音切换：仅会话内、不持久化、每次打开默认 false（需求：初始非静音）
  var origBarParent = null; // 影视态激活时把 #bottom-bar 提到 body 以免被 desktop-window-shell 的 transform/clip-path 截断
  var origBarNext = null;
  var origVolParent = null; // 影视态激活时把 #volume-control 从 .modes 移到 .transport 的 #prev-btn 位置
  var origVolNext = null;
  var isDraggingProgress = false; // 进度条拖拽中（由 pointer/touch 驱动 UI，避免 timeupdate 回写导致闪烁）
  var progressDocBound = false;   // document 级 move/up/touch 监听是否已挂
  var lastProgressMoveTs = 0;     // 拖拽 seek 节流（ms）
  var origHeart = null;     // 影视态激活时替换 #heart-btn 为追片状态按钮（退出时还原）
  var currentSeriesKey = null;
  var heartBtnStates = [null, 'watching', 'planToWatch', 'onHold', 'watched', 'abandoned'];
  var epPanel = null;          // 「选集」弹层 DOM
  var epAnchorEl = null;       // 「选集」按钮（用于捕获阶段排除，避免点击瞬间被空白判定提前关闭）
  var barProtectTimer = null;  // 控制条保护期：持续清除 music.js 可能注入的 soft-hidden
  var barProtectMO = null;     // 控制条 class 变化观察器（兜底，防止定时轮询漏过）

  function $(id) { return doc && doc.getElementById ? doc.getElementById(id) : null; }
  function toast(msg) {
    var fn = (SFV.ui && typeof SFV.ui.toast === 'function') ? SFV.ui.toast
      : (SFV.home && typeof SFV.home.toast === 'function') ? SFV.home.toast
      : (global.toast && typeof global.toast === 'function') ? global.toast
      : null;
    if (fn) fn(msg);
  }
  function fmt(sec) {
    sec = Math.max(0, sec | 0);
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' + s : s);
  }

  // ---------- 控制条保护期 ----------
  // 视频态下 music.js 的 controlsAutoHide 定时器仍在跑，会给 #bottom-bar 注入 .soft-hidden
  // 或移除 .visible，造成控制条视觉上消失（即使 player.css 中和了 soft-hidden 的 opacity，
  // 它仍然可能影响命中区 / 拦截点击）。这里建立「保护期」持续清掉 soft-hidden 并保持 visible，
  // 保证 #bottom-bar 在视频态期间始终可用；退出视频态时再停掉。
  function startBarProtection() {
    stopBarProtection();
    var bar = $('bottom-bar');
    if (!bar) return;
    // 立即执行一次
    sanitizeBar(bar);
    // 定时轮询：高频快速反应（music.js 定时 480ms 注入，我们用 150ms 清除）
    barProtectTimer = setInterval(function () {
      if (!active) { stopBarProtection(); return; }
      sanitizeBar($('bottom-bar'));
    }, 150);
    // MutationObserver 兜底：监听 class 变化，一旦 soft-hidden 被加就立刻移除
    if (doc && doc.body && typeof MutationObserver !== 'undefined') {
      barProtectMO = new MutationObserver(function (mutations) {
        if (!active) { stopBarProtection(); return; }
        mutations.forEach(function (m) {
          if (m.type === 'attributes' && m.attributeName === 'class') {
            var b = m.target;
            if (b && b.id === 'bottom-bar') sanitizeBar(b);
          }
        });
      });
      barProtectMO.observe(bar, { attributes: true, attributeFilter: ['class'] });
    }
  }
  function stopBarProtection() {
    if (barProtectTimer) { clearInterval(barProtectTimer); barProtectTimer = null; }
    if (barProtectMO) { try { barProtectMO.disconnect(); } catch (e) {} barProtectMO = null; }
  }
  function sanitizeBar(bar) {
    if (!bar) return;
    // 强制清除所有可能来自音乐态的隐藏类（只在视频态生效）
    bar.classList.remove('soft-hidden');
    // 强制保持 visible 类（music.js 的 setControlsHidden 可能同步移除它）
    bar.classList.add('visible');
    // 清除任何可能被 music.js 设的 inline pointer-events:none
    if (bar.style && bar.style.pointerEvents === 'none') bar.style.pointerEvents = '';
    // 如果 music.js 在我们的 reparent 之后又把 bar 搬回 desktop-window-shell，
    // 这里兜底把它再拉回 body（正常情况下我们 reparent 一次就够）
    if (bar.parentNode && bar.parentNode !== doc.body && bar.parentNode.id !== '') {
      // 只有当它被明确搬回某个带 id 的容器时才兜底，避免干扰正常 DOM
      if (origBarParent && bar.parentNode === origBarParent) {
        try { doc.body.appendChild(bar); } catch (e) {}
      }
    }
  }

  // ---------- 激活 / 退出 ----------
  function activate(meta) {
    meta = meta || {};
    console.log('[PlayerController] activate 调用 embed=' + meta.embed + ' active=' + active);
    if (!doc || !doc.body) { console.log('[PlayerController] document/body 不可用'); return; }
    if (active) { applyMeta(meta); return; }
    active = true;
    var isEmbed = !!meta.embed;
    var bar = $('bottom-bar');
    // 嵌入态也要给 body 加 video-player-active，否则 #bottom-bar 会被
    // "body.video-space-active:not(.video-player-active)" 这条规则 display:none 永久隐藏
    doc.body.classList.add('video-player-active');
    doc.body.classList.remove('video-player-idle');
    console.log('[PlayerController] 已添加 body.video-player-active，bottom-bar 元素存在=' + !!bar + ' embed=' + isEmbed);
    if (bar) {
      // 把 #bottom-bar 提到 body 末尾，避免被 #desktop-window-shell 的 transform/clip-path 截断或压住
      if (bar.parentNode && bar.parentNode !== doc.body) {
        origBarParent = bar.parentNode;
        origBarNext = bar.nextSibling;
        doc.body.appendChild(bar);
        console.log('[PlayerController] bottom-bar 已提升为 body 直接子元素');
      }
      bar.classList.add('visible');
      bar.classList.remove('soft-hidden');
      // 仅保留 position:fixed 作为 reparenting 后的安全网；可见性/空闲淡出完全交给 CSS
      // （body.video-player-active #bottom-bar 显示，body.video-player-idle #bottom-bar 淡出）
      bar.style.position = 'fixed';
    }
    // 启动控制条保护期：持续清除 music.js 可能注入的 soft-hidden
    startBarProtection();
    if (isEmbed) {
      // 嵌入态不接管视频播放控件（iframe 自带），但保留底部控制条的可见性
      console.log('[PlayerController] 嵌入态：跳过视频控件接管，但保持底部控制条可见');
      applyMeta(meta);
      return;
    }
    videoEl = (SFV.player && SFV.player.getVideoEl) ? SFV.player.getVideoEl() : null;
    console.log('[PlayerController] videoEl 存在=' + !!videoEl);
    restoreVolumeState(); // 恢复上次记忆音量（默认 100%）并默认非静音；显示层与 autoplay shim 解耦
    // 影视态下把音量控制移到 transport 区 #prev-btn 的位置（play 按钮左侧）
    reparentVolumeToTransport(true);
    swapHandlers(true);
    injectVideoButtons();
    bindVideoEvents();
    bindVolumeControls();
    bindGlobalKeys(); // 空格键播放/暂停（capture 阶段，影视态独占）
    bindProgressControls(); // 进度条拖拽 seek
    setupHeartBtn(); // 必须在 applyMeta 之前捕获原始心形按钮，否则 refreshHeartBtn 先改了它
    applyMeta(meta);
    updateNavButtons();
    // [#11] 影视态下把 ⓘ 信息按钮的 tooltip 改为「视频详情」（退出时还原）
    var tdb = doc.getElementById && doc.getElementById('track-detail-btn');
    if (tdb) { tdb.title = '视频详情'; tdb.setAttribute('aria-label', '视频详情'); }
  }

  function deactivate() {
    console.log('[PlayerController] deactivate 调用 active=' + active);
    if (!active) return;
    active = false;
    stopBarProtection(); // 停掉控制条保护期（必须在 swapHandlers 等之前，避免回调干扰）
    swapHandlers(false);
    removeInjectedButtons();
    closeEpisodePanel(); // 退出时清理「选集」弹层（若有）
    unbindVolumeControls();
    unbindGlobalKeys(); // 解绑空格键播放/暂停
    unbindProgressControls(); // 解绑进度条拖拽 seek
    unbindVideoEvents();
    reparentVolumeToTransport(false);
    if (doc && doc.body) doc.body.classList.remove('video-player-active', 'video-player-idle');
    var bar = $('bottom-bar');
    if (bar) {
      bar.classList.remove('visible');
      bar.classList.remove('soft-hidden'); // 退出前再清一次 soft-hidden，避免音乐态残留
      // 清激活时覆盖的 inline 样式，让 CSS 常态规则重新接管
      bar.style.display = '';
      bar.style.position = '';
      bar.style.opacity = '';
      bar.style.pointerEvents = '';
      bar.style.transform = '';
      bar.style.zIndex = '';
      // 恢复原来的 DOM 位置（音乐态期望它在 desktop-window-shell 内）
      if (origBarParent) {
        try {
          if (origBarNext && origBarNext.parentNode === origBarParent) {
            origBarParent.insertBefore(bar, origBarNext);
          } else {
            origBarParent.appendChild(bar);
          }
          console.log('[PlayerController] bottom-bar 已恢复为 desktop-window-shell 子元素');
        } catch (e) {}
        origBarParent = null;
        origBarNext = null;
      }
    }
    videoEl = null;
    // [#11] 还原 ⓘ 信息按钮的 tooltip 为「歌曲详情 / 评论」
    var tdb = doc.getElementById && doc.getElementById('track-detail-btn');
    if (tdb) { tdb.title = '歌曲详情 / 评论'; tdb.setAttribute('aria-label', '歌曲详情 / 评论'); }
    // 还原 #heart-btn 为音乐态「红心喜欢」
    if (origHeart) {
      var hb = $('heart-btn');
      if (hb) {
        hb.innerHTML = origHeart.html;
        hb.onclick = origHeart.onclick;
        hb.title = origHeart.title;
        hb.setAttribute('aria-label', origHeart.ariaLabel);
      }
      origHeart = null;
    }
    currentSeriesKey = null;
  }

  // ---------- 追片状态按钮（影视态下心形按钮改为6态图标，无文字） ----------
  function getSeriesKey() {
    var meta = (SFV.player && SFV.player.getMeta) ? SFV.player.getMeta() : null;
    return (meta && meta.seriesKey) ? meta.seriesKey : null;
  }
  function getTrackIconHtml(status) {
    var map = (SFV.model && SFV.model.STATE_ICONS) || {};
    var icon = map[status || 'none'] || '';
    return '<span class="sfv-track-icon">' + icon + '</span>';
  }
  function refreshHeartBtn() {
    var btn = $('heart-btn');
    if (!btn) return;
    var key = getSeriesKey();
    currentSeriesKey = key;
    var status = (key && SFV.model && typeof SFV.model.getTrackStatus === 'function') ? SFV.model.getTrackStatus(key) : null;
    var label = (status && SFV.model && SFV.model.TRACK_LABELS) ? SFV.model.TRACK_LABELS[status] : '未追';
    btn.innerHTML = getTrackIconHtml(status);
    btn.title = '追片：' + label;
    btn.setAttribute('aria-label', '追片：' + label);
  }
  function onHeartClick(e) {
    e && e.preventDefault();
    var key = currentSeriesKey || getSeriesKey();
    if (!key || !SFV.model || typeof SFV.model.getTrackStatus !== 'function' || typeof SFV.model.setTrackStatus !== 'function') return;
    var status = SFV.model.getTrackStatus(key);
    var idx = heartBtnStates.indexOf(status);
    var next = heartBtnStates[(idx + 1) % heartBtnStates.length];
    SFV.model.setTrackStatus(key, next);
    refreshHeartBtn();
    var label = (next && SFV.model.TRACK_LABELS) ? SFV.model.TRACK_LABELS[next] : '未追';
    toast('已设为：' + label);
  }
  function setupHeartBtn() {
    var hb = $('heart-btn');
    if (!hb) return;
    origHeart = {
      html: hb.innerHTML,
      onclick: hb.onclick,
      title: hb.title,
      ariaLabel: hb.getAttribute('aria-label')
    };
    hb.onclick = onHeartClick;
    refreshHeartBtn();
  }

  // ---------- 音量控制 reposition（影视态移到 transport 区 prev 位置，退出时还原） ----------
  function reparentVolumeToTransport(on) {
    var volCtrl = $('volume-control');
    if (!volCtrl) return;
    if (on) {
      var prevBtn = $('prev-btn');
      if (prevBtn && prevBtn.parentNode && volCtrl.parentNode !== prevBtn.parentNode) {
        origVolParent = volCtrl.parentNode;
        origVolNext = volCtrl.nextSibling;
        prevBtn.parentNode.insertBefore(volCtrl, prevBtn);
      }
    } else {
      if (origVolParent) {
        try {
          if (origVolNext && origVolNext.parentNode === origVolParent) {
            origVolParent.insertBefore(volCtrl, origVolNext);
          } else {
            origVolParent.appendChild(volCtrl);
          }
        } catch (e) {}
        origVolParent = null;
        origVolNext = null;
      }
    }
  }

  // 空格键 → 播放/暂停（与底部控制栏播放按钮同效）。capture 阶段拦截，
  // 既避免页面滚动，也阻止音乐态 Space 热键在影视态同时触发音频播放/暂停。
  function bindGlobalKeys() {
    if (global.addEventListener) global.addEventListener('keydown', onSpaceKeyDown, true);
  }
  function unbindGlobalKeys() {
    if (global.removeEventListener) global.removeEventListener('keydown', onSpaceKeyDown, true);
  }

  // ---------- onclick 替换 ----------
  function swapHandlers(on) {
    var map = {
      'play-btn': on ? onPlay : null,
      'prev-btn': on ? onPrev : null,
      'next-btn': on ? onNext : null,
      'play-mode-btn': on ? onMode : null,
      'fullscreen-toggle-btn': on ? onFullscreen : null
    };
    Object.keys(map).forEach(function (id) {
      // fullscreen-toggle-btn 在 #bottom-bar 中是 class 而非 id，需单独按类查找
      var el = (id === 'fullscreen-toggle-btn')
        ? (doc.querySelector ? doc.querySelector('.fullscreen-toggle-btn') : null)
        : $(id);
      if (!el) return;
      if (on) {
        if (!origHandlers[id]) origHandlers[id] = el.onclick;
        el.onclick = map[id];
      } else {
        el.onclick = origHandlers[id] || null;
        delete origHandlers[id];
      }
    });
  }

  function onPlay(e) { e && e.preventDefault(); if (SFV.player) SFV.player.togglePlay(); }
  function onPrev(e) { e && e.preventDefault(); if (SFV.player) SFV.player.playPrevEpisode(); updateNavButtons(); }
  function onNext(e) { e && e.preventDefault(); if (SFV.player) SFV.player.playNextEpisode(); updateNavButtons(); }
  function onMode(e) { e && e.preventDefault(); if (SFV.player) SFV.player.cyclePlayMode(); refreshModeBtn(); }
  function onFullscreen(e) { e && e.preventDefault(); if (SFV.player) SFV.player.toggleFullscreen(); }
  // ESC 返回：与控制条 ✕ 返回键同功能（关闭播放器 / 返回详情页）
  function onKeyDown(e) {
    if (!active) return;
    if (e.key !== 'Escape' && e.keyCode !== 27) return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    // 全屏态下 ESC 优先退出全屏（Electron 原生全屏或 HTML5 Fullscreen），不要再关播放器；
    // 退出全屏回到窗口态后再次按 ESC 才关闭播放器（返回详情页）。
    // 注意：Electron 原生全屏不会触发 doc.fullscreenElement，真实状态由窗口状态 IPC
    // 写入 body.desktop-fullscreen（player.js 同步 body.sfv-fullscreen）。必须按该真实
    // 状态判断，否则原生全屏下 doc.fullscreenElement 恒为 null → 首按 ESC 直接关播放器越级返回。
    if (doc) {
      var inFs = !!(doc.fullscreenElement) ||
        (doc.body && doc.body.classList.contains('desktop-fullscreen')) ||
        (doc.body && doc.body.classList.contains('sfv-fullscreen'));
      if (inFs) return;
    }
    if (SFV.player && SFV.player.close) SFV.player.close();
  }

  // 空格键 → 播放/暂停（与底部控制栏播放按钮同效）。capture 阶段拦截，
  // 既避免页面滚动，也阻止音乐态 Space 热键在影视态同时触发音频播放/暂停。
  function onSpaceKeyDown(e) {
    if (!active) return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === ' ' || e.code === 'Space' || e.keyCode === 32) {
      e.preventDefault();
      e.stopPropagation();
      if (SFV.player && SFV.player.togglePlay) SFV.player.togglePlay();
    }
  }

  // ---------- 动态注入视频键 ----------
  function mkVideoBtn(id, label, onClick, title) {
    var b = doc.createElement('button');
    b.id = id; b.type = 'button'; b.className = 'ctrl-btn sfv-vbtn'; b.textContent = label;
    if (title) b.title = title;
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }
  function injectVideoButtons() {
    var modes = doc.querySelector && doc.querySelector('#bottom-bar .control-cluster.modes');
    if (!modes) return;
    var ref = doc.querySelector ? doc.querySelector('.fullscreen-toggle-btn') : null;
    var speed = mkVideoBtn('sfv-ctrl-speed', '1x', function (e) { e.preventDefault(); if (SFV.player) { SFV.player.cycleSpeed(); refreshSpeed(); } }, '倍速');
    var ep = mkVideoBtn('sfv-ctrl-ep', '选集', function (e) { e.preventDefault(); if (SFV.player) openEpisodePanel(e); }, '选集');
    var dan = mkVideoBtn('sfv-ctrl-dan', '弹幕', function (e) { e.preventDefault(); if (SFV.danmaku && SFV.danmaku.ui && SFV.danmaku.ui.openPanel) SFV.danmaku.ui.openPanel(); }, '弹幕');
    var qual = mkVideoBtn('sfv-ctrl-quality', '画质', function (e) { e.preventDefault(); if (SFV.srUi) SFV.srUi.toggleMenu(e); }, '画质增强');
    var close = mkVideoBtn('sfv-ctrl-close', '✕', function (e) { e.preventDefault(); if (SFV.player) SFV.player.close(); }, '关闭');
    injectedBtns = [speed, ep, dan, qual, close];
    injectedBtns.forEach(function (b) {
      if (ref && ref.parentNode) ref.parentNode.insertBefore(b, ref);
      else modes.appendChild(b);
    });
  }
  function removeInjectedButtons() {
    injectedBtns.forEach(function (b) { if (b.parentNode) b.parentNode.removeChild(b); });
    injectedBtns = [];
  }

  // ---------- 「选集」弹层 ----------
  // 点击「选集」弹出剧集列表；再次点击按钮或点击面板外空白区域则收回。
  // 行为对齐「画质」/「收藏」面板（捕获阶段排除锚点，避免点击瞬间被空白判定提前关闭）。
  function openEpisodePanel(e) {
    if (epPanel && epPanel.parentNode) { closeEpisodePanel(); return; }
    var pl = (SFV.player && typeof SFV.player.getPlaylist === 'function') ? SFV.player.getPlaylist() : null;
    var tracks = (pl && pl.tracks) || null;
    if (!tracks || !tracks.length) { toast('当前没有可选剧集'); return; }
    var curIdx = (pl && typeof pl.index === 'number') ? pl.index : -1;
    var d = global.document;
    var panel = d.createElement('div');
    panel.className = 'sfv-episode-panel';
    var hd = d.createElement('div');
    hd.className = 'sfv-ep-head';
    hd.textContent = '选集';
    panel.appendChild(hd);
    var list = d.createElement('div');
    list.className = 'sfv-ep-list';
    tracks.forEach(function (ep, i) {
      var item = d.createElement('button');
      item.type = 'button';
      item.className = 'sfv-ep-item' + (i === curIdx ? ' is-current' : '');
      item.textContent = (ep && ep.name) ? ep.name : ('第' + (i + 1) + '集');
      item.addEventListener('click', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        if (SFV.player && typeof SFV.player.playEpisodeAt === 'function') SFV.player.playEpisodeAt(i);
        closeEpisodePanel();
      });
      list.appendChild(item);
    });
    panel.appendChild(list);
    var anchor = $('sfv-ctrl-ep') || (e && e.currentTarget) || null;
    // 面板必须挂载到影视态顶层覆盖层（或 body），不能放在底部控制栏内部，
    // 否则会被 #bottom-bar 的边界/clip-path/overflow 裁剪，导致右侧面板看不到。
    var mount = $('sfv-overlay') || doc.body;
    mount.appendChild(panel);
    epPanel = panel;
    epAnchorEl = anchor;
    doc.addEventListener('pointerdown', onEpDocDown, true);
  }
  function closeEpisodePanel() {
    if (epPanel && epPanel.parentNode) epPanel.parentNode.removeChild(epPanel);
    epPanel = null; epAnchorEl = null;
    doc.removeEventListener('pointerdown', onEpDocDown, true);
  }
  function onEpDocDown(e) {
    if (!epPanel) return;
    if (epAnchorEl && (e.target === epAnchorEl || (epAnchorEl.contains && epAnchorEl.contains(e.target)))) return;
    if (epPanel.contains && epPanel.contains(e.target)) return;
    closeEpisodePanel();
  }
  function refreshSpeed() {
    var b = $('sfv-ctrl-speed');
    if (b && SFV.player && SFV.player.getSpeed) b.textContent = SFV.player.getSpeed() + 'x';
  }
  function refreshModeBtn() {
    var btn = $('play-mode-btn');
    if (!btn || !SFV.player || !SFV.player.getPlayMode) return;
    var mode = SFV.player.getPlayMode();
    var label = { sequence: '连播', 'repeat-one': '单集循环', off: '不连播' };
    btn.title = label[mode] || mode;
    btn.setAttribute('data-mode', mode === 'sequence' ? 'loop' : (mode === 'repeat-one' ? 'single' : 'off'));
  }
  function updateNavButtons() {
    var prev = $('prev-btn'), next = $('next-btn');
    var hasPrev = SFV.player && SFV.player.hasPrevEpisode ? SFV.player.hasPrevEpisode() : false;
    var hasNext = SFV.player && SFV.player.hasNextEpisode ? SFV.player.hasNextEpisode() : false;
    if (prev) { prev.disabled = !hasPrev; prev.style.opacity = hasPrev ? '' : '0.38'; }
    if (next) { next.disabled = !hasNext; next.style.opacity = hasNext ? '' : '0.38'; }
  }

  // ---------- videoEl 事件绑定 ----------
  function onTimeUpdate() {
    if (!videoEl) return;
    if (isDraggingProgress) return; // 拖拽期间由指针事件驱动 UI，避免 timeupdate 回写导致闪烁
    var c = Math.floor(videoEl.currentTime || 0), d = Math.floor(videoEl.duration || 0);
    var ratio = d ? (c / d) : 0;
    var fill = $('progress-fill'), thumb = $('progress-thumb'), time = $('time-display');
    if (fill) fill.style.width = (ratio * 100) + '%';
    if (thumb) thumb.style.left = (ratio * 100) + '%';
    if (time) time.textContent = fmt(c) + ' / ' + fmt(d);
  }
  function refreshPlayIcon() {
    var b = $('play-icon');
    if (!b || !videoEl) return;
    b.innerHTML = videoEl.paused
      ? '<path d="M8 5v14l11-7z"/>'
      : '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
  }
  function refreshVolumeIcon() {
    refreshVolumeUI();
  }

  // 恢复上次记忆音量（持久化于 SFV.player settings.volume），默认 1.0（100%）；每次打开默认非静音。
  // 注意：仅同步 videoEl.volume 与显示意图，不在此解除 player.js 初始的 muted shim，
  // 以保留 Chrome 自动播放合规；真实静音解除由 wireUnmuteOnInteraction（首次手势）完成。
  function restoreVolumeState() {
    if (!videoEl) return;
    var saved = (SFV.player && typeof SFV.player.getSettings === 'function') ? SFV.player.getSettings() : {};
    var v = (saved && typeof saved.volume === 'number' && saved.volume >= 0 && saved.volume <= 1) ? saved.volume : 1.0;
    volumePref = v;
    userMuted = false; // 每次打开默认非静音
    videoEl.volume = v; // 同步真实音量（muted shim 保持原样）
  }

  // 同步音量 slider / 百分比 / 图标 / muted 状态到意图层（与 videoEl.muted 解耦）
  function refreshVolumeUI() {
    if (!videoEl) return;
    var slider = $('volume-slider');
    var val = $('volume-value');
    var vc = $('volume-control');
    var btn = $('volume-btn');
    var displayedMuted = userMuted || (volumePref <= 0); // 0 音量同样显示为静音图标
    var shown = displayedMuted ? 0 : volumePref; // 静音时 slider 视觉降到 0，但 volumePref 保留以解除静音后恢复
    if (slider) slider.value = String(shown);
    if (val) val.textContent = Math.round(shown * 100) + '%';
    if (vc) vc.classList.toggle('muted', displayedMuted);
    updateVolumeIconSvg(btn, displayedMuted);
  }

  function updateVolumeIconSvg(btn, muted) {
    if (!btn) return;
    var svg = $('volume-icon') || btn.querySelector('svg');
    if (!svg) return;
    svg.innerHTML = muted
      ? '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/>'
      : '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15 9.5a4 4 0 0 1 0 5"/>';
  }

  // 影视态：slider 直接控制 videoEl.volume，并取消静音（否则 autoplay 默认 muted 导致拖了 slider 也没声音）
  // 拖动 slider 本身即用户手势，可安全解除 muted shim；同时记忆音量偏好（持久化）。
  function onVolumeSliderInput(e) {
    if (!videoEl) return;
    e.stopImmediatePropagation();
    var v = parseFloat(e.target.value);
    v = Math.max(0, Math.min(1, isNaN(v) ? 1 : v));
    volumePref = v;
    userMuted = false;
    videoEl.volume = v;
    videoEl.muted = false; // 手势内，解除 autoplay shim
    if (SFV.player && typeof SFV.player.setSetting === 'function') SFV.player.setSetting('volume', v);
    refreshVolumeUI();
  }

  // 覆盖 audio engine 在 change 时弹出基于 targetVolume（其值在影视态不会更新）的 stale toast
  function onVolumeSliderChange(e) {
    e.stopImmediatePropagation();
    var pct = videoEl ? Math.round((videoEl.muted ? 0 : videoEl.volume) * 100) : 0;
    toast('音量 ' + pct + '%');
  }

  // 影视态：点击音量图标切换静音；同时保留原 toggleVolumePanel 的面板展开行为。
  // 静音切换仅作用于会话内 userMuted（不持久化）；muted 状态本身不写入 settings，每次打开默认非静音。
  function onVolumeBtnClick(e) {
    if (!videoEl) return;
    e && e.preventDefault();
    e && e.stopPropagation();
    if (typeof global.toggleVolumePanel === 'function') global.toggleVolumePanel(e);
    userMuted = !userMuted;
    videoEl.muted = userMuted;
    if (!userMuted && videoEl.volume === 0) {
      videoEl.volume = 0.5;
      volumePref = 0.5;
      if (SFV.player && typeof SFV.player.setSetting === 'function') SFV.player.setSetting('volume', 0.5);
    }
    refreshVolumeUI();
  }

  function bindVolumeControls() {
    var slider = $('volume-slider');
    var btn = $('volume-btn');
    if (slider) {
      volInputHandler = onVolumeSliderInput;
      volChangeHandler = onVolumeSliderChange;
      // 用 capture 阶段拦截 audio engine 注册的 bubble 监听器，避免音量被设到 audio engine 以及 stale toast
      slider.addEventListener('input', volInputHandler, true);
      slider.addEventListener('change', volChangeHandler, true);
    }
    if (btn) {
      if (!origHandlers['volume-btn']) origHandlers['volume-btn'] = btn.onclick;
      btn.onclick = onVolumeBtnClick;
    }
    refreshVolumeUI();
  }

  function unbindVolumeControls() {
    var slider = $('volume-slider');
    var btn = $('volume-btn');
    if (slider) {
      if (volInputHandler) slider.removeEventListener('input', volInputHandler, true);
      if (volChangeHandler) slider.removeEventListener('change', volChangeHandler, true);
    }
    if (btn) btn.onclick = origHandlers['volume-btn'] || null;
    delete origHandlers['volume-btn'];
    volInputHandler = null;
    volChangeHandler = null;
  }

  // ---------- 进度条拖拽 seek（影视态底部控制栏） ----------
  function getProgressRatio(e) {
    var bar = $('progress-bar');
    if (!bar) return 0;
    var rect = (bar.getBoundingClientRect && bar.getBoundingClientRect()) || { left: 0, width: 0 };
    var clientX = e.clientX;
    if (e.touches && e.touches.length) clientX = e.touches[0].clientX;
    if (!rect.width) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }
  function seekVideoByRatio(ratio) {
    ratio = Math.max(0, Math.min(1, ratio));
    if (SFV.player && SFV.player.seek) {
      SFV.player.seek(ratio);
    } else if (videoEl && videoEl.duration) {
      try { videoEl.currentTime = ratio * videoEl.duration; } catch (e) {}
    }
  }
  function updateProgressVisual(ratio) {
    var fill = $('progress-fill'), thumb = $('progress-thumb'), time = $('time-display');
    if (fill) fill.style.width = (ratio * 100) + '%';
    if (thumb) thumb.style.left = (ratio * 100) + '%';
    if (time && videoEl && videoEl.duration) {
      time.textContent = fmt(Math.floor(ratio * videoEl.duration)) + ' / ' + fmt(Math.floor(videoEl.duration));
    }
  }
  function onProgressDown(e) {
    if (!videoEl || !videoEl.duration) return;
    var bar = $('progress-bar');
    if (!bar) return;
    isDraggingProgress = true;
    lastProgressMoveTs = 0;
    bar.classList.add('is-dragging');
    bindProgressDocListeners(true);
    var ratio = getProgressRatio(e);
    updateProgressVisual(ratio);
    seekVideoByRatio(ratio);
    e.preventDefault();
    e.stopPropagation();
  }
  function onProgressMove(e) {
    if (!isDraggingProgress) return;
    var ratio = getProgressRatio(e);
    updateProgressVisual(ratio);
    var now = Date.now();
    if (now - lastProgressMoveTs > 80) {
      seekVideoByRatio(ratio);
      lastProgressMoveTs = now;
    }
    e.preventDefault();
    e.stopPropagation();
  }
  function onProgressUp(e) {
    if (!isDraggingProgress) return;
    var bar = $('progress-bar');
    if (bar) bar.classList.remove('is-dragging');
    isDraggingProgress = false;
    bindProgressDocListeners(false);
    var ratio = getProgressRatio(e);
    updateProgressVisual(ratio);
    seekVideoByRatio(ratio);
  }
  function bindProgressDocListeners(on) {
    if (!doc) return;
    if (on) {
      if (progressDocBound) return;
      doc.addEventListener('mousemove', onProgressMove);
      doc.addEventListener('mouseup', onProgressUp);
      doc.addEventListener('touchmove', onProgressMove, { passive: false });
      doc.addEventListener('touchend', onProgressUp);
      doc.addEventListener('touchcancel', onProgressUp);
      progressDocBound = true;
    } else {
      if (!progressDocBound) return;
      doc.removeEventListener('mousemove', onProgressMove);
      doc.removeEventListener('mouseup', onProgressUp);
      doc.removeEventListener('touchmove', onProgressMove, { passive: false });
      doc.removeEventListener('touchend', onProgressUp);
      doc.removeEventListener('touchcancel', onProgressUp);
      progressDocBound = false;
    }
  }
  function bindProgressControls() {
    var bar = $('progress-bar');
    if (!bar) return;
    bar.addEventListener('mousedown', onProgressDown);
    bar.addEventListener('touchstart', onProgressDown, { passive: false });
  }
  function unbindProgressControls() {
    var bar = $('progress-bar');
    if (bar) {
      bar.removeEventListener('mousedown', onProgressDown);
      bar.removeEventListener('touchstart', onProgressDown, { passive: false });
      if (isDraggingProgress) bar.classList.remove('is-dragging');
    }
    isDraggingProgress = false;
    bindProgressDocListeners(false);
  }

  function bindVideoEvents() {
    if (!videoEl) return;
    videoEl.addEventListener('timeupdate', onTimeUpdate);
    videoEl.addEventListener('durationchange', onTimeUpdate);
    videoEl.addEventListener('loadedmetadata', onTimeUpdate);
    videoEl.addEventListener('play', refreshPlayIcon);
    videoEl.addEventListener('pause', refreshPlayIcon);
    videoEl.addEventListener('ended', refreshPlayIcon);
    videoEl.addEventListener('volumechange', refreshVolumeIcon);
    onTimeUpdate(); refreshPlayIcon(); refreshVolumeUI(); refreshSpeed(); refreshModeBtn();
  }
  function unbindVideoEvents() {
    if (!videoEl) return;
    videoEl.removeEventListener('timeupdate', onTimeUpdate);
    videoEl.removeEventListener('durationchange', onTimeUpdate);
    videoEl.removeEventListener('loadedmetadata', onTimeUpdate);
    videoEl.removeEventListener('play', refreshPlayIcon);
    videoEl.removeEventListener('pause', refreshPlayIcon);
    videoEl.removeEventListener('ended', refreshPlayIcon);
    videoEl.removeEventListener('volumechange', refreshVolumeIcon);
  }

  // ---------- 元信息 ----------
  function applyMeta(meta) {
    meta = meta || {};
    var title = $('control-title'), artist = $('control-artist'), cover = $('control-cover');
    if (title) title.textContent = meta.title || '';
    if (artist) artist.textContent = meta.subtitle || '';
    if (cover) {
      if (meta.cover) {
        cover.style.backgroundImage = 'url("' + String(meta.cover).replace(/"/g, '\\"') + '")';
        cover.classList.remove('cover-empty');
      } else {
        cover.style.backgroundImage = '';
        cover.classList.add('cover-empty');
      }
    }
    refreshModeBtn(); refreshSpeed(); updateNavButtons(); refreshHeartBtn();
  }

  // ---------- 空间切换：切到音乐空间强制关闭视频 ----------
  function onSpaceChange(detail) {
    if (detail && detail.spaceMode === 'music' && SFV.player && SFV.player.isOpen && SFV.player.isOpen()) {
      SFV.player.close();
    }
  }

  // ---------- 初始化 ----------
  function init() {
    if (!doc) return;
    console.log('[PlayerController] init 注册事件监听');
    global.addEventListener('sfv:player-open', function (e) { console.log('[PlayerController] 收到 sfv:player-open'); activate(e && e.detail); });
    global.addEventListener('sfv:player-close', function () { deactivate(); });
    // ESC 返回：影视态播放中与 ✕ 返回键同功能（关闭播放器）
    global.addEventListener('keydown', onKeyDown);
    // 元信息晚到（如 source-adapter 解析出真实封面/标题）时刷新底部控制器
    global.addEventListener('sfv:player-meta', function (e) { if (active) applyMeta(e && e.detail); });
    if (SFV.state && SFV.state.EVENT) {
      global.addEventListener(SFV.state.EVENT, function (e) { onSpaceChange(e && e.detail); });
    }
  }

  SFV.playerController = { init: init, activate: activate, deactivate: deactivate };

  if (doc && doc.readyState !== 'loading') init();
  else doc.addEventListener('DOMContentLoaded', init);
})(typeof window !== 'undefined' ? window : this);
