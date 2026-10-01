'use strict';
/**
 * 汇联 Task7 播控条契约测：createOverlay 参数形状、bounds 跟随与节流、播完清理顺序、
 * unmount 生命周期红线（销毁 overlay 但不删任务）、错误上浮、控件桥接、事件订阅注销。
 * 运行：node --test tests/huilian-player-bar.test.js
 * 假定时器/假时钟：mount 前替换 sandbox.setInterval/clearInterval 与 sandbox.Date，
 * 手动 tick 与推进时钟保证节流（100ms）与周期同步（500ms）断言确定性。
 */
const test = require('node:test');
const assert = require('node:assert');
const { loadPage, fire } = require('./helpers/huilian-harness');

const MAGNET = 'magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCD2345';
const RECT = { x: 20, y: 240, width: 640, height: 360 };
const FILES = [
  { name: 'a.mkv', progress: 0.9, size: 1048576, content_path: 'D:/dl/a.mkv' },
  { name: 'b.mkv', progress: 0.8, size: 2097152, content_path: 'D:/dl/b.mkv' },
  { name: 'c.mkv', progress: 0.01, size: 512, content_path: 'D:/dl/c.mkv' },
];

// vm 沙箱跨 realm：沙箱字面量原型 ≠ 宿主 Object.prototype → deepStrictEqual 前 JSON 归一
const norm = (v) => JSON.parse(JSON.stringify(v));
const flush = () => new Promise((r) => setImmediate(r));

/**
 * 记录型桥 setup：
 * opts.overlayError / overlayPending → createOverlay 失败 / 可控在途；
 * opts.setBoundsNoop → setBounds 返 {ok:true,data:false}（无 overlay）；opts.setBoundsError → {ok:false,error}；
 * opts.filesAsArray → download.files 返回裸数组（qbt 真实形状）；
 * opts.setPropertyError / seekError / stopAndCleanError → 对应控件/清理调用以 {ok:false,error} resolve
 *   （真实 ipc-video 对失败控件调用即以此形状 resolve，而非 reject）；
 * opts.pollTime / pollDuration → getProperty 轮询返回该数值（真机无 property-change 事件时的兜底来源）。
 */
function setup(options) {
  const opts = options || {};
  const calls = { createOverlay: [], setBounds: [], destroyOverlay: [], stopAndClean: [], setProperty: [], seek: [], command: [], getProperty: [], delete: [] };
  const order = [];
  const clock = { t: 10000 };
  let overlayResolve = null;

  const loaded = loadPage({
    bridge: {
      player: {
        createOverlay: (o) => {
          calls.createOverlay.push(o);
          order.push(['createOverlay']);
          if (opts.overlayError) return Promise.resolve({ ok: false, error: opts.overlayError });
          if (opts.overlayPending) return new Promise((res) => { overlayResolve = res; });
          return Promise.resolve({ ok: true, data: { playerId: 'mpv-' + calls.createOverlay.length } });
        },
        setBounds: (id, rect) => {
          calls.setBounds.push({ id: id, rect: rect });
          if (opts.setBoundsError) return Promise.resolve({ ok: false, error: opts.setBoundsError });
          return Promise.resolve({ ok: true, data: !opts.setBoundsNoop });
        },
        destroyOverlay: (id) => { calls.destroyOverlay.push(id); order.push(['destroyOverlay', id]); return Promise.resolve({ ok: true, data: true }); },
        stopAndClean: (id) => {
          calls.stopAndClean.push(id); order.push(['stopAndClean', id]);
          if (opts.stopAndCleanError) return Promise.resolve({ ok: false, error: opts.stopAndCleanError });
          return Promise.resolve({ ok: true, data: true });
        },
        setProperty: (id, name, value) => {
          calls.setProperty.push([id, name, value]);
          if (opts.setPropertyError) return Promise.resolve({ ok: false, error: opts.setPropertyError });
          return Promise.resolve({ ok: true, data: null });
        },
        seek: (id, sec) => {
          calls.seek.push([id, sec]);
          if (opts.seekError) return Promise.resolve({ ok: false, error: opts.seekError });
          return Promise.resolve({ ok: true, data: null });
        },
        command: (id, cmd) => { calls.command.push([id, cmd]); return Promise.resolve({ ok: true, data: null }); },
        getProperty: (id, name) => {
          calls.getProperty.push([id, name]);
          if (opts.getPropertyError) return Promise.resolve({ ok: false, error: opts.getPropertyError });
          if (name === 'duration' && opts.pollDuration != null) return Promise.resolve({ ok: true, data: opts.pollDuration });
          if (name === 'time-pos' && opts.pollTime != null) return Promise.resolve({ ok: true, data: opts.pollTime });
          return Promise.resolve({ ok: true, data: null });
        },
      },
      download: {
        addTorrent: () => Promise.resolve({ ok: true, data: { hash: '' } }),
        list: () => Promise.resolve({
          ok: true,
          // 真实桥形状：download.list → {ok:true,data:<qbt 裸数组>}
          data: [{ hash: 'HASH1', name: '某电影', state: 'downloading', progress: 0.5, dlspeed: 1, upspeed: 1, url: MAGNET }],
        }),
        files: () => Promise.resolve({ ok: true, data: opts.filesAsArray ? FILES : { files: FILES } }),
        delete: (hash, delFiles) => { calls.delete.push([hash, delFiles]); order.push(['delete', hash, delFiles]); return Promise.resolve({ ok: true, data: true }); },
      },
    },
  });

  loaded.sandbox.Date = { now: () => clock.t }; // 播控条节流用可控时钟
  const timers = [];
  const cleared = [];
  loaded.sandbox.setInterval = (fn, delay) => { timers.push({ fn: fn, delay: delay, id: timers.length + 1 }); return timers.length; };
  loaded.sandbox.clearInterval = (id) => cleared.push(id);

  loaded.page.mount(loaded.host);
  const t = Object.assign({}, loaded, {
    calls, order, clock, timers, cleared,
    resolveOverlay: (res) => { if (overlayResolve) overlayResolve(res); },
  });
  t.stage = t.doc.querySelector('.huilian-stage');
  assert.ok(t.stage, '前置：页面应渲染 .huilian-stage 视频容器（overlay 跟随目标）');
  setRect(t, RECT);
  return t;
}

function setRect(t, rect) { t.stage._rect = Object.assign({}, rect); }
function errorText(t) { return t.doc.querySelector('.huilian-error').textContent; }

/** 触发某周期的 setInterval 回调（2000=任务轮询，500=播控条兜底同步）。 */
async function tick(t, delay) {
  await Promise.all(t.timers.filter((x) => x.delay === delay).map((x) => x.fn()));
  await flush();
}

/** 派发 mpv 事件给全部存活订阅（未退订的旧订阅会被重复触发 → 双处理可测）。 */
function emit(t, event, payload) {
  t.events.filter((e) => e.event === event && !e.removed)
    .forEach((e) => e.cb(payload || { event: event, id: e.playerId }));
}

/** 加入磁力 → 轮询认领 → 展开文件 → 点第 i 个文件行（幂等：认领展开只做一次）。 */
async function playFile(t, index) {
  if (!t.claimed) {
    t.doc.querySelector('#huilian-input').value = MAGNET;
    fire(t.doc.querySelector('#huilian-add'), 'click');
    await flush();
    await tick(t, 2000);
    fire(t.doc.querySelector('.huilian-task[data-hash="HASH1"]'), 'click');
    await flush();
    t.claimed = true;
  }
  fire(t.doc.querySelector('.huilian-file[data-index="' + (index || 0) + '"]'), 'click');
  await flush();
}

// ---------------------------------------------------------------------------
// Brief Step1 五条
// ---------------------------------------------------------------------------

test('1) 点可播文件行 → createOverlay 收到 {url:content_path,title} + 容器 rect 四字段，并渲染控件条', async () => {
  const t = setup();
  await playFile(t);
  assert.strictEqual(t.calls.createOverlay.length, 1, '应且仅应发起一次 overlay 创建');
  assert.deepStrictEqual(norm(t.calls.createOverlay[0]),
    { url: 'D:/dl/a.mkv', title: 'a.mkv', x: 20, y: 240, width: 640, height: 360 });
  const bar = t.doc.querySelector('.huilian-bar');
  assert.ok(bar, 'overlay 成功后应渲染 .huilian-bar 控件条');
  ['#huilian-toggle', '#huilian-seek', '#huilian-vol', '#huilian-close-del', '#huilian-keep']
    .forEach((sel) => assert.ok(bar.querySelector(sel), '控件条缺少 ' + sel));
  assert.strictEqual(bar.parentNode, t.stage.parentNode, '控件条应与视频容器同层（原生 overlay 置顶，HTML 控件不可叠在其上）');
});

test('2) 矩形变化 → setBounds(playerId, rect) 跟随；未变化/100ms 内不重发，500ms 周期兜底', async () => {
  const t = setup();
  await playFile(t);
  assert.strictEqual(t.calls.setBounds.length, 1, 'overlay 创建后应立即强制同步一次矩形');
  assert.strictEqual(t.calls.setBounds[0].id, 'mpv-1');
  assert.deepStrictEqual(norm(t.calls.setBounds[0].rect), RECT);

  fire(t.sandbox, 'resize');
  assert.strictEqual(t.calls.setBounds.length, 1, '矩形未变化不得重发');

  setRect(t, { x: 20, y: 300, width: 640, height: 360 });
  fire(t.sandbox, 'resize');
  assert.strictEqual(t.calls.setBounds.length, 1, '距上次发送 <100ms（节流下限）应挂起变化');

  t.clock.t += 120;
  fire(t.sandbox, 'resize');
  assert.strictEqual(t.calls.setBounds.length, 2, '越过 100ms 下限后变化应发出');
  assert.deepStrictEqual(norm(t.calls.setBounds[1].rect), { x: 20, y: 300, width: 640, height: 360 });

  setRect(t, { x: 0, y: 100, width: 1280, height: 720 });
  t.clock.t += 120;
  await tick(t, 500);
  assert.strictEqual(t.calls.setBounds.length, 3, '500ms 周期同步应兜底发出挂起的变化');
  assert.deepStrictEqual(norm(t.calls.setBounds[2].rect), { x: 0, y: 100, width: 1280, height: 720 });
});

test('3) end-file → 播完面板；删任务+删文件 = stopAndClean→download.delete(hash,true) 各一次有序', async () => {
  const t = setup();
  await playFile(t);
  emit(t, 'end-file');
  const panel = t.doc.querySelector('.huilian-done-panel');
  assert.ok(panel, 'end-file 应出现 .huilian-done-panel 播完面板');
  fire(panel.querySelector('#huilian-done-del'), 'click');
  await flush();
  assert.deepStrictEqual(t.order.filter((x) => x[0] === 'stopAndClean' || x[0] === 'delete'),
    [['stopAndClean', 'mpv-1'], ['delete', 'HASH1', true]], '先 stopAndClean 再 delete(hash,true)');
  assert.deepStrictEqual(t.calls.destroyOverlay, ['mpv-1'], '删完应销毁 overlay');
  fire(panel.querySelector('#huilian-done-del'), 'click');
  await flush();
  assert.strictEqual(t.calls.stopAndClean.length, 1, '重复点击不得二次 stopAndClean');
  assert.strictEqual(t.calls.delete.length, 1, '重复点击不得二次 delete');
  assert.strictEqual(t.doc.querySelector('.huilian-bar'), null, '删除后播控条应移除');
});

test('4) 红线：unmount → destroyOverlay 恰好一次、清播控定时器、绝不 download.delete', async () => {
  const t = setup();
  await playFile(t);
  const barTimers = t.timers.filter((x) => x.delay === 500).map((x) => x.id);
  assert.strictEqual(barTimers.length, 1, '前置：播控条应注册 500ms 兜底同步定时器');

  t.page.unmount();
  assert.deepStrictEqual(t.calls.destroyOverlay, ['mpv-1'], '红线：unmount 必须销毁当前 overlay');
  assert.strictEqual(t.calls.delete.length, 0, '红线：离开页面只杀画面，不得删任务');
  assert.ok(t.cleared.indexOf(barTimers[0]) >= 0, 'unmount 应 clearInterval 播控条 500ms 兜底同步定时器');
  assert.strictEqual(t.doc.querySelector('.huilian-bar'), null, 'unmount 后播控条应移除');

  t.page.unmount();
  assert.strictEqual(t.calls.destroyOverlay.length, 1, '重复 unmount 不得重复销毁（幂等）');
});

test('4b) 红线：back() 与 router 注册的 unmount 同链，同样只销毁 overlay 不删任务', async () => {
  const t = setup();
  await playFile(t);
  assert.strictEqual(t.registrations[0].unmount, t.page.unmount, 'router 注册应携带同一 unmount（切 tab 走同一条链）');
  t.page.back();
  assert.deepStrictEqual(t.calls.destroyOverlay, ['mpv-1']);
  assert.strictEqual(t.calls.delete.length, 0);
});

test('4c) 红线：createOverlay 在途时 unmount+重挂 → 过期落地仍销毁 overlay，且不画进新页', async () => {
  const t = setup({ overlayPending: true });
  await playFile(t);
  t.page.unmount();
  t.page.mount(t.host); // 挂载代次递增：在途响应作废
  t.resolveOverlay({ ok: true, data: { playerId: 'mpv-late' } });
  await flush();
  assert.deepStrictEqual(t.calls.destroyOverlay, ['mpv-late'], '过期 overlay 落地后必须立即销毁，防遗留 mpv 进程');
  assert.strictEqual(t.host.querySelectorAll('.huilian-bar').length, 0, '过期 overlay 不得在新页渲染控件条');
  assert.strictEqual(t.calls.setBounds.length, 0, '过期 overlay 不得启动 bounds 同步');
  assert.strictEqual(t.calls.delete.length, 0);
});

test('5) createOverlay {ok:false,error} → .huilian-error 显示 error 且控件条不出现', async () => {
  const t = setup({ overlayError: 'mpv.exe 不存在，请检查 _up_/mpv/mpv.exe' });
  await playFile(t);
  assert.ok(errorText(t).indexOf('mpv.exe 不存在') >= 0, '桥 error 应原样上浮，实际：' + errorText(t));
  assert.strictEqual(t.doc.querySelector('.huilian-bar'), null, '失败不得渲染控件条');
  assert.strictEqual(t.calls.destroyOverlay.length, 0, '无 playerId 时不应调用 destroyOverlay');
  assert.strictEqual(t.calls.setBounds.length, 0);
});

// ---------------------------------------------------------------------------
// 控件桥接 / 订阅生命周期 / 降级
// ---------------------------------------------------------------------------

test('6) destroy 注销全部 onEvent 订阅；切换文件先销毁旧 overlay 且不双处理事件', async () => {
  const t = setup();
  await playFile(t, 0);
  const firstSubs = t.events.filter((e) => !e.removed);
  assert.ok(firstSubs.length >= 3, '播控条应订阅 time-pos/duration/end-file 等事件，实际 ' + firstSubs.length);
  await playFile(t, 1); // 换文件：任一时刻至多一个 overlay
  assert.ok(firstSubs.every((e) => e.removed), '旧播控条的订阅应全部退订（防重挂双处理）');
  assert.deepStrictEqual(t.calls.destroyOverlay, ['mpv-1'], '切换文件应先销毁旧 overlay');
  assert.strictEqual(t.calls.createOverlay.length, 2);
  assert.strictEqual(t.doc.querySelectorAll('.huilian-bar').length, 1, '同一时刻只应有一条控件条');
  emit(t, 'end-file');
  assert.strictEqual(t.doc.querySelectorAll('.huilian-done-panel').length, 1, '事件只被当前播控条处理一次');
  t.page.unmount();
  assert.deepStrictEqual(t.calls.destroyOverlay, ['mpv-1', 'mpv-2'], 'unmount 应销毁当前 overlay');
  assert.strictEqual(t.calls.delete.length, 0);
});

test('7) 控件桥接：toggle→setProperty(pause) 反转、音量→setProperty(volume)、seek→seek(id,sec)', async () => {
  const t = setup();
  await playFile(t);
  const bar = t.doc.querySelector('.huilian-bar');
  fire(bar.querySelector('#huilian-toggle'), 'click');
  fire(bar.querySelector('#huilian-toggle'), 'click');
  assert.deepStrictEqual(t.calls.setProperty.filter((x) => x[1] === 'pause'),
    [['mpv-1', 'pause', true], ['mpv-1', 'pause', false]], '暂停/继续应走 player.setProperty(id,"pause",bool)');
  const vol = bar.querySelector('#huilian-vol');
  vol.value = '35';
  fire(vol, 'change');
  assert.deepStrictEqual(t.calls.setProperty.filter((x) => x[1] === 'volume'), [['mpv-1', 'volume', 35]]);
  const seekEl = bar.querySelector('#huilian-seek');
  seekEl.value = '125.5';
  fire(seekEl, 'change');
  assert.deepStrictEqual(t.calls.seek, [['mpv-1', 125.5]]);
  emit(t, 'duration', { data: 600 });
  emit(t, 'time-pos', { data: 125.5 });
  assert.strictEqual(Number(seekEl.max), 600, 'duration 事件应更新进度条上限');
  assert.strictEqual(Number(seekEl.value), 125.5, 'time-pos 事件应回写当前进度');
});

test('8) setBounds：{ok:true,data:false} 静默；{ok:false,error} 上浮提示条', async () => {
  const a = setup({ setBoundsNoop: true });
  await playFile(a);
  assert.strictEqual(a.calls.setBounds.length, 1);
  assert.strictEqual(errorText(a), '', 'data:false = 无 overlay（拆除竞态）属正常，不应报错');

  const b = setup({ setBoundsError: 'rect 必须为有限数：x/y/width/height' });
  await playFile(b);
  await flush();
  assert.ok(errorText(b).indexOf('rect 必须为有限数') >= 0, 'IPC 失败必须上浮 .huilian-error');
});

test('9) #huilian-keep（仅关闭）→ destroyOverlay 且保留任务', async () => {
  const t = setup();
  await playFile(t);
  fire(t.doc.querySelector('#huilian-keep'), 'click');
  await flush();
  assert.deepStrictEqual(t.calls.destroyOverlay, ['mpv-1']);
  assert.strictEqual(t.calls.delete.length, 0, '仅关闭不得删任务');
  assert.strictEqual(t.calls.stopAndClean.length, 0);
  assert.strictEqual(t.doc.querySelector('.huilian-bar'), null);
});

test('10) shutdown（mpv 意外退出）→ 降级面板「重试/换文件」，不清任务；重试重建 overlay', async () => {
  const t = setup();
  await playFile(t);
  emit(t, 'shutdown', { event: 'shutdown', id: 'mpv-1', code: 1 });
  const panel = t.doc.querySelector('.huilian-degraded-panel');
  assert.ok(panel, '进程意外退出应出现降级面板');
  // 注：假 DOM 的 textContent 不聚合子节点（已知分歧），故分别断言面板说明与按钮节点
  assert.ok(panel.textContent.indexOf('播放已中断') >= 0, '面板应有中文说明，实际：' + panel.textContent);
  const retry = panel.querySelector('#huilian-retry');
  const swap = panel.querySelector('#huilian-switch');
  assert.ok(retry && swap, '面板应给出「重试/换文件」按钮');
  assert.strictEqual(retry.textContent, '重试');
  assert.strictEqual(swap.textContent, '换文件');
  assert.strictEqual(t.calls.delete.length, 0, 'spec §6：进程异常退出不清理下载任务');
  fire(panel.querySelector('#huilian-retry'), 'click');
  await flush();
  assert.strictEqual(t.calls.createOverlay.length, 2, '重试应对同一文件重新创建 overlay');
  assert.strictEqual(t.calls.createOverlay[1].url, 'D:/dl/a.mkv');
});

test('11) qbt files 返回裸数组（真实桥形状）→ 文件子行同样渲染且点击可播', async () => {
  const t = setup({ filesAsArray: true });
  await playFile(t);
  assert.strictEqual(t.doc.querySelectorAll('.huilian-file').length, 3, '裸数组 payload 应被识别');
  assert.strictEqual(t.calls.createOverlay.length, 1);
});

test('12) 点不可播文件行（data-playable=0）→ 不发起 createOverlay、无控件条', async () => {
  const t = setup();
  await playFile(t, 2);
  assert.strictEqual(t.calls.createOverlay.length, 0);
  assert.strictEqual(t.doc.querySelector('.huilian-bar'), null);
});

// ---------------------------------------------------------------------------
// 复审修正（Fix round 1）：控件错误上浮 / stopAndClean 失败不删文件 / getProperty 轮询兜底
// ---------------------------------------------------------------------------

test('13) 控件调用以 {ok:false,error} resolve → 错误统一上浮 .huilian-error（不再静默）', async () => {
  const p = setup({ setPropertyError: 'mpv 拒绝设置 pause' });
  await playFile(p);
  fire(p.doc.querySelector('.huilian-bar').querySelector('#huilian-toggle'), 'click');
  await flush();
  assert.ok(errorText(p).indexOf('mpv 拒绝设置 pause') >= 0,
    'pause 失败的真实 error 必须上浮，实际：' + errorText(p));

  const s = setup({ seekError: '跳转超出可播范围' });
  await playFile(s);
  const seekEl = s.doc.querySelector('#huilian-seek');
  seekEl.value = '9999';
  fire(seekEl, 'change');
  await flush();
  assert.ok(errorText(s).indexOf('跳转超出可播范围') >= 0,
    'seek 失败的真实 error 必须上浮，实际：' + errorText(s));

  const v = setup({ setPropertyError: '音量设置被拒' });
  await playFile(v);
  const vol = v.doc.querySelector('#huilian-vol');
  vol.value = '20';
  fire(vol, 'change');
  await flush();
  assert.ok(errorText(v).indexOf('音量设置被拒') >= 0,
    'volume 失败的真实 error 必须上浮，实际：' + errorText(v));
});

test('14) stopAndClean 以 {ok:false,error} 失败 → 上报且绝不发起破坏性 download.delete', async () => {
  const t = setup({ stopAndCleanError: 'mpv stop 超时' });
  await playFile(t);
  emit(t, 'end-file');
  fire(t.doc.querySelector('.huilian-done-panel').querySelector('#huilian-done-del'), 'click');
  await flush();
  assert.strictEqual(t.calls.stopAndClean.length, 1, 'stopAndClean 应尝试一次');
  assert.strictEqual(t.calls.delete.length, 0, '红线安全序：停止失败不得删磁盘文件');
  assert.ok(errorText(t).indexOf('mpv stop 超时') >= 0,
    '停止失败的真实 error 必须上浮，实际：' + errorText(t));
});

test('15) 真机无 property-change 事件 → getProperty 轮询兜底推进进度条（time-pos/duration）', async () => {
  const t = setup({ pollTime: 42.5, pollDuration: 600 });
  await playFile(t);
  const seekEl = t.doc.querySelector('.huilian-bar').querySelector('#huilian-seek');
  assert.strictEqual(Number(seekEl.value), 0, '前置：轮询前进度为 0');
  await tick(t, 500); // 500ms 兜底同步同一 tick 内驱动 progress 轮询
  assert.ok(t.calls.getProperty.some((c) => c[1] === 'time-pos'), '应向桥轮询 time-pos');
  assert.ok(t.calls.getProperty.some((c) => c[1] === 'duration'), '应向桥轮询 duration');
  assert.strictEqual(Number(seekEl.max), 600, 'duration 轮询应回写进度条上限');
  assert.strictEqual(Number(seekEl.value), 42.5, 'time-pos 轮询应回写当前进度');
});

test('16) 事件值优先：事件到达后的保持窗内轮询不得回拉扯进度条（两源不打架）', async () => {
  const t = setup({ pollTime: 300, pollDuration: 999 });
  await playFile(t);
  const seekEl = t.doc.querySelector('.huilian-bar').querySelector('#huilian-seek');
  emit(t, 'time-pos', { data: 100 });  // 事件把进度设为 100（记录事件时刻 = clock.t）
  emit(t, 'duration', { data: 600 });
  assert.strictEqual(Number(seekEl.value), 100);
  assert.strictEqual(Number(seekEl.max), 600);
  await tick(t, 500); // 同一时刻轮询会返回 300/999：应让位事件值，不回覆写
  assert.strictEqual(Number(seekEl.value), 100, '事件保持窗内轮询不得覆盖事件进度');
  assert.strictEqual(Number(seekEl.max), 600, '事件已给 duration：轮询不得再改写上限');
});

// ---------------------------------------------------------------------------
// 终审修正：I3 stale onClose 身份守卫 / I2 进程退出后仍可删任务
// ---------------------------------------------------------------------------

test('17) I3：旧条 onClose 不孤儿化当前条 —— unmount 仍销毁当前 overlay', async () => {
  const t = setup();
  await playFile(t, 0);                       // 条 A（mpv-1）
  const barA = t.doc.querySelector('.huilian-bar');
  const keepA = barA.querySelector('#huilian-keep');
  await playFile(t, 1);                       // 换文件：先销毁 A，当前条 = B（mpv-2）
  assert.deepStrictEqual(t.calls.destroyOverlay, ['mpv-1'], '前置：切换应先销毁 A 的 overlay');
  // 触发旧条 A 的 onClose（点 A 的「仅关闭」→ keepOnly：A 已销毁 destroy 幂等 no-op + onClose）
  fire(keepA, 'click');
  await flush();
  assert.strictEqual(t.calls.destroyOverlay.length, 1, '旧条 onClose 不得改动当前条 B 的 overlay');
  t.page.unmount();
  assert.deepStrictEqual(t.calls.destroyOverlay, ['mpv-1', 'mpv-2'],
    '红线：旧条 onClose 不得让页面遗忘当前条 B；unmount 必须仍能销毁 B 的 overlay');
});

test('18) I2：stopAndClean 以 player-not-found 失败（mpv 进程已退出）→ 视为已停止，仍可删任务+删文件', async () => {
  const t = setup({ stopAndCleanError: 'player not found: mpv-1' });
  await playFile(t);
  emit(t, 'end-file');
  fire(t.doc.querySelector('.huilian-done-panel').querySelector('#huilian-done-del'), 'click');
  await flush();
  assert.strictEqual(t.calls.stopAndClean.length, 1, 'stopAndClean 应尝试一次');
  assert.deepStrictEqual(t.calls.delete, [['HASH1', true]],
    '进程已退出（player not found）应继续删除任务+文件，而非中止（spec §6 播完删任务面板）');
  assert.ok(t.calls.destroyOverlay.indexOf('mpv-1') >= 0, '删除收尾仍应销毁 overlay');
});

test('19) I2 边界：区分「进程已消失」与「真实停止失败」——后者仍中止删除（不削弱 Task7 红线）', async () => {
  const t = setup({ stopAndCleanError: 'mpv stop 超时' });
  await playFile(t);
  emit(t, 'end-file');
  fire(t.doc.querySelector('.huilian-done-panel').querySelector('#huilian-done-del'), 'click');
  await flush();
  assert.strictEqual(t.calls.delete.length, 0, '真实停止失败（非 player not found）不得删磁盘文件（红线安全序保持不动）');
});

// ---------------------------------------------------------------------------
// 终审修正：I4 页面隐藏（未走 unmount 的 hide 路径）拆除 overlay
// ---------------------------------------------------------------------------

test('20) I4：页面隐藏（document hidden + visibilitychange）→ 立即销毁 overlay、保留任务', async () => {
  const t = setup();
  await playFile(t);
  assert.deepStrictEqual(t.calls.destroyOverlay, [], '前置：播放中尚未销毁');
  t.doc.hidden = true;
  fire(t.doc, 'visibilitychange');
  await flush();
  assert.deepStrictEqual(t.calls.destroyOverlay, ['mpv-1'],
    '红线：页面隐藏必须立即销毁 overlay（spec §4「页面隐藏 → destroyOverlay」，overlay 未 parent 会浮在隐藏主窗之上）');
  assert.strictEqual(t.calls.delete.length, 0, '隐藏只杀画面，不得删任务');
});

test('21) I4：可见态 visibilitychange 不误销毁', async () => {
  const t = setup();
  await playFile(t);
  t.doc.hidden = false;
  fire(t.doc, 'visibilitychange');
  await flush();
  assert.strictEqual(t.calls.destroyOverlay.length, 0, '仅 hidden=true 才拆除');
});

test('22) I4：有桥 mount 注册、unmount 注销 visibilitychange 监听（防跨路由泄漏）', async () => {
  const t = setup();
  await playFile(t);
  const before = (t.doc.listeners.visibilitychange || []).length;
  assert.ok(before >= 1, '前置：有桥 mount 应注册 visibilitychange 监听');
  t.page.unmount();
  assert.strictEqual((t.doc.listeners.visibilitychange || []).length, 0, 'unmount 应注销监听');
});

// ---------------------------------------------------------------------------
// 终审修正波 2：I6 播完面板不依赖 mpv 事件（desktop/mpv-controller 无 observe/property-change 订阅，
// end-file 在真机不可达）——同一 500ms tick 的轮询值 time-pos ≥ duration 即确定性判定播完。
// ---------------------------------------------------------------------------

test('23) I6：全程不派发任何 onEvent，仅凭轮询值（time-pos=duration）→ 播完面板出现', async () => {
  const t = setup({ pollTime: 600, pollDuration: 600 });
  await playFile(t);
  assert.strictEqual(t.doc.querySelector('.huilian-done-panel'), null, '前置：尚未 tick 不应出现播完面板');
  await tick(t, 500); // 兜底 tick：getProperty 轮询 time-pos/duration 各 600
  const panel = t.doc.querySelector('.huilian-done-panel');
  assert.ok(panel, '修复后：轮询推得 time-pos≥duration 必须弹出 .huilian-done-panel（真机无 end-file 事件）');
  assert.ok(t.calls.getProperty.some((c) => c[1] === 'time-pos') &&
    t.calls.getProperty.some((c) => c[1] === 'duration'), '前置：判定来源应为轮询值');
  assert.ok(panel.querySelector('#huilian-done-del') && panel.querySelector('#huilian-done-keep'),
    '面板应含「删任务+删文件/保留任务」，删除安全序仍由 deleteTaskAndFiles 承担');
  // 播完删任务红线不变：点删 → stopAndClean→delete(hash,true)
  fire(panel.querySelector('#huilian-done-del'), 'click');
  await flush();
  assert.deepStrictEqual(t.order.filter((x) => x[0] === 'stopAndClean' || x[0] === 'delete'),
    [['stopAndClean', 'mpv-1'], ['delete', 'HASH1', true]], 'I6 弹出面板与既有删任务链路等价');
});

test('24) I6：面板弹出后继续 tick 不重复弹出（每次播放恰好一次）；未播完值不误弹', async () => {
  const mid = setup({ pollTime: 300, pollDuration: 600 });
  await playFile(mid);
  await tick(mid, 500);
  await tick(mid, 500);
  assert.strictEqual(mid.doc.querySelector('.huilian-done-panel'), null, 'time-pos(300)<duration(600) 不得误判播完');

  const t = setup({ pollTime: 600, pollDuration: 600 });
  await playFile(t);
  await tick(t, 500);
  assert.ok(t.doc.querySelector('.huilian-done-panel'), '前置：首轮 tick 应判定播完');
  await tick(t, 500);
  await tick(t, 500);
  assert.strictEqual(t.doc.querySelectorAll('.huilian-done-panel').length, 1,
    '面板展示期间后续 tick 不得重复弹出/重建');
});
