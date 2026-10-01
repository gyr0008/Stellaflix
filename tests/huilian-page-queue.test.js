'use strict';
/**
 * 汇联页任务接线测：加入任务、hash 认领、2s 轮询列表与文件选择。
 * 运行：node --test tests/huilian-page-queue.test.js
 * 假定时器：mount 前替换 sandbox.setInterval/clearInterval 捕获轮询回调，手动 tick 保证确定性。
 */
const test = require('node:test');
const assert = require('node:assert');
const { loadPage, fire } = require('./helpers/huilian-harness');

const MAGNET = 'magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCD2345';

/** 冲刷所有 microtask（桥返回 Promise，链式 then 需至少两轮）。 */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * 装载有桥的汇联页：download.* 全部记录调用；state.torrents 可在测试中途改写，
 * 模拟轮询 list() 返回值变化（空 → 认领命中）。
 * opts.listImpl：自定义 list 返回（可控 Promise，测轮询防重入/过期响应）；
 * opts.filesReject：files 返回 rejected Promise（测错误上浮）。
 * 注：opts.files 一律以「真实桥形状」传入 —— ipc-video 把 qbt 的 /torrents/files 裸数组
 *   包成 {ok:true,data:<array>}，故 stub 直接透传裸数组（历史 fixture 曾误用 {files:[]} 包装，
 *   掩盖了源码读 res.data.files 的真机 bug，见 pickFiles）。
 * setInterval 桩捕获回调（ticks）与周期（delays，Minor#4 断言 2000ms）。
 */
function setup(options) {
  const opts = options || {};
  const state = { torrents: [] };
  const calls = { addTorrent: [], list: [], files: [] };
  const loaded = loadPage({
    bridge: {
      download: {
        addTorrent: (params) => {
          calls.addTorrent.push(params);
          return Promise.resolve({ ok: true, data: { hash: '' } });
        },
        list: () => {
          calls.list.push(1);
          if (opts.listImpl) return opts.listImpl(state);
          // 真实桥形状：download.list → {ok:true,data:<qbt 裸数组>}（见 download-manager.listTorrents JSON.parse）
          return Promise.resolve({ ok: true, data: state.torrents });
        },
        files: (hash) => {
          calls.files.push(hash);
          if (opts.filesReject) return Promise.reject(new Error('ipc 断开'));
          // 真实桥：download.files(hash) → {ok:true,data:<qbt 裸数组>}
          return Promise.resolve({ ok: true, data: opts.files || [] });
        },
      },
    },
  });
  const ticks = [];
  const delays = [];
  const cleared = [];
  loaded.sandbox.setInterval = (fn, delay) => { ticks.push(fn); delays.push(delay); return 7; };
  loaded.sandbox.clearInterval = (id) => { cleared.push(id); };
  loaded.page.mount(loaded.host);
  return Object.assign({}, loaded, { state, calls, ticks, delays, cleared });
}

/** 加入磁力并轮询到 hash 认领完成，返回认领后的任务行。 */
async function claimRow(t, torrent) {
  t.doc.querySelector('#huilian-input').value = MAGNET;
  fire(t.doc.querySelector('#huilian-add'), 'click');
  await flush();
  t.state.torrents = [torrent];
  await t.ticks[0]();
  await flush();
  return t.doc.querySelector('.huilian-task[data-hash="' + torrent.hash + '"]');
}

test('add 非法输入 → 提示条且不调 download.addTorrent', async () => {
  const t = setup();
  // 输入框留空 → makeAddParams 判非法
  fire(t.doc.querySelector('#huilian-add'), 'click');
  await flush();
  const err = t.doc.querySelector('.huilian-error');
  assert.ok(err, '缺少 .huilian-error 提示条节点');
  assert.ok(
    err.textContent.indexOf('无效') >= 0 || err.textContent.indexOf('magnet') >= 0,
    '提示文案应说明输入非法，实际：' + err.textContent
  );
  assert.strictEqual(t.calls.addTorrent.length, 0, '非法输入不得调用 addTorrent');
});

test('add 磁力 → addTorrent({url}) 后进入 解析中 行', async () => {
  const t = setup();
  t.doc.querySelector('#huilian-input').value = MAGNET;
  fire(t.doc.querySelector('#huilian-add'), 'click');
  await flush();
  assert.deepStrictEqual(t.calls.addTorrent, [{ url: MAGNET }], 'addTorrent 应收到 makeAddParams 的 {url}');
  assert.strictEqual(t.ticks.length, 1, '加入后应启动 2s 轮询 setInterval');
  // list 返回空 → 认领前 pending 行状态 'stalled-meta'（解析中）
  await t.ticks[0]();
  await flush();
  const rows = t.host.querySelectorAll('.huilian-task');
  assert.strictEqual(rows.length, 1, '应渲染一条等待认领的任务行');
  assert.ok(rows[0].textContent.indexOf('解析中') >= 0, '认领前任务行应显示 解析中');
  assert.strictEqual(t.doc.querySelector('[data-hash]'), null, 'list 未命中前不得认领 hash');
});

test('list 轮询认领 hash → 渲染 .huilian-task[data-hash]，含 50% 与速度', async () => {
  const t = setup();
  const row = await claimRow(t, {
    hash: 'HASH1', name: '某电影', state: 'downloading',
    progress: 0.5, dlspeed: 2048, upspeed: 512, url: MAGNET,
  });
  assert.ok(row, '认领后应渲染 .huilian-task[data-hash="HASH1"]');
  assert.strictEqual(t.host.querySelectorAll('.huilian-task').length, 1, '认领后 pending 占位行应消失');
  assert.ok(row.textContent.indexOf('50%') >= 0, '任务行应显示整数百分比 50%，实际：' + row.textContent);
  assert.ok(row.textContent.indexOf('2048') >= 0, '任务行应显示下行速度');
  assert.ok(row.textContent.indexOf('512') >= 0, '任务行应显示上行速度');
  // 生命周期红线：unmount 必清轮询 interval
  t.page.unmount();
  assert.deepStrictEqual(t.cleared, [7], 'unmount 应 clearInterval 轮询定时器');
});

test('files(hash) 返回 2 文件 → 渲染两行，progress 0.9 行 data-playable=1、0.01 行 =0', async () => {
  const t = setup({
    files: [
      { name: 'a.mkv', progress: 0.9, size: 1048576 },
      { name: 'b.mkv', progress: 0.01, size: 2048 },
    ],
  });
  const row = await claimRow(t, {
    hash: 'HASH1', name: '某电影', state: 'downloading',
    progress: 0.5, dlspeed: 2048, upspeed: 512, url: MAGNET,
  });
  assert.ok(row, '前置：任务行应已认领');
  fire(row, 'click');
  await flush();
  assert.deepStrictEqual(t.calls.files, ['HASH1'], '展开任务行应调用 download.files(hash)');
  const fileRows = row.querySelectorAll('.huilian-file');
  assert.strictEqual(fileRows.length, 2, '应渲染两个文件子行');
  assert.strictEqual(fileRows[0].getAttribute('data-index'), '0');
  assert.strictEqual(fileRows[0].getAttribute('data-playable'), '1', 'progress 0.9 且 size>0 应可播');
  assert.strictEqual(fileRows[1].getAttribute('data-index'), '1');
  assert.strictEqual(fileRows[1].getAttribute('data-playable'), '0', 'progress 0.01 低于 5% 阈值应不可播');
});

// ---- 复审修正测（Fix round 1） ----

test('add 磁力 → setInterval 周期断言为 2000ms（Minor#4）', async () => {
  const t = setup();
  t.doc.querySelector('#huilian-input').value = MAGNET;
  fire(t.doc.querySelector('#huilian-add'), 'click');
  await flush();
  assert.strictEqual(t.ticks.length, 1, '加入后应启动轮询定时器');
  assert.strictEqual(t.delays[0], 2000, '轮询周期应为 2000ms');
});

test('轮询防重入：在途 list 未落地时再次 tick 不发起新请求，落地后恢复（Important#1）', async () => {
  let release;
  const t = setup({ listImpl: () => new Promise((res) => { release = res; }) });
  t.doc.querySelector('#huilian-input').value = MAGNET;
  fire(t.doc.querySelector('#huilian-add'), 'click');
  await flush();
  t.ticks[0](); // 首轮请求在途（不可 await：桥 Promise 未落地前 tick 链永不 resolve）
  await flush();
  assert.strictEqual(t.calls.list.length, 1);
  t.ticks[0](); // 定时器再次触发：修复后在途应直接跳过，不并发第二次 list
  t.ticks[0]();
  await flush();
  assert.strictEqual(t.calls.list.length, 1, '在途请求未落地时不得重复发起 list');
  release({ ok: true, data: [] });
  await flush();
  t.ticks[0](); // 落地后下一轮恢复正常（新请求同样在途，不 await）
  await flush();
  assert.strictEqual(t.calls.list.length, 2, '在途请求落地后应恢复轮询');
});

test('轮询过期响应：unmount 后快速重挂，在途响应不得渲染进新页（Important#1）', async () => {
  let release;
  const t = setup({ listImpl: () => new Promise((res) => { release = res; }) });
  t.doc.querySelector('#huilian-input').value = MAGNET;
  fire(t.doc.querySelector('#huilian-add'), 'click');
  await flush();
  t.ticks[0](); // 旧挂载的轮询请求在途
  await flush();
  t.page.unmount();
  t.page.mount(t.host); // 快速重挂：挂载代次递增
  assert.strictEqual(t.host.querySelectorAll('.huilian-task').length, 0, '前置：新页应无任务行');
  release({
    ok: true,
    data: [{ hash: 'HASH1', name: '某电影', state: 'downloading', progress: 0.5 }],
  });
  await flush();
  assert.strictEqual(
    t.host.querySelectorAll('.huilian-task').length, 0,
    '过期代次的响应应被丢弃，不得写回新页面'
  );
});

test('files(hash) reject → 错误上浮到 .huilian-error 提示条（Important#2）', async () => {
  const t = setup({ filesReject: true });
  const row = await claimRow(t, {
    hash: 'HASH1', name: '某电影', state: 'downloading',
    progress: 0.5, dlspeed: 2048, upspeed: 512, url: MAGNET,
  });
  assert.ok(row, '前置：任务行应已认领');
  fire(row, 'click');
  await flush();
  assert.deepStrictEqual(t.calls.files, ['HASH1'], '前置：应已请求 files');
  const err = t.doc.querySelector('.huilian-error');
  assert.ok(err, '缺少 .huilian-error 提示条节点');
  assert.ok(
    err.textContent.indexOf('文件列表') >= 0,
    'files 失败应上浮文件列表错误文案，实际：' + err.textContent
  );
});

test('展开文件行跨 2s 轮询重绘保持，复用缓存不重复请求（Important#3）', async () => {
  const t = setup({
    files: [
      { name: 'a.mkv', progress: 0.9, size: 1048576 },
      { name: 'b.mkv', progress: 0.01, size: 2048 },
    ],
  });
  const torrent = {
    hash: 'HASH1', name: '某电影', state: 'downloading',
    progress: 0.5, dlspeed: 2048, upspeed: 512, url: MAGNET,
  };
  const row = await claimRow(t, torrent);
  assert.ok(row, '前置：任务行应已认领');
  fire(row, 'click');
  await flush();
  assert.strictEqual(row.querySelectorAll('.huilian-file').length, 2, '前置：首轮应展开两个文件子行');
  // 再跑一轮轮询（同 hash 进度变化）→ 任务行整体重绘
  t.state.torrents = [Object.assign({}, torrent, { progress: 0.6 })];
  await t.ticks[0]();
  await flush();
  const row2 = t.doc.querySelector('.huilian-task[data-hash="HASH1"]');
  assert.notStrictEqual(row2, row, '前置：轮询应已重绘出新任务行节点');
  const fileRows = row2.querySelectorAll('.huilian-file');
  assert.strictEqual(fileRows.length, 2, '轮询重绘后展开的文件子行应保持');
  assert.strictEqual(fileRows[0].getAttribute('data-playable'), '1', '保持后仍可播标记不丢');
  assert.strictEqual(t.calls.files.length, 1, '重绘应复用缓存文件数据，不得重新请求 files');
});

// ---- 复审修正（Fix round 1）：不可播行点击不折叠 / pickFiles 兼容双形状 ----

test('点不可播文件行 → 拦截冒泡不折叠展开列表，且不发起来播放（Minor#3）', async () => {
  const t = setup({
    files: [
      { name: 'a.mkv', progress: 0.9, size: 1048576 },
      { name: 'c.mkv', progress: 0.01, size: 2048 },
    ],
  });
  const row = await claimRow(t, {
    hash: 'HASH1', name: '某电影', state: 'downloading',
    progress: 0.5, dlspeed: 2048, upspeed: 512, url: MAGNET,
  });
  fire(row, 'click');
  await flush();
  const fileRows = row.querySelectorAll('.huilian-file');
  assert.strictEqual(fileRows.length, 2, '前置：展开两个文件子行');
  const deadRow = fileRows[1];
  assert.strictEqual(deadRow.getAttribute('data-playable'), '0', '前置：低进度行不可播');
  // 真机：不可播行若无监听，点击冒泡到任务行触发 toggleFiles → 折叠展开列表；
  // 修复后须挂一个「仅拦截冒泡」的处理，令点击不再穿透（此处以 stopPropagation 被调用为可观测证据）。
  let stopped = false;
  fire(deadRow, 'click', { stopPropagation: () => { stopped = true; } });
  await flush();
  assert.ok(stopped, '点不可播行必须 stopPropagation，避免穿透到任务行折叠文件列表');
});

test('files(hash) 兼容旧 {files:[...]} 包装形状 → pickFiles 仍渲染（Minor#4 双形状）', async () => {
  const t = setup({
    files: { files: [{ name: 'a.mkv', progress: 0.9, size: 1048576 }] },
  });
  const row = await claimRow(t, {
    hash: 'HASH1', name: '某电影', state: 'downloading',
    progress: 0.5, dlspeed: 2048, upspeed: 512, url: MAGNET,
  });
  fire(row, 'click');
  await flush();
  assert.deepStrictEqual(t.calls.files, ['HASH1'], '展开应请求一次 files');
  assert.strictEqual(row.querySelectorAll('.huilian-file').length, 1,
    '旧 {files:[...]} 包装形状也应被 pickFiles 兼容识别（真实桥为裸数组，两形状都须支持）');
});

// ---- C1：download.list 真实裸数组形状归一 ----

test('list 裸数组 payload（真实桥形状）→ 归一后渲染任务行（C1）', async () => {
  const t = setup();
  t.state.torrents = [{
    hash: 'HASH1', name: '某电影', state: 'downloading',
    progress: 0.5, dlspeed: 2048, upspeed: 512,
  }];
  await t.ticks[0]();
  await flush();
  const rows = t.host.querySelectorAll('.huilian-task');
  assert.strictEqual(rows.length, 1, '裸数组 list payload 应渲染一行任务（读 data 本身，而非 data.torrents）');
  assert.strictEqual(rows[0].getAttribute('data-hash'), 'HASH1', '任务行应带认领 hash');
  assert.ok(rows[0].textContent.indexOf('50%') >= 0, '裸数组渲染的百分比应正确');
});

test('list 兼容旧 {torrents:[...]} 包装形状 → pickTorrents 仍渲染（C1 双形状，对齐 pickFiles 约定）', async () => {
  const t = setup({
    listImpl: () => Promise.resolve({
      ok: true,
      data: { torrents: [{ hash: 'H2', name: '旧包装片', state: 'downloading', progress: 0.2 }] },
    }),
  });
  await t.ticks[0]();
  await flush();
  const rows = t.host.querySelectorAll('.huilian-task');
  assert.strictEqual(rows.length, 1, '包装形状也应被识别（真实桥为裸数组，两形状都须支持）');
  assert.strictEqual(rows[0].getAttribute('data-hash'), 'H2');
});

// ---- I1：页面进入即装 2s 轮询（无需先加入任务） ----

test('mount 即装轮询 interval（2s），unmount 仍清除（I1）', () => {
  const t = setup();
  assert.strictEqual(t.ticks.length, 1, 'mount 应调用 setInterval 装 2s 轮询（重进页面即刷新任务列表）');
  assert.strictEqual(t.delays[0], 2000, '轮询周期应为 2000ms');
  t.page.unmount();
  assert.deepStrictEqual(t.cleared, [7], 'unmount 应 clearInterval 轮询定时器');
});

test('非桌面（无桥）mount 不装轮询，保持降级安静（I1 降级守卫）', () => {
  const { loadPage: lp } = require('./helpers/huilian-harness');
  const { page, host, sandbox } = lp({ bridge: null });
  const armed = [];
  sandbox.setInterval = (fn, delay) => { armed.push(delay); return 99; };
  page.mount(host);
  assert.strictEqual(armed.length, 0, '无桥时 mount 不得装轮询，非桌面路径保持安静');
});
