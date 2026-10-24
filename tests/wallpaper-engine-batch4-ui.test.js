'use strict';

/**
 * tests/wallpaper-engine-batch4-ui.test.js — WE 前端移植契约（批 4：停用/启用钮 + CSS 行布局修复）
 *
 * 移植来源：Mineradio-2.5.1 public/wallpaper-engine.js H4/H40（enabled 状态机 +
 * toggleWallpaperEngineBackground），public/index.html L285-292（三钮行），
 * public/wallpaper-engine.css :187-213（3-col actions + .fx-mini-btn.on）、
 * :670-679（v2.0.10 行溢出修复，替换我方 translateX(-100px) hack）。
 * 双拷贝 lockstep（后加载者赢）：
 *   COPY-1: public/js/modules/07-fx/03-wallpaper-engine-library.js
 *   COPY-2: public/video/wallpaper-engine/wallpaper-engine-*.js
 * 双 CSS lockstep：public/css/index.css 与 public/video/wallpaper-engine.css 两条级联都在生效。
 * 主人拍板差异：默认启用（上游默认停用）；文案纯中文，不引 uiText。
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
const BOTH = [['COPY-1', copy1], ['COPY-2', copy2]];

const indexHtml = read('public/index.html');
const cssMain = read('public/css/index.css');
const cssVideo = read('public/video/wallpaper-engine.css');

// ---------------------------------------------------------------------------
// 1) index.html：停用/启用钮（截图 UI 的最后一块）
// ---------------------------------------------------------------------------

test('index.html：WE 行必须有 #wallpaper-engine-toggle-btn，且在「识别 / 导入」之前', () => {
  const row = indexHtml.match(/<div class="wallpaper-engine-actions">[\s\S]{0,600}?<\/div>/);
  assert.ok(row, '找不到 .wallpaper-engine-actions 行');
  assert.match(row[0], /id="wallpaper-engine-toggle-btn"[^>]*onclick="toggleWallpaperEngineBackground\(\)"/,
    'toggle 钮必须以 onclick 调用全局 toggleWallpaperEngineBackground');
  assert.match(row[0], /aria-pressed=/, 'toggle 钮需要 aria-pressed 状态');
  const toggleIdx = row[0].indexOf('wallpaper-engine-toggle-btn');
  const importIdx = row[0].indexOf('openWallpaperEngineLibrary()');
  assert.ok(toggleIdx >= 0 && importIdx >= 0 && toggleIdx < importIdx, '顺序必须为 停用/启用 → 识别/导入 → 恢复原背景');
});

// ---------------------------------------------------------------------------
// 2) enabled 状态机源码钉（双拷贝 lockstep）
// ---------------------------------------------------------------------------

for (const [label, text] of BOTH) {
  test(`${label}：enabled 状态机 — store key、默认启用、持久化、backgroundActive、toggle/enable 流程`, () => {
    assert.match(text, /var WALLPAPER_ENGINE_ENABLED_STORE_KEY = 'stellaflix-wallpaper-engine-enabled-v1';/,
      `${label} 缺少 enabled store key`);
    // 主人拍板：Stellaflix 默认启用（上游默认停用，v1.4.3 我方已反转，不得跟删）
    assert.match(text, /function readWallpaperEngineEnabled\(\)[\s\S]{0,260}?return raw !== '0' && raw !== 'false';/,
      `${label} readWallpaperEngineEnabled 必须默认 true（仅 '0'/'false' 视为停用）`);
    assert.match(text, /function saveWallpaperEngineEnabled\(\)[\s\S]{0,200}?wallpaperEngineEnabled \? '1' : '0'/,
      `${label} saveWallpaperEngineEnabled 必须持久化 '1'/'0'`);
    assert.match(text, /function wallpaperEngineBackgroundActive\(\)[\s\S]{0,160}?wallpaperEngineEnabled && !!wallpaperEngineSelection\.active/,
      `${label} wallpaperEngineBackgroundActive 必须同时看 enabled 与 selection.active`);
    assert.match(text, /function toggleWallpaperEngineBackground\(\)/, `${label} 缺少全局 toggleWallpaperEngineBackground`);
    // 停用路径：deactivate(quiet) + enabled=false + save + 中文 toast
    assert.match(text, /function toggleWallpaperEngineBackground\(\)[\s\S]{0,600}?deactivateWallpaperEngineBackground\(true\)/,
      `${label} 停用分支必须复用 deactivate 拆除链（清 active、停 session、恢复原背景）`);
    // 启用路径：busy gate → 无选择引导开库 → 有选择则 enabled=true 并 apply
    assert.match(text, /Wallpaper Engine 库正在更新，请稍后再启用/, `${label} 启用分支缺少 busy 提示文案`);
    assert.match(text, /请先识别并选择 Wallpaper Engine 壁纸/, `${label} 启用分支缺少未选择引导文案`);
    assert.match(text, /openWallpaperEngineLibrary\(\)/, `${label} 未选择时必须打开壁纸库`);
    assert.match(text, /function activateWallpaperEngineItem\(id\)[\s\S]{0,1400}?wallpaperEngineEnabled = true;\s*\n\s*saveWallpaperEngineEnabled\(\);/,
      `${label} activateItem（用户显式选中）必须自动转正 enabled（保持我方「选中即应用」语义）`);
    assert.match(text, /function initializeWallpaperEngineLibrary\(\)[\s\S]{0,240}?if \(!wallpaperEngineEnabled \|\| !wallpaperEngineSelection\.active\) return;/,
      `${label} 启动自动恢复必须被 enabled 闸住（停用后重启不回灌壁纸）`);
  });

  test(`${label}：入口 UI 必须渲染 toggle 钮三态（停用/启用 + .on + aria-pressed）`, () => {
    assert.match(text, /function updateWallpaperEngineEntryUi\(message\)[\s\S]{0,1800}?getElementById\('wallpaper-engine-toggle-btn'\)/,
      `${label} updateWallpaperEngineEntryUi 未取 toggle 钮`);
    assert.match(text, /toggle\.classList\.toggle\('on', wallpaperEngineEnabled\)/, `${label} 缺少 .on 态切换（CSS 激活样式依赖它）`);
    assert.match(text, /toggle\.textContent = wallpaperEngineEnabled \? '停用' : '启用'/, `${label} 缺少 停用/启用 文案切换`);
    assert.match(text, /toggle\.setAttribute\('aria-pressed'/, `${label} 缺少 aria-pressed 同步`);
    // 停用后（active=false 但 id 保留）值区显示「<标题> · 已停用」
    assert.match(text, /' · 已停用'/, `${label} 停用态值区缺少「· 已停用」回显`);
  });
}

// ---------------------------------------------------------------------------
// 3) 双 CSS lockstep：v2.0.10 行布局修复 + 3 列 + .fx-mini-btn.on
// ---------------------------------------------------------------------------

for (const [label, css] of [['index.css', cssMain], ['video/wallpaper-engine.css', cssVideo]]) {
  test(`${label}：必须删除 translateX(-100px) hack（v2.0.10 clamp 列宽取代）`, () => {
    assert.doesNotMatch(css, /translateX\(-100px\)/, `${label} 仍残留 translateX(-100px) 魔法偏移 hack`);
  });

  test(`${label}：actions 网格三列 + .fx-mini-btn.on 激活样式 + WE 行 clamp 第三列`, () => {
    assert.match(css, /\.wallpaper-engine-actions\s*{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/,
      `${label} .wallpaper-engine-actions 基础规则必须 3 列（三钮：停用/识别导入/恢复原背景）`);
    assert.match(css, /\.wallpaper-engine-actions \.fx-mini-btn\.on\s*{/, `${label} 缺少 .fx-mini-btn.on 激活样式`);
    assert.match(css, /clamp\(176px,\s*40vw,\s*224px\)/, `${label} 缺少 v2.0.10 的 WE 行第三列 clamp 宽度`);
  });
}

// ---------------------------------------------------------------------------
// 4) 行为验证（COPY-2 state.js 在 vm 中可独立执行，house style 同批 3b）
// ---------------------------------------------------------------------------

test('vm 行为：enabled 默认启用、save 持久化 0/false 语义、背景活动闸', () => {
  const store = new Map();
  const localStorageStub = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  const ctx = vm.createContext({
    console,
    localStorage: localStorageStub,
    window: {},
    document: { hidden: false, addEventListener() {}, getElementById: () => null },
    navigator: {},
    setTimeout() { return 0; }, clearTimeout() {}, setInterval() { return 0; }, clearInterval() {},
  });
  vm.runInContext(read(COPY2_DIR + 'wallpaper-engine-state.js'), ctx);
  const readEnabled = ctx.readWallpaperEngineEnabled;
  const saveEnabled = ctx.saveWallpaperEngineEnabled;
  assert.equal(typeof readEnabled, 'function', 'state.js 未导出 readWallpaperEngineEnabled');
  assert.equal(readEnabled(), true, '无存储值时必须默认启用');
  store.set('stellaflix-wallpaper-engine-enabled-v1', '0');
  assert.equal(readEnabled(), false, "'0' 必须解析为停用");
  store.set('stellaflix-wallpaper-engine-enabled-v1', 'false');
  assert.equal(readEnabled(), false, "'false' 必须解析为停用");
  store.set('stellaflix-wallpaper-engine-enabled-v1', '1');
  assert.equal(readEnabled(), true, "'1' 必须解析为启用");
  ctx.wallpaperEngineEnabled = false;
  saveEnabled();
  assert.equal(store.get('stellaflix-wallpaper-engine-enabled-v1'), '0', 'save(false) 必须写 \'0\'');
  ctx.wallpaperEngineEnabled = true;
  saveEnabled();
  assert.equal(store.get('stellaflix-wallpaper-engine-enabled-v1'), '1', 'save(true) 必须写 \'1\'');
  // backgroundActive 双闸
  ctx.wallpaperEngineEnabled = true;
  ctx.wallpaperEngineSelection.active = false;
  assert.equal(ctx.wallpaperEngineBackgroundActive(), false, 'selection 未激活时不得活动');
  ctx.wallpaperEngineSelection.active = true;
  assert.equal(ctx.wallpaperEngineBackgroundActive(), true, 'enabled+active 才活动');
  ctx.wallpaperEngineEnabled = false;
  assert.equal(ctx.wallpaperEngineBackgroundActive(), false, '停用后即便 active 也不得活动');
});

// ---------------------------------------------------------------------------
// 5) 行为验证（批4 交付口径）：toggle 停用 → 启用经既有 apply 路径重放最后选择
// ---------------------------------------------------------------------------

function makeToggleEnv() {
  const calls = [];
  const fakeBody = { classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } };
  const sandbox = {
    console,
    // playback.js 自声明的 restore/clear 链在 vm 内真实执行：给到空 DOM 即可安全穿过
    document: { hidden: false, body: fakeBody, getElementById: () => null, addEventListener() {}, removeEventListener() {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    window: {},
    wallpaperEngineEnabled: true,
    wallpaperEngineLibraryBusy: false,
    wallpaperEngineLayerToken: 0,
    wallpaperEngineHostBoundsRestartTimer: 0,
    wallpaperEngineRuntimeError: 'stale',
    wallpaperEngineDesktopPreviewActive: true,
    wallpaperEngineDesktopPreviewUsesAsset: true,
    wallpaperEngineHostBoundsPreparing: true,
    wallpaperEngineSelection: {
      id: 'a1b2c3d4e5f60718293a4b5c', title: 'Aurora', kind: 'engine',
      mediaType: 'video', active: true,
    },
    updateWallpaperEngineEntryUi: () => { calls.push('entryUi'); },
    showToast: (t) => { calls.push('toast:' + t); },
    saveWallpaperEngineEnabled: () => { calls.push('saveEnabled:' + (sandbox.wallpaperEngineEnabled ? '1' : '0')); },
    saveWallpaperEngineSelection: () => { calls.push('saveSelection'); },
    wallpaperEngineProjectById: (id) => (
      id === 'a1b2c3d4e5f60718293a4b5c'
        ? { id, title: 'Aurora', enginePlayable: true, playable: false, hasPreview: true, projectType: 'scene' }
        : null),
    applyWallpaperEngineBackground: (item, quiet) => { calls.push('apply:' + (item && item.id) + ':' + quiet); },
    closeWallpaperEngineLibrary: () => { calls.push('closeLibrary'); },
    openWallpaperEngineLibrary: () => { calls.push('openLibrary'); },
    loadWallpaperEngineLibrary: () => { calls.push('loadLibrary'); return Promise.resolve([]); },
    cancelWallpaperEngineHostRecovery: () => { calls.push('cancelRecovery'); },
    cancelWallpaperEngineSwitchTimer: () => { calls.push('cancelSwitch'); },
    cancelWallpaperEngineVideoRetry: () => { calls.push('cancelRetry'); },
    cancelWallpaperEngineFirstFrameWait: () => { calls.push('cancelFirstFrame'); },
    stopWallpaperEngineCaptureStream: () => { calls.push('stopCapture'); },
    stopWallpaperEngineGlassCaptureStream: () => { calls.push('stopGlassCapture'); },
    stopWallpaperEngineNativeSession: () => { calls.push('stopSession'); return Promise.resolve({ ok: true }); },
    restoreOriginalBackgroundAfterWallpaperEngine: () => { calls.push('restoreBg'); },
    clearWallpaperEngineFreezeFrame: () => { calls.push('clearFreeze'); },
    clearWallpaperEngineLayerMedia: () => { calls.push('clearMedia'); },
    renderWallpaperEngineLibrary: () => { calls.push('renderLibrary'); },
  };
  vm.createContext(sandbox);
  vm.runInContext(read(COPY2_DIR + 'wallpaper-engine-playback.js'), sandbox, { filename: 'wallpaper-engine-playback.js' });
  // playback.js 自身声明先行（apply/restore/clearLayerMedia 在本文件内），桩必须在 run 之后覆盖（house style 同 flicker 套件）
  sandbox.applyWallpaperEngineBackground = (item, quiet) => { calls.push('apply:' + (item && item.id) + ':' + quiet); };
  sandbox.restoreOriginalBackgroundAfterWallpaperEngine = () => { calls.push('restoreBg'); };
  sandbox.clearWallpaperEngineLayerMedia = () => { calls.push('clearMedia'); };
  return { sandbox, calls };
}

test('vm 行为：toggle 停用→deactivate 落盘 enabled=false；再启用经 apply 重放最后选择', () => {
  const env = makeToggleEnv();
  const { sandbox, calls } = env;

  // 1) 停用：deactivate 全链（quiet），enabled=false 落盘，选择 id 保留供重放。
  sandbox.toggleWallpaperEngineBackground();
  assert.equal(sandbox.wallpaperEngineEnabled, false);
  assert.equal(sandbox.wallpaperEngineSelection.active, false);
  assert.equal(sandbox.wallpaperEngineSelection.id, 'a1b2c3d4e5f60718293a4b5c', '停用须保留最后选择');
  assert.ok(calls.includes('saveEnabled:0'), calls.join('|'));
  assert.ok(calls.includes('restoreBg'));
  assert.ok(calls.includes('stopSession'));
  assert.ok(!calls.some((c) => c.startsWith('apply:')), '停用路径不得再 apply');

  // 2) 启用：enabled=true + active 复位 + 既有 apply 路径重放最后选择。
  calls.length = 0;
  sandbox.toggleWallpaperEngineBackground();
  assert.equal(sandbox.wallpaperEngineEnabled, true);
  assert.equal(sandbox.wallpaperEngineSelection.active, true);
  assert.ok(calls.includes('saveEnabled:1'));
  assert.ok(calls.includes('saveSelection'));
  assert.ok(calls.includes('apply:a1b2c3d4e5f60718293a4b5c:false'), '启用必须重放最后选择：' + calls.join('|'));
  assert.equal(sandbox.wallpaperEngineRuntimeError, '');

  // 3) 库忙时启用被拒（busy 门），不切 enabled。
  calls.length = 0;
  sandbox.wallpaperEngineEnabled = false;
  sandbox.wallpaperEngineLibraryBusy = true;
  sandbox.toggleWallpaperEngineBackground();
  assert.equal(sandbox.wallpaperEngineEnabled, false, 'busy 时不得启用');
  assert.ok(calls.some((c) => c.includes('库正在更新')));

  // 4) 无选择时启用 → 提示 + 打开资料库。
  calls.length = 0;
  sandbox.wallpaperEngineLibraryBusy = false;
  sandbox.wallpaperEngineSelection = { id: '', title: '', kind: 'preview', active: false };
  sandbox.toggleWallpaperEngineBackground();
  assert.equal(sandbox.wallpaperEngineEnabled, false);
  assert.ok(calls.includes('openLibrary'));
  assert.ok(calls.some((c) => c.includes('请先识别并选择')));
});

// ---------------------------------------------------------------------------
// 6) 粒子与壁纸共存（主人 10-18 真机反馈，推翻批4「不跟改」判定）：
//    上游 layer z-index 0 + 激活期不隐藏 #canvas-container，粒子画布（three.js
//    alpha:true / scene.background=null）浮在壁纸之上双显。我方原 z=2 + 双隐
//    清单把粒子压在壁纸下 → 只剩壁纸。恢复清单只针对底色组，不含画布。
// ---------------------------------------------------------------------------

for (const [label, css] of [['index.css', cssMain], ['video/wallpaper-engine.css', cssVideo]]) {
  test(`${label}：WE 层 z-index 必须为 0（粒子画布 z=1 浮于壁纸之上，DOM 序在画布之前）`, () => {
    assert.match(css, /#wallpaper-engine-layer\s*{[^}]*z-index:\s*0/,
      `${label} #wallpaper-engine-layer 必须 z-index:0，让 #canvas-container(z=1) 粒子盖在壁纸上`);
  });

  test(`${label}：wallpaper-engine-active / dwm-active 隐藏清单不得含 #canvas-container`, () => {
    assert.doesNotMatch(css, /body\.wallpaper-engine-active\s+#canvas-container/,
      `${label} 普通激活期不得隐藏粒子画布（上游 H5 软化）`);
    assert.doesNotMatch(css, /body\.wallpaper-engine-dwm-active[^,{]*#canvas-container/,
      `${label} DWM 透视期不得隐藏粒子画布（three.js 画布 alpha:true 透明底，不会挡原生场景）`);
    // 底色组仍须隐藏（custom-bg 是 DWM 黑屏修复的当事元素）
    assert.match(css, /body\.wallpaper-engine-dwm-active #custom-bg/, `${label} 底色组隐藏不得连带删除`);
  });
}
