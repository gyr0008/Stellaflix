'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');

function extractBlock(startMarker, endMarker, label) {
  const start = mainSource.indexOf(startMarker);
  assert.ok(start >= 0, label + '：未找到起点 ' + startMarker);
  const end = mainSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, label + '：未找到终点 ' + endMarker);
  return mainSource.slice(start, end);
}

test('窗口拖动时 DWM 镜像面走事件驱动 nudge，而不是裸 return 等 60ms 轮询', () => {
  const block = extractBlock(
    'function scheduleWallpaperEngineHostBoundsRestart(',
    '\nfunction ',
    'scheduleWallpaperEngineHostBoundsRestart'
  );
  const dwmBranch = block.indexOf("captureMode === 'dwm-thumbnail'");
  assert.ok(dwmBranch >= 0, 'dwm-thumbnail 分支应仍然存在');
  const branchTail = block.slice(dwmBranch, block.indexOf('\n', block.indexOf('return', dwmBranch)));
  assert.match(branchTail, /nudgeDwmSurfaceFollow/, 'dwm-thumbnail 分支内必须先调用 nudgeDwmSurfaceFollow 再 return');
  assert.match(branchTail, /status\.sessionId/, 'nudge 需带上当前 sessionId 做代次校验');
});

test('renderer 生命周期清理强制 stop 携带 forceHelperCleanup，WE 关不掉时 DWM helper 也必须拆', () => {
  const block = extractBlock(
    'function stopWallpaperEngineRuntimeForRenderer(',
    '\nfunction ',
    'stopWallpaperEngineRuntimeForRenderer'
  );
  assert.match(block, /stop\(\{\s*forceHelperCleanup:\s*true\s*\}\)/,
    'renderer 清理路径应调用 runtime.stop({ forceHelperCleanup: true })');
});

test('识别/导入文件对话框允许直接选择视频与图片文件', () => {
  const block = extractBlock(
    "ipcMain.handle('stellaflix-wallpaper-engine-choose-project-file'",
    '\nipcMain.handle(',
    'choose-project-file handler'
  );
  for (const ext of ['mp4', 'webm', 'mov', 'm4v', 'jpg', 'jpeg', 'png', 'webp', 'gif']) {
    assert.ok(block.includes(`'${ext}'`), 'filters 应包含 .' + ext);
  }
  assert.ok(block.includes("'pkg'") && block.includes("'json'"), '原有 pkg/pak/json 过滤须保留');
});
