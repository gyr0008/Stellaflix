const { contextBridge, ipcRenderer, clipboard, webUtils } = require('electron');

contextBridge.exposeInMainWorld('desktopWindow', {
  isDesktop: true,
  minimize: () => ipcRenderer.invoke('desktop-window-minimize'),
  restore: () => ipcRenderer.invoke('desktop-window-restore'),
  toggleMaximize: () => ipcRenderer.invoke('desktop-window-toggle-maximize'),
  toggleFullscreen: () => ipcRenderer.invoke('desktop-window-toggle-fullscreen'),
  exitFullscreenWindowed: () => ipcRenderer.invoke('desktop-window-exit-fullscreen-windowed'),
  getState: () => ipcRenderer.invoke('desktop-window-get-state'),
  getGpuDiagnostics: () => ipcRenderer.invoke('stellaflix-get-gpu-diagnostics'),
  getMemorySnapshot: () => ipcRenderer.invoke('stellaflix-memory-get-snapshot'),
  configureMemoryReduct: (payload) => ipcRenderer.invoke('stellaflix-memory-configure-auto', payload || {}),
  trimAppMemory: (payload) => ipcRenderer.invoke('stellaflix-memory-trim-app', payload || {}),
  purgeSystemMemory: (payload) => ipcRenderer.invoke('stellaflix-memory-purge-system', payload || {}),
  getCacheSettings: () => ipcRenderer.invoke('stellaflix-cache-get-settings'),
  chooseCacheDirectory: () => ipcRenderer.invoke('stellaflix-cache-choose-directory'),
  setCacheSettings: (payload) => ipcRenderer.invoke('stellaflix-cache-set-settings', payload || {}),
  listWallpaperEngineProjects: (payload) => ipcRenderer.invoke('stellaflix-wallpaper-engine-list', payload || {}),
  getWallpaperEngineProjectDetails: (id) => ipcRenderer.invoke('stellaflix-wallpaper-engine-project-details', String(id || '')),
  openWallpaperEngineProjectDetails: (id, target) => ipcRenderer.invoke('stellaflix-wallpaper-engine-open-project-details', {
    id: String(id || ''),
    target: target === 'workshop' ? 'workshop' : 'we',
  }),
  chooseWallpaperEngineDirectory: () => ipcRenderer.invoke('stellaflix-wallpaper-engine-choose-directory'),
  chooseWallpaperEngineProjectFile: () => ipcRenderer.invoke('stellaflix-wallpaper-engine-choose-project-file'),
  removeWallpaperEngineDirectory: (rootId) => ipcRenderer.invoke('stellaflix-wallpaper-engine-remove-directory', String(rootId || '')),
  getWallpaperEngineRuntimeStatus: (payload) => ipcRenderer.invoke('stellaflix-wallpaper-engine-runtime-status', payload || {}),
  startWallpaperEngineScene: (payload) => ipcRenderer.invoke('stellaflix-wallpaper-engine-start-scene', payload || {}),
  reportWallpaperEngineCaptureResult: (payload) => ipcRenderer.invoke('stellaflix-wallpaper-engine-capture-result', payload || {}),
  prepareWallpaperEngineGlassCapture: (payload) => ipcRenderer.invoke('stellaflix-wallpaper-engine-prepare-glass-capture', payload || {}),
  activateWallpaperEngineDwmSurface: (payload) => ipcRenderer.invoke('stellaflix-wallpaper-engine-activate-dwm-surface', payload || {}),
  updateWallpaperEngineGlassSurface: (payload) => ipcRenderer.send('stellaflix-wallpaper-engine-glass-surface', payload || {}),
  reportWallpaperEnginePointerActivity: (payload) => ipcRenderer.send('stellaflix-wallpaper-engine-pointer-activity', payload || {}),
  stopWallpaperEngineScene: (payload) => ipcRenderer.invoke('stellaflix-wallpaper-engine-stop-scene', payload || {}),
  onWallpaperEngineHostBoundsChanged: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('stellaflix-wallpaper-engine-host-bounds-changed', listener);
    return () => ipcRenderer.removeListener('stellaflix-wallpaper-engine-host-bounds-changed', listener);
  },
  listLocalMusicLibrary: () => ipcRenderer.invoke('stellaflix-local-library-list'),
  readLocalMusicLyric: (localFileId) => ipcRenderer.invoke('stellaflix-local-library-lyric', String(localFileId || '')),
  importLocalMusicFiles: async (files) => {
    const entries = [];
    for (const file of Array.from(files || [])) {
      let filePath = '';
      try {
        filePath = webUtils && typeof webUtils.getPathForFile === 'function' ? webUtils.getPathForFile(file) : '';
      } catch (_) {}
      if (!filePath) continue;
      entries.push({
        path: filePath,
        relativePath: String(file && (file.webkitRelativePath || file.name) || ''),
      });
    }
    if (!entries.length) return { ok: false, count: 0, tracks: [], error: 'NO_AUTHORIZED_LOCAL_AUDIO' };
    const authorization = await ipcRenderer.invoke('stellaflix-local-library-authorize', { files: entries });
    if (!authorization || authorization.ok !== true || !authorization.token) return authorization;
    return ipcRenderer.invoke('stellaflix-local-library-import', { token: authorization.token });
  },
  readLyricCache: (key) => ipcRenderer.invoke('stellaflix-cache-read-lyric', key || ''),
  writeLyricCache: (key, payload) => ipcRenderer.invoke('stellaflix-cache-write-lyric', key || '', payload || {}),
  close: (behavior) => ipcRenderer.invoke('desktop-window-close', behavior),
  getCloseBehavior: () => ipcRenderer.invoke('desktop-window-get-close-behavior'),
  setCloseBehavior: (behavior) => ipcRenderer.invoke('desktop-window-set-close-behavior', behavior),
  openNeteaseMusicLogin: () => ipcRenderer.invoke('netease-music-open-login'),
  clearNeteaseMusicLogin: () => ipcRenderer.invoke('netease-music-clear-login'),
  openQQMusicLogin: (options) => ipcRenderer.invoke('qq-music-open-login', options || {}),
  clearQQMusicLogin: () => ipcRenderer.invoke('qq-music-clear-login'),
  openKugouMusicLogin: () => ipcRenderer.invoke('kugou-music-open-login'),
  clearKugouMusicLogin: () => ipcRenderer.invoke('kugou-music-clear-login'),
  clearQishuiMusicLogin: () => ipcRenderer.invoke('qishui-music-clear-login'),
  openSpotifyMusicLogin: () => ipcRenderer.invoke('spotify-music-open-login'),
  clearSpotifyMusicLogin: () => ipcRenderer.invoke('spotify-music-clear-login'),
  openUpdatePage: (url) => ipcRenderer.invoke('stellaflix-open-update-page', String(url || '')),
  updateCheck: () => ipcRenderer.invoke('stellaflix-update-check'),
  updateDownload: () => ipcRenderer.invoke('stellaflix-update-download'),
  updateInstall: () => ipcRenderer.invoke('stellaflix-update-install'),
  updateStatus: () => ipcRenderer.invoke('stellaflix-update-status'),
  onUpdateEvent: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('stellaflix-update-event', listener);
    return () => ipcRenderer.removeListener('stellaflix-update-event', listener);
  },
  restartApp: () => ipcRenderer.invoke('stellaflix-restart-app'),
  configureGlobalHotkeys: (bindings) => ipcRenderer.invoke('stellaflix-hotkeys-configure-global', bindings || []),
  copyText: (text) => {
    clipboard.writeText(String(text || ''));
    return { ok: true };
  },
  readText: () => ({ ok: true, text: clipboard.readText() || '' }),
  exportJsonFile: (payload) => ipcRenderer.invoke('stellaflix-export-json-file', payload || {}),
  exportLoginCookie: (provider) => ipcRenderer.invoke('stellaflix-export-login-cookie', provider || ''),
  importJsonFile: () => ipcRenderer.invoke('stellaflix-import-json-file'),
  readCurrentFxAutosave: () => ipcRenderer.invoke('stellaflix-current-fx-autosave-read'),
  // Legacy names kept so older call sites do not throw; both are async now.
  readCurrentFxAutosaveSync: () => ipcRenderer.invoke('stellaflix-current-fx-autosave-read'),
  saveCurrentFxAutosaveSync: (payload) => ipcRenderer.invoke('stellaflix-current-fx-autosave-save', payload || {}),
  saveCurrentFxAutosave: (payload) => ipcRenderer.invoke('stellaflix-current-fx-autosave-save', payload || {}),
  onGlobalHotkey: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('stellaflix-global-hotkey', listener);
    return () => ipcRenderer.removeListener('stellaflix-global-hotkey', listener);
  },
  setDesktopLyricsEnabled: (enabled, payload) => ipcRenderer.invoke('stellaflix-desktop-lyrics-set-enabled', !!enabled, payload || {}),
  updateDesktopLyrics: (payload) => ipcRenderer.invoke('stellaflix-desktop-lyrics-update', payload || {}),
  onDesktopLyricsLockState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('stellaflix-desktop-lyrics-lock-state', listener);
    return () => ipcRenderer.removeListener('stellaflix-desktop-lyrics-lock-state', listener);
  },
  onDesktopLyricsEnabledState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('stellaflix-desktop-lyrics-enabled-state', listener);
    return () => ipcRenderer.removeListener('stellaflix-desktop-lyrics-enabled-state', listener);
  },
  setWallpaperMode: (enabled, payload) => ipcRenderer.invoke('stellaflix-wallpaper-set-enabled', !!enabled, payload || {}),
  updateWallpaperMode: (payload) => ipcRenderer.invoke('stellaflix-wallpaper-update', payload || {}),
  getWallpaperModeStatus: () => ipcRenderer.invoke('stellaflix-wallpaper-get-status'),
  updateDesktopIconShields: (payload) => ipcRenderer.send('stellaflix-full-desktop-icon-shields', payload || {}),
  setDesktopSoftwareLocked: (locked) => ipcRenderer.invoke('stellaflix-full-desktop-set-software-lock', locked === true),
  setDesktopIconsVisible: (visible) => ipcRenderer.invoke('stellaflix-full-desktop-set-icons-visible', visible !== false),
  requestDesktopKeyboardFocus: (reason) => ipcRenderer.invoke(
    'stellaflix-full-desktop-request-keyboard-focus',
    String(reason || 'renderer-pointerdown').slice(0, 80)
  ),
  updateDesktopPointerRoute: (payload) => ipcRenderer.send('stellaflix-full-desktop-pointer-route', {
    overSoftwareUi: payload && payload.overSoftwareUi === true,
    overDesktopControls: payload && payload.overDesktopControls === true,
  }),
  onWallpaperModeState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('stellaflix-wallpaper-runtime-state', listener);
    return () => ipcRenderer.removeListener('stellaflix-wallpaper-runtime-state', listener);
  },
  onStateChange: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('desktop-window-state', listener);
    return () => ipcRenderer.removeListener('desktop-window-state', listener);
  },
  // ── 影视态桥接：海报持久化 / 海报缓存 / 媒体直链嗅探 ──
  videoPoster: (action, payload) => ipcRenderer.invoke('stellaflix-video-poster', action, payload || null),
  posterCache: (action, payload) => ipcRenderer.invoke('stellaflix-poster-cache', action, payload || null),
  resolveMediaSniff: (url, opts) => ipcRenderer.invoke('stellaflix-resolve-media-sniff', Object.assign({ url: url }, opts || {})),
  // ── T-双态独立海报：通用媒体选择器（图片 + 视频） ──
  pickMedia: (mode) => ipcRenderer.invoke('stellaflix-pick-media', (mode === 'video' || mode === 'any') ? mode : 'image'),
  pickImage: () => ipcRenderer.invoke('stellaflix-pick-media', 'image'),
  pickVideo: () => ipcRenderer.invoke('stellaflix-pick-media', 'video'),
  fileToBlob: (absolutePath) => ipcRenderer.invoke('stellaflix-file-to-blob', String(absolutePath || '')),
  // ── 第三方音源（custom-source / 青听音乐） ──
  customSource: {
    isSupported: true,
    getState: () => ipcRenderer.invoke('STELLAFLIX_CUSTOM_SOURCE_GET_STATE'),
    listInstalled: () => ipcRenderer.invoke('STELLAFLIX_CUSTOM_SOURCE_LIST_INSTALLED'),
    listAvailableBundled: () => ipcRenderer.invoke('STELLAFLIX_CUSTOM_SOURCE_LIST_AVAILABLE_BUNDLED'),
    importScriptFromUrl: (url) => ipcRenderer.invoke('STELLAFLIX_CUSTOM_SOURCE_IMPORT_SCRIPT_URL', String(url || '')),
    importScriptFromText: (text) => ipcRenderer.invoke('STELLAFLIX_CUSTOM_SOURCE_IMPORT_SCRIPT_TEXT', String(text || '')),
    enable: (pkgId) => ipcRenderer.invoke('STELLAFLIX_CUSTOM_SOURCE_ENABLE', String(pkgId || '')),
    disable: (pkgId) => ipcRenderer.invoke('STELLAFLIX_CUSTOM_SOURCE_DISABLE', String(pkgId || '')),
    installBundled: (pkgId) => ipcRenderer.invoke('STELLAFLIX_CUSTOM_SOURCE_INSTALL_BUNDLED', String(pkgId || '')),
    remove: (pkgId) => ipcRenderer.invoke('STELLAFLIX_CUSTOM_SOURCE_REMOVE', String(pkgId || '')),
    parsePreviewFromText: (text) => ipcRenderer.invoke('STELLAFLIX_CUSTOM_SOURCE_PARSE_PREVIEW', String(text || '')),
    getPolicy: () => ipcRenderer.invoke('STELLAFLIX_CUSTOM_SOURCE_GET_POLICY'),
    setPolicy: (patch) => ipcRenderer.invoke('STELLAFLIX_CUSTOM_SOURCE_SET_POLICY', patch && typeof patch === 'object' ? patch : {}),
    checkUpdates: () => ipcRenderer.invoke('STELLAFLIX_CUSTOM_SOURCE_CHECK_UPDATES'),
    openScriptDirectory: () => ipcRenderer.invoke('STELLAFLIX_CUSTOM_SOURCE_OPEN_SCRIPT_DIRECTORY'),
    // 解析后端地址（用户自填的 musicserver 类端点）
    getBackend: () => ipcRenderer.invoke('STELLAFLIX_CUSTOM_SOURCE_GET_BACKEND'),
    setBackend: (patch) => ipcRenderer.invoke('STELLAFLIX_CUSTOM_SOURCE_SET_BACKEND', patch && typeof patch === 'object' ? patch : {}),
    // 播放链路直通解析（绕开 HTTP 路由，保证第三方音源模式可用）
    resolveOnline: (payload) => ipcRenderer.invoke('STELLAFLIX_CUSTOM_SOURCE_RESOLVE_ONLINE', payload && typeof payload === 'object' ? payload : {}),
    onEvent: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_e, payload) => callback(payload || {});
      ipcRenderer.on('STELLAFLIX_CUSTOM_SOURCE_EVENT', listener);
      return () => ipcRenderer.removeListener('STELLAFLIX_CUSTOM_SOURCE_EVENT', listener);
    },
    onLog: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_e, payload) => callback(payload || {});
      ipcRenderer.on('STELLAFLIX_CUSTOM_SOURCE_LOG', listener);
      return () => ipcRenderer.removeListener('STELLAFLIX_CUSTOM_SOURCE_LOG', listener);
    },
    onStateChange: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_e, payload) => callback(payload || {});
      ipcRenderer.on('STELLAFLIX_CUSTOM_SOURCE_STATE_CHANGE', listener);
      ipcRenderer.on('STELLAFLIX_CUSTOM_SOURCE_REFRESH_ACTIVATION', listener);
      return () => {
        ipcRenderer.removeListener('STELLAFLIX_CUSTOM_SOURCE_STATE_CHANGE', listener);
        ipcRenderer.removeListener('STELLAFLIX_CUSTOM_SOURCE_REFRESH_ACTIVATION', listener);
      };
    },
  },
});

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.classList.add('desktop-shell-root');
  document.body.classList.add('desktop-shell');
});

// 影视态 preload（暴露 window.stellaflixVideo 命名空间）
try {
  require('./preload-video');
} catch (e) {
  console.warn('[StellaflixVideo] preload-video 加载失败:', e && e.message || e);
}
