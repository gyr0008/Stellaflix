// tests/mlib-detail-modal-bindings.test.js —— 批D Task 5：弹窗事件仍走 09 那唯一一枚 document click 委托
'use strict';
const test = require('node:test');
const assert = require('node:assert');            // 宽松断言：vm 跨 realm，deepStrictEqual 会误报（仓内约定）
const { bootDetail } = require('./helpers/mlib-detail-boot');

const B = (o) => bootDetail(Object.assign({ withBindings: true, axis: 'albums', detailOpen: true }, o || {}));
const names = (f) => f.pageCalls.map((c) => c.name);

// brief Step 1 的 ③④ 两条断言写的是 `f.pageCalls[0]`，但共用 boot 的记账桩把**所有**页面调用都记进
// pageCalls，其中 currentDetail() 是 09 读「当前详情实体」真相源的那一次**查询**，不是意图（brief 自己的
// 注释：「轴名与 id 都取真相源，不读按钮属性」）。逐字跑会让 pageCalls[0] 恒等于 currentDetail。
// 改产品（另立第二真相源）不行、改 helper（Task 3 的共用面）不在本 Task 的 Files 里，
// 所以这里按 brief 的语义把查询滤掉，只断言「一次点击出一个意图」；
// 同时反向断言 currentDetail 确实被读过一次——真相源用没用得上，这条链才盖得住。
const intents = (f) => f.pageCalls.filter((c) => c.name !== 'currentDetail');
const detailReads = (f) => f.pageCalls.filter((c) => c.name === 'currentDetail').length;

test('关闭钮 → closeDetail（一次点击只出一个意图）', () => {
  const f = B();
  f.click(f.ids('[data-mlib-modal-close]'));
  assert.deepEqual(names(f), ['closeDetail']);
});

// 修复轮1·发现①：第一击经 closeDetail 桩摘掉 mlib-detail-open 后，第二击落在「真相源闸关闭」的
// runModalChrome 上——遮罩判据根本没跑，原断言恒真（RED 证据：只在原测试里补阳性对照、不补真相源类，
// 对照那条当场红 actual 0 ≠ expected 1，证明分支是死的）。按裁决补回真相源：第二击这才真正走
// 「点击落在子孙、不是遮罩自身」那条路，且阳性对照钉住遮罩命中在本 boot 里仍然是活的。
test('遮罩空白处点击＝关闭；窗口内点击不算遮罩（参照库 849-851 event.target===mask 口径）', () => {
  const f = B();
  f.click(f.ids('#mlib-detail-modal'));
  assert.equal(f.pageCalls.filter((c) => c.name === 'closeDetail').length, 1);
  f.pageCalls.length = 0;
  f.body.classList.add('mlib-detail-open');    // 真相源复位（桩的 closeDetail 当场摘类，这里补回＝还原「详情开着」的现场）
  f.click(f.ids('.stella-mlib-modal'));        // 目标落在窗口本体：closest 链一路向上但 mask 是**父级**，不算自身命中
  assert.deepEqual(names(f), [], '窗口内点击不得当成遮罩');
  f.click(f.ids('#mlib-detail-modal'));        // 阳性对照：同一 boot、同一闸下，遮罩本体这一击必须走 closeDetail
  assert.equal(f.pageCalls.filter((c) => c.name === 'closeDetail').length, 1,
    '阳性对照：遮罩本体命中要能关（证明上一条 [] 是「判据跑过且不认子孙」，不是分支没跑到）');
});

test('播放全部＝playEntity(当前轴, 当前详情实体 id)：轴名与 id 都取真相源，不读按钮属性', () => {
  const f = B({ detailId: 'local-album:x' });
  f.click(f.ids('[data-mlib-modal-play]'));
  assert.deepEqual(intents(f)[0], { name: 'playEntity', args: ['albums', 'local-album:x'] });
  assert.equal(detailReads(f), 1, '实体 id 只从 currentDetail() 取（属性面不得有第二份）');
});

test('随机播放＝playEntityShuffled；专辑轴不放随机入口（参照库 index.html:2068 只有歌单窗有随机钮）', () => {
  const f = B({ axis: 'playlists', detailId: 'pl:1' });
  f.click(f.ids('[data-mlib-modal-shuffle]'));
  assert.deepEqual(intents(f)[0], { name: 'playEntityShuffled', args: ['playlists', 'pl:1'] });
  assert.equal(detailReads(f), 1, '同上：随机也只认 currentDetail()');
  const a = B({ detailId: 'local-album:x' });    // 轴＝albums
  a.click(a.ids('[data-mlib-modal-shuffle]'));
  assert.deepEqual(names(a), [], '专辑轴命中随机钮也不发意图（CSS 已隐藏，这里是代码闸）');
});

test('展开简介钮走 toggleDesc，不发播放意图', () => {
  const f = B();
  f.click(f.ids('[data-mlib-modal-desc-toggle]'));
  assert.deepEqual(f.modal.calls, ['toggleDesc']);
  assert.deepEqual(names(f), []);
});

test('弹窗里的曲目行仍走既有 playTrack 分支（同一委托，不新增监听；点行内格子靠 closest 回行）', () => {
  const f = B();
  const row = f.doc.createElement('div');
  row.classList.add('stella-mlib-track');
  row.setAttribute('data-mlib-track-id', 't7');
  const nameCell = f.doc.createElement('div');            // 曲名格子（真库里点的是它，不是行本体）
  row.appendChild(nameCell);
  f.ids('#mlib-detail-modal-tracks').appendChild(row);
  f.click(nameCell);
  assert.deepEqual(f.pageCalls[0], { name: 'playTrack', args: ['t7'] });
});

test('整单播放进行中：重复点击不再入队（isBusy 闸，参照库 742-743 同口径）', () => {
  const f = B({ busy: true });
  f.click(f.ids('[data-mlib-modal-play]'));
  f.click(f.ids('[data-mlib-modal-shuffle]'));
  assert.deepEqual(names(f), [], 'busy 期间两颗整单钮都当已识别、不发意图');
});

test('ESC：弹窗开着 → closeDetail（详情→网格→关库三级顺序不变）；库没开时完全不消费', () => {
  const f = B();
  f.key('Escape');
  assert.equal(f.pageCalls[0].name, 'closeDetail');
  assert.equal(f.prevented, true);
  const g = B({ detailOpen: false, active: false });
  g.key('Escape');
  assert.equal(g.prevented, false, '资料库没开时不得拦 ESC（既有 ESC 链原样运行）');
});

test('切轴收窗：开另一轴前先回网格（详情弹窗不得浮在别的轴上）', () => {
  const f = B();
  f.openAxis('artists');                       // forceOpenAxis 里那句 ensureDetailClosed（:49-57）就是收口
  assert.ok(names(f).includes('closeDetail'), '切轴必须走 closeDetail，由 08 负责 hide()');
});

test('关库收窗：mlibClose 必须先经 closeDetail（切轴那条已由 ensureDetailClosed 覆盖，关库是唯一漏点）', () => {
  const f = B();
  f.closeLibrary();
  assert.ok(names(f).includes('closeDetail'), '关库不先复位详情＝弹窗 .show 浮在首页上（hide 本身已由 Task 3「closeDetail：弹窗轴收窗」那条盖住，这里只验调用链）');
});

test('08 接线：弹窗轴整单播放前后打 busy，零入队时把读层文案写进状态行（不静默、不发明）', async () => {
  const f = bootDetail({ axis: 'albums', playback: true, detailOpen: true,
    axisData: { axis: 'albums', cards: [{ id: 'AL1', title: 'A', sub: 'x', cover: '', count: 1, playable: true, meta: {} }], status: 'ok' },
    detail: { entity: { id: 'AL1', title: 'A', sub: 'x', cover: '', count: 1, playable: true, meta: {} }, tracks: [{ id: 't1', name: 'n', matched: false, duration: 100 }], status: 'ok' } });
  await f.win.stellaMlibPage.openAxis('albums');
  await f.win.stellaMlibPage.openDetail('albums', 'AL1');
  f.modal.calls.length = 0;
  const n = await f.win.stellaMlibPage.playEntity('albums', 'AL1');
  assert.equal(n, 0, '唯一一条 unmatched ⇒ 零入队');
  assert.equal(f.state.queued.length, 0);
  assert.deepEqual(f.modal.calls, ['setBusy', 'setStatus', 'setBusy'], '进 await 前收钮、finally 放钮；零入队必须给话说');
  assert.equal(f.modal.status[0].text, f.read.unplayableHint(), '状态行文案＝读层既有 hint，本批不发明新串');
  assert.equal(f.modal.status[0].tone, 'warn');
});

// ============================================================================
// 修复轮1·发现②：playEntityShuffled 的播放体此前零覆盖（④ 只测绑定面「出意图」）。
// 三条口径全部钉死，R8 折叠（playTracks 单一核心）前后这组断言必须同样绿——它们就是折叠的行为证据。
// 沙箱与宿主共享同一枚 Math（helpers/mlib-fake-dom.js 的 sandbox 字面量把 Math 直接传入），
// 所以 Math.random 的临时改写能打进 08 的 Fisher-Yates——测完必须还原（同文件多例串跑）。
// ============================================================================

test('随机整单播放：入队顺序＝打乱后的置换（强制随机下 Fisher-Yates 的确定结果），读层 res.tracks 不被原地覆写', async () => {
  const tracks = [
    { id: 't1', name: 'A', matched: true, duration: 100 },
    { id: 't2', name: 'B', matched: true, duration: 100 },
    { id: 't3', name: 'C', matched: true, duration: 100 },
    { id: 't4', name: 'D', matched: true, duration: 100 },
  ];
  const f = bootDetail({ axis: 'playlists', playback: true, detailOpen: true,
    axisData: { axis: 'playlists', cards: [{ id: 'PL1', title: 'P', sub: 'x', cover: '', count: 4, playable: true, meta: {} }], status: 'ok' },
    detail: { entity: { id: 'PL1', title: 'P', sub: 'x', cover: '', count: 4, playable: true, meta: {} }, tracks, status: 'ok' } });
  await f.win.stellaMlibPage.openAxis('playlists');
  await f.win.stellaMlibPage.openDetail('playlists', 'PL1');
  const readOrder = tracks.map((t) => t.id);
  const realRandom = Math.random;
  Math.random = () => 0.5;   // 4 元素上 i=3↔2、i=2↔1、i=1 自换 ⇒ [t1,t4,t2,t3]，可推演的确定置换
  let n;
  try {
    n = await f.win.stellaMlibPage.playEntityShuffled('playlists', 'PL1');
  } finally {
    Math.random = realRandom;
  }
  assert.equal(n, 4, '全部 matched ⇒ 整单 4 首入队');
  const queuedOrder = f.state.queued.map((q) => q.song.mlibTrackId);
  assert.notDeepEqual(queuedOrder, readOrder, '随机入队顺序 ≠ 读层原序');
  assert.deepEqual(queuedOrder, ['t1', 't4', 't2', 't3'], '入队顺序＝强制随机下 Fisher-Yates 的置换（只重排、不增不减）');
  assert.deepEqual(tracks.map((t) => t.id), readOrder,
    '读层那份共享数组没被打乱覆写（打乱只发生在 res.tracks.filter(Boolean) 的本地副本上）');
});

test('随机整单全不可播：0 入队、状态行给读层 hint（与 playEntity 的零入队收口同形）', async () => {
  const f = bootDetail({ axis: 'albums', playback: true, detailOpen: true,
    axisData: { axis: 'albums', cards: [{ id: 'AL1', title: 'A', sub: 'x', cover: '', count: 2, playable: true, meta: {} }], status: 'ok' },
    detail: { entity: { id: 'AL1', title: 'A', sub: 'x', cover: '', count: 2, playable: true, meta: {} },
      tracks: [{ id: 't1', name: 'n', matched: false, duration: 100 }, { id: 't2', name: 'm', matched: false, duration: 100 }], status: 'ok' } });
  await f.win.stellaMlibPage.openAxis('albums');
  await f.win.stellaMlibPage.openDetail('albums', 'AL1');
  f.modal.calls.length = 0;
  const n = await f.win.stellaMlibPage.playEntityShuffled('albums', 'AL1');
  assert.equal(n, 0, '全是 unmatched ⇒ 零入队');
  assert.equal(f.state.queued.length, 0, '一首都不进队');
  assert.deepEqual(f.modal.calls, ['setBusy', 'setStatus', 'setBusy'], '收钮/给话说/放钮，一条不少');
  assert.equal(f.modal.status[0].text, f.read.unplayableHint(), '文案取读层既有 hint，不发明');
  assert.equal(f.modal.status[0].tone, 'warn');
});

// ============================================================================
// 批D 终审 Important②：跨实体 setBusy/setStatus 覆写——窗口代数守卫（真 15，不用 spy）。
// 一份窗口承载两个实体：closeDetail 只 bump requestSeq、不 bump playSeq，且 playTracks 的
// modal 是入口抓的层对象 ⇒ A 的迟到响应照样入队起播（裁决：参照库语义，旧实体的乐该放完），
// 但 setBusy/setStatus 是「写窗口」——用户已把窗口重开成 B 后，A 的 finally / 零入队 hint
// 不得打进 B 的窗口（否则 B 播放中两颗整单钮被 A 提前放掉、A 的文案写进 B 的状态行）。
// 兑现：15 的 show() 递增窗口代数并经 currentGen() 导出，08 的 playTracks 入口快照代数，
// 代数变了只丢「窗口写」，入队/起播一律不作废。
// ============================================================================

const gate = () => {
  const d = {};
  d.promise = new Promise((resolve) => { d.resolve = resolve; });
  return d;
};
const gridCard = (id, extra) => Object.assign(
  { id, title: id, sub: 'x', cover: '', count: 2, playable: true, meta: {} }, extra || {});
const detailOf = (id, matched) => ({
  entity: { id, title: id, sub: 'x', cover: '', count: 1, playable: true, meta: {} },
  tracks: [{ id: id + '-t1', name: id, matched: matched !== false, duration: 100 }],
  status: 'ok',
});

// 序列：open(A)→play(A)[第 2 次 getDetail 挂闸]→ESC→open(B)→play(B)[挂闸]→手动释放。
// detail 工厂按「同一 id 第几次被要」分流：第 1 次（openDetail）同步给数据，第 2 次（playTracks）返回闸。
async function crossEntity() {
  const gates = { 'AL_A#2': gate(), 'AL_B#2': gate() };
  const seen = {};
  const f = bootDetail({
    realModal: true, playback: true,
    axisData: { axis: 'albums', status: 'ok', cards: [gridCard('AL_A'), gridCard('AL_B')] },
    detail: (axis, id) => {
      seen[id] = (seen[id] || 0) + 1;
      const key = id + '#' + seen[id];
      return gates[key] ? gates[key].promise : detailOf(id);
    },
  });
  const P = f.win.stellaMlibPage;
  await P.openAxis('albums');
  await P.openDetail('albums', 'AL_A');                 // 窗＝A（代数 g1）
  const inflightA = P.playEntity('albums', 'AL_A');     // A 播放中：setBusy(true) 已同步落
  P.closeDetail();                                      // ESC：只 bump requestSeq，不动 playSeq/代数
  await P.openDetail('albums', 'AL_B');                 // 重开成 B：show() 代数 g1→g2
  const inflightB = P.playEntity('albums', 'AL_B');     // B 播放中
  return { f, gates, inflightA, inflightB };
}

test('窗口代数①：A 在途→ESC→开 B→B 播放中→释放 A——A 照常入队，但不得放掉 B 的钮、不得改 B 的忙态文案', async () => {
  const { f, gates, inflightA, inflightB } = await crossEntity();
  // 反空转闸：两次播放必须都还挂在闸上。若「第 2 次 getDetail 才挂闸」的约定哪天不成立，
  // A 会当场落地并入队 ⇒ 这条先红，而不是让下面整组断言退化成同义反复。
  assert.equal(f.state.queued.length, 0, '前置事实：夹具确实在途（A/B 两次播放都还没入队）');
  assert.equal(f.ids('#mlib-detail-modal-play').disabled, true, '前置事实：B 播放中播放钮是收的');
  assert.equal(f.ids('#mlib-detail-modal-shuffle').disabled, true, '前置事实：B 播放中随机钮是收的');

  gates['AL_A#2'].resolve(detailOf('AL_A'));            // 释放 A 的迟到响应（全部可播）
  assert.equal(await inflightA, 1, '裁决：入队/起播不作废——旧实体的乐该放完');
  assert.deepEqual(f.state.queued.map((q) => q.song.mlibTrackId), ['AL_A-t1'], 'A 那首照常入队');
  assert.equal(f.ids('#mlib-detail-modal-play').disabled, true, 'A 的迟到 finally 不得放掉 B 的播放钮');
  assert.equal(f.ids('#mlib-detail-modal-shuffle').disabled, true, '随机钮同闸');
  assert.equal(f.ids('#mlib-detail-modal-play-label').textContent, '正在播放…', 'B 的忙态文案不得被 A 改回');

  gates['AL_B#2'].resolve(detailOf('AL_B'));            // 阳性对照：同代数，B 自己的 finally 照常放钮
  assert.equal(await inflightB, 1);
  assert.equal(f.ids('#mlib-detail-modal-play').disabled, false, '同代数窗口的 busy 往返照常生效（守卫没被焊死）');
});

test('窗口代数②：A 零入队 → 它的 hint 只能落在 A 自己的窗口，不许写进用户重开的 B', async () => {
  const { f, gates, inflightA } = await crossEntity();
  assert.equal(f.state.queued.length, 0, '前置事实：A 仍在途（未挂闸时本条会同义反复：before 会提前含 hint）');
  const before = f.ids('#mlib-detail-modal-status').textContent;
  gates['AL_A#2'].resolve(detailOf('AL_A', false));     // A 的唯一一轨 unmatched ⇒ 零入队 ⇒ 原本会 setStatus
  assert.equal(await inflightA, 0, '零入队照旧');
  assert.equal(f.ids('#mlib-detail-modal-status').textContent, before,
    'A 的零入队文案不得写进 B 的状态行（窗口代数已变）');
  assert.equal(f.ids('#mlib-detail-modal-play').disabled, true, 'B 的钮也不得被 A 放掉');
});

// ============================================================================
// 批D 终审 Important③：卡快照说不可播、窗口钮却可点（网格脏）——同一枚状态行必须给话说，
// 不许出现「点得响却零反馈」（这是 R9 从按钮侧堵的那类缺陷，从入口侧又露了一次）。
// ============================================================================
test('卡态不可播而窗口钮可点：零入队，但状态行给读层 hint + tone=warn', async () => {
  const f = bootDetail({
    realModal: true, playback: true,
    axisData: { axis: 'albums', status: 'ok', cards: [gridCard('AL_A', { playable: false })] },
    detail: detailOf('AL_A'),                            // 详情说「有 matched 轨」⇒ 窗口钮亮
  });
  const P = f.win.stellaMlibPage;
  await P.openAxis('albums');
  await P.openDetail('albums', 'AL_A');
  assert.equal(f.ids('#mlib-detail-modal-play').disabled, false, '前置事实：窗口钮可点（详情有可播轨）');
  const n = await P.playEntity('albums', 'AL_A');
  assert.equal(n, 0, '卡快照不可播 ⇒ 零入队（闸保留）');
  assert.equal(f.state.queued.length, 0);
  const status = f.ids('#mlib-detail-modal-status');
  assert.equal(status.textContent, f.read.unplayableHint(), '文案取读层既有 hint，不发明新串');
  assert.equal(status.getAttribute('data-tone'), 'warn');
});
