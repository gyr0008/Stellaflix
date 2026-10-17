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

// 「结束占用」只对得起用户：只有占用者确实是我们自己的残留进程时才提供这个按钮。
// 旧版把「结束占用并重试」设成 defaultId:0（回车即 taskkill），误杀过第三方服务。
const KILLABLE_OCCUPIER_RE = /^(stellaflix|electron|node)\.exe$/i;

function isKillableOccupier(occupier) {
  const pid = occupier && occupier.pid;
  const name = occupier && occupier.name;
  if (!pid || String(pid) === '0') return false;
  if (!name) return false;
  return KILLABLE_OCCUPIER_RE.test(String(name));
}

// 端口锁弹窗的全部文案与按钮决策（纯函数；真正弹给用户的动作留在 main.js）。
// 不变量：defaultId 与 cancelId 永远指向不杀进程的那一项。
function buildPortLockDialog(port, occupier) {
  const pid = occupier && occupier.pid && String(occupier.pid) !== '0' ? String(occupier.pid) : null;
  const who = pid
    ? `占用进程：${(occupier && occupier.name) || '未知'}（PID ${pid}）`
    : '占用者无法识别（可能非本机监听）。';
  const killable = isKillableOccupier(occupier);
  const buttons = killable ? ['结束占用并重试', '退出应用'] : ['重试', '退出应用'];
  const safeIndex = killable ? 1 : 0;
  return {
    type: 'warning',
    title: 'Stellaflix 无法启动',
    message: `端口 ${port} 已被占用。${who}`,
    detail: 'Stellaflix 固定使用端口 ' + port + '，换端口会导致影视数据换桶"消失"。\n'
      + (killable
        ? '占用者是 Stellaflix 自身或残留的服务端进程，可以结束后继续。\n'
        : '占用者不是 Stellaflix 的进程，结束它可能误伤别的程序，请自行确认后手动处理。\n')
      + '或退出应用保留现场。',
    buttons,
    defaultId: safeIndex,
    cancelId: buttons.length - 1,
    noLink: true,
    killable,
    safeIndex,
  };
}

module.exports = { parseListeningPid, parseTasklistName, isKillableOccupier, buildPortLockDialog };
