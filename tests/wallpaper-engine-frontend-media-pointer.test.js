'use strict';

/**
 * tests/wallpaper-engine-frontend-media-pointer.test.js — WE 前端移植契约（批 3b：A7/A8/B8）
 *
 * 移植来源：Mineradio-2.5.1 public/wallpaper-engine.js（THEIRS），hunks H46（A7 媒体根 chip）、
 * H2/H3（A8 指针活动 8ms 节奏 + lastSentX/Y 去重），B8 为 COPY-2 独有的
 * describeWallpaperEngineMediaFailure 反向补齐 COPY-1。
 * Stellaflix 同一引擎有两份拷贝同时在页面执行（后加载者赢），任何行为修改必须
 * lockstep 落在两份上（house style 参照 wallpaper-engine-frontend-flicker-port.test.js）：
 *   COPY-1: public/js/modules/07-fx/03-wallpaper-engine-library.js（monolithic，EOF 自启动，仅做源码钉）
 *   COPY-2: public/video/wallpaper-engine/wallpaper-engine-*.js（split，init 由 video/bootstrap.js 延迟）
 * COPY-2 的 state.js / library.js 在 vm 中可独立执行，故对 chip 渲染与指针去重做行为验证。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const COPY1_FILE = 'public/js/modules/07-fx/03-wallpaper-engine-library.js';
const COPY2_DIR = 'public/video/wallpaper-engine/';
const COPY2_FILES = [
  'wallpaper-engine-state.js',
  'wallpaper-engine-capture.js',
  'wallpaper-engine-capture-result.js',
  'wallpaper-engine-bridge.js',
  'wallpaper-engine-glass.js',
  'wallpaper-engine-playback.js',
  'wallpaper-engine-library.js',
  'wallpaper-engine-ui.js'
].map((f) => COPY2_DIR + f);

const copy1 = read(COPY1_FILE);
const copy2 = COPY2_FILES.map(read).join('\n');
const BOTH = [['COPY-1', copy1], ['COPY-2', copy2]];

// ---------------------------------------------------------------------------
// A7 源码钉：manual-root chip 必须区分 kind==='media'（导入的视频/图片文件）
// ---------------------------------------------------------------------------

test('A7 源码钉：renderWallpaperEngineManualRoots 处理 root.kind === \'media\'', () => {
  for (const [label, text] of BOTH) {
    assert.match(
      text,
      /function renderWallpaperEngineManualRoots\(\)[\s\S]{0,1200}?var isMedia = root\.kind === 'media';/,
      `${label} chip 渲染缺少 media 根识别（手动导入的视频/图片会被当目录渲染）`
    );
    assert.match(text, /isMedia \? '手动导入文件' : '手动导入目录'/, `${label} chip title 缺少 media 分支`);
    assert.match(text, /escHtml\(root\.name \|\| \(isMedia \? '导入视频' : '导入目录'\)\)/, `${label} chip 名称兜底缺少 media 分支`);
    assert.match(text, /isMedia \? '移除此索引文件' : '移除此索引目录'/, `${label} 移除按钮 title 缺少 media 分支`);
    // 移除链路保持 id 透传（kind:'media' 与 directory 共用 remove-root 流程）
    assert.match(
      text,
      /data-wallpaper-action="remove-root" data-root-id="' \+ escHtml\(root\.id \|\| ''\)/,
      `${label} remove-root 按钮必须以 data-root-id 携带不透明 id（媒体移除依赖它，勿改成路径）`
    );
    assert.match(
      text,
      /removeWallpaperEngineDirectory\(button\.getAttribute\('data-root-id'\)\)/,
      `${label} chip 点击代理必须仍走 removeWallpaperEngineDirectory(rootId)`
    );
  }
});

// ---------------------------------------------------------------------------
// A8 源码钉：两份拷贝统一 8ms 节奏 + 量化去重（lastSentX/Y no-op skip）
// ---------------------------------------------------------------------------

test('A8 源码钉：指针活动 8ms 节奏与 lastSentX/Y 去重在两份拷贝同时成立', () => {
  for (const [label, text] of BOTH) {
    assert.match(
      text,
      /var WALLPAPER_ENGINE_POINTER_ACTIVITY_INTERVAL_MS = 8;/,
      `${label} 指针活动节奏必须是 8ms（owner 拍板：流畅度优先）`
    );
    assert.doesNotMatch(text, /WALLPAPER_ENGINE_POINTER_ACTIVITY_INTERVAL_MS = 20;/, `${label} 仍残留 20ms 节流`);
    assert.match(
      text,
      /var wallpaperEnginePointerActivityLastSentX = -1;\s*var wallpaperEnginePointerActivityLastSentY = -1;/,
      `${label} 缺少 lastSentX/Y 去重变量声明`
    );
    assert.match(
      text,
      /function cancelWallpaperEnginePointerActivity\(\)[\s\S]{0,320}?wallpaperEnginePointerActivityLastSentX = -1;\s*wallpaperEnginePointerActivityLastSentY = -1;/,
      `${label} cancel 时必须复位 lastSentX/Y`
    );
    assert.match(
      text,
      /if \(nextX === wallpaperEnginePointerActivityLastSentX && nextY === wallpaperEnginePointerActivityLastSentY\) return;/,
      `${label} flush 缺少同格指针 no-op IPC 跳过`
    );
    assert.match(
      text,
      /wallpaperEnginePointerActivityLastSentX = nextX;\s*wallpaperEnginePointerActivityLastSentY = nextY;/,
      `${label} flush 发送成功后必须记录 lastSentX/Y`
    );
  }
});

// ---------------------------------------------------------------------------
// B8 源码钉：COPY-2 独有的 describeWallpaperEngineMediaFailure 反向补齐 COPY-1
// ---------------------------------------------------------------------------

test('B8 源码钉：describeWallpaperEngineMediaFailure 与 layerFailed 错误透传在两份拷贝同时存在', () => {
  for (const [label, text] of BOTH) {
    assert.match(
      text,
      /function describeWallpaperEngineMediaFailure\(item, error\) \{/,
      `${label} 缺少 MediaError.code 诊断函数（双拷贝漂移）`
    );
    assert.match(text, /MediaError\.code=/, `${label} 诊断日志必须带 MediaError.code`);
    assert.match(
      text,
      /function wallpaperEngineLayerFailed\(item, attemptedKind, token, error\) \{/,
      `${label} wallpaperEngineLayerFailed 必须接收 error 形参`
    );
    assert.match(
      text,
      /describeWallpaperEngineMediaFailure\(item, error\)\);/,
      `${label} media 起播失败 toast 必须走 describeWallpaperEngineMediaFailure(item, error)`
    );
    assert.match(
      text,
      /video\.onerror = function \(\) \{\s*var mediaErr = video\.error \|\| null;\s*wallpaperEngineLayerFailed\(item, kind, token, mediaErr\);\s*\};/,
      `${label} media 视频 onerror 必须把 video.error 透传给 layerFailed`
    );
  }
});

// ---------------------------------------------------------------------------
// 行为验证（COPY-2 split 文件在 vm 中独立可跑）
// ---------------------------------------------------------------------------

function makeChipEnv() {
  const host = { innerHTML: '' };
  const sandbox = {
    console,
    window: {},
    document: {
      getElementById: (id) => (id === 'wallpaper-engine-manual-roots' ? host : null)
    },
    wallpaperEngineProjects: [],
    wallpaperEngineLibrarySnapshot: {
      manualRoots: [
        { kind: 'directory', id: 'a1b2c3d4e5f60718293a4b5c', name: 'Steam 创意库' },
        { kind: 'media', id: 'b2c3d4e5f60718293a4b5c6d', name: 'neon-city.mp4' },
        { kind: 'media', id: 'c3d4e5f60718293a4b5c6d7e', name: '' }
      ]
    },
    wallpaperEngineMediaToken: '',
    wallpaperEngineLibraryBusy: false,
    wallpaperEngineSelection: { id: '', kind: 'preview', active: false }
  };
  vm.createContext(sandbox);
  vm.runInContext(read(COPY2_DIR + 'wallpaper-engine-library.js'), sandbox, { filename: 'wallpaper-engine-library.js' });
  // escHtml 由 05-playback 模块提供（本 split 文件外），沙箱内补桩
  sandbox.escHtml = (value) => String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  return { sandbox, host };
}

test('A7 行为：library.js chip 渲染——media 根用文件文案、directory 根不变、remove-root 携带 id', () => {
  const { sandbox, host } = makeChipEnv();
  sandbox.renderWallpaperEngineManualRoots();
  const html = host.innerHTML;
  const chips = html.split('<span class="wallpaper-engine-root-chip">').slice(1);
  assert.equal(chips.length, 3, '三个手动根应渲染三枚 chip');
  assert.match(chips[0], /title="手动导入目录"/, 'directory 根保持原 title');
  assert.match(chips[0], /title="移除此索引目录"/, 'directory 根保持原移除 title');
  assert.ok(chips[0].includes('Steam 创意库'), 'directory 名称应原样出现');
  assert.match(chips[1], /title="手动导入文件"/, 'media 根 title 必须是「手动导入文件」');
  assert.match(chips[1], /title="移除此索引文件"/, 'media 根移除 title 必须是「移除此索引文件」');
  assert.ok(chips[1].includes('neon-city.mp4'), 'media 根应显示导入文件名');
  assert.ok(!chips[1].includes('手动导入目录'), 'media chip 不得沿用目录文案');
  assert.ok(chips[2].includes('导入视频'), 'media 根名称为空时应兜底为「导入视频」');
  for (const chip of chips) {
    assert.match(chip, /data-wallpaper-action="remove-root" data-root-id="[a-f0-9]+"/, '每枚 chip 都要带 remove-root + root id');
  }
  assert.match(chips[1], /data-root-id="b2c3d4e5f60718293a4b5c6d"/, 'media chip 的 root id 必须原样透传给移除流程');
});

function makeStateEnv() {
  const calls = [];
  const layer = {
    classList: {
      _set: new Set(['engine-ready']),
      add(...cs) { cs.forEach((c) => this._set.add(c)); },
      remove(...cs) { cs.forEach((c) => this._set.delete(c)); },
      contains(c) { return this._set.has(c); }
    }
  };
  const sandbox = {
    console,
    window: {},
    document: {
      hidden: false,
      documentElement: { clientWidth: 1920, clientHeight: 1080 },
      getElementById: (id) => (id === 'wallpaper-engine-layer' ? layer : null)
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(read(COPY2_DIR + 'wallpaper-engine-state.js'), sandbox, { filename: 'wallpaper-engine-state.js' });
  // 覆盖同文件声明的会话状态与桌面 API，聚焦验证指针节奏
  sandbox.wallpaperEngineDesktopApi = () => ({
    reportWallpaperEnginePointerActivity: (payload) => { calls.push(payload); }
  });
  sandbox.wallpaperEngineSelection = { id: 'x', kind: 'engine', active: true };
  sandbox.wallpaperEngineHostBoundsPreparing = false;
  sandbox.wallpaperEngineNativeSessionId = 'a1b2c3d4e5f60718293a4b5c';
  sandbox.wallpaperEngineCaptureStream = {};
  return { sandbox, calls };
}

test('A8 行为：state.js 指针活动——8ms 常量、同量化格 no-op 去重、移动后恢复发送、cancel 复位', () => {
  const { sandbox, calls } = makeStateEnv();
  assert.equal(sandbox.WALLPAPER_ENGINE_POINTER_ACTIVITY_INTERVAL_MS, 8,
    'COPY-2 运行时节奏常量必须是 8ms');

  sandbox.rememberWallpaperEnginePointerPosition({ clientX: 100, clientY: 200 });
  sandbox.flushWallpaperEnginePointerActivity();
  assert.equal(calls.length, 1, '首个坐标必须上报');
  assert.equal(calls[0].sessionId, 'a1b2c3d4e5f60718293a4b5c');

  // 同一量化格重复 flush：不得再发 IPC（8ms 高频节奏依赖该去重）
  sandbox.flushWallpaperEnginePointerActivity();
  sandbox.flushWallpaperEnginePointerActivity();
  assert.equal(calls.length, 1, '指针停在同一量化格时不得重复发送 IPC');

  // 位置改变：恢复发送
  sandbox.rememberWallpaperEnginePointerPosition({ clientX: 800, clientY: 600 });
  sandbox.flushWallpaperEnginePointerActivity();
  assert.equal(calls.length, 2, '指针移动到不同量化格必须上报');
  assert.ok(calls[1].xUnit !== calls[0].xUnit, 'xUnit 应随位置变化');

  // cancel 复位 lastSentX/Y 后，同一位置重新允许上报
  sandbox.cancelWallpaperEnginePointerActivity();
  sandbox.rememberWallpaperEnginePointerPosition({ clientX: 800, clientY: 600 });
  sandbox.flushWallpaperEnginePointerActivity();
  assert.equal(calls.length, 3, 'cancel 后 lastSent 复位，同点应重新上报');
});
