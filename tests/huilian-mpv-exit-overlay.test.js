'use strict';
/**
 * 汇联 I2（desktop 侧）：mpv 进程退出（_onProcessExit → _cleanupHandle）必须销毁 overlay 窗口。
 * overlay 为 alwaysOnTop 未 parent 子窗（mpv-controller:416），若句柄被丢弃却不销毁窗口，
 * 则路由离开/关窗后画面残留；且渲染层 destroyOverlay 因句柄缺失返回 false、command 抛
 * 'player not found'，用户再也无法经停播清理 → 破坏「播完删任务」红线。
 * 手法：vm 载入 mpv-controller 源码 + stub require（child_process/net/fs/electron），
 * 真跑 createOverlay 拿到 overlay 句柄，再触发子进程 exit 断言 overlay 窗被销毁。
 * 不新增 desktop 公开面（不导出 _cleanupHandle/_onProcessExit，仅用既有 _getHandlesForTest 观测句柄表）。
 * 运行：node --test tests/huilian-mpv-exit-overlay.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const realCrypto = require('node:crypto');
const realOs = require('node:os');
const realPath = require('node:path');
const EventEmitter = require('node:events').EventEmitter;

function loadMpv() {
  const createdWins = [];
  const procs = [];

  class FakeOverlayWin extends EventEmitter {
    constructor(config) {
      super();
      this._config = config;
      this.destroyed = false;
      createdWins.push(this);
    }
    setIgnoreMouseEvents() {}
    loadURL() { return Promise.resolve(); }
    show() { this.shown = true; }
    // 64 位 HWND 句柄（小端字节序 Buffer），供 --wid 与 hwnd.toString('hex') 使用
    getNativeWindowHandle() { return Buffer.from([0x2a, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]); }
    setBounds() {}
    destroy() { this.destroyed = true; this.emit('closed'); }
  }

  class FakeProc extends EventEmitter {
    constructor() {
      super();
      this.pid = 4321;
      this.exitCode = null;
      this.killed = false;
    }
    kill() { this.killed = true; }
  }

  function makeSock() {
    const s = new EventEmitter();
    s.setEncoding = () => {};
    s.destroy = () => {};
    s.write = () => {};
    return s;
  }

  const fakeFs = {
    existsSync: () => true,           // 令 _findMpvExe 命中 mpv.exe（不读真实磁盘）
    unlinkSync: () => {},
  };
  const fakeNet = {
    connect: (pipePath, cb) => {
      const sock = makeSock();
      if (typeof cb === 'function') setImmediate(cb); // 让 createPlayer 走 socket 连接成功分支
      return sock;
    },
  };
  const fakeCp = {
    spawn: () => { const p = new FakeProc(); procs.push(p); return p; },
    spawnSync: () => ({ status: 0 }),
  };
  const fakeElectron = { BrowserWindow: FakeOverlayWin };

  const src = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'mpv-controller.js'), 'utf8');
  const stubs = {
    child_process: fakeCp, net: fakeNet, fs: fakeFs,
    path: realPath, os: realOs, crypto: realCrypto, electron: fakeElectron,
  };
  const sandbox = {
    require: (id) => stubs[id] || {},
    module: { exports: {} }, exports: {},
    __dirname: path.join(__dirname, '..', 'desktop'),
    console, Buffer, process, setImmediate, setTimeout, clearTimeout,
    Math, Number, String, Object, Array, JSON, Promise, Error, Date, Map, Set, RegExp,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'mpv-controller.js' });
  const mpv = sandbox.module.exports;
  mpv.setConfig({ mpv: { enableLogging: false } });
  return { mpv, procs, createdWins };
}

test('I2 desktop：mpv 进程退出 → _cleanupHandle 销毁 overlay 窗口并移除句柄', async () => {
  const { mpv, procs, createdWins } = loadMpv();
  const result = await mpv.createOverlay({ url: 'D:/dl/a.mkv', title: 'a.mkv', x: 0, y: 0, width: 640, height: 360 });
  assert.strictEqual(result.ok, true, '前置：overlay 应创建成功');
  const playerId = result.data.playerId;
  assert.ok(mpv._getHandlesForTest().has(playerId), '前置：句柄应存在于 _handles');
  assert.strictEqual(createdWins.length, 1, '前置：应创建一个 overlay 子窗');
  const win = createdWins[0];
  assert.strictEqual(win.destroyed, false, '前置：overlay 窗尚未销毁');

  // 触发 mpv 子进程意外退出（proc 'exit' → _onProcessExit → _cleanupHandle）
  const proc = procs[procs.length - 1];
  proc.exitCode = 1;
  proc.emit('exit', 1);

  assert.strictEqual(win.destroyed, true,
    '修复后：进程退出必须销毁 overlay 窗（否则 alwaysOnTop 未 parent 子窗在离开路由/关窗后残留）');
  assert.strictEqual(mpv._getHandlesForTest().has(playerId), false, '修复后：句柄应从 _handles 移除');
});

test('I2 desktop：进程退出后渲染层 destroyOverlay 走安全 no-op（句柄已回收不抛）', async () => {
  const { mpv, procs, createdWins } = loadMpv();
  const result = await mpv.createOverlay({ url: 'D:/dl/b.mkv', title: 'b.mkv', x: 0, y: 0, width: 640, height: 360 });
  const playerId = result.data.playerId;
  procs[procs.length - 1].exitCode = 1;
  procs[procs.length - 1].emit('exit', 1);
  assert.strictEqual(createdWins[0].destroyed, true, '前置：退出已销毁 overlay');
  // 句柄消失后 destroyOverlay 应返回 false（不抛），供渲染层停播安全收尾
  const ok = await mpv.destroyOverlay(playerId);
  assert.strictEqual(ok, false, '句柄缺失时 destroyOverlay 返回 false（player not found 语义来源）');
});
