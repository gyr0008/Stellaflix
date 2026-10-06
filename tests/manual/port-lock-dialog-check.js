'use strict';

// 手动验收工装（用完即杀，勿留残留占 3000）：
//   1. node tests/manual/port-lock-dialog-check.js occupier        # 占住 3000
//   2. 启动 Stellaflix → 应弹「端口 3000 已被占用」对话框
//      - 点「结束占用并重试」→ 应用 taskkill 本工装并正常绑 3000
//      - 或点「退出应用」→ 应用干净退出，3000 仍由本工装持有
//   3. node tests/manual/port-lock-dialog-check.js selftest        # 实弹解析校验
const { execSync } = require('child_process');
const netstat = execSync('netstat -ano', { encoding: 'utf8' });

const { parseListeningPid, parseTasklistName } = require('../../desktop/port-lock');

if (process.argv[2] === 'occupier') {
  require('net').createServer().listen(3000, '127.0.0.1', () => {
    console.log('occupier listening on 127.0.0.1:3000, pid=' + process.pid);
  });
} else if (process.argv[2] === 'selftest') {
  const pid = parseListeningPid(netstat, 3000);
  console.log('3000 LISTENING pid =', pid);
  if (pid) {
    const tasklist = execSync('tasklist /FI "PID eq ' + pid + '" /NH', { encoding: 'utf8' });
    console.log('process name =', parseTasklistName(tasklist, pid));
  }
} else {
  console.log('usage: node tests/manual/port-lock-dialog-check.js occupier|selftest');
}
