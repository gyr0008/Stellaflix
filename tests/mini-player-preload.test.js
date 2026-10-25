'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('mini-player-preload 通道改名 stellaflix 且文档信任门保留', () => {
  const src = read('desktop/mini-player-preload.js');
  assert.ok(!src.includes('mineradio'), '通道必须全部改名');
  for (const ch of ['stellaflix-mini-player-command', 'stellaflix-mini-player-move-by',
    'stellaflix-mini-player-window-move-by', 'stellaflix-mini-player-set-pointer-passthrough-sync',
    'stellaflix-mini-player-set-pointer-passthrough', 'stellaflix-mini-player-state'])
    assert.ok(src.includes(ch), 'missing ' + ch);
  assert.match(src, /mini-player-compact\.html/);
});

test('主 preload 暴露 5 个迷你播放器 API', () => {
  const src = read('desktop/preload.js');
  for (const api of ['setMiniPlayerEnabled', 'setMiniPlayerMode', 'prepareMiniPlayerTransition',
    'updateMiniPlayer', 'onMiniPlayerCommand'])
    assert.ok(src.includes(api), 'missing api ' + api);
  assert.ok(!src.includes('mineradio'), 'preload 不得残留 mineradio');
});

test('主 preload 迷你播放器 invoke 通道名与 Task 4 handler 对齐', () => {
  const src = read('desktop/preload.js');
  for (const ch of ['stellaflix-mini-player-set-enabled', 'stellaflix-mini-player-set-mode',
    'stellaflix-mini-player-prepare-transition', 'stellaflix-mini-player-update'])
    assert.ok(src.includes(ch), 'missing channel ' + ch);
});
