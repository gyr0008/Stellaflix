// ============================================================
// 15-lx-source-manager.js — 批 T13：LX 源管理 UI（顶栏徽章 + 管理面板 + 双通道导入）
// 移植上游 index.html:5667-5672（徽章 DOM）/:29506-29530（徽章逻辑）/:29553-29595（面板）
// /:29640-29830（handlers）/:29851-29899（文件导入）/:29911-29940（链接导入）。
// 响应形态以本分支 server.js 路由族（~:8217-8450）为准，非上游：
//  - status.installed 行标字段是 `current`（上游 active）；
//  - check 路由直发 host 数组本体（上游 {checked:[...]} 包壳）；
//  - import 成功体是 {ok, id, meta:{name,version,...}}（上游 result.name 顶层）。
// 台账携带：select/toggle/delete/import 成功后必须调 window.invalidateLxResolvedAudioCache
//  + window.clearLxAudioPrefetchTimer（T10 注释 13:1459-1461 预留给本模块的钩子）；
//  LX_NO_SOURCES 终态引导经 attachNoticeOpenAction 接线（spec §5，13 模块终态分支调用）；
//  重复导入会静默复活停用记录（T4 采纳的上游去重语义）——导入收据文案披露，不改服务端。
// ============================================================

var lxSourceManagerInfo = null; // 最近一次 status/toggle/select/delete 载荷（对齐上游 currentLxSourceInfo）

function lxSourceInstalled(info) {
  return (info && Array.isArray(info.installed)) ? info.installed : [];
}

function lxSourceFindRow(id) {
  id = String(id || '');
  return lxSourceInstalled(lxSourceManagerInfo).find(function (item) { return String(item.id) === id; }) || null;
}

// —— 徽章（上游 :29507-29530；文案「启用数/总数」）——
function applyLxSourceBadge(info) {
  var label = document.getElementById('lx-source-top-label');
  var count = document.getElementById('lx-source-top-count');
  var button = document.getElementById('lx-source-top-btn');
  var installed = lxSourceInstalled(info);
  var enabled = info && typeof info.enabledCount === 'number'
    ? info.enabledCount
    : installed.filter(function (item) { return item.enabled !== false; }).length;
  var name = (info && info.name) || '未知';
  if (label) label.textContent = '音源：' + name;
  if (count) count.textContent = installed.length ? (enabled + '/' + installed.length) : '';
  if (button) button.setAttribute('title', '当前音源：' + name + '；已启用 ' + enabled + '/' + installed.length);
}

async function refreshLxSourceBadge() {
  var label = document.getElementById('lx-source-top-label');
  var count = document.getElementById('lx-source-top-count');
  try {
    var info = await apiJson('/api/lx-source/status?t=' + Date.now(), { timeoutMs: 8000 });
    if (!info || !info.ok) throw new Error((info && (info.error || info.code)) || 'SOURCE_UNAVAILABLE');
    lxSourceManagerInfo = info;
    applyLxSourceBadge(info);
  } catch (e) {
    lxSourceManagerInfo = null;
    if (label) label.textContent = '音源：不可用';
    if (count) count.textContent = '';
    var button = document.getElementById('lx-source-top-btn');
    if (button) button.setAttribute('title', '当前音源加载失败');
  }
}

// —— 面板行渲染（上游 :29553-29595；纯字符串出口便于测试）——
function lxSourceRowMetaText(item) {
  var parts = [];
  if (item.version) parts.push('v' + item.version);
  if (item.author) parts.push(item.author);
  if (item.current) parts.push('当前使用');
  parts.push(item.enabled === false ? '已停用' : '已启用');
  return parts.join(' · ');
}

function renderLxSourceRowsHtml(installed) {
  return (installed || []).map(function (item) {
    var id = escHtml(String(item.id || ''));
    var name = escHtml(String(item.name || '未命名音源'));
    var disabledRow = item.enabled === false;
    return '<div class="lx-source-row' + (item.current ? ' active' : '') + (disabledRow ? ' disabled' : '') + '"' +
      ' data-source-row="' + id + '">' +
      '<input class="lx-source-check" type="checkbox" data-source-check="' + id + '"' +
      ' aria-label="选择 ' + name + '"' +
      ' onchange="window.lxSourceManager && window.lxSourceManager.updateBulkSelection()">' +
      '<div class="lx-source-row-main" data-source-id="' + id + '" title="切换到这个音源"' +
      ' onclick="window.lxSourceManager && window.lxSourceManager.selectSource(\'' + id + '\')">' +
      '<div class="lx-source-row-title">' + name + '</div>' +
      '<div class="lx-source-row-meta">' + escHtml(lxSourceRowMetaText(item) || '点击切换到此音源') + '</div>' +
      '</div>' +
      '<div class="lx-source-row-actions">' +
      '<span class="lx-source-availability" data-source-availability="' + id + '">未检查</span>' +
      (item.current ? '<span class="lx-source-current-flag">当前</span>' : '') +
      '<button type="button" class="lx-source-toggle-btn" data-source-toggle="' + id + '"' +
      ' title="启用或停用这个音源"' +
      ' onclick="window.lxSourceManager && window.lxSourceManager.toggleSource(\'' + id + '\')">' +
      (disabledRow ? '启用' : '停用') + '</button>' +
      '<button type="button" class="lx-source-check-one" data-source-check-one="' + id + '"' +
      ' title="检查这个音源是否可用"' +
      ' onclick="window.lxSourceManager && window.lxSourceManager.checkSourceOne(\'' + id + '\')">检查</button>' +
      '<button type="button" class="lx-source-delete-btn" data-source-delete="' + id + '"' +
      ' title="删除这个音源"' +
      ' onclick="window.lxSourceManager && window.lxSourceManager.deleteSource(\'' + id + '\')">删除</button>' +
      '</div>' +
      '</div>';
  }).join('');
}

function lxSourceManagerMask() {
  return document.getElementById('lx-source-manager-mask');
}

function lxSourcePanelIsOpen() {
  var mask = lxSourceManagerMask();
  return !!(mask && mask.getAttribute('data-open') === '1');
}

function renderLxSourcePanel() {
  var mask = lxSourceManagerMask();
  if (!mask) return;
  var installed = lxSourceInstalled(lxSourceManagerInfo);
  var list = mask.querySelector('.lx-source-manager-list') || document.getElementById('lx-source-manager-list');
  if (list) list.innerHTML = renderLxSourceRowsHtml(installed);
  var countEl = document.getElementById('lx-source-manager-count');
  if (countEl) countEl.textContent = '已导入 ' + installed.length + ' 个音源；可逐个启用、停用或检查可用性';
  var guide = document.getElementById('lx-source-empty-guide');
  if (guide) guide.hidden = installed.length > 0;
  updateLxSourceBulkSelection();
}

async function openLxSourceManager() {
  var mask = lxSourceManagerMask();
  if (!mask) return;
  mask.setAttribute('data-open', '1');
  mask.setAttribute('aria-hidden', 'false');
  if (!lxSourceManagerInfo) await refreshLxSourceBadge();
  renderLxSourcePanel();
}

function closeLxSourceManager() {
  var mask = lxSourceManagerMask();
  if (!mask) return;
  mask.setAttribute('data-open', '0');
  mask.setAttribute('aria-hidden', 'true');
}

// —— 批量选择态（上游 :29600-29630）——
function getSelectedSourceIds() {
  var mask = lxSourceManagerMask();
  if (!mask) return [];
  return Array.prototype.slice.call(mask.querySelectorAll('[data-source-check]') || [])
    .filter(function (check) { return check.checked; })
    .map(function (check) { return check.getAttribute('data-source-check'); })
    .filter(Boolean);
}

function updateLxSourceBulkSelection() {
  var mask = lxSourceManagerMask();
  if (!mask) return;
  var checks = Array.prototype.slice.call(mask.querySelectorAll('[data-source-check]') || []);
  var selected = checks.filter(function (check) { return check.checked; });
  var selectAll = mask.querySelector('[data-source-select-all]');
  if (selectAll) {
    selectAll.checked = !!checks.length && selected.length === checks.length;
    selectAll.indeterminate = selected.length > 0 && selected.length < checks.length;
  }
  var count = mask.querySelector('[data-source-bulk-count]') || document.getElementById('lx-source-bulk-count');
  if (count) count.textContent = '已选 ' + selected.length + ' 个';
  ['enable', 'disable', 'check', 'delete'].forEach(function (key) {
    var button = mask.querySelector('[data-source-bulk-' + key + ']');
    if (button) button.disabled = !selected.length;
  });
}

// —— 缓存失效（台账携带1：13:1459-1461 预留钩子，源状态一变全清镜像+撤预取）——
function lxSourceInvalidatePlaybackCaches() {
  try {
    if (typeof window !== 'undefined' && typeof window.invalidateLxResolvedAudioCache === 'function') {
      window.invalidateLxResolvedAudioCache({});
    }
    if (typeof window !== 'undefined' && typeof window.clearLxAudioPrefetchTimer === 'function') {
      window.clearLxAudioPrefetchTimer();
    }
  } catch (e) { /* 缓存清理失败不阻断 UI（下次 resolve 自然重建） */ }
}

// 状态变更成功后：清缓存 → 拉最新 status → 面板若开着就地重渲染。
async function afterLxSourceStateChange() {
  lxSourceInvalidatePlaybackCaches();
  await refreshLxSourceBadge();
  if (lxSourcePanelIsOpen()) renderLxSourcePanel();
}

// —— 路由动作封装（POST 体形态对齐 server.js 路由读取：ids|id / enabled / url / fileName+script）——
async function lxSourcePost(route, body, fallbackError) {
  var result = await apiJson('/api/lx-source/' + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 30000,
  });
  if (!result || result.ok !== true) {
    throw new Error((result && (result.error || result.code)) || fallbackError);
  }
  return result;
}

async function selectLxSource(id) {
  var buttonLike = { classList: { add: function () {}, remove: function () {} } };
  try {
    var result = await lxSourcePost('select', { id: id }, 'SOURCE_SELECT_FAILED');
    lxSourceManagerInfo = result;
    await afterLxSourceStateChange();
    closeLxSourceManager();
    showToast('已切换音源：' + (result.name || '未知'));
    return result;
  } catch (e) {
    if (buttonLike) buttonLike.classList.remove('busy');
    showToast('音源切换失败：' + ((e && e.message) || '未知错误'));
    throw e;
  }
}

async function setLxSourcesEnabled(ids, enabled) {
  var result = await lxSourcePost('toggle', { ids: ids, enabled: !!enabled }, 'SOURCE_TOGGLE_FAILED');
  lxSourceManagerInfo = result;
  await afterLxSourceStateChange();
  return result;
}

async function toggleLxSource(id) {
  var row = lxSourceFindRow(id);
  var wasEnabled = !!(row && row.enabled !== false);
  try {
    var result = await setLxSourcesEnabled([id], !wasEnabled);
    showToast(wasEnabled ? '已停用音源' : '已启用音源');
    return result;
  } catch (e) {
    showToast('音源状态修改失败：' + ((e && e.message) || '未知错误'));
    throw e;
  }
}

async function bulkSetLxSourcesEnabled(enabled) {
  var ids = getSelectedSourceIds();
  if (!ids.length) return null;
  try {
    var result = await setLxSourcesEnabled(ids, enabled);
    showToast((enabled ? '已批量启用 ' : '已批量停用 ') + ids.length + ' 个音源');
    return result;
  } catch (e) {
    updateLxSourceBulkSelection();
    showToast('批量修改失败：' + ((e && e.message) || '未知错误'));
    throw e;
  }
}

// —— 检查可用性（上游 :29780-29812；本分支 check 路由直发数组本体）——
function lxSourceCheckRows(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.checked)) return result.checked; // 上游包壳容忍位
  throw new Error((result && (result.error || result.code)) || 'SOURCE_CHECK_FAILED');
}

async function checkLxSourceAvailability(ids) {
  ids = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (!ids.length) return null;
  var mask = lxSourceManagerMask();
  try {
    // check 例外：本分支路由成功体是 host 的逐源数组本体（server.js:8372），
    // 无 {ok} 包壳，不能走 lxSourcePost 的 ok 校验——用 lxSourceCheckRows 判别形态。
    var result = await apiJson('/api/lx-source/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ids }),
      timeoutMs: 30000,
    });
    var rows = lxSourceCheckRows(result);
    rows.forEach(function (item) {
      if (!mask) return;
      var status = mask.querySelector('[data-source-availability="' + String(item.id || '') + '"]');
      if (!status) return;
      status.classList.remove('ok', 'bad');
      status.classList.add(item.ok ? 'ok' : 'bad');
      status.textContent = item.ok ? '可用' : '不可用';
      status.setAttribute('title', item.ok
        ? ('支持：' + ((item.sources || []).join('、') || '未声明平台'))
        : String(item.error || '音源脚本加载失败'));
    });
    var failed = rows.filter(function (item) { return !item.ok; }).length;
    showToast(failed ? ('检查完成：' + failed + ' 个不可用') : ('检查完成：' + rows.length + ' 个音源可用'));
    return rows;
  } catch (e) {
    showToast('音源检查失败：' + ((e && e.message) || '未知错误'));
    throw e;
  }
}

// —— 删除（上游 :29723-29778：confirm → 单删 {id} / 批删 {ids}）——
async function deleteLxSource(id) {
  var row = lxSourceFindRow(id);
  var sourceName = row ? (row.name || '未命名音源') : '这个音源';
  if (!confirm('确定删除「' + sourceName + '」吗？删除后需要重新导入才能恢复。')) return null;
  try {
    var result = await lxSourcePost('delete', { id: id }, 'SOURCE_DELETE_FAILED');
    lxSourceManagerInfo = result;
    await afterLxSourceStateChange();
    if (!lxSourceInstalled(result).length) closeLxSourceManager();
    showToast('已删除音源：' + sourceName);
    return result;
  } catch (e) {
    showToast('音源删除失败：' + ((e && e.message) || '未知错误'));
    throw e;
  }
}

async function bulkDeleteLxSources() {
  var ids = getSelectedSourceIds();
  if (!ids.length) return null;
  if (!confirm('确定删除选中的 ' + ids.length + ' 个音源吗？删除后需要重新导入才能恢复。')) return null;
  try {
    var result = await lxSourcePost('delete', { ids: ids }, 'SOURCE_BULK_DELETE_FAILED');
    lxSourceManagerInfo = result;
    await afterLxSourceStateChange();
    showToast('已批量删除 ' + (Number(result.deleted) || ids.length) + ' 个音源');
    return result;
  } catch (e) {
    updateLxSourceBulkSelection();
    showToast('批量删除失败：' + ((e && e.message) || '未知错误'));
    throw e;
  }
}

// —— 双通道导入 ——
// 文件通道（上游 :29851-29899）：逐文件 POST {fileName, script}，逐文件校验回执；
// 携带3：本分支 import 重复脚本会复用原 id 并复活停用记录（host importSource 去重段），
// 收据文案必须披露这一点。
async function importLxSourceFiles(files) {
  files = Array.prototype.slice.call(files || []);
  if (!files.length) return '';
  var importedCount = 0;
  var failedNames = [];
  var firstImportError = '';
  var lastResult = null;
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    try {
      showToast('正在验证音源 ' + (i + 1) + '/' + files.length + '：' + file.name);
      var script = await file.text();
      lastResult = await lxSourcePost('import', { fileName: file.name, script: script }, 'IMPORT_FAILED');
      importedCount++;
    } catch (fileError) {
      failedNames.push(file.name);
      if (!firstImportError) firstImportError = file.name + '：' + ((fileError && fileError.message) || '导入失败');
      console.warn('[LXSourceFileImport]', file.name, fileError);
    }
  }
  if (!importedCount || !lastResult) {
    var allFailed = new Error(firstImportError || '所选音源均导入失败');
    showToast('音源导入失败：' + allFailed.message);
    throw allFailed;
  }
  await afterLxSourceStateChange();
  var receipt = '已导入 ' + importedCount + ' 个音源' +
    (failedNames.length ? ('，失败 ' + failedNames.length + ' 个（' + failedNames.join('、') + '）') : '') +
    '；当前：' + ((lastResult.meta && lastResult.meta.name) || lastResult.name || '未知') +
    '。提示：重新导入同一音源会自动启用已停用记录';
  showToast(receipt);
  return receipt;
}

function openLxSourceImport() {
  var input = document.getElementById('lx-source-import-input');
  if (!input) {
    input = document.createElement('input');
    input.id = 'lx-source-import-input';
    input.type = 'file';
    input.multiple = true;
    input.accept = '.js,application/javascript,text/javascript,text/plain';
    input.style.display = 'none';
    input.addEventListener('change', function () {
      importLxSourceFiles(input.files).catch(function () { /* 收据/toast 已在上行 */ });
    });
    document.body.appendChild(input);
  }
  input.value = '';
  input.click();
}

// URL/APIKEY 归一：与 lx-source-host.js normalizeImportSourceUrl（T4）同规三则——
// ① 64-hex 视为 APIKEY 展开 ynx 端点；② 裸 ynx.de5.net/ 补 http:；③ ynx https 预降级 http。
// 差别仅在 UI 层失败返回 ''（host 抛 LX_SOURCE_URL_INVALID）。
function normalizeLxSourceUrlInput(value) {
  var text = String(value || '').trim();
  if (!text) return '';
  if (/^[a-f0-9]{64}$/i.test(text)) {
    text = 'http://ynx.de5.net/API/lx-ynx.php?APIKEY=' + text;
  } else if (/^ynx\.de5\.net\//i.test(text)) {
    text = 'http://' + text;
  }
  try {
    var target = new URL(text);
    if (!/^https?:$/.test(target.protocol)) return '';
    if (target.protocol === 'https:' && target.hostname === 'ynx.de5.net') target.protocol = 'http:';
    return target.href;
  } catch (e) {
    return '';
  }
}

function lxSourceApiKeyHintText(value) {
  var text = String(value || '').trim();
  if (/^[a-f0-9]{64}$/i.test(text)) {
    return '识别为 APIKEY：将展开为 ynx.de5.net 兼容端点导入（http://ynx.de5.net/API/lx-ynx.php?APIKEY=…）';
  }
  return '';
}

function lxSourceUrlModalHtml() {
  return '<div class="lx-source-url-dialog" role="dialog" aria-modal="true">' +
    '<div class="lx-source-url-title">导入落雪兼容音源</div>' +
    '<div class="lx-source-url-desc">粘贴音源 JS 链接，验证成功后会自动设为当前播放音源。</div>' +
    '<div class="lx-source-url-warn">安全提示：音源会执行代码，只导入你信任的来源。</div>' +
    '<input id="lx-source-url-value" type="text"' +
    ' placeholder="可粘贴音源链接，或直接粘贴 64 位 APIKEY"' +
    ' oninput="window.lxSourceManager && window.lxSourceManager.onUrlInput(this.value)">' +
    '<div id="lx-source-apikey-hint" class="lx-source-apikey-hint" hidden></div>' +
    '<div class="lx-source-url-actions">' +
    '<button type="button" onclick="window.lxSourceManager && window.lxSourceManager.closeUrlModal()">取消</button>' +
    '<button type="button" onclick="window.lxSourceManager && window.lxSourceManager.submitUrl()">导入链接</button>' +
    '</div>' +
    '</div>';
}

function openLxSourceUrlModal() {
  var modal = document.getElementById('lx-source-url-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'lx-source-url-modal';
    modal.className = 'lx-source-url-modal';
    modal.innerHTML = lxSourceUrlModalHtml();
    document.body.appendChild(modal);
  } else {
    modal.style.display = 'flex';
  }
  var input = document.getElementById('lx-source-url-value');
  if (input && input.focus) setTimeout(function () { input.focus(); }, 0);
}

function closeLxSourceUrlModal() {
  var modal = document.getElementById('lx-source-url-modal');
  if (modal) modal.style.display = 'none';
  var hint = document.getElementById('lx-source-apikey-hint');
  if (hint) { hint.hidden = true; hint.textContent = ''; }
}

// APIKEY 输入展开（brief ④）：粘贴 64-hex 即时展开识别提示，判定与归一同 normalizeLxSourceUrlInput。
function onLxSourceUrlInput(value) {
  var hint = document.getElementById('lx-source-apikey-hint');
  if (!hint) return;
  var text = lxSourceApiKeyHintText(value);
  hint.textContent = text;
  hint.hidden = !text;
}

async function importLxSourceFromUrl(raw) {
  var sourceUrl = normalizeLxSourceUrlInput(raw);
  if (!sourceUrl) throw new Error('INVALID_SOURCE_URL');
  showToast('正在下载并验证音源…');
  var result = await lxSourcePost('import', { url: sourceUrl }, 'IMPORT_FAILED');
  await afterLxSourceStateChange();
  var name = (result.meta && result.meta.name) || result.name || '未知';
  showToast('已接入：' + name + (result.meta && result.meta.version ? (' ' + result.meta.version) : ''));
  return result;
}

async function submitLxSourceUrl() {
  var input = document.getElementById('lx-source-url-value');
  var raw = input ? String(input.value || '').trim() : '';
  var sourceUrl = normalizeLxSourceUrlInput(raw);
  if (!sourceUrl) {
    showToast('音源链接无效：可粘贴 http/https 链接，或直接粘贴 64 位 APIKEY');
    return;
  }
  try {
    await importLxSourceFromUrl(raw);
    closeLxSourceUrlModal();
  } catch (e) {
    showToast('音源导入失败：' + ((e && e.message) || '文件无效'));
  }
}

// —— LX_NO_SOURCES 引导接线（spec §5，13 模块终态分支调用）——
// 在最近一张换源通知卡（或静态 #source-fallback-notice）上挂「打开音源管理」按钮。
function attachLxNoticeOpenAction() {
  var stack = document.getElementById('source-fallback-stack');
  var target = (stack && stack.firstChild) ? stack.firstChild : document.getElementById('source-fallback-notice');
  if (!target || !target.appendChild) return;
  var kids = Array.prototype.slice.call(target.children || []);
  var existing = kids.find(function (child) {
    return child.getAttribute && child.getAttribute('data-lx-open-manager');
  });
  if (existing) { existing.hidden = false; return; } // 静态槽位（#source-fallback-notice 内联）翻出即走
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'lx-source-notice-open-btn';
  btn.setAttribute('data-lx-open-manager', '1');
  btn.textContent = '打开音源管理';
  btn.onclick = function () { openLxSourceManager(); };
  target.appendChild(btn);
}

async function openLxSourceManagerFromNotice() {
  closeLxSourceUrlModal();
  await openLxSourceManager();
}

// —— 遮罩点击关闭（背景区域）——
(function initLxSourceManagerMaskDismiss() {
  var mask = lxSourceManagerMask();
  if (!mask || typeof mask.addEventListener !== 'function') return;
  mask.addEventListener('click', function (event) {
    if (event && event.target === mask) closeLxSourceManager();
  });
})();

if (typeof window !== 'undefined') {
  window.lxSourceManager = {
    refreshBadge: refreshLxSourceBadge,
    renderRowsHtml: renderLxSourceRowsHtml,
    open: openLxSourceManager,
    close: closeLxSourceManager,
    openFromNotice: openLxSourceManagerFromNotice,
    selectSource: selectLxSource,
    toggleSource: toggleLxSource,
    bulkSetEnabled: bulkSetLxSourcesEnabled,
    checkSourceOne: function (id) { return checkLxSourceAvailability([id]); },
    bulkCheck: function () { return checkLxSourceAvailability(getSelectedSourceIds()); },
    deleteSource: deleteLxSource,
    bulkDelete: bulkDeleteLxSources,
    importFiles: importLxSourceFiles,
    importFilePicker: openLxSourceImport,
    importFromUrl: importLxSourceFromUrl,
    normalizeUrlInput: normalizeLxSourceUrlInput,
    apiKeyHintText: lxSourceApiKeyHintText,
    urlModalHtml: lxSourceUrlModalHtml,
    openUrlModal: openLxSourceUrlModal,
    closeUrlModal: closeLxSourceUrlModal,
    submitUrl: submitLxSourceUrl,
    onUrlInput: onLxSourceUrlInput,
    updateBulkSelection: updateLxSourceBulkSelection,
    getSelectedSourceIds: getSelectedSourceIds,
    attachNoticeOpenAction: attachLxNoticeOpenAction,
  };
  // 首屏徽章自刷（DOM 由 index.html 内联，无需等待其它模块）
  refreshLxSourceBadge();
}
// ============================================================
