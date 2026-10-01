/*
 * Stellaflix 影视模块 — 汇联 mpv 播控条（Task7）
 * 用法：SFV.huilianPlayerBar.create({bridge, container, file, hash, onClose, onError, isStale})
 *   container = 页面 .huilian-stage 视频容器：其 getBoundingClientRect（视口 CSS px）即 overlay 跟随矩形，
 *               主进程（Task5/D1）再加主窗口客户区偏移并按 zoom 换算，故此处不加 scrollX/scrollY；
 *   控件条 .huilian-bar 追加到 container.parentNode（原生 overlay 恒置顶，HTML 控件不可叠在其上）。
 * 生命周期红线（T158）：destroy() 必调 player.destroyOverlay 且绝不删任务；
 *   download.delete 只在用户点「删任务+删文件」（播完面板 / 控件条 close-del）时发生。
 * 桥方法实名（desktop/preload-video.js，brief 简写以实名为准）：
 *   player.createOverlay(opts) / destroyOverlay(playerId) / setBounds(playerId, rect) /
 *   command(id, cmdArr) / getProperty(id, name) / setProperty(id, name, value) / seek(id, sec) /
 *   stopAndClean(id) / onEvent(id, event, cb) → 返回退订函数；download.delete(hash, deleteFiles)。
 *   真实桥无 player.pause/resume/stop，且 mpv JSON IPC 无 'set' 命令：暂停走 setProperty(id,'pause',bool)
 *   （主进程转 ['set_property','pause',v]）。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});
  var SYNC_INTERVAL_MS = 500;   // 周期兜底同步（brief 允许）
  var MIN_SEND_MS = 100;        // 节流下限：两次 setBounds 至少间隔 100ms
  // 容器未布局（0x0，例如 CSS 尚未就位）时的兜底创建尺寸 = 桌面端 createOverlay 默认值
  var DEFAULT_RECT = { x: 0, y: 0, width: 800, height: 450 };

  function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

  function el(tag, id, cls) {
    var n = global.document.createElement(tag);
    if (id) n.setAttribute('id', id);
    if (cls) n.setAttribute('class', cls);
    return n;
  }

  function create(options) {
    var opts = options || {};
    var bridge = opts.bridge;
    var container = opts.container;
    var file = opts.file || {};
    var hash = opts.hash || '';
    var onClose = typeof opts.onClose === 'function' ? opts.onClose : function () {};
    var onError = typeof opts.onError === 'function' ? opts.onError : function () {};
    var isStale = typeof opts.isStale === 'function' ? opts.isStale : function () { return false; };
    var player = bridge && bridge.player;

    var playerId = null;
    var barNode = null, panelNode = null, toggleBtn = null, seekEl = null, volEl = null;
    var subs = [], timer = null, gen = 0, destroyed = false, cleaned = false,
      ended = false, paused = false, lastRect = null, lastSentAt = -1e9;

    function report(res, fallback) { onError((res && res.error) || (res && res.message) || fallback); }

    // ---- 容器矩形（视口 CSS px）----
    function rect() {
      if (!container || !container.getBoundingClientRect) return null;
      var r = container.getBoundingClientRect() || {};
      var out = { x: Number(r.x), y: Number(r.y), width: Number(r.width), height: Number(r.height) };
      if (!isNum(out.x) || !isNum(out.y) || !isNum(out.width) || !isNum(out.height)) return null;
      if (out.width <= 0 || out.height <= 0) return null; // 未布局：本轮不发，等周期兜底
      return out;
    }
    function sameRect(a, b) {
      return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
    }

    function sendBounds(r) {
      var myGen = gen;
      return Promise.resolve(player.setBounds(playerId, r)).then(function (res) {
        if (destroyed || myGen !== gen) return;   // 拆除/换带中的竞态：静默
        if (!res || res.ok) return;               // {ok:true,data:false} = 无 overlay，静默忽略
        report(res, '同步播放窗口位置失败');
      }).catch(function (err) { if (!destroyed && myGen === gen) report(err, '同步播放窗口位置失败'); });
    }

    // 节流：矩形未变化不发；变化但未满 100ms 下限也先挂起，由 500ms 周期同步兜底发出
    function sync(force) {
      if (destroyed || !playerId) return;
      var r = rect();
      if (!r) return;
      if (!force && lastRect && sameRect(r, lastRect)) return;
      if (!force && global.Date.now() - lastSentAt < MIN_SEND_MS) return;
      lastRect = r; lastSentAt = global.Date.now();
      sendBounds(r);
    }

    // ---- 事件订阅 ----
    function subscribe(event, handler) {
      if (typeof player.onEvent !== 'function') return;
      var myGen = gen;
      var off = player.onEvent(playerId, event, function (payload) {
        if (destroyed || myGen !== gen) return;   // 旧订阅即使未被桥清理也不再处理（防重挂双处理）
        handler(payload);
      });
      if (typeof off === 'function') subs.push(off);
    }
    function eventValue(payload) {
      if (!payload) return null;
      if (payload.data && typeof payload.data.value !== 'undefined') return payload.data.value;
      return typeof payload.data !== 'undefined' ? payload.data : null;
    }
    function applyTime(sec) { if (isNum(sec) && seekEl) seekEl.value = String(sec); }
    function applyDuration(sec) { if (isNum(sec) && seekEl) seekEl.max = String(Math.max(0, sec)); }
    // time-pos/duration 在 mpv 侧以 property-change 携带 name 广播，兼容两种形态
    function onPropertyChange(payload) {
      var name = payload && payload.name;
      var v = eventValue(payload);
      if (name === 'time-pos') applyTime(v);
      else if (name === 'duration') applyDuration(v);
    }
    function subscribeEvents() {
      subscribe('time-pos', function (p) { applyTime(eventValue(p)); });
      subscribe('duration', function (p) { applyDuration(eventValue(p)); });
      subscribe('property-change', onPropertyChange);
      subscribe('end-file', function () {
        ended = true;
        showPanel('huilian-done-panel', '已播完', [
          { id: 'huilian-done-del', label: '删任务+删文件', on: deleteTaskAndFiles },
          { id: 'huilian-done-keep', label: '保留任务', on: function () { keepOnly(); } },
        ]);
      });
      subscribe('shutdown', function () {
        if (ended || cleaned) return; // 播完/已清理后的进程退出属预期，不再降级
        showPanel('huilian-degraded-panel', '播放已中断（mpv 进程退出）', [
          { id: 'huilian-retry', label: '重试', on: function () { releaseOverlay(); startOverlay(); } },
          { id: 'huilian-switch', label: '换文件', on: function () { releaseOverlay(); onClose(); } },
        ]);
      });
    }

    // ---- DOM ----
    function removePanel() {
      if (panelNode && panelNode.parentNode) panelNode.parentNode.removeChild(panelNode);
      panelNode = null;
    }
    function showPanel(cls, tip, items) {
      removePanel();
      var box = el('div', '', cls);
      box.textContent = tip; // 提示文案直存本节点：假 DOM textContent 不聚合子节点
      for (var i = 0; i < items.length; i++) {
        var b = el('button', items[i].id);
        b.textContent = items[i].label;
        b.addEventListener('click', items[i].on);
        box.appendChild(b);
      }
      (barNode || container).appendChild(box);
      panelNode = box;
    }
    function mountDom() {
      var host = (container && container.parentNode) || container;
      if (!host || !host.appendChild) return;
      var bar = el('div', '', 'huilian-bar');
      toggleBtn = el('button', 'huilian-toggle'); toggleBtn.textContent = '暂停';
      seekEl = el('input', 'huilian-seek'); seekEl.setAttribute('type', 'range');
      seekEl.min = '0'; seekEl.max = '0'; seekEl.value = '0';
      var vol = el('input', 'huilian-vol'); vol.setAttribute('type', 'range');
      vol.min = '0'; vol.max = '100'; vol.value = '100';
      volEl = vol;
      var del = el('button', 'huilian-close-del'); del.textContent = '删任务+删文件';
      var keep = el('button', 'huilian-keep'); keep.textContent = '仅关闭';
      toggleBtn.addEventListener('click', onToggle);
      seekEl.addEventListener('change', onSeek);
      vol.addEventListener('change', onVolume);
      del.addEventListener('click', deleteTaskAndFiles);
      keep.addEventListener('click', function () { keepOnly(); });
      bar.appendChild(toggleBtn); bar.appendChild(seekEl); bar.appendChild(vol);
      bar.appendChild(del); bar.appendChild(keep);
      host.appendChild(bar);
      barNode = bar;
    }
    function removeDom() {
      removePanel();
      if (barNode && barNode.parentNode) barNode.parentNode.removeChild(barNode);
      barNode = null; panelNode = null; toggleBtn = null; seekEl = null; volEl = null;
    }

    function invoke(promise, fallback) {
      Promise.resolve(promise).catch(function (err) { if (!destroyed) report(err, fallback); });
    }

    // ---- 控件动作 ----
    function setPause(next) {
      if (!playerId) return;
      paused = next;
      if (toggleBtn) toggleBtn.textContent = next ? '继续' : '暂停';
      invoke(player.setProperty(playerId, 'pause', next), '暂停失败'); // 真实桥无 pause/resume
    }
    function onToggle() { setPause(!paused); }
    function onSeek() {
      var sec = Number(seekEl && seekEl.value);
      if (!playerId || !isNum(sec)) return;
      invoke(player.seek(playerId, sec), '跳转失败');
    }
    function onVolume(ev) {
      var src = (ev && ev.target) || volEl;
      var v = Number(src && src.value);
      if (!playerId || !isNum(v)) return;
      invoke(player.setProperty(playerId, 'volume', v), '音量设置失败');
    }
    // 仅关闭：杀画面保留任务（红线：不调 download.delete）
    function keepOnly() { api.destroy(); onClose(); }
    // 删任务+删文件：stopAndClean → download.delete(hash,true) 各一次，随后销毁 overlay
    function deleteTaskAndFiles() {
      if (cleaned) return; // 各一次：重复点击不再发起
      cleaned = true;
      Promise.resolve(playerId ? player.stopAndClean(playerId) : null)
        .catch(function (err) { if (!destroyed) report(err, '停止播放失败'); })
        .then(function () {
          if (!hash || !bridge.download || typeof bridge.download.delete !== 'function') {
            report(null, '缺少任务标识，无法删除任务');
            return;
          }
          return Promise.resolve(bridge.download.delete(hash, true)).then(function (res) {
            if (!res || !res.ok) report(res, '删除任务失败');
          });
        })
        .catch(function (err) { if (!destroyed) report(err, '删除任务失败'); })
        .then(function () { api.destroy(); onClose(); });
    }

    // ---- overlay 生命周期 ----
    function releaseOverlay() {
      gen += 1;                                  // 在途回调作废（含 createOverlay/setBounds/事件）
      for (var i = 0; i < subs.length; i++) { try { subs[i](); } catch (e) {} }
      subs = [];
      if (timer !== null) { global.clearInterval(timer); timer = null; }
      var id = playerId;
      playerId = null;
      lastRect = null;
      if (container && container.setAttribute) container.setAttribute('data-playing', '0');
      removeDom();
      if (!id || typeof player.destroyOverlay !== 'function') return null;
      // 红线核心：无论走到哪条离开路径，overlay 一律销毁；任务是否删除取决于用户选择
      return Promise.resolve(player.destroyOverlay(id)).then(function (res) {
        if (!destroyed && res && !res.ok) report(res, '销毁播放窗口失败');
      }).catch(function (err) { if (!destroyed) report(err, '销毁播放窗口失败'); });
    }

    function startOverlay() {
      var myGen = gen;
      var r = rect() || { x: DEFAULT_RECT.x, y: DEFAULT_RECT.y, width: DEFAULT_RECT.width, height: DEFAULT_RECT.height };
      ended = false; paused = false;
      return Promise.resolve(player.createOverlay({
        url: file.content_path || '', title: file.name || '',
        x: r.x, y: r.y, width: r.width, height: r.height,
      })).then(function (res) {
        if (destroyed || myGen !== gen || isStale()) {
          // 过期挂载代次 / 已拆除：只回收 overlay，绝不把控件条画进新页（Task3 mountGen 约定）
          var late = res && res.ok && res.data && res.data.playerId;
          if (late && typeof player.destroyOverlay === 'function') Promise.resolve(player.destroyOverlay(late)).catch(function () {});
          return;
        }
        if (!res || !res.ok) { report(res, '无法启动播放'); return; }
        playerId = res.data.playerId;
        mountDom();
        subscribeEvents();
        if (container && container.setAttribute) container.setAttribute('data-playing', '1');
        sync(true); // 创建时视口坐标≠屏幕坐标：立即强制校正一次 overlay bounds
        timer = global.setInterval(function () { sync(false); }, SYNC_INTERVAL_MS);
      }).catch(function (err) { if (!destroyed && myGen === gen) report(err, '无法启动播放'); });
    }

    // bounds 跟随：resize / 滚动（含容器内部滚动，capture 捕获）都走同一节流同步
    var win = global.window;
    function onWinLayout() { sync(false); }

    var api = {
      sync: sync,
      destroy: function () {
        if (destroyed) return;      // 幂等：重复 unmount 不得重复 destroyOverlay
        destroyed = true;
        if (win && win.removeEventListener) {
          win.removeEventListener('resize', onWinLayout);
          win.removeEventListener('scroll', onWinLayout, true);
        }
        releaseOverlay();
      },
    };

    if (!player || typeof player.createOverlay !== 'function') {
      report(null, '播放桥不可用');
      return api;
    }
    if (!file.content_path) {
      report(null, 'qbt 未返回文件绝对路径（content_path），暂无法播放');
      return api;
    }
    if (win && win.addEventListener) {
      win.addEventListener('resize', onWinLayout);
      win.addEventListener('scroll', onWinLayout, true);
    }
    startOverlay();
    return api;
  }

  SFV.huilianPlayerBar = { create: create };
})(typeof window !== 'undefined' ? window : this);
