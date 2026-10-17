'use strict';

/**
 * 「退出登录」（全部退出）账号复活 bug（2026-10-17）。
 *
 * 根因：logoutAllAccountsAndResetEasterEgg 只打 5 个服务端 logout 接口（把
 * cookie 文件清零），从不清 Electron 登录分区（persist:stellaflix-*-login）。
 * 分区里的原始 cookie 还在 → 下次点「登录」时 openNeteaseMusicLoginWindow 命中
 * reused 短路（desktop/main.js:2624），窗口都不弹就抓回 cookie 重新落盘，
 * 用户感知为"删了账号，一点就复活"。
 *
 * 单平台退出 logoutActiveAccount 每条分支都调 desktopWindow.clear*，
 * 本测试把同一契约钉到"全部退出"路径上。
 *
 * 运行：node --test tests/logout-all-clears-desktop-sessions.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(
  path.join(ROOT, 'public', 'js', 'modules', '08-account', '04-user-modal-logout.js'),
  'utf8'
);

const CLEAR_METHODS = [
  'clearNeteaseMusicLogin',
  'clearQQMusicLogin',
  'clearKugouMusicLogin',
  'clearQishuiMusicLogin',
  'clearSpotifyMusicLogin',
];

function loadModule(desktopWindow) {
  const logoutCalls = [];
  const clearCalls = [];
  const toasts = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    document: { getElementById: () => null, addEventListener() {} },
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    clearTimeout,
    showToast: (m) => toasts.push(m),
    apiJson: (url) => {
      logoutCalls.push(url);
      return Promise.resolve({ ok: true });
    },
    Promise, Date, Math, JSON, RegExp, String, Number, Object, Array, Error, Set, Map,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.desktopWindow = Object.assign({}, desktopWindow || {});
  CLEAR_METHODS.forEach(function (method) {
    if (!(method in sandbox.desktopWindow)) {
      sandbox.desktopWindow[method] = () => { clearCalls.push(method); return Promise.resolve({ ok: true }); };
    }
  });
  // resetAllProviderRendererLoginState / 收尾调用链需要的运行时全局（其它模块的声明）
  sandbox.playlistCatalogRevision = 0;
  sandbox.miniQueueOpen = false;
  sandbox.closeCollectModal = () => {};
  sandbox.closeGsapModal = () => {};
  sandbox.closeUserModal = () => {};
  sandbox.closeLoginModal = () => {};
  sandbox.updateLikeButtons = () => {};
  sandbox.safeRenderQueuePanel = () => {};
  sandbox.renderUserBtn = () => {};
  sandbox.safeShelfRebuild = () => {};
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  // 已进入"二次点击确认"状态，跳过 arm 分支
  sandbox.logoutAllAccountsResetConfirmUntil = Date.now() + 5000;
  return { sandbox, logoutCalls, clearCalls, toasts };
}

// ---------------------------------------------------------------- 分区清理契约

test('全部退出：清完 5 个服务端 cookie 后必须清全部 5 个 Electron 登录分区', async () => {
  const { sandbox, logoutCalls, clearCalls, toasts } = loadModule();
  await sandbox.logoutAllAccountsAndResetEasterEgg();
  assert.deepStrictEqual(logoutCalls, [
    '/api/logout', '/api/qq/logout', '/api/kugou/logout', '/api/qishui/logout', '/api/spotify/logout',
  ], '服务端 logout 顺序不变');
  CLEAR_METHODS.forEach(function (method) {
    assert.ok(clearCalls.includes(method), method + ' 必须被调用——分区原件不清，下次点登录会 reused 短路秒登复活账号');
  });
  assert.ok(toasts.includes('已退出全部账号'), toasts.join('|'));
});

test('全部退出：单个分区 clear 抛错不中断流程（allSettled 容错）', async () => {
  const desktopWindow = {
    clearNeteaseMusicLogin: () => Promise.reject(new Error('分区被占用')),
  };
  const { sandbox, clearCalls, toasts } = loadModule(desktopWindow);
  await sandbox.logoutAllAccountsAndResetEasterEgg();
  assert.strictEqual(clearCalls.length, 4, '网易云 clear 失败后其余 4 个照常清');
  assert.strictEqual(sandbox.loginStatus.loggedIn, false, '内存态照常重置');
  assert.ok(toasts.includes('已退出全部账号'), toasts.join('|'));
});

test('全部退出：非桌面环境（无 desktopWindow 方法）不抛错', async () => {
  const desktopWindow = {};
  CLEAR_METHODS.forEach(function (method) { desktopWindow[method] = undefined; });
  const { sandbox, toasts } = loadModule(desktopWindow);
  await sandbox.logoutAllAccountsAndResetEasterEgg();
  assert.ok(toasts.includes('已退出全部账号'), toasts.join('|'));
});
