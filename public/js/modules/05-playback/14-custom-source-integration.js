// ====================================================================
//  Stellaflix 2.1.0 — 第三方音源 / 青听音乐 前端集成
//  - 对接 window.desktopWindow.customSource（Electron preload 桥）
//  - 浏览器纯 web 场景提供兼容桩，不会报错
//  - 三模式切换：official-first / custom-first / aggregate（聚合解析：元数据跨平台匹配 + 音质降序热切换）
//  - 14 项 IPC 操作 + 事件/日志/状态变更订阅
// ====================================================================

(function () {
  var STORE_KEY = 'stellaflix-custom-source-v1';
  var CUSTOM_PROVIDER_KEY = 'lx-custom-source';

  function hasBridge() {
    return !!(window.desktopWindow && window.desktopWindow.customSource && window.desktopWindow.customSource.isSupported);
  }
  function getBridge() {
    return hasBridge() ? window.desktopWindow.customSource : null;
  }
  function safeStorage() {
    try { return window.localStorage; } catch (_) { return null; }
  }
  function loadPrefs() {
    try {
      var s = safeStorage();
      if (!s) return defaultPrefs();
      var raw = s.getItem(STORE_KEY);
      var obj = raw ? JSON.parse(raw) : null;
      var merged = Object.assign(defaultPrefs(), obj || {});
      // 旧版兼容迁移：custom-only 模式已删除，统一回退到 aggregate（保留的跨平台匹配模式）
      if (merged.mode === 'custom-only') merged.mode = 'aggregate';
      return merged;
    } catch (_) {
      return defaultPrefs();
    }
  }
  function savePrefs(prefs) {
    try {
      var s = safeStorage();
      if (s) s.setItem(STORE_KEY, JSON.stringify(prefs || {}));
    } catch (_) {}
  }
  function defaultPrefs() {
    return {
      mode: 'official-first',       // official-first | custom-first | aggregate
      enabled: true,                // 全局第三方音源总开关
      preferCustomOnOfficialFail: true,
    };
  }

  var prefs = loadPrefs();
  var uiState = {
    activeTab: 'overview',
    installed: [],
    bundled: [],
    log: [],
    installedCount: 0,
    enabledCount: 0,
  };

  function pushLog(level, message, data) {
    var line = {
      at: new Date().toISOString(),
      level: /^(info|warn|error|debug)$/.test(String(level || '')) ? String(level) : 'info',
      message: String(message || ''),
      data: (typeof data === 'undefined') ? null : data,
    };
    uiState.log.unshift(line);
    if (uiState.log.length > 300) uiState.log.length = 300;
    try { renderLog(); } catch (_) {}
  }

  function el(id) { return document.getElementById(id); }

  function setButtonActive(parentSelector, attrName, attrValue) {
    var nodes = document.querySelectorAll(parentSelector + ' [' + attrName + ']');
    nodes.forEach(function (n) { n.setAttribute('data-active', n.getAttribute(attrName) === attrValue ? '1' : '0'); });
  }

  function applyOverviewUi() {
    setButtonActive('#custom-source-mode-switch', 'data-mode', prefs.mode);
    var hint = el('custom-source-overview-hint');
    if (!hint) return;
    var modeText = prefs.mode === 'official-first' ? '官方优先：先尝试五平台原生接口，失败后再尝试第三方音源（默认，安全稳妥）。'
      : prefs.mode === 'custom-first' ? '自定义优先：先尝试已启用的第三方音源，失败后再回退到五平台官方解析。'
      : prefs.mode === 'aggregate' ? '聚合解析：打破平台绑定——全部在线歌曲按歌名/歌手/专辑元数据跨平台匹配真实版本，再从最高音质开始逐级热切换解析；官方接口仅作兜底。'
      : '（未知取源模式，请重新选择取源模式。）';
    var bridge = getBridge();
    var statusText = bridge
      ? ('<b>当前状态</b>：桌面桥接可用 · 已安装 ' + uiState.installedCount + ' 个音源 · 已启用 ' + uiState.enabledCount + ' 个。')
      : '<b>当前状态</b>：Web 预览环境，desktopWindow.customSource 未启用（该模式下解析接口不会工作）。';
    hint.innerHTML = statusText + '<br><br>' + modeText;
    refreshBackend();
  }

  function refreshBackend() {
    var bridge = getBridge();
    var input = el('custom-source-backend-url');
    if (!bridge || !input) return;
    Promise.resolve(bridge.getBackend()).then(function (r) {
      if (r && typeof r.backendUrl === 'string') input.value = r.backendUrl;
    }).catch(function () {});
  }

  function setBackendUrl(inputValue) {
    var bridge = getBridge();
    if (!bridge || typeof bridge.setBackend !== 'function') {
      pushLog('warn', '解析后端地址保存失败：桌面桥接不可用');
      return Promise.resolve({ ok: false });
    }
    var value = String(inputValue == null ? '' : inputValue).trim();
    if (value && !/^https?:\/\//i.test(value)) {
      pushLog('warn', '解析后端地址格式无效，需以 http(s):// 开头');
      return Promise.resolve({ ok: false, error: 'INVALID_URL' });
    }
    return Promise.resolve(bridge.setBackend({ backendUrl: value })).then(function (r) {
      pushLog('info', value ? '已保存解析后端地址，激活中的音源已重新加载配置。' : '已清空解析后端地址（使用内置默认）。');
      return r || { ok: true };
    }).catch(function (e) {
      pushLog('warn', '保存解析后端地址失败：' + (e && e.message || String(e)));
      return { ok: false, error: String(e) };
    });
  }

  function updateEntryBadge() {
    var btn = el('custom-source-btn') || el('custom-source-entry-btn');
    if (!btn) return;
    var bridge = getBridge();
    var active = !!(bridge && uiState.enabledCount > 0);
    if (btn.classList) {
      btn.classList.toggle('active', active);
    }
    if (btn.hasAttribute && btn.hasAttribute('data-active')) {
      btn.setAttribute('data-active', active ? '1' : '0');
    }
    btn.title = (bridge ? '' : '[Web 预览：桥接未可用] ') + '第三方音源 · ' +
      (prefs.mode === 'official-first' ? '官方优先' : prefs.mode === 'custom-first' ? '自定义优先' : prefs.mode === 'aggregate' ? '聚合解析' : '未知') +
      ' · 已安装 ' + uiState.installedCount + '，已启用 ' + uiState.enabledCount;
  }

  if (typeof window.openCustomSourceModal !== 'function') {
    window.openCustomSourceModal = function () {
      if (window.CustomSourceIntegration && typeof window.CustomSourceIntegration.openModal === 'function') {
        window.CustomSourceIntegration.openModal();
      }
    };
  }

  function renderInstalled() {
    var box = el('custom-source-installed-list');
    if (!box) return;
    var items = Array.isArray(uiState.installed) ? uiState.installed : [];
    if (!items.length) {
box.innerHTML = '<div class="custom-source-hint">还没有安装第三方音源，可以到"内置音源"标签安装青听音乐，或从"导入 / 新增"通过 URL 或粘贴源码安装。</div>';
      return;
    }
    box.innerHTML = items.map(function (pkg) {
      var pkgId = String(pkg.pkgId || pkg.id || '');
      var name = String(pkg.name || pkg.packageName || pkgId || '未命名');
      var author = String(pkg.author || pkg.packageAuthor || '未知作者');
      var version = String(pkg.version || pkg.packageVersion || '');
      var desc = String(pkg.description || pkg.packageDescription || '').replace(/</g, '&lt;');
      var enabled = pkg.enabled === true;
      var bundled = pkg.bundled === true || pkg.origin === 'bundled';
      var actions = '';
      if (bundled && !pkg.installed) actions += '<button class="btn-secondary" type="button" onclick="window.CustomSourceIntegration.installBundled(\'' + escAttr(pkgId) + '\')">安装</button> ';
      actions += enabled
        ? '<button class="btn-secondary" type="button" onclick="window.CustomSourceIntegration.disable(\'' + escAttr(pkgId) + '\')">停用</button>'
        : '<button class="btn-primary" type="button" onclick="window.CustomSourceIntegration.enable(\'' + escAttr(pkgId) + '\')">启用</button>';
      if (!bundled) actions += ' <button class="btn-ghost" type="button" onclick="window.CustomSourceIntegration.remove(\'' + escAttr(pkgId) + '\')">移除</button>';
      return '<div class="custom-source-item">'
        + '<div class="meta">'
        + '<h4>' + escHtml(name) + (version ? ' · v' + escHtml(version) : '') + '</h4>'
        + '<div class="sub">' + escHtml(author) + (bundled ? ' · 内置音源' : '') + '</div>'
        + (desc ? '<div class="sub" style="margin-top:4px;">' + desc + '</div>' : '')
        + '</div>'
        + '<div class="actions">'
        + (bundled ? '<span class="pill bundled">内置</span> ' : '')
        + (enabled ? '<span class="pill enabled">启用中</span>' : '<span class="pill disabled">停用</span>')
        + actions
        + '</div>'
        + '</div>';
    }).join('');
  }

  function renderBundled() {
    var box = el('custom-source-bundled-list');
    if (!box) return;
    var items = Array.isArray(uiState.bundled) ? uiState.bundled : [];
    if (!items.length) {
      box.innerHTML = '<div class="custom-source-hint">当前没有可用的内置音源列表。</div>';
      return;
    }
    box.innerHTML = items.map(function (pkg) {
      var pkgId = String(pkg.pkgId || pkg.id || '');
      var name = String(pkg.name || pkg.packageName || pkgId || '未命名');
      var author = String(pkg.author || pkg.packageAuthor || '内置');
      var version = String(pkg.version || pkg.packageVersion || '');
      var desc = String(pkg.description || pkg.packageDescription || '').replace(/</g, '&lt;');
      var installed = pkg.installed === true;
      var enabled = pkg.enabled === true;
      var actions = '';
      actions += installed
        ? '<button class="btn-secondary" type="button" onclick="window.CustomSourceIntegration.installBundled(\'' + escAttr(pkgId) + '\')">重新安装 / 更新</button>'
        : '<button class="btn-primary" type="button" onclick="window.CustomSourceIntegration.installBundled(\'' + escAttr(pkgId) + '\')">一键安装</button>';
      if (installed) actions += enabled
        ? ' <button class="btn-secondary" type="button" onclick="window.CustomSourceIntegration.disable(\'' + escAttr(pkgId) + '\')">停用</button>'
        : ' <button class="btn-primary" type="button" onclick="window.CustomSourceIntegration.enable(\'' + escAttr(pkgId) + '\')">启用</button>';
      return '<div class="custom-source-item">'
        + '<div class="meta">'
        + '<h4>' + escHtml(name) + (version ? ' · v' + escHtml(version) : '') + '</h4>'
        + '<div class="sub">' + escHtml(author) + ' · 内置音源</div>'
        + (desc ? '<div class="sub" style="margin-top:4px;">' + desc + '</div>' : '')
        + '</div>'
        + '<div class="actions">'
        + '<span class="pill bundled">内置</span>'
        + (installed ? (enabled ? '<span class="pill enabled">启用中</span>' : '<span class="pill disabled">已安装</span>') : '')
        + actions
        + '</div>'
        + '</div>';
    }).join('');
  }

  function renderLog() {
    var box = el('custom-source-log-window');
    if (!box) return;
    var lines = uiState.log.slice(0, 120);
    box.innerHTML = lines.map(function (line) {
      var head = '[' + line.at.slice(11, 19) + '] [' + line.level.toUpperCase() + ']';
      var body = line.message + (line.data == null ? '' : (' ' + JSON.stringify(line.data)));
      return '<div class="line ' + escAttr(line.level) + '">' + escHtml(head + ' ' + body) + '</div>';
    }).join('') || '<div class="line info">（暂无日志）</div>';
  }

  function escHtml(s) {
    s = String(s == null ? '' : s);
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escAttr(s) { return String(s || '').replace(/'/g, '\\\'').replace(/\\/g, '\\\\'); }

  async function refreshInstalled() {
    var bridge = getBridge();
    if (!bridge) { uiState.installed = []; installedReconcileCount(); renderInstalled(); applyOverviewUi(); updateEntryBadge(); return; }
    try {
      var installed = await bridge.listInstalled();
      uiState.installed = Array.isArray(installed) ? installed : [];
      installedReconcileCount();
    } catch (e) {
      pushLog('error', 'listInstalled failed: ' + (e.message || String(e)));
    }
    renderInstalled();
    applyOverviewUi();
    updateEntryBadge();
  }

  async function refreshBundled() {
    var bridge = getBridge();
    if (!bridge) { uiState.bundled = []; renderBundled(); return; }
    try {
      var bundled = await bridge.listAvailableBundled();
      uiState.bundled = Array.isArray(bundled) ? bundled : [];
    } catch (e) {
      pushLog('error', 'listAvailableBundled failed: ' + (e.message || String(e)));
    }
    renderBundled();
  }

  function installedReconcileCount() {
    var items = Array.isArray(uiState.installed) ? uiState.installed : [];
    uiState.installedCount = items.length;
    uiState.enabledCount = items.filter(function (it) { return it.enabled === true; }).length;
  }

  async function openScriptDirectory() {
    var bridge = getBridge();
    if (!bridge) { pushLog('warn', 'openScriptDirectory：当前不是桌面环境'); return; }
    try {
      var ret = await bridge.openScriptDirectory();
      pushLog('info', '打开脚本目录: ' + (ret && ret.dir ? ret.dir : JSON.stringify(ret)));
    } catch (e) {
      pushLog('error', '打开脚本目录失败: ' + (e.message || String(e)));
    }
  }

  async function enable(pkgId) {
    var bridge = getBridge();
    if (!bridge) return;
    try {
      var r = await bridge.enable(pkgId);
      pushLog('info', 'enable ' + pkgId, r || null);
    } catch (e) { pushLog('error', 'enable failed: ' + (e.message || String(e))); }
    await Promise.all([refreshInstalled(), refreshBundled()]);
  }
  async function disable(pkgId) {
    var bridge = getBridge();
    if (!bridge) return;
    try {
      var r = await bridge.disable(pkgId);
      pushLog('info', 'disable ' + pkgId, r || null);
    } catch (e) { pushLog('error', 'disable failed: ' + (e.message || String(e))); }
    await Promise.all([refreshInstalled(), refreshBundled()]);
  }
  async function remove(pkgId) {
    var bridge = getBridge();
    if (!bridge) return;
    if (!confirm('确认要移除音源 ' + pkgId + ' 吗？')) return;
    try {
      var r = await bridge.remove(pkgId);
      pushLog('info', 'remove ' + pkgId, r || null);
    } catch (e) { pushLog('error', 'remove failed: ' + (e.message || String(e))); }
    await Promise.all([refreshInstalled(), refreshBundled()]);
  }
  async function installBundled(pkgId) {
    var bridge = getBridge();
    if (!bridge) return;
    try {
      var r = await bridge.installBundled(pkgId);
      pushLog('info', 'installBundled ' + pkgId, r || null);
      if (r && r.ok && r.enabled !== true) {
        try { await bridge.enable(pkgId); } catch (_) {}
      }
    } catch (e) { pushLog('error', 'installBundled failed: ' + (e.message || String(e))); }
    await Promise.all([refreshInstalled(), refreshBundled()]);
  }

  async function importByUrl() {
    var bridge = getBridge();
    var input = el('custom-source-import-url');
    var status = el('custom-source-import-status');
    var url = input ? String(input.value || '').trim() : '';
    if (!url) { if (status) status.textContent = '请输入 URL'; return; }
    if (!bridge) { if (status) status.textContent = '[Web 预览] 未启用桌面桥接'; return; }
    if (status) status.textContent = '导入中…';
    try {
      var r = await bridge.importScriptFromUrl(url);
      pushLog('info', 'importScriptFromUrl', r || null);
      if (r && r.ok) { if (status) status.textContent = '导入成功'; }
      else if (r && r.error) { if (status) status.textContent = '失败: ' + r.error; }
      else { if (status) status.textContent = '已完成'; }
    } catch (e) {
      pushLog('error', 'importScriptFromUrl failed: ' + (e.message || String(e)));
      if (status) status.textContent = '异常: ' + (e.message || String(e));
    }
    await Promise.all([refreshInstalled(), refreshBundled()]);
  }

  async function previewScript() {
    var bridge = getBridge();
    var textArea = el('custom-source-import-text');
    var status = el('custom-source-import-status');
    var text = textArea ? String(textArea.value || '') : '';
    if (!text) { if (status) status.textContent = '请先粘贴脚本'; return; }
    if (!bridge) { if (status) status.textContent = '[Web 预览] 未启用桌面桥接'; return; }
    if (status) status.textContent = '预览中…';
    try {
      var r = await bridge.parsePreviewFromText(text);
      pushLog('info', 'parsePreviewFromText', r || null);
      if (r && r.ok) {
        var pkg = r.packageMeta || {};
        if (status) status.textContent = '预览通过：' + (pkg.name || '未命名') + (pkg.version ? ' v' + pkg.version : '') + ' · 作者: ' + (pkg.author || '未知');
      } else if (r && r.error) {
        if (status) status.textContent = '脚本错误: ' + r.error;
      } else {
        if (status) status.textContent = '预览完成';
      }
    } catch (e) {
      pushLog('error', 'parsePreviewFromText failed: ' + (e.message || String(e)));
      if (status) status.textContent = '异常: ' + (e.message || String(e));
    }
  }

  async function importByText() {
    var bridge = getBridge();
    var textArea = el('custom-source-import-text');
    var status = el('custom-source-import-status');
    var text = textArea ? String(textArea.value || '') : '';
    if (!text) { if (status) status.textContent = '请先粘贴脚本'; return; }
    if (!bridge) { if (status) status.textContent = '[Web 预览] 未启用桌面桥接'; return; }
    if (status) status.textContent = '安装中…';
    try {
      var r = await bridge.importScriptFromText(text);
      pushLog('info', 'importScriptFromText', r || null);
      if (r && r.ok) {
        if (status) status.textContent = '安装成功: ' + (r.pkgId || '');
        if (r.enabled !== true && r.pkgId) { try { await bridge.enable(r.pkgId); } catch (_) {} }
      } else if (r && r.error) {
        if (status) status.textContent = '失败: ' + r.error;
      } else {
        if (status) status.textContent = '已完成';
      }
    } catch (e) {
      pushLog('error', 'importScriptFromText failed: ' + (e.message || String(e)));
      if (status) status.textContent = '异常: ' + (e.message || String(e));
    }
    await Promise.all([refreshInstalled(), refreshBundled()]);
  }

  function setMode(mode) {
    if (!/^(official-first|custom-first|aggregate)$/.test(String(mode || ''))) return;
    prefs.mode = String(mode);
    savePrefs(prefs);
    applyOverviewUi();
    updateEntryBadge();
    pushLog('info', 'setMode -> ' + prefs.mode);
  }

  function switchTab(tabName) {
    if (!/^(overview|installed|bundled|import|log)$/.test(String(tabName || ''))) return;
    uiState.activeTab = tabName;
    setButtonActive('.custom-source-modal .tabs', 'data-tab', tabName);
    setButtonActive('.custom-source-modal .body', 'data-panel', tabName);
    if (tabName === 'installed') refreshInstalled();
    if (tabName === 'bundled') refreshBundled();
    if (tabName === 'log') renderLog();
  }

  function openModal() {
    var overlay = el('custom-source-modal-overlay');
    if (!overlay) return;
    overlay.setAttribute('data-open', '1');
    overlay.setAttribute('aria-hidden', 'false');
    switchTab(uiState.activeTab || 'overview');
    applyOverviewUi();
    Promise.all([refreshInstalled(), refreshBundled()]).catch(function () {});
    // 点击遮罩空白处关闭（一次性绑定，幂等）
    bindOverlayOutsideClickOnce();
    // Esc 键关闭（与 closeModal 里的 removeEventListener 配对）
    document.addEventListener('keydown', onKeydownCloseEsc);
  }
  function closeModal() {
    var overlay = el('custom-source-modal-overlay');
    if (!overlay) return;
    overlay.setAttribute('data-open', '0');
    overlay.setAttribute('aria-hidden', 'true');
    document.removeEventListener('keydown', onKeydownCloseEsc);
  }

  // Esc 键关闭面板（与 openModal 的 add 配对，关闭后立即 removeEventListener，
  // 保证面板关闭后不留残留监听；同时仅在面板打开期间生效）
  function onKeydownCloseEsc(e) {
    if (e && (e.key === 'Escape' || e.keyCode === 27)) closeModal();
  }

  // 点击遮罩（.custom-source-modal-overlay）空白处关闭：
  // overlay 是全屏 fixed 遮罩（CSS: position:fixed; inset:0; display:flex 仅在 data-open='1'），
  // 仅当点击目标就是 overlay 本身（即点到遮罩、未点到 .custom-source-modal）时触发关闭。
  // 一次性绑定，靠 __csiOutsideClickBound 标记幂等，避免 openModal 多次调用叠加监听。
  function bindOverlayOutsideClickOnce() {
    var overlay = el('custom-source-modal-overlay');
    if (!overlay || overlay.__csiOutsideClickBound) return;
    overlay.__csiOutsideClickBound = true;
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) {
        // 阻断事件冒泡到 document/body：防止任何文档级代理监听器把这次「点遮罩」点击
        // 当作「点击弹窗外内容」并响应弹窗背后的元素（避免点击跨过弹窗、穿透到背后内容）。
        e.stopPropagation();
        closeModal();
      }
    });
  }

  function clearLog() {
    uiState.log = [];
    renderLog();
  }

  function appendSourceSwitcherEntries() {
    if (!prefs.enabled) return [];
    var bridge = getBridge();
    var installed = Array.isArray(uiState.installed) ? uiState.installed : [];
    var enabledPackages = installed.filter(function (it) { return it.enabled === true; });
    if (!enabledPackages.length) {
      // Fallback：至少有一个“第三方音源”条目可以一键切到模态
      return [{ key: 'lx-custom-source', label: 'CS', title: '第三方音源（点击前往管理）', action: 'open-manager' }];
    }
    return enabledPackages.map(function (pkg) {
      var name = String(pkg.name || pkg.packageName || pkg.pkgId || '第三方音源');
      return {
        key: 'lx-custom-source',
        label: (String(pkg.shortLabel || '').slice(0, 4) || 'CS'),
        title: name,
        pkgId: String(pkg.pkgId || pkg.id || ''),
      };
    });
  }

  // ==================== 三模式解析：resolveOnlinePlaybackData ====================
  function songToLxMusicInfo(song, requestedQuality) {
    if (!song) song = {};
    var name = String(song.name || song.title || '');
    var artistArr = [];
    if (Array.isArray(song.artists)) song.artists.forEach(function (a) { if (a && a.name) artistArr.push(String(a.name)); });
    if (!artistArr.length && song.artist) {
      (String(song.artist).split(/[、,，/\\&]/) || []).forEach(function (s) { var v = String(s || '').trim(); if (v) artistArr.push(v); });
    }
    var albumName = String((song.album && (song.album.name || song.album.title)) || song.albumName || '');
    var interval = Number(song.duration || song.interval || song.length || 0) || 0;
    if (interval > 10 * 60 * 60 * 1000) interval = Math.floor(interval / 1000);
    else if (interval > 60 * 60) interval = Math.floor(interval);
    // 平台 ID（provider / hash / songmid / strMediaMid / mid / rid 等）必须留在顶层。
    // 主进程 toLxMusicInfo() 直接读顶层字段提取 rid，若只塞进 _raw 会导致 rid 取空、
    // 音源脚本抛 "rid should not be empty"，第三方音源模式（如 custom-first）必然「找不到音源」。
    // 做法：先平铺原生字段，再用 LX 规范字段覆盖同名项。
    var lx = {};
    for (var key in song) {
      if (Object.prototype.hasOwnProperty.call(song, key)) lx[key] = song[key];
    }
    // LX MusicInfo 规范
    lx.name = name;
    lx.singer = artistArr.join('、') || '未知歌手';
    lx.album = albumName;
    lx.interval = interval || 0;
    lx._raw = song;
    lx.quality = normalizePlaybackQuality(requestedQuality || 'hires');
    return lx;
  }

  function isOfficialResultUsable(officialResult, mode) {
    // custom-first：官方结果一律不算"可用"，保证第三方音源永远作为主候选
    if (mode === 'custom-first') return false;
    if (!officialResult || typeof officialResult !== 'object') return false;
    if (!officialResult.url) return false;
    if (officialResult.trial) return false;
    if (officialResult.vipRequired || officialResult.onlyVipPlayable) return false;
    return true;
  }

  function aggregateSourceLabel(source) {
    if (source === 'wy') return '网易云线路';
    if (source === 'tx') return 'QQ 线路';
    if (source === 'kg') return '酷狗线路';
    if (source === 'kw') return '酷我线路';
    if (source === 'mg') return '咪咕线路';
    return '第三方音源';
  }

  // 聚合解析：把歌曲当纯元数据，交给 server 跨平台搜索匹配（wy/tx/kg 真实版本），
  // 再由主进程按音质降序逐候选热切换解析。仅在预解析阶段调用，避免与官方兜底重复请求。
  async function resolveAggregateViaHttp(song, context) {
    var requestedQuality = context.requestedQuality || 'hires';
    var payload = {
      song: songToLxMusicInfo(song, requestedQuality),
      quality: normalizePlaybackQuality(requestedQuality),
    };
    var res;
    try {
      res = await apiJson('/api/custom-source/resolve-aggregate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeoutMs: 24000,
      });
    } catch (e) {
      pushLog('error', 'aggregate resolve failed: ' + (e.message || String(e)));
      return { override: false, reason: 'exception' };
    }
    if (!res || typeof res !== 'object' || !res.url) {
      var failReason = res && (res.reason || res.error) || 'unknown';
      pushLog('info', 'aggregate 未命中: ' + failReason);
      return { override: false, reason: (res && res.reason) || 'no-url' };
    }
    var resolvedLevel = String(res.level || requestedQuality || '');
    var sourceLabel = '聚合解析 · ' + aggregateSourceLabel(res.source);
    pushLog('info', 'aggregate 命中: ' + sourceLabel + (resolvedLevel ? ' @ ' + resolvedLevel : ''), { urlPrefix: String(res.url).slice(0, 80) });
    return {
      override: true,
      resolvedPlaybackProvider: CUSTOM_PROVIDER_KEY,
      sourceLabel: sourceLabel,
      resolvedSourceLabel: sourceLabel,
      via: 'aggregate',
      data: {
        url: String(res.url),
        level: resolvedLevel || requestedQuality || 'standard',
        provider: CUSTOM_PROVIDER_KEY,
        source: sourceLabel,
        sourceMatch: true,
        trial: false,
      },
    };
  }

  async function resolveOnlinePlaybackData(song, context) {
    context = context || {};
    if (!prefs.enabled) {
      return { override: false, reason: 'disabled' };
    }
    // 允许调用方通过 context.mode 临时覆盖全局模式（如 AI 助手强制 aggregate 使用青听等第三方源）
    var mode = context.mode || prefs.mode || 'official-first';
    var officialResult = context.officialResult || {};
    var bridge = getBridge();
    var customEnabled = prefs.enabled && !!bridge;
    var officialUsable = isOfficialResultUsable(officialResult, mode);

    // 聚合解析：打破平台绑定，全部在线歌曲先按元数据匹配真实平台版本 + 音质降序热切换；
    // 官方接口仅作兜底（预解析未命中后官方结果可用则直接使用，不重复跑聚合）。
    if (mode === 'aggregate') {
      if (!customEnabled) return { override: false, reason: 'bridge-missing' };
      // 已有可用解析结果（含 AI 助手委托传入的 ticket URL）时直接复用，
      // 不得再跑 24s 聚合 HTTP 解析，否则切歌会被重复解析卡住。
      if (officialResult && officialResult.url && !officialResult.trial) return { override: false, reason: 'fallback-to-official' };
      if (context.preResolve === true) return resolveAggregateViaHttp(song, context);
      return { override: false, reason: 'aggregate-already-tried' };
    }
    // 自定义优先：先尝试第三方，失败且官方可用则再用官方
    if (mode === 'custom-first') {
      if (!customEnabled) {
        return { override: false, reason: 'bridge-missing' };
      }
      var first = await resolveViaBridge(song, context, 'custom-first');
      if (first && first.override === true) return first;
      if (officialUsable) return { override: false, reason: 'fallback-to-official' };
      // 官方不可用也无第三方，让系统走兜底
      return { override: false, reason: 'custom-first-noop' };
    }
    // official-first（默认）：官方不可用才走第三方
    if (mode === 'official-first') {
      if (officialUsable) return { override: false, reason: 'official-ok' };
      if (!customEnabled) return { override: false, reason: 'bridge-missing' };
      return resolveViaBridge(song, context, 'official-first-after-fail');
    }
    return { override: false, reason: 'no-mode-matched' };
  }

  async function resolveViaBridge(song, context, mode) {
    var bridge = getBridge();
    var requestedQuality = context.requestedQuality || 'hires';
    var lxSong = songToLxMusicInfo(song, requestedQuality);
    var payload = {
      song: lxSong,
      quality: normalizePlaybackQuality(requestedQuality),
      mode: mode,
      officialResult: context.officialResult || {},
    };
    var res = null;
    var via = 'http';
    try {
      // 优先走 Electron 主进程 IPC 直通解析，绕开 HTTP bridge 注入时序问题
      if (bridge && typeof bridge.resolveOnline === 'function') {
        var ipcRes = await Promise.resolve(bridge.resolveOnline(payload));
        if (ipcRes && typeof ipcRes === 'object' && ipcRes.ok === true && ipcRes.result && typeof ipcRes.result === 'object') {
          res = ipcRes.result;
          via = 'ipc';
        } else if (ipcRes && typeof ipcRes === 'object' && ipcRes.result && typeof ipcRes.result === 'object') {
          res = ipcRes.result;
          via = 'ipc';
        } else if (ipcRes && typeof ipcRes === 'object' && (ipcRes.url || ipcRes.reason)) {
          // 兼容直接返回解析结果
          res = ipcRes;
          via = 'ipc';
        }
      }
      // 降级：HTTP 路由（web 预览或老 bridge）
      if (!res) {
        var httpRes = await apiJson('/api/custom-source/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          timeoutMs: 16000,
        });
        if (httpRes && typeof httpRes === 'object' && httpRes.result && typeof httpRes.result === 'object' && (httpRes.result.url || httpRes.ok === false)) {
          res = httpRes.result;
        } else {
          res = httpRes;
        }
        via = via === 'ipc' ? 'ipc+http' : 'http';
      }
    } catch (e) {
      pushLog('error', 'resolveViaBridge failed via=' + via + ': ' + (e.message || String(e)));
      return { override: false, reason: 'exception', via: via };
    }

    if (!res || typeof res !== 'object') {
      pushLog('warn', 'resolve 响应为空 via=' + via);
      return { override: false, reason: 'empty-response', via: via };
    }
    if (!res.url) {
      pushLog('info', 'resolve 未获得音频 via=' + via + ': ' + (res.reason || res.error || 'unknown'), res);
      return { override: false, reason: res.reason || 'no-url', via: via };
    }
    var url = String(res.url || '');
    var resolvedLevel = String(res.level || res.quality || requestedQuality || '');
    var sourceLabel = String(res.sourceLabel || res.packageName || res.pkgId || res.sourceName || res.source || '第三方音源');
    pushLog('info', 'resolve 成功 via=' + via + ': ' + sourceLabel + (resolvedLevel ? ' @ ' + resolvedLevel : ''), { urlPrefix: url.slice(0, 80), reason: res.reason || null });
    return {
      override: true,
      resolvedPlaybackProvider: CUSTOM_PROVIDER_KEY,
      sourceLabel: sourceLabel,
      resolvedSourceLabel: sourceLabel,
      via: via,
      data: {
        url: url,
        level: resolvedLevel || requestedQuality || 'standard',
        provider: CUSTOM_PROVIDER_KEY,
        source: sourceLabel,
        sourceMatch: true,
        trial: false,
        headers: (res.headers && typeof res.headers === 'object') ? res.headers : undefined,
        custom: (res.custom && typeof res.custom === 'object') ? res.custom : undefined,
      },
    };
  }

  async function fallbackOnPlaybackFailure(song, data, idx, token, opts) {
    // 官方解析失败时，若当前是 official-first 或 custom-first，给第三方再一次机会
    if (!prefs.enabled) return null;
    var bridge = getBridge();
    if (!bridge) return null;
    if (prefs.mode === 'aggregate') {
      // aggregate 已经在主流程里调用过第三方（聚合解析含搜索匹配，重复代价高）；防止重复请求
      return null;
    }
    var resolved;
    try {
      resolved = await resolveViaBridge(song, {
        officialResult: data || {},
        requestedQuality: normalizePlaybackQuality(opts && opts.qualityOverride || 'hires'),
        playbackProvider: normalizePlaybackProvider(songProviderKey(song)),
        token: token,
      }, 'fallback');
    } catch (_) { resolved = null; }
    if (!resolved || resolved.override !== true || !resolved.data || !resolved.data.url) {
      return null;
    }
    var mergedData = Object.assign({}, data || {}, resolved.data || {});
    var newOpts = Object.assign({}, opts || {}, {
      preResolvedPlaybackData: mergedData,
      fallbackDepth: (opts && opts.fallbackDepth || 0) + 1,
    });
    if (resolved.resolvedPlaybackProvider && song) song.resolvedPlaybackProvider = resolved.resolvedPlaybackProvider;
    if (resolved.sourceLabel && song) song.sourceLabel = resolved.sourceLabel;
    if (resolved.resolvedSourceLabel && song) song.resolvedSourceLabel = resolved.resolvedSourceLabel;
    var started = await playQueueAt(idx, newOpts);
    return { result: started === true };
  }

  // ==================== IPC 事件订阅 + 启动就绪 ====================
  function subscribeBridgeEvents() {
    var bridge = getBridge();
    if (!bridge) return;
    try {
      if (typeof bridge.onEvent === 'function') {
        bridge.onEvent(function (evt) {
          pushLog('info', '[EVENT] ' + (evt && evt.name || 'event'), evt && evt.payload || null);
        });
      }
      if (typeof bridge.onLog === 'function') {
        bridge.onLog(function (evt) {
          pushLog((evt && evt.level) || 'info', (evt && evt.message) || '', evt && evt.data || null);
        });
      }
      if (typeof bridge.onStateChange === 'function') {
        bridge.onStateChange(function () {
          Promise.all([refreshInstalled(), refreshBundled()]).catch(function () {});
        });
      }
    } catch (e) {
      pushLog('warn', 'subscribeBridgeEvents failed: ' + (e.message || String(e)));
    }
  }

  function bootstrap() {
    try {
      updateEntryBadge();
      subscribeBridgeEvents();
      applyOverviewUi();
      pushLog('info', 'CustomSourceIntegration ready · mode=' + prefs.mode + (hasBridge() ? ' · desktop' : ' · web-preview'));
      Promise.all([refreshInstalled(), refreshBundled()]).catch(function () {});
    } catch (e) {
      console.warn('[CustomSourceIntegration] bootstrap error', e && e.message || e);
    }
  }

  window.CustomSourceIntegration = {
    // UI
    openModal: openModal,
    closeModal: closeModal,
    switchTab: switchTab,
    clearLog: clearLog,
    setMode: setMode,
    // 解析后端地址（用户自填）
    setBackendUrl: setBackendUrl,
    refreshBackend: refreshBackend,
    // 列表
    refreshInstalled: refreshInstalled,
    refreshBundled: refreshBundled,
    openScriptDirectory: openScriptDirectory,
    // 音源操作
    enable: enable,
    disable: disable,
    remove: remove,
    installBundled: installBundled,
    // 导入
    importByUrl: importByUrl,
    importByText: importByText,
    previewScript: previewScript,
    // 集成
    resolveOnlinePlaybackData: resolveOnlinePlaybackData,
    fallbackOnPlaybackFailure: fallbackOnPlaybackFailure,
    appendSourceSwitcherEntries: appendSourceSwitcherEntries,
    getMode: function () { return prefs.mode; },
    isEnabled: function () { return !!prefs.enabled; },
    // 告知播放链路官方请求是否可跳过：aggregate / custom-first 一定跳；custom-first 跳过后仍会在 resolveOnlinePlaybackData 中失败再回退
    // aggregate 预解析未命中时会重新放行官方请求作为兜底（见 13-playback-start-audio.js 的 preResolve 逻辑）
    shouldSkipOfficialRequest: function () {
      if (!prefs.enabled) return false;
      var m = prefs.mode;
      return m === 'custom-first' || m === 'aggregate';
    },
    // custom-first 模式时，无论官方返回啥都不算可用
    shouldTreatOfficialAsUnusable: function () {
      if (!prefs.enabled) return false;
      var m = prefs.mode;
      return m === 'custom-first';
    },
    hasBridge: hasBridge,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    setTimeout(bootstrap, 0);
  }
})();
