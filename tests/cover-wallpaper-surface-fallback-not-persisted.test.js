'use strict';

/**
 * tests/cover-wallpaper-surface-fallback-not-persisted.test.js
 * —— 运行时降级不得写盘（桌面壁纸层挂不上 ≠ 用户改主意）
 *
 * 【被锁定的缺陷（改前真实行为）】
 *   18-cover-wallpaper.js 的降级分支原本是：
 *       if (desktopActive && result.ok === true && coverWallpaperDesktopLayerHidden(result.status)) {
 *         setCoverWallpaperSurface('board');     // ← 内部 saveLyricLayout({ user: true })
 *         showToast('...已改用播放器背景板');
 *       }
 *   于是任何一次「运行时判定桌面层不可见」（hostStrategy 落到 'progman' 本体，
 *   见 coverWallpaperDesktopLayerHidden 147-153）都会被永久写成用户选择：
 *     · fx.coverWallpaperSurface 被改成 'board'
 *     · current-fx-autosave.json 落盘 'board'
 *   用户可见面：点壁纸模式再也出不来「后面铺满屏幕的那层壁纸」，
 *   只剩窗口内一块背景板，而且重启也不会重试 —— 与上一轮修的
 *   「运行时回执不得反写用户开关」是同一族单向棘轮。
 *
 * 【本文件锁定的契约】
 *   A. 降级只改渲染位置（effectiveCoverWallpaperSurface() 返回 'board'）；
 *   B. 降级绝不改 fx.coverWallpaperSurface、绝不调 saveLyricLayout 写盘；
 *   C. 用户重新点分段按钮（setCoverWallpaperSurface）= 重新尝试，降级作废；
 *   D. 降级后桌面层不再被反复 setCoverWallpaperMode(true) 试探。
 *
 * 【证伪要求】把降级分支改回 setCoverWallpaperSurface('board')，
 * 用例 ①②④ 必须变红；只留 ③⑤ 绿。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_ROOT = path.join(__dirname, '..');
const SRC_PATH = path.join(APP_ROOT, 'public/js/modules/02-visual/18-cover-wallpaper.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

// 让 coverWallpaperDesktopLayerHidden() 判「桌面层不可见」的回执：
// hostStrategy 落到 'progman' 本体，即旧实现里唯一会触发降级的分支。
const HIDDEN_STATUS = Object.freeze({
  supported: true,
  enabled: true,
  active: true,
  attaching: false,
  windowId: 42,
  parentClassName: 'Progman',
  hostStrategy: 'progman',
});
// 可见且不需要降级的回执。
const VISIBLE_STATUS = Object.freeze({
  supported: true,
  enabled: true,
  active: true,
  attaching: false,
  windowId: 43,
  parentClassName: 'WorkerW',
  hostStrategy: 'shelldll-defview',
});

function buildHarness(options) {
  const opts = options || {};
  const calls = { setMode: [], update: [], toast: [], save: [], updateFxInputs: 0 };
  const api = {
    setCoverWallpaperMode: (enabled, payload) => {
      calls.setMode.push({ enabled: !!enabled, hasPayload: !!(payload && payload.enabled) });
      return Promise.resolve({
        ok: true,
        enabled: !!enabled,
        status: opts.status || VISIBLE_STATUS,
      });
    },
    updateCoverWallpaperMode: (payload) => {
      calls.update.push(payload || {});
      return Promise.resolve({ ok: true, enabled: true, status: opts.status || VISIBLE_STATUS });
    },
    getCoverWallpaperModeStatus: () => Promise.resolve(opts.status || VISIBLE_STATUS),
    onCoverWallpaperModeState: () => () => {},
  };
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    Promise,
    setTimeout,
    clearTimeout,
    setInterval: (fn) => { sandbox.__tick = fn; return 1; },
    clearInterval: () => {},
    performance: { now: () => Number(sandbox.__now || 0) },
    requestAnimationFrame: (fn) => (fn && fn(0)) || 0,
    cancelAnimationFrame: () => {},
    document: {
      getElementById: () => null,
      querySelectorAll: () => [],
      body: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, offsetWidth: 0 },
    },
    fx: Object.assign({
      coverWallpaper: true,
      coverWallpaperSurface: 'desktop',
      coverWallpaperOpacity: 1,
      preset: 0,
    }, opts.fx),
    isDevelopmentLockedFx: () => false,
    clampRange: (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0)),
    currentDesktopSongMeta: () => ({ title: 'T', artist: 'A', cover: 'C' }),
    desktopOverlayColors: () => ({}),
    getDesktopWindowApi: () => api,
    showToast: (msg) => calls.toast.push(String(msg)),
    saveLyricLayout: (options) => { calls.save.push(options || {}); },
    updateFxInputs: () => { calls.updateFxInputs++; },
    playing: false,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { sandbox, calls, api };
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

test('① 降级后用户选择不被改写：fx.coverWallpaperSurface 仍是 desktop', async () => {
  const { sandbox } = buildHarness({ status: HIDDEN_STATUS });
  await sandbox.applyCoverWallpaperState(true);
  await flush();
  assert.equal(sandbox.fx.coverWallpaperSurface, 'desktop',
    '运行时判定不可见不得被当成「用户改主意」');
});

test('② 降级不写盘：不得以 user:true 保存展示位置', async () => {
  const { sandbox, calls } = buildHarness({ status: HIDDEN_STATUS });
  await sandbox.applyCoverWallpaperState(true);
  await flush();
  const userSaves = calls.save.filter((o) => o && o.user === true);
  assert.deepEqual(userSaves, [],
    '降级路径不得调 saveLyricLayout({ user: true }) —— 那就是把运行时状态烧进存档');
});

test('③ 降级确实生效：渲染位置切到板，且当次仍试过桌面层', async () => {
  const { sandbox, calls } = buildHarness({ status: HIDDEN_STATUS });
  await sandbox.applyCoverWallpaperState(true);
  await flush();
  assert.equal(sandbox.effectiveCoverWallpaperSurface(), 'board',
    '判定不可见后本次会话要真的回落到播放器背景板');
  assert.equal(calls.setMode[0].enabled, true,
    '第一次必须真的试过桌面壁纸层，不能未试就降级');
  assert.equal(calls.toast.filter((m) => m.indexOf('桌面壁纸层不可见') >= 0).length, 1,
    '降级提示只弹一次，不许刷屏');
});

test('④ 用户重选桌面层 = 重新尝试：降级作废并发起桌面层', async () => {
  const { sandbox, calls } = buildHarness({ status: HIDDEN_STATUS });
  await sandbox.applyCoverWallpaperState(true);
  await flush();
  assert.equal(sandbox.effectiveCoverWallpaperSurface(), 'board');

  const before = calls.setMode.length;
  sandbox.setCoverWallpaperSurface('desktop');   // 用户原地重选（存档值本来就是 desktop）
  await flush();

  assert.equal(sandbox.effectiveCoverWallpaperSurface(), 'board',
    '重试仍不可见时会再次降级（会话内），但下面这两条才关键：');
  assert.equal(sandbox.fx.coverWallpaperSurface, 'desktop',
    '重试后再次降级也不得把用户选择改回 board —— 否则用户永远点不回来');
  assert.ok(calls.setMode.slice(before).some((c) => c.enabled === true),
    '重新选择必须重新向桌面层发起，否则用户永远点不回来');
});

test('⑤ 降级后 260ms 节拍不再反复试探桌面层', async () => {
  const { sandbox, calls } = buildHarness({ status: HIDDEN_STATUS });
  await sandbox.applyCoverWallpaperState(true);
  await flush();
  calls.update.length = 0;
  sandbox.__now = 10000;
  if (typeof sandbox.__tick === 'function') sandbox.__tick();
  await flush();
  assert.equal(calls.update.length, 0,
    '降级到板后 pushCoverWallpaperDesktopState 必须按板位置短路，不推桌面层状态');
});

test('⑥ 源码守卫：降级分支不得出现 setCoverWallpaperSurface(', () => {
  const anchor = SRC.indexOf('coverWallpaperDesktopLayerHidden(result.status)');
  assert.ok(anchor > 0, '降级分支必须存在（否则本条守卫失去意义）');
  const branch = SRC.slice(anchor, anchor + 700);
  assert.match(branch, /coverWallpaperRuntimeSurfaceFallback\s*=\s*'board'/,
    '降级必须只置会话内标记');
  assert.doesNotMatch(branch, /setCoverWallpaperSurface\(/,
    '降级分支禁止调 setCoverWallpaperSurface —— 它内部会 saveLyricLayout({ user: true })');
});

test('⑦ 源码守卫：所有行为判定走 effectiveCoverWallpaperSurface()', () => {
  assert.match(SRC, /function effectiveCoverWallpaperSurface\(\)/,
    '必须存在「用户选择 + 会话降级」的合成口径');

  // 只有三处允许直接读用户选择：
  //   · setCoverWallpaperSurface —— 判断「用户是否真的换了位置」（要写盘）
  //   · updateCoverWallpaperSurfaceControls —— 分段控件选中态必须反映用户选择
  //   · effectiveCoverWallpaperSurface —— 合成口径本身，读用户选择是它的职责
  function bodyOf(name) {
    const start = SRC.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' 必须存在');
    let depth = 0;
    for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
      if (SRC[i] === '{') depth++;
      else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
    }
    throw new Error(name + ' 函数体未闭合');
  }
  let rest = SRC
    .replace(bodyOf('setCoverWallpaperSurface'), '')
    .replace(bodyOf('updateCoverWallpaperSurfaceControls'), '')
    .replace(bodyOf('effectiveCoverWallpaperSurface'), '');

  const behaviorReads = rest
    .split('\n')
    .filter((line) => /normalizeCoverWallpaperSurface\(fx\.coverWallpaperSurface\)/.test(line));
  assert.deepEqual(behaviorReads, [],
    '行为分支直接读 fx.coverWallpaperSurface 会绕过会话降级：\n' + behaviorReads.join('\n'));
});
