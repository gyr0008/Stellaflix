'use strict';
// 任务栏隐藏 / 还原（壁纸模式沉浸态专用）。
//
// 为什么必须「真隐藏」而不是「盖住」——本机实测 2026-10-25（2560x1440 / Win11 NT 10.0.26300，
// 任务栏 auto-hide 开启），四组对照（判据 = 光标移到底部后 Shell_TrayWnd 的矩形变不变）：
//   | 场景                          | tray rect        | 结论            |
//   | 无全屏窗（对照组）             | 1438 → 1392      | 弹出来了        |
//   | 全屏窗 + 前台                  | 1438 → 1438      | 被抑制，不弹     |
//   | 全屏窗 + 非前台                | 1438 → 1392      | 会弹            |
//   | 全屏窗 + topmost + 非前台       | 1438 → 1392      | 仍会弹          |
// 结论：Shell_TrayWnd 自身是 WS_EX_TOPMOST，光标贴边时 Explorer 会把它 raise 到 topmost 带最上方，
// 所以「把壁纸窗设成 topmost」挡不住它（实拍里连开始菜单都会弹到壁纸上面）。
// 只有 ShowWindow(Shell_TrayWnd, SW_HIDE) 能同时做到「不显示」和「悬停也不出现」。
//
// 另一个必须记的坑：FindWindow("Shell_TrayWnd", $null) 在 PowerShell 里**恒失败**。
// PowerShell 把 $null 绑到 [string] 形参时传的是空字符串 ""（实测 `[string]$null` 长度 0、非 NULL），
// 而空字符串只匹配「标题为空」的窗口；Shell_TrayWnd / Progman 的标题都非空。
// 必须传 [NullString]::Value 才是真正的 NULL 指针（实测：$null→0，[NullString]::Value→65972）。

const TASKBAR_HIDE_CMD = 0; // SW_HIDE
const TASKBAR_SHOW_CMD = 5; // SW_SHOW

/**
 * 生成任务栏显隐脚本（纯 ASCII：PowerShell 5.1 的 -File / -Command 在中文系统上按 ANSI 读中文会截断字符串）。
 * @param {boolean} hidden 是否隐藏。
 * @returns {string} PowerShell 脚本。
 */
function taskbarVisibilityScript(hidden) {
  const wantHidden = hidden === true;
  const command = wantHidden ? TASKBAR_HIDE_CMD : TASKBAR_SHOW_CMD;
  const expectVisible = wantHidden ? '$false' : '$true';
  return `
$ErrorActionPreference = "Continue"
if (-not ("StellaflixTaskbarNative" -as [type])) {
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class StellaflixTaskbarNative {
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr FindWindow(string className, string windowName);
  [DllImport("user32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsWindow(IntPtr hWnd);
}
"@
}
$tray = [StellaflixTaskbarNative]::FindWindow("Shell_TrayWnd", [NullString]::Value)
if ($tray -eq [IntPtr]::Zero -or -not [StellaflixTaskbarNative]::IsWindow($tray)) {
  [pscustomobject]@{ ok = $false; reason = "SHELL_TRAY_NOT_FOUND"; hwnd = "0"; visible = $false; requestedHidden = ${wantHidden ? '$true' : '$false'} } | ConvertTo-Json -Compress
  exit 0
}
[StellaflixTaskbarNative]::ShowWindow($tray, ${command}) | Out-Null
$visible = [StellaflixTaskbarNative]::IsWindowVisible($tray)
[pscustomobject]@{ ok = ($visible -eq ${expectVisible}); reason = ""; hwnd = $tray.ToInt64().ToString(); visible = $visible; requestedHidden = ${wantHidden ? '$true' : '$false'} } | ConvertTo-Json -Compress
`;
}

function parseTaskbarResult(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed && typeof parsed === 'object' && Object.prototype.hasOwnProperty.call(parsed, 'ok')) return parsed;
    } catch (_) { }
  }
  return null;
}

/**
 * 设置任务栏显隐。**永不 reject**：这是沉浸态的附属动作，失败只降级为「任务栏还在」，
 * 不能反过来把壁纸模式整体搞挂。
 * @param {boolean} hidden 是否隐藏。
 * @param {object} options { execFileImpl, timeoutMs, logger }
 * @returns {Promise<{ok:boolean, visible:boolean, hwnd:string, reason:string}>} 结果。
 */
function setTaskbarHidden(hidden, options = {}) {
  const execFileImpl = options.execFileImpl;
  const fallback = {
    ok: false,
    visible: hidden !== true,
    hwnd: '',
    reason: 'SHELL_TRAY_EXEC_UNAVAILABLE',
  };
  if (typeof execFileImpl !== 'function') return Promise.resolve(fallback);
  let script;
  try {
    script = taskbarVisibilityScript(hidden === true);
  } catch (error) {
    return Promise.resolve({ ...fallback, reason: String(error && error.message || 'SHELL_TRAY_SCRIPT_FAILED') });
  }
  const logger = options.logger || console;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      execFileImpl('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true,
        timeout: Math.max(1000, Math.min(10000, Number(options.timeoutMs) || 5000)),
        maxBuffer: 128 * 1024,
      }, (error, stdout) => {
        if (error) {
          const reason = String(error && error.message || 'SHELL_TRAY_EXEC_FAILED');
          if (logger && typeof logger.warn === 'function') logger.warn('[Taskbar] visibility change failed:', reason);
          finish({ ...fallback, reason });
          return;
        }
        const parsed = parseTaskbarResult(stdout);
        if (!parsed) {
          finish({ ...fallback, reason: 'SHELL_TRAY_ACK_INVALID' });
          return;
        }
        finish({
          ok: parsed.ok === true,
          visible: parsed.visible === true,
          hwnd: String(parsed.hwnd || ''),
          reason: String(parsed.reason || ''),
        });
      });
    } catch (error) {
      finish({ ...fallback, reason: String(error && error.message || 'SHELL_TRAY_EXEC_FAILED') });
    }
  });
}

/**
 * 确保任务栏可见。启动自愈与退出兜底都用它——宁可多显示一次，也不能把任务栏弄丢。
 * @param {object} options 同 setTaskbarHidden。
 * @returns {Promise<object>} 结果。
 */
function ensureTaskbarVisible(options = {}) {
  return setTaskbarHidden(false, options);
}

/**
 * 同步还原任务栏（退出路径专用）。before-quit 里异步链可能被 15s 超时截断，
 * 所以最后一步必须用同步调用兜住，宁可卡住进程 200ms 也不能让用户的桌面停在「没有任务栏」。
 * @param {object} options { execFileSyncImpl, timeoutMs, logger }
 * @returns {boolean} 是否确认可见。
 */
function restoreTaskbarSync(options = {}) {
  const execFileSyncImpl = options.execFileSyncImpl;
  if (typeof execFileSyncImpl !== 'function') return false;
  const logger = options.logger || console;
  try {
    const stdout = execFileSyncImpl('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      taskbarVisibilityScript(false),
    ], {
      windowsHide: true,
      timeout: Math.max(1000, Math.min(10000, Number(options.timeoutMs) || 5000)),
      maxBuffer: 128 * 1024,
      encoding: 'utf8',
    });
    const parsed = parseTaskbarResult(stdout);
    return !!(parsed && parsed.ok === true);
  } catch (error) {
    if (logger && typeof logger.warn === 'function') logger.warn('[Taskbar] sync restore failed:', error && error.message || error);
    return false;
  }
}

module.exports = {
  TASKBAR_HIDE_CMD,
  TASKBAR_SHOW_CMD,
  ensureTaskbarVisible,
  parseTaskbarResult,
  restoreTaskbarSync,
  setTaskbarHidden,
  taskbarVisibilityScript,
};
