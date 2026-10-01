'use strict';
/**
 * 汇联 Task5/D1：mpv overlay bounds 同步契约测（zoom 换算纯函数 + IPC + preload）。
 * 运行：node --test tests/huilian-overlay-bounds.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// mpv-controller 顶层不 require electron（:33 起惰性 getElectron），node --test 直接 require 已核实可行
const mpv = require('../desktop/mpv-controller');

// ---------------------------------------------------------------------------
// Brief Step1 逐字测试
// ---------------------------------------------------------------------------

test('zoom=1：内容偏移 + rect', () => {
  assert.deepStrictEqual(
    mpv.computeOverlayScreenBounds({ x: 100, y: 50, width: 1200, height: 800 }, 1, { x: 20, y: 240, width: 640, height: 360 }),
    { x: 120, y: 290, width: 640, height: 360 });
});
test('zoom=1.25：CSS px 除回逻辑 px', () => {
  const r = mpv.computeOverlayScreenBounds({ x: 0, y: 0, width: 1000, height: 600 }, 1.25, { x: 100, y: 100, width: 500, height: 280 });
  assert.deepStrictEqual(r, { x: 80, y: 80, width: 400, height: 224 });
});
test('内容区顶部偏移不含标题栏（用 getContentBounds 语义：x,y 即客户区）', () => {
  const r = mpv.computeOverlayScreenBounds({ x: 10, y: 10, width: 800, height: 600 }, 1, { x: 0, y: 0, width: 100, height: 60 });
  assert.deepStrictEqual(r, { x: 10, y: 10, width: 100, height: 60 });
});
test('rect 缺字段/负宽高 → throw', () => {
  assert.throws(() => mpv.computeOverlayScreenBounds({ x: 0, y: 0 }, 1, null));
  assert.throws(() => mpv.computeOverlayScreenBounds({ x: 0, y: 0, width: 1, height: 1 }, 1, { x: 0, y: 0, width: -5, height: 10 }));
});

// ---------------------------------------------------------------------------
// 取整 / 最小尺寸 / zoom 兜底 / 非法输入补充
// ---------------------------------------------------------------------------

test('四舍五入取整：0.667→1，3.333→3', () => {
  const r = mpv.computeOverlayScreenBounds({ x: 0, y: 0, width: 800, height: 600 }, 1.5, { x: 10, y: 5, width: 100, height: 50 });
  assert.deepStrictEqual(r, { x: 7, y: 3, width: 67, height: 33 });
});
test('宽高换算后不足 1px → 最小钳到 1', () => {
  const r = mpv.computeOverlayScreenBounds({ x: 0, y: 0, width: 800, height: 600 }, 10, { x: 0, y: 0, width: 2, height: 0.5 });
  assert.deepStrictEqual(r, { x: 0, y: 0, width: 1, height: 1 });
});
test('zoomFactor ≤0 或非有限 → 按 1 处理', () => {
  const cb = { x: 5, y: 5, width: 800, height: 600 };
  const rect = { x: 20, y: 30, width: 300, height: 200 };
  const base = mpv.computeOverlayScreenBounds(cb, 1, rect);
  assert.deepStrictEqual(mpv.computeOverlayScreenBounds(cb, 0, rect), base);
  assert.deepStrictEqual(mpv.computeOverlayScreenBounds(cb, -2, rect), base);
  assert.deepStrictEqual(mpv.computeOverlayScreenBounds(cb, NaN, rect), base);
});
test('rect 字段缺失/非数字/Infinity → throw', () => {
  const cb = { x: 0, y: 0, width: 800, height: 600 };
  assert.throws(() => mpv.computeOverlayScreenBounds(cb, 1, { x: 0, y: 0, width: 10 }));
  assert.throws(() => mpv.computeOverlayScreenBounds(cb, 1, { x: 0, y: 0, width: 'a', height: 10 }));
  assert.throws(() => mpv.computeOverlayScreenBounds(cb, 1, { x: Infinity, y: 0, width: 10, height: 10 }));
  assert.throws(() => mpv.computeOverlayScreenBounds(cb, 1, { x: 0, y: 0, width: 0, height: 10 }));
});

// ---------------------------------------------------------------------------
// setOverlayRect：无 electron 环境，用测试缝注入假句柄 + 假主窗口
// ---------------------------------------------------------------------------

function fakeMainWindow(cb, zoom) {
  return { getContentBounds: () => Object.assign({}, cb), webContents: { getZoomFactor: () => zoom } };
}
function recordingOverlayWin() {
  const calls = [];
  return { setBounds: (b) => { calls.push(b); }, calls };
}

test('setOverlayRect：未知 playerId（含已销毁 overlay）→ false，不抛', () => {
  assert.strictEqual(mpv.setOverlayRect('mpv-不存在的id', { x: 0, y: 0, width: 10, height: 10 }, fakeMainWindow({ x: 0, y: 0, width: 800, height: 600 }, 1)), false);
});

test('setOverlayRect：句柄存在但无 overlayWin → false', () => {
  mpv._getHandlesForTest().set('mpv-t5-noovl', { id: 'mpv-t5-noovl', meta: {} });
  try {
    assert.strictEqual(mpv.setOverlayRect('mpv-t5-noovl', { x: 0, y: 0, width: 10, height: 10 }, fakeMainWindow({ x: 0, y: 0, width: 800, height: 600 }, 1)), false);
  } finally {
    mpv._getHandlesForTest().delete('mpv-t5-noovl');
  }
});

test('setOverlayRect：有 overlayWin → 客户区偏移+zoom 换算后 setBounds，返回 true', () => {
  const win = recordingOverlayWin();
  mpv._getHandlesForTest().set('mpv-t5-ok', { id: 'mpv-t5-ok', meta: {}, overlayWin: win });
  try {
    const ok = mpv.setOverlayRect('mpv-t5-ok', { x: 100, y: 100, width: 500, height: 280 },
      fakeMainWindow({ x: 0, y: 0, width: 1000, height: 600 }, 1.25));
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(win.calls, [{ x: 80, y: 80, width: 400, height: 224 }]);
  } finally {
    mpv._getHandlesForTest().delete('mpv-t5-ok');
  }
});

test('setOverlayRect：overlay 窗口半途被销毁（setBounds/getContentBounds 抛错）→ 安全 no-op 返 false', () => {
  const win = { setBounds: () => { throw new Error('Object has been destroyed'); } };
  mpv._getHandlesForTest().set('mpv-t5-dead', { id: 'mpv-t5-dead', meta: {}, overlayWin: win });
  const destroyedMain = {
    getContentBounds: () => { throw new Error('Object has been destroyed'); },
    webContents: { getZoomFactor: () => 1 },
  };
  try {
    assert.strictEqual(mpv.setOverlayRect('mpv-t5-dead', { x: 0, y: 0, width: 100, height: 50 }, destroyedMain), false);
    const aliveMain = fakeMainWindow({ x: 0, y: 0, width: 800, height: 600 }, 1);
    assert.strictEqual(mpv.setOverlayRect('mpv-t5-dead', { x: 0, y: 0, width: 100, height: 50 }, aliveMain), false);
  } finally {
    mpv._getHandlesForTest().delete('mpv-t5-dead');
  }
});

test('setOverlayRect：rect 非法 → throw（IPC 层统一转 ok:false）', () => {
  const win = recordingOverlayWin();
  mpv._getHandlesForTest().set('mpv-t5-badrect', { id: 'mpv-t5-badrect', meta: {}, overlayWin: win });
  try {
    assert.throws(() => mpv.setOverlayRect('mpv-t5-badrect', { x: 0, y: 0, width: -1, height: 50 }, fakeMainWindow({ x: 0, y: 0, width: 800, height: 600 }, 1)));
    assert.strictEqual(win.calls.length, 0);
  } finally {
    mpv._getHandlesForTest().delete('mpv-t5-badrect');
  }
});

// ---------------------------------------------------------------------------
// IPC 通道契约：ipc-video.js 顶层 require electron → 用 vm 加载源码 + stub 依赖
// ---------------------------------------------------------------------------

function loadIpcVideoWithStubs(mpvCtrlStub) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'ipc-video.js'), 'utf8');
  const handlers = {};
  const stubs = {
    electron: { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } } },
    './mpv-controller': mpvCtrlStub,
    './download-manager': { setConfig: () => {} },
    './ffprobe': { setConfig: () => {} },
    './video-config': { get: () => ({}) },
    './protocol-adapters': { emby: {}, alist: {}, aliyun: {}, webdav: {} },
  };
  const sandbox = { require: (id) => stubs[id] || {}, console, module: { exports: {} }, __dirname: path.join(__dirname, '..', 'desktop') };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'ipc-video.js' });
  sandbox.module.exports.initIpc();
  return { handlers, sandbox };
}

test('ipc-video 注册 mpv-overlay-set-bounds 通道，返回 {ok:true,data}', () => {
  const calls = [];
  const { handlers } = loadIpcVideoWithStubs({
    setConfig: () => {}, setEventBroadcast: () => {},
    setOverlayRect: (id, rect) => { calls.push([id, rect]); return true; },
  });
  const fn = handlers['stellaflix-video:mpv-overlay-set-bounds'];
  assert.strictEqual(typeof fn, 'function', '通道未注册');
  const rect = { x: 1, y: 2, width: 30, height: 40 };
  return Promise.resolve(fn({}, { id: 'mpv-1', rect })).then((r) => {
    // vm 跨 realm 对象原型不同 → JSON 归一后比较
    assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { ok: true, data: true });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][0], 'mpv-1');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(calls[0][1])), rect);
  });
});

test('ipc-video：setOverlayRect 抛错 → {ok:false,error}', () => {
  const { handlers } = loadIpcVideoWithStubs({
    setConfig: () => {}, setEventBroadcast: () => {},
    setOverlayRect: () => { throw new Error('rect 必须为有限数'); },
  });
  return handlers['stellaflix-video:mpv-overlay-set-bounds']({}, { id: 'x', rect: null }).then((r) => {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'rect 必须为有限数');
  });
});

// ---------------------------------------------------------------------------
// preload：player.setBounds(playerId, rect) 桥接契约
// ---------------------------------------------------------------------------

function loadPreload() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'preload-video.js'), 'utf8');
  const exposed = {};
  const invokes = [];
  const sandbox = {
    require: (id) => id === 'electron' ? {
      contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } },
      ipcRenderer: { invoke: (ch, arg) => { invokes.push([ch, arg]); return Promise.resolve({ ok: true, data: true }); }, on: () => {}, removeListener: () => {} },
    } : {},
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'preload-video.js' });
  return { exposed, invokes };
}

test('preload player.setBounds → invoke 正确通道与 {id,rect} 载荷', () => {
  const { exposed, invokes } = loadPreload();
  const player = exposed.stellaflixVideo.player;
  assert.strictEqual(typeof player.setBounds, 'function');
  const rect = { x: 10, y: 20, width: 640, height: 360 };
  return Promise.resolve(player.setBounds('mpv-9', rect)).then(() => {
    // vm 跨 realm 对象原型不同 → JSON 归一后比较
    assert.deepStrictEqual(JSON.parse(JSON.stringify(invokes)), [['stellaflix-video:mpv-overlay-set-bounds', { id: 'mpv-9', rect }]]);
  });
});
