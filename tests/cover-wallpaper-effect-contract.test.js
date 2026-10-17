'use strict';
// 封面壁纸画面实现的性能契约（逐字移植自 Mineradio wallpaper-effect.js 的实证常量）：
// 不透明画布、DPR 封顶 1.35、粒子数按面积 clamp(420,760)、播放 RAF/空闲 30fps/关闭 1Hz。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('画面模块存在且导出 createCoverWallpaperEffect 三方法接口', () => {
  const src = read('public/js/cover-wallpaper-effect.js');
  assert.match(src, /function createCoverWallpaperEffect\(canvas\)/);
  assert.match(src, /global\.createCoverWallpaperEffect\s*=/);
  assert.match(src, /return\s*\{\s*applyState:\s*applyState,\s*setPaused:\s*setOverlayRenderPaused,\s*dispose:\s*dispose\s*\}/);
});

test('关键性能常量逐字保留', () => {
  const src = read('public/js/cover-wallpaper-effect.js');
  assert.match(src, /WALLPAPER_IDLE_FPS\s*=\s*30/);
  assert.match(src, /WALLPAPER_DISABLED_DELAY\s*=\s*1000/);
  assert.match(src, /getContext\('2d',\s*\{\s*alpha:\s*false\s*\}\)/);
  assert.match(src, /Math\.min\(1\.35,\s*Math\.max\(1,/);
  assert.match(src, /Math\.min\(760,\s*Math\.max\(420,/);
});

test('关闭态释放重载荷（封面与粒子）', () => {
  const src = read('public/js/cover-wallpaper-effect.js');
  assert.match(src, /if\s*\(!state\.enabled\)\s*\{[\s\S]{0,200}state\.cover\s*=\s*'';[\s\S]{0,100}particles\.length\s*=\s*0/);
});
