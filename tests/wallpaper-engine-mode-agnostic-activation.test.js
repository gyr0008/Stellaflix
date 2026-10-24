// 影视态残影根因修复（方案A）：WE 壁纸 DWM 激活链不得依赖播放控制栏可见性。
// 根因：prepare-glass-capture 与 getDwmGlassCaptureSource 及 capture-grant 消费
// 三处闸都要求 dwmGlassSurfaceActive===true，而该标志仅当 #bottom-bar 可见时为真；
// 影视首页 CSS（player.css body.video-space-active:not(.video-player-active) #bottom-bar
// {display:none}）结构性地让它永假 → 'D' 永不发送 → helper 停在 else 分支 →
// 源窗异步滞后跟随 → 拖窗残影。音乐态控制栏常显故从未复现。
// 修法：三处闸去掉 dwmGlassSurfaceActive 条件，保留其余全部校验
// （surface ready、windowId 匹配、source name、session 一致性）。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

test('main.js prepare-glass-capture gate no longer requires dwmGlassSurfaceActive', async () => {
  const source = read('desktop/main.js');
  const gate = /const status = wallpaperEngineRuntime\.getStatus\(\);\s*\n\s*if \(!status \|\| status\.active !== true \|\| status\.sessionId !== sessionId\s*\n\s*\|\| status\.captureMode !== 'dwm-thumbnail'\s*\n\s*\|\| status\.dwmGlassSurfaceReady !== true\) \{\s*\n\s*return \{ ok: false, error: 'WALLPAPER_ENGINE_DWM_GLASS_SURFACE_UNAVAILABLE' \};/;
  assert.match(source, gate);
  assert.equal(/status\.dwmGlassSurfaceActive/.test(source), false);
});

test('main.js dwm-glass capture-grant consumption keeps windowId+name pinning without active flag', async () => {
  const source = read('desktop/main.js');
  assert.match(source, /if \(grant\.kind === 'dwm-glass'\) \{\s*\n\s*const current = wallpaperEngineRuntime\.getStatus\(\);/);
  assert.equal(/current\.dwmGlassSurfaceActive/.test(source), false);
  // The identity checks that replace the dropped flag must survive.
  assert.match(source, /current\.dwmGlassSurfaceReady !== true\s*\n\s*\|\| !sourceMatch\s*\n\s*\|\| Number\(sourceMatch\[1\]\) !== Number\(current\.dwmGlassSurfaceWindowId\)\s*\n\s*\|\| String\(source && source\.name \|\| ''\) !== 'Stellaflix WE DWM Surface'/);
});

test('runtime getDwmGlassCaptureSource gate drops dwmGlassSurfaceActive but keeps ready+windowId checks', async () => {
  const source = read('desktop/wallpaper-engine-runtime.js');
  assert.match(source, /const expectedWindowId = String\(Math\.max\(0, Number\(session\.dwmSurfaceWindowId\) \|\| 0\)\);\s*\n(?:\s*\/\/[^\n]*\n)*\s*if \(session\.dwmSurfaceReady !== true \|\| session\.dwmGlassSurfaceReady !== true\s*\n\s*\|\| !\/\^\\d\+\$\/\.test\(expectedWindowId\)/);
  assert.equal(/session\.dwmGlassSurfaceActive !== true/.test(source), false);
});

test('dwmGlassSurfaceActive stays reported and maintained for the control-bar glass sampler', async () => {
  const source = read('desktop/wallpaper-engine-runtime.js');
  // Still exported on public session state (renderer glass keeps consuming it).
  assert.match(source, /dwmGlassSurfaceActive: session\.dwmGlassSurfaceActive === true,/);
  // Still updated by updateGlassSurface geometry sync.
  assert.match(source, /session\.dwmGlassSurfaceActive = active;/);
  // Still reset on session teardown paths.
  assert.ok((source.match(/session\.dwmGlassSurfaceActive = false;/g) || []).length >= 3);
});
