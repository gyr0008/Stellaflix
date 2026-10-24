'use strict';

/**
 * tests/wallpaper-engine-frontend-flicker-port.test.js — WE 前端防闪屏移植契约（批 3a：A5/A2/A1/A4）
 *
 * 移植来源：Mineradio-2.5.1 public/wallpaper-engine.js（THEIRS），hunks H1/H53（A5）、
 * H26（A2）、H38+H31/H32/H34（A1）、H7/H63/H64（A4）。
 * Stellaflix 同一引擎有两份拷贝同时在页面执行（后加载者赢），任何行为修改必须
 * lockstep 落在两份上：
 *   COPY-1: public/js/modules/07-fx/03-wallpaper-engine-library.js（EOF 自启动，仅做源码钉）
 *   COPY-2: public/video/wallpaper-engine/wallpaper-engine-*.js（split，init 由 video/bootstrap.js 延迟）
 * COPY-2 在 vm 里按 split 文件单独可跑，故对 state/capture/glass/playback/library 走行为验证；
 * 两份都命中同一组源码钉以捕捉 lockstep 漂移（house style 参照
 * wallpaper-engine-dwm-transparency.test.js / splash-click-guard.test.js）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const COPY1_FILE = 'public/js/modules/07-fx/03-wallpaper-engine-library.js';
const COPY2_DIR = 'public/video/wallpaper-engine/';
const COPY2_FILES = [
  'wallpaper-engine-state.js',
  'wallpaper-engine-capture.js',
  'wallpaper-engine-capture-result.js',
  'wallpaper-engine-bridge.js',
  'wallpaper-engine-glass.js',
  'wallpaper-engine-playback.js',
  'wallpaper-engine-library.js',
  'wallpaper-engine-ui.js'
].map((f) => COPY2_DIR + f);

const copy1 = read(COPY1_FILE);
const copy2 = COPY2_FILES.map(read).join('\n');

function makeClassList(owner) {
  const set = new Set();
  return {
    add: (...cs) => cs.forEach((c) => set.add(c)),
    remove: (...cs) => cs.forEach((c) => set.delete(c)),
    contains: (c) => set.has(c),
    toggle: (c, on) => { if (on === undefined) { set.has(c) ? set.delete(c) : set.add(c); } else if (on) { set.add(c); } else { set.delete(c); } },
    _set: set,
    _owner: owner
  };
}

function fakeEl(id) {
  const el = {
    id,
    classList: makeClassList(id),
    src: '',
    poster: '',
    muted: false,
    loop: false,
    playsInline: true,
    onload: null,
    onerror: null,
    onloadedmetadata: null,
    onloadeddata: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    removeAttribute: (name) => { if (name === 'src') el.src = ''; if (name === 'poster') el.poster = ''; },
    setAttribute: () => {},
    getAttribute: () => null,
    load: () => {},
    pause: () => {},
    play: () => Promise.resolve(),
    querySelector: () => null,
    dataset: {},
    style: {}
  };
  return el;
}

function countMatches(text, re) {
  const m = text.match(re);
  return m ? m.length : 0;
}

// ---------------------------------------------------------------------------
// 源码钉：两份拷贝必须同时命中（捕捉双拷贝 lockstep 漂移）
// ---------------------------------------------------------------------------

test('A5 源码钉：两份拷贝都有 wallpaperEngineLibraryLoadPromise 且 busy 时返回在途 promise', () => {
  for (const [label, text] of [['COPY-1(' + COPY1_FILE + ')', copy1], ['COPY-2(video split)', copy2]]) {
    assert.match(text, /var wallpaperEngineLibraryLoadPromise = null;/, `${label} 缺少在途 promise 全局`);
    assert.match(
      text,
      /if \(wallpaperEngineLibraryBusy\) return wallpaperEngineLibraryLoadPromise \|\| Promise\.resolve\(wallpaperEngineProjects\);/,
      `${label} busy 分支必须返回在途 promise（而非旧 projects 快照）`
    );
    assert.match(text, /wallpaperEngineLibraryLoadPromise = loadPromise;/, `${label} 未把扫描登记到 wallpaperEngineLibraryLoadPromise`);
    assert.match(
      text,
      /loadPromise\.then\(function \(\) \{\s*if \(wallpaperEngineLibraryLoadPromise === loadPromise\) wallpaperEngineLibraryLoadPromise = null;/,
      `${label} 缺少 settled 后清空 wallpaperEngineLibraryLoadPromise 的回调`
    );
  }
});

test('A2 源码钉：两份拷贝 dwm 揭示都改走 revealAfterNativeSettles（2×RAF + 320ms）', () => {
  for (const [label, text] of [['COPY-1', copy1], ['COPY-2', copy2]]) {
    assert.match(text, /\(function revealAfterNativeSettles\(\)/, `${label} 缺少 revealAfterNativeSettles`);
    assert.match(
      text,
      /requestAnimationFrame\(function \(\) \{\s*requestAnimationFrame\(function \(\) \{\s*setTimeout\(function \(\)/,
      `${label} 缺少 2×requestAnimationFrame 嵌套`
    );
    assert.match(text, /wallpaperEngineLayerReady\('dwm', settleToken\);\s*clearWallpaperEngineFreezeFrame\(false\);/, `${label} settle 后应一步揭示并清冻结帧`);
    assert.match(text, /\}, 320\);/, `${label} 缺少 320ms settle`);
    assert.doesNotMatch(
      text,
      /wallpaperEngineLayerReady\('dwm', token\);\s*clearWallpaperEngineFreezeFrame\(false\);/,
      `${label} 仍保留立即揭示（应与 settle 版同步替换）`
    );
  }
});

test('A1 源码钉：applyBackground 加 wallpaper-engine-loading，ready/failed/restore 三条路都摘除', () => {
  for (const [label, text] of [['COPY-1', copy1], ['COPY-2', copy2]]) {
    assert.match(text, /document\.body\.classList\.add\('wallpaper-engine-loading'\);/, `${label} applyBackground 路径缺 loading 门`);
    assert.ok(
      countMatches(text, /document\.body\.classList\.remove\('wallpaper-engine-loading'\);/g) >= 2,
      `${label} layerReady 与 layerFailed 都应各摘一次（单参 remove ≥2 处）`
    );
    assert.match(
      text,
      /classList\.remove\('wallpaper-engine-active', 'wallpaper-engine-dwm-active', 'wallpaper-engine-loading'\);/,
      `${label} restoreOriginalBackgroundAfterWallpaperEngine 必须连 loading 一起清`
    );
  }
});

test('A1 源码钉：engine 起播期间先挂项目预览海报（dwm-active 后不得回盖）', () => {
  for (const [label, text] of [['COPY-1', copy1], ['COPY-2', copy2]]) {
    assert.match(
      text,
      /if \(kind === 'engine'\) \{[\s\S]{0,2400}?image\.src = wallpaperEngineMediaUrl\(item, 'preview'\);[\s\S]{0,600}?startWallpaperEngineNativeBackground\(item, token\)/,
      `${label} engine 分支缺少原生起播前的预览海报`
    );
    assert.match(
      text,
      /if \(document\.body\.classList\.contains\('wallpaper-engine-dwm-active'\)\) return;\s*wallpaperEngineLayerReady\('image', token\);/,
      `${label} 海报 onload 必须跳过原生面已接管的情形`
    );
  }
});

test('A4 源码钉：stopWallpaperEngineNativeSession 严格校验 + rendererLifecycle 透传 + pagehide 带参停机', () => {
  for (const [label, text] of [['COPY-1', copy1], ['COPY-2', copy2]]) {
    assert.match(
      text,
      /var options = arguments\.length > 1 && arguments\[1\] && typeof arguments\[1\] === 'object' \? arguments\[1\] : \{\};/,
      `${label} 缺少 options 解析`
    );
    assert.match(
      text,
      /if \(!stopAll && !\/\^\[a-f0-9\]\{24\}\$\/i\.test\(expected\)\) return Promise\.resolve\(\{ ok: true, skipped: true \}\);/,
      `${label} 缺少 24 位十六进制 session-id 严格校验`
    );
    assert.match(text, /if \(options\.rendererLifecycle === true\) payload\.rendererLifecycle = true;/, `${label} 缺少 rendererLifecycle 透传`);
    assert.match(text, /var pagehideSessionId = String\(wallpaperEngineNativeSessionId \|\| ''\);/, `${label} pagehide 缺少会话捕获`);
    assert.match(
      text,
      /stopWallpaperEngineNativeSession\(pagehideSessionId, \{ rendererLifecycle: true \}\)/,
      `${label} pagehide 必须以 rendererLifecycle:true 停机`
    );
  }
});

test('A1-CSS 钉：两份样式表都有 body.wallpaper-engine-loading 期间的 #custom-bg 不透明门', () => {
  for (const file of ['public/css/index.css', 'public/video/wallpaper-engine.css']) {
    const css = read(file);
    assert.match(
      css,
      /body\.wallpaper-engine-loading #custom-bg\s*\{[^}]*background:\s*rgb\(var\(--custom-bg-color-rgb[^)]*\)\s*\)\s*!important/,
      `${file} 缺少加载期强制不透明底色的规则（透明窗口会把桌面/WE 弹窗露出来）`
    );
  }
});

// ---------------------------------------------------------------------------
// 行为验证（COPY-2 按 split 文件在 vm 中可独立执行）
// ---------------------------------------------------------------------------

function makeCaptureEnv() {
  const calls = [];
  const sessionId = 'a1b2c3d4e5f60718293a4b5c';
  const sandbox = {
    console,
    window: {},
    navigator: {},
    wallpaperEngineDesktopApi: () => ({
      stopWallpaperEngineScene: (payload) => {
        calls.push(payload);
        return Promise.resolve({ ok: true });
      }
    }),
    wallpaperEngineNativeSessionId: sessionId
  };
  vm.createContext(sandbox);
  vm.runInContext(read(COPY2_DIR + 'wallpaper-engine-capture.js'), sandbox, { filename: 'wallpaper-engine-capture.js' });
  return { sandbox, calls, sessionId };
}

test('A4 行为：capture.js 停机——非法 id 被拒、rendererLifecycle 与 all 随 payload 透传', async () => {
  const env = makeCaptureEnv();
  const rejected = await env.sandbox.stopWallpaperEngineNativeSession('not-a-hex-id');
  assert.equal(rejected.ok, true);
  assert.equal(rejected.skipped, true, '非 24-hex 会话 id 不得向主进程发停机 IPC');
  assert.equal(env.calls.length, 0, '被拒调用不应触达 stopWallpaperEngineScene');

  const lifecycle = await env.sandbox.stopWallpaperEngineNativeSession(env.sessionId, { rendererLifecycle: true });
  assert.equal(lifecycle.ok, true);
  // vm 沙箱对象的原型属跨 realm，逐键断言而非 deepEqual
  assert.equal(env.calls[0].sessionId, env.sessionId);
  assert.equal(env.calls[0].all, false);
  assert.equal(env.calls[0].rendererLifecycle, true,
    'payload 必须携带 all 与 rendererLifecycle，preload 才会原样转发');

  const stopAll = await env.sandbox.stopWallpaperEngineNativeSession();
  assert.equal(stopAll.ok, true);
  assert.equal(env.calls[1].all, true, '无参调用应广播 all:true');
  assert.equal(env.sandbox.wallpaperEngineNativeSessionId, '', '无参停机应清空本地会话记录');
});

function makeLibraryEnv() {
  const sandbox = {
    console,
    document: { getElementById: () => null },
    window: {},
    wallpaperEngineProjects: [],
    wallpaperEngineLibrarySnapshot: null,
    wallpaperEngineMediaToken: '',
    wallpaperEngineLibraryBusy: false,
    wallpaperEngineSelection: { id: '', kind: 'preview', active: false }
  };
  vm.createContext(sandbox);
  vm.runInContext(read(COPY2_DIR + 'wallpaper-engine-library.js'), sandbox, { filename: 'wallpaper-engine-library.js' });
  // 覆盖同文件里的渲染/状态副作用，专注验证加载去重语义
  sandbox.renderWallpaperEngineLibrary = () => {};
  sandbox.updateWallpaperEngineLibraryStatus = () => {};
  sandbox.showToast = () => {};
  sandbox.consumeWallpaperEngineSnapshot = (snapshot) => { sandbox.wallpaperEngineProjects = snapshot.projects || []; };
  return sandbox;
}

test('A5 行为：library.js 扫描在途时二次调用返回同一 promise，且 resolve 到新结果', async () => {
  const sandbox = makeLibraryEnv();
  let resolveList;
  sandbox.wallpaperEngineDesktopApi = () => ({
    listWallpaperEngineProjects: () => new Promise((resolve) => { resolveList = resolve; })
  });
  const first = sandbox.loadWallpaperEngineLibrary(false, false);
  const second = sandbox.loadWallpaperEngineLibrary(false, false);
  assert.equal(second, first, 'busy 期间必须返回在途 promise 本体（当前实现返回旧快照，属回归）');
  resolveList({ ok: true, count: 1, projects: [{ id: 'fresh-project' }] });
  const result = await second;
  assert.deepEqual(result, [{ id: 'fresh-project' }], '在途调用必须等到真实扫描结果，而非立即 resolve 旧 projects');
  assert.equal(sandbox.wallpaperEngineLibraryBusy, false);
});

function makeGlassEnv() {
  const sessionId = 'a1b2c3d4e5f60718293a4b5c';
  const token = 7;
  const calls = [];
  const rafQueue = [];
  const timers = [];
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
    wallpaperEngineSelection: { id: 'project-id', kind: 'engine', active: true },
    wallpaperEngineDesktopApi: () => ({
      startWallpaperEngineScene: async () => ({ ok: true, sessionId, captureMode: 'dwm-thumbnail' })
    }),
    wallpaperEngineNativeStartIsCurrent: () => true,
    wallpaperEngineCaptureFpsPreference: () => 30,
    stopWallpaperEnginePreparedCaptureStreams: () => {},
    stopWallpaperEnginePreparedGlassCaptureStreams: () => {},
    stopWallpaperEngineCaptureStream: () => {},
    takeWallpaperEnginePreparedCaptureStream: () => null,
    reportWallpaperEngineCaptureResult: async () => ({ ok: true, accepted: true, captureReady: true }),
    wallpaperEngineLayerReady: (kind, layerToken) => { calls.push(`layerReady:${kind}:${layerToken}`); },
    clearWallpaperEngineFreezeFrame: () => { calls.push('clearFreeze'); },
    requestAnimationFrame: (cb) => { rafQueue.push(cb); },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; }
  };
  vm.createContext(sandbox);
  vm.runInContext(read(COPY2_DIR + 'wallpaper-engine-glass.js'), sandbox, { filename: 'wallpaper-engine-glass.js' });
  function flushRaf() {
    const pending = rafQueue.splice(0, rafQueue.length);
    pending.forEach((cb) => cb());
  }
  return { sandbox, calls, sessionId, flushRaf, rafQueue, timers };
}

test('A2 行为：glass.js dwm 揭示被推迟到 2×RAF + 320ms settle，令牌过期则放弃揭示', async () => {
  const env = makeGlassEnv();
  await env.sandbox.startWallpaperEngineNativeBackground({ id: 'project-id', enginePlayable: true }, env.sandbox.wallpaperEngineLayerToken);
  assert.equal(env.calls.includes('layerReady:dwm:7'), false, '揭示不得在 ack 后立即发生');
  env.flushRaf();
  env.flushRaf();
  assert.equal(env.timers.length, 1, '两次 rAF 后应登记 settle 定时器');
  assert.ok(env.timers[0].ms >= 320, 'settle 至少 320ms');
  assert.equal(env.calls.includes('layerReady:dwm:7'), false, '定时器未到期前不得揭示');

  // 场景一：令牌过期 → 守卫吞掉揭示
  env.sandbox.wallpaperEngineLayerToken += 1;
  env.timers[0].fn();
  assert.equal(env.calls.includes('layerReady:dwm:7'), false, 'token 已换代，不得再揭示旧层');

  // 场景二：令牌/会话仍有效 → 一步揭示并清冻结帧
  const env2 = makeGlassEnv();
  await env2.sandbox.startWallpaperEngineNativeBackground({ id: 'project-id', enginePlayable: true }, env2.sandbox.wallpaperEngineLayerToken);
  env2.flushRaf();
  env2.flushRaf();
  env2.timers[0].fn();
  assert.ok(env2.calls.includes('layerReady:dwm:7'), 'settle 到期应调用 wallpaperEngineLayerReady("dwm", settleToken)');
  assert.ok(env2.calls.includes('clearFreeze'), '揭示同时清除冻结帧');
});

function makePlaybackEnv() {
  const layer = fakeEl('wallpaper-engine-layer');
  const image = fakeEl('wallpaper-engine-image');
  const video = fakeEl('wallpaper-engine-video');
  const body = { classList: makeClassList('body') };
  const els = { 'wallpaper-engine-layer': layer, 'wallpaper-engine-image': image, 'wallpaper-engine-video': video };
  const item = {
    id: 'project-id',
    title: 'Neon Scene',
    enginePlayable: true,
    playable: false,
    hasPreview: true,
    mediaType: 'video',
    projectType: 'scene'
  };
  const state = { startedWith: null };
  const sandbox = {
    console,
    document: {
      hidden: false,
      body,
      getElementById: (id) => (id === 'custom-bg-video' ? null : (els[id] || null))
    },
    window: {},
    wallpaperEngineLayerToken: 0,
    wallpaperEngineSwitchTimer: 0,
    wallpaperEngineRuntimeError: '',
    wallpaperEngineHostRecoveryInFlight: false,
    wallpaperEngineNativeSessionId: '',
    WALLPAPER_ENGINE_SWITCH_FADE_MS: 440,
    WALLPAPER_ENGINE_HOST_RECOVERY_MAX_ATTEMPTS: 3,
    // 批4 起 apply 入口有 enabled 闸（state.js 的 wallpaperEngineEnabled），行为环境按默认启用铺垫
    wallpaperEngineEnabled: true,
    wallpaperEngineSelection: { id: item.id, kind: 'engine', mediaType: 'video', active: true }
  };
  vm.createContext(sandbox);
  vm.runInContext(read(COPY2_DIR + 'wallpaper-engine-playback.js'), sandbox, { filename: 'wallpaper-engine-playback.js' });
  // playback.js 自身的声明先行，桩必须在 run 之后覆盖
  sandbox.wallpaperEngineProjectById = () => item;
  sandbox.wallpaperEngineMediaUrl = (proj, kind) => `stellaflix-wallpaper://${kind}/${proj.id}`;
  sandbox.stopWallpaperEngineNativeSession = () => Promise.resolve({ ok: true });
  sandbox.updateWallpaperEngineEntryUi = () => {};
  sandbox.showToast = () => {};
  sandbox.wallpaperEngineNativeHostUnavailable = () => false;
  sandbox.cancelWallpaperEngineSwitchTimer = () => {};
  sandbox.cancelWallpaperEngineVideoRetry = () => {};
  sandbox.cancelWallpaperEngineFirstFrameWait = () => {};
  sandbox.cancelWallpaperEngineHostRecovery = () => {};
  sandbox.clearWallpaperEngineFreezeFrame = () => {};
  sandbox.stopWallpaperEngineCaptureStream = () => {};
  sandbox.stopWallpaperEngineGlassCaptureStream = () => {};
  sandbox.reportWallpaperEngineCaptureResult = () => Promise.resolve({ ok: true });
  sandbox.renderWallpaperEngineLibrary = () => {};
  sandbox.queueWallpaperEnginePointerActivity = () => {};
  sandbox.scheduleWallpaperEngineGlassSamplerCapture = () => {};
  sandbox.startWallpaperEngineNativeBackground = (proj, token) => {
    state.startedWith = token;
    return new Promise(() => {}); // 原生起播挂起，模拟数秒黑窗
  };
  return { sandbox, body, layer, image, video, item, state };
}

test('A1 行为：playback.js 引擎起播先立 loading 门 + 挂预览海报，ready 摘门、dwm 接管后海报不回盖', async () => {
  const env = makePlaybackEnv();
  env.sandbox.applyWallpaperEngineBackground(env.item, true);
  assert.equal(env.body.classList.contains('wallpaper-engine-loading'), true, 'applyBackground 必须给 body 挂 wallpaper-engine-loading');
  assert.equal(env.state.startedWith, env.sandbox.wallpaperEngineLayerToken, '原生起播应携带本次 token');
  assert.equal(env.image.src, 'stellaflix-wallpaper://preview/project-id', 'engine 起播期间必须先解码项目预览海报');
  assert.equal(typeof env.image.onload, 'function', '海报需 onload 回调走 image 层揭示');

  env.image.onload();
  assert.equal(env.body.classList.contains('wallpaper-engine-loading'), false, 'layerReady 必须摘掉 loading 门');
  assert.equal(env.layer.classList.contains('image-ready'), true, '海报应走 image-ready 揭示');

  // 原生面已接管：再次解码不得把静帧海报盖回实时壁纸之上
  const env2 = makePlaybackEnv();
  env2.sandbox.applyWallpaperEngineBackground(env2.item, true);
  env2.body.classList.add('wallpaper-engine-dwm-active');
  env2.image.onload();
  assert.equal(env2.layer.classList.contains('image-ready'), false, 'dwm-active 后海报 onload 必须跳过 layerReady');

  // layerFailed 与 restore 两条退路也必须摘门
  const env3 = makePlaybackEnv();
  env3.sandbox.applyWallpaperEngineBackground(env3.item, true);
  const failedToken = env3.sandbox.wallpaperEngineLayerToken;
  env3.sandbox.wallpaperEngineLayerFailed({ id: 'project-id', title: 'x', hasPreview: false }, 'engine', failedToken);
  assert.equal(env3.body.classList.contains('wallpaper-engine-loading'), false, 'layerFailed 必须摘掉 loading 门');
  const env4 = makePlaybackEnv();
  env4.sandbox.applyWallpaperEngineBackground(env4.item, true);
  env4.sandbox.restoreOriginalBackgroundAfterWallpaperEngine();
  assert.equal(env4.body.classList.contains('wallpaper-engine-loading'), false, 'restore 必须摘掉 loading 门');
});
