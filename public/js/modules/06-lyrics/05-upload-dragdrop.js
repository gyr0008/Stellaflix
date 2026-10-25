// ============================================================
var AUDIO_UPLOAD_EXT_RE = /\.(mp3|flac|wav|ogg|m4a|aac|opus)$/i;
var IMAGE_UPLOAD_EXT_RE = /\.(jpg|jpeg|png|webp)$/i;
function isAudioUploadFile(file) {
  if (!file) return false;
  return /^audio\//i.test(file.type || '') || AUDIO_UPLOAD_EXT_RE.test(file.name || '');
}
function isImageUploadFile(file) {
  if (!file) return false;
  return /^image\//i.test(file.type || '') || IMAGE_UPLOAD_EXT_RE.test(file.name || '');
}
function uploadFileSortKey(file) {
  return String((file && (file.webkitRelativePath || file.name)) || '').toLowerCase();
}
function sortedAudioUploadFiles(files) {
  return Array.prototype.slice.call(files || [])
    .filter(isAudioUploadFile)
    .sort(function (a, b) {
      return uploadFileSortKey(a).localeCompare(uploadFileSortKey(b), 'zh-CN', { numeric: true, sensitivity: 'base' });
    });
}
function firstImageUploadFile(files) {
  var list = Array.prototype.slice.call(files || []);
  for (var i = 0; i < list.length; i++) if (isImageUploadFile(list[i])) return list[i];
  return null;
}
function localSongFromAudioFile(file) {
  var rel = String(file.webkitRelativePath || file.name || '');
  var filename = String(file.name || rel || '本地音乐');
  var title = filename.replace(/\.[^.]+$/, '');
  return hydrateCustomCover({
    type: 'local',
    source: 'local',
    provider: 'local',
    name: title || '本地音乐',
    artist: '本地文件',
    album: rel && rel !== filename ? rel.split(/[\\/]/).slice(0, -1).join(' / ') : '',
    localKey: [rel || filename, file.size || 0, file.lastModified || 0].join(':'),
    localUrl: URL.createObjectURL(file),
    localPath: rel,
    duration: 0
  });
}
function canUsePersistentLocalMusicLibrary() {
  return !!(
    window.desktopWindow &&
    typeof window.desktopWindow.importLocalMusicFiles === 'function'
  );
}
function canRemovePersistentLocalTracks() {
  return !!(
    window.desktopWindow &&
    typeof window.desktopWindow.removeLocalMusicTracks === 'function'
  );
}
function normalizeLocalTrackId(value) {
  return String(value || '').replace(/^local:/, '').toLowerCase();
}
function applyPersistentLocalLibraryTracks(result) {
  var tracks = result && Array.isArray(result.tracks) ? result.tracks : [];
  persistentLocalLibraryTracks = tracks.map(function (song) {
    var copy = hydrateCustomCover(Object.assign({}, song));
    copy.localMissing = false;
    return copy;
  }).filter(function (song) {
    return song && song.localUrl && song.localKey;
  }).map(cloneSong);
  if (typeof refreshHomeDashboardLocalMusic === 'function') refreshHomeDashboardLocalMusic(true);
  return persistentLocalLibraryTracks;
}
async function removePersistentLocalTracks(ids) {
  // 批4-D：只走新引擎（内存态 + SQLite 行）。
  var raw = (Array.isArray(ids) ? ids : [ids]).map(function (v) { return String(v || ''); }).filter(Boolean);
  if (!raw.length) return null;
  if (!window.stellaMlibSeam || typeof window.stellaMlibSeam.removeLocalTracks !== 'function') return null;
  var engineRes = await window.stellaMlibSeam.removeLocalTracks(raw);
  if (engineRes && engineRes.ok) {
    persistentLocalLibraryTracks = (typeof getLocalLibraryTracks === 'function' ? getLocalLibraryTracks() : persistentLocalLibraryTracks).map(cloneSong);
    if (typeof refreshHomeDashboardLocalMusic === 'function') refreshHomeDashboardLocalMusic(true);
    return { ok: true, removed: engineRes.removed };
  }
  return null;
}
function removeLocalTrackFromLibraryAndQueue(song) {
  if (!song) return Promise.resolve(false);
  var rawId = String(song.localFileId || song.localKey || '');
  var isLegacy = /^[a-f0-9]{24}$/.test(normalizeLocalTrackId(rawId));
  var isEngineKey = /:\d+:\d+$/.test(rawId); // 新引擎 songKey = abs:size:mtime
  if (!rawId || (!isLegacy && !isEngineKey)) {
    showToast('这首歌不在持久化本地曲库中');
    return Promise.resolve(false);
  }
  if (!canRemovePersistentLocalTracks() && !(window.stellaMlibSeam && typeof window.stellaMlibSeam.removeLocalTracks === 'function')) {
    showToast('当前环境无法删除本地曲库');
    return Promise.resolve(false);
  }
  return removePersistentLocalTracks([isLegacy ? normalizeLocalTrackId(rawId) : rawId]).then(function (result) {
    if (!result) return false;
    var queueKey = queueItemKey(song);
    var idx = -1;
    for (var i = 0; i < playQueue.length; i++) {
      if (queueItemKey(playQueue[i]) === queueKey) { idx = i; break; }
    }
    var wasCurrent = currentIdx === idx || (!!currentLocalSong && queueItemKey(currentLocalSong) === queueKey);
    if (idx >= 0) playQueue.splice(idx, 1);
    if (wasCurrent) {
      try {
        if (audio) {
          audio.pause();
          audio.removeAttribute('src');
          audio.load();
        }
      } catch (e) { }
      currentLocalSong = null;
      if (currentIdx >= playQueue.length) currentIdx = playQueue.length - 1;
      playing = false;
      if (typeof setPlayIcon === 'function') setPlayIcon(false);
      if (typeof hideLoading === 'function') hideLoading();
    } else if (idx >= 0 && currentIdx > idx) {
      currentIdx -= 1;
    }
    safeRenderQueuePanel('remove-local-track');
    safeShelfRebuild('remove-local-track', true);
    updateCustomCoverButton();
    updateEmptyHomeVisibility({ forceLoad: false });
    showToast('已从本地曲库移除');
    return true;
  }).catch(function (e) {
    console.warn('[LocalLibraryRemove]', e);
    showToast('移除本地曲库失败');
    return false;
  });
}
async function importPersistentLocalAudioFiles(files) {
  if (!canUsePersistentLocalMusicLibrary()) return null;
  var selectedFiles = Array.prototype.slice.call(files || []);
  if (!selectedFiles.length) return null;
  var result = await window.desktopWindow.importLocalMusicFiles(selectedFiles);
  if (!result || result.ok !== true || !Array.isArray(result.tracks) || !result.tracks.length) {
    throw new Error(result && result.error || 'LOCAL_LIBRARY_IMPORT_FAILED');
  }
  return result;
}
// 批4-C2：新优先导入——选目录（主进程扫描落库）→ 新引擎水合+解析，失败回退旧拖入面板。
async function importLocalMusicFolderViaEngine() {
  if (!window.desktopWindow || typeof window.desktopWindow.chooseLocalMusicFolder !== 'function') {
    return { ok: false, fallback: true, error: 'ENGINE_UNAVAILABLE' };
  }
  if (!window.stellaMlibSeam || typeof window.stellaMlibSeam.hydrateFolder !== 'function') {
    return { ok: false, fallback: true, error: 'SEAM_UNAVAILABLE' };
  }
  var chosen;
  try { chosen = await window.desktopWindow.chooseLocalMusicFolder(); }
  catch (e) { return { ok: false, fallback: true, error: 'CHOOSE_FAILED' }; }
  if (chosen && chosen.canceled) return { ok: false, canceled: true }; // 用户取消，不回退
  var folderPath = chosen && (chosen.folderPath || chosen.path);
  if (!folderPath) return { ok: false, fallback: true, error: 'NO_FOLDER' };
  // chooseLocalMusicFolder 已扫描落库；这里直接水合+解析，不重复扫描。
  var res = await window.stellaMlibSeam.hydrateFolder(folderPath);
  if (res && res.ok && res.count > 0) {
    if (typeof refreshHomeDashboardLocalMusic === 'function') refreshHomeDashboardLocalMusic(true);
    if (typeof safeShelfRebuild === 'function') safeShelfRebuild('local-folder-import', true);
    if (typeof showToast === 'function') showToast('已导入 ' + res.count + ' 首本地音乐');
    return { ok: true, count: res.count, folderPath: folderPath };
  }
  return { ok: false, fallback: true, error: 'ENGINE_EMPTY' };
}
// 按钮入口：先试新引擎；引擎不可用/失败才回退旧拖入式文件夹选择（port don't delete）。
async function triggerLocalFolderImport() {
  var res = null;
  try { res = await importLocalMusicFolderViaEngine(); } catch (e) { res = { ok: false, fallback: true }; }
  if (res && (res.ok || res.canceled)) return res;
  if (typeof triggerUploadInput === 'function') triggerUploadInput('folder');
  return res || { ok: false };
}
window.triggerLocalFolderImport = triggerLocalFolderImport;

// 批4-D：拖入/单曲选择统一走新引擎——File 反推父文件夹按文件夹导入；引擎彻底不可用则本次会话内存态播放（不持久化）。
async function importDroppedFilesViaEngine(files) {
  var list = Array.prototype.slice.call(files || []);
  if (!list.length) return { ok: false };
  var audioFiles = sortedAudioUploadFiles(list);
  var imgFile = firstImageUploadFile(list);
  if (!audioFiles.length) { if (imgFile) handleCoverFiles([imgFile]); return { ok: false }; }
  function sessionOnly() {
    importLocalAudioSongs(audioFiles.map(localSongFromAudioFile), { coverFile: audioFiles.length === 1 ? imgFile : null });
    return { ok: false, sessionOnly: true };
  }
  if (!window.desktopWindow || typeof window.desktopWindow.localMusicFoldersForFiles !== 'function'
    || !window.stellaMlibSeam || typeof window.stellaMlibSeam.addLocalMusicFolder !== 'function') {
    return sessionOnly();
  }
  var res = null;
  try { res = await window.desktopWindow.localMusicFoldersForFiles(list); } catch (_e) { res = null; }
  var folders = (res && res.ok && Array.isArray(res.folders)) ? res.folders : [];
  if (!folders.length) return sessionOnly();
  var total = 0;
  for (var i = 0; i < folders.length; i += 1) {
    var r = await window.stellaMlibSeam.addLocalMusicFolder(folders[i]);
    if (r && r.ok) total += r.count;
  }
  if (total > 0) {
    if (typeof refreshHomeDashboardLocalMusic === 'function') refreshHomeDashboardLocalMusic(true);
    if (typeof safeShelfRebuild === 'function') safeShelfRebuild('local-drop-import', true);
    if (typeof showToast === 'function') showToast('已导入 ' + total + ' 首本地音乐');
    return { ok: true, count: total };
  }
  return sessionOnly();
}

function isLocalPlaybackSnapshot(snapshot) {
  var song = snapshot && snapshot.current;
  return !!(song && (song.type === 'local' || song.source === 'local' || song.localKey || song.localFileId));
}
function isRemovablePersistentLocalSong(song) {
  if (!song || !canRemovePersistentLocalTracks()) return false;
  if (!(song.type === 'local' || song.source === 'local' || song.localKey || song.localFileId)) return false;
  return /^[a-f0-9]{24}$/.test(normalizeLocalTrackId(song.localFileId || song.localKey));
}
function restoredLocalTrackIndex(tracks, snapshot) {
  var current = snapshot && snapshot.current || {};
  var localId = String(current.localFileId || current.localKey || '').replace(/^local:/, '');
  if (localId) {
    for (var i = 0; i < tracks.length; i++) {
      var songId = String(tracks[i].localFileId || tracks[i].localKey || '').replace(/^local:/, '');
      if (songId === localId) return i;
    }
    return -1;
  }
  var fallback = Number(snapshot && snapshot.currentIdx);
  return isFinite(fallback) && fallback >= 0 && fallback < tracks.length ? Math.round(fallback) : 0;
}
async function restorePersistedLocalLibrary() {
  var snapshotAtRequest = restoredLastPlaybackSnapshot;
  var queueAtRequest = playQueue;
  var indexAtRequest = currentIdx;
  var localSongAtRequest = currentLocalSong;
  // 批4-D 前置：先水合新引擎，再以新引擎为曲库来源；新引擎空且旧库仍可用时才回退旧 IPC（过渡共存）。
  var tracks = [];
  if (window.stellaMlibSeam && typeof window.stellaMlibSeam.hydrateAll === 'function') {
    try { await window.stellaMlibSeam.hydrateAll(); } catch (_e) { /* 新引擎水合失败走旧回退 */ }
  }
  if (typeof getLocalLibraryTracks === 'function') {
    try {
      tracks = (getLocalLibraryTracks() || []).map(function (song) {
        var copy = hydrateCustomCover(Object.assign({}, song));
        copy.localMissing = false;
        return copy;
      }).filter(function (song) { return song && song.localUrl && song.localKey; });
    } catch (_e2) { tracks = []; }
  }
  if (!tracks.length) return false;
  persistentLocalLibraryTracks = tracks.map(cloneSong);
  if (typeof refreshHomeDashboardLocalMusic === 'function') refreshHomeDashboardLocalMusic(true);
  var snapshot = snapshotAtRequest;
  if (snapshot && !isLocalPlaybackSnapshot(snapshot)) return false;
  if (
    restoredLastPlaybackSnapshot !== snapshotAtRequest
    || playQueue !== queueAtRequest
    || currentIdx !== indexAtRequest
    || currentLocalSong !== localSongAtRequest
  ) return false;
  if (snapshot) {
    var restoredIndex = restoredLocalTrackIndex(tracks, snapshot);
    if (restoredIndex < 0 || !tracks[restoredIndex]) {
      playQueue = tracks;
      currentIdx = -1;
      currentLocalSong = null;
      pendingPlaybackResumeAt = 0;
      restoredLastPlaybackSnapshot = null;
      startupRestoreHomePending = false;
      try { localStorage.removeItem(LAST_PLAYBACK_STORE_KEY); } catch (e) { }
      applyRestoredPlaybackProgressUi({ currentTime: 0, duration: 0, current: null });
      safeRenderQueuePanel('local-library-missing');
      updateEmptyHomeVisibility({ forceLoad: false });
      return false;
    }
    currentIdx = restoredIndex;
  } else {
    currentIdx = -1;
  }
  playQueue = tracks;
  currentLocalSong = null;
  if (!snapshot) {
    safeRenderQueuePanel('local-library-restore');
    updateEmptyHomeVisibility({ forceLoad: false });
    if (typeof refreshHomeDashboardLocalMusic === 'function') refreshHomeDashboardLocalMusic(true);
    return false;
  }
  var current = playQueue[currentIdx];
  if (!current) return false;
  snapshot.current = playbackRestoreSongSnapshot(current);
  snapshot.current.localMissing = false;
  updateControlTrackInfo(current);
  var titleEl = document.getElementById('thumb-title');
  var artistEl = document.getElementById('thumb-artist');
  if (titleEl) titleEl.textContent = current.name || current.title || '本地音乐';
  if (artistEl) artistEl.textContent = current.artist || '本地文件';
  var thumbWrap = document.getElementById('thumb-wrap');
  if (thumbWrap) thumbWrap.classList.add('visible');
  if (current.cover) {
    setTimeout(function () {
      if (!audio && currentIdx >= 0 && playQueue[currentIdx] && queueItemKey(playQueue[currentIdx]) === queueItemKey(current)) {
        loadCoverFromUrl(songCoverSrc(current, 400), { deferHeavy: true, delay: 120, timeout: 700 });
      }
    }, 180);
  }
  safeRenderQueuePanel('local-library-restore', { scrollCurrent: miniQueueOpen });
  updateEmptyHomeVisibility({ forceLoad: false });
  return true;
}
function loadPersistedLocalLibraryIntoQueue() {
  if (!Array.isArray(persistentLocalLibraryTracks) || !persistentLocalLibraryTracks.length) return false;
  return importLocalAudioSongs(persistentLocalLibraryTracks.map(cloneSong), { mode: 'persistent-library' });
}
var uploadFilePickerActiveUntil = 0;
var uploadFilePickerFocusArmed = false;
var uploadFilePickerFocusTimer = null;
function uploadImportNow() {
  return (window.performance && typeof performance.now === 'function') ? performance.now() : Date.now();
}
function isUploadPanelOpen() {
  var panel = document.getElementById('upload-panel');
  return !!(panel && panel.classList.contains('show'));
}
function pinUploadSearchArea() {
  var area = document.getElementById('search-area');
  if (area && typeof setPeek === 'function') setPeek(area, true, 'search');
}
function ensureUploadActionsVisibleForPanel() {
  var actions = document.getElementById('upload-actions');
  if (!actions) return false;
  try {
    var style = getComputedStyle(actions);
    if (style.display !== 'none' && style.visibility !== 'hidden' && actions.getClientRects().length > 0) {
      return true;
    }
    // 先尝试把搜索区 pin 出来（search 模式切换），让 actions 回到可见状态
    pinUploadSearchArea();
    // 兜底：如果 body/html 的 simple-mode 强制隐藏 upload-actions，临时解除以让面板可显示
    if (document.body && document.body.classList && document.body.classList.contains('simple-mode')) {
      // 仅对 upload-actions 本身做一个可见性兜底，不动 body 的 simple-mode（它管控的是一整套 UI）
      actions.dataset.simpleHiddenFallback = '1';
      actions.style.setProperty('display', 'flex', 'important');
      actions.style.setProperty('visibility', 'visible', 'important');
    }
    style = getComputedStyle(actions);
    return style.display !== 'none';
  } catch (e) {
    return true;
  }
}
function restoreUploadActionsVisibility() {
  var actions = document.getElementById('upload-actions');
  if (actions && actions.dataset && actions.dataset.simpleHiddenFallback === '1') {
    delete actions.dataset.simpleHiddenFallback;
    actions.style.removeProperty('display');
    actions.style.removeProperty('visibility');
  }
}
function keepUploadImportActive(ms) {
  uploadFilePickerActiveUntil = Math.max(uploadFilePickerActiveUntil, uploadImportNow() + (ms || 12000));
  pinUploadSearchArea();
}
function isUploadImportActive() {
  return isUploadPanelOpen() || uploadImportNow() < uploadFilePickerActiveUntil;
}
function clearUploadFilePickerFocusTimer() {
  if (uploadFilePickerFocusTimer) {
    clearTimeout(uploadFilePickerFocusTimer);
    uploadFilePickerFocusTimer = null;
  }
}
function disarmUploadFilePickerFocus() {
  if (!uploadFilePickerFocusArmed) return;
  uploadFilePickerFocusArmed = false;
  window.removeEventListener('focus', handleUploadFilePickerFocus);
}
function handleUploadFilePickerFocus() {
  disarmUploadFilePickerFocus();
  keepUploadImportActive(900);
  clearUploadFilePickerFocusTimer();
  uploadFilePickerFocusTimer = setTimeout(function () {
    uploadFilePickerFocusTimer = null;
    uploadFilePickerActiveUntil = 0;
    if (isUploadPanelOpen()) closeUploadPanel();
  }, 900);
}
function armUploadFilePickerFocus() {
  disarmUploadFilePickerFocus();
  uploadFilePickerFocusArmed = true;
  window.addEventListener('focus', handleUploadFilePickerFocus);
}
function finishUploadFilePicker(closePanel) {
  uploadFilePickerActiveUntil = 0;
  clearUploadFilePickerFocusTimer();
  disarmUploadFilePickerFocus();
  if (closePanel) closeUploadPanel({ keepPicker: true });
}
function ensureUploadLibraryChoice() {
  var panel = document.getElementById('upload-panel');
  if (!panel) return;
  var count = Array.isArray(persistentLocalLibraryTracks) ? persistentLocalLibraryTracks.length : 0;
  var existing = document.getElementById('upload-play-library-btn');
  if (!count) {
    if (existing) existing.remove();
    return;
  }
  var btn = existing;
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'upload-play-library-btn';
    btn.type = 'button';
    btn.className = 'upload-choice';
    btn.onclick = function () {
      closeUploadPanel();
      if (typeof loadPersistedLocalLibraryIntoQueue === 'function') loadPersistedLocalLibraryIntoQueue();
    };
    panel.insertBefore(btn, panel.firstChild);
  }
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2">' +
    '<path d="M9 18V5l12-2v13"/>' +
    '<circle cx="6" cy="18" r="3"/>' +
    '<circle cx="18" cy="16" r="3"/>' +
    '</svg><span><strong>播放本地曲库</strong><small>' + count + ' 首已保存，点此装入队列</small></span>';
}
function openUploadPanel() {
  closeUploadTip(false);
  var actions = document.getElementById('upload-actions');
  var panel = document.getElementById('upload-panel');
  if (!panel) {
    if (typeof showToast === 'function') showToast('导入面板还没准备好，请稍后再试');
    return;
  }
  // 先保证面板的父容器可见（setPeek 把搜索区打开；simple-mode 的 !important 兜底）
  ensureUploadActionsVisibleForPanel();
  ensureUploadLibraryChoice();
  panel.classList.add('show');
  pinUploadSearchArea();
  // 如果兜底后 actions 仍然不可见（极少见），给用户明确提示（而不是静默）
  if (actions) {
    try {
      var style = getComputedStyle(actions);
      if (style.display === 'none') {
        triggerUploadInput('audio');
      }
    } catch (e) { }
  }
}
function closeUploadPanel(opts) {
  opts = opts || {};
  if (!opts.keepPicker) uploadFilePickerActiveUntil = 0;
  var panel = document.getElementById('upload-panel');
  if (panel) panel.classList.remove('show');
  // 关闭面板时把之前为了 simple-mode 兜底写入的 inline 重要样式清理掉
  restoreUploadActionsVisibility();
}
function toggleUploadPanel(event) {
  if (event) event.stopPropagation();
  var panel = document.getElementById('upload-panel');
  if (!panel) return;
  if (panel.classList.contains('show')) closeUploadPanel();
  else openUploadPanel();
}
function triggerUploadInput(kind) {
  var id = kind === 'cover' ? 'cover-input' : (kind === 'folder' ? 'folder-input' : 'file-input');
  var input = document.getElementById(id);
  if (!input) {
    input = document.createElement('input');
    input.type = 'file';
    input.id = id;
    if (kind === 'cover') {
      input.accept = '.jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp';
    } else {
      input.accept = '.mp3,.flac,.wav,.ogg,.m4a,.aac,.opus,audio/mpeg,audio/flac,audio/wav,audio/ogg,audio/mp4,audio/aac';
      if (kind === 'folder') {
        input.setAttribute('webkitdirectory', '');
        input.setAttribute('directory', '');
        input.multiple = true;
      }
    }
    input.style.display = 'none';
    document.body.appendChild(input);
    if (id === 'file-input') {
      fileInput = input;
      input.addEventListener('change', function (e) { handleFiles(e.target.files, { mode: 'audio' }); e.target.value = ''; });
    } else if (id === 'cover-input') {
      coverInput = input;
      input.addEventListener('change', function (e) { handleCoverFiles(e.target.files); e.target.value = ''; });
    } else if (id === 'folder-input') {
      folderInput = input;
      input.addEventListener('change', function (e) { handleFiles(e.target.files, { mode: 'folder' }); e.target.value = ''; });
    }
  }
  keepUploadImportActive(kind === 'folder' ? 120000 : 45000);
  armUploadFilePickerFocus();
  try {
    // 确保 input 在 DOM 中可见（display:none 的 click 也能触发，但部分环境要求元素存在）
    if (!input.isConnected) document.body.appendChild(input);
    input.click();
  } catch (e) {
    console.warn('[LocalImport] failed to open file picker', e);
    if (typeof showToast === 'function') {
      showToast('打开文件选择器失败：可直接把文件拖到窗口里导入');
    }
    finishUploadFilePicker(false);
  }
}
function importLocalAudioSongs(songs, opts) {
  opts = opts || {};
  songs = Array.isArray(songs) ? songs.filter(Boolean) : [];
  if (!songs.length) return false;
  homeForcedOpen = false;
  homeSuppressed = false;
  setHomeControlsLocked(false);
  playQueue = songs.map(cloneSong);
  currentIdx = 0;
  currentLocalSong = null;
  activeRadioContext = null;
  safeRenderQueuePanel('local-import', { scrollCurrent: miniQueueOpen });
  safeShelfRebuild('local-import', true);
  forcePlaybackControlsInteractive();
  updateEmptyHomeVisibility({ forceLoad: false });
  showToast(songs.length > 1 ? ('已导入 ' + songs.length + ' 首本地音乐') : '正在播放本地音乐');
  Promise.resolve(playQueueAt(0, { manual: true })).then(function () {
    if (opts.coverFile && currentIdx === 0 && playQueue[0]) {
      loadCoverFromFile(opts.coverFile, { trackToken: trackSwitchToken, deferHeavy: false, delay: 0, timeout: 260 });
    }
  }).catch(function (e) { console.warn('[LocalImport]', e); });
  return true;
}
function handleCoverFiles(files) {
  finishUploadFilePicker(true);
  var imgFile = firstImageUploadFile(files);
  if (!imgFile) {
    showToast('没有找到可用的封面图片');
    return;
  }
  loadCoverFromFile(imgFile, null);
  updateCustomCoverButton();
}
async function handleFiles(files, opts) {
  finishUploadFilePicker(true);
  opts = opts || {};
  var audioFiles = sortedAudioUploadFiles(files);
  var imgFile = firstImageUploadFile(files);
  if (audioFiles.length) {
    // 批4-D：音频统一走新引擎（File→父文件夹→按文件夹导入，持久化 + mlib/首页条带更新）。
    // 引擎彻底不可用时 importDroppedFilesViaEngine 内部已做会话态播放。
    await importDroppedFilesViaEngine(files);
    return;
  }
  if (imgFile) {
    handleCoverFiles([imgFile]);
    return;
  }
  showToast('没有找到可导入的音乐或封面文件');
}
var fileInput = document.getElementById('file-input');
if (fileInput) fileInput.addEventListener('change', function (e) { handleFiles(e.target.files, { mode: 'audio' }); e.target.value = ''; });
var coverInput = document.getElementById('cover-input');
if (coverInput) coverInput.addEventListener('change', function (e) { handleCoverFiles(e.target.files); e.target.value = ''; });
var folderInput = document.getElementById('folder-input');
if (folderInput) folderInput.addEventListener('change', function (e) { handleFiles(e.target.files, { mode: 'folder' }); e.target.value = ''; });
var lyricFontInput = document.getElementById('lyric-font-input');
if (lyricFontInput) lyricFontInput.addEventListener('change', function (e) { handleLyricFontFiles(e.target.files); e.target.value = ''; });
document.addEventListener('click', function (e) {
  var panel = document.getElementById('upload-panel');
  if (!panel || !panel.classList.contains('show')) return;
  if (e.target && e.target.closest && e.target.closest('#upload-actions')) return;
  closeUploadPanel();
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') closeUploadPanel();
});
var dropOv = document.getElementById('drop-overlay'), dragCount = 0;
document.addEventListener('dragenter', function (e) { e.preventDefault(); dragCount++; dropOv.classList.add('show'); });
document.addEventListener('dragleave', function (e) { e.preventDefault(); dragCount--; if (dragCount <= 0) { dragCount = 0; dropOv.classList.remove('show'); } });
document.addEventListener('dragover', function (e) { e.preventDefault(); });
document.addEventListener('drop', function (e) {
  e.preventDefault(); dragCount = 0; dropOv.classList.remove('show');
  if (e.dataTransfer.files.length) importDroppedFilesViaEngine(e.dataTransfer.files);
});

// ============================================================
//  控制台 — 预设卡片 + 主滑块 + 开关 + 三态
