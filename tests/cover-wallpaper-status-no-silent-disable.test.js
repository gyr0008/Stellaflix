'use strict';

/**
 * tests/cover-wallpaper-status-no-silent-disable.test.js
 * —— 运行时回执不得反写用户开关（对齐 Mineradio-2.5.1 的单向下发契约）
 *
 * 【取证依据（本次亲自复核源码，非记忆）】
 *  1. 参照库 desktop/preload.js:169-170 只暴露两个壁纸层接口：
 *       setWallpaperMode(enabled,payload) / updateWallpaperMode(payload)
 *     `grep -rn "onWallpaperModeState|wallpaper-runtime-state|WallpaperModeStatus" Mineradio-2.5.1/public/`
 *     **零命中** —— 参照库根本没有「回执 → 渲染层」的反馈通道。
 *  2. 参照库 public/app.js:45467-45468 只做
 *       api.setWallpaperMode(...).catch(function(e){ console.warn(...) })
 *     不读结果、不改 fx.wallpaperMode。用户开关的唯一真源就是用户本人。
 *  3. 我们额外加了回执链（desktop/preload.js:165-170）：
 *       getCoverWallpaperModeStatus / onCoverWallpaperModeState
 *     汇入 18-cover-wallpaper.js:85 applyCoverWallpaperRuntimeStatus，其中
 *       nextEnabled = (enabled||active) ? true : (attaching ? 原值 : false)
 *     是一条**只能减、不能加**的单向棘轮。
 *  4. 冷启动毒丸：DEFAULT_WALLPAPER_STATE.enabled === false（wallpaper-mode-runtime.js:4），
 *     未建窗时 getStatus() 回 {supported:true, enabled:false, active:false,
 *     attaching:false, windowId:null}（376-390）。这个「运行时还没启动」的空回执
 *     会被第 3 条当成「用户不要壁纸」的证据。
 *  5. 运行期同样触发：runStop()（708-716）无条件把 state.enabled 置 false 并
 *     emitStatus(reason)（730）；reconcileDisplay 失败路径（696）直接走 stop，
 *     于是任何一次重新贴合失败（显示器热插拔 / explorer 重启 / 远程桌面）
 *     都会把用户开的壁纸模式永久关掉。
 *  6. 关掉后的连锁：pushCoverWallpaperDesktopState 首行
 *     `if (!coverWallpaperEnabled()) return;`（18-cover-wallpaper.js:102）
 *     → 260ms 节拍从此不推任何状态 → 壁纸停在旧帧或整窗空白。
 *     这正是「有时候开壁纸模式不出壁纸 / 切歌后壁纸不更新」的用户可见面。
 *
 * 【本文件锁定的契约】
 *   A. 回执只在 supported === false（平台确实不支持）时允许置否；
 *   B. 其余任何回执（冷启动 windowId:null、字段缺失、attach 中、stop 回执）
 *      一律不得改动 fx.coverWallpaper；
 *   C. 回执被忽略后，260ms 节拍必须继续推送，壁纸才能跟着切歌更新。
 *
 * 【证伪要求】把 applyCoverWallpaperRuntimeStatus 改回旧版（缺 enabled 即置否），
 * 用例 ①②③⑤ 必须变红；只留 ④（supported:false）绿。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_ROOT = path.join(__dirname, '..');
const SRC_PATH = path.join(APP_ROOT, 'public/js/modules/02-visual/18-cover-wallpaper.js');
const RUNTIME_PATH = path.join(APP_ROOT, 'desktop/wallpaper-mode-runtime.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

const COLD_STATUS = Object.freeze({
  supported: true,
  enabled: false,
  active: false,
  attaching: false,
  windowId: null,
  parentClassName: '',
  hostStrategy: '',
});

function buildHarness(options) {
  const opts = options || {};
  const calls = { setMode: [], update: [], toast: [], updateFxInputs: 0 };
  const api = {
    setCoverWallpaperMode: (enabled, payload) => {
      calls.setMode.push({ enabled: !!enabled, hasPayload: !!(payload && payload.enabled) });
      return Promise.resolve(opts.ack || { ok: true, enabled: true, status: opts.status || null });
    },
    updateCoverWallpaperMode: (payload) => {
      calls.update.push(payload || {});
      return Promise.resolve({ ok: true, enabled: true, status: opts.status || null });
    },
    getCoverWallpaperModeStatus: () => Promise.resolve(
      opts.initStatus === undefined ? COLD_STATUS : opts.initStatus,
    ),
    onCoverWallpaperModeState: () => () => {},
  };
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    Promise,
    setTimeout,
    clearTimeout,
    // 捕获 260ms 节拍回调，供用例手动触发，避免真等 260ms。
    setInterval: (fn) => { sandbox.__tick = fn; return 1; },
    clearInterval: () => {},
    performance: { now: () => Number(sandbox.__now || 0) },
    requestAnimationFrame: (fn) => (fn && fn(0)) || 0,
    cancelAnimationFrame: () => {},
    document: {
      getElementById: () => null,
      querySelectorAll: () => [],
      body: { classList: { add() {}, remove() {} }, offsetWidth: 0 },
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
    showToast: (msg) => calls.toast.push(msg),
    saveLyricLayout: () => {},
    updateFxInputs: () => { calls.updateFxInputs++; },
    playing: false,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { sandbox, calls, api };
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

test('① 冷启动空回执（windowId:null / enabled:false）→ 不得把用户开关关掉', async () => {
  const { sandbox } = buildHarness({ fx: { coverWallpaper: true } });
  sandbox.applyCoverWallpaperRuntimeStatus(COLD_STATUS);
  assert.equal(sandbox.fx.coverWallpaper, true,
    '运行时还没建窗时的空回执不是「用户不要壁纸」的证据');
});

test('② 回执缺字段（空对象 / 只有 supported:true）→ 不得改动开关', async () => {
  const { sandbox } = buildHarness({ fx: { coverWallpaper: true } });
  sandbox.applyCoverWallpaperRuntimeStatus({});
  sandbox.applyCoverWallpaperRuntimeStatus({ supported: true });
  assert.equal(sandbox.fx.coverWallpaper, true, '字段缺失不得被当成否定证据');
});

test('③ stop / 重新贴合失败的回执（enabled:false 但窗口曾存在）→ 仍不得改动开关', async () => {
  const { sandbox } = buildHarness({ fx: { coverWallpaper: true } });
  sandbox.applyCoverWallpaperRuntimeStatus({
    supported: true, enabled: false, active: false, attaching: false, windowId: 9,
    lastError: 'WALLPAPER_DISPLAY_RECONCILE_FAILED', reason: 'display-reconcile-failed',
  });
  assert.equal(sandbox.fx.coverWallpaper, true,
    '参照库对壁纸层只做单向下发，重建失败不归渲染层去关用户开关');
});

test('④ 唯一合法置否：supported === false（平台确实不支持）→ 必须关掉', async () => {
  const { sandbox, calls } = buildHarness({ fx: { coverWallpaper: true } });
  sandbox.applyCoverWallpaperRuntimeStatus({ supported: false });
  assert.equal(sandbox.fx.coverWallpaper, false, '平台不支持时必须落到关闭态');
  assert.equal(calls.updateFxInputs, 1, '要同步一次 UI');
});

test('④b supported === false 但已经是关态 → 不得重复刷 UI', async () => {
  const { sandbox, calls } = buildHarness({ fx: { coverWallpaper: false } });
  sandbox.applyCoverWallpaperRuntimeStatus({ supported: false });
  assert.equal(sandbox.fx.coverWallpaper, false);
  assert.equal(calls.updateFxInputs, 0, '状态没变就不要重复 updateFxInputs');
});

test('⑤ 端到端：启动失败回执不得让 260ms 节拍停摆（壁纸才会跟着切歌更新）', async () => {
  const { sandbox, calls, api } = buildHarness({
    fx: { coverWallpaper: true, coverWallpaperSurface: 'desktop' },
    initStatus: COLD_STATUS,
    ack: {
      ok: false,
      enabled: false,
      error: 'WALLPAPER_NATIVE_ATTACH_FAILED',
      status: COLD_STATUS,
    },
  });
  sandbox.__now = 10000;
  sandbox.initCoverWallpaper(api);
  await flush();
  assert.equal(sandbox.fx.coverWallpaper, true,
    '一次 attach 失败的回执不得把用户开关擦掉');
  assert.equal(typeof sandbox.__tick, 'function', '260ms 节拍必须已注册');
  sandbox.__tick();
  assert.equal(calls.update.length, 1,
    '节拍必须继续推送状态，否则切歌后壁纸不会更新（pushCoverWallpaperDesktopState 首行会 return）');
});

test('⑥ 源码守卫：回执处理里不得出现「缺 enabled 即置否」的兜底分支', () => {
  assert.doesNotMatch(SRC, /status\.attaching === true \? !!fx\.coverWallpaper : false/,
    '缺 enabled 即置否是单向棘轮，必须移除');
  assert.match(SRC, /status\.supported === false/,
    '只保留 supported === false 这一条合法置否');
});

test('⑦ 参照库取证守卫：参照库 preload 里不得有回执订阅接口', () => {
  const refPreload = path.join(APP_ROOT, '..', 'Mineradio-2.5.1', 'desktop', 'preload.js');
  if (!fs.existsSync(refPreload)) return; // 参照库不在同层目录时跳过（换机不误红）
  const text = fs.readFileSync(refPreload, 'utf8');
  assert.doesNotMatch(text, /onWallpaperModeState|getWallpaperModeStatus/,
    '参照库没有壁纸回执通道，这是本项目的增补，必须自己兜住副作用');
  assert.match(text, /setWallpaperMode/, '参照库只做单向下发');
});

test('⑧ 运行时取证守卫：runStop 会 emitStatus 一条 enabled:false', () => {
  const text = fs.readFileSync(RUNTIME_PATH, 'utf8');
  const stopStart = text.indexOf('async runStop');
  assert.ok(stopStart > 0, 'runStop 必须存在');
  const body = text.slice(stopStart, stopStart + 2200);
  assert.match(body, /normalizeWallpaperState\(this\.state, \{\}, false\)/,
    'runStop 必须把 state.enabled 置 false');
  assert.match(body, /emitStatus\(reason\)/,
    'runStop 必须 emitStatus —— 这条回执就是渲染层的毒丸来源');
});
