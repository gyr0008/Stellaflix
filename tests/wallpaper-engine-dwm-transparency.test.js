'use strict';

// WE 原生引擎（dwm-thumbnail）模式下，壁纸由 DWM 合成在透明窗口背后显示：
// 任何不透明的 html 根画布都会把 WE 表面整个盖成黑屏（2026-09-18 审查结论）。
// 本文件锁定该链路的四条契约。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

test('DWM 模式下 html 根画布必须透明（index.css 与 wallpaper-engine.css 都要有规则）', () => {
  for (const file of ['public/css/index.css', 'public/video/wallpaper-engine.css']) {
    const css = read(file);
    assert.match(
      css,
      /html[^\n{]*:has\(\s*body\.wallpaper-engine-dwm-active\s*\)[^{]*\{[^}]*background:\s*transparent\s*!important/,
      `${file} 缺少 body.wallpaper-engine-dwm-active 时 html 背景透明的规则`
    );
  }
});

test('DWM 模式下不再有强制显示 engine-ready 主图层的死规则', () => {
  for (const file of ['public/css/index.css', 'public/video/wallpaper-engine.css']) {
    const css = read(file);
    assert.doesNotMatch(
      css,
      /wallpaper-engine-dwm-active\s+#wallpaper-engine-layer\.(?:video-ready|engine-ready)/,
      `${file} 仍保留 DWM 模式强制显示兜底视频图层的规则（兜底流在主进程从未准备，属死代码）`
    );
  }
});

test('page-bg-diy 不得用内联 important 背景压过 DWM 透明规则，须改用 --page-bg-diy 变量', () => {
  const js = read('public/video/page-bg-diy.js');
  assert.doesNotMatch(
    js,
    /documentElement\.style\.setProperty\(\s*['"]background['"]/,
    'page-bg-diy 仍在 html 上写内联 background（内联 !important 会压过样式表 !important，击穿透明）'
  );
  assert.match(js, /--page-bg-diy/, 'page-bg-diy 应改为在 html 上设置 --page-bg-diy 自定义属性');
  const css = read('public/css/index.css');
  assert.match(
    css,
    /html\s*\{[^}]*background:\s*var\(--page-bg-diy,\s*#000\)/,
    'index.css 缺少 html { background: var(--page-bg-diy, #000) } 承接规则'
  );
});

test('startWallpaperEngineNativeBackground 在 dwm-thumbnail 模式不挂兜底视频流，仅激活 dwm 图层', async () => {
  const sessionId = 'a1b2c3d4e5f60718293a4b5c';
  const token = 7;
  const calls = [];

  const fakeVideo = { muted: false, loop: false, playsInline: true, srcObject: undefined, dataset: {} };
  const fakeLayer = { classList: { add: () => {}, remove: () => {}, contains: () => false } };

  const sandbox = {
    console,
    window: { innerWidth: 1920, innerHeight: 1080 },
    document: {
      hidden: false,
      getElementById: (id) => (id === 'wallpaper-engine-video' ? fakeVideo : id === 'wallpaper-engine-layer' ? fakeLayer : null)
    },
    wallpaperEngineLayerToken: token,
    wallpaperEngineNativeSessionId: '',
    wallpaperEngineCaptureMode: '',
    wallpaperEngineDesktopApi: () => ({
      startWallpaperEngineScene: async () => ({ ok: true, sessionId, captureMode: 'dwm-thumbnail' })
    }),
    wallpaperEngineNativeStartIsCurrent: () => true,
    wallpaperEngineCaptureFpsPreference: () => 30,
    stopWallpaperEnginePreparedCaptureStreams: () => { calls.push('stopPrepared'); },
    stopWallpaperEnginePreparedGlassCaptureStreams: () => { calls.push('stopPreparedGlass'); },
    stopWallpaperEngineCaptureStream: () => { calls.push('stopStream'); },
    takeWallpaperEnginePreparedCaptureStream: () => {
      calls.push('takePrepared');
      return { getVideoTracks: () => [{ readyState: 'live', addEventListener: () => {}, getSettings: () => ({}) }] };
    },
    reportWallpaperEngineCaptureResult: async () => ({ ok: true, accepted: true, captureReady: true }),
    wallpaperEngineLayerReady: (kind, layerToken) => { calls.push(`layerReady:${kind}:${layerToken}`); },
    clearWallpaperEngineFreezeFrame: () => { calls.push('clearFreeze'); },
    calibrateWallpaperEngineCaptureViewport: () => { calls.push('calibrate'); },
    requestWallpaperEngineVideoPlayback: () => { calls.push('playback'); },
    waitForWallpaperEngineVideoFirstFrame: () => { calls.push('firstFrame'); }
  };

  vm.createContext(sandbox);
  vm.runInContext(read('public/video/wallpaper-engine/wallpaper-engine-glass.js'), sandbox, {
    filename: 'wallpaper-engine-glass.js'
  });

  await sandbox.startWallpaperEngineNativeBackground({ id: 'project-id', enginePlayable: true }, token);

  assert.ok(!calls.includes('takePrepared'),
    'dwm-thumbnail 模式不应再领取主捕获流做全屏兜底（主进程从不准备该流，兜底必为 null；可见性由窗口透明 + DWM 承担）');
  assert.equal(fakeVideo.srcObject, undefined, 'dwm-thumbnail 模式不应向 #wallpaper-engine-video 挂任何 srcObject');
  assert.ok(calls.includes('layerReady:dwm:7'), '应调用 wallpaperEngineLayerReady("dwm", token)');
  assert.equal(sandbox.wallpaperEngineNativeSessionId, sessionId);
  assert.equal(sandbox.wallpaperEngineCaptureMode, 'dwm-thumbnail');
});
