'use strict';

// electron-updater 集成回归：自动下载 + 静默安装 + 失败降级到外部下载页。
// 与 update-external-only / external-update-page-bridge 两组测试互补：
// 那两组守住「服务端不提供本地下载」，这一组守住「主进程确实接了 electron-updater」。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(appRoot, rel), 'utf8');

const mainText = read('desktop/main.js');
const preloadText = read('desktop/preload.js');
const uiText = read('public/js/modules/08-account/00-update-preview.js');
const stateText = read('public/js/modules/00-state/01-perf-render-state.js');
const serverText = read('server.js');
const packageData = JSON.parse(read('package.json'));

test('electron-updater is a runtime dependency, not a dev dependency', () => {
  assert.equal(packageData.dependencies['electron-updater'], '^6.8.9');
  assert.ok(
    !(packageData.devDependencies && packageData.devDependencies['electron-updater']),
    'electron-updater 必须进 dependencies，否则打包后运行期缺失'
  );
});

test('main process initialises autoUpdater with packaging guard', () => {
  assert.match(mainText, /const \{ autoUpdater \} = require\('electron-updater'\);/);
  assert.match(mainText, /function initAutoUpdater\(\) \{/);
  assert.match(mainText, /initAutoUpdater\(\);/);
  // 未打包环境必须跳过，否则开发环境启动即抛错
  assert.match(mainText, /if \(!app\.isPackaged\) \{/);
  assert.match(mainText, /autoUpdater\.autoDownload = false;/);
  assert.match(mainText, /autoUpdater\.autoInstallOnAppQuit = false;/);
});

test('feed list prefers mirrors, GitHub direct stays as final fallback', () => {
  assert.match(mainText, /function buildUpdaterFeeds\(\) \{/);
  // 2026-09-17 拍板：镜像优先（国内网络下高效），GitHub 直连排最后兜底。
  const mirrorLoop = mainText.indexOf('UPDATE_MIRRORS.forEach');
  const githubPush = mainText.indexOf("label: 'GitHub 直连兜底'");
  assert.ok(mirrorLoop !== -1 && githubPush !== -1 && githubPush > mirrorLoop,
    '镜像 push 必须在 GitHub 直连 push 之前（镜像优先，直连兜底）');
  assert.match(mainText, /provider: 'github', owner: UPDATE_OWNER, repo: UPDATE_REPO/);
  // 兼容两种国内加速前缀（A: 代理前缀拼接 releasePath；B: 已含 github.com 的镜像直拼）
  assert.match(mainText, /const genericUrl = \/github\\\.com\/i\.test\(trimmed\)/);
  assert.match(mainText, /provider: 'generic', url: genericUrl/);
  // owner/repo/mirrors 一律取自 package.json，避免两处配置漂移
  assert.match(mainText, /const UPDATE_OWNER = \(APP_METADATA\.update && APP_METADATA\.update\.owner\)/);
  assert.match(mainText, /const UPDATE_MIRRORS = \(APP_METADATA\.update && Array\.isArray\(APP_METADATA\.update\.mirrors\)\)/);
});

test('feed rotation is centralized in switchUpdaterFeedOrThrow and wired to error + stall watchdog', () => {
  // 2026-09 重构：轮换收敛到 switchUpdaterFeedOrThrow()，error 事件与下载 stall 看门狗共用一条换源路径
  assert.match(mainText, /function switchUpdaterFeedOrThrow\(lastError\) \{/);
  // 轮换条件必须是「还有下一条」，防止越界；换源后重新 setFeedURL 并触发检查
  assert.match(mainText, /if \(updaterFeedIndex < updaterFeeds\.length - 1\) \{/);
  assert.match(mainText, /updaterFeedIndex \+= 1;/);
  assert.match(mainText, /autoUpdater\.setFeedURL\(next\.options\);/);
  // error 事件必须接入轮换（未下载时）；下载中卡死由 watchdog 走同一函数切线
  assert.match(mainText, /autoUpdater\.on\('error', error => \{/);
  assert.match(mainText, /if \(!updaterDownloadAttempted && switchUpdaterFeedOrThrow\(message\)\) \{/);
  assert.match(mainText, /switchUpdaterFeedOrThrow\('stall ' \+ idleMs \+ 'ms'\)/);
});

test('update IPC handlers are registered and sender-trusted', () => {
  ['stellaflix-update-check', 'stellaflix-update-download', 'stellaflix-update-install'].forEach(channel => {
    const escaped = channel.replace(/-/g, '\\-');
    assert.match(mainText, new RegExp("ipcMain\\.handle\\('" + escaped + "', async event => \\{"));
  });
  const trustedCount = mainText.split("if (!isTrustedMainWindowIpc(event)) return { ok: false, error: 'UNTRUSTED_SENDER' };").length - 1;
  assert.ok(trustedCount >= 3, '三个更新 IPC 都必须做发送方校验，实际命中 ' + trustedCount);
});

test('install path is silent, force-restarts, and guarded by downloaded state', () => {
  assert.match(mainText, /autoUpdater\.quitAndInstall\(true, true\);/);
  assert.match(mainText, /if \(updaterState !== 'downloaded'\) return \{ ok: false, error: 'UPDATE_NOT_DOWNLOADED' \};/);
  // 必须延后到 IPC 应答之后，否则渲染进程收不到返回
  assert.match(mainText, /setImmediate\(\(\) => \{\s*\n\s*try \{ autoUpdater\.quitAndInstall\(true, true\); \}/);
});

test('download handler does not pre-check updaterState (avoids event race)', () => {
  const start = mainText.indexOf("ipcMain.handle('stellaflix-update-download'");
  const end = mainText.indexOf("ipcMain.handle('stellaflix-update-install'");
  const body = mainText.slice(start, end);
  assert.ok(start !== -1 && end !== -1 && end > start);
  // 防竞态契约保留：electron-updater 会在 checkForUpdates resolve 之前派发 update-available，
  // handler 内不得校验 updaterState !== 'available'（会与事件时序形成竞态）
  assert.doesNotMatch(body, /updaterState !== 'available'/);
  // 2026-09 重构：下载改为 startUpdaterDownloadAttempt 异步封装（watchdog/stall 检测在函数内），
  // handler 不再直接 await downloadUpdate()，避免 IPC 无限悬挂；实际调用在封装函数内
  assert.match(body, /startUpdaterDownloadAttempt\('ipc-download'\)/);
  assert.match(mainText, /autoUpdater\.downloadUpdate\(\)/);
});

test('progress and status events are forwarded to the renderer', () => {
  assert.match(mainText, /function postUpdateEvent\(payload\) \{/);
  assert.match(mainText, /mainWindow\.webContents\.send\('stellaflix-update-event', payload \|\| \{\}\);/);
  assert.match(mainText, /autoUpdater\.on\('download-progress', progress => \{/);
  assert.match(mainText, /autoUpdater\.on\('update-downloaded', info => \{/);
});

test('preload exposes the full auto-update bridge', () => {
  assert.match(preloadText, /updateCheck: \(\) => ipcRenderer\.invoke\('stellaflix-update-check'\),/);
  assert.match(preloadText, /updateDownload: \(\) => ipcRenderer\.invoke\('stellaflix-update-download'\),/);
  assert.match(preloadText, /updateInstall: \(\) => ipcRenderer\.invoke\('stellaflix-update-install'\),/);
  assert.match(preloadText, /onUpdateEvent: \(callback\) => \{/);
  assert.match(preloadText, /ipcRenderer\.on\('stellaflix-update-event', listener\);/);
  // 订阅必须可退订，避免渲染进程重复监听
  assert.match(preloadText, /return \(\) => ipcRenderer\.removeListener\('stellaflix-update-event', listener\);/);
});

test('renderer keeps an autoUpdate state machine', () => {
  assert.match(stateText, /autoUpdate: \{/);
  assert.match(stateText, /supported: false,/);
  assert.match(stateText, /phase: 'idle',/);
  assert.match(uiText, /function initAutoUpdateBridge\(\) \{/);
  assert.match(uiText, /function handleAutoUpdateEvent\(payload\) \{/);
  assert.match(uiText, /async function requestAutoUpdateDownload\(\) \{/);
  assert.match(uiText, /async function installAutoUpdate\(\) \{/);
  assert.match(uiText, /initAutoUpdateBridge\(\);/);
});

test('main button prefers auto update, explicit mirror choice still opens external page', () => {
  // 已下载 → 直接安装
  assert.match(uiText, /if \(au\.phase === 'downloaded'\) \{\s*\n\s*installAutoUpdate\(\);/);
  // 自动更新可用且未失败 → 交给 electron-updater
  assert.match(uiText, /if \(au\.supported && au\.phase !== 'error'\) \{/);
  assert.match(uiText, /var started = await requestAutoUpdateDownload\(\);/);
  // 失败则落到外链（return 被跳过）
  assert.match(uiText, /if \(started\) return;/);
  // 用户点具体网盘线路时不劫持
  assert.match(uiText, /var explicitPage = Number\.isInteger\(preferredIndex\);/);
  assert.match(uiText, /if \(!explicitPage\) \{/);
});

test('progress drives the existing fill and ring UI instead of always zero', () => {
  assert.match(uiText, /function updateUpdatePreviewProgress\(percent\) \{/);
  assert.match(uiText, /var pct = Math\.max\(0, Math\.min\(100, Number\(percent\) \|\| 0\)\);/);
  assert.match(uiText, /if \(fill\) fill\.style\.width = pct \+ '%';/);
  assert.match(uiText, /55\.29 - \(55\.29 \* pct\) \/ 100/);
  // 进度事件高频，必须只更新进度条而不重建面板
  assert.match(uiText, /updateUpdatePreviewProgress\(au\.percent\);\s*\n\s*syncUpdatePreviewStateClass\(\);\s*\n\s*return;/);
});

test('external download page stays as the regression fallback', () => {
  // 渲染层仍保留跳转能力
  assert.match(uiText, /desktopWindow\.openUpdatePage\(target\)/);
  // 服务端本地下载仍然停用——这两条是 external-only 的护栏，不得被本次改造抹掉
  assert.match(serverText, /error: 'UPDATE_EXTERNAL_ONLY'/);
  assert.match(serverText, /patchAvailable: false/);
  // 自动更新失败时，脚注要说明已改为下载页
  assert.match(uiText, /自动更新不可用/);
});
