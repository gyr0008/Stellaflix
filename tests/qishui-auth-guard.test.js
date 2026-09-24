'use strict';

/**
 * qishui-auth-v6 运行期守卫测试（2026-09-24 防御性加固）
 * 运行：node --test tests/qishui-auth-guard.test.js
 *
 * 背景：qishui-auth-v6 被链式顶层 require（server.js → qishui-qr-login → 本模块），
 * 修复前顶层 require('electron') 在纯 Node（npm test / CI）下直接
 * Cannot find module 炸掉整条链，连 mock 注入的 qr-login 测试都被拖死。
 *
 * 覆盖：
 * 1) 模块加载零副作用：纯 Node 下 require 成功且导出完整
 * 2) 惰性守卫：真正发起 QR 流程时抛 QS_AUTH_ELECTRON_UNAVAILABLE（带 code，可被路由透传）
 * 3) 静态断言：无顶层 electron/qrcode require
 * 4) 依赖闭环：qishui-qr-login 在纯 Node 下可加载（bridge 可构造）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appRoot = path.join(__dirname, '..');
const authSource = fs.readFileSync(path.join(appRoot, 'qishui-auth-v6.js'), 'utf8');

test('修复前对照记录：顶层 require electron 在纯 Node 下必炸（当前用例守护不再发生）', () => {
  // 顶层（函数体外）不允许出现 electron/qrcode 的直接 require
  // 更稳的判定：所有 require('electron') 必须出现在 getElectron 函数体内
  const occurrences = [...authSource.matchAll(/require\('electron'\)/g)]
    .filter(m => {
      const lineStart = authSource.lastIndexOf('\n', m.index) + 1;
      const line = authSource.slice(lineStart, authSource.indexOf('\n', m.index));
      return !line.trim().startsWith('//'); // 排除注释里的字样
    });
  assert.ok(occurrences.length >= 1, '应至少有一处 electron require（惰性 getter 内）');
  const getElectronStart = authSource.indexOf('function getElectron()');
  const getElectronEnd = authSource.indexOf('function getQRCode()');
  assert.ok(getElectronStart > -1 && getElectronEnd > getElectronStart, 'getElectron 惰性 getter 应存在');
  occurrences.forEach(m => {
    assert.ok(m.index > getElectronStart && m.index < getElectronEnd,
      `require('electron') 出现在 ${m.index}，必须限定在 getElectron() 函数体内`);
  });
  const qrcodeOccurrences = [...authSource.matchAll(/require\('qrcode'\)/g)]
    .filter(m => {
      const lineStart = authSource.lastIndexOf('\n', m.index) + 1;
      const line = authSource.slice(lineStart, authSource.indexOf('\n', m.index));
      return !line.trim().startsWith('//'); // 排除注释里的字样
    });
  const getQrStart = authSource.indexOf('function getQRCode()');
  assert.ok(getQrStart > -1, 'getQRCode 惰性 getter 应存在');
  qrcodeOccurrences.forEach(m => {
    // require('qrcode') 必须在 getQRCode 函数体内（下一个 function 边界之前）
    const nextFn = authSource.indexOf('\nfunction ', getQrStart + 10);
    assert.ok(m.index > getQrStart && (nextFn === -1 || m.index < nextFn),
      `require('qrcode') 出现在 ${m.index}，必须限定在 getQRCode() 函数体内`);
  });
});

test('模块加载零副作用：纯 Node 下 require 成功且导出完整', () => {
  const mod = require(path.join(appRoot, 'qishui-auth-v6'));
  assert.strictEqual(typeof mod.configure, 'function');
  assert.strictEqual(typeof mod.getQrCode, 'function');
  assert.strictEqual(typeof mod.checkQrConnect, 'function');
  assert.strictEqual(typeof mod.clear, 'function');
  delete require.cache[require.resolve(path.join(appRoot, 'qishui-auth-v6'))];
});

test('惰性守卫：纯 Node 下调用 QR 流程抛 QS_AUTH_ELECTRON_UNAVAILABLE', async () => {
  const mod = require(path.join(appRoot, 'qishui-auth-v6'));
  // configure 一个能返回合法 identity 的 hook（绕开 QISHUI_V6_AUTH_NOT_CONFIGURED，直达 electron 守卫）
  mod.configure({
    getConfig: () => ({ deviceId: 'd1', installId: 'i1', verifyPortraitId: '', computerName: 'PC', cookie: '', msToken: '' }),
    updateConfig: () => {},
  });
  await assert.rejects(
    () => mod.getQrCode(),
    (err) => err && err.code === 'QS_AUTH_ELECTRON_UNAVAILABLE',
    '纯 Node 下 getQrCode 应抛带 code 的明确错误而非 Cannot find module'
  );
  delete require.cache[require.resolve(path.join(appRoot, 'qishui-auth-v6'))];
});

test('依赖闭环：qishui-qr-login 在纯 Node 下可加载', () => {
  const qrLogin = require(path.join(appRoot, 'qishui-qr-login'));
  assert.strictEqual(typeof qrLogin.createQishuiQrLoginBridge, 'function');
  assert.strictEqual(typeof qrLogin.getStatus, 'function');
  const status = qrLogin.getStatus();
  assert.strictEqual(status.provider, 'qishui');
  delete require.cache[require.resolve(path.join(appRoot, 'qishui-qr-login'))];
});
