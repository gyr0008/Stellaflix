/*
 * Stellaflix — 内联事件处理器全局函数补挂 (2026-09-12)
 *
 * 背景（已实测确认，非推测）：
 *   index-loader.js 把全部模块源码拼进一个外层 `try { ... } catch` 块执行。
 *   ECMAScript 规范 Annex B.3.3 的「块级函数声明 web 兼容语义」只覆盖
 *   FunctionDeclaration，**不覆盖 AsyncFunctionDeclaration**：
 *     - sloppy mode: try { function f(){} }      → typeof f === 'function'（泄漏到全局，符合预期）
 *     - sloppy mode: try { async function af(){} } → typeof af === 'undefined'（不泄漏）
 *   index-loader.js:156-168 的注释只考虑了普通 function，因此所有「async function
 *   声明 + HTML 内联 onclick/onchange 调用」的组合都会抛
 *   `ReferenceError: xxx is not defined`。
 *
 * 本模块放在 modulePaths 末尾，运行时机在所有声明之后、同一 try 块作用域内，
 * 因此可以直接读到那些块级 async 函数并显式挂到 window。
 *
 * 维护约定：新增「被 HTML 内联 handler 调用的 async function」时，把函数名加进
 * 下面的清单即可；`outputs/audit-inline-onclick-globals.js` 会静态校验覆盖率。
 */
try {
  if (typeof togglePlay === 'function') window.togglePlay = togglePlay;
  // playQueueAt 同为 async 声明不泄漏；agent-adapter.js / agent-music-tools.js 是独立
  // <script>（AI 助手委托主播放通道），只能经 window 拿到它。
  if (typeof playQueueAt === 'function') window.playQueueAt = playQueueAt;
  if (typeof showLoginModal === 'function') window.showLoginModal = showLoginModal;
  if (typeof submitQQCookieLogin === 'function') window.submitQQCookieLogin = submitQQCookieLogin;
  if (typeof confirmCookieExportPrompt === 'function') window.confirmCookieExportPrompt = confirmCookieExportPrompt;
  if (typeof logoutActiveAccount === 'function') window.logoutActiveAccount = logoutActiveAccount;
  if (typeof logoutAllAccountsAndResetEasterEgg === 'function') window.logoutAllAccountsAndResetEasterEgg = logoutAllAccountsAndResetEasterEgg;
  if (typeof startUpdatePreviewDownload === 'function') window.startUpdatePreviewDownload = startUpdatePreviewDownload;
  if (typeof refreshUserPlaylists === 'function') window.refreshUserPlaylists = refreshUserPlaylists;
  if (typeof refreshAudioOutputDevices === 'function') window.refreshAudioOutputDevices = refreshAudioOutputDevices;
  if (typeof clearHomeDashboardVideo === 'function') window.clearHomeDashboardVideo = clearHomeDashboardVideo;
  if (typeof startLocalBeatAnalysis === 'function') window.startLocalBeatAnalysis = startLocalBeatAnalysis;
  if (typeof openWallpaperEngineLibrary === 'function') window.openWallpaperEngineLibrary = openWallpaperEngineLibrary;
  if (typeof chooseWallpaperEngineProjectFile === 'function') window.chooseWallpaperEngineProjectFile = chooseWallpaperEngineProjectFile;
  if (typeof chooseWallpaperEngineDirectory === 'function') window.chooseWallpaperEngineDirectory = chooseWallpaperEngineDirectory;
  if (typeof refreshWallpaperEngineLibrary === 'function') window.refreshWallpaperEngineLibrary = refreshWallpaperEngineLibrary;
  if (typeof launchWallpaperEngineProjectDetails === 'function') window.launchWallpaperEngineProjectDetails = launchWallpaperEngineProjectDetails;
  // persistentLocalLibraryTracks 是被整体重新赋值的 var，静态挂值会失效，须经 getter 读取。
  window.getStellaflixPersistentLocalLibraryTracks = function () {
    return typeof persistentLocalLibraryTracks !== 'undefined' && Array.isArray(persistentLocalLibraryTracks)
      ? persistentLocalLibraryTracks : [];
  };
} catch (e) {
  try { console.error('[Startup] expose-inline-globals failed:', e); } catch (e2) {}
}
