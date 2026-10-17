'use strict';

/**
 * tests/port-lock-dialog.test.js — 端口锁弹窗决策层（E 方案）
 *
 * 现状事实（desktop/main.js:583-593）：
 *   buttons: ['结束占用并重试', '退出应用'], defaultId: 0
 * 即 **回车 = 立刻 taskkill 占用进程**。用户手滑按下回车，被杀的可能是一个正在跑的
 * node 服务、别的开发服务器，甚至用户自己另一个程序。弹窗默认值必须落在安全项上。
 *
 * 契约（纯函数 buildPortLockDialog，不依赖 Electron）：
 *   ① defaultId 与 cancelId 永远指向「不杀进程」的那一项，回车/Esc 不会误杀
 *   ② 只有占用者确属本项目自身/残留服务端进程（Stellaflix.exe / electron.exe / node.exe）
 *      才提供「结束占用并重试」；无法识别归属时只给「重试 / 退出应用」
 *   ③ 认不出占用者（非本机监听）时同样不得提供杀进程按钮
 *   ④ 文案里带上占用者 PID 与映像名，用户点之前就知道会杀谁
 *   ⑤ main.js 必须改用这个决策层，不得再硬编码 defaultId: 0 的杀进程按钮
 *
 * 运行：node --test tests/port-lock-dialog.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildPortLockDialog } = require('../desktop/port-lock.js');
const ROOT = path.resolve(__dirname, '..');
const mainText = fs.readFileSync(path.join(ROOT, 'desktop', 'main.js'), 'utf8');

const PORT = 3000;

test('① 占用者可识别时，默认/取消都落在「退出应用」（回车不再误杀）', () => {
  const d = buildPortLockDialog(PORT, { pid: '4321', name: 'node.exe' });
  const killIdx = d.buttons.findIndex((b) => /结束|kill/i.test(b));
  assert.ok(killIdx >= 0, '本项目的残留进程仍应提供结束按钮');
  assert.notEqual(d.defaultId, killIdx, 'defaultId 不得是杀进程项');
  assert.notEqual(d.cancelId, killIdx, 'cancelId 不得是杀进程项');
  assert.equal(d.buttons[d.defaultId], d.buttons[d.cancelId]);
});

test('② 占用者是第三方进程时，根本不提供杀进程按钮', () => {
  for (const name of ['steam.exe', 'chrome.exe', 'spotify.exe', 'SomeServer.exe']) {
    const d = buildPortLockDialog(PORT, { pid: '999', name });
    assert.ok(
      !d.buttons.some((b) => /结束|kill/i.test(b)),
      name + ' 不应给出「结束占用」按钮：' + JSON.stringify(d.buttons)
    );
    assert.ok(d.buttons.some((b) => /重试/.test(b)), '要给无害的重试');
    assert.ok(d.buttons.some((b) => /退出应用/.test(b)));
    assert.equal(d.buttons[d.defaultId], '重试', '默认落在无害的重试上');
    assert.equal(d.cancelId, d.buttons.indexOf('退出应用'));
  }
});

test('② 本项目自身/残留服务端进程才允许提供杀进程项', () => {
  for (const name of ['Stellaflix.exe', 'electron.exe', 'node.exe', 'NODE.EXE']) {
    const d = buildPortLockDialog(PORT, { pid: '12', name });
    assert.ok(
      d.buttons.some((b) => /结束占用/.test(b)),
      name + ' 属于可结束的自身/残留进程：' + JSON.stringify(d.buttons)
    );
  }
});

test('③ 认不出占用者时不得提供杀进程按钮', () => {
  for (const occ of [{ pid: null, name: null }, { pid: '0', name: null }, { pid: '7', name: null }]) {
    const d = buildPortLockDialog(PORT, occ);
    assert.ok(!d.buttons.some((b) => /结束|kill/i.test(b)), JSON.stringify(occ) + ' -> ' + JSON.stringify(d.buttons));
  }
});

test('④ 文案里点明端口、PID 与映像名', () => {
  const d = buildPortLockDialog(PORT, { pid: '4321', name: 'node.exe' });
  const all = d.message + ' ' + d.detail;
  assert.match(all, /3000/);
  assert.match(all, /4321/);
  assert.match(all, /node\.exe/);
  assert.match(all, /换端口|换桶/, '必须解释为什么不能换端口（10-01 数据"消失"事故口径）');
  assert.equal(d.type, 'warning');
});

test('⑤ main.js 改用决策层，不再硬编码 defaultId: 0 的杀进程弹窗', () => {
  assert.match(mainText, /buildPortLockDialog\s*\(/, 'main.js 必须调用 buildPortLockDialog');
  const portBlock = mainText.slice(
    mainText.indexOf('async function acquireLockedPort'),
    mainText.indexOf('function startupDelay')
  );
  assert.ok(portBlock.length > 50, 'acquireLockedPort 函数体必须能定位到');
  assert.doesNotMatch(portBlock, /defaultId:\s*0/, '端口锁弹窗不得再把杀进程设成默认按钮');
  assert.doesNotMatch(portBlock, /buttons:\s*\[\s*'结束占用并重试'/, '按钮组应由决策层给出');
});

test('⑤ 决策层仍是纯函数：不 require electron、不弹窗', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'port-lock.js'), 'utf8');
  assert.doesNotMatch(src, /require\('electron'\)/);
  assert.doesNotMatch(src, /showMessageBox/);
});
