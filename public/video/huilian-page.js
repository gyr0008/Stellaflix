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
  var nodes = null;       // { input, browse, list, error }
  var tasks = [];         // reduceTasks 输出的任务视图行
  var pending = null;     // 已提交但未认领 hash 的磁力 { magnet }
  var pollTimer = null;
  var pollInFlight = false; // 轮询防重入：上一请求未落地时跳过本次 tick
  var mountGen = 0;         // 挂载代次：mount 递增，在途响应代次不符则丢弃（防 unmount/重挂串扰）
  var expanded = null;      // 展开态跨轮询保持 { hash, files }；files 为缓存 payload，重绘复用

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

  // ---- 文件子行：展开任务行时按 download.files(hash) 渲染，展开态跨轮询重绘保持 ----
  function findRowNode(hash) {
    if (!nodes) return null;
    var kids = nodes.list.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].getAttribute && kids[i].getAttribute('data-hash') === hash) return kids[i];
    }
    return null;
  }

  function makeFilesBox(files) {
    var q = queue();
    var box = el('div', { cls: 'huilian-files' });
    for (var i = 0; i < files.length; i++) {
      var f = files[i] || {};
      var fileNode = el('div', { cls: 'huilian-file' });
      fileNode.setAttribute('data-index', String(i));
      fileNode.setAttribute('data-playable', (q && q.isPlayable(f)) ? '1' : '0');
      fileNode.textContent = (f.name || ('文件 ' + i)) + ' · ' + Math.round((f.progress || 0) * 100) + '%';
      box.appendChild(fileNode);
    }
    return box;
  }

  function openFiles(rowNode, files) {
    if (!rowNode || rowNode._filesBox || !files) return;
    var box = makeFilesBox(files);
    rowNode.appendChild(box);
    rowNode._filesBox = box;
  }

  // 落地 files payload：仅当该 hash 仍是当前展开目标（折叠/切换/卸载后丢弃）
  function applyFiles(hash, files) {
    if (!expanded || expanded.hash !== hash) return;
    expanded.files = files;
    openFiles(findRowNode(hash), files);
  }

  function toggleFiles(hash, rowNode) {
    if (rowNode._filesBox) {
      rowNode.removeChild(rowNode._filesBox);
      rowNode._filesBox = null;
      expanded = null;
      return;
    }
    if (expanded && expanded.hash === hash) { expanded = null; return; } // 展开请求在途时再次点击 → 取消展开
    var b = bridge();
    if (!b) return;
    expanded = { hash: hash, files: null };
    b.download.files(hash).then(function (res) {
      if (!res || !res.ok) { fail(res, '获取文件列表失败'); return; }
      applyFiles(hash, (res.data && res.data.files) || []);
    }).catch(function (err) { fail(err, '获取文件列表失败'); }); // IPC reject 统一喂提示条（红线）
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
    // 轮询重绘后恢复展开行：有缓存 payload 直接重开（不重新请求），在途则由落地回调处理
    if (expanded && expanded.files) {
      openFiles(findRowNode(expanded.hash), expanded.files);
    }
  }

  // ---- 2s 轮询：download.list → matchHash 认领 → reduceTasks 重绘 ----
  function pollOnce() {
    var b = bridge();
    if (!b || pollInFlight) return Promise.resolve(); // 防重入：上一请求未落地则跳过本轮
    var gen = mountGen;
    pollInFlight = true;
    return b.download.list().then(function (res) {
      if (gen !== mountGen) return; // 过期挂载代次：unmount/重挂后落地，丢弃防状态与画面串扰
      pollInFlight = false;         // 仅当代次相符才复位，避免过期响应误开新代的并发窗口
      if (!res || !res.ok) { fail(res, '获取任务列表失败'); return; }
      var q = queue();
      var torrents = (res.data && res.data.torrents) || [];
      if (pending && q && q.matchHash(torrents, pending.magnet)) pending = null;
      tasks = q ? q.reduceTasks(torrents) : [];
      render();
    }).catch(function () {
      if (gen === mountGen) pollInFlight = false; // 桥异常静默，下轮自动重试
    });
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
      target.value = ''; // 复位选择框：同一文件修改后可再次选中触发 change
      var text = String(reader.result || '');
      var comma = text.indexOf(',');
      var base64 = comma >= 0 ? text.slice(comma + 1) : text;
      var params = q.makeAddParams('', { base64: base64, name: file.name });
      if (!params) { showError('读取 .torrent 文件失败：内容为空或文件名缺失'); return; }
      submitParams(params);
    };
    reader.onerror = function () {
      target.value = '';
      showError('读取 .torrent 文件失败');
    };
    reader.readAsDataURL(file);
  }

  function mount(host) {
    if (SFV.ui && SFV.ui.setTitle) SFV.ui.setTitle('汇联');
    if (SFV.ui && SFV.ui.setBrowseChrome) SFV.ui.setBrowseChrome(true);
    // 重新进入汇联页：重置上一轮状态与轮询（生命周期红线）；代次递增使旧挂载的在途响应作废
    stopPolling();
    mountGen += 1;
    nodes = null; tasks = []; pending = null;
    pollInFlight = false; expanded = null;
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
    nodes = { input: input, browse: browse, list: list, error: error };
  }

  function unmount() {
    stopPolling();
    nodes = null; tasks = []; pending = null;
    pollInFlight = false; expanded = null;
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
