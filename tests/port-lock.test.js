'use strict';

/**
 * desktop/port-lock.js 单元测试（3000 端口硬锁的纯解析层）
 * 运行：node tests/port-lock.test.js
 * 背景：Electron main 无法纯 node 单测（poster-cache/vault 同例），拆纯函数到此模块。
 * 契约：从 netstat -ano 输出取指定端口 LISTENING 行的 PID；取不到返回 null。
 */

const assert = require('assert');
const { parseListeningPid, parseTasklistName } = require('../desktop/port-lock');

let passed = 0;
let failed = 0;
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log('  \u2714 ' + label);
  } catch (e) {
    failed++;
    console.error('  \u2716 ' + label + '\n    ' + (e && e.message));
  }
}

const NETSTAT = [
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1036',
  '  TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       7336',
  '  TCP    127.0.0.1:3001         0.0.0.0:0              LISTENING       9090',
  '  TCP    127.0.0.1:54321        127.0.0.1:3000         ESTABLISHED     4242',
  '  TCP    [::1]:3000             [::1]:54321            ESTABLISHED     7336',
  '  UDP    0.0.0.0:5353           *:*                                    1036',
].join('\r\n');

check('命中 3000 LISTENING 行 PID', () => {
  assert.strictEqual(parseListeningPid(NETSTAT, 3000), '7336');
});

check('不同端口不串（3001 独立命中）', () => {
  assert.strictEqual(parseListeningPid(NETSTAT, 3001), '9090');
});

check('前缀相近不误命中（13000 无人监听→null）', () => {
  assert.strictEqual(parseListeningPid(NETSTAT, 13000), null);
});

check('只认 LISTENING，ESTABLISHED 不算占用者', () => {
  assert.strictEqual(parseListeningPid(NETSTAT, 54321), null);
});

check('空/异常输入返回 null', () => {
  assert.strictEqual(parseListeningPid('', 3000), null);
  assert.strictEqual(parseListeningPid(null, 3000), null);
  assert.strictEqual(parseListeningPid(undefined, 3000), null);
});

check('PID 0 视为无效', () => {
  const out = '  TCP    127.0.0.1:3000    0.0.0.0:0    LISTENING    0';
  assert.strictEqual(parseListeningPid(out, 3000), null);
});

check('IPv6 监听行也能命中', () => {
  const out = '  TCP    [::1]:3000    [::]:0    LISTENING    555';
  assert.strictEqual(parseListeningPid(out, 3000), '555');
});

check('tasklist 表格式取映像名', () => {
  const out = [
    'Image Name                     PID Session Name        Session#    Mem Usage',
    '========================= ======== ================ =========== ============',
    'node.exe                      7336 Console                   1     26,932 K',
  ].join('\r\n');
  assert.strictEqual(parseTasklistName(out, '7336'), 'node.exe');
});

check('tasklist 找不到该 PID → null', () => {
  const out = 'INFO: No tasks are running which match the specified criteria.';
  assert.strictEqual(parseTasklistName(out, '7336'), null);
});

check('tasklist 空输入 → null', () => {
  assert.strictEqual(parseTasklistName('', '1'), null);
  assert.strictEqual(parseTasklistName(null, '1'), null);
});

console.log(`\nport-lock: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
