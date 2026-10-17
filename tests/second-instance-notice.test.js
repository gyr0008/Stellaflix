'use strict';

/**
 * tests/second-instance-notice.test.js — 二次实例在「首实例还没建窗口」阶段要有可见反馈（D 方案）
 *
 * 实测事实（h152 取证）：首实例仍在端口探测/服务端启动阶段时二次启动，
 * 第二个进程 243ms 静默 exit(0)；首实例的 second-instance 处理器调用 focusMainWindow()，
 * 而 mainWindow 还是 null → 直接 return false（desktop/main.js:2061）。
 * 用户看到的现象 = 「双击图标，闪一下就没了」。
 *
 * 契约（desktop/main.js 源约 + 纯文案层 desktop/second-instance-notice.js 单测）：
 *   ① second-instance 处理器必须接住 focusMainWindow() 的返回值
 *   ② 聚焦失败（窗口尚未创建/已销毁）时，必须给出可见提示，而不是只剩 stderr 一行日志
 *   ③ 提示要去重：连点 5 次图标只出现一个弹窗，不得叠一层
 *   ④ 提示文案必须说明「已在启动/已有实例在运行」，并给出可操作项（我知道了）
 *   ⑤ 绝不允许因为二次实例而 taskkill、也不允许绕过单实例锁另开窗口
 *
 * 运行：node --test tests/second-instance-notice.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const mainText = fs.readFileSync(path.join(ROOT, 'desktop', 'main.js'), 'utf8');
const notice = require('../desktop/second-instance-notice.js');

test('①② second-instance 处理器接住聚焦结果，失败时走可见提示', () => {
  const block = mainText.slice(
    mainText.indexOf("app.on('second-instance'"),
    mainText.indexOf('app.whenReady().then(async () => {', mainText.indexOf("app.on('second-instance'"))
  );
  assert.ok(block.length > 50, '必须能定位 second-instance 处理器');
  assert.match(block, /const\s+\w+\s*=\s*focusMainWindow\(\)/, '必须接住 focusMainWindow() 的返回值');
  assert.match(block, /notifySecondInstanceWhileStarting/, '聚焦失败时必须调用可见提示');
});

test('③ 提示层带去重闸门（连点只弹一个）', () => {
  const fnText = mainText.slice(
    mainText.indexOf('function notifySecondInstanceWhileStarting'),
    mainText.indexOf('function notifySecondInstanceWhileStarting') + 1800
  );
  assert.ok(fnText.length > 100, 'main.js 必须定义 notifySecondInstanceWhileStarting');
  assert.match(fnText, /secondInstanceNoticeVisible|noticeVisible/, '必须有「已弹过」状态位');
  assert.match(fnText, /showMessageBox/, '必须真的弹窗（不能只 console.log）');
  assert.doesNotMatch(fnText, /taskkill/, '提示路径不得杀进程');
});

test('④ 文案说明已在启动，并给出可操作按钮', () => {
  const spec = notice.buildNotice({ port: 3000, elapsedMs: 1200 });
  assert.match(spec.message, /正在启动|已在启动|已经打开|已运行/);
  assert.ok(Array.isArray(spec.buttons) && spec.buttons.length >= 1);
  assert.match(spec.buttons.join('|'), /知道了|好嘞|确定/);
  assert.equal(spec.type, 'info', '这是提示不是警告，不该用红色图标吓用户');
  assert.ok(spec.noLink === true);
});

test('④ 端口锁等待阶段单独说明「正在等其他实例让出端口」', () => {
  const spec = notice.buildNotice({ port: 3000, stage: 'port-lock' });
  assert.match(spec.detail, /端口/);
  assert.match(spec.detail, /3000/);
});

test('④ elapsedMs 取整且非法值不炸', () => {
  assert.equal(notice.buildNotice({ port: 3000, elapsedMs: 1234.9 }).elapsedText, '1.2 秒');
  const bad = notice.buildNotice({ port: 3000, elapsedMs: NaN });
  assert.equal(typeof bad.message, 'string');
  assert.equal(bad.elapsedText, '');
});

test('⑤ 纯层不依赖 electron', () => {
  const src = fs.readFileSync(path.join(ROOT, 'desktop', 'second-instance-notice.js'), 'utf8');
  assert.doesNotMatch(src, /require\('electron'\)/);
});
