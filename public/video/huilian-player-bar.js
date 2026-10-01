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
  // 进度兜底轮询保持窗：time-pos/duration 的 property-change 仅在本机向 mpv 发出 observe_property
  // 订阅后才会推送；当前仓库 desktop/mpv-controller.js 从不发起该订阅（_eventBroadcast 只转发
  // mpv 免订阅事件，如 end-file；见其 _handleLine），故这对事件不会送达渲染层，getProperty 轮询
  // 是常驻兜底（有界成本：500ms tick；duration 取到即停）。若日后接入订阅，事件经本保持窗自动
  // 接管优先级、轮询让位，两源互不打架。
  var POLL_EVENT_HOLD_MS = 3000;
  // 容器未布局（0x0，例如 CSS 尚未就位）时的兜底创建尺寸 = 桌面端 createOverlay 默认值
  var DEFAULT_RECT = { x: 0, y: 0, width: 800, height: 450 };

  function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

  // I2：mpv 进程已退出/句柄已回收时 command 抛 'player not found: '+id，ipc-video 转 {ok:false,error}；
  // 该失败语义为「已停止」，删除流程应照常进行（区别于真实停止失败，后者仍须中止以不删磁盘文件）。
  function isPlayerGoneError(msg) { return String(msg || '').indexOf('player not found') >= 0; }

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
      ended = false, paused = false, lastRect = null, lastSentAt = -1e9,
      lastTimeEventAt = -1e9, lastDurEventAt = -1e9;

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

    // 进度兜底轮询（Important#2）：真机 mpv-controller 从不 subscribe，time-pos/duration 的
    // property-change 永不送达渲染层，进度条只能靠周期性 getProperty 取。挂在同一 500ms tick 上，
    // 事件若先到并在保持窗内则让位（applyTime/applyDuration 只由事件写），两源互不打架。
    function pollOne(name, apply) {
      if (typeof player.getProperty !== 'function') return;
      var myGen = gen;
      Promise.resolve(player.getProperty(playerId, name)).then(function (res) {
        // 后台轮询失败（属性暂不可用/已停止）静默：属可容忍抖动，不污染统一错误条
        if (destroyed || myGen !== gen || !res || res.ok !== true) return;
        apply(res.data);
      }).catch(function () {});
    }
    function pollProgress() {
      if (destroyed || !playerId) return;                 // 销毁/换带后定时器已清，绝不补发 IPC
      var now = global.Date.now();
      // 响应落地时复检保持窗：往返期间若有事件到达则丢弃轮询值（事件优先；不复检也只会在下一轮自愈）
      if (now - lastTimeEventAt >= POLL_EVENT_HOLD_MS) {
        pollOne('time-pos', function (v) {
          if (global.Date.now() - lastTimeEventAt < POLL_EVENT_HOLD_MS) return;
          applyTime(v);
        });
      }
      // duration 取到正上限后不再轮询（省 IPC）；拿到即停
      if (!(seekEl && Number(seekEl.max) > 0) && now - lastDurEventAt >= POLL_EVENT_HOLD_MS) {
        pollOne('duration', function (v) {
          if (global.Date.now() - lastDurEventAt < POLL_EVENT_HOLD_MS) return;
          applyDuration(v);
        });
      }
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
      if (name === 'time-pos') { lastTimeEventAt = global.Date.now(); applyTime(v); }
      else if (name === 'duration') { lastDurEventAt = global.Date.now(); applyDuration(v); }
    }
    function subscribeEvents() {
      subscribe('time-pos', function (p) { lastTimeEventAt = global.Date.now(); applyTime(eventValue(p)); });
      subscribe('duration', function (p) { lastDurEventAt = global.Date.now(); applyDuration(eventValue(p)); });
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
      var myGen = gen;
      Promise.resolve(promise).then(function (res) {
        if (destroyed || myGen !== gen) return;          // 拆除/换带中的竞态：静默
        // 真实 ipc-video 对失败控件调用以 {ok:false,error} resolve（非 reject）：错误统一喂 .huilian-error
        if (res && res.ok === false) report(res, fallback);
      }).catch(function (err) { if (!destroyed) report(err, fallback); });
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
    // 删任务+删文件：安全序 —— 先 stopAndClean，只有停止成功才允许进入破坏性 download.delete。
    // 停止失败（拒绝或 {ok:false}）→ 上浮错误、绝不删磁盘文件、撤销幂等标记以便重试（overlay 现场保留）。
    function deleteTaskAndFiles() {
      if (cleaned) return; // 各一次：重复点击不再发起
      cleaned = true;
      Promise.resolve(playerId ? player.stopAndClean(playerId) : null)
        .then(function (res) {
          // I2：进程已退出（player not found）视为已停止，继续删任务；真实停止失败仍抛错中止不删文件
          if (res && res.ok === false && !isPlayerGoneError(res.error)) throw res;
          var del = Promise.resolve();
          if (!hash || !bridge.download || typeof bridge.download.delete !== 'function') {
            report(null, '缺少任务标识，无法删除任务');
          } else {
            del = Promise.resolve(bridge.download.delete(hash, true))
              .then(function (dres) { if (!dres || !dres.ok) report(dres, '删除任务失败'); })
              .catch(function (err) { if (!destroyed) report(err, '删除任务失败'); });
          }
          // 停止成功后无论删除结果都收尾：销毁 overlay 并关闭播控条
          return del.then(function () { api.destroy(); onClose(); });
        })
        .catch(function (err) {
          cleaned = false;                                // 停止失败可重试
          if (!destroyed) report(err, '停止播放失败，已取消删除任务');
        });
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
        lastTimeEventAt = -1e9; lastDurEventAt = -1e9; // 新 overlay：清事件窗，立即启用轮询兜底
        mountDom();
        subscribeEvents();
        if (container && container.setAttribute) container.setAttribute('data-playing', '1');
        sync(true); // 创建时视口坐标≠屏幕坐标：立即强制校正一次 overlay bounds
        timer = global.setInterval(function () { sync(false); pollProgress(); }, SYNC_INTERVAL_MS);
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
