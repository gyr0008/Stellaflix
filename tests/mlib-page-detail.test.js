// tests/mlib-page-detail.test.js —— Task 6：本地音乐资料库二级详情视图（vm + 假 DOM，复用 Task 5 fakeDom）
// 覆盖：openDetail/closeDetail 视图切换（body 类 mlib-detail-open + 网格 aria-hidden）、
//       详情头部（eyebrow/detail-title/head-meta）、曲目行（只带 data-mlib-track-id、数据进 __mlibDetailPayloadForTests）、
//       文本转义、matched:false 行播放钮 disabled+title=unplayableHint()、详情状态盒（error 缝 message 透传 / engine-missing / 空轨）、
//       滚动进入前记录 + 返回恢复、关详情后在途渲染丢弃、is-openable 卡可点入口。
// 批D（10-26）分流后：全屏详情归艺人轴，本文件里「铺 #mlib-detail-tracks / 钉顶 / 恢复滚动 / 头部」的用例一律改艺人轴驱动；
//       弹窗轴覆盖在 tests/mlib-detail-modal-render.test.js（同一共用 boot）；专辑头形态保留一条「弹窗层缺席＝降级全屏」用例。
//       共用 bootDetail 已抽到 tests/helpers/mlib-detail-boot.js（仓里唯一一份，本文件 require 它，不留第二份）。
// 运行：node --test tests/mlib-page-detail.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');            // 宽松断言：vm 跨 realm 下 deepStrictEqual 会误报（仓内约定）
const { createFakeDom, SHELL } = require('./helpers/mlib-fake-dom');
const { bootDetail, READ_SRC, PAGE_SRC } = require('./helpers/mlib-detail-boot');

const entity = (o) => Object.assign({ id: 'AL1', title: '十一月的萧邦', sub: '周杰伦', cover: 'https://cdn/a.jpg', count: 3, playable: true, meta: { releaseYear: 2005 } }, o || {});
const track = (o) => Object.assign({ id: 't1', name: '夜曲', artist: '周杰伦', album: '十一月的萧邦', cover: 'https://cdn/1.jpg', duration: 250, matched: true }, o || {});

/* -------------------------------------------------------- ① 视图切换 + 头部 + 曲目行 */

test('openDetail：置 mlib-detail-open、网格视图 aria-hidden、详情头部三件套渲染', async () => {
  const { win, body, doc, head, gridView } = bootDetail({ detail: { entity: entity(), tracks: [track()], status: 'ok' } });
  // 批D：全屏详情归艺人轴（专辑/歌单走弹窗，分流覆盖在 mlib-detail-modal-render.test.js）。
  await win.stellaMlibPage.openDetail('artists', 'AL1');
  assert.equal(body.classList.contains('mlib-detail-open'), true, 'body 类真相源须置 mlib-detail-open（Task 7 依赖）');
  assert.equal(gridView().getAttribute('aria-hidden'), 'true', '进详情须把网格视图对读屏隐藏');
  assert.equal(win.document.getElementById('mlib-view-detail') && true, true, '详情容器必须存在');
  const eyebrow = head().querySelector('.stella-mlib-eyebrow');
  const title = head().querySelector('.stella-mlib-detail-title');
  const meta = head().querySelector('.stella-mlib-head-meta');
  assert.ok(eyebrow, '头部必须有 eyebrow 元素');
  assert.ok(title, '头部必须有标题元素');
  assert.ok(meta, '头部必须有 head-meta 元素');
  assert.equal(meta.textContent, '3 首 · 2005', 'head-meta＝参照库式「N 首」量词 + 发行年（页面拥有「首」单位串）');
  assert.equal(title.textContent, '十一月的萧邦', '标题＝entity.title 原文（textContent，非注入）');
  assert.equal(eyebrow.textContent, '周杰伦', 'eyebrow＝entity.sub（读层既有串，不新造文案）');
});

/* ---- 批C-3（10-26 主人拍板）：详情头大封面/头像 ----
 * 参照库 06-music-library.js:822-831 + index.css:2969-3010 的 hero 几何：
 * 图块 clamp(96px,11vw,148px)、gap clamp(18px,2.4vw,30px)、meta 侧 min-width:0。
 * 轴别差异沿用本仓既有铁律：专辑/歌单＝方形封面（.stella-mlib-art），
 * 艺人＝圆形头像（.stella-mlib-artist-art），**绝不拿 entity.cover（专辑封面）冒充头像**。
 */

test('openDetail：专辑轴在弹窗层缺席时降级全屏页——详情头出 hero，方形封面 img.src＝entity.cover', async () => {
  const { win, head } = bootDetail({ detail: { entity: entity({ cover: 'https://cdn/big.jpg' }), tracks: [track()], status: 'ok' } });
  // 批D 降级闸：15 未导出弹窗面＝detailModalLayer() 缺席 → detailForm('albums') 自动回 'page'，绝不抛错。
  // （弹窗轴的信息区形态由 Task 4 的真 renderInfo 负责；这里保住「降级不白屏、方形封面链同源」这条产品承诺。）
  delete win.stellaMlibDetailModal;
  await win.stellaMlibPage.openDetail('albums', 'AL1');
  const hero = head().querySelector('.stella-mlib-hero');
  assert.ok(hero, '详情头必须有 hero 容器（参照库同一结构）');
  const art = hero.querySelector('.stella-mlib-hero-art');
  assert.ok(art, 'hero 必须有图块');
  assert.equal(art.matches('.stella-mlib-artist-art'), false, '专辑轴图块不是圆形头像层');
  const img = art.querySelector('img');
  assert.ok(img, '有封面 URL 才出 img');
  assert.equal(img.src, 'https://cdn/big.jpg', '封面走属性赋值，不经 HTML 字符串拼接');
});

test('openDetail：艺人详情头 hero 用圆形头像层，无 avatar 时首字母占位且不出 img', async () => {
  const { win, head } = bootDetail({ detail: { entity: entity({ id: 'AR1', title: '陶喆', sub: '', cover: 'https://cdn/album.jpg', meta: {} }), tracks: [track()], status: 'ok' } });
  await win.stellaMlibPage.openDetail('artists', 'AR1');
  const hero = head().querySelector('.stella-mlib-hero');
  const art = hero.querySelector('.stella-mlib-hero-art');
  assert.equal(art.matches('.stella-mlib-artist-art'), true, '艺人轴图块必须是圆形头像层');
  assert.equal(art.querySelector('img'), null, 'engine 不给头像 → 不出 img，绝不把专辑封面当头像贴上去');
  assert.equal(art.children[0].textContent, '陶', '首字母占位沿用网格同一兜底链');
});

test('openDetail：弹窗层缺席降级全屏——entity 无封面 → hero 图块仍在（退回占位底色），文案照常渲染', async () => {
  const { win, head } = bootDetail({ detail: { entity: entity({ cover: '' }), tracks: [track()], status: 'ok' } });
  delete win.stellaMlibDetailModal; // 批D 降级闸（同上一条方形封面用例的口径）
  await win.stellaMlibPage.openDetail('albums', 'AL1');
  const hero = head().querySelector('.stella-mlib-hero');
  assert.ok(hero.querySelector('.stella-mlib-hero-art'), '无封面也要留图块位：版面不跳');
  assert.equal(hero.querySelector('.stella-mlib-hero-art').querySelector('img'), null);
  assert.equal(head().querySelector('.stella-mlib-detail-title').textContent, '十一月的萧邦', '文案不因缺图一起消失');
});

test('openDetail：曲目行渲染，行只带 data-mlib-track-id，完整数据进 __mlibDetailPayloadForTests', async () => {
  const tracks = [track({ id: 't1' }), track({ id: 't2', name: '发如雪' })];
  const { win, doc, row, rows, tracks: pageTracks } = bootDetail({ detail: { entity: entity(), tracks, status: 'ok' } });
  await win.stellaMlibPage.openDetail('artists', 'AL1'); // 批D：本文件只验全屏页轴的行流水线（弹窗宿主由 modal-render 用例守）
  assert.equal(rows().length, 2, '两条轨渲染两行');
  assert.ok(pageTracks().querySelector('[data-mlib-track-id="t1"]'), '行必须落在页轴容器 #mlib-detail-tracks');
  const r1 = row('t1');
  assert.ok(r1, '按 data-mlib-track-id 必须能取回行');
  assert.equal(r1.classList.contains('stella-mlib-track'), true, '行挂 .stella-mlib-track');
  // DOM 属性面：行只放标识与 ARIA（role/tabindex/data-mlib-track-id），曲名/艺人/时长数据一律不进属性
  // 白名单过滤写（同网格测试）：真 DOM 会把 classList 反映成 class 属性，假 DOM 不反映——两侧都不误红
  const ROW_ALLOWED = ['data-mlib-track-id', 'role', 'tabindex', 'class'];
  const leaked = Object.keys(r1.attributes).filter((k) => ROW_ALLOWED.indexOf(k) === -1);
  assert.deepEqual(leaked, [], '可播行属性面只允许标识+ARIA(+class)，无数据字段泄漏');
  assert.equal(r1.getAttribute('role'), 'button', '行 role=button（参照库）');
  assert.equal(r1.getAttribute('tabindex'), '0', '行可聚焦（参照库）');
  assert.equal(r1.getAttribute('aria-disabled'), null, '可播行不带 aria-disabled');
  assert.equal(r1.getAttribute('data-name'), null, '曲名不得进属性');
  assert.equal(r1.getAttribute('data-artist'), null, '艺人不得进属性');
  const payload = win.__mlibDetailPayloadForTests.get(r1);
  assert.equal(payload, tracks[0], 'payload Map 存读层那张轨对象本身（同一引用，不复制）');
  assert.equal(win.__mlibDetailPayloadForTests.get(row('t2')), tracks[1]);
});

test('openDetail：曲目行为参照库 5 列（序号/曲名/艺人/时长/播放钮），无封面列', async () => {
  const { win, row } = bootDetail({ detail: { entity: entity(), tracks: [track({ duration: 250 })], status: 'ok' } });
  await win.stellaMlibPage.openDetail('artists', 'AL1'); // 批D：页轴行流水线（5 列口径两形态同源，宿主归 modal-render 用例）
  const r1 = row('t1');
  assert.equal(r1.children.length, 5, '参照库 .stella-mlib-track 为 5 列网格，行必须恰好 5 个子节点');
  assert.equal(r1.querySelector('.stella-mlib-track-no').textContent, '1', '序号从 1 起（照读层顺序，页面不重排）');
  assert.equal(r1.querySelector('.stella-mlib-track-name').textContent, '夜曲');
  assert.equal(r1.querySelector('.stella-mlib-track-artist').textContent, '周杰伦');
  assert.equal(r1.querySelector('.stella-mlib-track-dur').textContent, '4:10', '时长 mm:ss（纯数值格式化，非文案）');
  const more = r1.querySelector('.stella-mlib-track-more');
  assert.ok(more, '第 5 列必须是 .stella-mlib-track-more 播放钮（参照库第 5 列即播放三角）');
  assert.equal(more.tagName, 'BUTTON', '播放动作是 button');
  assert.equal(r1.querySelector('.stella-mlib-track-cover'), null, '参照库无封面列：不得有 .stella-mlib-track-cover');
  assert.equal(r1.querySelector('img'), null, '行内不得出现 img（封面列已废除）');
  assert.equal(r1.querySelector('.stella-mlib-track-play'), null, '发明类 .stella-mlib-track-play 不得存在');
});

test('openDetail：曲目文本注入防御（esc/textContent，绝不解析成标签）', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  const { win, row } = bootDetail({ detail: { entity: entity({ title: evil }), tracks: [track({ name: evil, artist: evil })], status: 'ok' } });
  await win.stellaMlibPage.openDetail('artists', 'AL1'); // 批D：全屏详情（含头部注入防御）归艺人轴
  assert.equal(win.document.getElementById('mlib-detail-head').querySelector('.stella-mlib-detail-title').textContent, evil, '标题按原文进 textContent');
  const r1 = row('t1');
  assert.equal(r1.querySelector('.stella-mlib-track-name').textContent, evil, '曲名按原文，不被当标签');
  assert.equal(r1.querySelector('.stella-mlib-track-name').querySelector('img'), null, '恶意串不得生成 img 子节点');
});

test('openDetail：详情曲目不渲染封面（参照库 5 列无封面，移植 CSS 也只给 5 列）', async () => {
  const { win, row } = bootDetail({ detail: { entity: entity(), tracks: [track({ id: 't1', cover: 'https://cdn/1.jpg' }), track({ id: 't2', cover: '' })], status: 'ok' } });
  await win.stellaMlibPage.openDetail('artists', 'AL1'); // 批D：页轴曲目（弹窗同一流水线）
  assert.equal(row('t1').querySelector('img'), null, '有 cover URL 也不画封面 img——参照库无封面列');
  assert.equal(row('t2').querySelector('img'), null);
  assert.equal(row('t1').querySelector('.stella-mlib-track-cover'), null, '不得有 .stella-mlib-track-cover 容器');
});

test('is-openable：三轴网格卡都标为可点开详情（详情入口实体）', async () => {
  const cards = [{ id: 'AL1', title: 'A', sub: 'x', cover: '', count: 1, playable: true, sortBucket: 'album', meta: {} }];
  const { win, card } = bootDetail({ axisData: { axis: 'albums', status: 'ok', cards }, detail: { entity: entity(), tracks: [track()], status: 'ok' } });
  await win.stellaMlibPage.openAxis('albums');
  assert.equal(card('AL1').classList.contains('is-openable'), true, '能打开详情的卡须带 is-openable（CSS cursor 靠它）');
});

/* -------------------------------------------------------- ② 滚动记录 / 恢复 */

test('进入详情前记录网格滚动、返回后恢复原值并移除 mlib-detail-open', async () => {
  const { win, body, scroll } = bootDetail({ detail: { entity: entity(), tracks: [track()], status: 'ok' } });
  scroll().scrollTop = 500;
  await win.stellaMlibPage.openDetail('artists', 'AL1'); // 批D：钉顶/滚动恢复只属于全屏页轴＝艺人轴（弹窗轴「不该发生」的反证见 mlib-detail-modal-render）
  assert.equal(scroll().scrollTop, 0, '进入详情把滚动复位到顶（真实产品行为，也让恢复可被观测）');
  scroll().scrollTop = 300; // 用户在详情里滚了一段
  win.stellaMlibPage.closeDetail();
  assert.equal(scroll().scrollTop, 500, '返回恢复到进入前记录的网格滚动位置（不是 0、不是 300）');
  assert.equal(body.classList.contains('mlib-detail-open'), false, '返回移除 mlib-detail-open');
  assert.equal(win.document.getElementById('mlib-view-grid').getAttribute('aria-hidden'), 'false', '返回后网格视图恢复对读屏可见');
});

/* -------------------------------------------------------- ③ 详情失败态（头部照常 + 列表状态盒） */

test('status=error：头部照常渲染 + 列表区状态盒，缝 message 逐字透传（非通用兜底）', async () => {
  const msg = '专辑索引损坏：ALBUM_CORRUPT(409)';
  const { win, head, tracks, rows } = bootDetail({ detail: { entity: entity(), tracks: [], status: 'error', message: msg } });
  await win.stellaMlibPage.openDetail('artists', 'AL1'); // 批D：全屏详情（状态盒落 #mlib-detail-tracks）归艺人轴
  assert.equal(head().querySelector('.stella-mlib-detail-title').textContent, '十一月的萧邦', '详情失败头部仍照常');
  assert.equal(tracks().children.length, 1, '失败态列表区只放一个状态盒');
  const box = tracks().children[0];
  assert.equal(box.classList.contains('stella-mlib-state-box'), true, '.stella-mlib-state-box 已在 CSS 里有主，详情状态盒须挂该类');
  assert.equal(box.getAttribute('data-tone'), 'warn', 'error 走 warn 色');
  assert.equal(box.querySelector('.stella-mlib-state-heading').textContent, msg, 'heading＝缝 message 原文透传');
  const btn = box.querySelector('.stella-mlib-state-btn');
  assert.ok(btn, '读取失败要有重试钮');
  assert.equal(btn.getAttribute('data-mlib-action'), 'retry', 'Task 7 按 data-mlib-action 接线');
  assert.equal(rows().length, 0, '失败态不渲染任何曲目行');
});

test('status=engine-missing：头部存在（entity 为空不崩）+ 状态盒引擎未就绪文案、无按钮', async () => {
  const { win, head, tracks, read } = bootDetail({ detail: { entity: null, tracks: [], status: 'engine-missing' } });
  await win.stellaMlibPage.openDetail('artists', 'AL1'); // 批D：全屏详情状态盒归艺人轴
  assert.ok(head().querySelector('.stella-mlib-detail-title'), 'entity 为空时标题元素仍在（头部照常骨架）');
  assert.equal(head().querySelector('.stella-mlib-detail-title').textContent, '', '无 entity 不放文本');
  assert.equal(tracks().children.length, 1, '引擎未就绪同样用状态盒容器');
  const box = tracks().children[0];
  assert.equal(box.getAttribute('data-tone'), 'warn');
  assert.ok(box.querySelector('.stella-mlib-state-heading'), '有文案行');
  assert.equal(box.querySelector('.stella-mlib-state-btn'), null, '引擎未就绪不给按钮（等 subscribe）');
});

test('status=ok 但零轨：走轴为空文案（getStateCopy 非 null），无曲目行', async () => {
  const { win, tracks, rows } = bootDetail({ detail: { entity: entity(), tracks: [], status: 'ok' } });
  await win.stellaMlibPage.openDetail('artists', 'AL1'); // 批D：全屏详情状态盒归艺人轴
  assert.equal(rows().length, 0);
  assert.equal(tracks().children.length, 1, '空详情用一个状态盒容器而非空列表');
  assert.ok(tracks().querySelector('.stella-mlib-state-heading'), '状态盒有文案行');
});

/* -------------------------------------------------------- ④ matched:false 行不可播 */

test('matched:false 行播放钮 disabled+title=unplayableHint()、行 aria-disabled；matched:true 行可用（惰性，无接线）', async () => {
  const { win, row, read } = bootDetail({ detail: { entity: entity(), tracks: [track({ id: 't1', matched: true }), track({ id: 't2', matched: false, name: '孤本' })], status: 'ok' } });
  await win.stellaMlibPage.openDetail('artists', 'AL1'); // 批D：页轴行可播性（弹窗行同一渲染函数）
  const on = row('t1').querySelector('.stella-mlib-track-more');
  const off = row('t2').querySelector('.stella-mlib-track-more');
  assert.ok(on, '行必须有 .stella-mlib-track-more 播放钮');
  assert.equal(on.disabled, false, '可播行播放钮不禁用');
  assert.equal(on.getAttribute('type'), 'button', '按钮不得有表单语义');
  assert.equal(on.getAttribute('aria-label'), '播放 夜曲', 'aria-label＝播放 + 曲名（参照库原文）');
  assert.ok(on.innerHTML.indexOf('M9 5.5v13l10.5-6.5z') >= 0, '播放三角 SVG');
  assert.equal(on.getAttribute('title'), null, '可播行不放 title——不发明参照库没有的播放文案');
  assert.equal(row('t1').getAttribute('aria-disabled'), null, '可播行不带 aria-disabled');
  assert.equal(off.disabled, true, 'matched:false 行播放钮置灰');
  assert.equal(off.getAttribute('title'), read.unplayableHint(), 'title 取读层文案，页面不硬编码');
  assert.equal(off.getAttribute('aria-label'), '播放 孤本', '不可播行仍有 aria-label');
  assert.equal(row('t2').getAttribute('aria-disabled'), 'true', '不可播行标 aria-disabled');
});

/* -------------------------------------------------------- 并发 / 清场 */

test('closeDetail 清空详情容器与 payload Map', async () => {
  const { win, tracks } = bootDetail({ detail: { entity: entity(), tracks: [track({ id: 't1' })], status: 'ok' } });
  await win.stellaMlibPage.openDetail('artists', 'AL1'); // 批D：页轴清场（#mlib-detail-head/tracks）归全屏页轴；弹窗轴清场由 modal 用例守
  assert.equal(win.__mlibDetailPayloadForTests.size, 1);
  win.stellaMlibPage.closeDetail();
  assert.equal(win.__mlibDetailPayloadForTests.size, 0, '离开详情 payload 不得残留');
  assert.equal(tracks().querySelector('.stella-mlib-track'), null, '曲目行清空');
});

test('在途详情被丢弃：closeDetail 后晚到的响应不得铺行/复活 payload', async () => {
  let release;
  const pending = new Promise((r) => { release = r; });
  const { win, tracks, rows } = bootDetail({ detail: () => pending });
  const inflight = win.stellaMlibPage.openDetail('artists', 'AL1'); // 批D：页轴在途作废（弹窗轴同口径由 modal 用例第7条守）
  win.stellaMlibPage.closeDetail();          // 关详情：seq 递增，晚到响应应被丢
  release({ entity: entity(), tracks: [track({ id: 't_late' })], status: 'ok' });
  await inflight;
  assert.equal(rows().length, 0, '旧详情晚到不得插行');
  assert.equal(tracks().querySelector('.stella-mlib-track'), null);
  assert.equal(win.__mlibDetailPayloadForTests.size, 0);
});

/* ------------------------------------------------ 文案源守卫（页面不得自带详情文案） */

test('页面模块不得自带读层拥有的状态文案', () => {
  assert.equal(PAGE_SRC.indexOf('未匹配到可播来源'), -1);
  assert.equal(PAGE_SRC.indexOf('曲库还是空的'), -1);
  assert.equal(PAGE_SRC.indexOf('这个板块还没有内容'), -1);
  assert.equal(PAGE_SRC.indexOf('曲库引擎尚未就绪'), -1);
});

/* -------------------------------------------------------- R1（第2轮回批）：详情态来通知＝重绘详情 */
// 第1轮把 F1 的缝通知接到了 openAxis 上，scoped 复审探针实锤出两处新破口（final-review round 1）：
//   探针① 详情在途时来通知 → openAxis 的 ++requestSeq 把在途 openDetail 判废，
//          body.mlib-detail-open 还挂着，但 #mlib-detail-head / #mlib-detail-tracks 都是 0 孩子＝永久空白。
// R 裁1（spec §5 line 74）：rev 变化要**三轴+详情一起作废**——正确行为是详情重新取数重绘，
// 不是跳过刷新、也不是留空白；同时网格标脏，等 closeDetail 恢复滚动后再补一次当前轴重绘（R1 ②③）。
// 本组夹具走「真缝 → 真读层 → 真页面」全链（详情侧此前只有 stub getDetail，观测不到重取）。

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function deferred() {
  const d = {};
  d.promise = new Promise((resolve) => { d.resolve = resolve; });
  return d;
}

// 专辑轴要有卡，缝轨必须带 albumId（读层 albumsFromTracks 的入组条件）
const albumTrack = (o) => Object.assign({
  id: 't1', name: '夜曲', artist: '周杰伦', artistId: 'AR1',
  album: '十一月的萧邦', albumId: 'AL1', cover: '', duration: 250, matched: true, releaseYear: 2005,
}, o || {});

// state 是本夹具的「引擎」：rev / 轴卡数据 / 详情数据 / 在途闸门 / 通知 handler 都由测试拨动。
function bootDetailNotify() {
  const state = {
    rev: 1,
    tracks: [albumTrack()],
    detail: { entity: entity(), tracks: [albumTrack()] },
    gate: null,        // 非空＝getAlbumDetail 挂在这个 deferred 上（造「在途详情」）
    detailFetches: 0,
    notify: null,
  };
  const seam = {
    getLibraryStats: async () => ({ ready: true, rev: state.rev }),
    getTracks: async () => ({ rev: state.rev, tracks: state.tracks }),
    getPlaylists: async () => ({ rev: state.rev, playlists: [] }),
    getAlbumDetail: async () => {
      state.detailFetches += 1;
      if (state.gate) return state.gate.promise; // 在途：由测试决定何时落地
      return { entity: state.detail.entity, tracks: state.detail.tracks };
    },
    subscribe: (fn) => { state.notify = fn; return () => { state.notify = null; }; },
  };
  const fake = createFakeDom({ mount: SHELL });
  const { win, doc } = fake;
  win.stellaMlibSeam = seam;
  win.loadScript(READ_SRC, '07-mlib-readlayer.js');
  win.loadScript(PAGE_SRC, '08-mlib-page.js');
  fake.state = state;
  fake.scroll = () => doc.getElementById('music-library-scroll');
  fake.grid = () => doc.getElementById('mlib-grid');
  fake.head = () => doc.getElementById('mlib-detail-head');
  fake.tracks = () => doc.getElementById('mlib-detail-tracks');
  fake.row = (id) => doc.querySelector('[data-mlib-track-id="' + id + '"]');
  fake.rows = () => doc.querySelectorAll('.stella-mlib-track');
  fake.cards = () => doc.querySelectorAll('.stella-mlib-album-card');
  fake.card = (id) => doc.querySelector('[data-mlib-id="' + id + '"]');
  return fake;
}

test('R1 详情在途时来通知：详情重取重绘，不得留永久空白（探针①）', async () => {
  const f = bootDetailNotify();
  await f.win.stellaMlibPage.openAxis('albums');
  assert.equal(f.cards().length, 1, '前置事实：网格渲染出 AL1 卡');

  const gate = deferred();
  f.state.gate = gate;
  const inflight = f.win.stellaMlibPage.openDetail('albums', 'AL1');
  await null; // openDetail 已进到 await getDetail，同步清场把详情两处掏空
  assert.equal(f.body.classList.contains('mlib-detail-open'), true, '前置事实：真相源还挂着');
  assert.equal(f.head().children.length, 0, '前置事实：在途期间详情头是空的');

  // 引擎侧换了数据，通知到来；在途那份旧响应随后才落地（必须被作废）
  f.state.gate = null;
  f.state.detail = { entity: entity({ title: '重取后的标题' }), tracks: [albumTrack({ id: 't_new', name: '新曲' })] };
  assert.equal(typeof f.state.notify, 'function', '前置事实：首次 openAxis 已把刷新回调登记进读层');
  f.state.notify();
  gate.resolve({ entity: entity({ title: '晚到的旧标题' }), tracks: [albumTrack({ id: 't_late', name: '旧曲' })] });
  await inflight;
  await delay(20);

  assert.equal(f.body.classList.contains('mlib-detail-open'), true, '通知不得把开着的详情关掉');
  // 这两行就是探针①的观测值（detail-open=true 而两处 0 孩子＝永久空白）
  assert.ok(f.head().children.length > 0, '#mlib-detail-head 必须有内容——不得留永久空白');
  assert.ok(f.tracks().children.length > 0, '#mlib-detail-tracks 必须有内容——不得留永久空白');
  assert.equal(f.head().querySelector('.stella-mlib-detail-title').textContent, '重取后的标题',
    '画出来的是通知后重取的那份');
  assert.ok(f.row('t_new'), '重取的那条轨上了屏');
  assert.equal(f.row('t_late'), null, '被作废的在途旧响应不得复活');
});

test('R1 refreshDetail 不得记录滚动：savedScrollTop 仍是进详情前的网格位置', async () => {
  const f = bootDetailNotify();
  await f.win.stellaMlibPage.openAxis('albums');
  f.scroll().scrollTop = 500; // 主人进详情前看的位置
  await f.win.stellaMlibPage.openDetail('albums', 'AL1');
  assert.equal(f.scroll().scrollTop, 0, '前置事实：进详情把滚动复位到顶');
  f.scroll().scrollTop = 300; // 用户在详情里滚了一段
  f.state.detail = { entity: entity(), tracks: [albumTrack({ id: 't_new' })] };
  f.state.notify();
  await delay(20);
  assert.ok(f.head().children.length > 0, '前置事实：通知后详情确实重绘了');
  f.win.stellaMlibPage.closeDetail();
  assert.equal(f.scroll().scrollTop, 500,
    '重绘详情绝不许覆写 savedScrollTop（覆写＝把网格位置换成详情位置，返回后被弹到 300）');
});

test('R1 详情开着来通知：网格标脏，返回时才补当前轴重绘（也不得把滚动钉走）', async () => {
  const f = bootDetailNotify();
  await f.win.stellaMlibPage.openAxis('albums');
  f.scroll().scrollTop = 500;
  await f.win.stellaMlibPage.openDetail('albums', 'AL1');
  // 引擎多出一张专辑：通知里读层先 invalidate，重取会拿到两份卡
  f.state.rev = 2;
  f.state.tracks = [albumTrack(), albumTrack({ id: 't2', albumId: 'AL2', album: '哎呦不错哦' })];
  f.state.detail = { entity: entity(), tracks: [albumTrack({ id: 't_new' })] };
  const fetchesBefore = f.state.detailFetches;
  f.state.notify();
  await delay(20);
  assert.equal(f.state.detailFetches, fetchesBefore + 1, '详情开着：通知打的是 getDetail（重取详情）');
  assert.ok(f.row('t_new'), '详情重绘到位');
  assert.equal(f.cards().length, 1, '网格脏到返回时再补：详情开着时不许在底下重绘');
  assert.equal(f.card('AL2'), null, '前置事实：新卡这会儿还没上屏');

  f.win.stellaMlibPage.closeDetail();
  assert.equal(f.scroll().scrollTop, 500, '返回先恢复滚动');
  await delay(20);
  assert.equal(f.cards().length, 2, 'closeDetail 之后脏位补一次当前轴重绘');
  assert.ok(f.card('AL2'), '网格是新数据');
  assert.equal(f.scroll().scrollTop, 500, '脏补走的是后台重绘路径，不得复用 openAxis 的钉顶分支');
});

test('R1 详情失败/为空时同样走 renderDetail 的状态盒分支，不得留空壳', async () => {
  const f = bootDetailNotify();
  await f.win.stellaMlibPage.openAxis('albums');
  await f.win.stellaMlibPage.openDetail('albums', 'AL1');
  assert.ok(f.row('t1'), '前置事实：详情渲染出曲目行');
  // 引擎侧详情这一支变成空列表（读层＝ok+零轨 → getStateCopy 给「这个板块还没有内容」）
  f.state.detail = { entity: entity(), tracks: [] };
  f.state.notify();
  await delay(20);
  assert.equal(f.rows().length, 0, '零轨不铺行');
  assert.equal(f.tracks().children.length, 1, '空列表也要有状态盒，不得留空壳');
  assert.ok(f.tracks().querySelector('.stella-mlib-state-heading'), '状态盒有文案行');
  assert.ok(f.head().children.length > 0, '头部照常，不因为空列表被掏空');
});
