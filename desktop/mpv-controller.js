'use strict';

/**
 * Stellaflare 影视态 — mpv 实例管理器 (mpv-controller.js)
 * ----------------------------------------------------------------------------
 * 主进程侧 mpv 播放器生命周期：创建 / 销毁 / 命令 / 属性 / 事件订阅。
 *
 * 架构：
 *   - 每个"播放器实例" = 一个 mpv.com 子进程 + 一个 IPC socket 连接
 *   - 句柄表 _handles 维护 id → { proc, socket, eventHandlers, meta }
 *   - 命令协议：JSON { command: [...], request_id } → { data, error }
 *   - 事件协议：{ event, ... } 异步推送到订阅者
 *
 * 边播边删（对齐 PDF 第 4.2 节滑动窗口 + 看完即删）：
 *   - demuxer-max-bytes=128MiB 控制磁盘缓存上限
 *   - demuxer-readahead-secs=20 控制预读深度
 *   - 播放结束 / 用户点"清空" → 调 stop + 主动 unlink 缓存文件
 *
 * 窗口嵌入：
 *   - 通过 --wid=<hwnd> 把 mpv 视频输出嵌入 Electron BrowserWindow
 *   - hwnd 由渲染进程通过 BrowserWindow.getNativeWindowHandle() 拿到
 *
 * 加载顺序：video-config → ffprobe → mpv-controller → download-manager
 */

const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// lazy require electron（避免顶层 require 在 electron 尚未 boot 时失败）
let _electron = null;
function getElectron() {
  if (!_electron) {
    try { _electron = require('electron'); } catch (e) { throw new Error('electron 未就绪：' + e.message); }
  }
  return _electron;
}

let _config = null;
let _mainWindow = null;
let _log = () => {};

function setConfig(cfg) {
  _config = cfg;
  if (cfg && cfg.mpv && cfg.mpv.enableLogging) {
    _log = (...a) => console.log('[mpv]', ...a);
  }
}

function setMainWindow(w) { _mainWindow = w; }

// -----------------------------------------------------------------------
//  句柄表
// -----------------------------------------------------------------------
const _handles = new Map();
let _nextId = 1;
// Optional renderer push hook assigned by ipc-video.initIpc().
let _eventBroadcast = null;

function setEventBroadcast(fn) {
  _eventBroadcast = typeof fn === 'function' ? fn : null;
}

function _killProcessTree(proc) {
  if (!proc || proc.killed || proc.exitCode !== null) return;
  const pid = proc.pid;
  try {
    if (process.platform === 'win32' && pid) {
      const { spawnSync } = require('child_process');
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 2000 });
      return;
    }
  } catch (_) {}
  try { proc.kill('SIGKILL'); } catch (_) {}
}

function _waitForExit(proc, timeoutMs) {
  if (!proc) return Promise.resolve(true);
  if (proc.exitCode !== null || proc.killed) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeoutMs);
    proc.once('exit', done);
    proc.once('error', done);
  });
}

function _genId() {
  return 'mpv-' + (_nextId++) + '-' + crypto.randomBytes(3).toString('hex');
}

// -----------------------------------------------------------------------
//  IPC socket 连接
// -----------------------------------------------------------------------
function _connectSocket(pipePath) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(pipePath, () => {
      clearTimeout(timer);
      resolve(sock);
    });
    const timer = setTimeout(() => {
      try { sock.destroy(); } catch (_) {}
      reject(new Error('socket connect timeout'));
    }, 5000);
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// -----------------------------------------------------------------------
//  公开 API
// -----------------------------------------------------------------------

/**
 * 创建 mpv 实例
 * @param {object} opts
 *   - hwnd: 目标窗口句柄（Buffer），用于 --wid 嵌入
 *   - url: 播放地址
 *   - title: 窗口标题
 *   - extraArgs: 额外 mpv 参数
 * @returns {Promise<{id:string, pid:number}>}
 */
function createPlayer(opts) {
  opts = opts || {};
  if (!_config) return Promise.reject(new Error('mpv-controller 未初始化'));
  const mpvExe = _findMpvExe();
  if (!mpvExe) return Promise.reject(new Error('mpv.exe 不存在，请检查 _up_/mpv/mpv.exe'));

  // Default exclusive: stop previous players before starting a new one so
  // track/video switches never leave two mpv processes fighting for GPU/CPU.
  const exclusive = opts.exclusive !== false;
  const prepare = exclusive ? destroyAllPlayers({ skipOverlays: false }) : Promise.resolve();

  return prepare.then(() => {
    const id = _genId();
    const pipePath = _makePipePath(id);
    const args = [
      '--no-terminal',
      '--force-window=immediate',
      '--keep-open=no',
      '--idle=yes',
      '--hr-seek-framedrop=no',
      '--input-ipc-server=' + pipePath,
    ];
    if (opts.hwnd) args.push('--wid=' + opts.hwnd.toString('hex'));
    if (opts.title) args.push('--force-media-title=' + opts.title);
    // 边播边删：缓存控制
    args.push('--demuxer-max-bytes=128MiB');
    args.push('--demuxer-readahead-secs=20');
    args.push('--cache-pause=yes');
    args.push('--cache-pause-initial=yes');
    if (Array.isArray(opts.extraArgs)) args.push(...opts.extraArgs);
    if (opts.url) args.push(opts.url);

    return new Promise((resolve, reject) => {
      let proc;
      try {
        // Ignore stdio pipes: unread stdout/stderr can block the child on Windows.
        proc = spawn(mpvExe, args, {
          windowsHide: true,
          detached: false,
          stdio: ['ignore', 'ignore', 'ignore'],
        });
      } catch (e) { reject(e); return; }
      const handle = {
        id, proc, socket: null, pipePath,
        eventHandlers: new Map(),
        meta: { url: opts.url, title: opts.title, pid: proc.pid, startedAt: Date.now() },
        _reqId: 1, _pending: new Map(),
      };
      _handles.set(id, handle);
      proc.on('exit', (code) => { _onProcessExit(id, code); });
      proc.on('error', (e) => { _log('proc error', id, e.message); });
      _connectSocket(pipePath).then(sock => {
        if (!_handles.has(id)) {
          try { sock.destroy(); } catch (_) {}
          try { _killProcessTree(proc); } catch (_) {}
          reject(new Error('player exited during socket connect'));
          return;
        }
        handle.socket = sock;
        _bindSocket(id, sock);
        _log('player created', id, 'pid=' + proc.pid);
        resolve({ id, pid: proc.pid });
      }).catch(err => {
        _killProcessTree(proc);
        _handles.delete(id);
        reject(err);
      });
    });
  });
}

/** 销毁实例：保留句柄等 exit，失败时 Windows taskkill /T 兜底 */
function destroyPlayer(id) {
  const h = _handles.get(id);
  if (!h) return Promise.resolve(false);
  return (async () => {
    const proc = h.proc;
    try { if (h.socket) h.socket.destroy(); } catch (_) {}
    h.socket = null;
    for (const p of h._pending.values()) {
      try { p.reject(new Error('player destroyed')); } catch (_) {}
    }
    h._pending.clear();
    if (!proc || proc.exitCode !== null) {
      try { fs.unlinkSync(h.pipePath); } catch (_) {}
      _handles.delete(id);
      return true;
    }
    try { proc.kill('SIGTERM'); } catch (_) {}
    const exited = await _waitForExit(proc, 400);
    if (!exited) {
      _killProcessTree(proc);
      await _waitForExit(proc, 800);
    }
    try { fs.unlinkSync(h.pipePath); } catch (_) {}
    _handles.delete(id);
    return true;
  })();
}

async function destroyAllPlayers(options) {
  const skipOverlays = !!(options && options.skipOverlays);
  const ids = Array.from(_handles.keys());
  await Promise.all(ids.map((id) => {
    const h = _handles.get(id);
    if (skipOverlays && h && h.overlayWin) return Promise.resolve(false);
    return destroyPlayer(id);
  }));
  return true;
}

/** 发送命令（对齐 mpv JSON IPC） */
function command(id, cmdArr) {
  const h = _handles.get(id);
  if (!h || !h.socket) return Promise.reject(new Error('player not found: ' + id));
  return new Promise((resolve, reject) => {
    const rid = h._reqId++;
    const payload = JSON.stringify({ command: cmdArr, request_id: rid }) + '\n';
    h._pending.set(rid, { resolve, reject });
    h.socket.write(payload);
    setTimeout(() => {
      if (h._pending.has(rid)) {
        h._pending.delete(rid);
        reject(new Error('command timeout'));
      }
    }, 10000);
  });
}

/** 获取属性 */
function getProperty(id, name) {
  return command(id, ['get_property', name]).then(r => r.data);
}

/** 设置属性 */
function setProperty(id, name, value) {
  return command(id, ['set_property', name, value]);
}

/** 订阅事件（渲染进程通过 IPC 注册回调） */
function onEvent(id, event, cb) {
  const h = _handles.get(id);
  if (!h) return;
  if (!h.eventHandlers.has(event)) h.eventHandlers.set(event, new Set());
  h.eventHandlers.get(event).add(cb);
}
function offEvent(id, event, cb) {
  const h = _handles.get(id);
  if (!h) return;
  const set = h.eventHandlers.get(event);
  if (set) set.delete(cb);
}

/** 一次性 seek（对齐 PDF 4.2 seek 处理） */
function seek(id, sec) {
  return command(id, ['seek', sec, 'absolute']);
}

/** 停止并清空缓存（对齐 PDF 看完即删） */
function stopAndClean(id) {
  return command(id, ['stop']).then(() => {
    const h = _handles.get(id);
    if (h && h.meta && h.meta.cacheFile) {
      try { fs.unlinkSync(h.meta.cacheFile); } catch (e) {}
    }
  });
}

/** 列出所有实例 */
function listPlayers() {
  return Array.from(_handles.values()).map(h => ({
    id: h.id, pid: h.meta.pid, url: h.meta.url, title: h.meta.title, startedAt: h.meta.startedAt,
  }));
}

// -----------------------------------------------------------------------
//  内部
// -----------------------------------------------------------------------
function _findMpvExe() {
  const candidates = [
    _config && _config.mpv && _config.mpv.dllPath ? path.join(path.dirname(_config.mpv.dllPath), 'mpv.exe') : '',
    path.resolve(__dirname, '..', '_up_', 'mpv', 'mpv.exe'),
  ];
  for (const c of candidates) { if (c && fs.existsSync(c)) return c; }
  return null;
}

function _makePipePath(id) {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\' + id.replace(/[^a-zA-Z0-9_-]/g, '_');
  }
  return path.join(os.tmpdir(), id + '.sock');
}

function _bindSocket(id, sock) {
  const h = _handles.get(id);
  if (!h) return;
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', chunk => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) _handleLine(id, line);
    }
  });
  sock.on('error', e => _log('socket error', id, e.message));
  sock.on('close', () => _log('socket close', id));
}

function _handleLine(id, line) {
  const h = _handles.get(id);
  if (!h) return;
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  if (msg.request_id != null) {
    const p = h._pending.get(msg.request_id);
    if (p) {
      h._pending.delete(msg.request_id);
      if (msg.error && msg.error !== 'success') p.reject(new Error(msg.error));
      else p.resolve(msg);
    }
    return;
  }
  if (msg.event) {
    const set = h.eventHandlers.get(msg.event);
    if (set) set.forEach(cb => { try { cb(msg); } catch (e) {} });
    const all = h.eventHandlers.get('*');
    if (all) all.forEach(cb => { try { cb(msg); } catch (e) {} });
    if (_eventBroadcast) {
      try { _eventBroadcast(id, msg.event, msg); } catch (e) {}
    }
  }
}

function _onProcessExit(id, code) {
  const h = _handles.get(id);
  if (!h) return;
  const payload = { event: 'shutdown', id, code };
  const all = h.eventHandlers.get('*');
  if (all) all.forEach(cb => { try { cb(payload); } catch (e) {} });
  if (_eventBroadcast) {
    try { _eventBroadcast(id, 'shutdown', payload); } catch (e) {}
  }
  _cleanupHandle(id);
}

function _cleanupHandle(id) {
  const h = _handles.get(id);
  if (!h) return;
  if (h.socket) { try { h.socket.destroy(); } catch (e) {} }
  try { fs.unlinkSync(h.pipePath); } catch (e) {}
  _handles.delete(id);
}

/**
 * 创建播放器叠加窗口（无边框、透明背景、置顶），把 mpv 视频输出嵌入其中。
 * 返回 { overlayId, playerId, hwnd }。
 */
function createOverlay(opts) {
  opts = opts || {};
  const { BrowserWindow } = getElectron();
  const overlayId = 'ovl-' + crypto.randomBytes(4).toString('hex');
  const win = new BrowserWindow({
    width: opts.width || 800,
    height: opts.height || 450,
    x: opts.x || 0,
    y: opts.y || 0,
    frame: false,
    transparent: true,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    resizable: false,
    focusable: false,
    parent: opts.parentHwnd ? undefined : undefined,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.setIgnoreMouseEvents(true);
  win.loadURL('data:text/html,<html><body style="margin:0;background:transparent"></body></html>');
  const hwnd = win.getNativeWindowHandle();
  return createPlayer(Object.assign({}, opts, { hwnd })).then(r => {
    const handle = _handles.get(r.id);
    if (!handle) {
      try { win.destroy(); } catch (_) {}
      return { ok: false, error: 'player exited immediately after create' };
    }
    handle.overlayId = overlayId;
    handle.overlayWin = win;
    win.show();
    return { ok: true, data: { overlayId, playerId: r.id, pid: r.pid, hwnd: hwnd.toString('hex') } };
  }).catch(err => {
    try { win.destroy(); } catch (e) {}
    return { ok: false, error: err.message };
  });
}

function destroyOverlay(playerId) {
  const h = _handles.get(playerId);
  if (!h) return Promise.resolve(false);
  if (h.overlayWin) { try { h.overlayWin.destroy(); } catch (e) {} }
  return destroyPlayer(playerId);
}

async function shutdown() {
  const ids = Array.from(_handles.keys());
  await Promise.all(ids.map(async (id) => {
    const h = _handles.get(id);
    if (!h) return;
    try { if (h.socket) h.socket.destroy(); } catch (_) {}
    for (const p of h._pending.values()) {
      try { p.reject(new Error('app shutting down')); } catch (_) {}
    }
    h._pending.clear();
    if (h.proc && h.proc.exitCode === null) {
      _killProcessTree(h.proc);
      await _waitForExit(h.proc, 400);
    }
    try { fs.unlinkSync(h.pipePath); } catch (_) {}
    _handles.delete(id);
  }));
  _handles.clear();
}

module.exports = {
  setConfig, setMainWindow, setEventBroadcast,
  createPlayer, destroyPlayer, destroyAllPlayers, createOverlay, destroyOverlay,
  command, getProperty, setProperty,
  onEvent, offEvent, seek, stopAndClean, listPlayers, shutdown,
};
