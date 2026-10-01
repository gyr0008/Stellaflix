/*
 * Stellaflix 影视模块 — 汇联页（BT 磁力播放·最小闭环入口）
 * 依赖：window.stellaflixVideo（desktop/preload-video.js 桥）与 SFV.huilianQueue（纯状态机）；
 *       无桥时整体降级。IPC 返回形状统一 {ok:true,data} / {ok:false,error}。
 * 生命周期红线：unmount 必须清理轮询 interval（Task 7 接入后还需强制销毁 mpv overlay）。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  var POLL_INTERVAL_MS = 2000;
  // 状态键 → 中文文案；'stalled-meta' 为磁力加入后、hash 认领前的 pending 态，未知键原样兜底显示
  var STATE_LABELS = {
    'stalled-meta': '解析中',
    downloading: '下载中',
    stalledDL: '等待下载',
    uploading: '上传中',
    stalledUP: '等待上传',
    paused: '已暂停',
    queued: '排队中',
    checking: '校验中',
    moving: '移动中',
    error: '出错'
  };

  function bridge() {
    var b = global.stellaflixVideo;
    return (b && b.download && b.player) ? b : null;
  }

  function queue() { return SFV.huilianQueue || null; }

  function el(tag, opts) {
    var n = document.createElement(tag);
    if (opts && opts.id) n.setAttribute('id', opts.id);
    if (opts && opts.cls) n.setAttribute('class', opts.cls);
    return n;
  }

  // ---- 页面内部状态（mount 时重置） ----
  var nodes = null;    // { input, addBtn, browse, list, error }
  var tasks = [];      // reduceTasks 输出的任务视图行
  var pending = null;  // 已提交但未认领 hash 的磁力 { magnet }
  var pollTimer = null;

  function showError(message) {
    if (nodes && nodes.error) nodes.error.textContent = message || '';
  }

  function fail(res, fallback) {
    showError((res && res.error) || fallback);
  }

  function stateLabel(state) {
    return STATE_LABELS[state] || String(state || '');
  }

  function stopPolling() {
    if (pollTimer !== null && pollTimer !== undefined) clearInterval(pollTimer);
    pollTimer = null;
  }

  // ---- 文件子行：展开任务行时按 download.files(hash) 渲染 ----
  function toggleFiles(hash, rowNode) {
    if (rowNode._filesBox) {
      rowNode.removeChild(rowNode._filesBox);
      rowNode._filesBox = null;
      return;
    }
    var b = bridge();
    if (!b) return;
    b.download.files(hash).then(function (res) {
      if (!res || !res.ok) { fail(res, '获取文件列表失败'); return; }
      var q = queue();
      var files = (res.data && res.data.files) || [];
      var box = el('div', { cls: 'huilian-files' });
      for (var i = 0; i < files.length; i++) {
        var f = files[i] || {};
        var fileNode = el('div', { cls: 'huilian-file' });
        fileNode.setAttribute('data-index', String(i));
        fileNode.setAttribute('data-playable', (q && q.isPlayable(f)) ? '1' : '0');
        fileNode.textContent = (f.name || ('文件 ' + i)) + ' · ' + Math.round((f.progress || 0) * 100) + '%';
        box.appendChild(fileNode);
      }
      rowNode.appendChild(box);
      rowNode._filesBox = box;
    });
  }

  function makeTaskRow(row, hash) {
    var node = el('div', { cls: 'huilian-task' });
    if (hash) node.setAttribute('data-hash', hash);
    var line = (row.name || '未命名任务') + ' · ' + stateLabel(row.state) + ' · ' + (row.pct || 0) + '%';
    if (hash) line += ' · ↓' + (row.dlspeed || 0) + ' ↑' + (row.upspeed || 0);
    node.textContent = line;
    if (hash) node.addEventListener('click', function () { toggleFiles(hash, node); });
    return node;
  }

  function render() {
    if (!nodes) return;
    nodes.list.innerHTML = '';
    if (pending) {
      nodes.list.appendChild(makeTaskRow({ name: '新任务（等待元数据）', state: 'stalled-meta', pct: 0 }, ''));
    }
    for (var i = 0; i < tasks.length; i++) {
      nodes.list.appendChild(makeTaskRow(tasks[i], tasks[i] && tasks[i].hash));
    }
  }

  // ---- 2s 轮询：download.list → matchHash 认领 → reduceTasks 重绘 ----
  function pollOnce() {
    var b = bridge();
    if (!b) return Promise.resolve();
    return b.download.list().then(function (res) {
      if (!res || !res.ok) { fail(res, '获取任务列表失败'); return; }
      var q = queue();
      var torrents = (res.data && res.data.torrents) || [];
      if (pending && q && q.matchHash(torrents, pending.magnet)) pending = null;
      tasks = q ? q.reduceTasks(torrents) : [];
      render();
    }).catch(function () { /* 桥异常静默，下轮自动重试 */ });
  }

  function ensurePolling() {
    if (pollTimer === null || pollTimer === undefined) {
      pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
    }
  }

  // ---- 加入任务 ----
  function submitParams(params) {
    var b = bridge();
    if (!b || !params) return Promise.resolve();
    return b.download.addTorrent(params).then(function (res) {
      if (!res || !res.ok) { fail(res, '加入任务失败'); return; }
      showError('');
      // 磁力分支：add 无返回 hash，置 pending 等轮询认领；torrent 分支：交给 list 直接出现
      if (params.url) pending = { magnet: params.url };
      render();
      ensurePolling();
    }).catch(function (err) { fail(err, '加入任务失败'); });
  }

  function onAdd() {
    var q = queue();
    if (!q || !nodes) return;
    var params = q.makeAddParams(nodes.input.value || '', null);
    if (!params) { showError('输入无效：请粘贴 magnet: 链接或选择 .torrent 文件'); return; }
    submitParams(params);
  }

  // 浏览…：#huilian-browse（input type=file accept=.torrent）→ FileReader → base64
  function onBrowseChange(ev) {
    var q = queue();
    if (!q) return;
    var target = ev && ev.target;
    var file = target && target.files && target.files[0];
    if (!file) return;
    var Reader = global.FileReader;
    if (!Reader) { showError('当前环境不支持读取 .torrent 文件'); return; }
    var reader = new Reader();
    reader.onload = function () {
      var text = String(reader.result || '');
      var comma = text.indexOf(',');
      var base64 = comma >= 0 ? text.slice(comma + 1) : text;
      submitParams(q.makeAddParams('', { base64: base64, name: file.name }));
    };
    reader.readAsDataURL(file);
  }

  function mount(host) {
    if (SFV.ui && SFV.ui.setTitle) SFV.ui.setTitle('汇联');
    if (SFV.ui && SFV.ui.setBrowseChrome) SFV.ui.setBrowseChrome(true);
    // 重新进入汇联页：重置上一轮状态与轮询（生命周期红线）
    stopPolling();
    nodes = null; tasks = []; pending = null;
    host.innerHTML = '';
    var wrap = el('div', { cls: 'huilian-wrap' });
    var row = el('div', { cls: 'huilian-input-row' });
    var input = el('input', { id: 'huilian-input', cls: 'huilian-input' });
    input.setAttribute('placeholder', '粘贴磁力链接 magnet:...');
    var btn = el('button', { id: 'huilian-add', cls: 'huilian-btn' });
    btn.textContent = '加入下载';
    var browse = el('input', { id: 'huilian-browse', cls: 'huilian-browse' });
    browse.setAttribute('type', 'file');
    browse.setAttribute('accept', '.torrent');
    var browseBtn = el('button', { id: 'huilian-browse-btn', cls: 'huilian-btn' });
    browseBtn.textContent = '浏览…';
    browseBtn.addEventListener('click', function () { browse.click && browse.click(); });
    var error = el('div', { cls: 'huilian-error' });
    var list = el('div', { id: 'huilian-tasks', cls: 'huilian-tasks' });
    if (!bridge()) {
      input.disabled = true; btn.disabled = true; browse.disabled = true; browseBtn.disabled = true;
      var hint = el('div', { cls: 'huilian-desk-only' });
      hint.textContent = 'BT 播放需在 Stellaflix 桌面版中使用';
      wrap.appendChild(hint);
    } else {
      btn.addEventListener('click', onAdd);
      browse.addEventListener('change', onBrowseChange);
    }
    row.appendChild(input); row.appendChild(btn); row.appendChild(browse); row.appendChild(browseBtn);
    wrap.appendChild(row); wrap.appendChild(error); wrap.appendChild(list);
    host.appendChild(wrap);
    nodes = { input: input, addBtn: btn, browse: browse, list: list, error: error };
  }

  function unmount() {
    stopPolling();
    nodes = null; tasks = []; pending = null;
    // Task 7 在此接入 overlay 销毁（离开汇联页前必须执行）
  }

  var page = {
    mount: mount,
    unmount: unmount,
    back: function () { page.unmount(); return false; },
  };
  if (SFV.router && SFV.router.register) SFV.router.register({ id: 'discover', title: '汇联', mount: mount, unmount: unmount, back: page.back });
  else SFV.huilianPage = page;
})(typeof window !== 'undefined' ? window : this);
