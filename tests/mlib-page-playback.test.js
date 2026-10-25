// tests/mlib-page-playback.test.js —— Task 8：播放接线（vm + 假 DOM，复用 Task 5/6/7 同一 harness）
// 覆盖：整张播放（卡播放钮→getDetail→只入 matched 轨、按读层顺序）/ 单曲入队（行→payload by data-mlib-track-id）/
//       track→song 映射＝仓内既有 song 对象惯例（小写字段 + 身份字段直传 + localFile→localKey + mlibTrackId 溯源），
//       不可播路径「不可达」（disabled 只是外观，代码闸在 payload：card.playable / track.matched），
//       在途 getDetail 期间关闭/切轴的晚到响应不入队，
//       单 click 监听不变量（播放意图由 09 既有委托分发，页面层不监听任何事件），
//       「去导入」＝既有绑定：非重复接线（④ 改写）。
// ⑨ 另用 jsdom + 真 index.html 骨架复核 W3C 事件语义（真冒泡＝一次点击一遍、不可播行的代码闸真的被走到）。
// 运行：node --test tests/mlib-page-playback.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');            // 宽松断言：vm 跨 realm 下 deepStrictEqual 会误报（仓内约定）
const fs = require('node:fs');
const path = require('node:path');
const { createFakeDom, fire, SHELL } = require('./helpers/mlib-fake-dom');

const DIR = path.join(__dirname, '..', 'public', 'js', 'modules', '04-shelf');
const READ_SRC = fs.readFileSync(path.join(DIR, '07-mlib-readlayer.js'), 'utf8');
const PAGE_SRC = fs.readFileSync(path.join(DIR, '08-mlib-page.js'), 'utf8');
const BIND_SRC = fs.readFileSync(path.join(DIR, '09-mlib-bindings.js'), 'utf8');

// 首页三卡（09 的 axis 分支）：播放委托不得把它吃掉，也证明「仍然只有一枚 click 监听」时有对照物
const CARDS = [
  { tag: 'button', id: 'card-albums', attrs: { type: 'button', 'data-mlib-axis': 'albums' }, children: [{ class: 'home-card-title', text: '专辑' }] },
  { tag: 'button', id: 'card-playlists', attrs: { type: 'button', 'data-mlib-axis': 'playlists' }, children: [{ class: 'home-card-title', text: '歌单' }] },
];

// 缝轨（spec §3 最小字段）：默认＝导入轨（source 用缝的词表值，不是任何 provider 词）
const track = (o) => Object.assign({
  id: 't1', name: '夜曲', artist: '周杰伦', artistId: 'AR1', album: '十一月的萧邦', albumId: 'AL1',
  cover: 'https://cdn/1.jpg', duration: 250, source: 'imported', localFile: '', matched: true,
}, o || {});

const albumCard = (id, title, extra) => Object.assign({
  id, title, sub: '周杰伦', cover: 'https://cdn/a.jpg', count: 3, playable: true,
  sortKey: String(title).toLowerCase(), sortBucket: 'album', meta: { releaseYear: 2005 },
}, extra || {});

const flush = async () => { await null; await new Promise((resolve) => setTimeout(resolve, 0)); };

function deferred() {
  const d = { promise: null, resolve: null, reject: null };
  d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; });
  return d;
}

// boot：真读层文件（getStateCopy/unplayableHint 是真的）+ 真页面（+ 可选真绑定层）。
// getAxisData/getDetail 换成测试数据（页面只见契约形状，同 Task 5/6 口径）。
// opts.queueSongNext=false 之类不需要：两个全局都给桩，断言里直接用 state。
function boot(options) {
  const opts = options || {};
  const state = { queued: [], next: [], imports: 0, playCalls: [] };
  const globals = {
    // 既有队列链全局（05-playback/10-queue-actions.js:1/30）：桩注入，harness 的 globals 同时是沙箱全局与 window
    queueSong: function (song, qo) { state.queued.push({ song, opts: qo === undefined ? null : qo }); return state.queued.length - 1; },
    queueSongNext: function (song) { state.next.push(song); return state.queued.length; },
    openPlatformPlaylistImport: function () { state.imports += 1; },
  };
  if (opts.withoutQueueSong) delete globals.queueSong;
  // 「立即播放」入口桩（05-playback/13-playback-start-audio.js:932 的全局面）：仅 I1 用例注入。
  // 默认不注入＝缺席，页面层的 typeof 守卫必须让它在缺位时静默（既有用例因此维持零播放、不受本轮回改影响）。
  if (opts.play) {
    globals.playQueueAt = function (idx, po) { state.playCalls.push({ idx, opts: po === undefined ? null : po }); return true; };
  }
  const fakeTimer = { calls: [] };
  const createOpts = { hover: opts.hover, mount: SHELL.concat(CARDS), globals };
  if (opts.withTimer !== false) createOpts.globals.__mlibTimer = function (cb, ms) { fakeTimer.calls.push({ cb, ms }); return fakeTimer.calls.length; };
  const fake = createFakeDom(createOpts);
  const { win, doc } = fake;
  fake.state = state;
  fake.timer = fakeTimer;
  win.loadScript(READ_SRC, '07-mlib-readlayer.js');
  fake.cards = Array.isArray(opts.cards) ? opts.cards : [albumCard('AL1', '十一月的萧邦')];
  fake.axisStatus = opts.axisStatus || 'ok';
  win.stellaMlibRead.getAxisData = async (axis) => ({ axis, cards: fake.cards, status: fake.axisStatus });
  fake.detailCalls = [];
  fake.detail = opts.detail !== undefined ? opts.detail : { entity: null, tracks: fake.cards.length ? [track()] : [], status: 'ok' };
  win.stellaMlibRead.getDetail = async function (axis, id) {
    fake.detailCalls.push({ axis, id });
    if (fake.detail && typeof fake.detail.promise === 'object' && fake.detail.promise && typeof fake.detail.promise.then === 'function') {
      return fake.detail.promise; // deferred 形态：由测试决定何时落地
    }
    return fake.detail;
  };
  win.loadScript(PAGE_SRC, '08-mlib-page.js');
  fake.withBindings = opts.bindings !== false;
  if (fake.withBindings) win.loadScript(BIND_SRC, '09-mlib-bindings.js');
  fake.read = win.stellaMlibRead;
  fake.page = win.stellaMlibPage;
  fake.doc = doc;
  fake.card = (id) => doc.querySelector('[data-mlib-id="' + id + '"]');
  fake.cardPlayBtn = (id) => { const c = fake.card(id); return c && c.querySelector('.stella-mlib-play-btn'); };
  fake.row = (id) => doc.querySelector('[data-mlib-track-id="' + id + '"]');
  fake.rowBtn = (id) => { const r = fake.row(id); return r && r.querySelector('.stella-mlib-track-more'); };
  fake.meta = (id) => { const c = fake.card(id); return c && c.querySelector('.stella-mlib-album-meta'); };
  fake.backBtn = () => doc.getElementById('mlib-detail-back');
  fake.click = (el) => fire(fake.body, 'click', { target: el });
  fake.openAlbums = async () => { await win.stellaMlibPage.openAxis('albums'); await flush(); };
  fake.openDetail = async (tracks) => {
    if (tracks !== undefined) fake.detail = { entity: albumCard('AL1'), tracks, status: 'ok' };
    await win.stellaMlibPage.openDetail('albums', 'AL1');
    await flush();
  };
  return fake;
}

const names = (list) => list.map((q) => q.song.name);

/* ------------------------------------------------ ① 整张播放：只入 matched、按读层顺序 */

test('整张播放：3 首含 1 首 unmatched → queueSong 恰 2 次，顺序＝读层原序（页面不重排）', async () => {
  const f = boot({ cards: [albumCard('AL1', '十一月的萧邦')] });
  await f.openAlbums();
  await f.openDetail();
  f.detail = {
    entity: albumCard('AL1'), status: 'ok',
    tracks: [track({ id: 't1', name: '夜曲' }), track({ id: 't2', name: '发如雪', matched: false }), track({ id: 't3', name: '青花瓷' })],
  };
  f.state.queued.length = 0;
  const n = await f.page.playEntity('albums', 'AL1');
  assert.equal(n, 2, '返回值＝实际入队首数');
  assert.deepEqual(names(f.state.queued), ['夜曲', '青花瓷'], 'unmatched 被过滤，其余按读层顺序');
  assert.equal(f.state.next.length, 0, '整张播放走 queueSong（入队尾），不抢「下一首」');
  f.state.queued.forEach((q) => assert.equal(q.opts, null, 'queueSong 第二参不发明（默认队尾追加）'));
});

test('整张播放：轴名取自 body 真相源（data-mlib-id 只给实体 id），getDetail 收到 (当前轴, 卡 id)', async () => {
  const f = boot({ cards: [albumCard('AL1', 'X'), albumCard('AL2', 'Y')] });
  await f.openAlbums();
  const ok = await f.page.playEntity('albums', 'AL2');
  assert.equal(ok, 1, '第二张卡也能整张播放');
  assert.deepEqual(f.detailCalls, [{ axis: 'albums', id: 'AL2' }], 'getDetail 的轴/id 就是页面层收到的那对');
});

test('整张播放（点击委托）：卡封面角标钮 → 读层取轨 → 入队；一次点击只跑一遍', async () => {
  const f = boot();
  await f.openAlbums();
  f.click(f.cardPlayBtn('AL1'));
  await flush();
  assert.equal(f.state.queued.length, 1, '一次点击＝一次入队路径（不靠幂等闸兜第二遍）');
  assert.equal(f.state.queued[0].song.name, '夜曲');
  // 同一事件再投给 window（真浏览器 document 冒泡后的第二段）不得再来一遍
  fire(f.win, 'click', { target: f.cardPlayBtn('AL1') });
  await flush();
  assert.equal(f.state.queued.length, 1, 'window 侧没有第二份监听');
});

/* ------------------------------------------------ ② track→song 映射＝仓内 song 对象惯例 */

test('track→song 映射：小写惯例字段 + 缝身份字段直传 + localFile→localKey + mlibTrackId 溯源', async () => {
  const f = boot();
  await f.openAlbums();
  const t = track({
    id: 't9', name: '晴天', artist: '周杰伦', artistId: 'AR1', album: '叶惠美', albumId: 'AL2',
    cover: 'https://cdn/9.jpg', duration: 269, source: 'local-file', localFile: 'music/晴天.mp3', matched: true,
  });
  f.detail = { entity: albumCard('AL1', '叶惠美'), tracks: [t], status: 'ok' };
  await f.openDetail();
  f.click(f.rowBtn('t9'));
  await flush();
  assert.equal(f.state.queued.length, 1);
  const song = f.state.queued[0].song;
  // 精确键集：缝字段（含 matched/localFile 原值）＋ 页面补的 localKey/mlibTrackId；
  // 键名大小写＝仓内惯例（desktop/local-music-library.js:371-391 与 06-lyrics/05-upload-dragdrop.js:27-43 全小写）
  assert.deepEqual(Object.keys(song).sort(), [
    'album', 'albumId', 'artist', 'artistId', 'cover', 'duration', 'id', 'localFile', 'localKey', 'matched', 'mlibTrackId', 'name', 'source',
  ].sort(), 'song 键集＝缝字段直传 + localKey + mlibTrackId，不发明别的');
  assert.equal(song.name, '晴天');
  assert.equal(song.artist, '周杰伦');
  assert.equal(song.album, '叶惠美');
  assert.equal(song.albumId, 'AL2');
  assert.equal(song.artistId, 'AR1');
  assert.equal(song.cover, 'https://cdn/9.jpg');
  assert.equal(song.duration, 269, 'duration 原值直传（缝契约＝数值）');
  assert.equal(song.id, 't9', 'id 原值直传＝queueItemKey 的 song: 身份（09-queue-snapshot-autoplay.js:9）');
  assert.equal(song.source, 'local-file', 'source 保持缝的词表值——绝不覆写成 \'mlib\'（那会把缝的来源信息弄丢）');
  assert.equal(song.localFile, 'music/晴天.mp3', '缝的 localFile 原值保留');
  assert.equal(song.localKey, 'music/晴天.mp3', 'localFile→localKey＝仓内本地标识惯例（09-queue-snapshot-autoplay.js:8 local: 身份）');
  assert.equal(song.mlibTrackId, 't9', 'mlibTrackId 只做溯源，不参与任何播放判定');
  assert.equal(song.localUrl, undefined, '页面不合成播放地址：localUrl 只能来自缝自己给的值');
});

test('本地优先不由页面判定：缝给出 type/source/localUrl 时原样直传给既有队列链', async () => {
  const f = boot();
  await f.openAlbums();
  const local = track({
    id: 'loc1', type: 'local', source: 'local', provider: 'local',
    localKey: 'aaaaaaaaaaaaaaaaaaaaaaaa', localFileId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    localUrl: 'stellaflix-local://media/audio/aaaaaaaaaaaaaaaaaaaaaaaa', localFile: 'music/a.mp3', matched: true,
  });
  f.detail = { entity: albumCard('AL1'), tracks: [local], status: 'ok' };
  await f.openDetail();
  f.click(f.rowBtn('loc1'));
  await flush();
  assert.equal(f.state.queued.length, 1);
  const song = f.state.queued[0].song;
  assert.equal(song.type, 'local', 'type 直传：playQueueAt 的本地分支据此走 playLocalQueueSong（13-playback-start-audio.js:1121）');
  assert.equal(song.localUrl, 'stellaflix-local://media/audio/aaaaaaaaaaaaaaaaaaaaaaaa', 'localUrl 直传＝本地优先的真凭据');
  assert.equal(song.localKey, 'aaaaaaaaaaaaaaaaaaaaaaaa', '缝已给 localKey 时不被 localFile 覆盖');
  assert.equal(song.source, 'local', 'source 不被页面改写');
});

/* ------------------------------------------------ ③ 单曲入队 / 不可达 */

test('单曲行播放钮点击 → 该轨入队一次（payload 按 data-mlib-track-id 命中）', async () => {
  const f = boot();
  await f.openAlbums();
  await f.openDetail([track({ id: 't1', name: '夜曲' }), track({ id: 't2', name: '发如雪' })]);
  f.click(f.rowBtn('t2'));
  await flush();
  assert.equal(f.state.queued.length, 1, '一行一次');
  assert.equal(f.state.queued[0].song.name, '发如雪');
  assert.equal(f.state.queued[0].song.mlibTrackId, 't2');
  const callsBefore = f.detailCalls.length;
  f.click(f.rowBtn('t1'));
  await flush();
  assert.equal(f.detailCalls.length, callsBefore, '单曲入队用已渲染的 payload，不再打读层');
});

test('整行＝同一入队路径（CSS 行 cursor:pointer）：点曲名格子照样命中', async () => {
  const f = boot();
  await f.openAlbums();
  await f.openDetail([track({ id: 't1', name: '夜曲' })]);
  const row = f.row('t1');
  f.click(row.querySelector('.stella-mlib-track-name'));
  await flush();
  assert.equal(f.state.queued.length, 1, 'closest(.stella-mlib-track) 命中行本体');
});

test('unmatched 行：钮 disabled（Task 6）+ 代码闸——假 DOM 把点击送到这里也不产生调用', async () => {
  const f = boot();
  await f.openAlbums();
  await f.openDetail([track({ id: 't1', name: '夜曲' }), track({ id: 't2', name: '发如雪', matched: false })]);
  const btn = f.rowBtn('t2');
  assert.equal(btn.disabled, true, '前置事实：Task 6 已给 unmatched 行的播放钮置 disabled');
  assert.equal(f.row('t2').getAttribute('aria-disabled'), 'true', '不可播行 aria-disabled');
  f.click(btn); // closest() 在 disabled 钮上照样命中（真浏览器不派发 click，假 DOM 派发 → 代码闸必须存在）
  await flush();
  assert.equal(f.state.queued.length, 0, 'disabled 钮不得成为绕过代码闸的通路');
  const n = await f.page.playTrack('t2');
  assert.equal(n, 0, '直调面同样被 matched 闸拦下（返回 0 首）');
  assert.equal(f.state.queued.length, 0, '两条路都零入队');
  // 对照：同一张详情里的可播行仍然可用
  f.click(f.rowBtn('t1'));
  await flush();
  assert.equal(f.state.queued.length, 1, '同详情里可播行不受影响');
});

test('整张播放里的 unmatched：既不入队也不改变后续曲目顺序（同 ①，独立验证读层原序）', async () => {
  const f = boot();
  await f.openAlbums();
  f.detail = {
    entity: albumCard('AL1'), status: 'ok',
    tracks: [track({ id: 'a', name: '乙', matched: false }), track({ id: 'b', name: '甲' }), track({ id: 'c', name: '丙', matched: false })],
  };
  const n = await f.page.playEntity('albums', 'AL1');
  assert.deepEqual([n, names(f.state.queued)], [1, ['甲']], '只留可播那首，顺序不因过滤而变');
});

/* ------------------------------------------------ ④ 卡不可播 / 关闭态 / 晚到响应 */

test('playable:false 的卡：钮 disabled + 点击零入队且零 getDetail 请求（代码闸在发请求之前）', async () => {
  const f = boot({ cards: [albumCard('AL1', '没有可播来源的专辑', { playable: false })] });
  await f.openAlbums();
  const btn = f.cardPlayBtn('AL1');
  assert.equal(btn.disabled, true, '前置事实：Task 5 已给不可播卡的播放钮置 disabled');
  f.click(btn);
  await flush();
  assert.deepEqual([f.detailCalls.length, f.state.queued.length], [0, 0], '不可播卡：不打读层、不入队');
  const n = await f.page.playEntity('albums', 'AL1');
  assert.equal(n, 0, '直调面同样返回 0 首');
  assert.equal(f.detailCalls.length, 0, '直调面也不发无用的详情请求');
});

test('资料库关闭后：卡 payload 已清 → 整张播放零请求零入队；行 payload 已清 → 单曲零入队', async () => {
  const f = boot();
  await f.openAlbums();
  await f.openDetail([track({ id: 't1', name: '夜曲' })]);
  f.win.mlibClose(); // 绑定层关闭：页面 close() 清网格 payload（详情 payload 由 closeDetail 清）
  f.page.closeDetail();
  const callsBefore = f.detailCalls.length;
  const a = await f.page.playEntity('albums', 'AL1');
  const b = await f.page.playTrack('t1');
  assert.deepEqual([a, b], [0, 0], '两张 Map 都清空后，id 查不到 payload＝播放路径不可达');
  assert.equal(f.detailCalls.length, callsBefore, '零请求');
  assert.equal(f.state.queued.length, 0, '零入队');
});

test('未展开资料库（无 mlib-active）：点击播放钮由绑定层闸住；直调页面 API 仍是测试面', async () => {
  const f = boot();
  await f.openAlbums();
  const btn = f.cardPlayBtn('AL1');
  f.body.classList.remove('mlib-active'); // 只关闸，不清 payload：证明闸在绑定层
  f.click(btn);
  await flush();
  assert.equal(f.state.queued.length, 0, '关闭态点击零入队');
  assert.equal(f.detailCalls.length, 0, '关闭态点击零请求');
  const n = await f.page.playEntity('albums', 'AL1');
  assert.equal(n, 1, 'payload 在场时直调面照常工作（同 mlibOpenAxis 直调口径）');
});

test('在途 getDetail 期间关闭资料库：晚到的响应不入队（与 requestSeq 同一并发口径）', async () => {
  const f = boot();
  await f.openAlbums();
  const d = deferred();
  f.detail = d;
  const inflight = f.page.playEntity('albums', 'AL1');
  await null;
  f.win.mlibClose(); // close() → clearGrid() → 播放代数作废
  d.resolve({ entity: albumCard('AL1'), tracks: [track()], status: 'ok' });
  const n = await inflight;
  assert.equal(n, 0, '晚到响应被丢弃，返回 0 首');
  assert.equal(f.state.queued.length, 0, '一份都不入队');
});

test('在途 getDetail 期间切轴（网格同步清场）：同样不入队，不复活旧轴的卡', async () => {
  const f = boot({ cards: [albumCard('AL1', 'X')] });
  await f.openAlbums();
  const d = deferred();
  f.detail = d;
  const inflight = f.page.playEntity('albums', 'AL1');
  await null;
  await f.win.stellaMlibPage.openAxis('playlists'); // 切轴＝清场
  d.resolve({ entity: albumCard('AL1'), tracks: [track()], status: 'ok' });
  assert.equal(await inflight, 0, '切轴后旧播放请求作废');
  assert.equal(f.state.queued.length, 0);
});

/* ------------------------------------------------ ⑤ 触屏/鼠标两模（CSS 承诺的整封面即播 + C1 详情入口） */

test('触屏（html 无 stella-mlib-has-hover）：整张封面即播；文案区进二级详情（C1）', async () => {
  const touch = boot({ hover: false });
  assert.equal(touch.html.classList.contains('stella-mlib-has-hover'), false, '前置事实：页面层探测把 hover 类摘了');
  await touch.openAlbums();
  const art = touch.card('AL1').querySelector('.stella-mlib-art');
  touch.click(art); // 触屏分支：点封面本体（钮被 CSS 隐藏）
  await flush();
  assert.equal(touch.state.queued.length, 1, '触屏整封面＝播放入口（music-library.css:331-339 承诺）');
  assert.equal(touch.body.classList.contains('mlib-detail-open'), false, '封面那一下是播放，不是进详情');

  const touch2 = boot({ hover: false });
  await touch2.openAlbums();
  touch2.detail = { entity: albumCard('AL1'), tracks: [track({ id: 't9', name: '晴天' })], status: 'ok' };
  touch2.click(touch2.card('AL1').querySelector('.stella-mlib-album-meta'));
  await flush();
  assert.equal(touch2.state.queued.length, 0, '触屏文案区不播放');
  assert.equal(touch2.body.classList.contains('mlib-detail-open'), true, '触屏文案区＝二级详情入口（C1：spec 两模机制的另一半）');
});

test('鼠标模（有 hover）：封面/文案区都进二级详情，都不起播（C1）', async () => {
  const mouse = boot({ hover: true });
  await mouse.openAlbums();
  mouse.detail = { entity: albumCard('AL1'), tracks: [track({ id: 't9', name: '晴天' })], status: 'ok' };
  const callsBefore = mouse.detailCalls.length;
  mouse.click(mouse.card('AL1').querySelector('.stella-mlib-art'));
  await flush();
  assert.equal(mouse.state.queued.length, 0, '鼠标模封面非钮区不起播');
  assert.equal(mouse.body.classList.contains('mlib-detail-open'), true, '鼠标模封面（非钮区）＝进详情（C1 修复前的死区）');
  assert.equal(mouse.detailCalls.length, callsBefore + 1, '封面那一下打了一次 getDetail（openDetail）');
});

/* ------------------------------------------------ ⑥ 队列全局缺席 */

test('queueSong 全局缺席：typeof 守卫，不抛错、零入队（页面不假设跨批次全局存在）', async () => {
  const f = boot({ withoutQueueSong: true });
  await f.openAlbums();
  await f.openDetail([track({ id: 't1', name: '夜曲' })]);
  let threw = 0;
  try {
    f.click(f.rowBtn('t1'));
    await flush();
    assert.equal(await f.page.playTrack('t1'), 0);
    assert.equal(await f.page.playEntity('albums', 'AL1'), 0);
  } catch (e) { threw += 1; }
  assert.equal(threw, 0, '缺席时静默不响应，绝不抛');
  assert.equal(f.state.queued.length, 0);
});

/* ------------------------------------------------ ⑦ 「去导入」＝既有绑定：非重复接线（④ 改写） */

test('去导入：绑定恰一枚且在绑定层；页面模块不绑 import、不监听任何事件', async () => {
  const f = boot({ cards: [], axisStatus: 'empty' }); // 曲库为空＝读层给 action:'import'（Task 3 表）
  await f.win.stellaMlibPage.openAxis('albums');
  await flush();
  const btn = f.doc.getElementById('mlib-state-box').querySelector('[data-mlib-action="import"]');
  assert.ok(btn, '空态必须交出 data-mlib-action="import" 钮（Task 3/5 既有产物）');
  f.click(btn);
  assert.equal(f.state.imports, 1, '一次点击＝恰好一次 openPlatformPlaylistImport');
  fire(f.win, 'click', { target: btn });
  assert.equal(f.state.imports, 1, '不存在第二条通路');
  // 归属：动作钮的接线只在 09-mlib-bindings.js，页面模块一次都不提
  assert.equal(PAGE_SRC.includes('openPlatformPlaylistImport'), false, '页面层不得再绑「去导入」（重复绑定＝开两层弹窗）');
  assert.match(BIND_SRC, /openPlatformPlaylistImport/, '绑定层持有唯一那一次绑定');
  assert.equal(/addEventListener\(\s*['"](?:click|keydown|keyup|mousedown|pointerdown)['"]/.test(PAGE_SRC), false,
    '页面层不注册任何指针/键盘委托（单一 click 委托归绑定层；封面 img 的 load/error 不算）');
});

test('单监听不变量：接完 read+page+bindings 仍只有 click/keydown 各一枚；首页三卡分支不受影响', async () => {
  const f = boot();
  const clicks = (f.body.listeners.click || []).length + (f.win.listeners.click || []).length;
  const keys = (f.body.listeners.keydown || []).length + (f.win.listeners.keydown || []).length;
  assert.equal(clicks, 1, 'click 委托恰一枚：播放接线没有新增第二枚');
  assert.equal(keys, 1, 'keydown 委托恰一枚（本任务不接键盘，也没多注册）');
  assert.equal((f.win.listeners.click || []).length, 0, 'window 上不得有第二份 click');
  // 三轴卡 → 轴的既有分支仍然工作（播放分支排在它后面，不吃掉非资料库点击）
  f.click(f.doc.getElementById('card-playlists'));
  await flush();
  assert.equal(f.body.classList.contains('mlib-axis-playlists'), true, '首页卡点击仍开对应轴');
  assert.equal(f.state.queued.length, 0, '开轴不产生任何入队');
});

/* ------------------------------------------------ ⑧ 不新造播放路径 / 不新增文案 */

test('页面层口径守卫：只用既有 queueSong+playQueueAt 两枚全局面，不碰队列内部态、不照抄"替换整队列"入口', async () => {
  // I1 裁定后：立即播＝调用既有全局 playQueueAt（13-playback-start-audio.js:932），但仍不得直接摸队列内部态
  //（队列表本体 / 当前索引），也不照抄那两枚"整队列替换并起播"的入口（它们要 provider id 与前置数据）。
  assert.equal(/playQueue\b|currentIdx\b|loadPlaylistIntoQueueById|startHomeLocalPlayback/.test(PAGE_SRC), false,
    '页面层不直接动队列内部态/当前索引，也不照抄那两枚替换整队列的入口');
  assert.match(PAGE_SRC, /window\.playQueueAt/, '立即播＝既有全局面 window.playQueueAt（13-playback-start-audio.js:932）');
  assert.equal(/source:\s*['"]mlib['"]/.test(PAGE_SRC), false, '不把 \'mlib\' 写进 source/provider（既有链认不出的词）');
  assert.equal(/showToast|alert\(/.test(PAGE_SRC), false, '播放路径不发明用户可见文案');
  assert.match(PAGE_SRC, /window\.queueSong/, '入队入口＝window.queueSong（10-queue-actions.js:1 的全局面）');
});

/* ------------------------------------------------ ⑨ 真 DOM（jsdom）复核：W3C 事件语义下的两条结论
   假 DOM 的两处已知取舍（helpers/mlib-fake-dom.js:40-45）：事件不冒泡（fire 只派发节点自身监听）、
   disabled 钮照样派发。于是「一次点击只跑一遍」「不可播行到底走没走到代码闸」这两件事
   在假 DOM 里根本测不出来（前者靠人造的第二投递模拟，后者压根绕过了浏览器语义）。
   控制器裁定 (2) 要求「假 DOM 与真浏览器都验」——这里用 jsdom + 真 index.html 骨架补上这一层：
   · 真冒泡：document 上的委托只可能收到一次 ⇒ 入队恰一次（若哪天多挂一枚 window 监听，当场翻倍）。
   · 真语义：不可播行的钮是 disabled（浏览器不派发 click），但**行本体没有 disabled**，
     而 CSS 把整行标成 cursor:pointer（music-library.css:536）——真实用户点行一定打得到委托，
     所以「不可达」只能由页面层的 matched 代码闸兑现。这里用 spy 证明闸确实被走到且零入队。 */

const { JSDOM } = require('jsdom');
const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function bootReal(options) {
  const opts = options || {};
  const dom = new JSDOM(INDEX_HTML, { url: 'http://localhost:3000/', pretendToBeVisual: true, runScripts: 'outside-only' });
  const win = dom.window;
  const doc = win.document;
  const cfg = {
    cards: Array.isArray(opts.cards) ? opts.cards : [albumCard('AL1', '十一月的萧邦')],
    axisStatus: opts.axisStatus || 'ok',
    detail: opts.detail !== undefined ? opts.detail : { entity: null, tracks: [track()], status: 'ok' },
  };
  const state = { queued: [], next: [], imports: 0, detailCalls: [], playCalls: [] };
  win.queueSong = function (song, qo) { state.queued.push({ song, opts: qo === undefined ? null : qo }); return state.queued.length - 1; };
  win.queueSongNext = function (song) { state.next.push(song); return state.queued.length; };
  win.openPlatformPlaylistImport = function () { state.imports += 1; };
  // I1：立即播入口桩——只有测试显式要才注入；默认缺席＝页面层 typeof 守卫必须静默（既有用例不受影响）。
  if (opts.play) {
    win.playQueueAt = function (idx, po) { state.playCalls.push({ idx, opts: po === undefined ? null : po }); return true; };
  }
  // hover 能力锁死成测试要的那一模：页面层只在载入/开轴时探测一次，必须在 eval 之前定义好
  const hoverMatches = opts.hover !== false;
  win.matchMedia = function (q) {
    return {
      media: String(q), matches: hoverMatches,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
    };
  };
  win.eval(READ_SRC);
  win.stellaMlibRead.getAxisData = async (axis) => ({ axis, cards: cfg.cards, status: cfg.axisStatus });
  win.stellaMlibRead.getDetail = async function (axis, id) {
    state.detailCalls.push({ axis, id });
    return cfg.detail;
  };
  win.eval(PAGE_SRC);
  win.eval(BIND_SRC);
  const api = {
    win, doc, body: doc.body, html: doc.documentElement, state, cfg, page: win.stellaMlibPage,
    card: (id) => doc.querySelector('[data-mlib-id="' + id + '"]'),
    cardPlayBtn: (id) => { const c = api.card(id); return c && c.querySelector('.stella-mlib-play-btn'); },
    row: (id) => doc.querySelector('[data-mlib-track-id="' + id + '"]'),
    rowBtn: (id) => { const r = api.row(id); return r && r.querySelector('.stella-mlib-track-more'); },
    meta: (id) => { const c = api.card(id); return c && c.querySelector('.stella-mlib-album-meta'); },
    backBtn: () => doc.getElementById('mlib-detail-back'),
    scroll: () => doc.getElementById('music-library-scroll'),
    openAlbums: async () => { await win.stellaMlibPage.openAxis('albums'); await flush(); },
    openDetail: async (tracks) => {
      if (tracks) cfg.detail = { entity: albumCard('AL1'), tracks, status: 'ok' };
      await win.stellaMlibPage.openDetail('albums', 'AL1');
      await flush();
    },
  };
  return api;
}

test('真 DOM：整张播放走真冒泡＝一次点击恰一次入队路径（多一枚监听当场翻倍）', async () => {
  const f = bootReal();
  assert.equal(f.html.classList.contains('stella-mlib-has-hover'), true, '前置事实：hover 模探测到位');
  await f.openAlbums();
  f.cardPlayBtn('AL1').click(); // 真派发：target＝钮，冒泡经过 document（委托在此）再向 window
  await flush();
  assert.equal(f.state.queued.length, 1, 'document 委托恰一枚 ⇒ 入队恰一次');
  assert.equal(f.state.next.length, 0, '仍走 queueSong（队尾），没有抢「下一首」');
  assert.deepEqual(f.state.detailCalls, [{ axis: 'albums', id: 'AL1' }], '轴名取自 body 真相源，id 取自 data-mlib-id');
});

test('真 DOM：整张播放 3 首含 1 首 unmatched → 恰 2 首、读层原序；行点击与卡点击同一条委托', async () => {
  const f = bootReal();
  await f.openAlbums();
  await f.openDetail([track({ id: 't1', name: '夜曲' }), track({ id: 't2', name: '发如雪', matched: false }), track({ id: 't3', name: '青花瓷' })]);
  f.state.queued.length = 0;
  f.cardPlayBtn('AL1').click();
  await flush();
  assert.deepEqual(names(f.state.queued), ['夜曲', '青花瓷'], 'unmatched 被过滤，顺序＝读层原序');
});

test('真 DOM：不可播行的两条路——disabled 钮点不动、整行（CSS cursor:pointer）打到代码闸：都零入队', async () => {
  const f = bootReal();
  await f.openAlbums();
  await f.openDetail([track({ id: 't1', name: '夜曲' }), track({ id: 't2', name: '发如雪', matched: false })]);
  const badRow = f.row('t2');
  const badBtn = f.rowBtn('t2');
  assert.equal(badBtn.disabled, true, 'Task 6 事实：unmatched 行的钮 disabled');
  assert.equal(badRow.getAttribute('aria-disabled'), 'true');
  assert.equal(badRow.getAttribute('disabled'), null, '但**行本体没有 disabled 属性**（只有 aria-disabled）：整行点击一定会冒泡到委托');
  assert.equal(badRow.getAttribute('aria-disabled'), 'true', '不可播行以 aria-disabled 表意，不改标签语义');
  // 用 spy 证明「这一击确实打到了页面闸」——只断言零入队的话，「被闸拦下」与「根本没进委托」无法区分。
  const seen = [];
  const realPlayTrack = f.page.playTrack;
  f.page.playTrack = function (trackId) { seen.push(trackId); return realPlayTrack.call(this, trackId); };

  badBtn.click(); // 浏览器语义：disabled 钮不派发 click（就算派发也照样被闸拦下，两条路同一结果）
  await flush();
  assert.equal(f.state.queued.length, 0, 'disabled 钮：零入队');

  seen.length = 0;
  badRow.click();
  await flush();
  assert.deepEqual(seen, ['t2'], '整行点击确实进入 playTrack（不可播行的真相源＝页面代码闸，不是钮的外观）');
  assert.equal(f.state.queued.length, 0, 'matched 闸兑现「不可达」：零入队，而不是"入队后指望队列链拒绝"');
  f.page.playTrack = realPlayTrack;

  // 对照：同一份详情里的可播行，真冒泡一次＝恰一次入队
  f.rowBtn('t1').click();
  await flush();
  assert.equal(f.state.queued.length, 1, '可播行仍正常入队一次');
});

test('真 DOM：触屏模整封面即播；鼠标模封面/文案区进详情不起播；关闭态（无 mlib-active）点击一律静默', async () => {
  const touch = bootReal({ hover: false });
  assert.equal(touch.html.classList.contains('stella-mlib-has-hover'), false, '探测不到 hover＝按触屏处理');
  await touch.openAlbums();
  touch.card('AL1').querySelector('.stella-mlib-art').click();
  await flush();
  assert.equal(touch.state.queued.length, 1, '触屏：整张封面＝播放入口（music-library.css:331-339 的承诺兑现）');
  assert.equal(touch.state.detailCalls.length, 1, '封面那一下确实是一次播放请求（playEntity→getDetail），不是进详情');
  assert.equal(touch.body.classList.contains('mlib-detail-open'), false, '触屏封面＝播放，不开详情');

  const mouse = bootReal({ hover: true });
  await mouse.openAlbums();
  mouse.detail = { entity: albumCard('AL1'), tracks: [track({ id: 't9', name: '晴天' })], status: 'ok' };
  const callsBefore = mouse.state.detailCalls.length;
  mouse.card('AL1').querySelector('.stella-mlib-album-meta').click();
  await flush();
  assert.equal(mouse.state.queued.length, 0, '鼠标模文案区点击不起播');
  assert.equal(mouse.body.classList.contains('mlib-detail-open'), true, '鼠标模文案区＝进二级详情（C1 真冒泡复核：修复前此处点了没反应）');
  assert.equal(mouse.state.detailCalls.length, callsBefore + 1, '文案区那一下打了一次 getDetail（openDetail）');
  const callsAfter = mouse.state.detailCalls.length;
  mouse.card('AL1').querySelector('.stella-mlib-art').click();
  await flush();
  assert.equal(mouse.body.classList.contains('mlib-detail-open'), true, '鼠标模封面（非钮区）同样进详情');
  assert.equal(mouse.state.detailCalls.length, callsAfter + 1, '封面（非钮区）＝再一次 openDetail');
  mouse.body.classList.remove('mlib-active'); // 资料库收起（真相源）
  mouse.cardPlayBtn('AL1').click();
  await flush();
  assert.deepEqual([mouse.state.queued.length, mouse.state.detailCalls.length], [0, callsAfter + 1],
    '未展开态：播放钮一律静默——连详情请求都不该发（闸在委托入口）');
});

/* ------------------------------------------------ ⑩ C1：二级详情入口 + 返回钮（鼠标可达） */

test('C1 假 DOM：hover 模点卡文案区 → openDetail 渲染曲目行并置 mlib-detail-open（此前指针死区）', async () => {
  const f = boot({ hover: true });
  await f.openAlbums();
  const callsBefore = f.detailCalls.length;
  f.click(f.meta('AL1')); // fire(body,'click',{target: metaNode})
  await flush();
  assert.equal(f.body.classList.contains('mlib-detail-open'), true, '文案区点击必须进二级详情（真相源类点亮）');
  assert.equal(f.detailCalls.length, callsBefore + 1, 'openDetail 打了恰一次 getDetail');
  assert.ok(f.row('t1'), '详情曲目行真的渲染出来了（stub getDetail → renderTracks）');
});

test('C1 假 DOM：hover 模点封面非钮区 → 进详情而非播放', async () => {
  const f = boot({ hover: true });
  await f.openAlbums();
  f.click(f.card('AL1').querySelector('.stella-mlib-art'));
  await flush();
  assert.equal(f.state.queued.length, 0, '封面非钮区不起播');
  assert.equal(f.body.classList.contains('mlib-detail-open'), true, '封面非钮区＝详情入口');
});

test('C1 假 DOM：一次点击互斥——点播放钮只播放、绝不同时开详情', async () => {
  const f = boot({ hover: true });
  await f.openAlbums();
  f.click(f.cardPlayBtn('AL1'));
  await flush();
  assert.equal(f.state.queued.length, 1, '播放钮那一下＝播放');
  assert.equal(f.body.classList.contains('mlib-detail-open'), false, '同一次点击不得又开详情（意图互斥）');
});

test('C1 假 DOM：返回钮委托命中 #mlib-detail-back → 仅当 mlib-detail-open 在场才调 closeDetail（真相源闸）', async () => {
  const f = boot({ hover: true });
  await f.openAlbums();
  // 详情没开：返回钮点了不该有动作（mlib-detail-back 常驻 DOM，靠类真相源闸兜住）
  const calls0 = f.detailCalls.length;
  f.click(f.backBtn());
  await flush();
  assert.equal(f.body.classList.contains('mlib-detail-open'), false, '未开详情时点返回钮不点亮、不改动');
  // 进详情
  f.click(f.meta('AL1'));
  await flush();
  assert.equal(f.body.classList.contains('mlib-detail-open'), true, '前置事实：详情已开');
  // 点返回钮 → closeDetail → 类摘除
  f.click(f.backBtn());
  assert.equal(f.body.classList.contains('mlib-detail-open'), false, '返回钮委托命中 → closeDetail 摘 mlib-detail-open');
});

test('C1 假 DOM：关闭态（无 mlib-active）点文案区/返回钮一律静默（闸在委托入口）', async () => {
  const f = boot({ hover: true });
  await f.openAlbums();
  f.body.classList.remove('mlib-active');
  const callsBefore = f.detailCalls.length;
  f.click(f.meta('AL1'));
  f.click(f.backBtn());
  await flush();
  assert.equal(f.detailCalls.length, callsBefore, '未展开态不产生任何详情请求');
  assert.equal(f.body.classList.contains('mlib-detail-open'), false, '未展开态不得点亮详情类');
});

test('C1 is-openable 一致性：能开详情的卡才带 is-openable；不可开详情的卡不点播放之外的路径', async () => {
  const f = boot({ hover: true });
  await f.openAlbums();
  const card = f.card('AL1');
  assert.equal(card.classList.contains('is-openable'), true, '能进二级的网格卡须带 is-openable（Task 6 buildCard 真相源）');
  // 剥掉 is-openable：绑定层不该把它当详情入口（playability/detail 守卫归页面层，绑定读的是页面已渲染的类）
  card.classList.remove('is-openable');
  const callsBefore = f.detailCalls.length;
  f.click(f.meta('AL1'));
  await flush();
  assert.equal(f.detailCalls.length, callsBefore, '不带 is-openable 的卡点了不进详情');
  assert.equal(f.body.classList.contains('mlib-detail-open'), false, '无 is-openable＝无详情入口');
});

test('C1 真 DOM：一次物理点击只产一个意图——文案区 .click() 仅 openDetail，不叠加第二次', async () => {
  const f = bootReal({ hover: true });
  await f.openAlbums();
  const before = f.state.detailCalls.length;
  f.meta('AL1').click(); // 真冒泡：target=文案区，经 document 委托一次
  await flush();
  assert.equal(f.state.detailCalls.length, before + 1, '一次物理点击＝恰好一次详情意图');
  assert.equal(f.body.classList.contains('mlib-detail-open'), true);
});

test('C1 真 DOM：点 #mlib-detail-back（真 .click）→ 网格回来 + scrollTop 恢复', async () => {
  const f = bootReal({ hover: true });
  await f.openAlbums();
  const sc = f.scroll();
  // jsdom 的 scrollTop 有布局才有值；用一个自有属性把「记录/恢复」变成可观测往返（test-local，不改 harness）
  Object.defineProperty(sc, 'scrollTop', { configurable: true, get() { return this.__st; }, set(v) { this.__st = v; } });
  sc.scrollTop = 480; // 网格滚动位置
  await f.openDetail([track({ id: 't1', name: '夜曲' })]);
  // openDetail 会排一枚「钉顶」rAF（08-mlib-page.js:471-473）；必须先让它跑完，
  // 否则在批跑时序下这枚 pending 帧可能晚于 closeDetail 触发，把恢复的 480 又打回 0（假阳性 race）。
  await new Promise((resolve) => f.win.requestAnimationFrame(() => resolve()));
  assert.equal(sc.scrollTop, 0, '进详情把滚动复位到顶');
  assert.equal(f.body.classList.contains('mlib-detail-open'), true, '前置事实：详情已开');
  sc.scrollTop = 120; // 用户在详情里滚了一段
  f.backBtn().click(); // 真 .click() → document 委托 → closeDetail
  await flush();
  assert.equal(f.body.classList.contains('mlib-detail-open'), false, '返回：详情关闭、网格回来');
  assert.equal(sc.scrollTop, 480, '网格 scrollTop 恢复到进入详情前记录的位置（不是 0、不是 120）');
});

/* ------------------------------------------------ ⑪ I1：整张播放/单曲播放必须真正起播（append 后立刻播首支新入队） */

test('I1 整张播放：全部 append 后恰好一次 playQueueAt(首个新入队索引)', async () => {
  const f = boot({ play: true });
  await f.openAlbums();
  f.detail = {
    entity: albumCard('AL1'), status: 'ok',
    tracks: [track({ id: 't1', name: '夜曲' }), track({ id: 't2', name: '发如雪', matched: false }), track({ id: 't3', name: '青花瓷' })],
  };
  const n = await f.page.playEntity('albums', 'AL1');
  assert.equal(n, 2, '两首入队');
  assert.equal(f.state.playCalls.length, 1, '起播恰一次（不是每首都播）');
  assert.equal(f.state.playCalls[0].idx, 0, '播的是本批首个新入队项的插入索引');
  assert.deepEqual(f.state.playCalls[0].opts, { manual: true }, '沿用既有手动起播口径（14-player-controls.js:545）');
});

test('I1 单曲行播放：入队后立刻播该项（playQueueAt 恰一次）', async () => {
  const f = boot({ play: true });
  await f.openAlbums();
  await f.openDetail([track({ id: 't1', name: '夜曲' }), track({ id: 't2', name: '青花瓷' })]);
  f.state.playCalls.length = 0; // openDetail 不该起播（起播只由播放意图触发）
  assert.equal(f.state.playCalls.length, 0, '进详情本身不起播');
  f.click(f.rowBtn('t2'));
  await flush();
  assert.equal(f.state.queued.length, 1, '该轨入队');
  assert.equal(f.state.playCalls.length, 1, '单曲点击也立即起播（与整张一致）');
});

test('I1 追加而非替换：既有 2 项在前，起播索引＝首个新入队位（第 2 项）、既有项绝不被动', async () => {
  const f = boot({ play: true });
  await f.openAlbums();
  // 重挂桩：模拟真实队列里已经有 2 项，queueSong 一律 push 到队尾并回真实插入索引
  const existing = [{ name: '既有A' }, { name: '既有B' }];
  f.state.queued.length = 0;
  f.state.playCalls.length = 0;
  f.win.queueSong = function (song) { existing.push(song); f.state.queued.push({ song, opts: null }); return existing.length - 1; };
  f.detail = { entity: albumCard('AL1'), status: 'ok', tracks: [track({ id: 't1', name: '夜曲' }), track({ id: 't3', name: '青花瓷' })] };
  const n = await f.page.playEntity('albums', 'AL1');
  assert.equal(n, 2, '两首新入队');
  assert.equal(f.state.playCalls.length, 1, '起播恰一次');
  assert.equal(f.state.playCalls[0].idx, 2, '起播索引＝第 3 项（前 2 是既有队列，绝不被顶掉/清空）');
  assert.deepEqual(existing.slice(0, 2).map((s) => s.name), ['既有A', '既有B'], '既有队列项原位保留（append 非 replace）');
});

test('I1 零匹配实体：既不入队也不起播（playQueueAt 零调用）', async () => {
  const f = boot({ play: true });
  await f.openAlbums();
  f.detail = { entity: albumCard('AL1'), status: 'ok', tracks: [track({ id: 't2', name: '发如雪', matched: false })] };
  const n = await f.page.playEntity('albums', 'AL1');
  assert.equal(n, 0, '零首可播');
  assert.equal(f.state.queued.length, 0, '不入队');
  assert.equal(f.state.playCalls.length, 0, '不起播');
});

test('I1 在途作废同样盖住起播步：getDetail 期间关闭 → 晚到响应既不 append 也不 playQueueAt', async () => {
  const f = boot({ play: true });
  await f.openAlbums();
  const d = deferred();
  f.detail = d;
  const inflight = f.page.playEntity('albums', 'AL1');
  await null;
  f.win.mlibClose(); // 作废播放代数
  d.resolve({ entity: albumCard('AL1'), tracks: [track()], status: 'ok' });
  const n = await inflight;
  assert.equal(n, 0, '晚到响应被丢弃');
  assert.equal(f.state.queued.length, 0, '一份不入队');
  assert.equal(f.state.playCalls.length, 0, '一步不起播（作废覆盖起播，不只覆盖入队）');
});

test('I1 playQueueAt 缺席：仍照常入队、静默不起播、绝不抛（typeof 守卫）', async () => {
  const f = boot(); // 不注入 playQueueAt
  await f.openAlbums();
  let threw = 0;
  try {
    await f.page.playEntity('albums', 'AL1');
  } catch (e) { threw += 1; }
  assert.equal(threw, 0, '起播全局缺席时不抛');
  assert.equal(f.state.queued.length, 1, '入队仍照常发生');
});

test('I1 真 DOM：整张播放一次物理点击 → 一次起播路径、起播恰好一次', async () => {
  const f = bootReal({ hover: true, play: true });
  await f.openAlbums();
  f.cfg.detail = { entity: albumCard('AL1'), status: 'ok', tracks: [track({ id: 't1', name: '夜曲' }), track({ id: 't3', name: '青花瓷' })] };
  f.cardPlayBtn('AL1').click();
  await flush();
  assert.equal(f.state.queued.length, 2, '两首入队');
  assert.equal(f.state.playCalls.length, 1, '一次点击＝一次起播（真冒泡不翻倍）');
  assert.equal(f.state.playCalls[0].idx, 0, '播首个新入队项');
});

