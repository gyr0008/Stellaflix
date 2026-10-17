'use strict';

// 二次实例的可见反馈文案层（desktop/main.js 引用）。
// 背景：首实例还在端口探测/服务端启动阶段时 mainWindow 为 null，focusMainWindow() 直接
// 返回 false，第二个进程静默 exit(0) —— 用户看到的就是「双击图标闪一下就没了」。
// 这里只出文案，不碰 Electron，方便纯 node 单测（tests/second-instance-notice.test.js）。

function elapsedTextOf(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '';
  return (n / 1000).toFixed(1) + ' 秒';
}

function buildNotice(opts) {
  opts = opts || {};
  const port = opts.port || 3000;
  const elapsed = elapsedTextOf(opts.elapsedMs);
  const stage = opts.stage || 'startup';
  return {
    type: 'info',
    title: 'Stellaflix',
    message: 'Stellaflix 已在启动中，请稍候' + (elapsed ? `（已等 ${elapsed}）` : '。'),
    detail: stage === 'port-lock'
      ? `正在等待端口 ${port} 让出。窗口出现后会自动带到前台，不用重复双击图标。`
      : `窗口出现后会自动带到前台，不用重复双击图标。若超过 30 秒仍无窗口，请查看 ${port} 端口是否被占用。`,
    buttons: ['我知道了'],
    noLink: true,
    elapsedText: elapsed,
  };
}

module.exports = { buildNotice, elapsedTextOf };
