// tests/mlib-detail-modal-render.test.js —— 批D Task 3：详情按轴分流
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { bootDetail } = require('./helpers/mlib-detail-boot');   // 见 Step 4：从既有 mlib-page-detail.test.js 抽出的共用 boot

test('分流判据：专辑/歌单＝弹窗，艺人＝全屏页', () => {
  const f = bootDetail({ axis: 'albums' });
  assert.equal(f.win.stellaMlibPage.detailForm('albums'), 'modal');
  assert.equal(f.win.stellaMlibPage.detailForm('playlists'), 'modal');
  assert.equal(f.win.stellaMlibPage.detailForm('artists'), 'page');
});

test('弹窗轴：openDetail 开窗→铺骨架→铺信息区，body.mlib-detail-open 仍真相源，网格滚动一律不动', async () => {
  const f = bootDetail({ axis: 'albums', scrollTop: 240 });
  await f.win.stellaMlibPage.openDetail('albums', 'local-album:x');
  assert.equal(f.modal.calls.join(','), 'show,skeleton,renderInfo', '弹窗轴必须先开窗、等数据时铺骨架、到位后铺信息区');
  assert.equal(f.modal.lastAxis, 'albums');
  assert.ok(f.body.classList.contains('mlib-detail-open'), '真相源不得换');
  assert.equal(f.sc.scrollTop, 240, '参照库开弹窗不滚动底下的库页（钉顶只属于全屏详情）');
});

test('艺人轴：保持批C 全屏 hero 视图，不碰弹窗', async () => {
  const f = bootDetail({ axis: 'artists', scrollTop: 240 });
  await f.win.stellaMlibPage.openDetail('artists', 'local-artist:y');
  assert.equal(f.modal.calls.length, 0, '艺人轴不得开弹窗');
  assert.equal(f.sc.scrollTop, 0, '全屏详情照旧钉顶');
  assert.ok(f.doc.getElementById('mlib-detail-head').children.length > 0, '全屏 hero 照旧铺');
});

test('弹窗轴：行铺进弹窗容器，#mlib-detail-tracks 留空，且行仍由 08 的 buildTrackRow 造（不出第二份模板）', async () => {
  const f = bootDetail({ axis: 'albums' });
  await f.win.stellaMlibPage.openDetail('albums', 'local-album:x');
  assert.equal(f.doc.getElementById('mlib-detail-tracks').children.length, 0,
    '全屏详情必须留空，否则同一次点击出现两份曲目表');
  const rows = f.modal.tracksEl().children;
  assert.ok(rows.length >= 1, '弹窗里要有行或状态盒');
  assert.equal(rows[0].classList.contains('stella-mlib-track'), true, '行类名由 08 的既有构建器给');
  assert.ok(rows[0].getAttribute('data-mlib-track-id'), '行必须带轨 id，09 的 playTrack 分支才认');
});

test('closeDetail：弹窗轴收窗（hide），全屏轴照旧恢复滚动', async () => {
  const f = bootDetail({ axis: 'albums', scrollTop: 300 });
  await f.win.stellaMlibPage.openDetail('albums', 'local-album:x');
  f.win.stellaMlibPage.closeDetail();
  assert.ok(f.modal.calls.includes('hide'), '关详情必须收窗（参照库 783-794）');
  assert.equal(f.sc.scrollTop, 300, '弹窗轴返回后网格回到原处（从没动过滚动，也谈不上恢复）');
  assert.ok(!f.body.classList.contains('mlib-detail-open'), '真相源必须摘掉');
});

test('currentDetail：详情开着时回 {axis,id,form}，关掉后回 null（09 的整单播放只认这个，不读 DOM 属性）', async () => {
  const f = bootDetail({ axis: 'playlists' });
  assert.equal(f.win.stellaMlibPage.currentDetail(), null);
  await f.win.stellaMlibPage.openDetail('playlists', 'pl:1');
  assert.deepEqual(f.win.stellaMlibPage.currentDetail(), { axis: 'playlists', id: 'pl:1', form: 'modal' });
  f.win.stellaMlibPage.closeDetail();
  assert.equal(f.win.stellaMlibPage.currentDetail(), null);
});

test('在途弹窗渲染不得复活：open→close→晚到的响应一份都不铺（沿用 requestSeq 口径）', async () => {
  const f = bootDetail({ axis: 'albums', delayMs: 10 });
  const p = f.win.stellaMlibPage.openDetail('albums', 'local-album:x');
  f.win.stellaMlibPage.closeDetail();
  await p;
  assert.ok(!f.modal.calls.includes('renderInfo'), '晚到响应不得铺弹窗');
});

// ============================================================================
// 批D Task 4：弹窗窗口与信息区（realModal:true 跑真 15 模块下半）
// ============================================================================
const M = (f) => f.win.stellaMlibDetailModal;   // 真弹窗层（realModal:true）

test('renderInfo：kicker 按轴、标题走 textContent、封面走 img.src（不拼 HTML）', async () => {
  const f = bootDetail({ axis: 'albums', realModal: true });
  M(f).renderInfo('albums', { entity: { title: '六九<A>', sub: '陶喆', cover: 'data:image/png;base64,AA', count: 2, meta: { releaseYear: 1969 } }, tracks: [{ id: 't1' }, { id: 't2' }], status: 'ok' });
  assert.equal(f.ids('#mlib-detail-modal-kicker').textContent, '本地曲库 · 资料库专辑');
  assert.equal(f.ids('#mlib-detail-modal-heading').textContent, '六九<A>');
  assert.equal(f.ids('#mlib-detail-modal-artist').textContent, '陶喆');
  assert.ok(!f.ids('#mlib-detail-modal-heading').innerHTML.includes('<'), '标题必须走 textContent');
  assert.equal(f.ids('#mlib-detail-modal-cover').children[0].src, 'data:image/png;base64,AA');
  assert.equal(f.ids('#mlib-detail-modal-cover').children[0].referrerPolicy, 'no-referrer',
    '显示用封面 img 与取色 img（15:116）同一口径：entity.cover 可为外链防盗链图（参照库 428/884 两处封面都带）');
});

test('取色打在 mask 节点上；无封面不写变量（深色降级交给 CSS）', async () => {
  const f = bootDetail({ axis: 'albums', realModal: true });
  const seen = [];
  f.win.stellaMlibCoverTheme.applyCoverTheme = (url, target) => { seen.push({ url, target }); return Promise.resolve(); };
  M(f).renderInfo('albums', { entity: { title: 'A', cover: 'https://y.qq.com/x.jpg' }, tracks: [], status: 'ok' });
  assert.equal(seen.length, 1, '必须调 applyCoverTheme');
  assert.equal(seen[0].url, 'https://y.qq.com/x.jpg', '15 传原始封面，代理归一在 Task 2 的 coverThemeSource 里做');
  assert.equal(seen[0].target, f.ids('#mlib-detail-modal'), '变量写在 mask 节点');
  M(f).renderInfo('albums', { entity: { title: 'A', cover: '' }, tracks: [], status: 'ok' });
  assert.equal(seen.length, 1, '空封面不得取色');
  // brief 原文此处写 f.themeWrites.length，但 boot 的 themeWrites 是 Object.create(null)
  // 记账对象、恒无 .length（实际值 undefined，assert.equal(undefined,0) 必红）⇒ 按 brief
  // 同段其它 themeWrites 断言的口径改用 Object.keys(…).length，语义不变。
  assert.equal(Object.keys(f.themeWrites).length, 0, '空封面不得写任何主题变量');
});

test('facts：年份缺失就整块不出现；条数＝实际渲染行数；总时长有则加', () => {
  const f = bootDetail({ axis: 'albums', realModal: true });
  M(f).renderInfo('albums', { entity: { title: 'A', count: 3, meta: { releaseYear: 0 } }, tracks: [{ id: '1', duration: 200 }, { id: '2', duration: 0 }], status: 'ok' });
  assert.deepEqual(f.ids('#mlib-detail-modal-facts').children.map((n) => n.textContent), ['2 首', '3 分 20 秒'],
    '年份为 0 不进 facts；条数取实渲行数（参照库 458-466 的 trackCount 陷阱）；时长 0 不计入总和；总时长格式是参照库 fmtTotalDuration 的「M 分 SS 秒」原样（28-53），不是 mm:ss');
});

test('简介：缝不产出 description ⇒ 整块 hidden；产出则默认折叠三行，toggleDesc 展开并改文案', () => {
  const f = bootDetail({ axis: 'albums', realModal: true });
  M(f).renderInfo('albums', { entity: { title: 'A' }, tracks: [{ id: '1' }], status: 'ok' });
  assert.equal(f.ids('#mlib-detail-modal-desc').hidden, true);
  assert.equal(f.ids('#mlib-detail-modal-desc-toggle').hidden, true);
  M(f).renderInfo('albums', { entity: { title: 'A', description: '一段需要折叠的简介文本'.repeat(6) }, tracks: [{ id: '1' }], status: 'ok' });
  assert.equal(f.ids('#mlib-detail-modal-desc').hidden, false);
  assert.equal(f.ids('#mlib-detail-modal-desc').classList.contains('expanded'), false);
  M(f).toggleDesc();
  assert.equal(f.ids('#mlib-detail-modal-desc').classList.contains('expanded'), true);
  assert.equal(f.ids('#mlib-detail-modal-desc-toggle').textContent, '收起简介');
});

test('本层不造曲目行：renderInfo/skeleton 都不往行容器塞 .stella-mlib-track', () => {
  const f = bootDetail({ axis: 'albums', realModal: true });
  M(f).renderInfo('albums', { entity: { title: 'A' }, tracks: [{ id: '1' }, { id: '2' }], status: 'ok' });
  assert.equal(f.ids('#mlib-detail-modal-tracks').children.filter((n) => n.classList.contains('stella-mlib-track')).length, 0,
    '行的唯一属主是 08 的 buildTrackRow（Task 3 已定），这里出现行＝两份模板');
});

test('骨架：等数据时铺 3 条（62%/78%/54%）并置 aria-busy；渲染完由 08 铺行时自然替换', () => {
  const f = bootDetail({ axis: 'albums', realModal: true });
  M(f).skeleton();
  const kids = f.ids('#mlib-detail-modal-tracks').children;
  assert.deepEqual(kids.map((n) => n.classList.contains('stella-mlib-modal-skeleton')), [true, true, true]);
  assert.deepEqual(kids.map((n) => n.style.width), ['62%', '78%', '54%'], '宽度照参照库 556-558 走内联 style（CSS 里 .stella-mlib-modal-skeleton 不放宽度）');
  assert.equal(f.ids('#mlib-detail-modal-tracks').getAttribute('aria-busy'), 'true');
  M(f).renderInfo('albums', { entity: { title: 'A' }, tracks: [], status: 'ok' });
  assert.equal(f.ids('#mlib-detail-modal-tracks').getAttribute('aria-busy'), 'false');
  assert.deepEqual(f.ids('#mlib-detail-modal-tracks').children.map((n) => n.classList.contains('stella-mlib-modal-skeleton')), [true, true, true],
    'renderInfo 之后骨架 3 条仍在行容器里：清行与铺行都是 08 的活（15 只收 aria-busy），这里出现「骨架被 15 抹掉」＝行容器两份属主');
});

test('整单钮：文案按轴、error/无轨一律 disabled（参照库 222-231 + 743 的进行中闸）', () => {
  const f = bootDetail({ axis: 'albums', realModal: true });
  M(f).renderInfo('albums', { entity: { title: 'A' }, tracks: [{ id: '1', matched: true }], status: 'ok' });
  assert.equal(f.ids('#mlib-detail-modal-play-label').textContent, '播放专辑');
  assert.equal(f.ids('#mlib-detail-modal-play').disabled, false);
  M(f).renderInfo('albums', { entity: { title: 'A' }, tracks: [], status: 'error', message: 'DB 锁' });
  assert.equal(f.ids('#mlib-detail-modal-play').disabled, true, 'error 态不得给一个点不响的播放钮');
  M(f).renderInfo('playlists', { entity: { title: 'P' }, tracks: [{ id: '1', matched: true }], status: 'ok' });
  assert.equal(f.ids('#mlib-detail-modal-play-label').textContent, '播放歌单');
  M(f).setBusy(true);
  assert.equal(M(f).isBusy(), true);
  assert.equal(f.ids('#mlib-detail-modal-play-label').textContent, '正在播放…');
  M(f).setBusy(false);
  assert.equal(f.ids('#mlib-detail-modal-play-label').textContent, '播放歌单', '忙态解除后文案要回到轴口径');
});

// 修复轮1·发现④（R9）：整单两颗钮的 disabled 此前有三处写者各写各的——
// show() 写 true、renderInfo 只在 !busy 时写 dead、setBusy(false) 无条件写 false。
// 缺陷序列＝不可播实体 + 任意 busy 往返 ⇒ 钮被点亮，点击被 08 的 card.playable 闸静默回 0（用户零反馈）。
// 裁决：在 15 内立单一真相源 stellaMlibModalState.playable，三处写者统一 disabled = busy || !playable。
test('R9：不可播实体扛得住 busy 往返——两颗整单钮始终 disabled（单一真相源 playable）', () => {
  const f = bootDetail({ axis: 'albums', realModal: true });
  M(f).show('albums');                                       // 开窗＝等数据：playable 未知 ⇒ 先收钮
  assert.equal(f.ids('#mlib-detail-modal-play').disabled, true, 'show() loading：播放钮收');
  assert.equal(f.ids('#mlib-detail-modal-shuffle').disabled, true, 'show() loading：随机钮同收');
  M(f).renderInfo('albums', { entity: { title: 'A' }, tracks: [{ id: '1', matched: false }], status: 'ok' });
  assert.equal(f.ids('#mlib-detail-modal-play').disabled, true, '前置事实：dead 实体 renderInfo 落灰（原本就写对）');
  M(f).setBusy(true);
  assert.equal(f.ids('#mlib-detail-modal-play').disabled, true, 'busy 期间收钮');
  M(f).setBusy(false);
  assert.equal(f.ids('#mlib-detail-modal-play').disabled, true,
    '缺陷：setBusy(false) 此前无条件点亮 ⇒ 不可播实体忙一轮回来留下一颗点得响却零反馈的播放钮');
  assert.equal(f.ids('#mlib-detail-modal-shuffle').disabled, true, '随机钮与播放钮同一真相源，同步保持灰');
  // 对照：可播实体忙一轮后照常点亮（单一算式不许把 live 实体也焊死）
  M(f).renderInfo('albums', { entity: { title: 'A' }, tracks: [{ id: '1', matched: true }], status: 'ok' });
  M(f).setBusy(true);
  M(f).setBusy(false);
  assert.equal(f.ids('#mlib-detail-modal-play').disabled, false, '可播实体 busy 往返后照常可点');
});

test('show/hide 生命周期：show 先清主题再开窗、滚动置顶；hide 经 closeGsapModal 的 afterClose 清主题', () => {
  const f = bootDetail({ axis: 'albums', realModal: true });   // realModal 会连 00-state/12-modal-anim.js 一起加载（沙箱无 gsap → style 兜底分支）
  const mask = f.ids('#mlib-detail-modal');
  M(f).show('albums');
  assert.equal(mask.classList.contains('show'), true, 'openGsapModal 的产物就是 .show');
  assert.equal(mask.getAttribute('aria-hidden'), 'false', '开着的窗口必须在读屏树里（与 hide 成对）');
  assert.equal(f.ids('#mlib-detail-modal-scroll').scrollTop, 0, '参照库 799-800：开窗即置顶');
  f.win.stellaMlibCoverTheme.applyThemeVars(200, 60, 90, mask);          // 先让主色真的落上去
  assert.equal(Object.keys(f.themeWrites).length, 5, 'applyThemeVars 要在 mask 上写满 5 个主题变量');
  M(f).show('playlists');                                                // 换轴重开（单弹窗承载两轴）
  assert.equal(Object.keys(f.themeWrites).length, 0, 'show 必须先清上一份主色，否则歌单顶着专辑的配色');
  f.win.stellaMlibCoverTheme.applyThemeVars(20, 180, 120, mask);
  M(f).hide();
  assert.equal(mask.classList.contains('show'), false, 'closeGsapModal 无 gsap 时同步收尾');
  assert.equal(mask.getAttribute('aria-hidden'), 'true', '关掉的窗口不得留在读屏树里（与 show 的 false 成对）');
  assert.equal(Object.keys(f.themeWrites).length, 0, '关窗后主题变量不得残留（参照库 786-792）');
  assert.equal(M(f).isModalAxis('artists'), false, '艺人轴不进弹窗（与 08 的 MODAL_AXES 同一判据）');
});
