'use strict';

/**
 * tests/wallpaper-engine-desktop-resident-diag.test.js — 桌面批 3c（A3 resident / A4 主侧生命周期 / A6 weDiag 全链）
 *
 * 移植来源：Mineradio-2.5.1 desktop/wallpaper-engine-bridge.js（resident emit ~L316-367、
 * stop-scene rendererLifecycle L844-875、start-scene alwaysOnTop 看门狗 L602-638/L707、
 * diag IPC L816-820）+ desktop/wallpaper-engine-runtime.js（weDiag 引导 L9-35、调用点）+
 * desktop/preload.js（reportWallpaperEngineDiag）+ public/wallpaper-engine.js（H43 resident 处理器、
 * weDiag bootstrap H1 与 H32/H34/H38 调用点）。
 *
 * Stellaflix 没有独立 bridge 文件：bridge 职责内联在 desktop/main.js（IPC handlers、窗口钩子、
 * 生命周期 helper）。渲染层有双拷贝需 lockstep：
 *   COPY-1: public/js/modules/07-fx/03-wallpaper-engine-library.js（源码钉）
 *   COPY-2: public/video/wallpaper-engine/wallpaper-engine-*.js（源码钉 + playback.js vm 行为）
 * 风格参照 wallpaper-engine-main-integration.test.js（extractBlock 源码扫描）与
 * wallpaper-engine-frontend-flicker-port.test.js（双拷贝钉 + vm 行为）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const mainSource = read('desktop/main.js');
const preloadSource = read('desktop/preload.js');
const runtimeSource = read('desktop/wallpaper-engine-runtime.js');

const COPY1_FILE = 'public/js/modules/07-fx/03-wallpaper-engine-library.js';
const COPY2_DIR = 'public/video/wallpaper-engine/';
const copy1 = read(COPY1_FILE);
const copy2 = [
  'wallpaper-engine-state.js',
  'wallpaper-engine-capture.js',
  'wallpaper-engine-capture-result.js',
  'wallpaper-engine-bridge.js',
  'wallpaper-engine-glass.js',
  'wallpaper-engine-playback.js',
  'wallpaper-engine-library.js',
  'wallpaper-engine-ui.js',
].map((f) => read(COPY2_DIR + f)).join('\n');

function extractBlock(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, label + '：未找到起点 ' + startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, label + '：未找到终点 ' + endMarker);
  return source.slice(start, end);
}

// ---------------------------------------------------------------------------
// A3 — 主进程 minimize-resident（对应 their bridge suspendForHiddenHost/resumeForVisibleHost）
// ---------------------------------------------------------------------------

test('A3 主侧：minimize + dwm-thumbnail + dwmSurfaceReady 时驻留会话，不走停机分支', () => {
  const block = extractBlock(
    mainSource,
    'function suspendWallpaperEngineForHiddenHost(',
    '\nfunction ',
    'suspendWallpaperEngineForHiddenHost'
  );
  assert.match(block, /runtimeStatus\.captureMode === 'dwm-thumbnail'/);
  assert.match(block, /runtimeStatus\.dwmSurfaceReady === true/);
  assert.match(block, /wallpaperEngineHostVisibilityResidentMinimized = true;/);
  assert.match(block, /preserved: true/);
  // resident 分支必须在真正停机（prepare 事件 + runtime stop）之前 return。
  const residentAt = block.indexOf('preserved: true');
  const stopAt = block.indexOf('stopWallpaperEngineRuntimeForRenderer');
  assert.ok(residentAt >= 0 && stopAt > residentAt,
    'minimize-resident 必须早于 host-hidden 停机路径返回，否则会话仍被销毁');
});

test('A3 主侧：restore 走 resident 通知（phase resident，80/420ms 重发 + 900ms 收尾），不重启会话', () => {
  const block = extractBlock(
    mainSource,
    'function resumeWallpaperEngineForVisibleHost(',
    '\nfunction ',
    'resumeWallpaperEngineForVisibleHost'
  );
  assert.match(block, /wallpaperEngineHostVisibilityResidentMinimized/);
  assert.match(block, /phase: 'resident'/);
  assert.match(block, /forceVisibleHost: true/);
  assert.match(block, /setTimeout\(notifyResident, 80\)/);
  assert.match(block, /setTimeout\(notifyResident, 420\)/);
  assert.match(block, /setTimeout\(\(\) => finishWallpaperEngineVisibleHostResume\(win\), 900\)/);
  assert.match(block, /'stellaflix-wallpaper-engine-host-bounds-changed'/);
});

// ---------------------------------------------------------------------------
// A4 — 主侧 rendererLifecycle 停机语义 + start-scene 黑闪（alwaysOnTop 看门狗）
// ---------------------------------------------------------------------------

test('A4 主侧：stop-scene 遵循 rendererLifecycle/all/sessionId 载荷旗标', () => {
  const block = extractBlock(
    mainSource,
    "ipcMain.handle('stellaflix-wallpaper-engine-stop-scene'",
    '\nipcMain.handle(',
    'stop-scene handler'
  );
  assert.match(block, /payload && payload\.rendererLifecycle === true/);
  assert.match(block, /const stopOptions = \{ forceHelperCleanup: rendererLifecycle \};/);
  assert.match(block, /wallpaperEngineRuntime\.stop\(stopOptions\)/);
  assert.match(block, /wallpaperEngineRuntime\.stop\(\{ \.\.\.stopOptions, sessionId \}\)/);
  assert.match(block, /wallpaperEngineGlassCaptureOperation \+= 1;/);
  assert.match(block, /wallpaperEngineCapturePreparationOperation = 0;/);
  assert.match(block, /pendingLifecycleSession[\s\S]*activeLifecycleSession[\s\S]*differentPendingSession/);
});

test('A4 主侧：renderer 清理 promise 去重，钩子带 rendererLifecycle，start-scene 先 await 清理', () => {
  const stopFn = extractBlock(
    mainSource,
    'function stopWallpaperEngineRuntimeForRenderer(',
    '\nfunction ',
    'stopWallpaperEngineRuntimeForRenderer'
  );
  assert.match(stopFn, /const rendererLifecycle = options && options\.rendererLifecycle === true;/);
  assert.match(stopFn, /if \(wallpaperEngineRendererCleanupPromise\) return wallpaperEngineRendererCleanupPromise;/);
  assert.match(stopFn, /if \(rendererLifecycle\) wallpaperEngineRendererCleanupPromise = cleanup;/);
  assert.match(stopFn, /result\.stopped !== true && \(result\.active \|\| wallpaperEngineRuntime\.pending\)/);
  assert.match(stopFn, /wallpaperEngineRuntime\.stop\(\{ forceHelperCleanup: true \}\)/);
  // rendererLifecycle 清理需拆掉可见性挂起态，防止与 suspend/resume 机制打架。
  assert.match(stopFn, /wallpaperEngineHostVisibilitySuspended = false;/);
  assert.match(stopFn, /wallpaperEngineHostVisibilityStopPromise = null;/);

  const lifecycleHooks = mainSource.match(
    /stopWallpaperEngineRuntimeForRenderer\([^\n]*\{ rendererLifecycle: true \}\)/g
  ) || [];
  assert.ok(lifecycleHooks.length >= 3,
    'render-process-gone / 主帧导航 / webContents destroyed 三处钩子都要带 rendererLifecycle:true（当前 ' + lifecycleHooks.length + '）');

  const startBlock = extractBlock(
    mainSource,
    "ipcMain.handle('stellaflix-wallpaper-engine-start-scene'",
    '\nipcMain.handle(',
    'start-scene handler'
  );
  assert.match(startBlock, /const pendingRendererCleanup = wallpaperEngineRendererCleanupPromise;/);
  assert.match(startBlock, /if \(pendingRendererCleanup\) await pendingRendererCleanup;/);
});

test('A4 主侧：start-scene 临时抬升宿主到 screen-saver + 10s 看门狗（v2.1.1 黑闪主侧）', () => {
  const block = extractBlock(
    mainSource,
    "ipcMain.handle('stellaflix-wallpaper-engine-start-scene'",
    '\nipcMain.handle(',
    'start-scene handler'
  );
  assert.match(block, /setAlwaysOnTop\(true, 'screen-saver'\)/);
  assert.match(block, /restoreHostTopTimer = setTimeout\(restoreHostTop, 10000\)/);
  assert.match(block, /restoreHostTopTimer\.unref/);
  assert.match(block, /finally \{[\s\S]*restoreHostTop\(\);[\s\S]*\}/);
  assert.match(block, /current\.setAlwaysOnTop\(false\)/);
});

// ---------------------------------------------------------------------------
// A6 — weDiag 全链：runtime 引导 / noteWeDiagEvent 导出 / main IPC / preload / 渲染层
// ---------------------------------------------------------------------------

test('A6 runtime：STELLAFLIX_WE_DIAG 引导 + 日志落 Stellaflix appdata 目录 + 旧身份零泄漏', () => {
  assert.match(runtimeSource, /process\.env\.STELLAFLIX_WE_DIAG === '1'/);
  assert.match(runtimeSource, /'Stellaflix', 'wallpaper-engine-diag\.log'/);
  assert.match(runtimeSource, /function noteWeDiagEvent\(event, payload = \{\}\)/);
  assert.match(runtimeSource, /module\.exports = \{[\s\S]*noteWeDiagEvent,[\s\S]*\};/);
  assert.equal(/MINERADIO_WE_DIAG/.test(runtimeSource), false, 'MINERADIO_WE_DIAG 必须零残留');
  assert.equal(/Mineradio/.test(runtimeSource), false, 'Mineradio 身份必须零泄漏');
  // 阶段计时/事件调用点与 their runtime 对齐。
  assert.match(runtimeSource, /weDiag\('start-begin'/);
  assert.equal((runtimeSource.match(/weDiag\('stage-done'/g) || []).length >= 7, true);
  assert.match(runtimeSource, /weDiag\('start-ok'/);
  assert.match(runtimeSource, /weDiag\('start-failed'/);
  assert.match(runtimeSource, /weDiag\('embed-begin'/);
  assert.match(runtimeSource, /weDiag\('embed-attempt'/);
  assert.match(runtimeSource, /weDiag\('embed-ok'/);
  assert.match(runtimeSource, /weDiag\('dwm-activate-begin'/);
  assert.match(runtimeSource, /weDiag\('dwm-activate-ok'/);
  assert.match(runtimeSource, /weDiag\('dwm-activate-failed'/);
  assert.match(runtimeSource, /weDiag\('dwm-helper-unavailable'/);
  assert.match(runtimeSource, /weDiag\('dwm-helper-exited'/);
});

test('A6 runtime 行为：env 开 → renderer 事件逐行写日志；env 关 → 静默 no-op 不落文件', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stellaflix-we-diag-'));
  const savedDiag = process.env.STELLAFLIX_WE_DIAG;
  const savedLocal = process.env.LOCALAPPDATA;
  const savedApp = process.env.APPDATA;
  try {
    process.env.STELLAFLIX_WE_DIAG = '1';
    delete process.env.APPDATA;
    process.env.LOCALAPPDATA = tempRoot;
    delete require.cache[require.resolve('../desktop/wallpaper-engine-runtime.js')];
    const mod = require('../desktop/wallpaper-engine-runtime.js');
    assert.equal(typeof mod.noteWeDiagEvent, 'function');
    mod.noteWeDiagEvent('renderer-layer-ready', { kind: 'dwm', sessionId: 'abc' });

    // env 关闭：子进程不带 STELLAFLIX_WE_DIAG，noteWeDiagEvent 必须 no-op 且不产生文件。
    const childEnv = { ...process.env };
    delete childEnv.STELLAFLIX_WE_DIAG;
    execFileSync(process.execPath, ['-e', `
      const mod = require(${JSON.stringify(path.join(ROOT, 'desktop', 'wallpaper-engine-runtime.js'))});
      mod.noteWeDiagEvent('renderer-off-probe', { a: 1 });
    `], { env: childEnv, stdio: 'pipe' });
    const logFile = path.join(tempRoot, 'Stellaflix', 'wallpaper-engine-diag.log');
    const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'env 关闭时不得追加任何行');
    assert.match(lines[0], /renderer:renderer-layer-ready kind=dwm sessionId=abc/);
    assert.doesNotMatch(lines.join('\n'), /renderer-off-probe/);
  } finally {
    if (savedDiag === undefined) delete process.env.STELLAFLIX_WE_DIAG;
    else process.env.STELLAFLIX_WE_DIAG = savedDiag;
    if (savedLocal === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = savedLocal;
    if (savedApp === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = savedApp;
    delete require.cache[require.resolve('../desktop/wallpaper-engine-runtime.js')];
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('A6 preload+main：diag 通道走 stellaflix-* 命名并转发 runtime.noteWeDiagEvent', () => {
  assert.match(preloadSource,
    /reportWallpaperEngineDiag: \(payload\) => ipcRenderer\.send\('stellaflix-wallpaper-engine-diag', payload \|\| \{\}\)/);
  assert.equal(/mineradio/i.test(preloadSource), false);
  assert.match(mainSource, /const \{ WallpaperEngineRuntime, noteWeDiagEvent \} = require\('\.\/wallpaper-engine-runtime'\);/);
  assert.match(mainSource, /ipcMain\.on\('stellaflix-wallpaper-engine-diag'/);
  assert.match(mainSource, /noteWeDiagEvent\(String\(payload && payload\.event \|\| 'renderer'\), payload\)/);
});

// ---------------------------------------------------------------------------
// 渲染层双拷贝 lockstep：H43 resident 处理器 + A6 weDiag bootstrap/调用点
// ---------------------------------------------------------------------------

test('A3 渲染层源码钉：双拷贝都有 phase resident 处理器（保留选择、不重采集）', () => {
  for (const [label, text] of [['COPY-1(' + COPY1_FILE + ')', copy1], ['COPY-2(video split)', copy2]]) {
    assert.match(text, /if \(phase === 'resident'\) \{/, `${label} 缺少 resident 分支`);
    assert.match(text, /var residentSessionId = String\(payload && payload\.sessionId \|\| ''\);/, `${label} resident sessionId 解析缺失`);
    assert.match(text, /wallpaperEngineCaptureMode !== 'dwm-thumbnail'/, `${label} resident 守卫必须校验 dwm-thumbnail`);
    assert.match(text, /residentSessionId !== String\(wallpaperEngineNativeSessionId \|\| ''\)/, `${label} resident 守卫必须比对会话 id`);
    // B4/B2：Stellaflix 用 selection.active，不引入 wallpaperEngineBackgroundActive()/uiText。
    assert.match(text, /if \(!wallpaperEngineSelection\.active\s*\|\|\s*wallpaperEngineSelection\.kind !== 'engine'/, `${label} resident 守卫应使用 selection.active 流`);
    assert.match(text, /wallpaperEngineHostBoundsPreparing = false;\s*\n\s*wallpaperEngineDesktopPreviewActive = false;\s*\n\s*wallpaperEngineDesktopPreviewUsesAsset = false;\s*\n\s*clearWallpaperEngineFreezeFrame\(false\);\s*\n\s*updateWallpaperEngineEntryUi\(\);\s*\n\s*return;/, `${label} resident 分支只清渲染态，不得触发重启/重采集`);
    assert.doesNotMatch(text, /phase === 'resident'[\s\S]{0,600}restartWallpaperEngineAfterHostBoundsChange\(\)/, `${label} resident 分支不得调用 restart`);
    assert.equal(/mineradio/i.test(text), false, `${label} 双拷贝不得混入 mineradio 身份`);
  }
});

test('A6 渲染层源码钉：双拷贝都有 weDiag bootstrap 与三个调用点', () => {
  for (const [label, text] of [['COPY-1', copy1], ['COPY-2', copy2]]) {
    assert.match(text, /window\.__stellaflixWeDiag = weDiag;/, `${label} 缺少 weDiag bootstrap 暴露`);
    assert.match(text, /api\.reportWallpaperEngineDiag\(Object\.assign\(\{ event: event \}, fields \|\| \{\}\)\)/, `${label} weDiag 未走 preload reportWallpaperEngineDiag`);
    assert.match(text, /if \(window\.__stellaflixWeDiag\) window\.__stellaflixWeDiag\('renderer-layer-ready', \{ kind: kind \}\);/, `${label} layerReady 缺 weDiag 调用`);
    assert.match(text, /if \(window\.__stellaflixWeDiag\) window\.__stellaflixWeDiag\('renderer-layer-failed', \{ attemptedKind: attemptedKind \}\);/, `${label} layerFailed 缺 weDiag 调用`);
    assert.match(text, /if \(window\.__stellaflixWeDiag\) window\.__stellaflixWeDiag\('renderer-load-begin', \{ kind: kind, hasPreview: item\.hasPreview === true \}\);/, `${label} applyBackground 缺 renderer-load-begin 调用`);
    assert.equal(/__mineradioWeDiag/.test(text), false, `${label} 不得保留 __mineradioWeDiag`);
  }
});

// ---------------------------------------------------------------------------
// vm 行为（COPY-2 playback.js 单独可跑）：resident 通知保留会话，不触发停机/重启
// ---------------------------------------------------------------------------

function makeHostBoundsEnv(overrides = {}) {
  const calls = [];
  const sessionId = 'a1b2c3d4e5f60718293a4b5c';
  const sandbox = {
    console,
    document: {
      hidden: false,
      getElementById: () => null,
      body: { classList: { add: () => { }, remove: () => { }, contains: () => false, toggle: () => { } } },
    },
    window: {},
    wallpaperEngineLayerToken: 5,
    wallpaperEngineHostBoundsPreparing: true,
    wallpaperEngineDesktopPreviewActive: true,
    wallpaperEngineDesktopPreviewUsesAsset: true,
    wallpaperEngineCaptureMode: 'dwm-thumbnail',
    wallpaperEngineNativeSessionId: sessionId,
    wallpaperEngineSelection: { id: 'project-id', kind: 'engine', active: true },
    updateWallpaperEngineEntryUi: () => { calls.push('entryUi'); },
    stopWallpaperEngineNativeSession: () => { calls.push('nativeStop'); return Promise.resolve({ ok: true }); },
  };
  Object.assign(sandbox, overrides);
  vm.createContext(sandbox);
  vm.runInContext(read(COPY2_DIR + 'wallpaper-engine-playback.js'), sandbox, { filename: 'wallpaper-engine-playback.js' });
  // playback.js 自身声明先行，观察桩必须在 run 之后覆盖。
  sandbox.clearWallpaperEngineFreezeFrame = (clearFreeze) => { calls.push('clearFreeze:' + String(clearFreeze)); };
  sandbox.restartWallpaperEngineAfterHostBoundsChange = () => { calls.push('restart'); };
  return { sandbox, calls, sessionId };
}

test('A3 行为：playback.js resident 通知——清渲染态、保留选择与会话，不 restart 也不停机', () => {
  const env = makeHostBoundsEnv();
  env.sandbox.handleWallpaperEngineHostBoundsChange({ phase: 'resident', sessionId: env.sessionId, forceVisibleHost: true });
  assert.equal(env.sandbox.wallpaperEngineHostBoundsPreparing, false, 'resident 通知后 preparing 门必须放开');
  assert.equal(env.sandbox.wallpaperEngineDesktopPreviewActive, false, 'resident 后不得停留在桌面被动预览');
  assert.equal(env.sandbox.wallpaperEngineDesktopPreviewUsesAsset, false);
  assert.ok(env.calls.includes('clearFreeze:false'), 'resident 需清冻结帧（false=不清采集层）');
  assert.ok(env.calls.includes('entryUi'));
  assert.ok(!env.calls.includes('restart'), 'resident 绝不得触发 Scene 重启/重采集');
  assert.ok(!env.calls.includes('nativeStop'), 'resident 绝不得停机');
  assert.equal(env.sandbox.wallpaperEngineSelection.active, true, 'resident 必须保留当前选择');
  assert.equal(env.sandbox.wallpaperEngineNativeSessionId, env.sessionId, 'resident 不得清掉原生会话');
});

test('A3 行为：playback.js resident 守卫——会话不匹配或非 dwm-thumbnail 时原样返回', () => {
  const mismatch = makeHostBoundsEnv();
  mismatch.sandbox.handleWallpaperEngineHostBoundsChange({ phase: 'resident', sessionId: 'ffffffffffffffffffffffff' });
  assert.equal(mismatch.sandbox.wallpaperEngineHostBoundsPreparing, true, '会话 id 不符不得动状态');
  assert.equal(mismatch.calls.length, 0);

  const wrongMode = makeHostBoundsEnv({ wallpaperEngineCaptureMode: 'stream' });
  wrongMode.sandbox.handleWallpaperEngineHostBoundsChange({ phase: 'resident', sessionId: wrongMode.sessionId });
  assert.equal(wrongMode.sandbox.wallpaperEngineHostBoundsPreparing, true, '非 dwm-thumbnail 不走 resident');
  assert.equal(wrongMode.calls.length, 0);

  const inactive = makeHostBoundsEnv({ wallpaperEngineSelection: { id: 'project-id', kind: 'engine', active: false } });
  inactive.sandbox.handleWallpaperEngineHostBoundsChange({ phase: 'resident', sessionId: inactive.sessionId });
  assert.equal(inactive.calls.length, 0, 'selection.active=false 时 resident 必须原样返回');
});

test('A6 行为：playback.js weDiag 调用点无 preload API 时静默 no-op', () => {
  const env = makeHostBoundsEnv();
  // window 无 __stellaflixWeDiag、desktopWindow 缺失：applyBackground/layerFailed 路径不得抛。
  env.sandbox.wallpaperEngineProjectById = () => ({ id: 'project-id', title: 'x', hasPreview: false, playable: false, enginePlayable: false });
  assert.doesNotThrow(() => {
    env.sandbox.handleWallpaperEngineHostBoundsChange({ phase: 'resident', sessionId: env.sessionId });
  });
  assert.match(copy2, /if \(window\.__stellaflixWeDiag\) window\.__stellaflixWeDiag\(/,
    '调用点必须先用 if (window.__stellaflixWeDiag) 短路（preload 缺席即 no-op）');
});
