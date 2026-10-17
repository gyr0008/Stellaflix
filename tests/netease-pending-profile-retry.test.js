'use strict';

/**
 * 网易云「临时档案」不刷新 bug（2026-10-17）· 渲染层部分。
 *
 * 根因链：桌面分区秒登 reused 抓回旧 cookie → POST /api/login/cookie 时服务端
 * 向网易云复验超时 → 返回 pendingProfile 兜底档案（nickname:'网易云用户'、无头像无 UID）→
 * openNeteaseWebLogin 直接把它当正式 loginStatus 挂界面，且该路径没有二维码路径
 * （checkQr 1406-1416）那样的延迟重查尾巴；网易云又没有 45s 自动轮询 → 界面永久卡兜底档案。
 *
 * 契约：openNeteaseWebLogin 收到 pendingProfile（或缺 userId）时必须安排一次
 * refreshLoginStatus(true) 延迟重查，成功后用完整资料覆盖 loginStatus。
 *
 * 运行：node --test tests/netease-pending-profile-retry.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(
  path.join(ROOT, 'public', 'js', 'modules', '08-account', '03-login-modal-flows.js'),
  'utf8'
);

const PENDING_INFO = {
  loggedIn: true, pendingProfile: true, nickname: '网易云用户', avatar: '',
  userId: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, vipLabel: '无VIP',
};
const FULL_INFO = {
  loggedIn: true, nickname: 'Pure-gr', avatar: 'https://p3.music.126.net/x/1.jpg',
  userId: 12895532729, vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, vipLabel: '无VIP',
};

function loadModule(cookieResponse, freshResponse) {
  const timers = [];
  const calls = { refreshLoginStatus: [], renderUserBtn: 0, apiJson: [] };
  const qrStatus = { textContent: '', className: '' };
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    document: { getElementById: (id) => (id === 'qr-status' ? qrStatus : null), addEventListener() {} },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    apiJson: (url, opts) => {
      calls.apiJson.push(url);
      if (url === '/api/login/cookie') return Promise.resolve(cookieResponse);
      return Promise.resolve({});
    },
    refreshLoginStatus: (force) => {
      calls.refreshLoginStatus.push(force);
      return Promise.resolve(freshResponse === undefined ? FULL_INFO : freshResponse);
    },
    updateLoginProviderUi: () => {},
    renderUserBtn: () => { calls.renderUserBtn += 1; },
    refreshUserPlaylists: () => {},
    loadHomeDiscover: () => {},
    offerLoginCookieExport: () => {},
    closeLoginModal: () => {},
    showToast: () => {},
    refreshQr: () => {},
    stopQrPoll: () => {},
    Promise, Date, Math, JSON, RegExp, String, Number, Object, Array, Error, Set, Map, encodeURIComponent,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.neteaseWebLoginBusy = false;
  sandbox.desktopWindow = { isDesktop: true, openNeteaseMusicLogin: () => Promise.resolve({ ok: true, cookie: 'MUSIC_U=test' }) };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  // 模块自身声明的 UI 函数覆盖沙箱桩，加载后统一换成空实现
  sandbox.updateLoginProviderUi = () => {};
  sandbox.offerLoginCookieExport = () => {};
  return { sandbox, timers, calls, qrStatus };
}

async function flush() {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
}

test('桌面窗口登录拿到 pendingProfile：必须延迟重查并用完整资料覆盖 loginStatus', async () => {
  const { sandbox, timers, calls } = loadModule(PENDING_INFO);
  await sandbox.openNeteaseWebLogin();
  assert.strictEqual(sandbox.loginStatus.nickname, '网易云用户', '先挂兜底档案保证即时反馈');
  const retry = timers.find((t) => t.ms > 420 && t.ms <= 3000);
  assert.ok(retry, 'pendingProfile 时必须排一次 ≤3s 的 refreshLoginStatus 重查（对齐 checkQr 的 1200ms 尾巴）');
  retry.fn();
  await flush();
  assert.deepStrictEqual(calls.refreshLoginStatus, [true], '重查必须 force=true 绕开前端节流');
  assert.strictEqual(sandbox.loginStatus.nickname, 'Pure-gr', '重查成功后界面资料要转正');
  assert.strictEqual(sandbox.loginStatus.userId, 12895532729);
  assert.ok(!sandbox.loginStatus.pendingProfile, '转正后要摘掉 pendingProfile 标记');
});

test('桌面窗口登录直接拿到完整资料：不排重查', async () => {
  const { sandbox, timers, calls } = loadModule(FULL_INFO);
  await sandbox.openNeteaseWebLogin();
  assert.strictEqual(sandbox.loginStatus.nickname, 'Pure-gr');
  assert.strictEqual(calls.refreshLoginStatus.length, 0, '资料完整就不要多打一枪');
  assert.ok(!timers.some((t) => t.ms > 420 && t.ms <= 3000), '只允许既有的 420ms 关窗定时器');
});

test('重查失败（返回 null）：保留兜底档案但不得抛未捕获异常', async () => {
  const { sandbox, timers, calls } = loadModule(PENDING_INFO, null);
  await sandbox.openNeteaseWebLogin();
  const retry = timers.find((t) => t.ms > 420 && t.ms <= 3000);
  assert.ok(retry, '仍要排重查');
  retry.fn();
  await flush();
  assert.strictEqual(calls.refreshLoginStatus.length, 1);
  assert.strictEqual(sandbox.loginStatus.nickname, '网易云用户', '重查没成功就维持原样，等下次事件');
});
