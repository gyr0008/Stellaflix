'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('封面壁纸主进程复用 DesktopWallpaperRuntime 且只注册独立通道', () => {
  const src = read('desktop/cover-wallpaper-runtime.js');
  assert.match(src, /require\('\.\/wallpaper-mode-runtime'\)/);
  assert.match(src, /new DesktopWallpaperRuntime/);
  assert.match(src, /overlay-preload\.js/);
  assert.match(src, /cover-wallpaper\.html/);
  for (const ch of [
    'stellaflix-cover-wallpaper-set-enabled',
    'stellaflix-cover-wallpaper-update',
    'stellaflix-cover-wallpaper-get-status',
    'stellaflix-cover-wallpaper-runtime-state',
  ]) assert.ok(src.includes(ch), 'missing channel ' + ch);
});

test('main.js 只接新模块名，quick-check 红线字样仍不存在', () => {
  const mainText = read('desktop/main.js');
  assert.match(mainText, /require\('\.\/cover-wallpaper-runtime'\)/);
  assert.ok(!mainText.includes('cover-wallpaper.html'), '页面名不得进 main.js（含禁用子串 wallpaper.html）');
  for (const marker of ['DesktopWallpaperRuntime', 'wallpaper-mode-runtime', 'wallpaper.html', 'wallpaper-preload.js']) {
    assert.ok(!mainText.includes(marker), 'main.js 不得含 ' + marker);
  }
});

test('preload 暴露 4 个封面壁纸 API', () => {
  const src = read('desktop/preload.js');
  for (const api of ['setCoverWallpaperMode', 'updateCoverWallpaperMode', 'getCoverWallpaperModeStatus', 'onCoverWallpaperModeState']) {
    assert.ok(src.includes(api), 'missing api ' + api);
  }
});

test('挂接脚本按候选链逐级回落，末端才退 Progman 父窗口', () => {
  const src = read('desktop/wallpaper-mode-runtime.js');
  // Windows 11 26xxx（NT 10.0.26300 实测）：DefView 宿主就是 Progman 且它排在 Z 序最后，
  // 经典「取 DefView 之后的兄弟 WorkerW」恒为 0，必须补上 Progman 子 WorkerW 这一档。
  assert.match(src, /FindWindowExByClass\(\$top, \[IntPtr\]::Zero, "SHELLDLL_DefView"\)/,
    '① 经典：含 DefView 的顶层窗之后的兄弟 WorkerW');
  assert.match(src, /FindWindowExByClass\(\$progman, \[IntPtr\]::Zero, "WorkerW"\)/,
    '② Windows 11 26xxx：Progman 的子 WorkerW');
  assert.match(src, /hostStrategy|strategy = 'shelldll-defview'/, '必须向渲染层汇报宿主策略');
  assert.match(src, /\$script:workerw -eq \[IntPtr\]::Zero\) \{ \$script:workerw = \$progman; \$script:strategy = 'progman' \}/,
    '④ 末端兜底仍是 Progman');
  assert.ok(!src.includes('throw "WALLPAPER_WORKERW_NOT_FOUND"'), '26300 上 0x052C 为 no-op，遇不到 WorkerW 不得直接报错');
});

test('Z 序锚点：WorkerW 宿主插最上层，Progman 宿主插 DefView 之下，DefView 宿主保持最底', () => {
  const src = read('desktop/wallpaper-mode-runtime.js');
  const block = src.slice(src.indexOf('$insertAfter'), src.indexOf('WALLPAPER_WORKERW_POSITION_FAILED'));

  // 2026-10-25 真机实测（2560x1440 / NT 10.0.26300，本机跑着 Wallpaper Engine）：
  //   Progman(65972) └─ WorkerW(66072) ├─ WPEDesktopDX11Window(131632)  ← WPE 壁纸
  //                                   └─ 我们的 Chrome_WidgetWin_1
  // 旧实现无条件插 HWND_BOTTOM(1) → 被 WPE 同尺寸窗口整块盖住，
  // 用户可见面 =「桌面壁纸层开了、桌面毫无反应」。改成默认 HWND_TOP(0)。
  assert.match(block, /^\$insertAfter = \[IntPtr\]::Zero$/m,
    '宿主是 WorkerW 时必须插到该宿主最上层（HWND_TOP），否则会被同父的 WPE 壁纸盖住');
  assert.match(block, /-eq 'progman'/, 'Progman 本体这一档改用 DefView 作为插入锚点');
  assert.match(block, /\$insertAfter = \$defViewHost/);
  assert.match(block, /-eq 'shelldll-defview'[\s\S]{0,120}Int64\]1/,
    '宿主是 DefView 本体时保持最底，避免盖住图标列表');
  assert.doesNotMatch(block, /^\$insertAfter = \[IntPtr\]::new\(\[Int64\]1\)$/m,
    '默认插最底是已证伪的旧行为，不得回潮');
  assert.match(src, /SetWindowPos\(\$target, \$insertAfter/, '必须用计算出的插入锚点而不是写死 HWND_BOTTOM');
});

test('Progman 直挂并置顶（progman-top）：壁纸要压在桌面图标层之上', () => {
  const src = read('desktop/wallpaper-mode-runtime.js');

  // 2026-10-25 真机实测的层级事实：
  //   Progman(65972)
  //   ├─ SHELLDLL_DefView(131474)   ← 图标层，是 Progman 的**直接子窗**
  //   └─ WorkerW(66072)             ← 壁纸层（WPE 也在这里），与 DefView 是**兄弟**
  // Z 序只在同父兄弟间生效，所以挂在 WorkerW 里的窗口永远盖不住图标。
  // 要把图标盖住（用户需求：隐藏桌面图标），只能挂 Progman 本体并置最上层。
  assert.match(src, /-and \$defViewHost -ne \[IntPtr\]::Zero\) \{\s*\n\s*\$script:workerw = \$progman\s*\n\s*\$script:strategy = 'progman-top'/,
    'DefView 是 Progman 直接子窗时必须改挂 Progman 本体，否则图标盖不住');
  assert.match(src, /FindWindowExByClass\(\$progman, \[IntPtr\]::Zero, "SHELLDLL_DefView"\)/,
    'progman-top 的前提判断就是「DefView 是否为 Progman 直接子窗」');
  // 只在满足前提时启用：经典 Win10 布局（DefView 在 WorkerW 里）继续走原候选链，不改老机器行为。
  assert.match(src, /if \(\$progman -ne \[IntPtr\]::Zero -and \$defViewHost -ne \[IntPtr\]::Zero\)/,
    'progman-top 不得无条件启用');
});

test('壁纸窗必须关掉隐形边框（thickFrame:false），否则整屏也漏一条桌面缝', () => {
  const src = read('desktop/wallpaper-mode-runtime.js');
  const start = src.indexOf('createWindow()');
  assert.ok(start > 0, 'createWindow 必须存在');
  const block = src.slice(start, src.indexOf('setIgnoreMouseEvents', start));
  // 实测：不加 thickFrame:false 时 Electron 给无边框窗保留 8px 隐形 WS_THICKFRAME 命中边框，
  // 客户区变成 2544x1432 且起点 (8,0)，SetWindowPos 到 2560x1440 后四边仍漏出桌面/图标。
  assert.match(block, /thickFrame: false/,
    '无边框壁纸窗必须 thickFrame:false，才能让客户区等于整屏');
  assert.match(block, /frame: false/, '仍然必须是无边框');
  assert.match(block, /resizable: false/, '仍然不可缩放');
});

test('渲染层不得把 progman-top 当成「不可见」而降级到背景板', () => {
  const src = read('public/js/modules/02-visual/18-cover-wallpaper.js');
  const start = src.indexOf('function coverWallpaperDesktopLayerHidden');
  assert.ok(start > 0, 'coverWallpaperDesktopLayerHidden 必须存在');
  const block = src.slice(start, src.indexOf('\n}', start));
  // 旧判定是 strategy === 'progman' 即判死（当时 Progman 宿主会被系统壁纸盖住）。
  // 现在 progman-top 是我们主动选择的「盖住图标」宿主，必须判为可见，
  // 因此匹配必须严格等值，绝不能放宽成 startsWith / indexOf。
  assert.match(block, /strategy === 'progman'/, '只认旧兜底策略名');
  assert.doesNotMatch(block, /startsWith\('progman'\)|indexOf\('progman'\)/,
    '放宽匹配会把 progman-top 误判成不可见，触发假降级');
});
