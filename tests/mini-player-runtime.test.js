'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('main.js 只接 mini-player-runtime 且不踩禁串', () => {
  const src = read('desktop/main.js');
  assert.match(src, /require\('\.\/mini-player-runtime'\)/);
  for (const marker of ['DesktopWallpaperRuntime', 'wallpaper-mode-runtime', 'wallpaper.html', 'wallpaper-preload.js'])
    assert.ok(!src.includes(marker), 'main.js 不得含 ' + marker);
});

test('runtime 注册全部迷你播放器通道且无 mineradio 残留', () => {
  const src = read('desktop/mini-player-runtime.js');
  assert.ok(!/mineradio/i.test(src));
  for (const ch of ['stellaflix-mini-player-set-enabled', 'stellaflix-mini-player-set-mode',
    'stellaflix-mini-player-prepare-transition', 'stellaflix-mini-player-update',
    'stellaflix-mini-player-command', 'stellaflix-mini-player-state'])
    assert.ok(src.includes(ch), 'missing ' + ch);
});

// —— 纯函数行为测试（对照源 Mineradio desktop/main.js :3323-3359 / :3793-3802 的实际逻辑）——
// 纯函数签名（第三参 display 注入 { workArea } 以保持无 electron 依赖）：
//   clampMiniPlayerBounds(bounds, mode, display)
//   miniPlayerDefaultBounds(mode, display)
//   shouldShowMiniPlayer({ paused, enabled, active, windowAlive, windowDestroyed, hiddenOrMinimized })
const runtimeModule = require('../desktop/mini-player-runtime');
const { clampMiniPlayerBounds, miniPlayerDefaultBounds, shouldShowMiniPlayer } = runtimeModule;

const DISPLAY = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };

test('clampMiniPlayerBounds 越界回弹到工作区内并强制固定尺寸', () => {
  const clamped = clampMiniPlayerBounds({ x: 2500, y: 2500, width: 360, height: 84 }, 'standard', DISPLAY);
  assert.deepEqual(clamped, { x: 1920 - 360, y: 1080 - 84, width: 360, height: 84 });
  const negative = clampMiniPlayerBounds({ x: -500, y: -500, width: 360, height: 84 }, 'standard', DISPLAY);
  assert.deepEqual(negative, { x: 0, y: 0, width: 360, height: 84 });
  const compact = clampMiniPlayerBounds({ x: 3000, y: 3000, width: 268, height: 58 }, 'compact', DISPLAY);
  assert.deepEqual(compact, { x: 1920 - 268, y: 1080 - 58, width: 268, height: 58 });
});

test('miniPlayerDefaultBounds("standard") 为 360x84 右下角带 14px 边距', () => {
  const standard = miniPlayerDefaultBounds('standard', DISPLAY);
  assert.equal(standard.width, 360);
  assert.equal(standard.height, 84);
  assert.equal(standard.x, 1920 - 360 - 14);
  assert.equal(standard.y, 1080 - 84 - 14);
  const compact = miniPlayerDefaultBounds('compact', DISPLAY);
  assert.deepEqual(compact, {
    x: 1920 - 268 - 14,
    y: 1080 - 58 - 14,
    width: 268,
    height: 58,
  });
});

test('shouldShowMiniPlayer 需 enabled+active+主窗最小化或隐藏等全部条件', () => {
  // 源条件（:3793-3802）：!paused && enabled && active && mainWindow 存在未销毁 && (isMinimized || !isVisible)
  const base = {
    paused: false,
    enabled: true,
    active: true,
    windowAlive: true,
    windowDestroyed: false,
    hiddenOrMinimized: true,
  };
  assert.equal(shouldShowMiniPlayer(base), true);
  assert.equal(shouldShowMiniPlayer({ ...base, enabled: false }), false, '未启用不显示');
  assert.equal(shouldShowMiniPlayer({ ...base, active: false }), false, '未进入迷你模式不显示');
  assert.equal(shouldShowMiniPlayer({ ...base, paused: true }), false, '恢复会话暂停不显示');
  assert.equal(shouldShowMiniPlayer({ ...base, windowAlive: false }), false, '主窗不存在不显示');
  assert.equal(shouldShowMiniPlayer({ ...base, windowDestroyed: true }), false, '主窗已销毁不显示');
  assert.equal(shouldShowMiniPlayer({ ...base, hiddenOrMinimized: false }), false, '主窗可见未最小化不显示');
});
