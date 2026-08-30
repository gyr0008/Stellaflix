/*
 * Stellaflare 影视态 — 汇联页 (page-discover.js)
 * ----------------------------------------------------------------------------
 * 汇联 = 影视态里「边下边播 + 边播边删」的入口页。
 *
 * 产品定位：无论影片在哪里（m3u8 / Emby / Alist / Aliyun / WebDAV / 磁力），
 * 统一接到汇联页 → 点一下 → 拉起独立的 mpv 播放窗口（独立 BrowserWindow，通过
 * --wid 嵌入 mpv 输出），边播边删由 mpv 的 demuxer-max-bytes + 播放结束自动清理。
 *
 * UI 结构：
 *   - 顶栏：协议切换 tab（Emby / Alist / Aliyun / WebDAV / BT 磁力）
 *   - 中栏：资源列表（协议 resolve 后渲染卡片网格）
 *   - 下栏：全屏 mpv 播放叠加层（独立 BrowserWindow 承托 mpv.exe）
 *
 * 协议桥接：通过 window.stellaflixVideo.protocol.* 调主进程 protocol-adapters
 * 播放器桥接：通过 window.stellaflixVideo.player.* 调主进程 mpv-controller
 * 下载桥接：通过 window.stellaflixVideo.download.* 调主进程 download-manager
 *
 * 边播边删：
 *   - mpv 启动参数已含 --demuxer-max-bytes=128MiB / --demuxer-readahead-secs=20
 *   - 播放结束 / 用户点「清空」→ player.stopAndClean → 主动 unlink 缓存文件
 *
 * 加载顺序：page-discover.js 由 index.html 挂载；依赖 stellaflixVideo 命名空间
 * （由 desktop/preload-video.js 暴露）。
 * 单文件 ≤ 500 行。
 */
(function (global) {
  'use strict';
  var SFV = (global.StellaflixVideo = global.StellaflixVideo || {});

  // ---- 模块级状态 ----
  var hostEl = null;
  var curProtocol = 'emby';
  var curList = [];
  var curPlayerId = null;

  // ---- 配置 ----
  var PROTOCOLS = [
    { id: 'emby', label: 'Emby / Jellyfin' },
    { id: 'alist', label: 'Alist' },
    { id: 'aliyun', label: '阿里云盘' },
    { id: 'webdav', label: 'WebDAV' },
    { id: 'direct', label: '直链 / m3u8' },
    { id: 'magnet', label: '磁力 / BT' },
  ];

  // =====================================================================
  //  页面主入口
  // =====================================================================
  function mount(host, ctx) {
    hostEl = host;
    host.innerHTML = '';
    var ui = SFV.ui;
    if (ui && typeof ui.setBrowseChrome === 'function') ui.setBrowseChrome(true);

    var wrap = ui ? ui.el('div', 'huilian-wrap') : c('div', 'huilian-wrap');

    // 1. 顶栏：协议切换 tab
    var tabBar = ui ? ui.el('div', 'huilian-tabbar') : c('div', 'huilian-tabbar');
    PROTOCOLS.forEach(function (p) {
      var tab = ui ? ui.el('div', 'huilian-tab' + (p.id === curProtocol ? ' active' : ''), p.label) : c('div', 'huilian-tab' + (p.id === curProtocol ? ' active' : ''), p.label);
      tab.dataset.id = p.id;
      tab.addEventListener('click', function () { switchProtocol(p.id); });
      tabBar.appendChild(tab);
    });
    wrap.appendChild(tabBar);

    // 2. 配置区（按协议动态渲染输入框）
    var configArea = ui ? ui.el('div', 'huilian-config-area') : c('div', 'huilian-config-area');
    configArea.id = 'huilian-config-area';
    wrap.appendChild(configArea);

    // 3. 资源列表
    var listArea = ui ? ui.el('div', 'huilian-list-area') : c('div', 'huilian-list-area');
    listArea.id = 'huilian-list-area';
    wrap.appendChild(listArea);

    // 4. 播放叠加层承载（独立 BrowserWindow 渲染到这里）
    var playerArea = ui ? ui.el('div', 'huilian-player-area') : c('div', 'huilian-player-area');
    playerArea.id = 'huilian-player-area';
    wrap.appendChild(playerArea);

    // 5. 状态栏
    var statusEl = ui ? ui.el('div', 'huilian-status', '就绪：选择协议 → 填写服务器地址 → 点「起播」') : c('div', 'huilian-status', '就绪：选择协议 → 填写服务器地址 → 点「起播」');
    statusEl.id = 'huilian-status';
    wrap.appendChild(statusEl);

    host.appendChild(wrap);

    renderConfigArea();
    refreshTabUI();

    // 全局订阅 mpv 事件
    if (global.stellaflixVideo && global.stellaflixVideo.player && global.stellaflixVideo.player.onAllEvents) {
      global.stellaflixVideo.player.onAllEvents('*', onPlayerEvent);
    }
  }

  // =====================================================================
  //  协议切换
  // =====================================================================
  function switchProtocol(pid) {
    curProtocol = pid;
    curList = [];
    refreshTabUI();
    renderConfigArea();
    renderList();
  }

  function refreshTabUI() {
    var tabs = hostEl.querySelectorAll('.huilian-tab');
    tabs.forEach(function (t) {
      if (t.dataset.id === curProtocol) t.classList.add('active');
      else t.classList.remove('active');
    });
  }

  // =====================================================================
  //  配置区（按协议渲染不同输入表单）
  // =====================================================================
  function renderConfigArea() {
    var area = hostEl.querySelector('#huilian-config-area');
    if (!area) return;
    area.innerHTML = '';
    var ui = SFV.ui;
    var row = ui ? ui.el('div', 'huilian-config-row') : c('div', 'huilian-config-row');

    if (curProtocol === 'emby') {
      row.appendChild(buildInput('emby-url', 'http://server:8096', 'Emby / Jellyfin 地址'));
      row.appendChild(buildInput('emby-user', '', '用户名'));
      row.appendChild(buildInput('emby-pass', '', '密码', 'password'));
    } else if (curProtocol === 'alist') {
      row.appendChild(buildInput('alist-url', 'http://alist.example.com', 'Alist 地址'));
      row.appendChild(buildInput('alist-token', '', 'Token（可选）', 'password'));
    } else if (curProtocol === 'aliyun') {
      row.appendChild(buildInput('aliyun-fileid', '', 'File ID'));
      row.appendChild(buildInput('aliyun-driveid', '', 'Drive ID（可选）'));
      row.appendChild(buildInput('aliyun-token', '', 'refresh_token', 'password'));
    } else if (curProtocol === 'webdav') {
      row.appendChild(buildInput('webdav-url', 'http://webdav.example.com/file.mp4', 'WebDAV URL'));
      row.appendChild(buildInput('webdav-user', '', '用户名（可选）'));
      row.appendChild(buildInput('webdav-pass', '', '密码（可选）', 'password'));
    } else if (curProtocol === 'direct') {
      row.appendChild(buildInput('direct-url', 'https://example.com/index.m3u8', '直链 / m3u8 URL'));
    } else if (curProtocol === 'magnet') {
      row.appendChild(buildInput('magnet-url', 'magnet:?xt=urn:btih:...', '磁力 URL'));
    }

    var playBtn = ui ? ui.el('button', 'huilian-btn huilian-btn-play', '▶ 起播') : c('button', 'huilian-btn huilian-btn-play', '▶ 起播');
    playBtn.addEventListener('click', onPlayClicked);
    row.appendChild(playBtn);

    var clearBtn = ui ? ui.el('button', 'huilian-btn huilian-btn-clear', '✕ 清空') : c('button', 'huilian-btn huilian-btn-clear', '✕ 清空');
    clearBtn.addEventListener('click', onClearClicked);
    row.appendChild(clearBtn);

    area.appendChild(row);
  }

  function buildInput(id, placeholder, label, type) {
    var ui = SFV.ui;
    var wrap = ui ? ui.el('div', 'huilian-input-wrap') : c('div', 'huilian-input-wrap');
    var lbl = ui ? ui.el('label', 'huilian-input-label', label) : c('label', 'huilian-input-label', label);
    lbl.setAttribute('for', id);
    var inp = document.createElement('input');
    inp.id = id;
    inp.type = type || 'text';
    inp.className = 'huilian-input';
    inp.placeholder = placeholder;
    wrap.appendChild(lbl);
    wrap.appendChild(inp);
    return wrap;
  }

  function getInput(id) {
    var el = hostEl.querySelector('#' + id);
    return el ? (el.value || '').trim() : '';
  }

  // =====================================================================
  //  起播 / 清空
  // =====================================================================
  async function onPlayClicked() {
    var sv = global.stellaflixVideo;
    if (!sv) { toast('视频模块未就绪'); return; }
    setStatus('解析中…');
    try {
      if (curProtocol === 'magnet') {
        // 磁力 → 走 qBittorrent 下载
        var magnetUrl = getInput('magnet-url');
        if (!magnetUrl) { toast('请填写磁力 URL'); return; }
        await sv.download.addTorrent({ url: magnetUrl, sequential: true });
        setStatus('已添加磁力任务到 qBittorrent，请在下载完成后点文件起播');
        return;
      }
      // 其他协议 → resolve → 拿直链 → 起播
      var manifest = await resolveCurrent();
      if (!manifest) { setStatus('解析失败'); return; }
      curList = [manifest];
      renderList();
      await playManifest(manifest);
    } catch (err) {
      toast('起播失败：' + (err && err.message ? err.message : String(err)));
      setStatus('起播失败');
    }
  }

  async function resolveCurrent() {
    var sv = global.stellaflixVideo;
    if (curProtocol === 'emby') {
      var url = getInput('emby-url');
      var creds = { username: getInput('emby-user'), password: getInput('emby-pass') };
      var r = await sv.protocol.resolveEmby(url, creds);
      return r.ok ? r.data : null;
    } else if (curProtocol === 'alist') {
      var alUrl = getInput('alist-url');
      var token = getInput('alist-token');
      var r = await sv.protocol.resolveAlist(alUrl, token);
      return r.ok ? r.data : null;
    } else if (curProtocol === 'aliyun') {
      var fileId = getInput('aliyun-fileid');
      var driveId = getInput('aliyun-driveid');
      var refreshToken = getInput('aliyun-token');
      var r = await sv.protocol.resolveAliyun(fileId, driveId, refreshToken);
      return r.ok ? r.data : null;
    } else if (curProtocol === 'webdav') {
      var wUrl = getInput('webdav-url');
      var creds = { username: getInput('webdav-user'), password: getInput('webdav-pass') };
      var r = await sv.protocol.resolveWebdav(wUrl, creds);
      return r.ok ? r.data : null;
    } else if (curProtocol === 'direct') {
      var dUrl = getInput('direct-url');
      if (!dUrl) return null;
      return {
        id: 'direct-' + dUrl,
        title: dUrl.split('/').pop() || 'direct',
        durationSec: 0,
        mimeType: 'video/mp4',
        kind: 'vod',
        source: 'direct',
        url: dUrl,
      };
    }
    return null;
  }

  async function playManifest(manifest) {
    var sv = global.stellaflixVideo;
    if (!sv || !sv.player || !sv.player.create) { toast('播放器未就绪'); return; }
    setStatus('创建播放器…');
    // 先销毁旧实例
    if (curPlayerId) { try { await sv.player.destroy(curPlayerId); } catch (e) {} }
    var r = await sv.player.create({
      url: manifest.url,
      title: manifest.title,
    });
    if (!r.ok) { toast('创建播放器失败：' + r.error); return; }
    curPlayerId = r.data.id;
    setStatus('播放器已创建：' + curPlayerId);
  }

  async function onClearClicked() {
    var sv = global.stellaflixVideo;
    if (curPlayerId && sv && sv.player) {
      try { await sv.player.stopAndClean(curPlayerId); } catch (e) {}
      try { await sv.player.destroy(curPlayerId); } catch (e) {}
      curPlayerId = null;
    }
    curList = [];
    renderList();
    setStatus('已清空');
  }

  // =====================================================================
  //  资源列表
  // =====================================================================
  function renderList() {
    var area = hostEl.querySelector('#huilian-list-area');
    if (!area) return;
    area.innerHTML = '';
    var ui = SFV.ui;
    if (!curList.length) {
      area.appendChild(ui ? ui.el('div', 'huilian-empty', '暂无资源，请先填写服务器地址后点「起播」') : c('div', 'huilian-empty', '暂无资源，请先填写服务器地址后点「起播」'));
      return;
    }
    var grid = ui ? ui.el('div', 'huilian-grid') : c('div', 'huilian-grid');
    curList.forEach(function (item) {
      var card = ui ? ui.el('div', 'huilian-card') : c('div', 'huilian-card');
      card.appendChild(ui ? ui.el('div', 'huilian-card-title', item.title || 'untitled') : c('div', 'huilian-card-title', item.title || 'untitled'));
      card.appendChild(ui ? ui.el('div', 'huilian-card-meta', (item.source || '') + (item.durationSec ? ' · ' + fmtTime(item.durationSec) : '')) : c('div', 'huilian-card-meta', (item.source || '') + (item.durationSec ? ' · ' + fmtTime(item.durationSec) : '')));
      card.addEventListener('click', function () { playManifest(item); });
      grid.appendChild(card);
    });
    area.appendChild(grid);
  }

  // =====================================================================
  //  播放器事件
  // =====================================================================
  function onPlayerEvent(payload) {
    if (!payload) return;
    if (payload.event === 'end-file') {
      setStatus('播放完毕，缓冲已清空');
      curPlayerId = null;
    } else if (payload.event === 'start-file') {
      setStatus('开始播放');
    }
  }

  // =====================================================================
  //  工具
  // =====================================================================
  function c(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (typeof text !== 'undefined') e.textContent = text;
    return e;
  }
  function fmtTime(sec) {
    sec = parseInt(sec, 10) || 0;
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h > 0 ? h + ':' : '') + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function setStatus(msg) {
    var el = hostEl.querySelector('#huilian-status');
    if (el) el.textContent = msg;
  }
  function toast(msg) {
    if (SFV.online && typeof SFV.online.toast === 'function') SFV.online.toast(msg);
    else if (global.console) console.log('[huilian]', msg);
  }

  function unmount() {
    var sv = global.stellaflixVideo;
    if (curPlayerId && sv && sv.player) {
      try { sv.player.destroy(curPlayerId); } catch (e) {}
    }
    hostEl = null;
  }

  function back() {
    unmount();
    return false;
  }

  // =====================================================================
  //  注册（替换占位页）
  // =====================================================================
  if (SFV.router && typeof SFV.router.register === 'function') {
    SFV.router.register({ id: 'discover', title: '汇联', mount: mount, unmount: unmount, back: back });
  } else {
    SFV.huilianPage = { mount: mount, unmount: unmount, back: back };
  }
})(typeof window !== 'undefined' ? window : this);
