function stellaflixCacheStorageNode(id) {
  return document.getElementById(id);
}

function formatStellaflixCacheBytes(value) {
  var bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return bytes + ' B';
  var units = ['KB', 'MB', 'GB', 'TB'];
  var index = -1;
  do {
    bytes /= 1024;
    index += 1;
  } while (bytes >= 1024 && index < units.length - 1);
  return (bytes >= 100 || index === 0 ? bytes.toFixed(0) : bytes.toFixed(1)) + ' ' + units[index];
}

function setStellaflixCacheStorageText(id, value) {
  var node = stellaflixCacheStorageNode(id);
  if (node) node.textContent = value == null || value === '' ? '—' : String(value);
}

function applyStellaflixCacheSettings(snapshot) {
  if (!snapshot || !snapshot.ok) {
    setStellaflixCacheStorageText('cache-storage-total', '读取失败');
    setStellaflixCacheStorageText('cache-storage-note', snapshot && snapshot.error ? ('缓存设置不可用：' + snapshot.error) : '缓存设置不可用');
    return;
  }
  var settings = snapshot.settings || {};
  var usage = snapshot.usage || {};
  setStellaflixCacheStorageText('cache-storage-root', settings.rootPath);
  setStellaflixCacheStorageText('cache-storage-total', '已占用 ' + formatStellaflixCacheBytes(usage.totalManagedBytes));
  setStellaflixCacheStorageText('cache-storage-lyrics-path', settings.lyricsPath);
  setStellaflixCacheStorageText('cache-storage-lyrics-size', formatStellaflixCacheBytes(usage.lyricsBytes));
  setStellaflixCacheStorageText('cache-storage-chromium-path', settings.activeChromiumPath || settings.chromiumPath);
  setStellaflixCacheStorageText('cache-storage-chromium-size', formatStellaflixCacheBytes(usage.chromiumBytes));
  setStellaflixCacheStorageText('cache-storage-beatmaps-path', settings.activeBeatmapsPath || settings.beatmapsPath);
  setStellaflixCacheStorageText('cache-storage-beatmaps-size', formatStellaflixCacheBytes(usage.beatmapsBytes));
  setStellaflixCacheStorageText('cache-storage-wallpaper-path', settings.activeWallpaperEnginePath || settings.wallpaperEnginePath);
  setStellaflixCacheStorageText('cache-storage-wallpaper-size', formatStellaflixCacheBytes(usage.wallpaperEngineBytes));
  setStellaflixCacheStorageText('cache-storage-userdata-path', settings.userDataPath || '系统安全数据目录');
  setStellaflixCacheStorageText('cache-storage-userdata-size', formatStellaflixCacheBytes(usage.userDataBytes));
  var restartButton = stellaflixCacheStorageNode('cache-storage-restart');
  if (restartButton) restartButton.hidden = !settings.restartRequired;
  setStellaflixCacheStorageText(
    'cache-storage-note',
    settings.restartRequired
      ? '歌词缓存已切换；封面、网络、音频分片、节奏分析与 WE 静音场景将在重启后改用新目录。'
      : '歌词缓存立即生效；封面、网络、音频分片、节奏分析与 WE 静音场景已使用此目录。'
  );
}

function refreshStellaflixCacheSettings() {
  if (!window.desktopWindow || typeof window.desktopWindow.getCacheSettings !== 'function') {
    applyStellaflixCacheSettings({ ok: false, error: '仅桌面版支持本地缓存路径设置' });
    return Promise.resolve();
  }
  setStellaflixCacheStorageText('cache-storage-total', '正在统计...');
  return window.desktopWindow.getCacheSettings().then(applyStellaflixCacheSettings).catch(function (error) {
    applyStellaflixCacheSettings({ ok: false, error: error && error.message || '读取失败' });
  });
}

function chooseStellaflixCacheRoot() {
  if (!window.desktopWindow || typeof window.desktopWindow.chooseCacheDirectory !== 'function') return;
  window.desktopWindow.chooseCacheDirectory().then(function (choice) {
    if (!choice || !choice.ok || choice.canceled || !choice.rootPath) return;
    return window.desktopWindow.setCacheSettings({ rootPath: choice.rootPath });
  }).then(function (snapshot) {
    if (snapshot) applyStellaflixCacheSettings(snapshot);
  }).catch(function (error) {
    applyStellaflixCacheSettings({ ok: false, error: error && error.message || '保存失败' });
  });
}

function restartStellaflixForCachePath() {
  if (!window.desktopWindow || typeof window.desktopWindow.restartApp !== 'function') return;
  window.desktopWindow.restartApp();
}

setTimeout(refreshStellaflixCacheSettings, 450);
