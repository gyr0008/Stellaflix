'use strict';

/**
 * Stellaflare 影视态 — qBittorrent 便携版下载管理器 (download-manager.js)
 * ----------------------------------------------------------------------------
 * 启动 / 停止 / 管理内嵌的 qBittorrent 便携版.exe，通过 Web API 添加任务、
 * 查询进度、删除任务（含本地文件）。
 *
 * 对齐 PDF 第 4.2 节滑动窗口顺序下载：
 *   - qBittorrent 原生支持"顺序下载"（Sequential download）模式
 *   - 通过 Web API 的 /api/v2/torrents/toggleSequentialDownload 开启
 *   - 配合 mpv 的 demuxer-readahead-secs 实现"边下边播"
 *
 * 边播边删（对齐 PDF 看完即删）：
 *   - 播放结束 → stopAndClean → 调 /api/v2/torrents/delete?hashes=xx&deleteFiles=true
 *   - 临时目录：app.getPath('temp')/StellaMedia/cache/，启动时 cleanOrphans()
 *
 * 合规：默认关闭做种（autoTMM=false, paused=false, seedingTimeLimit=0）
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

let _config = null;
let _proc = null;
let _cookie = null;
let _log = () => {};

function setConfig(cfg) {
  _config = cfg;
  if (cfg && cfg.mpv && cfg.mpv.enableLogging) _log = (...a) => console.log('[qbt]', ...a);
}

// -----------------------------------------------------------------------
//  HTTP 封装
// -----------------------------------------------------------------------
function _http(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const port = _config?.qbt?.port || 8080;
    const auth = Buffer.from((_config?.qbt?.username || 'admin') + ':' + (_config?.qbt?.password || 'adminadmin')).toString('base64');
    const opts = { hostname: '127.0.0.1', port, path: pathname, method, headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' } };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(_config?.network?.timeout || 15000, () => req.destroy(new Error('http timeout')));
    if (body) req.write(body);
    req.end();
  });
}

async function _login() {
  const res = await _http('POST', '/api/v2/auth/login', 'username=' + encodeURIComponent(_config.qbt.username) + '&password=' + encodeURIComponent(_config.qbt.password));
  if (res.status === 200) _cookie = res.body;
  return res;
}

// -----------------------------------------------------------------------
//  生命周期
// -----------------------------------------------------------------------
function isRunning() { return !!_proc && !_proc.killed; }

function start() {
  if (isRunning()) return Promise.resolve(true);
  if (!_config?.qbt?.enabled) return Promise.reject(new Error('qbt disabled'));
  const exe = _config.qbt.exePath;
  if (!fs.existsSync(exe)) return Promise.reject(new Error('qBittorrent 不存在: ' + exe));
  return new Promise((resolve, reject) => {
    const args = ['--configuration=qbt-portable', '--relative-fastresume'];
    _proc = spawn(exe, args, {
      windowsHide: true,
      cwd: path.dirname(exe),
      detached: false,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    _proc.on('error', reject);
    _proc.on('exit', code => { _log('qbt exit', code); _proc = null; });
    // 等 Web API 就绪
    const deadline = Date.now() + 30000;
    const poll = async () => {
      try { const r = await _http('GET', '/api/v2/app/version'); if (r.status === 200) { _log('qbt ready'); resolve(true); return; } } catch (e) {}
      if (Date.now() > deadline) { reject(new Error('qbt start timeout')); return; }
      setTimeout(poll, 500);
    };
    setTimeout(poll, 1000);
  });
}

function killProcessTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  try {
    if (process.platform === 'win32' && proc.pid) {
      const { spawnSync } = require('child_process');
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, timeout: 2000 });
      return;
    }
  } catch (_) {}
  try { proc.kill('SIGKILL'); } catch (_) {}
}

function stop() {
  return new Promise(resolve => {
    if (!_proc || _proc.exitCode !== null) { _proc = null; resolve(true); return; }
    const proc = _proc;
    const finish = () => { if (_proc === proc) _proc = null; resolve(true); };
    proc.once('exit', finish);
    try { proc.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => {
      if (proc.exitCode === null) {
        killProcessTree(proc);
        setTimeout(finish, 400);
      } else {
        finish();
      }
    }, 1000);
  });
}

// -----------------------------------------------------------------------
//  任务管理
// -----------------------------------------------------------------------

/**
 * 添加磁力/URL 任务
 * @param {object} opts
 *   - url: 磁力或种了 URL
 *   - savePath: 保存目录（可选，默认用配置）
 *   - sequential: 是否顺序下载（默认 true，对齐 PDF 4.2）
 *   - firstLastPiecePrio: 是否优先首尾 piece（默认 true）
 *   - autoStart: 是否自动开始（默认 true）
 */
async function addTorrent(opts) {
  opts = opts || {};
  await start();
  await _login();
  const form = new URLSearchParams();
  form.append('urls', opts.url);
  if (opts.savePath) form.append('savepath', opts.savePath);
  else if (_config.qbt.defaultSavePath) form.append('savepath', _config.qbt.defaultSavePath);
  form.append('autoTMM', 'false');
  form.append('paused', opts.autoStart === false ? 'true' : 'false');
  form.append('seedingTimeLimit', '0');     // 默认不做种
  form.append('sequentialDownload', opts.sequential !== false ? 'true' : 'false');
  form.append('firstLastPiecePrio', opts.firstLastPiecePrio !== false ? 'true' : 'false');
  const res = await _http('POST', '/api/v2/torrents/add', form.toString());
  if (res.status !== 200) throw new Error('add torrent failed: ' + res.body);
  return res.body;
}

/** 列出任务 */
async function listTorrents(filter) {
  await _login();
  const q = filter ? '?filter=' + filter : '';
  const res = await _http('GET', '/api/v2/torrents/info' + q);
  try { return JSON.parse(res.body); } catch (e) { return []; }
}

/** 取任务文件列表 */
async function getTorrentFiles(hash) {
  await _login();
  const res = await _http('GET', '/api/v2/torrents/files?hash=' + encodeURIComponent(hash));
  try { return JSON.parse(res.body); } catch (e) { return []; }
}

/** 删除任务 + 本地文件（对齐 PDF 看完即删） */
async function deleteTorrent(hash, deleteFiles) {
  await _login();
  const qs = 'hashes=' + encodeURIComponent(hash) + '&deleteFiles=' + (deleteFiles === false ? 'false' : 'true');
  const res = await _http('POST', '/api/v2/torrents/delete', qs);
  return res.status === 200;
}

/** 暂停/恢复 */
async function pauseResume(hash, pause) {
  await _login();
  const qs = 'hashes=' + encodeURIComponent(hash);
  const res = await _http('POST', pause ? '/api/v2/torrents/pause' : '/api/v2/torrents/resume', qs);
  return res.status === 200;
}

/** 取任务进度（0-100） */
async function getProgress(hash) {
  const files = await getTorrentFiles(hash);
  if (!files.length) return 0;
  const total = files.reduce((a, f) => a + (f.size || 0), 0);
  const progress = files.reduce((a, f) => a + (f.size || 0) * (f.progress || 0), 0);
  return total > 0 ? progress / total : 0;
}

/** 启动时清理孤儿缓存（对齐 PDF cleanOrphans） */
function cleanOrphans() {
  const cacheDir = _config?.mediaLibrary?.cacheDir;
  if (!cacheDir || !fs.existsSync(cacheDir)) return;
  try {
    const entries = fs.readdirSync(cacheDir);
    for (const e of entries) {
      try { fs.unlinkSync(path.join(cacheDir, e)); } catch (err) {}
    }
    _log('cleanOrphans done, removed', entries.length, 'files');
  } catch (e) {
    _log('cleanOrphans error', e.message);
  }
}

function shutdown() { return stop(); }

module.exports = {
  setConfig, start, stop, isRunning,
  addTorrent, listTorrents, getTorrentFiles, deleteTorrent, pauseResume, getProgress,
  cleanOrphans, shutdown,
};
