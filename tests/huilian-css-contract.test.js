'use strict';
/**
 * 汇联 Task8 样式↔DOM 契约锁（静态交叉核验，非重言式：渲染器与 player.css 是两个独立产物，
 * 本测用 vm 假 DOM 真实驱动渲染器到全部视觉状态，再核验每个 class 在 CSS 有规则）：
 *   a) 场景采集：降级页 / 桌面页 / pending 行 / 任务行 / 文件行 / 播控条 / 播完面板 / 中断降级面板，
 *      遍历真实渲染树收集 huilian-* class，逐个断言 public/video/player.css 存在对应规则；
 *   b) 反向清桩：旧 v1/v2/v3 带报废选择器不得残留（注释剥离后再查，防孤儿规则）；
 *   c) 属性谓词契约：data-hash / data-playable / data-playing 与 CSS 属性选择器一致。
 * 运行：node --test tests/huilian-css-contract.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadPage, fire } = require('./helpers/huilian-harness');

const CSS_PATH = path.join(__dirname, '..', 'public', 'video', 'player.css');
// 剥离 /* */ 注释后的 CSS：契约核验只看真实规则，允许注释中提及历史类名
const cssRules = () => fs.readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const MAGNET = 'magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCD2345';
const FILES = [
  { name: 'a.mkv', progress: 0.9, size: 1048576, content_path: 'D:/dl/a.mkv' },
  { name: 'b.srt', progress: 0.01, size: 512, content_path: 'D:/dl/b.srt' },
];
const flush = () => new Promise((r) => setImmediate(r));

/** 遍历渲染树收集 class 令牌（假 DOM 节点：attributes.class + children）。 */
function walk(node, out) {
  const cls = node.getAttribute && node.getAttribute('class');
  if (cls) String(cls).split(/\s+/).filter(Boolean).forEach((c) => out.add(c));
  (node.children || []).forEach((k) => walk(k, out));
}

/** 派发 mpv 事件（沿用 huilian-player-bar.test.js 约定：只打存活订阅）。 */
function emit(t, event, payload) {
  t.events.filter((e) => e.event === event && !e.removed)
    .forEach((e) => e.cb(payload || { event: event, id: e.playerId }));
}

/**
 * 桌面场景驱动到「任务行 + 展开文件行 + 播控条已挂载」：
 * 磁力加入 → pending 行 → 轮询认领 → 点任务行展开 → 点可播文件行 → overlay 创建 → .huilian-bar。
 * setInterval 捕获为手动 timer（与 Task7 测同款），保证确定性。
 */
async function driveToBar() {
  const t = loadPage({
    bridge: {
      download: {
        addTorrent: () => Promise.resolve({ ok: true, data: { hash: '' } }),
        list: () => Promise.resolve({
          ok: true,
          data: { torrents: [{ hash: 'HASH1', name: '某电影', state: 'downloading', progress: 0.5, dlspeed: 1, upspeed: 1, url: MAGNET }] },
        }),
        files: () => Promise.resolve({ ok: true, data: FILES }),
        delete: () => Promise.resolve({ ok: true, data: true }),
      },
    },
  });
  const timers = [];
  t.sandbox.setInterval = (fn) => { timers.push(fn); return timers.length; };
  t.sandbox.clearInterval = () => {};
  t.page.mount(t.host);

  t.doc.querySelector('#huilian-input').value = MAGNET;
  fire(t.doc.querySelector('#huilian-add'), 'click');
  await flush();
  t.pendingRow = t.doc.querySelector('.huilian-task');
  assert.ok(t.pendingRow && t.pendingRow.getAttribute('data-hash') === null,
    '前置：加入后应出现无 data-hash 的 pending 行');
  await timers[0](); // 任务轮询 tick → hash 认领
  await flush();
  t.taskRow = t.doc.querySelector('.huilian-task[data-hash="HASH1"]');
  assert.ok(t.taskRow, '前置：轮询后应出现带 data-hash 的任务行');
  fire(t.taskRow, 'click');
  await flush();
  assert.ok(t.doc.querySelector('.huilian-file[data-playable="1"]'), '前置：应出现可播文件行');
  assert.ok(t.doc.querySelector('.huilian-file[data-playable="0"]'), '前置：应出现不可播文件行');
  fire(t.doc.querySelector('.huilian-file[data-playable="1"]'), 'click');
  await flush();
  assert.ok(t.doc.querySelector('.huilian-bar'), '前置：播控条应已挂载');
  return t;
}

test('a) 渲染器全部视觉状态的 huilian class 在 player.css 均有规则', async () => {
  const css = cssRules();
  const classes = new Set();

  // 场景1：非桌面降级（无桥）→ .huilian-desk-only 等
  const d = loadPage({ bridge: null });
  d.page.mount(d.host);
  walk(d.host, classes);

  // 场景2：桌面完整链路 + end-file 播完面板
  const t = await driveToBar();
  emit(t, 'end-file');
  assert.ok(t.doc.querySelector('.huilian-done-panel'), '前置：end-file 应出现播完面板');
  walk(t.host, classes);

  // 场景3：mpv 进程退出 → 中断降级面板（独立实例，避免与播完面板互斥遮挡）
  const s = await driveToBar();
  emit(s, 'shutdown');
  assert.ok(s.doc.querySelector('.huilian-degraded-panel'), '前置：shutdown 应出现降级面板');
  walk(s.host, classes);

  // 期望清单：新页 DOM 的真实 class 全集（缺一即场景驱动退化，先报错）
  const EXPECTED = [
    'huilian-wrap', 'huilian-input-row', 'huilian-input', 'huilian-btn', 'huilian-browse',
    'huilian-error', 'huilian-play-wrap', 'huilian-stage', 'huilian-tasks', 'huilian-desk-only',
    'huilian-task', 'huilian-files', 'huilian-file', 'huilian-bar',
    'huilian-done-panel', 'huilian-degraded-panel',
  ];
  EXPECTED.forEach((c) => assert.ok(classes.has(c), '渲染树未采集到 class：' + c));

  const collected = Array.from(classes).filter((c) => c.indexOf('huilian-') === 0);
  collected.forEach((c) => assert.ok(css.indexOf('.' + c) >= 0,
    'player.css 缺少 .' + c + ' 规则（渲染器会产出一个无样式的节点）'));
});

test('b) 旧 v1/v2/v3 汇联选择器已全部清桩（无孤儿规则）', () => {
  const css = cssRules();
  const DEAD_OLD_SELECTORS = [
    'huilian-title', 'huilian-header', 'huilian-provider-badge', 'huilian-video',
    'huilian-progress-row', 'huilian-seekbar', 'huilian-heatmap', 'huilian-heatmap-wrap',
    'huilian-status', 'huilian-status-row', 'huilian-metas',
    'huilian-cards', 'huilian-card', 'huilian-card-title', 'huilian-card-body', 'huilian-card-meta',
    'huilian-tabbar', 'huilian-tab', 'huilian-config-area', 'huilian-config-row',
    'huilian-input-wrap', 'huilian-input-label', 'huilian-btn-play', 'huilian-btn-clear',
    'huilian-list-area', 'huilian-empty', 'huilian-grid', 'huilian-player-area',
  ];
  DEAD_OLD_SELECTORS.forEach((c) => assert.ok(css.indexOf('.' + c) < 0,
    '旧选择器 .' + c + ' 仍残留在 player.css（对应实现已归档 _archive/，规则应报废）'));
});

test('c) 属性谓词契约：CSS 依赖的 data-* 属性由渲染器真实写出', async () => {
  const t = await driveToBar();
  // .huilian-task[data-hash] / :not([data-hash])
  assert.strictEqual(t.pendingRow.getAttribute('data-hash'), null);
  assert.strictEqual(t.taskRow.getAttribute('data-hash'), 'HASH1');
  // .huilian-file[data-playable="1"]（可播阈值上屏）与 data-index
  const playable = t.doc.querySelector('.huilian-file[data-playable="1"]');
  assert.strictEqual(playable.getAttribute('data-index'), '0');
  // .huilian-stage[data-playing="1"]：overlay 创建成功后翻位（CSS 高亮描边依赖）
  assert.ok(t.doc.querySelector('.huilian-stage[data-playing="1"]'),
    '播放后 .huilian-stage 应带 data-playing="1"');
  // 控件条 id 面：CSS 以 #huilian-seek / #huilian-vol / #huilian-close-del 定位
  ['#huilian-toggle', '#huilian-seek', '#huilian-vol', '#huilian-close-del', '#huilian-keep']
    .forEach((sel) => assert.ok(t.doc.querySelector(sel), '播控条缺少 ' + sel));
});
