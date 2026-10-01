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
const qbtCred = require('./qbt-credential'); // D3 适配层：凭据落盘 + WebUI 会话（纯编排留在本文件）

let _config = null;
let _proc = null;
let _log = () => {};

function setConfig(cfg) {
  _config = cfg;
  if (cfg && cfg.mpv && cfg.mpv.enableLogging) _log = (...a) => console.log('[qbt]', ...a);
}

// -----------------------------------------------------------------------
//  HTTP 封装
// -----------------------------------------------------------------------
/**
 * @param {string} method
 * @param {string} pathname
 * @param {Buffer|string} [body]
 * @param {string} [contentType] 缺省 application/x-www-form-urlencoded（向后兼容旧调用点）
 */
function _http(method, pathname, body, contentType) {
  return new Promise((resolve, reject) => {
    const port = _config?.qbt?.port || 8080;
    const auth = Buffer.from((_config?.qbt?.username || 'admin') + ':' + (_config?.qbt?.password || 'adminadmin')).toString('base64');
    // 会话回放：auth/login 拿到的 SID 随 Cookie 头带上；非 GET 再带 X-CSRF-Token（qbt 4.6.1+ 默认 CSRF 防护）
    const headers = Object.assign({ Authorization: 'Basic ' + auth, 'Content-Type': contentType || 'application/x-www-form-urlencoded' }, qbtCred.sessionHeaders(method));
    const opts = { hostname: '127.0.0.1', port, path: pathname, method, headers };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { qbtCred.takeSession(res.headers['set-cookie']); resolve({ status: res.statusCode, body: data }); });
    });
    req.on('error', reject);
    req.setTimeout(_config?.network?.timeout || 15000, () => req.destroy(new Error('http timeout')));
    if (body) req.write(body);
    req.end();
  });
}

async function _login() {
  const res = await _http('POST', '/api/v2/auth/login', 'username=' + encodeURIComponent(_config.qbt.username) + '&password=' + encodeURIComponent(_config.qbt.password));
  // 存量缺陷修正：原 `_cookie = res.body` 存的是登录响应体（"Ok."）而非会话且从不回放，现由 _http 经 qbtCred.takeSession 捕获并回放 SID/CSRF
  return res;
}

/**
 * D3 凭据编排（Task6；纯函数，无 fs/网络，依赖注入供单测；真实适配层见 qbt-credential.js）：
 *   - stored 已有 → 原样返回，零调用
 *   - 无 stored   → login(默认口令) → setPassword(genPw()) → saveCred → 返回新凭据
 *   - login 或 setPassword reject → 整体 reject，且绝不 saveCred
 * @param {{stored:?{username:string,password:string}, login:Function, setPassword:Function, saveCred:Function, genPw:Function, defaults:?{username:string,password:string}}} deps
 */
async function ensureCredential(deps) {
  const d = deps || {};
  if (d.stored) return { username: d.stored.username, password: d.stored.password };
  const def = d.defaults || {};
  await d.login(def.username, def.password);
  const cred = { username: def.username, password: d.genPw() };
  await d.setPassword(cred.password);
  await d.saveCred(cred);
  return cred;
}

/** 真实入口薄封装：就绪后确保 WebUI 口令；失败仅记 message（口令不落日志） */
async function _ensureCredentialReal() {
  try { await qbtCred.ensureReal({ config: _config, http: _http, ensureCredential }); }
  catch (e) { _log('qbt credential error:', e.message); }
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
  // D3：先把落盘口令灌进 _config.qbt（重启后就绪轮询的 Basic 认证要用最新凭据），并复位会话
  qbtCred.applyStored(_config);
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
      try {
        const r = await _http('GET', '/api/v2/app/version');
        // D3：就绪后确保 WebUI 凭据（首启生成随机口令并落盘），再放行启动
        if (r.status === 200) { _log('qbt ready'); await _ensureCredentialReal(); resolve(true); return; }
      } catch (e) {}
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

// -----------------------------------------------------------------------
//  任务表单构造（纯函数，不发请求，便于单测）
// -----------------------------------------------------------------------

const CRLF = '\r\n';
const BOUNDARY_BASE = '----SFV.qbtAdd.bnd';

/**
 * 净化用户上传文件名：去掉双引号与 CR/LF（防 multipart header 注入伪头部），
 * 并去掉其它控制字符；空值兜底为固定名。
 * @param {string} name
 * @returns {string}
 */
function sanitizeFileName(name) {
  const cleaned = String(name == null ? '' : name)
    .replace(/["\r\n]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim();
  return cleaned || 'upload.torrent';
}

/** 表单文本字段值同样去 CR/LF，避免越界到 header 行 */
function sanitizeFieldValue(value) {
  return String(value == null ? '' : value).replace(/[\r\n]/g, '');
}

/**
 * 收集与既有 url 分支一致的公共字段集（对齐 spec §3：顺序下载 + 首尾 piece + 不做种）
 * @returns {Array<[string,string]>}
 */
function collectAddFields(opts, qbt) {
  const fields = [];
  const savePath = opts.savePath || qbt.defaultSavePath;
  if (savePath) fields.push(['savepath', sanitizeFieldValue(savePath)]);
  fields.push(['autoTMM', 'false']);
  fields.push(['paused', opts.autoStart === false ? 'true' : 'false']);
  fields.push(['seedingTimeLimit', '0']);     // 默认不做种
  fields.push(['sequentialDownload', opts.sequential !== false ? 'true' : 'false']);
  fields.push(['firstLastPiecePrio', opts.firstLastPiecePrio !== false ? 'true' : 'false']);
  return fields;
}

/**
 * 选一个不与任何分段内容冲突的 boundary（拼接安全）
 * @param {Array<Buffer|string>} payloads
 * @returns {string}
 */
function pickBoundary(payloads) {
  for (let i = 0; i < 64; i++) {
    const candidate = BOUNDARY_BASE + i;
    if (!payloads.some(p => p.indexOf(candidate) !== -1)) return candidate;
  }
  throw new Error('无法为 multipart 表单选出安全分隔符');
}

/**
 * 构造 qBittorrent /api/v2/torrents/add 的请求体（纯函数，不发请求）
 *   - opts.url 非空            → application/x-www-form-urlencoded
 *   - opts.torrentBase64 非空  → multipart/form-data（文件段字段名 torrents）
 *   - 两者皆空                 → throw
 * @param {object} opts  { url } | { torrentBase64, fileName } + savePath/sequential/firstLastPiecePrio/autoStart
 * @param {object} cfg   全局配置（读 cfg.qbt.defaultSavePath）
 * @returns {{ body: Buffer|string, headers: { 'Content-Type': string } }}
 */
function buildAddFormBody(opts, cfg) {
  opts = opts || {};
  const qbt = (cfg && cfg.qbt) || {};
  const fields = collectAddFields(opts, qbt);

  if (opts.url) {
    const form = new URLSearchParams();
    form.append('urls', String(opts.url));
    for (const field of fields) form.append(field[0], field[1]);
    return { body: form.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } };
  }

  if (opts.torrentBase64) {
    const torrent = Buffer.from(String(opts.torrentBase64), 'base64');
    if (!torrent.length) throw new Error('torrent 文件内容为空或 base64 非法');
    const fileName = sanitizeFileName(opts.fileName);
    const boundary = pickBoundary([torrent, fileName].concat(fields.map(f => f[0]).concat(fields.map(f => f[1]))));
    const chunks = [];
    const push = text => chunks.push(Buffer.from(text, 'utf8'));
    // 文件段（字段名 torrents 为 qbt Web API 约定）
    push('--' + boundary + CRLF);
    push('Content-Disposition: form-data; name="torrents"; filename="' + fileName + '"' + CRLF);
    push('Content-Type: application/x-bittorrent' + CRLF + CRLF);
    chunks.push(torrent);
    push(CRLF);
    // 其余文本字段
    for (const field of fields) {
      push('--' + boundary + CRLF);
      push('Content-Disposition: form-data; name="' + field[0] + '"' + CRLF + CRLF);
      push(field[1]);
      push(CRLF);
    }
    push('--' + boundary + '--' + CRLF);
    return { body: Buffer.concat(chunks), headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary } };
  }

  throw new Error('addTorrent 需要 url 或 torrentBase64');
}

/**
 * 添加磁力/URL 任务，或上传 .torrent 文件任务（D2）
 * @param {object} opts
 *   - url: 磁力或种了 URL
 *   - torrentBase64: .torrent 文件的 base64（与 url 二选一，url 优先）
 *   - fileName: 上传文件名（multipart 中会净化）
 *   - savePath: 保存目录（可选，默认用配置）
 *   - sequential: 是否顺序下载（默认 true，对齐 PDF 4.2）
 *   - firstLastPiecePrio: 是否优先首尾 piece（默认 true）
 *   - autoStart: 是否自动开始（默认 true）
 */
async function addTorrent(opts) {
  opts = opts || {};
  await start();
  await _login();
  const built = buildAddFormBody(opts, _config || {});
  const res = await _http('POST', '/api/v2/torrents/add', built.body, built.headers['Content-Type']);
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
  addTorrent, buildAddFormBody, listTorrents, getTorrentFiles, deleteTorrent, pauseResume, getProgress,
  cleanOrphans, shutdown, ensureCredential, _ensureCredentialReal,
};
