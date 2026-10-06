'use strict';

// 3000 端口硬锁的纯解析层（desktop/main.js 引用）。
// Electron main 无法纯 node 单测（poster-cache/vault 同例），解析逻辑拆到这里，
// 由 tests/port-lock.test.js 以 netstat/tasklist 夹具覆盖。

// netstat -ano 输出中取 port 的 LISTENING 行 PID；无则 null。
function parseListeningPid(netstatOutput, port) {
  const lines = String(netstatOutput || '').split(/\r?\n/);
  const target = ':' + port;
  for (let i = 0; i < lines.length; i++) {
    const cols = lines[i].trim().split(/\s+/);
    if (cols.length < 5 || cols[0] !== 'TCP') continue;
    if (!cols[1].endsWith(target)) continue;
    if (cols[3].toUpperCase() !== 'LISTENING') continue;
    if (/^\d+$/.test(cols[4]) && cols[4] !== '0') return cols[4];
  }
  return null;
}

// tasklist 输出（表格或 CSV）中取指定 PID 的映像名；无则 null。
function parseTasklistName(tasklistOutput, pid) {
  const lines = String(tasklistOutput || '').split(/\r?\n/);
  const pidStr = String(pid);
  for (let i = 0; i < lines.length; i++) {
    const csv = lines[i].match(/^\s*"([^"]+)"\s*,\s*"?/);
    if (csv) {
      const rest = lines[i].replace(/^\s*"[^"]+"\s*,\s*"?/, '');
      if (rest.startsWith(pidStr)) return csv[1];
      continue;
    }
    const cols = lines[i].trim().split(/\s+/);
    if (cols.length >= 2 && cols[1] === pidStr && /\./.test(cols[0])) return cols[0];
  }
  return null;
}

module.exports = { parseListeningPid, parseTasklistName };
