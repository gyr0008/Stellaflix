// tests/mlib-bindings-contract.test.js —— Task 7：资料库 shell 绑定（vm + 假 DOM，复用 Task 5 fakeDom）
// 覆盖：三卡委托点击（data-mlib-axis 唯一映射源）/ 影视态 video-home-collapsed 闸 /
//       ESC 两级（document capture，资料库未开时完全让位）/ 重复点同卡幂等 / mlib-leaving→420ms 让位复位
//       （timer 走 window.__mlibTimer || setTimeout，测试注入假 clock）/ 真页面模块端到端 body 类契约。
// 修复轮新增：F2 监听注册唯一（click/ESC/动作钮各只一枚，全在 document）、
//       F3 让位复位单一属主（真页面在场时 260ms 不许摘类，420 才摘）、
//       F4 状态盒 data-mlib-action 动作钮（import 恰一次 / retry 绕幂等强制重读 / 未开态不响应）。
// 运行：node --test tests/mlib-bindings-contract.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');            // 宽松断言：vm 跨 realm 下 deepStrictEqual 会误报（仓内约定）
const fs = require('node:fs');
const path = require('node:path');
const { createFakeDom, fire, SHELL } = require('./helpers/mlib-fake-dom');

const DIR = path.join(__dirname, '..', 'public', 'js', 'modules', '04-shelf');
const BIND_SRC = fs.readFileSync(path.join(DIR, '09-mlib-bindings.js'), 'utf8');
const PAGE_SRC = fs.readFileSync(path.join(DIR, '08-mlib-page.js'), 'utf8');

// 与 index.html 静态三卡同构：button[data-mlib-axis] + 内层 children（委托要找的是 closest 命中的卡本体）。
const CARDS = [
  { tag: 'button', id: 'card-playlists', attrs: { type: 'button', 'data-mlib-axis': 'playlists' }, children: [
    { class: 'home-card-title', text: '歌单' },
  ] },
  { tag: 'button', id: 'card-albums', attrs: { type: 'button', 'data-mlib-axis': 'albums' }, children: [
    { class: 'home-card-title', text: '专辑' },
  ] },
  { tag: 'button', id: 'card-artists', attrs: { type: 'button', 'data-mlib-axis': 'artists' }, children: [
    { class: 'home-card-title', text: '艺人' },
  ] },
];

function mountCards(extra) {
  return SHELL.concat(CARDS).concat(extra || []);
}

// 真时钟等待：F3 的 260/420 属主之争只能靠真实流逝的时间戳出来（页面层那枚 260 用的是沙箱 setTimeout，
// 注入的假 clock 看不见它——所以「注入假 clock 后 420 全摘」这类断言根本无法发现双属主）。
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 微任务/短任务冲刷：openAxis→读层→paint 全链走完（断言状态盒产物前必须等它）
const flush = async () => { await null; await new Promise((resolve) => setTimeout(resolve, 0)); };

function makeFakeTimer() {
  const t = { calls: [], seq: 0 };
  t.fn = function (cb, ms) {
    const id = ++t.seq;
    t.calls.push({ id, cb, ms });
    return id;
  };
  t.runAll = function () {
    const pending = t.calls.splice(0, t.calls.length);
    pending.forEach((c) => c.cb());
    return pending.length;
  };
  return t;
}

// boot：假 DOM（SHELL＋三卡）＋ 09 绑定模块 ＋ 可注入假 timer ＋ 页面层假桩（brief：stellaMlibPage fake 可桩）。
function boot(opts) {
  const options = opts || {};
  const fakeTimer = options.fakeTimer === false ? null : makeFakeTimer();
  const fake = createFakeDom({
    hover: options.hover,
    bodyClass: options.bodyClass,
    mount: mountCards(options.mount),
    globals: fakeTimer ? { __mlibTimer: fakeTimer.fn } : {},
  });
  const { win } = fake;
  fake.timer = fakeTimer;
  fake.calls = { openAxis: [], close: 0, openDetail: [], closeDetail: 0, playEntity: [], playTrack: [] };
  win.stellaMlibPage = {
    openAxis: async function (axis) { fake.calls.openAxis.push(axis); },
    close: function () { fake.calls.close += 1; },
    openDetail: async function (axis, id) { fake.calls.openDetail.push({ axis, id }); },
    playEntity: async function (axis, id) { fake.calls.playEntity.push({ axis, id }); },
    playTrack: function (trackId) { fake.calls.playTrack.push(trackId); },
    // 桩按真页面的契约动作：closeDetail 自己摘 mlib-detail-open（真相源复位在页面层，绑定层不重复写）
    closeDetail: function () { fake.calls.closeDetail += 1; win.document.body.classList.remove('mlib-detail-open'); },
  };
  win.loadScript(BIND_SRC, '09-mlib-bindings.js');
  fake.card = (axis) => win.document.getElementById('card-' + axis);
  // ESC 与 click 同理：监听挂在 document（本 harness 存进 body.listeners），所以 fire 到 body 才打得到。
  fake.esc = (extra) => fire(fake.body, 'keydown', Object.assign({ key: 'Escape', code: 'Escape' }, extra || {}));
  return fake;
}

// 委托点击要 fire 到 **真正挂着监听的那个节点**（F2 单一属主）：
// 产品代码注册在 document，本 harness 把 document 的监听存进 body.listeners（helpers/mlib-fake-dom.js:257），
// 所以这里是 body；fire 到 window 打不到它——正是「别靠双注册把测试喂绿」的意思。
const click = (f, el) => fire(f.body, 'click', { target: el });

/* -------------------------------------------------------- ① 委托点击 */

test('委托点击：三卡 → 对应轴；data-mlib-axis 是唯一映射源', async () => {
  const f = boot();
  const { win, body } = f;
  // 点卡本体 → 轴名只取自 data-mlib-axis 属性（模块内没有任何卡 id/文案→轴的表）
  click(f, f.card('playlists'));
  click(f, f.card('albums'));
  click(f, f.card('artists'));
  assert.deepEqual(f.calls.openAxis, ['playlists', 'albums', 'artists'], '三卡按属性各开对应轴');
  assert.equal(body.classList.contains('mlib-active'), true);
  assert.equal(body.classList.contains('mlib-axis-artists'), true, '最后点的轴挂上');
  assert.equal(body.classList.contains('mlib-axis-albums'), false, '其余轴类摘除');
  assert.equal(body.classList.contains('mlib-axis-playlists'), false, '其余轴类摘除');
  // 点卡内层子节点（另一张卡）→ closest([data-mlib-axis]) 仍命中卡本体
  click(f, f.card('playlists').children[0]);
  assert.deepEqual(f.calls.openAxis, ['playlists', 'albums', 'artists', 'playlists'], '子节点委托命中同一轴');
  // 无 data-mlib-axis 的节点（壳层容器）点击不联动
  click(f, win.document.getElementById('mlib-grid'));
  assert.equal(f.calls.openAxis.length, 4, '非资料库入口点击零触发');
  // 映射源守卫：轴名在源码里零硬编码（没有任何卡 id/轴名映射表），closest 只认 data-mlib-axis 属性
  assert.equal(/['"](playlists|albums|artists)['"]/.test(BIND_SRC), false, '轴名不得作为字面量出现在绑定模块（唯一映射源＝data-mlib-axis）');
  assert.equal(BIND_SRC.includes('card-playlists'), false, '不得出现卡 id 映射表');
  assert.equal(BIND_SRC.includes('歌单') || BIND_SRC.includes('专辑') || BIND_SRC.includes('艺人'), false, '不得出现卡文案映射表');
});

test('影视态不响应：body 含 video-home-collapsed 时点击不开资料库', () => {
  const f = boot({ bodyClass: 'video-home-collapsed' });
  click(f, f.card('albums'));
  assert.equal(f.calls.openAxis.length, 0, '影视态收起 Home 时委托点击被闸住');
  assert.equal(f.body.classList.contains('mlib-active'), false, 'body 类真相源不得被写入');
  // 直调全局仍是 vm 测试面（闸在入口委托，不在 API 本身）
  f.win.mlibOpenAxis('albums');
  assert.equal(f.body.classList.contains('mlib-active'), true, 'window.mlibOpenAxis 直调面不受影视态闸影响');
});

/* -------------------------------------------------------- ② ESC 两级（capture） */

test('ESC 两级：详情→网格→关闭；资料库未开时不拦截', () => {
  const f = boot();
  // 资料库未开：完全让位（不 preventDefault / 不 stopPropagation / 不调任何页面 API）
  let prevented = 0;
  let stopped = 0;
  f.esc({ preventDefault() { prevented += 1; }, stopPropagation() { stopped += 1; } });
  assert.deepEqual([prevented, stopped], [0, 0], '未开时不得消费事件——10-shell 既有 ESC 链保持原样');
  assert.equal(f.calls.close, 0);
  // 网格层：ESC → mlibClose（置 leaving，消费事件）
  f.win.mlibOpenAxis('albums');
  let g2 = { p: 0, s: 0 };
  f.esc({ preventDefault() { g2.p += 1; }, stopPropagation() { g2.s += 1; } });
  assert.deepEqual(g2, { p: 1, s: 1 }, '网格层 ESC 必须 preventDefault+stopPropagation（抢在 document 冒泡链之前）');
  assert.equal(f.body.classList.contains('mlib-leaving'), true, '关闭走 leaving 动画态');
  // 详情层：ESC 只回网格，不关整层
  const f2 = boot();
  f2.win.mlibOpenAxis('artists');
  f2.body.classList.add('mlib-detail-open');
  let g3 = { p: 0, s: 0 };
  f2.esc({ preventDefault() { g3.p += 1; }, stopPropagation() { g3.s += 1; } });
  assert.equal(g3.s, 1, '详情层 ESC 同样消费');
  assert.equal(f2.calls.closeDetail, 1, '第一级 ESC 只关详情');
  assert.equal(f2.body.classList.contains('mlib-detail-open'), false, 'detail-open 摘除（页面 truth-source 复位）');
  assert.equal(f2.body.classList.contains('mlib-leaving'), false, '整层不得同时关闭');
  assert.equal(f2.body.classList.contains('mlib-active'), true, '回到网格层，资料库仍开');
  // 第二级 ESC 才关整层
  f2.esc();
  assert.equal(f2.body.classList.contains('mlib-leaving'), true, '第二级 ESC 关闭整层');
  // key/code 任一口径命中即处理（10-shell 用 code，overlay 用 key；fire 默认两样都不带，这里只给 code）
  const f3 = boot();
  f3.win.mlibOpenAxis('albums');
  fire(f3.body, 'keydown', { code: 'Escape' });
  assert.equal(f3.calls.close, 1, '仅 code:Escape 也须命中');
});

/* -------------------------------------------------------- ③ 幂等 */

test('mlib-active 期间重复点同一卡幂等（不重放入场动画）', () => {
  const f = boot();
  click(f, f.card('albums'));
  click(f, f.card('albums'));
  click(f, f.card('albums'));
  assert.deepEqual(f.calls.openAxis, ['albums'], '已开同轴：重复点击不重放 openAxis（入场动画不重跑）');
  assert.equal(f.body.classList.contains('mlib-active'), true);
  assert.equal(f.body.classList.contains('mlib-axis-albums'), true);
});

test('leaving 期间点同卡=复活：必须重新调 openAxis，不被幂等误吞', () => {
  const f = boot();
  click(f, f.card('albums'));
  f.win.mlibClose();
  assert.equal(f.body.classList.contains('mlib-leaving'), true, '关闭先进 leaving');
  click(f, f.card('albums'));
  assert.deepEqual(f.calls.openAxis, ['albums', 'albums'], '让位途中再点=复活，重放 openAxis');
  assert.equal(f.body.classList.contains('mlib-leaving'), false, '复活摘 leaving');
  assert.equal(f.body.classList.contains('mlib-active'), true, '复活保 active');
});

test('活动期点不同轴：干净换轴（摘 leaving/其余轴类，挂目标轴）', () => {
  const f = boot();
  click(f, f.card('albums'));
  click(f, f.card('artists'));
  assert.deepEqual(f.calls.openAxis, ['albums', 'artists']);
  assert.equal(f.body.classList.contains('mlib-axis-artists'), true);
  assert.equal(f.body.classList.contains('mlib-axis-albums'), false, '其余轴类摘除');
  assert.equal(f.body.classList.contains('mlib-active'), true, '换轴不经过关闭态');
});

/* -------------------------------------------------------- ④ 让位复位（420ms，假 clock） */

test('关闭走 mlib-leaving：先置 leaving 类，420ms 后摘 active/leaving（timer 可注入假 clock）', () => {
  const f = boot();
  f.win.mlibOpenAxis('albums');
  f.body.classList.add('mlib-detail-open'); // 兜底：详情还开着直接关整层
  assert.equal(f.timer.calls.length, 0, 'open 不排离场 timer');
  f.win.mlibClose();
  assert.equal(f.body.classList.contains('mlib-leaving'), true, '先置 leaving，CSS 才有东西可动');
  assert.equal(f.body.classList.contains('mlib-active'), true, '动画期间 active 必须还挂着');
  assert.equal(f.calls.close, 1, '页面层 close()（清网格/在途请求）被委托');
  assert.deepEqual(f.timer.calls.map((c) => c.ms), [420], '离场 timer 恰好一枚、延时 420ms');
  f.timer.runAll();
  assert.equal(f.body.classList.contains('mlib-active'), false);
  assert.equal(f.body.classList.contains('mlib-leaving'), false);
  assert.equal(f.body.classList.contains('mlib-detail-open'), false, 'detail-open 一并复位');
  assert.equal(f.body.classList.contains('mlib-axis-albums'), false, '轴类对称摘除（不留尸体类）');
  // seq 守卫：关→开→旧 timer 晚到，不得拆掉新开的层
  const g = boot();
  g.win.mlibOpenAxis('albums');
  g.win.mlibClose();
  const late = g.timer.calls[0];
  g.win.mlibOpenAxis('playlists');
  late.cb();
  assert.equal(g.body.classList.contains('mlib-active'), true, '晚到的旧离场回调必须被 seq 丢弃');
  assert.equal(g.body.classList.contains('mlib-axis-playlists'), true, '新轴不被旧 timer 误摘');
  // 未开时 mlibClose 无害：不置 leaving、不排 timer
  const h = boot();
  h.win.mlibClose();
  assert.equal(h.body.classList.contains('mlib-leaving'), false);
  assert.deepEqual(h.timer.calls, [], '无活动层不排 timer');
});

/* -------------------------------------- ④b 让位复位单一属主（F3：260 不是契约，420 才是） */

test('让位复位单一属主：真页面在场时 active/leaving 两类 260ms 后仍在（detail-open 已由 closeDetail 当场 0ms 复位），420ms 才由绑定层摘净', async () => {
  const fakeTimer = makeFakeTimer();
  const fake = createFakeDom({ hover: true, mount: mountCards(), globals: { __mlibTimer: fakeTimer.fn } });
  const { win, body } = fake;
  win.stellaMlibRead = {
    unplayableHint: () => '',
    getStateCopy: () => null, // 有卡态：paint 走 renderGrid，状态盒不参与本次断言
    getAxisData: async (axis) => ({ axis, cards: [], status: 'ok' }),
  };
  win.loadScript(PAGE_SRC, '08-mlib-page.js');
  win.loadScript(BIND_SRC, '09-mlib-bindings.js');

  await win.mlibOpenAxis('albums');
  assert.equal(body.classList.contains('mlib-active'), true);
  assert.equal(body.classList.contains('mlib-axis-albums'), true);
  body.classList.add('mlib-detail-open'); // 详情也开着：批D 起 detail-open 由 closeDetail 当场摘，只剩 active/leaving 两类归 420

  win.mlibClose();
  assert.equal(body.classList.contains('mlib-leaving'), true, '先置 leaving');
  assert.deepEqual(fakeTimer.calls.map((c) => c.ms), [420], '离场 timer 恰一枚 420（假 clock 侧）');

  // 真时钟走过 260：页面层若还自己排一枚 markInactive（F3 前的双属主），active/leaving 此刻已被摘掉。
  // 这条断言是 F3 的命门——注入的假 clock 看不见页面层那枚真 setTimeout，所以「假 clock 推到 420 全摘」根本发现不了双属主。
  await delay(300);
  assert.equal(body.classList.contains('mlib-active'), true, '260ms 后 active 必须还在：让位复位归绑定层单一属主');
  assert.equal(body.classList.contains('mlib-leaving'), true, '260ms 后 leaving 必须还在（动画还没跑完）');
  // 批D Task 5 改的是这一档的属主，不是 F3 的那一档：mlibClose 在 p.close() 之前先走
  // ensureDetailClosed() → 页面 closeDetail()，详情（含弹窗的 .show）当场收，否则遮罩浮在首页上。
  // 本条测的仍是 F3 的命门——active/leaving 的让位复位只有绑定层 420 那一枚属主（页面层没在 260 抢跑）。
  assert.equal(body.classList.contains('mlib-detail-open'), false, '批D：关库当场经 closeDetail 复位详情，不等 420');

  assert.equal(fakeTimer.runAll(), 1, '只有一枚待跑 timer');
  assert.equal(body.classList.contains('mlib-active'), false, '420ms 到点才摘');
  assert.equal(body.classList.contains('mlib-leaving'), false);
  assert.equal(body.classList.contains('mlib-detail-open'), false);
  assert.equal(body.classList.contains('mlib-axis-albums'), false, '轴类一并摘净');
});

/* -------------------------------------------------------- ⑤ 真页面模块端到端（body 类契约全链） */
test('端到端（真 08-mlib-page + 迷你读层）：点击开轴/换轴/关闭的 body 类真相源全链', async () => {
  const fakeTimer = makeFakeTimer();
  const fake = createFakeDom({ hover: true, mount: mountCards(), globals: { __mlibTimer: fakeTimer.fn } });
  const { win, body } = fake;
  let axisCalls = 0;
  win.stellaMlibRead = {
    unplayableHint: () => '',
    getStateCopy: (axis, result) => (result && result.status === 'ok' && result.cards.length ? null
      : { heading: '空', hint: '', action: null }),
    getAxisData: async (axis) => { axisCalls += 1; return { axis, cards: [], status: 'empty' }; },
  };
  win.loadScript(PAGE_SRC, '08-mlib-page.js');
  win.loadScript(BIND_SRC, '09-mlib-bindings.js');

  click(fake, win.document.getElementById('card-albums'));
  await null; // openAxis 是 async：让微任务跑完再断言
  assert.equal(body.classList.contains('mlib-active'), true, '真页面 markActive + 绑定预写双保险一致');
  assert.equal(body.classList.contains('mlib-axis-albums'), true);
  assert.equal(win.document.getElementById('music-library').getAttribute('aria-hidden'), 'false', '页面层 aria 由 openAxis 落');
  assert.equal(axisCalls, 1);

  // 换轴：点艺人卡
  click(fake, win.document.getElementById('card-artists'));
  await null;
  assert.equal(body.classList.contains('mlib-axis-artists'), true);
  assert.equal(body.classList.contains('mlib-axis-albums'), false, '真页面 markActive 互斥摘其余轴类');

  // 重复点同轴：幂等＝不重跑 openAxis 副作用（以读层请求计数观测，不看 aria 这种恒值）
  click(fake, win.document.getElementById('card-artists'));
  await null;
  assert.equal(axisCalls, 2, '幂等闸：已开同轴重复点击不得再打读层/重放入场');

  // 关闭：绑定层置 leaving + 排 420；页面层只负责清网格/状态盒/aria（不再自己排离场 timer，见 F3 专项测试）
  win.mlibClose();
  assert.equal(body.classList.contains('mlib-leaving'), true);
  assert.equal(body.classList.contains('mlib-active'), true, '420ms 前 active 仍在，动画有东西可跑');
  assert.deepEqual(fakeTimer.calls.map((c) => c.ms), [420], '绑定层只排自己那枚 420 timer');
  fakeTimer.calls[0].cb(); // 不用 runAll：保留 calls 数组供二次关闭计数
  assert.equal(body.classList.contains('mlib-active'), false);
  assert.equal(body.classList.contains('mlib-leaving'), false);
  assert.equal(body.classList.contains('mlib-axis-artists'), false);

  // 再开再关：复活路径（leaving 期真页面 markActive 自己摘掉 leaving）
  click(fake, win.document.getElementById('card-albums'));
  await null;
  assert.equal(body.classList.contains('mlib-active'), true);
  win.mlibClose();
  assert.equal(body.classList.contains('mlib-leaving'), true);
  assert.equal(fakeTimer.calls.length, 2, '二次关闭再排一枚 420');
  fakeTimer.calls[1].cb();
  assert.equal(body.classList.contains('mlib-active'), false, '闭环可重入，状态干净');
});

/* -------------------------------------------------------- ⑥ 注册唯一（F2） */

test('注册唯一：click 一枚、keydown 一枚（内含 ESC 与激活键两级分派）；window 上没有第二份', () => {
  const f = boot();
  const clicks = (f.body.listeners.click || []).length + (f.win.listeners.click || []).length;
  const keys = (f.body.listeners.keydown || []).length + (f.win.listeners.keydown || []).length;
  assert.equal(clicks, 1, 'click 委托恰一枚监听（本 harness 把 document 的监听存进 body.listeners）');
  assert.equal(keys, 1, 'keydown 恰一枚监听：F2 加激活键分派也不许开第二枚');
  assert.equal((f.win.listeners.click || []).length, 0, 'window 上不得再有第二份 click：真浏览器里 document 冒泡后会再到 window＝同一次点击跑两遍');
  assert.equal((f.win.listeners.keydown || []).length, 0, 'window 上不得再有第二份 keydown');
  // 一次逻辑点击＝恰好一次 openAxis：同一事件再投给 window（真浏览器的第二段冒泡），window 侧没有监听可打。
  click(f, f.card('albums'));
  fire(f.win, 'click', { target: f.card('albums') });
  assert.deepEqual(f.calls.openAxis, ['albums'], '一次点击只产生一次 openAxis（不靠幂等闸兜住第二遍）');
  // ESC 必须是 document 上的 capture：capture 恒早于 10-shell 那两个冒泡期归属者
  // （10-shell/01-viewport-resize-shortcuts.js:22 document 冒泡、10-shell/04-desktop-overlay-fullscreen.js:706 dock 冒泡）。
  assert.match(BIND_SRC, /document\.addEventListener\('keydown',\s*onKeydownCapture,\s*true\)/,
    'ESC 监听必须是 document capture（第三参 true）');
  assert.equal(/window\.addEventListener\(\s*['"](click|keydown)/.test(BIND_SRC), false, 'window 上不得注册任何 click/keydown 委托');
});

/* -------------------------------------------------------- ⑦ 状态盒动作钮（F4） */

// 动作钮由页面层每次空态/错误态重渲（fillStateBox），所以只能走委托，绝不逐钮挂监听。
const ACTION_BTN_MOUNT = [
  {
    tag: 'div', id: 'state-host', children: [
      {
        tag: 'button', id: 'btn-import', attrs: { type: 'button', 'data-mlib-action': 'import' },
        children: [{ tag: 'svg', id: 'btn-import-inner' }],
      },
      { tag: 'button', id: 'btn-retry', attrs: { type: 'button', 'data-mlib-action': 'retry' } },
    ],
  },
];

test('状态盒「去导入」：委托命中、恰好打开一次；全局函数缺席也不抛', () => {
  const f = boot({ mount: ACTION_BTN_MOUNT });
  let opened = 0;
  f.win.openPlatformPlaylistImport = function () { opened += 1; };
  f.win.mlibOpenAxis('playlists'); // 动作钮只在已展开的资料库里有意义
  click(f, f.doc.getElementById('btn-import'));
  assert.equal(opened, 1, '一次点击＝恰好一次 openPlatformPlaylistImport');
  fire(f.win, 'click', { target: f.doc.getElementById('btn-import') }); // 第二投递打不到任何监听
  assert.equal(opened, 1, '不存在第二次打开导入弹窗的通路');
  // 按钮内层（svg 图标）点击同样由 closest 命中：钮要可重绘，监听不能长在钮上
  click(f, f.doc.getElementById('btn-import-inner'));
  assert.equal(opened, 2, '内层子节点委托命中同一钮');
  // typeof 守卫：导入模块没加载时不得抛（本层绝不假设全局存在）
  delete f.win.openPlatformPlaylistImport;
  click(f, f.doc.getElementById('btn-import'));
  assert.equal(opened, 2, '全局缺席＝静默不响应，不抛错');
});

test('状态盒「重试」：绕过 mlibOpenAxis 幂等闸，先 invalidate 再按 body 真相源轴强制重读', async () => {
  const f = boot({ mount: ACTION_BTN_MOUNT });
  let invalidated = 0;
  f.win.stellaMlibRead = { invalidate: function () { invalidated += 1; } };
  f.win.mlibOpenAxis('artists');
  await null;
  f.calls.openAxis.length = 0;
  // 闸还活着（这是它该做的事）：同轴已开时直调 mlibOpenAxis 不放行
  assert.equal(f.win.mlibOpenAxis('artists'), null, '前置事实：mlibOpenAxis 幂等闸此时会吞掉同轴请求');
  assert.deepEqual(f.calls.openAxis, [], '对照：走 mlibOpenAxis 确实一次都不打页面层');

  click(f, f.doc.getElementById('btn-retry'));
  await null;
  assert.equal(invalidated, 1, 'retry 必须先让读层缓存作废（否则重读拿回的仍是那份错误缓存）');
  assert.deepEqual(f.calls.openAxis, ['artists'],
    'retry 走强制重读路径：已 active 且同轴也必须真打一次页面 openAxis');
  // 轴名来自 body 现挂的 mlib-axis-*（真相源），不是任何缓存变量
  f.win.mlibOpenAxis('albums');
  await null;
  f.calls.openAxis.length = 0;
  click(f, f.doc.getElementById('btn-retry'));
  await null;
  assert.deepEqual(f.calls.openAxis, ['albums'], '切轴后 retry 重读的是当前轴，不是第一次开的那条轴');
  assert.equal(invalidated, 2, '每次 retry 各自 invalidate 一次');
});

test('让位途中 retry＝同轴复活：不得被上一枚 420 离场 timer 摘掉（强制路径同样要 bump 代数）', () => {
  const g = boot({ mount: ACTION_BTN_MOUNT });
  g.win.stellaMlibRead = { invalidate: function () { } };
  g.win.mlibOpenAxis('albums');
  g.win.mlibClose();
  assert.equal(g.body.classList.contains('mlib-leaving'), true, '先进入让位动画态');
  click(g, g.doc.getElementById('btn-retry'));
  assert.deepEqual(g.calls.openAxis, ['albums', 'albums'], '让位途中 retry 照样打页面重读');
  assert.equal(g.body.classList.contains('mlib-leaving'), false, 'retry＝复活：leaving 必须摘掉');
  assert.equal(g.timer.calls.length, 1, '复活不排第二枚 timer');
  g.timer.runAll(); // 上一轮关闭那枚 420 现在才跑
  assert.equal(g.body.classList.contains('mlib-active'), true,
    '强制重读也必须算「开」：不 bump generation 的话这枚旧 timer 会把刚重读好的层摘没');
  assert.equal(g.body.classList.contains('mlib-axis-albums'), true);
});

test('资料库未开（无 mlib-active）：两个动作钮都不响应', () => {
  const f = boot({ mount: ACTION_BTN_MOUNT });
  let opened = 0; let invalidated = 0;
  f.win.openPlatformPlaylistImport = function () { opened += 1; };
  f.win.stellaMlibRead = { invalidate: function () { invalidated += 1; } };
  click(f, f.doc.getElementById('btn-import'));
  click(f, f.doc.getElementById('btn-retry'));
  assert.deepEqual([opened, invalidated], [0, 0], '关闭态下动作钮一律静默不响应');
  assert.deepEqual(f.calls.openAxis, [], '关闭态 retry 不得把资料库打开');
  // 未知 action token 同样不动作（不猜语义、不落到默认分支）
  f.win.mlibOpenAxis('albums');
  const unknown = f.doc.createElement('button');
  unknown.setAttribute('data-mlib-action', 'self-destruct');
  f.body.appendChild(unknown);
  click(f, unknown);
  assert.equal(f.calls.openAxis.length, 1, '未知 token 不接线');
  // 文案归读层/页面层：绑定模块里不得出现按钮文字
  assert.equal(/去导入|重试/.test(BIND_SRC), false, '绑定层只认 action token，绝不复制按钮文案');
});

test('端到端（真 08-mlib-page 状态盒）：retry 交出第二次读层请求，重绘后的 import 钮照样命中', async () => {
  const fakeTimer = makeFakeTimer();
  const fake = createFakeDom({ hover: true, mount: mountCards(), globals: { __mlibTimer: fakeTimer.fn } });
  const { win, body } = fake;
  const readCalls = [];
  let invalidated = 0; let imports = 0;
  win.stellaMlibRead = {
    unplayableHint: () => '',
    // 文案/动作 token 全由「读层」给（这里用测试替身），绑定层一个字都不带
    getStateCopy: (axis, res) => (res.status === 'error'
      ? { heading: 'H', hint: 'T', action: 'retry' }
      : { heading: 'H', hint: 'T', action: 'import' }),
    invalidate: () => { invalidated += 1; },
    getAxisData: async (axis) => {
      readCalls.push(axis);
      return { axis, cards: [], status: readCalls.length === 1 ? 'error' : 'empty' };
    },
  };
  win.openPlatformPlaylistImport = () => { imports += 1; };
  win.loadScript(PAGE_SRC, '08-mlib-page.js');
  win.loadScript(BIND_SRC, '09-mlib-bindings.js');

  click(fake, win.document.getElementById('card-albums'));
  await flush();
  assert.equal(readCalls.length, 1, '首读：错误态');
  const box = win.document.getElementById('mlib-state-box');
  const retryBtn = box.querySelector('[data-mlib-action="retry"]');
  assert.ok(retryBtn, '页面层必须把 action 钮交出来（状态盒由它每次重渲）');
  assert.equal(body.classList.contains('mlib-active'), true);
  assert.equal(body.classList.contains('mlib-axis-albums'), true);

  click(fake, retryBtn);
  await flush();
  assert.equal(invalidated, 1, 'retry 先 invalidate 读层缓存');
  assert.deepEqual(readCalls, ['albums', 'albums'], 'active+同轴下仍打出第二次读层请求＝幂等闸被绕过（正确方向）');

  // 第二次渲染把状态盒换成了「去导入」钮（同一节点被 innerHTML 重建）：委托必须照样命中新钮
  const importBtn = win.document.getElementById('mlib-state-box').querySelector('[data-mlib-action="import"]');
  assert.ok(importBtn, '重渲后的空态钮带 data-mlib-action="import"');
  click(fake, importBtn);
  assert.equal(imports, 1, '新钮由同一条委托命中：不逐钮挂监听');
});

/* -------------------------------------------------------- ⑧ 源码口径守卫 */

test('绑定模块口径：timer 钩子按 brief、不改 #empty-home、IIFE 严格模式', () => {
  assert.match(BIND_SRC, /window\.__mlibTimer \|\| (window\.)?setTimeout/, 'timer 必须经 window.__mlibTimer || setTimeout 取');
  assert.equal(BIND_SRC.includes('empty-home'), false, '#empty-home 让位归 CSS（body.mlib-active #empty-home），绑定层不得双写');
  assert.match(BIND_SRC, /\(function \(\)\s*\{[\s\S]*'use strict'/, 'IIFE + use strict（仓内约定）');
  assert.equal(PAGE_SRC.includes('mlibOpenAxis'), false, '全局面归绑定层，页面层不反向依赖');
});

/* -------------------------------------------------------- ⑨ F2 键盘激活 */
// 详情曲目行早就带 role=button + tabindex=0（行能聚焦），F2 之前却只有 click 与 Escape：
// 键盘用户 Tab 到行上按什么都没发生；卡根（08 buildCard 的 tabIndex=0）同理。
// 要求：Enter/Space 走的是 **同一条** document keydown 监听、**同一套** click 的优先级判定，
// 焦点落在真 <button> 上时必须让位给原生激活（否则浏览器补的那发 click 会再走一遍＝入队两次）。

const keyOn = (f, el, key, extra) => fire(f.body, 'keydown', Object.assign({ key, target: el }, extra || {}));

// 网格/详情里的可聚焦东西（结构与 08-mlib-page.js 的 buildCard/buildTrackRow 同构）
function mountKeyboardFixture(f) {
  const doc = f.doc;
  const grid = doc.getElementById('mlib-grid');
  const mk = (tag, cls, attrs, parent) => {
    const n = doc.createElement(tag);
    String(cls || '').split(/\s+/).filter(Boolean).forEach((c) => n.classList.add(c));
    Object.keys(attrs || {}).forEach((k) => n.setAttribute(k, attrs[k]));
    (parent || grid).appendChild(n);
    return n;
  };
  const card = mk('article', 'stella-mlib-album-card is-openable', { 'data-mlib-id': 'X1' });
  card.tabIndex = 0;
  const meta = mk('div', 'stella-mlib-album-meta', {}, card);
  const art = mk('div', 'stella-mlib-art', {}, card);
  const playBtn = mk('button', 'stella-mlib-play-btn', { type: 'button' }, art);
  const playBtnGlyph = mk('svg', '', {}, playBtn);
  const plainCard = mk('article', 'stella-mlib-album-card', { 'data-mlib-id': 'X2' });   // 无 is-openable
  const row = mk('div', 'stella-mlib-track', { role: 'button', tabindex: '0', 'data-mlib-track-id': 'T1' });
  const rowName = mk('div', 'stella-mlib-track-name', {}, row);
  const rowPlayBtn = mk('button', 'stella-mlib-track-more', { type: 'button' }, row);
  const rowPlayGlyph = mk('svg', '', {}, rowPlayBtn);
  const offRow = mk('div', 'stella-mlib-track', { role: 'button', tabindex: '0', 'aria-disabled': 'true', 'data-mlib-track-id': 'T2' });
  const offRowBtn = mk('button', 'stella-mlib-track-more', { type: 'button' }, offRow);
  offRowBtn.disabled = true;
  return { card, meta, art, playBtn, playBtnGlyph, plainCard, row, rowName, rowPlayBtn, rowPlayGlyph, offRow, offRowBtn };
}

test('F2 键盘激活：Enter/Space 命中卡＝开详情、命中行＝播该轨，与 click 同一套优先级', async () => {
  const f = boot();
  const fx = mountKeyboardFixture(f);
  f.win.mlibOpenAxis('albums');
  f.calls.openDetail.length = 0;
  let prevented = 0;
  const pd = { preventDefault() { prevented += 1; } };

  keyOn(f, fx.card, 'Enter', pd);
  assert.deepEqual(f.calls.openDetail, [{ axis: 'albums', id: 'X1' }], '卡根 Enter＝openDetail（轴取 body 现值轴）');
  assert.equal(prevented, 1, '命中的按键必须 preventDefault（Space 不拦就会把整页滚走）');

  keyOn(f, fx.meta, ' ', pd);
  assert.equal(f.calls.openDetail.length, 2, '卡内文案区（非 button 子节点）同样命中同一张卡');
  assert.equal(f.calls.openDetail[1].id, 'X1');

  keyOn(f, fx.row, 'Enter');
  assert.deepEqual(f.calls.playTrack, ['T1'], '曲目行 Enter＝playTrack');
  keyOn(f, fx.rowName, ' ');
  assert.deepEqual(f.calls.playTrack, ['T1', 'T1'], '行内子节点 closest 命中同一行（与 click 一致）');

  // 切轴后仍按 body 现值轴走（真相源，不是缓存变量）
  f.win.mlibOpenAxis('artists');
  keyOn(f, fx.card, 'Enter');
  assert.equal(f.calls.openDetail[2].axis, 'artists', '换轴后按键命中的是当前轴');

  // 不可开详情（无 is-openable）＝无操作；不认识的键＝无操作
  const before = [f.calls.openDetail.length, f.calls.playTrack.length];
  keyOn(f, fx.plainCard, 'Enter');
  keyOn(f, fx.card, 'a');
  keyOn(f, fx.card, 'Tab');
  assert.deepEqual([f.calls.openDetail.length, f.calls.playTrack.length], before, '不可开的卡与其它按键一律不响应');
});

test('F2 键盘激活：焦点落在真 <button>（含内层图标/不可播灰钮）一律让位给原生激活，绝不双触发', () => {
  const f = boot();
  const fx = mountKeyboardFixture(f);
  f.win.mlibOpenAxis('albums');
  // 键盘按在卡上的播放钮：本层什么都不做——原生 Enter 会补发一次 click，那条链才负责播放
  keyOn(f, fx.playBtn, 'Enter');
  keyOn(f, fx.playBtnGlyph, ' ');
  keyOn(f, fx.rowPlayBtn, 'Enter');
  keyOn(f, fx.rowPlayGlyph, 'Enter');
  keyOn(f, fx.offRowBtn, 'Enter');
  assert.deepEqual(f.calls.playEntity, [], 'keydown 不得替原生钮代劳：否则入队两次');
  assert.deepEqual(f.calls.playTrack, [], '行内播放钮的 Enter 归原生 click，不落到行那一级');
  assert.deepEqual(f.calls.openDetail, [], '同理不得顺手开详情');
  // 让位 ≠ 坏了：浏览器随后补的那发 click 照常命中同一枚钮，恰好一次
  click(f, fx.playBtn);
  assert.deepEqual(f.calls.playEntity, [{ axis: 'albums', id: 'X1' }], '一次按键＝原生 click 一趟，恰一次播放');
  click(f, fx.rowPlayBtn);
  assert.deepEqual(f.calls.playTrack, ['T1'], '行内钮经 click 命中所在行');
  // 同一趟按键+原生 click 的整体序列：Enter 钮 → 只有 click 那一次
  f.calls.playEntity.length = 0;
  keyOn(f, fx.playBtn, 'Enter');
  click(f, fx.playBtn);
  assert.equal(f.calls.playEntity.length, 1, 'keydown+click 这一整趟只出一次播放意图（双触发＝入队两次）');
});

test('F2 click 与 keydown 同判据：同一批非 button 节点，两条路产出的调用序列逐条一致', () => {
  const a = boot();
  const fa = mountKeyboardFixture(a);
  const b = boot();
  const fb = mountKeyboardFixture(b);
  a.win.mlibOpenAxis('albums');
  b.win.mlibOpenAxis('albums');
  // 同样的顺序，一个走 click、一个走 Enter/Space（非 button 节点：button 那一档故意不同，让位给原生）
  const seq = [
    ['card', 'Enter'], ['meta', ' '], ['plainCard', 'Enter'],
    ['row', 'Enter'], ['rowName', ' '], ['offRow', 'Enter'], ['card', ' '],
  ];
  seq.forEach(([name, key]) => {
    click(a, fa[name]);
    keyOn(b, fb[name], key);
  });
  assert.deepEqual(b.calls.playTrack, a.calls.playTrack, '播放意图逐条一致');
  assert.deepEqual(b.calls.openDetail, a.calls.openDetail, '详情意图逐条一致');
  assert.deepEqual(b.calls.playEntity, a.calls.playEntity);
  assert.ok(a.calls.openDetail.length >= 2 && a.calls.playTrack.length >= 3, '对照：这批步进确实产生了意图，不是两边都空对空');
  // aria-disabled 的行：两条路都同样交给页面层代码闸（本层不认 disabled 之外的第二判据）
  assert.deepEqual(a.calls.playTrack.slice(-2), ['T1', 'T2'], '不可播行也照样转发（可播性归页面层 matched 闸）');
});

test('F2 键盘分派不新增监听：document 上仍只一枚 keydown，判定函数仍只一份', () => {
  const f = boot();
  const keys = (f.body.listeners.keydown || []).length + (f.win.listeners.keydown || []).length;
  assert.equal(keys, 1, 'keydown 恰一枚监听（ESC 与 Enter/Space 共用同一条）');
  assert.equal((f.win.listeners.keydown || []).length, 0, 'window 上不得有第二份');
  assert.equal((BIND_SRC.match(/addEventListener\(\s*['"]keydown['"]/g) || []).length, 1, '源码里 keydown 注册恰一处');
  // 同一套优先级：判定函数定义一份，click 与 keydown 各调一次（复制第二份判定＝F2 明令禁止的属主漂移）
  assert.equal((BIND_SRC.match(/function runPlayIntent\(/g) || []).length, 1, 'runPlayIntent 定义恰一处');
  assert.equal((BIND_SRC.match(/runPlayIntent\(/g) || []).length, 3, '定义 1 + 调用 2（click 与 keydown 共用）');
  // 同一枚 handler 既是 ESC 又是激活键
  assert.match(BIND_SRC, /document\.addEventListener\('keydown',\s*onKeydownCapture,\s*true\)/, '仍是那枚 document capture 监听');
  assert.equal((BIND_SRC.match(/onKeydownCapture/g) || []).length, 2, 'handler 定义 + 注册各一处，不开第二条监听');
});

test('F2 键盘激活闸在 mlib-active：库关着时按键一律不响应', () => {
  const f = boot();
  const fx = mountKeyboardFixture(f);
  keyOn(f, fx.card, 'Enter');
  keyOn(f, fx.row, ' ');
  assert.deepEqual(f.calls.openDetail, [], '未开库：按键不得开详情');
  assert.deepEqual(f.calls.playTrack, [], '未开库：按键不得播曲');
  // ESC 那一级完全不受影响（资料库没开时不拦截）
  let prevented = 0;
  f.esc({ preventDefault() { prevented += 1; } });
  assert.equal(prevented, 0, '未开库时 ESC 仍把事件原样让给 10-shell');
});

/* -------------------------------------------------------- ⑩ R5 长按连发（第2轮回批） */
// 真浏览器按住 Enter/Space 不放会连发 keydown（e.repeat=true）。第1轮的激活键分支没认这个标志，
// 于是长按一次＝把同一张卡的详情请求（或同一行入队）连打 N 次。参照库 06-music-library.js:1238 同口径：
// 激活键只认「刚按下」那一发；抬手后的 repeat=false 照常工作，ESC 一档不受本条影响。

test('R5 长按 Enter/Space 不得连发：repeat 的按键一律不激活，抬手那发照常命中', () => {
  const f = boot();
  const fx = mountKeyboardFixture(f);
  f.win.mlibOpenAxis('albums');
  keyOn(f, fx.card, 'Enter', { repeat: true });
  keyOn(f, fx.meta, ' ', { repeat: true });
  keyOn(f, fx.row, 'Enter', { repeat: true });
  assert.deepEqual(f.calls.openDetail, [], '连发的按键不得重复开详情（长按一次＝N 份详情请求）');
  assert.deepEqual(f.calls.playTrack, [], '连发的按键不得重复入队（长按一次＝N 次入队）');
  let prevented = 0;
  keyOn(f, fx.card, 'Enter', { repeat: true, preventDefault() { prevented += 1; } });
  assert.equal(prevented, 0, '连发档不消费事件：这条分支整段让位');
  // 对照：抬手那一发（repeat=false）照常命中——闸认的是 repeat 标志，不是把激活键整条掐掉
  keyOn(f, fx.card, 'Enter', { repeat: false });
  assert.equal(f.calls.openDetail.length, 1, '抬手后的那一发照常激活');
  keyOn(f, fx.row, ' ', { repeat: false });
  assert.deepEqual(f.calls.playTrack, ['T1'], '行同理：非连发照常播');
  // ESC 一档不受影响（既不认 repeat 也不该认：连按 ESC 关两层是既有行为）
  const g = boot();
  g.win.mlibOpenAxis('albums');
  let escConsumed = 0;
  g.esc({ repeat: true, preventDefault() { escConsumed += 1; } });
  assert.equal(escConsumed, 1, 'ESC 的 repeat 照样消费事件：本条只管激活键');
  assert.equal(g.body.classList.contains('mlib-leaving'), true, 'ESC 关闭链一字未动');
});
