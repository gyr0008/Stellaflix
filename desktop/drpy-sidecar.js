/*
 * drpy-sidecar.js — drpy-lite sidecar 生命周期管理（批 2 · 新文件）
 *
 * 职责：拉起/监控/重启 drpy-lite 运行时（index.js），对外提供 status 查询。
 * 设计：
 *   - 纯 Node child_process 实现（不绑 Electron），server.js 与测试均可直接 require
 *   - 握手：监听子进程 stdout 的 `DRPY_READY <host>:<port>` 行
 *   - 崩溃：指数退避重启（1s 起、上限 30s），连续 5 次失败后停止并标记 error
 *   - 退出：进程退出时随主进程终止子进程
 * 安全：drpy-lite 仅监听 127.0.0.1；规则目录出厂为空（合规红线见 BUILD-NOTES）
 */
'use strict';

const {spawn} = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

const RESTART_BASE_MS = 1000;
const RESTART_MAX_MS = 30 * 1000;
const RESTART_GIVE_UP = 5;
const READY_TIMEOUT_MS = 20 * 1000;

function createDrpySidecar(options) {
  const opts = options || {};
  const liteDir = opts.liteDir
    || process.env.DRPY_LITE_DIR
    || path.join(__dirname, '..', 'drpy-lite');
  const host = opts.host || process.env.DRPY_HOST || '127.0.0.1';
  const port = (opts.port != null ? opts.port : (process.env.DRPY_PORT != null ? parseInt(process.env.DRPY_PORT, 10) : 5757));

  let child = null;
  let state = 'stopped'; // stopped | starting | running | error
  let baseUrl = null;
  let restarts = 0;
  let consecutiveFailures = 0;
  let lastError = null;
  let stopped = true; // 用户意图：是否应当处于运行状态
  let restartTimer = null;

  function log() {
    if (!opts.quiet) console.log('[drpy-sidecar]', ...arguments);
  }

  function computeBackoff() {
    return Math.min(RESTART_BASE_MS * Math.pow(2, restarts), RESTART_MAX_MS);
  }

  function scheduleRestart() {
    if (stopped || state === 'error') return;
    if (restartTimer) return; // 幂等：勿因双重触发而叠加重启
    if (consecutiveFailures >= RESTART_GIVE_UP) {
      state = 'error';
      lastError = '连续 ' + consecutiveFailures + ' 次启动失败，放弃重启';
      log(lastError);
      return;
    }
    const delay = computeBackoff();
    restarts += 1;
    log('将在', delay, 'ms 后重启（第', restarts, '次）');
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (stopped) return;
      start();
    }, delay);
  }

  function waitForReady(c) {
    return new Promise((resolve) => {
      let buf = '';
      let done = false;
      const timer = setTimeout(() => finish(null, 'READY 超时 (' + READY_TIMEOUT_MS + 'ms)'), READY_TIMEOUT_MS);
      const onData = (chunk) => {
        buf += chunk.toString('utf8');
        const m = buf.match(/DRPY_READY\s+([0-9.]+):(\d+)/);
        if (m && !done) finish('http://' + m[1] + ':' + m[2], null);
      };
      const onExit = () => { if (!done) finish(null, '子进程在 READY 前退出'); };
      function finish(url, err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        c.stdout.off('data', onData);
        c.off('exit', onExit);
        resolve({url, err});
      }
      c.stdout.on('data', onData);
      c.on('exit', onExit);
    });
  }

  function start() {
    if (child) return;
    // 可选组件语义：drpy-lite 未随包安装时保持 error 态，不反复 spawn，不阻断主服务
    if (!fs.existsSync(path.join(liteDir, 'index.js'))) {
      state = 'error';
      lastError = 'drpy-lite 未安装（可选组件），跳过启动: ' + liteDir;
      return;
    }
    stopped = false; // 自动重启放行
    state = 'starting';
    try {
      child = spawn(process.execPath, [path.join(liteDir, 'index.js')], {
        cwd: liteDir,
        env: Object.assign({}, process.env, {DRPY_HOST: host, DRPY_PORT: String(port)}),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      state = 'error';
      lastError = 'spawn 失败: ' + e.message;
      return;
    }
    const c = child;
    log('启动 drpy-lite pid=' + c.pid, 'dir=' + liteDir, 'port=' + port);
    c.stderr && c.stderr.on('data', () => {}); // 丢弃 stderr，避免管道堵死
    // spawn 失败（如 cwd 消失、ENOENT）走 error 事件：必须挂 handler，否则进程崩溃
    c.on('error', (e) => {
      if (child !== c) return;
      child = null;
      baseUrl = null;
      if (stopped) { state = 'stopped'; return; }
      lastError = 'spawn error: ' + e.message;
      consecutiveFailures += 1;
      state = 'crashed';
      scheduleRestart();
    });
    c.on('exit', (code, signal) => {
      if (child !== c) return; // 已有新一代实例
      child = null;
      baseUrl = null;
      if (stopped) { state = 'stopped'; return; } // 主动 stop，不重启
      log('子进程异常退出 code=' + code, 'signal=' + signal);
      consecutiveFailures += 1;
      state = 'crashed';
      scheduleRestart();
    });
    waitForReady(c).then(({url, err}) => {
      if (child !== c) return; // 晚到的旧实例就绪信号，忽略
      if (url) {
        state = 'running';
        baseUrl = url;
        consecutiveFailures = 0;
        log('READY', url);
      } else {
        consecutiveFailures += 1;
        lastError = err || 'unknown';
        if (!stopped && child === null) {
          state = 'crashed';
          scheduleRestart();
        }
      }
    });
  }

  function stop() {
    stopped = true; // 禁止自动重启
    state = 'stopped';
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (child) {
      try { child.kill('SIGTERM'); } catch (e) { /* ignore */ }
      child = null;
    }
    baseUrl = null;
  }

  function status() {
    return {
      state,
      baseUrl,
      pid: child ? child.pid : null,
      restarts,
      consecutiveFailures,
      lastError,
      liteDir,
    };
  }

  function healthCheck(timeoutMs) {
    if (!baseUrl) return Promise.resolve({ok: false, reason: 'not-running'});
    return new Promise((resolve) => {
      const req = http.get(baseUrl + '/config?healthy=1', {timeout: timeoutMs || 5000}, (res) => {
        res.resume();
        resolve({ok: res.statusCode === 200, reason: res.statusCode === 200 ? null : 'HTTP_' + res.statusCode});
      });
      req.on('timeout', () => { req.destroy(); resolve({ok: false, reason: 'timeout'}); });
      req.on('error', (e) => resolve({ok: false, reason: e.message}));
    });
  }

  return {start, stop, status, healthCheck};
}

module.exports = {createDrpySidecar};
