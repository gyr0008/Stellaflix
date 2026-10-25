'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MiniPlayerStateCache, miniPlayerThemeSignature } = require('../desktop/mini-player-state-cache');
const { MiniPlayerRecoverySession } = require('../desktop/mini-player-recovery-session');

// 断言依据源文件实际行为：
// - MiniPlayerStateCache.setEnabled(enabled) 只收一个参数；补丁须经 apply()，
//   且 apply() 要求 enabled && resident 同时成立。
// - MiniPlayerRecoverySession 构造需要 stopRecoveryTimer/stopRecreateTimer/scheduleRecovery 回调。
test('MiniPlayerStateCache 禁用态丢重载荷、启用态补丁合并', () => {
  const cache = new MiniPlayerStateCache(false);
  assert.equal(cache.apply({ title: 'A' }), false, '禁用且未驻留时拒绝补丁');
  cache.setEnabled(true);
  cache.setResident(true);
  assert.equal(cache.apply({ title: 'A', artist: 'x', cover: 'data:image/png;base64,AAAA', playing: true }), true);
  assert.equal(cache.value.title, 'A');
  assert.equal(cache.value.cover, 'data:image/png;base64,AAAA');
  cache.setEnabled(false);
  assert.equal(cache.enabled, false);
  assert.equal(cache.value.cover, '', '禁用后封面必须释放');
});

test('miniPlayerThemeSignature 对同表稳定、改值即变', () => {
  const a = miniPlayerThemeSignature({ '--accent': '#123456' });
  assert.equal(a, miniPlayerThemeSignature({ '--accent': '#123456' }));
  assert.notEqual(a, miniPlayerThemeSignature({ '--accent': '#654321' }));
});

test('MiniPlayerRecoverySession 挂起期间 resume 幂等恢复', () => {
  const calls = [];
  const session = new MiniPlayerRecoverySession({
    stopRecoveryTimer: () => calls.push('stopRecovery'),
    stopRecreateTimer: () => calls.push('stopRecreate'),
    scheduleRecovery: (delay) => calls.push('schedule:' + delay),
  });
  session.pause('system-suspend');
  assert.equal(session.paused, true);
  assert.deepEqual(calls, ['stopRecovery', 'stopRecreate']);
  assert.equal(session.resume('system-suspend', 120), true);
  assert.equal(session.paused, false);
  assert.deepEqual(calls, ['stopRecovery', 'stopRecreate', 'schedule:120']);
  // 幂等：原因已解除后重复 resume 不再安排恢复。
  assert.equal(session.resume('system-suspend', 120), false);
  assert.equal(calls.length, 3);
});
