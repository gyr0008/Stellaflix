'use strict';

/**
 * tests/mini-player-renderer.test.js — Task 6 渲染端迷你播放器契约
 *
 * 覆盖：
 *   ① 06-mini-player.js 存在、声明 7 个全局函数、无 'mineradio' 残留；
 *   ② index-loader 在 10-shell 段 05-startup-bindings 之后注册新模块；
 *   ③ fx-defaults 追加 8 个 miniPlayer 键且默认值逐字符合 R5 裁定；
 *   ④ index.html 迷你播放器设置块含全部必需 id、无 'mineradio'；
 *   ⑤ 04-desktop-overlay-fullscreen 的 minimize 分支引用 collapseToMiniPlayer；
 *   ⑥ vm 沙箱行为：pushMiniPlayerState 判重（同签名二推不发；force=true 必发；
 *      首推含 meta+visual；payload 不带 uiLanguage —— R4）；
 *      handleDesktopMiniPlayerCommand exit-wallpaper 分支落 fx 并调 applyCoverWallpaperState。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(APP_ROOT, rel), 'utf8');

const MODULE_REL = 'public/js/modules/10-shell/06-mini-player.js';

test('① 渲染模块存在，声明 7 个全局函数，无 mineradio 残留', () => {
  const src = read(MODULE_REL);
  ['pushMiniPlayerState', 'collapseToMiniPlayer', 'handleDesktopMiniPlayerCommand',
    'toggleMiniPlayerSetting', 'toggleMiniPlayerVisual', 'setDesktopMiniPlayerMode',
    'miniPlayerThemePayload',
  ].forEach((name) => {
    assert.match(src, new RegExp('^function ' + name + '\\(', 'm'), '缺少全局函数 ' + name);
  });
  assert.doesNotMatch(src, /mineradio/i);
});

test('② index-loader 在 05-startup-bindings 之后注册 06-mini-player', () => {
  const loader = read('public/js/index-loader.js');
  const lines = loader.split(/\r?\n/);
  const at = lines.findIndex((l) => l.includes("'js/modules/10-shell/05-startup-bindings.js'"));
  assert.ok(at >= 0, '找不到 05-startup-bindings 注册行');
  assert.match(lines[at + 1], /'js\/modules\/10-shell\/06-mini-player\.js',/, '新模块必须紧跟 10-shell 段尾');
});

test('③ fx-defaults 追加 8 个 miniPlayer 键与精确默认值', () => {
  const src = read('public/js/modules/00-state/04-fx-defaults.js');
  [
    /miniPlayerEnabled:\s*true/,
    /miniPlayerMode:\s*'standard'/,
    /miniPlayerHoverExpand:\s*true/,
    /miniPlayerPulseEnabled:\s*true/,
    /miniPlayerPulseStrength:\s*1\b/,
    /miniPlayerGlowEnabled:\s*true/,
    /miniPlayerGlowStrength:\s*1\b/,
    /miniPlayerRadius:\s*12\b/,
  ].forEach((re) => assert.match(src, re));
});

test('④ index.html 迷你播放器设置块：必需 id 全在，且无 mineradio 残留', () => {
  const html = read('public/index.html');
  const start = html.indexOf('fx-mini-player-settings');
  assert.ok(start > 0, '缺少 fx-mini-player-settings 块');
  const block = html.slice(start, html.indexOf('</div>\n      </div>', start) > 0 ? html.length : start + 4000);
  ['id="t-miniPlayer"', 'id="mini-player-mode-seg"', 'data-mini-player-mode="standard"',
    'data-mini-player-mode="compact"', 'id="t-miniPlayerHover"', 'id="t-miniPlayerPulse"',
    'id="t-miniPlayerGlow"', 'id="fx-miniplayerpulse"', 'id="fx-miniplayerglow"',
    'id="fx-miniplayerradius"',
  ].forEach((needle) => assert.ok(block.includes(needle), '设置块缺少 ' + needle));
  assert.doesNotMatch(block, /mineradio/i);
});

test('⑤ minimize 分支改调 collapseToMiniPlayer（保留原生最小化兜底）', () => {
  const src = read('public/js/modules/10-shell/04-desktop-overlay-fullscreen.js');
  const m = src.match(/action === 'minimize'[\s\S]{0,320}/);
  assert.ok(m, '找不到 minimize 分支');
  assert.match(m[0], /collapseToMiniPlayer/);
  assert.match(m[0], /animateDesktopWindowMinimize\(api\)/, 'collapse 不可用时必须回退原生最小化');
});

// —— ⑥ vm 沙箱行为 ——

function fakeEl() {
  return {
    classList: { add() {}, remove() {}, toggle() {}, contains() { return true; } },
    setAttribute() {}, getAttribute() { return null; },
    title: '', value: 0, style: {}, textContent: '',
    parentElement: { querySelector() { return null; } },
    addEventListener() {},
  };
}

function buildRendererContext(overrides) {
  overrides = overrides || {};
  const calls = { updates: [], minimize: 0, saveLyricLayout: [], applyCoverWallpaper: [], toast: [], toggleFx: [], togglePlay: 0, prev: 0, next: 0 };
  const sandbox = {
    fx: Object.assign({
      miniPlayerEnabled: true, miniPlayerMode: 'standard',
      miniPlayerHoverExpand: true, miniPlayerPulseEnabled: true, miniPlayerPulseStrength: 1,
      miniPlayerGlowEnabled: true, miniPlayerGlowStrength: 1, miniPlayerRadius: 12,
      desktopLyrics: false, coverWallpaper: true,
    }, overrides.fx || {}),
    fxDefaults: { miniPlayerPulseStrength: 1, miniPlayerGlowStrength: 1, miniPlayerRadius: 12 },
    playQueue: [{ name: 'Song A', artist: 'B' }],
    currentIdx: 0,
    playing: true,
    audio: { src: 'x', paused: false, ended: false },
    currentDesktopSongMeta: () => ({ title: 'Song A', artist: 'B', cover: 'data:image/png;base64,AAA', _signature: 'Song A|B|data:image/png;base64,AAA' }),
    desktopOverlayColors: () => ({ primary: '#fff', secondary: '#eee', highlight: '#ddd', glow: '#ccc' }),
    desktopRuntimeState: { minimized: false, visible: true },
    beatPulse: 0, smoothBass: 0, smoothEnergy: 0,
    audioCtx: null, analyser: null, frequencyData: null, beatAnalyser: null, beatFrequencyData: null,
    clampRange: (v, a, b) => Math.max(a, Math.min(b, Number(v))),
    isDevelopmentLockedFx: () => false,
    getDesktopWindowApi: () => sandbox.window.desktopWindow,
    saveLyricLayout: (opts) => calls.saveLyricLayout.push(opts),
    updateFxInputs: () => {},
    applyCoverWallpaperState: (force) => { calls.applyCoverWallpaper.push(force); return Promise.resolve({ ok: true }); },
    showToast: (msg) => calls.toast.push(msg),
    toggleFx: (key) => calls.toggleFx.push(key),
    togglePlay: () => { calls.togglePlay += 1; },
    prevTrack: () => { calls.prev += 1; },
    nextTrack: () => { calls.next += 1; },
    document: {
      hidden: false, fullscreenElement: null, offsetWidth: 0,
      body: fakeEl(),
      documentElement: { classList: fakeEl().classList, style: { setProperty() {} } },
      getElementById: () => fakeEl(),
      querySelectorAll: () => [],
    },
    window: {
      matchMedia: () => ({ matches: false }),
      addEventListener: () => {},
      desktopWindow: {
        isDesktop: false, // 初始判定走非桌面分支，IIFE 注册块跳过；updateMiniPlayer 仍可被 push 直接使用
        minimize: () => { calls.minimize += 1; return Promise.resolve(); },
        prepareMiniPlayerTransition: () => Promise.resolve({ ok: true }),
        setMiniPlayerEnabled: () => Promise.resolve({ ok: true, miniPlayerEnabled: true }),
        setMiniPlayerMode: () => Promise.resolve({ ok: true, miniPlayerMode: 'standard' }),
        updateMiniPlayer: (payload) => { calls.updates.push(payload); return Promise.resolve({ ok: true }); },
      },
    },
    performance: { now: () => 10000 },
    setTimeout: () => 0,
    clearTimeout: () => {},
    console, Object, Promise, Math, Number, String, Array, JSON,
  };
  vm.createContext(sandbox);
  vm.runInContext(read(MODULE_REL), sandbox);
  return { sandbox, calls };
}

test('⑥a 首推携带 meta+visual；同签名二推判重不发；force=true 必发', async () => {
  const { sandbox, calls } = buildRendererContext();
  sandbox.pushMiniPlayerState(false, false);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.updates.length, 1, '首次推送必须发一条补丁');
  const first = calls.updates[0];
  assert.equal(first.title, 'Song A');
  assert.equal(first.artist, 'B');
  assert.equal(first.cover, 'data:image/png;base64,AAA');
  assert.ok(first.metaSignature, '首推必须带 metaSignature');
  assert.equal(first.visual.pulseEnabled, true);
  assert.equal(first.visual.radius, 12);
  assert.equal(first.miniPlayerMode, 'standard');
  assert.ok(!('uiLanguage' in first), 'R4：payload 不得再带 uiLanguage 字段');

  sandbox.pushMiniPlayerState(false, false);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.updates.length, 1, '状态未变化时二推必须判重，不产生 IPC');

  sandbox.pushMiniPlayerState(true, false);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.updates.length, 2, 'force=true 必须绕过判重完整重发');
});

test('⑥b 判重缓存失效路径：updateMiniPlayer 回包 !ok 时三推重发', async () => {
  const { sandbox, calls } = buildRendererContext();
  sandbox.window.desktopWindow.updateMiniPlayer = (payload) => {
    calls.updates.push(payload);
    return Promise.resolve({ ok: false });
  };
  sandbox.pushMiniPlayerState(false, false);
  await new Promise((r) => setTimeout(r, 0));
  sandbox.pushMiniPlayerState(false, false);
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(calls.updates.length >= 2, '失败补丁必须 invalidate，给下一次重发机会');
});

test('⑥c exit-wallpaper 命令：落 fx.coverWallpaper、按 reason 保存并调 applyCoverWallpaperState', async () => {
  const { sandbox, calls } = buildRendererContext();
  sandbox.handleDesktopMiniPlayerCommand({ action: 'exit-wallpaper' });
  assert.equal(sandbox.fx.coverWallpaper, false);
  assert.deepEqual(calls.applyCoverWallpaper, [true]);
  assert.equal(calls.saveLyricLayout.length, 1);
  assert.equal(calls.saveLyricLayout[0].reason, 'miniPlayerExitWallpaper');
  assert.equal(calls.saveLyricLayout[0].user, true);
});

test('⑥d 播放命令路由到既有全局播放函数', () => {
  const { sandbox, calls } = buildRendererContext();
  sandbox.handleDesktopMiniPlayerCommand({ action: 'toggle-play' });
  sandbox.handleDesktopMiniPlayerCommand({ action: 'previous' });
  sandbox.handleDesktopMiniPlayerCommand({ action: 'next' });
  sandbox.handleDesktopMiniPlayerCommand({ action: 'toggle-desktop-lyrics' });
  assert.equal(calls.togglePlay, 1);
  assert.equal(calls.prev, 1);
  assert.equal(calls.next, 1);
  assert.deepEqual(calls.toggleFx, ['desktopLyrics']);
});

test('⑥e fx.miniPlayerEnabled=false 时 collapseToMiniPlayer 返回 false（保持原生最小化、零推送）', () => {
  const { sandbox, calls } = buildRendererContext({ fx: { miniPlayerEnabled: false } });
  const before = calls.updates.length;
  assert.equal(sandbox.collapseToMiniPlayer(), false);
  assert.equal(calls.minimize, 0, '不可用时 collapse 内部不得自行最小化，由调用方回退 animateDesktopWindowMinimize');
  assert.equal(calls.updates.length, before, '迷你播放器关闭时最小化路径不推送任何状态');
});

test('⑦ 播放态广播点驱动脉冲计时与迷你状态推送（参照 app.js:28409-28418/32738）', () => {
  const src = read('public/js/modules/05-playback/12-playback-switch-core.js');
  const fn = src.slice(src.indexOf('function syncPlaybackStateFromAudioEvent'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /syncMiniPlayerPulseTimer/);
  assert.match(body, /pushMiniPlayerState\(false,\s*true\)/);
});

test('⑧ 桌面运行态与 visibilitychange 挂钩 syncMiniPlayerPulseTimer（参照 app.js:3159/3169）', () => {
  const src = read('public/js/modules/00-state/08-desktop-render-power.js');
  const vis = src.slice(src.indexOf("document.addEventListener('visibilitychange'"));
  assert.match(vis.slice(0, 400), /syncMiniPlayerPulseTimer/);
  const stateFn = src.slice(src.indexOf('desktopRuntimeState.minimized ='));
  assert.match(stateFn.slice(0, 700), /syncMiniPlayerPulseTimer/);
});

test('⑨ 模式切换段高亮走 .fx-seg 的 CSS 契约类 active', () => {
  const src = read(MODULE_REL);
  const seg = src.slice(src.indexOf("#mini-player-mode-seg"));
  assert.match(seg.slice(0, 200), /classList\.toggle\('active'/);
});
